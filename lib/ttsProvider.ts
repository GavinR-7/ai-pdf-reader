/**
 * The speech provider seam.
 *
 * v1 ships exactly one implementation (`WebSpeechProvider`: free, no server,
 * no latency). The interface exists anyway because Phase 5 may add a
 * network-backed provider, and the whole point of defining the boundary now is
 * that adding one must not touch the queue or the UI.
 */

import type { Chunk } from "./types";

export interface Voice {
  /** Provider-scoped identifier. For Web Speech this is `voiceURI`. */
  id: string;
  /** Human-readable name, as offered to the reader. */
  name: string;
  /** BCP-47 tag, e.g. "en-GB". */
  lang: string;
  /** Whether the engine considers this its default. */
  isDefault: boolean;
}

export interface SpeechSettings {
  /** `null` means "whatever the engine picks". */
  voiceId: string | null;
  /** Playback rate. 1 is normal; the UI offers 0.75–2. */
  rate: number;
}

export interface TTSProvider {
  /** Stable identifier, for logging and for a future provider toggle. */
  readonly id: string;

  /**
   * Speak one chunk, resolving when it has finished.
   *
   * Resolves — rather than rejecting — when `signal` aborts. Cancellation is a
   * normal outcome here, not an error: the reader pressed pause. The caller
   * checks `signal.aborted` after awaiting to tell the two apart, which keeps
   * the queue loop free of try/catch around every step.
   *
   * Rejects only on genuine synthesis failure.
   */
  speak(chunk: Chunk, signal: AbortSignal): Promise<void>;

  /** Stop immediately and drop anything queued inside the engine. */
  cancel(): void;

  /** Available voices. May need to wait on the engine to populate them. */
  getVoices(): Promise<Voice[]>;

  /** Apply voice and rate. Takes effect on the next `speak`. */
  configure(settings: SpeechSettings): void;

  /**
   * Optional: begin producing audio for a chunk *before* it is needed.
   *
   * This is the lookahead hook, and it is the reason the queue can accept a
   * network-backed provider without changing shape. Web Speech has nothing to
   * prefetch and does not implement it; an HTTP provider would fetch and cache
   * here, so that by the time the queue reaches the chunk the audio is already
   * in hand and there is no gap between sentences.
   *
   * Must be safe to call repeatedly for the same chunk, and must never reject
   * in a way that matters — the queue fires it and does not await it.
   */
  prepare?(chunk: Chunk, signal: AbortSignal): Promise<void>;
}
