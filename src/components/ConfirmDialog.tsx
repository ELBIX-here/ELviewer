import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { onBackButtonPress } from "@tauri-apps/api/app";
import { isMobile } from "../lib/platform";

/**
 * In-app confirmation, styled like the rest of the app (the webview's native
 * window.confirm is unavailable in this Tauri version and looks out of place anyway).
 * A bottom sheet on phones, a dialog on wide screens – same frame as ResumeSheet.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message?: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Destructive actions start on "cancel" so Enter doesn't confirm by accident.
    cancelBtn.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    const back = isMobile() ? onBackButtonPress(() => onCancel()) : null;
    return () => {
      window.removeEventListener("keydown", onKey, true);
      void back?.then((l) => l.unregister());
    };
  }, [onCancel]);

  // Portaled: the phone sidebar drawer is transformed, which would trap a fixed overlay inside it.
  return createPortal(
    <div className="rs-back" onClick={onCancel}>
      <div className="rs-sheet cf-sheet" role="alertdialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="rs-grip" aria-hidden />
        <h2 className="cf-title">{title}</h2>
        {message && <p className="cf-msg">{message}</p>}
        <div className="cf-actions">
          <button ref={cancelBtn} className="cf-btn" onClick={onCancel}>
            취소
          </button>
          <button className={`cf-btn ${danger ? "cf-danger" : "cf-primary"}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
