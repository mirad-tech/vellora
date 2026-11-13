//! Atomic, conflict-aware saving. Ported verbatim from the frozen baseline
//! (`src-tauri/src/reliable_save.rs`): the token lifecycle and Windows
//! ReplaceFileW recovery path are security-relevant, so they are not reshaped.

use std::fs::{self, Metadata};
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use sha2::{Digest, Sha256};

use crate::types::{CommandResult, DocumentPayload};

pub type ContentDigest = [u8; 32];

pub fn content_digest(bytes: &[u8]) -> ContentDigest {
  Sha256::digest(bytes).into()
}

#[derive(Debug)]
pub enum SaveFailure {
  Changed(ContentDigest),
  Io(io::Error),
  #[cfg(windows)]
  Recovery {
    backup_path: std::path::PathBuf,
    replace_error: io::Error,
    restore_error: io::Error,
  },
}

impl From<io::Error> for SaveFailure {
  fn from(error: io::Error) -> Self {
    Self::Io(error)
  }
}

#[derive(Debug)]
pub struct SaveBaseline {
  digest: ContentDigest,
  pending: Option<(String, ContentDigest)>,
}

impl SaveBaseline {
  pub fn new(content: &str) -> Self {
    Self {
      digest: content_digest(content.as_bytes()),
      pending: None,
    }
  }

  pub fn digest(&self) -> ContentDigest {
    self.digest
  }

  fn conflict(&mut self, digest: ContentDigest) -> CommandResult<DocumentPayload> {
    // Tokens are process-unique and only accepted from this exact open session.
    // They grant no path access: session validation always runs before saving.
    static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);
    let token = NEXT_TOKEN.fetch_add(1, Ordering::Relaxed).to_string();
    self.pending = Some((token.clone(), digest));
    CommandResult::file_changed(token)
  }

  pub fn save(
    &mut self,
    path: &str,
    content: &str,
    token: Option<&str>,
  ) -> CommandResult<DocumentPayload> {
    let expected = match token {
      None => self.digest,
      Some(token) => match &self.pending {
        Some((pending, digest)) if pending == token => *digest,
        _ => {
          return match fs::read(path) {
            Ok(bytes) => self.conflict(content_digest(&bytes)),
            Err(error) => save_io_error(error),
          }
        }
      },
    };
    match crate::file_access::save_markdown_file(path, content, &expected) {
      Ok(document) => {
        self.digest = content_digest(content.as_bytes());
        self.pending = None;
        CommandResult::success(DocumentPayload { document })
      }
      Err(SaveFailure::Changed(digest)) => self.conflict(digest),
      Err(SaveFailure::Io(error)) => save_io_error(error),
      #[cfg(windows)]
      Err(SaveFailure::Recovery {
        backup_path,
        replace_error,
        restore_error,
      }) => CommandResult::failure(
        "SAVE_FAILED",
        format!(
          "保存失败，无法自动恢复原文件。草稿已保留。备份路径：{}。替换错误：{}。恢复错误：{}。",
          backup_path.display(),
          replace_error,
          restore_error,
        ),
      ),
    }
  }
}

fn save_io_error(error: io::Error) -> CommandResult<DocumentPayload> {
  match error.kind() {
    io::ErrorKind::NotFound => CommandResult::failure("NOT_FOUND", "文件不存在或已被移动。"),
    _ => CommandResult::failure(
      "SAVE_FAILED",
      "保存失败，请检查权限或文件状态。草稿已保留。",
    ),
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SaveStage {
  Write,
  Sync,
  Replace,
}

pub fn atomic_write(
  path: &Path,
  content: &[u8],
  expected: &ContentDigest,
) -> Result<Metadata, SaveFailure> {
  atomic_write_with(path, content, expected, |_| Ok(()))
}

fn check_disk(path: &Path, expected: &ContentDigest) -> Result<(), SaveFailure> {
  let actual = content_digest(&fs::read(path)?);
  if actual != *expected {
    return Err(SaveFailure::Changed(actual));
  }
  Ok(())
}

fn atomic_write_with(
  path: &Path,
  content: &[u8],
  expected: &ContentDigest,
  mut before: impl FnMut(SaveStage) -> io::Result<()>,
) -> Result<Metadata, SaveFailure> {
  let metadata = fs::metadata(path)?;
  if !metadata.is_file() || metadata.permissions().readonly() {
    return Err(io::Error::new(io::ErrorKind::PermissionDenied, "target is not writable").into());
  }
  check_disk(path, expected)?;
  let parent = path
    .parent()
    .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing directory"))?;
  let mut temporary = tempfile::Builder::new()
    .prefix(".vellora-save-")
    .tempfile_in(parent)?;
  before(SaveStage::Write)?;
  temporary.write_all(content)?;
  // Windows ReplaceFileW merges the original file's ACL and attributes. On Unix,
  // rename replaces the inode, so copy its mode before making the new file durable.
  #[cfg(not(windows))]
  temporary
    .as_file()
    .set_permissions(metadata.permissions())?;
  before(SaveStage::Sync)?;
  temporary.as_file().sync_all()?;
  let saved_metadata = temporary.as_file().metadata()?;
  // Close the staging handle before ReplaceFileW. TempPath keeps RAII cleanup
  // active without holding a handle that denies the OS replacement operation.
  let temporary = temporary.into_temp_path();
  before(SaveStage::Replace)?;
  #[cfg(windows)]
  let backup = tempfile::Builder::new()
    .prefix(".vellora-save-backup-")
    .suffix(".md")
    .tempfile_in(parent)?
    .into_temp_path();
  check_disk(path, expected)?;
  #[cfg(windows)]
  replace_file(&temporary, path, backup)?;
  #[cfg(not(windows))]
  replace_file(&temporary, path)?;
  // Do not read the destination back: a later read failure or external write must
  // not turn an already committed save into a reported failure or a stale baseline.
  Ok(saved_metadata)
}

#[cfg(windows)]
fn wide_path(path: &Path) -> Vec<u16> {
  use std::os::windows::ffi::OsStrExt;
  path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(windows)]
fn replace_file(temporary: &Path, path: &Path, backup: tempfile::TempPath) -> Result<(), SaveFailure> {
  use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
  let target = wide_path(path);
  let replacement = wide_path(temporary);
  let backup_name = wide_path(&backup);
  // Supplying a backup preserves the target on a 1176 failure. Flags 0 keep
  // ACL merging mandatory.
  let succeeded = unsafe {
    ReplaceFileW(
      target.as_ptr(),
      replacement.as_ptr(),
      backup_name.as_ptr(),
      0,
      std::ptr::null(),
      std::ptr::null(),
    )
  };
  if succeeded == 0 {
    Err(recover_failed_replacement(path, backup, io::Error::last_os_error()))
  } else {
    Ok(())
  }
}

#[cfg(windows)]
fn recover_failed_replacement(
  path: &Path,
  mut backup: tempfile::TempPath,
  replace_error: io::Error,
) -> SaveFailure {
  use windows_sys::Win32::Foundation::ERROR_UNABLE_TO_MOVE_REPLACEMENT_2;
  use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

  if replace_error.raw_os_error() != Some(ERROR_UNABLE_TO_MOVE_REPLACEMENT_2 as i32) {
    return replace_error.into();
  }

  // On 1177 the backup now holds the original. Keep it if another writer has
  // reclaimed the target name or Windows otherwise refuses to move it back.
  backup.disable_cleanup(true);
  let backup_name = wide_path(&backup);
  let target = wide_path(path);
  if unsafe { MoveFileExW(backup_name.as_ptr(), target.as_ptr(), 0) } == 0 {
    let restore_error = io::Error::last_os_error();
    return SaveFailure::Recovery {
      backup_path: backup.to_path_buf(),
      replace_error,
      restore_error,
    };
  }
  replace_error.into()
}

#[cfg(not(windows))]
fn replace_file(temporary: &Path, path: &Path) -> io::Result<()> {
  fs::rename(temporary, path)
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::tempdir;

  fn conflict_token(result: CommandResult<DocumentPayload>) -> String {
    match result {
      CommandResult::Err {
        code,
        conflict_token: Some(token),
        ..
      } => {
        assert_eq!(code, "FILE_CHANGED");
        token
      }
      other => panic!("expected conflict, got {other:?}"),
    }
  }

  #[test]
  fn same_size_external_changes_require_confirmation_of_the_current_version() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, "first").unwrap();
    let mut baseline = SaveBaseline::new("first");
    fs::write(&path, "other").unwrap();
    let first = conflict_token(baseline.save(path.to_str().unwrap(), "draft", None));
    assert_eq!(fs::read_to_string(&path).unwrap(), "other");
    fs::write(&path, "again").unwrap();
    let second = conflict_token(baseline.save(path.to_str().unwrap(), "draft", Some(&first)));
    assert_ne!(first, second);
    assert_eq!(fs::read_to_string(&path).unwrap(), "again");
    assert!(matches!(
      baseline.save(path.to_str().unwrap(), "draft", Some(&second)),
      CommandResult::Ok { .. }
    ));
    assert_eq!(fs::read_to_string(&path).unwrap(), "draft");
    assert_eq!(baseline.digest, content_digest(b"draft"));
    assert!(baseline.pending.is_none());
    conflict_token(baseline.save(path.to_str().unwrap(), "stale", Some(&second)));
    assert_eq!(fs::read_to_string(&path).unwrap(), "draft");
  }

  #[test]
  fn tokens_are_not_reusable_after_reopening_or_between_sessions() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, "external").unwrap();
    let mut first = SaveBaseline::new("original");
    let token = conflict_token(first.save(path.to_str().unwrap(), "draft", None));
    let mut reopened = SaveBaseline::new("external");
    let replacement =
      conflict_token(reopened.save(path.to_str().unwrap(), "stale draft", Some(&token)));
    assert_ne!(token, replacement);
    assert_eq!(fs::read_to_string(&path).unwrap(), "external");
  }

  #[test]
  fn detects_external_write_between_temporary_write_and_replacement() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, "original").unwrap();
    let result = atomic_write_with(&path, b"draft", &content_digest(b"original"), |stage| {
      if stage == SaveStage::Replace {
        fs::write(&path, "external")?;
      }
      Ok(())
    });
    assert!(matches!(result, Err(SaveFailure::Changed(_))));
    assert_eq!(fs::read_to_string(&path).unwrap(), "external");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
  }

  #[test]
  fn write_sync_and_replace_failures_keep_original_and_remove_temporary_files() {
    for failing_stage in [SaveStage::Write, SaveStage::Sync, SaveStage::Replace] {
      let dir = tempdir().unwrap();
      let path = dir.path().join("note.md");
      fs::write(&path, "original").unwrap();
      let result = atomic_write_with(&path, b"draft", &content_digest(b"original"), |stage| {
        if stage == failing_stage {
          Err(io::Error::other("injected disk failure"))
        } else {
          Ok(())
        }
      });
      assert!(
        matches!(result, Err(SaveFailure::Io(_))),
        "{failing_stage:?}"
      );
      assert_eq!(fs::read_to_string(&path).unwrap(), "original");
      assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
  }

  #[test]
  fn deleted_target_is_not_recreated_and_failed_save_keeps_baseline() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("deleted.md");
    let mut baseline = SaveBaseline::new("original");
    let result = baseline.save(path.to_str().unwrap(), "draft", None);
    assert!(matches!(result, CommandResult::Err { ref code, .. } if code == "NOT_FOUND"));
    assert!(!path.exists());
    assert_eq!(baseline.digest, content_digest(b"original"));
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
  }

  #[test]
  fn readonly_target_is_not_replaced() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("readonly.md");
    fs::write(&path, "original").unwrap();
    let original_permissions = fs::metadata(&path).unwrap().permissions();
    let mut readonly = original_permissions.clone();
    readonly.set_readonly(true);
    fs::set_permissions(&path, readonly).unwrap();
    let result = atomic_write(&path, b"draft", &content_digest(b"original"));
    let bytes = fs::read(&path).unwrap();
    fs::set_permissions(&path, original_permissions).unwrap();
    assert!(matches!(result, Err(SaveFailure::Io(_))));
    assert_eq!(bytes, b"original");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
  }

  #[cfg(windows)]
  #[test]
  fn windows_file_open_without_delete_sharing_cannot_be_replaced() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = tempdir().unwrap();
    let path = dir.path().join("occupied.md");
    fs::write(&path, "original").unwrap();
    let handle = fs::OpenOptions::new()
      .read(true)
      .share_mode(1)
      .open(&path)
      .unwrap();
    let result = atomic_write(&path, b"draft", &content_digest(b"original"));
    assert!(matches!(result, Err(SaveFailure::Io(_))));
    assert_eq!(fs::read(&path).unwrap(), b"original");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    drop(handle);
    atomic_write(&path, b"draft", &content_digest(b"original")).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"draft");
  }

  #[cfg(windows)]
  #[test]
  fn windows_failed_replacement_restores_or_preserves_original() {
    use windows_sys::Win32::Foundation::{
      ERROR_UNABLE_TO_MOVE_REPLACEMENT, ERROR_UNABLE_TO_MOVE_REPLACEMENT_2,
    };

    for (code, recreated) in [
      (ERROR_UNABLE_TO_MOVE_REPLACEMENT, false),
      (ERROR_UNABLE_TO_MOVE_REPLACEMENT_2, false),
      (ERROR_UNABLE_TO_MOVE_REPLACEMENT_2, true),
    ] {
      let dir = tempdir().unwrap();
      let target = dir.path().join("note.md");
      fs::write(&target, b"original").unwrap();
      let backup = tempfile::NamedTempFile::new_in(dir.path()).unwrap().into_temp_path();
      let backup_path = backup.to_path_buf();
      // Reproduce the documented on-disk state at each native error boundary.
      if code == ERROR_UNABLE_TO_MOVE_REPLACEMENT_2 {
        fs::rename(&target, &backup_path).unwrap();
      }
      if recreated {
        fs::write(&target, b"new external revision").unwrap();
      }

      let failure = recover_failed_replacement(&target, backup, io::Error::from_raw_os_error(code as i32));
      if recreated {
        let SaveFailure::Recovery { backup_path: retained, replace_error, restore_error } = failure else {
          panic!("expected recovery failure, got {failure:?}");
        };
        assert_eq!(retained, backup_path);
        assert_eq!(replace_error.raw_os_error(), Some(code as i32));
        assert!(restore_error.raw_os_error().is_some());
        assert_eq!(fs::read(&retained).unwrap(), b"original");
        assert_eq!(fs::read(&target).unwrap(), b"new external revision");
      } else {
        assert!(matches!(failure, SaveFailure::Io(error) if error.raw_os_error() == Some(code as i32)));
        assert_eq!(fs::read(&target).unwrap(), b"original");
        assert!(!backup_path.exists());
        atomic_write(&target, b"draft", &content_digest(b"original")).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"draft");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
      }
    }
  }

  #[cfg(unix)]
  #[test]
  fn replacement_preserves_unix_mode() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempdir().unwrap();
    let path = dir.path().join("private.md");
    fs::write(&path, "original").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    atomic_write(&path, b"draft", &content_digest(b"original")).unwrap();
    assert_eq!(
      fs::metadata(path).unwrap().permissions().mode() & 0o777,
      0o640
    );
  }

  #[cfg(windows)]
  #[test]
  fn windows_replacement_preserves_the_targets_protected_acl() {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Security::Authorization::{SetNamedSecurityInfoW, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{
      GetFileSecurityW, GetSecurityDescriptorDacl, DACL_SECURITY_INFORMATION,
      PROTECTED_DACL_SECURITY_INFORMATION, SE_DACL_PROTECTED,
    };
    fn dacl(path: &[u16]) -> Vec<u8> {
      let mut needed = 0;
      unsafe {
        GetFileSecurityW(
          path.as_ptr(),
          DACL_SECURITY_INFORMATION,
          std::ptr::null_mut(),
          0,
          &mut needed,
        );
      }
      assert!(needed > 0);
      let mut descriptor = vec![0u8; needed as usize];
      let ok = unsafe {
        GetFileSecurityW(
          path.as_ptr(),
          DACL_SECURITY_INFORMATION,
          descriptor.as_mut_ptr().cast(),
          needed,
          &mut needed,
        )
      };
      assert_ne!(ok, 0, "{}", io::Error::last_os_error());
      descriptor
    }
    let dir = tempdir().unwrap();
    let path = dir.path().join("private.md");
    fs::write(&path, "original").unwrap();
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut descriptor = dacl(&wide);
    let mut present = 0;
    let mut defaulted = 0;
    let mut acl = std::ptr::null_mut();
    let ok = unsafe {
      GetSecurityDescriptorDacl(
        descriptor.as_mut_ptr().cast(),
        &mut present,
        &mut acl,
        &mut defaulted,
      )
    };
    assert_ne!(ok, 0, "{}", io::Error::last_os_error());
    assert_ne!(present, 0);
    let error = unsafe {
      SetNamedSecurityInfoW(
        wide.as_ptr(),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        acl,
        std::ptr::null(),
      )
    };
    assert_eq!(error, 0);
    let before = dacl(&wide);
    assert_ne!(
      u16::from_le_bytes([before[2], before[3]]) & SE_DACL_PROTECTED,
      0
    );
    atomic_write(&path, b"draft", &content_digest(b"original")).unwrap();
    let after = dacl(&wide);
    assert_ne!(
      u16::from_le_bytes([after[2], after[3]]) & SE_DACL_PROTECTED,
      0
    );
    // The auto-inherited bookkeeping bit may change; the ACL itself and its
    // protection against parent inheritance must be preserved exactly.
    let acl_offset = |data: &[u8]| u32::from_le_bytes(data[16..20].try_into().unwrap()) as usize;
    assert!(
      after[acl_offset(&after)..] == before[acl_offset(&before)..],
      "target ACL changed"
    );
  }
}
