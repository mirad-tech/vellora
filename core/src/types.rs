//! Wire-compatible result types shared by the native core and the app layer.
//!
//! The native product has no IPC bridge, but the old command contract is kept
//! verbatim so that error codes, conflict tokens and messages stay testable
//! against the frozen baseline (see docs/native/PARITY.md).

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownDocument {
  pub path: String,
  pub name: String,
  pub content: String,
  pub modified_at: f64,
  pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum CommandResult<T> {
  Ok {
    ok: bool,
    #[serde(flatten)]
    data: T,
  },
  Err {
    ok: bool,
    code: String,
    message: String,
    #[serde(rename = "conflictToken", skip_serializing_if = "Option::is_none")]
    conflict_token: Option<String>,
  },
}

impl<T> CommandResult<T> {
  pub fn success(data: T) -> Self {
    Self::Ok { ok: true, data }
  }

  pub fn failure(code: impl Into<String>, message: impl Into<String>) -> Self {
    Self::Err {
      ok: false,
      code: code.into(),
      message: message.into(),
      conflict_token: None,
    }
  }

  pub fn file_changed(token: String) -> Self {
    Self::Err {
      ok: false,
      code: "FILE_CHANGED".to_string(),
      message: "文件已被其他程序修改，请选择保留草稿、重新加载或确认覆盖。".to_string(),
      conflict_token: Some(token),
    }
  }

  pub fn into_result(self) -> Result<T, CommandError> {
    match self {
      Self::Ok { data, .. } => Ok(data),
      Self::Err {
        ok: _,
        code,
        message,
        conflict_token,
      } => Err(CommandError {
        code,
        message,
        conflict_token,
      }),
    }
  }

  pub fn as_err(&self) -> Option<CommandError> {
    match self {
      Self::Ok { .. } => None,
      Self::Err {
        ok: _,
        code,
        message,
        conflict_token,
      } => Some(CommandError {
        code: code.clone(),
        message: message.clone(),
        conflict_token: conflict_token.clone(),
      }),
    }
  }
}

/// Borrowed view of an error arm. Kept separate so tests can assert on codes
/// without cloning the whole result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandError {
  pub code: String,
  pub message: String,
  pub conflict_token: Option<String>,
}

impl std::fmt::Display for CommandError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "{}: {}", self.code, self.message)
  }
}

impl std::error::Error for CommandError {}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DocumentPayload {
  pub document: MarkdownDocument,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePayload {
  pub src: String,
  pub mime: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum LinkInspectData {
  Markdown {
    action: String,
    document: MarkdownDocument,
  },
  External {
    action: String,
    url: String,
  },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EmptyPayload {}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn conflict_wire_format_is_camel_case_and_other_errors_are_unchanged() {
    let conflict = CommandResult::<DocumentPayload>::file_changed("token".to_string());
    let value = serde_json::to_value(conflict).unwrap();
    assert_eq!(value["conflictToken"], "token");
    assert_eq!(value["code"], "FILE_CHANGED");
    assert_eq!(value["ok"], false);
    assert!(value.get("conflict_token").is_none());
    let other = serde_json::to_value(CommandResult::<DocumentPayload>::failure(
      "NOT_FOUND",
      "missing",
    ))
    .unwrap();
    assert_eq!(other.as_object().unwrap().len(), 3);
  }

  #[test]
  fn success_payload_flattens_document_under_ok() {
    let payload = DocumentPayload {
      document: MarkdownDocument {
        path: "C:/n/a.md".into(),
        name: "a.md".into(),
        content: "# a".into(),
        modified_at: 1.0,
        size: 3,
      },
    };
    let value = serde_json::to_value(CommandResult::success(payload)).unwrap();
    assert_eq!(value["ok"], true);
    assert_eq!(value["document"]["name"], "a.md");
    assert_eq!(value["document"]["modifiedAt"], 1.0);
  }
}
