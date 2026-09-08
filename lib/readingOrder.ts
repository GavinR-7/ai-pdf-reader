/**
 * Reconstructing reading order from positioned text.
 *
 * pdf.js does not return paragraphs. It returns text *runs* with a position on
 * the page, in whatever order they happen to appear in the PDF's content
 * stream — which is drawing order, not reading order. On a two-column paper
 * the naive fix (concatenate in the order given, or sort by vertical position)
 * interleaves the columns: you get the first line of the left column, then the
 * first line of the right column, then the second line of the left, and the
 * result is unreadable.
 *
 * Everything here is a pure function over geometry so it can be tested with
 * literal coordinates instead of a PDF, a browser, and a worker thread. The
 * pdf.js-specific glue lives in `lib/extractPdf.ts`.
 *
 * See ARCHITECTURE.md § Reading order for the heuristic and its failure modes.
 */

/**
 * One text run, normalised out of pdf.js's `TextItem`.
 *
 * This type exists to quarantine a genuine typing problem: pdf.js declares
 * `TextItem.transform` as `Array<any>`, so the x/y coordinates arrive
 * untyped. `lib/extractPdf.ts` validates them once, at the boundary, and
 * everything downstream of that gets these honest `number`s.
 *
 * Coordinates are PDF user space: origin at the bottom-left of the page, so
 * **larger `y` is higher up the page**. That is the opposite of screen
 * coordinates and is the single easiest thing to get backwards here.
 */
export interface PositionedItem {
  text: string;
  /** Left edge of the run. */
  x: number;
  /** Text baseline. Larger = higher on the page. */
  y: number;
  /** Advance width of the run, so the right edge is `x + width`. */
  width: number;
  /** Glyph height, used to size the line-grouping tolerance. */
  height: number;
}

/** A run of items sharing a baseline, in left-to-right order. */
export interface Line {
  text: string;
  /** Baseline y of the line's first item. */
  y: number;
  /** Left edge of the leftmost item. */
  x0: number;
  /** Right edge of the rightmost item. */
  x1: number;
  /**
   * Median glyph height of the line's visible text, i.e. its type size.
   * A change in this between adjacent lines is the strongest available signal
   * that a heading has started, and it fires where vertical spacing alone is
   * too subtle to call.
   */
  height: number;
}

/** Tunables for column detection. Defaults are derived in ARCHITECTURE.md. */
export interface ColumnOptions {
  /**
   * Largest share of items allowed to cross the gutter before we conclude
   * there isn't one. Measured: real two-column pages score 0–3%, single-column
   * pages 12–44%. 0.06 sits in the empty gap between those two populations.
   */
  maxStraddleRatio: number;
  /**
   * Smallest share of items the lighter side must hold. Stops a single-column
   * page from being "split" just because one stray item sits far right.
   * Measured: two-column pages score 39–49%, single-column 6–37%.
   */
  minBalance: number;
  /** Below this many items, don't guess — a sparse page has no reliable signal. */
  minItems: number;
}

export const DEFAULT_COLUMN_OPTIONS: ColumnOptions = {
  maxStraddleRatio: 0.06,
  minBalance: 0.25,
  minItems: 20,
};

/**
 * Value at `fraction` through the sorted list. Used with a low fraction to
 * estimate "normal" line spacing: within a paragraph, spacing is regular and
 * tight, so the bottom quartile of gaps is the leading. The median is wrong
 * for this — a three-line block whose last line is a heading has gaps
 * [12, 48] and a median of 30, which declares the heading normal spacing and
 * swallows it into the paragraph.
 */
function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor(fraction * (sorted.length - 1));
  return sorted[index] ?? 0;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) return 0;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
}

/**
 * Find the x coordinate of the gutter between two columns, or `null` for a
 * single-column page.
 *
 * The heuristic: a real gutter is a vertical line that almost no text crosses.
 * So sweep a candidate split across the middle half of the page and, for each,
 * count the items that straddle it. A two-column layout has a position where
 * that count collapses to near zero while both sides still hold plenty of
 * text; a single-column layout has no such position, because every full-width
 * line crosses every candidate.
 *
 * Counting *items* rather than *lines* matters. Left- and right-column text on
 * the same visual row shares a baseline, so grouping into lines first would
 * merge the two columns into one line that straddles every candidate and
 * destroy the signal. Geometry first, lines second.
 */
export function detectColumnSplit(
  items: PositionedItem[],
  pageWidth: number,
  options: ColumnOptions = DEFAULT_COLUMN_OPTIONS,
): number | null {
  const inked = items.filter((item) => item.text.trim().length > 0);
  if (inked.length < options.minItems || pageWidth <= 0) return null;

  let best: { split: number; straddle: number; balance: number } | null = null;

  // Only the middle half is searched: a gutter near the page edge is a margin,
  // not a column boundary.
  const from = Math.floor(pageWidth * 0.25);
  const to = Math.ceil(pageWidth * 0.75);

  for (let split = from; split <= to; split++) {
    let straddle = 0;
    let left = 0;
    let right = 0;
    for (const item of inked) {
      const itemRight = item.x + item.width;
      if (item.x < split && itemRight > split) straddle++;
      else if (itemRight <= split) left++;
      else right++;
    }
    const balance = Math.min(left, right) / inked.length;
    // Fewest crossings wins; ties broken toward the more evenly filled split,
    // which keeps us off the blank strip just inside a margin.
    if (
      best === null ||
      straddle < best.straddle ||
      (straddle === best.straddle && balance > best.balance)
    ) {
      best = { split, straddle, balance };
    }
  }

  if (best === null) return null;
  const straddleRatio = best.straddle / inked.length;
  if (straddleRatio > options.maxStraddleRatio) return null;
  if (best.balance < options.minBalance) return null;
  return best.split;
}

/**
 * Group items sharing a baseline into lines, top to bottom.
 *
 * Tolerance is half the median glyph height rather than a fixed number of
 * points, so it scales with the document's type size. It has to be loose
 * enough to keep subscripts and superscripts on their own line (`d_model` sits
 * ~1.5pt below its baseline) and tight enough not to swallow the next line of
 * body text.
 */
export function buildLines(items: PositionedItem[]): Line[] {
  if (items.length === 0) return [];

  // Geometry stats come from visible glyphs only: space runs are reported with
  // height 0 and would drag the median to nonsense.
  const heights = items.map((item) => item.height).filter((h) => h > 0);
  const medianHeight = median(heights);
  const tolerance = medianHeight > 0 ? medianHeight * 0.5 : 4;

  // Top of page first (y descending), then left to right within a row.
  const sorted = [...items].sort((a, b) => (b.y === a.y ? a.x - b.x : b.y - a.y));

  const groups: PositionedItem[][] = [];
  let current: PositionedItem[] = [];
  let baseline = Number.NaN;
  for (const item of sorted) {
    if (current.length === 0 || Math.abs(item.y - baseline) <= tolerance) {
      if (current.length === 0) baseline = item.y;
      current.push(item);
    } else {
      groups.push(current);
      current = [item];
      baseline = item.y;
    }
  }
  if (current.length > 0) groups.push(current);

  // Word gaps are narrow. Measured on a CVPR paper: a real inter-word space is
  // 2.41pt against a 10pt type size, so the threshold has to sit below 0.24 of
  // the height or words fuse ("with x denoting" -> "withxdenoting"). It also
  // has to stay above zero-width kerning between glyphs of the same word.
  const gapThreshold = medianHeight > 0 ? medianHeight * 0.18 : 1.5;

  const lines: Line[] = [];
  for (const group of groups) {
    // Whitespace runs are *kept* here. Most PDFs encode their own spacing, and
    // honouring it is far more reliable than re-deriving every space from
    // coordinates; the gap rule below is the fallback for those that don't.
    const ordered = [...group].sort((a, b) => a.x - b.x);
    let text = "";
    let cursor = Number.NaN;
    for (const item of ordered) {
      if (text.length > 0) {
        const gap = item.x - cursor;
        const needsSpace =
          gap > gapThreshold && !/\s$/.test(text) && !/^\s/.test(item.text);
        if (needsSpace) text += " ";
      }
      text += item.text;
      cursor = item.x + item.width;
    }

    const normalised = text.replace(/\s+/g, " ").trim();
    if (normalised.length === 0) continue;

    const inked = ordered.filter((item) => item.text.trim().length > 0);
    const first = inked[0] ?? ordered[0];
    const lineHeights = inked.map((item) => item.height).filter((h) => h > 0);
    const xs = inked.map((item) => item.x);
    const rights = inked.map((item) => item.x + item.width);
    lines.push({
      text: normalised,
      y: first === undefined ? 0 : first.y,
      x0: xs.length > 0 ? Math.min(...xs) : 0,
      x1: rights.length > 0 ? Math.max(...rights) : 0,
      height: median(lineHeights),
    });
  }
  return lines;
}

/**
 * Join lines that flow together into running text.
 *
 * Two structural signals survive from the layout and are worth keeping, since
 * the chunker (Phase 2) uses newlines as hard boundaries and would otherwise
 * run a heading into the paragraph beneath it:
 *
 *   - an unusually large vertical gap starts a new block;
 *   - a trailing hyphen before a lowercase word is a word broken across lines,
 *     so the hyphen is dropped and the halves are rejoined.
 *
 * De-hyphenation is a heuristic and it is wrong for a genuine compound that
 * happens to break at its hyphen ("multi-" / "head" becomes "multihead").
 * That is rarer than broken words, and it costs a word rather than a sentence.
 */
function linesToText(lines: Line[]): string {
  if (lines.length === 0) return "";

  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const curr = lines[i];
    if (prev === undefined || curr === undefined) continue;
    gaps.push(prev.y - curr.y);
  }
  const normalGap = percentile(
    gaps.filter((gap) => gap > 0),
    0.25,
  );

  let text = "";
  let previous: Line | undefined;
  for (const line of lines) {
    if (line.text.length === 0) continue;
    if (previous === undefined) {
      text = line.text;
      previous = line;
      continue;
    }
    const gap = previous.y - line.y;
    // 1.4 rather than a rounder 1.6: measured on a CVPR paper, body leading is
    // 12.0pt and the gap under a subsection heading is 18.0pt, which 1.6 misses
    // by a tenth of a point. Body gaps are uniform, so the slack costs nothing.
    const spacedApart = normalGap > 0 && gap > normalGap * 1.4;
    // Type size is the sharper signal. Within a paragraph it is constant, so
    // any real change marks structure — 10pt body to 12pt section heading to
    // 11pt subsection. 5% clears floating-point noise while still catching a
    // 1pt step at these sizes; a larger threshold misses heading-to-heading.
    const tallest = Math.max(line.height, previous.height);
    const resized =
      tallest > 0 && Math.abs(line.height - previous.height) / tallest > 0.05;
    const isNewBlock = spacedApart || resized;
    if (isNewBlock) {
      text += "\n" + line.text;
    } else if (/[‐-]$/.test(text) && /^[a-z]/.test(line.text)) {
      text = text.slice(0, -1) + line.text;
    } else {
      text += " " + line.text;
    }
    previous = line;
  }
  return text;
}

/**
 * Turn one page's positioned items into reading-order text.
 *
 * Single column: lines top to bottom.
 *
 * Two columns: the page is cut at the gutter into left, right, and *full-width*
 * items (those that cross it — a title, a banner figure caption, a table
 * spanning the page). Full-width lines are the key to getting this right. They
 * act as horizontal rules that divide the page into bands, and reading runs
 * band by band: everything above the first full-width line (left column, then
 * right column), then that line, then the next band, and so on.
 *
 * Without banding, a paper whose page opens with a full-width figure and
 * continues in two columns reads its caption in the wrong place. With it, the
 * common academic layouts come out in the order a person would read them.
 */
export function toReadingOrder(
  items: PositionedItem[],
  pageWidth: number,
  options: ColumnOptions = DEFAULT_COLUMN_OPTIONS,
): string {
  const split = detectColumnSplit(items, pageWidth, options);
  if (split === null) {
    return linesToText(buildLines(items));
  }

  const left: PositionedItem[] = [];
  const right: PositionedItem[] = [];
  const full: PositionedItem[] = [];
  for (const item of items) {
    const itemRight = item.x + item.width;
    if (item.x < split && itemRight > split) full.push(item);
    else if (itemRight <= split) left.push(item);
    else right.push(item);
  }

  const leftLines = buildLines(left);
  const rightLines = buildLines(right);
  const fullLines = buildLines(full);

  // Each full-width line closes the band above it. `-Infinity` closes the last
  // band at the bottom of the page.
  const boundaries = [...fullLines].sort((a, b) => b.y - a.y);
  const blocks: Line[][] = [];
  let ceiling = Number.POSITIVE_INFINITY;

  const inBand = (lines: Line[], top: number, bottom: number): Line[] =>
    lines.filter((line) => line.y <= top && line.y > bottom);

  for (const boundary of boundaries) {
    const bandLeft = inBand(leftLines, ceiling, boundary.y);
    const bandRight = inBand(rightLines, ceiling, boundary.y);
    if (bandLeft.length > 0) blocks.push(bandLeft);
    if (bandRight.length > 0) blocks.push(bandRight);
    blocks.push([boundary]);
    ceiling = boundary.y;
  }
  const tailLeft = inBand(leftLines, ceiling, Number.NEGATIVE_INFINITY);
  const tailRight = inBand(rightLines, ceiling, Number.NEGATIVE_INFINITY);
  if (tailLeft.length > 0) blocks.push(tailLeft);
  if (tailRight.length > 0) blocks.push(tailRight);

  return blocks
    .map((block) => linesToText(block))
    .filter((text) => text.length > 0)
    .join("\n");
}
