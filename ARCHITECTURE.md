# Architecture

A running record of the decisions in this codebase: what was chosen, what the
alternative was, and why this one won. Appended to as each phase lands.

**Status:** Phase 3 complete (the player).

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

## Sentence chunking (Phase 2)

`lib/chunker.ts` is a pure function `(pages: PageText[]) => Chunk[]` with 46
tests. It has no dependency, by choice.

### Why sentence-level granularity

The alternatives, and what each costs:

| Unit | Why not |
|---|---|
| **Paragraph** | Too coarse for all three jobs at once. A paragraph is 30–60 seconds of audio, so pause/resume and "jump back one" are useless; the highlight covers half the screen and stops telling you where you are; and a citation to a paragraph is barely a citation — the reader still has to hunt for the sentence the claim came from. |
| **Fixed token count** | Cuts mid-sentence by construction. Speech synthesis needs a complete clause to get prosody right, so a 200-token chunk boundary lands mid-phrase and the reader hears the sentence break in the wrong place. It also makes citations meaningless: "chunk 12" is not a thing a person can point at in the document. |
| **Sentence** | Matches all three consumers. It is one natural utterance, one comfortable highlight, and the smallest unit a claim can honestly be traced to. |

The catch is that sentences vary from 3 to 900 characters, which is why the
long-sentence rule below exists — it keeps the *upper* end bounded without
giving up the natural unit.

### Why rules, not an NLP library

A sentence splitter is a well-understood problem with a short list of hard
cases, and the whole list appears in the tests. A library (`compromise`,
`sbd`, a wasm build of spaCy) would add 100KB+ to a client bundle to solve a
problem that is ~150 lines here, and — more to the point — the failure modes
would be unexplainable. When this splitter breaks, the rule that broke is
visible and has a test next to it.

### The rules

Each has a test, named after the case:

- **Blocks first.** The extractor emits `\n` where it saw real vertical
  structure. No sentence crosses one, which is what keeps a heading from being
  glued to the paragraph beneath it.
- **Abbreviations.** A dot after a known abbreviation is never terminal:
  `Dr.`, `Fig.`, `et al.`, `Inc.`, `vs.`, month names, and ~60 others.
- **Single letters.** One letter before a dot is an initial (`J. R. R.
  Tolkien`) or dotted shorthand (`e.g.`, `i.e.`, `U.S.`).
- **Decimals.** A dot between two digits is never terminal: `3.14`, `$1.5M`,
  `Section 2.1`.
- **Enumerators.** Digits then a dot, *at the start of a block*, are a section
  or list number: `3. Deep Residual Learning` stays whole. The restriction to
  block-start is what distinguishes it from a number that really does end a
  sentence — "the total was 42. The next year…" still splits. This was a real
  bug caught by running the chunker over the ResNet paper.
- **Ellipses.** Never a boundary. `He waited ... and then he left` is one
  sentence; treating the run as terminal splits far more often than it helps.
  Costs the rare `Wait... Who said that?`.
- **Closing punctuation.** A boundary may sit after quotes and brackets:
  `He said "Stop." Then he left.` splits correctly, and so do citations —
  `… earlier [3].` and `… documented (Smith 2020).`
- **A lowercase next word cancels the boundary.** If a full stop is followed by
  lowercase, it was an abbreviation this list does not know about.
- **No terminal punctuation is still a chunk.** Headings and fragments are
  content and must be readable and citable.

**The abbreviation trade-off, stated plainly.** The rule is conservative: it
*never* splits after a known abbreviation. So a sentence genuinely ending in
one — "…as shown by Smith et al. The method then…" — stays merged with the
next. That is the deliberate direction to be wrong in: over-splitting severs a
sentence, which corrupts an utterance, a highlight, and a citation target
simultaneously; under-splitting yields one chunk that is merely longer than
ideal.

### Sentences that span a page break

Pages are concatenated with a **space, not a newline**. Newlines are reserved
for block boundaries *within* a page, where the extractor saw real structure.
This is what lets a sentence broken across a page break come out as one chunk,
and a word broken across it be rejoined (`recon-` + `figured`).

The chunk keeps the page it **started** on, so clicking a citation lands where
the thought begins rather than mid-clause on the following page.

Cost: a page ending with a heading and no punctuation runs into the next
page's first sentence. Rare, and far cheaper than severing every sentence that
crosses a page.

### Long sentences

Over **400 characters**, a sentence is split at clause boundaries. The limit
comes from the audio queue, not the text: one chunk is one utterance, and an
utterance is the smallest thing a listener can rewind to or skip between. A
900-character sentence is a 40-second block with no way to navigate inside it.
400 characters is roughly 20 seconds of speech — long enough that ordinary
prose is never cut, short enough that a pathological legal sentence stays
steerable.

Separators are tried strongest-first — `;` then `:` then em-dash then
`, and`/`, but`/`, which` then any comma — and the chosen cut is the one
**nearest the middle**, not the first match. Splitting at the first match
shaves one clause off the front and leaves a 350-character remainder; splitting
near the middle gives two readable halves. Each half is then reconsidered
recursively. A run-on with no punctuation at all falls back to the last word
break before the limit, which always makes progress, so the recursion
terminates.

### Offsets survive trimming

`charStart` is maintained through every trim and split — when leading
whitespace is removed from a chunk, the offset moves with it. Getting this
wrong is invisible in the UI and quietly corrupts the one field that exists to
outlive the chunking rules. There is a test that slices the original document
text at `charStart` and asserts it reproduces the chunk exactly.

### Verified against real documents

`scripts/verify-chunks.mts` runs extraction plus chunking over a real PDF.
Across 10 pages each of the two fixtures: ids sequential, offsets strictly
ascending, page numbers non-decreasing, and no chunk over the limit.

About 7% of chunks begin with a lowercase letter — the rough signal for a bad
split. Inspecting them, essentially all are *extraction* artifacts rather than
chunking errors: in-figure axis labels ("weight layer", "relu"), e-mail
addresses, and linearised mathematics. Removing rotated text (the vertical
arXiv stamp down the side of page 1) fixed the one class that was genuinely
severing sentences.

---

## The player (Phase 3)

Four pieces, split along the line between "logic that can be tested" and
"behaviour that can only be heard":

| File | Job | Tested |
|---|---|---|
| `lib/ttsProvider.ts` | the provider interface | types only |
| `lib/playbackQueue.ts` | ordering, cancellation, lookahead | 12 unit tests |
| `lib/webSpeechProvider.ts` | the browser engine and its defects | by hand |
| `hooks/usePlayer.ts` | React state binding | by hand |

The queue is deliberately *not* inside the hook. Cancellation is the part most
likely to hide a bug you can only find by listening, so it is a plain async
function over an injected provider, and the tests drive it with a fake that can
be made to hang mid-sentence on command.

### The cancellation model

There is **exactly one `AbortSignal` per run**, and every control that changes
what should be heard goes through the same path: abort the run in flight, then
start a new one. Pause, stop, jump-to-sentence, next, previous, a speed change
and a voice change are all that same operation. Nothing else stops a run, so
there is one place to reason about and one place to get right.

Three properties make it hold together:

- **`speak` resolves on abort, it does not reject.** Cancellation is the reader
  pressing pause, not a failure. Rejecting would mean wrapping every step in
  try/catch and distinguishing real synthesis errors from ordinary pauses by
  inspecting exceptions. Instead the loop checks `signal.aborted` and the
  provider contract states this explicitly.
- **The signal is checked *after* every await, not just at the top.** An abort
  that lands while a sentence is mid-utterance must leave the index *on that
  sentence*, so resuming repeats it rather than skipping it. There is a test
  named for exactly this, because the bug it prevents — "pause and resume
  silently skips a sentence" — is easy to introduce and hard to notice.
- **No orphaned utterances.** `pause()` aborts the signal *and* calls
  `provider.cancel()`, and the provider tears down its engine state. The hook
  also halts on unmount, so navigating away does not leave a voice talking to
  an empty room.

### Lookahead: how a network provider drops in unchanged

`TTSProvider` has an optional `prepare(chunk, signal)`. The queue calls it for
the next `LOOKAHEAD` (2) chunks **and never awaits it**:

```
handlers.onChunkStart(index);
for (ahead of 1..LOOKAHEAD) void provider.prepare?.(chunks[index + ahead], signal);
await provider.speak(chunk, signal);
```

Web Speech has nothing to prefetch and does not implement `prepare`, so today
this is a no-op. But the *shape* is what has to be right now: an HTTP-backed
provider fetches and caches inside `prepare`, so by the time the queue reaches
that chunk the audio is already in hand and there is no gap between sentences.

Two chunks of runway rather than one, because at a normal rate a sentence is
only a few seconds and a network round trip needs more than one sentence of
margin to never be the reason for a gap.

Because `prepare` is fired and never awaited, and its rejections are swallowed,
**a failing or slow lookahead can only fail to help — it can never stall or
break playback.** There is a test for a provider whose `prepare` always throws,
and one for a provider that has no `prepare` at all.

Nothing in `Reader.tsx` or `PlayerControls.tsx` knows a provider exists. They
consume `usePlayer`'s state and call its controls, so swapping the provider is
a one-line change at the `useMemo` that constructs it.

### Web Speech's three defects

The API is free, local and zero-latency, and its `onend` gives sentence-level
sync directly — no timing estimation anywhere, which is why the highlight is
exact rather than approximate. It is also unreliable in three specific ways,
each worked around and commented at the site of the workaround:

**1. `getVoices()` returns `[]` until the engine loads its voice list.** On
Chrome the list arrives asynchronously, announced by a `voiceschanged` event,
and a call at page load returns empty with no hint that waiting would help. The
naive fix — always wait for the event — *hangs* on browsers where the list is
ready immediately and the event therefore never fires. So: return synchronously
if the list is already populated; otherwise wait for the event **with a 2s
timeout** and take whatever exists when it expires.

**2. Chrome silently abandons long utterances after ~15 seconds.** No `onend`,
no `onerror` — the queue waits forever on a promise that will never settle and
playback appears to freeze mid-document. Worked around by toggling
`pause()`/`resume()` on a 10-second timer while speaking, which resets the
engine's watchdog. This is not hypothetical: chunks are capped at 400
characters, which at 0.75× is comfortably over 15 seconds.

**3. `cancel()` then `speak()` in the same task is a race.** `cancel()` is
processed asynchronously; the new utterance is often swallowed by the in-flight
cancel and simply never plays, so the reader clicks a sentence and gets
silence. Two guards: `speak` waits for the engine to report itself quiet (poll,
250ms cap) and then yields one more turn, and an **epoch counter** invalidates
events from cancelled utterances — a late `onend` from a superseded utterance
would otherwise resolve the wrong promise and skip a sentence.

### Auto-scroll follows input events, not scroll events

The obvious implementation watches `scroll` and stops following when one
arrives it did not cause. It does not work: `scrollIntoView({behavior:
"smooth"})` emits a stream of scroll events over several hundred milliseconds,
indistinguishable from a person dragging, so the feature disables itself every
single time it works. Guarding with an "ignore scrolls for the next N ms" flag
trades that for a window in which genuine user scrolls are swallowed.

`wheel`, `touchmove` and the scrolling keys carry no such ambiguity — they only
fire when a person does something. Following stops on the first one, and
resumes when the reader **clicks a sentence**, which is an equally unambiguous
signal that they want the player to lead again. A button appears while
following is off, so the state is visible rather than mysterious.

### Reading interface decisions

- **Every sentence is a `<button>`.** That is the accessible way to say "click
  to jump here": focusable, keyboard-reachable, announced as actionable. Styled
  back down to inherit the surrounding prose, it costs nothing visually.
- **The highlight is a wash, not a block.** A hard highlight fights the text it
  is meant to help you follow. A tint plus a 2px leading edge marks position
  without obscuring the words.
- **~66-character measure**, set in `ch` so it tracks the font rather than a
  guessed pixel width.
- **Serif for the document, sans for the interface.** The reader should never
  have to work out whether something is content or chrome.
- **The transport bar is pinned to the bottom**, because this is mobile-first
  and the bottom of the screen is where a thumb is.
- **Headings are detected at render time**, not stored on `Chunk`. Whether a
  short unpunctuated run looks like a heading is a presentation question; the
  domain type stays as Phase 0 defined it.

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
