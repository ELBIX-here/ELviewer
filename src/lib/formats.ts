import type { Kind } from "../types";

/** Mirrors `kind_for_ext` in the Rust backend. */
export function kindForExt(ext: string): Kind | null {
  switch (ext.toLowerCase()) {
    case "txt":
    case "text":
    case "log":
    case "md":
    case "markdown":
    case "html":
    case "htm":
    case "xhtml":
    case "docx":
    case "hwpx":
    case "hwp":
    case "rtf":
      return "text";
    case "epub":
    case "mobi":
    case "azw":
    case "azw3":
    case "prc":
    case "kf8":
    case "fb2":
    case "cbz":
      return "ebook";
    case "pdf":
      return "pdf";
    case "jpg":
    case "jpeg":
    case "png":
    case "gif":
    case "webp":
    case "avif":
    case "bmp":
      return "image";
    default:
      return null;
  }
}
