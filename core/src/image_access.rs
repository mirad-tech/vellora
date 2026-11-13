//! Local image resolution. The native view consumes decoded bytes directly;
//! the data-URL shape is kept for parity tests with the frozen baseline.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

use crate::path_policy::resolve_document_relative_path;
use crate::types::{CommandResult, ImagePayload};

pub const DEFAULT_MAX_MARKDOWN_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedImage {
  pub path: PathBuf,
  pub mime: &'static str,
  pub bytes: Vec<u8>,
}

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

/// Resolve and read a local image. Shared by every image entry point so a new
/// view cannot bypass the size, type, or directory-boundary rules.
pub fn read_local_image(
  document_path: &str,
  raw_src: &str,
  max_bytes: Option<u64>,
) -> CommandResult<ResolvedImage> {
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

  let file = match fs::File::open(&image_path) {
    Ok(file) => file,
    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
      return CommandResult::failure("IMAGE_NOT_FOUND", "Image no longer exists.");
    }
    Err(_) => return CommandResult::failure("IMAGE_READ_FAILED", "Cannot open image."),
  };
  // Validate the opened object, not just the earlier pathname lookup.
  if !opened_image_matches(&file, &image_path) {
    return CommandResult::failure("UNSUPPORTED_IMAGE_SOURCE", "Image path changed while opening.");
  }
  let metadata = match file.metadata() {
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

  let mut bytes = Vec::new();
  let read_result = file.take(limit.saturating_add(1)).read_to_end(&mut bytes);
  match read_result {
    Ok(_) => {},
    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
      return CommandResult::failure("IMAGE_NOT_FOUND", "图片不存在或已被移动。");
    }
    Err(_) => {
      return CommandResult::failure("IMAGE_READ_FAILED", "无法读取图片，请检查权限或文件状态。");
    }
  };

  if bytes.len() as u64 > limit {
    return CommandResult::failure("IMAGE_TOO_LARGE", "Image exceeds the size limit.");
  }

  CommandResult::success(ResolvedImage {
    path: image_path,
    mime,
    bytes,
  })
}

// Windows returns the normalized path for this actual open handle. This closes
// the canonicalize/open race if a file or parent directory becomes a reparse point.
#[cfg(windows)]
fn opened_image_matches(file: &fs::File, expected: &Path) -> bool {
  use std::os::windows::ffi::OsStringExt;
  use std::os::windows::io::AsRawHandle;
  use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
  let mut buffer = vec![0u16; 512];
  loop {
    let length = unsafe { GetFinalPathNameByHandleW(file.as_raw_handle() as _, buffer.as_mut_ptr(), buffer.len() as u32, 0) } as usize;
    if length == 0 || length > 32768 { return false; }
    if length >= buffer.len() { buffer.resize(length + 1, 0); continue; }
    let actual = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length]));
    return actual == expected;
  }
}

#[cfg(not(windows))]
fn opened_image_matches(_file: &fs::File, expected: &Path) -> bool {
  // The native Qt target is Windows. Keep the existing portable path check;
  // Unix callers retain their platform's original race characteristics.
  fs::canonicalize(expected).is_ok_and(|actual| actual == expected)
}

/// Data-URL form used by the frozen baseline and by parity tests.
pub fn resolve_local_image(
  document_path: &str,
  raw_src: &str,
  max_bytes: Option<u64>,
) -> CommandResult<ImagePayload> {
  match read_local_image(document_path, raw_src, max_bytes) {
    CommandResult::Ok { data, .. } => CommandResult::success(ImagePayload {
      src: format!("data:{};base64,{}", data.mime, BASE64.encode(&data.bytes)),
      mime: data.mime.to_string(),
    }),
    CommandResult::Err {
      ok: _,
      code,
      message,
      conflict_token,
    } => CommandResult::Err {
      ok: false,
      code,
      message,
      conflict_token,
    },
  }
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

  #[test]
  fn decoded_bytes_match_the_file_and_keep_the_resolved_path() {
    let dir = tempdir().unwrap();
    let doc = dir.path().join("doc.md");
    let img = dir.path().join("pic.jpg");
    fs::write(&doc, "# d").unwrap();
    fs::write(&img, b"jpeg-bytes").unwrap();

    let resolved = read_local_image(doc.to_str().unwrap(), "pic.jpg", None).into_result().unwrap();
    assert_eq!(resolved.bytes, b"jpeg-bytes");
    assert_eq!(resolved.mime, "image/jpeg");
    assert!(resolved.path.ends_with("pic.jpg"));
  }

  #[test]
  fn absolute_and_protocol_sources_are_rejected() {
    let dir = tempdir().unwrap();
    let doc = dir.path().join("doc.md");
    fs::write(&doc, "# d").unwrap();
    for src in ["C:/Windows/win.ini", "https://example.com/a.png", "data:image/png;base64,AA"] {
      match read_local_image(doc.to_str().unwrap(), src, None) {
        CommandResult::Err { code, .. } => assert_eq!(code, "UNSUPPORTED_IMAGE_SOURCE", "{src}"),
        other => panic!("expected rejection for {src}, got {other:?}"),
      }
    }
  }
  #[test]
  fn fresh_reads_revalidate_changed_removed_and_oversized_images() {
    let dir = tempdir().unwrap();
    let doc = dir.path().join("doc.md");
    let img = dir.path().join("pic.gif");
    fs::write(&doc, "# doc").unwrap();
    fs::write(&img, b"GIF89a").unwrap();
    let first = read_local_image(doc.to_str().unwrap(), "pic.gif", Some(6)).into_result().unwrap();
    assert_eq!(first.bytes, b"GIF89a");
    fs::write(&img, b"GIF87a").unwrap();
    let second = read_local_image(doc.to_str().unwrap(), "pic.gif", Some(6)).into_result().unwrap();
    assert_eq!(second.bytes, b"GIF87a");
    assert_eq!(first.bytes, b"GIF89a", "returned snapshot must remain owned");
    fs::write(&img, b"GIF89ax").unwrap();
    assert!(matches!(read_local_image(doc.to_str().unwrap(), "pic.gif", Some(6)), CommandResult::Err { code, .. } if code == "IMAGE_TOO_LARGE"));
    fs::remove_file(&img).unwrap();
    assert!(matches!(read_local_image(doc.to_str().unwrap(), "pic.gif", None), CommandResult::Err { code, .. } if code == "IMAGE_NOT_FOUND"));
  }

  #[test]
  #[cfg(windows)]
  fn opened_handle_must_match_authorized_canonical_object() {
    let dir = tempdir().unwrap();
    let image = dir.path().join("image.png");
    let other = dir.path().join("other.png");
    fs::write(&image, b"image").unwrap();
    fs::write(&other, b"other").unwrap();
    let file = fs::File::open(&image).unwrap();
    assert!(opened_image_matches(&file, &fs::canonicalize(&image).unwrap()));
    assert!(!opened_image_matches(&file, &fs::canonicalize(&other).unwrap()));
  }

}
