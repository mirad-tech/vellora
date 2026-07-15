use std::path::Path;

use crate::file_access::is_markdown_path;

/// Find the first Markdown path among process/CLI arguments.
pub fn find_markdown_path_in_args(args: &[String]) -> Option<String> {
  for arg in args {
    if arg.is_empty() || arg.starts_with('-') {
      continue;
    }
    // Skip the executable path itself.
    if arg.ends_with(".exe") {
      continue;
    }
    let path = Path::new(arg);
    if is_markdown_path(path) {
      return Some(arg.clone());
    }
  }
  None
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn finds_markdown_arg() {
    let args = vec![
      r"C:\Program Files\Vellora\Vellora.exe".into(),
      "--flag".into(),
      r"C:\docs\readme.md".into(),
    ];
    assert_eq!(
      find_markdown_path_in_args(&args).as_deref(),
      Some(r"C:\docs\readme.md")
    );
  }

  #[test]
  fn ignores_non_markdown() {
    let args = vec!["app.exe".into(), "notes.txt".into(), "--help".into()];
    assert!(find_markdown_path_in_args(&args).is_none());
  }

  #[test]
  fn finds_markdown_extension_case_insensitive() {
    let args = vec!["app.exe".into(), r"D:\a.MARKDOWN".into()];
    assert!(find_markdown_path_in_args(&args).is_some());
  }
}
