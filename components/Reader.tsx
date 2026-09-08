"use client";

import { memo } from "react";
import type { Chunk } from "@/lib/types";

interface ReaderProps {
  chunks: Chunk[];
  activeIndex: number;
  onSelect: (index: number) => void;
  activeRef: React.RefObject<HTMLElement | null>;
}

/**
 * Presentational heuristic, not a domain fact: a short run with no terminal
 * punctuation reads as a heading, so it gets its own line rather than being
 * set inline with the prose around it.
 *
 * Deliberately kept here rather than added to `Chunk`. Whether something looks
 * like a heading is a rendering question; the chunker's job is to decide where
 * sentences end, and the domain type stays as Phase 0 defined it.
 */
function looksLikeHeading(text: string): boolean {
  return text.length < 80 && !/[.!?:;]$/.test(text);
}

/**
 * The document, rendered as its chunks.
 *
 * Every sentence is a button. That is the accessible way to express "click
 * this to jump here" — it is focusable, reachable by keyboard, and announced
 * as actionable — and it costs nothing visually once the button styling is
 * stripped back to inheriting the prose around it.
 */
export const Reader = memo(function Reader({
  chunks,
  activeIndex,
  onSelect,
  activeRef,
}: ReaderProps) {
  return (
    <article className="measure font-serif text-[1.0625rem] leading-[1.75] text-ink">
      {chunks.map((chunk, index) => {
        const isActive = index === activeIndex;
        const isHeading = looksLikeHeading(chunk.text);
        const startsPage =
          index === 0 || chunks[index - 1]?.pageNumber !== chunk.pageNumber;

        const sentence = (
          <button
            type="button"
            ref={
              isActive
                ? (node) => {
                    activeRef.current = node;
                  }
                : undefined
            }
            onClick={() => onSelect(index)}
            aria-current={isActive ? "true" : undefined}
            className={[
              "cursor-pointer rounded-[3px] px-0.5 text-left transition-colors duration-150",
              "hover:bg-accent-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
              isActive
                ? "bg-highlight shadow-[inset_2px_0_0_0_var(--highlight-edge)]"
                : "",
              isHeading ? "font-semibold" : "",
            ].join(" ")}
          >
            {chunk.text}
          </button>
        );

        return (
          <span key={chunk.id}>
            {startsPage && (
              <span
                aria-hidden
                className="my-6 flex select-none items-center gap-3 font-sans text-[11px] uppercase tracking-wider text-ink-faint"
              >
                <span className="h-px flex-1 bg-rule" />
                Page {chunk.pageNumber}
                <span className="h-px flex-1 bg-rule" />
              </span>
            )}
            {isHeading ? (
              <span className="mt-5 mb-1 block font-sans text-base">{sentence}</span>
            ) : (
              <>
                {sentence}{" "}
              </>
            )}
          </span>
        );
      })}
    </article>
  );
});
