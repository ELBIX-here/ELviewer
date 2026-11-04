import type { Utterance, VoiceOptions } from "./tts";

/**
 * Read-aloud on Android through the phone's text-to-speech engine, via the
 * `window.ElTts` bridge (SystemTts.kt). Same surface as the desktop `TtsPlayer`
 * so useTextTts drives both the same way.
 */

export interface SystemVoice {
  id: string;
  lang: string;
  network: boolean;
  quality: number;
}

export interface SystemTtsStatus {
  ready: boolean;
  engine?: string;
  /** engine can speak Korean (voice data installed) */
  korean?: boolean;
  voices: SystemVoice[];
  error?: string;
}

/** The native bridge. Calls return immediately; results arrive as `eltts` events. */
export interface ElTtsBridge {
  init(): void;
  status(): string;
  speak(id: string, text: string, rate: number, pitch: number, voice: string, volume: number, gapMs: number, flush: boolean): void;
  stop(): void;
  openSettings(): void;
}

export interface ElTtsEvent {
  type: "ready" | "error" | "start" | "done";
  id?: string;
  message?: string;
}

export function systemBridge(): ElTtsBridge | null {
  return (window as unknown as { ElTts?: ElTtsBridge }).ElTts ?? null;
}

/** Starts the engine (if needed) and resolves with its status. */
export function systemTtsStatus(bridge: ElTtsBridge, target: EventTarget = window, timeoutMs = 8000): Promise<SystemTtsStatus> {
  const read = () => JSON.parse(bridge.status()) as SystemTtsStatus;
  const now = read();
  if (now.ready) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      target.removeEventListener("eltts", on);
      window.clearTimeout(timer);
      resolve(read());
    };
    const on = (e: Event) => {
      const t = (e as CustomEvent<ElTtsEvent>).detail?.type;
      if (t === "ready" || t === "error") done();
    };
    const timer = window.setTimeout(done, timeoutMs);
    target.addEventListener("eltts", on);
    bridge.init();
  });
}

/**
 * Human labels for system voices: Korean voices are numbered ("한국어 1"), others
 * show their language tag; voices that need the internet are marked.
 */
export function systemVoiceLabels(voices: SystemVoice[]): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  for (const v of voices) {
    const base = v.lang.toLowerCase().startsWith("ko") ? `한국어 ${++n}` : v.lang;
    out[v.id] = v.network ? `${base} (온라인)` : base;
  }
  return out;
}

type PlayerEvents = {
  start: (u: Utterance) => void;
  end: () => void;
  error: (e: string) => void;
  state: (s: "playing" | "paused" | "stopped" | "loading") => void;
};

export interface SystemVoiceOptions extends VoiceOptions {
  pitch: number;
}

/**
 * Keeps a few sentences queued in the engine (so speech carries on smoothly, also
 * while the screen is off) and reports which one is audible. The engine has no
 * pause, so pausing stops it and resuming re-speaks the current sentence.
 */
export class SystemTtsPlayer {
  /** sentences handed to the engine and not finished yet, in order */
  private queued: { id: string; u: Utterance }[] = [];
  /** sentences to speak again after a pause, before pulling new ones */
  private replay: Utterance[] = [];
  private stopped = true;
  private paused = false;
  private gen = 0;
  private seq = 0;
  private exhausted = false;
  private readonly lookahead = 4;

  constructor(
    private bridge: ElTtsBridge,
    private next: () => Utterance | null,
    private opts: () => SystemVoiceOptions,
    private on: PlayerEvents,
    private target: EventTarget = window,
  ) {
    this.target.addEventListener("eltts", this.onEvent);
  }

  get isPlaying() {
    return !this.stopped;
  }

  get isPaused() {
    return this.paused;
  }

  private pull(): Utterance | null {
    return this.replay.shift() ?? this.next();
  }

  private fill(flush: boolean) {
    while (this.queued.length < this.lookahead) {
      const u = this.pull();
      if (!u) {
        this.exhausted = true;
        break;
      }
      const o = this.opts();
      const id = `${this.gen}:${this.seq++}`;
      this.bridge.speak(id, u.text, o.speed, o.pitch, o.voice, Math.min(1, o.volume), Math.round(o.gap * 1000), flush);
      flush = false;
      this.queued.push({ id, u });
    }
    if (this.queued.length === 0) this.finish();
  }

  private finish() {
    this.stopped = true;
    this.paused = false;
    this.on.state("stopped");
    this.on.end();
  }

  private onEvent = (e: Event) => {
    const d = (e as CustomEvent<ElTtsEvent>).detail;
    if (!d?.id || this.stopped || this.paused) return;
    if (Number(d.id.split(":")[0]) !== this.gen) return; // from before a stop/restart
    const i = this.queued.findIndex((q) => q.id === d.id);
    if (i < 0) return;
    if (d.type === "start") {
      this.on.start(this.queued[i].u);
      this.on.state("playing");
    } else if (d.type === "done" || d.type === "error") {
      if (d.type === "error") this.on.error(d.message ?? "speak_failed");
      this.queued.splice(0, i + 1);
      if (this.exhausted && this.queued.length === 0 && this.replay.length === 0) this.finish();
      else this.fill(false);
    }
  };

  play() {
    this.stopped = false;
    this.paused = false;
    this.exhausted = false;
    this.on.state("loading");
    this.fill(true);
  }

  pause() {
    if (this.stopped || this.paused) return;
    this.paused = true;
    this.gen++;
    this.bridge.stop();
    // the audible sentence and everything queued behind it are spoken again on resume
    this.replay = [...this.queued.map((q) => q.u), ...this.replay];
    this.queued = [];
    this.on.state("paused");
  }

  resume() {
    if (this.stopped || !this.paused) return;
    this.play();
  }

  /** Drop what is queued (voice/speed changed, or the reader jumped elsewhere). */
  restart() {
    this.gen++;
    this.bridge.stop();
    this.queued = [];
    this.replay = [];
    if (!this.stopped) this.play();
  }

  /** Volume applies from the next queued sentence. */
  setVolume(_v: number) {}

  stop() {
    this.stopped = true;
    this.paused = false;
    this.gen++;
    this.bridge.stop();
    this.queued = [];
    this.replay = [];
    this.on.state("stopped");
  }

  dispose() {
    this.stop();
    this.target.removeEventListener("eltts", this.onEvent);
  }
}
