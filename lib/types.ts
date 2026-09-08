/**
 * Core domain model.
 *
 * These types exist before any feature code because three separate subsystems
 * — the PDF extractor, the audio player, and the citation validator — all have
 * to agree on what "a piece of the document" is. Defining that agreement first
 * is what stops the app from growing three incompatible notions of position.
 *
 * See ARCHITECTURE.md § Domain model for the reasoning.
 */

/**
 * One sentence (or clause-sized fragment of a very long sentence) of the
 * document. The single unit of work in the entire app:
 *
 *   - the audio queue speaks one Chunk per utterance,
 *   - the reader highlights one Chunk at a time,
 *   - a key point cites Chunks by `id`.
 *
 * Chunks are produced only by `lib/chunker.ts` and are treated as immutable
 * once produced. Nothing downstream may reorder, merge, or renumber them —
 * `id` is a permanent address, and rewriting it would silently invalidate
 * every citation that points at it.
 */
export interface Chunk {
  /**
   * Stable, sequential, zero-based index into `ParsedDocument.chunks`.
   *
   * Doubles as a citation anchor, so it must be (a) cheap for a language model
   * to emit and echo back without transcription errors, and (b) mechanically
   * verifiable server-side: `id` is valid iff `0 <= id < chunks.length`.
   */
  id: number;

  /**
   * 1-based page the chunk *starts* on, matching what the reader sees printed
   * on the page. A sentence running across a page break keeps the page it
   * started on, so "jump to this citation" lands where the thought begins
   * rather than mid-clause on the following page.
   */
  pageNumber: number;

  /** The chunk's text, whitespace-normalised, ready to display and speak. */
  text: string;

  /**
   * Character offset of `text` within the full concatenated document text.
   *
   * Not needed to play audio, but it is the only durable link back to the
   * source document once chunk boundaries are decided. It lets us re-derive
   * ordering, compute reading progress by document length rather than sentence
   * count, and — if chunking rules ever change — map old chunk IDs onto new
   * ones instead of throwing citations away.
   */
  charStart: number;
}

/**
 * The result of extracting one PDF in the browser. This is the whole
 * application state produced by upload; everything else is derived from it.
 *
 * There is deliberately no `id`, no `createdAt`, and no upload URL: v1 has no
 * database and no server-side storage, and the file never leaves the browser.
 */
export interface ParsedDocument {
  /** Original filename, for display only. Never used as an identifier. */
  filename: string;

  /** Page count as reported by the PDF itself, not inferred from chunks. */
  pageCount: number;

  /** Every chunk in reading order. `chunks[i].id === i` is an invariant. */
  chunks: Chunk[];

  /**
   * False when the PDF is a scan with no embedded text layer (page images
   * only). Extraction of such a file yields near-empty text, which would make
   * the reader silently play nothing. Modelled explicitly so the UI is forced
   * to handle the case rather than rendering a blank document.
   *
   * OCR is out of scope for v1; this flag exists to say so honestly.
   */
  hasTextLayer: boolean;
}

/**
 * Raw text of a single page, as it comes out of the pdf.js extractor and goes
 * into the chunker. The seam between Phase 1 and Phase 2: it is the chunker's
 * entire input, which is what keeps `chunker.ts` a pure function testable
 * without a PDF, a browser, or a worker.
 */
export interface PageText {
  /** 1-based page number, as printed. */
  pageNumber: number;

  /** Reading-order text for this page, columns already resolved. */
  text: string;
}
