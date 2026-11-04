/**
 * Dev-only: lets the UI run in a plain browser (`npm run dev`, http://localhost:1420)
 * for design work. Fakes the Tauri IPC with a small sample library, keeps
 * plugin-store data in localStorage. Never loaded inside the Tauri app.
 */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { Entry } from "../types";

const ROOT = "C:\\Novels";
const now = Date.now();

function file(dir: string, name: string, size: number, daysAgo: number, ext = name.split(".").pop()!.toLowerCase()): Entry {
  const kind: Entry["kind"] = ext === "epub" ? "ebook" : ext === "pdf" ? "pdf" : "text";
  return { id: `${dir}\\${name}`, name, dir, root: ROOT, ext, kind, size, mtime: now - daysAgo * 86400_000, inArchive: false };
}

const ENTRIES: Entry[] = [
  ...Array.from({ length: 12 }, (_, i) => file(`${ROOT}\\달빛 조각사`, `달빛 조각사 ${String(i + 1).padStart(2, "0")}권.txt`, 1_400_000 + i * 31_000, 40 - i)),
  ...Array.from({ length: 8 }, (_, i) => file(`${ROOT}\\전지적 독자 시점`, `전지적 독자 시점 ${i + 1}화~${i + 10}화.txt`, 820_000 + i * 12_000, 10 - i)),
  ...Array.from({ length: 5 }, (_, i) => file(`${ROOT}\\고전`, ["데미안.epub", "어린 왕자.epub", "변신.pdf", "노인과 바다.epub", "이방인.txt"][i], 300_000 + i * 90_000, 90)),
  file(ROOT, "회귀한 검성의 서재.txt", 2_310_000, 2),
  file(ROOT, "북부 대공의 하녀.txt", 1_870_000, 1),
  file(ROOT, "시간을 거스르는 모래시계.txt", 960_000, 5),
  file(ROOT, "작업 메모.md", 12_000, 0),
];

const PARA = [
  "제 1화 모래시계가 뒤집히던 밤",
  "창밖으로 첫눈이 내리고 있었다. 서재의 등불은 이미 반쯤 꺼져 있었고, 책상 위에는 읽다 만 책 한 권이 펼쳐져 있었다.",
  "\"아직 안 자?\"",
  "문틈으로 들어온 목소리에 그는 고개를 들었다. 모래시계의 마지막 알갱이가 떨어지는 소리가 유난히 크게 들렸다.",
  "그는 대답 대신 모래시계를 뒤집었다. 시간은 다시 흐르기 시작했고, 이야기도 그랬다.",
];
const SAMPLE = Array.from({ length: 400 }, (_, i) => PARA[i % PARA.length].replace("제 1화", `제 ${Math.floor(i / 5) + 1}화`)).join("\n\n");

const LS = "elviewer-dev-store:";
const stores = new Map<number, string>();

const enc = new TextEncoder();
function textResponse(text: string): ArrayBuffer {
  const body = enc.encode(JSON.stringify({ encoding: "UTF-8", bytes: text.length * 3, chars: text.length }) + "\n" + text);
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
}

function seedProgress() {
  const key = LS + "progress.json";
  if (localStorage.getItem(key)) return;
  const p: Record<string, unknown> = {};
  const mark = (e: Entry, pct: number, hoursAgo: number, done = false) =>
    (p[e.id] = { pct, para: Math.floor(pct * 2000), updatedAt: now - hoursAgo * 3600_000, mtime: e.mtime, done, totalChars: 900_000 });
  mark(ENTRIES[3], 0.42, 1);
  mark(ENTRIES[14], 0.77, 5);
  mark(ENTRIES.find((e) => e.name.startsWith("회귀한"))!, 0.18, 26);
  mark(ENTRIES.find((e) => e.name.startsWith("북부"))!, 0.63, 50);
  mark(ENTRIES[0], 1, 300, true);
  mark(ENTRIES[1], 1, 200, true);
  localStorage.setItem(key, JSON.stringify({ progress: p }));
  localStorage.setItem(LS + "settings.json", JSON.stringify({ settings: { roots: [ROOT] } }));
}

/** `?platform=android`: a fake phone TTS engine that "speaks" each sentence for ~1.2 s. */
function installFakeSystemTts() {
  const emit = (detail: object) => window.dispatchEvent(new CustomEvent("eltts", { detail }));
  let timers: number[] = [];
  let at = 0;
  (window as unknown as { ElTts: object }).ElTts = {
    init: () => setTimeout(() => emit({ type: "ready" }), 300),
    status: () =>
      JSON.stringify({
        ready: true,
        engine: "com.samsung.SMT",
        korean: true,
        voices: [
          { id: "ko-KR-SMTf00", lang: "ko-KR", network: false, quality: 400 },
          { id: "ko-KR-SMTm00", lang: "ko-KR", network: false, quality: 400 },
          { id: "ko-kr-x-kob-network", lang: "ko-KR", network: true, quality: 400 },
        ],
      }),
    speak: (id: string, text: string, rate: number, _p: number, _v: string, _vol: number, gapMs: number, flush: boolean) => {
      if (flush) {
        timers.forEach(clearTimeout);
        timers = [];
        at = Date.now();
      }
      const len = Math.max(600, (text.length * 70) / rate);
      at = Math.max(at, Date.now());
      timers.push(window.setTimeout(() => emit({ type: "start", id }), at - Date.now()));
      at += len;
      timers.push(window.setTimeout(() => emit({ type: "done", id }), at - Date.now()));
      at += gapMs;
    },
    stop: () => {
      timers.forEach(clearTimeout);
      timers = [];
    },
    openSettings: () => console.info("[mock] open TTS settings"),
  };
}

export function installTauriMock() {
  seedProgress();
  if (new URLSearchParams(location.search).get("platform") === "android") installFakeSystemTts();
  mockWindows("main");
  let rid = 1;
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      switch (cmd) {
        case "app_platform":
          return new URLSearchParams(location.search).get("platform") ?? "windows";
        case "device_name":
          return "DEV-PC";
        case "scan_library":
          return ENTRIES;
        case "watch_roots":
          return null;
        case "list_encodings":
          return [["auto", "자동"], ["utf-8", "UTF-8"], ["euc-kr", "EUC-KR (CP949)"]];
        case "read_text":
          return textResponse(SAMPLE);
        case "tts_status":
          return { installed: false, bundled: false, dir: null, downloadBytes: 380_000_000, voices: ["F1", "M1"] };
        case "gdrive_auth_available":
          return true;
        case "plugin:store|load": {
          const id = rid++;
          stores.set(id, String(a.path));
          return id;
        }
        case "plugin:store|get": {
          const data = JSON.parse(localStorage.getItem(LS + stores.get(a.rid as number)) ?? "{}");
          const k = a.key as string;
          return [data[k] ?? null, k in data];
        }
        case "plugin:store|set": {
          const name = LS + stores.get(a.rid as number);
          const data = JSON.parse(localStorage.getItem(name) ?? "{}");
          data[a.key as string] = a.value;
          localStorage.setItem(name, JSON.stringify(data));
          return null;
        }
        default:
          if (cmd.startsWith("plugin:")) return null;
          console.warn("[mock] unhandled", cmd, a);
          throw new Error(`mock: ${cmd}`);
      }
    },
    { shouldMockEvents: true },
  );
}
