import type { Entry } from "../types";

/**
 * Pictures and tables in Markdown / HTML documents. The reader works on plain
 * paragraphs, so each picture or table takes one paragraph: its text (the alt
 * text, or the cells joined) is what search and read-aloud see, and the views
 * draw the block in its place.
 */
export type RichBlock = { kind: "img"; src: string; alt: string } | { kind: "table"; rows: TableRow[] };
export interface TableRow {
  cells: string[];
  /** header cells (<th>, or the Markdown row above the --- line) */
  head: boolean[];
}
export type RichMap = Map<number, RichBlock>;

/** Paragraph text standing for a picture. */
export const imageText = (alt: string) => (alt ? `[그림: ${alt}]` : "[그림]");
/** Paragraph text standing for a table: cells with " · ", rows with " / ". */
export const tableText = (rows: TableRow[]) => rows.map((r) => r.cells.join(" · ")).join(" / ");

// ---- loading pictures -------------------------------------------------------------

const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

/** "a\b/../c/./d" → "a/c/d" (lowercased for lookups). */
export function normalizePath(p: string): string {
  const out: string[] = [];
  for (const part of p.split(/[\\/]+/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/").toLowerCase();
}

export interface ImageLoader {
  /** a URL the <img> can show, or null when the picture can't be found */
  load(src: string): Promise<string | null>;
  dispose(): void;
}

/**
 * Finds the picture a document refers to. Relative paths are looked up among the
 * library's files in the document's folder (works for local folders, Android folders,
 * archives and Google Drive alike); a document on a plain local path also reads the
 * file directly when it isn't in the library. Inline `data:` pictures and web
 * addresses are used as they are.
 */
export function makeImageLoader(doc: Entry, library: readonly Entry[], readBinary: (id: string) => Promise<Uint8Array>): ImageLoader {
  const byPath = new Map<string, Entry>();
  for (const e of library) if (e.kind === "image") byPath.set(normalizePath(`${e.dir}/${e.name}`), e);
  const cache = new Map<string, Promise<string | null>>();
  const urls: string[] = [];
  const plainPath = !doc.inArchive && /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(doc.id) && !doc.id.includes("|");

  const resolve = async (src: string): Promise<string | null> => {
    const s = src.trim();
    if (/^data:image\//i.test(s)) return s;
    if (/^https?:\/\//i.test(s)) return s;
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith("/") || s.startsWith("#")) return null;
    let rel = s.replace(/[?#].*$/, "");
    try {
      rel = decodeURIComponent(rel);
    } catch {
      /* keep as written */
    }
    const ext = rel.split(".").pop()?.toLowerCase() ?? "";
    const mime = MIME[ext];
    if (!mime) return null;
    const key = normalizePath(`${doc.dir}/${rel}`);
    const hit = byPath.get(key);
    let id = hit?.id;
    if (!id && plainPath) {
      // Rebuild the path with the original casing and separator.
      const sep = doc.id.includes("\\") ? "\\" : "/";
      const parts: string[] = [];
      for (const part of `${doc.dir}${sep}${rel}`.split(/[\\/]+/)) {
        if (part === "" || part === ".") continue;
        if (part === "..") parts.pop();
        else parts.push(part);
      }
      id = (doc.id.startsWith("/") ? "/" : doc.id.startsWith("\\\\") ? "\\\\" : "") + parts.join(sep);
    }
    if (!id) return null;
    const bytes = await readBinary(id);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    urls.push(url);
    return url;
  };

  return {
    load(src) {
      let p = cache.get(src);
      if (!p) {
        p = resolve(src).catch(() => null);
        cache.set(src, p);
      }
      return p;
    },
    dispose() {
      for (const u of urls) URL.revokeObjectURL(u);
      urls.length = 0;
      cache.clear();
    },
  };
}
