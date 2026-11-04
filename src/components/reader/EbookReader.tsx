import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Bookmark, SearchHit, TocItem } from "../../types";
import type { FoliateLocation, FoliateTocItem, FoliateView } from "foliate-js/view.js";
import { readBinary } from "../../lib/tauri";
import { useSettings, themeColors } from "../../store/settings";
import { useProgress, NO_BOOKMARKS } from "../../store/progress";
import { ReaderChrome, type PanelName } from "./ReaderChrome";
import { useAutoHide } from "./useAutoHide";
import { useReadingTracker } from "./useReadingTracker";
import { useReaderKeys } from "./useReaderKeys";
import { useEndAdvance } from "./useEndAdvance";
import { attachSwipe } from "./useSwipe";
import { effectiveColumns } from "../../lib/layout";
import { stripExt } from "../../lib/sort";
import { formatPct } from "../../lib/text";
import type { ReaderProps } from "./TextReader";
import elSansRegular from "../../assets/fonts/ELSans-Regular.woff2?url";
import elSansBold from "../../assets/fonts/ELSans-Bold.woff2?url";

// Book sections render in their own iframes, so the app's @font-face rules don't reach them.
const abs = (u: string) => new URL(u, window.location.href).href;
const FONT_FACES = `
  @font-face { font-family: "EL Sans"; src: url("${abs(elSansRegular)}") format("woff2"); font-weight: 100 549; }
  @font-face { font-family: "EL Sans"; src: url("${abs(elSansBold)}") format("woff2"); font-weight: 550 900; }
`;

function flattenToc(items: FoliateTocItem[] | undefined, level = 0, out: TocItem[] = []): TocItem[] {
  for (const it of items ?? []) {
    out.push({ label: it.label?.trim() || "(제목 없음)", href: it.href, level });
    if (it.subitems?.length) flattenToc(it.subitems, level + 1, out);
  }
  return out;
}

export function EbookReader({ entry, onBack, onPrevFile, onNextFile, nextName, subtitle }: ReaderProps) {
  const { settings, set } = useSettings();
  const progress = useProgress((st) => st.progress[entry.id]);
  const bookmarks = useProgress((st) => st.bookmarks[entry.id] ?? NO_BOOKMARKS);
  const { update, addBookmark, removeBookmark } = useProgress();

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelName | null>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [loc, setLoc] = useState<FoliateLocation | null>(null);
  const [title, setTitle] = useState(stripExt(entry.name));
  const [toast, setToast] = useState<string | null>(null);
  const ui = useAutoHide(settings.uiAutoHideSec * 1000, panel !== null);
  const isComic = entry.ext === "cbz";
  // Handlers installed inside the book's iframes live for the whole session; read the latest values via refs.
  const uiRef = useRef(ui);
  uiRef.current = ui;
  const goNextRef = useRef<() => void>(() => {});
  const modeRef = useRef(settings.readMode);
  modeRef.current = settings.readMode;

  const [hostSize, setHostSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHostSize((p) => (p.w === el.clientWidth && p.h === el.clientHeight ? p : { w: el.clientWidth, h: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const columns = effectiveColumns(settings.columns, hostSize.w, hostSize.h);

  const colors = themeColors(settings);
  const css = useMemo(
    () => `
    @namespace epub "http://www.idpf.org/2007/ops";
    ${FONT_FACES}
    html { color-scheme: ${settings.theme === "light" || settings.theme === "sepia" ? "light" : "dark"}; }
    html, body { background: ${colors.bg} !important; color: ${colors.fg} !important; }
    body { font-family: ${settings.fontFamily} !important; font-size: ${settings.fontSize}px !important; letter-spacing: ${settings.letterSpacing}px; }
    p, li, blockquote, dd, div { line-height: ${settings.lineHeight} !important; text-align: ${settings.textAlign === "justify" ? "justify" : "start"}; }
    p { margin-top: 0; margin-bottom: ${settings.paragraphSpacing}em !important; }
    a:link { color: ${settings.theme === "light" || settings.theme === "sepia" ? "#9a5b12" : "#e8a23c"}; }
    img, svg { max-width: 100% !important; height: auto !important; }
    pre { white-space: pre-wrap !important; }
    aside[epub|type~="footnote"], aside[epub|type~="endnote"] { display: none; }
  `,
    [settings.fontFamily, settings.fontSize, settings.lineHeight, settings.letterSpacing, settings.paragraphSpacing, settings.textAlign, settings.theme, colors.bg, colors.fg],
  );

  const applyLayout = useCallback(
    (view: FoliateView) => {
      const r = view.renderer;
      if (!r) return;
      r.setAttribute("flow", settings.readMode === "scroll" ? "scrolled" : "paginated");
      r.setAttribute("gap", "6%");
      r.setAttribute("margin", "56px");
      // foliate only splits into two columns when each fits within max-inline-size.
      const maxInline = columns === 2 && hostSize.w ? Math.min(settings.maxWidth, Math.floor(hostSize.w / 2)) : settings.maxWidth;
      r.setAttribute("max-inline-size", `${maxInline}px`);
      r.setAttribute("max-column-count", String(columns));
      r.setStyles?.(css);
    },
    [settings.readMode, settings.maxWidth, columns, hostSize.w, css],
  );

  // Open book.
  useEffect(() => {
    let cancelled = false;
    let view: FoliateView | null = null;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        await import("foliate-js/view.js");
        const bytes = await readBinary(entry.id);
        if (cancelled) return;
        const file = new File([bytes as BlobPart], entry.name);
        view = document.createElement("foliate-view") as FoliateView;
        hostRef.current!.replaceChildren(view);
        view.addEventListener("relocate", ((e: CustomEvent<FoliateLocation>) => {
          setLoc(e.detail);
          update(entry.id, { pct: e.detail.fraction ?? 0, loc: e.detail.cfi, mtime: entry.mtime });
        }) as EventListener);
        view.addEventListener("load", ((e: CustomEvent<{ doc: Document }>) => {
          // Forward keyboard events from inside the iframe.
          e.detail.doc.addEventListener("keydown", (ke) => {
            const clone = new KeyboardEvent("keydown", ke);
            window.dispatchEvent(clone);
          });
          e.detail.doc.addEventListener("pointermove", (pe) => uiRef.current.onPointerMove(pe));
          e.detail.doc.addEventListener("wheel", () => window.dispatchEvent(new Event("reader-activity")), { passive: true });
          e.detail.doc.addEventListener("click", (ce) => {
            const w = e.detail.doc.defaultView;
            if (!w) return;
            if (w.getSelection()?.toString()) return;
            if (uiRef.current.consumeTap()) return;
            const x = ce.clientX / w.innerWidth;
            if (modeRef.current === "page") {
              if (x < 0.25) void view?.prev();
              else if (x > 0.75) goNextRef.current();
              else uiRef.current.toggle();
            } else if (x > 0.3 && x < 0.7) uiRef.current.toggle();
          });
          // The reflowable paginator turns pages on swipe by itself; fixed layouts (comics) don't.
          if (view?.book?.rendition?.layout === "pre-paginated") {
            // Otherwise the browser claims the horizontal drag as a pan and cancels the pointer.
            e.detail.doc.documentElement.style.touchAction = "pan-y pinch-zoom";
            attachSwipe(
              e.detail.doc,
              () => goNextRef.current(),
              () => void view?.prev(),
            );
          }
        }) as EventListener);
        await view.open(file);
        if (cancelled) return;
        viewRef.current = view;
        applyLayout(view);
        const t = view.book.metadata?.title;
        if (t) setTitle(typeof t === "string" ? t : Object.values(t)[0] ?? title);
        setToc(flattenToc(view.book.toc));
        const last = progress?.loc;
        await view.init({ lastLocation: last, showTextStart: !last });
        if (!last && progress?.pct) await view.goToFraction(progress.pct);
      } catch (e) {
        console.error(e);
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      try {
        view?.close();
        view?.remove();
      } catch {
        /* ignore */
      }
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id]);

  useEffect(() => {
    if (viewRef.current) applyLayout(viewRef.current);
  }, [applyLayout]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(id);
  }, [toast]);

  const pct = loc?.fraction ?? progress?.pct ?? 0;
  const end = useEndAdvance(onNextFile, nextName, setToast);
  const pctRef = useRef(pct);
  pctRef.current = pct;
  /** At the last location the paginator's next() is a no-op – offer the next file instead. */
  const goNext = useCallback(() => {
    if (pctRef.current >= 0.999) end.onEnd();
    else void viewRef.current?.next();
  }, [end]);
  goNextRef.current = goNext;
  useReadingTracker({ bookId: entry.id, title, kind: entry.ext === "cbz" ? "comic" : "ebook", pct });
  const currentCfi = loc?.cfi;
  const isBookmarked = !!currentCfi && bookmarks.some((b) => b.loc === currentCfi);
  const toggleBookmark = useCallback(() => {
    if (!currentCfi) return;
    const existing = bookmarks.find((b) => b.loc === currentCfi);
    if (existing) {
      removeBookmark(entry.id, existing.id);
      setToast("책갈피를 제거했습니다");
    } else {
      const label = loc?.tocItem?.label ? `${loc.tocItem.label} · ${formatPct(pct)}` : `${formatPct(pct)} 지점`;
      addBookmark(entry.id, { pct, loc: currentCfi, label });
      setToast("책갈피를 추가했습니다");
    }
  }, [currentCfi, bookmarks, entry.id, loc, pct, addBookmark, removeBookmark]);

  const onSearch = useCallback(async (q: string): Promise<SearchHit[]> => {
    const view = viewRef.current;
    if (!view) return [];
    const hits: SearchHit[] = [];
    for await (const r of view.search({ query: q })) {
      if (r === "done") break;
      if (typeof r === "object" && "cfi" in r) {
        hits.push({ para: hits.length, offset: 0, loc: r.cfi, snippet: `${r.excerpt.pre}${r.excerpt.match}${r.excerpt.post}` });
        if (hits.length >= 500) break;
      }
    }
    return hits;
  }, []);

  const currentTocIndex = useMemo(() => {
    const href = loc?.tocItem?.href;
    if (!href) return undefined;
    const i = toc.findIndex((t) => t.href === href);
    return i >= 0 ? i : undefined;
  }, [loc, toc]);

  useReaderKeys({
    enabled: !loading,
    next: goNext,
    prev: () => void viewRef.current?.prev(),
    home: () => void viewRef.current?.goToFraction(0),
    end: () => void viewRef.current?.goToFraction(1),
    back: () => (panel ? setPanel(null) : onBack()),
    toggleMode: () => set({ readMode: settings.readMode === "scroll" ? "page" : "scroll" }),
    toggleToc: () => setPanel((p) => (p === "toc" ? null : "toc")),
    toggleSearch: () => setPanel((p) => (p === "search" ? null : "search")),
    toggleBookmark,
    fontDelta: (d) => set({ fontSize: Math.min(48, Math.max(10, settings.fontSize + d)) }),
    prevFile: onPrevFile,
    nextFile: onNextFile,
    toggleUi: ui.toggle,
    hideUi: ui.hide,
  });

  const posLabel = loc?.location ? `${loc.location.current.toLocaleString()} / ${loc.location.total.toLocaleString()}` : loc?.tocItem?.label ?? "";

  return (
    <div className={`reader ${ui.cursorHidden ? "hide-cursor" : ""}`} onPointerMove={ui.onPointerMove}>
      <div className="ebook-host" ref={hostRef} />
      {loading && (
        <div className="loading-overlay">
          <div className="spinner" />
          <span>불러오는 중…</span>
        </div>
      )}
      {error && (
        <div className="loading-overlay">
          <div className="error-box">
            <div style={{ fontWeight: 600, marginBottom: 8 }}>책을 열 수 없습니다</div>
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
        title={title}
        subtitle={subtitle}
        pct={pct}
        posLabel={posLabel}
        visible={ui.visible}
        onSeek={(p) => void viewRef.current?.goToFraction(p)}
        onBack={onBack}
        onPrevFile={onPrevFile}
        onNextFile={onNextFile}
        toc={toc}
        currentTocIndex={currentTocIndex}
        onGoToc={(t: TocItem) => t.href && void viewRef.current?.goTo(t.href)}
        bookmarks={bookmarks}
        isBookmarked={isBookmarked}
        onToggleBookmark={toggleBookmark}
        onGoBookmark={(b: Bookmark) => (b.loc ? void viewRef.current?.goTo(b.loc) : void viewRef.current?.goToFraction(b.pct))}
        onRemoveBookmark={(id) => removeBookmark(entry.id, id)}
        onSearch={isComic ? undefined : onSearch}
        onGoHit={(h) => h.loc && void viewRef.current?.goTo(h.loc)}
        panel={panel}
        setPanel={setPanel}
        showModeToggle
        settingsScope="ebook"
      />
      {toast && (
        <div className="toast">
          <span>{toast}</span>
        </div>
      )}
    </div>
  );
}
