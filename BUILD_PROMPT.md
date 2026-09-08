# Build Prompt: AI PDF Reader

**Paste this into Claude Code at the root of a new empty directory.**

---

## Project

Build an AI PDF reader: a user uploads a PDF, the app reads it aloud sentence by sentence with the current sentence highlighted, and generates a summary plus key points that are grounded in specific sentences of the document.

**Stack:** Next.js 15 (App Router), TypeScript strict mode, Tailwind v4, deployed to Vercel. No database in v1.

**Owner context:** I am learning this stack deliberately. I need to be able to explain every architectural decision in this codebase. Do not introduce libraries, patterns, or abstractions without explaining why they're there and what the alternative was.

---

## Hard rules

1. **Stop at every phase gate.** Do not proceed to the next phase until I say so. At each gate, explain what you built and why, then wait.
2. **No `any`.** TypeScript strict mode, no escape hatches. If typing is hard, say so and explain the tradeoff.
3. **Pure logic gets unit tests.** Chunking and citation validation are pure functions and must have tests that pass before their phase gate.
4. **No database, no auth, no accounts.** State lives in React. Refresh clears it. This is intentional.
5. **Maintain `ARCHITECTURE.md`** as you go — every significant decision, the alternative considered, and why this one won.
6. **No secrets in code.** Environment variables only, with a `.env.example` committed.

---

## Phase 0 — Scaffold and types

Create the Next.js 15 project with TypeScript strict, Tailwind v4, and Vitest.

Define the core domain types in `lib/types.ts` before writing any feature code:

```ts
interface Chunk {
  id: number;           // stable, sequential, used as citation anchor
  pageNumber: number;
  text: string;
  charStart: number;    // offset in the full document text
}

interface ParsedDocument {
  filename: string;
  pageCount: number;
  chunks: Chunk[];
  hasTextLayer: boolean;   // false = scanned PDF
}
```

Start `ARCHITECTURE.md` with a "Domain model" section explaining why `Chunk` is the central abstraction — it serves as the audio queue unit, the highlight unit, and the citation anchor simultaneously.

**GATE 0:** Explain the type design and why chunk IDs are stable sequential integers rather than UUIDs or page-relative indices.

---

## Phase 1 — PDF extraction (client-side)

Install `pdfjs-dist`. Build a client-side extractor.

Requirements:

- File picker plus drag-and-drop. Accept only `.pdf`.
- Extraction runs entirely in the browser. The file never uploads.
- **Configure the pdf.js worker correctly for Next.js.** Copy the worker into `public/` and set `GlobalWorkerOptions.workerSrc`. Do not rely on bundler resolution from `node_modules` — explain why it fails.
- **Reconstruct reading order.** pdf.js returns positioned text items, not paragraphs. Sort by vertical position, then detect multi-column layouts by clustering x-coordinates and reading columns in order. Naive concatenation interleaves columns on academic papers and produces gibberish. Implement the column detection; explain your heuristic and where it will fail.
- **Detect scanned PDFs.** If average extracted characters per page is under 100, set `hasTextLayer: false` and show a clear message explaining that OCR is not supported. Do not attempt to read an empty document aloud.
- Show progress during extraction — large PDFs take seconds.

Render the extracted text on screen so I can visually verify reading order before anything else is built on top of it.

**GATE 1:** Show me extraction working on both a single-column and a two-column PDF. Explain the column detection heuristic and what document layouts will break it.

---

## Phase 2 — Sentence chunking

Write `lib/chunker.ts` as a **pure function**: `(pages: PageText[]) => Chunk[]`.

Handle these correctly, and write a test for each:

- Abbreviations: `Dr.`, `Fig.`, `et al.`, `Inc.`, `vs.`
- Decimals: `3.14`, `$1.5M`
- Citations: `[3].`, `(Smith 2020).`
- Ellipses: `...`
- Sentences spanning a page break — the chunk keeps the page number where it started
- Very long sentences (over ~400 chars): split at clause boundaries so no single audio chunk is unwieldy
- Headings and fragments with no terminal punctuation

Do not use a heavyweight NLP library. A well-tested regex-plus-rules approach is correct here and I need to understand it.

Tests must pass before the gate.

**GATE 2:** Walk me through the chunking rules and show the test suite passing. Explain why sentence-level granularity was chosen over paragraph-level or fixed-token-count.

---

## Phase 3 — The player (the core of the app)

This is the most important phase. Build it carefully.

### 3a — Provider interface

```ts
interface TTSProvider {
  speak(chunk: Chunk, signal: AbortSignal): Promise<void>;
  cancel(): void;
  getVoices(): Promise<Voice[]>;
}
```

Implement `WebSpeechProvider` using the browser `speechSynthesis` API. This is v1's only provider: free, no server, no latency. Its `onstart` and `onend` events give sentence-level sync directly.

### 3b — The queue

Build a `usePlayer` hook managing:

- Current chunk index
- Playing / paused / stopped state
- **Lookahead**: the design must support generating chunk N+1 while N plays. Web Speech doesn't need this, but the interface and queue structure must accommodate it so Phase 5 is a drop-in swap. Explain how the queue is structured to allow this.
- Clean cancellation via `AbortSignal` on pause, stop, or jump — no orphaned utterances continuing after the user pauses.

Known Web Speech pitfalls to handle explicitly: `getVoices()` returns empty until the `voiceschanged` event fires; Chrome silently stops long utterances after ~15 seconds; cancel-then-immediately-speak races. Handle all three and document them in `ARCHITECTURE.md`.

### 3c — The UI

- Document text rendered as chunks, the active chunk visibly highlighted
- Auto-scroll to keep the active chunk in view, but **disable auto-scroll if the user scrolls manually**, and re-enable when they click a chunk
- Controls: play/pause, previous/next sentence, speed (0.75x–2x), voice picker
- Click any sentence to jump playback there
- Progress indicator: sentence position and page number

Design it properly — real typographic hierarchy, comfortable reading measure (~65–75 characters per line), mobile-first. This is a reading interface; it should feel like one.

**GATE 3:** Demo the player. Explain the queue's cancellation model and how the lookahead structure will accept a network-backed provider without changing the UI layer.

---

## Phase 4 — Summary and grounded key points

Server route: `app/api/analyze/route.ts`. Anthropic API key from environment.

**Request:** the chunks, serialized as numbered lines: `[12] The sentence text here.`

**Prompt requirements:**
- System prompt instructs the model to return JSON only — no preamble, no markdown fences
- Every key point must cite the chunk IDs it derives from
- The model must not paraphrase beyond what the cited chunks support

**Response schema:**

```ts
{
  summary: string;                                        // 3-5 sentences
  keyPoints: Array<{ point: string; chunkIds: number[] }>;
  documentType: "academic" | "legal" | "financial" | "technical" | "other";
}
```

**Citation validation is mandatory and happens server-side.** Write `lib/validateCitations.ts` as a pure, unit-tested function:

- Every cited chunk ID must exist in the submitted document
- A key point with zero valid citations is dropped entirely
- A key point with a mix of valid and invalid IDs keeps the valid ones and is flagged
- The response reports how many citations were dropped

Do not trust the model's citations. Verify them mechanically. Explain in `ARCHITECTURE.md` why this validation layer exists.

**UI:** summary panel alongside the reader. Each key point shows its source page and is clickable — clicking jumps the player to the first cited chunk and highlights it.

Handle: documents too large for one call (over ~150k tokens → say so clearly, do not silently truncate), API errors, malformed JSON, rate limits.

**GATE 4:** Show the analysis working. Then deliberately test the validation by feeding a fabricated citation ID through the validator and showing it gets dropped.

---

## Phase 5 — OpenAI TTS provider (optional, do not start unless I ask)

Implement `OpenAITTSProvider` against the existing interface.

- Server route generates audio per chunk, never per document — explain the Vercel timeout constraint
- Client-side lookahead: prefetch the next 2 chunks while the current one plays
- Cache key: hash of `chunk.text + voice + speed`. Cache in memory for v1; the key design should survive a move to persistent storage.
- Provider toggle in the UI so I can compare quality and measure latency
- Log estimated cost per document so I can see the economics

**GATE 5:** Compare the two providers on latency and quality. Report measured cost for a 20-page document.

---

## Phase 6 — Ship

- Deploy to Vercel
- `README.md`: what it does, how to run locally, environment variables, architecture summary, known limitations
- `ARCHITECTURE.md` complete
- Verified working on mobile

---

## Explicitly out of scope

Do not build any of these unless I ask: OCR for scanned PDFs, user accounts, a database, saved documents, highlights or notes, background audio on mobile, multi-document search, RAG or a vector store, chat-with-your-PDF.