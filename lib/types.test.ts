import { describe, it, expect } from "vitest";
import type { Chunk, ParsedDocument } from "./types";

/**
 * Phase 0 has no behaviour to test yet. This file does two jobs:
 * it proves the Vitest toolchain runs against TypeScript with the "@/" alias,
 * and it writes down the invariant every later phase depends on —
 * `chunks[i].id === i` — so that when the chunker exists in Phase 2 there is
 * already an assertion waiting for it.
 */

const sample: ParsedDocument = {
  filename: "sample.pdf",
  pageCount: 2,
  hasTextLayer: true,
  chunks: [
    { id: 0, pageNumber: 1, text: "The first sentence.", charStart: 0 },
    { id: 1, pageNumber: 1, text: "The second sentence.", charStart: 20 },
    { id: 2, pageNumber: 2, text: "A sentence on page two.", charStart: 41 },
  ],
};

describe("domain model", () => {
  it("uses a chunk's array position as its id", () => {
    sample.chunks.forEach((chunk: Chunk, index: number) => {
      expect(chunk.id).toBe(index);
    });
  });

  it("orders chunks by their offset in the document text", () => {
    const offsets = sample.chunks.map((chunk) => chunk.charStart);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  it("never lets page numbers go backwards", () => {
    const pages = sample.chunks.map((chunk) => chunk.pageNumber);
    expect(pages).toEqual([...pages].sort((a, b) => a - b));
  });
});
