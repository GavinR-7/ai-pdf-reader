"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Chunk } from "@/lib/types";
import type { TTSProvider, Voice } from "@/lib/ttsProvider";
import { runPlayback } from "@/lib/playbackQueue";

export type PlayerStatus = "idle" | "playing" | "paused" | "finished";

export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export interface Player {
  status: PlayerStatus;
  /** Index of the chunk that is playing, or would play next. */
  index: number;
  currentChunk: Chunk | undefined;
  voices: Voice[];
  voiceId: string | null;
  rate: number;
  error: string | null;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  jumpTo: (index: number) => void;
  setRate: (rate: number) => void;
  setVoiceId: (voiceId: string) => void;
}

/**
 * Binds the playback queue to React state.
 *
 * All the interesting logic — ordering, cancellation, lookahead — lives in
 * `lib/playbackQueue.ts`, which is why it has tests. This hook's only job is
 * to own the run's `AbortController`, mirror the queue's position into state
 * for rendering, and make sure every control that changes what should be
 * heard goes through the same single path: abort the run, start a new one.
 *
 * `chunks` must be referentially stable — memoise it in the caller — or every
 * render restarts playback.
 */
export function usePlayer(chunks: Chunk[], provider: TTSProvider): Player {
  const [status, setStatus] = useState<PlayerStatus>("idle");
  const [index, setIndex] = useState(0);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceId, setVoiceIdState] = useState<string | null>(null);
  const [rate, setRateState] = useState(1);
  const [error, setError] = useState<string | null>(null);

  // Refs shadow the state that callbacks need to read. Reading state inside a
  // callback that was created on an earlier render gives a stale value, and
  // "resume from the wrong sentence" is exactly the bug that produces.
  const indexRef = useRef(0);
  const statusRef = useRef<PlayerStatus>("idle");
  const voiceIdRef = useRef<string | null>(null);
  const rateRef = useRef(1);
  const controllerRef = useRef<AbortController | null>(null);

  const setStatusBoth = useCallback((next: PlayerStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  /** Abort the run in flight, if any, and silence the engine. */
  const halt = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    provider.cancel();
  }, [provider]);

  const start = useCallback(
    (from: number) => {
      halt();
      const bounded = Math.min(Math.max(from, 0), Math.max(chunks.length - 1, 0));
      const controller = new AbortController();
      controllerRef.current = controller;
      indexRef.current = bounded;
      setIndex(bounded);
      setError(null);
      setStatusBoth("playing");

      void runPlayback(chunks, bounded, provider, controller.signal, {
        onChunkStart: (at) => {
          indexRef.current = at;
          setIndex(at);
        },
        onComplete: () => setStatusBoth("finished"),
      }).catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Playback failed.");
        setStatusBoth("paused");
      });
    },
    [chunks, halt, provider, setStatusBoth],
  );

  const play = useCallback(() => {
    if (statusRef.current === "playing") return;
    start(statusRef.current === "finished" ? 0 : indexRef.current);
  }, [start]);

  const pause = useCallback(() => {
    halt();
    if (statusRef.current === "playing") setStatusBoth("paused");
  }, [halt, setStatusBoth]);

  const toggle = useCallback(() => {
    if (statusRef.current === "playing") pause();
    else play();
  }, [pause, play]);

  const jumpTo = useCallback(
    (to: number) => {
      const bounded = Math.min(Math.max(to, 0), Math.max(chunks.length - 1, 0));
      if (statusRef.current === "playing") {
        start(bounded);
        return;
      }
      // Paused or idle: move the highlight without starting playback, which is
      // what makes clicking a sentence a way to read as well as to listen.
      indexRef.current = bounded;
      setIndex(bounded);
      if (statusRef.current === "finished") setStatusBoth("paused");
    },
    [chunks.length, setStatusBoth, start],
  );

  const next = useCallback(() => jumpTo(indexRef.current + 1), [jumpTo]);
  const previous = useCallback(() => jumpTo(indexRef.current - 1), [jumpTo]);

  /**
   * Voice and rate cannot be changed mid-utterance — Web Speech bakes both in
   * when `speak()` is called. So a change restarts the current sentence, which
   * is both the only honest option and the one that lets the reader actually
   * hear what they just picked.
   */
  const applySettings = useCallback(() => {
    provider.configure({ voiceId: voiceIdRef.current, rate: rateRef.current });
    if (statusRef.current === "playing") start(indexRef.current);
  }, [provider, start]);

  const setRate = useCallback(
    (nextRate: number) => {
      rateRef.current = nextRate;
      setRateState(nextRate);
      applySettings();
    },
    [applySettings],
  );

  const setVoiceId = useCallback(
    (nextVoiceId: string) => {
      voiceIdRef.current = nextVoiceId;
      setVoiceIdState(nextVoiceId);
      applySettings();
    },
    [applySettings],
  );

  // Load the voice list once per provider. See WebSpeechProvider.getVoices for
  // why this is asynchronous at all.
  useEffect(() => {
    let cancelled = false;
    void provider
      .getVoices()
      .then((list) => {
        if (cancelled) return;
        setVoices(list);
        if (voiceIdRef.current !== null) return;
        const preferred =
          list.find((voice) => voice.isDefault) ??
          list.find((voice) => voice.lang.toLowerCase().startsWith("en")) ??
          list[0];
        if (preferred === undefined) return;
        voiceIdRef.current = preferred.id;
        setVoiceIdState(preferred.id);
        provider.configure({ voiceId: preferred.id, rate: rateRef.current });
      })
      .catch(() => {
        // No voice list is survivable: the engine falls back to its default.
      });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  // A new document resets the player rather than continuing into it.
  useEffect(() => {
    halt();
    indexRef.current = 0;
    setIndex(0);
    setStatusBoth("idle");
  }, [chunks, halt, setStatusBoth]);

  // Leaving the page must not leave a voice talking to an empty room.
  useEffect(() => halt, [halt]);

  return {
    status,
    index,
    currentChunk: chunks[index],
    voices,
    voiceId,
    rate,
    error,
    play,
    pause,
    toggle,
    next,
    previous,
    jumpTo,
    setRate,
    setVoiceId,
  };
}
