import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import type { TextDoc } from "../../lib/text";
import { splitSentences, type Sentence } from "../../lib/textPrep";
import { TtsPlayer, ttsCancelDownload, ttsDelete, ttsDownload, ttsStatus, ttsUnload, type TtsStatus, type Utterance } from "../../lib/tts";
import { useSettings } from "../../store/settings";

/** Survives the reader remounting when auto-advancing to the next file. */
export const useTtsSession = create<{ resumeOnOpen: boolean; set: (v: boolean) => void }>((set) => ({
  resumeOnOpen: false,
  set: (resumeOnOpen) => set({ resumeOnOpen }),
}));

export type TtsState = "playing" | "paused" | "stopped" | "loading";

export function useTextTts(opts: {
  doc: TextDoc | null;
  /** paragraph currently at the top of the screen */
  currentPara: () => number;
  ensureVisible: (para: number) => void;
  /** reached the end of the document while reading */
  onFinished: () => void;
}) {
  const settings = useSettings((s) => s.settings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [status, setStatus] = useState<TtsStatus | null>(null);
  const [state, setState] = useState<TtsState>("stopped");
  const [current, setCurrent] = useState<Sentence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [download, setDownload] = useState<{ done: number; total: number } | null>(null);
  const [sleepChoice, setSleepChoice] = useState<number | null>(null);
  const [sleepLeftMin, setSleepLeftMin] = useState<number | null>(null);

  // sentence cursor: next sentence to hand to the player
  const cursor = useRef({ para: 0, idx: 0 });
  const cache = useRef(new Map<number, Sentence[]>());
  const playerRef = useRef<TtsPlayer | null>(null);
  /** sentence that is currently audible – used for prev/next sentence */
  const playingRef = useRef<Sentence | null>(null);

  const sentencesOf = useCallback((para: number): Sentence[] => {
    const doc = optsRef.current.doc;
    if (!doc) return [];
    let s = cache.current.get(para);
    if (!s) {
      s = splitSentences(para, doc.paras[para] ?? "");
      cache.current.set(para, s);
    }
    return s;
  }, []);

  const nextUtterance = useCallback((): Utterance | null => {
    const doc = optsRef.current.doc;
    if (!doc) return null;
    let { para, idx } = cursor.current;
    while (para < doc.paras.length) {
      const list = sentencesOf(para);
      if (idx < list.length) {
        const s = list[idx];
        cursor.current = { para, idx: idx + 1 };
        return { key: `${para}:${s.start}`, text: s.text, para: s.para, start: s.start, end: s.end };
      }
      para++;
      idx = 0;
    }
    cursor.current = { para, idx };
    return null;
  }, [sentencesOf]);

  useEffect(() => {
    cache.current.clear();
  }, [opts.doc]);

  const refreshStatus = useCallback(() => {
    ttsStatus()
      .then(setStatus)
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(refreshStatus, [refreshStatus]);

  useEffect(() => {
    const player = new TtsPlayer(
      nextUtterance,
      () => {
        const s = settingsRef.current;
        return { voice: s.ttsVoice, speed: s.ttsSpeed, steps: s.ttsSteps, gap: s.ttsGap, volume: s.ttsVolume };
      },
      {
        start: (u) => {
          const s: Sentence = { para: u.para, start: u.start, end: u.end, text: u.text };
          playingRef.current = s;
          setCurrent(s);
          setError(null);
          if (settingsRef.current.ttsFollow) optsRef.current.ensureVisible(u.para);
        },
        end: () => {
          playingRef.current = null;
          setCurrent(null);
          optsRef.current.onFinished();
        },
        error: (e) => setError(e),
        state: setState,
      },
    );
    playerRef.current = player;
    return () => {
      player.dispose();
      playerRef.current = null;
    };
  }, [nextUtterance]);

  // Voice / speed / quality changes take effect from the current sentence.
  const voiceKey = `${settings.ttsVoice}|${settings.ttsSpeed}|${settings.ttsSteps}`;
  const firstVoice = useRef(true);
  useEffect(() => {
    if (firstVoice.current) {
      firstVoice.current = false;
      return;
    }
    const p = playerRef.current;
    const cur = playingRef.current;
    if (p?.isPlaying && cur) {
      cursor.current = { para: cur.para, idx: Math.max(0, sentencesOf(cur.para).findIndex((s) => s.start === cur.start)) };
      p.restart();
    }
  }, [voiceKey, sentencesOf]);

  useEffect(() => {
    playerRef.current?.setVolume(settings.ttsVolume);
  }, [settings.ttsVolume]);

  /** Start (or restart) reading at a paragraph / character offset. */
  const startAt = useCallback(
    (para: number, offset = 0) => {
      const p = playerRef.current;
      if (!p || !status?.installed) return;
      const list = sentencesOf(para);
      let idx = list.findIndex((s) => s.end > offset);
      if (idx < 0) idx = list.length;
      cursor.current = { para, idx };
      setError(null);
      if (p.isPlaying) p.restart();
      else void p.play();
    },
    [status, sentencesOf],
  );

  const play = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    if (p.isPlaying && p.isPaused) p.resume();
    else if (!p.isPlaying) startAt(optsRef.current.currentPara());
  }, [startAt]);

  const pause = useCallback(() => playerRef.current?.pause(), []);
  const stop = useCallback(() => {
    playerRef.current?.stop();
    playingRef.current = null;
    setCurrent(null);
  }, []);

  const toggle = useCallback(() => {
    const p = playerRef.current;
    if (p?.isPlaying && !p.isPaused) pause();
    else play();
  }, [play, pause]);

  const skip = useCallback(
    (dir: 1 | -1) => {
      const cur = playingRef.current;
      if (!cur) return;
      const list = sentencesOf(cur.para);
      const i = list.findIndex((s) => s.start === cur.start);
      if (dir === 1) {
        cursor.current = { para: cur.para, idx: i + 1 };
      } else if (i > 0) {
        cursor.current = { para: cur.para, idx: i - 1 };
      } else {
        // previous non-empty paragraph's last sentence
        let p = cur.para - 1;
        while (p >= 0 && sentencesOf(p).length === 0) p--;
        cursor.current = p >= 0 ? { para: p, idx: sentencesOf(p).length - 1 } : { para: 0, idx: 0 };
      }
      playerRef.current?.restart();
    },
    [sentencesOf],
  );

  // Sleep timer
  useEffect(() => {
    if (sleepChoice == null) {
      setSleepLeftMin(null);
      return;
    }
    const until = Date.now() + sleepChoice * 60000;
    setSleepLeftMin(sleepChoice);
    const id = window.setInterval(() => {
      const left = Math.ceil((until - Date.now()) / 60000);
      if (left <= 0) {
        playerRef.current?.pause();
        setSleepChoice(null);
      } else setSleepLeftMin(left);
    }, 10000);
    return () => window.clearInterval(id);
  }, [sleepChoice]);

  const startDownload = useCallback(async () => {
    setError(null);
    setDownload({ done: 0, total: status?.downloadBytes ?? 1 });
    try {
      await ttsDownload((done, total) => setDownload({ done, total }));
      refreshStatus();
    } catch (e) {
      if (String(e) !== "cancelled") setError(`다운로드 실패: ${e}`);
    } finally {
      setDownload(null);
    }
  }, [status, refreshStatus]);

  const deleteModel = useCallback(async () => {
    stop();
    await ttsDelete().catch((e) => setError(String(e)));
    refreshStatus();
  }, [stop, refreshStatus]);

  // Free the ONNX sessions (~1 GB) when leaving the reader.
  useEffect(() => () => void ttsUnload().catch(() => {}), []);

  return {
    status,
    state,
    current,
    error,
    download,
    sleepChoice,
    sleepLeftMin,
    setSleep: setSleepChoice,
    play,
    pause,
    stop,
    toggle,
    startAt,
    prevSentence: () => skip(-1),
    nextSentence: () => skip(1),
    startDownload,
    cancelDownload: () => void ttsCancelDownload(),
    deleteModel,
    isActive: state !== "stopped",
  };
}
