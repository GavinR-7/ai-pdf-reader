/**
 * Types and parsing for the document analysis (summary plus grounded key
 * points). Shared between the API route and the UI.
 *
 * Everything here is pure. The Anthropic call itself lives in
 * `app/api/analyze/route.ts`.
 */

export type DocumentType =
  | "academic"
  | "legal"
  | "financial"
  | "technical"
  | "other";

const DOCUMENT_TYPES: readonly DocumentType[] = [
  "academic",
  "legal",
  "financial",
  "technical",
  "other",
];

/** A key point exactly as the model returned it, before any checking. */
export interface RawKeyPoint {
  point: string;
  chunkIds: number[];
}

/** The model's whole response, before any checking. */
export interface RawAnalysis {
  summary: string;
  keyPoints: RawKeyPoint[];
  documentType: DocumentType;
}

export interface ValidatedKeyPoint {
  point: string;
  /** Only citations that resolve to a real chunk. Never empty. */
  chunkIds: number[];
  /**
   * True when the model cited chunks that do not exist and they were removed.
   * Surfaced in the UI: a point whose grounding was partly invented deserves
   * to be read with more suspicion than one that was clean.
   */
  flagged: boolean;
}

export interface CitationReport {
  /** Individual chunk IDs discarded because no such chunk exists. */
  droppedCitations: number;
  /** Key points discarded entirely because nothing they cited was real. */
  droppedKeyPoints: number;
  /** Key points that kept some citations but lost others. */
  flaggedKeyPoints: number;
}

export interface ValidatedAnalysis {
  summary: string;
  keyPoints: ValidatedKeyPoint[];
  documentType: DocumentType;
  citations: CitationReport;
}

/**
 * The schema handed to the API as a structured output constraint.
 *
 * Written as plain JSON Schema rather than through Zod: it is the only schema
 * in the project, it is data rather than code, and adding a validation library
 * to express one object shape would be a dependency the reader has to learn
 * for no benefit. The SDK's `jsonSchemaOutputFormat` helper types
 * `parsed_output` from this directly.
 */
export const ANALYSIS_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "A 3-5 sentence summary of the document.",
    },
    keyPoints: {
      type: "array",
      items: {
        type: "object",
        properties: {
          point: { type: "string" },
          chunkIds: {
            type: "array",
            items: { type: "integer" },
            description: "IDs of the numbered lines this point derives from.",
          },
        },
        required: ["point", "chunkIds"],
        additionalProperties: false,
      },
    },
    documentType: {
      type: "string",
      enum: ["academic", "legal", "financial", "technical", "other"],
    },
  },
  required: ["summary", "keyPoints", "documentType"],
  additionalProperties: false,
} as const;

export class AnalysisFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisFormatError";
  }
}

function isDocumentType(value: unknown): value is DocumentType {
  return (
    typeof value === "string" &&
    DOCUMENT_TYPES.includes(value as DocumentType)
  );
}

/**
 * Turn an untrusted string into a `RawAnalysis`, or throw.
 *
 * Structured outputs make well-formed JSON the overwhelmingly likely case, so
 * this is a backstop rather than the main path — but it is a backstop worth
 * having, because the alternative to "throw a clear error" is "read
 * `undefined.map` in a React component". It also tolerates the two things
 * models do even when told not to: wrap the object in ```json fences, and
 * write a sentence before it.
 */
export function parseAnalysis(text: string): RawAnalysis {
  let candidate = text.trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(candidate);
  if (fenced?.[1] !== undefined) candidate = fenced[1].trim();

  // Tolerate a preamble by taking the outermost braces.
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) {
    throw new AnalysisFormatError("The model did not return a JSON object.");
  }
  candidate = candidate.slice(first, last + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new AnalysisFormatError("The model returned malformed JSON.");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AnalysisFormatError("The model did not return a JSON object.");
  }

  const record: Record<string, unknown> = { ...parsed };

  if (typeof record.summary !== "string") {
    throw new AnalysisFormatError("The analysis is missing a summary.");
  }
  if (!Array.isArray(record.keyPoints)) {
    throw new AnalysisFormatError("The analysis is missing key points.");
  }

  const keyPoints: RawKeyPoint[] = [];
  for (const item of record.keyPoints) {
    if (typeof item !== "object" || item === null) continue;
    const entry: Record<string, unknown> = { ...item };
    if (typeof entry.point !== "string") continue;
    // A non-array or missing chunkIds becomes an empty citation list, which
    // the validator then drops. Malformed grounding is treated as absent
    // grounding rather than as a reason to reject the whole response.
    const ids = Array.isArray(entry.chunkIds) ? entry.chunkIds : [];
    const chunkIds: number[] = [];
    for (const id of ids) {
      if (typeof id === "number" && Number.isFinite(id)) chunkIds.push(id);
    }
    keyPoints.push({ point: entry.point, chunkIds });
  }

  return {
    summary: record.summary,
    keyPoints,
    documentType: isDocumentType(record.documentType)
      ? record.documentType
      : "other",
  };
}
