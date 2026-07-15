use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::types::{CommandResult, DocumentPayload, MarkdownDocument};

const SUPPORTED_EXTENSIONS: &[&str] = &["md", "markdown"];

pub fn is_markdown_path(path: &Path) -> bool {
  path
    .extension()
    .and_then(|ext| ext.to_str())
    .map(|ext| SUPPORTED_EXTENSIONS.iter().any(|s| ext.eq_ignore_ascii_case(s)))
    .unwrap_or(false)
}

fn modified_at_ms(metadata: &fs::Metadata) -> f64 {
  metadata
    .modified()
    .ok()
    .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
    .map(|d| d.as_secs_f64() * 1000.0)
    .unwrap_or(0.0)
}

pub fn read_markdown_file(file_path: &str) -> CommandResult<DocumentPayload> {
  let trimmed = file_path.trim();
  if trimmed.is_empty() {
    return CommandResult::failure("INVALID_ARGUMENT", "文件路径无效。");
  }

  let path = PathBuf::from(trimmed);
  if !is_markdown_path(&path) {
    return CommandResult::failure("UNSUPPORTED_FILE_TYPE", "只能打开 .md 或 .markdown 文件。");
  }

  let canonical = match fs::canonicalize(&path) {
    Ok(p) => p,
    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
      return CommandResult::failure("NOT_FOUND", "文件不存在或已被移动。");
    }
    Err(_) => path.clone(),
  };

  let metadata = match fs::metadata(&canonical) {
    Ok(m) => m,
    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
      return CommandResult::failure("NOT_FOUND", "文件不存在或已被移动。");
    }
    Err(_) => {
      return CommandResult::failure("READ_FAILED", "无法读取文件，请检查权限或文件状态。");
    }
  };

  if !metadata.is_file() {
    return CommandResult::failure("NOT_A_FILE", "选择的路径不是文件。");
  }

  let content = match fs::read_to_string(&canonical) {
    Ok(c) => c,
    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
      return CommandResult::failure("NOT_FOUND", "文件不存在或已被移动。");
    }
    Err(_) => {
      return CommandResult::failure("READ_FAILED", "无法读取文件，请检查权限或文件状态。");
    }
  };

  let name = canonical
    .file_name()
    .map(|n| n.to_string_lossy().into_owned())
    .unwrap_or_else(|| trimmed.to_string());

  CommandResult::success(DocumentPayload {
    document: MarkdownDocument {
      path: canonical.to_string_lossy().into_owned(),
      name,
      content,
      modified_at: modified_at_ms(&metadata),
      size: metadata.len(),
    },
  })
}

pub fn save_markdown_file(file_path: &str, content: &str) -> CommandResult<DocumentPayload> {
  let trimmed = file_path.trim();
  if trimmed.is_empty() {
    return CommandResult::failure("INVALID_ARGUMENT", "文件路径无效。");
  }

  if !is_markdown_path(Path::new(trimmed)) {
    return CommandResult::failure("UNSUPPORTED_FILE_TYPE", "只能保存 .md 或 .markdown 文件。");
  }

  let path = PathBuf::from(trimmed);
  let metadata = match fs::metadata(&path) {
    Ok(m) => m,
    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
      return CommandResult::failure("NOT_FOUND", "文件不存在或已被移动。");
    }
    Err(_) => {
      return CommandResult::failure("SAVE_FAILED", "保存失败，请检查权限或文件状态。");
    }
  };

  if !metadata.is_file() {
    return CommandResult::failure("NOT_A_FILE", "选择的路径不是文件。");
  }

  if let Err(_) = fs::write(&path, content) {
    return CommandResult::failure("SAVE_FAILED", "保存失败，请检查权限或文件状态。");
  }

  read_markdown_file(path.to_string_lossy().as_ref()).map_err_to_save()
}

trait MapReadToSave {
  fn map_err_to_save(self) -> Self;
}

impl MapReadToSave for CommandResult<DocumentPayload> {
  fn map_err_to_save(self) -> Self {
    match self {
      CommandResult::Err { code, message, .. } => {
        let mapped = if code == "UNSUPPORTED_FILE_TYPE" {
          code
        } else if code == "NOT_FOUND" || code == "NOT_A_FILE" || code == "INVALID_ARGUMENT" {
          code
        } else {
          "SAVE_FAILED".to_string()
        };
        CommandResult::failure(mapped, message)
      }
      other => other,
    }
  }
}

pub fn choose_markdown_file() -> CommandResult<DocumentPayload> {
  let picked = rfd::FileDialog::new()
    .add_filter("Markdown", &["md", "markdown"])
    .set_title("打开 Markdown 文件")
    .pick_file();

  match picked {
    Some(path) => read_markdown_file(path.to_string_lossy().as_ref()),
    None => CommandResult::failure("CANCELED", "已取消。"),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Write;
  use tempfile::tempdir;

  #[test]
  fn detects_markdown_extensions() {
    assert!(is_markdown_path(Path::new("a.md")));
    assert!(is_markdown_path(Path::new("a.markdown")));
    assert!(is_markdown_path(Path::new("A.MD")));
    assert!(!is_markdown_path(Path::new("a.txt")));
    assert!(!is_markdown_path(Path::new("a")));
  }

  #[test]
  fn reads_and_saves_markdown() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    {
      let mut f = fs::File::create(&path).unwrap();
      write!(f, "# hello").unwrap();
    }

    let open = read_markdown_file(path.to_str().unwrap());
    match open {
      CommandResult::Ok { data, .. } => {
        assert_eq!(data.document.content, "# hello");
        assert_eq!(data.document.name, "note.md");
      }
      CommandResult::Err { code, message, .. } => panic!("{code}: {message}"),
    }

    let saved = save_markdown_file(path.to_str().unwrap(), "# saved");
    match saved {
      CommandResult::Ok { data, .. } => assert_eq!(data.document.content, "# saved"),
      CommandResult::Err { code, message, .. } => panic!("{code}: {message}"),
    }
  }

  #[test]
  fn rejects_non_markdown() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.txt");
    fs::write(&path, "x").unwrap();
    match read_markdown_file(path.to_str().unwrap()) {
      CommandResult::Err { code, .. } => assert_eq!(code, "UNSUPPORTED_FILE_TYPE"),
      _ => panic!("expected failure"),
    }
  }

  #[test]
  fn missing_file_not_found() {
    match read_markdown_file(r"C:\definitely-missing-vellora-file-xyz.md") {
      CommandResult::Err { code, .. } => assert_eq!(code, "NOT_FOUND"),
      _ => panic!("expected failure"),
    }
  }
}
