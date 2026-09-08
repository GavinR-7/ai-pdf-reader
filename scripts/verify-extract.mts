import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { toReadingOrder, detectColumnSplit, type PositionedItem } from "../lib/readingOrder.ts";

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
    if (!("str" in it)) continue;
    const t = it.transform;
    const x = t[4], y = t[5];
    if (typeof x !== "number" || typeof y !== "number") continue;
    items.push({ text: it.str, x, y, width: it.width, height: it.height });
  }
  const split = detectColumnSplit(items, viewport.width);
  const text = toReadingOrder(items, viewport.width);
  console.log(`\n--- page ${pageNo} | columns=${split === null ? 1 : 2}${split === null ? "" : ` split@${split}`} | ${text.length} chars ---`);
  console.log(text.slice(0, 1100));
}
