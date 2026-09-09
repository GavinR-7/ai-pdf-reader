"use client";

import { useCallback, useRef, useState } from "react";
import type { Chunk } from "@/lib/types";
import type { ValidatedAnalysis } from "@/lib/analysis";

export type AnalysisState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; analysis: ValidatedAnalysis }
  | { kind: "error"; message: string };

/**
 * Requests the summary and grounded key points.
 *
 * Analysis is **explicitly triggered**, never automatic. It is the one action
 * in this app that sends the document's text off the device and the one that
 * costs money, so it waits to be asked. Everything before it — extraction,
 * chunking, reading aloud — happens entirely in the browser.
 *
 * Only `id` and `text` are sent. Page numbers and character offsets are of no
 * use to the model and are the reader's business, not the server's.
 */
export function useAnalysis(chunks: Chunk[]) {
  const [state, setState] = useState<AnalysisState>({ kind: "idle" });
  const controllerRef = useRef<AbortController | null>(null);

  const analyze = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ kind: "loading" });

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chunks: chunks.map((chunk) => ({ id: chunk.id, text: chunk.text })),
        }),
        signal: controller.signal,
      });

      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          typeof payload === "object" &&
          payload !== null &&
          "error" in payload &&
          typeof (payload as { error: unknown }).error === "string"
            ? (payload as { error: string }).error
            : `Analysis failed (${response.status}).`;
        setState({ kind: "error", message });
        return;
      }

      setState({ kind: "ready", analysis: payload as ValidatedAnalysis });
    } catch (cause) {
      if (controller.signal.aborted) return;
      setState({
        kind: "error",
        message:
          cause instanceof Error ? cause.message : "Could not reach the server.",
      });
    }
  }, [chunks]);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    setState({ kind: "idle" });
  }, []);

  return { state, analyze, reset };
}
