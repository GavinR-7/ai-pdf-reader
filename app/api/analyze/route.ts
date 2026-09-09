/**
 * POST /api/analyze — summary plus key points grounded in specific sentences.
 *
 * This is the only server-side code in the app and the only place the
 * Anthropic key is read. The PDF itself never reaches a server; its *text*
 * does, which is a real distinction and one the UI states plainly.
 */

import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { NextResponse } from "next/server";
import {
  ANALYSIS_JSON_SCHEMA,
  AnalysisFormatError,
  parseAnalysis,
  type RawAnalysis,
} from "@/lib/analysis";
import { validateCitations } from "@/lib/validateCitations";

/**
 * Analysis with adaptive thinking over a long document is not a two-second
 * request. Vercel's default serverless timeout would cut it off mid-flight.
 */
export const maxDuration = 60;

/**
 * Refuse rather than truncate above this.
 *
 * Note this is **not** the model's context limit — Claude Opus 5 has a 1M
 * token window, so a 150k-token document fits comfortably. It is a deliberate
 * cost and latency guard: at $5/1M input tokens, 150k tokens is roughly $0.75
 * of input per analysis, which is about as much as this app should spend
 * without the reader having asked for it.
 *
 * The important part is what happens at the limit: the request is **rejected
 * with an explanation**, never silently truncated. A summary of the first
 * third of a document, presented as a summary of the document, is a wrong
 * answer that looks like a right one.
 */
const MAX_INPUT_TOKENS = 150_000;

/**
 * Rough token estimate at ~4 characters per token for English prose.
 *
 * Deliberately not a call to the token-counting API: that is a second network
 * round trip on every request to refine a number that only needs to be right
 * to within a rough margin, and the estimate is used with a generous
 * threshold. If documents near the limit start being wrongly rejected,
 * `client.messages.countTokens` is the exact answer.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const SYSTEM_PROMPT = `You summarise documents and ground every claim in the source text.

You will be given a document as numbered lines, one sentence per line:

[0] The first sentence.
[1] The second sentence.

Produce:
- summary: 3 to 5 sentences describing what the document says and why it matters.
- keyPoints: the most important specific claims in the document. For each, cite the IDs of the numbered lines it derives from.
- documentType: one of academic, legal, financial, technical, other.

Rules for citations, which matter more than fluency:
- Cite only line IDs that appear in the document you were given. Never invent one.
- Every key point must cite at least one line, and those lines must actually support it.
- Do not generalise beyond what the cited lines say. If the document does not support a claim, leave it out.
- Prefer citing the one or two lines that state the claim most directly over citing a whole region.
- Write each key point as a complete sentence that stands on its own, not as a fragment or heading.`;

interface AnalyzeRequestChunk {
  id: number;
  text: string;
}

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    return badRequest(
      "The server has no ANTHROPIC_API_KEY configured, so analysis is unavailable.",
      503,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body was not valid JSON.");
  }

  if (typeof body !== "object" || body === null || !("chunks" in body)) {
    return badRequest("Request body must include a `chunks` array.");
  }

  const rawChunks = (body as { chunks: unknown }).chunks;
  if (!Array.isArray(rawChunks)) {
    return badRequest("`chunks` must be an array.");
  }
  if (rawChunks.length === 0) {
    return badRequest("There is nothing to analyse — the document has no text.");
  }

  const chunks: AnalyzeRequestChunk[] = [];
  for (const raw of rawChunks) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry: Record<string, unknown> = { ...raw };
    if (typeof entry.id !== "number" || typeof entry.text !== "string") continue;
    chunks.push({ id: entry.id, text: entry.text });
  }

  if (chunks.length !== rawChunks.length) {
    return badRequest("Every chunk must have a numeric `id` and a string `text`.");
  }

  // The exact serialisation the system prompt describes. Numbered lines are
  // what make citation possible at all: the model can only cite an ID it can
  // see, and the ID it sees is the chunk's real index.
  const document = chunks.map((chunk) => `[${chunk.id}] ${chunk.text}`).join("\n");

  const estimated = estimateTokens(document);
  if (estimated > MAX_INPUT_TOKENS) {
    return badRequest(
      `This document is too large to analyse in one request — roughly ${estimated.toLocaleString()} tokens against a ${MAX_INPUT_TOKENS.toLocaleString()} limit. It has not been analysed, and nothing was truncated: a summary of part of a document, presented as a summary of the whole, would be misleading. Try a shorter document or an extract.`,
      413,
    );
  }

  const client = new Anthropic({ apiKey });

  let raw: RawAnalysis;
  let usage: { input: number; output: number } = { input: 0, output: 0 };

  try {
    // Streamed rather than a plain create: a long document plus adaptive
    // thinking can run past the SDK's HTTP timeout on a non-streaming request.
    // `finalMessage()` still gives one complete response to work with.
    const stream = client.messages.stream({
      model: "claude-opus-5",
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "medium",
        // Structured outputs constrain the response to this schema, so
        // "the model wrote prose instead of JSON" stops being a failure mode.
        // It does *not* make the citations true — a schema can require an
        // array of integers, but it cannot know which integers exist. That is
        // what validateCitations is for, and why both layers are here.
        format: jsonSchemaOutputFormat(ANALYSIS_JSON_SCHEMA),
      },
      messages: [
        {
          role: "user",
          content: `Here is the document as numbered lines.\n\n${document}`,
        },
      ],
    });

    const message = await stream.finalMessage();
    usage = {
      input: message.usage.input_tokens,
      output: message.usage.output_tokens,
    };

    if (message.stop_reason === "refusal") {
      return badRequest(
        "The model declined to analyse this document.",
        422,
      );
    }

    if (message.parsed_output !== null && message.parsed_output !== undefined) {
      raw = message.parsed_output;
    } else {
      // Backstop: structured outputs should make this unreachable, but
      // reading `undefined` in a React component is a worse outcome than
      // re-parsing the text ourselves.
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      raw = parseAnalysis(text);
    }
  } catch (cause) {
    if (cause instanceof AnalysisFormatError) {
      return badRequest(`The analysis could not be read: ${cause.message}`, 502);
    }
    if (cause instanceof Anthropic.RateLimitError) {
      return badRequest(
        "The analysis service is rate limited right now. Wait a moment and try again.",
        429,
      );
    }
    if (cause instanceof Anthropic.AuthenticationError) {
      return badRequest("The server's Anthropic API key was rejected.", 502);
    }
    if (cause instanceof Anthropic.APIConnectionError) {
      return badRequest("Could not reach the analysis service.", 504);
    }
    if (cause instanceof Anthropic.APIError) {
      return badRequest(`The analysis service returned an error (${cause.status}).`, 502);
    }
    console.error("[analyze] unexpected failure", cause);
    return badRequest("Analysis failed unexpectedly.", 500);
  }

  // The mandatory step. Everything above this line is untrusted.
  const validated = validateCitations(raw, chunks.length);

  // Rough cost, logged server-side so the economics are visible during
  // development. Claude Opus 5: $5/1M input, $25/1M output.
  const cost = (usage.input * 5) / 1_000_000 + (usage.output * 25) / 1_000_000;
  console.log(
    `[analyze] ${chunks.length} chunks · ${usage.input} in / ${usage.output} out · ~$${cost.toFixed(4)} · ` +
      `${validated.keyPoints.length} key points · ${validated.citations.droppedCitations} citations dropped`,
  );

  return NextResponse.json(validated);
}
