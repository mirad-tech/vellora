use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownDocument {
  pub path: String,
  pub name: String,
  pub content: String,
  pub modified_at: f64,
  pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
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

impl<T: Serialize> CommandResult<T> {
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
}

#[derive(Debug, Clone, Serialize)]
pub struct DocumentPayload {
  pub document: MarkdownDocument,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePayload {
  pub src: String,
  pub mime: String,
}

#[derive(Debug, Clone, Serialize)]
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

#[derive(Debug, Clone, Serialize)]
pub struct EmptyPayload {}
