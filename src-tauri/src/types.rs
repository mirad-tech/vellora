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
