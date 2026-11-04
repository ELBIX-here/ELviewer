import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Bookmark, Entry, SearchHit, TocItem } from "../../types";
import { formatPct } from "../../lib/text";
import { useSettings } from "../../store/settings";
import {
  IconBack,
  IconBookmark,
  IconBookmarkFilled,
  IconFullscreen,
  IconList,
  IconNext,
  IconPages,
  IconPause,
  IconPlay,
  IconPrev,
  IconScroll,
  IconSearch,
  IconSettings,
  IconHeadphones,
  IconNote,
  IconUndo,
} from "../Icons";
import { SettingsPanel } from "./SettingsPanel";
import { TocPanel, BookmarksPanel, SearchPanel } from "./Panels";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isMobile } from "../../lib/platform";

export type PanelName = "toc" | "search" | "bookmarks" | "settings" | "tts" | "notes";

export interface ChromeProps {
  entry: Entry;
  title: string;
  subtitle?: string;
  pct: number;
  posLabel: string;
  visible: boolean;
  onSeek: (pct: number) => void;
  onBack: () => void;
  onPrevFile?: () => void;
  onNextFile?: () => void;
  toc: TocItem[];
  currentTocIndex?: number;
  onGoToc: (item: TocItem) => void;
  bookmarks: Bookmark[];
  isBookmarked: boolean;
  onToggleBookmark: () => void;
  onGoBookmark: (b: Bookmark) => void;
  onRemoveBookmark: (id: string) => void;
  onSearch?: (q: string) => Promise<SearchHit[]> | SearchHit[];
  onGoHit?: (hit: SearchHit) => void;
  panel: PanelName | null;
  setPanel: (p: PanelName | null) => void;
  showModeToggle?: boolean;
  autoPlay?: { on: boolean; toggle: () => void; label: string };
  settingsExtra?: ReactNode;
  settingsScope?: "text" | "ebook" | "pdf" | "image";
  /** read-aloud button (text documents) */
  tts?: { playing: boolean; onClick: () => void };
  /** highlights & notes count; shows the notes button when set */
  notesCount?: number;
  /** panels rendered by the reader itself (tts, notes) */
  customPanels?: Partial<Record<PanelName, ReactNode>>;
  /** what lies at a given position (chapter title), shown while dragging the progress bar */
  labelAt?: (pct: number) => string | undefined;
  /** exact reading place, so `돌아가기` returns to the same line rather than the same percentage */
  place?: { save: () => unknown; restore: (place: unknown) => void };
}

export function ReaderChrome(p: ChromeProps) {
  const { settings, set } = useSettings();
  const toggle = (name: PanelName) => p.setPanel(p.panel === name ? null : name);

  // Chapter navigation from the bottom bar.
  const idx = p.currentTocIndex;
  const chapter = idx != null ? p.toc[idx]?.label : undefined;
  const prevChapter = idx != null && idx > 0 ? p.toc[idx - 1] : undefined;
  const nextChapter = idx != null ? p.toc[idx + 1] : p.toc[0];

  // Jumps from the bottom bar can be taken back for a few seconds (a stray touch on the
  // progress bar shouldn't cost the reader their place).
  const [undo, setUndo] = useState<{ pct: number; place?: unknown } | null>(null);
  const pctRef = useRef(p.pct);
  pctRef.current = p.pct;
  const jump = (go: () => void) => {
    const from = { pct: pctRef.current, place: p.place?.save() };
    go();
    setUndo(from);
  };
  useEffect(() => {
    if (!undo) return;
    const id = window.setTimeout(() => setUndo(null), 7000);
    return () => window.clearTimeout(id);
  }, [undo]);

  const toggleFullscreen = async () => {
    const w = getCurrentWindow();
    const fs = await w.isFullscreen();
    await w.setFullscreen(!fs);
  };

  return (
    <>
      <div className={`chrome-top ${p.visible ? "" : "hidden"}`} onPointerDown={(e) => e.stopPropagation()}>
        <button className="icon-btn" title="서재로 (Esc)" onClick={p.onBack}>
          <IconBack />
        </button>
        <div className="title">
          <b title={p.title}>{p.title}</b>
          {p.subtitle && <span>{p.subtitle}</span>}
        </div>
        {p.onPrevFile && (
          <button className="icon-btn" title="이전 파일 (Ctrl+←)" onClick={p.onPrevFile}>
            <IconPrev />
          </button>
        )}
        {p.onNextFile && (
          <button className="icon-btn" title="다음 파일 (Ctrl+→)" onClick={p.onNextFile}>
            <IconNext />
          </button>
        )}
        {p.showModeToggle && (
          <button
            className="icon-btn"
            title={settings.readMode === "scroll" ? "페이지 모드로 (M)" : "스크롤 모드로 (M)"}
            onClick={() => set({ readMode: settings.readMode === "scroll" ? "page" : "scroll" })}
          >
            {settings.readMode === "scroll" ? <IconPages /> : <IconScroll />}
          </button>
        )}
        {p.autoPlay && (
          <button className={`icon-btn ${p.autoPlay.on ? "active" : ""}`} title={p.autoPlay.label} onClick={p.autoPlay.toggle}>
            {p.autoPlay.on ? <IconPause /> : <IconPlay />}
          </button>
        )}
        {p.tts && (
          <button className={`icon-btn ${p.tts.playing || p.panel === "tts" ? "active" : ""}`} title="읽어 주기 (R)" onClick={p.tts.onClick}>
            <IconHeadphones />
          </button>
        )}
        <button className={`icon-btn ${p.panel === "toc" ? "active" : ""}`} title="목차 (T)" onClick={() => toggle("toc")} disabled={p.toc.length === 0}>
          <IconList />
        </button>
        {p.onSearch && (
          <button className={`icon-btn ${p.panel === "search" ? "active" : ""}`} title="검색 (Ctrl+F)" onClick={() => toggle("search")}>
            <IconSearch />
          </button>
        )}
        <button className={`icon-btn ${p.isBookmarked ? "active" : ""}`} title="책갈피 추가/제거 (B)" onClick={p.onToggleBookmark}>
          {p.isBookmarked ? <IconBookmarkFilled /> : <IconBookmark />}
        </button>
        <button className={`icon-btn ${p.panel === "bookmarks" ? "active" : ""}`} title="책갈피 목록" onClick={() => toggle("bookmarks")}>
          <span style={{ fontSize: 12, fontWeight: 700 }}>{p.bookmarks.length}</span>
        </button>
        {p.notesCount != null && (
          <button className={`icon-btn ${p.panel === "notes" ? "active" : ""}`} title="하이라이트·메모 (N)" onClick={() => toggle("notes")}>
            <IconNote />
          </button>
        )}
        {!isMobile() && (
          <button className="icon-btn" title="전체 화면 (F11)" onClick={toggleFullscreen}>
            <IconFullscreen />
          </button>
        )}
        <button className={`icon-btn ${p.panel === "settings" ? "active" : ""}`} title="설정" onClick={() => toggle("settings")}>
          <IconSettings />
        </button>
      </div>

      <div className={`chrome-bottom ${p.visible ? "" : "hidden"}`} onPointerDown={(e) => e.stopPropagation()}>
        <div className="cb-info">
          <span className="cb-chapter" title={chapter}>
            {chapter ?? p.title}
          </span>
          <span className="cb-pos">
            <b>{formatPct(p.pct)}</b>
            {p.posLabel && <span> · {p.posLabel}</span>}
          </span>
        </div>
        <div className="progress-row">
          <button className="icon-btn cb-step" title="이전 장" disabled={!prevChapter} onClick={() => prevChapter && jump(() => p.onGoToc(prevChapter))}>
            <IconPrev />
          </button>
          <Slider pct={p.pct} marks={p.bookmarks.map((b) => b.pct)} labelAt={p.labelAt} onSeek={(v) => jump(() => p.onSeek(v))} />
          <button className="icon-btn cb-step" title="다음 장" disabled={!nextChapter} onClick={() => nextChapter && jump(() => p.onGoToc(nextChapter))}>
            <IconNext />
          </button>
        </div>
      </div>

      {undo && (
        <button className={`seek-undo ${p.visible ? "with-chrome" : ""}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => {
            setUndo(null);
            if (p.place && undo.place !== undefined) p.place.restore(undo.place);
            else p.onSeek(undo.pct);
          }}>
          <IconUndo />
          {formatPct(undo.pct)}로 돌아가기
        </button>
      )}

      {!p.visible && settings.showMiniProgress && (
        <>
          <div className="mini-progress">
            <i style={{ width: `${p.pct * 100}%` }} />
          </div>
          <div className="mini-pct">{formatPct(p.pct)}</div>
        </>
      )}

      {p.panel === "toc" && <TocPanel items={p.toc} current={p.currentTocIndex} onGo={p.onGoToc} onClose={() => p.setPanel(null)} />}
      {p.panel === "bookmarks" && (
        <BookmarksPanel items={p.bookmarks} onGo={p.onGoBookmark} onRemove={p.onRemoveBookmark} onClose={() => p.setPanel(null)} />
      )}
      {p.panel === "search" && p.onSearch && (
        <SearchPanel onSearch={p.onSearch} onGo={p.onGoHit ?? (() => {})} onClose={() => p.setPanel(null)} />
      )}
      {p.panel && p.customPanels?.[p.panel]}
      {p.panel === "settings" && <SettingsPanel onClose={() => p.setPanel(null)} extra={p.settingsExtra} scope={p.settingsScope ?? "text"} />}
    </>
  );
}

/**
 * Progress bar. Touching it jumps there; dragging moves relative to the finger, and
 * sliding the finger upwards while dragging slows it down for fine positioning
 * (½ above 40 px, ¼ above 90 px) – handy in very long novels. The bubble shows the
 * percentage and, when the reader knows it, the chapter at that point.
 */
function Slider({ pct, marks, labelAt, onSeek }: { pct: number; marks: number[]; labelAt?: (pct: number) => string | undefined; onSeek: (pct: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ value: number; fine: number } | null>(null);
  const state = useRef({ lastX: 0, value: 0 });

  const pctAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };

  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const r = ref.current!.getBoundingClientRect();
      const above = r.top - e.clientY;
      const fine = above > 90 ? 0.25 : above > 40 ? 0.5 : 1;
      const s = state.current;
      s.value = Math.min(1, Math.max(0, s.value + ((e.clientX - s.lastX) / r.width) * fine));
      s.lastX = e.clientX;
      setDrag({ value: s.value, fine });
    };
    const up = () => {
      setDrag(null);
      onSeek(state.current.value);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    window.addEventListener("pointercancel", () => setDrag(null), { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [dragging]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = drag?.value ?? pct;
  const tipAt = drag?.value ?? hover;
  const tipLabel = tipAt != null ? labelAt?.(tipAt) : undefined;
  return (
    <div
      className={`slider ${dragging ? "dragging" : ""}`}
      ref={ref}
      onPointerDown={(e) => {
        e.preventDefault();
        const v = pctAt(e.clientX);
        state.current = { lastX: e.clientX, value: v };
        setDrag({ value: v, fine: 1 });
      }}
      onPointerMove={(e) => e.pointerType === "mouse" && setHover(pctAt(e.clientX))}
      onPointerLeave={() => setHover(null)}
    >
      <div className="track">
        <div className="fill" style={{ width: `${shown * 100}%` }} />
        {marks.map((m, i) => (
          <div key={i} className="mark" style={{ left: `${m * 100}%` }} />
        ))}
        <div className="knob" style={{ left: `${shown * 100}%` }} />
        {tipAt != null && (
          <div className="tip" style={{ left: `${Math.min(92, Math.max(8, tipAt * 100))}%` }}>
            {tipLabel && <span className="tip-label">{tipLabel}</span>}
            <b>{formatPct(tipAt)}</b>
            {drag && drag.fine < 1 && <span className="tip-fine">정밀 ×{drag.fine === 0.5 ? "½" : "¼"}</span>}
          </div>
        )}
      </div>
    </div>
  );
}