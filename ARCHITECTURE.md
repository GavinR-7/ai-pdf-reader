# Architecture

A running record of the decisions in this codebase: what was chosen, what the
alternative was, and why this one won. Appended to as each phase lands.

**Status:** Phase 1 complete (extraction and reading order).

---

## Domain model

### `Chunk` is the central abstraction

The app has three features that look unrelated:

1. **Reading aloud** — feed text to a speech engine one utterance at a time.
2. **Highlighting** — show the reader which part of the document is being read.
3. **Grounded key points** — let a summary point say "this claim comes from
   *here* in the document" and let the user click through to it.

Each of these needs to name a *piece* of the document, and the naive move is to
let each one pick its own unit: the player queues paragraphs, the renderer
highlights whatever DOM node it drew, the citation layer refers to page numbers
or character offsets. That produces three coordinate systems and a permanent
translation problem between them — "the model cited page 4, which paragraph do
I scroll to, and which utterance is playing?"

So the app defines one unit, the `Chunk` (one sentence), and all three features
address the document through it:

| Feature | What a `Chunk` is to it |
|---|---|
| Player | one queue entry, one utterance |
| Reader | one highlightable span |
| Citations | one anchor, addressed by `id` |

Because the three agree, the interesting interactions are trivial rather than
plumbing. "Click a key point, jump playback there and highlight it" is
`setCurrentIndex(chunkId)` — one number, understood identically by the queue
and the renderer. Had the units differed, that single line would have been a
mapping layer, and mapping layers are where drift and off-by-ones live.

The cost of this choice is that the whole app inherits the chunker's mistakes.
A bad sentence split is simultaneously a bad utterance, a bad highlight, and a
bad citation target. That is precisely why `lib/chunker.ts` is a pure function
with a test per rule (Phase 2): it is the one place where an error is
guaranteed to be visible everywhere.

### Why chunk IDs are stable sequential integers

`Chunk.id` is the chunk's zero-based position in `ParsedDocument.chunks` —
not a UUID, not `page 4, sentence 2`.

**Versus UUIDs.** The IDs' hardest job is surviving a round trip through a
language model: they go into the prompt as `[12] The sentence text.` and come
back as `chunkIds: [12, 13]`. A small integer is one token and is echoed
back reliably. A UUID is a dozen-odd tokens of high-entropy hex, and a model
that miscopies one character produces a citation that fails validation for no
reason a user could ever understand. Integers also make validation a range
check (`0 <= id < chunks.length`) instead of a set membership lookup, make the
prompt dramatically cheaper — hundreds of IDs per document, and the ID text is
paid for on every request — and make debugging legible: `[12]` in a log tells
you where you are in the document; a UUID tells you nothing. UUIDs buy global
uniqueness across documents, which matters when there is a database. There is
no database (hard rule 4), and a `ParsedDocument` is the only scope that
exists.

**Versus page-relative indices** (`{ page: 4, index: 2 }`). This is a
composite key, so every comparison, every "is this chunk before that one",
every queue operation becomes a two-field comparison instead of `a < b`.
Worse, it does not survive the case the chunker is explicitly required to
handle: a sentence that spans a page break belongs to two pages, and any
scheme keyed on page has to arbitrate that at every call site. With a flat
sequential ID, the page is just an *attribute* of the chunk
(`pageNumber`, defined as where the sentence started) rather than part of its
identity, so a page-break sentence is unremarkable — one chunk, one ID, one
page number recorded for display.

**What "stable" means here.** The ID is an address into a specific
`ParsedDocument`, and it is permanent for that document's lifetime. This is
what makes server-side citation validation possible at all: chunks go out to
the model, IDs come back, and the server can check them against the array it
was given (Phase 4). The invariant `chunks[i].id === i` is therefore load-
bearing, and it constrains the code: nothing downstream of the chunker may
filter, sort, merge, or renumber the array, because doing so silently
repoints every citation. The chunker is the only producer of IDs; everything
else treats them as read-only. There is a test asserting the invariant in
`lib/types.test.ts`, and it is not a formality — it is the thing that breaks
first if someone later "optimises" the array.

The ID is deliberately *not* durable across re-parses. Re-upload the same PDF
after a change to the chunking rules and the IDs may mean something different.
That is acceptable because nothing is persisted (hard rule 4) — but it is the
reason `charStart` exists.

### Why `charStart` is on the type when nothing needs it yet

`charStart` is the chunk's character offset in the full document text. Nothing
in Phase 0–3 reads it. It is on the type because it is the only field that
ties a chunk back to the source document independently of the chunking rules.
If the rules change, chunk IDs shift meaning; character offsets don't. That
makes it the migration path (map old IDs to new ones by offset rather than
discarding citations), and it enables progress measured by document length
rather than sentence count — sentences vary in length by an order of
magnitude, so "sentence 40 of 200" is a poor progress bar. Cheap to record at
chunking time, expensive to reconstruct later.

### Why `hasTextLayer` is a field and not an inference

A scanned PDF is page images with no embedded text. Extraction "succeeds" and
returns almost nothing, and the failure mode is an app that renders a blank
document and reads silence aloud. Any caller could infer the condition by
inspecting `chunks.length`, but "could infer" means "will forget". Making it a
required boolean on `ParsedDocument` means the UI has to acknowledge it, and
the app can say plainly that OCR is out of scope rather than appearing broken.

### Why `PageText` is a separate type

`PageText[]` is the seam between extraction (Phase 1, browser-only, needs
pdf.js and a worker) and chunking (Phase 2, pure, needs nothing). Naming it
keeps the chunker's signature `(pages: PageText[]) => Chunk[]`, which is what
allows chunking rules to be tested with a string literal instead of a PDF
fixture, a browser, and a worker thread. The alternative — chunking directly
from pdf.js text items — welds the two phases together and makes the
most rule-dense code in the app the hardest to test.

---

## Reading order (Phase 1)

### The problem

pdf.js does not return paragraphs. `getTextContent()` returns *text runs* with
a position, in content-stream order — which is drawing order, not reading
order. On a two-column paper, concatenating them (or sorting by vertical
position) interleaves the columns: line 1 of the left column, line 1 of the
right, line 2 of the left, and so on. The output is unreadable, and every
downstream feature inherits it.

The work is split so the hard part is testable:

| Module | Job | Testable how |
|---|---|---|
| `lib/extractPdf.ts` | pdf.js, workers, files, progress | by hand, in a browser |
| `lib/readingOrder.ts` | all layout reasoning, pure | 17 unit tests, no PDF needed |

### Why the pdf.js worker is copied into `public/`

pdf.js starts its parser with `new Worker(workerSrc)`, and that constructor
takes **a URL the browser fetches at run time**, not a module specifier a
bundler can follow. Pointing it into `node_modules` fails four separate ways,
and the failure mode is a silent hang rather than an error:

1. `node_modules` is not served — nothing under it has a URL in production.
2. Importing the worker instead asks the bundler to inline ~1.3MB of parser
   into the main client chunk. A worker is a *separate execution context*;
   code pulled into the page's context is not a worker, and pdf.js will not
   use it as one.
3. The `new URL("…", import.meta.url)` trick some bundlers special-case is
   handled inconsistently by Turbopack between dev and production, so it can
   work locally and break on Vercel.
4. A CDN copy works but decouples the worker's version from the installed one.
   pdf.js compares the two and refuses to run on a mismatch, so `npm update`
   would break the app at run time instead of at build time.

`scripts/copy-pdf-assets.mjs` therefore copies the worker, `standard_fonts/`
(base-14 font metrics) and `cmaps/` (CJK character maps) out of the installed
package on `postinstall` and `prebuild`. The served files are version-locked to
the API by construction, and `public/pdfjs/` is gitignored because it is
generated, not authored.

### The column-detection heuristic

**A real gutter is a vertical line that almost nothing crosses.** So sweep a
candidate split across the middle half of the page and, for each position,
count the text items straddling it. A two-column page has a position where that
count collapses to nearly zero while both sides still hold plenty of text. A
single-column page has no such position, because every full-width line crosses
every candidate.

Measured across the two fixtures in `test-pdfs/`:

| Layout | Straddling items at best split | Balance (lighter side's share) |
|---|---|---|
| ResNet, CVPR two-column, pp. 1–8 | **0–3%** | 39–49% |
| "Attention Is All You Need", single column, pp. 1–8 | **12–44%** | 6–37% |

The two populations do not overlap, and the thresholds sit in the empty gap
between them: **≤6% straddle** and **≥25% balance**, with at least 20 items on
the page before guessing at all.

Two details matter more than the numbers:

- **Count items, not lines.** Left- and right-column text on the same visual
  row shares a baseline. Grouping into lines *first* merges the two columns
  into one line that straddles every candidate and destroys the signal.
  Geometry first, lines second.
- **Detect per page, not per document.** A paper's title page, its body, and
  its references pages can differ, and per-page detection handles that for
  free.

Rejected alternative: looking for a **blank vertical strip** (zero ink over a
≥12pt band). Tried first, and it found nothing on the real two-column paper —
a single full-width figure or caption closes the gutter and the test collapses
to "no columns". Counting crossings degrades gracefully where a binary
occupancy test does not.

### Full-width elements: banding

Once a gutter is found, items are cut into left, right, and **full-width**
(those crossing it — a title, a banner figure caption, a table). Full-width
lines act as horizontal rules dividing the page into bands, and reading runs
band by band: everything above the first full-width line (left column, then
right), then that line, then the next band.

Without this, a page that opens with a full-width title over two columns reads
its title somewhere in the middle of the left column. With it, the ResNet title
page comes out title → authors → affiliation → abstract, correctly.

### Block boundaries, and why they exist

Extraction emits `\n` between blocks and spaces within them. The chunker
(Phase 2) treats `\n` as a hard boundary, which is what stops a heading being
glued to the paragraph beneath it. Two signals mark a boundary:

- **Vertical gap** greater than 1.4× the normal line spacing. "Normal" is the
  25th percentile of gaps, *not* the median: within a paragraph, leading is
  regular and tight, so the bottom quartile is the leading. The median breaks
  down on short blocks — a three-line block ending in a heading has gaps
  [12, 48] and a median of 30, which declares the heading to be normal spacing.
- **Type size change** over 5%. Measured on the ResNet paper: body 10.0pt,
  subsection heading 11.0pt, section heading 12.0pt. Spacing alone misses the
  heading-to-heading transition by a tenth of a point; size catches it cleanly.
  Within a paragraph the size is constant, so any real change marks structure.

`1.4` and `5%` are tuned against real documents, and both are recorded here
because they are exactly the kind of magic number that looks arbitrary later.

### Spacing and hyphenation

The PDF's **own space runs are preserved**, not discarded and re-derived. An
early version filtered out whitespace items before assembling lines, which
threw away the most reliable spacing information in the file and produced
`withxdenoting`. Coordinates are the *fallback*, for documents that encode no
spaces: a gap wider than 0.18 × type size inserts one. That constant is also
measured — a real inter-word space in the ResNet paper is 2.41pt against a 10pt
type size, so a threshold at 0.25 (2.5pt) fuses words.

A trailing hyphen before a lowercase word is treated as a word broken across
lines and rejoined. This is wrong for a genuine compound that happens to break
at its hyphen (`multi-` / `head` → `multihead`), which is rarer than broken
words and costs a word rather than a sentence.

### Where this will break

Stated plainly, because the heuristic is confident and wrong in specific ways:

- **Three or more columns.** The detector finds one gutter. A three-column
  newsletter reads as two columns with one of them scrambled.
- **Tables.** Column gaps inside a wide table look exactly like a page gutter
  to a crossing-count sweep. Tabular data will interleave.
- **Rotated or vertical text**, and right-to-left scripts. Everything here
  assumes left-to-right rows with a shared baseline.
- **Sidebars and pull quotes** that sit inside a column's x-range but are not
  part of its flow get read inline, mid-sentence.
- **Mathematics.** Displayed equations are laid out in two dimensions and are
  linearised into nonsense (`QKT`, stray `√`). They are read aloud as gibberish.
  Out of scope to fix; worth knowing before wondering why.
- **Figures.** In-figure labels sit at arbitrary positions and are pulled into
  the text near their y-coordinate, so a caption can arrive with axis labels
  attached.

### Detecting a scanned PDF

`hasTextLayer` is false when average extracted characters per page fall below
**100**. A page of ordinary prose holds 1500–3000, so the threshold is an order
of magnitude clear of any real text page. It is not zero because scanned PDFs
are rarely perfectly empty — a producer watermark or a stamped page number is
common — and a zero test would call such a file readable and then read four
words aloud.

### Quarantining pdf.js's `any`

pdf.js declares `TextItem.transform` as `Array<any>`, so the x and y
translation arrive untyped. Hard rule 2 bans `any` in our code, and a cast
would be a lie — nothing guarantees those entries are numbers.

`toPositionedItem()` in `lib/extractPdf.ts` is the single place this surface is
touched. It validates with `typeof` and `Number.isFinite` and returns
`PositionedItem | null`; items that fail are dropped, because an item with no
position cannot be placed in reading order and a `NaN` would poison the
geometry for the whole page. One boundary, one runtime check, honest types
everywhere downstream.

---

## Toolchain

| Decision | Alternative considered | Why |
|---|---|---|
| Next.js 15.5.25, App Router | Next 16 (current latest) | The brief specifies Next 15. 16 is out but changes enough (React 19.2+, config surface) that it would be a learning tax unrelated to the app. |
| Vitest | Jest | Shares Vite's TypeScript/ESM handling, so tests run TS with no separate Babel or ts-jest transform to configure. Jest needs that transform layer, and the failure modes of getting it wrong are opaque. |
| `environment: "node"` in tests | jsdom | Everything under test is a pure function. jsdom would be startup cost buying no coverage. Revisit if a hook ever needs testing. |
| `globals: false`, explicit imports | `globals: true` | `import { describe, it, expect } from "vitest"` is visible in the file and needs no ambient type wiring in tsconfig. |
| Manual `@/` alias in `vitest.config.mts` | `vite-tsconfig-paths` | One alias is not worth a dependency. If the list grows past two or three, take the plugin. |
| `noUncheckedIndexedAccess: true` | plain `strict` | The player indexes a queue constantly (`chunks[i + 1]` for lookahead) and the end-of-document case is exactly where an off-by-one hides. This turns it into a compile error. Cost: genuine index reads need a guard — and since `!` is also banned (below), that guard is a real runtime check, which is the point. |
| `no-explicit-any`, `no-non-null-assertion`, and `consistent-type-assertions` (`objectLiteralTypeAssertions: "never"`) as **errors** | leave as warnings | Hard rule 2 is "no escape hatches". `next/typescript` ships `no-explicit-any` as a warning, which means it gets scrolled past. As errors, the build fails instead of the debt accruing. The third rule bans `{ ... } as Foo`, which skips excess-property checking and would let a malformed `Chunk` through silently. Plain narrowing casts stay legal — pdf.js returns loose unions and narrowing one after a runtime check is honest; inventing a shape is not. |
| `@types/node@^24` | `^20` from the scaffold | Vitest 5 requires `^22 \|\| >=24`; the dev machine runs Node 24.17. Aligning the types to the actual runtime is the honest fix — the alternative was `--legacy-peer-deps`, which suppresses the report without resolving the mismatch. |

### Known issue: `npm audit` reports 2 vulnerabilities

Both are a transitive `postcss` inside Next 15's own dependency tree. `npm
audit fix --force` resolves them by installing Next 16, which the brief rules
out. The advisories concern PostCSS processing attacker-controlled CSS; here
PostCSS only ever runs at build time over our own stylesheets, so it is not
reachable. Noted rather than silenced — revisit if the app moves to Next 16.

---

## Non-decisions (things deliberately absent)

- **No database, no auth.** State lives in React and refresh clears it
  (hard rule 4). This is what removes persistence, migrations, and sessions
  from v1 entirely, and it is why `ParsedDocument` has no `id` field.
- **No file upload.** The PDF is parsed in the browser (Phase 1). The file
  never reaches a server, so there is no storage, no size limit beyond the
  browser's, and no privacy question about the document itself. The *text*
  does go to the Anthropic API in Phase 4 — a real distinction, and one the
  UI should state.
- **No state management library.** Nothing yet justifies one. If it does, the
  reason will be written here.
