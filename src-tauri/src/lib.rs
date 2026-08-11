mod file_access;
mod image_access;
mod launch_args;
mod link_access;
mod path_policy;
mod types;

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

#[cfg(target_os = "macos")]
use tauri::RunEvent;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use types::{CommandResult, DocumentPayload, EmptyPayload, ImagePayload, LinkInspectData};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
enum CloseAction {
  CloseWindow,
  HideWindow,
  QuitApp,
}

#[derive(Debug, Default)]
struct CloseState {
  allow_window_close: bool,
  prompt_pending: bool,
  action: Option<CloseAction>,
}

#[derive(Debug, Default)]
struct LaunchState {
  pending_path: Option<String>,
  frontend_ready: bool,
}

pub struct AppState {
  /// Pending launch/open request and the frontend readiness handshake.
  launch_state: Mutex<LaunchState>,
  /// Session: only the currently opened document may be saved / used as link base.
  pub current_document: Mutex<Option<PathBuf>>,
  /// Whether the renderer reports unsaved changes (for close protection).
  pub has_unsaved_changes: Mutex<bool>,
  /// Pending close/hide/quit intent and the Windows one-shot close bypass.
  close_state: Mutex<CloseState>,
}

impl Default for AppState {
  fn default() -> Self {
    Self {
      launch_state: Mutex::new(LaunchState::default()),
      current_document: Mutex::new(None),
      has_unsaved_changes: Mutex::new(false),
      close_state: Mutex::new(CloseState::default()),
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
  *lock_mutex(&state.close_state) = CloseState::default();
}

fn clear_close_flags_if_idle(state: &AppState) {
  let mut close = lock_mutex(&state.close_state);
  if !close.prompt_pending {
    *close = CloseState::default();
  }
}

fn queue_open_path(state: &AppState, path: String) -> bool {
  let mut launch = lock_mutex(&state.launch_state);
  if launch.frontend_ready {
    true
  } else {
    // The app is single-document: the most recent user request wins before startup.
    launch.pending_path = Some(path);
    false
  }
}

fn take_initial_path_and_mark_ready(state: &AppState) -> Option<String> {
  let mut launch = lock_mutex(&state.launch_state);
  launch.frontend_ready = true;
  launch.pending_path.take()
}

#[cfg(any(target_os = "macos", test))]
fn markdown_path_from_urls(urls: &[url::Url]) -> Option<String> {
  urls.iter().find_map(|url| {
    let path = url.to_file_path().ok()?;
    if file_access::is_markdown_path(&path) {
      Some(path.to_string_lossy().into_owned())
    } else {
      None
    }
  })
}

fn remember_opened(state: &AppState, result: &CommandResult<DocumentPayload>) {
  if let CommandResult::Ok { data, .. } = result {
    set_current_document(state, &data.document.path);
    *lock_mutex(&state.has_unsaved_changes) = false;
    clear_close_flags_if_idle(state);
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
      clear_close_flags_if_idle(state);
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
  let path = take_initial_path_and_mark_ready(&state);

  match path {
    Some(p) => {
      let result = file_access::read_markdown_file(&p);
      if matches!(result, CommandResult::Ok { .. }) {
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
    // Saving/opening may finish after a close or quit request. Keep that newer
    // user intent until the renderer confirms or cancels the pending prompt.
    clear_close_flags_if_idle(&state);
  }
  CommandResult::success(EmptyPayload {})
}

fn default_window_close_action() -> CloseAction {
  #[cfg(target_os = "macos")]
  {
    CloseAction::HideWindow
  }

  #[cfg(not(target_os = "macos"))]
  {
    CloseAction::CloseWindow
  }
}

fn begin_close_request(state: &AppState, action: CloseAction) -> bool {
  let mut close = lock_mutex(&state.close_state);
  let already_pending = close.prompt_pending;
  close.prompt_pending = true;
  close.action = Some(action);
  already_pending
}

fn cancel_close_request(state: &AppState) {
  let mut close = lock_mutex(&state.close_state);
  close.prompt_pending = false;
  close.action = None;
  close.allow_window_close = false;
}

fn take_pending_close_action(state: &AppState) -> CloseAction {
  let mut close = lock_mutex(&state.close_state);
  close.prompt_pending = false;
  close
    .action
    .take()
    .unwrap_or_else(default_window_close_action)
}

fn execute_close_action(app: &AppHandle, action: CloseAction) -> CommandResult<EmptyPayload> {
  match action {
    CloseAction::CloseWindow => {
      let state = app.state::<AppState>();
      lock_mutex(&state.close_state).allow_window_close = true;
      let Some(window) = app.get_webview_window("main") else {
        lock_mutex(&state.close_state).allow_window_close = false;
        return CommandResult::failure("CLOSE_FAILED", "找不到主窗口。");
      };
      if window.close().is_err() {
        lock_mutex(&state.close_state).allow_window_close = false;
        return CommandResult::failure("CLOSE_FAILED", "无法关闭窗口。");
      }
    }
    CloseAction::HideWindow => {
      let Some(window) = app.get_webview_window("main") else {
        return CommandResult::failure("CLOSE_FAILED", "找不到主窗口。");
      };
      if window.hide().is_err() {
        return CommandResult::failure("CLOSE_FAILED", "无法隐藏窗口。");
      }
    }
    CloseAction::QuitApp => app.exit(0),
  }

  CommandResult::success(EmptyPayload {})
}

fn complete_close_request(app: &AppHandle, state: &AppState) -> CommandResult<EmptyPayload> {
  let action = take_pending_close_action(state);
  let result = execute_close_action(app, action);
  if matches!(&result, CommandResult::Ok { .. }) {
    *lock_mutex(&state.has_unsaved_changes) = false;
  }
  result
}

#[tauri::command]
fn confirm_close(
  allow: bool,
  state: State<'_, AppState>,
  app: AppHandle,
) -> CommandResult<EmptyPayload> {
  if !allow {
    cancel_close_request(&state);
    return CommandResult::success(EmptyPayload {});
  }

  complete_close_request(&app, &state)
}

fn focus_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
  }
}

fn handle_open_path(app: &AppHandle, path: String) {
  let state = app.state::<AppState>();
  if queue_open_path(&state, path.clone()) {
    let _ = app.emit("open-file-path", path);
  }
  focus_main_window(app);
}

fn handle_second_instance(app: &AppHandle, args: Vec<String>) {
  if let Some(path) = launch_args::find_markdown_path_in_args(&args) {
    handle_open_path(app, path);
    return;
  }
  focus_main_window(app);
}

fn request_close_confirmation(app: &AppHandle, action: CloseAction) {
  let state = app.state::<AppState>();
  let already_pending = begin_close_request(&state, action);

  if already_pending {
    #[cfg(target_os = "macos")]
    {
      // Keep one renderer-owned confirmation open so its discard callback can
      // reset the reusable window's in-memory draft before a later Dock reopen.
      let _ = app.emit("close-requested", ());
    }
    // The renderer already owns the close decision. Refocus that surface instead
    // of opening a native discard path that could bypass save-and-exit.
    focus_main_window(app);
    return;
  }

  let _ = app.emit("close-requested", ());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let mut builder = tauri::Builder::default();

  builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
    handle_second_instance(app, args);
  }));

  #[cfg(feature = "macos-e2e")]
  {
    builder = builder
      .plugin(tauri_plugin_wdio::init())
      .plugin(tauri_plugin_wdio_webdriver::init());
  }

  let app = builder
    .manage(AppState::default())
    .setup(|app| {
      let args: Vec<String> = std::env::args().collect();
      if let Some(path) = launch_args::find_markdown_path_in_args(&args) {
        let state = app.state::<AppState>();
        queue_open_path(&state, path);
      }
      Ok(())
    })
    .on_window_event(|window, event| {
      if let WindowEvent::CloseRequested { api, .. } = event {
        let app = window.app_handle();
        let state = app.state::<AppState>();

        #[cfg(not(target_os = "macos"))]
        {
          let allow = {
            let mut close = lock_mutex(&state.close_state);
            let value = close.allow_window_close;
            close.allow_window_close = false;
            if value {
              close.prompt_pending = false;
              close.action = None;
            }
            value
          };
          if allow {
            return;
          }

          if !*lock_mutex(&state.has_unsaved_changes) {
            clear_close_flags(&state);
            return;
          }

          api.prevent_close();
          request_close_confirmation(app, CloseAction::CloseWindow);
        }

        #[cfg(target_os = "macos")]
        {
          // Native macOS semantics keep the application alive when its last
          // window is closed. Prevent destruction and hide the reusable window.
          api.prevent_close();
          if *lock_mutex(&state.has_unsaved_changes) {
            request_close_confirmation(app, CloseAction::HideWindow);
          } else {
            clear_close_flags(&state);
            let _ = window.hide();
          }
        }
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
    .build(tauri::generate_context!())
    .expect("error while building Vellora");

  app.run(|_app, event| match event {
    #[cfg(target_os = "macos")]
    RunEvent::Opened { urls } => {
      if let Some(path) = markdown_path_from_urls(&urls) {
        handle_open_path(_app, path);
      }
    }
    #[cfg(target_os = "macos")]
    RunEvent::Reopen { .. } => focus_main_window(_app),
    #[cfg(target_os = "macos")]
    RunEvent::ExitRequested { code, api, .. } if code.is_none() => {
      let state = _app.state::<AppState>();
      if *lock_mutex(&state.has_unsaved_changes) {
        api.prevent_exit();
        request_close_confirmation(_app, CloseAction::QuitApp);
      }
    }
    _ => {}
  });
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
    begin_close_request(&state, CloseAction::CloseWindow);

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
    assert!(lock_mutex(&state.close_state).prompt_pending);
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

  #[test]
  fn launch_queue_keeps_latest_path_until_frontend_is_ready() {
    let state = AppState::default();
    assert!(!queue_open_path(&state, "first.md".into()));
    assert!(!queue_open_path(&state, "second.markdown".into()));
    assert_eq!(
      take_initial_path_and_mark_ready(&state).as_deref(),
      Some("second.markdown")
    );
    assert!(queue_open_path(&state, "warm.md".into()));
    assert!(take_initial_path_and_mark_ready(&state).is_none());
  }

  #[test]
  fn opened_urls_choose_first_supported_local_markdown() {
    let dir = tempdir().unwrap();
    let ignored = url::Url::parse("https://example.com/readme.md").unwrap();
    let text = url::Url::from_file_path(dir.path().join("notes.txt")).unwrap();
    let first_path = dir.path().join("中文 空格.md");
    let second_path = dir.path().join("second.markdown");
    let first = url::Url::from_file_path(&first_path).unwrap();
    let second = url::Url::from_file_path(second_path).unwrap();

    let selected = markdown_path_from_urls(&[ignored, text, first, second]).unwrap();
    assert!(path_policy::paths_equal(
      std::path::Path::new(&selected),
      &first_path
    ));
  }

  #[test]
  fn close_request_tracks_latest_intent_and_cancel_preserves_dirty() {
    let state = AppState::default();
    *lock_mutex(&state.has_unsaved_changes) = true;

    assert!(!begin_close_request(&state, CloseAction::HideWindow));
    assert!(begin_close_request(&state, CloseAction::QuitApp));
    {
      let close = lock_mutex(&state.close_state);
      assert!(close.prompt_pending);
      assert!(!close.allow_window_close);
      assert_eq!(close.action, Some(CloseAction::QuitApp));
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
    let state = AppState::default();
    begin_close_request(&state, CloseAction::HideWindow);
    assert_eq!(take_pending_close_action(&state), CloseAction::HideWindow);

    let close = lock_mutex(&state.close_state);
    assert!(!close.prompt_pending);
    assert_eq!(close.action, None);
  }

  #[test]
  fn clean_transition_preserves_pending_quit_until_confirmation() {
    let state = AppState::default();
    *lock_mutex(&state.has_unsaved_changes) = true;
    begin_close_request(&state, CloseAction::QuitApp);

    // Models an async save/open completing after Cmd+Q started confirmation.
    *lock_mutex(&state.has_unsaved_changes) = false;
    clear_close_flags_if_idle(&state);

    let close = lock_mutex(&state.close_state);
    assert!(close.prompt_pending);
    assert_eq!(close.action, Some(CloseAction::QuitApp));
  }
}
