import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import logoUrl from "../assets/logo.svg";

/**
 * Desktop window frame drawn by the app (the native one is turned off with
 * `decorations: false`), so the title bar follows the reading theme.
 * Dragging and double-click-to-maximize come from `data-tauri-drag-region`.
 * Hidden in full screen.
 */
export function TitleBar({ title }: { title?: string }) {
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [focused, setFocused] = useState(true);

  useEffect(() => {
    const win = getCurrentWindow();
    const update = async () => {
      setMaximized(await win.isMaximized().catch(() => false));
      setFullscreen(await win.isFullscreen().catch(() => false));
    };
    void update();
    const unResize = win.onResized(() => void update());
    const unFocus = win.onFocusChanged((e) => setFocused(e.payload));
    return () => {
      void unResize.then((f) => f());
      void unFocus.then((f) => f());
    };
  }, []);

  if (fullscreen) return null;
  const win = getCurrentWindow();
  return (
    <header className={`titlebar ${focused ? "" : "blurred"}`} data-tauri-drag-region>
      <img className="tb-logo" src={logoUrl} alt="" data-tauri-drag-region />
      <span className="tb-app" data-tauri-drag-region>
        ELviewer
      </span>
      {title && (
        <span className="tb-doc" data-tauri-drag-region>
          {title}
        </span>
      )}
      <div className="tb-controls">
        <button className="tb-btn" title="최소화" aria-label="최소화" onClick={() => void win.minimize()}>
          <svg viewBox="0 0 12 12">
            <path d="M2 6.5h8" />
          </svg>
        </button>
        <button className="tb-btn" title={maximized ? "이전 크기로" : "최대화"} aria-label={maximized ? "이전 크기로" : "최대화"} onClick={() => void win.toggleMaximize()}>
          {maximized ? (
            <svg viewBox="0 0 12 12">
              <rect x="2" y="3.5" width="6.5" height="6.5" rx="1.2" />
              <path d="M4 3.5V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-.5" />
            </svg>
          ) : (
            <svg viewBox="0 0 12 12">
              <rect x="2.25" y="2.25" width="7.5" height="7.5" rx="1.4" />
            </svg>
          )}
        </button>
        <button className="tb-btn close" title="닫기" aria-label="닫기" onClick={() => void win.close()}>
          <svg viewBox="0 0 12 12">
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
          </svg>
        </button>
      </div>
    </header>
  );
}
