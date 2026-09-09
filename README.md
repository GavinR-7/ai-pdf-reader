# AI PDF Reader

Upload a PDF, have it read aloud sentence by sentence with the current sentence
highlighted, and get a summary plus key points that are grounded in specific
sentences of the document — with every citation checked against the source
before you see it.

The PDF is parsed **entirely in your browser**. The file is never uploaded.

---

## What it does

- **Reads a PDF in the browser.** Drag-and-drop or file picker; pdf.js runs in a
  Web Worker, with progress shown per page.
- **Reconstructs reading order.** Detects two-column layouts and reads the
  columns in order instead of interleaving them — the thing that turns an
  academic paper into gibberish if you get it wrong.
- **Detects scanned PDFs** and says so plainly rather than reading silence.
- **Splits into sentences** with rules for abbreviations (`Dr.`, `Fig.`,
  `et al.`), decimals (`3.14`, `$1.5M`), citations (`[3].`), section numbers,
  and sentences that span a page break.
- **Reads aloud** through the browser's speech synthesis, one sentence per
  utterance, with the active sentence highlighted and auto-scrolled into view.
  Click any sentence to jump there.
- **Summarises and extracts key points** via the Anthropic API, where every key
  point cites the sentences it came from and **the citations are verified
  server-side**. Invented citations are dropped; a key point with no valid
  citation left is dropped entirely.

---

## Running it locally

Requires Node 22+ (developed on 24).

```bash
npm install          # also copies pdf.js assets into public/pdfjs/
npm run dev          # http://localhost:3000
```

Everything except the summary works with no API key at all.

### Environment variables

Copy `.env.example` to `.env.local` and fill in:

| Variable | Required for | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | The summary panel only | Server-side only. Deliberately has no `NEXT_PUBLIC_` prefix — that would ship it to the browser. |

Without it, extraction, chunking and read-aloud all work; the analyse button
returns a clear "not configured" message.

### Scripts

| Command | Does |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` | Production build |
| `npm test` | Unit tests (81) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |

### Dev harnesses

Two scripts run the pure pipeline over a real PDF in Node, without a browser —
useful for checking extraction and chunking against a real document:

```bash
node --experimental-strip-types scripts/verify-extract.mts <file.pdf> 1 2 3
node --experimental-strip-types scripts/verify-chunks.mts  <file.pdf> 6
```

---

## Architecture in brief

Full reasoning — every decision, the alternative considered, and why this one
won — is in [ARCHITECTURE.md](./ARCHITECTURE.md).

**One unit of position: the `Chunk`.** A chunk is one sentence, and it is
simultaneously the audio queue's entry, the highlight's span, and a citation's
anchor. Because all three agree, "click a key point, jump playback there and
highlight it" is a single number rather than a mapping layer. Chunk IDs are
stable sequential integers because they have to survive a round trip through a
language model and be verifiable by a range check.

```
PDF file
  │  lib/extractPdf.ts        browser only: pdf.js, worker, progress
  ▼
PositionedItem[]             per page, rotation and NaN rejected at the boundary
  │  lib/readingOrder.ts      PURE: column detection, banding, line assembly
  ▼
PageText[]
  │  lib/chunker.ts           PURE: sentence rules, page-spanning, long-sentence splits
  ▼
Chunk[]  ──────────────┬─────────────────────────────┐
                       │                             │
   lib/playbackQueue.ts│ PURE: order, cancel,    POST /api/analyze
   + webSpeechProvider │ lookahead                   │  server only, key here
                       ▼                             ▼
                  read aloud              lib/validateCitations.ts  PURE
                                                     ▼
                                          summary + grounded key points
```

Layout reasoning, chunking, the playback queue and citation validation are all
pure functions with no DOM, network, or pdf.js dependency. That is what makes
them testable, and it is why the tests are literals rather than fixtures.

**No database, no auth, no accounts.** State lives in React and refresh clears
it. This is intentional.

---

## Known limitations

Stated plainly, because the heuristics are confident and wrong in specific ways.

**Reading order**

- **Three or more columns** — the detector finds one gutter, so a
  three-column layout reads as two with one scrambled.
- **Tables** — column gaps inside a wide table look exactly like a page gutter.
  Tabular data interleaves.
- **Rotated or vertical text**, and right-to-left scripts, are not supported.
  Off-horizontal runs are dropped (which is what removes the vertical arXiv
  stamp from the text).
- **Mathematics** — displayed equations are two-dimensional and linearise into
  nonsense. They are read aloud as gibberish.
- **Figures** — in-figure labels are pulled in near their vertical position, so
  a caption can arrive with axis labels attached.

**Chunking**

- A sentence genuinely *ending* in a known abbreviation ("…by Smith et al. The
  method…") stays merged with the next. Deliberate: over-splitting corrupts an
  utterance, a highlight, and a citation target at once, while under-splitting
  just yields a longer chunk.
- A page ending with an unpunctuated heading runs into the next page's first
  sentence.

**Reading aloud**

- Voice quality is whatever the browser provides, and it varies a lot between
  browsers and platforms.
- Web Speech has no background audio on mobile — locking the screen stops
  playback.

**Analysis**

- Documents over ~150k estimated tokens are **refused, not truncated**.
- Citation validation proves a cited sentence *exists*. It cannot prove the
  sentence *supports* the claim — that check is mechanical, not semantic.

**Not built, on purpose:** OCR for scanned PDFs, accounts, a database, saved
documents, highlights or notes, background audio, multi-document search, RAG,
chat-with-your-PDF.
