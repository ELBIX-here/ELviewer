import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { initPlatform } from "./lib/platform";
import "./styles/fonts.css";
import "./styles/global.css";
import "./styles/library.css";
import "./styles/reader.css";
import "./styles/stats.css";
import "./styles/mobile.css";

// Last theme, applied before the first render so the launch screen has the right colors.
try {
  const t = JSON.parse(localStorage.getItem("el-theme") ?? "null") as { bg: string; fg: string; theme: string } | null;
  if (t) {
    document.documentElement.style.setProperty("--bg", t.bg);
    document.documentElement.style.setProperty("--fg", t.fg);
    document.documentElement.dataset.theme = t.theme;
  }
} catch {
  /* first run or storage unavailable */
}

// Disable the WebView2 context menu and browser zoom / navigation shortcuts.
document.addEventListener("contextmenu", (e) => {
  // Android raises contextmenu on long-press; blocking it would break text selection.
  if (document.documentElement.dataset.platform === "mobile") return;
  const t = e.target as HTMLElement;
  if (t.tagName !== "INPUT" && t.tagName !== "TEXTAREA" && !window.getSelection()?.toString()) e.preventDefault();
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && ["r", "R", "p", "P", "u", "U", "j", "J"].includes(e.key)) e.preventDefault();
  if (e.key === "F5" || e.key === "F3" || e.key === "F7") e.preventDefault();
});

// Surface uncaught errors instead of failing silently.
function showFatal(msg: string) {
  let el = document.getElementById("fatal");
  if (!el) {
    el = document.createElement("div");
    el.id = "fatal";
    el.className = "toast";
    el.style.maxWidth = "80vw";
    el.style.userSelect = "text";
    el.onclick = () => el?.remove();
    document.body.appendChild(el);
  }
  el.textContent = msg;
}
window.addEventListener("error", (e) => {
  // Benign Chromium notice emitted when layout settles within one frame.
  if (/ResizeObserver loop/.test(e.message)) return;
  showFatal(`오류: ${e.message}`);
});
window.addEventListener("unhandledrejection", (e) => showFatal(`오류: ${String(e.reason?.message ?? e.reason)}`));

// Plain-browser dev preview (no Tauri runtime): fake the IPC with a sample library.
const devMock =
  import.meta.env.DEV && !("__TAURI_INTERNALS__" in window) ? import("./dev/mockTauri").then((m) => m.installTauriMock()) : Promise.resolve();

void devMock.then(initPlatform).then(() =>
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary onReset={() => window.location.reload()}>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
),
);
