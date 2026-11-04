import type { ReplaceRule } from "../types";

// ---------------------------------------------------------------------------
// Replace rules
// ---------------------------------------------------------------------------

export interface RuleResult {
  text: string;
  /** matches per rule id */
  counts: Record<string, number>;
  errors: Record<string, string>;
}

function compile(rule: ReplaceRule): RegExp {
  if (rule.regex) return new RegExp(rule.find, "gm");
  return new RegExp(rule.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
}

/** Applies enabled rules in order. Regex rules use JS syntax with `gm` flags; `$1` works in the replacement. */
export function applyRules(text: string, rules: ReplaceRule[]): RuleResult {
  const counts: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const r of rules) {
    if (!r.enabled || !r.find) continue;
    try {
      const re = compile(r);
      let n = 0;
      text = text.replace(re, (...args) => {
        n++;
        if (!r.regex) return r.replace;
        // Expand $1..$9 / $& like String.replace would.
        const groups = args.slice(0, -2) as string[];
        return r.replace.replace(/\$(\d|&)/g, (_, g) => (g === "&" ? groups[0] : groups[Number(g)] ?? ""));
      });
      counts[r.id] = n;
    } catch (e) {
      errors[r.id] = String((e as Error).message ?? e);
    }
  }
  return { text, counts, errors };
}

// ---------------------------------------------------------------------------
// Reflow: join hard-wrapped lines
// ---------------------------------------------------------------------------

// A line that ends a sentence / quote / bracket is a real line break.
const TERMINAL = /[.!?…~。！？"'”’」』)\]】》>〉:;♡♥★☆*=\-─━]\s*$/;
// A line that starts dialogue, a list item, a heading marker… starts a new paragraph.
const STARTER = /^\s*["'“‘「『(\[【《<〈\-–—*#=|•·※▶►◆■□●○]/;
const HEADING = /^\s*(?:제\s*)?\d{1,4}\s*(?:화|장|회|편|부|권)|^\s*(?:chapter|episode|prologue|epilogue|프롤로그|에필로그|외전|번외)/i;

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

export interface ReflowStats {
  applied: boolean;
  /** how many line breaks were removed */
  joined: number;
  typical: number;
}

/**
 * Text copied from web novels is often hard-wrapped every N characters, so a
 * sentence is split across lines. Detects that (in "auto") and re-joins lines
 * that continue the same sentence.
 */
export function reflow(text: string, mode: "auto" | "on" | "off"): { text: string; stats: ReflowStats } {
  const none = { text, stats: { applied: false, joined: 0, typical: 0 } };
  if (mode === "off") return none;
  const lines = text.split("\n");
  const lengths = lines.map((l) => l.trimEnd().length).filter((n) => n > 0).sort((a, b) => a - b);
  if (lengths.length < 20) return none;
  const typical = percentile(lengths, 0.85);
  if (typical < 16) return none;

  const isWrapped = (i: number) => {
    const cur = lines[i].trimEnd();
    const next = lines[i + 1];
    if (!next || !next.trim() || !cur.trim()) return false;
    if (cur.length < typical * 0.7) return false;
    if (TERMINAL.test(cur) || STARTER.test(next) || HEADING.test(cur) || HEADING.test(next)) return false;
    return true;
  };

  if (mode === "auto") {
    let candidates = 0;
    let nonEmpty = 0;
    for (let i = 0; i < lines.length - 1; i++) {
      if (!lines[i].trim()) continue;
      nonEmpty++;
      if (isWrapped(i)) candidates++;
    }
    // Normal novel text: nearly every line ends in punctuation. Hard-wrapped text: a large share doesn't.
    if (nonEmpty === 0 || candidates / nonEmpty < 0.2) return none;
  }

  // Wrapping at an exact character count splits words (join without a space); wrapping at
  // word boundaries drops the space (join with one). Exact wrapping makes nearly every
  // wrapped line the same length; word wrapping leaves them ragged.
  const wrappedLens = lines.map((l, i) => (isWrapped(i) ? l.trimEnd().length : -1)).filter((n) => n > 0);
  const exact = wrappedLens.length > 0 && wrappedLens.filter((n) => n === typical).length / wrappedLens.length > 0.8;
  const out: string[] = [];
  let buf = "";
  let joined = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (buf) {
      const glue = buf.endsWith(" ") || line.startsWith(" ") || exact ? "" : " ";
      buf += glue + line.trim();
      joined++;
    } else buf = line;
    if (!isWrapped(i)) {
      out.push(buf);
      buf = "";
    }
  }
  if (buf) out.push(buf);
  return { text: out.join("\n"), stats: { applied: true, joined, typical } };
}

// ---------------------------------------------------------------------------
// Sentence segmentation (for TTS)
// ---------------------------------------------------------------------------

export interface Sentence {
  para: number;
  start: number;
  end: number;
  text: string;
}

const SENT_END = /([.!?…~。！？]+["'”’」』)\]]*)(\s+|$)|(["”」』])(\s+)(?=["“「『])/g;

/** Splits a paragraph into sentences with character offsets. Very short pieces are merged. */
export function splitSentences(para: number, text: string, maxLen = 180): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;
  const push = (end: number) => {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (t) {
      const prev = out[out.length - 1];
      if (prev && (prev.text.length < 6 || t.length < 4) && prev.text.length + t.length < maxLen) {
        prev.end = start + lead + t.length;
        prev.text = text.slice(prev.start, prev.end);
      } else out.push({ para, start: start + lead, end: start + lead + t.length, text: t });
    }
    start = end;
  };
  SENT_END.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENT_END.exec(text))) {
    const end = m.index + (m[1] ? m[1].length : m[3].length);
    push(end);
    // Hard limit for run-on sentences: cut at the last comma/space.
  }
  if (start < text.length) push(text.length);
  // Split anything still too long at commas / spaces.
  const res: Sentence[] = [];
  for (const s of out) {
    if (s.text.length <= maxLen) {
      res.push(s);
      continue;
    }
    let a = s.start;
    while (s.end - a > maxLen) {
      const slice = text.slice(a, a + maxLen);
      const cut = Math.max(slice.lastIndexOf(", "), slice.lastIndexOf(" "));
      const b = a + (cut > maxLen / 3 ? cut + 1 : maxLen);
      res.push({ para, start: a, end: b, text: text.slice(a, b).trim() });
      a = b;
    }
    res.push({ para, start: a, end: s.end, text: text.slice(a, s.end).trim() });
  }
  return res.filter((s) => /[\p{L}\p{N}]/u.test(s.text));
}
