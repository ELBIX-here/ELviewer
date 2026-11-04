//! Google Drive support on the Rust side.
//!
//! The Drive REST calls themselves run in the webview (`src/lib/gdrive.ts`, plain
//! `fetch` – the API allows cross-origin requests), so the same code serves desktop
//! and Android. Rust only does what the webview can't:
//!
//! * a local cache of downloaded Drive files, so the normal text / archive / ebook
//!   pipeline (`storage::open`) can read them, offline too;
//! * desktop sign-in: OAuth 2.0 for installed apps (browser + loopback redirect +
//!   PKCE), keeping the refresh token in the app data folder. Android signs in
//!   through Google Play services in `MainActivity.kt` instead.

use std::fs::{self, File};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub const ID_PREFIX: &str = "gdrive:";
/// Downloaded books are kept up to this many bytes in total (least recently used go first).
const CACHE_LIMIT: u64 = 2 * 1024 * 1024 * 1024;

pub fn is_gdrive_id(id: &str) -> bool {
    id.starts_with(ID_PREFIX)
}

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("gdrive");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Drive file ids are `[A-Za-z0-9_-]`; refuse anything else so an id can't escape the cache folder.
fn checked_file_id(file_id: &str) -> Result<&str, String> {
    if !file_id.is_empty() && file_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        Ok(file_id)
    } else {
        Err(format!("잘못된 Google Drive 파일 id: {file_id}"))
    }
}

/// Opens the cached copy of a `gdrive:<fileId>` library id.
pub fn open_cached(app: &AppHandle, id: &str) -> Result<File, String> {
    let file_id = checked_file_id(&id[ID_PREFIX.len()..])?;
    let path = cache_dir(app)?.join(file_id);
    let missing = |_| "Google Drive 파일을 아직 내려받지 않았습니다. 인터넷 연결을 확인하세요.".to_string();
    // Opened writable only to touch the timestamp for the LRU eviction.
    match fs::OpenOptions::new().read(true).write(true).open(&path) {
        Ok(f) => {
            let _ = f.set_modified(std::time::SystemTime::now());
            Ok(f)
        }
        Err(_) => File::open(&path).map_err(missing),
    }
}

/// True when the cache holds `file_id` at revision `rev` (Drive's modifiedTime).
pub fn cache_has(app: &AppHandle, file_id: &str, rev: &str) -> Result<bool, String> {
    let dir = cache_dir(app)?;
    let file_id = checked_file_id(file_id)?;
    let stored = fs::read_to_string(dir.join(format!("{file_id}.rev"))).unwrap_or_default();
    Ok(stored == rev && dir.join(file_id).is_file())
}

/// Stores a downloaded Drive file at revision `rev`.
pub fn cache_put(app: &AppHandle, file_id: &str, rev: &str, bytes: &[u8]) -> Result<(), String> {
    let file_id = checked_file_id(file_id)?;
    let dir = cache_dir(app)?;
    let tmp = dir.join(format!("{file_id}.part"));
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, dir.join(file_id)).map_err(|e| e.to_string())?;
    fs::write(dir.join(format!("{file_id}.rev")), rev).map_err(|e| e.to_string())?;
    evict(&dir, file_id);
    Ok(())
}

/// Android: the webview can't hand Rust raw bytes, so downloads arrive as base64 chunks.
/// `index` 0 starts a new file; `last` finishes it like `cache_put`.
pub fn cache_put_chunk(app: &AppHandle, file_id: &str, rev: &str, index: u32, last: bool, data_b64: &str) -> Result<(), String> {
    use base64::Engine;
    use std::io::Write;
    let file_id = checked_file_id(file_id)?;
    let dir = cache_dir(app)?;
    let tmp = dir.join(format!("{file_id}.part"));
    let bytes = base64::engine::general_purpose::STANDARD.decode(data_b64).map_err(|e| e.to_string())?;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(index > 0)
        .truncate(index == 0)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    f.write_all(&bytes).map_err(|e| e.to_string())?;
    drop(f);
    if last {
        fs::rename(&tmp, dir.join(file_id)).map_err(|e| e.to_string())?;
        fs::write(dir.join(format!("{file_id}.rev")), rev).map_err(|e| e.to_string())?;
        evict(&dir, file_id);
    }
    Ok(())
}
/// Drops least recently used files until the cache fits in `CACHE_LIMIT`.
fn evict(dir: &std::path::Path, keep: &str) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = rd
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_none())
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some((m.modified().ok()?, m.len(), e.path()))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort_by_key(|f| f.0);
    for (_, len, path) in files {
        if total <= CACHE_LIMIT {
            break;
        }
        if path.file_name().and_then(|n| n.to_str()) == Some(keep) {
            continue;
        }
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("rev"));
        total -= len;
    }
}

pub fn cache_clear(app: &AppHandle) -> Result<(), String> {
    let dir = cache_dir(app)?;
    fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}


#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessToken {
    access_token: String,
    expires_in: u64,
}

/// Desktop sign-in: OAuth 2.0 for installed apps
/// (https://developers.google.com/identity/protocols/oauth2/native-app).
#[cfg(desktop)]
pub mod auth {
    use super::AccessToken;
    use base64::Engine;
    use sha2::Digest;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Manager};

    const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
    const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
    const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
    const SCOPES: &str = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.appdata";

    /// Set at build time from `src-tauri/google_oauth.json` (see build.rs).
    const CLIENT_ID: Option<&str> = option_env!("ELVIEWER_GOOGLE_CLIENT_ID");
    const CLIENT_SECRET: Option<&str> = option_env!("ELVIEWER_GOOGLE_CLIENT_SECRET");

    /// In-memory access token and when to renew it.
    static ACCESS: Mutex<Option<(String, Instant)>> = Mutex::new(None);
    static CANCEL: AtomicBool = AtomicBool::new(false);

    fn client() -> Result<(&'static str, &'static str), String> {
        match (CLIENT_ID, CLIENT_SECRET) {
            (Some(id), Some(secret)) if !id.is_empty() => Ok((id, secret)),
            _ => Err("NOT_CONFIGURED: 이 빌드에는 Google OAuth 클라이언트가 설정되어 있지 않습니다 (src-tauri/google_oauth.json).".into()),
        }
    }

    pub fn available() -> bool {
        client().is_ok()
    }

    fn token_file(app: &AppHandle) -> Result<PathBuf, String> {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(dir.join("gdrive-auth.json"))
    }

    fn form(pairs: &[(&str, &str)]) -> String {
        let mut s = form_urlencoded::Serializer::new(String::new());
        for (k, v) in pairs {
            s.append_pair(k, v);
        }
        s.finish()
    }

    fn post_form(url: &str, body: String) -> Result<serde_json::Value, String> {
        let res = reqwest::blocking::Client::new()
            .post(url)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body)
            .timeout(Duration::from_secs(30))
            .send()
            .map_err(|e| format!("OFFLINE: Google 서버에 연결할 수 없습니다: {e}"))?;
        let status = res.status();
        let text = res.text().map_err(|e| e.to_string())?;
        let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
        if !status.is_success() {
            let err = v.get("error").and_then(|e| e.as_str()).unwrap_or("error");
            let desc = v.get("error_description").and_then(|e| e.as_str()).unwrap_or("");
            // A revoked or expired refresh token means signing in again.
            let prefix = if err == "invalid_grant" { "NOT_CONNECTED: " } else { "" };
            return Err(format!("{prefix}{err} {desc}"));
        }
        Ok(v)
    }

    fn remember(v: &serde_json::Value) -> Result<AccessToken, String> {
        let access_token = v.get("access_token").and_then(|t| t.as_str()).ok_or("no access_token")?.to_string();
        let expires_in = v.get("expires_in").and_then(|t| t.as_u64()).unwrap_or(3600);
        // Renew a minute early.
        let until = Instant::now() + Duration::from_secs(expires_in.saturating_sub(60));
        *ACCESS.lock().unwrap() = Some((access_token.clone(), until));
        Ok(AccessToken { access_token, expires_in })
    }

    fn random_urlsafe(n: usize) -> Result<String, String> {
        let mut buf = vec![0u8; n];
        getrandom::fill(&mut buf).map_err(|e| e.to_string())?;
        Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf))
    }

    pub fn cancel_connect() {
        CANCEL.store(true, Ordering::SeqCst);
    }

    /// Opens Google's sign-in page in the browser and waits for its redirect to a loopback port.
    pub fn connect(app: &AppHandle) -> Result<AccessToken, String> {
        let (client_id, client_secret) = client()?;
        CANCEL.store(false, Ordering::SeqCst);
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let redirect = format!("http://127.0.0.1:{}", listener.local_addr().map_err(|e| e.to_string())?.port());
        let verifier = random_urlsafe(48)?;
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(verifier.as_bytes()));
        let state = random_urlsafe(16)?;
        let url = format!(
            "{AUTH_URL}?{}",
            form(&[
                ("client_id", client_id),
                ("redirect_uri", &redirect),
                ("response_type", "code"),
                ("scope", SCOPES),
                ("code_challenge", &challenge),
                ("code_challenge_method", "S256"),
                ("state", &state),
                ("access_type", "offline"),
                ("prompt", "consent"),
            ])
        );
        tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| e.to_string())?;

        let deadline = Instant::now() + Duration::from_secs(300);
        let params = loop {
            if CANCEL.load(Ordering::SeqCst) {
                return Err("CANCELLED: 로그인을 취소했습니다.".into());
            }
            if Instant::now() > deadline {
                return Err("CANCELLED: 로그인 시간이 초과되었습니다.".into());
            }
            let mut stream = match listener.accept() {
                Ok((s, _)) => s,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(200));
                    continue;
                }
                Err(e) => return Err(e.to_string()),
            };
            stream.set_nonblocking(false).ok();
            stream.set_read_timeout(Some(Duration::from_secs(10))).ok();
            let mut buf = [0u8; 8192];
            let n = stream.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            let target = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("");
            let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
            let params: std::collections::HashMap<String, String> = form_urlencoded::parse(query.as_bytes()).into_owned().collect();
            // Browsers also ask for /favicon.ico and the like – wait for the real redirect.
            if params.get("state") != Some(&state) {
                let _ = write!(stream, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                continue;
            }
            let ok = params.contains_key("code");
            let page = if ok {
                "ELviewer에 Google Drive가 연결되었습니다. 이 창을 닫아도 됩니다."
            } else {
                "Google Drive 연결이 취소되었습니다. 이 창을 닫고 다시 시도하세요."
            };
            let html = format!("<!doctype html><meta charset=utf-8><title>ELviewer</title><body style=\"font:16px system-ui;padding:40px;background:#1c1d20;color:#d5d7dc\">{page}</body>");
            let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}", html.len());
            if !ok {
                return Err(format!("CANCELLED: {}", params.get("error").map(String::as_str).unwrap_or("인증 실패")));
            }
            break params;
        };

        let v = post_form(
            TOKEN_URL,
            form(&[
                ("client_id", client_id),
                ("client_secret", client_secret),
                ("code", &params["code"]),
                ("code_verifier", &verifier),
                ("redirect_uri", &redirect),
                ("grant_type", "authorization_code"),
            ]),
        )?;
        // Google's consent screen lets people untick individual permissions; without them
        // the API doesn't fail, it just shows nothing – so say so now.
        let granted = v.get("scope").and_then(|s| s.as_str()).unwrap_or("");
        if !granted.contains("drive.readonly") || !granted.contains("drive.appdata") {
            return Err("SCOPE: Google 로그인 화면에서 권한 두 개(Drive 파일 보기, 앱 데이터)를 모두 체크해야 합니다. 다시 연결하세요.".into());
        }
        if let Some(refresh) = v.get("refresh_token").and_then(|t| t.as_str()) {
            let saved = serde_json::json!({ "refresh_token": refresh });
            std::fs::write(token_file(app)?, saved.to_string()).map_err(|e| e.to_string())?;
        }
        remember(&v)
    }

    fn refresh_token(app: &AppHandle) -> Option<String> {
        let s = std::fs::read_to_string(token_file(app).ok()?).ok()?;
        let v: serde_json::Value = serde_json::from_str(&s).ok()?;
        v.get("refresh_token")?.as_str().map(str::to_string)
    }

    /// A valid access token, refreshed when needed. `NOT_CONNECTED: …` when signed out.
    pub fn access_token(app: &AppHandle, force: bool) -> Result<AccessToken, String> {
        if !force {
            if let Some((t, until)) = ACCESS.lock().unwrap().clone() {
                let now = Instant::now();
                if until > now {
                    return Ok(AccessToken { access_token: t, expires_in: (until - now).as_secs() });
                }
            }
        }
        let (client_id, client_secret) = client()?;
        let refresh = refresh_token(app).ok_or("NOT_CONNECTED: Google Drive에 로그인하지 않았습니다.")?;
        let v = post_form(
            TOKEN_URL,
            form(&[
                ("client_id", client_id),
                ("client_secret", client_secret),
                ("refresh_token", &refresh),
                ("grant_type", "refresh_token"),
            ]),
        )?;
        remember(&v)
    }

    pub fn disconnect(app: &AppHandle) {
        if let Some(refresh) = refresh_token(app) {
            // Best effort: also revoke the grant on Google's side.
            let _ = post_form(REVOKE_URL, form(&[("token", &refresh)]));
        }
        *ACCESS.lock().unwrap() = None;
        if let Ok(f) = token_file(app) {
            let _ = std::fs::remove_file(f);
        }
    }
}