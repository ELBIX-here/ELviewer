import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Settings } from "../../types";
import type { TextDoc } from "../../lib/text";
import { paraAtOffset } from "../../lib/text";
import { renderDecorated, type DecoMap } from "../../lib/decorate";

export interface TextViewHandle {
  goTo: (para: number, frac?: number) => void;
  next: () => void;
  prev: () => void;
  seek: (pct: number) => void;
  home: () => void;
  end: () => void;
  /** scroll only if `para` isn't already on screen (TTS follow) */
  ensureVisible: (para: number) => void;
}

export interface TextViewProps {
  doc: TextDoc;
  settings: Settings;
  initial: { para: number; frac: number };
  onPos: (para: number, frac: number, pct: number) => void;
  decos: DecoMap;
  tocParas: Set<number>;
  autoPlay: boolean;
  onToggleUi: () => void;
  /** called first on a tap; true = the tap only closed the chrome, ignore it */
  interceptTap?: () => boolean;
  /** user tried to go past the end */
  onEnd?: () => void;
  /** click on a highlight mark */
  onDecoClick?: (id: string, rect: DOMRect) => void;
  /** mouse released – the reader checks for a text selection */
  onSelectEnd?: () => void;
}

const TOP_PAD = 72;
const BOTTOM_PAD = 120;


export const ScrollView = forwardRef<TextViewHandle, TextViewProps>(function ScrollView(
  { doc, settings: s, initial, onPos, decos, tocParas, autoPlay, onToggleUi, interceptTap, onEnd, onDecoClick, onSelectEnd },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerWidthRef = useRef(600);
  const lastPosRef = useRef(initial);
  const suppressRef = useRef(0);
  const jumpToken = useRef(0);
  const reportRef = useRef<(() => void) | null>(null);

  const paraStyle = useMemo<React.CSSProperties>(
    () => ({
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      lineHeight: s.lineHeight,
      letterSpacing: s.letterSpacing ? `${s.letterSpacing}px` : undefined,
      textIndent: s.textIndent ? `${s.textIndent}em` : undefined,
      textAlign: s.textAlign,
      paddingBottom: `${s.paragraphSpacing}em`,
    }),
    [s.fontFamily, s.fontSize, s.lineHeight, s.letterSpacing, s.textIndent, s.textAlign, s.paragraphSpacing],
  );

  const estimate = useCallback(
    (i: number) => {
      const len = doc.paras[i].length;
      const lineH = s.fontSize * s.lineHeight;
      if (len === 0) return s.fontSize * 0.6 + s.fontSize * s.paragraphSpacing;
      const charsPerLine = Math.max(8, Math.floor(innerWidthRef.current / (s.fontSize * 0.92)));
      const lines = Math.max(1, Math.ceil(len / charsPerLine));
      return lines * lineH + s.fontSize * s.paragraphSpacing;
    },
    [doc, s.fontSize, s.lineHeight, s.paragraphSpacing],
  );

  const virt = useVirtualizer({
    count: doc.paras.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimate,
    overscan: 12,
    paddingStart: TOP_PAD,
    paddingEnd: BOTTOM_PAD,
    getItemKey: (i) => i,
  });

  // Scroll to a paragraph, then correct for measurement drift over a few frames.
  const scrollToPara = useCallback(
    (para: number, frac = 0) => {
      const el = scrollRef.current;
      if (!el) return;
      para = Math.min(doc.paras.length - 1, Math.max(0, para));
      // Paragraph heights start as estimates and are corrected as rows render, which
      // moves the target. Re-aim every frame until the position holds for a few frames,
      // then record where we actually landed.
      const token = ++jumpToken.current;
      suppressRef.current = Number.MAX_SAFE_INTEGER;
      let tries = 0;
      let stable = 0;
      const step = () => {
        if (token !== jumpToken.current) return;
        const m = virt.measurementsCache[para];
        if (m) {
          const target = Math.max(0, m.start + frac * m.size - TOP_PAD);
          if (Math.abs(el.scrollTop - target) > 1) {
            el.scrollTop = target;
            stable = 0;
          } else stable++;
        }
        if (stable < 3 && ++tries < 60) requestAnimationFrame(step);
        else {
          suppressRef.current = 0;
          reportRef.current?.();
        }
      };
      step();
    },
    [doc, virt],
  );

  // Report position on scroll (rAF-throttled).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const report = () => {
      raf = 0;
      if (suppressRef.current > 0) {
        suppressRef.current--;
        return;
      }
      const top = el.scrollTop + TOP_PAD;
      const items = virt.getVirtualItems();
      const item = items.find((v) => v.end > top + 1) ?? items[items.length - 1];
      if (!item) return;
      const frac = Math.min(1, Math.max(0, (top - item.start) / Math.max(1, item.size)));
      const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
      const para = item.index;
      const pct = atEnd ? 1 : (doc.cum[para] + frac * (doc.paras[para].length + 1)) / doc.total;
      lastPosRef.current = { para, frac };
      onPos(para, frac, Math.min(1, pct));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(report);
    };
    reportRef.current = report;
    // The user taking over the scroll cancels any in-flight position correction.
    const takeOver = () => {
      if (suppressRef.current > 0) {
        jumpToken.current++;
        suppressRef.current = 0;
      }
    };
    el.addEventListener("wheel", takeOver, { passive: true });
    el.addEventListener("touchstart", takeOver, { passive: true });
    el.addEventListener("pointerdown", takeOver, { passive: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("wheel", takeOver);
      el.removeEventListener("touchstart", takeOver);
      el.removeEventListener("pointerdown", takeOver);
      el.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [virt, doc, onPos]);

  // Initial position.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) innerWidthRef.current = Math.min(s.maxWidth, el.clientWidth - s.padding * 2);
    scrollToPara(initial.para, initial.frac);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  // Keep position when typography or width changes.
  const layoutKey = `${s.fontFamily}|${s.fontSize}|${s.lineHeight}|${s.letterSpacing}|${s.paragraphSpacing}|${s.textIndent}|${s.maxWidth}|${s.padding}|${s.textAlign}`;
  const firstLayout = useRef(true);
  useEffect(() => {
    if (firstLayout.current) {
      firstLayout.current = false;
      return;
    }
    const el = scrollRef.current;
    if (el) innerWidthRef.current = Math.min(s.maxWidth, el.clientWidth - s.padding * 2);
    const pos = lastPosRef.current;
    virt.measure();
    requestAnimationFrame(() => scrollToPara(pos.para, pos.frac));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = Math.min(s.maxWidth, el.clientWidth - s.padding * 2);
      if (Math.abs(w - innerWidthRef.current) > 2) {
        innerWidthRef.current = w;
        const pos = lastPosRef.current;
        virt.measure();
        requestAnimationFrame(() => scrollToPara(pos.para, pos.frac));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [virt, scrollToPara, s.maxWidth, s.padding]);

  // Auto scroll.
  useEffect(() => {
    if (!autoPlay) return;
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const tick = (t: number) => {
      const dt = (t - last) / 1000;
      last = t;
      acc += s.autoScrollSpeed * dt;
      const whole = Math.floor(acc);
      if (whole >= 1) {
        el.scrollTop += whole;
        acc -= whole;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [autoPlay, s.autoScrollSpeed]);

  useImperativeHandle(
    ref,
    () => ({
      goTo: (para, frac = 0) => scrollToPara(para, frac),
      next: () => {
        const el = scrollRef.current;
        if (!el) return;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) onEnd?.();
        else el.scrollBy({ top: el.clientHeight * 0.9, behavior: "instant" as ScrollBehavior });
      },
      prev: () => {
        const el = scrollRef.current;
        if (el) el.scrollBy({ top: -el.clientHeight * 0.9, behavior: "instant" as ScrollBehavior });
      },
      seek: (pct) => {
        if (pct >= 0.999) {
          const el = scrollRef.current;
          if (el) el.scrollTop = el.scrollHeight;
          return;
        }
        const off = pct * doc.total;
        const para = paraAtOffset(doc.cum, off);
        const len = doc.paras[para].length + 1;
        scrollToPara(para, (off - doc.cum[para]) / len);
      },
      home: () => scrollToPara(0, 0),
      ensureVisible: (para) => {
        const el = scrollRef.current;
        if (!el) return;
        const item = virt.getVirtualItems().find((v) => v.index === para);
        const top = el.scrollTop + TOP_PAD;
        const bottom = el.scrollTop + el.clientHeight - BOTTOM_PAD / 2;
        if (item && item.start >= top - 4 && item.end <= bottom) return;
        // Keep a little context above the sentence being read.
        scrollToPara(Math.max(0, para - 1), 0);
      },
      end: () => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      },
    }),
    [scrollToPara, doc, virt, onEnd],
  );

  const items = virt.getVirtualItems();

  return (
    <div
      className="scroll-view"
      ref={scrollRef}
      onMouseUp={() => onSelectEnd?.()}
      onClick={(e) => {
        const mark = (e.target as HTMLElement).closest("mark[data-hl]") as HTMLElement | null;
        if (mark && onDecoClick) {
          onDecoClick(mark.dataset.hl!, mark.getBoundingClientRect());
          return;
        }
        // Center click toggles UI, but not when selecting text.
        if (window.getSelection()?.toString()) return;
        if (interceptTap?.()) return;
        const el = scrollRef.current!;
        const x = e.clientX - el.getBoundingClientRect().left;
        if (x > el.clientWidth * 0.3 && x < el.clientWidth * 0.7) onToggleUi();
      }}
    >
      <div className="scroll-inner" style={{ height: virt.getTotalSize(), maxWidth: s.maxWidth, padding: `0 ${s.padding}px` }}>
        {items.map((item) => {
          const text = doc.paras[item.index];
          return (
            <p
              key={item.key}
              data-index={item.index}
              ref={virt.measureElement}
              className={`para ${text.length === 0 ? "blank" : ""} ${tocParas.has(item.index) ? "toc-line" : ""}`}
              style={{ ...paraStyle, transform: `translateY(${item.start}px)`, paddingLeft: s.padding, paddingRight: s.padding }}
            >
              {renderDecorated(text, decos.get(item.index))}
            </p>
          );
        })}
      </div>
    </div>
  );
});
