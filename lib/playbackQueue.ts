/**
 * The playback queue.
 *
 * Deliberately separate from the React hook that drives it, and free of any
 * DOM or browser dependency, so the cancellation model — the part most likely
 * to harbour a bug you can only hear — is unit-testable with a fake provider.
 *
 * See ARCHITECTURE.md § The player for the cancellation and lookahead design.
 */

import type { Chunk } from "./types";
import type { TTSProvider } from "./ttsProvider";

/**
 * How many chunks ahead to prepare while the current one plays.
 *
 * Two, not one: at a normal rate a sentence is a few seconds, so a provider
 * that has to make a network round trip needs more than one sentence of
 * runway to stay ahead without ever being the reason for a gap. Web Speech
 * ignores this entirely — it has no `prepare` — but the queue's shape is what
 * has to be right now, not the provider's.
 */
export const LOOKAHEAD = 2;

export interface PlaybackHandlers {
  /** Fired as each chunk begins, before any audio is produced. */
  onChunkStart(index: number): void;
  /** Fired once the last chunk has finished, and not on cancellation. */
  onComplete(): void;
}

/**
 * Speak `chunks` from `startIndex` until the end or until `signal` aborts.
 *
 * The cancellation model, in one place:
 *
 *   - There is exactly one `AbortSignal` per run. Pause, stop, jump, and a
 *     settings change all abort the current run and (except for pause and
 *     stop) start a fresh one. Nothing else stops a run.
 *   - `speak` resolves rather than rejects on abort, so the loop's own
 *     `signal.aborted` check is what ends it — no exception control flow.
 *   - The signal is checked *after* every await, not only at the top. An
 *     abort that arrives while a chunk is mid-sentence must not advance the
 *     index, or resuming would silently skip a sentence.
 *   - `prepare` calls are fired and never awaited. A lookahead that fails or
 *     is slow can therefore never stall or break playback; it can only fail
 *     to help.
 */
export async function runPlayback(
  chunks: Chunk[],
  startIndex: number,
  provider: TTSProvider,
  signal: AbortSignal,
  handlers: PlaybackHandlers,
): Promise<void> {
  let index = Math.max(0, startIndex);

  while (index < chunks.length) {
    if (signal.aborted) return;

    const chunk = chunks[index];
    if (chunk === undefined) return;

    handlers.onChunkStart(index);

    // Fire-and-forget: this is the seam a network provider fills. Errors are
    // swallowed on purpose — a failed prefetch must not stop the reader, it
    // just means the chunk is fetched later, when it is actually needed.
    if (provider.prepare !== undefined) {
      for (let ahead = 1; ahead <= LOOKAHEAD; ahead++) {
        const upcoming = chunks[index + ahead];
        if (upcoming === undefined) break;
        void provider.prepare(upcoming, signal).catch(() => undefined);
      }
    }

    await provider.speak(chunk, signal);

    // Checked after the await, not before: aborting mid-sentence must leave
    // the index on the sentence that was interrupted so resume repeats it
    // rather than skipping it.
    if (signal.aborted) return;

    index += 1;
  }

  handlers.onComplete();
}
