use std::fs;
use std::path::Path;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

use crate::path_policy::resolve_document_relative_path;
use crate::types::{CommandResult, ImagePayload};

pub const DEFAULT_MAX_MARKDOWN_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

fn mime_for_extension(ext: &str) -> Option<&'static str> {
  match ext.to_ascii_lowercase().as_str() {
    "png" => Some("image/png"),
    "jpg" | "jpeg" => Some("image/jpeg"),
    "gif" => Some("image/gif"),
    "webp" => Some("image/webp"),
    "bmp" => Some("image/bmp"),
    _ => None,
  }
}

fn has_protocol(value: &str) -> bool {
  let bytes = value.as_bytes();
  if bytes.is_empty() || !bytes[0].is_ascii_alphabetic() {
    return false;
  }
  for (i, b) in bytes.iter().enumerate() {
    if *b == b':' {
      return i > 0;
    }
    if !(b.is_ascii_alphanumeric() || *b == b'+' || *b == b'.' || *b == b'-') {
      return false;
    }
  }
  false
}

pub fn resolve_local_image(
  document_path: &str,
  raw_src: &str,
  max_bytes: Option<u64>,
) -> CommandResult<ImagePayload> {
  if document_path.trim().is_empty() {
    return CommandResult::failure("INVALID_ARGUMENT", "文件路径无效。");
  }
  if raw_src.trim().is_empty() {
    return CommandResult::failure("INVALID_ARGUMENT", "图片路径无效。");
  }

  let trimmed = raw_src.trim();
  let cleaned = trimmed.split(['?', '#']).next().unwrap_or(trimmed);

  if has_protocol(cleaned) || Path::new(cleaned).is_absolute() {
    return CommandResult::failure(
      "UNSUPPORTED_IMAGE_SOURCE",
      "仅支持当前 Markdown 文件旁的相对路径图片。",
    );
  }

  let extension = Path::new(cleaned)
    .extension()
    .and_then(|e| e.to_str())
    .unwrap_or("");
  let Some(mime) = mime_for_extension(extension) else {
    return CommandResult::failure("UNSUPPORTED_IMAGE_TYPE", "不支持该图片类型。");
  };

  let Some(image_path) = resolve_document_relative_path(Path::new(document_path), cleaned) else {
    return CommandResult::failure(
      "UNSUPPORTED_IMAGE_SOURCE",
      "仅支持当前 Markdown 文件旁的相对路径图片。",
    );
  };

  let metadata = match fs::metadata(&image_path) {
    Ok(m) => m,
    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
      return CommandResult::failure("IMAGE_NOT_FOUND", "图片不存在或已被移动。");
    }
    Err(_) => {
      return CommandResult::failure("IMAGE_READ_FAILED", "无法读取图片，请检查权限或文件状态。");
    }
  };

  if !metadata.is_file() {
    return CommandResult::failure("IMAGE_NOT_FOUND", "图片不存在或已被移动。");
  }

  let limit = max_bytes.unwrap_or(DEFAULT_MAX_MARKDOWN_IMAGE_BYTES);
  if metadata.len() > limit {
    return CommandResult::failure("IMAGE_TOO_LARGE", "图片过大，已跳过。");
  }

  let bytes = match fs::read(&image_path) {
    Ok(b) => b,
    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
      return CommandResult::failure("IMAGE_NOT_FOUND", "图片不存在或已被移动。");
    }
    Err(_) => {
      return CommandResult::failure("IMAGE_READ_FAILED", "无法读取图片，请检查权限或文件状态。");
    }
  };

  CommandResult::success(ImagePayload {
    src: format!("data:{mime};base64,{}", BASE64.encode(bytes)),
    mime: mime.to_string(),
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Write;
  use tempfile::tempdir;

  #[test]
  fn resolves_relative_png() {
    let dir = tempdir().unwrap();
    let doc = dir.path().join("doc.md");
    let img = dir.path().join("pic.png");
    fs::write(&doc, "# d").unwrap();
    fs::write(&img, b"\x89PNG\r\n\x1a\nfake").unwrap();

    match resolve_local_image(doc.to_str().unwrap(), "pic.png", None) {
      CommandResult::Ok { data, .. } => {
        assert!(data.src.starts_with("data:image/png;base64,"));
        assert_eq!(data.mime, "image/png");
      }
      CommandResult::Err { code, message, .. } => panic!("{code}: {message}"),
    }
  }

  #[test]
  fn rejects_parent_traversal_image() {
    let dir = tempdir().unwrap();
    let nested = dir.path().join("notes");
    fs::create_dir(&nested).unwrap();
    let doc = nested.join("doc.md");
    fs::write(&doc, "# d").unwrap();
    let outside = dir.path().join("secret.png");
    fs::write(&outside, b"x").unwrap();

    match resolve_local_image(doc.to_str().unwrap(), "../secret.png", None) {
      CommandResult::Err { code, .. } => assert_eq!(code, "UNSUPPORTED_IMAGE_SOURCE"),
      _ => panic!("expected failure"),
    }
  }

  #[test]
  fn rejects_oversized_image() {
    let dir = tempdir().unwrap();
    let doc = dir.path().join("doc.md");
    let img = dir.path().join("big.png");
    fs::write(&doc, "# d").unwrap();
    let mut f = fs::File::create(&img).unwrap();
    f.write_all(&[0u8; 64]).unwrap();

    match resolve_local_image(doc.to_str().unwrap(), "big.png", Some(16)) {
      CommandResult::Err { code, .. } => assert_eq!(code, "IMAGE_TOO_LARGE"),
      _ => panic!("expected failure"),
    }
  }

  #[test]
  fn rejects_unsupported_type() {
    let dir = tempdir().unwrap();
    let doc = dir.path().join("doc.md");
    fs::write(&doc, "# d").unwrap();
    match resolve_local_image(doc.to_str().unwrap(), "a.svg", None) {
      CommandResult::Err { code, .. } => assert_eq!(code, "UNSUPPORTED_IMAGE_TYPE"),
      _ => panic!("expected failure"),
    }
  }
}
