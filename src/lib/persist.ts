import { load, type Store } from "@tauri-apps/plugin-store";

const stores = new Map<string, Promise<Store>>();

function store(name: string): Promise<Store> {
  let s = stores.get(name);
  if (!s) {
    s = load(name, { autoSave: 300, defaults: {} });
    stores.set(name, s);
  }
  return s;
}

export async function loadValue<T>(file: string, key: string, fallback: T): Promise<T> {
  try {
    const s = await store(file);
    const v = await s.get<T>(key);
    return v ?? fallback;
  } catch (e) {
    console.error("store load failed", file, key, e);
    return fallback;
  }
}

export async function saveValue<T>(file: string, key: string, value: T): Promise<void> {
  try {
    const s = await store(file);
    await s.set(key, value);
  } catch (e) {
    console.error("store save failed", file, key, e);
  }
}

/** Returns a debounced saver – repeated calls within `ms` collapse into one write. */
export function debouncedSaver<T>(file: string, key: string, ms = 500): (value: T) => void {
  let timer: number | undefined;
  let pending: T;
  return (value: T) => {
    pending = value;
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      void saveValue(file, key, pending);
    }, ms);
  };
}
