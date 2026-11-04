import { create } from "zustand";
import type { Entry, Progress } from "../types";
import * as drive from "../lib/gdrive";
import {
  buildIndex,
  collectLocal,
  fileKey,
  imageFolderKey,
  localPatch,
  mergeDocs,
  otherPositions,
  parseDoc,
  sameDoc,
  type DeviceInfo,
  type DevicePos,
} from "../lib/sync";
import { loadTombstones, setTombstones } from "../lib/tombstones";
import { loadValue, saveValue } from "../lib/persist";
import { deviceIdentity } from "../lib/platform";
import { useProgress } from "./progress";
import { useNotes } from "./notes";
import { useLibrary } from "./library";
import { dirName, useSettings } from "./settings";

interface Saved {
  connected: boolean;
  email: string | null;
  lastSync: number;
}

interface CloudState extends Saved {
  hydrated: boolean;
  /** this build can sign in (desktop needs a compiled-in OAuth client) */
  available: boolean;
  connecting: boolean;
  syncing: boolean;
  error: string | null;
  /** Google stopped accepting the sign-in (revoked, or a test-mode grant expired): sign in again */
  needsReauth: boolean;
  /** this device, as other devices see it */
  device: DeviceInfo | null;
  /** book key → positions read on other devices, newest first (kept for offline use) */
  positions: Record<string, DevicePos[]>;
  /** a newer place from another device for the book on screen */
  offer: { id: string; pos: DevicePos } | null;
  hydrate: () => Promise<void>;
  connect: () => Promise<void>;
  cancelConnect: () => void;
  disconnect: () => Promise<void>;
  /** Pull, merge, apply and push. `openId` = progress id of the book on screen. */
  sync: (openId?: string | null) => Promise<void>;
  /** Move the open book to the offered place (the reader then reopens there). */
  acceptOffer: () => void;
  dismissOffer: () => void;
}

const persist = (s: Saved) => saveValue("gdrive.json", "account", s);

let running: Promise<void> | null = null;
let again = false;
/** offers the user waved away: progress id → updatedAt of the dismissed place */
const dismissed = new Map<string, number>();

export const useCloud = create<CloudState>((set, get) => ({
  connected: false,
  email: null,
  lastSync: 0,
  hydrated: false,
  available: false,
  connecting: false,
  syncing: false,
  error: null,
  needsReauth: false,
  device: null,
  positions: {},
  offer: null,

  hydrate: async () => {
    const [saved, available, savedId, positions, ident] = await Promise.all([
      loadValue<Saved>("gdrive.json", "account", { connected: false, email: null, lastSync: 0 }),
      drive.authAvailable(),
      loadValue<string>("gdrive.json", "deviceId", ""),
      loadValue<Record<string, DevicePos[]>>("gdrive.json", "positions", {}),
      deviceIdentity(),
    ]);
    // A random id per installation tells devices apart even when they share a name.
    const id = savedId || (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    if (!savedId) await saveValue("gdrive.json", "deviceId", id);
    set({ ...saved, available, positions, device: { id, ...ident }, hydrated: true });
  },

  connect: async () => {
    set({ connecting: true, error: null });
    try {
      const email = await drive.connect();
      const s = { connected: true, email, lastSync: get().lastSync };
      set({ ...s, connecting: false, needsReauth: false });
      await persist(s);
      // Drive folders that failed while signed out: list them again (clears their error).
      void useLibrary.getState().scan(useSettings.getState().settings.roots, true);
      await get().sync();
    } catch (e) {
      set({ connecting: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  cancelConnect: () => drive.cancelConnect(),

  disconnect: async () => {
    await drive.disconnect();
    const s = { connected: false, email: null, lastSync: 0 };
    set({ ...s, error: null, offer: null, positions: {}, needsReauth: false });
    await persist(s);
    await saveValue("gdrive.json", "positions", {});
  },

  sync: async (openId) => {
    if (!get().connected || !get().device) return;
    // One run at a time; a request during a run schedules one more afterwards.
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      set({ syncing: true });
      try {
        do {
          again = false;
          await syncOnce(openId ?? null, get().device!, set);
        } while (again);
        const s = { connected: true, email: get().email, lastSync: Date.now() };
        set({ lastSync: s.lastSync, error: null, needsReauth: false });
        await persist(s);
      } catch (e) {
        // Lost sign-ins get their own prompt (needsReauth) rather than an error line.
        if (!(e instanceof drive.DriveAuthError)) set({ error: e instanceof Error ? e.message : String(e) });
        console.warn("sync failed", e);
      } finally {
        set({ syncing: false });
        running = null;
      }
    })();
    return running;
  },

  acceptOffer: () => {
    const o = get().offer;
    if (!o) return;
    applyPlace(o.id, o.pos);
    set({ offer: null });
  },
  dismissOffer: () => {
    const o = get().offer;
    if (o) dismissed.set(o.id, o.pos.updatedAt);
    set({ offer: null });
  },
}));

drive.authEvents.addEventListener("lost", () => {
  if (useCloud.getState().connected) useCloud.setState({ needsReauth: true });
});

async function syncOnce(openId: string | null, me: DeviceInfo, set: (p: Partial<CloudState>) => void) {
  const entries = useLibrary.getState().entries;
  const index = buildIndex(entries, dirName);
  const remote = parseDoc(await drive.readSyncFile());
  // Read local state after the download, so edits made meanwhile are included.
  const { progress, bookmarks } = useProgress.getState();
  const { highlights } = useNotes.getState();
  const tomb = await loadTombstones();
  const local = { progress, bookmarks, highlights, tomb };

  const merged = mergeDocs(remote, collectLocal(local, index, me), tomb);
  const patch = localPatch(merged, local, index);
  useProgress.getState().applySync({}, patch.bookmarks);
  useNotes.getState().applySync(patch.highlights);
  setTombstones(merged.tomb);

  const positions = otherPositions(merged, me.id);
  set({ positions });
  await saveValue("gdrive.json", "positions", positions);

  // The book on screen was read further somewhere else since: offer to go there.
  if (openId) {
    const key = index.idToKey.get(openId);
    const top = key ? positions[key]?.[0] : undefined;
    if (top && isNewerPlace(top, progress[openId]) && dismissed.get(openId) !== top.updatedAt) set({ offer: { id: openId, pos: top } });
  }

  if (!sameDoc(remote, merged)) await drive.writeSyncFile(JSON.stringify(merged));
}

// ---- resume choices -------------------------------------------------------------

/** Progress id of an entry: image folders are one book stored under their folder. */
export const progressId = (e: Entry) => (e.kind === "image" ? e.dir : e.id);

/** Sync key of an entry – the same on every device that has the book. */
export function bookKey(e: Entry): string {
  if (e.kind !== "image") return fileKey(e);
  const count = useLibrary.getState().entries.filter((x) => x.kind === "image" && x.dir === e.dir).length;
  return imageFolderKey(dirName(e.dir), count);
}

/** Another device's place is worth mentioning: read later than here, and somewhere else. */
export function isNewerPlace(other: DevicePos, here: Progress | undefined): boolean {
  if (!here) return other.pct > 0.001 || !!other.loc || (other.para ?? 0) > 0 || (other.page ?? 0) > 0;
  if (other.updatedAt <= here.updatedAt) return false;
  const samePlace =
    Math.abs(other.pct - here.pct) < 0.001 && (other.para ?? 0) === (here.para ?? 0) && (other.page ?? 0) === (here.page ?? 0) && (!other.loc || other.loc === here.loc);
  return !samePlace;
}

/** Places offered when opening `e`: other devices' newer places (newest first) and this device's own. */
export function resumeChoices(e: Entry): { here: Progress | undefined; others: DevicePos[] } {
  const here = useProgress.getState().progress[progressId(e)];
  const all = useCloud.getState().positions[bookKey(e)] ?? [];
  return { here, others: all.filter((p) => isNewerPlace(p, here)).slice(0, 3) };
}

/** Make `pos` (or the beginning) this device's reading position for progress id `id`. */
export function applyPlace(id: string, pos: DevicePos | "start") {
  const here = useProgress.getState().progress[id];
  // Keep what is this device's own (reading time, file mtime for the "updated" badge).
  const keep: Partial<Progress> = { readMs: here?.readMs, mtime: here?.mtime, totalChars: here?.totalChars };
  const next: Progress =
    pos === "start"
      ? { ...keep, pct: 0, para: 0, frac: 0, page: 0, done: false, paraCount: here?.paraCount, updatedAt: here?.updatedAt ?? 0 }
      : {
          ...keep,
          pct: pos.pct,
          para: pos.para,
          frac: pos.frac,
          loc: pos.loc,
          page: pos.page,
          done: !!pos.done,
          paraCount: pos.paraCount,
          totalChars: pos.totalChars ?? here?.totalChars,
          // Taking over a place isn't reading: keep its time, so it doesn't look newer than it is.
          updatedAt: Math.max(pos.updatedAt, here?.updatedAt ?? 0),
        };
  useProgress.getState().applySync({ [id]: next }, {});
}
