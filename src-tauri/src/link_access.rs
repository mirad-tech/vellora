use std::path::Path;

use url::Url;

use crate::file_access::{is_markdown_path, read_markdown_file};
use crate::path_policy::resolve_document_relative_path;
use crate::types::{CommandResult, EmptyPayload, LinkInspectData};

const DANGEROUS_PROTOCOLS: &[&str] = &["javascript:", "data:", "vbscript:", "file:"];

fn protocol_of(value: &str) -> Option<String> {
  let bytes = value.as_bytes();
  if bytes.is_empty() || !bytes[0].is_ascii_alphabetic() {
    return None;
  }
  for (i, b) in bytes.iter().enumerate() {
    if *b == b':' {
      return Some(value[..i + 1].to_ascii_lowercase());
    }
    if !(b.is_ascii_alphanumeric() || *b == b'+' || *b == b'.' || *b == b'-') {
      return None;
    }
  }
  None
}

fn decode_path(value: &str) -> String {
  let cleaned = value.split(['?', '#']).next().unwrap_or(value);
  match urlencoding::decode(cleaned) {
    Ok(s) => s,
    Err(_) => cleaned.to_string(),
  }
}

// Minimal percent-decode without extra crate dependency (urlencoding may not be in Cargo.toml).
// We already have decode in path_policy; reuse simple approach.
mod urlencoding {
  pub fn decode(input: &str) -> Result<String, ()> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
      if bytes[i] == b'%' && i + 2 < bytes.len() {
        let h = from_hex(bytes[i + 1]);
        let l = from_hex(bytes[i + 2]);
        if let (Some(h), Some(l)) = (h, l) {
          out.push((h << 4) | l);
          i += 3;
          continue;
        }
      }
      out.push(bytes[i]);
      i += 1;
    }
    String::from_utf8(out).map_err(|_| ())
  }

  fn from_hex(byte: u8) -> Option<u8> {
    match byte {
      b'0'..=b'9' => Some(byte - b'0'),
      b'a'..=b'f' => Some(byte - b'a' + 10),
      b'A'..=b'F' => Some(byte - b'A' + 10),
      _ => None,
    }
  }
}

pub fn inspect_markdown_link(
  document_path: &str,
  raw_href: &str,
) -> CommandResult<LinkInspectData> {
  if document_path.trim().is_empty() {
    return CommandResult::failure("INVALID_ARGUMENT", "文件路径无效。");
  }
  if raw_href.trim().is_empty() {
    return CommandResult::failure("INVALID_ARGUMENT", "链接无效。");
  }

  let href = raw_href.trim();
  let protocol = protocol_of(href);

  if let Some(ref p) = protocol {
    if DANGEROUS_PROTOCOLS.contains(&p.as_str()) {
      return CommandResult::failure("DANGEROUS_PROTOCOL", "已阻止不安全链接。");
    }

    if p == "http:" || p == "https:" {
      return match Url::parse(href) {
        Ok(url) => CommandResult::success(LinkInspectData::External {
          action: "external".into(),
          url: url.to_string(),
        }),
        Err(_) => CommandResult::failure("UNSUPPORTED_LINK", "链接无效。"),
      };
    }

    return CommandResult::failure(
      "UNSUPPORTED_LINK",
      "只能打开 Markdown 链接或安全外部链接。",
    );
  }

  let decoded = decode_path(href);
  let Some(local_path) = resolve_document_relative_path(Path::new(document_path), &decoded) else {
    return CommandResult::failure(
      "UNSUPPORTED_LINK",
      "只能打开 Markdown 链接或安全外部链接。",
    );
  };

  if !is_markdown_path(&local_path) {
    return CommandResult::failure(
      "UNSUPPORTED_LINK",
      "只能打开 Markdown 链接或安全外部链接。",
    );
  }

  match read_markdown_file(local_path.to_string_lossy().as_ref()) {
    CommandResult::Ok { data, .. } => CommandResult::success(LinkInspectData::Markdown {
      action: "markdown".into(),
      document: data.document,
    }),
    CommandResult::Err { code, message, .. } => CommandResult::failure(code, message),
  }
}

/// Open a confirmed HTTP or HTTPS URL in the system browser.
pub fn open_external_url(url: &str) -> CommandResult<EmptyPayload> {
  let trimmed = url.trim();
  if trimmed.is_empty() {
    return CommandResult::failure("INVALID_ARGUMENT", "链接无效。");
  }

  let parsed = match Url::parse(trimmed) {
    Ok(u) => u,
    Err(_) => return CommandResult::failure("UNSUPPORTED_LINK", "链接无效。"),
  };

  if parsed.scheme() != "https" && parsed.scheme() != "http" {
    return CommandResult::failure("DANGEROUS_PROTOCOL", "已阻止不安全链接。");
  }

  // HTTP allowed for legacy docs; only after inspect + frontend confirm.
  match open::that(parsed.as_str()) {
    Ok(()) => CommandResult::success(EmptyPayload {}),
    Err(_) => CommandResult::failure("OPEN_FAILED", "无法打开外部链接。"),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;
  use tempfile::tempdir;

  #[test]
  fn blocks_dangerous_protocols() {
    for href in ["javascript:alert(1)", "data:text/html,hi", "vbscript:msg", "file:///c:/x"] {
      match inspect_markdown_link(r"C:\notes\a.md", href) {
        CommandResult::Err { code, .. } => assert_eq!(code, "DANGEROUS_PROTOCOL"),
        _ => panic!("expected dangerous for {href}"),
      }
    }
  }

  #[test]
  fn accepts_https_external() {
    match inspect_markdown_link(r"C:\notes\a.md", "https://example.com/path") {
      CommandResult::Ok {
        data: LinkInspectData::External { action, url },
        ..
      } => {
        assert_eq!(action, "external");
        assert!(url.starts_with("https://example.com/"));
      }
      other => panic!("unexpected: {other:?}"),
    }
  }

  #[test]
  fn opens_relative_markdown() {
    let dir = tempdir().unwrap();
    let a = dir.path().join("a.md");
    let b = dir.path().join("b.md");
    fs::write(&a, "# a").unwrap();
    fs::write(&b, "# b").unwrap();

    match inspect_markdown_link(a.to_str().unwrap(), "b.md") {
      CommandResult::Ok {
        data: LinkInspectData::Markdown { action, document },
        ..
      } => {
        assert_eq!(action, "markdown");
        assert_eq!(document.content, "# b");
      }
      other => panic!("unexpected: {other:?}"),
    }
  }

  #[test]
  fn rejects_traversal_markdown_link() {
    let dir = tempdir().unwrap();
    let nested = dir.path().join("notes");
    fs::create_dir(&nested).unwrap();
    let a = nested.join("a.md");
    fs::write(&a, "# a").unwrap();
    fs::write(dir.path().join("secret.md"), "# s").unwrap();

    match inspect_markdown_link(a.to_str().unwrap(), "../secret.md") {
      CommandResult::Err { code, .. } => assert_eq!(code, "UNSUPPORTED_LINK"),
      _ => panic!("expected failure"),
    }
  }

  #[test]
  fn open_external_rejects_non_http() {
    match open_external_url("javascript:alert(1)") {
      CommandResult::Err { code, .. } => {
        assert!(code == "DANGEROUS_PROTOCOL" || code == "UNSUPPORTED_LINK" || code == "INVALID_ARGUMENT");
      }
      _ => panic!("expected failure"),
    }
  }

  #[test]
  fn open_external_accepts_http_and_https_schemes_only() {
    // Does not actually launch a browser in unit tests if open fails; scheme gate is what we assert.
    match open_external_url("ftp://example.com") {
      CommandResult::Err { code, .. } => {
        assert!(code == "DANGEROUS_PROTOCOL" || code == "UNSUPPORTED_LINK");
      }
      _ => panic!("ftp must be rejected"),
    }
  }
}
