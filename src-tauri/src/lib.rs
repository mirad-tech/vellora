mod file_access;
mod image_access;
mod launch_args;
mod link_access;
mod path_policy;
mod types;

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use rfd::{MessageButtons, MessageDialog, MessageDialogResult};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use types::{CommandResult, DocumentPayload, EmptyPayload, ImagePayload, LinkInspectData};

pub struct AppState {
  /// Markdown path from first-launch CLI args (kept until successfully opened).
  pub initial_path: Mutex<Option<String>>,
  /// Session: only the currently opened document may be saved / used as link base.
  pub current_document: Mutex<Option<PathBuf>>,
  /// Whether the renderer reports unsaved changes (for close protection).
  pub has_unsaved_changes: Mutex<bool>,
  /// One-shot flag: next CloseRequested may proceed without discard prompt.
  pub allow_close: Mutex<bool>,
  /// True after first unsaved close attempt while waiting for frontend / native dialog.
  pub close_prompt_pending: Mutex<bool>,
}

impl Default for AppState {
  fn default() -> Self {
    Self {
      initial_path: Mutex::new(None),
      current_document: Mutex::new(None),
      has_unsaved_changes: Mutex::new(false),
      allow_close: Mutex::new(false),
      close_prompt_pending: Mutex::new(false),
    }
  }
}

fn lock_mutex<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
  mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn set_current_document(state: &AppState, path: &str) {
  *lock_mutex(&state.current_document) = Some(PathBuf::from(path));
}

fn clear_close_flags(state: &AppState) {
  *lock_mutex(&state.allow_close) = false;
  *lock_mutex(&state.close_prompt_pending) = false;
}

fn remember_opened(state: &AppState, result: &CommandResult<DocumentPayload>) {
  if let CommandResult::Ok { data, .. } = result {
    set_current_document(state, &data.document.path);
    *lock_mutex(&state.has_unsaved_changes) = false;
    clear_close_flags(state);
  }
}

fn require_session_document(
  state: &AppState,
  claimed_path: &str,
) -> Result<PathBuf, CommandResult<EmptyPayload>> {
  let current = lock_mutex(&state.current_document);
  let Some(ref session) = *current else {
    return Err(CommandResult::failure(
      "NO_DOCUMENT",
      "当前没有已打开的文档。",
    ));
  };

  let claimed = PathBuf::from(claimed_path.trim());
  if claimed_path.trim().is_empty() || !path_policy::paths_equal(session, &claimed) {
    return Err(CommandResult::failure(
      "SESSION_MISMATCH",
      "文档会话不匹配，请重新打开文件。",
    ));
  }

  Ok(session.clone())
}

fn map_empty_err<T: serde::Serialize>(err: CommandResult<EmptyPayload>) -> CommandResult<T> {
  match err {
    CommandResult::Err { code, message, .. } => CommandResult::failure(code, message),
    CommandResult::Ok { .. } => unreachable!("empty success is not an error"),
  }
}

/// Pure inspect: does not mutate session, unsaved flag, or close flags.
fn inspect_link_session(
  state: &AppState,
  document_path: &str,
  href: &str,
) -> CommandResult<LinkInspectData> {
  let session = match require_session_document(state, document_path) {
    Ok(p) => p,
    Err(e) => return map_empty_err(e),
  };
  link_access::inspect_markdown_link(session.to_string_lossy().as_ref(), href)
}

/// Open a local Markdown link only after the caller has confirmed discard.
/// Re-validates session and href; switches current_document only on success.
fn open_link_session(
  state: &AppState,
  document_path: &str,
  href: &str,
) -> CommandResult<DocumentPayload> {
  let session = match require_session_document(state, document_path) {
    Ok(p) => p,
    Err(e) => return map_empty_err(e),
  };

  match link_access::inspect_markdown_link(session.to_string_lossy().as_ref(), href) {
    CommandResult::Ok {
      data: LinkInspectData::Markdown { document, .. },
      ..
    } => {
      set_current_document(state, &document.path);
      *lock_mutex(&state.has_unsaved_changes) = false;
      clear_close_flags(state);
      CommandResult::success(DocumentPayload { document })
    }
    CommandResult::Ok {
      data: LinkInspectData::External { .. },
      ..
    } => CommandResult::failure(
      "UNSUPPORTED_LINK",
      "请使用外链确认流程打开 HTTP(S) 链接。",
    ),
    CommandResult::Err { code, message, .. } => CommandResult::failure(code, message),
  }
}

#[tauri::command]
fn choose_markdown_file(state: State<'_, AppState>) -> CommandResult<DocumentPayload> {
  let result = file_access::choose_markdown_file();
  remember_opened(&state, &result);
  result
}

#[tauri::command]
fn open_markdown_file(path: String, state: State<'_, AppState>) -> CommandResult<DocumentPayload> {
  let result = file_access::read_markdown_file(&path);
  remember_opened(&state, &result);
  result
}

#[tauri::command]
fn save_markdown_file(
  path: String,
  content: String,
  state: State<'_, AppState>,
) -> CommandResult<DocumentPayload> {
  let session = match require_session_document(&state, &path) {
    Ok(p) => p,
    Err(e) => return map_empty_err(e),
  };

  let result = file_access::save_markdown_file(session.to_string_lossy().as_ref(), &content);
  if let CommandResult::Ok { data, .. } = &result {
    set_current_document(&state, &data.document.path);
    *lock_mutex(&state.has_unsaved_changes) = false;
  }
  result
}

#[tauri::command]
fn resolve_local_image(
  document_path: String,
  src: String,
  state: State<'_, AppState>,
) -> CommandResult<ImagePayload> {
  let session = match require_session_document(&state, &document_path) {
    Ok(p) => p,
    Err(e) => return map_empty_err(e),
  };
  image_access::resolve_local_image(session.to_string_lossy().as_ref(), &src, None)
}

#[tauri::command]
fn inspect_markdown_link(
  document_path: String,
  href: String,
  state: State<'_, AppState>,
) -> CommandResult<LinkInspectData> {
  inspect_link_session(&state, &document_path, &href)
}

#[tauri::command]
fn open_markdown_link(
  document_path: String,
  href: String,
  state: State<'_, AppState>,
) -> CommandResult<DocumentPayload> {
  open_link_session(&state, &document_path, &href)
}

#[tauri::command]
fn open_external_url(url: String) -> CommandResult<EmptyPayload> {
  link_access::open_external_url(&url)
}

#[tauri::command]
fn get_initial_document(state: State<'_, AppState>) -> CommandResult<DocumentPayload> {
  let path = lock_mutex(&state.initial_path).clone();

  match path {
    Some(p) => {
      let result = file_access::read_markdown_file(&p);
      if matches!(result, CommandResult::Ok { .. }) {
        *lock_mutex(&state.initial_path) = None;
        remember_opened(&state, &result);
      }
      result
    }
    None => CommandResult::failure("NO_INITIAL", "没有初始文档。"),
  }
}

#[tauri::command]
fn set_unsaved_changes(value: bool, state: State<'_, AppState>) -> CommandResult<EmptyPayload> {
  *lock_mutex(&state.has_unsaved_changes) = value;
  if !value {
    *lock_mutex(&state.close_prompt_pending) = false;
  }
  CommandResult::success(EmptyPayload {})
}

#[tauri::command]
fn confirm_close(
  allow: bool,
  state: State<'_, AppState>,
  app: AppHandle,
) -> CommandResult<EmptyPayload> {
  if !allow {
    *lock_mutex(&state.allow_close) = false;
    *lock_mutex(&state.close_prompt_pending) = false;
    return CommandResult::success(EmptyPayload {});
  }

  *lock_mutex(&state.allow_close) = true;
  *lock_mutex(&state.close_prompt_pending) = false;

  if let Some(window) = app.get_webview_window("main") {
    if window.close().is_err() {
      *lock_mutex(&state.allow_close) = false;
      return CommandResult::failure("CLOSE_FAILED", "无法关闭窗口。");
    }
  } else {
    *lock_mutex(&state.allow_close) = false;
    return CommandResult::failure("CLOSE_FAILED", "找不到主窗口。");
  }

  CommandResult::success(EmptyPayload {})
}

fn focus_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
  }
}

fn handle_second_instance(app: &AppHandle, args: Vec<String>) {
  if let Some(path) = launch_args::find_markdown_path_in_args(&args) {
    let _ = app.emit("open-file-path", path);
  }
  focus_main_window(app);
}

fn native_discard_dialog() -> bool {
  let result = MessageDialog::new()
    .set_title("未保存更改")
    .set_description("当前文档有未保存更改。")
    .set_buttons(MessageButtons::OkCancelCustom(
      "放弃更改".to_string(),
      "继续编辑".to_string(),
    ))
    .show();

  matches!(result, MessageDialogResult::Ok)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let mut builder = tauri::Builder::default();

  builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
    handle_second_instance(app, args);
  }));

  builder
    .manage(AppState::default())
    .setup(|app| {
      let args: Vec<String> = std::env::args().collect();
      if let Some(path) = launch_args::find_markdown_path_in_args(&args) {
        let state = app.state::<AppState>();
        *lock_mutex(&state.initial_path) = Some(path);
      }
      Ok(())
    })
    .on_window_event(|window, event| {
      if let WindowEvent::CloseRequested { api, .. } = event {
        let app = window.app_handle();
        let state = app.state::<AppState>();

        let allow = {
          let mut guard = lock_mutex(&state.allow_close);
          let value = *guard;
          *guard = false;
          value
        };
        if allow {
          *lock_mutex(&state.close_prompt_pending) = false;
          return;
        }

        let unsaved = *lock_mutex(&state.has_unsaved_changes);
        if !unsaved {
          *lock_mutex(&state.close_prompt_pending) = false;
          return;
        }

        api.prevent_close();

        let mut pending = lock_mutex(&state.close_prompt_pending);
        if *pending {
          drop(pending);
          if native_discard_dialog() {
            *lock_mutex(&state.allow_close) = true;
            *lock_mutex(&state.has_unsaved_changes) = false;
            *lock_mutex(&state.close_prompt_pending) = false;
            let _ = window.close();
          } else {
            *lock_mutex(&state.close_prompt_pending) = false;
          }
          return;
        }

        *pending = true;
        drop(pending);
        let _ = window.emit("close-requested", ());
      }
    })
    .invoke_handler(tauri::generate_handler![
      choose_markdown_file,
      open_markdown_file,
      save_markdown_file,
      resolve_local_image,
      inspect_markdown_link,
      open_markdown_link,
      open_external_url,
      get_initial_document,
      set_unsaved_changes,
      confirm_close
    ])
    .run(tauri::generate_context!())
    .expect("error while running Vellora");
}

#[cfg(test)]
mod session_link_tests {
  use super::*;
  use std::fs;
  use tempfile::tempdir;

  /// Open and return the session path as stored by the backend (canonical).
  fn open_session(state: &AppState, path: &str, content: &str) -> String {
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

    let state = AppState::default();
    let session_path = open_session(
      &state,
      source.to_str().unwrap(),
      "# source\n\n[t](target.md)\n",
    );
    *lock_mutex(&state.has_unsaved_changes) = true;

    let before = lock_mutex(&state.current_document).clone();
    let result = inspect_link_session(&state, &session_path, "target.md");
    assert!(
      matches!(
        result,
        CommandResult::Ok {
          data: LinkInspectData::Markdown { .. },
          ..
        }
      ),
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

    let state = AppState::default();
    let session_path = open_session(&state, source.to_str().unwrap(), "# source");
    *lock_mutex(&state.has_unsaved_changes) = true;

    let result = open_link_session(&state, &session_path, "target.md");
    match result {
      CommandResult::Ok { data, .. } => {
        assert_eq!(data.document.content, "# target body");
        let current = lock_mutex(&state.current_document).clone().unwrap();
        assert!(path_policy::paths_equal(
          &current,
          std::path::Path::new(&data.document.path)
        ));
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

    let state = AppState::default();
    let session_path = open_session(
      &state,
      source.to_str().unwrap(),
      "# source\n\n[t](target.md)\n",
    );
    *lock_mutex(&state.has_unsaved_changes) = true;
    *lock_mutex(&state.close_prompt_pending) = true;

    let inspected = inspect_link_session(&state, &session_path, "target.md");
    assert!(matches!(
      inspected,
      CommandResult::Ok {
        data: LinkInspectData::Markdown { .. },
        ..
      }
    ));

    fs::remove_file(&target).unwrap();

    let opened = open_link_session(&state, &session_path, "target.md");
    match &opened {
      CommandResult::Err { code, .. } => assert_eq!(code, "NOT_FOUND"),
      other => panic!("expected NOT_FOUND, got {other:?}"),
    }

    let current = lock_mutex(&state.current_document).clone().unwrap();
    assert!(path_policy::paths_equal(
      &current,
      std::path::Path::new(&session_path)
    ));
    assert!(*lock_mutex(&state.has_unsaved_changes));
    // Failure must not clear close-protection flags
    assert!(*lock_mutex(&state.close_prompt_pending));
  }

  #[test]
  fn external_and_failures_keep_session() {
    let dir = tempdir().unwrap();
    let source = dir.path().join("source.md");
    let state = AppState::default();
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
}
