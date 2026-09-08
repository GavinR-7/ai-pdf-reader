/**
 * Sentence chunking.
 *
 * A pure function: `(pages: PageText[]) => Chunk[]`. No PDF, no DOM, no
 * network — which is what lets every rule below have a test written as a
 * string literal.
 *
 * Chunks are the app's only unit of position (see ARCHITECTURE.md § Domain
 * model), so a mistake here is simultaneously a bad utterance, a bad
 * highlight, and a bad citation target. That is the reason this file is rules
 * plus tests rather than a dependency.
 */

import type { Chunk, PageText } from "./types";

/**
 * Above this many characters, a sentence is split at clause boundaries.
 *
 * The constraint is the audio queue, not the text: one chunk is one utterance,
 * and an utterance is the smallest thing a listener can rewind to or jump
 * between. A 900-character sentence is a 40-second block you cannot navigate
 * inside. 400 characters is roughly 20 seconds of speech at a normal rate —
 * long enough that ordinary prose is never cut, short enough that the
 * pathological legal sentence stays steerable.
 */
export const MAX_CHUNK_CHARS = 400;

/** Below this, a clause split is not worth making — it produces fragments. */
const MIN_CLAUSE_CHARS = 40;

/**
 * Words that take a full stop without ending a sentence.
 *
 * Stored without the dot and matched case-insensitively. This is the single
 * highest-value rule in the file: "Fig. 3", "et al.", "vs.", "Dr." and
 * "3.14" account for nearly every bad split in academic and financial prose.
 */
const ABBREVIATIONS = new Set([
  // Titles
  "dr", "mr", "mrs", "ms", "prof", "rev", "hon", "st", "jr", "sr",
  // Academic apparatus
  "fig", "figs", "eq", "eqs", "ref", "refs", "sec", "secs", "ch", "chap",
  "tab", "tbl", "vol", "no", "nos", "pp", "p", "al", "ed", "eds", "trans",
  "cf", "viz", "resp", "approx", "cal", "est",
  // Latin shorthand. The dotted forms ("e.g.") are caught by the
  // single-letter rule below; these catch the undotted tail.
  "eg", "ie", "etc", "vs", "vol",
  // Organisations
  "inc", "ltd", "co", "corp", "plc", "llc", "univ", "dept", "assn", "bros",
  // Dates and units
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct",
  "nov", "dec", "mon", "tue", "wed", "thu", "fri", "sat", "sun",
]);

/** Characters that may sit between terminal punctuation and the space. */
const CLOSERS = new Set(["\"", "'", ")", "]", "}", "”", "’", "»"]);

/** A new sentence may start with any of these. */
const OPENERS = /^[A-Z0-9"'(\[“‘«—]/;

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}

/** The run of letters immediately before `index`, lowercased. */
function precedingWord(text: string, index: number): string {
  let start = index;
  while (start > 0) {
    const char = text[start - 1];
    if (char === undefined || !/[A-Za-z]/.test(char)) break;
    start--;
  }
  return text.slice(start, index).toLowerCase();
}

/**
 * Offsets at which a block of text should be cut into sentences.
 *
 * Each returned offset is the index *after* the sentence's final character
 * (including any closing quote or bracket), so `slice(previous, offset)` is a
 * whole sentence.
 */
function sentenceEnds(text: string): number[] {
  const ends: number[] = [];

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char !== "." && char !== "!" && char !== "?") continue;

    if (char === ".") {
      // Ellipsis. Never a boundary: "He paused ... and went on" is one
      // sentence, and treating the run as terminal splits far more often than
      // it helps. Costs the rare "Wait... Who said that?".
      if (text[i + 1] === "." || text[i - 1] === ".") continue;

      // Decimal or version number: 3.14, $1.5M, Section 2.1.
      if (isDigit(text[i - 1]) && isDigit(text[i + 1])) continue;

      // A section or list enumerator at the head of a block: "3.", "3.1.",
      // "12.". A numbered heading is not a sentence, and "3. Deep Residual
      // Learning" has to stay whole. Deliberately restricted to the *start of
      // the block* — that is what distinguishes an enumerator from a number
      // that genuinely ends a sentence, as in "the total was 42. The next
      // year...", which must still split.
      if (/^\s*\d+(?:\.\d+)*$/.test(text.slice(0, i))) continue;

      const word = precedingWord(text, i);
      if (ABBREVIATIONS.has(word)) continue;
      // A single letter before the dot is an initial ("J. R. R. Tolkien") or
      // the tail of dotted shorthand ("e.g.", "i.e.", "U.S.").
      if (word.length === 1) continue;
    }

    // Step over closing quotes and brackets: `He said "Stop." Then he left.`
    let end = i + 1;
    while (end < text.length && CLOSERS.has(text[end] ?? "")) end++;

    // Punctuation at the very end of the block closes the last sentence.
    if (end >= text.length) {
      ends.push(text.length);
      break;
    }

    // A boundary needs whitespace after it. `3.5.` inside a token is not one.
    if (!isWhitespace(text[end])) continue;

    let next = end;
    while (next < text.length && isWhitespace(text[next])) next++;
    if (next >= text.length) {
      ends.push(text.length);
      break;
    }

    // Lowercase after a full stop means the stop was not terminal — an
    // abbreviation this list does not know about, most likely.
    const rest = text.slice(next);
    if (!OPENERS.test(rest)) continue;

    ends.push(end);
  }

  if (ends.length === 0 || (ends[ends.length - 1] ?? 0) < text.length) {
    // A heading or fragment with no terminal punctuation is still a chunk.
    ends.push(text.length);
  }
  return ends;
}

/**
 * Clause separators, strongest first.
 *
 * A long sentence is cut at the strongest separator nearest its middle, then
 * each half is reconsidered. Splitting at the middle rather than the first
 * match keeps the pieces near-equal instead of shaving one clause off the
 * front and leaving a 350-character remainder.
 */
const CLAUSE_PATTERNS: RegExp[] = [
  /;\s/g,
  /:\s/g,
  /\s—\s|\s--\s/g,
  /,\s(?=(?:and|but|or|which|while|whereas|although|though|because|so)\s)/g,
  /,\s/g,
];

function splitLongSentence(text: string): { text: string; offset: number }[] {
  if (text.length <= MAX_CHUNK_CHARS) return [{ text, offset: 0 }];

  for (const pattern of CLAUSE_PATTERNS) {
    pattern.lastIndex = 0;
    const middle = text.length / 2;
    let best: number | null = null;
    let match = pattern.exec(text);
    while (match !== null) {
      // Cut after the separator and its space, so the clause keeps its comma.
      const cut = match.index + match[0].length;
      if (cut >= MIN_CLAUSE_CHARS && text.length - cut >= MIN_CLAUSE_CHARS) {
        if (best === null || Math.abs(cut - middle) < Math.abs(best - middle)) {
          best = cut;
        }
      }
      match = pattern.exec(text);
    }
    if (best !== null) {
      const left = text.slice(0, best);
      const right = text.slice(best);
      return [
        ...splitLongSentence(left),
        ...splitLongSentence(right).map((part) => ({
          text: part.text,
          offset: part.offset + best,
        })),
      ];
    }
  }

  // No clause boundary anywhere — a run-on, or a long table row flattened into
  // prose. Fall back to the last word break before the limit so the split is
  // at least not mid-word. Guaranteed to make progress, so recursion ends.
  let cut = text.lastIndexOf(" ", MAX_CHUNK_CHARS);
  if (cut < MIN_CLAUSE_CHARS) cut = MAX_CHUNK_CHARS;
  const left = text.slice(0, cut);
  const right = text.slice(cut);
  return [
    ...splitLongSentence(left),
    ...splitLongSentence(right).map((part) => ({
      text: part.text,
      offset: part.offset + cut,
    })),
  ];
}

interface PageRange {
  pageNumber: number;
  start: number;
}

/**
 * Concatenate pages into the single document text that `charStart` indexes
 * into, recording where each page begins.
 *
 * Pages are joined with a **space, not a newline**, which is deliberate and is
 * what makes a sentence spanning a page break come out as one chunk. Newlines
 * are reserved for block boundaries *within* a page (headings, paragraphs),
 * where the extractor saw real vertical structure. A word broken across the
 * page break is rejoined by the same rule the extractor uses within a page.
 *
 * The cost: a page that ends with a heading and no punctuation runs into the
 * next page's first sentence. Rare, and much cheaper than severing every
 * sentence that crosses a page.
 */
function buildDocumentText(pages: PageText[]): {
  text: string;
  ranges: PageRange[];
} {
  let text = "";
  const ranges: PageRange[] = [];

  for (const page of pages) {
    if (text.length > 0) {
      if (/[‐-]$/.test(text) && /^[a-z]/.test(page.text)) {
        text = text.slice(0, -1);
      } else {
        text += " ";
      }
    }
    ranges.push({ pageNumber: page.pageNumber, start: text.length });
    text += page.text;
  }

  return { text, ranges };
}

/** The page an offset falls on: the last page that starts at or before it. */
function pageAt(ranges: PageRange[], offset: number): number {
  let low = 0;
  let high = ranges.length - 1;
  let found = ranges[0]?.pageNumber ?? 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const range = ranges[mid];
    if (range === undefined) break;
    if (range.start <= offset) {
      found = range.pageNumber;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * Split a document into sentence-sized chunks.
 *
 * `chunks[i].id === i` is an invariant the rest of the app relies on, so this
 * numbers them last, after every split and filter has happened.
 */
export function chunkDocument(pages: PageText[]): Chunk[] {
  const { text, ranges } = buildDocumentText(pages);
  const chunks: Chunk[] = [];

  // Blocks first. The extractor emits "\n" where it saw real structure — a
  // heading, a new paragraph — and those are boundaries no sentence crosses.
  let blockStart = 0;
  const blocks: { text: string; offset: number }[] = [];
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === "\n") {
      if (i > blockStart) blocks.push({ text: text.slice(blockStart, i), offset: blockStart });
      blockStart = i + 1;
    }
  }

  for (const block of blocks) {
    let sentenceStart = 0;
    for (const end of sentenceEnds(block.text)) {
      const raw = block.text.slice(sentenceStart, end);
      const absolute = block.offset + sentenceStart;
      sentenceStart = end;

      // Trimming has to move the offset with it, or charStart points at
      // whitespace and every downstream position is off by a space or two.
      const leading = raw.length - raw.trimStart().length;
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;

      for (const part of splitLongSentence(trimmed)) {
        const partText = part.text.trim();
        if (partText.length === 0) continue;
        const partLeading = part.text.length - part.text.trimStart().length;
        const charStart = absolute + leading + part.offset + partLeading;
        chunks.push({
          id: chunks.length,
          pageNumber: pageAt(ranges, charStart),
          text: partText,
          charStart,
        });
      }
    }
  }

  return chunks;
}
