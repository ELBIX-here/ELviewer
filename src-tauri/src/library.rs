//! Library scanning: walk the watched folders and list every readable file,
//! including members of zip/7z archives.

use crate::archive;
use serde::Serialize;
use std::path::Path;
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Unique id – the real path, or `archive|member` for archive members.
    pub id: String,
    pub name: String,
    /// Folder this entry lives in. For archive members this is the archive
    /// path joined with the member's folder, so archives behave like folders.
    pub dir: String,
    pub root: String,
    pub ext: String,
    pub kind: &'static str,
    pub size: u64,
    pub mtime: u64,
    pub in_archive: bool,
}

pub fn kind_for_ext(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "txt" | "text" | "log" | "md" | "markdown" | "html" | "htm" | "xhtml" | "docx" | "hwpx"
        | "hwp" | "rtf" => "text",
        "epub" | "mobi" | "azw" | "azw3" | "prc" | "kf8" | "fb2" | "cbz" => "ebook",
        "pdf" => "pdf",
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "avif" | "bmp" => "image",
        _ => return None,
    })
}

fn ext_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn mtime_of(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A file found while walking a library root, before archive expansion.
pub(crate) struct Found {
    /// id used to open the file (path on desktop, URI JSON on Android, `gdrive:<fileId>`)
    pub id: String,
    pub name: String,
    /// display folder, `\`-separated, starting with the root id
    pub dir: String,
    pub root: String,
    pub size: u64,
    pub mtime: u64,
}

/// Adds `f` to `out`, expanding zip/7z archives into their readable members.
/// Archives behave like folders: their members live under `dir\name`.
pub(crate) fn add_found(out: &mut Vec<Entry>, f: Found, open: impl FnOnce() -> Result<std::fs::File, String>) {
    let ext = ext_of(&f.name);
    if archive::is_archive_ext(&ext) {
        let Ok(members) = open().and_then(archive::list) else { return };
        let readable: Vec<_> = members
            .iter()
            .filter_map(|m| kind_for_ext(&ext_of(&m.name)).map(|k| (m, k)))
            .collect();
        // Archives that are all images are comics – expose as one ebook (cbz).
        let all_images = !readable.is_empty() && readable.iter().all(|(_, k)| *k == "image");
        if all_images && ext == "zip" {
            out.push(Entry { id: f.id, name: f.name, dir: f.dir, root: f.root, ext: "cbz".into(), kind: "ebook", size: f.size, mtime: f.mtime, in_archive: false });
            return;
        }
        let vpath = format!("{}\\{}", f.dir, f.name);
        for (m, kind) in readable {
            if kind == "image" {
                continue;
            }
            let inner = m.name.replace('\\', "/");
            let (inner_dir, inner_name) = match inner.rfind('/') {
                Some(i) => (&inner[..i], &inner[i + 1..]),
                None => ("", inner.as_str()),
            };
            let member_dir = if inner_dir.is_empty() { vpath.clone() } else { format!("{}\\{}", vpath, inner_dir.replace('/', "\\")) };
            out.push(Entry {
                id: format!("{}{}{}", f.id, archive::SEP, m.name),
                name: inner_name.to_string(),
                dir: member_dir,
                root: f.root.clone(),
                ext: ext_of(inner_name),
                kind,
                size: m.size,
                mtime: f.mtime,
                in_archive: true,
            });
        }
        return;
    }
    if let Some(kind) = kind_for_ext(&ext) {
        out.push(Entry { id: f.id, name: f.name, dir: f.dir, root: f.root, ext, kind, size: f.size, mtime: f.mtime, in_archive: false });
    }
}

fn skip_name(n: &str) -> bool {
    n.starts_with('.') || n.eq_ignore_ascii_case("node_modules")
}

/// Desktop: walk filesystem roots.
pub fn scan(roots: &[String]) -> Vec<Entry> {
    let mut out = Vec::new();
    for root in roots {
        let root_path = Path::new(root);
        if !root_path.is_dir() {
            continue;
        }
        for entry in WalkDir::new(root_path)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !e.file_name().to_str().map(skip_name).unwrap_or(false))
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path().to_path_buf();
            let Ok(meta) = entry.metadata() else { continue };
            let found = Found {
                id: path.to_string_lossy().to_string(),
                name: entry.file_name().to_string_lossy().to_string(),
                dir: path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
                root: root.clone(),
                size: meta.len(),
                mtime: mtime_of(&meta),
            };
            add_found(&mut out, found, || std::fs::File::open(&path).map_err(|e| e.to_string()));
        }
    }
    out
}

/// Android: walk folders granted through the system folder picker (SAF).
/// Roots and file ids are the plugin's URI JSON; display folders are `root\sub\dir`.
#[cfg(target_os = "android")]
pub fn scan_android(app: &tauri::AppHandle, roots: &[String]) -> Vec<Entry> {
    use tauri_plugin_android_fs::{AndroidFsExt, Entry as FsEntry, FsUri};
    let fs = app.android_fs();
    let mut out = Vec::new();
    for root in roots {
        let Ok(root_uri) = FsUri::from_json_str(root) else { continue };
        // (folder uri, display path)
        let mut stack = vec![(root_uri, root.clone())];
        while let Some((dir_uri, dir_path)) = stack.pop() {
            let Ok(children) = fs.read_dir(&dir_uri) else { continue };
            for child in children {
                if skip_name(child.name()) {
                    continue;
                }
                match child {
                    FsEntry::Dir { uri, name, .. } => stack.push((uri, format!("{}\\{}", dir_path, name))),
                    FsEntry::File { uri, name, last_modified, len, .. } => {
                        let Ok(id) = uri.to_json_string() else { continue };
                        let mtime = last_modified.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
                        let found = Found { id, name, dir: dir_path.clone(), root: root.clone(), size: len, mtime };
                        add_found(&mut out, found, || fs.open_file_readable(&uri).map_err(|e| e.to_string()));
                    }
                    #[allow(unreachable_patterns)]
                    _ => {}
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::tests::make_zip;
    use std::fs;

    #[test]
    fn maps_extensions_to_reader_kinds() {
        assert_eq!(kind_for_ext("txt"), Some("text"));
        assert_eq!(kind_for_ext("hwpx"), Some("text"));
        assert_eq!(kind_for_ext("azw3"), Some("ebook"));
        assert_eq!(kind_for_ext("pdf"), Some("pdf"));
        assert_eq!(kind_for_ext("webp"), Some("image"));
        assert_eq!(kind_for_ext("exe"), None);
    }

    #[test]
    fn scans_folders_and_expands_archives() {
        let root = std::env::temp_dir().join(format!("elviewer-scan-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("시리즈")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::write(root.join("단편.txt"), "본문").unwrap();
        fs::write(root.join("시리즈").join("2권.epub"), b"PK").unwrap();
        fs::write(root.join(".hidden").join("숨김.txt"), "x").unwrap();
        fs::write(root.join("무시.exe"), "x").unwrap();
        fs::write(root.join("묶음.zip"), make_zip(&[("1부/1권.txt", b"a"), ("cover.jpg", b"img")])).unwrap();
        fs::write(root.join("만화.zip"), make_zip(&[("01.jpg", b"a"), ("02.png", b"b")])).unwrap();

        let root_s = root.to_string_lossy().to_string();
        let mut found = scan(&[root_s.clone()]);
        found.sort_by(|a, b| a.name.cmp(&b.name));
        let _ = fs::remove_dir_all(&root);

        let names: Vec<&str> = found.iter().map(|e| e.name.as_str()).collect();
        // hidden folders, unknown types and images inside mixed archives are skipped
        assert_eq!(names, vec!["1권.txt", "2권.epub", "단편.txt", "만화.zip"]);

        let member = found.iter().find(|e| e.name == "1권.txt").unwrap();
        assert!(member.in_archive);
        assert_eq!(member.id, format!("{}{}1부/1권.txt", root.join("묶음.zip").to_string_lossy(), crate::archive::SEP));
        assert_eq!(member.dir, format!(r"{}\묶음.zip\1부", root_s));

        // an archive of only images is a comic book
        let comic = found.iter().find(|e| e.name == "만화.zip").unwrap();
        assert_eq!((comic.kind, comic.ext.as_str()), ("ebook", "cbz"));
    }
}
