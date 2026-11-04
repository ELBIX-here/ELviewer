declare module "foliate-js/view.js" {
  export interface FoliateTocItem {
    label: string;
    href?: string;
    subitems?: FoliateTocItem[];
  }
  export interface FoliateLocation {
    fraction: number;
    cfi?: string;
    tocItem?: FoliateTocItem;
    location?: { current: number; next: number; total: number };
    section?: { current: number; total: number };
  }
  export interface FoliateRenderer extends HTMLElement {
    setStyles?: (css: string) => void;
    next: () => Promise<void>;
    prev: () => Promise<void>;
  }
  export interface FoliateBook {
    metadata?: { title?: string | Record<string, string>; author?: unknown };
    toc?: FoliateTocItem[];
    sections: unknown[];
    rendition?: { layout?: string };
  }
  export interface FoliateView extends HTMLElement {
    book: FoliateBook;
    renderer: FoliateRenderer;
    lastLocation: FoliateLocation | null;
    open: (file: File | Blob) => Promise<void>;
    close: () => void;
    init: (opts: { lastLocation?: string | number; showTextStart?: boolean }) => Promise<void>;
    goTo: (target: string | number) => Promise<void>;
    goToFraction: (frac: number) => Promise<void>;
    next: () => Promise<void>;
    prev: () => Promise<void>;
    search: (opts: { query: string; matchCase?: boolean; matchDiacritics?: boolean; matchWholeWords?: boolean }) => AsyncGenerator<
      { cfi: string; excerpt: { pre: string; match: string; post: string } } | { progress: number } | "done"
    >;
    clearSearch: () => void;
  }
  export function makeBook(file: File | Blob): Promise<FoliateBook>;
}
