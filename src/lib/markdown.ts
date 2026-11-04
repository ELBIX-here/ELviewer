import type { TocItem } from "../types";
import type { Deco, DecoMap } from "./decorate";

/**
 * Markdown → reader paragraphs. Not a full CommonMark renderer: novels written in
 * Markdown use a handful of constructs, and the reader shows plain paragraphs, so the
 * markup is removed and what it meant is kept as styles over the remaining text
 * (headings, bold, italic, code, quotes). Offsets of those styles are in the cleaned
 * text, so highlights, search and read-aloud keep working on what is on screen.
 */
export interface MarkdownDoc {
  /** one paragraph per line, no blank lines */
  text: string;
  toc: TocItem[];
  /** paragraph index → styled ranges */
  styles: DecoMap;
}

interface Para {
  text: string;
  decos: Deco[];
}

const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const THEMATIC = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const REF_DEF = /^ {0,3}\[[^\]]+\]:\s*\S+/;
const WORD = /[\p{L}\p{N}]/u;

// ---- inline -------------------------------------------------------------------

const INLINE = new RegExp(
  [
    String.raw`\\([\\` + "`" + String.raw`*_{}\[\]()#+\-.!~|>])`, // 1 escape
    String.raw`(` + "`" + String.raw`+)([\s\S]*?[^` + "`" + String.raw`])\2(?!` + "`" + `)`, // 2,3 code span
    String.raw`!\[([^\]]*)\]\([^)]*\)`, // 4 image
    String.raw`\[([^\]]+)\]\([^)]*\)`, // 5 link
    String.raw`\[([^\]]+)\]\[[^\]]*\]`, // 6 reference link
    String.raw`<((?:https?|mailto):[^>\s]+)>`, // 7 autolink
    String.raw`<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>`, // html tag / comment
    String.raw`(\*\*\*|___)(?=\S)([\s\S]*?\S)\8`, // 8,9 bold italic
    String.raw`(\*\*|__)(?=\S)([\s\S]*?\S)\10`, // 10,11 bold
    String.raw`(\*|_)(?=\S)([\s\S]*?\S)\12`, // 12,13 italic
    String.raw`~~(?=\S)([\s\S]*?\S)~~`, // 14 strikethrough
  ].join("|"),
  "gu",
);

/** Strips inline markup; returns the text and the styles it stood for. */
export function inline(src: string): Para {
  let text = "";
  const decos: Deco[] = [];
  let last = 0;
  const nested = (inner: string, cls: string) => {
    const r = inline(inner);
    const at = text.length;
    for (const d of r.decos) decos.push({ ...d, start: d.start + at, end: d.end + at });
    text += r.text;
    decos.push({ start: at, end: text.length, cls });
  };
  // A fresh regex per call: `nested` recurses, and a shared global regex would lose its place.
  const re = new RegExp(INLINE.source, INLINE.flags);
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const start = m.index;
    const end = start + m[0].length;
    // `_` inside a word (snake_case, 한글_이름) is not emphasis.
    const delim = m[8] ?? m[10] ?? m[12];
    if (delim?.startsWith("_") && ((start > 0 && WORD.test(src[start - 1])) || (end < src.length && WORD.test(src[end])))) {
      re.lastIndex = start + 1;
      continue;
    }
    text += src.slice(last, start);
    last = end;
    if (m[1] != null) text += m[1];
    else if (m[2] != null) {
      const at = text.length;
      text += m[3].replace(/^ (.*) $/, "$1");
      decos.push({ start: at, end: text.length, cls: "md-code" });
    } else if (m[4] != null) text += m[4] ? `[그림: ${m[4]}]` : "[그림]";
    else if (m[5] != null) nested(m[5], "md-link");
    else if (m[6] != null) nested(m[6], "md-link");
    else if (m[7] != null) text += m[7];
    else if (m[8] != null) nested(m[9], "md-b md-i");
    else if (m[10] != null) nested(m[11], "md-b");
    else if (m[12] != null) nested(m[13], "md-i");
    else if (m[14] != null) nested(m[14], "md-s");
    // else: html tag – dropped
  }
  text += src.slice(last);
  return { text, decos };
}

// ---- blocks -------------------------------------------------------------------

/**
 * Many novels in .md put every paragraph on its own line without blank lines between
 * them. Strict Markdown would glue such lines into one block; when blank lines are rare,
 * each line is taken as a paragraph instead.
 */
function lineMode(lines: string[]): boolean {
  let blank = 0;
  let filled = 0;
  for (const l of lines) {
    if (l.trim()) filled++;
    else blank++;
  }
  return filled > 0 && blank / filled < 0.2;
}

export function markdownToDoc(src: string): MarkdownDoc {
  let lines = src.replace(/\r\n?/g, "\n").split("\n");
  // YAML front matter
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (close > 0) lines = lines.slice(close + 1);
  }
  const perLine = lineMode(lines);
  const paras: Para[] = [];
  const toc: TocItem[] = [];
  let buf: string[] = [];
  let bufCls = "";
  /** the last plain paragraph pushed in line mode, for setext headings under it */
  let lastPlain: { line: number; para: number; raw: string } | null = null;

  const push = (p: Para, cls = "") => {
    if (!p.text.trim()) return;
    if (cls) p.decos.unshift({ start: 0, end: p.text.length, cls });
    paras.push(p);
  };
  const flush = () => {
    if (!buf.length) return;
    // Soft-wrapped lines join with a space; a line ending in two spaces or "\" is a hard break.
    const parts: string[] = [];
    let cur = "";
    for (const l of buf) {
      const hard = / {2,}$/.test(l) || /\\$/.test(l);
      const piece = l.replace(/\\$/, "").trim();
      cur = cur ? `${cur} ${piece}` : piece;
      if (hard) {
        parts.push(cur);
        cur = "";
      }
    }
    if (cur) parts.push(cur);
    for (const part of parts) push(inline(part), bufCls);
    buf = [];
    bufCls = "";
  };
  const heading = (level: number, raw: string) => {
    const p = inline(raw);
    if (!p.text.trim()) return;
    toc.push({ label: p.text.trim(), para: paras.length, level: Math.max(0, level - 1) });
    push(p, `md-h md-h${Math.min(level, 4)}`);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const marker = fence[1];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(marker); i++) {
        if (lines[i].trim()) push({ text: lines[i].replace(/\t/g, "    "), decos: [] }, "md-code md-pre");
      }
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      heading(h[1].length, h[2] ?? "");
      continue;
    }
    // Setext heading: a paragraph line underlined with === or ---
    if (/^ {0,3}(=+|-+)\s*$/.test(line)) {
      const level = line.trim().startsWith("=") ? 1 : 2;
      // Novels also put "---" straight under prose as a scene break: under a long or
      // multi-line paragraph it stays a divider, only a short line becomes a heading.
      const titleLike = (s: string) => level === 1 || s.trim().length <= 50;
      if (buf.length && !bufCls && (level === 1 || buf.length === 1) && titleLike(buf[0])) {
        const raw = buf.join(" ");
        buf = [];
        heading(level, raw);
        continue;
      }
      if (lastPlain && lastPlain.line === i - 1 && lastPlain.para === paras.length - 1 && titleLike(lastPlain.raw)) {
        paras.pop();
        heading(level, lastPlain.raw);
        lastPlain = null;
        continue;
      }
    }
    if (THEMATIC.test(line)) {
      flush();
      push({ text: "* * *", decos: [] }, "md-hr");
      continue;
    }
    if (REF_DEF.test(line)) continue;
    if (TABLE_ROW.test(line)) {
      flush();
      if (TABLE_RULE.test(line)) continue;
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      push(inline(cells.join("  ·  ")), "md-table");
      continue;
    }
    const q = QUOTE.exec(line);
    if (q) {
      if (bufCls !== "md-quote") flush();
      bufCls = "md-quote";
      if (!q[1].trim()) flush();
      else {
        buf.push(q[1]);
        if (perLine) flush();
      }
      continue;
    }
    const li = LIST.exec(line);
    if (li) {
      flush();
      const depth = Math.floor(li[1].replace(/\t/g, "    ").length / 2);
      const bullet = /\d/.test(li[2]) ? `${li[2].replace(")", ".")} ` : "• ";
      const body = inline(li[3].replace(/^\[([ xX])\]\s+/, (_, c) => (c === " " ? "☐ " : "☑ ")));
      const lead = "　".repeat(Math.min(depth, 4)) + bullet;
      push({ text: lead + body.text, decos: body.decos.map((d) => ({ ...d, start: d.start + lead.length, end: d.end + lead.length })) });
      continue;
    }
    if (bufCls) flush();
    buf.push(line);
    if (perLine) {
      const before = paras.length;
      flush();
      lastPlain = paras.length > before ? { line: i, para: paras.length - 1, raw: line } : null;
    }
  }
  flush();

  const styles: DecoMap = new Map();
  paras.forEach((p, i) => {
    if (p.decos.length) styles.set(i, p.decos);
  });
  return { text: paras.map((p) => p.text.replace(/\n/g, " ")).join("\n"), toc, styles };
}

export const isMarkdownExt = (ext: string) => ext === "md" || ext === "markdown";
