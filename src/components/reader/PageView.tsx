import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { paraAtOffset } from "../../lib/text";
import { type TextViewHandle, type TextViewProps } from "./ScrollView";
import { renderDecorated } from "../../lib/decorate";
import { blockOf, effectiveColumns, pageBlocks } from "../../lib/layout";


interface Pending {
  para?: number;
  end?: boolean;
}

export const PageView = forwardRef<TextViewHandle, TextViewProps>(function PageView(
  { doc, settings: s, initial, onPos, decos, tocParas, autoPlay, onToggleUi, interceptTap, onEnd, onDecoClick, onSelectEnd },
  ref,
) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Paragraphs are laid out one block at a time; blocks break at chapter headings so the
  // short last page of a block is the end of a chapter, not a stray line mid-story.
  const blocks = useMemo(() => pageBlocks(doc.paras.length, doc.toc.map((t) => t.para ?? 0)), [doc]);
  const blockCount = blocks.length;
  const [block, setBlock] = useState(() => blockOf(blocks, initial.para));
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [size, setSize] = useState({ w: 0, h: 0 });
  /** whole viewport, for the automatic page count */
  const [vp, setVp] = useState({ w: 0, h: 0 });
  const [anim, setAnim] = useState(false);
  const [tick, setTick] = useState(0);
  const pendingRef = useRef<Pending>({ para: initial.para });
  const paraPagesRef = useRef<number[]>([]);
  const curParaRef = useRef(initial.para);
  /**
   * Paragraph to keep as the position across relayouts (resize, fold/unfold, font change).
   * The relaid-out page usually starts a little before it; reporting that page's top
   * paragraph instead would creep backwards with every resize. Cleared by user navigation.
   */
  const anchorRef = useRef<number | null>(null);
  const fadeKey = useRef(0);

  const padY = s.paddingY;
  const gap = Math.max(24, s.padding);
  const columns = effectiveColumns(s.columns, vp.w, vp.h);
  const colW = columns === 2 ? Math.max(100, (size.w - gap) / 2) : size.w;
  const step = size.w + gap;
  const blockStart = blocks[Math.min(block, blockCount - 1)][0];
  const blockEnd = Math.min(doc.paras.length, blocks[Math.min(block, blockCount - 1)][1]);

  const layoutKey = `${s.fontFamily}|${s.fontSize}|${s.lineHeight}|${s.letterSpacing}|${s.paragraphSpacing}|${s.textIndent}|${s.textAlign}|${columns}|${s.padding}|${s.maxWidth}`;

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

  // Measure viewport.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => {
      const vw = el.clientWidth;
      const vh = el.clientHeight;
      setVp((prev) => (prev.w === vw && prev.h === vh ? prev : { w: vw, h: vh }));
      const maxW = columns === 2 ? s.maxWidth * 2 : s.maxWidth;
      const w = Math.max(100, Math.min(maxW, el.clientWidth - s.padding * 2));
      const h = Math.max(100, el.clientHeight - padY * 2);
      setSize((prev) => (Math.abs(prev.w - w) < 1 && Math.abs(prev.h - h) < 1 ? prev : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [s.padding, padY, s.maxWidth, columns]);

  // Any layout-affecting change should keep the current paragraph in view.
  const firstLayout = useRef(true);
  useEffect(() => {
    if (firstLayout.current) {
      firstLayout.current = false;
      return;
    }
    // A resize can arrive in several steps; keep the anchor from the first one.
    anchorRef.current ??= curParaRef.current;
    pendingRef.current = { para: anchorRef.current };
    setTick((t) => t + 1);
  }, [layoutKey, size.w, size.h]);

  // Layout pass: count pages and map paragraphs → page.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || size.w === 0) return;
    const colStep = colW + gap;
    const children = Array.from(content.children) as HTMLElement[];
    const pages = children.map((el) => Math.floor(Math.floor((el.offsetLeft + 2) / colStep) / columns));
    const lastEl = children[children.length - 1];
    let count = 1;
    if (lastEl) {
      // Use scrollWidth to include the tail of the last paragraph.
      const totalCols = Math.max(1, Math.round((content.scrollWidth + gap) / colStep));
      count = Math.max(1, Math.ceil(totalCols / columns));
    }
    paraPagesRef.current = pages;
    setPageCount(count);
    const pend = pendingRef.current;
    pendingRef.current = {};
    setPage((cur) => {
      let p = cur;
      if (pend.para != null) p = pages[Math.min(pages.length - 1, Math.max(0, pend.para - blockStart))] ?? 0;
      else if (pend.end) p = count - 1;
      return Math.min(count - 1, Math.max(0, p));
    });
    setAnim(false);
    switchingRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block, size.w, size.h, layoutKey, tick, doc]);

  // Report position.
  useEffect(() => {
    // Skip while a relayout is still pending: `page` belongs to the old layout.
    if (size.w === 0 || pendingRef.current.para != null) return;
    // The position is the paragraph at the TOP of the page: the first one starting on it,
    // or – when the page opens mid-paragraph – the one continuing from the previous page.
    const pages = paraPagesRef.current;
    let i = pages.findIndex((pg) => pg >= page);
    if (i < 0) i = pages.length - 1;
    else if (pages[i] > page && i > 0) i--;
    let para = blockStart + Math.max(0, i);
    const anchor = anchorRef.current;
    if (anchor != null && anchor >= blockStart && anchor < blockEnd) para = anchor;
    curParaRef.current = para;
    const start = doc.cum[blockStart];
    const end = doc.cum[blockEnd];
    const pct = (start + ((page + 1) / pageCount) * (end - start)) / doc.total;
    onPos(para, 0, Math.min(1, pct));
  }, [page, pageCount, block, blockStart, blockEnd, doc, onPos, size.w]);

  const goToPara = useCallback(
    (para: number) => {
      para = Math.min(doc.paras.length - 1, Math.max(0, para));
      anchorRef.current = null;
      const b = blockOf(blocks, para);
      pendingRef.current = { para };
      if (b !== block) setBlock(b);
      else setTick((t) => t + 1);
    },
    [block, blocks, doc],
  );

  /** Turns in quick succession (held key) skip the animation so pages keep up. */
  const lastTurn = useRef(0);
  const animateTurn = () => {
    const now = performance.now();
    const rapid = now - lastTurn.current < 250;
    lastTurn.current = now;
    setAnim(!rapid);
    // The fade re-mounts the page to restart its animation – not while flipping fast.
    if (!rapid) fadeKey.current++;
  };

  // A held key sends turns faster than React re-renders: read and advance the page
  // through refs, so turns arriving before the next render aren't counted twice as
  // "page + 1" (and lost). While the next block is being laid out, turns are dropped
  // rather than skipping a whole block.
  const pageRef = useRef(page);
  pageRef.current = page;
  const pageCountRef = useRef(pageCount);
  pageCountRef.current = pageCount;
  const blockRef = useRef(block);
  blockRef.current = block;
  const switchingRef = useRef(false);

  const next = useCallback(() => {
    anchorRef.current = null;
    if (switchingRef.current) return;
    const p = pageRef.current;
    const b = blockRef.current;
    if (p < pageCountRef.current - 1) {
      animateTurn();
      pageRef.current = p + 1;
      setPage(p + 1);
    } else if (b < blockCount - 1) {
      switchingRef.current = true;
      pendingRef.current = { para: blocks[b + 1][0] };
      setBlock(b + 1);
    } else onEnd?.();
  }, [blocks, blockCount, onEnd]);

  const prev = useCallback(() => {
    anchorRef.current = null;
    if (switchingRef.current) return;
    const p = pageRef.current;
    const b = blockRef.current;
    if (p > 0) {
      animateTurn();
      pageRef.current = p - 1;
      setPage(p - 1);
    } else if (b > 0) {
      switchingRef.current = true;
      pendingRef.current = { end: true };
      setBlock(b - 1);
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      goTo: (para) => goToPara(para),
      next,
      prev,
      seek: (pct) => {
        if (pct >= 0.999) {
          anchorRef.current = null;
          pendingRef.current = { end: true };
          if (blockCount - 1 !== block) setBlock(blockCount - 1);
          else setTick((t) => t + 1);
          return;
        }
        goToPara(paraAtOffset(doc.cum, pct * doc.total));
      },
      home: () => goToPara(0),
      ensureVisible: (para) => {
        const b = blockOf(blocks, para);
        if (b === block) {
          const target = paraPagesRef.current[para - blockStart];
          if (target === page || (target != null && target < page && (paraPagesRef.current[para - blockStart + 1] ?? pageCount) > page)) return;
          if (target != null) {
            anchorRef.current = null;
            setAnim(true);
            setPage(target);
            return;
          }
        }
        goToPara(para);
      },
      end: () => {
        anchorRef.current = null;
        pendingRef.current = { end: true };
        if (blockCount - 1 !== block) setBlock(blockCount - 1);
        else setTick((t) => t + 1);
      },
    }),
    [goToPara, next, prev, doc, blocks, block, blockCount, blockStart, page, pageCount],
  );

  // Wheel → page flip (throttled).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    let lock = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const now = performance.now();
      if (now - lock < 160) return;
      if (Math.abs(e.deltaY) < 4 && Math.abs(e.deltaX) < 4) return;
      lock = now;
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (d > 0) next();
      else prev();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [next, prev]);

  // Auto page turn.
  useEffect(() => {
    if (!autoPlay) return;
    const id = window.setInterval(next, s.autoPageSec * 1000);
    return () => window.clearInterval(id);
  }, [autoPlay, s.autoPageSec, next]);

  // Touch swipe.
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const animClass = anim ? (s.animation === "slide" ? "anim-slide" : s.animation === "fade" ? "anim-fade" : "") : "";

  return (
    <div
      className="page-viewport"
      ref={viewportRef}
      style={{ padding: `${padY}px ${s.padding}px` }}
      onMouseUp={() => onSelectEnd?.()}
      onClick={(e) => {
        const mark = (e.target as HTMLElement).closest("mark[data-hl]") as HTMLElement | null;
        if (mark && onDecoClick) {
          onDecoClick(mark.dataset.hl!, mark.getBoundingClientRect());
          return;
        }
        // Zones: left third = previous, right third = next, middle = toggle UI.
        // Skipped when the user was selecting text.
        if (window.getSelection()?.toString()) return;
        if (interceptTap?.()) return;
        const r = viewportRef.current!.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width;
        if (x < 0.3) prev();
        else if (x > 0.7) next();
        else onToggleUi();
      }}
      onPointerDown={(e) => {
        if (e.pointerType === "touch") touchStart.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerUp={(e) => {
        const t = touchStart.current;
        touchStart.current = null;
        if (!t || e.pointerType !== "touch") return;
        const dx = e.clientX - t.x;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(e.clientY - t.y)) {
          if (dx < 0) next();
          else prev();
        }
      }}
    >
      <div style={{ position: "relative", width: size.w, height: size.h, margin: "0 auto", overflow: "hidden" }}>
        <div
          ref={contentRef}
          key={s.animation === "fade" ? fadeKey.current : "static"}
          className={`page-content ${animClass}`}
          style={{
            width: size.w,
            height: size.h,
            columnWidth: colW,
            columnGap: gap,
            transform: `translateX(${-page * step}px)`,
          }}
        >
          {doc.paras.slice(blockStart, blockEnd).map((text, i) => {
            const idx = blockStart + i;
            return (
              <p key={idx} data-index={idx} className={`${text.length === 0 ? "blank" : ""} ${tocParas.has(idx) ? "toc-line" : ""}`} style={paraStyle}>
                {renderDecorated(text, decos.get(idx))}
              </p>
            );
          })}
        </div>
        {columns === 2 && <div className="page-divider" />}
      </div>
    </div>
  );
});
