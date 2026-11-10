import type { TocItem } from "../types";
import type { Deco, DecoMap } from "./decorate";
import type { MarkdownDoc } from "./markdown";

/**
 * HTML → reader paragraphs, the same shape the Markdown converter produces: the
 * markup is removed and what it meant is kept as styles over the remaining text
 * (headings, bold, italic, code, quotes, lists, tables), headings become the table
 * of contents. Images and tables don't fit a paragraph reader, so an image becomes
 * "[그림: alt]" and a table row becomes one line of cells.
 *
 * The document is parsed with DOMParser and never attached to the page, so its
 * scripts don't run and its images and styles aren't loaded.
 */
export function htmlToDoc(src: string, parser: { parseFromString(s: string, type: "text/html"): Document } = new DOMParser()): MarkdownDoc {
  const dom = parser.parseFromString(src, "text/html");
  const paras: { text: string; decos: Deco[] }[] = [];
  const toc: TocItem[] = [];

  // The paragraph being filled.
  let text = "";
  let decos: Deco[] = [];
  /** list bullet waiting for the item's first text */
  let lead = "";
  /** inline styles open around the current position */
  const open: { cls: string; start: number }[] = [];

  interface Ctx {
    /** block styles over whole paragraphs (quote, table row, heading) */
    cls: string;
    heading: number;
    pre: boolean;
    depth: number;
  }

  const flush = (ctx: Ctx) => {
    // Drop the trailing space left by whitespace collapsing.
    const t = text.replace(/[ \t ]+$/, "");
    for (const o of open) if (t.length > o.start) decos.push({ start: o.start, end: t.length, cls: o.cls });
    for (const o of open) o.start = 0;
    const list = decos.map((d) => ({ ...d, end: Math.min(d.end, t.length) })).filter((d) => d.end > d.start);
    text = "";
    decos = [];
    if (!t.trim()) return;
    if (ctx.heading) toc.push({ label: t.trim(), para: paras.length, level: ctx.heading - 1 });
    const cls = [ctx.cls, ctx.heading ? `md-h md-h${Math.min(ctx.heading, 4)}` : ""].filter(Boolean).join(" ");
    if (cls) list.unshift({ start: 0, end: t.length, cls });
    paras.push({ text: t, decos: list });
  };

  const append = (s: string, ctx: Ctx) => {
    if (!ctx.pre) {
      s = s.replace(/\s+/g, " ");
      if (!text || text.endsWith(" ")) s = s.replace(/^ /, "");
    }
    if (!s) return;
    if (!text && lead) {
      text = lead;
      lead = "";
    }
    text += s;
  };

  const inlineCls: Record<string, string> = {
    b: "md-b",
    strong: "md-b",
    th: "md-b",
    i: "md-i",
    em: "md-i",
    cite: "md-i",
    dfn: "md-i",
    var: "md-i",
    s: "md-s",
    del: "md-s",
    strike: "md-s",
    code: "md-code",
    kbd: "md-code",
    samp: "md-code",
    tt: "md-code",
    a: "md-link",
    u: "md-u",
    ins: "md-u",
    mark: "md-mark",
  };
  const SKIP = new Set(["script", "style", "head", "noscript", "template", "svg", "math", "iframe", "object", "nav", "button", "select", "input", "textarea", "rt", "rp"]);
  const BLOCK = new Set([
    "p", "div", "section", "article", "main", "header", "footer", "aside", "figure", "figcaption", "address", "center",
    "ul", "ol", "dl", "dt", "dd", "table", "thead", "tbody", "tfoot", "caption", "form", "fieldset", "details", "summary", "body", "html",
  ]);

  const walk = (node: Node, ctx: Ctx) => {
    if (node.nodeType === 3) {
      const v = node.nodeValue ?? "";
      if (!ctx.pre) return append(v, ctx);
      // Preformatted text: one paragraph per line.
      const lines = v.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
      lines.forEach((l, i) => {
        if (i > 0) flush(ctx);
        append(l, ctx);
      });
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag) || el.hasAttribute("hidden")) return;
    const children = () => el.childNodes.forEach((c) => walk(c, ctx));

    if (tag === "br") return flush(ctx);
    if (tag === "img") {
      const alt = (el.getAttribute("alt") ?? "").trim();
      append(alt ? ` [그림: ${alt}] ` : " [그림] ", ctx);
      return;
    }
    if (tag === "hr") {
      flush(ctx);
      paras.push({ text: "* * *", decos: [{ start: 0, end: 5, cls: "md-hr" }] });
      return;
    }
    if (/^h[1-6]$/.test(tag)) return block({ ...ctx, heading: Number(tag[1]) });
    if (tag === "blockquote") return block({ ...ctx, cls: join(ctx.cls, "md-quote") });
    if (tag === "pre") return block({ ...ctx, cls: join(ctx.cls, "md-code md-pre"), pre: true });
    if (tag === "tr") return block({ ...ctx, cls: join(ctx.cls, "md-table") });
    if (tag === "ul" || tag === "ol") return block({ ...ctx, depth: ctx.depth + 1 });
    if (tag === "li") {
      flush(ctx);
      const parent = el.parentElement;
      let bullet = "• ";
      if (parent?.tagName.toLowerCase() === "ol") {
        const items = [...parent.children].filter((c) => c.tagName.toLowerCase() === "li");
        bullet = `${Number(parent.getAttribute("start") ?? 1) + items.indexOf(el)}. `;
      }
      lead = "　".repeat(Math.min(Math.max(ctx.depth - 1, 0), 4)) + bullet;
      children();
      flush(ctx);
      lead = "";
      return;
    }
    if (tag === "td" || tag === "th") {
      if (text.trim()) append("  ·  ", { ...ctx, pre: true });
    } else if (BLOCK.has(tag)) {
      return block(ctx);
    }
    // Inline element.
    const cls = inlineCls[tag];
    if (!cls) return children();
    const o = { cls, start: text.length };
    open.push(o);
    children();
    open.splice(open.indexOf(o), 1);
    if (text.length > o.start) decos.push({ start: o.start, end: text.length, cls });

    function block(inner: Ctx) {
      flush(ctx);
      el.childNodes.forEach((c) => walk(c, inner));
      flush(inner);
    }
  };

  const root: Ctx = { cls: "", heading: 0, pre: false, depth: 0 };
  walk(dom.body ?? dom.documentElement, root);
  flush(root);

  // Only one heading (usually the page title) isn't a table of contents: let the
  // chapter detector look at the text instead.
  const styles: DecoMap = new Map();
  paras.forEach((p, i) => {
    if (p.decos.length) styles.set(i, p.decos);
  });
  return { text: paras.map((p) => p.text.replace(/\n/g, " ")).join("\n"), toc: toc.length >= 2 ? toc : [], styles };
}

function join(a: string, b: string) {
  return a ? `${a} ${b}` : b;
}

export const isHtmlExt = (ext: string) => ext === "html" || ext === "htm" || ext === "xhtml";
