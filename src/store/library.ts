import { create } from "zustand";
import type { Entry } from "../types";
import { scanLibrary, watchRoots } from "../lib/tauri";
import { isDriveId, scanDrive } from "../lib/gdrive";
import { dirName } from "./settings";

interface LibraryState {
  entries: Entry[];
  scanning: boolean;
  error: string | null;
  lastScan: number;
  /** ids of files whose on-disk content changed since they were last scanned */
  changed: Set<string>;
  /** folder currently shown in the library; kept here so it survives opening a book */
  cwd: string | null;
  setCwd: (cwd: string | null) => void;
  /** `force`: also relist Google Drive folders that were scanned a moment ago */
  scan: (roots: string[], force?: boolean) => Promise<void>;
  markChanged: (paths: string[]) => void;
  clearChanged: (id: string) => void;
}

export const useLibrary = create<LibraryState>((set, get) => ({
  entries: [],
  scanning: false,
  error: null,
  lastScan: 0,
  changed: new Set(),
  cwd: null,
  setCwd: (cwd) => set({ cwd }),
  scan: async (roots, force = false) => {
    set({ scanning: true, error: null });
    const local = roots.filter((r) => !isDriveId(r));
    const remote = roots.filter(isDriveId);
    try {
      const [localEntries, driveResult] = await Promise.all([
        scanLibrary(local),
        remote.length ? scanDrive(remote, force, dirName) : Promise.resolve({ entries: [], error: null }),
      ]);
      set({
        entries: [...localEntries, ...driveResult.entries],
        scanning: false,
        lastScan: Date.now(),
        error: driveResult.error ? `Google Drive: ${driveResult.error}` : null,
      });
      await watchRoots(local);
    } catch (e) {
      set({ scanning: false, error: String(e) });
    }
  },
  markChanged: (paths) => {
    const changed = new Set(get().changed);
    for (const p of paths) changed.add(p);
    set({ changed });
  },
  clearChanged: (id) => {
    if (!get().changed.has(id)) return;
    const changed = new Set(get().changed);
    changed.delete(id);
    set({ changed });
  },
}));
