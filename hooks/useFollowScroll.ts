"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Keys that scroll the page, and so signal the reader has taken over. */
const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

/**
 * Keeps the active sentence in view, and gets out of the way when the reader
 * scrolls for themselves.
 *
 * **Why this listens for input events rather than `scroll` events.** The
 * obvious implementation watches `scroll` and turns following off when one
 * arrives that it did not cause. It does not work: `scrollIntoView({behavior:
 * "smooth"})` emits a stream of scroll events over several hundred
 * milliseconds, indistinguishable from a person dragging, so the feature
 * immediately disables itself every time it works. Guarding with an
 * "ignore scrolls for the next N ms" flag then trades that for a window in
 * which genuine user scrolls are swallowed.
 *
 * Wheel, touch, and key events carry no such ambiguity: they only happen when
 * a person does something. Following stops on the first one and resumes only
 * when the reader clicks a sentence, which is an equally unambiguous signal
 * that they want the player's position to lead again.
 */
export function useFollowScroll(activeIndex: number) {
  const [following, setFollowing] = useState(true);
  const activeRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!following) return;
    activeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIndex, following]);

  useEffect(() => {
    const stop = () => setFollowing(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) setFollowing(false);
    };
    window.addEventListener("wheel", stop, { passive: true });
    window.addEventListener("touchmove", stop, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchmove", stop);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  /** Re-enable following and jump straight to the active sentence. */
  const resume = useCallback(() => {
    setFollowing(true);
    activeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  return { following, resume, setFollowing, activeRef };
}
