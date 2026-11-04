export type Kind = "text" | "ebook" | "pdf" | "image";

export interface Entry {
  id: string;
  name: string;
  dir: string;
  root: string;
  ext: string;
  kind: Kind;
  size: number;
  mtime: number;
  inArchive: boolean;
}

export interface Progress {
  /** 0..1 */
  pct: number;
  /** text: paragraph index */
  para?: number;
  /** text: fraction inside the paragraph (scroll mode) */
  frac?: number;
  /** ebook: CFI / location string */
  loc?: string;
  /** pdf / image: page index */
  page?: number;
  updatedAt: number;
  /** mtime of the file when last read – used for the "updated" badge */
  mtime?: number;
  done?: boolean;
  /** accumulated reading time in ms */
  readMs?: number;
  /** text documents: total character count, for time-left estimates */
  totalChars?: number;
  /** text documents: paragraph count when `para` was saved; if the layout pipeline
   *  (reflow, replace rules) changes it, the position is restored from `pct` instead */
  paraCount?: number;
}

export type HighlightColor = "yellow" | "green" | "blue" | "pink";

export interface Highlight {
  id: string;
  /** start/end as paragraph index + character offset inside that paragraph */
  sPara: number;
  sOff: number;
  ePara: number;
  eOff: number;
  /** the highlighted text at creation time – shown in the list and used to re-anchor */
  text: string;
  color: HighlightColor;
  note?: string;
  pct: number;
  /** paragraph count of the document when created – if it changes (reflow, rules), re-anchor by text */
  paraCount?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ReplaceRule {
  id: string;
  find: string;
  replace: string;
  regex: boolean;
  enabled: boolean;
}

export interface Bookmark {
  id: string;
  pct: number;
  para?: number;
  loc?: string;
  page?: number;
  label: string;
  createdAt: number;
}

export interface TocItem {
  label: string;
  /** text: paragraph index */
  para?: number;
  /** ebook: href */
  href?: string;
  /** pdf: page index */
  page?: number;
  level: number;
}

export interface SearchHit {
  para: number;
  offset: number;
  snippet: string;
  loc?: string;
}

export type ThemeName = "light" | "dark" | "sepia" | "black" | "custom";
export type ReadMode = "scroll" | "page";

export interface Settings {
  roots: string[];
  theme: ThemeName;
  customBg: string;
  customFg: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  paragraphSpacing: number;
  textIndent: number;
  maxWidth: number;
  padding: number;
  textAlign: "left" | "justify";
  readMode: ReadMode;
  /** pages side by side in page mode; 0 = automatic (two on wide screens, e.g. an unfolded foldable) */
  columns: 0 | 1 | 2;
  animation: "none" | "slide" | "fade";
  collapseBlank: boolean;
  autoScrollSpeed: number;
  autoPageSec: number;
  librarySort: "name" | "recent" | "added" | "progress";
  libraryView: "list" | "grid";
  /** seconds before the chrome hides itself again after being shown; 0 = only on click */
  uiAutoHideSec: number;
  /** thin progress line + % while the chrome is hidden */
  showMiniProgress: boolean;
  /** a book read further on another device: ask where to start, or always take the newest place */
  syncOpen: "ask" | "latest";
  /** Android: volume up/down turn pages while reading */
  volumeKeyPaging: boolean;
  encodingOverrides: Record<string, string>;
  /** join hard-wrapped lines back into paragraphs */
  reflow: "auto" | "on" | "off";
  replaceRules: ReplaceRule[];
  /** turning past the last page opens the next file in the folder */
  autoNextFile: boolean;
  ttsVoice: string;
  ttsSpeed: number;
  /** flow-matching steps: 5 fast, 8 standard, 12 high quality */
  ttsSteps: number;
  /** pause between sentences, seconds */
  ttsGap: number;
  ttsVolume: number;
  ttsFollow: boolean;
  /** Android: system TTS voice id ("" = the engine's Korean default) */
  ttsSystemVoice: string;
  /** Android: system TTS pitch, 1 = normal */
  ttsPitch: number;
  /** display names for library roots whose id isn't a readable path (Android folder URIs) */
  rootLabels: Record<string, string>;
}
