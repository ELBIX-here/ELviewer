import { useEffect, useRef, type RefObject } from "react";

/**
 * Listen for horizontal touch swipes on `target` (left swipe = next). Mouse pointers
 * are ignored; desktop uses clicks, keys and the wheel. Returns a detach function.
 */
export function attachSwipe(target: EventTarget, onNext: () => void, onPrev: () => void): () => void {
  let start: { x: number; y: number; t: number } | null = null;
  const down = (e: Event) => {
    const p = e as PointerEvent;
    if (p.pointerType === "touch") start = { x: p.clientX, y: p.clientY, t: performance.now() };
  };
  const up = (e: Event) => {
    const p = e as PointerEvent;
    const s = start;
    start = null;
    if (!s || p.pointerType !== "touch") return;
    const dx = p.clientX - s.x;
    const dy = p.clientY - s.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && performance.now() - s.t < 800) {
      if (dx < 0) onNext();
      else onPrev();
    }
  };
  const cancel = () => {
    start = null;
  };
  target.addEventListener("pointerdown", down);
  target.addEventListener("pointerup", up);
  target.addEventListener("pointercancel", cancel);
  return () => {
    target.removeEventListener("pointerdown", down);
    target.removeEventListener("pointerup", up);
    target.removeEventListener("pointercancel", cancel);
  };
}

/** Swipe → next / previous page on an element of the reader. */
export function useSwipe(ref: RefObject<HTMLElement | null>, onNext: () => void, onPrev: () => void, enabled = true) {
  // The reader re-renders during a swipe (pointer moves update UI state), which gives
  // us new callbacks. Keep the listeners – and the touch-start they remember – stable
  // and call the latest callbacks through refs.
  const next = useRef(onNext);
  const prev = useRef(onPrev);
  next.current = onNext;
  prev.current = onPrev;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    return attachSwipe(
      el,
      () => next.current(),
      () => prev.current(),
    );
  }, [ref, enabled]);
}
