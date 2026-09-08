"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { DropZone } from "@/components/DropZone";
import { PlayerControls } from "@/components/PlayerControls";
import { Reader } from "@/components/Reader";
import { usePlayer } from "@/hooks/usePlayer";
import { useFollowScroll } from "@/hooks/useFollowScroll";
import { chunkDocument } from "@/lib/chunker";
import { WebSpeechProvider, isWebSpeechSupported } from "@/lib/webSpeechProvider";
import type { ExtractedPdf, ExtractionProgress } from "@/lib/extractPdf";

type Status =
  | { kind: "idle" }
  | { kind: "extracting"; progress: ExtractionProgress | null; filename: string }
  | { kind: "ready"; document: ExtractedPdf }
  | { kind: "error"; message: string };

export default function Home() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  const handleFile = useCallback(async (file: File) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus({ kind: "extracting", progress: null, filename: file.name });

    try {
      // Imported here rather than at the top of the module on purpose. pdf.js
      // is ~1MB of browser-only code that touches DOM globals at import time,
      // so a static import would both break the server prerender of this page
      // and put the whole parser in the initial bundle for a visitor who has
      // not chosen a file yet. This defers it to the moment it is needed.
      const { extractPdf } = await import("@/lib/extractPdf");
      const result = await extractPdf(
        file,
        (progress) =>
          setStatus((current) =>
            current.kind === "extracting" ? { ...current, progress } : current,
          ),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setStatus({ kind: "ready", document: result });
    } catch (error) {
      if (controller.signal.aborted) return;
      setStatus({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Something went wrong reading that PDF.",
      });
    }
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setStatus({ kind: "idle" });
  }, []);

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-5 pt-10 sm:px-8 sm:pt-16">
      {status.kind !== "ready" && (
        <header className="mb-10">
          <h1 className="font-serif text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            PDF Reader
          </h1>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-muted">
            Reads a PDF aloud sentence by sentence, and grounds every key point
            in the sentences it came from.
          </p>
        </header>
      )}

      {status.kind === "idle" && <DropZone onFile={handleFile} />}

      {status.kind === "extracting" && (
        <ExtractingPanel filename={status.filename} progress={status.progress} />
      )}

      {status.kind === "error" && (
        <div className="rounded-lg border border-rule bg-paper-raised p-6">
          <p role="alert" className="text-ink">
            {status.message}
          </p>
          <button
            onClick={reset}
            className="mt-4 rounded-md border border-rule px-3 py-1.5 text-sm text-ink hover:border-ink-faint"
          >
            Try another file
          </button>
        </div>
      )}

      {status.kind === "ready" && (
        <DocumentView document={status.document} onReset={reset} />
      )}
    </main>
  );
}

function ExtractingPanel({
  filename,
  progress,
}: {
  filename: string;
  progress: ExtractionProgress | null;
}) {
  const percent =
    progress === null ? 0 : Math.round((progress.page / progress.pageCount) * 100);
  return (
    <div className="rounded-lg border border-rule bg-paper-raised p-6">
      <p className="text-sm text-ink">
        Reading <span className="font-medium">{filename}</span>
      </p>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label="Extraction progress"
        className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-rule"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-200"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="mt-2 text-xs tabular-nums text-ink-muted">
        {progress === null
          ? "Opening document…"
          : `Page ${progress.page} of ${progress.pageCount}`}
      </p>
    </div>
  );
}

function DocumentView({
  document: parsed,
  onReset,
}: {
  document: ExtractedPdf;
  onReset: () => void;
}) {
  // Memoised because `usePlayer` restarts playback whenever the chunk array's
  // identity changes — re-chunking on every render would abort the utterance
  // in flight on every state update, which sounds exactly as bad as it reads.
  const chunks = useMemo(() => chunkDocument(parsed.pages), [parsed.pages]);
  const provider = useMemo(() => new WebSpeechProvider(), []);
  const player = usePlayer(chunks, provider);
  const { following, resume, activeRef } = useFollowScroll(player.index);

  const selectChunk = useCallback(
    (index: number) => {
      player.jumpTo(index);
      // Clicking a sentence is an unambiguous "follow the player again".
      resume();
    },
    [player, resume],
  );

  if (!parsed.hasTextLayer) {
    return (
      <>
        <DocumentHeader parsed={parsed} chunkCount={0} onReset={onReset} />
        <ScannedNotice />
      </>
    );
  }

  return (
    <>
      <DocumentHeader parsed={parsed} chunkCount={chunks.length} onReset={onReset} />

      {!isWebSpeechSupported() && (
        <p className="mb-6 rounded-lg border border-rule bg-accent-soft p-4 text-sm text-ink-muted">
          This browser has no speech synthesis, so the document can be read on
          screen but not aloud.
        </p>
      )}

      <Reader
        chunks={chunks}
        activeIndex={player.index}
        onSelect={selectChunk}
        activeRef={activeRef}
      />

      <PlayerControls
        player={player}
        totalChunks={chunks.length}
        following={following}
        onResumeFollow={resume}
      />
    </>
  );
}

function DocumentHeader({
  parsed,
  chunkCount,
  onReset,
}: {
  parsed: ExtractedPdf;
  chunkCount: number;
  onReset: () => void;
}) {
  const twoColumnPages = parsed.columnsPerPage.filter((count) => count === 2).length;
  return (
    <div className="mb-8 flex flex-wrap items-baseline justify-between gap-4 border-b border-rule pb-4">
      <div>
        <h1 className="font-serif text-xl font-semibold text-ink">{parsed.filename}</h1>
        <p className="mt-1 font-sans text-xs tabular-nums text-ink-muted">
          {parsed.pageCount} pages
          {chunkCount > 0 && <> · {chunkCount.toLocaleString()} sentences</>}
          {twoColumnPages > 0 && <> · {twoColumnPages} two-column</>}
        </p>
      </div>
      <button
        onClick={onReset}
        className="rounded-md border border-rule px-3 py-1.5 font-sans text-sm text-ink hover:border-ink-faint"
      >
        Choose another
      </button>
    </div>
  );
}

function ScannedNotice() {
  return (
    <div className="rounded-lg border border-rule bg-accent-soft p-6">
      <h2 className="font-serif text-lg font-semibold text-ink">
        This PDF has no text layer
      </h2>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-muted">
        It looks like a scan — page images with no selectable text behind them.
        Reading it aloud would produce silence, so the reader is not offered.
      </p>
      <p className="mt-3 max-w-prose text-sm leading-relaxed text-ink-muted">
        Recognising text in images (OCR) is out of scope for this version. A PDF
        exported from a word processor, or one you can select text in, will work.
      </p>
    </div>
  );
}
