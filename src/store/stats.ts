import { create } from "zustand";
import { debouncedSaver, loadValue } from "../lib/persist";

export interface DayStat {
  ms: number;
  /** characters read (text documents only) */
  chars: number;
  /** ms read per hour of the day, 24 entries */
  hours: number[];
  /** ms per book id */
  books: Record<string, number>;
}

export interface BookStat {
  title: string;
  kind: string;
  ms: number;
  chars: number;
  firstRead: number;
  lastRead: number;
  finishedAt?: number;
}

interface StatsData {
  days: Record<string, DayStat>;
  books: Record<string, BookStat>;
  goalMin: number;
}

interface StatsState extends StatsData {
  hydrated: boolean;
  hydrate: () => Promise<void>;
  record: (bookId: string, meta: { title: string; kind: string }, ms: number, chars: number) => void;
  markFinished: (bookId: string) => void;
  setGoal: (min: number) => void;
}

export function dayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const save = debouncedSaver<StatsData>("stats.json", "stats", 1500);

export const useStats = create<StatsState>((set, get) => ({
  days: {},
  books: {},
  goalMin: 30,
  hydrated: false,
  hydrate: async () => {
    const data = await loadValue<Partial<StatsData>>("stats.json", "stats", {});
    set({ days: data.days ?? {}, books: data.books ?? {}, goalMin: data.goalMin ?? 30, hydrated: true });
  },
  record: (bookId, meta, ms, chars) => {
    const now = new Date();
    const key = dayKey(now);
    const s = get();
    const prevDay = s.days[key] ?? { ms: 0, chars: 0, hours: new Array(24).fill(0), books: {} };
    const hours = [...prevDay.hours];
    hours[now.getHours()] += ms;
    const day: DayStat = {
      ms: prevDay.ms + ms,
      chars: prevDay.chars + chars,
      hours,
      books: { ...prevDay.books, [bookId]: (prevDay.books[bookId] ?? 0) + ms },
    };
    const prevBook = s.books[bookId];
    const book: BookStat = {
      title: meta.title,
      kind: meta.kind,
      ms: (prevBook?.ms ?? 0) + ms,
      chars: (prevBook?.chars ?? 0) + chars,
      firstRead: prevBook?.firstRead ?? now.getTime(),
      lastRead: now.getTime(),
      finishedAt: prevBook?.finishedAt,
    };
    const next = { days: { ...s.days, [key]: day }, books: { ...s.books, [bookId]: book } };
    set(next);
    save({ ...next, goalMin: s.goalMin });
  },
  markFinished: (bookId) => {
    const s = get();
    const b = s.books[bookId];
    if (!b || b.finishedAt) return;
    const books = { ...s.books, [bookId]: { ...b, finishedAt: Date.now() } };
    set({ books });
    save({ days: s.days, books, goalMin: s.goalMin });
  },
  setGoal: (goalMin) => {
    const s = get();
    set({ goalMin });
    save({ days: s.days, books: s.books, goalMin });
  },
}));

// ---------- derived metrics ----------

const DAY_MS = 86400000;
/** A day counts as a reading day once at least a minute was read. */
export const READ_DAY_MS = 60000;

export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export function streaks(days: Record<string, DayStat>): { current: number; best: number } {
  const keys = Object.keys(days)
    .filter((k) => days[k].ms >= READ_DAY_MS)
    .sort();
  let best = 0;
  let run = 0;
  let prev: number | null = null;
  for (const k of keys) {
    const t = new Date(k + "T00:00:00").getTime();
    run = prev !== null && Math.round((t - prev) / DAY_MS) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = t;
  }
  // Current streak: counts today if read, otherwise still alive through yesterday.
  let current = 0;
  let d = new Date();
  if ((days[dayKey(d)]?.ms ?? 0) < READ_DAY_MS) d = addDays(d, -1);
  while ((days[dayKey(d)]?.ms ?? 0) >= READ_DAY_MS) {
    current++;
    d = addDays(d, -1);
  }
  return { current, best };
}

/** Consecutive weeks (Mon–Sun) with at least one reading day, like Kindle's "weeks in a row". */
export function weekStreak(days: Record<string, DayStat>): number {
  const monday = (d: Date) => addDays(d, -((d.getDay() + 6) % 7));
  let start = monday(new Date());
  const weekRead = (s: Date) => {
    for (let i = 0; i < 7; i++) if ((days[dayKey(addDays(s, i))]?.ms ?? 0) >= READ_DAY_MS) return true;
    return false;
  };
  if (!weekRead(start)) start = addDays(start, -7);
  let n = 0;
  while (weekRead(start)) {
    n++;
    start = addDays(start, -7);
  }
  return n;
}

export function sumRange(days: Record<string, DayStat>, from: Date, count: number): number {
  let ms = 0;
  for (let i = 0; i < count; i++) ms += days[dayKey(addDays(from, i))]?.ms ?? 0;
  return ms;
}

/** Characters per minute across all text reading (null until there is enough data). */
export function readingSpeed(books: Record<string, BookStat>): number | null {
  let ms = 0;
  let chars = 0;
  for (const b of Object.values(books)) {
    if (b.chars > 0) {
      ms += b.ms;
      chars += b.chars;
    }
  }
  if (ms < 3 * 60000 || chars < 500) return null;
  return chars / (ms / 60000);
}

export function formatMinutes(ms: number): string {
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}분`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}시간 ${m}분` : `${h}시간`;
}
