import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { Bookmark, Entry, Highlight, HighlightColor, ReplaceRule, SearchHit, TocItem } from "../../types";
import { readText, listEncodings, saveTextAs } from "../../lib/tauri";
import { isMobile } from "../../lib/platform";
import { buildDoc, formatPct, paraAtOffset, searchText, type TextDoc } from "../../lib/text";
import { applyRules, reflow, type ReflowStats } from "../../lib/textPrep";
import { isMarkdownExt, markdownToDoc } from "../../lib/markdown";
import { addDeco, highlightDecos, readSelection, searchDecos, type DecoMap, type TextRangeSel } from "../../lib/decorate";
import { useSettings } from "../../store/settings";
import { useProgress, NO_BOOKMARKS } from "../../store/progress";
import { useNotes, NO_HIGHLIGHTS } from "../../store/notes";
import { useLibrary } from "../../store/library";
import { ReaderChrome, type PanelName } from "./ReaderChrome";
import { ScrollView, type TextViewHandle } from "./ScrollView";
import { PageView } from "./PageView";
import { useAutoHide } from "./useAutoHide";
import { useReadingTracker } from "./useReadingTracker";
import { useReaderKeys } from "./useReaderKeys";
import { ttsAvailable, useTextTts, useTtsSession } from "./useTextTts";
import { TtsPanel } from "./TtsPanel";
import { NoteEditor, NotesPanel, SelectionToolbar, notesToMarkdown } from "./NotesUi";
import { stripExt } from "../../lib/sort";

export interface ReaderProps {
  entry: Entry;
  onBack: () => void;
  onPrevFile?: () => void;
  onNextFile?: () => void;
  /** display name of the next file, for the "turn once more" hint */
  nextName?: string;
  subtitle?: string;
}

interface Prepared {
  doc: TextDoc;
  ruleCounts: Record<string, number>;
  ruleErrors: Record<string, string>;
  reflow: ReflowStats;
}

/** Re-locate highlights created against a different paragraph layout by searching for their text. */
function anchor(list: Highlight[], doc: TextDoc): Highlight[] {
  const n = doc.paras.length;
  return list.flatMap((h) => {
    if (!h.paraCount || h.paraCount === n) return h.ePara < n ? [h] : [];
    const probe = h.text.split("\n")[0].slice(0, 40);
    if (!probe) return [];
    const guess = paraAtOffset(doc.cum, h.pct * doc.total);
    for (let d = 0; d < 400; d++) {
      for (const p of [guess + d, guess - d]) {
        if (p < 0 || p >= n || (d === 0 && p !== guess)) continue;
        const i = doc.paras[p].indexOf(probe);
        if (i >= 0) {
          // Re-anchor as a single-paragraph range when the layout changed.
          const end = Math.min(doc.paras[p].length, i + h.text.length);
          return [{ ...h, sPara: p, sOff: i, ePara: p, eOff: end }];
        }
      }
    }
    return [];
  });
}

export function TextReader({ entry, onBack, onPrevFile, onNextFile, nextName, subtitle }: ReaderProps) {
  const { settings, set } = useSettings();
  const progress = useProgress((st) => st.progress[entry.id]);
  const bookmarks = useProgress((st) => st.bookmarks[entry.id] ?? NO_BOOKMARKS);
  const { update, addBookmark, removeBookmark } = useProgress();
  const rawHighlights = useNotes((st) => st.highlights[entry.id] ?? NO_HIGHLIGHTS);
  const notes = useNotes();
  const changed = useLibrary((st) => st.changed);
  const clearChanged = useLibrary((st) => st.clearChanged);

  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const doc = prepared?.doc ?? null;
  const docRef = useRef<TextDoc | null>(null);
  docRef.current = doc;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [panel, setPanel] = useState<PanelName | null>(null);
  const [autoPlay, setAutoPlay] = useState(false);
  const [search, setSearch] = useState<{ para: number; query: string } | null>(null);
  const [encodings, setEncodings] = useState<[string, string][]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [pos, setPos] = useState({ para: progress?.para ?? 0, frac: progress?.frac ?? 0, pct: progress?.pct ?? 0 });
  const [selTool, setSelTool] = useState<{ rect: DOMRect; sel?: TextRangeSel; hlId?: string } | null>(null);
  const [noteEdit, setNoteEdit] = useState<{ id?: string; sel?: TextRangeSel; text: string; initial: string } | null>(null);
  const endArmed = useRef(false);
  const viewRef = useRef<TextViewHandle>(null);
  const initialRef = useRef({ para: progress?.para ?? 0, frac: progress?.frac ?? 0 });
  const posRef = useRef(pos);
  const ui = useAutoHide(settings.uiAutoHideSec * 1000, panel !== null);
  const encodingOverride = settings.encodingOverrides[entry.id];
  const rulesKey = JSON.stringify(settings.replaceRules.filter((r) => r.enabled));

  // ---------- loading pipeline: decode → replace rules → reflow → paragraphs ----------
  const load = useCallback(
    async (keepPos: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const res = await readText(entry.id, encodingOverride, entry.ext);
        const s = useSettings.getState().settings;
        const ruled = applyRules(res.text, s.replaceRules);
        // Markdown: markup → styles, paragraphs already decided by the converter.
        const md = isMarkdownExt(entry.ext) ? markdownToDoc(ruled.text) : null;
        const flowed = reflow(md ? md.text : ruled.text, md ? "off" : s.reflow);
        const d = buildDoc(flowed.text, md ? false : s.collapseBlank, res.encoding);
        if (md) {
          if (md.toc.length) d.toc = md.toc;
          d.styles = md.styles;
        }
        const prog = useProgress.getState().progress[entry.id];
        if (keepPos) {
          // Layout changed under us: map the position through the percentage.
          const pct = posRef.current.pct;
          initialRef.current = { para: paraAtOffset(d.cum, pct * d.total), frac: 0 };
        } else if (prog && prog.paraCount && prog.paraCount !== d.paras.length) {
          initialRef.current = { para: paraAtOffset(d.cum, (prog.pct ?? 0) * d.total), frac: 0 };
        }
        if (useTtsSession.getState().resumeOnOpen) initialRef.current = { para: 0, frac: 0 };
        setPrepared({ doc: d, ruleCounts: ruled.counts, ruleErrors: ruled.errors, reflow: flowed.stats });
        clearChanged(entry.id);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entry.id, encodingOverride],
  );

  useEffect(() => {
    initialRef.current = { para: progress?.para ?? 0, frac: progress?.frac ?? 0 };
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, encodingOverride]);

  // Layout-affecting text settings → rebuild, keeping the position.
  const layoutKey = `${settings.collapseBlank}|${settings.reflow}|${rulesKey}`;
  const firstLayout = useRef(true);
  useEffect(() => {
    if (firstLayout.current) {
      firstLayout.current = false;
      return;
    }
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  useEffect(() => {
    listEncodings().then(setEncodings).catch(() => {});
  }, []);

  useEffect(() => {
    if (changed.has(entry.id) && doc) setToast("파일이 갱신되었습니다");
  }, [changed, entry.id, doc]);

  useReadingTracker({
    bookId: entry.id,
    title: stripExt(entry.name),
    kind: "text",
    pct: pos.pct,
    charOffset: doc ? doc.cum[Math.min(pos.para, doc.paras.length - 1)] + pos.frac * ((doc.paras[pos.para]?.length ?? 0) + 1) : undefined,
    autoPlay,
  });

  const onPos = useCallback(
    (para: number, frac: number, pct: number) => {
      const p = { para, frac, pct };
      posRef.current = p;
      initialRef.current = { para, frac };
      endArmed.current = false;
      setPos(p);
      update(entry.id, { para, frac, pct, mtime: entry.mtime, totalChars: docRef.current?.total, paraCount: docRef.current?.paras.length });
    },
    [entry.id, entry.mtime, update],
  );

  // ---------- end of document → next file ----------
  const handleEnd = useCallback(() => {
    if (!settings.autoNextFile || !onNextFile) {
      setToast(onNextFile ? "마지막 페이지입니다" : "마지막 페이지입니다 · 같은 폴더에 다음 파일이 없습니다");
      return;
    }
    if (endArmed.current) {
      endArmed.current = false;
      onNextFile();
    } else {
      endArmed.current = true;
      setToast(`마지막 페이지 · 한 번 더 넘기면 다음 화${nextName ? `: ${stripExt(nextName)}` : ""}`);
    }
  }, [settings.autoNextFile, onNextFile, nextName]);

  // ---------- TTS ----------
  const tts = useTextTts({
    doc,
    currentPara: () => posRef.current.para,
    ensureVisible: (para) => viewRef.current?.ensureVisible(para),
    onFinished: () => {
      if (settings.autoNextFile && onNextFile) {
        useTtsSession.getState().set(true);
        onNextFile();
      } else setToast("끝까지 읽었습니다");
    },
  });

  // Continue reading aloud after auto-advancing to this file.
  useEffect(() => {
    if (doc && tts.status?.installed && useTtsSession.getState().resumeOnOpen) {
      useTtsSession.getState().set(false);
      tts.startAt(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, tts.status?.installed]);

  const onTtsButton = useCallback(() => {
    if (!tts.status?.installed) {
      setPanel("tts");
      return;
    }
    if (tts.state === "stopped") {
      tts.play();
      setPanel("tts");
    } else if (panel !== "tts") setPanel("tts");
    else tts.toggle();
  }, [tts, panel]);

  // ---------- decorations ----------
  const highlights = useMemo(() => (doc ? anchor(rawHighlights, doc) : []), [rawHighlights, doc]);
  const decos = useMemo(() => {
    const map: DecoMap = new Map();
    if (!doc) return map;
    if (doc.styles) for (const [p, list] of doc.styles) map.set(p, [...list]);
    highlightDecos(map, highlights, (p) => doc.paras[p]?.length ?? 0);
    if (search) searchDecos(map, search.para, doc.paras[search.para] ?? "", search.query);
    if (tts.current) addDeco(map, tts.current.para, { start: tts.current.start, end: tts.current.end, cls: "tts" });
    return map;
  }, [doc, highlights, search, tts.current]);

  // ---------- selection & highlights ----------
  const onSelectEnd = useCallback(() => {
    // Let the browser finish updating the selection first.
    requestAnimationFrame(() => {
      const sel = readSelection();
      if (sel) setSelTool({ rect: sel.rect, sel });
    });
  }, []);

  // Touch: text is selected by long-press (no mouseup) – follow the selection instead.
  useEffect(() => {
    if (!isMobile()) return;
    let t: number | undefined;
    const onChange = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        const sel = readSelection();
        if (sel) setSelTool({ rect: sel.rect, sel });
      }, 450);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("selectionchange", onChange);
    };
  }, []);

  const onDecoClick = useCallback((id: string, rect: DOMRect) => {
    if (window.getSelection()?.toString()) return;
    setSelTool({ rect, hlId: id });
  }, []);

  const textOf = useCallback(
    (s: { sPara: number; sOff: number; ePara: number; eOff: number }) => {
      if (!doc) return "";
      const parts: string[] = [];
      for (let p = s.sPara; p <= s.ePara; p++) {
        const t = doc.paras[p] ?? "";
        parts.push(t.slice(p === s.sPara ? s.sOff : 0, p === s.ePara ? s.eOff : t.length));
      }
      return parts.join("\n").trim();
    },
    [doc],
  );

  const createHighlight = useCallback(
    (sel: TextRangeSel, color: HighlightColor, note?: string) => {
      if (!doc) return;
      const pct = (doc.cum[sel.sPara] + sel.sOff) / doc.total;
      notes.add(entry.id, { sPara: sel.sPara, sOff: sel.sOff, ePara: sel.ePara, eOff: sel.eOff, text: textOf(sel), color, note, pct, paraCount: doc.paras.length });
      window.getSelection()?.removeAllRanges();
    },
    [doc, entry.id, notes, textOf],
  );

  const currentHl = selTool?.hlId ? highlights.find((h) => h.id === selTool.hlId) : undefined;

  const exportNotes = useCallback(async () => {
    const fileName = `${stripExt(entry.name)} - 메모.md`;
    let path: string | null = null;
    if (!isMobile()) {
      path = await saveDialog({ defaultPath: fileName, filters: [{ name: "Markdown", extensions: ["md"] }, { name: "텍스트", extensions: ["txt"] }] });
      if (!path) return;
    }
    if (await saveTextAs(path, fileName, notesToMarkdown(stripExt(entry.name), highlights))) setToast("내보냈습니다");
  }, [entry.name, highlights]);

  // ---------- toc / bookmarks / search ----------
  const tocParas = useMemo(() => new Set((doc?.toc ?? []).map((t) => t.para!)), [doc]);
  const place = useMemo(
    () => ({
      save: () => ({ ...posRef.current }),
      restore: (p: unknown) => {
        const at = p as { para: number; frac: number };
        viewRef.current?.goTo(at.para, at.frac);
      },
    }),
    [],
  );

  /** Chapter at a position of the progress bar – shown in its bubble while dragging. */
  const labelAt = useCallback(
    (pct: number) => {
      if (!doc || !doc.toc.length) return undefined;
      const para = paraAtOffset(doc.cum, pct * doc.total);
      let label: string | undefined;
      for (const t of doc.toc) {
        if ((t.para ?? 0) > para) break;
        label = t.label;
      }
      return label;
    },
    [doc],
  );

  const currentTocIndex = useMemo(() => {
    if (!doc) return undefined;
    let idx: number | undefined;
    for (let i = 0; i < doc.toc.length; i++) {
      if (doc.toc[i].para! <= pos.para) idx = i;
      else break;
    }
    return idx;
  }, [doc, pos.para]);

  const isBookmarked = bookmarks.some((b) => b.para === pos.para);
  const toggleBookmark = useCallback(() => {
    if (!doc) return;
    const existing = bookmarks.find((b) => b.para === pos.para);
    if (existing) {
      removeBookmark(entry.id, existing.id);
      setToast("책갈피를 제거했습니다");
    } else {
      const text = doc.paras[pos.para]?.trim() || doc.paras.slice(pos.para, pos.para + 5).find((p) => p.trim())?.trim() || `${formatPct(pos.pct)} 지점`;
      addBookmark(entry.id, { pct: pos.pct, para: pos.para, label: text.slice(0, 80) });
      setToast("책갈피를 추가했습니다");
    }
  }, [doc, bookmarks, pos, entry.id, addBookmark, removeBookmark]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(id);
  }, [toast]);

  const lastQuery = useRef("");
  const onSearch = useCallback(
    (q: string): SearchHit[] => {
      lastQuery.current = q;
      return doc ? searchText(doc.paras, q) : [];
    },
    [doc],
  );
  const onGoHit = useCallback((h: SearchHit) => {
    setSearch({ para: h.para, query: lastQuery.current });
    viewRef.current?.goTo(h.para, 0);
  }, []);

  useReaderKeys({
    enabled: !!doc && !noteEdit,
    next: () => viewRef.current?.next(),
    prev: () => viewRef.current?.prev(),
    home: () => viewRef.current?.home(),
    end: () => viewRef.current?.end(),
    back: () => (selTool ? setSelTool(null) : panel ? setPanel(null) : onBack()),
    toggleMode: () => set({ readMode: settings.readMode === "scroll" ? "page" : "scroll" }),
    toggleToc: () => setPanel((p) => (p === "toc" ? null : "toc")),
    toggleSearch: () => setPanel((p) => (p === "search" ? null : "search")),
    toggleBookmark,
    toggleAuto: () => setAutoPlay((a) => !a),
    fontDelta: (d) => set({ fontSize: Math.min(48, Math.max(10, settings.fontSize + d)) }),
    prevFile: onPrevFile,
    nextFile: onNextFile,
    toggleUi: ui.toggle,
    hideUi: ui.hide,
    toggleTts: () => (tts.status?.installed ? tts.toggle() : setPanel("tts")),
    toggleNotes: () => setPanel((p) => (p === "notes" ? null : "notes")),
  });

  const posLabel = doc ? `${(pos.para + 1).toLocaleString()} / ${doc.paras.length.toLocaleString()} 줄` : "";
  const title = stripExt(entry.name);

  const settingsExtra = (
    <TextSettingsExtra
      prepared={prepared}
      encodings={encodings}
      encodingOverride={encodingOverride}
      entryId={entry.id}
      hasNext={!!onNextFile}
    />
  );

  const viewProps = {
    ref: viewRef,
    doc: doc!,
    settings,
    onPos,
    decos,
    tocParas,
    autoPlay,
    onToggleUi: ui.toggle,
    interceptTap: ui.consumeTap,
    onEnd: handleEnd,
    onDecoClick,
    onSelectEnd,
  };

  return (
    <div className={`reader ${ui.cursorHidden ? "hide-cursor" : ""}`} onPointerMove={ui.onPointerMove}>
      {doc &&
        !error &&
        (settings.readMode === "scroll" ? (
          <ScrollView key={`scroll-${entry.id}`} {...viewProps} initial={initialRef.current} />
        ) : (
          <PageView key={`page-${entry.id}`} {...viewProps} initial={{ para: initialRef.current.para, frac: 0 }} />
        ))}
      {loading && (
        <div className="loading-overlay">
          <div className="spinner" />
          <span>불러오는 중…</span>
        </div>
      )}
      {error && (
        <div className="loading-overlay">
          <div className="error-box">
            <div style={{ fontWeight: 600, marginBottom: 8 }}>파일을 열 수 없습니다</div>
            <div className="muted" style={{ fontSize: 13 }}>
              {error}
            </div>
            <div style={{ marginTop: 14, display: "flex", gap: 8, justifyContent: "center" }}>
              <button className="btn" onClick={onBack}>
                서재로
              </button>
              <button className="btn primary" onClick={() => load(false)}>
                다시 시도
              </button>
            </div>
          </div>
        </div>
      )}
      <ReaderChrome
        entry={entry}
        title={title}
        subtitle={subtitle}
        pct={pos.pct}
        posLabel={posLabel}
        visible={ui.visible}
        onSeek={(p) => viewRef.current?.seek(p)}
        onBack={onBack}
        onPrevFile={onPrevFile}
        onNextFile={onNextFile}
        toc={doc?.toc ?? []}
        currentTocIndex={currentTocIndex}
        labelAt={labelAt}
        place={place}
        onGoToc={(t: TocItem) => viewRef.current?.goTo(t.para ?? 0, 0)}
        bookmarks={bookmarks}
        isBookmarked={isBookmarked}
        onToggleBookmark={toggleBookmark}
        onGoBookmark={(b: Bookmark) => viewRef.current?.goTo(b.para ?? 0, 0)}
        onRemoveBookmark={(id) => removeBookmark(entry.id, id)}
        onSearch={onSearch}
        onGoHit={onGoHit}
        panel={panel}
        setPanel={setPanel}
        showModeToggle
        autoPlay={{
          on: autoPlay,
          toggle: () => setAutoPlay((a) => !a),
          label: settings.readMode === "scroll" ? "자동 스크롤 (A)" : "자동 넘김 (A)",
        }}
        settingsExtra={settingsExtra}
        settingsScope="text"
        tts={ttsAvailable() ? { playing: tts.isActive, onClick: onTtsButton } : undefined}
        notesCount={highlights.length}
        customPanels={{
          tts: (
            <TtsPanel
              status={tts.status}
              state={tts.state}
              currentText={tts.current?.text ?? null}
              error={tts.error}
              download={tts.download}
              sleepChoice={tts.sleepChoice}
              sleepLeftMin={tts.sleepLeftMin}
              onClose={() => setPanel(null)}
              onPlay={tts.play}
              onPause={tts.pause}
              onStop={tts.stop}
              onPrevSentence={tts.prevSentence}
              onNextSentence={tts.nextSentence}
              onDownload={tts.startDownload}
              onCancelDownload={tts.cancelDownload}
              onDeleteModel={tts.deleteModel}
              onOpenSystemSettings={tts.openSystemSettings}
              onSleep={tts.setSleep}
            />
          ),
          notes: (
            <NotesPanel
              items={highlights}
              onGo={(h) => viewRef.current?.goTo(h.sPara, 0)}
              onEdit={(h) => setNoteEdit({ id: h.id, text: h.text, initial: h.note ?? "" })}
              onRemove={(h) => notes.remove(entry.id, h.id)}
              onExport={exportNotes}
              onCopyAll={() => {
                void navigator.clipboard.writeText(notesToMarkdown(title, highlights));
                setToast("클립보드에 복사했습니다");
              }}
              onClose={() => setPanel(null)}
            />
          ),
        }}
      />
      {/* TTS mini player while the chrome is hidden */}
      {tts.isActive && !ui.visible && panel !== "tts" && (
        <button className="tts-pill" onClick={() => setPanel("tts")} onPointerDown={(e) => e.stopPropagation()}>
          <span className={`tts-dot ${tts.state === "playing" ? "live" : ""}`} />
          {tts.state === "paused" ? "일시 정지됨" : "읽는 중"}
        </button>
      )}
      {selTool && (
        <SelectionToolbar
          rect={selTool.rect}
          current={currentHl}
          onClose={() => setSelTool(null)}
          onColor={(c) => {
            if (currentHl) notes.update(entry.id, currentHl.id, { color: c });
            else if (selTool.sel) createHighlight(selTool.sel, c);
            setSelTool(null);
          }}
          onNote={() => {
            if (currentHl) setNoteEdit({ id: currentHl.id, text: currentHl.text, initial: currentHl.note ?? "" });
            else if (selTool.sel) setNoteEdit({ sel: selTool.sel, text: textOf(selTool.sel), initial: "" });
            setSelTool(null);
          }}
          onCopy={() => {
            const t = currentHl ? currentHl.text : selTool.sel ? textOf(selTool.sel) : "";
            void navigator.clipboard.writeText(t);
            setToast("복사했습니다");
            setSelTool(null);
          }}
          onReadFrom={
            tts.status?.installed
              ? () => {
                  const at = currentHl ? { p: currentHl.sPara, o: currentHl.sOff } : selTool.sel ? { p: selTool.sel.sPara, o: selTool.sel.sOff } : null;
                  if (at) tts.startAt(at.p, at.o);
                  window.getSelection()?.removeAllRanges();
                  setSelTool(null);
                }
              : undefined
          }
          onDelete={
            currentHl
              ? () => {
                  notes.remove(entry.id, currentHl.id);
                  setSelTool(null);
                }
              : undefined
          }
        />
      )}
      {noteEdit && (
        <NoteEditor
          initial={noteEdit.initial}
          quote={noteEdit.text}
          onCancel={() => setNoteEdit(null)}
          onSave={(v) => {
            const note = v.trim() || undefined;
            if (noteEdit.id) notes.update(entry.id, noteEdit.id, { note });
            else if (noteEdit.sel) createHighlight(noteEdit.sel, "yellow", note);
            setNoteEdit(null);
          }}
        />
      )}
      {toast && (
        <div className="toast">
          <span>{toast}</span>
          {toast.includes("갱신") && (
            <button className="btn primary" style={{ padding: "4px 10px" }} onClick={() => load(true)}>
              다시 불러오기
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Text-only settings: file, reflow, replace rules, auto-next
// ---------------------------------------------------------------------------

function TextSettingsExtra({
  prepared,
  encodings,
  encodingOverride,
  entryId,
  hasNext,
}: {
  prepared: Prepared | null;
  encodings: [string, string][];
  encodingOverride?: string;
  entryId: string;
  hasNext: boolean;
}) {
  const { settings, set } = useSettings();
  const doc = prepared?.doc;
  const rules = settings.replaceRules;
  const setRules = (r: ReplaceRule[]) => set({ replaceRules: r });
  const patch = (id: string, p: Partial<ReplaceRule>) => setRules(rules.map((r) => (r.id === id ? { ...r, ...p } : r)));
  // Rules apply on blur / Enter so typing doesn't re-layout the book on every keystroke.
  const [drafts, setDrafts] = useState<Record<string, Partial<ReplaceRule>>>({});
  const commit = (id: string) => {
    const d = drafts[id];
    if (!d) return;
    patch(id, d);
    setDrafts((x) => {
      const n = { ...x };
      delete n[id];
      return n;
    });
  };

  const seg = <T extends string | number>(value: T, options: { v: T; l: string }[], onChange: (v: T) => void) => (
    <div className="seg">
      {options.map((o) => (
        <button key={String(o.v)} className={o.v === value ? "on" : ""} onClick={() => onChange(o.v)}>
          {o.l}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <div className="group">텍스트 정리</div>
      <div className="field">
        <label>줄 합치기</label>
        <div className="ctl">
          {seg(settings.reflow, [
            { v: "auto", l: "자동" },
            { v: "on", l: "항상" },
            { v: "off", l: "끔" },
          ], (v) => set({ reflow: v }))}
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12, lineHeight: 1.5, marginBottom: 4 }}>
        {prepared?.reflow.applied
          ? `문장 중간에서 끊긴 줄 ${prepared.reflow.joined.toLocaleString()}곳을 이었습니다.`
          : "웹에서 복사해 문장 중간마다 줄이 끊긴 txt를 문단으로 다시 이어 줍니다. 이 파일은 해당 없음."}
      </div>
      <div className="field" style={{ alignItems: "flex-start" }}>
        <label style={{ paddingTop: 6 }}>치환 규칙</label>
        <div className="ctl" style={{ flexDirection: "column", alignItems: "stretch" }}>
          {rules.map((r) => {
            const d = { ...r, ...drafts[r.id] };
            const count = prepared?.ruleCounts[r.id];
            const err = prepared?.ruleErrors[r.id];
            return (
              <div key={r.id} className={`rule ${r.enabled ? "" : "off"}`}>
                <div className="rule-row">
                  <input
                    type="text"
                    placeholder="찾을 내용"
                    value={d.find}
                    onChange={(e) => setDrafts((x) => ({ ...x, [r.id]: { ...x[r.id], find: e.target.value } }))}
                    onBlur={() => commit(r.id)}
                    onKeyDown={(e) => e.key === "Enter" && commit(r.id)}
                  />
                  <span className="muted">→</span>
                  <input
                    type="text"
                    placeholder="(지우기)"
                    value={d.replace}
                    onChange={(e) => setDrafts((x) => ({ ...x, [r.id]: { ...x[r.id], replace: e.target.value } }))}
                    onBlur={() => commit(r.id)}
                    onKeyDown={(e) => e.key === "Enter" && commit(r.id)}
                  />
                </div>
                <div className="rule-row small">
                  <label className="chk">
                    <input type="checkbox" checked={r.enabled} onChange={(e) => patch(r.id, { enabled: e.target.checked })} /> 사용
                  </label>
                  <label className="chk">
                    <input type="checkbox" checked={r.regex} onChange={(e) => patch(r.id, { regex: e.target.checked })} /> 정규식
                  </label>
                  <span className={err ? "rule-err" : "muted"}>{err ? "정규식 오류" : r.enabled && count != null ? `${count.toLocaleString()}곳` : ""}</span>
                  <span style={{ flex: 1 }} />
                  <button className="link danger" onClick={() => setRules(rules.filter((x) => x.id !== r.id))}>
                    삭제
                  </button>
                </div>
              </div>
            );
          })}
          <button
            className="btn ghost"
            onClick={() => setRules([...rules, { id: `${Date.now()}`, find: "", replace: "", regex: false, enabled: true }])}
          >
            + 규칙 추가
          </button>
          <div className="muted" style={{ fontSize: 11, lineHeight: 1.5 }}>
            모든 txt에 적용됩니다. 예: 광고 문구 지우기, <code>^[=\-*]{"{3,}"}$</code>(정규식)로 구분선 지우기
          </div>
        </div>
      </div>

      <div className="group">이어 읽기</div>
      <div className="field">
        <label>다음 화 자동</label>
        <div className="ctl">
          {seg(settings.autoNextFile ? 1 : 0, [
            { v: 1, l: "켬" },
            { v: 0, l: "끔" },
          ], (v) => set({ autoNextFile: v === 1 }))}
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
        마지막 페이지에서 한 번 더 넘기면 같은 폴더의 다음 파일을 엽니다. 읽어 주기도 다음 화로 이어집니다.
        {!hasNext && " (이 파일은 폴더의 마지막 파일입니다)"}
      </div>

      <div className="group">파일</div>
      <div className="field">
        <label>인코딩</label>
        <div className="ctl">
          <select
            value={encodingOverride ?? "auto"}
            onChange={(e) => {
              const v = e.target.value;
              const next = { ...settings.encodingOverrides };
              if (v === "auto") delete next[entryId];
              else next[entryId] = v;
              set({ encodingOverrides: next });
            }}
          >
            {encodings.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
                {v === "auto" && doc ? ` (감지: ${doc.encoding})` : ""}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label>정보</label>
        <div className="ctl muted" style={{ fontSize: 12, flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
          <span>{doc ? `${doc.total.toLocaleString()} 자 · ${doc.paras.length.toLocaleString()} 줄` : ""}</span>
          <span style={{ wordBreak: "break-all", userSelect: "text" }}>{entryId}</span>
        </div>
      </div>
    </>
  );
}
