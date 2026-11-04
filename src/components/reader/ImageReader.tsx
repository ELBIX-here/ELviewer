import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { isDriveId } from "../../lib/gdrive";
import type { Bookmark, Entry } from "../../types";
import { useSettings, dirName } from "../../store/settings";
import { useProgress, NO_BOOKMARKS } from "../../store/progress";
import { useLibrary } from "../../store/library";
import { ReaderChrome, type PanelName } from "./ReaderChrome";
import { useAutoHide } from "./useAutoHide";
import { useReadingTracker } from "./useReadingTracker";
import { useReaderKeys } from "./useReaderKeys";
import { useEndAdvance } from "./useEndAdvance";
import { useSwipe } from "./useSwipe";
import { sortEntries } from "../../lib/sort";
import type { ReaderProps } from "./TextReader";
import { storage } from "../../lib/platform";
import { readBinary } from "../../lib/tauri";

/**
 * A folder of images is treated as one "book" (webtoon / scanned comic).
 * The entry passed in is any image of the folder; the folder path is the id
 * used for progress so that all images share one position.
 */
export function ImageReader({ entry, onBack, onPrevFile, onNextFile, nextName, subtitle }: ReaderProps) {
  const { settings } = useSettings();
  const entries = useLibrary((st) => st.entries);
  const images = useMemo(() => sortEntries(entries.filter((e) => e.dir === entry.dir && e.kind === "image")), [entries, entry.dir]);
  const bookId = entry.dir;
  const progress = useProgress((st) => st.progress[bookId]);
  const bookmarks = useProgress((st) => st.bookmarks[bookId] ?? NO_BOOKMARKS);
  const { update, addBookmark, removeBookmark } = useProgress();

  const startIndex = Math.max(0, images.findIndex((i) => i.id === entry.id));
  const [page, setPage] = useState(progress?.page ?? startIndex);
  const [panel, setPanel] = useState<PanelName | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const ui = useAutoHide(settings.uiAutoHideSec * 1000, panel !== null);
  const scrollMode = settings.readMode === "scroll";
  const total = images.length;
  const pct = total ? (page + 1) / total : 0;
  useReadingTracker({ bookId, title: dirName(entry.dir), kind: "comic", pct });

  useEffect(() => {
    if (!total) return;
    update(bookId, { page, pct, mtime: entry.mtime });
  }, [page, pct, total, bookId, entry.mtime, update]);

  // Scroll mode: restore + track.
  const restored = useRef(false);
  useEffect(() => {
    if (!scrollMode || restored.current) return;
    restored.current = true;
    requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-i="${page}"]`);
      el?.scrollIntoView({ block: "start" });
    });
  }, [scrollMode, page]);
  useEffect(() => {
    restored.current = false;
  }, [scrollMode]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const mid = el.scrollTop + el.clientHeight * 0.4;
    const kids = Array.from(el.children) as HTMLElement[];
    let idx = 0;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].offsetTop <= mid) idx = i;
      else break;
    }
    setPage(idx);
  }, []);

  const goTo = useCallback(
    (p: number) => {
      p = Math.min(total - 1, Math.max(0, p));
      setPage(p);
      if (scrollMode) scrollRef.current?.querySelector<HTMLElement>(`[data-i="${p}"]`)?.scrollIntoView({ block: "start" });
    },
    [total, scrollMode],
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
  const prev = useCallback(() => (scrollMode ? scrollRef.current?.scrollBy({ top: -scrollRef.current.clientHeight * 0.9 }) : goTo(page - 1)), [scrollMode, goTo, page]);

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
    if (existing) removeBookmark(bookId, existing.id);
    else addBookmark(bookId, { pct, page, label: images[page]?.name ?? `${page + 1}` });
  }, [bookmarks, page, pct, bookId, images, addBookmark, removeBookmark]);

  useReaderKeys({
    enabled: total > 0,
    next,
    prev,
    home: () => goTo(0),
    end: () => goTo(total - 1),
    back: () => (panel ? setPanel(null) : onBack()),
    toggleMode: () => useSettings.getState().set({ readMode: scrollMode ? "page" : "scroll" }),
    toggleBookmark,
    prevFile: onPrevFile,
    nextFile: onNextFile,
    toggleUi: ui.toggle,
    hideUi: ui.hide,
  });

  const src = (e: Entry) => convertFileSrc(e.id);
  // Drive images and Android URIs aren't paths the webview can load: read them as blobs.
  const Img = storage.directPaths && !isDriveId(entry.id) ? null : UriImage;

  return (
    <div className={`reader ${ui.cursorHidden ? "hide-cursor" : ""}`} ref={hostRef} onPointerMove={ui.onPointerMove}>
      {scrollMode ? (
        <div
          className="img-scroll"
          ref={scrollRef}
          onScroll={onScroll}
          onClick={(e) => {
            if (ui.consumeTap()) return;
            const x = e.clientX / window.innerWidth;
            if (x > 0.3 && x < 0.7) ui.toggle();
          }}
        >
          {images.map((img, i) => (
            Img ? (
              <Img key={img.id} entry={img} index={i} style={{ maxWidth: settings.maxWidth }} />
            ) : (
              <img key={img.id} data-i={i} src={src(img)} loading="lazy" style={{ maxWidth: settings.maxWidth }} alt={img.name} />
            )
          ))}
        </div>
      ) : (
        <div
          className="img-single"
          onClick={(e) => {
            if (ui.consumeTap()) return;
            const x = e.clientX / window.innerWidth;
            if (x < 0.3) prev();
            else if (x > 0.7) next();
            else ui.toggle();
          }}
        >
          {images[page] && (Img ? <Img key={images[page].id} entry={images[page]} eager /> : <img src={src(images[page])} alt={images[page].name} />)}
        </div>
      )}
      <ReaderChrome
        entry={entry}
        title={dirName(entry.dir)}
        subtitle={subtitle ?? images[page]?.name}
        pct={pct}
        posLabel={`${page + 1} / ${total} 장`}
        visible={ui.visible}
        onSeek={(p) => goTo(Math.round(p * (total - 1)))}
        onBack={onBack}
        onPrevFile={onPrevFile}
        onNextFile={onNextFile}
        toc={[]}
        onGoToc={() => {}}
        bookmarks={bookmarks}
        isBookmarked={isBookmarked}
        onToggleBookmark={toggleBookmark}
        onGoBookmark={(b: Bookmark) => goTo(b.page ?? 0)}
        onRemoveBookmark={(id) => removeBookmark(bookId, id)}
        panel={panel}
        setPanel={setPanel}
        showModeToggle
        settingsScope="image"
      />
      {endToast && (
        <div className="toast">
          <span>{endToast}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Image backed by an Android document URI: the bytes are read through the backend
 * when the image nears the viewport and shown via a blob URL (freed on unmount).
 */
function UriImage({ entry, index, style, eager }: { entry: Entry; index?: number; style?: React.CSSProperties; eager?: boolean }) {
  const ref = useRef<HTMLImageElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [near, setNear] = useState(!!eager);
  useEffect(() => {
    if (near || !ref.current) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), { rootMargin: "1500px 0px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [near]);
  useEffect(() => {
    if (!near) return;
    let u: string | null = null;
    let cancelled = false;
    readBinary(entry.id)
      .then((bytes) => {
        if (cancelled) return;
        u = URL.createObjectURL(new Blob([bytes as BlobPart]));
        setUrl(u);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (u) URL.revokeObjectURL(u);
    };
  }, [near, entry.id]);
  return <img ref={ref} data-i={index} src={url ?? undefined} alt={entry.name} style={{ minHeight: url ? undefined : 400, ...style }} />;
}
