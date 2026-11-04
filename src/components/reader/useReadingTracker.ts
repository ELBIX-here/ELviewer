import { useEffect, useRef } from "react";
import { useStats } from "../../store/stats";
import { useProgress } from "../../store/progress";

const TICK_MS = 10000;
/** No input for this long pauses the clock (the reader walked away). */
const IDLE_MS = 3 * 60000;
/** Faster than this is a jump (seek, TOC), not reading. ~3,600 chars/min. */
const MAX_CHARS_PER_SEC = 60;

/**
 * Counts active reading time for a book and feeds the statistics store.
 * `charOffset` (text documents) is the current absolute character position;
 * forward movement at a plausible speed is counted as characters read.
 */
export function useReadingTracker(opts: {
  bookId: string;
  title: string;
  kind: string;
  pct: number;
  charOffset?: number;
  autoPlay?: boolean;
}) {
  const record = useStats((s) => s.record);
  const markFinished = useStats((s) => s.markFinished);
  const addReadTime = useProgress((s) => s.addReadTime);
  const lastInput = useRef(Date.now());
  const offsetRef = useRef(opts.charOffset);
  const lastOffset = useRef(opts.charOffset);
  const optsRef = useRef(opts);
  offsetRef.current = opts.charOffset;
  optsRef.current = opts;

  useEffect(() => {
    const bump = () => {
      lastInput.current = Date.now();
    };
    const evs = ["keydown", "wheel", "pointerdown", "pointermove", "touchstart", "reader-activity"];
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    return () => evs.forEach((e) => window.removeEventListener(e, bump));
  }, []);

  useEffect(() => {
    lastOffset.current = offsetRef.current;
    let last = Date.now();
    const flush = (final: boolean) => {
      const now = Date.now();
      const elapsed = now - last;
      last = now;
      const o = optsRef.current;
      const active = document.visibilityState === "visible" && (o.autoPlay || now - lastInput.current < IDLE_MS);
      let chars = 0;
      const cur = offsetRef.current;
      if (cur != null && lastOffset.current != null) {
        const delta = cur - lastOffset.current;
        if (active && delta > 0 && delta <= (elapsed / 1000) * MAX_CHARS_PER_SEC) chars = delta;
      }
      lastOffset.current = cur;
      if (!active || elapsed < (final ? 3000 : 1)) return;
      record(o.bookId, { title: o.title, kind: o.kind }, elapsed, chars);
      addReadTime(o.bookId, elapsed);
    };
    const id = window.setInterval(() => flush(false), TICK_MS);
    return () => {
      window.clearInterval(id);
      flush(true);
    };
  }, [opts.bookId, record, addReadTime]);

  useEffect(() => {
    if (opts.pct >= 0.995) markFinished(opts.bookId);
  }, [opts.pct, opts.bookId, markFinished]);
}
