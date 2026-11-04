import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { open } from "@tauri-apps/plugin-dialog";
import { onBackButtonPress } from "@tauri-apps/api/app";
import type { Entry, Progress } from "../../types";
import { useCloud, isNewerPlace } from "../../store/cloud";
import { buildIndex, type DevicePos } from "../../lib/sync";
import { DeviceIcon } from "./ResumeSheet";
import { useSettings , dirName } from "../../store/settings";
import { useLibrary } from "../../store/library";
import { useProgress } from "../../store/progress";
import { naturalCompare, baseName, stripExt } from "../../lib/sort";
import { formatAgo, formatPct, formatSize } from "../../lib/text";
import { IconArchive, IconChart, IconCloud, IconFolder, IconFolderPlus, IconGrid, IconRefresh, IconRows, IconSettings, IconTrash } from "../Icons";
import { SettingsPanel } from "../reader/SettingsPanel";
import { isMobile } from "../../lib/platform";
import { pickRootDir } from "../../lib/tauri";
import logoUrl from "../../assets/logo.svg";
import { CloudSection, DrivePicker } from "./CloudUi";
import { isDriveId, DRIVE_PREFIX } from "../../lib/gdrive";

interface FolderRow {
  type: "folder";
  path: string;
  name: string;
  count: number;
  done: number;
  isArchive: boolean;
  latestMtime: number;
}
interface FileRow {
  type: "file";
  entry: Entry;
}
type Row = FolderRow | FileRow;

const ROW_H = 58;

function isDirectChild(dir: string, base: string): boolean {
  return dir === base;
}

/** True when `path` is `base` itself or lives somewhere below it (segment-aware, so `a\b` is not under `a\bc`). */
export function isUnder(path: string, base: string): boolean {
  const b = base.replace(/[\\/]$/, "");
  if (path === b || path === base) return true;
  if (!path.startsWith(b)) return false;
  const c = path[b.length];
  return c === "\\" || c === "/";
}

/** First path segment of `dir` below `base`. */
function childFolder(dir: string, base: string): string | null {
  const b = base.replace(/[\\/]$/, "");
  if (dir === b || !isUnder(dir, b)) return null;
  const rest = dir.slice(b.length + 1);
  if (!rest) return null;
  const seg = rest.split(/[\\/]/)[0];
  return b + "\\" + seg;
}

function isArchivePath(p: string): boolean {
  return /\.(zip|7z)$/i.test(p) || /\.(zip|7z)\\/i.test(p);
}

export function LibraryView({ onOpen, onStats }: { onOpen: (e: Entry, place?: DevicePos) => void; onStats: () => void }) {
  const { settings, set, addRoot, removeRoot } = useSettings();
  const { entries, scanning, error, scan, changed, cwd, setCwd } = useLibrary();
  const progress = useProgress((st) => st.progress);
  const [query, setQuery] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  /** narrow screens: sidebar slides in as a drawer */
  const [drawer, setDrawer] = useState(false);
  const [drivePicker, setDrivePicker] = useState(false);
  // Android back button closes the drawer / Drive picker before anything else.
  useEffect(() => {
    if (!isMobile() || (!drawer && !drivePicker)) return;
    const l = onBackButtonPress(() => {
      if (drivePicker) setDrivePicker(false);
      else setDrawer(false);
    });
    return () => {
      void l.then((x) => x.unregister());
    };
  }, [drawer, drivePicker]);
  const listRef = useRef<HTMLDivElement>(null);

  const roots = settings.roots;

  const pickFolder = async () => {
    if (isMobile()) {
      const picked = await pickRootDir().catch((e) => {
        console.error(e);
        return null;
      });
      if (!picked) return;
      set({ rootLabels: { ...settings.rootLabels, [picked.id]: picked.name } });
      addRoot(picked.id);
      setCwd(picked.id);
      setDrawer(false);
      return;
    }
    const dir = await open({ directory: true, multiple: false, title: "소설 폴더 선택" });
    if (typeof dir === "string") {
      addRoot(dir);
      if (!cwd) setCwd(dir);
    }
  };
  const addDriveFolder = (folderId: string, name: string) => {
    const root = DRIVE_PREFIX + folderId;
    set({ rootLabels: { ...settings.rootLabels, [root]: name } });
    addRoot(root);
    setCwd(root);
    setDrivePicker(false);
    setDrawer(false);
  };
  /** Display name of a library root (Android roots are URIs, so their name is stored separately). */
  const rootName = (r: string) => settings.rootLabels[r] ?? baseName(r);

  // Where are we? Default to the first root.
  const base = cwd ?? roots[0] ?? null;

  // Group entries under the current folder.
  const rows = useMemo<Row[]>(() => {
    if (!base) return [];
    const q = query.trim().toLowerCase();
    if (q) {
      // Global search across the current root.
      const root = roots.find((r) => isUnder(base, r)) ?? base;
      const hits = entries.filter((e) => e.root === root && e.name.toLowerCase().includes(q)).sort((a, b) => naturalCompare(a.name, b.name));
      return hits.slice(0, 2000).map((entry) => ({ type: "file", entry }));
    }
    const folders = new Map<string, FolderRow>();
    const files: Entry[] = [];
    for (const e of entries) {
      if (isDirectChild(e.dir, base)) {
        files.push(e);
        continue;
      }
      const child = childFolder(e.dir, base);
      if (!child) continue;
      let f = folders.get(child);
      if (!f) {
        f = { type: "folder", path: child, name: baseName(child), count: 0, done: 0, isArchive: isArchivePath(child), latestMtime: 0 };
        folders.set(child, f);
      }
      f.count++;
      const pid = e.kind === "image" ? e.dir : e.id;
      if (progress[pid]?.done) f.done++;
      if (e.mtime > f.latestMtime) f.latestMtime = e.mtime;
    }
    // A folder of images collapses into a single "book" row.
    const imgs = files.filter((e) => e.kind === "image");
    const nonImgs = files.filter((e) => e.kind !== "image");
    const folderRows = [...folders.values()].sort((a, b) => naturalCompare(a.name, b.name));
    let fileRows = nonImgs;
    switch (settings.librarySort) {
      case "recent":
        fileRows = [...nonImgs].sort((a, b) => (progress[b.id]?.updatedAt ?? 0) - (progress[a.id]?.updatedAt ?? 0) || naturalCompare(a.name, b.name));
        break;
      case "added":
        fileRows = [...nonImgs].sort((a, b) => b.mtime - a.mtime || naturalCompare(a.name, b.name));
        break;
      case "progress":
        fileRows = [...nonImgs].sort((a, b) => (progress[b.id]?.pct ?? 0) - (progress[a.id]?.pct ?? 0) || naturalCompare(a.name, b.name));
        break;
      default:
        fileRows = [...nonImgs].sort((a, b) => naturalCompare(a.name, b.name));
    }
    const out: Row[] = [...folderRows, ...fileRows.map((entry): FileRow => ({ type: "file", entry }))];
    if (imgs.length) {
      const first = [...imgs].sort((a, b) => naturalCompare(a.name, b.name))[0];
      out.unshift({ type: "file", entry: { ...first, name: `${roots.includes(base) ? rootName(base) : baseName(base)} (이미지 ${imgs.length}장)` } });
    }
    return out;
  }, [entries, base, query, progress, settings.librarySort, roots]);

  const recent = useMemo(() => {
    const byId = new Map(entries.map((e) => [e.id, e]));
    return Object.entries(progress)
      .filter(([, p]) => !p.done && p.updatedAt)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .map(([id]) => byId.get(id) ?? entries.find((e) => e.kind === "image" && e.dir === id))
      .filter((e): e is Entry => !!e)
      .slice(0, 8);
  }, [entries, progress]);

  // Places read on other devices (Google Drive sync), mapped onto this library.
  const cloudConnected = useCloud((s) => s.connected);
  const positions = useCloud((s) => s.positions);
  const syncIndex = useMemo(() => buildIndex(entries, dirName), [entries, settings.rootLabels]);
  const othersRecent = useMemo(() => {
    if (!cloudConnected) return [];
    const out: { entry: Entry; pos: DevicePos }[] = [];
    for (const [key, list] of Object.entries(positions)) {
      const pid = syncIndex.keyToIds.get(key)?.[0];
      if (!pid || !list.length) continue;
      const entry = entries.find((e) => e.id === pid) ?? entries.find((e) => e.kind === "image" && e.dir === pid);
      if (entry) out.push({ entry, pos: list[0] });
    }
    return out.sort((a, b) => b.pos.updatedAt - a.pos.updatedAt).slice(0, 12);
  }, [cloudConnected, positions, syncIndex, entries]);
  const [recentTab, setRecentTab] = useState<"here" | "others">("here");
  // Nothing read on this device yet: start on what the other devices have.
  useEffect(() => {
    if (!recent.length && othersRecent.length) setRecentTab("others");
  }, [recent.length, othersRecent.length]);
  /** The newest place on another device when it's ahead of this device's own. */
  const aheadElsewhere = (pid: string, p: Progress | undefined): DevicePos | undefined => {
    const key = syncIndex.idToKey.get(pid);
    const top = key ? positions[key]?.[0] : undefined;
    return top && isNewerPlace(top, p) ? top : undefined;
  };

  const crumbs = useMemo(() => {
    if (!base) return [];
    const root = roots.find((r) => isUnder(base, r));
    if (!root) return [{ label: rootName(base), path: base }];
    const rootTrim = root.replace(/[\\/]$/, "");
    const rest = base === rootTrim || base === root ? "" : base.slice(rootTrim.length + 1);
    const out = [{ label: rootName(root), path: root }];
    let acc = rootTrim;
    for (const seg of rest ? rest.split(/[\\/]/) : []) {
      acc += "\\" + seg;
      out.push({ label: seg, path: acc });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, roots, settings.rootLabels]);

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_H,
    overscan: 10,
  });

  const openRow = useCallback(
    (row: Row) => {
      if (row.type === "folder") {
        setCwd(row.path);
        setQuery("");
        listRef.current?.scrollTo({ top: 0 });
      } else onOpen(row.entry);
    },
    [onOpen],
  );

  useEffect(() => {
    if (cwd && !roots.some((r) => isUnder(cwd, r))) setCwd(roots[0] ?? null);
  }, [roots, cwd]);

  const isGrid = settings.libraryView === "grid";

  /** Header line under the folder title: what is here and how much of it is read. */
  const summary = useMemo(() => {
    let folders = 0;
    let books = 0;
    let done = 0;
    for (const r of rows) {
      if (r.type === "folder") {
        folders++;
        done += r.done;
        books += r.count;
      } else {
        books++;
        if (progress[r.entry.kind === "image" ? r.entry.dir : r.entry.id]?.done) done++;
      }
    }
    return { folders, books, done };
  }, [rows, progress]);
  const title = crumbs.length ? crumbs[crumbs.length - 1].label : "";

  return (
    <div className={`library ${drawer ? "drawer-open" : ""}`}>
      <div className="drawer-backdrop" onClick={() => setDrawer(false)} />
      <aside className="sidebar">
        <div className="brand">
          <img className="logo" src={logoUrl} alt="" />
          <span className="wordmark">ELviewer</span>
        </div>
        <div className="section-title">폴더</div>
        <div className="roots">
          {roots.map((r) => (
            <div
              key={r}
              className={`root-item ${base && isUnder(base, r) ? "active" : ""}`}
              onClick={() => {
                setCwd(r);
                setDrawer(false);
              }}
              title={rootName(r)}
            >
              {isDriveId(r) ? (
                <IconCloud className="cloud-mark" style={{ width: 18, height: 18, stroke: "currentColor", fill: "none", strokeWidth: 1.8 }} />
              ) : (
                <IconFolder style={{ width: 18, height: 18, stroke: "currentColor", fill: "none", strokeWidth: 1.8 }} />
              )}
              <span className="name">{rootName(r)}</span>
              <button
                className="icon-btn remove"
                title="목록에서 제거"
                onClick={(e) => {
                  e.stopPropagation();
                  removeRoot(r);
                }}
              >
                <IconTrash />
              </button>
            </div>
          ))}
          {roots.length === 0 && (
            <div className="muted" style={{ padding: "8px 12px", fontSize: 12, lineHeight: 1.5 }}>
              소설이 들어 있는 폴더를 추가하세요. 하위 폴더와 zip/7z 안의 파일까지 자동으로 읽습니다.
            </div>
          )}
        </div>
        <div className="foot">
          <CloudSection onAddFolder={() => setDrivePicker(true)} />
          <button
            className="btn ghost"
            onClick={() => {
              setDrawer(false);
              onStats();
            }}
            style={{ justifyContent: "flex-start" }}
          >
            <IconChart style={{ width: 18, height: 18, stroke: "currentColor", fill: "none", strokeWidth: 1.8 }} />
            읽기 통계
          </button>
          <button className="btn primary" onClick={pickFolder}>
            <IconFolderPlus style={{ width: 18, height: 18, stroke: "currentColor", fill: "none", strokeWidth: 1.8 }} />
            폴더 추가
          </button>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn ghost" style={{ flex: 1 }} onClick={() => scan(roots, true)} disabled={scanning}>
              <IconRefresh style={{ width: 16, height: 16, stroke: "currentColor", fill: "none", strokeWidth: 1.8 }} />
              {scanning ? "검색 중…" : "다시 읽기"}
            </button>
            <button className="btn ghost" onClick={() => setShowSettings(true)} title="설정">
              <IconSettings style={{ width: 16, height: 16, stroke: "currentColor", fill: "none", strokeWidth: 1.8 }} />
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <button className="icon-btn menu-btn" title="메뉴" onClick={() => setDrawer(true)}>
            <IconRows />
          </button>
          <div className="crumbs">
            {crumbs.map((c, i) => (
              <span key={c.path} style={{ display: "contents" }}>
                {i > 0 && <span className="sep">›</span>}
                <button className={i === crumbs.length - 1 ? "current" : ""} onClick={() => setCwd(c.path)}>
                  {c.label}
                </button>
              </span>
            ))}
          </div>
          <input type="search" placeholder="현재 폴더 전체에서 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select value={settings.librarySort} onChange={(e) => set({ librarySort: e.target.value as typeof settings.librarySort })}>
            <option value="name">이름순</option>
            <option value="recent">최근 읽은 순</option>
            <option value="added">최근 수정 순</option>
            <option value="progress">진행률 순</option>
          </select>
          <button className={`icon-btn ${!isGrid ? "active" : ""}`} onClick={() => set({ libraryView: "list" })} title="목록">
            <IconRows />
          </button>
          <button className={`icon-btn ${isGrid ? "active" : ""}`} onClick={() => set({ libraryView: "grid" })} title="바둑판">
            <IconGrid />
          </button>
        </div>

        {roots.length === 0 ? (
          <div className="empty">
            <h2>서재가 비어 있습니다</h2>
            <p>{isMobile() ? "아래 " : "왼쪽의 "}"폴더 추가"로 소설 폴더를 지정하세요. 폴더의 변경 사항은 자동으로 반영됩니다. Google Drive 폴더도 연결할 수 있습니다.</p>
            <p style={{ fontSize: 12 }}>지원 형식: TXT · EPUB · MOBI/AZW3 · FB2 · PDF · DOCX · HWPX · RTF · HTML · MD · CBZ · 이미지 폴더 · ZIP/7Z 내부 파일</p>
            <button className="btn primary" onClick={pickFolder}>
              폴더 추가
            </button>
          </div>
        ) : (
          <>
            <header className="lib-hero">
              {query ? (
                <>
                  <div className="eyebrow">검색</div>
                  <h1 className="display">“{query.trim()}”</h1>
                  <div className="lib-meta">{rows.length.toLocaleString()}개 찾음</div>
                </>
              ) : (
                <>
                  {crumbs.length > 1 && (
                    <nav className="eyebrow hero-crumbs" aria-label="상위 폴더">
                      {crumbs.slice(0, -1).map((c, i) => (
                        <span key={c.path} style={{ display: "contents" }}>
                          {i > 0 && <span className="sep">/</span>}
                          <button onClick={() => setCwd(c.path)}>{c.label}</button>
                        </span>
                      ))}
                    </nav>
                  )}
                  <h1 className="display">{title}</h1>
                  <div className="lib-meta">
                    {summary.folders > 0 && <span>폴더 {summary.folders.toLocaleString()}</span>}
                    <span>파일 {summary.books.toLocaleString()}</span>
                    {summary.done > 0 && <span>완독 {summary.done.toLocaleString()}</span>}
                  </div>
                </>
              )}
            </header>
            {!query && (recent.length > 0 || othersRecent.length > 0) && crumbs.length <= 1 && (
              <div className="recent">
                <div className="recent-head">
                  <h3 className="display">이어 읽기</h3>
                  {othersRecent.length > 0 && (
                    <div className="seg-mini" role="tablist" aria-label="이어 읽기 기록">
                      <button role="tab" aria-selected={recentTab === "here"} className={recentTab === "here" ? "on" : ""} onClick={() => setRecentTab("here")}>
                        이 기기
                      </button>
                      <button role="tab" aria-selected={recentTab === "others"} className={recentTab === "others" ? "on" : ""} onClick={() => setRecentTab("others")}>
                        다른 기기
                      </button>
                    </div>
                  )}
                </div>
                {recentTab === "others" && othersRecent.length > 0 ? (
                  <div className="cards">
                    {othersRecent.map(({ entry: e, pos }) => (
                      <div key={`${e.id}|${pos.dev}`} className="card" onClick={() => onOpen(e, pos)} title={`${pos.name}에서 읽던 곳부터 열기`}>
                        <div className="d dev">
                          <DeviceIcon kind={pos.kind} />
                          <span>
                            {pos.name} · {formatAgo(pos.updatedAt)}
                          </span>
                        </div>
                        <div className="t" title={e.name}>
                          {e.kind === "image" ? dirName(e.dir) : stripExt(e.name)}
                        </div>
                        <div className="card-foot">
                          <div className="bar">
                            <i style={{ width: `${pos.pct * 100}%` }} />
                          </div>
                          <span className="pct">{formatPct(pos.pct)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : recent.length > 0 ? (
                  <div className="cards">
                    {recent.map((e) => {
                      const pid = e.kind === "image" ? e.dir : e.id;
                      const p = progress[pid];
                      const ahead = aheadElsewhere(pid, p);
                      return (
                        <div key={e.id} className="card" onClick={() => onOpen(e)}>
                          {ahead ? (
                            <div className="d dev" title={`${ahead.name}에서 ${formatAgo(ahead.updatedAt)} 더 읽었습니다`}>
                              <DeviceIcon kind={ahead.kind} />
                              <span>
                                {ahead.name}에서 {formatPct(ahead.pct)}
                              </span>
                            </div>
                          ) : (
                            <div className="d">
                              {dirName(e.dir)} · {formatAgo(p?.updatedAt ?? 0)}
                            </div>
                          )}
                          <div className="t" title={e.name}>
                            {e.kind === "image" ? dirName(e.dir) : stripExt(e.name)}
                          </div>
                          <div className="card-foot">
                            <div className="bar">
                              <i style={{ width: `${(p?.pct ?? 0) * 100}%` }} />
                            </div>
                            <span className="pct">{formatPct(p?.pct ?? 0)}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="recent-empty">이 기기에서 읽은 책이 아직 없습니다. "다른 기기"에서 이어 읽어 보세요.</div>
                )}
              </div>
            )}
            {error && (
              <div className="muted" style={{ padding: "8px 18px", color: "var(--danger)" }}>
                {error}
              </div>
            )}
            {isGrid ? (
              <div className="list" ref={listRef}>
                <div className="grid">
                  {rows.map((row) => (
                    <GridTile
                      key={row.type === "folder" ? row.path : row.entry.id}
                      row={row}
                      onOpen={openRow}
                      pct={row.type === "file" ? (progress[row.entry.kind === "image" ? row.entry.dir : row.entry.id]?.pct ?? 0) : row.count ? row.done / row.count : 0}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div className="list" ref={listRef}>
                <div className="list-inner" style={{ height: virt.getTotalSize() }}>
                  {virt.getVirtualItems().map((v) => {
                    const row = rows[v.index];
                    return (
                      <div key={v.key} className="row" style={{ transform: `translateY(${v.start}px)`, height: ROW_H }} onClick={() => openRow(row)}>
                        {row.type === "folder" ? <FolderCells row={row} /> : <FileCells entry={row.entry} progress={progress} changed={changed} />}
                      </div>
                    );
                  })}
                </div>
                {rows.length === 0 && !scanning && <div className="center">{query ? "검색 결과가 없습니다" : "읽을 수 있는 파일이 없습니다"}</div>}
                {scanning && rows.length === 0 && (
                  <div className="center">
                    <div className="spinner" />
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </main>
      {drivePicker && <DrivePicker onPick={addDriveFolder} onClose={() => setDrivePicker(false)} />}
      {showSettings && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50 }} onClick={() => setShowSettings(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            <div style={{ pointerEvents: "auto", position: "absolute", top: 0, right: 0, bottom: 0 }}>
              <SettingsPanel onClose={() => setShowSettings(false)} scope="text" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FolderCells({ row }: { row: FolderRow }) {
  return (
    <>
      <div className={`icon ${row.isArchive ? "" : "folder"}`}>
        {row.isArchive ? (
          <IconArchive style={{ stroke: "currentColor", fill: "none", strokeWidth: 1.8 }} />
        ) : (
          <IconFolder style={{ stroke: "currentColor", fill: "none", strokeWidth: 1.8 }} />
        )}
      </div>
      <div className="info">
        <div className="title">{row.name}</div>
        <div className="sub">
          <span>{row.count.toLocaleString()}개 파일</span>
          {row.done > 0 && <span>· {row.done}개 완독</span>}
        </div>
      </div>
      <div className="right">
        {row.count > 0 && (
          <>
            <div className="bar">
              <i style={{ width: `${(row.done / row.count) * 100}%` }} />
            </div>
            <span>{Math.round((row.done / row.count) * 100)}%</span>
          </>
        )}
      </div>
    </>
  );
}

function FileCells({ entry, progress, changed }: { entry: Entry; progress: Record<string, { pct: number; done?: boolean; mtime?: number; updatedAt: number }>; changed: Set<string> }) {
  const pid = entry.kind === "image" ? entry.dir : entry.id;
  const p = progress[pid];
  const updated = p && ((p.mtime != null && entry.mtime > p.mtime + 1000) || changed.has(entry.id));
  return (
    <>
      <div className="icon">{entry.kind === "image" ? "IMG" : entry.ext.toUpperCase().slice(0, 4)}</div>
      <div className="info">
        <div className="title">
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{entry.kind === "image" ? entry.name : stripExt(entry.name)}</span>
          {updated && <span className="badge new">갱신</span>}
          {p?.done && <span className="badge done">완독</span>}
        </div>
        <div className="sub">
          <span>{formatSize(entry.size)}</span>
          {entry.inArchive && <span>· 압축 파일 내부</span>}
          {p?.updatedAt ? <span>· {new Date(p.updatedAt).toLocaleDateString()}</span> : null}
        </div>
      </div>
      <div className="right">
        {p && (
          <>
            <div className="bar">
              <i style={{ width: `${p.pct * 100}%` }} />
            </div>
            <span>{formatPct(p.pct)}</span>
          </>
        )}
      </div>
    </>
  );
}

/** Cover colors for books without artwork: muted inks that sit well on cream and on navy. */
const COVERS = ["#1c2640", "#7a4a14", "#3f5a4c", "#8c4436", "#3a4558", "#5b4a6b", "#e6dcc6"];
const LIGHT_COVER = "#e6dcc6";

function coverColor(name: string): string {
  let h = 0;
  // Digits are ignored so every volume of a series shares one cover color.
  const key = name.replace(/[\d\s]+/g, "");
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return COVERS[Math.abs(h) % COVERS.length];
}

function GridTile({ row, onOpen, pct }: { row: Row; onOpen: (r: Row) => void; pct: number }) {
  const isFolder = row.type === "folder";
  const name = isFolder ? row.name : row.entry.kind === "image" ? row.entry.name : stripExt(row.entry.name);
  const sub = isFolder ? `${row.count.toLocaleString()}개 파일` : row.entry.kind === "image" ? "IMAGES" : row.entry.ext.toUpperCase();
  const color = coverColor(name);
  return (
    <div className={`tile ${isFolder ? "is-folder" : ""}`} onClick={() => onOpen(row)} title={name}>
      {isFolder ? (
        <div className="cover folder">
          {row.isArchive ? <IconArchive /> : <IconFolder />}
          <span>{sub}</span>
        </div>
      ) : (
        <div className={`cover book ${color === LIGHT_COVER ? "on-light" : ""}`} style={{ background: color }}>
          <span className="cover-title">{name}</span>
          <span className="cover-rule" />
          <span className="cover-fmt">{sub}</span>
        </div>
      )}
      <div className="t">{name}</div>
      <div className="tile-foot">
        <div className="bar">
          <i style={{ width: `${pct * 100}%` }} />
        </div>
        <span>{pct > 0 ? `${Math.round(pct * 100)}%` : ""}</span>
      </div>
    </div>
  );
}
