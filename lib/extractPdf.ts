/**
 * Browser-side PDF text extraction.
 *
 * This is the only module that knows pdf.js exists. It turns a `File` into
 * `PageText[]` and hands off to `lib/readingOrder.ts` for the actual layout
 * reasoning, which is pure and tested. Everything here is I/O, worker setup,
 * and validation at the boundary.
 *
 * The file never leaves the browser. There is no upload endpoint.
 */

import * as pdfjs from "pdfjs-dist";
import type { PageText } from "./types";
import {
  detectColumnSplit,
  toReadingOrder,
  type PositionedItem,
} from "./readingOrder";

/**
 * Where pdf.js fetches its worker and data files from.
 *
 * **Why these are served out of `public/` rather than resolved by the bundler.**
 * pdf.js starts its parser with `new Worker(workerSrc)`, and a Web Worker
 * constructor takes a *URL the browser fetches at run time* — not a module
 * specifier the bundler can follow. So `workerSrc` has to name a real, stable,
 * same-origin path that exists after the build. Pointing it into
 * `node_modules` fails for several independent reasons, and it is worth being
 * precise about them because the failure is a silent hang, not an error:
 *
 *  1. `node_modules` is not served. Nothing under it has a URL in production.
 *  2. Importing the worker instead (`import worker from ".../pdf.worker.mjs"`)
 *     asks the bundler to inline ~1.3MB of parser into the main client chunk.
 *     A worker is a separate execution context; code pulled into the page's
 *     context is not a worker and pdf.js will not use it as one.
 *  3. The `new URL("...", import.meta.url)` trick that some bundlers special-
 *     case is handled inconsistently by Turbopack across dev and production
 *     builds, so it can work locally and break on Vercel.
 *  4. A CDN copy would work but decouples the worker's version from the
 *     installed one. pdf.js compares them and refuses to run on a mismatch, so
 *     an `npm update` would break the app at run time rather than at build.
 *
 * `scripts/copy-pdf-assets.mjs` copies all three out of the installed package
 * on postinstall and prebuild, which keeps the served files version-locked to
 * the API by construction.
 */
const PDFJS_ASSET_BASE = "/pdfjs";

pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_ASSET_BASE}/pdf.worker.min.mjs`;

/**
 * Below this many characters per page on average, treat the document as a scan
 * with no text layer.
 *
 * A page of ordinary prose holds 1500–3000 characters, so 100 is an order of
 * magnitude clear of any real text page. It is not zero because a scanned PDF
 * usually is not perfectly empty — it carries a producer watermark, a page
 * number stamped by the scanner, or a stray OCR fragment — and a zero test
 * would call such a file readable and then read four words aloud.
 */
export const MIN_CHARS_PER_PAGE = 100;

export interface ExtractionProgress {
  /** Pages processed so far. */
  page: number;
  /** Total pages in the document. */
  pageCount: number;
}

/**
 * Extraction output. Deliberately *not* a `ParsedDocument`: chunking is a
 * separate pure step (Phase 2) and this module has no business doing it.
 */
export interface ExtractedPdf {
  filename: string;
  pageCount: number;
  pages: PageText[];
  hasTextLayer: boolean;
  /** Column count detected per page, for display and debugging. */
  columnsPerPage: number[];
}

export class PdfExtractionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PdfExtractionError";
  }
}

/**
 * Narrow one pdf.js text item into a `PositionedItem`.
 *
 * pdf.js declares `TextItem.transform` as `Array<any>`, so `transform[4]` and
 * `transform[5]` — the x and y translation of the text matrix — arrive with no
 * type at all. Hard rule 2 bans `any` in our code, and more importantly a cast
 * here would be a lie: nothing guarantees those entries are numbers.
 *
 * So this is the one place the untyped surface is touched, and it is handled
 * with a runtime check rather than an assertion. Items that fail it are
 * dropped: an item with no position cannot be placed in reading order, and
 * silently losing a stray run is better than poisoning the geometry with NaN.
 */
function toPositionedItem(item: unknown): PositionedItem | null {
  if (typeof item !== "object" || item === null) return null;
  if (!("str" in item) || !("transform" in item)) return null;

  const { str, transform, width, height } = item as {
    str: unknown;
    transform: unknown;
    width?: unknown;
    height?: unknown;
  };

  if (typeof str !== "string") return null;
  if (!Array.isArray(transform)) return null;

  const x: unknown = transform[4];
  const y: unknown = transform[5];
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  return {
    text: str,
    x,
    y,
    width: typeof width === "number" && Number.isFinite(width) ? width : 0,
    height: typeof height === "number" && Number.isFinite(height) ? height : 0,
  };
}

/**
 * Read a PDF in the browser and return its text, page by page, in reading
 * order.
 *
 * Progress is reported per page because extraction is genuinely slow on large
 * documents — pdf.js parses each page's content stream — and a reader who
 * dropped in a 75-page paper needs to see that something is happening.
 */
export async function extractPdf(
  file: File,
  onProgress?: (progress: ExtractionProgress) => void,
  signal?: AbortSignal,
): Promise<ExtractedPdf> {
  if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
    throw new PdfExtractionError("That file is not a PDF.");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  const task = pdfjs.getDocument({
    data: bytes,
    cMapUrl: `${PDFJS_ASSET_BASE}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_ASSET_BASE}/standard_fonts/`,
    // The document is never rendered to a canvas, only read, so there is no
    // reason to build XFA form data we would then ignore.
    enableXfa: false,
  });

  signal?.addEventListener("abort", () => void task.destroy(), { once: true });

  let document_: pdfjs.PDFDocumentProxy;
  try {
    document_ = await task.promise;
  } catch (cause) {
    if (signal?.aborted) throw new PdfExtractionError("Extraction cancelled.", { cause });
    throw new PdfExtractionError(
      "That PDF could not be opened. It may be corrupt or password-protected.",
      { cause },
    );
  }

  try {
    const pageCount = document_.numPages;
    const pages: PageText[] = [];
    const columnsPerPage: number[] = [];
    let totalChars = 0;

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      if (signal?.aborted) throw new PdfExtractionError("Extraction cancelled.");

      const page = await document_.getPage(pageNumber);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();

        const items: PositionedItem[] = [];
        for (const raw of content.items) {
          const positioned = toPositionedItem(raw);
          if (positioned !== null) items.push(positioned);
        }

        const text = toReadingOrder(items, viewport.width);
        pages.push({ pageNumber, text });
        columnsPerPage.push(countColumns(items, viewport.width));
        totalChars += text.length;
      } finally {
        // Release the page's parsed operator list. Without this a large
        // document accumulates every page it has touched in memory.
        page.cleanup();
      }

      onProgress?.({ page: pageNumber, pageCount });
    }

    return {
      filename: file.name,
      pageCount,
      pages,
      hasTextLayer: pageCount > 0 && totalChars / pageCount >= MIN_CHARS_PER_PAGE,
      columnsPerPage,
    };
  } finally {
    // `destroy()` is on the loading task, not the document: it is what tears
    // down the worker. Without it every opened PDF leaks a live worker thread.
    await task.destroy();
  }
}

/**
 * 1 or 2, using the same detector that drives reading order — never a second
 * copy of the rule. This is only for the verification panel, so the reader can
 * see what the extractor concluded about each page.
 */
function countColumns(items: PositionedItem[], pageWidth: number): number {
  return detectColumnSplit(items, pageWidth) === null ? 1 : 2;
}
