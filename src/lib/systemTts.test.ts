import { describe, expect, it, vi } from "vitest";
import { SystemTtsPlayer, systemVoiceLabels, type ElTtsBridge, type ElTtsEvent } from "./systemTts";
import type { Utterance } from "./tts";

/** Fake of the Android `ElTts` bridge: records calls; the test plays the engine's part. */
function setup(sentences: string[]) {
  const target = new EventTarget();
  const spoken: { id: string; text: string; flush: boolean; gapMs: number; volume: number }[] = [];
  const bridge: ElTtsBridge = {
    init: vi.fn(),
    status: () => JSON.stringify({ ready: true, voices: [] }),
    speak: (id, text, _rate, _pitch, _voice, volume, gapMs, flush) => spoken.push({ id, text, flush, gapMs, volume }),
    stop: vi.fn(),
    openSettings: vi.fn(),
  };
  let i = 0;
  const next = (): Utterance | null => (i < sentences.length ? { key: String(i), text: sentences[i], para: i, start: 0, end: sentences[i++].length } : null);
  const on = { start: vi.fn(), end: vi.fn(), error: vi.fn(), state: vi.fn() };
  const player = new SystemTtsPlayer(bridge, next, () => ({ voice: "", speed: 1, steps: 8, gap: 0.25, volume: 1.4, pitch: 1 }), on, target);
  const emit = (d: ElTtsEvent) => target.dispatchEvent(new CustomEvent("eltts", { detail: d }));
  /** the engine speaks the oldest queued sentence to the end */
  const speakNext = (id: string) => {
    emit({ type: "start", id });
    emit({ type: "done", id });
  };
  return { player, bridge, spoken, on, emit, speakNext, rewind: (n: number) => (i = n) };
}

describe("SystemTtsPlayer", () => {
  it("keeps four sentences queued, flushing only the first", () => {
    const t = setup(["하나.", "둘.", "셋.", "넷.", "다섯.", "여섯."]);
    t.player.play();
    expect(t.spoken.map((s) => s.text)).toEqual(["하나.", "둘.", "셋.", "넷."]);
    expect(t.spoken.map((s) => s.flush)).toEqual([true, false, false, false]);
    expect(t.spoken[0].gapMs).toBe(250);
    // the engine takes volume 0..1
    expect(t.spoken[0].volume).toBe(1);
  });

  it("reports the audible sentence and tops the queue up as sentences finish", () => {
    const t = setup(["하나.", "둘.", "셋.", "넷.", "다섯."]);
    t.player.play();
    t.emit({ type: "start", id: t.spoken[0].id });
    expect(t.on.start).toHaveBeenLastCalledWith(expect.objectContaining({ text: "하나." }));
    expect(t.on.state).toHaveBeenLastCalledWith("playing");
    t.emit({ type: "done", id: t.spoken[0].id });
    expect(t.spoken.map((s) => s.text)).toContain("다섯.");
  });

  it("ends after the last sentence is spoken", () => {
    const t = setup(["하나.", "둘."]);
    t.player.play();
    t.speakNext(t.spoken[0].id);
    expect(t.on.end).not.toHaveBeenCalled();
    t.speakNext(t.spoken[1].id);
    expect(t.on.end).toHaveBeenCalledTimes(1);
    expect(t.player.isPlaying).toBe(false);
  });

  it("ends right away when there is nothing to read", () => {
    const t = setup([]);
    t.player.play();
    expect(t.on.end).toHaveBeenCalledTimes(1);
  });

  it("pauses by stopping the engine and re-speaks the interrupted sentence on resume", () => {
    const t = setup(["하나.", "둘.", "셋.", "넷.", "다섯.", "여섯."]);
    t.player.play();
    t.speakNext(t.spoken[0].id);
    t.emit({ type: "start", id: t.spoken[1].id }); // "둘." is audible
    t.player.pause();
    expect(t.bridge.stop).toHaveBeenCalled();
    expect(t.player.isPaused).toBe(true);
    const before = t.spoken.length;
    t.player.resume();
    const again = t.spoken.slice(before).map((s) => s.text);
    expect(again[0]).toBe("둘.");
    expect(t.spoken[before].flush).toBe(true);
  });

  it("ignores engine events from before a restart", () => {
    const t = setup(["하나.", "둘.", "셋.", "넷.", "다섯.", "여섯."]);
    t.player.play();
    const old = t.spoken[0].id;
    t.rewind(4);
    t.player.restart();
    t.on.start.mockClear();
    t.emit({ type: "start", id: old });
    expect(t.on.start).not.toHaveBeenCalled();
    expect(t.spoken[t.spoken.length - 1].text).toBe("여섯.");
  });

  it("surfaces a failed sentence and moves on", () => {
    const t = setup(["하나.", "둘."]);
    t.player.play();
    t.emit({ type: "error", id: t.spoken[0].id, message: "speak_failed_-3" });
    expect(t.on.error).toHaveBeenCalledWith("speak_failed_-3");
    t.speakNext(t.spoken[1].id);
    expect(t.on.end).toHaveBeenCalled();
  });

  it("stops listening after dispose", () => {
    const t = setup(["하나.", "둘."]);
    t.player.play();
    t.player.dispose();
    t.emit({ type: "start", id: t.spoken[0].id });
    expect(t.on.start).not.toHaveBeenCalled();
  });
});

describe("systemVoiceLabels", () => {
  it("numbers Korean voices and marks online ones", () => {
    const labels = systemVoiceLabels([
      { id: "ko-kr-x-ism-local", lang: "ko-KR", network: false, quality: 400 },
      { id: "ko-kr-x-kob-network", lang: "ko-KR", network: true, quality: 400 },
      { id: "en-us-x-sfg-local", lang: "en-US", network: false, quality: 400 },
    ]);
    expect(labels).toEqual({ "ko-kr-x-ism-local": "한국어 1", "ko-kr-x-kob-network": "한국어 2 (온라인)", "en-us-x-sfg-local": "en-US" });
  });
});
