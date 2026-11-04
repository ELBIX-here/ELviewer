import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSettings } from "../../store/settings";
import { isAndroid, setVolumeKeyPaging } from "../../lib/platform";

export interface ReaderKeyHandlers {
  enabled: boolean;
  next: () => void;
  prev: () => void;
  home?: () => void;
  end?: () => void;
  back: () => void;
  toggleMode?: () => void;
  toggleToc?: () => void;
  toggleSearch?: () => void;
  toggleBookmark?: () => void;
  toggleAuto?: () => void;
  fontDelta?: (d: number) => void;
  prevFile?: () => void;
  nextFile?: () => void;
  toggleUi?: () => void;
  /** turning a page from the keyboard / volume keys puts the chrome away */
  hideUi?: () => void;
  toggleTts?: () => void;
  toggleNotes?: () => void;
}

function isTyping(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable;
}

/** Global keyboard shortcuts shared by all reader types. */
export function useReaderKeys(h: ReaderKeyHandlers) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape / the Android back button must work even while a book failed to load.
      if (!h.enabled && e.key !== "Escape") return;
      if (e.key === "Escape") {
        if (isTyping()) (document.activeElement as HTMLElement).blur();
        h.back();
        return;
      }
      if (isTyping()) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const next = () => {
        h.hideUi?.();
        h.next();
      };
      const prev = () => {
        h.hideUi?.();
        h.prev();
      };
      switch (e.key) {
        case "ArrowRight":
          if (ctrl) h.nextFile?.();
          else next();
          break;
        case "ArrowLeft":
          if (ctrl) h.prevFile?.();
          else prev();
          break;
        case "PageDown":
        case "ArrowDown":
          next();
          break;
        case "PageUp":
        case "ArrowUp":
          prev();
          break;
        case " ":
          e.preventDefault();
          if (e.shiftKey) prev();
          else next();
          break;
        case "Home":
          h.home?.();
          break;
        case "End":
          h.end?.();
          break;
        case "F11":
          e.preventDefault();
          if (document.documentElement.dataset.platform === "mobile") break;
          void getCurrentWindow()
            .isFullscreen()
            .then((fs) => getCurrentWindow().setFullscreen(!fs));
          break;
        case "f":
        case "F":
          if (ctrl) {
            e.preventDefault();
            h.toggleSearch?.();
          }
          break;
        case "m":
        case "M":
          if (!ctrl) h.toggleMode?.();
          break;
        case "t":
        case "T":
          if (!ctrl) h.toggleToc?.();
          break;
        case "b":
        case "B":
          if (!ctrl) h.toggleBookmark?.();
          break;
        case "a":
        case "A":
          if (!ctrl) h.toggleAuto?.();
          break;
        case "+":
        case "=":
          if (ctrl) {
            e.preventDefault();
            h.fontDelta?.(1);
          }
          break;
        case "-":
        case "_":
          if (ctrl) {
            e.preventDefault();
            h.fontDelta?.(-1);
          }
          break;
        case "r":
        case "R":
          if (!ctrl) h.toggleTts?.();
          break;
        case "n":
        case "N":
          if (!ctrl) h.toggleNotes?.();
          break;
        case "Enter":
          e.preventDefault();
          h.toggleUi?.();
          break;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [h]);

  const volumePaging = useSettings((s) => s.settings.volumeKeyPaging) && h.enabled;
  useEffect(() => {
    if (!volumePaging || !isAndroid()) return;
    setVolumeKeyPaging(true);
    return () => setVolumeKeyPaging(false);
  }, [volumePaging]);
}
