import { useCallback, useEffect, useRef, useState } from "react";
// Legacy build: the modern one relies on very new JS APIs (e.g. Uint8Array#toHex)
// that Android System WebView versions still in common use lack.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { Bookmark, TocItem } from "../../types";
import { readBinary } from "../../lib/tauri";
import { useSettings } from "../../store/settings";
import { useProgress, NO_BOOKMARKS } from "../../store/progress";
import { ReaderChrome, type PanelName } from "./ReaderChrome";
import { useAutoHide } from "./useAutoHide";
import { useReadingTracker } from "./useReadingTracker";
import { useReaderKeys } from "./useReaderKeys";
import { useEndAdvance } from "./useEndAdvance";
import { useSwipe } from "./useSwipe";
import { stripExt } from "../../lib/sort";
import type { ReaderProps } from "./TextReader";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();

interface PageInfo {
  w: number;
  h: number;
}

/** Renders one PDF page onto a canvas when visible. */
function PdfPage({ pdf, index, width, dark }: { pdf: PDFDocumentProxy; index: number; width: number; dark: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => setVisible(es.some((e) => e.isIntersecting)), { rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    (async () => {
      const page = await pdf.getPage(index + 1);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const scale = width / base.width;
      const dpr = window.devicePixelRatio || 1;
      const vp = page.getViewport({ scale: scale * dpr });
      const canvas = ref.current!;
      canvas.width = vp.width;
      canvas.height = vp.height;
      canvas.style.width = `${vp.width / dpr}px`;
      canvas.style.height = `${vp.height / dpr}px`;
      const ctx = canvas.getContext("2d")!;
      const t = page.render({ canvasContext: ctx, viewport: vp, canvas });
      task = t;
      try {
        await t.promise;
      } catch {
        /* cancelled */
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, index, width, visible]);

  return (
    <div className="pdf-page" ref={wrapRef} style={{ filter: dark ? "invert(0.88) hue-rotate(180deg)" : undefined }}>
      <canvas ref={ref} />
    </div>
  );
}

export function PdfReader({ entry, onBack, onPrevFile, onNextFile, nextName, subtitle }: ReaderProps) {
  const { settings } = useSettings();
  const progress = useProgress((st) => st.progress[entry.id]);
  const bookmarks = useProgress((st) => st.bookmarks[entry.id] ?? NO_BOOKMARKS);
  const { update, addBookmark, removeBookmark } = useProgress();

  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [page, setPage] = useState(progress?.page ?? 0);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelName | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const ui = useAutoHide(settings.uiAutoHideSec * 1000, panel !== null);
  const dark = settings.theme === "dark" || settings.theme === "black";
  const scrollMode = settings.readMode === "scroll";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const bytes = await readBinary(entry.id);
        const doc = await pdfjs.getDocument({ data: bytes }).promise;
        if (cancelled) return;
        const infos: PageInfo[] = [];
        // Page sizes for layout; sample lazily beyond the first 50 to keep startup fast.
        const first = await doc.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        for (let i = 0; i < doc.numPages; i++) infos.push({ w: vp.width, h: vp.height });
        setPages(infos);
        setPdf(doc);
        try {
          const outline = await doc.getOutline();
          const items: TocItem[] = [];
          const walk = async (nodes: typeof outline, level: number) => {
            for (const n of nodes ?? []) {
              let pageIndex: number | undefined;
              try {
                const dest = typeof n.dest === "string" ? await doc.getDestination(n.dest) : n.dest;
                if (dest && dest[0]) pageIndex = await doc.getPageIndex(dest[0]);
              } catch {
                /* ignore */
              }
              items.push({ label: n.title, page: pageIndex, level });
              if (n.items?.length) await walk(n.items, level + 1);
            }
          };
          await walk(outline, 0);
          setToc(items.filter((t) => t.page != null));
        } catch {
          /* no outline */
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entry.id]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const total = pages.length;
  const pct = total ? (page + 1) / total : progress?.pct ?? 0;
  useReadingTracker({ bookId: entry.id, title: stripExt(entry.name), kind: "pdf", pct });

  useEffect(() => {
    if (!total) return;
    update(entry.id, { page, pct, mtime: entry.mtime });
  }, [page, pct, total, entry.id, entry.mtime, update]);

  // Scroll mode: track current page and restore.
  const pageW = Math.min(settings.maxWidth, size.w - 40);
  const gapPx = 12;
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!scrollMode || !total || restoredRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    restoredRef.current = true;
    requestAnimationFrame(() => {
      const ratio = pageW / pages[0].w;
      el.scrollTop = page * (pages[0].h * ratio + gapPx) + 16;
    });
  }, [scrollMode, total, pageW, pages, page]);

  useEffect(() => {
    restoredRef.current = false;
  }, [scrollMode]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !total) return;
    const ratio = pageW / pages[0].w;
    const ph = pages[0].h * ratio + gapPx;
    const p = Math.min(total - 1, Math.max(0, Math.round((el.scrollTop + el.clientHeight * 0.4 - 16) / ph)));
    setPage(p);
  }, [total, pageW, pages]);

  const goTo = useCallback(
    (p: number) => {
      p = Math.min(total - 1, Math.max(0, p));
      setPage(p);
      if (scrollMode) {
        const el = scrollRef.current;
        if (!el) return;
        const ratio = pageW / pages[0].w;
        el.scrollTop = p * (pages[0].h * ratio + gapPx) + 16;
      }
    },
    [total, scrollMode, pageW, pages],
  );


  const [endToast, setEndToast] = useState<string | null>(null);
  useEffect(() => {
    if (!endToast) return;
    const id = window.setTimeout(() => setEndToast(null), 2600);
    return () => window.clearTimeout(id);
  }, [endToast]);
  const end = useEndAdvance(onNextFile, nextName, setEndToast);
  const next = useCallback(() => {
    const el = scrollRef.current;
    if (scrollMode && el) {
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) end.onEnd();
      else el.scrollBy({ top: el.clientHeight * 0.9 });
    } else if (page >= total - 1) end.onEnd();
    else goTo(page + 1);
  }, [scrollMode, goTo, page, total, end]);
  const prev = useCallback(() => {
    if (scrollMode) scrollRef.current?.scrollBy({ top: -scrollRef.current.clientHeight * 0.9 });
    else goTo(page - 1);
  }, [scrollMode, goTo, page]);

  useSwipe(hostRef, next, prev, !scrollMode);

  useEffect(() => {
    if (scrollMode) return;
    const el = hostRef.current;
    if (!el) return;
    let lock = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const now = performance.now();
      if (now - lock < 160) return;
      lock = now;
      if (e.deltaY > 0) next();
      else prev();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scrollMode, next, prev]);

  const isBookmarked = bookmarks.some((b) => b.page === page);
  const toggleBookmark = useCallback(() => {
    const existing = bookmarks.find((b) => b.page === page);
    if (existing) removeBookmark(entry.id, existing.id);
    else addBookmark(entry.id, { pct, page, label: `${page + 1} 페이지` });
  }, [bookmarks, page, pct, entry.id, addBookmark, removeBookmark]);

  useReaderKeys({
    enabled: !!pdf,
    next,
    prev,
    home: () => goTo(0),
    end: () => goTo(total - 1),
    back: () => (panel ? setPanel(null) : onBack()),
    toggleMode: () => useSettings.getState().set({ readMode: scrollMode ? "page" : "scroll" }),
    toggleToc: () => setPanel((p) => (p === "toc" ? null : "toc")),
    toggleBookmark,
    prevFile: onPrevFile,
    nextFile: onNextFile,
    toggleUi: ui.toggle,
    hideUi: ui.hide,
  });

  const singleW = pages[0] ? Math.min(size.w - 32, ((size.h - 32) * pages[0].w) / pages[0].h) : 0;

  return (
    <div className={`reader ${ui.cursorHidden ? "hide-cursor" : ""}`} ref={hostRef} onPointerMove={ui.onPointerMove}>
      {pdf && scrollMode && (
        <div
          className="pdf-scroll"
          ref={scrollRef}
          onScroll={onScroll}
          onClick={(e) => {
            if (ui.consumeTap()) return;
            const x = e.clientX / size.w;
            if (x > 0.3 && x < 0.7) ui.toggle();
          }}
        >
          {pages.map((_, i) => (
            <PdfPage key={i} pdf={pdf} index={i} width={pageW} dark={dark} />
          ))}
        </div>
      )}
      {pdf && !scrollMode && (
        <div
          className="pdf-single"
          onClick={(e) => {
            if (ui.consumeTap()) return;
            const x = e.clientX / size.w;
            if (x < 0.3) prev();
            else if (x > 0.7) next();
            else ui.toggle();
          }}
        >
          <PdfPage key={page} pdf={pdf} index={page} width={singleW} dark={dark} />
        </div>
      )}
      {!pdf && !error && (
        <div className="loading-overlay">
          <div className="spinner" />
          <span>불러오는 중…</span>
        </div>
      )}
      {error && (
        <div className="loading-overlay">
          <div className="error-box">
            <div style={{ fontWeight: 600, marginBottom: 8 }}>PDF를 열 수 없습니다</div>
            <div className="muted" style={{ fontSize: 13 }}>
              {error}
            </div>
            <button className="btn" style={{ marginTop: 14 }} onClick={onBack}>
              서재로
            </button>
          </div>
        </div>
      )}
      <ReaderChrome
        entry={entry}
        title={stripExt(entry.name)}
        subtitle={subtitle}
        pct={pct}
        posLabel={total ? `${page + 1} / ${total} 쪽` : ""}
        visible={ui.visible}
        onSeek={(p) => goTo(Math.round(p * (total - 1)))}
        onBack={onBack}
        onPrevFile={onPrevFile}
        onNextFile={onNextFile}
        toc={toc}
        onGoToc={(t: TocItem) => t.page != null && goTo(t.page)}
        bookmarks={bookmarks}
        isBookmarked={isBookmarked}
        onToggleBookmark={toggleBookmark}
        onGoBookmark={(b: Bookmark) => goTo(b.page ?? 0)}
        onRemoveBookmark={(id) => removeBookmark(entry.id, id)}
        panel={panel}
        setPanel={setPanel}
        showModeToggle
        settingsScope="pdf"
      />
      {endToast && (
        <div className="toast">
          <span>{endToast}</span>
        </div>
      )}
    </div>
  );
}
