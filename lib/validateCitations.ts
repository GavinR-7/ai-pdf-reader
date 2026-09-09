/**
 * Mechanical verification of the model's citations.
 *
 * This exists because a language model asked to cite its sources will
 * sometimes cite a chunk that does not exist. Not often, and not
 * maliciously — but a summary whose grounding is decorative is worse than a
 * summary with no grounding at all, because it looks trustworthy.
 *
 * The rule is: **do not trust the citations, check them.** A citation is valid
 * if and only if it names a chunk in the document that was actually submitted.
 * That is a range check, which is cheap, total, and impossible to get subtly
 * wrong — the whole reason chunk IDs are sequential integers (see
 * ARCHITECTURE.md § Why chunk IDs are stable sequential integers).
 *
 * Runs **server-side**, before the response is sent. A client-side check would
 * be a suggestion; this is a guarantee about what the UI can receive.
 */

import type {
  CitationReport,
  RawAnalysis,
  ValidatedAnalysis,
  ValidatedKeyPoint,
} from "./analysis";

/**
 * Drop every citation that does not name a real chunk, and every key point
 * left with no citations at all.
 *
 * @param analysis   The model's response, already parsed but not trusted.
 * @param chunkCount Number of chunks in the document that was submitted.
 *                   Valid IDs are exactly `0 .. chunkCount - 1`.
 */
export function validateCitations(
  analysis: RawAnalysis,
  chunkCount: number,
): ValidatedAnalysis {
  const keyPoints: ValidatedKeyPoint[] = [];
  const report: CitationReport = {
    droppedCitations: 0,
    droppedKeyPoints: 0,
    flaggedKeyPoints: 0,
  };

  for (const raw of analysis.keyPoints) {
    const valid: number[] = [];
    const seen = new Set<number>();
    let dropped = 0;

    for (const id of raw.chunkIds) {
      const exists = Number.isInteger(id) && id >= 0 && id < chunkCount;
      if (!exists) {
        dropped += 1;
        continue;
      }
      // Duplicates are not an error, but they would render as the same source
      // twice, so they are collapsed. They are not counted as dropped: nothing
      // was invented, it was just said twice.
      if (seen.has(id)) continue;
      seen.add(id);
      valid.push(id);
    }

    report.droppedCitations += dropped;

    // A key point with nothing real behind it is not a key point. It is
    // dropped whole rather than shown ungrounded, because the entire promise
    // of this panel is that every claim can be traced to a sentence.
    if (valid.length === 0) {
      report.droppedKeyPoints += 1;
      continue;
    }

    const flagged = dropped > 0;
    if (flagged) report.flaggedKeyPoints += 1;

    keyPoints.push({ point: raw.point, chunkIds: valid, flagged });
  }

  return {
    summary: analysis.summary,
    keyPoints,
    documentType: analysis.documentType,
    citations: report,
  };
}
