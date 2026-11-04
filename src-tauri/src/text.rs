//! Encoding detection and text extraction for the various document formats.

use encoding_rs::Encoding;
use std::io::Read;

/// Result of decoding a document to plain UTF-8 text.
pub struct Decoded {
    pub text: String,
    pub encoding: String,
}

/// Heuristic check for UTF-16 without a BOM: a large share of NUL bytes on one
/// parity of positions is a strong signal (Latin text in UTF-16 is `xx 00 xx 00`).
fn sniff_utf16(bytes: &[u8]) -> Option<&'static Encoding> {
    let sample = &bytes[..bytes.len().min(4096)];
    if sample.len() < 4 {
        return None;
    }
    let (mut even_nul, mut odd_nul) = (0usize, 0usize);
    for (i, b) in sample.iter().enumerate() {
        if *b == 0 {
            if i % 2 == 0 {
                even_nul += 1;
            } else {
                odd_nul += 1;
            }
        }
    }
    let half = sample.len() / 2;
    if odd_nul > half / 3 && even_nul < half / 20 {
        Some(encoding_rs::UTF_16LE)
    } else if even_nul > half / 3 && odd_nul < half / 20 {
        Some(encoding_rs::UTF_16BE)
    } else {
        None
    }
}

/// Decode raw bytes to a String. `forced` is an encoding label chosen by the user
/// (e.g. "euc-kr"); otherwise BOM, then UTF-16 sniffing, then chardetng decide.
pub fn decode_bytes(bytes: &[u8], forced: Option<&str>) -> Decoded {
    let (encoding, skip) = if let Some((enc, len)) = Encoding::for_bom(bytes) {
        (enc, len)
    } else if let Some(enc) = forced.and_then(|l| Encoding::for_label(l.as_bytes())) {
        (enc, 0)
    } else if let Some(enc) = sniff_utf16(bytes) {
        (enc, 0)
    } else {
        let mut det = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Allow);
        det.feed(bytes, true);
        // Prefer Korean as the tie-breaker since that's the primary use case.
        (det.guess(Some(b"kr"), chardetng::Utf8Detection::Allow), 0)
    };
    let (cow, _, _) = encoding.decode(&bytes[skip..]);
    let mut text = cow.into_owned();
    if text.contains('\r') {
        text = text.replace("\r\n", "\n").replace('\r', "\n");
    }
    Decoded {
        text,
        encoding: encoding.name().to_string(),
    }
}

/// Read a member of a zip archive (used for docx/hwpx/epub-like containers).
fn zip_member(bytes: &[u8], predicate: impl Fn(&str) -> bool) -> Vec<(String, Vec<u8>)> {
    let cursor = std::io::Cursor::new(bytes);
    let mut out = Vec::new();
    let Ok(mut archive) = zip::ZipArchive::new(cursor) else {
        return out;
    };
    for i in 0..archive.len() {
        let Ok(mut file) = archive.by_index(i) else { continue };
        let name = file.name().to_string();
        if predicate(&name) {
            let mut buf = Vec::with_capacity(file.size() as usize);
            if file.read_to_end(&mut buf).is_ok() {
                out.push((name, buf));
            }
        }
    }
    out
}

/// Extract text from XML by treating `para_tags` as paragraph boundaries and
/// `text_tags` as text runs. Everything else is dropped. Good enough for OOXML
/// (`w:p` / `w:t`) and HWPX (`hp:p` / `hp:t`).
fn xml_text(xml: &str, para_tag: &str, text_tag: &str, break_tags: &[&str]) -> String {
    let mut out = String::with_capacity(xml.len() / 3);
    let mut rest = xml;
    let mut in_text = false;
    while let Some(lt) = rest.find('<') {
        if in_text {
            out.push_str(&decode_entities(&rest[..lt]));
        }
        rest = &rest[lt + 1..];
        let Some(gt) = rest.find('>') else { break };
        let tag = &rest[..gt];
        rest = &rest[gt + 1..];
        let closing = tag.starts_with('/');
        let name_part = tag.trim_start_matches('/');
        let name = name_part
            .split(|c: char| c.is_whitespace() || c == '/')
            .next()
            .unwrap_or("");
        if name == text_tag {
            in_text = !closing && !tag.ends_with('/');
        } else if name == para_tag {
            if closing {
                out.push('\n');
            }
        } else if break_tags.contains(&name) && !closing {
            out.push('\n');
        }
    }
    out
}

fn decode_entities(s: &str) -> std::borrow::Cow<'_, str> {
    if !s.contains('&') {
        return std::borrow::Cow::Borrowed(s);
    }
    std::borrow::Cow::Owned(html_escape::decode_html_entities(s).into_owned())
}

pub fn docx_text(bytes: &[u8]) -> Option<String> {
    let parts = zip_member(bytes, |n| n == "word/document.xml");
    let (_, xml) = parts.into_iter().next()?;
    let xml = String::from_utf8_lossy(&xml);
    Some(xml_text(&xml, "w:p", "w:t", &["w:br", "w:cr"]))
}

pub fn hwpx_text(bytes: &[u8]) -> Option<String> {
    let mut parts = zip_member(bytes, |n| n.starts_with("Contents/section") && n.ends_with(".xml"));
    if parts.is_empty() {
        return None;
    }
    // section0.xml, section1.xml, ... – natural order by number.
    parts.sort_by_key(|(n, _)| {
        n.trim_start_matches("Contents/section")
            .trim_end_matches(".xml")
            .parse::<u32>()
            .unwrap_or(0)
    });
    let mut out = String::new();
    for (_, xml) in parts {
        let xml = String::from_utf8_lossy(&xml);
        out.push_str(&xml_text(&xml, "hp:p", "hp:t", &["hp:lineBreak"]));
        out.push('\n');
    }
    Some(out)
}

/// Very small HTML → text converter: block-level closers become newlines, all
/// other tags are removed, entities are decoded, whitespace runs are collapsed.
pub fn html_text(html: &str) -> String {
    const BLOCK: &[&str] = &[
        "p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section", "article",
        "blockquote", "pre", "hr", "dd", "dt", "header", "footer", "title",
    ];
    let mut out = String::with_capacity(html.len() / 2);
    let mut rest = html;
    let mut skip_depth: Option<&str> = None;
    let mut in_pre = false;
    while let Some(lt) = rest.find('<') {
        let chunk = &rest[..lt];
        if skip_depth.is_none() {
            push_text(&mut out, &decode_entities(chunk), in_pre);
        }
        rest = &rest[lt + 1..];
        if rest.starts_with("!--") {
            match rest.find("-->") {
                Some(e) => rest = &rest[e + 3..],
                None => break,
            }
            continue;
        }
        let Some(gt) = rest.find('>') else { break };
        let tag = &rest[..gt];
        rest = &rest[gt + 1..];
        let closing = tag.starts_with('/');
        let name = tag
            .trim_start_matches('/')
            .split(|c: char| c.is_whitespace() || c == '/')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if let Some(skipping) = skip_depth {
            if closing && name == skipping {
                skip_depth = None;
            }
            continue;
        }
        if !closing && (name == "script" || name == "style" || name == "head") {
            skip_depth = Some(if name == "script" { "script" } else if name == "style" { "style" } else { "head" });
            continue;
        }
        if name == "pre" {
            in_pre = !closing;
        }
        if BLOCK.contains(&name.as_str()) && !out.ends_with('\n') {
            out.push('\n');
        }
    }
    if skip_depth.is_none() {
        push_text(&mut out, &decode_entities(rest), in_pre);
    }
    out
}

fn push_text(out: &mut String, s: &str, pre: bool) {
    if pre {
        out.push_str(s);
        return;
    }
    let mut last_space = out.ends_with('\n') || out.is_empty();
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !last_space {
                out.push(' ');
                last_space = true;
            }
        } else {
            out.push(ch);
            last_space = false;
        }
    }
}

/// RTF → text via rtf-parser; falls back to a crude control-word stripper.
pub fn rtf_text(bytes: &[u8]) -> String {
    let raw = String::from_utf8_lossy(bytes).into_owned();
    if let Ok(doc) = rtf_parser::RtfDocument::try_from(raw.as_str()) {
        let text = doc.get_text();
        if !text.trim().is_empty() {
            return text;
        }
    }
    // Fallback: strip {\...} groups' control words.
    let mut out = String::new();
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                let mut word = String::new();
                while let Some(&n) = chars.peek() {
                    if n.is_ascii_alphabetic() {
                        word.push(n);
                        chars.next();
                    } else {
                        break;
                    }
                }
                if word == "par" || word == "line" {
                    out.push('\n');
                } else if word.is_empty() {
                    if let Some(n) = chars.next() {
                        if n != '{' && n != '}' && n != '\\' {
                            // \'xx hex escapes and such – ignore
                        } else {
                            out.push(n);
                        }
                    }
                }
                // swallow numeric parameter + delimiter space
                while let Some(&n) = chars.peek() {
                    if n.is_ascii_digit() || n == '-' {
                        chars.next();
                    } else {
                        break;
                    }
                }
                if chars.peek() == Some(&' ') {
                    chars.next();
                }
            }
            '{' | '}' => {}
            '\n' | '\r' => {}
            _ => out.push(c),
        }
    }
    out
}

/// Turn document bytes into plain text according to the file extension.
pub fn extract_text(bytes: &[u8], ext: &str, forced_encoding: Option<&str>) -> Result<Decoded, String> {
    let ext = ext.to_ascii_lowercase();
    match ext.as_str() {
        "docx" => docx_text(bytes)
            .map(|t| Decoded { text: t, encoding: "docx".into() })
            .ok_or_else(|| "DOCX 문서를 읽을 수 없습니다".to_string()),
        "hwpx" => hwpx_text(bytes)
            .map(|t| Decoded { text: t, encoding: "hwpx".into() })
            .ok_or_else(|| "HWPX 문서를 읽을 수 없습니다".to_string()),
        "hwp" => Err("HWP(5.0 바이너리) 형식은 아직 지원하지 않습니다. 한글에서 HWPX 또는 TXT로 저장해 주세요.".into()),
        "rtf" => Ok(Decoded { text: rtf_text(bytes), encoding: "rtf".into() }),
        "html" | "htm" | "xhtml" => {
            let d = decode_bytes(bytes, forced_encoding);
            Ok(Decoded { text: html_text(&d.text), encoding: d.encoding })
        }
        _ => Ok(decode_bytes(bytes, forced_encoding)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_euc_kr() {
        let (bytes, _, _) = encoding_rs::EUC_KR.encode("안녕하세요. 소설 본문입니다.\r\n둘째 줄");
        let d = decode_bytes(&bytes, None);
        assert_eq!(d.encoding, "EUC-KR");
        assert_eq!(d.text, "안녕하세요. 소설 본문입니다.\n둘째 줄");
    }

    #[test]
    fn detects_utf8_bom_and_utf16() {
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice("가나다".as_bytes());
        assert_eq!(decode_bytes(&bom, None).text, "가나다");

        // encoding_rs encodes UTF-16 targets as UTF-8, so build the bytes by hand.
        let u16: Vec<u8> = "hello world, this is utf-16 text without bom"
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        let d = decode_bytes(&u16, None);
        assert_eq!(d.encoding, "UTF-16LE");
        assert!(d.text.starts_with("hello world"));
    }

    #[test]
    fn strips_html() {
        let t = html_text("<html><head><title>x</title><style>p{}</style></head><body><p>첫 &amp; 문단</p><p>둘째<br>줄</p><script>bad()</script></body></html>");
        // <head> (and its title) is dropped entirely.
        assert_eq!(t.trim(), "첫 & 문단\n둘째\n줄");
    }

    #[test]
    fn xml_paragraphs() {
        let xml = r#"<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> World</w:t></w:r></w:p><w:p><w:r><w:t>Next</w:t></w:r></w:p></w:body></w:document>"#;
        assert_eq!(xml_text(xml, "w:p", "w:t", &["w:br"]), "Hello World\nNext\n");
    }
}
