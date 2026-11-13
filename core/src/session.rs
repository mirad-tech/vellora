//! Single-document session state machine.
//!
//! Ported from the frozen baseline (`src-tauri/src/lib.rs`) minus the Tauri
//! window/IPC glue. The invariants that matter for data safety are preserved:
//!
//! * only the currently opened document may be saved or used as a link base;
//! * a queued save re-validates the session after a document switch;
//! * inspection never mutates session, dirty flag, or close intent;
//! * a failed open never clears session, dirty flag, or a pending close prompt.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use crate::path_policy;
use crate::reliable_save::SaveBaseline;
use crate::types::{CommandResult, DocumentPayload, EmptyPayload, LinkInspectData, MarkdownDocument};

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

fn map_empty_err<T>(err: CommandResult<EmptyPayload>) -> CommandResult<T> {
  match err {
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
    CommandResult::Ok {
      data: LinkInspectData::Markdown { document, .. },
      ..
    } => {
      set_current_document(state, &document);
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

    let state = SessionState::default();
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

    let state = SessionState::default();
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
    assert_eq!(
      take_initial_path_and_mark_ready(&state).as_deref(),
      Some("second.markdown")
    );
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
    assert_eq!(
      require_session_document(&state, &session).unwrap(),
      PathBuf::from(session)
    );
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
      CommandResult::Err {
        conflict_token: Some(token),
        ..
      } => token,
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
    assert_eq!(
      take_pending_close_action(&state),
      CloseAction::CloseWindow
    );

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
}
