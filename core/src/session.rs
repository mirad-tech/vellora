//! Single-document session state machine.
//!
//! Ported from the frozen baseline (`src-tauri/src/lib.rs`) minus the Tauri
//! window/IPC glue. The invariants that matter for data safety are preserved:
//!
//! * only the currently opened document may be saved or used as a link base;
//! * a queued save re-validates the session after a document switch;
//! * inspection never mutates session, dirty flag, or close intent;
//! * a failed open never clears session, dirty flag, or a pending close prompt.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use crate::file_access;
use crate::path_policy;
use crate::reliable_save::SaveBaseline;
use crate::rename;
use crate::types::{
  CommandResult, DeletePayload, DeleteTargetPayload, DocumentPayload, EmptyPayload, LinkInspectData,
  MarkdownDocument, MoveTargetPayload, RenamePayload,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CloseAction {
  CloseWindow,
}

#[derive(Debug, Default)]
pub struct CloseState {
  pub allow_window_close: bool,
  pub prompt_pending: bool,
  pub action: Option<CloseAction>,
}

#[derive(Debug, Default)]
pub struct LaunchState {
  pending_path: Option<String>,
  frontend_ready: bool,
}

#[derive(Debug, Default)]
pub struct SessionState {
  /// Serializes disk reads/session replacement with saves, including the final
  /// fingerprint check and atomic replacement. Never held by close callbacks.
  pub document_operation: Mutex<()>,
  save_baseline: Mutex<Option<SaveBaseline>>,
  launch_state: Mutex<LaunchState>,
  /// Only the currently opened document may be saved / used as a link base.
  pub current_document: Mutex<Option<PathBuf>>,
  /// Whether the editor reports unsaved changes (for close protection).
  pub has_unsaved_changes: Mutex<bool>,
  pub close_state: Mutex<CloseState>,
}

pub fn lock_mutex<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
  mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn set_current_document(state: &SessionState, document: &MarkdownDocument) {
  *lock_mutex(&state.current_document) = Some(PathBuf::from(&document.path));
  *lock_mutex(&state.save_baseline) = Some(SaveBaseline::new(&document.content));
}

pub fn remember_opened(state: &SessionState, result: &CommandResult<DocumentPayload>) {
  if let CommandResult::Ok { data, .. } = result {
    set_current_document(state, &data.document);
    *lock_mutex(&state.has_unsaved_changes) = false;
    clear_close_flags_if_idle(state);
  }
}

pub fn clear_close_flags(state: &SessionState) {
  *lock_mutex(&state.close_state) = CloseState::default();
}

pub fn clear_close_flags_if_idle(state: &SessionState) {
  let mut close = lock_mutex(&state.close_state);
  if !close.prompt_pending {
    *close = CloseState::default();
  }
}

pub fn require_session_document(
  state: &SessionState,
  claimed_path: &str,
) -> Result<PathBuf, CommandResult<EmptyPayload>> {
  let current = lock_mutex(&state.current_document);
  let Some(ref session) = *current else {
    return Err(CommandResult::failure("NO_DOCUMENT", "当前没有已打开的文档。"));
  };

  let claimed = PathBuf::from(claimed_path.trim());
  if claimed_path.trim().is_empty() || !path_policy::paths_equal(session, &claimed) {
    return Err(CommandResult::failure("SESSION_MISMATCH", "文档会话不匹配，请重新打开文件。"));
  }

  Ok(session.clone())
}

fn map_empty_err<T>(err: CommandResult<EmptyPayload>) -> CommandResult<T> {
  match err {
    CommandResult::Err { ok: _, code, message, conflict_token } => {
      CommandResult::Err { ok: false, code, message, conflict_token }
    }
    CommandResult::Ok { .. } => unreachable!("empty success is not an error"),
  }
}

/// Pure inspect: does not mutate session, unsaved flag, or close flags.
pub fn inspect_link_session(
  state: &SessionState,
  document_path: &str,
  href: &str,
) -> CommandResult<LinkInspectData> {
  let session = match require_session_document(state, document_path) {
    Ok(p) => p,
    Err(e) => return map_empty_err(e),
  };
  crate::link_access::inspect_markdown_link(session.to_string_lossy().as_ref(), href)
}

/// Open a local Markdown link only after the caller has confirmed discard.
/// Re-validates session and href; switches current_document only on success.
pub fn open_link_session(
  state: &SessionState,
  document_path: &str,
  href: &str,
) -> CommandResult<DocumentPayload> {
  let _operation = lock_mutex(&state.document_operation);
  let session = match require_session_document(state, document_path) {
    Ok(p) => p,
    Err(e) => return map_empty_err(e),
  };

  match crate::link_access::inspect_markdown_link(session.to_string_lossy().as_ref(), href) {
    CommandResult::Ok { data: LinkInspectData::Markdown { document, .. }, .. } => {
      set_current_document(state, &document);
      *lock_mutex(&state.has_unsaved_changes) = false;
      clear_close_flags_if_idle(state);
      CommandResult::success(DocumentPayload { document })
    }
    CommandResult::Ok { data: LinkInspectData::External { .. }, .. } => {
      CommandResult::failure("UNSUPPORTED_LINK", "请使用外链确认流程打开 HTTP(S) 链接。")
    }
    CommandResult::Err { code, message, .. } => CommandResult::failure(code, message),
  }
}

pub fn save_document_session(
  state: &SessionState,
  path: &str,
  content: &str,
  conflict_token: Option<&str>,
) -> CommandResult<DocumentPayload> {
  let _operation = lock_mutex(&state.document_operation);
  let session = match require_session_document(state, path) {
    Ok(p) => p,
    Err(e) => return map_empty_err(e),
  };

  let mut baseline = lock_mutex(&state.save_baseline);
  let Some(baseline) = baseline.as_mut() else {
    return CommandResult::failure("NO_DOCUMENT", "当前没有已打开的文档。");
  };
  // The editor owns dirty state: input received while saving must not lose
  // close protection when an older revision finishes writing.
  baseline.save(session.to_string_lossy().as_ref(), content, conflict_token)
}

const RENAME_BUSY: &str = "无法重命名：文件或文件夹可能正被其他程序使用，或没有写入权限。";

fn rename_failure<T>(error: &io::Error) -> CommandResult<T> {
  match error.kind() {
    io::ErrorKind::NotFound => CommandResult::failure("NOT_FOUND", "文件或文件夹不存在或已被移动。"),
    io::ErrorKind::AlreadyExists => CommandResult::failure("TARGET_EXISTS", "已存在同名的文件或文件夹。"),
    io::ErrorKind::PermissionDenied => CommandResult::failure("RENAME_FAILED", RENAME_BUSY),
    // ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION have no stable ErrorKind.
    _ if cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33)) => {
      CommandResult::failure("RENAME_FAILED", RENAME_BUSY)
    }
    _ => CommandResult::failure("RENAME_FAILED", format!("无法重命名：{error}")),
  }
}

/// `document` is inside `from` (checked case-insensitively on Windows), so its
/// leading components name `from`; keep only the remainder under the new name.
fn relocate(document: &Path, from: &Path, to: &Path) -> PathBuf {
  let mut moved = to.to_path_buf();
  for component in document.components().skip(from.components().count()) {
    moved.push(component.as_os_str());
  }
  moved
}

/// Renames a Markdown file or a folder in place. When the entry is, or contains,
/// the open document, the session moves to the new path inside the same critical
/// section as saves, so a queued save can never target the old name. The save
/// baseline and any pending conflict token are content digests, not paths: they
/// stay valid, and the editor keeps its draft, undo history and dirty state.
pub fn rename_entry_session(
  state: &SessionState,
  path: &str,
  new_name: &str,
) -> CommandResult<RenamePayload> {
  let _operation = lock_mutex(&state.document_operation);
  let trimmed = path.trim();
  if trimmed.is_empty() {
    return CommandResult::failure("INVALID_ARGUMENT", "路径无效。");
  }
  if Path::new(trimmed).file_name().is_none() {
    return CommandResult::failure("INVALID_ARGUMENT", "不能重命名磁盘根目录。");
  }
  // The entry itself is never followed: renaming a symlink or junction renames
  // the link, not the folder or file it points to.
  let (source, own) = match rename::resolve_entry(Path::new(trimmed)) {
    Ok(entry) => entry,
    Err(error) => return rename_failure(&error),
  };
  let is_link = own.file_type().is_symlink();
  // What a link points to decides only whether it is renamed as a file or a folder.
  let metadata = if is_link {
    match fs::metadata(&source) {
      Ok(metadata) => metadata,
      Err(error) => return rename_failure(&error),
    }
  } else {
    own
  };
  let is_dir = metadata.is_dir();
  let supported = is_dir || (metadata.is_file() && file_access::is_markdown_path(&source));
  if !supported {
    return CommandResult::failure("UNSUPPORTED_FILE_TYPE", "只能重命名 .md、.markdown 文件或文件夹。");
  }
  if let Err(message) = rename::validate_new_name(new_name, !is_dir) {
    return CommandResult::failure("INVALID_NAME", message);
  }
  let (Some(parent), Some(old_name)) = (source.parent(), source.file_name()) else {
    return CommandResult::failure("INVALID_ARGUMENT", "不能重命名磁盘根目录。");
  };
  if old_name == std::ffi::OsStr::new(new_name) {
    return CommandResult::success(RenamePayload {
      path: source.to_string_lossy().into_owned(),
      name: new_name.to_string(),
      is_dir,
      session_path: None,
    });
  }

  // Held across the rename so an open that bypasses `document_operation` cannot
  // interleave between the disk change and the session update.
  let mut current = lock_mutex(&state.current_document);
  // The session holds the opened file with every link resolved, so renaming a
  // link never moves it.
  let moves_session = !is_link
    && current.as_deref().is_some_and(|document| {
      if is_dir {
        path_policy::is_path_inside_directory(document, &source)
      } else {
        path_policy::paths_equal(document, &source)
      }
    });
  let target = parent.join(new_name);
  if let Err(error) = rename::rename_no_replace(&source, &target) {
    return rename_failure(&error);
  }
  // The disk now spells the entry exactly as requested, including case-only
  // renames. Not canonicalized: that would follow a renamed link.
  let renamed = target;
  let session_path = if moves_session {
    current.as_deref().map(|document| relocate(document, &source, &renamed))
  } else {
    None
  };
  if let Some(moved) = &session_path {
    *current = Some(moved.clone());
  }
  let name = renamed
    .file_name()
    .map(|name| name.to_string_lossy().into_owned())
    .unwrap_or_else(|| new_name.to_string());
  CommandResult::success(RenamePayload {
    path: renamed.to_string_lossy().into_owned(),
    name,
    is_dir,
    session_path: session_path.map(|moved| moved.to_string_lossy().into_owned()),
  })
}

const MOVE_BUSY: &str = "无法移动：文件或文件夹可能正被其他程序使用，或没有写入权限。";
const OTHER_DRIVE: &str = "暂不支持移动到其他磁盘。";
const TARGET_TAKEN: &str = "目标文件夹里已有同名的文件或文件夹。";

fn move_failure<T>(error: &io::Error) -> CommandResult<T> {
  // ERROR_NOT_SAME_DEVICE on Windows, EXDEV elsewhere: the move would be a copy.
  let other_drive = if cfg!(windows) { 17 } else { 18 };
  if error.raw_os_error() == Some(other_drive) {
    return CommandResult::failure("OTHER_DRIVE", OTHER_DRIVE);
  }
  match error.kind() {
    io::ErrorKind::NotFound => CommandResult::failure("NOT_FOUND", "文件或文件夹不存在或已被移动。"),
    io::ErrorKind::AlreadyExists => CommandResult::failure("TARGET_EXISTS", TARGET_TAKEN),
    io::ErrorKind::PermissionDenied => CommandResult::failure("MOVE_FAILED", MOVE_BUSY),
    // ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION have no stable ErrorKind.
    _ if cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33)) => {
      CommandResult::failure("MOVE_FAILED", MOVE_BUSY)
    }
    _ => CommandResult::failure("MOVE_FAILED", format!("无法移动：{error}")),
  }
}

/// Both canonical paths start on the same drive or share. A different volume
/// mounted in a folder is still refused by the move itself.
#[cfg(windows)]
fn same_volume(a: &Path, b: &Path) -> bool {
  use std::path::Component;
  match (a.components().next(), b.components().next()) {
    (Some(Component::Prefix(a)), Some(Component::Prefix(b))) => {
      a.as_os_str().to_string_lossy().eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
    }
    _ => true,
  }
}

#[cfg(not(windows))]
fn same_volume(_: &Path, _: &Path) -> bool {
  true
}

struct MovePlan {
  source: PathBuf,
  name: String,
  is_dir: bool,
  is_link: bool,
  target: PathBuf,
  same_folder: bool,
}

/// Checks a move of `path` into `directory` without touching the disk.
fn move_plan<T>(path: &str, directory: &str) -> Result<MovePlan, CommandResult<T>> {
  let trimmed = path.trim();
  if trimmed.is_empty() || !Path::new(trimmed).is_absolute() {
    return Err(CommandResult::failure("INVALID_ARGUMENT", "路径无效。"));
  }
  if Path::new(trimmed).file_name().is_none() {
    return Err(CommandResult::failure("INVALID_ARGUMENT", "不能移动磁盘根目录。"));
  }
  // As for a rename, the entry itself is never followed: a link moves as the link.
  let (source, own) = rename::resolve_entry(Path::new(trimmed)).map_err(|error| move_failure(&error))?;
  let is_link = own.file_type().is_symlink();
  let metadata = if is_link { fs::metadata(&source).map_err(|error| move_failure(&error))? } else { own };
  let is_dir = metadata.is_dir();
  if !is_dir && !(metadata.is_file() && file_access::is_markdown_path(&source)) {
    return Err(CommandResult::failure("UNSUPPORTED_FILE_TYPE", "只能移动 .md、.markdown 文件或文件夹。"));
  }
  let folder = directory.trim();
  if folder.is_empty() || !Path::new(folder).is_absolute() {
    return Err(CommandResult::failure("INVALID_ARGUMENT", "目标文件夹无效。"));
  }
  let destination = match fs::canonicalize(folder) {
    Ok(destination) => destination,
    Err(error) if error.kind() == io::ErrorKind::NotFound => {
      return Err(CommandResult::failure("NOT_FOUND", "目标文件夹不存在或已被移动。"));
    }
    Err(error) => return Err(move_failure(&error)),
  };
  if !destination.is_dir() {
    return Err(CommandResult::failure("NOT_A_DIRECTORY", "目标不是文件夹。"));
  }
  // A linked folder moves as the link, so only a real folder can contain the target.
  if is_dir && !is_link && path_policy::is_path_inside_directory(&destination, &source) {
    return Err(CommandResult::failure("INVALID_TARGET", "不能把文件夹移到它自己或它的子文件夹里。"));
  }
  if !same_volume(&source, &destination) {
    return Err(CommandResult::failure("OTHER_DRIVE", OTHER_DRIVE));
  }
  let name = match source.file_name() {
    Some(name) => name.to_owned(),
    None => return Err(CommandResult::failure("INVALID_ARGUMENT", "不能移动磁盘根目录。")),
  };
  let target = destination.join(&name);
  let same_folder = source.parent().is_some_and(|parent| path_policy::paths_equal(parent, &destination));
  if !same_folder && fs::symlink_metadata(&target).is_ok() {
    return Err(CommandResult::failure("TARGET_EXISTS", TARGET_TAKEN));
  }
  Ok(MovePlan { source, name: name.to_string_lossy().into_owned(), is_dir, is_link, target, same_folder })
}

/// Describes a move for the warning before it. Never changes the disk or the session.
pub fn inspect_move_session(
  state: &SessionState,
  path: &str,
  directory: &str,
) -> CommandResult<MoveTargetPayload> {
  let plan = match move_plan(path, directory) {
    Ok(plan) => plan,
    Err(failure) => return failure,
  };
  let current = lock_mutex(&state.current_document);
  let contains_session =
    !plan.is_link && current.as_deref().is_some_and(|doc| contains_document(doc, &plan.source, plan.is_dir));
  CommandResult::success(MoveTargetPayload {
    path: plan.source.to_string_lossy().into_owned(),
    name: plan.name,
    is_dir: plan.is_dir,
    target: plan.target.to_string_lossy().into_owned(),
    same_folder: plan.same_folder,
    contains_session,
  })
}

/// Moves a Markdown file or a folder into `directory`, keeping its name and never
/// replacing an existing entry. Like a rename, the session follows the open
/// document inside the same critical section as saves, so the editor keeps its
/// draft, undo history and dirty state, and a queued save never targets the old
/// path. Only a move on the same drive: nothing is ever copied.
pub fn move_entry_session(state: &SessionState, path: &str, directory: &str) -> CommandResult<RenamePayload> {
  let _operation = lock_mutex(&state.document_operation);
  let plan = match move_plan(path, directory) {
    Ok(plan) => plan,
    Err(failure) => return failure,
  };
  if plan.same_folder {
    return CommandResult::success(RenamePayload {
      path: plan.source.to_string_lossy().into_owned(),
      name: plan.name,
      is_dir: plan.is_dir,
      session_path: None,
    });
  }
  // Held across the move so an open that bypasses `document_operation` cannot
  // interleave between the disk change and the session update.
  let mut current = lock_mutex(&state.current_document);
  let moves_session =
    !plan.is_link && current.as_deref().is_some_and(|doc| contains_document(doc, &plan.source, plan.is_dir));
  if let Err(error) = rename::rename_no_replace(&plan.source, &plan.target) {
    return move_failure(&error);
  }
  let session_path = if moves_session {
    current.as_deref().map(|doc| relocate(doc, &plan.source, &plan.target))
  } else {
    None
  };
  if let Some(moved) = &session_path {
    *current = Some(moved.clone());
  }
  CommandResult::success(RenamePayload {
    path: plan.target.to_string_lossy().into_owned(),
    name: plan.name,
    is_dir: plan.is_dir,
    session_path: session_path.map(|moved| moved.to_string_lossy().into_owned()),
  })
}

/// What the platform did with an entry handed to it for deletion.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiskDelete {
  /// Moved to the recycle bin, or destroyed when that was asked for.
  Deleted,
  /// Only for a recycle request: the location has no recycle bin, or the entry
  /// does not fit in it. Nothing was touched.
  NotRecyclable,
  /// Failed with this HRESULT or OS error code.
  Failed(i32),
}

const DELETE_BUSY: &str = "无法删除：文件或文件夹可能正被其他程序使用，或没有权限";
const NOT_RECYCLABLE: &str = "这个位置不支持回收站，或者内容太大，回收站放不下。";
const DELETE_MISSING: &str = "文件或文件夹不存在或已被移动。";

fn delete_io_failure<T>(error: &io::Error) -> CommandResult<T> {
  match error.kind() {
    io::ErrorKind::NotFound => CommandResult::failure("NOT_FOUND", DELETE_MISSING),
    io::ErrorKind::PermissionDenied => CommandResult::failure("DELETE_FAILED", format!("{DELETE_BUSY}。")),
    _ => CommandResult::failure("DELETE_FAILED", format!("无法删除：{error}")),
  }
}

fn delete_code_failure<T>(code: i32) -> CommandResult<T> {
  let code = code as u32;
  // HRESULT_FROM_WIN32 of ERROR_FILE_NOT_FOUND and ERROR_PATH_NOT_FOUND.
  if matches!(code, 0x8007_0002 | 0x8007_0003) {
    return CommandResult::failure("NOT_FOUND", DELETE_MISSING);
  }
  CommandResult::failure("DELETE_FAILED", format!("{DELETE_BUSY}（错误 0x{code:08X}）。"))
}

/// Checks an entry the file tree asks to delete, without following it. Returns
/// the entry as the disk spells it and whether it is a folder.
fn delete_target<T>(path: &str) -> Result<(PathBuf, bool), CommandResult<T>> {
  let trimmed = path.trim();
  if trimmed.is_empty() || !Path::new(trimmed).is_absolute() {
    return Err(CommandResult::failure("INVALID_ARGUMENT", "路径无效。"));
  }
  if Path::new(trimmed).file_name().is_none() {
    return Err(CommandResult::failure("INVALID_ARGUMENT", "不能删除磁盘根目录。"));
  }
  let resolved = rename::resolve_entry(Path::new(trimmed));
  let (source, own) = resolved.map_err(|error| delete_io_failure(&error))?;
  // The shell can reach through a link into the folder it points to, so a link
  // is refused rather than handed over.
  if own.file_type().is_symlink() {
    return Err(CommandResult::failure("UNSUPPORTED_LINK", "暂不支持删除符号链接或目录联接。"));
  }
  let is_dir = own.is_dir();
  if !is_dir && !(own.is_file() && file_access::is_markdown_path(&source)) {
    return Err(CommandResult::failure("UNSUPPORTED_FILE_TYPE", "只能删除 .md、.markdown 文件或文件夹。"));
  }
  Ok((source, is_dir))
}

fn contains_document(document: &Path, entry: &Path, is_dir: bool) -> bool {
  if is_dir {
    path_policy::is_path_inside_directory(document, entry)
  } else {
    path_policy::paths_equal(document, entry)
  }
}

/// Describes an entry for the confirmation before it is deleted. Never changes
/// the disk or the session.
pub fn inspect_delete_session(state: &SessionState, path: &str) -> CommandResult<DeleteTargetPayload> {
  let (source, is_dir) = match delete_target(path) {
    Ok(target) => target,
    Err(failure) => return failure,
  };
  let current = lock_mutex(&state.current_document);
  let contains_session = current.as_deref().is_some_and(|doc| contains_document(doc, &source, is_dir));
  let name = source.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
  CommandResult::success(DeleteTargetPayload {
    path: source.to_string_lossy().into_owned(),
    name,
    is_dir,
    contains_session,
  })
}

/// Deletes a Markdown file or a folder through `delete`, which moves it to the
/// recycle bin unless `permanent`. When the entry is, or contains, the open
/// document, the session closes inside the same critical section as saves, so a
/// queued save can never write the deleted file back. A failed deletion keeps the
/// session: the editor still holds the draft and can save it again.
pub fn delete_entry_session(
  state: &SessionState,
  path: &str,
  permanent: bool,
  delete: impl FnOnce(&Path, bool) -> DiskDelete,
) -> CommandResult<DeletePayload> {
  let _operation = lock_mutex(&state.document_operation);
  let (source, is_dir) = match delete_target(path) {
    Ok(target) => target,
    Err(failure) => return failure,
  };
  // Held across the deletion so an open that bypasses `document_operation`
  // cannot interleave between the disk change and the session update.
  let mut current = lock_mutex(&state.current_document);
  let closes = current.as_deref().is_some_and(|document| contains_document(document, &source, is_dir));
  match delete(&source, permanent) {
    DiskDelete::Deleted => {}
    DiskDelete::NotRecyclable => return CommandResult::failure("RECYCLE_UNAVAILABLE", NOT_RECYCLABLE),
    // A shell operation can report an error after the entry is already gone.
    DiskDelete::Failed(code) if fs::symlink_metadata(&source).is_ok() => return delete_code_failure(code),
    DiskDelete::Failed(_) => {}
  }
  if closes {
    *current = None;
    drop(current);
    *lock_mutex(&state.save_baseline) = None;
    *lock_mutex(&state.has_unsaved_changes) = false;
    clear_close_flags_if_idle(state);
  }
  CommandResult::success(DeletePayload {
    path: source.to_string_lossy().into_owned(),
    is_dir,
    permanent,
    closed_session: closes,
  })
}

/// Returns `true` when the app is already interactive and the caller must handle
/// the path now; `false` when it was queued for the initial document handshake.
pub fn queue_open_path(state: &SessionState, path: String) -> bool {
  let mut launch = lock_mutex(&state.launch_state);
  if launch.frontend_ready {
    true
  } else {
    // The app is single-document: the most recent user request wins before startup.
    launch.pending_path = Some(path);
    false
  }
}

pub fn take_initial_path_and_mark_ready(state: &SessionState) -> Option<String> {
  let mut launch = lock_mutex(&state.launch_state);
  launch.frontend_ready = true;
  launch.pending_path.take()
}

pub fn mark_ready(state: &SessionState) {
  lock_mutex(&state.launch_state).frontend_ready = true;
}

pub fn set_unsaved_changes(state: &SessionState, value: bool) {
  *lock_mutex(&state.has_unsaved_changes) = value;
  if !value {
    // Saving/opening may finish after a close request. Keep that newer
    // user intent until the editor confirms or cancels the pending prompt.
    clear_close_flags_if_idle(state);
  }
}

/// Returns `true` when a prompt was already pending (the caller must refocus the
/// existing surface instead of opening a second discard path).
pub fn begin_close_request(state: &SessionState, action: CloseAction) -> bool {
  let mut close = lock_mutex(&state.close_state);
  let already_pending = close.prompt_pending;
  close.prompt_pending = true;
  close.action = Some(action);
  already_pending
}

pub fn cancel_close_request(state: &SessionState) {
  let mut close = lock_mutex(&state.close_state);
  close.prompt_pending = false;
  close.action = None;
  close.allow_window_close = false;
}

pub fn take_pending_close_action(state: &SessionState) -> CloseAction {
  let mut close = lock_mutex(&state.close_state);
  close.prompt_pending = false;
  close.action.take().unwrap_or(CloseAction::CloseWindow)
}

/// One-shot bypass consumed by the window procedure.
pub fn take_close_bypass(state: &SessionState) -> bool {
  let mut close = lock_mutex(&state.close_state);
  let value = close.allow_window_close;
  close.allow_window_close = false;
  if value {
    close.prompt_pending = false;
    close.action = None;
  }
  value
}

pub fn allow_next_close(state: &SessionState) {
  lock_mutex(&state.close_state).allow_window_close = true;
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::file_access;
  use std::fs;
  use tempfile::tempdir;

  /// Open and return the session path as stored by the backend (canonical).
  fn open_session(state: &SessionState, path: &str, content: &str) -> String {
    fs::write(path, content).unwrap();
    let result = file_access::read_markdown_file(path);
    remember_opened(state, &result);
    match result {
      CommandResult::Ok { data, .. } => data.document.path,
      CommandResult::Err { code, message, .. } => panic!("{code}: {message}"),
    }
  }

  #[test]
  fn inspect_does_not_change_session_or_unsaved() {
    let dir = tempdir().unwrap();
    let source = dir.path().join("source.md");
    let target = dir.path().join("target.md");
    fs::write(&target, "# target").unwrap();

    let state = SessionState::default();
    let session_path = open_session(&state, source.to_str().unwrap(), "# source\n\n[t](target.md)\n");
    *lock_mutex(&state.has_unsaved_changes) = true;

    let before = lock_mutex(&state.current_document).clone();
    let result = inspect_link_session(&state, &session_path, "target.md");
    assert!(
      matches!(result, CommandResult::Ok { data: LinkInspectData::Markdown { .. }, .. }),
      "unexpected: {result:?}"
    );
    assert_eq!(*lock_mutex(&state.current_document), before);
    assert!(*lock_mutex(&state.has_unsaved_changes));
  }

  #[test]
  fn open_link_switches_session_only_on_success() {
    let dir = tempdir().unwrap();
    let source = dir.path().join("source.md");
    let target = dir.path().join("target.md");
    fs::write(&target, "# target body").unwrap();

    let state = SessionState::default();
    let session_path = open_session(&state, source.to_str().unwrap(), "# source");
    *lock_mutex(&state.has_unsaved_changes) = true;

    let result = open_link_session(&state, &session_path, "target.md");
    match result {
      CommandResult::Ok { data, .. } => {
        assert_eq!(data.document.content, "# target body");
        let current = lock_mutex(&state.current_document).clone().unwrap();
        assert!(path_policy::paths_equal(&current, std::path::Path::new(&data.document.path)));
        assert!(!*lock_mutex(&state.has_unsaved_changes));
      }
      CommandResult::Err { code, message, .. } => panic!("{code}: {message}"),
    }
  }

  #[test]
  fn open_fails_after_inspect_when_target_deleted_keeps_session_and_dirty() {
    let dir = tempdir().unwrap();
    let source = dir.path().join("source.md");
    let target = dir.path().join("target.md");
    fs::write(&target, "# target").unwrap();

    let state = SessionState::default();
    let session_path = open_session(&state, source.to_str().unwrap(), "# source\n\n[t](target.md)\n");
    *lock_mutex(&state.has_unsaved_changes) = true;
    begin_close_request(&state, CloseAction::CloseWindow);

    let inspected = inspect_link_session(&state, &session_path, "target.md");
    assert!(matches!(inspected, CommandResult::Ok { data: LinkInspectData::Markdown { .. }, .. }));

    fs::remove_file(&target).unwrap();

    let opened = open_link_session(&state, &session_path, "target.md");
    match &opened {
      CommandResult::Err { code, .. } => assert_eq!(code, "NOT_FOUND"),
      other => panic!("expected NOT_FOUND, got {other:?}"),
    }

    let current = lock_mutex(&state.current_document).clone().unwrap();
    assert!(path_policy::paths_equal(&current, std::path::Path::new(&session_path)));
    assert!(*lock_mutex(&state.has_unsaved_changes));
    // Failure must not clear close-protection flags
    assert!(lock_mutex(&state.close_state).prompt_pending);
  }

  #[test]
  fn external_and_failures_keep_session() {
    let dir = tempdir().unwrap();
    let source = dir.path().join("source.md");
    let state = SessionState::default();
    let session_path = open_session(&state, source.to_str().unwrap(), "# source");
    let before = lock_mutex(&state.current_document).clone();
    *lock_mutex(&state.has_unsaved_changes) = true;

    let ext = open_link_session(&state, &session_path, "https://example.com/");
    assert!(matches!(ext, CommandResult::Err { .. }));
    assert_eq!(*lock_mutex(&state.current_document), before);
    assert!(*lock_mutex(&state.has_unsaved_changes));

    let dang = open_link_session(&state, &session_path, "javascript:alert(1)");
    assert!(matches!(dang, CommandResult::Err { .. }));
    assert_eq!(*lock_mutex(&state.current_document), before);

    let trav = open_link_session(&state, &session_path, "../secret.md");
    assert!(matches!(trav, CommandResult::Err { .. }));
    assert_eq!(*lock_mutex(&state.current_document), before);

    let mismatch = open_link_session(&state, r"C:\other\not-session.md", "target.md");
    assert!(matches!(
      mismatch,
      CommandResult::Err { code, .. } if code == "SESSION_MISMATCH"
    ));
    assert_eq!(*lock_mutex(&state.current_document), before);
    assert!(*lock_mutex(&state.has_unsaved_changes));
  }

  #[test]
  fn launch_queue_keeps_latest_path_until_frontend_is_ready() {
    let state = SessionState::default();
    assert!(!queue_open_path(&state, "first.md".into()));
    assert!(!queue_open_path(&state, "second.markdown".into()));
    assert_eq!(take_initial_path_and_mark_ready(&state).as_deref(), Some("second.markdown"));
    assert!(queue_open_path(&state, "warm.md".into()));
    assert!(take_initial_path_and_mark_ready(&state).is_none());
  }

  #[test]
  fn successful_save_keeps_newer_dirty_state_and_pending_close_intent() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    let state = SessionState::default();
    let session = open_session(&state, path.to_str().unwrap(), "original");
    *lock_mutex(&state.has_unsaved_changes) = true;
    begin_close_request(&state, CloseAction::CloseWindow);
    let result = save_document_session(&state, &session, "saved revision", None);
    assert!(matches!(result, CommandResult::Ok { .. }), "{result:?}");
    assert!(*lock_mutex(&state.has_unsaved_changes));
    assert!(lock_mutex(&state.close_state).prompt_pending);
    let result = save_document_session(&state, &session, "next revision", None);
    assert!(matches!(result, CommandResult::Ok { .. }), "{result:?}");
    assert_eq!(fs::read_to_string(&path).unwrap(), "next revision");
  }

  #[test]
  fn save_conflict_preserves_session_dirty_and_close_intent() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    let state = SessionState::default();
    let session = open_session(&state, path.to_str().unwrap(), "original");
    *lock_mutex(&state.has_unsaved_changes) = true;
    begin_close_request(&state, CloseAction::CloseWindow);
    fs::write(&path, "external").unwrap();
    let result = save_document_session(&state, &session, "draft", None);
    assert!(matches!(result, CommandResult::Err { ref code, .. } if code == "FILE_CHANGED"));
    assert_eq!(fs::read_to_string(&path).unwrap(), "external");
    assert!(*lock_mutex(&state.has_unsaved_changes));
    assert!(lock_mutex(&state.close_state).prompt_pending);
    assert_eq!(require_session_document(&state, &session).unwrap(), PathBuf::from(session));
  }

  #[test]
  fn link_switch_invalidates_old_conflict_token() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("source.md");
    let target = dir.path().join("target.md");
    let state = SessionState::default();
    let source = open_session(&state, path.to_str().unwrap(), "original");
    fs::write(&path, "external").unwrap();
    fs::write(&target, "target").unwrap();
    let token = match save_document_session(&state, &source, "draft", None) {
      CommandResult::Err { conflict_token: Some(token), .. } => token,
      other => panic!("{other:?}"),
    };
    let destination = match open_link_session(&state, &source, "target.md") {
      CommandResult::Ok { data, .. } => data.document.path,
      other => panic!("{other:?}"),
    };
    let old_path = save_document_session(&state, &source, "stale", Some(&token));
    assert!(matches!(old_path, CommandResult::Err { ref code, .. } if code == "SESSION_MISMATCH"));
    let new_path = save_document_session(&state, &destination, "stale", Some(&token));
    assert!(matches!(new_path, CommandResult::Err { ref code, .. } if code == "FILE_CHANGED"));
    assert_eq!(fs::read_to_string(&target).unwrap(), "target");
    assert_eq!(fs::read_to_string(&path).unwrap(), "external");
  }

  #[test]
  fn queued_save_revalidates_session_after_a_document_switch() {
    use std::sync::{mpsc, Arc};
    let dir = tempdir().unwrap();
    let path = dir.path().join("source.md");
    let target = dir.path().join("target.md");
    let state = Arc::new(SessionState::default());
    let source = open_session(&state, path.to_str().unwrap(), "original");
    let operation = lock_mutex(&state.document_operation);
    let (started_tx, started_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let worker_state = Arc::clone(&state);
    let worker = std::thread::spawn(move || {
      started_tx.send(()).unwrap();
      let result = save_document_session(&worker_state, &source, "stale", None);
      done_tx.send(result).unwrap();
    });
    started_rx.recv().unwrap();
    assert!(done_rx.try_recv().is_err());
    open_session(&state, target.to_str().unwrap(), "target");
    drop(operation);
    let result = done_rx.recv().unwrap();
    worker.join().unwrap();
    assert!(matches!(result, CommandResult::Err { ref code, .. } if code == "SESSION_MISMATCH"));
    assert_eq!(fs::read_to_string(&path).unwrap(), "original");
    assert_eq!(fs::read_to_string(&target).unwrap(), "target");
  }

  #[test]
  fn renaming_the_open_file_moves_the_session_and_keeps_dirty_state() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    let state = SessionState::default();
    let session = open_session(&state, path.to_str().unwrap(), "original");
    *lock_mutex(&state.has_unsaved_changes) = true;
    let renamed = match rename_entry_session(&state, &session, "renamed.md") {
      CommandResult::Ok { data, .. } => data,
      other => panic!("{other:?}"),
    };
    let moved = renamed.session_path.clone().expect("session moved");
    assert_eq!(moved, renamed.path);
    assert_eq!(renamed.name, "renamed.md");
    assert!(!renamed.is_dir);
    assert!(!path.exists());
    assert!(*lock_mutex(&state.has_unsaved_changes));
    let stale = save_document_session(&state, &session, "draft", None);
    assert!(matches!(stale, CommandResult::Err { ref code, .. } if code == "SESSION_MISMATCH"));
    let saved = save_document_session(&state, &moved, "draft", None);
    assert!(matches!(saved, CommandResult::Ok { .. }), "{saved:?}");
    assert_eq!(fs::read_to_string(dir.path().join("renamed.md")).unwrap(), "draft");
    assert!(!path.exists());
  }

  #[test]
  fn rename_keeps_a_pending_conflict_token_usable_at_the_new_path() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    let state = SessionState::default();
    let session = open_session(&state, path.to_str().unwrap(), "original");
    fs::write(&path, "external").unwrap();
    let token = match save_document_session(&state, &session, "draft", None) {
      CommandResult::Err { conflict_token: Some(token), .. } => token,
      other => panic!("{other:?}"),
    };
    let moved = match rename_entry_session(&state, &session, "moved.md") {
      CommandResult::Ok { data, .. } => data.session_path.unwrap(),
      other => panic!("{other:?}"),
    };
    let result = save_document_session(&state, &moved, "draft", Some(&token));
    assert!(matches!(result, CommandResult::Ok { .. }), "{result:?}");
    assert_eq!(fs::read_to_string(dir.path().join("moved.md")).unwrap(), "draft");
  }

  #[test]
  fn renaming_a_parent_folder_moves_the_session_with_it() {
    let dir = tempdir().unwrap();
    let folder = dir.path().join("drafts");
    fs::create_dir_all(folder.join("deep")).unwrap();
    let path = folder.join("deep").join("note.md");
    let state = SessionState::default();
    open_session(&state, path.to_str().unwrap(), "original");
    let renamed = match rename_entry_session(&state, folder.to_str().unwrap(), "published") {
      CommandResult::Ok { data, .. } => data,
      other => panic!("{other:?}"),
    };
    assert!(renamed.is_dir);
    let moved = PathBuf::from(renamed.session_path.unwrap());
    assert!(moved.ends_with(Path::new("published").join("deep").join("note.md")), "{moved:?}");
    let saved = save_document_session(&state, moved.to_str().unwrap(), "next", None);
    assert!(matches!(saved, CommandResult::Ok { .. }), "{saved:?}");
    let published = dir.path().join("published").join("deep").join("note.md");
    assert_eq!(fs::read_to_string(published).unwrap(), "next");
    assert!(!folder.exists());
  }

  #[test]
  fn rename_never_replaces_an_existing_entry_or_moves_the_session() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("a.md");
    fs::write(dir.path().join("b.md"), "keep").unwrap();
    let state = SessionState::default();
    let session = open_session(&state, path.to_str().unwrap(), "mine");
    let before = lock_mutex(&state.current_document).clone();
    let result = rename_entry_session(&state, &session, "b.md");
    assert!(matches!(result, CommandResult::Err { ref code, .. } if code == "TARGET_EXISTS"), "{result:?}");
    assert_eq!(fs::read_to_string(dir.path().join("b.md")).unwrap(), "keep");
    assert_eq!(fs::read_to_string(&path).unwrap(), "mine");
    assert_eq!(*lock_mutex(&state.current_document), before);
  }

  #[test]
  fn renaming_another_file_leaves_the_session_alone() {
    let dir = tempdir().unwrap();
    let other = dir.path().join("other.md");
    fs::write(&other, "other").unwrap();
    let state = SessionState::default();
    let session = open_session(&state, dir.path().join("open.md").to_str().unwrap(), "open");
    let result = rename_entry_session(&state, other.to_str().unwrap(), "elsewhere.md");
    assert!(
      matches!(result, CommandResult::Ok { ref data, .. } if data.session_path.is_none()),
      "{result:?}"
    );
    assert_eq!(require_session_document(&state, &session).unwrap(), PathBuf::from(&session));
    assert!(dir.path().join("elsewhere.md").exists());
  }

  #[test]
  fn case_only_rename_of_the_open_file_is_allowed() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    let state = SessionState::default();
    let session = open_session(&state, path.to_str().unwrap(), "body");
    let moved = match rename_entry_session(&state, &session, "Note.md") {
      CommandResult::Ok { data, .. } => data.session_path.unwrap(),
      other => panic!("{other:?}"),
    };
    assert_eq!(Path::new(&moved).file_name().unwrap(), "Note.md");
    let names: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|entry| entry.unwrap().file_name()).collect();
    assert_eq!(names, vec![std::ffi::OsString::from("Note.md")]);
    let saved = save_document_session(&state, &moved, "next", None);
    assert!(matches!(saved, CommandResult::Ok { .. }), "{saved:?}");
  }

  #[test]
  fn invalid_names_and_non_markdown_files_are_rejected_without_changes() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    let state = SessionState::default();
    let session = open_session(&state, path.to_str().unwrap(), "body");
    for name in ["note.txt", "a/b.md", "con.md", "bad?.md", "trailing.md "] {
      let result = rename_entry_session(&state, &session, name);
      assert!(
        matches!(result, CommandResult::Err { ref code, .. } if code == "INVALID_NAME"),
        "{name}: {result:?}"
      );
    }
    let text = dir.path().join("notes.txt");
    fs::write(&text, "x").unwrap();
    let result = rename_entry_session(&state, text.to_str().unwrap(), "notes.md");
    assert!(matches!(result, CommandResult::Err { ref code, .. } if code == "UNSUPPORTED_FILE_TYPE"));
    assert!(path.exists() && text.exists());
    assert_eq!(require_session_document(&state, &session).unwrap(), PathBuf::from(&session));
  }

  #[cfg(windows)]
  #[test]
  fn windows_rename_fails_when_file_is_open_without_delete_sharing() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = tempdir().unwrap();
    let path = dir.path().join("occupied.md");
    let state = SessionState::default();
    let session = open_session(&state, path.to_str().unwrap(), "original");
    let before = lock_mutex(&state.current_document).clone();
    // FILE_SHARE_READ only (no FILE_SHARE_DELETE): MoveFileExW must fail with sharing violation.
    let handle = fs::OpenOptions::new().read(true).share_mode(1).open(&path).unwrap();
    let result = rename_entry_session(&state, &session, "moved.md");
    assert!(matches!(result, CommandResult::Err { ref code, .. } if code == "RENAME_FAILED"), "{result:?}");
    assert!(path.exists());
    assert!(!dir.path().join("moved.md").exists());
    assert_eq!(fs::read_to_string(&path).unwrap(), "original");
    assert_eq!(*lock_mutex(&state.current_document), before);
    drop(handle);
  }

  #[test]
  fn renaming_an_unrelated_folder_leaves_the_session_alone() {
    let dir = tempdir().unwrap();
    let other_dir = dir.path().join("other");
    fs::create_dir_all(&other_dir).unwrap();
    let open_path = dir.path().join("open.md");
    let state = SessionState::default();
    let session = open_session(&state, open_path.to_str().unwrap(), "open");
    let result = rename_entry_session(&state, other_dir.to_str().unwrap(), "renamed_dir");
    assert!(
      matches!(result, CommandResult::Ok { ref data, .. } if data.is_dir && data.session_path.is_none()),
      "{result:?}"
    );
    assert!(!other_dir.exists());
    assert!(dir.path().join("renamed_dir").is_dir());
    assert_eq!(require_session_document(&state, &session).unwrap(), PathBuf::from(&session));
  }

  #[test]
  fn renaming_a_prefix_named_folder_does_not_match_sibling_session() {
    let dir = tempdir().unwrap();
    let prefix_dir = dir.path().join("a");
    let sibling_dir = dir.path().join("ab");
    fs::create_dir_all(&prefix_dir).unwrap();
    fs::create_dir_all(&sibling_dir).unwrap();
    let doc_path = sibling_dir.join("doc.md");
    let state = SessionState::default();
    let session = open_session(&state, doc_path.to_str().unwrap(), "sibling");
    let result = rename_entry_session(&state, prefix_dir.to_str().unwrap(), "a_new");
    assert!(
      matches!(result, CommandResult::Ok { ref data, .. } if data.is_dir && data.session_path.is_none()),
      "{result:?}"
    );
    assert!(!prefix_dir.exists());
    assert!(dir.path().join("a_new").is_dir());
    assert!(doc_path.exists());
    assert_eq!(require_session_document(&state, &session).unwrap(), PathBuf::from(&session));
  }

  #[test]
  fn renaming_a_linked_folder_renames_the_link_not_its_target() {
    let dir = tempdir().unwrap();
    let real = dir.path().join("real");
    fs::create_dir_all(&real).unwrap();
    let doc = real.join("doc.md");
    let link = dir.path().join("link");
    if !rename::make_dir_link(&real, &link) {
      eprintln!("skipped: this system cannot create a directory link");
      return;
    }
    let state = SessionState::default();
    // Opened through the link: the session reports the real file.
    let session = open_session(&state, link.join("doc.md").to_str().unwrap(), "body");
    let result = rename_entry_session(&state, link.to_str().unwrap(), "link2");
    let data = match result {
      CommandResult::Ok { data, .. } => data,
      other => panic!("{other:?}"),
    };
    assert!(data.is_dir);
    assert!(data.session_path.is_none());
    assert!(Path::new(&data.path).ends_with("link2"), "{data:?}");
    assert!(real.is_dir(), "the link's target was renamed");
    assert!(!dir.path().join("real2").exists());
    assert!(fs::symlink_metadata(&link).is_err());
    assert!(fs::symlink_metadata(dir.path().join("link2")).unwrap().file_type().is_symlink());
    assert_eq!(fs::read_to_string(&doc).unwrap(), "body");
    let saved = save_document_session(&state, &session, "next", None);
    assert!(matches!(saved, CommandResult::Ok { .. }), "{saved:?}");
    assert_eq!(fs::read_to_string(&doc).unwrap(), "next");
  }

  #[test]
  fn renaming_an_externally_deleted_path_returns_not_found() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("gone.md");
    let state = SessionState::default();
    let session = open_session(&state, path.to_str().unwrap(), "original");
    let before = lock_mutex(&state.current_document).clone();
    fs::remove_file(&path).unwrap();
    let result = rename_entry_session(&state, &session, "moved.md");
    assert!(matches!(result, CommandResult::Err { ref code, .. } if code == "NOT_FOUND"), "{result:?}");
    assert!(!dir.path().join("moved.md").exists());
    assert_eq!(*lock_mutex(&state.current_document), before);
  }

  #[test]
  fn close_request_tracks_latest_intent_and_cancel_preserves_dirty() {
    let state = SessionState::default();
    *lock_mutex(&state.has_unsaved_changes) = true;

    assert!(!begin_close_request(&state, CloseAction::CloseWindow));
    assert!(begin_close_request(&state, CloseAction::CloseWindow));
    {
      let close = lock_mutex(&state.close_state);
      assert!(close.prompt_pending);
      assert!(!close.allow_window_close);
      assert_eq!(close.action, Some(CloseAction::CloseWindow));
    }

    cancel_close_request(&state);
    let close = lock_mutex(&state.close_state);
    assert!(!close.prompt_pending);
    assert_eq!(close.action, None);
    drop(close);
    assert!(*lock_mutex(&state.has_unsaved_changes));
  }

  #[test]
  fn taking_close_action_clears_prompt_but_keeps_selected_action() {
    let state = SessionState::default();
    begin_close_request(&state, CloseAction::CloseWindow);
    assert_eq!(take_pending_close_action(&state), CloseAction::CloseWindow);

    let close = lock_mutex(&state.close_state);
    assert!(!close.prompt_pending);
    assert_eq!(close.action, None);
  }

  #[test]
  fn clean_transition_preserves_pending_close_until_confirmation() {
    let state = SessionState::default();
    *lock_mutex(&state.has_unsaved_changes) = true;
    begin_close_request(&state, CloseAction::CloseWindow);

    // Models an async save/open completing after a close request started confirmation.
    *lock_mutex(&state.has_unsaved_changes) = false;
    clear_close_flags_if_idle(&state);

    let close = lock_mutex(&state.close_state);
    assert!(close.prompt_pending);
    assert_eq!(close.action, Some(CloseAction::CloseWindow));
  }

  #[test]
  fn close_bypass_is_consumed_once() {
    let state = SessionState::default();
    allow_next_close(&state);
    assert!(take_close_bypass(&state));
    assert!(!take_close_bypass(&state));
  }

  fn remove_for_test(entry: &Path, _permanent: bool) -> DiskDelete {
    let removed = if entry.is_dir() { fs::remove_dir_all(entry) } else { fs::remove_file(entry) };
    match removed {
      Ok(()) => DiskDelete::Deleted,
      Err(_) => DiskDelete::Failed(-1),
    }
  }

  fn never_delete(entry: &Path, _permanent: bool) -> DiskDelete {
    panic!("the deleter ran for {entry:?}");
  }

  fn deleted(result: CommandResult<DeletePayload>) -> DeletePayload {
    match result {
      CommandResult::Ok { data, .. } => data,
      other => panic!("{other:?}"),
    }
  }

  fn failure_code<T: std::fmt::Debug>(result: CommandResult<T>) -> String {
    match result {
      CommandResult::Err { code, .. } => code,
      other => panic!("{other:?}"),
    }
  }

  #[test]
  fn deleting_the_open_file_closes_the_session_and_drops_its_draft() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    let state = SessionState::default();
    let session = open_session(&state, path.to_str().unwrap(), "body");
    *lock_mutex(&state.has_unsaved_changes) = true;
    let target = match inspect_delete_session(&state, &session) {
      CommandResult::Ok { data, .. } => data,
      other => panic!("{other:?}"),
    };
    assert!(target.contains_session);
    assert!(!target.is_dir);
    assert_eq!(target.name, "note.md");
    assert!(path.exists(), "inspecting must not delete");
    let mut calls = Vec::new();
    let result = delete_entry_session(&state, &session, false, |entry, permanent| {
      calls.push(permanent);
      remove_for_test(entry, permanent)
    });
    let result = deleted(result);
    assert_eq!(calls, [false]);
    assert!(result.closed_session);
    assert!(!result.permanent);
    assert!(!path.exists());
    assert!(lock_mutex(&state.current_document).is_none());
    assert!(!*lock_mutex(&state.has_unsaved_changes));
    // A save queued before the deletion can never write the file back.
    let saved = save_document_session(&state, &session, "draft", None);
    assert_eq!(failure_code(saved), "NO_DOCUMENT");
    assert!(!path.exists());
  }

  #[test]
  fn deleting_a_parent_folder_closes_the_session_but_a_prefix_named_sibling_does_not() {
    let dir = tempdir().unwrap();
    let drafts = dir.path().join("drafts");
    let draft = dir.path().join("draft");
    fs::create_dir_all(drafts.join("deep")).unwrap();
    fs::create_dir_all(&draft).unwrap();
    fs::write(draft.join("other.md"), "other").unwrap();
    let state = SessionState::default();
    open_session(&state, drafts.join("deep").join("note.md").to_str().unwrap(), "body");
    let inspected = inspect_delete_session(&state, draft.to_str().unwrap());
    assert!(matches!(inspected, CommandResult::Ok { ref data, .. } if !data.contains_session));
    let sibling = deleted(delete_entry_session(&state, draft.to_str().unwrap(), false, remove_for_test));
    assert!(sibling.is_dir);
    assert!(!sibling.closed_session);
    assert!(!draft.exists());
    assert!(lock_mutex(&state.current_document).is_some());
    let parent = deleted(delete_entry_session(&state, drafts.to_str().unwrap(), false, remove_for_test));
    assert!(parent.closed_session);
    assert!(!drafts.exists());
    assert!(lock_mutex(&state.current_document).is_none());
  }

  #[test]
  fn an_entry_that_cannot_be_recycled_stays_until_permanent_deletion_is_asked_for() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    let state = SessionState::default();
    let session = open_session(&state, path.to_str().unwrap(), "body");
    let refused = delete_entry_session(&state, &session, false, |_, _| DiskDelete::NotRecyclable);
    assert_eq!(failure_code(refused), "RECYCLE_UNAVAILABLE");
    assert_eq!(fs::read_to_string(&path).unwrap(), "body");
    assert!(lock_mutex(&state.current_document).is_some());
    let mut asked = None;
    let result = delete_entry_session(&state, &session, true, |entry, permanent| {
      asked = Some(permanent);
      remove_for_test(entry, permanent)
    });
    let result = deleted(result);
    assert_eq!(asked, Some(true));
    assert!(result.permanent);
    assert!(result.closed_session);
    assert!(!path.exists());
  }

  #[test]
  fn a_failed_deletion_keeps_the_session_unless_the_entry_is_gone() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    let state = SessionState::default();
    let session = open_session(&state, path.to_str().unwrap(), "body");
    // ERROR_SHARING_VIOLATION as an HRESULT: another program holds the file.
    let sharing = 0x8007_0020_u32 as i32;
    let busy = delete_entry_session(&state, &session, false, |_, _| DiskDelete::Failed(sharing));
    assert_eq!(failure_code(busy), "DELETE_FAILED");
    assert!(path.exists());
    assert!(lock_mutex(&state.current_document).is_some());
    // Reported as failed, but the entry is gone: the session must not outlive it.
    let gone = delete_entry_session(&state, &session, false, |entry, _| {
      fs::remove_file(entry).unwrap();
      DiskDelete::Failed(-1)
    });
    assert!(deleted(gone).closed_session);
    assert!(lock_mutex(&state.current_document).is_none());
  }

  #[test]
  fn links_other_files_and_unsafe_paths_are_refused_before_anything_is_deleted() {
    let dir = tempdir().unwrap();
    let state = SessionState::default();
    let text = dir.path().join("notes.txt");
    fs::write(&text, "x").unwrap();
    let result = delete_entry_session(&state, text.to_str().unwrap(), false, never_delete);
    assert_eq!(failure_code(result), "UNSUPPORTED_FILE_TYPE");
    assert!(text.exists());
    let missing = dir.path().join("missing.md");
    let result = delete_entry_session(&state, missing.to_str().unwrap(), false, never_delete);
    assert_eq!(failure_code(result), "NOT_FOUND");
    let root = if cfg!(windows) { "C:\\" } else { "/" };
    for path in ["", "relative.md", root] {
      let result = delete_entry_session(&state, path, false, never_delete);
      assert_eq!(failure_code(result), "INVALID_ARGUMENT", "{path}");
    }
    let real = dir.path().join("real");
    fs::create_dir_all(&real).unwrap();
    fs::write(real.join("doc.md"), "keep").unwrap();
    let link = dir.path().join("link");
    if !rename::make_dir_link(&real, &link) {
      eprintln!("skipped the link case: this system cannot create a directory link");
      return;
    }
    let result = delete_entry_session(&state, link.to_str().unwrap(), false, never_delete);
    assert_eq!(failure_code(result), "UNSUPPORTED_LINK");
    assert_eq!(fs::read_to_string(real.join("doc.md")).unwrap(), "keep");
    assert!(fs::symlink_metadata(&link).is_ok());
  }

  fn moved(result: CommandResult<RenamePayload>) -> RenamePayload {
    match result {
      CommandResult::Ok { data, .. } => data,
      other => panic!("{other:?}"),
    }
  }

  #[test]
  fn moving_the_open_file_into_a_folder_moves_the_session_and_keeps_dirty_state() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    let archive = dir.path().join("archive");
    fs::create_dir(&archive).unwrap();
    let state = SessionState::default();
    let session = open_session(&state, path.to_str().unwrap(), "body");
    *lock_mutex(&state.has_unsaved_changes) = true;
    let target = match inspect_move_session(&state, &session, archive.to_str().unwrap()) {
      CommandResult::Ok { data, .. } => data,
      other => panic!("{other:?}"),
    };
    assert!(target.contains_session);
    assert!(!target.same_folder);
    assert!(!target.is_dir);
    assert!(Path::new(&target.target).ends_with(Path::new("archive").join("note.md")), "{target:?}");
    assert!(path.exists(), "inspecting must not move");
    let result = moved(move_entry_session(&state, &session, archive.to_str().unwrap()));
    let moved_session = result.session_path.clone().expect("session moved");
    assert_eq!(moved_session, result.path);
    assert!(!path.exists());
    assert!(*lock_mutex(&state.has_unsaved_changes));
    let stale = save_document_session(&state, &session, "draft", None);
    assert_eq!(failure_code(stale), "SESSION_MISMATCH");
    let saved = save_document_session(&state, &moved_session, "draft", None);
    assert!(matches!(saved, CommandResult::Ok { .. }), "{saved:?}");
    assert_eq!(fs::read_to_string(archive.join("note.md")).unwrap(), "draft");
  }

  #[test]
  fn moving_a_folder_takes_the_open_document_inside_it_along() {
    let dir = tempdir().unwrap();
    let drafts = dir.path().join("drafts");
    let published = dir.path().join("published");
    fs::create_dir_all(drafts.join("deep")).unwrap();
    fs::create_dir(&published).unwrap();
    let state = SessionState::default();
    open_session(&state, drafts.join("deep").join("note.md").to_str().unwrap(), "body");
    let result = moved(move_entry_session(&state, drafts.to_str().unwrap(), published.to_str().unwrap()));
    assert!(result.is_dir);
    let session = PathBuf::from(result.session_path.unwrap());
    let expected = Path::new("published").join("drafts").join("deep").join("note.md");
    assert!(session.ends_with(&expected), "{session:?}");
    let saved = save_document_session(&state, session.to_str().unwrap(), "next", None);
    assert!(matches!(saved, CommandResult::Ok { .. }), "{saved:?}");
    assert_eq!(fs::read_to_string(dir.path().join(&expected)).unwrap(), "next");
    assert!(!drafts.exists());
  }

  #[test]
  fn moves_never_replace_nest_a_folder_in_itself_or_leave_markdown() {
    let dir = tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let path = dir.path().join("a.md");
    let sub = dir.path().join("sub");
    let folder = dir.path().join("folder");
    fs::create_dir_all(&sub).unwrap();
    fs::create_dir_all(folder.join("inner")).unwrap();
    fs::write(sub.join("a.md"), "keep").unwrap();
    let state = SessionState::default();
    let session = open_session(&state, path.to_str().unwrap(), "mine");
    let before = lock_mutex(&state.current_document).clone();
    let taken = move_entry_session(&state, &session, sub.to_str().unwrap());
    assert_eq!(failure_code(taken), "TARGET_EXISTS");
    assert_eq!(fs::read_to_string(sub.join("a.md")).unwrap(), "keep");
    assert_eq!(fs::read_to_string(&path).unwrap(), "mine");
    assert_eq!(*lock_mutex(&state.current_document), before);
    for into in [folder.clone(), folder.join("inner")] {
      let result = move_entry_session(&state, folder.to_str().unwrap(), into.to_str().unwrap());
      assert_eq!(failure_code(result), "INVALID_TARGET", "{into:?}");
    }
    assert!(folder.join("inner").is_dir());
    // Already in that folder: nothing changes and the session stays put.
    let inspected = inspect_move_session(&state, &session, root);
    assert!(matches!(inspected, CommandResult::Ok { ref data, .. } if data.same_folder), "{inspected:?}");
    let same = moved(move_entry_session(&state, &session, root));
    assert!(same.session_path.is_none());
    assert!(path.exists());
    assert_eq!(*lock_mutex(&state.current_document), before);
    let text = dir.path().join("notes.txt");
    fs::write(&text, "x").unwrap();
    let result = move_entry_session(&state, text.to_str().unwrap(), sub.to_str().unwrap());
    assert_eq!(failure_code(result), "UNSUPPORTED_FILE_TYPE");
    let missing = dir.path().join("missing");
    let result = move_entry_session(&state, &session, missing.to_str().unwrap());
    assert_eq!(failure_code(result), "NOT_FOUND");
    let result = move_entry_session(&state, &session, text.to_str().unwrap());
    assert_eq!(failure_code(result), "NOT_A_DIRECTORY");
    let cases = [("", root), ("relative.md", root), (session.as_str(), ""), (session.as_str(), "sub")];
    for (from, into) in cases {
      let result = move_entry_session(&state, from, into);
      assert_eq!(failure_code(result), "INVALID_ARGUMENT", "{from} -> {into}");
    }
    assert!(text.exists());
    assert!(path.exists());
    assert_eq!(*lock_mutex(&state.current_document), before);
  }

  #[test]
  fn moving_a_linked_folder_moves_the_link_not_its_target() {
    let dir = tempdir().unwrap();
    let real = dir.path().join("real");
    let elsewhere = dir.path().join("elsewhere");
    fs::create_dir_all(&real).unwrap();
    fs::create_dir_all(&elsewhere).unwrap();
    let doc = real.join("doc.md");
    let link = dir.path().join("link");
    if !rename::make_dir_link(&real, &link) {
      eprintln!("skipped: this system cannot create a directory link");
      return;
    }
    let state = SessionState::default();
    let session = open_session(&state, link.join("doc.md").to_str().unwrap(), "body");
    let result = moved(move_entry_session(&state, link.to_str().unwrap(), elsewhere.to_str().unwrap()));
    assert!(result.is_dir);
    assert!(result.session_path.is_none());
    assert!(fs::symlink_metadata(elsewhere.join("link")).unwrap().file_type().is_symlink());
    assert!(fs::symlink_metadata(&link).is_err());
    assert_eq!(fs::read_to_string(&doc).unwrap(), "body");
    let saved = save_document_session(&state, &session, "next", None);
    assert!(matches!(saved, CommandResult::Ok { .. }), "{saved:?}");
    assert_eq!(fs::read_to_string(&doc).unwrap(), "next");
  }
}
