import { debouncedSaver, loadValue } from "./persist";

/**
 * Deleted bookmark / highlight ids with the time of deletion, so that a sync doesn't
 * bring back from another device something that was removed here.
 */
let tombs: Record<string, number> = {};
let loaded: Promise<void> | null = null;
const save = debouncedSaver<Record<string, number>>("sync.json", "tombstones", 300);

export function loadTombstones(): Promise<Record<string, number>> {
  loaded ??= loadValue<Record<string, number>>("sync.json", "tombstones", {}).then((t) => {
    tombs = { ...t, ...tombs };
  });
  return loaded.then(() => tombs);
}

export function recordDeletion(itemId: string) {
  tombs = { ...tombs, [itemId]: Date.now() };
  save(tombs);
}

export function setTombstones(next: Record<string, number>) {
  tombs = next;
  save(tombs);
}
