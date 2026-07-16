use std::path::Path;

use crate::file_access::is_markdown_path;

/// tauri-driver / msedgedriver on Windows may launch the app with filesystem
/// paths rewritten as `--C:\path\to\file.md` (a leading `--` before the drive).
/// Recover the real path so CLI open still works under WebDriver.
fn normalize_cli_arg(arg: &str) -> &str {
  if let Some(rest) = arg.strip_prefix("--") {
    let bytes = rest.as_bytes();
    if bytes.len() >= 3
      && bytes[0].is_ascii_alphabetic()
      && bytes[1] == b':'
      && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
      return rest;
    }
  }
  arg
}

/// Find the first Markdown path among process/CLI arguments.
pub fn find_markdown_path_in_args(args: &[String]) -> Option<String> {
  for arg in args {
    if arg.is_empty() {
      continue;
    }
    let candidate = normalize_cli_arg(arg);
    // Skip flags (session tokens, help, etc.) — not drive-prefixed paths.
    if candidate.starts_with('-') {
      continue;
    }
    // Skip the executable path itself.
    if candidate.ends_with(".exe") {
      continue;
    }
    let path = Path::new(candidate);
    if is_markdown_path(path) {
      return Some(candidate.to_string());
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

  #[test]
  fn recovers_webdriver_prefixed_windows_path() {
    let args = vec![
      r"G:\app\vellora.exe".into(),
      r"--c:\users\asl\appdata\local\temp\source.md".into(),
      "--vellora-e2e-session=a1b2c3d4-e5f6-4789-a012-3456789abcde".into(),
    ];
    assert_eq!(
      find_markdown_path_in_args(&args).as_deref(),
      Some(r"c:\users\asl\appdata\local\temp\source.md")
    );
  }

  #[test]
  fn does_not_treat_session_flag_as_path() {
    let args = vec![
      "app.exe".into(),
      "--vellora-e2e-session=a1b2c3d4-e5f6-4789-a012-3456789abcde".into(),
    ];
    assert!(find_markdown_path_in_args(&args).is_none());
  }
}
