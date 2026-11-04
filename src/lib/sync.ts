import type { Bookmark, Entry, Highlight, Progress } from "../types";
import { baseName } from "./sort";

/**
 * Reading data synced between devices through one JSON file in the Google Drive
 * app data folder. Books are matched by content-ish identity – file name + size,
 * or folder name + image count for image folders – because the same book has a
 * different id on every device (a Windows path, an Android URI, a Drive file id).
 *
 * Every device keeps its own reading position and publishes it under its device id;
 * nothing overwrites another device's place. When a book is opened, the newest
 * position from elsewhere is offered next to this device's own one (see ResumeSheet).
 * Bookmarks and highlights are shared: merged item by item (newest edit wins), with
 * deletions travelling as tombstones so they don't come back.
 */

export interface SyncedProgress {
  pct: number;
  para?: number;
  frac?: number;
  loc?: string;
  page?: number;
  done?: boolean;
  paraCount?: number;
  totalChars?: number;
  updatedAt: number;
}

export type DeviceKind = "pc" | "phone" | "tablet";

export interface DeviceInfo {
  id: string;
  name: string;
  kind: DeviceKind;
}

/** A reading position and the device it was read on. */
export interface DevicePos extends SyncedProgress {
  dev: string;
  name: string;
  kind: DeviceKind;
}

export interface SyncBook {
  /** display name, for humans reading the file */
  name: string;
  /** device id → that device's latest position */
  pos?: Record<string, DevicePos>;
  b?: Bookmark[];
  h?: Highlight[];
}

export interface SyncDoc {
  v: 2;
  savedAt: number;
  books: Record<string, SyncBook>;
  /** deleted bookmark / highlight id → deletion time */
  tomb: Record<string, number>;
}

/** Tombstones older than this are dropped (every device will have synced by then). */
const TOMB_TTL = 180 * 24 * 3600_000;
/** Positions are kept for a year; a device not seen for that long is gone. */
const POS_TTL = 365 * 24 * 3600_000;
/** Device id for positions written by version 1 files, which didn't record devices. */
export const LEGACY_DEVICE = "legacy";

const norm = (s: string) => s.normalize("NFC").toLowerCase().trim();

/** Book key of a file entry; image folders use `imageFolderKey`. */
export const fileKey = (e: Pick<Entry, "name" | "size">) => `f:${norm(e.name)}:${e.size}`;
export const imageFolderKey = (label: string, count: number) => `d:${norm(label)}:${count}`;

/**
 * Library index: device-specific progress id → book key and back. Progress ids are
 * entry ids, except image folders, which are one "book" stored under their folder.
 */
export function buildIndex(entries: Entry[], folderLabel: (dir: string) => string) {
  const idToKey = new Map<string, string>();
  const keyToIds = new Map<string, string[]>();
  const names = new Map<string, string>();
  const add = (id: string, key: string, name: string) => {
    idToKey.set(id, key);
    const list = keyToIds.get(key);
    if (list) list.push(id);
    else keyToIds.set(key, [id]);
    names.set(key, name);
  };
  const imageDirs = new Map<string, number>();
  for (const e of entries) {
    if (e.kind === "image") imageDirs.set(e.dir, (imageDirs.get(e.dir) ?? 0) + 1);
    else add(e.id, fileKey(e), e.name);
  }
  for (const [dir, count] of imageDirs) {
    const label = folderLabel(dir) || baseName(dir);
    add(dir, imageFolderKey(label, count), label);
  }
  return { idToKey, keyToIds, names };
}
export type SyncIndex = ReturnType<typeof buildIndex>;

export interface LocalData {
  progress: Record<string, Progress>;
  bookmarks: Record<string, Bookmark[]>;
  highlights: Record<string, Highlight[]>;
  tomb: Record<string, number>;
}

export function pickProgress(p: Progress): SyncedProgress {
  const { pct, para, frac, loc, page, done, paraCount, totalChars, updatedAt } = p;
  const out: SyncedProgress = { pct, updatedAt };
  if (para != null) out.para = para;
  if (frac != null) out.frac = frac;
  if (loc != null) out.loc = loc;
  if (page != null) out.page = page;
  if (done) out.done = done;
  if (paraCount != null) out.paraCount = paraCount;
  if (totalChars != null) out.totalChars = totalChars;
  return out;
}

function mergeItems<T extends { id: string }>(lists: (T[] | undefined)[], stamp: (t: T) => number, tomb: Record<string, number>): T[] {
  const byId = new Map<string, T>();
  for (const list of lists)
    for (const it of list ?? []) {
      const cur = byId.get(it.id);
      if (!cur || stamp(it) > stamp(cur)) byId.set(it.id, it);
    }
  return [...byId.values()].filter((it) => !(tomb[it.id] >= stamp(it)));
}

const bookmarkStamp = (b: Bookmark) => b.createdAt;
const highlightStamp = (h: Highlight) => h.updatedAt;

/** What this device knows, grouped by book key (books outside the library are left out). */
export function collectLocal(local: LocalData, index: SyncIndex, me: DeviceInfo): Record<string, SyncBook> {
  const out: Record<string, SyncBook> = {};
  const ids = new Set([...Object.keys(local.progress), ...Object.keys(local.bookmarks), ...Object.keys(local.highlights)]);
  for (const id of ids) {
    const key = index.idToKey.get(id);
    if (!key) continue;
    const book = (out[key] ??= { name: index.names.get(key) ?? key });
    const p = local.progress[id];
    // updatedAt 0 = opened but never moved: nothing to share.
    if (p && p.updatedAt && (!book.pos || p.updatedAt > book.pos[me.id].updatedAt)) {
      book.pos = { [me.id]: { ...pickProgress(p), dev: me.id, name: me.name, kind: me.kind } };
    }
    if (local.bookmarks[id]?.length) book.b = mergeItems([book.b, local.bookmarks[id]], bookmarkStamp, {});
    if (local.highlights[id]?.length) book.h = mergeItems([book.h, local.highlights[id]], highlightStamp, {});
  }
  return out;
}

/** Merges the cloud document with this device's data. */
export function mergeDocs(remote: SyncDoc | null, localBooks: Record<string, SyncBook>, localTomb: Record<string, number>, now = Date.now()): SyncDoc {
  const tomb: Record<string, number> = {};
  for (const src of [remote?.tomb ?? {}, localTomb])
    for (const [id, t] of Object.entries(src)) if (now - t < TOMB_TTL && !(tomb[id] >= t)) tomb[id] = t;
  const books: Record<string, SyncBook> = {};
  const keys = new Set([...Object.keys(remote?.books ?? {}), ...Object.keys(localBooks)]);
  for (const key of keys) {
    const r = remote?.books[key];
    const l = localBooks[key];
    const book: SyncBook = { name: r?.name ?? l?.name ?? key };
    const pos: Record<string, DevicePos> = {};
    for (const src of [r?.pos, l?.pos])
      for (const [dev, p] of Object.entries(src ?? {})) if (now - p.updatedAt < POS_TTL && !(pos[dev]?.updatedAt >= p.updatedAt)) pos[dev] = p;
    // A version-1 position is only worth keeping while no device has read further since.
    const legacy = pos[LEGACY_DEVICE];
    if (legacy && Object.values(pos).some((p) => p.dev !== LEGACY_DEVICE && p.updatedAt >= legacy.updatedAt)) delete pos[LEGACY_DEVICE];
    if (Object.keys(pos).length) book.pos = pos;
    const b = mergeItems([r?.b, l?.b], bookmarkStamp, tomb).sort((x, y) => x.pct - y.pct);
    if (b.length) book.b = b;
    const h = mergeItems([r?.h, l?.h], highlightStamp, tomb).sort((x, y) => x.sPara - y.sPara || x.sOff - y.sOff);
    if (h.length) book.h = h;
    books[key] = book;
  }
  return { v: 2, savedAt: now, books, tomb };
}

export interface LocalPatch {
  bookmarks: Record<string, Bookmark[]>;
  highlights: Record<string, Highlight[]>;
}

const sameList = (a: { id: string }[] | undefined, b: { id: string }[] | undefined) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/** Shared notes to apply locally. Reading positions are never overwritten – they are offered. */
export function localPatch(doc: SyncDoc, local: LocalData, index: SyncIndex): LocalPatch {
  const patch: LocalPatch = { bookmarks: {}, highlights: {} };
  for (const [key, book] of Object.entries(doc.books)) {
    for (const id of index.keyToIds.get(key) ?? []) {
      if (!sameList(local.bookmarks[id], book.b) && (book.b?.length || local.bookmarks[id]?.length)) patch.bookmarks[id] = book.b ?? [];
      if (!sameList(local.highlights[id], book.h) && (book.h?.length || local.highlights[id]?.length)) patch.highlights[id] = book.h ?? [];
    }
  }
  return patch;
}

/** Positions read on other devices, per book key, newest first. */
export function otherPositions(doc: SyncDoc, me: string): Record<string, DevicePos[]> {
  const out: Record<string, DevicePos[]> = {};
  for (const [key, book] of Object.entries(doc.books)) {
    const list = Object.values(book.pos ?? {}).filter((p) => p.dev !== me);
    if (list.length) out[key] = list.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return out;
}

/** True when `a` and `b` carry the same data (ignoring savedAt). */
export function sameDoc(a: SyncDoc | null, b: SyncDoc): boolean {
  if (!a) return false;
  return JSON.stringify(a.books) === JSON.stringify(b.books) && JSON.stringify(a.tomb) === JSON.stringify(b.tomb);
}

interface DocV1 {
  v: 1;
  savedAt?: number;
  books: Record<string, { name: string; p?: SyncedProgress; b?: Bookmark[]; h?: Highlight[] }>;
  tomb?: Record<string, number>;
}

export function parseDoc(json: string | null): SyncDoc | null {
  if (!json) return null;
  try {
    const d = JSON.parse(json) as SyncDoc | DocV1;
    if (!d || !d.books) return null;
    if (d.v === 2) return { v: 2, savedAt: d.savedAt ?? 0, books: d.books, tomb: d.tomb ?? {} };
    if (d.v === 1) {
      // Version 1 kept one position per book without saying where it was read.
      const books: Record<string, SyncBook> = {};
      for (const [key, b] of Object.entries(d.books)) {
        const book: SyncBook = { name: b.name };
        if (b.p) book.pos = { [LEGACY_DEVICE]: { ...b.p, dev: LEGACY_DEVICE, name: "다른 기기", kind: "pc" } };
        if (b.b) book.b = b.b;
        if (b.h) book.h = b.h;
        books[key] = book;
      }
      return { v: 2, savedAt: d.savedAt ?? 0, books, tomb: d.tomb ?? {} };
    }
    return null;
  } catch {
    return null;
  }
}
