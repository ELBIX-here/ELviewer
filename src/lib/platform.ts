import { invoke } from "@tauri-apps/api/core";

let os = "";

/** Call once at startup (before rendering) so `isMobile()` can be used synchronously. */
export async function initPlatform(): Promise<void> {
  try {
    os = await invoke<string>("app_platform");
  } catch {
    os = /android/i.test(navigator.userAgent) ? "android" : "";
  }
  document.documentElement.dataset.platform = isMobile() ? "mobile" : "desktop";
  if (isAndroid()) watchAndroidInsets();
}

/** Android: system bar sizes come from MainActivity (window.ElInsets) as --inset-* CSS variables. */
function watchAndroidInsets() {
  const bridge = (window as unknown as { ElInsets?: { get(): string } }).ElInsets;
  if (!bridge) return;
  const apply = () => {
    try {
      const v = JSON.parse(bridge.get()) as Record<string, number>;
      const s = document.documentElement.style;
      for (const side of ["top", "right", "bottom", "left"]) s.setProperty(`--inset-${side}`, `${v[side] ?? 0}px`);
    } catch {
      /* bridge not ready */
    }
  };
  apply();
  window.addEventListener("elinsets", apply);
  window.addEventListener("resize", apply);
  // Insets arrive asynchronously right after launch.
  setTimeout(apply, 300);
  setTimeout(apply, 1500);
}

/**
 * Android: while on, MainActivity swallows the volume keys and sends them to the page
 * as PageDown (volume down) / PageUp (volume up) keydown events.
 */
export function setVolumeKeyPaging(on: boolean) {
  const bridge = (window as unknown as { ElKeys?: { setVolumePaging(on: boolean): void } }).ElKeys;
  try {
    bridge?.setVolumePaging(on);
  } catch {
    /* bridge unavailable */
  }
}

/** What other devices call this one: "Galaxy S24" / "DESKTOP-ABC", and its kind for the icon. */
export async function deviceIdentity(): Promise<{ name: string; kind: "pc" | "phone" | "tablet" }> {
  if (isAndroid()) {
    const bridge = (window as unknown as { ElDevice?: { info(): string } }).ElDevice;
    try {
      const d = JSON.parse(bridge?.info() ?? "{}") as { name?: string; tablet?: boolean };
      return { name: d.name || "Android", kind: d.tablet ? "tablet" : "phone" };
    } catch {
      return { name: "Android", kind: "phone" };
    }
  }
  const name = await invoke<string>("device_name").catch(() => "");
  return { name: name || "PC", kind: "pc" };
}
export const platformName = () => os;
export const isAndroid = () => os === "android";
export const isMobile = () => os === "android" || os === "ios";

/** Whether library ids are filesystem paths the webview can load directly (asset protocol). */
export const storage = {
  get directPaths() {
    return !isAndroid();
  },
};
