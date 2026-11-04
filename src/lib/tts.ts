import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface TtsStatus {
  /** "neural": desktop Supertonic model; "system": the phone's text-to-speech engine */
  engine?: "neural" | "system";
  installed: boolean;
  bundled: boolean;
  dir: string | null;
  downloadBytes: number;
  voices: string[];
  /** system engine: display names per voice id */
  labels?: Record<string, string>;
  /** system engine: Korean voice data is installed */
  korean?: boolean;
}

export const VOICE_LABELS: Record<string, string> = {
  F1: "여성 1",
  F2: "여성 2",
  F3: "여성 3",
  F4: "여성 4",
  F5: "여성 5",
  M1: "남성 1",
  M2: "남성 2",
  M3: "남성 3",
  M4: "남성 4",
  M5: "남성 5",
};

export const ttsStatus = () => invoke<TtsStatus>("tts_status");
export const ttsCancelDownload = () => invoke("tts_cancel_download");
export const ttsDelete = () => invoke("tts_delete");
export const ttsUnload = () => invoke("tts_unload");

export async function ttsDownload(onProgress: (done: number, total: number) => void): Promise<void> {
  const un = await listen<{ done: number; total: number }>("tts-download", (e) => onProgress(e.payload.done, e.payload.total));
  try {
    await invoke("tts_download");
  } finally {
    un();
  }
}

export interface Utterance {
  /** stable key used to match prefetched audio */
  key: string;
  text: string;
  para: number;
  start: number;
  end: number;
}

export interface VoiceOptions {
  voice: string;
  speed: number;
  steps: number;
  gap: number;
  volume: number;
}

async function synth(text: string, o: VoiceOptions): Promise<{ sr: number; pcm: Float32Array }> {
  const buf = await invoke<ArrayBuffer>("tts_synthesize", { text, voice: o.voice, speed: o.speed, steps: o.steps });
  const view = new DataView(buf);
  const sr = view.getUint32(0, true);
  // copy: the IPC buffer may not be 4-byte aligned after the header
  const pcm = new Float32Array(buf.slice(4));
  return { sr, pcm };
}

/**
 * Sentence-by-sentence player. Pulls utterances from `next()`, keeps a couple
 * synthesized ahead so there is no gap between sentences, and plays them
 * through Web Audio (works the same on every OS – no system voices involved).
 */
export class TtsPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private queue: { u: Utterance; audio: Promise<AudioBuffer | null> }[] = [];
  private stopped = true;
  private paused = false;
  private gen = 0;
  private lookahead = 2;

  constructor(
    private next: () => Utterance | null,
    private opts: () => VoiceOptions,
    private on: {
      start: (u: Utterance) => void;
      end: () => void;
      error: (e: string) => void;
      state: (s: "playing" | "paused" | "stopped" | "loading") => void;
    },
  ) {}

  get isPlaying() {
    return !this.stopped;
  }

  get isPaused() {
    return this.paused;
  }

  private ensureCtx() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    this.gain!.gain.value = this.opts().volume;
    return this.ctx;
  }

  private fill() {
    while (this.queue.length < this.lookahead + 1) {
      const u = this.next();
      if (!u) break;
      const o = this.opts();
      const gen = this.gen;
      const audio = synth(u.text, o)
        .then(({ sr, pcm }) => {
          if (gen !== this.gen || pcm.length === 0) return null;
          const ctx = this.ensureCtx();
          const b = ctx.createBuffer(1, pcm.length, sr);
          b.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
          return b;
        })
        .catch((e) => {
          if (gen === this.gen) this.on.error(String(e));
          return null;
        });
      this.queue.push({ u, audio });
    }
  }

  async play() {
    this.stopped = false;
    this.paused = false;
    const ctx = this.ensureCtx();
    if (ctx.state === "suspended") await ctx.resume();
    this.fill();
    void this.loop(this.gen);
  }

  private async loop(gen: number) {
    while (!this.stopped && gen === this.gen) {
      const item = this.queue.shift();
      if (!item) {
        this.stopped = true;
        this.on.state("stopped");
        this.on.end();
        return;
      }
      this.on.state("loading");
      const buf = await item.audio;
      if (gen !== this.gen || this.stopped) return;
      this.fill();
      if (!buf) continue; // empty sentence (only symbols) or failed synth – skip
      this.on.start(item.u);
      this.on.state(this.paused ? "paused" : "playing");
      await new Promise<void>((resolve) => {
        const ctx = this.ensureCtx();
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.gain!);
        src.onended = () => resolve();
        this.source = src;
        src.start();
      });
      this.source = null;
      if (gen !== this.gen || this.stopped) return;
      const gap = this.opts().gap;
      if (gap > 0) await new Promise((r) => setTimeout(r, gap * 1000));
    }
  }

  pause() {
    if (this.stopped || this.paused) return;
    this.paused = true;
    void this.ctx?.suspend();
    this.on.state("paused");
  }

  resume() {
    if (this.stopped || !this.paused) return;
    this.paused = false;
    void this.ctx?.resume();
    this.on.state("playing");
  }

  /** Drop prefetched audio (voice/speed changed, or the reader jumped elsewhere). */
  restart() {
    this.gen++;
    try {
      this.source?.stop();
    } catch {
      /* already stopped */
    }
    this.source = null;
    this.queue = [];
    if (!this.stopped) {
      this.paused = false;
      void this.ctx?.resume();
      void this.play();
    }
  }

  setVolume(v: number) {
    if (this.gain) this.gain.gain.value = v;
  }

  stop() {
    this.stopped = true;
    this.paused = false;
    this.gen++;
    try {
      this.source?.stop();
    } catch {
      /* already stopped */
    }
    this.source = null;
    this.queue = [];
    this.on.state("stopped");
  }

  dispose() {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }
}
