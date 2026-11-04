import { useEffect, useRef, useState } from "react";

/** How long the hourglass plays before the app may take over (ms). */
const PLAY_MS = 1900;
const FADE_MS = 380;

/**
 * Launch screen: the app icon's hourglass comes alive – sand drains from the top
 * bulb and lands as books stacking up in the bottom one ("time turns into knowledge").
 * Line-art geometry matches icons-src/build_icons.mjs. Stays until both the animation has
 * played and the app is `ready`, then fades out.
 */
export function Splash({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const reduced = useRef(typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [played, setPlayed] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setPlayed(true), reduced.current ? 250 : PLAY_MS);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!played || !ready) return;
    setLeaving(true);
    const t = window.setTimeout(onDone, FADE_MS);
    return () => window.clearTimeout(t);
  }, [played, ready, onDone]);

  return (
    <div className={`splash ${leaving ? "leaving" : ""} ${reduced.current ? "still" : ""}`} aria-hidden="true">
      <svg className="splash-glass" viewBox="0 0 512 512">
        <defs>
          <clipPath id="spTopClip">
            <rect className="sp-drain" x="160" y="150" width="192" height="100" />
          </clipPath>
        </defs>
        <path className="sp-ink" d="M168 128H344C344 196 292 222 268 256C292 290 344 316 344 384H168C168 316 220 290 244 256C220 222 168 196 168 128Z" fill="none" />
        <path className="sp-ink" d="M150 120H362M150 392H362" />
        <path clipPath="url(#spTopClip)" d="M206 180H306C296 204 276 222 262 240H250C236 222 216 204 206 180Z" fill="#E8A23C" />
        <path className="sp-stream" d="M256 244V318" stroke="#E8A23C" strokeWidth="8" strokeLinecap="round" />
        <rect className="sp-book b1" x="192" y="344" width="128" height="22" rx="5" />
        <rect className="sp-book b2" x="206" y="320" width="100" height="20" rx="5" fill="#E8A23C" />
      </svg>
      <div className="splash-name">ELviewer</div>
    </div>
  );
}
