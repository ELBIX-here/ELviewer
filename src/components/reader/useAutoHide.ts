import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Reader chrome visibility. The chrome is hidden while reading and only
 * toggled explicitly (center click / Enter) – moving the mouse or turning
 * pages never brings it back. While a panel is open it stays pinned.
 * `autoHideMs > 0` hides it again after that long without interaction.
 * Also hides the mouse cursor after a few idle seconds.
 */
export function useAutoHide(autoHideMs: number, pinned: boolean) {
  const [visible, setVisible] = useState(false);
  const [cursorHidden, setCursorHidden] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const cursorTimer = useRef<number | undefined>(undefined);

  const clear = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = undefined;
  };

  const arm = useCallback(() => {
    clear();
    if (autoHideMs > 0 && !pinned) timer.current = window.setTimeout(() => setVisible(false), autoHideMs);
  }, [autoHideMs, pinned]);

  const show = useCallback(() => {
    setVisible(true);
    arm();
  }, [arm]);

  const hide = useCallback(() => {
    if (pinned) return;
    clear();
    setVisible(false);
  }, [pinned]);

  /**
   * A tap on the page while the chrome is up only closes the chrome – it doesn't
   * also turn the page or land on the progress bar's neighbourhood. Returns true when
   * the tap was used up that way.
   */
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const consumeTap = useCallback(() => {
    if (pinned || !visibleRef.current) return false;
    clear();
    setVisible(false);
    return true;
  }, [pinned]);

  const toggle = useCallback(() => {
    if (pinned) return;
    setVisible((v) => {
      if (v) clear();
      else arm();
      return !v;
    });
  }, [arm, pinned]);

  // Panels keep the chrome up; closing the last panel restarts the auto-hide timer.
  useEffect(() => {
    if (pinned) {
      clear();
      setVisible(true);
    } else arm();
  }, [pinned, arm]);

  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const onPointerMove = useCallback((e?: { clientX: number; clientY: number }) => {
    if (e) {
      const lp = lastPos.current;
      if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) < 4) return;
      lastPos.current = { x: e.clientX, y: e.clientY };
    }
    setCursorHidden(false);
    if (cursorTimer.current) window.clearTimeout(cursorTimer.current);
    cursorTimer.current = window.setTimeout(() => setCursorHidden(true), 2500);
  }, []);

  useEffect(
    () => () => {
      clear();
      if (cursorTimer.current) window.clearTimeout(cursorTimer.current);
    },
    [],
  );

  return { visible, cursorHidden: cursorHidden && !visible, show, hide, toggle, consumeTap, onPointerMove };
}
