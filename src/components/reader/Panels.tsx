import { useEffect, useRef, useState } from "react";
import type { Bookmark, SearchHit, TocItem } from "../../types";
import { formatPct } from "../../lib/text";
import { IconClose, IconTrash } from "../Icons";

export function PanelShell({ title, onClose, children, head }: { title: string; onClose: () => void; children: React.ReactNode; head?: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="panel" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div className="panel-head">
        <span>{title}</span>
        <button className="icon-btn" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      {head}
      {children}
    </div>
  );
}

export function TocPanel({ items, current, onGo, onClose }: { items: TocItem[]; current?: number; onGo: (t: TocItem) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (current == null) return;
    const el = ref.current?.querySelector<HTMLElement>(`[data-i="${current}"]`);
    el?.scrollIntoView({ block: "center" });
  }, [current]);
  return (
    <PanelShell title={`목차 (${items.length})`} onClose={onClose}>
      <div className="panel-body" ref={ref}>
        {items.map((t, i) => (
          <div key={i} data-i={i} className={`panel-item ${current === i ? "active" : ""}`} style={{ paddingLeft: 10 + t.level * 14 }} onClick={() => onGo(t)}>
            <span className="lbl">{t.label}</span>
          </div>
        ))}
        {items.length === 0 && <div className="center muted" style={{ height: 120 }}>감지된 목차가 없습니다</div>}
      </div>
    </PanelShell>
  );
}

export function BookmarksPanel({ items, onGo, onRemove, onClose }: { items: Bookmark[]; onGo: (b: Bookmark) => void; onRemove: (id: string) => void; onClose: () => void }) {
  return (
    <PanelShell title={`책갈피 (${items.length})`} onClose={onClose}>
      <div className="panel-body">
        {items.map((b) => (
          <div key={b.id} className="panel-item" onClick={() => onGo(b)}>
            <span className="lbl wrap">{b.label}</span>
            <span className="meta">{formatPct(b.pct)}</span>
            <button
              className="icon-btn del"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(b.id);
              }}
            >
              <IconTrash />
            </button>
          </div>
        ))}
        {items.length === 0 && (
          <div className="center muted" style={{ height: 120 }}>
            <span>책갈피가 없습니다</span>
            <span style={{ fontSize: 12 }}>
              읽는 중 <kbd>B</kbd> 를 누르면 추가됩니다
            </span>
          </div>
        )}
      </div>
    </PanelShell>
  );
}

export function SearchPanel({ onSearch, onGo, onClose }: { onSearch: (q: string) => Promise<SearchHit[]> | SearchHit[]; onGo: (h: SearchHit) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const run = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try {
      const r = await onSearch(q.trim());
      setHits(r);
      setActive(-1);
    } finally {
      setBusy(false);
    }
  };

  const go = (i: number) => {
    if (i < 0 || i >= hits.length) return;
    setActive(i);
    onGo(hits[i]);
  };

  const highlight = (s: string) => {
    const i = s.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return s;
    return (
      <>
        {s.slice(0, i)}
        <mark>{s.slice(i, i + q.length)}</mark>
        {s.slice(i + q.length)}
      </>
    );
  };

  return (
    <PanelShell
      title="검색"
      onClose={onClose}
      head={
        <div className="search-box">
          <input
            ref={inputRef}
            type="search"
            placeholder="본문 검색…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (hits.length && !e.shiftKey && active >= 0) go((active + 1) % hits.length);
                else void run();
              }
              if (e.key === "F3") {
                e.preventDefault();
                go(e.shiftKey ? (active - 1 + hits.length) % hits.length : (active + 1) % hits.length);
              }
            }}
          />
          <button className="btn" onClick={run} disabled={busy}>
            {busy ? "…" : "찾기"}
          </button>
        </div>
      }
    >
      <div className="panel-body">
        {hits.length > 0 && (
          <div className="muted" style={{ padding: "4px 10px 8px", fontSize: 12 }}>
            {hits.length}
            {hits.length >= 500 ? "+" : ""}건 · Enter로 다음 결과
          </div>
        )}
        {hits.map((h, i) => (
          <div key={i} className={`panel-item ${active === i ? "active" : ""}`} onClick={() => go(i)}>
            <span className="lbl wrap" style={{ fontSize: 12.5 }}>
              {highlight(h.snippet)}
            </span>
          </div>
        ))}
        {!busy && q && hits.length === 0 && <div className="center muted" style={{ height: 100 }}>결과 없음</div>}
      </div>
    </PanelShell>
  );
}
