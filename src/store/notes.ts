import { create } from "zustand";
import type { Highlight } from "../types";
import { debouncedSaver, loadValue } from "../lib/persist";
import { recordDeletion } from "../lib/tombstones";

export const NO_HIGHLIGHTS: Highlight[] = [];

interface NotesState {
  highlights: Record<string, Highlight[]>;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  add: (fileId: string, h: Omit<Highlight, "id" | "createdAt" | "updatedAt">) => Highlight;
  update: (fileId: string, id: string, patch: Partial<Highlight>) => void;
  remove: (fileId: string, id: string) => void;
  /** Cloud sync: replace the lists of the given files, keeping timestamps. */
  applySync: (patch: Record<string, Highlight[]>) => void;
}

const save = debouncedSaver<Record<string, Highlight[]>>("highlights.json", "highlights", 300);

export const byPosition = (a: Highlight, b: Highlight) => a.sPara - b.sPara || a.sOff - b.sOff;

export const useNotes = create<NotesState>((set, get) => ({
  highlights: {},
  hydrated: false,
  hydrate: async () => {
    const highlights = await loadValue<Record<string, Highlight[]>>("highlights.json", "highlights", {});
    set({ highlights, hydrated: true });
  },
  add: (fileId, h) => {
    const now = Date.now();
    const hl: Highlight = { ...h, id: `${now}-${Math.random().toString(36).slice(2, 7)}`, createdAt: now, updatedAt: now };
    const list = [...(get().highlights[fileId] ?? []), hl].sort(byPosition);
    const highlights = { ...get().highlights, [fileId]: list };
    set({ highlights });
    save(highlights);
    return hl;
  },
  update: (fileId, id, patch) => {
    const list = (get().highlights[fileId] ?? []).map((h) => (h.id === id ? { ...h, ...patch, updatedAt: Date.now() } : h));
    const highlights = { ...get().highlights, [fileId]: list };
    set({ highlights });
    save(highlights);
  },
  remove: (fileId, id) => {
    const highlights = { ...get().highlights, [fileId]: (get().highlights[fileId] ?? []).filter((h) => h.id !== id) };
    set({ highlights });
    save(highlights);
    recordDeletion(id);
  },
  applySync: (patch) => {
    if (!Object.keys(patch).length) return;
    const highlights = { ...get().highlights, ...patch };
    set({ highlights });
    save(highlights);
  },
}));
