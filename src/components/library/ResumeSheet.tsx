import { useEffect, useRef, useState } from "react";
import type { Progress } from "../../types";
import type { DeviceKind, DevicePos } from "../../lib/sync";
import { formatAgo, formatPct } from "../../lib/text";
import { useCloud } from "../../store/cloud";
import { useSettings } from "../../store/settings";
import { IconMonitor, IconPhone, IconRestart, IconTablet } from "../Icons";
import { isMobile } from "../../lib/platform";
import { onBackButtonPress } from "@tauri-apps/api/app";

export type ResumeChoice = { kind: "other"; pos: DevicePos } | { kind: "here" } | { kind: "start" };

const iconStyle = { stroke: "currentColor", fill: "none", strokeWidth: 1.7 } as const;

export function DeviceIcon({ kind, ...rest }: { kind: DeviceKind } & React.SVGProps<SVGSVGElement>) {
  const I = kind === "phone" ? IconPhone : kind === "tablet" ? IconTablet : IconMonitor;
  return <I {...iconStyle} {...rest} />;
}

/**
 * Asked when a book was read further on another device: continue from there, from
 * this device's own place, or from the beginning. A bottom sheet on phones, a dialog
 * on wide screens.
 */
export function ResumeSheet({
  title,
  here,
  others,
  onPick,
  onCancel,
}: {
  title: string;
  here: Progress | undefined;
  others: DevicePos[];
  onPick: (c: ResumeChoice) => void;
  onCancel: () => void;
}) {
  const me = useCloud((s) => s.device);
  const setSettings = useSettings((s) => s.set);
  const [remember, setRemember] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Focus the dialog itself (no ring on an option the user didn't choose); Tab reaches the options.
    sheet.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      } else if (e.key === "Enter" && document.activeElement === sheet.current) {
        e.preventDefault();
        sheet.current?.querySelector<HTMLButtonElement>(".rs-opt")?.click();
      }
    };
    window.addEventListener("keydown", onKey, true);
    // Android back button closes the sheet, not the app.
    const back = isMobile() ? onBackButtonPress(() => onCancel()) : null;
    return () => {
      window.removeEventListener("keydown", onKey, true);
      void back?.then((l) => l.unregister());
    };
  }, [onCancel]);

  const pick = (c: ResumeChoice) => {
    if (remember) setSettings({ syncOpen: "latest" });
    onPick(c);
  };
  const hasHere = !!here && (here.pct > 0.0005 || (here.para ?? 0) > 0 || (here.page ?? 0) > 0 || !!here.loc);

  return (
    <div className="rs-back" onClick={onCancel}>
      <div ref={sheet} tabIndex={-1} className="rs-sheet" role="dialog" aria-modal="true" aria-label="어디서부터 읽을까요" onClick={(e) => e.stopPropagation()}>
        <div className="rs-grip" aria-hidden />
        <div className="rs-eyebrow">어디서부터 읽을까요?</div>
        <h2 className="rs-title">{title}</h2>

        <div className="rs-options">
          {others.map((p, i) => (
            <button key={p.dev} className={`rs-opt ${i === 0 ? "rs-primary" : ""}`} onClick={() => pick({ kind: "other", pos: p })}>
              <span className="rs-ico">
                <DeviceIcon kind={p.kind} />
              </span>
              <span className="rs-body">
                <span className="rs-name">
                  <span className="rs-ellipsis">{p.name}</span>
                  {i === 0 && <span className="rs-badge">최근</span>}
                </span>
                <span className="rs-meta">{formatAgo(p.updatedAt)} · 동기화된 기록</span>
                <span className="rs-bar">
                  <i style={{ width: `${Math.min(100, p.pct * 100)}%` }} />
                </span>
              </span>
              <span className="rs-pct">{formatPct(p.pct)}</span>
            </button>
          ))}

          {hasHere && (
            <button className="rs-opt" onClick={() => pick({ kind: "here" })}>
              <span className="rs-ico">
                <DeviceIcon kind={me?.kind ?? "pc"} />
              </span>
              <span className="rs-body">
                <span className="rs-name">
                  <span className="rs-ellipsis">이 기기에서 읽던 곳</span>
                </span>
                <span className="rs-meta">{here!.updatedAt ? formatAgo(here!.updatedAt) : "열어 보기만 함"}</span>
                <span className="rs-bar">
                  <i style={{ width: `${Math.min(100, here!.pct * 100)}%` }} />
                </span>
              </span>
              <span className="rs-pct">{formatPct(here!.pct)}</span>
            </button>
          )}

          <button className="rs-opt rs-quiet" onClick={() => pick({ kind: "start" })}>
            <span className="rs-ico">
              <IconRestart {...iconStyle} />
            </span>
            <span className="rs-body">
              <span className="rs-name">처음부터 읽기</span>
            </span>
          </button>
        </div>

        <label className="rs-remember">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>다음부터 묻지 않고 가장 최근 기록으로 열기</span>
        </label>
      </div>
    </div>
  );
}
