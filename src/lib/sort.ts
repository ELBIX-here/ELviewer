import type { Entry } from "../types";

export const collator = new Intl.Collator(["ko", "en"], { numeric: true, sensitivity: "base" });

export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b);
}

export function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => naturalCompare(a.name, b.name));
}

/** Files in the same folder as `entry`, of the same kind, in natural order. */
export function siblings(all: Entry[], entry: Entry): Entry[] {
  return sortEntries(all.filter((e) => e.dir === entry.dir && e.kind === entry.kind));
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/|]/);
  return parts[parts.length - 1] || path;
}

export function stripExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}
