/**
 * Dev harness: extract a real PDF and chunk it, so chunking rules can be
 * eyeballed against real prose rather than only against unit-test literals.
 *
 *   node --experimental-strip-types scripts/verify-chunks.mts <file.pdf> [maxPages]
 */
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  toReadingOrder,
  positionedItemFrom,
  type PositionedItem,
} from "../lib/readingOrder.ts";
import { chunkDocument, MAX_CHUNK_CHARS } from "../lib/chunker.ts";
import type { PageText } from "../lib/types.ts";

const file = process.argv[2] ?? "";
const maxPages = Number(process.argv[3] ?? 6);
const doc = await pdfjs.getDocument({ url: file }).promise;

const pages: PageText[] = [];
for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
  const page = await doc.getPage(n);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items: PositionedItem[] = [];
  for (const it of content.items) {
    const positioned = positionedItemFrom(it);
    if (positioned !== null) items.push(positioned);
  }
  pages.push({ pageNumber: n, text: toReadingOrder(items, viewport.width) });
}

const chunks = chunkDocument(pages);
const lengths = chunks.map((c) => c.text.length).sort((a, b) => a - b);
const p = (f: number) => lengths[Math.floor(f * (lengths.length - 1))] ?? 0;

console.log(`${file}: ${pages.length} pages -> ${chunks.length} chunks`);
console.log(`chars: min=${p(0)} p50=${p(0.5)} p90=${p(0.9)} max=${p(1)} (limit ${MAX_CHUNK_CHARS})`);
console.log(`over limit: ${lengths.filter((l) => l > MAX_CHUNK_CHARS).length}`);
console.log(`very short (<25): ${lengths.filter((l) => l < 25).length}\n`);

for (const c of chunks.slice(Number(process.argv[4] ?? 0), Number(process.argv[4] ?? 0) + 28)) {
  console.log(`[${String(c.id).padStart(3)}] p${c.pageNumber} @${String(c.charStart).padStart(6)} ${JSON.stringify(c.text.slice(0, 150))}`);
}
