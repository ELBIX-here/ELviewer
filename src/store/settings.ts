import { create } from "zustand";
import type { Settings, ThemeName } from "../types";
import { debouncedSaver, loadValue } from "../lib/persist";
import { baseName } from "../lib/sort";

export const DEFAULT_FONT = '"EL Sans", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';

export const FONT_PRESETS: { label: string; value: string }[] = [
  { label: "EL Sans (기본)", value: DEFAULT_FONT },
  { label: "맑은 고딕", value: '"Malgun Gothic", sans-serif' },
  { label: "나눔고딕", value: '"NanumGothic", "Nanum Gothic", sans-serif' },
  { label: "Noto Sans KR", value: '"Noto Sans KR", sans-serif' },
  { label: "나눔명조", value: '"NanumMyeongjo", "Nanum Myeongjo", serif' },
  { label: "Noto Serif KR", value: '"Noto Serif KR", serif' },
  { label: "KoPub 바탕", value: '"KoPubWorldBatang", "KoPub Batang", serif' },
  { label: "바탕", value: '"Batang", serif' },
  { label: "굴림", value: '"Gulim", sans-serif' },
  { label: "돋움", value: '"Dotum", sans-serif' },
  { label: "시스템 기본", value: "system-ui, sans-serif" },
  { label: "고정폭", value: '"D2Coding", "Consolas", monospace' },
];

export const THEMES: Record<Exclude<ThemeName, "custom">, { label: string; bg: string; fg: string }> = {
  // Warm "paper & ink" palette, drawn from the hourglass icon (navy / paper / sand).
  light: { label: "라이트", bg: "#faf8f3", fg: "#24211c" },
  dark: { label: "다크", bg: "#171c29", fg: "#dad3c4" },
  sepia: { label: "세피아", bg: "#f3ead8", fg: "#47392a" },
  black: { label: "블랙 (OLED)", bg: "#000000", fg: "#c9c3b6" },
};

export const DEFAULT_SETTINGS: Settings = {
  roots: [],
  theme: "dark",
  customBg: "#1c2640",
  customFg: "#e9e1d0",
  fontFamily: DEFAULT_FONT,
  fontSize: 19,
  lineHeight: 1.8,
  letterSpacing: 0,
  paragraphSpacing: 0.6,
  textIndent: 0,
  maxWidth: 820,
  padding: 48,
  textAlign: "left",
  readMode: "scroll",
  columns: 1,
  animation: "slide",
  collapseBlank: true,
  autoScrollSpeed: 40,
  autoPageSec: 20,
  librarySort: "name",
  libraryView: "list",
  uiAutoHideSec: 0,
  showMiniProgress: true,
  volumeKeyPaging: true,
  syncOpen: "ask",
  encodingOverrides: {},
  reflow: "auto",
  replaceRules: [],
  autoNextFile: true,
  ttsVoice: "F1",
  ttsSpeed: 1.0,
  ttsSteps: 8,
  ttsGap: 0.25,
  ttsVolume: 1,
  ttsFollow: true,
  rootLabels: {},
};

interface SettingsState {
  settings: Settings;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  set: (patch: Partial<Settings>) => void;
  addRoot: (root: string) => void;
  removeRoot: (root: string) => void;
}

const save = debouncedSaver<Settings>("settings.json", "settings", 400);

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  hydrated: false,
  hydrate: async () => {
    const stored = await loadValue<Partial<Settings>>("settings.json", "settings", {});
    // Settings saved before EL Sans shipped point at the old default stack – move them over.
    if (stored.fontFamily && stored.fontFamily.startsWith('"Pretendard"')) stored.fontFamily = DEFAULT_FONT;
    // Phones: narrower margins and a slightly smaller default type size.
    const base = document.documentElement.dataset.platform === "mobile" ? { ...DEFAULT_SETTINGS, padding: 18, fontSize: 18 } : DEFAULT_SETTINGS;
    set({ settings: { ...base, ...stored }, hydrated: true });
  },
  set: (patch) => {
    const next = { ...get().settings, ...patch };
    set({ settings: next });
    save(next);
  },
  addRoot: (root) => {
    const roots = get().settings.roots;
    if (!roots.includes(root)) get().set({ roots: [...roots, root] });
  },
  removeRoot: (root) => {
    const rootLabels = { ...get().settings.rootLabels };
    delete rootLabels[root];
    get().set({ roots: get().settings.roots.filter((r) => r !== root), rootLabels });
  },
}));

export function themeColors(s: Settings): { bg: string; fg: string } {
  if (s.theme === "custom") return { bg: s.customBg, fg: s.customFg };
  return THEMES[s.theme];
}

/** Display name of a folder: the stored label for library roots (Android folder URIs), else its last segment. */
export function dirName(dir: string): string {
  return useSettings.getState().settings.rootLabels[dir] ?? baseName(dir);
}
