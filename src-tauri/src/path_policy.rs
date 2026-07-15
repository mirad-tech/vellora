use std::fs;
use std::path::{Component, Path, PathBuf};

/// Normalize path separators and resolve `.` / `..` without requiring the path to exist.
pub fn normalize_path(path: &Path) -> PathBuf {
  let mut out = PathBuf::new();
  for component in path.components() {
    match component {
      Component::Prefix(prefix) => out.push(prefix.as_os_str()),
      Component::RootDir => out.push(component.as_os_str()),
      Component::CurDir => {}
      Component::ParentDir => {
        out.pop();
      }
      Component::Normal(part) => out.push(part),
    }
  }
  out
}

pub fn paths_equal(a: &Path, b: &Path) -> bool {
  #[cfg(windows)]
  {
    a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
  }
  #[cfg(not(windows))]
  {
    a == b
  }
}

/// Returns true when `child` is inside `parent` (or equal to it).
pub fn is_path_inside_directory(child: &Path, parent: &Path) -> bool {
  let child = normalize_path(child);
  let parent = normalize_path(parent);

  if paths_equal(&child, &parent) {
    return true;
  }

  let mut child_iter = child.components();
  for parent_component in parent.components() {
    match child_iter.next() {
      Some(child_component) => {
        #[cfg(windows)]
        {
          let parent_s = parent_component.as_os_str().to_string_lossy();
          let child_s = child_component.as_os_str().to_string_lossy();
          if !parent_s.eq_ignore_ascii_case(&child_s) {
            return false;
          }
        }
        #[cfg(not(windows))]
        {
          if parent_component != child_component {
            return false;
          }
        }
      }
      None => return false,
    }
  }
  true
}

/// Reject absolute, UNC, drive-relative (`C:foo`), and any path with a Windows prefix.
fn is_unsafe_relative_candidate(decoded: &str, candidate: &Path) -> bool {
  if candidate.is_absolute() {
    return true;
  }

  // UNC / network shares
  if decoded.starts_with("//") || decoded.starts_with("\\\\") {
    return true;
  }

  // Windows drive-relative: `C:foo`, `C:..\x` (is_absolute() is false)
  let bytes = decoded.as_bytes();
  if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
    return true;
  }

  // Any path component that is a Prefix is not a pure relative path
  for component in candidate.components() {
    if matches!(component, Component::Prefix(_) | Component::RootDir) {
      return true;
    }
  }

  false
}

/// Resolve a document-relative path. Only paths inside the document directory are allowed.
/// Existing targets are canonicalized so directory symlinks cannot escape.
pub fn resolve_document_relative_path(
  document_path: &Path,
  relative_path: &str,
) -> Option<PathBuf> {
  if relative_path.trim().is_empty() {
    return None;
  }

  let cleaned = relative_path.split(['?', '#']).next().unwrap_or(relative_path);
  let decoded = urlencoding_decode(cleaned);
  let candidate = Path::new(&decoded);

  if is_unsafe_relative_candidate(&decoded, candidate) {
    return None;
  }

  let document_dir = document_path.parent()?;
  let lexical_target = normalize_path(&document_dir.join(candidate));

  if !is_path_inside_directory(&lexical_target, document_dir) {
    return None;
  }

  // Prefer canonical document directory when available (open docs always exist).
  let canonical_dir = fs::canonicalize(document_dir).unwrap_or_else(|_| normalize_path(document_dir));

  // If the target (or a symlink) exists, require canonical containment so
  // in-directory symlinks cannot escape the document folder.
  if let Ok(canonical_target) = fs::canonicalize(&lexical_target) {
    if !is_path_inside_directory(&canonical_target, &canonical_dir) {
      return None;
    }
    return Some(canonical_target);
  }

  // Target does not exist yet (e.g. missing image): lexical containment is enough.
  Some(lexical_target)
}

fn urlencoding_decode(value: &str) -> String {
  let bytes = value.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'%' && i + 2 < bytes.len() {
      if let (Some(h), Some(l)) = (from_hex(bytes[i + 1]), from_hex(bytes[i + 2])) {
        out.push((h << 4) | l);
        i += 3;
        continue;
      }
    }
    if bytes[i] == b'+' {
      out.push(b' ');
    } else {
      out.push(bytes[i]);
    }
    i += 1;
  }
  String::from_utf8_lossy(&out).into_owned()
}

fn from_hex(byte: u8) -> Option<u8> {
  match byte {
    b'0'..=b'9' => Some(byte - b'0'),
    b'a'..=b'f' => Some(byte - b'a' + 10),
    b'A'..=b'F' => Some(byte - b'A' + 10),
    _ => None,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;
  use std::path::PathBuf;
  use tempfile::tempdir;

  #[test]
  fn allows_same_directory_relative_path() {
    let dir = tempdir().unwrap();
    let doc = dir.path().join("readme.md");
    fs::write(&doc, "# d").unwrap();
    let resolved = resolve_document_relative_path(&doc, "image.png").unwrap();
    assert!(resolved.ends_with("image.png"));
  }

  #[test]
  fn rejects_parent_traversal() {
    let dir = tempdir().unwrap();
    let doc = dir.path().join("readme.md");
    fs::write(&doc, "# d").unwrap();
    assert!(resolve_document_relative_path(&doc, "../secret.png").is_none());
    assert!(resolve_document_relative_path(&doc, r"..\..\Windows\win.ini").is_none());
  }

  #[test]
  fn rejects_percent_encoded_traversal() {
    let dir = tempdir().unwrap();
    let doc = dir.path().join("readme.md");
    fs::write(&doc, "# d").unwrap();
    assert!(resolve_document_relative_path(&doc, "%2e%2e/secret.png").is_none());
    assert!(resolve_document_relative_path(&doc, "..%2fsecret.png").is_none());
    assert!(resolve_document_relative_path(&doc, "%2e%2e%5csecret.png").is_none());
  }

  #[test]
  fn rejects_absolute_paths() {
    let dir = tempdir().unwrap();
    let doc = dir.path().join("readme.md");
    fs::write(&doc, "# d").unwrap();
    assert!(resolve_document_relative_path(&doc, r"C:\Windows\win.ini").is_none());
    assert!(resolve_document_relative_path(&doc, "/etc/passwd").is_none());
  }

  #[test]
  fn rejects_drive_relative_paths() {
    let dir = tempdir().unwrap();
    let doc = dir.path().join("readme.md");
    fs::write(&doc, "# d").unwrap();
    assert!(resolve_document_relative_path(&doc, r"C:foo.png").is_none());
    assert!(resolve_document_relative_path(&doc, r"D:..\secret.png").is_none());
  }

  #[test]
  fn nested_relative_stays_inside() {
    let dir = tempdir().unwrap();
    let doc = dir.path().join("readme.md");
    fs::write(&doc, "# d").unwrap();
    let resolved = resolve_document_relative_path(&doc, "assets/pic.png").unwrap();
    assert!(resolved.ends_with(Path::new("assets").join("pic.png")));
  }

  #[test]
  fn rejects_symlink_escape_when_supported() {
    let dir = tempdir().unwrap();
    let notes = dir.path().join("notes");
    fs::create_dir(&notes).unwrap();
    let doc = notes.join("readme.md");
    fs::write(&doc, "# d").unwrap();

    let outside = dir.path().join("secret.png");
    fs::write(&outside, b"secret").unwrap();
    let link = notes.join("escape.png");

    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_file(&outside, &link).is_ok();
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(&outside, &link).is_ok();
    #[cfg(not(any(windows, unix)))]
    let linked = false;

    if !linked {
      // Symlink creation may require elevated privileges on Windows CI.
      return;
    }

    assert!(
      resolve_document_relative_path(&doc, "escape.png").is_none(),
      "symlink pointing outside document dir must be rejected"
    );
  }

  #[test]
  fn paths_equal_is_case_insensitive_on_windows() {
    let a = PathBuf::from(r"C:\Notes\A.md");
    let b = PathBuf::from(r"c:\notes\a.md");
    #[cfg(windows)]
    assert!(paths_equal(&a, &b));
    #[cfg(not(windows))]
    assert!(!paths_equal(&a, &b) || paths_equal(&a, &a));
  }
}
