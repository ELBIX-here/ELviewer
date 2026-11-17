mod archive;
mod gdrive;
mod library;
mod storage;
mod text;
#[cfg(desktop)]
mod tts;
#[cfg(mobile)]
#[path = "tts_stub.rs"]
mod tts;
mod watcher;

use serde::Serialize;
use std::path::Path;
use tauri::ipc::Response;
use tauri::{AppHandle, State};

/// Load the raw bytes of a file (path or Android URI) or an `archive|member` virtual id.
fn load_bytes(app: &AppHandle, id: &str) -> Result<Vec<u8>, String> {
    if let Some((archive_id, member)) = archive::split_virtual(id) {
        archive::read_member(storage::open(app, archive_id)?, member)
    } else {
        storage::read_all(app, id)
    }
}

fn ext_of(id: &str) -> String {
    let name = id.rsplit(['\\', '/', archive::SEP]).next().unwrap_or(id);
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TextMeta {
    encoding: String,
    bytes: usize,
    chars: usize,
}

/// Returns `<json meta>\n<utf-8 text>` as a raw IPC response so that very large
/// files aren't JSON-escaped on the way to the webview.
#[tauri::command]
async fn read_text(app: AppHandle, id: String, ext: Option<String>, encoding: Option<String>) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = load_bytes(&app, &id)?;
        // Android URI ids carry no file name, so the caller passes the extension.
        let ext = ext.filter(|e| !e.is_empty()).unwrap_or_else(|| ext_of(&id));
        let decoded = text::extract_text(&bytes, &ext, encoding.as_deref())?;
        let meta = TextMeta {
            encoding: decoded.encoding,
            bytes: bytes.len(),
            chars: decoded.text.chars().count(),
        };
        let mut out = serde_json::to_vec(&meta).map_err(|e| e.to_string())?;
        out.push(b'\n');
        out.extend_from_slice(decoded.text.as_bytes());
        Ok(Response::new(out))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Raw bytes for binary formats (epub, pdf, images, ...).
#[tauri::command]
async fn read_binary(app: AppHandle, id: String) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || load_bytes(&app, &id).map(Response::new))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn scan_library(app: AppHandle, roots: Vec<String>) -> Result<Vec<library::Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Desktop roots are paths; Android roots are folder URIs from the system picker.
        let (uris, paths): (Vec<String>, Vec<String>) = roots.into_iter().partition(|r| storage::is_uri_id(r));
        #[allow(unused_mut)]
        let mut out = library::scan(&paths);
        #[cfg(target_os = "android")]
        out.extend(library::scan_android(&app, &uris));
        let _ = (&app, uris);
        out
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct PickedRoot {
    id: String,
    name: String,
}

/// Android: let the user pick a folder through the system picker and keep access across restarts.
#[tauri::command]
async fn pick_root_dir(app: AppHandle) -> Result<Option<PickedRoot>, String> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_android_fs::AndroidFsExt;
        let fs = app.android_fs_async();
        let Some(uri) = fs.picker().pick_dir(None, false).await.map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        fs.picker().persist_uri_permission(&uri).await.map_err(|e| e.to_string())?;
        let name = fs.get_name(&uri).await.unwrap_or_else(|_| "폴더".into());
        let id = uri.to_json_string().map_err(|e| e.to_string())?;
        return Ok(Some(PickedRoot { id, name }));
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("pick_root_dir is Android-only".into())
    }
}

/// Write `contents` to a file the user chooses. Desktop gets a path from the JS save
/// dialog; Android opens the system "create document" picker here.
#[tauri::command]
async fn save_text_as(app: AppHandle, path: Option<String>, file_name: String, contents: String) -> Result<bool, String> {
    if let Some(p) = path {
        std::fs::write(&p, contents).map_err(|e| e.to_string())?;
        return Ok(true);
    }
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_android_fs::AndroidFsExt;
        let fs = app.android_fs_async();
        let Some(uri) = fs.picker().save_file(None, &file_name, Some("text/markdown"), false).await.map_err(|e| e.to_string())? else {
            return Ok(false);
        };
        fs.write(&uri, contents.as_bytes()).await.map_err(|e| e.to_string())?;
        return Ok(true);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, file_name);
        Ok(false)
    }
}

#[tauri::command]
fn app_platform() -> &'static str {
    std::env::consts::OS
}

/// Desktop: the computer's name, shown to other devices as where a book was read.
/// (Android reads its device name in MainActivity.)
#[tauri::command]
fn device_name() -> String {
    ["COMPUTERNAME", "HOSTNAME"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|v| !v.trim().is_empty()))
        .unwrap_or_default()
}

#[tauri::command]
fn watch_roots(app: AppHandle, state: State<'_, watcher::WatchState>, roots: Vec<String>) -> Result<(), String> {
    watcher::watch(app, &state, &roots)
}

#[tauri::command]
fn list_encodings() -> Vec<(&'static str, &'static str)> {
    vec![
        ("auto", "자동 감지"),
        ("utf-8", "UTF-8"),
        ("euc-kr", "EUC-KR / CP949 (한국어)"),
        ("utf-16le", "UTF-16 LE"),
        ("utf-16be", "UTF-16 BE"),
        ("shift_jis", "Shift_JIS (일본어)"),
        ("euc-jp", "EUC-JP (일본어)"),
        ("gb18030", "GB18030 / GBK (중국어 간체)"),
        ("big5", "Big5 (중국어 번체)"),
        ("windows-1252", "Windows-1252 (서유럽)"),
        ("windows-1251", "Windows-1251 (키릴)"),
        ("koi8-r", "KOI8-R"),
        ("iso-8859-1", "ISO-8859-1"),
    ]
}

#[tauri::command]
fn tts_status(app: AppHandle) -> tts::TtsStatus {
    tts::status(&app)
}

#[tauri::command]
async fn tts_download(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || tts::download(&app))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn tts_cancel_download() {
    tts::CANCEL_DOWNLOAD.store(true, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
fn tts_delete(app: AppHandle) -> Result<(), String> {
    tts::delete_downloaded(&app)
}

#[tauri::command]
fn tts_unload() {
    tts::unload();
}

/// Returns `u32 sample_rate (LE)` followed by mono f32 LE PCM samples.
#[tauri::command]
async fn tts_synthesize(app: AppHandle, text: String, voice: String, speed: f32, steps: usize) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = tts::synthesize(&app, &text, &voice, speed, steps)?;
        let mut out = Vec::with_capacity(4 + s.pcm.len() * 4);
        out.extend_from_slice(&s.sample_rate.to_le_bytes());
        for v in s.pcm {
            out.extend_from_slice(&v.to_le_bytes());
        }
        Ok(Response::new(out))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Readable entries inside a zip/7z archive that is already accessible through
/// `storage::open` – used for archives in Google Drive folders once they are cached.
#[tauri::command]
async fn archive_entries(app: AppHandle, id: String, name: String, dir: String, root: String, size: u64, mtime: u64) -> Result<Vec<library::Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        let open_id = id.clone();
        library::add_found(&mut out, library::Found { id, name, dir, root, size, mtime }, || storage::open(&app, &open_id));
        out
    })
    .await
    .map_err(|e| e.to_string())
}

// ---- Google Drive (REST calls live in src/lib/gdrive.ts) -----------------------

#[tauri::command]
fn gdrive_cache_has(app: AppHandle, file_id: String, rev: String) -> Result<bool, String> {
    gdrive::cache_has(&app, &file_id, &rev)
}

/// Raw body = file bytes; headers `x-file-id` and `x-rev` (Drive's modifiedTime).
#[tauri::command]
async fn gdrive_cache_put(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .ok_or_else(|| format!("missing header {name}"))
    };
    let file_id = header("x-file-id")?;
    let rev = header("x-rev")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    gdrive::cache_put(&app, &file_id, &rev, bytes)
}

/// Android counterpart of `gdrive_cache_put`: base64 chunks, `index` 0 first.
#[tauri::command]
fn gdrive_cache_put_chunk(app: AppHandle, file_id: String, rev: String, index: u32, last: bool, data: String) -> Result<(), String> {
    gdrive::cache_put_chunk(&app, &file_id, &rev, index, last, &data)
}

#[tauri::command]
fn gdrive_cache_clear(app: AppHandle) -> Result<(), String> {
    gdrive::cache_clear(&app)
}

/// Desktop: whether this build carries an OAuth client (Android signs in through Play services).
#[tauri::command]
fn gdrive_auth_available() -> bool {
    #[cfg(desktop)]
    return gdrive::auth::available();
    #[cfg(mobile)]
    return true;
}

#[tauri::command]
async fn gdrive_connect(app: AppHandle) -> Result<gdrive::AccessToken, String> {
    #[cfg(desktop)]
    return tauri::async_runtime::spawn_blocking(move || gdrive::auth::connect(&app)).await.map_err(|e| e.to_string())?;
    #[cfg(mobile)]
    {
        let _ = app;
        Err("desktop only".into())
    }
}

#[tauri::command]
fn gdrive_cancel_connect() {
    #[cfg(desktop)]
    gdrive::auth::cancel_connect();
}

#[tauri::command]
async fn gdrive_access_token(app: AppHandle, force: Option<bool>) -> Result<gdrive::AccessToken, String> {
    #[cfg(desktop)]
    return tauri::async_runtime::spawn_blocking(move || gdrive::auth::access_token(&app, force.unwrap_or(false))).await.map_err(|e| e.to_string())?;
    #[cfg(mobile)]
    {
        let _ = (app, force);
        Err("desktop only".into())
    }
}

#[tauri::command]
async fn gdrive_disconnect(app: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    tauri::async_runtime::spawn_blocking(move || gdrive::auth::disconnect(&app)).await.map_err(|e| e.to_string())?;
    #[cfg(mobile)]
    let _ = app;
    Ok(())
}

/// The file the app was started with ("Open with" in Explorer), until the UI takes it.
#[derive(Default)]
struct LaunchFile(std::sync::Mutex<Option<String>>);

/// First non-flag argument that names an existing file, made absolute against `cwd`.
fn file_arg<I: IntoIterator<Item = String>>(args: I, cwd: &Path) -> Option<String> {
    args.into_iter().skip(1).filter(|a| !a.starts_with('-')).find_map(|a| {
        let p = cwd.join(&a);
        p.is_file().then(|| p.to_string_lossy().into_owned())
    })
}

#[tauri::command]
fn take_launch_file(state: State<'_, LaunchFile>) -> Option<String> {
    state.0.lock().ok()?.take()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let launch = LaunchFile::default();
    #[cfg(desktop)]
    if let Ok(cwd) = std::env::current_dir() {
        *launch.0.lock().unwrap() = file_arg(std::env::args(), &cwd);
    }
    let builder = tauri::Builder::default();
    // Desktop: opening another file while ELviewer runs reuses the open window.
    // Registered first, as the plugin requires.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        use tauri::{Emitter, Manager};
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
        if let Some(path) = file_arg(argv, Path::new(&cwd)) {
            let _ = app.emit("open-file", path);
        }
    }));
    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build());
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_android_fs::init());
    // Desktop: the last window size, position and maximized state come back on the next run.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
    builder
        .manage(watcher::WatchState::default())
        .manage(launch)
        .invoke_handler(tauri::generate_handler![
            read_text,
            read_binary,
            scan_library,
            watch_roots,
            list_encodings,
            tts_status,
            tts_download,
            tts_cancel_download,
            tts_delete,
            tts_unload,
            tts_synthesize,
            pick_root_dir,
            save_text_as,
            app_platform,
            device_name,
            archive_entries,
            gdrive_cache_has,
            gdrive_cache_put,
            gdrive_cache_put_chunk,
            gdrive_cache_clear,
            gdrive_auth_available,
            gdrive_connect,
            gdrive_cancel_connect,
            gdrive_access_token,
            gdrive_disconnect,
            take_launch_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod launch_tests {
    use super::file_arg;

    #[test]
    fn picks_the_first_existing_file_and_skips_flags() {
        let dir = std::env::temp_dir().join("elviewer-launch-test");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("책 1.md"), "# hi").unwrap();
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();

        let got = file_arg(args(&["elviewer.exe", "--flag", "책 1.md"]), &dir).unwrap();
        assert_eq!(std::path::Path::new(&got), dir.join("책 1.md"));
        // An absolute path is kept as it is.
        let abs = dir.join("책 1.md").to_string_lossy().into_owned();
        assert_eq!(file_arg(args(&["elviewer.exe", &abs]), std::path::Path::new("C:\\")), Some(abs));
        // Missing files, folders and a bare launch give nothing.
        assert_eq!(file_arg(args(&["elviewer.exe", "없음.md"]), &dir), None);
        assert_eq!(file_arg(args(&["elviewer.exe", "."]), &dir), None);
        assert_eq!(file_arg(args(&["elviewer.exe"]), &dir), None);
    }
}
