import { describe, it, expect } from "vitest";
import { validateCitations } from "./validateCitations";
import { parseAnalysis, AnalysisFormatError } from "./analysis";
import type { RawAnalysis } from "./analysis";

function analysis(keyPoints: RawAnalysis["keyPoints"]): RawAnalysis {
  return { summary: "A summary.", keyPoints, documentType: "academic" };
}

describe("validateCitations", () => {
  it("keeps a key point whose citations all exist", () => {
    const result = validateCitations(
      analysis([{ point: "Depth helps.", chunkIds: [0, 3] }]),
      10,
    );
    expect(result.keyPoints).toEqual([
      { point: "Depth helps.", chunkIds: [0, 3], flagged: false },
    ]);
    expect(result.citations.droppedCitations).toBe(0);
  });

  it("drops a fabricated citation ID and flags the point", () => {
    // The case the whole module exists for: the model cites chunk 999 in a
    // 10-chunk document. It is removed, the real citation survives, and the
    // point is marked so the reader knows its grounding was partly invented.
    const result = validateCitations(
      analysis([{ point: "Depth helps.", chunkIds: [2, 999] }]),
      10,
    );
    expect(result.keyPoints).toEqual([
      { point: "Depth helps.", chunkIds: [2], flagged: true },
    ]);
    expect(result.citations.droppedCitations).toBe(1);
    expect(result.citations.flaggedKeyPoints).toBe(1);
    expect(result.citations.droppedKeyPoints).toBe(0);
  });

  it("drops a key point entirely when no citation is real", () => {
    const result = validateCitations(
      analysis([
        { point: "Invented.", chunkIds: [50, 51] },
        { point: "Real.", chunkIds: [1] },
      ]),
      10,
    );
    expect(result.keyPoints).toEqual([
      { point: "Real.", chunkIds: [1], flagged: false },
    ]);
    expect(result.citations.droppedKeyPoints).toBe(1);
    expect(result.citations.droppedCitations).toBe(2);
  });

  it("drops a key point that cites nothing at all", () => {
    const result = validateCitations(analysis([{ point: "Ungrounded.", chunkIds: [] }]), 10);
    expect(result.keyPoints).toEqual([]);
    expect(result.citations.droppedKeyPoints).toBe(1);
  });

  it("rejects out-of-range, negative, and non-integer IDs", () => {
    const result = validateCitations(
      analysis([{ point: "Mixed.", chunkIds: [-1, 0, 9, 10, 2.5, Number.NaN] }]),
      10,
    );
    // Valid: 0 and 9. Invalid: -1, 10 (one past the end), 2.5, NaN.
    expect(result.keyPoints[0]?.chunkIds).toEqual([0, 9]);
    expect(result.citations.droppedCitations).toBe(4);
  });

  it("treats the boundary correctly: chunkCount itself is not a valid ID", () => {
    const result = validateCitations(analysis([{ point: "Edge.", chunkIds: [3] }]), 3);
    expect(result.keyPoints).toEqual([]);
    expect(result.citations.droppedCitations).toBe(1);
  });

  it("collapses duplicate citations without counting them as dropped", () => {
    const result = validateCitations(
      analysis([{ point: "Repeated.", chunkIds: [4, 4, 4] }]),
      10,
    );
    expect(result.keyPoints[0]?.chunkIds).toEqual([4]);
    expect(result.keyPoints[0]?.flagged).toBe(false);
    expect(result.citations.droppedCitations).toBe(0);
  });

  it("preserves citation order as the model gave it", () => {
    const result = validateCitations(
      analysis([{ point: "Ordered.", chunkIds: [7, 1, 4] }]),
      10,
    );
    expect(result.keyPoints[0]?.chunkIds).toEqual([7, 1, 4]);
  });

  it("rejects every citation against an empty document", () => {
    const result = validateCitations(analysis([{ point: "Nothing.", chunkIds: [0] }]), 0);
    expect(result.keyPoints).toEqual([]);
    expect(result.citations.droppedCitations).toBe(1);
  });

  it("passes the summary and document type through untouched", () => {
    const result = validateCitations(analysis([]), 10);
    expect(result.summary).toBe("A summary.");
    expect(result.documentType).toBe("academic");
  });
});

describe("parseAnalysis", () => {
  const valid = JSON.stringify({
    summary: "It works.",
    keyPoints: [{ point: "A point.", chunkIds: [1, 2] }],
    documentType: "technical",
  });

  it("parses a clean JSON object", () => {
    expect(parseAnalysis(valid)).toEqual({
      summary: "It works.",
      keyPoints: [{ point: "A point.", chunkIds: [1, 2] }],
      documentType: "technical",
    });
  });

  it("tolerates markdown fences the prompt asked it not to use", () => {
    expect(parseAnalysis("```json\n" + valid + "\n```").summary).toBe("It works.");
  });

  it("tolerates a preamble before the object", () => {
    expect(parseAnalysis("Here is the analysis:\n" + valid).summary).toBe("It works.");
  });

  it("falls back to 'other' for an unrecognised document type", () => {
    const odd = JSON.stringify({ summary: "s", keyPoints: [], documentType: "poetry" });
    expect(parseAnalysis(odd).documentType).toBe("other");
  });

  it("treats malformed grounding as absent grounding", () => {
    const odd = JSON.stringify({
      summary: "s",
      keyPoints: [{ point: "p", chunkIds: "not an array" }],
      documentType: "other",
    });
    // Survives parsing with no citations, then gets dropped by the validator.
    expect(parseAnalysis(odd).keyPoints).toEqual([{ point: "p", chunkIds: [] }]);
    expect(validateCitations(parseAnalysis(odd), 5).keyPoints).toEqual([]);
  });

  it("throws on malformed JSON", () => {
    expect(() => parseAnalysis("{ not json")).toThrow(AnalysisFormatError);
  });

  it("throws when there is no object at all", () => {
    expect(() => parseAnalysis("I cannot help with that.")).toThrow(AnalysisFormatError);
  });

  it("throws when the summary is missing", () => {
    expect(() => parseAnalysis(JSON.stringify({ keyPoints: [] }))).toThrow(
      AnalysisFormatError,
    );
  });
});
