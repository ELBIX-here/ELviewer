// Downloads the Supertonic 3 TTS model into ./models/supertonic-3 so `tauri build`
// can bundle it into the installer. Run once after cloning:  node scripts/fetch_tts_model.mjs
import { createWriteStream, existsSync, mkdirSync, statSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "models", "supertonic-3");
const BASE = "https://huggingface.co/Supertone/supertonic-3/resolve/main";
// Keep in sync with MODEL_FILES in src-tauri/src/tts.rs
const FILES = [
  ["onnx/tts.json", 8253],
  ["onnx/unicode_indexer.json", 277676],
  ["onnx/duration_predictor.onnx", 3700147],
  ["onnx/text_encoder.onnx", 36416150],
  ["onnx/vector_estimator.onnx", 256534781],
  ["onnx/vocoder.onnx", 101424195],
  ...["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"].map((v) => [`voice_styles/${v}.json`, null]),
  ["LICENSE", 15007],
];

for (const [rel, size] of FILES) {
  const dest = join(DIR, rel);
  if (existsSync(dest) && (size == null || statSync(dest).size === size)) {
    console.log("ok  ", rel);
    continue;
  }
  mkdirSync(dirname(dest), { recursive: true });
  process.stdout.write(`get  ${rel} … `);
  const res = await fetch(`${BASE}/${rel}`);
  if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest + ".part"));
  renameSync(dest + ".part", dest);
  console.log("done");
}
console.log("model ready at", DIR);
