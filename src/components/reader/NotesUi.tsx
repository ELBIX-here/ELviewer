import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Highlight, HighlightColor } from "../../types";
import { formatPct } from "../../lib/text";
import { PanelShell } from "./Panels";
import { IconTrash } from "../Icons";
import { isMobile } from "../../lib/platform";

export const HL_COLORS: { c: HighlightColor; label: string }[] = [
  { c: "yellow", label: "노랑" },
  { c: "green", label: "초록" },
  { c: "blue", label: "파랑" },
  { c: "pink", label: "분홍" },
];

/** Floating toolbar for a fresh selection or an existing highlight. */
export function SelectionToolbar({
  rect,
  current,
  onColor,
  onNote,
  onCopy,
  onReadFrom,
  onDelete,
  onClose,
}: {
  rect: DOMRect;
  current?: Highlight;
  onColor: (c: HighlightColor) => void;
  onNote: () => void;
  onCopy: () => void;
  onReadFrom?: () => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: rect.left + rect.width / 2, top: rect.top - 8, below: false });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
    // On touch devices the system copy/share menu sits above the selection – go below it.
    const touch = document.documentElement.dataset.platform === "mobile";
    const below = touch ? rect.bottom + h + 60 < window.innerHeight : rect.top - h - 10 < 8;
    setPos({ left, top: below ? rect.bottom + (touch ? 44 : 10) : rect.top - h - 10, below });
  }, [rect]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="sel-toolbar" style={{ left: pos.left, top: pos.top }} onMouseDown={(e) => e.preventDefault()}>
      {HL_COLORS.map(({ c, label }) => (
        <button key={c} className={`hl-dot hl-${c} ${current?.color === c ? "on" : ""}`} title={label} onClick={() => onColor(c)} />
      ))}
      <span className="sep" />
      <button className="tb-btn" onClick={onNote}>
        {current?.note ? "메모 수정" : "메모"}
      </button>
      <button className="tb-btn" onClick={onCopy}>
        복사
      </button>
      {onReadFrom && (
        <button className="tb-btn" onClick={onReadFrom}>
          여기서부터 읽기
        </button>
      )}
      {onDelete && (
        <button className="tb-btn danger" onClick={onDelete}>
          삭제
        </button>
      )}
    </div>
  );
}

export function NoteEditor({ initial, quote, onSave, onCancel }: { initial: string; quote: string; onSave: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="modal-back" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">메모</div>
        <blockquote className="quote">{quote.length > 200 ? quote.slice(0, 200) + "…" : quote}</blockquote>
        <textarea
          ref={ref}
          value={v}
          onChange={(e) => setV(e.target.value)}
          placeholder="이 부분에 대한 생각을 적어 두세요"
          rows={5}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onSave(v);
            e.stopPropagation();
          }}
        />
        <div className="modal-actions">
          <span className="muted" style={{ fontSize: 11 }}>
            Ctrl+Enter 저장
          </span>
          <button className="btn" onClick={onCancel}>
            취소
          </button>
          <button className="btn primary" onClick={() => onSave(v)}>
            저장
          </button>
        </div>
      </div>
    </div>
  );
}

export function NotesPanel({
  items,
  onGo,
  onEdit,
  onRemove,
  onExport,
  onCopyAll,
  onClose,
}: {
  items: Highlight[];
  onGo: (h: Highlight) => void;
  onEdit: (h: Highlight) => void;
  onRemove: (h: Highlight) => void;
  onExport: () => void;
  onCopyAll: () => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<"all" | "notes">("all");
  const shown = filter === "notes" ? items.filter((h) => h.note) : items;
  return (
    <PanelShell
      title={`하이라이트·메모 (${items.length})`}
      onClose={onClose}
      head={
        <div className="search-box" style={{ alignItems: "center" }}>
          <div className="seg">
            <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>
              전체
            </button>
            <button className={filter === "notes" ? "on" : ""} onClick={() => setFilter("notes")}>
              메모만
            </button>
          </div>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onCopyAll} disabled={!items.length}>
            복사
          </button>
          <button className="btn" onClick={onExport} disabled={!items.length}>
            내보내기
          </button>
        </div>
      }
    >
      <div className="panel-body">
        {shown.map((h) => (
          <div key={h.id} className="note-item" onClick={() => onGo(h)}>
            <div className={`note-bar hl-${h.color}`} />
            <div className="note-main">
              <div className="note-text">{h.text.length > 160 ? h.text.slice(0, 160) + "…" : h.text}</div>
              {h.note && <div className="note-note">{h.note}</div>}
              <div className="note-meta">
                <span>{formatPct(h.pct)}</span>
                <button
                  className="link"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(h);
                  }}
                >
                  {h.note ? "메모 수정" : "메모 추가"}
                </button>
              </div>
            </div>
            <button
              className="icon-btn del"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(h);
              }}
            >
              <IconTrash />
            </button>
          </div>
        ))}
        {shown.length === 0 && (
          <div className="center muted" style={{ height: 140, textAlign: "center", padding: 16 }}>
            <span>{filter === "notes" ? "메모가 없습니다" : "하이라이트가 없습니다"}</span>
            <span style={{ fontSize: 12 }}>본문을 {isMobile() ? "길게 눌러 선택하면" : "드래그하면"} 색을 칠하거나 메모를 남길 수 있습니다</span>
          </div>
        )}
      </div>
    </PanelShell>
  );
}

export function notesToMarkdown(title: string, items: Highlight[]): string {
  const lines = [`# ${title}`, "", `> ELviewer 하이라이트·메모 · ${new Date().toLocaleString()}`, ""];
  for (const h of items) {
    lines.push(`- **${formatPct(h.pct)}** — ${h.text.replace(/\n+/g, " ")}`);
    if (h.note) lines.push(`  - 메모: ${h.note.replace(/\n+/g, " ")}`);
  }
  return lines.join("\n") + "\n";
}
