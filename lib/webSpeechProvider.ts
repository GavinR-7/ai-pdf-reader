/**
 * `TTSProvider` backed by the browser's `speechSynthesis`.
 *
 * v1's only provider: free, no server, no network latency, and its `onend`
 * event gives sentence-level synchronisation directly — which is exactly the
 * granularity the highlight needs, with no timing estimation anywhere.
 *
 * The Web Speech API is also, bluntly, unreliable. Three specific defects are
 * handled below and each is commented where it is worked around, because they
 * are invisible in the code that causes them and maddening to rediscover.
 */

import type { Chunk } from "./types";
import type { SpeechSettings, TTSProvider, Voice } from "./ttsProvider";

/** Give up waiting for `voiceschanged` after this and use whatever we have. */
const VOICES_TIMEOUT_MS = 2000;

/** How often to nudge Chrome so it does not abandon a long utterance. */
const KEEPALIVE_MS = 10_000;

/** How long to wait for the engine to go quiet after `cancel()`. */
const CANCEL_SETTLE_MAX_MS = 250;
const CANCEL_POLL_MS = 25;

export function isWebSpeechSupported(): boolean {
  return typeof globalThis.speechSynthesis !== "undefined";
}

export class SpeechError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeechError";
  }
}

function toVoice(voice: SpeechSynthesisVoice): Voice {
  return {
    id: voice.voiceURI,
    name: voice.name,
    lang: voice.lang,
    isDefault: voice.default,
  };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class WebSpeechProvider implements TTSProvider {
  readonly id = "web-speech";

  #settings: SpeechSettings = { voiceId: null, rate: 1 };
  #voices: SpeechSynthesisVoice[] = [];

  /**
   * Incremented on every cancel and every new utterance.
   *
   * Guards against the third pitfall below: events from a cancelled utterance
   * can arrive *after* its replacement has started, and acting on them would
   * resolve the wrong promise and skip a sentence. A handler that finds the
   * epoch has moved on knows it is a ghost and does nothing.
   */
  #epoch = 0;

  #keepAlive: ReturnType<typeof setInterval> | null = null;

  #synth(): SpeechSynthesis {
    const synth = globalThis.speechSynthesis;
    if (synth === undefined) {
      throw new SpeechError("This browser has no speech synthesis.");
    }
    return synth;
  }

  configure(settings: SpeechSettings): void {
    this.#settings = settings;
  }

  /**
   * **Pitfall 1: `getVoices()` returns an empty array until the engine has
   * loaded its voice list.**
   *
   * On Chrome the list arrives asynchronously and is announced by a
   * `voiceschanged` event; call `getVoices()` on page load and you get `[]`,
   * with no indication that waiting would help. The naive fix — always wait
   * for the event — hangs on browsers where the list is ready immediately and
   * the event consequently never fires. So: return synchronously if the list
   * is already populated, otherwise wait for the event *with a timeout*, and
   * take whatever exists when the timeout expires.
   */
  async getVoices(): Promise<Voice[]> {
    const synth = this.#synth();

    const immediate = synth.getVoices();
    if (immediate.length > 0) {
      this.#voices = immediate;
      return immediate.map(toVoice);
    }

    const loaded = await new Promise<SpeechSynthesisVoice[]>((resolve) => {
      let settled = false;
      const finish = (voices: SpeechSynthesisVoice[]) => {
        if (settled) return;
        settled = true;
        synth.removeEventListener("voiceschanged", onChanged);
        clearTimeout(timer);
        resolve(voices);
      };
      const onChanged = () => finish(synth.getVoices());
      const timer = setTimeout(() => finish(synth.getVoices()), VOICES_TIMEOUT_MS);
      synth.addEventListener("voiceschanged", onChanged);
    });

    this.#voices = loaded;
    return loaded.map(toVoice);
  }

  cancel(): void {
    if (!isWebSpeechSupported()) return;
    this.#epoch += 1;
    this.#stopKeepAlive();
    this.#synth().cancel();
  }

  async speak(chunk: Chunk, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const synth = this.#synth();

    /**
     * **Pitfall 3: cancel-then-immediately-speak is a race.**
     *
     * `cancel()` is processed asynchronously inside the engine. Calling
     * `speak()` in the same task frequently loses: the new utterance is
     * swallowed by the in-flight cancel and simply never plays, so the reader
     * presses a sentence and gets silence. Waiting for the engine to report
     * itself quiet — and then yielding one more turn even if it already was —
     * makes the handoff deterministic. The epoch guard below covers the
     * remainder, where a cancelled utterance's events arrive late.
     */
    synth.cancel();
    const deadline = Date.now() + CANCEL_SETTLE_MAX_MS;
    while ((synth.speaking || synth.pending) && Date.now() < deadline) {
      await delay(CANCEL_POLL_MS);
    }
    await delay(0);
    if (signal.aborted) return;

    const epoch = (this.#epoch += 1);

    await new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(chunk.text);
      utterance.rate = Math.min(2, Math.max(0.5, this.#settings.rate));

      const voice = this.#voices.find((v) => v.voiceURI === this.#settings.voiceId);
      if (voice !== undefined) {
        utterance.voice = voice;
        // Setting lang alongside the voice matters: some engines ignore the
        // voice and fall back to the document language without it.
        utterance.lang = voice.lang;
      }

      let settled = false;
      let detach = () => {};
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        this.#stopKeepAlive();
        detach();
        action();
      };

      const onAbort = () => {
        finish(() => {
          synth.cancel();
          // Resolve, don't reject: cancellation is the reader pressing pause,
          // not a failure. The queue checks `signal.aborted` after awaiting.
          resolve();
        });
      };
      detach = () => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });

      utterance.onend = () => {
        if (epoch !== this.#epoch) return; // ghost of a cancelled utterance
        finish(resolve);
      };

      utterance.onerror = (event) => {
        if (epoch !== this.#epoch) return;
        finish(() => {
          // These two are what a deliberate cancel looks like from the
          // engine's side, so they are a normal outcome rather than an error.
          if (event.error === "interrupted" || event.error === "canceled") {
            resolve();
            return;
          }
          reject(new SpeechError(`Speech synthesis failed: ${event.error}`));
        });
      };

      synth.speak(utterance);
      this.#startKeepAlive();
    });
  }

  /**
   * **Pitfall 2: Chrome silently stops speaking after ~15 seconds.**
   *
   * Long utterances are abandoned partway with no `onend` and no `onerror` —
   * the queue simply waits forever on a promise that will never settle, and
   * playback appears to freeze mid-document. The established workaround is to
   * toggle `pause()`/`resume()` on a timer, which resets the engine's internal
   * watchdog.
   *
   * This is not hypothetical here: chunks are capped at 400 characters, which
   * at 0.75x is comfortably over 15 seconds of speech.
   */
  #startKeepAlive(): void {
    this.#stopKeepAlive();
    this.#keepAlive = setInterval(() => {
      if (!isWebSpeechSupported()) return;
      const synth = this.#synth();
      if (synth.speaking && !synth.paused) {
        synth.pause();
        synth.resume();
      }
    }, KEEPALIVE_MS);
  }

  #stopKeepAlive(): void {
    if (this.#keepAlive !== null) {
      clearInterval(this.#keepAlive);
      this.#keepAlive = null;
    }
  }
}
