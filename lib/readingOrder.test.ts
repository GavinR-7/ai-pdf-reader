import { describe, it, expect } from "vitest";
import {
  buildLines,
  detectColumnSplit,
  toReadingOrder,
  type PositionedItem,
} from "./readingOrder";

/**
 * Geometry is built by hand here rather than loaded from a PDF fixture. That
 * is the whole reason reading order is a pure function: the rules are testable
 * without pdf.js, a worker, or a browser, and a failing case can be written
 * down as five numbers instead of a 2MB binary.
 *
 * Coordinates are PDF user space — larger y is *higher* on the page.
 */

const PAGE_WIDTH = 600;

function item(
  text: string,
  x: number,
  y: number,
  width = text.length * 5,
  height = 10,
): PositionedItem {
  return { text, x, y, width, height };
}

/** Twelve rows of two columns: left occupies 50–250, right 320–520. */
function twoColumnPage(): PositionedItem[] {
  const items: PositionedItem[] = [];
  for (let row = 0; row < 12; row++) {
    const y = 700 - row * 12;
    items.push(item(`L${row}`, 50, y, 200));
    items.push(item(`R${row}`, 320, y, 200));
  }
  return items;
}

/** Twelve full-width lines, 50–550. */
function singleColumnPage(): PositionedItem[] {
  const items: PositionedItem[] = [];
  for (let row = 0; row < 12; row++) {
    items.push(item(`Line ${row}`, 50, 700 - row * 12, 500));
  }
  return items;
}

describe("detectColumnSplit", () => {
  it("finds the gutter on a two-column page", () => {
    const split = detectColumnSplit(twoColumnPage(), PAGE_WIDTH);
    expect(split).not.toBeNull();
    // The gutter is the blank strip between 250 and 320.
    expect(split).toBeGreaterThanOrEqual(250);
    expect(split).toBeLessThanOrEqual(320);
  });

  it("reports no split on a single-column page", () => {
    expect(detectColumnSplit(singleColumnPage(), PAGE_WIDTH)).toBeNull();
  });

  it("refuses to guess on a sparse page", () => {
    // Two columns' worth of geometry, but only six items — a figure-only page.
    const sparse = [
      item("L0", 50, 700, 200),
      item("R0", 320, 700, 200),
      item("L1", 50, 688, 200),
      item("R1", 320, 688, 200),
      item("L2", 50, 676, 200),
      item("R2", 320, 676, 200),
    ];
    expect(detectColumnSplit(sparse, PAGE_WIDTH)).toBeNull();
  });

  it("is not fooled by a single stray item on the far side", () => {
    // Eleven full-width lines plus one item hugging the right margin. A naive
    // "is there a blank vertical strip" test would split here; the balance
    // check rejects it because one side holds almost nothing.
    const items = singleColumnPage();
    items.push(item("*", 560, 640, 10));
    expect(detectColumnSplit(items, PAGE_WIDTH)).toBeNull();
  });
});

describe("buildLines", () => {
  it("groups items sharing a baseline into one line", () => {
    const lines = buildLines([
      item("Hello", 50, 700, 25),
      item("world", 80, 700, 25),
      item("Next", 50, 688, 25),
    ]);
    expect(lines.map((line) => line.text)).toEqual(["Hello world", "Next"]);
  });

  it("keeps a subscript on the line it belongs to", () => {
    // `d_model` — the subscript sits 1.5pt low and is set 3pt smaller.
    const lines = buildLines([
      item("d", 258, 215.9, 5),
      item("model", 263.2, 214.4, 17, 7),
      item("= 512", 283.9, 215.9, 25),
    ]);
    expect(lines).toHaveLength(1);
    // No space before the subscript: it is one symbol, and the 0.2pt gap is
    // far below the threshold. "= 512" is 3.7pt clear, so that space is kept.
    expect(lines[0]?.text).toBe("dmodel = 512");
  });

  it("does not double up a space the PDF already emitted", () => {
    const lines = buildLines([
      item("Hello", 50, 700, 25),
      item(" ", 75, 700, 5),
      item("world", 80, 700, 25),
    ]);
    expect(lines[0]?.text).toBe("Hello world");
  });

  it("orders lines top to bottom, not in content-stream order", () => {
    const lines = buildLines([
      item("third", 50, 676, 25),
      item("first", 50, 700, 25),
      item("second", 50, 688, 25),
    ]);
    expect(lines.map((line) => line.text)).toEqual(["first", "second", "third"]);
  });
});

describe("toReadingOrder", () => {
  it("reads two columns in order instead of interleaving them", () => {
    // The regression this whole module exists for. Sorting by vertical
    // position alone yields "L0 R0 L1 R1 ..." — gibberish on a real paper.
    const text = toReadingOrder(twoColumnPage(), PAGE_WIDTH);
    const leftFirst = text.indexOf("L11");
    const rightFirst = text.indexOf("R0");
    expect(leftFirst).toBeGreaterThan(-1);
    expect(rightFirst).toBeGreaterThan(-1);
    expect(leftFirst).toBeLessThan(rightFirst);
    expect(text).toContain("L0 L1 L2");
    expect(text).toContain("R0 R1 R2");
  });

  it("reads a full-width heading before the columns beneath it", () => {
    const items = twoColumnPage();
    items.push(item("A Full Width Title", 50, 760, 500));
    const text = toReadingOrder(items, PAGE_WIDTH);
    expect(text.indexOf("A Full Width Title")).toBeLessThan(text.indexOf("L0"));
    expect(text.indexOf("L0")).toBeLessThan(text.indexOf("R0"));
  });

  it("reads a mid-page full-width figure between the bands around it", () => {
    const items: PositionedItem[] = [];
    for (let row = 0; row < 8; row++) {
      const y = 700 - row * 12;
      items.push(item(`Top L${row}`, 50, y, 200));
      items.push(item(`Top R${row}`, 320, y, 200));
    }
    items.push(item("Figure 1: spans the page", 50, 580, 500));
    for (let row = 0; row < 8; row++) {
      const y = 540 - row * 12;
      items.push(item(`Bot L${row}`, 50, y, 200));
      items.push(item(`Bot R${row}`, 320, y, 200));
    }
    const text = toReadingOrder(items, PAGE_WIDTH);
    expect(text.indexOf("Top L0")).toBeLessThan(text.indexOf("Top R0"));
    expect(text.indexOf("Top R0")).toBeLessThan(text.indexOf("Figure 1"));
    expect(text.indexOf("Figure 1")).toBeLessThan(text.indexOf("Bot L0"));
    expect(text.indexOf("Bot L0")).toBeLessThan(text.indexOf("Bot R0"));
  });

  it("rejoins a word broken across a line break", () => {
    const text = toReadingOrder(
      [item("The Trans-", 50, 700, 200), item("former model", 50, 688, 200)],
      PAGE_WIDTH,
    );
    expect(text).toBe("The Transformer model");
  });

  it("starts a new block at an unusually large vertical gap", () => {
    const text = toReadingOrder(
      [
        item("First paragraph line one", 50, 700, 400),
        item("and line two.", 50, 688, 400),
        item("A Heading", 50, 640, 400),
      ],
      PAGE_WIDTH,
    );
    // The chunker treats "\n" as a hard boundary, which is what stops a
    // heading being read as part of the paragraph above it.
    expect(text).toBe("First paragraph line one and line two.\nA Heading");
  });

  it("returns an empty string for a page with no text", () => {
    expect(toReadingOrder([], PAGE_WIDTH)).toBe("");
  });
});
