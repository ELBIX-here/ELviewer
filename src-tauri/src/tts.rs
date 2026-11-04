//! Offline neural TTS using Supertone's Supertonic 3 (ONNX, 44.1 kHz, OpenRAIL-M).
//!
//! Pipeline (per chunk of text):
//!   unicode ids → duration_predictor → text_encoder → vector_estimator × N steps
//!   (flow matching, starting from gaussian noise) → vocoder → f32 PCM
//!
//! Model files are looked up in the bundled resource folder first (installer
//! ships them), then in the app-data folder (downloaded on first use).

use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use unicode_normalization::UnicodeNormalization;

pub const MODEL_ID: &str = "supertonic-3";
const HF_BASE: &str = "https://huggingface.co/Supertone/supertonic-3/resolve/main";

/// (relative path, size in bytes) – sizes from the Hugging Face listing, used for progress.
pub const MODEL_FILES: &[(&str, u64)] = &[
    ("onnx/tts.json", 8_253),
    ("onnx/unicode_indexer.json", 277_676),
    ("onnx/duration_predictor.onnx", 3_700_147),
    ("onnx/text_encoder.onnx", 36_416_150),
    ("onnx/vector_estimator.onnx", 256_534_781),
    ("onnx/vocoder.onnx", 101_424_195),
    ("voice_styles/F1.json", 292_046),
    ("voice_styles/F2.json", 292_423),
    ("voice_styles/F3.json", 290_794),
    ("voice_styles/F4.json", 291_808),
    ("voice_styles/F5.json", 291_479),
    ("voice_styles/M1.json", 291_748),
    ("voice_styles/M2.json", 292_055),
    ("voice_styles/M3.json", 290_198),
    ("voice_styles/M4.json", 291_522),
    ("voice_styles/M5.json", 291_469),
    ("LICENSE", 15_007),
];

pub const VOICES: &[&str] = &["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"];

// ---------------------------------------------------------------------------
// model location
// ---------------------------------------------------------------------------

fn is_complete(dir: &Path) -> bool {
    MODEL_FILES.iter().all(|(p, _)| dir.join(p).is_file())
}

fn bundled_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?.join("models").join(MODEL_ID);
    is_complete(&dir).then_some(dir)
}

fn download_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("models").join(MODEL_ID))
}

pub fn model_dir(app: &AppHandle) -> Option<PathBuf> {
    bundled_dir(app).or_else(|| download_dir(app).ok().filter(|d| is_complete(d)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsStatus {
    installed: bool,
    bundled: bool,
    dir: Option<String>,
    download_bytes: u64,
    voices: Vec<&'static str>,
}

pub fn status(app: &AppHandle) -> TtsStatus {
    let bundled = bundled_dir(app);
    let dir = model_dir(app);
    TtsStatus {
        installed: dir.is_some(),
        bundled: bundled.is_some(),
        dir: dir.map(|d| d.to_string_lossy().to_string()),
        download_bytes: MODEL_FILES.iter().map(|(_, s)| s).sum(),
        voices: VOICES.to_vec(),
    }
}

// ---------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    file: String,
    done: u64,
    total: u64,
}

pub static CANCEL_DOWNLOAD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn download(app: &AppHandle) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    CANCEL_DOWNLOAD.store(false, Ordering::SeqCst);
    let dir = download_dir(app)?;
    let total: u64 = MODEL_FILES.iter().map(|(_, s)| s).sum();
    let client = reqwest::blocking::Client::builder()
        .user_agent("ELviewer")
        .timeout(None)
        .build()
        .map_err(|e| e.to_string())?;
    let mut done: u64 = 0;
    for (rel, size) in MODEL_FILES {
        let dest = dir.join(rel);
        if dest.is_file() && fs::metadata(&dest).map(|m| m.len() == *size).unwrap_or(false) {
            done += size;
            continue;
        }
        fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
        let part = dest.with_extension("part");
        let mut resp = client
            .get(format!("{HF_BASE}/{rel}"))
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("{rel}: {e}"))?;
        let mut out = fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 1 << 16];
        let mut last_emit = std::time::Instant::now();
        loop {
            if CANCEL_DOWNLOAD.load(Ordering::SeqCst) {
                drop(out);
                let _ = fs::remove_file(&part);
                return Err("cancelled".into());
            }
            let n = resp.read(&mut buf).map_err(|e| format!("{rel}: {e}"))?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            done += n as u64;
            if last_emit.elapsed().as_millis() > 150 {
                last_emit = std::time::Instant::now();
                let _ = app.emit("tts-download", DownloadProgress { file: rel.to_string(), done, total });
            }
        }
        out.flush().map_err(|e| e.to_string())?;
        drop(out);
        fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    }
    let _ = app.emit("tts-download", DownloadProgress { file: "done".into(), done: total, total });
    // A fresh model directory invalidates any loaded engine.
    *ENGINE.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

pub fn delete_downloaded(app: &AppHandle) -> Result<(), String> {
    *ENGINE.lock().map_err(|e| e.to_string())? = None;
    let dir = download_dir(app)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// engine
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct Config {
    ae: AeConfig,
    ttl: TtlConfig,
}
#[derive(Deserialize)]
struct AeConfig {
    sample_rate: i32,
    base_chunk_size: i32,
}
#[derive(Deserialize)]
struct TtlConfig {
    chunk_compress_factor: i32,
    latent_dim: i32,
}

#[derive(Deserialize)]
struct StyleComponent {
    data: Vec<Vec<Vec<f32>>>,
    dims: Vec<usize>,
}
#[derive(Deserialize)]
struct VoiceStyleFile {
    style_ttl: StyleComponent,
    style_dp: StyleComponent,
}

struct Style {
    ttl: (Vec<i64>, Vec<f32>),
    dp: (Vec<i64>, Vec<f32>),
}

fn flatten(c: StyleComponent) -> (Vec<i64>, Vec<f32>) {
    let shape = c.dims.iter().map(|&d| d as i64).collect();
    let data = c.data.into_iter().flatten().flatten().collect();
    (shape, data)
}

struct Engine {
    dir: PathBuf,
    cfg: Config,
    indexer: Vec<i64>,
    dp: Session,
    enc: Session,
    est: Session,
    voc: Session,
    styles: std::collections::HashMap<String, Style>,
}

static ENGINE: LazyLock<Mutex<Option<Engine>>> = LazyLock::new(|| Mutex::new(None));

fn session(path: &Path) -> Result<Session, String> {
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8);
    Session::builder()
        .map_err(|e| e.to_string())?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| e.to_string())?
        .with_intra_threads(threads)
        .map_err(|e| e.to_string())?
        .commit_from_file(path)
        .map_err(|e| format!("{}: {e}", path.display()))
}

impl Engine {
    fn load(dir: &Path) -> Result<Self, String> {
        let onnx = dir.join("onnx");
        let cfg: Config = serde_json::from_slice(&fs::read(onnx.join("tts.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let indexer: Vec<i64> =
            serde_json::from_slice(&fs::read(onnx.join("unicode_indexer.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        Ok(Engine {
            dir: dir.to_path_buf(),
            cfg,
            indexer,
            dp: session(&onnx.join("duration_predictor.onnx"))?,
            enc: session(&onnx.join("text_encoder.onnx"))?,
            est: session(&onnx.join("vector_estimator.onnx"))?,
            voc: session(&onnx.join("vocoder.onnx"))?,
            styles: Default::default(),
        })
    }

    fn style(&mut self, voice: &str) -> Result<&Style, String> {
        if !self.styles.contains_key(voice) {
            if !VOICES.contains(&voice) {
                return Err(format!("unknown voice {voice}"));
            }
            let raw = fs::read(self.dir.join("voice_styles").join(format!("{voice}.json"))).map_err(|e| e.to_string())?;
            let f: VoiceStyleFile = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
            self.styles.insert(voice.to_string(), Style { ttl: flatten(f.style_ttl), dp: flatten(f.style_dp) });
        }
        Ok(&self.styles[voice])
    }

    /// One forward pass over a single (already normalised, ≤ ~120 char) chunk.
    fn infer(&mut self, text: &str, voice: &str, steps: usize, speed: f32) -> Result<Vec<f32>, String> {
        let ids: Vec<i64> = text
            .chars()
            .map(|c| self.indexer.get(c as usize).copied().unwrap_or(-1))
            .collect();
        let n = ids.len();
        if n == 0 {
            return Ok(Vec::new());
        }
        let style = self.style(voice)?;
        let (ttl_shape, ttl) = (style.ttl.0.clone(), style.ttl.1.clone());
        let (dp_shape, dp) = (style.dp.0.clone(), style.dp.1.clone());
        let e = |e: ort::Error| e.to_string();

        let text_ids = Tensor::from_array((vec![1i64, n as i64], ids)).map_err(e)?;
        let text_mask = Tensor::from_array((vec![1i64, 1, n as i64], vec![1f32; n])).map_err(e)?;
        let style_dp = Tensor::from_array((dp_shape, dp)).map_err(e)?;
        let style_ttl = Tensor::from_array((ttl_shape, ttl)).map_err(e)?;

        // 1. duration (seconds)
        let duration = {
            let out = self
                .dp
                .run(ort::inputs! { "text_ids" => &text_ids, "style_dp" => &style_dp, "text_mask" => &text_mask })
                .map_err(e)?;
            let (_, d) = out["duration"].try_extract_tensor::<f32>().map_err(e)?;
            d[0] / speed.max(0.3)
        };

        // 2. text embedding
        let (emb_shape, emb) = {
            let out = self
                .enc
                .run(ort::inputs! { "text_ids" => &text_ids, "style_ttl" => &style_ttl, "text_mask" => &text_mask })
                .map_err(e)?;
            let (shape, data) = out["text_emb"].try_extract_tensor::<f32>().map_err(e)?;
            (shape.iter().copied().collect::<Vec<i64>>(), data.to_vec())
        };
        let text_emb = Tensor::from_array((emb_shape, emb)).map_err(e)?;

        // 3. flow matching from gaussian noise
        let sr = self.cfg.ae.sample_rate;
        let chunk = (self.cfg.ae.base_chunk_size * self.cfg.ttl.chunk_compress_factor) as usize;
        let latent_dim = (self.cfg.ttl.latent_dim * self.cfg.ttl.chunk_compress_factor) as usize;
        let wav_len = (duration * sr as f32) as usize;
        let latent_len = wav_len.div_ceil(chunk).max(1);
        let mut rng = match std::env::var("ELVIEWER_TTS_SEED").ok().and_then(|v| v.parse::<u64>().ok()) {
            Some(seed) => Rng(seed | 1),
            None => Rng::seeded(),
        };
        let mut xt: Vec<f32> = (0..latent_dim * latent_len).map(|_| rng.normal()).collect();
        let latent_mask = Tensor::from_array((vec![1i64, 1, latent_len as i64], vec![1f32; latent_len])).map_err(e)?;
        let total = Tensor::from_array((vec![1i64], vec![steps as f32])).map_err(e)?;
        for step in 0..steps {
            let cur = Tensor::from_array((vec![1i64], vec![step as f32])).map_err(e)?;
            let noisy = Tensor::from_array((vec![1i64, latent_dim as i64, latent_len as i64], xt)).map_err(e)?;
            let out = self
                .est
                .run(ort::inputs! {
                    "noisy_latent" => &noisy,
                    "text_emb" => &text_emb,
                    "style_ttl" => &style_ttl,
                    "latent_mask" => &latent_mask,
                    "text_mask" => &text_mask,
                    "current_step" => &cur,
                    "total_step" => &total
                })
                .map_err(e)?;
            let (_, d) = out["denoised_latent"].try_extract_tensor::<f32>().map_err(e)?;
            xt = d.to_vec();
        }

        // 4. vocoder
        let latent = Tensor::from_array((vec![1i64, latent_dim as i64, latent_len as i64], xt)).map_err(e)?;
        let out = self.voc.run(ort::inputs! { "latent" => &latent }).map_err(e)?;
        let (_, wav) = out["wav_tts"].try_extract_tensor::<f32>().map_err(e)?;
        Ok(wav[..wav_len.min(wav.len())].to_vec())
    }
}

/// Small xorshift + Box–Muller; avoids pulling in `rand` for one gaussian draw.
struct Rng(u64);
impl Rng {
    fn seeded() -> Self {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(42);
        Rng(t | 1)
    }
    fn next_f32(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        ((self.0 >> 40) as f32 + 0.5) / (1u64 << 24) as f32
    }
    fn normal(&mut self) -> f32 {
        let u1 = self.next_f32();
        let u2 = self.next_f32();
        (-2.0 * u1.ln()).sqrt() * (2.0 * std::f32::consts::PI * u2).cos()
    }
}

// ---------------------------------------------------------------------------
// text preparation
// ---------------------------------------------------------------------------

static RE_SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static RE_EMOJI: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}\x{1F1E6}-\x{1F1FF}\x{FE0F}]+").unwrap()
});
static RE_SPACE_PUNCT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r" ([,.!?;:'])").unwrap());
static RE_ENDS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"[.!?;:,'"\u{201C}\u{201D}\u{2018}\u{2019})\]}…。」』】〉》›»~]$"#).unwrap());

fn detect_lang(text: &str) -> &'static str {
    let mut hangul = 0;
    let mut kana = 0;
    let mut latin = 0;
    for c in text.chars() {
        match c as u32 {
            0xAC00..=0xD7A3 | 0x1100..=0x11FF | 0x3130..=0x318F => hangul += 1,
            0x3040..=0x30FF => kana += 1,
            0x41..=0x5A | 0x61..=0x7A => latin += 1,
            _ => {}
        }
    }
    if hangul > 0 && hangul >= kana {
        "ko"
    } else if kana > 0 {
        "ja"
    } else if latin > 0 {
        "en"
    } else {
        "na"
    }
}

/// Mirrors Supertonic's reference preprocessing, plus a few novel-specific cleanups
/// (dialogue brackets, decorative separators, repeated punctuation).
fn normalize(text: &str) -> String {
    let mut t: String = text.nfkd().collect();
    t = RE_EMOJI.replace_all(&t, "").to_string();
    for (from, to) in [
        ("–", "-"),
        ("‑", "-"),
        ("—", "-"),
        ("_", " "),
        ("\u{201C}", "\""),
        ("\u{201D}", "\""),
        ("\u{2018}", "'"),
        ("\u{2019}", "'"),
        ("´", "'"),
        ("`", "'"),
        ("[", " "),
        ("]", " "),
        ("|", " "),
        ("/", " "),
        ("#", " "),
        ("→", " "),
        ("←", " "),
        ("「", "\""),
        ("」", "\""),
        ("『", "\""),
        ("』", "\""),
        ("【", " "),
        ("】", " "),
        ("《", " "),
        ("》", " "),
        ("〈", " "),
        ("〉", " "),
        ("<", " "),
        (">", " "),
        ("*", " "),
        ("=", " "),
        ("…", "..."),
        ("ㆍ", ", "),
        ("·", ", "),
    ] {
        t = t.replace(from, to);
    }
    for s in ["♥", "☆", "★", "♡", "©", "\\", "※"] {
        t = t.replace(s, "");
    }
    // "......" and "!!!!" → a single mark, otherwise the model reads long pauses / squeals.
    while t.contains("....") {
        t = t.replace("....", "...");
    }
    while t.contains("!!") {
        t = t.replace("!!", "!");
    }
    while t.contains("??") {
        t = t.replace("??", "?");
    }
    while t.contains("--") {
        t = t.replace("--", "-");
    }
    t = RE_SPACE_PUNCT.replace_all(&t, "$1").to_string();
    while t.contains("\"\"") {
        t = t.replace("\"\"", "\"");
    }
    t = RE_SPACES.replace_all(&t, " ").trim().to_string();
    if !t.is_empty() && !RE_ENDS.is_match(&t) {
        t.push('.');
    }
    t
}

/// Split into model-sized chunks (Supertonic recommends ≤120 chars for Korean/Japanese).
fn chunks(text: &str, max_chars: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let push_piece = |piece: &str, cur: &mut String, out: &mut Vec<String>| {
        if cur.chars().count() + piece.chars().count() > max_chars && !cur.is_empty() {
            out.push(std::mem::take(cur).trim().to_string());
        }
        cur.push_str(piece);
    };
    // sentence pieces end at . ! ? (keeping the mark), then commas, then spaces
    let mut piece = String::new();
    for c in text.chars() {
        piece.push(c);
        if matches!(c, '.' | '!' | '?' | ',' | ' ') && piece.chars().count() >= 8 || piece.chars().count() >= max_chars {
            push_piece(&piece, &mut cur, &mut out);
            piece.clear();
        }
    }
    if !piece.is_empty() {
        push_piece(&piece, &mut cur, &mut out);
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

/// Drop the model's leading/trailing silence (≈0.5 s each) so sentence clips can be
/// chained with a consistent gap chosen by the player.
fn trim_silence(wav: Vec<f32>, sr: u32) -> Vec<f32> {
    let thr = 0.01f32;
    let margin = (sr as f32 * 0.03) as usize;
    let first = wav.iter().position(|v| v.abs() > thr);
    let last = wav.iter().rposition(|v| v.abs() > thr);
    match (first, last) {
        (Some(a), Some(b)) => wav[a.saturating_sub(margin)..(b + margin).min(wav.len())].to_vec(),
        _ => Vec::new(),
    }
}

pub struct Synth {
    pub sample_rate: u32,
    pub pcm: Vec<f32>,
}

/// Synthesize `text` (any length – long input is chunked and joined with short pauses).
pub fn synthesize(app: &AppHandle, text: &str, voice: &str, speed: f32, steps: usize) -> Result<Synth, String> {
    let mut guard = ENGINE.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        let dir = model_dir(app).ok_or("TTS 음성 모델이 설치되어 있지 않습니다")?;
        *guard = Some(Engine::load(&dir)?);
    }
    synth_with(guard.as_mut().unwrap(), text, voice, speed, steps)
}

fn synth_with(engine: &mut Engine, text: &str, voice: &str, speed: f32, steps: usize) -> Result<Synth, String> {
    let sr = engine.cfg.ae.sample_rate as u32;
    let steps = steps.clamp(2, 16);
    let normalized = normalize(text);
    if normalized.chars().all(|c| !c.is_alphanumeric()) {
        return Ok(Synth { sample_rate: sr, pcm: Vec::new() });
    }
    let lang = detect_lang(&normalized);
    let max = if lang == "ko" || lang == "ja" { 120 } else { 300 };
    let mut pcm = Vec::new();
    for (i, c) in chunks(&normalized, max).iter().enumerate() {
        let tagged = format!("<{lang}>{c}</{lang}>");
        let wav = trim_silence(engine.infer(&tagged, voice, steps, speed)?, sr);
        if i > 0 {
            pcm.extend(std::iter::repeat_n(0.0f32, (sr as f32 * 0.15) as usize));
        }
        pcm.extend(wav);
    }
    Ok(Synth { sample_rate: sr, pcm })
}

/// Release the ~1 GB of ONNX sessions when TTS is switched off.
pub fn unload() {
    if let Ok(mut g) = ENGINE.lock() {
        *g = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lang_detection() {
        assert_eq!(detect_lang("안녕하세요"), "ko");
        assert_eq!(detect_lang("Hello world"), "en");
        assert_eq!(detect_lang("こんにちは"), "ja");
        assert_eq!(detect_lang("1234"), "na");
    }

    #[test]
    fn normalization() {
        assert_eq!(normalize("“아, 저……”").chars().filter(|c| *c == '"').count(), 2);
        assert!(normalize("끝났다!!!!").ends_with('!'));
        assert!(!normalize("끝났다!!!!").contains("!!"));
        assert!(normalize("문장 끝").ends_with('.'));
        assert!(!normalize("| 106화. 수호자").contains('|'));
    }

    /// Real-model smoke test: `cargo test --release -- --ignored tts_model --nocapture`
    #[test]
    #[ignore]
    fn tts_model() {
        let dir = std::env::var("ELVIEWER_TTS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join("../models").join(MODEL_ID));
        let tag = std::env::var("ELVIEWER_TTS_TAG").unwrap_or_default();
        let t0 = std::time::Instant::now();
        let mut engine = Engine::load(&dir).expect("load");
        println!("load {:?}", t0.elapsed());
        let out_dir = std::env::temp_dir().join("elviewer-tts");
        fs::create_dir_all(&out_dir).unwrap();
        let text = "“그래도 일단은 다행인가.” 오시안은 고개를 끄덕였다. 저들은 아무래도 다른 이들을 약탈하거나 하는 파티는 아닌 모양이었다.";
        for (voice, steps) in [("F1", 8), ("M1", 8), ("F1", 5)] {
            let t = std::time::Instant::now();
            let s = synth_with(&mut engine, text, voice, 1.0, steps).unwrap();
            let secs = s.pcm.len() as f32 / s.sample_rate as f32;
            let took = t.elapsed().as_secs_f32();
            println!("{voice} steps={steps}: audio {secs:.2}s, took {took:.2}s, RTF {:.3}", took / secs);
            let mut w = Vec::new();
            let n = s.pcm.len() as u32;
            for (tag, v) in [(b"RIFF", 36 + n * 2), (b"WAVE", 0)] { w.extend_from_slice(tag); if tag == b"RIFF" { w.extend_from_slice(&v.to_le_bytes()); } }
            w.extend_from_slice(b"fmt "); w.extend_from_slice(&16u32.to_le_bytes()); w.extend_from_slice(&1u16.to_le_bytes()); w.extend_from_slice(&1u16.to_le_bytes());
            w.extend_from_slice(&s.sample_rate.to_le_bytes()); w.extend_from_slice(&(s.sample_rate * 2).to_le_bytes()); w.extend_from_slice(&2u16.to_le_bytes()); w.extend_from_slice(&16u16.to_le_bytes());
            w.extend_from_slice(b"data"); w.extend_from_slice(&(n * 2).to_le_bytes());
            for v in &s.pcm { w.extend_from_slice(&((v.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes()); }
            fs::write(out_dir.join(format!("{voice}_{steps}{tag}.wav")), w).unwrap();
        }
        println!("wrote to {}", out_dir.display());
    }

    #[test]
    fn chunking() {
        let long = "가나다라마바사아자차. ".repeat(30);
        let cs = chunks(&long, 120);
        assert!(cs.len() > 1);
        assert!(cs.iter().all(|c| c.chars().count() <= 120));
    }
}
