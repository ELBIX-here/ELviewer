import { create } from "zustand";
import type { Bookmark, Progress } from "../types";
import { debouncedSaver, loadValue } from "../lib/persist";
import { recordDeletion } from "../lib/tombstones";

interface ProgressState {
  progress: Record<string, Progress>;
  bookmarks: Record<string, Bookmark[]>;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  update: (id: string, patch: Partial<Progress>) => void;
  addReadTime: (id: string, ms: number) => void;
  markDone: (id: string, done: boolean) => void;
  clear: (id: string) => void;
  addBookmark: (fileId: string, b: Omit<Bookmark, "id" | "createdAt">) => void;
  removeBookmark: (fileId: string, id: string) => void;
  /** Cloud sync: replace records wholesale, keeping their timestamps. */
  applySync: (progress: Record<string, Progress>, bookmarks: Record<string, Bookmark[]>) => void;
}

/** Stable empty list for selectors – a fresh `[]` per call would re-render forever. */
export const NO_BOOKMARKS: Bookmark[] = [];

const saveProgress = debouncedSaver<Record<string, Progress>>("progress.json", "progress", 800);
const saveBookmarks = debouncedSaver<Record<string, Bookmark[]>>("bookmarks.json", "bookmarks", 300);

/**
 * Whether `next` is a different reading position than `prev`. Readers report their
 * position on open too; only real moves count as "read more recently" – otherwise
 * opening a book on one device would beat the further position synced from another.
 */
function moved(prev: Progress, next: Progress): boolean {
  return (
    (prev.para ?? 0) !== (next.para ?? 0) ||
    // An ebook's first report adds a location at the very start – not a move.
    (prev.loc != null && prev.loc !== next.loc) ||
    (prev.page ?? 0) !== (next.page ?? 0) ||
    !!prev.done !== !!next.done ||
    Math.abs((prev.pct ?? 0) - (next.pct ?? 0)) > 0.0005 ||
    Math.abs((prev.frac ?? 0) - (next.frac ?? 0)) > 0.05
  );
}

export const useProgress = create<ProgressState>((set, get) => ({
  progress: {},
  bookmarks: {},
  hydrated: false,
  hydrate: async () => {
    const [progress, bookmarks] = await Promise.all([
      loadValue<Record<string, Progress>>("progress.json", "progress", {}),
      loadValue<Record<string, Bookmark[]>>("bookmarks.json", "bookmarks", {}),
    ]);
    set({ progress, bookmarks, hydrated: true });
  },
  update: (id, patch) => {
    const prev = get().progress[id] ?? { pct: 0, updatedAt: 0 };
    const next: Progress = { ...prev, ...patch };
    if (next.pct >= 0.995) next.done = true;
    next.updatedAt = moved(prev, next) ? Date.now() : prev.updatedAt;
    const progress = { ...get().progress, [id]: next };
    set({ progress });
    saveProgress(progress);
  },
  addReadTime: (id, ms) => {
    const prev = get().progress[id];
    if (!prev) return;
    const progress = { ...get().progress, [id]: { ...prev, readMs: (prev.readMs ?? 0) + ms } };
    set({ progress });
    saveProgress(progress);
  },
  markDone: (id, done) => {
    const prev = get().progress[id] ?? { pct: 0, updatedAt: 0 };
    const progress = { ...get().progress, [id]: { ...prev, done, pct: done ? 1 : prev.pct, updatedAt: Date.now() } };
    set({ progress });
    saveProgress(progress);
  },
  clear: (id) => {
    const progress = { ...get().progress };
    delete progress[id];
    set({ progress });
    saveProgress(progress);
  },
  addBookmark: (fileId, b) => {
    const list = get().bookmarks[fileId] ?? [];
    const bm: Bookmark = { ...b, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, createdAt: Date.now() };
    const bookmarks = { ...get().bookmarks, [fileId]: [...list, bm].sort((x, y) => x.pct - y.pct) };
    set({ bookmarks });
    saveBookmarks(bookmarks);
  },
  removeBookmark: (fileId, id) => {
    const list = (get().bookmarks[fileId] ?? []).filter((b) => b.id !== id);
    const bookmarks = { ...get().bookmarks, [fileId]: list };
    set({ bookmarks });
    saveBookmarks(bookmarks);
    recordDeletion(id);
  },
  applySync: (patchP, patchB) => {
    const progress = { ...get().progress, ...patchP };
    const bookmarks = { ...get().bookmarks, ...patchB };
    set({ progress, bookmarks });
    if (Object.keys(patchP).length) saveProgress(progress);
    if (Object.keys(patchB).length) saveBookmarks(bookmarks);
  },
}));
