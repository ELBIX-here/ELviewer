import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Entry } from "./types";
import { useSettings, themeColors , dirName } from "./store/settings";
import { useProgress } from "./store/progress";
import { useLibrary } from "./store/library";
import { LibraryView } from "./components/library/LibraryView";
import { StatsView } from "./components/stats/StatsView";
import { useStats } from "./store/stats";
import { useNotes } from "./store/notes";
import { TextReader } from "./components/reader/TextReader";
import { EbookReader } from "./components/reader/EbookReader";
import { PdfReader } from "./components/reader/PdfReader";
import { ImageReader } from "./components/reader/ImageReader";
import { siblings, baseName, stripExt } from "./lib/sort";
import { kindForExt } from "./lib/formats";
import { isMobile } from "./lib/platform";
import { onBackButtonPress } from "@tauri-apps/api/app";
import { useCloud, applyPlace, progressId, resumeChoices } from "./store/cloud";
import { ResumeSheet, DeviceIcon, type ResumeChoice } from "./components/library/ResumeSheet";
import type { DevicePos } from "./lib/sync";
import type { Progress } from "./types";
import { formatAgo, formatPct } from "./lib/text";
import { TitleBar } from "./components/TitleBar";
import { Splash } from "./components/Splash";

/** Relative luminance below the midpoint: light text / system icons belong on it. */
function isDarkColor(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return true;
  const n = parseInt(m[1], 16);
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const l = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return l < 0.18;
}

export default function App() {
  const [current, setCurrent] = useState<Entry | null>(null);
  const [splash, setSplash] = useState(true);
  const settingsReady = useSettings((s) => s.hydrated);
  const progressReady = useProgress((s) => s.hydrated);
  const ready = settingsReady && progressReady;
  const endSplash = useCallback(() => setSplash(false), []);

  // Desktop: the interface (not the reading text) scales with the window, so a small
  // window doesn't feel cramped and a large one doesn't look sparse. 1200×780 = 100%,
  // never below 90% so labels stay legible.
  useEffect(() => {
    if (isMobile()) return;
    const apply = () => {
      const s = Math.min(window.innerWidth / 1200, window.innerHeight / 780);
      const v = Math.round(Math.min(1.2, Math.max(0.9, s)) * 20) / 20;
      document.documentElement.style.setProperty("--ui-scale", String(v));
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, []);
  return (
    <div className="app-shell">
      {!isMobile() && <TitleBar title={current ? stripExt(current.name) : undefined} />}
      <div className="app-body">
        <Main current={current} setCurrent={setCurrent} />
        {splash && <Splash ready={ready} onDone={endSplash} />}
      </div>
    </div>
  );
}

function Main({ current, setCurrent }: { current: Entry | null; setCurrent: (e: Entry | null) => void }) {
  const settings = useSettings((s) => s.settings);
  const hydratedS = useSettings((s) => s.hydrated);
  const hydrateS = useSettings((s) => s.hydrate);
  const hydratedP = useProgress((s) => s.hydrated);
  const hydrateP = useProgress((s) => s.hydrate);
  const addRoot = useSettings((s) => s.addRoot);
  const { entries, scan, markChanged } = useLibrary();
  const [view, setView] = useState<"library" | "stats">("library");
  const hydrateStats = useStats((s) => s.hydrate);

  useEffect(() => {
    void hydrateS();
    void hydrateP();
    void hydrateStats();
    void useNotes.getState().hydrate();
    void useCloud.getState().hydrate();
  }, [hydrateS, hydrateP, hydrateStats]);

  // Theme → CSS variables.
  useEffect(() => {
    const { bg, fg } = themeColors(settings);
    const root = document.documentElement;
    root.style.setProperty("--bg", bg);
    root.style.setProperty("--fg", fg);
    root.dataset.theme = settings.theme;
    // Android: system bar icons and the window behind the page follow the theme.
    (window as unknown as { ElBars?: { setTheme(bg: string, dark: boolean): void } }).ElBars?.setTheme(bg, isDarkColor(bg));
    // Remembered for the next launch so the first frame already has the right colors.
    try {
      localStorage.setItem("el-theme", JSON.stringify({ bg, fg, theme: settings.theme }));
    } catch {
      /* storage unavailable */
    }
  }, [settings.theme, settings.customBg, settings.customFg]);

  // Scan library when roots change.
  const rootsKey = settings.roots.join("\n");
  useEffect(() => {
    if (!hydratedS) return;
    void scan(settings.roots);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey, hydratedS]);

  // Mobile: no folder watching (SAF folders can't be watched) – rescan when the app comes back.
  useEffect(() => {
    if (!isMobile()) return;
    const onVis = () => {
      if (document.visibilityState === "visible") void scan(useSettings.getState().settings.roots);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [scan]);

  // Android back button: close the reader / stats / go up a folder. At the library
  // root the listener is removed so the system default (leave the app) applies.
  const cwd = useLibrary((s) => s.cwd);
  const atLibraryRoot = !current && view === "library" && (!cwd || settings.roots.includes(cwd));
  useEffect(() => {
    if (!isMobile() || atLibraryRoot) return;
    const listener = onBackButtonPress(() => {
      // The library's drawer / Drive picker handle their own back press.
      if (document.querySelector(".library.drawer-open, .drive-picker, .rs-back")) return;
      if (current || view === "stats") {
        // Readers and the stats page already treat Escape as "close panel, else go back".
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        return;
      }
      const c = useLibrary.getState().cwd;
      if (c) useLibrary.getState().setCwd(c.slice(0, Math.max(0, c.lastIndexOf("\\"))) || null);
    });
    return () => {
      void listener.then((l) => l.unregister());
    };
  }, [atLibraryRoot, current, view]);

  // Folder watcher → debounced rescan.
  useEffect(() => {
    let timer: number | undefined;
    const un = listen<string[]>("library-changed", (e) => {
      markChanged(e.payload);
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => void scan(useSettings.getState().settings.roots), 1200);
    });
    return () => {
      void un.then((f) => f());
      if (timer) window.clearTimeout(timer);
    };
  }, [scan, markChanged]);

  // Drag & drop: folders become roots, files open directly.
  useEffect(() => {
    if (isMobile()) return;
    const un = getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type !== "drop") return;
      for (const p of e.payload.paths) {
        const ext = (p.split(".").pop() ?? "").toLowerCase();
        const kind = kindForExt(ext);
        if (kind && !/\.(zip|7z)$/i.test(p)) {
          setCurrent({ id: p, name: baseName(p), dir: p.slice(0, Math.max(0, p.lastIndexOf("\\"))), root: "", ext, kind, size: 0, mtime: Date.now(), inArchive: false });
          return;
        }
        addRoot(p);
      }
    });
    return () => {
      void un.then((f) => f());
    };
  }, [addRoot]);

  // ---- Google Drive sync -------------------------------------------------------
  // Runs after library scans (so books can be matched), when the app is hidden or
  // shown again, when a book is closed, every few minutes, and before the window closes.
  const openId = current ? (current.kind === "image" ? current.dir : current.id) : null;
  const openIdRef = useRef(openId);
  openIdRef.current = openId;
  const lastSyncAt = useRef(0);
  const syncNow = useCallback((minGapMs = 0) => {
    if (!useCloud.getState().connected || Date.now() - lastSyncAt.current < minGapMs) return Promise.resolve();
    lastSyncAt.current = Date.now();
    return useCloud.getState().sync(openIdRef.current);
  }, []);
  const cloudConnected = useCloud((s) => s.connected);
  const lastScan = useLibrary((s) => s.lastScan);
  useEffect(() => {
    if (cloudConnected && lastScan) void syncNow(15_000);
  }, [cloudConnected, lastScan, syncNow]);
  useEffect(() => {
    const onVis = () => void syncNow(document.visibilityState === "hidden" ? 0 : 10_000);
    document.addEventListener("visibilitychange", onVis);
    // Desktop: coming back to the window from another app (no visibility change there).
    const onFocus = () => void syncNow(10_000);
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void syncNow(60_000);
    }, 5 * 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [syncNow]);
  const prevOpen = useRef<string | null>(null);
  useEffect(() => {
    // Leaving a book (closing it or moving to the next file) pushes its position.
    if (prevOpen.current && prevOpen.current !== openId) {
      useCloud.getState().dismissOffer();
      void syncNow(0);
    }
    prevOpen.current = openId;
  }, [openId, syncNow]);
  useEffect(() => {
    if (isMobile()) return;
    const un = getCurrentWindow().onCloseRequested(async () => {
      if (!useCloud.getState().connected) return;
      await Promise.race([syncNow(0), new Promise((r) => window.setTimeout(r, 4000))]);
    });
    return () => {
      void un.then((f) => f());
    };
  }, [syncNow]);
  const offer = useCloud((s) => s.offer);
  /** bumped to reopen the reader at a position taken over from another device */
  const [readerNonce, setReaderNonce] = useState(0);

  // ---- opening a book: offer places read on other devices --------------------
  const [resume, setResume] = useState<{ entry: Entry; here: Progress | undefined; others: DevicePos[] } | null>(null);
  /** Open `e`; `place` = a place picked from the other-devices list (no question then). */
  const requestOpen = useCallback((e: Entry, place?: DevicePos) => {
    const pid = progressId(e);
    if (place) applyPlace(pid, place);
    else {
      const { here, others } = resumeChoices(e);
      if (others.length) {
        if (useSettings.getState().settings.syncOpen !== "latest") {
          setResume({ entry: e, here, others });
          return;
        }
        applyPlace(pid, others[0]);
      }
    }
    setCurrent(e);
    setReaderNonce((n) => n + 1);
  }, []);
  const pickResume = useCallback(
    (c: ResumeChoice) => {
      if (!resume) return;
      const pid = progressId(resume.entry);
      if (c.kind === "other") applyPlace(pid, c.pos);
      else if (c.kind === "start") applyPlace(pid, "start");
      setResume(null);
      setCurrent(resume.entry);
      setReaderNonce((n) => n + 1);
    },
    [resume],
  );
  const resumeSheet = resume && (
    <ResumeSheet
      title={resume.entry.kind === "image" ? dirName(resume.entry.dir) : stripExt(resume.entry.name)}
      here={resume.here}
      others={resume.others}
      onPick={pickResume}
      onCancel={() => setResume(null)}
    />
  );

  // Window title.
  useEffect(() => {
    if (isMobile()) return;
    void getCurrentWindow().setTitle(current ? `${stripExt(current.name)} - ELviewer` : "ELviewer");
  }, [current]);

  // Image folders are one "book", so they have no prev/next file.
  const sibs = useMemo(() => (current && current.kind !== "image" ? siblings(entries, current) : []), [entries, current]);
  const idx = current ? sibs.findIndex((e) => e.id === current.id) : -1;
  const prevEntry = idx > 0 ? sibs[idx - 1] : undefined;
  const nextEntry = idx >= 0 && idx < sibs.length - 1 ? sibs[idx + 1] : undefined;
  const onBack = useCallback(() => setCurrent(null), []);
  const subtitle = current ? `${dirName(current.dir)}${sibs.length > 1 && idx >= 0 ? ` · ${idx + 1}/${sibs.length}` : ""}` : undefined;

  // The launch screen covers this until the stores are loaded.
  if (!hydratedS || !hydratedP) return null;

  if (!current) {
    return (
      <>
        {view === "stats" ? (
          <StatsView onBack={() => setView("library")} onOpen={(e) => requestOpen(e)} />
        ) : (
          <LibraryView onOpen={requestOpen} onStats={() => setView("stats")} />
        )}
        {resumeSheet}
      </>
    );
  }

  const props = {
    entry: current,
    onBack,
    onPrevFile: prevEntry ? () => requestOpen(prevEntry) : undefined,
    onNextFile: nextEntry ? () => requestOpen(nextEntry) : undefined,
    subtitle,
    nextName: nextEntry?.name,
  };

  const k = `${openId}#${readerNonce}`;
  const reader =
    current.kind === "ebook" ? (
      <EbookReader key={k} {...props} />
    ) : current.kind === "pdf" ? (
      <PdfReader key={k} {...props} />
    ) : current.kind === "image" ? (
      <ImageReader key={k} {...props} />
    ) : (
      <TextReader key={k} {...props} />
    );
  return (
    <>
      {reader}
      {offer && offer.id === openId && !resume && (
        <div className="sync-offer" role="status">
          <span className="dev-ico">
            <DeviceIcon kind={offer.pos.kind} />
          </span>
          <span className="txt">
            <span>{offer.pos.name}에서 더 읽었어요</span>
            <small>
              <b>{formatPct(offer.pos.pct)}</b> · {formatAgo(offer.pos.updatedAt)}
            </small>
          </span>
          <button
            className="btn primary"
            onClick={() => {
              useCloud.getState().acceptOffer();
              setReaderNonce((n) => n + 1);
            }}
          >
            이어 읽기
          </button>
          <button className="btn ghost" onClick={() => useCloud.getState().dismissOffer()}>
            닫기
          </button>
        </div>
      )}
      {resumeSheet}
    </>
  );
}
