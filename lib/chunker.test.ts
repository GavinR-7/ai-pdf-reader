import { describe, it, expect } from "vitest";
import { chunkDocument, MAX_CHUNK_CHARS } from "./chunker";
import type { PageText } from "./types";

/** One page of text, so a rule can be written as a string literal. */
function page(text: string, pageNumber = 1): PageText {
  return { pageNumber, text };
}

function textsOf(pages: PageText[]): string[] {
  return chunkDocument(pages).map((chunk) => chunk.text);
}

describe("invariants", () => {
  it("numbers chunks by array position", () => {
    const chunks = chunkDocument([page("One. Two. Three.")]);
    chunks.forEach((chunk, index) => expect(chunk.id).toBe(index));
  });

  it("orders chunks by their offset in the document text", () => {
    const chunks = chunkDocument([
      page("First sentence here. Second one follows.", 1),
      page("Third is on page two.", 2),
    ]);
    const offsets = chunks.map((chunk) => chunk.charStart);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  it("points charStart at the chunk's own first character", () => {
    const pages = [page("Alpha beta. Gamma delta.")];
    const chunks = chunkDocument(pages);
    const full = pages[0]?.text ?? "";
    for (const chunk of chunks) {
      expect(full.slice(chunk.charStart, chunk.charStart + chunk.text.length)).toBe(
        chunk.text,
      );
    }
  });

  it("returns nothing for an empty document", () => {
    expect(chunkDocument([])).toEqual([]);
    expect(chunkDocument([page("   ")])).toEqual([]);
  });
});

describe("abbreviations", () => {
  it("does not split on a title", () => {
    expect(textsOf([page("Dr. Smith ran the trial. It worked.")])).toEqual([
      "Dr. Smith ran the trial.",
      "It worked.",
    ]);
  });

  it("does not split on Fig.", () => {
    expect(textsOf([page("See Fig. 4 for the layout. The rest follows.")])).toEqual([
      "See Fig. 4 for the layout.",
      "The rest follows.",
    ]);
  });

  it("does not split on et al.", () => {
    expect(
      textsOf([page("This follows Smith et al. 2020 exactly. We extend it.")]),
    ).toEqual(["This follows Smith et al. 2020 exactly.", "We extend it."]);
  });

  it("does not split on Inc.", () => {
    expect(textsOf([page("She joined Acme Inc. in Ohio last year.")])).toEqual([
      "She joined Acme Inc. in Ohio last year.",
    ]);
  });

  it("does not split on vs.", () => {
    expect(textsOf([page("We compare ours vs. theirs below. Results differ.")])).toEqual([
      "We compare ours vs. theirs below.",
      "Results differ.",
    ]);
  });

  it("does not split on dotted shorthand or initials", () => {
    expect(textsOf([page("Use a solver, e.g. Newton's method, here. It converges.")])).toEqual([
      "Use a solver, e.g. Newton's method, here.",
      "It converges.",
    ]);
    expect(textsOf([page("J. R. R. Tolkien wrote it. Many read it.")])).toEqual([
      "J. R. R. Tolkien wrote it.",
      "Many read it.",
    ]);
  });
});

describe("decimals and numbers", () => {
  it("does not split inside a decimal", () => {
    expect(textsOf([page("Pi is 3.14 exactly. Everyone knows that.")])).toEqual([
      "Pi is 3.14 exactly.",
      "Everyone knows that.",
    ]);
  });

  it("does not split inside a currency amount", () => {
    expect(textsOf([page("Revenue hit $1.5M this quarter. Costs fell.")])).toEqual([
      "Revenue hit $1.5M this quarter.",
      "Costs fell.",
    ]);
  });

  it("does not split inside a section number", () => {
    expect(textsOf([page("As shown in Section 2.1 above. We continue.")])).toEqual([
      "As shown in Section 2.1 above.",
      "We continue.",
    ]);
  });
});

describe("citations", () => {
  it("splits after a bracketed numeric citation", () => {
    expect(textsOf([page("This was shown earlier [3]. We reproduce it here.")])).toEqual([
      "This was shown earlier [3].",
      "We reproduce it here.",
    ]);
  });

  it("splits after a parenthetical author-year citation", () => {
    expect(
      textsOf([page("The effect is well documented (Smith 2020). Others disagree.")]),
    ).toEqual(["The effect is well documented (Smith 2020).", "Others disagree."]);
  });

  it("keeps an abbreviation inside a parenthetical intact", () => {
    expect(textsOf([page("The layout is shown (see Fig. 2). It is unusual.")])).toEqual([
      "The layout is shown (see Fig. 2).",
      "It is unusual.",
    ]);
  });
});

describe("ellipses", () => {
  it("does not split inside an ellipsis", () => {
    expect(textsOf([page("He waited ... and then he left. She stayed.")])).toEqual([
      "He waited ... and then he left.",
      "She stayed.",
    ]);
  });

  it("does not split on a trailing ellipsis mid-thought", () => {
    expect(textsOf([page("The list goes on... but we stop here.")])).toEqual([
      "The list goes on... but we stop here.",
    ]);
  });
});

describe("quotes", () => {
  it("splits after punctuation inside a closing quote", () => {
    expect(textsOf([page('He said "Stop." Then he left.')])).toEqual([
      'He said "Stop."',
      "Then he left.",
    ]);
  });
});

describe("page breaks", () => {
  it("keeps a sentence spanning a page break as one chunk on its starting page", () => {
    const chunks = chunkDocument([
      page("The result holds for every case we", 4),
      page("tested during the study. It is robust.", 5),
    ]);
    expect(chunks[0]?.text).toBe("The result holds for every case we tested during the study.");
    // The thought begins on page 4, so jumping to this citation lands there.
    expect(chunks[0]?.pageNumber).toBe(4);
    expect(chunks[1]?.text).toBe("It is robust.");
    expect(chunks[1]?.pageNumber).toBe(5);
  });

  it("rejoins a word broken across a page break", () => {
    const chunks = chunkDocument([
      page("The network was recon-", 2),
      page("figured overnight. It then ran.", 3),
    ]);
    expect(chunks[0]?.text).toBe("The network was reconfigured overnight.");
    expect(chunks[0]?.pageNumber).toBe(2);
  });
});

describe("headings and fragments", () => {
  it("keeps a heading as its own chunk", () => {
    expect(textsOf([page("3. Deep Residual Learning\nLet us consider H(x). It maps inputs.")])).toEqual([
      "3. Deep Residual Learning",
      "Let us consider H(x).",
      "It maps inputs.",
    ]);
  });

  it("keeps a numbered section heading whole", () => {
    expect(textsOf([page("3.1. Residual Learning\nWe restate the mapping.")])).toEqual([
      "3.1. Residual Learning",
      "We restate the mapping.",
    ]);
  });

  it("still splits after a number that genuinely ends a sentence", () => {
    expect(textsOf([page("The final count was 42. The next year differed.")])).toEqual([
      "The final count was 42.",
      "The next year differed.",
    ]);
  });

  it("does not merge blocks across a newline", () => {
    expect(textsOf([page("Abstract\nWe present a method")])).toEqual([
      "Abstract",
      "We present a method",
    ]);
  });
});

describe("long sentences", () => {
  it("splits a very long sentence at clause boundaries", () => {
    const long =
      "The system processes each incoming document through a pipeline of stages, " +
      "beginning with tokenisation and normalisation of the raw source text, " +
      "continuing through a series of statistical transformations that estimate " +
      "the relative importance of every term in its surrounding context, " +
      "applying a smoothing pass that damps the influence of rare terms, " +
      "and concluding with a ranking step that orders all remaining candidates " +
      "by their final weighted score before returning them to the caller.";
    expect(long.length).toBeGreaterThan(MAX_CHUNK_CHARS);
    const chunks = textsOf([page(long)]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
    // Nothing is lost or duplicated by the split.
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(long);
  });

  it("prefers a semicolon over a comma", () => {
    const clause = "a".repeat(200);
    const long = `${clause}, and more text here; ${clause} and the tail follows.`;
    expect(long.length).toBeGreaterThan(MAX_CHUNK_CHARS);
    const chunks = textsOf([page(long)]);
    // Both a comma and a semicolon are available; the semicolon is the
    // stronger break, so the cut lands there rather than at the earlier comma.
    expect(chunks[0]?.endsWith(";")).toBe(true);
  });

  it("splits a run-on with no punctuation at a word break", () => {
    const long = `${"word ".repeat(120)}end.`;
    const chunks = textsOf([page(long)]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
    // Cut at spaces, so rejoining reproduces the sentence exactly: no word
    // was sliced down the middle.
    expect(chunks.join(" ")).toBe(long.trim());
  });

  it("leaves an ordinary sentence untouched", () => {
    const ordinary = "This sentence is comfortably under the limit, with a clause.";
    expect(textsOf([page(ordinary)])).toEqual([ordinary]);
  });
});
