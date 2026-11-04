//! Reading members of zip / 7z archives without extracting them to disk.
//!
//! Virtual ids use the form `<archive id>|inner/dir/file.txt`. `|` cannot appear in
//! a Windows path or in an encoded Android content URI, so the split is unambiguous.
//! The archive type is detected from its magic bytes, so it works for ids that
//! carry no file extension (Android URIs).

use std::io::{Read, Seek, SeekFrom};

pub const SEP: char = '|';

pub struct Member {
    pub name: String,
    pub size: u64,
}

/// Split `archive|inner` into its two halves, if it is a virtual path.
pub fn split_virtual(path: &str) -> Option<(&str, &str)> {
    // The archive part (path or encoded URI) never contains `|`; the member name might.
    let idx = path.find(SEP)?;
    Some((&path[..idx], &path[idx + 1..]))
}

pub fn is_archive_ext(ext: &str) -> bool {
    matches!(ext, "zip" | "7z")
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Zip,
    SevenZ,
}

fn sniff<R: Read + Seek>(r: &mut R) -> Result<Kind, String> {
    let mut magic = [0u8; 6];
    let n = r.read(&mut magic).map_err(|e| e.to_string())?;
    r.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    if n >= 4 && &magic[..2] == b"PK" {
        Ok(Kind::Zip)
    } else if n >= 6 && magic == [b'7', b'z', 0xBC, 0xAF, 0x27, 0x1C] {
        Ok(Kind::SevenZ)
    } else {
        Err("지원하지 않는 압축 형식입니다 (zip, 7z만 지원)".into())
    }
}

/// Zip member names that aren't flagged UTF-8 are usually CP949 on Korean
/// systems; run them through chardetng so they display correctly.
fn decode_zip_name(raw: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(raw) {
        return s.to_string();
    }
    let mut det = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
    det.feed(raw, true);
    let enc = det.guess(Some(b"kr"), chardetng::Utf8Detection::Deny);
    enc.decode(raw).0.into_owned()
}

fn zip_name(file: &zip::read::ZipFile<'_, impl Read>) -> String {
    let raw = file.name_raw();
    if std::str::from_utf8(raw).is_ok() {
        file.name().to_string()
    } else {
        decode_zip_name(raw)
    }
}

pub fn list<R: Read + Seek>(mut r: R) -> Result<Vec<Member>, String> {
    match sniff(&mut r)? {
        Kind::Zip => {
            let mut archive = zip::ZipArchive::new(std::io::BufReader::new(r)).map_err(|e| e.to_string())?;
            let mut out = Vec::with_capacity(archive.len());
            for i in 0..archive.len() {
                let Ok(f) = archive.by_index_raw(i) else { continue };
                if f.is_dir() {
                    continue;
                }
                out.push(Member { name: zip_name(&f), size: f.size() });
            }
            Ok(out)
        }
        Kind::SevenZ => {
            let archive = sevenz_rust2::Archive::read(&mut r, &sevenz_rust2::Password::empty()).map_err(|e| e.to_string())?;
            Ok(archive
                .files
                .iter()
                .filter(|f| !f.is_directory())
                .map(|f| Member { name: f.name().to_string(), size: f.size() })
                .collect())
        }
    }
}

pub fn read_member<R: Read + Seek>(mut r: R, name: &str) -> Result<Vec<u8>, String> {
    match sniff(&mut r)? {
        Kind::Zip => {
            let mut archive = zip::ZipArchive::new(std::io::BufReader::new(r)).map_err(|e| e.to_string())?;
            for i in 0..archive.len() {
                let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
                if zip_name(&f) == name {
                    let mut buf = Vec::with_capacity(f.size() as usize);
                    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
                    return Ok(buf);
                }
            }
            Err(format!("압축 파일 안에 '{name}' 항목이 없습니다"))
        }
        Kind::SevenZ => {
            let mut reader = sevenz_rust2::ArchiveReader::new(r, sevenz_rust2::Password::empty()).map_err(|e| e.to_string())?;
            reader.read_file(name).map_err(|e| e.to_string())
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    /// Builds an in-memory zip (stored, UTF-8 names) from `(name, contents)` pairs.
    pub(crate) fn make_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, data) in files {
            w.start_file(*name, opts).unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    #[test]
    fn splits_virtual_ids_at_the_first_separator() {
        assert_eq!(split_virtual(r"C:\소설\묶음.zip|1부/1권.txt"), Some((r"C:\소설\묶음.zip", "1부/1권.txt")));
        // a member name may itself contain the separator
        assert_eq!(split_virtual("a.zip|x|y.txt"), Some(("a.zip", "x|y.txt")));
        assert_eq!(split_virtual(r"C:\소설\책.txt"), None);
    }

    #[test]
    fn lists_and_reads_zip_members() {
        let z = make_zip(&[("1부/1권.txt", "첫 권".as_bytes()), ("readme.md", b"# hi")]);
        let names: Vec<String> = list(Cursor::new(&z)).unwrap().into_iter().map(|m| m.name).collect();
        assert_eq!(names, vec!["1부/1권.txt", "readme.md"]);
        assert_eq!(read_member(Cursor::new(&z), "1부/1권.txt").unwrap(), "첫 권".as_bytes());
        assert!(read_member(Cursor::new(&z), "없음.txt").is_err());
    }

    #[test]
    fn decodes_cp949_member_names() {
        let (raw, _, _) = encoding_rs::EUC_KR.encode("달빛 조각사 01권.txt");
        assert!(std::str::from_utf8(&raw).is_err());
        assert_eq!(decode_zip_name(&raw), "달빛 조각사 01권.txt");
    }

    #[test]
    fn rejects_unknown_archive_formats() {
        assert!(list(Cursor::new(b"Rar!\x1a\x07\x00".to_vec())).is_err());
    }
}
