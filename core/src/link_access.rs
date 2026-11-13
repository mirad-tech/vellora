//! Link inspection and external launch. Validation is pure; the launch side
//! effect is injected so no link can be opened without the same gate the old
//! command layer enforced.

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
  match percent_decode(cleaned) {
    Ok(s) => s,
    Err(_) => cleaned.to_string(),
  }
}

fn percent_decode(input: &str) -> Result<String, ()> {
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

    return CommandResult::failure("UNSUPPORTED_LINK", "只能打开 Markdown 链接或安全外部链接。");
  }

  let decoded = decode_path(href);
  let Some(local_path) = resolve_document_relative_path(Path::new(document_path), &decoded) else {
    return CommandResult::failure("UNSUPPORTED_LINK", "只能打开 Markdown 链接或安全外部链接。");
  };

  if !is_markdown_path(&local_path) {
    return CommandResult::failure("UNSUPPORTED_LINK", "只能打开 Markdown 链接或安全外部链接。");
  }

  match read_markdown_file(local_path.to_string_lossy().as_ref()) {
    CommandResult::Ok { data, .. } => CommandResult::success(LinkInspectData::Markdown {
      action: "markdown".into(),
      document: data.document,
    }),
    CommandResult::Err { code, message, .. } => CommandResult::failure(code, message),
  }
}

/// Scheme gate for an already-decided external link.
pub fn validate_external_url(url: &str) -> Result<String, (String, String)> {
  let trimmed = url.trim();
  if trimmed.is_empty() {
    return Err(("INVALID_ARGUMENT".into(), "链接无效。".into()));
  }

  let parsed = match Url::parse(trimmed) {
    Ok(u) => u,
    Err(_) => return Err(("UNSUPPORTED_LINK".into(), "链接无效。".into())),
  };

  if parsed.scheme() != "https" && parsed.scheme() != "http" {
    return Err(("DANGEROUS_PROTOCOL".into(), "已阻止不安全链接。".into()));
  }

  Ok(parsed.to_string())
}

/// Open a confirmed HTTP or HTTPS URL through the injected launcher.
pub fn open_external_url(
  url: &str,
  launcher: impl Fn(&str) -> std::io::Result<()>,
) -> CommandResult<EmptyPayload> {
  match validate_external_url(url) {
    Ok(safe) => match launcher(&safe) {
      Ok(()) => CommandResult::success(EmptyPayload {}),
      Err(_) => CommandResult::failure("OPEN_FAILED", "无法打开外部链接。"),
    },
    Err((code, message)) => CommandResult::failure(code, message),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;
  use tempfile::tempdir;

  #[test]
  fn blocks_dangerous_protocols() {
    for href in [
      "javascript:alert(1)",
      "data:text/html,hi",
      "vbscript:msg",
      "file:///c:/x",
    ] {
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
    match open_external_url("javascript:alert(1)", |_| Ok(())) {
      CommandResult::Err { code, .. } => {
        assert!(code == "DANGEROUS_PROTOCOL" || code == "UNSUPPORTED_LINK" || code == "INVALID_ARGUMENT");
      }
      _ => panic!("expected failure"),
    }
  }

  #[test]
  fn open_external_accepts_http_and_https_schemes_only() {
    match validate_external_url("ftp://example.com") {
      Err((code, _)) => assert_eq!(code, "DANGEROUS_PROTOCOL"),
      Ok(url) => panic!("ftp must be rejected, got {url}"),
    }
    assert!(validate_external_url("https://example.com/a?b=1").is_ok());
    assert!(validate_external_url("http://example.com").is_ok());
  }

  #[test]
  fn launcher_is_not_called_for_rejected_links() {
    use std::cell::Cell;
    let called = Cell::new(false);
    let result = open_external_url("file:///c:/windows", |_| {
      called.set(true);
      Ok(())
    });
    assert!(matches!(result, CommandResult::Err { .. }));
    assert!(!called.get());
  }

  #[test]
  fn launcher_failure_is_reported_as_open_failed() {
    let result = open_external_url("https://example.com", |_| {
      Err(std::io::Error::other("no browser"))
    });
    match result {
      CommandResult::Err { code, .. } => assert_eq!(code, "OPEN_FAILED"),
      other => panic!("unexpected: {other:?}"),
    }
  }
}
