import type { SearchHit, TocItem } from "../types";
import type { DecoMap } from "./decorate";

export interface TextDoc {
  paras: string[];
  /** cum[i] = number of characters before paragraph i. Length paras.length + 1. */
  cum: Float64Array;
  total: number;
  toc: TocItem[];
  encoding: string;
  /** formatting kept from the source (Markdown headings, bold, …) */
  styles?: DecoMap;
}

/** Splits text into paragraphs. Optionally collapses runs of blank lines into one. */
export function buildDoc(text: string, collapseBlank: boolean, encoding: string): TextDoc {
  let paras = text.split("\n");
  if (collapseBlank) {
    const out: string[] = [];
    let blank = false;
    for (const p of paras) {
      const isBlank = p.trim().length === 0;
      if (isBlank) {
        if (!blank) out.push("");
        blank = true;
      } else {
        out.push(p);
        blank = false;
      }
    }
    paras = out;
  }
  // Trim trailing blank paragraphs.
  while (paras.length > 1 && paras[paras.length - 1].trim() === "") paras.pop();
  const cum = new Float64Array(paras.length + 1);
  let acc = 0;
  for (let i = 0; i < paras.length; i++) {
    cum[i] = acc;
    acc += paras[i].length + 1;
  }
  cum[paras.length] = acc;
  return { paras, cum, total: Math.max(1, acc), toc: detectToc(paras), encoding };
}

// Strong markers are chapter headings that rarely appear in body text:
// "12화", "제3장", "열일하는 과금 기사 0화", "Chapter 7", "프롤로그" ...
const STRONG_PATTERNS: RegExp[] = [
  /(?:^|\s|[^\d])(?:제\s*)?\d{1,4}\s*(?:화|장|회|편|부|권)(?=\s|$|[.:)\]!,~\-–—])/,
  /^\s*(?:chapter|episode|ep\.?|part|book|vol\.?|volume)\s*\d+/i,
  /^\s*(?:프롤로그|에필로그|서장|종장|외전|번외|막간|prologue|epilogue|interlude)(?=\s|$|[.:)\]!,~\-–—])/i,
];
const LEADING_MARKER =
  /^[\s|#＃\-–—=*·•<\[【〈《(「『]*(?:(?:제\s*)?\d{1,4}\s*(?:화|장|회|편|부|권)|(?:chapter|episode|ep\.?)\s*\d+|프롤로그|에필로그|서장|종장|외전|번외|막간|prologue|epilogue)/i;
// Weak markers are ambiguous ("1. ...", "#3", "【제목】"); used only when no strong ones exist.
const WEAK_PATTERNS: RegExp[] = [/^\s*[#＃]\s*\d+/, /^\s*\d{1,4}\s*[.．:：)]\s*\S/, /^\s*[【《]\s*.{1,40}?\s*[】》]\s*$/];

export function detectToc(paras: string[]): TocItem[] {
  const strong: TocItem[] = [];
  const weak: TocItem[] = [];
  const n = paras.length;
  // Long-line headings are body text; the same line repeated back-to-back is a
  // decorative divider, not two chapters.
  let last = "";
  for (let i = 0; i < n; i++) {
    const p = paras[i];
    if (p.length === 0 || p.length > 50) continue;
    const trimmed = p.trim();
    if (trimmed.length === 0 || trimmed === last) continue;
    last = trimmed;
    // A marker at the very start ("106화. 수호자의 정체 (1)", "| 12화", "제3장 …") is a heading
    // even with punctuation. A marker mid-line counts only if the line isn't a sentence:
    // "열일하는 과금 기사 3화" is a heading, "서버당 1회 구입 가능합니다!" is body text.
    const leading = LEADING_MARKER.test(trimmed);
    const sentenceLike = /[!?,;"“”…]/.test(trimmed) || /[.:]/.test(trimmed.slice(0, -1)) || trimmed.length > 36;
    if ((leading || !sentenceLike) && STRONG_PATTERNS.some((re) => re.test(trimmed))) {
      strong.push({ label: trimmed, para: i, level: 0 });
    } else if (strong.length === 0 && weak.length <= 2000 && WEAK_PATTERNS.some((re) => re.test(trimmed))) {
      weak.push({ label: trimmed, para: i, level: 0 });
    }
  }
  if (strong.length >= 2) return strong;
  // Weak markers only count when they're sparse enough to be headings rather than lists.
  if (weak.length >= 2 && weak.length <= Math.max(300, n / 40)) return weak;
  return strong;
}

/** Binary search: paragraph index that contains character offset `off`. */
export function paraAtOffset(cum: Float64Array, off: number): number {
  let lo = 0;
  let hi = cum.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= off) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function searchText(paras: string[], query: string, limit = 500): SearchHit[] {
  const hits: SearchHit[] = [];
  if (!query) return hits;
  const q = query.toLowerCase();
  for (let i = 0; i < paras.length && hits.length < limit; i++) {
    const p = paras[i];
    const lower = p.toLowerCase();
    let idx = lower.indexOf(q);
    while (idx >= 0 && hits.length < limit) {
      const start = Math.max(0, idx - 30);
      const end = Math.min(p.length, idx + q.length + 50);
      hits.push({ para: i, offset: idx, snippet: (start > 0 ? "…" : "") + p.slice(start, end) + (end < p.length ? "…" : "") });
      idx = lower.indexOf(q, idx + q.length);
    }
  }
  return hits;
}

export function formatPct(pct: number): string {
  return (Math.min(1, Math.max(0, pct)) * 100).toFixed(1) + "%";
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}분`;
  const h = Math.floor(min / 60);
  return `${h}시간 ${min % 60}분`;
}

/** "방금", "5분 전", "3시간 전", "어제", "4일 전", then the date. */
export function formatAgo(t: number, now = Date.now()): string {
  if (!t) return "기록 없음";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  const days = Math.floor(s / 86400);
  if (days === 1) return "어제";
  if (days < 7) return `${days}일 전`;
  return new Date(t).toLocaleDateString();
}