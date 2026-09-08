import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  toReadingOrder,
  detectColumnSplit,
  positionedItemFrom,
  type PositionedItem,
} from "../lib/readingOrder.ts";

const file = process.argv[2] ?? "";
const pages = process.argv.slice(3).map(Number);
const doc = await pdfjs.getDocument({ url: file }).promise;
console.log(`=== ${file} (${doc.numPages} pages) ===`);

for (const pageNo of pages) {
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items: PositionedItem[] = [];
  for (const it of content.items) {
    const positioned = positionedItemFrom(it);
    if (positioned !== null) items.push(positioned);
  }
  const split = detectColumnSplit(items, viewport.width);
  const text = toReadingOrder(items, viewport.width);
  console.log(`\n--- page ${pageNo} | columns=${split === null ? 1 : 2}${split === null ? "" : ` split@${split}`} | ${text.length} chars ---`);
  console.log(text.slice(0, 1100));
}
