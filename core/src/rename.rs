//! In-place renames for the file tree. A rename keeps the entry in its parent
//! directory, so every document-relative image and link stays valid, and it never
//! replaces an existing file or folder.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::file_access::is_markdown_path;
use crate::types::{CommandResult, EmptyPayload, EntryPayload};

fn is_forbidden_char(c: char) -> bool {
  c.is_control() || matches!(c, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*')
}

fn is_reserved_windows_name(name: &str) -> bool {
  let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
  if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
    return true;
  }
  let bytes = stem.as_bytes();
  bytes.len() == 4
    && (stem.starts_with("COM") || stem.starts_with("LPT"))
    && (b'1'..=b'9').contains(&bytes[3])
}

/// Checks a proposed file or folder name. The rules follow Windows on every host
/// so a renamed document stays portable; Markdown files keep a Markdown extension.
pub fn validate_new_name(name: &str, is_markdown_file: bool) -> Result<(), &'static str> {
  if name.is_empty() {
    return Err("名称不能为空。");
  }
  if name.trim() != name {
    return Err("名称首尾不能有空格。");
  }
  if name.ends_with('.') {
    return Err("名称不能以句点结尾。");
  }
  if name.chars().any(is_forbidden_char) {
    return Err("名称不能包含 \\ / : * ? \" < > | 或控制字符。");
  }
  if name.encode_utf16().count() > 255 {
    return Err("名称过长。");
  }
  if is_reserved_windows_name(name) {
    return Err("这是 Windows 保留的名称，请换一个。");
  }
  if is_markdown_file && !is_markdown_path(Path::new(name)) {
    return Err("文件扩展名必须是 .md 或 .markdown。");
  }
  Ok(())
}

/// Resolves `path` for a rename without following the entry itself. Only the
/// parent folder is made canonical, so a symlink or junction stays the link and
/// a rename never reaches the folder or file it points to. Returns the entry and
/// its own (not followed) metadata.
pub fn resolve_entry(path: &Path) -> io::Result<(PathBuf, fs::Metadata)> {
  let name =
    path.file_name().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
  let parent = match path.parent() {
    Some(parent) if !parent.as_os_str().is_empty() => parent,
    _ => Path::new("."),
  };
  let entry = fs::canonicalize(parent)?.join(name);
  let own = fs::symlink_metadata(&entry)?;
  if own.file_type().is_symlink() {
    return Ok((entry, own));
  }
  // Not a link: canonicalizing now only adopts the spelling the disk uses.
  Ok((fs::canonicalize(&entry)?, own))
}

/// Renames `from` to `to` without ever replacing an existing entry. A link is
/// renamed as itself.
#[cfg(windows)]
pub fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
  use std::os::windows::ffi::OsStrExt;
  use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
  let wide = |path: &Path| path.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<u16>>();
  let (source, target) = (wide(from), wide(to));
  // Flags 0: no MOVEFILE_REPLACE_EXISTING, so an existing target fails with
  // ERROR_ALREADY_EXISTS, and no MOVEFILE_COPY_ALLOWED, so nothing is copied.
  // NTFS still allows a case-only change of the same entry.
  if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0) } == 0 {
    return Err(io::Error::last_os_error());
  }
  Ok(())
}

/// Renames `from` to `to` without replacing a different existing entry.
#[cfg(not(windows))]
pub fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
  // Portable fallback for a future Linux build. The check and the rename are not
  // atomic: switch to renameat2(RENAME_NOREPLACE) when that target ships.
  match std::fs::symlink_metadata(to) {
    Ok(target) => {
      if !same_entry(&std::fs::symlink_metadata(from)?, &target) {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, "target exists"));
      }
    }
    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
    Err(error) => return Err(error),
  }
  std::fs::rename(from, to)
}

#[cfg(unix)]
fn same_entry(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
  use std::os::unix::fs::MetadataExt;
  a.dev() == b.dev() && a.ino() == b.ino()
}

#[cfg(not(any(unix, windows)))]
fn same_entry(_: &std::fs::Metadata, _: &std::fs::Metadata) -> bool {
  false
}

const UNTITLED: &str = "未命名";

fn create_failure<T>(error: &io::Error) -> CommandResult<T> {
  match error.kind() {
    io::ErrorKind::NotFound => CommandResult::failure("NOT_FOUND", "文件夹不存在或已被移动。"),
    io::ErrorKind::AlreadyExists => CommandResult::failure("TARGET_EXISTS", "已存在同名的文件或文件夹。"),
    io::ErrorKind::PermissionDenied => {
      CommandResult::failure("CREATE_FAILED", "无法新建文件：没有写入权限。")
    }
    _ => CommandResult::failure("CREATE_FAILED", format!("无法新建文件：{error}")),
  }
}

fn create_new_file(path: &Path) -> io::Result<()> {
  fs::OpenOptions::new().write(true).create_new(true).open(path).map(drop)
}

/// Creates an empty Markdown file in `directory`, never replacing an existing
/// entry. An empty `name` picks the first free "未命名.md", "未命名 2.md", ...
pub fn create_markdown_entry(directory: &str, name: &str) -> CommandResult<EntryPayload> {
  let trimmed = directory.trim();
  if trimmed.is_empty() {
    return CommandResult::failure("INVALID_ARGUMENT", "路径无效。");
  }
  // Keep the folder as the caller named it: canonicalizing would follow a
  // junction or symlink, and the file tree would no longer find the new file.
  let directory = Path::new(trimmed);
  if !directory.is_absolute() {
    return CommandResult::failure("INVALID_ARGUMENT", "路径无效。");
  }
  match fs::metadata(directory) {
    Ok(metadata) if metadata.is_dir() => {}
    Ok(_) => return CommandResult::failure("NOT_A_DIRECTORY", "选择的路径不是文件夹。"),
    Err(error) => return create_failure(&error),
  }
  let created = |path: PathBuf| {
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let real = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
    CommandResult::success(EntryPayload {
      path: path.to_string_lossy().into_owned(),
      name,
      real_path: real.to_string_lossy().into_owned(),
    })
  };
  if !name.is_empty() {
    if let Err(message) = validate_new_name(name, true) {
      return CommandResult::failure("INVALID_NAME", message);
    }
    let path = directory.join(name);
    return match create_new_file(&path) {
      Ok(()) => created(path),
      Err(error) => create_failure(&error),
    };
  }
  for index in 1..=999u32 {
    let candidate = if index == 1 { format!("{UNTITLED}.md") } else { format!("{UNTITLED} {index}.md") };
    let path = directory.join(candidate);
    match create_new_file(&path) {
      Ok(()) => return created(path),
      Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
      Err(error) => return create_failure(&error),
    }
  }
  CommandResult::failure("CREATE_FAILED", "无法新建文件：未命名文件过多，请先整理文件夹。")
}

/// Removes a Markdown file that was created for the user and then abandoned.
/// Only an empty regular file is removed: anything with content, a link, a
/// folder or another file type is left in place. A missing file counts as done.
pub fn remove_empty_markdown(path: &str) -> CommandResult<EmptyPayload> {
  let trimmed = path.trim();
  if trimmed.is_empty() {
    return CommandResult::failure("INVALID_ARGUMENT", "路径无效。");
  }
  let path = Path::new(trimmed);
  if !is_markdown_path(path) {
    return CommandResult::failure("UNSUPPORTED_FILE_TYPE", "只能删除 .md 或 .markdown 文件。");
  }
  let metadata = match fs::symlink_metadata(path) {
    Ok(metadata) => metadata,
    Err(error) if error.kind() == io::ErrorKind::NotFound => return CommandResult::success(EmptyPayload {}),
    Err(error) => return CommandResult::failure("REMOVE_FAILED", format!("无法删除文件：{error}")),
  };
  if !metadata.is_file() {
    return CommandResult::failure("NOT_A_FILE", "选择的路径不是文件。");
  }
  if metadata.len() != 0 {
    return CommandResult::failure("NOT_EMPTY", "文件已有内容，未删除。");
  }
  match fs::remove_file(path) {
    Ok(()) => CommandResult::success(EmptyPayload {}),
    Err(error) if error.kind() == io::ErrorKind::NotFound => CommandResult::success(EmptyPayload {}),
    Err(error) => CommandResult::failure("REMOVE_FAILED", format!("无法删除文件：{error}")),
  }
}

#[cfg(test)]
pub(crate) fn make_dir_link(target: &Path, link: &Path) -> bool {
  #[cfg(unix)]
  {
    std::os::unix::fs::symlink(target, link).is_ok()
  }
  #[cfg(windows)]
  {
    // Directory symlinks need a privilege; a junction does not.
    std::os::windows::fs::symlink_dir(target, link).is_ok()
      || std::process::Command::new("cmd")
        .arg("/C")
        .arg("mklink")
        .arg("/J")
        .arg(link)
        .arg(target)
        .output()
        .is_ok_and(|output| output.status.success())
  }
  #[cfg(not(any(unix, windows)))]
  {
    false
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn accepts_ordinary_names() {
    for name in ["note.md", "说明.markdown", "A B.MD", "v0.1.5.md", "console.md"] {
      assert_eq!(validate_new_name(name, true), Ok(()), "{name}");
    }
    assert_eq!(validate_new_name("设计", false), Ok(()));
  }

  #[test]
  fn rejects_unsafe_or_non_portable_names() {
    for name in [
      "", " a.md", "a.md ", "a.md.", "..", "a/b.md", "a\\b.md", "a:b.md", "bad?.md", "x*.md", "tab\t.md",
      "con.md", "LPT1.md", "nul",
    ] {
      assert!(validate_new_name(name, true).is_err(), "{name}");
    }
    assert!(validate_new_name("COM9", false).is_err());
    assert!(validate_new_name("notes.txt", true).is_err());
    assert!(validate_new_name(&"a".repeat(256), false).is_err());
  }

  #[test]
  fn untitled_files_never_replace_existing_ones() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("未命名.md"), "keep").unwrap();
    let created = match create_markdown_entry(dir.path().to_str().unwrap(), "") {
      CommandResult::Ok { data, .. } => data,
      other => panic!("{other:?}"),
    };
    assert_eq!(created.name, "未命名 2.md");
    assert_eq!(fs::read_to_string(dir.path().join("未命名.md")).unwrap(), "keep");
    assert!(fs::read(dir.path().join("未命名 2.md")).unwrap().is_empty());
  }

  #[test]
  fn named_creation_validates_and_refuses_existing_entries() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    assert!(matches!(create_markdown_entry(root, "notes.md"), CommandResult::Ok { .. }));
    let again = create_markdown_entry(root, "notes.md");
    assert!(matches!(again, CommandResult::Err { ref code, .. } if code == "TARGET_EXISTS"), "{again:?}");
    if cfg!(windows) {
      let other_case = create_markdown_entry(root, "NOTES.md");
      assert!(matches!(other_case, CommandResult::Err { ref code, .. } if code == "TARGET_EXISTS"));
    }
    for name in ["notes.txt", "bad?.md", "con.md", " lead.md"] {
      let result = create_markdown_entry(root, name);
      assert!(
        matches!(result, CommandResult::Err { ref code, .. } if code == "INVALID_NAME"),
        "{name}: {result:?}"
      );
    }
    let missing = dir.path().join("missing");
    let result = create_markdown_entry(missing.to_str().unwrap(), "");
    assert!(matches!(result, CommandResult::Err { ref code, .. } if code == "NOT_FOUND"), "{result:?}");
    let file = dir.path().join("notes.md");
    let result = create_markdown_entry(file.to_str().unwrap(), "");
    assert!(matches!(result, CommandResult::Err { ref code, .. } if code == "NOT_A_DIRECTORY"), "{result:?}");
  }

  #[test]
  fn new_files_keep_a_linked_folder_and_report_the_real_file_too() {
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    fs::create_dir_all(&real).unwrap();
    let link = dir.path().join("link");
    if !make_dir_link(&real, &link) {
      eprintln!("skipped: this system cannot create a directory link");
      return;
    }
    let created = match create_markdown_entry(link.to_str().unwrap(), "") {
      CommandResult::Ok { data, .. } => data,
      other => panic!("{other:?}"),
    };
    assert!(Path::new(&created.path).starts_with(&link), "{created:?}");
    assert_eq!(PathBuf::from(&created.real_path), fs::canonicalize(real.join("未命名.md")).unwrap());
    let relative = create_markdown_entry("relative", "");
    assert!(matches!(relative, CommandResult::Err { ref code, .. } if code == "INVALID_ARGUMENT"));
  }

  #[test]
  fn only_empty_regular_markdown_files_are_removed() {
    let dir = tempfile::tempdir().unwrap();
    let empty = dir.path().join("empty.md");
    fs::write(&empty, "").unwrap();
    assert!(matches!(remove_empty_markdown(empty.to_str().unwrap()), CommandResult::Ok { .. }));
    assert!(!empty.exists());
    assert!(matches!(remove_empty_markdown(empty.to_str().unwrap()), CommandResult::Ok { .. }));

    let written = dir.path().join("written.md");
    fs::write(&written, "keep").unwrap();
    let result = remove_empty_markdown(written.to_str().unwrap());
    assert!(matches!(result, CommandResult::Err { ref code, .. } if code == "NOT_EMPTY"), "{result:?}");
    assert_eq!(fs::read_to_string(&written).unwrap(), "keep");

    let text = dir.path().join("empty.txt");
    fs::write(&text, "").unwrap();
    let result = remove_empty_markdown(text.to_str().unwrap());
    assert!(matches!(result, CommandResult::Err { ref code, .. } if code == "UNSUPPORTED_FILE_TYPE"));
    assert!(text.exists());

    let folder = dir.path().join("folder.md");
    fs::create_dir(&folder).unwrap();
    let result = remove_empty_markdown(folder.to_str().unwrap());
    assert!(matches!(result, CommandResult::Err { ref code, .. } if code == "NOT_A_FILE"), "{result:?}");
    assert!(folder.is_dir());
  }
}
