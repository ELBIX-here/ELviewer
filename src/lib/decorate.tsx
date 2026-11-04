import type { ReactNode } from "react";
import type { Highlight } from "../types";

/** A styled character range inside one paragraph. */
export interface Deco {
  start: number;
  end: number;
  /** css class: "hl hl-yellow", "search", "tts" … */
  cls: string;
  /** highlight id, so clicks on the mark can open the editor */
  id?: string;
  title?: string;
}

export type DecoMap = Map<number, Deco[]>;

export function addDeco(map: DecoMap, para: number, d: Deco) {
  const list = map.get(para);
  if (list) list.push(d);
  else map.set(para, [d]);
}

export function highlightDecos(map: DecoMap, list: Highlight[], paraLen: (p: number) => number) {
  for (const h of list) {
    for (let p = h.sPara; p <= h.ePara; p++) {
      const start = p === h.sPara ? h.sOff : 0;
      const end = p === h.ePara ? h.eOff : paraLen(p);
      if (end > start) addDeco(map, p, { start, end, cls: `hl hl-${h.color}${h.note ? " has-note" : ""}`, id: h.id, title: h.note });
    }
  }
}

export function searchDecos(map: DecoMap, para: number, text: string, query: string) {
  if (!query) return;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let i = lower.indexOf(q);
  while (i >= 0) {
    addDeco(map, para, { start: i, end: i + q.length, cls: "search" });
    i = lower.indexOf(q, i + q.length);
  }
}

/**
 * Renders a paragraph with overlapping decorations. The text is cut at every
 * boundary and each piece gets the union of the classes covering it, so a TTS
 * sentence over a highlight shows both.
 */
export function renderDecorated(text: string, decos: Deco[] | undefined): ReactNode {
  if (!decos || decos.length === 0) return text;
  const cuts = new Set<number>([0, text.length]);
  for (const d of decos) {
    cuts.add(Math.max(0, Math.min(text.length, d.start)));
    cuts.add(Math.max(0, Math.min(text.length, d.end)));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: ReactNode[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a === b) continue;
    const covering = decos.filter((d) => d.start <= a && d.end >= b);
    const piece = text.slice(a, b);
    if (covering.length === 0) out.push(piece);
    else {
      const hl = covering.find((d) => d.id);
      out.push(
        <mark key={a} className={covering.map((d) => d.cls).join(" ")} data-hl={hl?.id} title={hl?.title}>
          {piece}
        </mark>,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// DOM selection ↔ (paragraph, offset)
// ---------------------------------------------------------------------------

function paraOf(node: Node | null): HTMLElement | null {
  let el: Node | null = node;
  while (el && !(el instanceof HTMLElement && el.dataset.index != null)) el = el.parentNode;
  return el as HTMLElement | null;
}

/** Range boundary → character offset inside paragraph `p`. */
function offsetIn(p: HTMLElement, node: Node, offset: number): number {
  if (node.nodeType === Node.TEXT_NODE) return offsetBefore(p, node) + offset;
  // Element boundary: `offset` counts child nodes. Point at the child it precedes,
  // or just past the element's own text when it is the end.
  const child = node.childNodes[offset];
  if (child) return offsetBefore(p, child);
  return offsetBefore(p, node) + (node.textContent?.length ?? 0);
}

function offsetBefore(p: HTMLElement, target: Node): number {
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let len = 0;
  let n = walker.nextNode();
  while (n) {
    if (n === target || target.contains(n)) return len;
    len += n.textContent?.length ?? 0;
    n = walker.nextNode();
  }
  return len;
}

export interface TextRangeSel {
  sPara: number;
  sOff: number;
  ePara: number;
  eOff: number;
  rect: DOMRect;
}

/** Current selection expressed in document coordinates, or null if empty / outside paragraphs. */
export function readSelection(): TextRangeSel | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const sp = paraOf(range.startContainer);
  const ep = paraOf(range.endContainer);
  if (!sp || !ep) return null;
  const sPara = Number(sp.dataset.index);
  const ePara = Number(ep.dataset.index);
  const sOff = offsetIn(sp, range.startContainer, range.startOffset);
  const eOff = offsetIn(ep, range.endContainer, range.endOffset);
  if (sPara === ePara && eOff <= sOff) return null;
  return { sPara, sOff, ePara, eOff, rect: range.getBoundingClientRect() };
}
