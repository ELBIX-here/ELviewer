import { useCallback, useMemo, useRef } from "react";
import { useSettings } from "../../store/settings";
import { stripExt } from "../../lib/sort";

/**
 * "Turn past the last page" handling shared by the non-text readers: the first
 * attempt shows a hint, the second opens the next file in the folder.
 */
export function useEndAdvance(onNextFile: (() => void) | undefined, nextName: string | undefined, toast: (msg: string) => void) {
  const autoNext = useSettings((s) => s.settings.autoNextFile);
  const armed = useRef(false);
  const onEnd = useCallback(() => {
    if (!autoNext || !onNextFile) {
      toast("마지막 페이지입니다");
      return;
    }
    if (armed.current) {
      armed.current = false;
      onNextFile();
    } else {
      armed.current = true;
      toast(`마지막 페이지 · 한 번 더 넘기면 다음 화${nextName ? `: ${stripExt(nextName)}` : ""}`);
    }
  }, [autoNext, onNextFile, nextName, toast]);
  const disarm = useCallback(() => {
    armed.current = false;
  }, []);
  return useMemo(() => ({ onEnd, disarm }), [onEnd, disarm]);
}
