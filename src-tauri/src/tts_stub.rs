//! Mobile builds: read-aloud is not available yet (the ONNX model and runtime are
//! desktop-only for now). Same API as `tts.rs` so the command layer is shared.

use serde::Serialize;
use tauri::AppHandle;

pub static CANCEL_DOWNLOAD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsStatus {
    installed: bool,
    bundled: bool,
    dir: Option<String>,
    download_bytes: u64,
    voices: Vec<&'static str>,
}

pub fn status(_app: &AppHandle) -> TtsStatus {
    TtsStatus { installed: false, bundled: false, dir: None, download_bytes: 0, voices: vec![] }
}

const UNSUPPORTED: &str = "모바일에서는 기기 음성 엔진으로 읽어 줍니다";

pub fn download(_app: &AppHandle) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

pub fn delete_downloaded(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

pub fn unload() {}

pub struct Synth {
    pub sample_rate: u32,
    pub pcm: Vec<f32>,
}

pub fn synthesize(_app: &AppHandle, _text: &str, _voice: &str, _speed: f32, _steps: usize) -> Result<Synth, String> {
    Err(UNSUPPORTED.into())
}
