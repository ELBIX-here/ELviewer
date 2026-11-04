//! Platform file access.
//!
//! Desktop ids are plain filesystem paths. On Android, files come from folders the
//! user granted through the system picker (Storage Access Framework), so ids are
//! the plugin's URI serialized as JSON (`{"uri":"content://…","documentTopTreeUri":…}`)
//! and must be opened through the content resolver.
//!
//! Google Drive files (`gdrive:<fileId>`) are read from the local download cache.

use std::fs::File;
use tauri::AppHandle;

/// True when `id` is an Android document URI rather than a filesystem path.
pub fn is_uri_id(id: &str) -> bool {
    id.starts_with('{')
}

pub fn open(app: &AppHandle, id: &str) -> Result<File, String> {
    if crate::gdrive::is_gdrive_id(id) {
        return crate::gdrive::open_cached(app, id);
    }
    #[cfg(target_os = "android")]
    if is_uri_id(id) {
        use tauri_plugin_android_fs::{AndroidFsExt, FsUri};
        let uri = FsUri::from_json_str(id).map_err(|e| e.to_string())?;
        return app.android_fs().open_file_readable(&uri).map_err(|e| format!("파일을 열 수 없습니다: {e}"));
    }
    let _ = app;
    File::open(id).map_err(|e| format!("파일을 열 수 없습니다: {e}"))
}

pub fn read_all(app: &AppHandle, id: &str) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut f = open(app, id)?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}
