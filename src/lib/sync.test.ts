import { describe, expect, it } from "vitest";
import {
  LEGACY_DEVICE,
  buildIndex,
  collectLocal,
  fileKey,
  localPatch,
  mergeDocs,
  otherPositions,
  parseDoc,
  type DevicePos,
  type LocalData,
  type SyncDoc,
} from "./sync";
import type { Bookmark, Entry } from "../types";

const DAY = 24 * 3600_000;
const NOW = 1_800_000_000_000;

const entry = (id: string, name: string, size: number, kind: Entry["kind"] = "text", dir = "C:\\books"): Entry => ({
  id,
  name,
  dir,
  root: "C:\\books",
  ext: name.split(".").pop() ?? "",
  kind,
  size,
  mtime: 0,
  inArchive: false,
});
const pos = (dev: string, pct: number, updatedAt: number): DevicePos => ({ dev, name: dev, kind: "pc", pct, updatedAt });
const bm = (id: string, createdAt: number, pct = 0.5): Bookmark => ({ id, pct, label: id, createdAt });
const doc = (books: SyncDoc["books"], tomb: Record<string, number> = {}): SyncDoc => ({ v: 2, savedAt: 0, books, tomb });

describe("book identity", () => {
  it("matches the same file on any device by normalized name + size", () => {
    expect(fileKey({ name: "Book.TXT", size: 10 })).toBe(fileKey({ name: " book.txt ", size: 10 }));
    // Hangul stored decomposed (macOS / some Android providers) equals precomposed.
    expect(fileKey({ name: "한글.txt".normalize("NFD"), size: 1 })).toBe(fileKey({ name: "한글.txt", size: 1 }));
    expect(fileKey({ name: "a.txt", size: 1 })).not.toBe(fileKey({ name: "a.txt", size: 2 }));
  });

  it("treats an image folder as one book keyed by folder label and image count", () => {
    const idx = buildIndex(
      [entry("C:\\c\\1.jpg", "1.jpg", 1, "image", "C:\\c"), entry("C:\\c\\2.jpg", "2.jpg", 1, "image", "C:\\c"), entry("C:\\t.txt", "t.txt", 5)],
      () => "만화",
    );
    expect(idx.idToKey.get("C:\\c")).toBe("d:만화:2");
    expect(idx.idToKey.get("C:\\t.txt")).toBe("f:t.txt:5");
    expect(idx.idToKey.has("C:\\c\\1.jpg")).toBe(false);
  });
});

describe("mergeDocs", () => {
  it("keeps one reading position per device; a device's newer position replaces its older one", () => {
    const remote = doc({ k: { name: "b", pos: { pc: pos("pc", 0.2, NOW - 5000), phone: pos("phone", 0.6, NOW - 4000) } } });
    const local = { k: { name: "b", pos: { pc: pos("pc", 0.3, NOW - 1000) } } };
    const out = mergeDocs(remote, local, {}, NOW);
    expect(out.books.k.pos?.pc.pct).toBe(0.3);
    expect(out.books.k.pos?.phone.pct).toBe(0.6);
  });

  it("never lets an older local position overwrite a newer remote one", () => {
    const remote = doc({ k: { name: "b", pos: { pc: pos("pc", 0.9, NOW - 1000) } } });
    const out = mergeDocs(remote, { k: { name: "b", pos: { pc: pos("pc", 0.1, NOW - 9000) } } }, {}, NOW);
    expect(out.books.k.pos?.pc.pct).toBe(0.9);
  });

  it("merges bookmarks from both sides and honours deletions (tombstones)", () => {
    const remote = doc({ k: { name: "b", b: [bm("a", NOW - 5000), bm("gone", NOW - 5000)] } });
    const local = { k: { name: "b", b: [bm("c", NOW - 100)] } };
    const out = mergeDocs(remote, local, { gone: NOW - 1000 }, NOW);
    expect(out.books.k.b?.map((b) => b.id).sort()).toEqual(["a", "c"]);
    expect(out.tomb.gone).toBe(NOW - 1000);
  });

  it("keeps an item re-created after it was deleted", () => {
    const out = mergeDocs(doc({ k: { name: "b", b: [bm("x", NOW - 10)] } }), {}, { x: NOW - 5000 }, NOW);
    expect(out.books.k.b?.map((b) => b.id)).toEqual(["x"]);
  });

  it("forgets tombstones after 180 days and positions after a year", () => {
    const remote = doc({ k: { name: "b", pos: { old: pos("old", 0.5, NOW - 400 * DAY), pc: pos("pc", 0.4, NOW - DAY) } } }, { ancient: NOW - 200 * DAY });
    const out = mergeDocs(remote, {}, {}, NOW);
    expect(out.tomb.ancient).toBeUndefined();
    expect(Object.keys(out.books.k.pos ?? {})).toEqual(["pc"]);
  });

  it("drops a version-1 (device-less) position once a real device has read further", () => {
    const remote = doc({ k: { name: "b", pos: { [LEGACY_DEVICE]: pos(LEGACY_DEVICE, 0.5, NOW - 5000), pc: pos("pc", 0.6, NOW - 1000) } } });
    expect(mergeDocs(remote, {}, {}, NOW).books.k.pos?.[LEGACY_DEVICE]).toBeUndefined();
  });
});

describe("applying the merged document locally", () => {
  const e = entry("C:\\books\\b.txt", "b.txt", 100);
  const index = buildIndex([e], () => "");
  const key = fileKey(e);
  const me = { id: "pc", name: "PC", kind: "pc" as const };
  const empty: LocalData = { progress: {}, bookmarks: {}, highlights: {}, tomb: {} };

  it("collects this device's position under its device id", () => {
    const local: LocalData = { ...empty, progress: { [e.id]: { pct: 0.4, updatedAt: NOW } } };
    const books = collectLocal(local, index, me);
    expect(books[key].pos?.pc).toMatchObject({ pct: 0.4, dev: "pc", name: "PC" });
  });

  it("does not publish a book that was only opened (updatedAt 0)", () => {
    const books = collectLocal({ ...empty, progress: { [e.id]: { pct: 0, updatedAt: 0 } } }, index, me);
    expect(books[key]?.pos).toBeUndefined();
  });

  it("patches shared bookmarks but never reading positions", () => {
    const merged = doc({ [key]: { name: "b", pos: { phone: pos("phone", 0.9, NOW) }, b: [bm("z", NOW)] } });
    const patch = localPatch(merged, { ...empty, progress: { [e.id]: { pct: 0.1, updatedAt: NOW - DAY } } }, index);
    expect(patch.bookmarks[e.id]?.map((b) => b.id)).toEqual(["z"]);
    expect(patch).not.toHaveProperty("progress");
  });

  it("lists other devices' positions newest first, excluding this device", () => {
    const merged = doc({ [key]: { name: "b", pos: { pc: pos("pc", 0.1, NOW), a: pos("a", 0.2, NOW - 2000), b: pos("b", 0.3, NOW - 1000) } } });
    expect(otherPositions(merged, "pc")[key].map((p) => p.dev)).toEqual(["b", "a"]);
  });
});

describe("parseDoc", () => {
  it("upgrades a version-1 file, keeping its position as a legacy device", () => {
    const v1 = JSON.stringify({ v: 1, savedAt: 5, books: { k: { name: "b", p: { pct: 0.5, updatedAt: 9 } } } });
    const d = parseDoc(v1);
    expect(d?.v).toBe(2);
    expect(d?.books.k.pos?.[LEGACY_DEVICE]).toMatchObject({ pct: 0.5, dev: LEGACY_DEVICE });
  });

  it("returns null for missing or broken files", () => {
    expect(parseDoc(null)).toBeNull();
    expect(parseDoc("{not json")).toBeNull();
    expect(parseDoc(JSON.stringify({ v: 3, books: {} }))).toBeNull();
  });
});
