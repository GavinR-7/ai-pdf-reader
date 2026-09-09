"use client";

import type { AnalysisState } from "@/hooks/useAnalysis";
import type { Chunk } from "@/lib/types";

interface SummaryPanelProps {
  state: AnalysisState;
  chunks: Chunk[];
  onAnalyze: () => void;
  onJumpTo: (chunkIndex: number) => void;
  activeIndex: number;
}

const TYPE_LABELS: Record<string, string> = {
  academic: "Academic",
  legal: "Legal",
  financial: "Financial",
  technical: "Technical",
  other: "Document",
};

export function SummaryPanel({
  state,
  chunks,
  onAnalyze,
  onJumpTo,
  activeIndex,
}: SummaryPanelProps) {
  if (state.kind === "idle") {
    return (
      <aside className="rounded-lg border border-rule bg-paper-raised p-5">
        <h2 className="font-serif text-base font-semibold text-ink">
          Summary and key points
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          Every key point cites the sentences it came from, and the citations
          are checked against the document before you see them.
        </p>
        <button
          onClick={onAnalyze}
          className="mt-4 w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-paper transition-transform hover:scale-[1.02] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Analyse this document
        </button>
        <p className="mt-3 text-xs leading-relaxed text-ink-faint">
          This sends the document&rsquo;s text to the Anthropic API. The PDF file
          itself never leaves your browser.
        </p>
      </aside>
    );
  }

  if (state.kind === "loading") {
    return (
      <aside className="rounded-lg border border-rule bg-paper-raised p-5">
        <h2 className="font-serif text-base font-semibold text-ink">Analysing…</h2>
        <div className="mt-4 space-y-2" aria-hidden>
          {[0, 1, 2, 3].map((row) => (
            <div
              key={row}
              className="h-3 animate-pulse rounded bg-rule"
              style={{ width: `${100 - row * 12}%` }}
            />
          ))}
        </div>
        <p className="sr-only" role="status">
          Analysing the document.
        </p>
      </aside>
    );
  }

  if (state.kind === "error") {
    return (
      <aside className="rounded-lg border border-rule bg-paper-raised p-5">
        <h2 className="font-serif text-base font-semibold text-ink">
          Analysis failed
        </h2>
        <p role="alert" className="mt-2 text-sm leading-relaxed text-ink-muted">
          {state.message}
        </p>
        <button
          onClick={onAnalyze}
          className="mt-4 rounded-md border border-rule px-3 py-1.5 text-sm text-ink hover:border-ink-faint"
        >
          Try again
        </button>
      </aside>
    );
  }

  const { analysis } = state;
  const { citations } = analysis;
  const droppedAnything =
    citations.droppedCitations > 0 || citations.droppedKeyPoints > 0;

  return (
    <aside className="space-y-5">
      <section className="rounded-lg border border-rule bg-paper-raised p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-serif text-base font-semibold text-ink">Summary</h2>
          <span className="rounded-full border border-rule px-2 py-0.5 text-[11px] text-ink-muted">
            {TYPE_LABELS[analysis.documentType] ?? "Document"}
          </span>
        </div>
        <p className="mt-3 font-serif text-[0.9375rem] leading-relaxed text-ink">
          {analysis.summary}
        </p>
      </section>

      <section className="rounded-lg border border-rule bg-paper-raised p-5">
        <h2 className="font-serif text-base font-semibold text-ink">Key points</h2>

        {analysis.keyPoints.length === 0 ? (
          <p className="mt-3 text-sm leading-relaxed text-ink-muted">
            No key point survived citation checking. Every one the model
            produced cited sentences that do not exist in this document, so none
            are shown.
          </p>
        ) : (
          <ul className="mt-3 space-y-4">
            {analysis.keyPoints.map((keyPoint, index) => {
              const isActiveSource = keyPoint.chunkIds.includes(activeIndex);
              return (
                <li key={index}>
                  <button
                    onClick={() => {
                      const first = keyPoint.chunkIds[0];
                      if (first !== undefined) onJumpTo(first);
                    }}
                    className={[
                      "w-full rounded-md p-2 text-left transition-colors",
                      "hover:bg-accent-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
                      isActiveSource ? "bg-highlight" : "",
                    ].join(" ")}
                  >
                    <span className="font-serif text-[0.9375rem] leading-relaxed text-ink">
                      {keyPoint.point}
                    </span>
                  </button>

                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 px-2">
                    {keyPoint.chunkIds.map((chunkId) => {
                      const chunk = chunks[chunkId];
                      if (chunk === undefined) return null;
                      return (
                        <button
                          key={chunkId}
                          onClick={() => onJumpTo(chunkId)}
                          title={chunk.text.slice(0, 160)}
                          className={[
                            "rounded-full border px-2 py-0.5 font-sans text-[11px] tabular-nums transition-colors",
                            chunkId === activeIndex
                              ? "border-highlight-edge bg-highlight text-ink"
                              : "border-rule text-ink-muted hover:border-accent hover:text-ink",
                          ].join(" ")}
                        >
                          p{chunk.pageNumber}
                        </button>
                      );
                    })}
                    {keyPoint.flagged && (
                      <span
                        title="The model also cited sentences that do not exist in this document. Those citations were removed."
                        className="rounded-full border border-rule px-2 py-0.5 font-sans text-[11px] text-ink-faint"
                      >
                        partly unverified
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/*
          The validation result is shown rather than hidden. If the model
          invented citations, that is information about how much to trust the
          panel, and burying it would defeat the point of checking.
        */}
        <p className="mt-5 border-t border-rule pt-3 font-sans text-[11px] leading-relaxed text-ink-faint">
          {droppedAnything ? (
            <>
              Citation check: {citations.droppedCitations} invalid{" "}
              {citations.droppedCitations === 1 ? "citation" : "citations"}{" "}
              removed
              {citations.droppedKeyPoints > 0 && (
                <>
                  , {citations.droppedKeyPoints} key{" "}
                  {citations.droppedKeyPoints === 1 ? "point" : "points"} dropped
                  for having no valid source
                </>
              )}
              .
            </>
          ) : (
            <>Citation check: every citation resolved to a real sentence.</>
          )}
        </p>
      </section>
    </aside>
  );
}
