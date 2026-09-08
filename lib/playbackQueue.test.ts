import { describe, it, expect } from "vitest";
import { runPlayback, LOOKAHEAD } from "./playbackQueue";
import type { Chunk } from "./types";
import type { SpeechSettings, TTSProvider, Voice } from "./ttsProvider";

function chunksOf(count: number): Chunk[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index,
    pageNumber: 1,
    text: `Sentence ${index}.`,
    charStart: index * 20,
  }));
}

/**
 * A provider that records what it was asked to do. `speak` resolves on the
 * next microtask unless told to hang, which is what lets a test abort in the
 * middle of a sentence.
 */
class FakeProvider implements TTSProvider {
  readonly id = "fake";
  spoken: number[] = [];
  prepared: number[] = [];
  cancelled = 0;
  settings: SpeechSettings | null = null;
  /** When set, `speak` never resolves until the signal aborts. */
  hangOn: number | null = null;

  async speak(chunk: Chunk, signal: AbortSignal): Promise<void> {
    this.spoken.push(chunk.id);
    if (this.hangOn === chunk.id) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return;
    }
    await Promise.resolve();
  }

  cancel(): void {
    this.cancelled += 1;
  }

  async getVoices(): Promise<Voice[]> {
    return [];
  }

  configure(settings: SpeechSettings): void {
    this.settings = settings;
  }

  async prepare(chunk: Chunk): Promise<void> {
    this.prepared.push(chunk.id);
  }
}

function handlers() {
  const started: number[] = [];
  let completed = 0;
  return {
    started,
    get completed() {
      return completed;
    },
    onChunkStart: (index: number) => void started.push(index),
    onComplete: () => void (completed += 1),
  };
}

describe("runPlayback", () => {
  it("speaks every chunk in order and then completes", async () => {
    const provider = new FakeProvider();
    const h = handlers();
    await runPlayback(chunksOf(4), 0, provider, new AbortController().signal, h);
    expect(provider.spoken).toEqual([0, 1, 2, 3]);
    expect(h.started).toEqual([0, 1, 2, 3]);
    expect(h.completed).toBe(1);
  });

  it("starts from the given index", async () => {
    const provider = new FakeProvider();
    await runPlayback(chunksOf(5), 3, provider, new AbortController().signal, handlers());
    expect(provider.spoken).toEqual([3, 4]);
  });

  it("prepares the next chunks while the current one plays", async () => {
    const provider = new FakeProvider();
    await runPlayback(chunksOf(6), 0, provider, new AbortController().signal, handlers());
    // Chunk 0 is spoken only after 1 and 2 have been asked for.
    expect(provider.prepared.slice(0, LOOKAHEAD)).toEqual([1, 2]);
    expect(provider.prepared).not.toContain(0);
  });

  it("does not prepare past the end of the document", async () => {
    const provider = new FakeProvider();
    await runPlayback(chunksOf(2), 0, provider, new AbortController().signal, handlers());
    expect(provider.prepared.every((id) => id < 2)).toBe(true);
  });

  it("stops at an abort raised before the run starts", async () => {
    const provider = new FakeProvider();
    const controller = new AbortController();
    controller.abort();
    const h = handlers();
    await runPlayback(chunksOf(3), 0, provider, controller.signal, h);
    expect(provider.spoken).toEqual([]);
    expect(h.completed).toBe(0);
  });

  it("stops mid-document when aborted between chunks", async () => {
    const provider = new FakeProvider();
    const controller = new AbortController();
    const h = handlers();
    const chunks = chunksOf(10);
    // Abort once chunk 2 has been reached.
    const originalStart = h.onChunkStart;
    const run = runPlayback(chunks, 0, provider, controller.signal, {
      onChunkStart: (index) => {
        originalStart(index);
        if (index === 2) controller.abort();
      },
      onComplete: h.onComplete,
    });
    await run;
    expect(provider.spoken).toEqual([0, 1, 2]);
    expect(h.completed).toBe(0);
  });

  it("does not advance past a sentence interrupted mid-utterance", async () => {
    // The regression that matters for pause/resume: aborting while chunk 2 is
    // speaking must leave 2 as the current chunk, so resuming repeats it
    // rather than silently skipping to 3.
    const provider = new FakeProvider();
    provider.hangOn = 2;
    const controller = new AbortController();
    const h = handlers();

    const run = runPlayback(chunksOf(6), 0, provider, controller.signal, h);
    // Let the loop reach the hanging chunk, then interrupt it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await run;

    expect(provider.spoken).toEqual([0, 1, 2]);
    expect(h.started[h.started.length - 1]).toBe(2);
    expect(h.completed).toBe(0);
  });

  it("never reports completion when it was cancelled", async () => {
    const provider = new FakeProvider();
    provider.hangOn = 0;
    const controller = new AbortController();
    const h = handlers();
    const run = runPlayback(chunksOf(1), 0, provider, controller.signal, h);
    controller.abort();
    await run;
    expect(h.completed).toBe(0);
  });

  it("survives a provider whose prepare rejects", async () => {
    const provider = new FakeProvider();
    provider.prepare = async () => {
      throw new Error("network down");
    };
    const h = handlers();
    await runPlayback(chunksOf(3), 0, provider, new AbortController().signal, h);
    // A failed lookahead can cost latency; it must never stop playback.
    expect(provider.spoken).toEqual([0, 1, 2]);
    expect(h.completed).toBe(1);
  });

  it("works with a provider that has no prepare at all", async () => {
    const provider = new FakeProvider();
    const withoutPrepare: TTSProvider = {
      id: provider.id,
      speak: (chunk, signal) => provider.speak(chunk, signal),
      cancel: () => provider.cancel(),
      getVoices: () => provider.getVoices(),
      configure: (settings) => provider.configure(settings),
    };
    const h = handlers();
    await runPlayback(chunksOf(3), 0, withoutPrepare, new AbortController().signal, h);
    expect(provider.spoken).toEqual([0, 1, 2]);
    expect(h.completed).toBe(1);
  });

  it("completes immediately on an empty document", async () => {
    const provider = new FakeProvider();
    const h = handlers();
    await runPlayback([], 0, provider, new AbortController().signal, h);
    expect(provider.spoken).toEqual([]);
    expect(h.completed).toBe(1);
  });
});
