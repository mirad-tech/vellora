//! C ABI bridge for the Qt shell.
//!
//! Every function returns a heap-allocated UTF-8 JSON string that the caller
//! must release with [`vellora_free`]. The Qt layer renders from this neutral
//! plan; it never parses Markdown or touches the filesystem itself, so the same
//! path, size and protocol rules apply as in the tested core.

use std::ffi::{c_char, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};

use serde_json::{json, Value};
use vellora_core::session::{self, DiskDelete, SessionState};
use vellora_core::types::{CommandResult, LinkInspectData};
use vellora_core::{file_access, image_access, link_access, rename};
use vellora_md::{Alignment, Block, Document, Inline, PreservedMarkdown, Table};

static SESSION: std::sync::OnceLock<SessionState> = std::sync::OnceLock::new();

fn state() -> &'static SessionState {
  SESSION.get_or_init(SessionState::default)
}

fn into_c_string(value: Value) -> *mut c_char {
  CString::new(value.to_string()).map(CString::into_raw).unwrap_or(std::ptr::null_mut())
}

unsafe fn from_c(value: *const c_char) -> String {
  if value.is_null() {
    return String::new();
  }
  CStr::from_ptr(value).to_string_lossy().into_owned()
}

/// Reads `len` bytes of strict UTF-8 document text. Unlike [`from_c`], an
/// embedded NUL is content, not a terminator: U+0000 is valid UTF-8, the core
/// opens such files and the outbound JSON keeps it, so inbound text must too.
unsafe fn from_c_len(value: *const u8, len: usize) -> Result<String, Value> {
  if len == 0 {
    return Ok(String::new());
  }
  if value.is_null() {
    return Err(error_json("INVALID_ARGUMENT", "null buffer with a nonzero length"));
  }
  let bytes = unsafe { std::slice::from_raw_parts(value, len) };
  std::str::from_utf8(bytes)
    .map(str::to_owned)
    .map_err(|_| error_json("INVALID_ARGUMENT", "document text is not valid UTF-8"))
}

fn error_json(code: &str, message: &str) -> Value {
  json!({ "ok": false, "code": code, "message": message })
}

fn guarded(f: impl FnOnce() -> Value) -> *mut c_char {
  let result =
    catch_unwind(AssertUnwindSafe(f)).unwrap_or_else(|_| error_json("PANIC", "native bridge failed"));
  into_c_string(result)
}

fn runs_json(inlines: &[Inline]) -> Value {
  let mut runs = Vec::new();
  for inline in inlines {
    match inline {
      Inline::Text { text, marks } => runs.push(json!({
        "kind": "text",
        "text": text,
        "bold": marks.bold,
        "italic": marks.italic,
        "strike": marks.strike,
        "link": marks.link.as_ref().map(link_json),
      })),
      Inline::Code { text, marks } => runs.push(json!({
        "kind": "code",
        "text": text,
        "bold": marks.bold,
        "italic": marks.italic,
        "strike": marks.strike,
        "link": marks.link.as_ref().map(link_json),
      })),
      Inline::HardBreak { marks } | Inline::SoftBreak { marks } => runs.push(json!({
        "kind": if matches!(inline, Inline::HardBreak { .. }) { "hardBreak" } else { "softBreak" },
        "bold": marks.bold, "italic": marks.italic, "strike": marks.strike,
        "link": marks.link.as_ref().map(link_json),
      })),
      Inline::Image { src, alt, title, marks, alt_source, reference } => runs.push(json!({
        "kind": "image",
        "src": src,
        "alt": alt,
        "title": title,
        "link": marks.link.as_ref().map(link_json),
        "altSource": alt_source.as_ref().map(|saved| &saved.source),
        "altOriginal": alt_source.as_ref().map(|saved| &saved.original),
        "reference": reference.as_ref().map(reference_json),
      })),
    }
  }
  Value::Array(runs)
}

fn reference_json(reference: &vellora_md::Reference) -> Value {
  json!({ "kind": reference.kind.as_str(), "label": reference.label,
          "textSource": reference.text_source, "sourceId": reference.source_id })
}

fn link_json(link: &vellora_md::Link) -> Value {
  json!({ "href": link.href, "title": link.title, "reference": link.reference.as_ref().map(reference_json) })
}

fn blocks_json(blocks: &[Block]) -> Value {
  Value::Array(blocks.iter().map(block_json).collect())
}

fn block_json(block: &Block) -> Value {
  match block {
    Block::Paragraph(inlines) => json!({ "type": "paragraph", "runs": runs_json(inlines) }),
    Block::Heading { level, content } => {
      json!({ "type": "heading", "level": level, "runs": runs_json(content) })
    }
    Block::BlockQuote(blocks) => json!({ "type": "quote", "blocks": blocks_json(blocks) }),
    Block::List(list) => json!({
      "type": "list",
      "ordered": list.ordered,
      "start": list.start,
      "delimiter": list.delimiter.to_string(),
      "items": Value::Array(list.items.iter().map(|item| blocks_json(item)).collect()),
      "tasks": list.tasks,
      "loose": list.loose,
    }),
    Block::Table(table) => table_json(table),
    Block::CodeBlock { language, text } => {
      json!({ "type": "code", "language": language, "text": text })
    }
    Block::HorizontalRule => json!({ "type": "hr" }),
    Block::RawSource(text) => json!({ "type": "raw", "text": text }),
  }
}

fn table_json(table: &Table) -> Value {
  let align = |value: Alignment| match value {
    Alignment::None => "none",
    Alignment::Left => "left",
    Alignment::Center => "center",
    Alignment::Right => "right",
  };
  json!({
    "type": "table",
    "headerIsBody": table.header_is_body,
    "cellHeaders": table.cell_headers.iter().map(|row| row.iter().map(|cell|
      json!({ "header": cell.header, "scope": cell.scope.as_str() })).collect::<Vec<_>>()).collect::<Vec<_>>(),
    "spans": table.spans.iter().map(|row| row.iter().map(|(colspan, rowspan)|
      json!({ "colspan": colspan, "rowspan": rowspan })).collect::<Vec<_>>()).collect::<Vec<_>>(),
    "align": Value::Array(table.align.iter().map(|a| json!(align(*a))).collect()),
    "header": Value::Array(table.header.iter().map(|cell| runs_json(cell)).collect()),
    "rows": Value::Array(
      table.rows.iter().map(|row| {
        Value::Array(row.iter().map(|cell| runs_json(cell)).collect())
      }).collect()
    ),
  })
}

fn plan_json(document: &Document) -> Value {
  let source: String = document.segments.iter().map(|s| s.source.as_str()).collect();
  let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
  let previews = document
    .segments
    .iter()
    .any(|s| matches!(s.block, Block::RawSource(_)))
    .then(|| vellora_md::preview::PreviewContext::new(&source));
  let mut outline_items = Vec::new();
  let mut source_base = 0usize;
  // A flat block list keeps the Qt renderer simple, but every block carries the
  // segment it came from and that segment's retained source: the editor splices
  // edits back by segment so untouched bytes never go through a serializer.
  let blocks: Vec<Value> = document
    .segments
    .iter()
    .enumerate()
    .map(|(index, segment)| {
      let segment_source = segment.source.replace("\r\n", "\n").replace('\r', "\n");
      let mut headings = Vec::new();
      let mut value = block_json(&segment.block);
      if let Value::Object(map) = &mut value {
        map.insert("segment".to_string(), json!(index));
        map.insert("source".to_string(), json!(segment.source));
        if let Block::RawSource(_) = &segment.block {
          if vellora_md::parse::is_nonvisual_source(&segment_source) {
            map.insert("hidden".to_string(), json!(true));
          }
          let preview = previews.as_ref().expect("raw preview context").render(&segment_source);
          for block in &preview.blocks {
            collect_outline_headings(block, &mut headings);
          }
          map.insert(
            "preview".to_string(),
            json!({ "blocks": blocks_json(&preview.blocks), "limited": preview.limited }),
          );
        }
      }
      if !matches!(segment.block, Block::RawSource(_)) {
        collect_outline_headings(&segment.block, &mut headings);
      }
      let offsets =
        if headings.is_empty() { Vec::new() } else { vellora_md::outline::heading_offsets(&segment_source) };
      let mut offsets = offsets.into_iter();
      for (level, text) in headings {
        if let Some((_, offset)) = offsets.find(|(candidate, _)| *candidate == level) {
          outline_items.push((level, text, source_base + offset));
        }
      }
      source_base += segment_source.len();
      value
    })
    .collect();
  let mut previous = 0usize;
  let mut utf16 = 0usize;
  let outline: Vec<_> = outline_items
    .into_iter()
    .map(|(level, text, offset)| {
      if offset >= previous {
        utf16 += normalized[previous..offset].encode_utf16().count();
      } else {
        utf16 = normalized[..offset].encode_utf16().count();
      }
      previous = offset;
      json!({ "level": level, "text": text, "sourceOffset": utf16 })
    })
    .collect();
  json!({ "blocks": blocks, "outline": outline })
}

fn collect_outline_headings(block: &Block, result: &mut Vec<(u8, String)>) {
  match block {
    Block::Heading { level, .. } => result.push((*level, block.plain_text().trim().to_string())),
    Block::BlockQuote(children) => {
      for child in children {
        collect_outline_headings(child, result);
      }
    }
    Block::List(list) => {
      for item in &list.items {
        for child in item {
          collect_outline_headings(child, result);
        }
      }
    }
    _ => {}
  }
}

#[no_mangle]
pub extern "C" fn vellora_version() -> *mut c_char {
  into_c_string(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }))
}

/// Releases a heap-allocated C string previously returned by a `vellora_*` bridge function.
///
/// # Safety
///
/// `pointer` must either be null or be a non-freed pointer originally returned by
/// this crate's C string bridge functions.
#[no_mangle]
pub unsafe extern "C" fn vellora_free(pointer: *mut c_char) {
  if pointer.is_null() {
    return;
  }
  drop(unsafe { CString::from_raw(pointer) });
}

/// Opens a Markdown file and returns `{ok, document, plan, lineEnding}`.
///
/// # Safety
///
/// `path` must either be null or point to a valid NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn vellora_open(path: *const c_char) -> *mut c_char {
  guarded(|| {
    let path = unsafe { from_c(path) };
    match file_access::read_markdown_file(&path) {
      CommandResult::Ok { data, .. } => {
        session::remember_opened(state(), &CommandResult::success(data.clone()));
        let preserved = PreservedMarkdown::new(&data.document.content);
        let plan = plan_json(preserved.document());
        json!({
          "ok": true,
          "document": data.document,
          "plan": plan,
          "lineEnding": document_line_ending(&data.document.content),
        })
      }
      CommandResult::Err { code, message, .. } => error_json(&code, &message),
    }
  })
}

fn document_line_ending(source: &str) -> &'static str {
  match source.find('\n') {
    Some(index) if index > 0 && source.as_bytes()[index - 1] == b'\r' => "\r\n",
    _ => "\n",
  }
}

fn plan_response(content: &str) -> Value {
  let preserved = PreservedMarkdown::new(content);
  json!({ "ok": true, "plan": plan_json(preserved.document()) })
}

/// Renders Markdown bytes into the neutral plan without touching the session.
///
/// Document text stops at the first NUL here; the Qt shell uses [`vellora_plan_n`].
///
/// # Safety
///
/// `content` must either be null or point to a valid NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn vellora_plan(content: *const c_char) -> *mut c_char {
  guarded(|| plan_response(&unsafe { from_c(content) }))
}

/// Length-delimited [`vellora_plan`]: every byte of `content` is document text.
///
/// # Safety
///
/// `content` must point to `content_len` readable bytes, or be null when `content_len` is 0.
#[no_mangle]
pub unsafe extern "C" fn vellora_plan_n(content: *const u8, content_len: usize) -> *mut c_char {
  guarded(|| match unsafe { from_c_len(content, content_len) } {
    Ok(content) => plan_response(&content),
    Err(error) => error,
  })
}

fn save_response(path: &str, content: &str, token: String) -> Value {
  let token = if token.is_empty() { None } else { Some(token) };
  match session::save_document_session(state(), path, content, token.as_deref()) {
    CommandResult::Ok { data, .. } => {
      json!({ "ok": true, "document": data.document })
    }
    CommandResult::Err { ok: _, code, message, conflict_token } => json!({
      "ok": false,
      "code": code,
      "message": message,
      "conflictToken": conflict_token,
    }),
  }
}

/// Saves through the session; `token` may be empty for a first attempt.
///
/// `content` stops at the first NUL here, which would truncate the file on disk;
/// the Qt shell must use [`vellora_save_n`].
///
/// # Safety
///
/// `path`, `content`, and `token` must each either be null or point to a valid
/// NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn vellora_save(
  path: *const c_char,
  content: *const c_char,
  token: *const c_char,
) -> *mut c_char {
  guarded(|| {
    let path = unsafe { from_c(path) };
    let content = unsafe { from_c(content) };
    let token = unsafe { from_c(token) };
    save_response(&path, &content, token)
  })
}

/// Length-delimited [`vellora_save`]: every byte of `content` is written, including
/// U+0000; invalid UTF-8 is rejected with `INVALID_ARGUMENT` instead of being replaced.
///
/// # Safety
///
/// `path` and `token` must each either be null or point to a valid NUL-terminated C
/// string. `content` must point to `content_len` readable bytes, or be null when
/// `content_len` is 0.
#[no_mangle]
pub unsafe extern "C" fn vellora_save_n(
  path: *const c_char,
  content: *const u8,
  content_len: usize,
  token: *const c_char,
) -> *mut c_char {
  guarded(|| {
    let content = match unsafe { from_c_len(content, content_len) } {
      Ok(content) => content,
      Err(error) => return error,
    };
    let path = unsafe { from_c(path) };
    let token = unsafe { from_c(token) };
    save_response(&path, &content, token)
  })
}

/// Pure splice: indices belong to the explicitly supplied draft, never global
/// session state. A failed batch has no side effects and a retry is deterministic.
///
/// # Safety
///
/// `content` and `edits` must each either be null or point to a valid NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn vellora_splice(content: *const c_char, edits: *const c_char) -> *mut c_char {
  guarded(|| {
    let content = unsafe { from_c(content) };
    let raw = unsafe { from_c(edits) };
    splice_json(&content, &raw)
  })
}

/// Text-only pure splice for editor draft collection. The validation and source
/// preservation contract is identical to vellora_splice; no render plan is built.
///
/// # Safety
///
/// `content` and `edits` must each either be null or point to a valid NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn vellora_splice_text(content: *const c_char, edits: *const c_char) -> *mut c_char {
  guarded(|| {
    let content = unsafe { from_c(content) };
    let raw = unsafe { from_c(edits) };
    splice_json_impl(&content, &raw, false)
  })
}

/// Length-delimited [`vellora_splice_text`]. `edits` stays a C string: it is JSON,
/// whose encoder escapes U+0000, so only the draft itself needs an explicit length.
///
/// # Safety
///
/// `content` must point to `content_len` readable bytes, or be null when `content_len`
/// is 0. `edits` must either be null or point to a valid NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn vellora_splice_text_n(
  content: *const u8,
  content_len: usize,
  edits: *const c_char,
) -> *mut c_char {
  guarded(|| {
    let content = match unsafe { from_c_len(content, content_len) } {
      Ok(content) => content,
      Err(error) => return error,
    };
    let raw = unsafe { from_c(edits) };
    splice_json_impl(&content, &raw, false)
  })
}

fn splice_json(content: &str, raw: &str) -> Value {
  splice_json_impl(content, raw, true)
}

fn splice_json_impl(content: &str, raw: &str, include_plan: bool) -> Value {
  let parsed: Value = match serde_json::from_str(raw) {
    Ok(value) => value,
    Err(_) => return error_json("BAD_EDITS", "edits must be a JSON array"),
  };
  let Some(items) = parsed.as_array() else {
    return error_json("BAD_EDITS", "edits must be a JSON array");
  };
  let mut list = Vec::with_capacity(items.len());
  for item in items {
    let Some(index) = item.get("index").and_then(Value::as_u64).and_then(|v| usize::try_from(v).ok()) else {
      return error_json("BAD_EDITS", "each edit requires a nonnegative integer index");
    };
    let Some(markdown) = item.get("markdown").and_then(Value::as_str) else {
      return error_json("BAD_EDITS", "each edit requires a markdown string");
    };
    list.push((index, markdown.to_string()));
  }
  let result = match vellora_md::splice_markdown(content, &list) {
    Ok(result) => result,
    Err(message) => return error_json("BAD_EDITS", message),
  };
  let applied = list.len();
  if include_plan {
    // Reparse the exact output so the returned indices belong to its next revision.
    json!({ "ok": true, "content": result, "applied": applied,
      "plan": plan_json(&vellora_md::parse(&result)) })
  } else {
    json!({ "ok": true, "content": result, "applied": applied })
  }
}

/// Validates and resolves a local image against the open document.
///
/// # Safety
///
/// `document_path` and `src` must each either be null or point to a valid NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn vellora_image(document_path: *const c_char, src: *const c_char) -> *mut c_char {
  guarded(|| {
    let document_path = unsafe { from_c(document_path) };
    let src = unsafe { from_c(src) };
    match image_access::authorize_local_image(&document_path, &src, None) {
      CommandResult::Ok { data, .. } => json!({
        "ok": true,
        "path": data.path.to_string_lossy(),
        "mime": data.mime,
        "bytes": data.size,
        "modifiedAt": data.modified_at,
      }),
      CommandResult::Err { code, message, .. } => error_json(&code, &message),
    }
  })
}

/// Queries validated metadata `{ok, size, modifiedAt}` for a local image without
/// reading payload bytes or returning a filesystem path.
///
/// # Safety
///
/// `document_path` and `src` must each either be null or point to a valid NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn vellora_image_stat(document_path: *const c_char, src: *const c_char) -> *mut c_char {
  guarded(|| {
    let document_path = unsafe { from_c(document_path) };
    let src = unsafe { from_c(src) };
    match image_access::authorize_local_image(&document_path, &src, None) {
      CommandResult::Ok { data, .. } => json!({
        "ok": true,
        "size": data.size,
        "modifiedAt": data.modified_at,
      }),
      CommandResult::Err { code, message, .. } => error_json(&code, &message),
    }
  })
}

/// Reads validated owned image bytes directly without base64 or JSON string encoding.
/// Decoders must consume the returned buffer rather than reopening a pathname returned
/// by the metadata endpoint. The returned JSON status `{ok, code?, message?, mime, size, modifiedAt}`
/// never includes a filesystem path.
///
/// # Safety
///
/// `document_path` and `src` must each either be null or point to a valid NUL-terminated C string.
/// When non-null, `data` and `len` must point to writable locations; any non-null `*data`
/// written on success must be released once with [`vellora_free_bytes`].
#[no_mangle]
pub unsafe extern "C" fn vellora_image_read(
  document_path: *const c_char,
  src: *const c_char,
  data: *mut *mut u8,
  len: *mut usize,
) -> *mut c_char {
  if !data.is_null() {
    unsafe { *data = std::ptr::null_mut() };
  }
  if !len.is_null() {
    unsafe { *len = 0 };
  }
  guarded(|| {
    if data.is_null() || len.is_null() {
      return error_json("INVALID_ARGUMENT", "output buffer pointers must not be null");
    }
    let document_path = unsafe { from_c(document_path) };
    let src = unsafe { from_c(src) };
    match image_access::read_local_image(&document_path, &src, None) {
      CommandResult::Ok { data: resolved, .. } => {
        let boxed = resolved.bytes.into_boxed_slice();
        let byte_len = boxed.len();
        if !boxed.is_empty() {
          let raw = Box::into_raw(boxed) as *mut u8;
          unsafe {
            *data = raw;
            *len = byte_len;
          }
        }
        json!({
          "ok": true,
          "mime": resolved.mime,
          "size": byte_len,
          "modifiedAt": resolved.modified_at,
        })
      }
      CommandResult::Err { code, message, .. } => error_json(&code, &message),
    }
  })
}

/// Releases a raw byte buffer previously allocated by [`vellora_image_read`].
///
/// # Safety
///
/// Either `data` is null / `len` is zero, or `(data, len)` must exactly match a
/// non-freed allocation produced by [`vellora_image_read`].
#[no_mangle]
pub unsafe extern "C" fn vellora_free_bytes(data: *mut u8, len: usize) {
  if data.is_null() || len == 0 {
    return;
  }
  let slice = unsafe { std::slice::from_raw_parts_mut(data, len) };
  drop(unsafe { Box::from_raw(slice) });
}

/// Link inspection: relative Markdown or an external http(s) URL.
///
/// # Safety
///
/// `document_path` and `href` must each either be null or point to a valid NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn vellora_inspect_link(
  document_path: *const c_char,
  href: *const c_char,
) -> *mut c_char {
  guarded(|| {
    let document_path = unsafe { from_c(document_path) };
    let href = unsafe { from_c(href) };
    match session::inspect_link_session(state(), &document_path, &href) {
      CommandResult::Ok { data, .. } => match data {
        LinkInspectData::Markdown { document, .. } => json!({
          "ok": true,
          "action": "markdown",
          "document": document,
        }),
        LinkInspectData::External { url, .. } => json!({
          "ok": true,
          "action": "external",
          "url": url,
        }),
      },
      CommandResult::Err { code, message, .. } => error_json(&code, &message),
    }
  })
}

/// Opens a local Markdown link, switching the session on success.
///
/// # Safety
///
/// `document_path` and `href` must each either be null or point to a valid NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn vellora_open_link(document_path: *const c_char, href: *const c_char) -> *mut c_char {
  guarded(|| {
    let document_path = unsafe { from_c(document_path) };
    let href = unsafe { from_c(href) };
    match session::open_link_session(state(), &document_path, &href) {
      CommandResult::Ok { data, .. } => {
        let preserved = PreservedMarkdown::new(&data.document.content);
        let plan = plan_json(preserved.document());
        json!({ "ok": true, "document": data.document, "plan": plan,
          "lineEnding": document_line_ending(&data.document.content) })
      }
      CommandResult::Err { code, message, .. } => error_json(&code, &message),
    }
  })
}

/// Opens an HTTP(S) URL after the caller has confirmed.
///
/// # Safety
///
/// `url` must either be null or point to a valid NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn vellora_open_external(url: *const c_char) -> *mut c_char {
  guarded(|| {
    let url = unsafe { from_c(url) };
    let result = link_access::open_external_url(&url, |target| {
      std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", target]).spawn().map(|_| ())
    });
    match result {
      CommandResult::Ok { .. } => json!({ "ok": true }),
      CommandResult::Err { code, message, .. } => error_json(&code, &message),
    }
  })
}

/// Renames a Markdown file or a folder in place, never replacing an existing entry.
/// Returns `{ok, path, name, isDir, sessionPath}`; `sessionPath` is the open
/// document's new path when the rename moved it, otherwise null.
///
/// # Safety
///
/// `path` and `new_name` must each either be null or point to a valid NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn vellora_rename(path: *const c_char, new_name: *const c_char) -> *mut c_char {
  guarded(|| {
    let path = unsafe { from_c(path) };
    let new_name = unsafe { from_c(new_name) };
    match session::rename_entry_session(state(), &path, &new_name) {
      CommandResult::Ok { data, .. } => json!({
        "ok": true,
        "path": data.path,
        "name": data.name,
        "isDir": data.is_dir,
        "sessionPath": data.session_path,
      }),
      CommandResult::Err { code, message, .. } => error_json(&code, &message),
    }
  })
}

/// Creates an empty Markdown file in `directory` without replacing anything. An
/// empty `name` picks the first free "未命名.md", "未命名 2.md", ... Returns
/// `{ok, path, name, realPath}`: `path` keeps the folder as given, links included;
/// `realPath` is the same file as an opened document reports it.
///
/// # Safety
///
/// `directory` and `name` must each either be null or point to a valid NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn vellora_create_markdown(
  directory: *const c_char,
  name: *const c_char,
) -> *mut c_char {
  guarded(|| {
    let directory = unsafe { from_c(directory) };
    let name = unsafe { from_c(name) };
    match rename::create_markdown_entry(&directory, &name) {
      CommandResult::Ok { data, .. } => {
        json!({ "ok": true, "path": data.path, "name": data.name, "realPath": data.real_path })
      }
      CommandResult::Err { code, message, .. } => error_json(&code, &message),
    }
  })
}

/// Removes a Markdown file only while it is still an empty regular file. Used for
/// a new file the user abandoned; anything with content is kept. Returns `{ok}`.
///
/// # Safety
///
/// `path` must either be null or point to a valid NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn vellora_remove_empty_markdown(path: *const c_char) -> *mut c_char {
  guarded(|| {
    let path = unsafe { from_c(path) };
    match rename::remove_empty_markdown(&path) {
      CommandResult::Ok { .. } => json!({ "ok": true }),
      CommandResult::Err { code, message, .. } => error_json(&code, &message),
    }
  })
}

/// A link or image target that resolves against the document's folder, so a
/// moved document may no longer find it. Anchors, URLs with a scheme, drive and
/// root paths stay valid wherever the document is.
fn is_scheme_char(c: char) -> bool {
  c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')
}

fn is_relative_target(target: &str) -> bool {
  if target.is_empty() || target.starts_with(['#', '/', '\\']) {
    return false;
  }
  let end = target.find(['/', '\\', '?', '#']).unwrap_or(target.len());
  if let Some(colon) = target[..end].find(':') {
    let scheme = &target[..colon];
    // "https:", "mailto:", and a drive letter such as "C:".
    if !scheme.is_empty() && scheme.chars().all(is_scheme_char) {
      return false;
    }
  }
  true
}

fn note_target(target: &str, found: &mut Vec<String>) {
  let target = target.trim();
  let target = target.strip_prefix('<').and_then(|inner| inner.strip_suffix('>')).unwrap_or(target);
  if is_relative_target(target) && !found.iter().any(|seen| seen == target) {
    found.push(target.to_string());
  }
}

fn note_inlines(inlines: &[Inline], found: &mut Vec<String>) {
  for inline in inlines {
    if let Some(link) = &inline.marks().link {
      note_target(&link.href, found);
    }
    if let Inline::Image { src, .. } = inline {
      note_target(src, found);
    }
  }
}

/// `src` and `href` attributes in retained HTML.
fn note_html(source: &str, found: &mut Vec<String>) {
  // ASCII lowering keeps every byte offset, so positions index `source` too.
  let lower = source.to_ascii_lowercase();
  for attribute in [" src=", " href=", "\tsrc=", "\thref=", "\nsrc=", "\nhref="] {
    let mut from = 0;
    while let Some(at) = lower[from..].find(attribute) {
      let start = from + at + attribute.len();
      from = start;
      let rest = &source[start..];
      let value = match rest.chars().next() {
        Some(quote @ ('"' | '\'')) => rest[1..].split(quote).next().unwrap_or(""),
        _ => rest.split(|c: char| c.is_whitespace() || c == '>').next().unwrap_or(""),
      };
      note_target(value, found);
    }
  }
}

fn note_block(block: &Block, found: &mut Vec<String>) {
  match block {
    Block::Paragraph(inlines) | Block::Heading { content: inlines, .. } => note_inlines(inlines, found),
    Block::BlockQuote(blocks) => blocks.iter().for_each(|block| note_block(block, found)),
    Block::List(list) => list.items.iter().flatten().for_each(|block| note_block(block, found)),
    Block::Table(table) => {
      table.header.iter().for_each(|cell| note_inlines(cell, found));
      table.rows.iter().flatten().for_each(|cell| note_inlines(cell, found));
    }
    Block::RawSource(source) => note_html(source, found),
    Block::CodeBlock { .. } | Block::HorizontalRule => {}
  }
}

/// Every distinct relative link and image target, in document order.
fn relative_targets(markdown: &str) -> Vec<String> {
  let mut found = Vec::new();
  for segment in &vellora_md::parse(markdown).segments {
    note_block(&segment.block, &mut found);
  }
  found
}

/// Describes moving `path` into `directory` for the warning before it. Returns
/// `{ok, path, name, isDir, target, sameFolder, containsSession,
/// relativeReferences, examples}`; changes nothing. For a file, the relative
/// links and images are counted in `draft` (the open document's unsaved text,
/// used only when the file is that document) or else in the file on disk.
///
/// # Safety
///
/// `path` and `directory` must each either be null or point to a valid
/// NUL-terminated C string; `draft` must be valid for `draft_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn vellora_inspect_move(
  path: *const c_char,
  directory: *const c_char,
  draft: *const u8,
  draft_len: usize,
  has_draft: i32,
) -> *mut c_char {
  guarded(|| {
    let path = unsafe { from_c(path) };
    let directory = unsafe { from_c(directory) };
    let draft = if has_draft == 0 {
      None
    } else {
      match unsafe { from_c_len(draft, draft_len) } {
        Ok(text) => Some(text),
        Err(error) => return error,
      }
    };
    let data = match session::inspect_move_session(state(), &path, &directory) {
      CommandResult::Ok { data, .. } => data,
      CommandResult::Err { code, message, .. } => return error_json(&code, &message),
    };
    // A folder moves with everything it links to inside it.
    let targets = if data.is_dir || data.same_folder {
      Vec::new()
    } else {
      match draft.filter(|_| data.contains_session) {
        Some(text) => relative_targets(&text),
        None => match file_access::read_markdown_file(&data.path) {
          CommandResult::Ok { data: file, .. } => relative_targets(&file.document.content),
          CommandResult::Err { .. } => Vec::new(),
        },
      }
    };
    json!({
      "ok": true,
      "path": data.path,
      "name": data.name,
      "isDir": data.is_dir,
      "target": data.target,
      "sameFolder": data.same_folder,
      "containsSession": data.contains_session,
      "relativeReferences": targets.len(),
      "examples": targets.iter().take(3).collect::<Vec<_>>(),
    })
  })
}

/// Moves a Markdown file or a folder into `directory` on the same drive, never
/// replacing anything. Returns `{ok, path, name, isDir, sessionPath}` like
/// [`vellora_rename`]; `sessionPath` is the open document's new path if it moved.
///
/// # Safety
///
/// `path` and `directory` must each either be null or point to a valid NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn vellora_move_entry(path: *const c_char, directory: *const c_char) -> *mut c_char {
  guarded(|| {
    let path = unsafe { from_c(path) };
    let directory = unsafe { from_c(directory) };
    match session::move_entry_session(state(), &path, &directory) {
      CommandResult::Ok { data, .. } => json!({
        "ok": true,
        "path": data.path,
        "name": data.name,
        "isDir": data.is_dir,
        "sessionPath": data.session_path,
      }),
      CommandResult::Err { code, message, .. } => error_json(&code, &message),
    }
  })
}

/// Deletes an entry for [`vellora_delete_entry`]: `permanent` 0 moves it to the
/// recycle bin, 1 destroys it. Returns 0 when done, 1 when the entry cannot be
/// recycled and nothing changed, and otherwise the failure's HRESULT.
pub type DeleteEntryFn = unsafe extern "C" fn(path: *const c_char, permanent: i32) -> i32;

/// HRESULT for an argument the shell cannot take.
const E_INVALIDARG: i32 = 0x8007_0057_u32 as i32;

/// The shell does not parse `\\?\` paths, so it gets the ordinary spelling.
fn shell_path(path: &std::path::Path) -> String {
  let text = path.to_string_lossy();
  if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
    return format!(r"\\{rest}");
  }
  text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

/// Describes an entry for the confirmation before deleting it. Returns
/// `{ok, path, name, isDir, containsSession}`; never changes the disk or session.
///
/// # Safety
///
/// `path` must either be null or point to a valid NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn vellora_inspect_delete(path: *const c_char) -> *mut c_char {
  guarded(|| {
    let path = unsafe { from_c(path) };
    match session::inspect_delete_session(state(), &path) {
      CommandResult::Ok { data, .. } => json!({
        "ok": true,
        "path": data.path,
        "name": data.name,
        "isDir": data.is_dir,
        "containsSession": data.contains_session,
      }),
      CommandResult::Err { code, message, .. } => error_json(&code, &message),
    }
  })
}

/// Deletes a Markdown file or a folder through `delete` and closes the session
/// when the open document went with it. Returns `{ok, path, isDir, permanent,
/// closedSession}`, or the code `RECYCLE_UNAVAILABLE` when it cannot be recycled.
///
/// # Safety
///
/// `path` must either be null or point to a valid NUL-terminated C string, and
/// `delete` must be safe to call with a NUL-terminated UTF-8 path.
#[no_mangle]
pub unsafe extern "C" fn vellora_delete_entry(
  path: *const c_char,
  permanent: i32,
  delete: Option<DeleteEntryFn>,
) -> *mut c_char {
  guarded(|| {
    let path = unsafe { from_c(path) };
    let delete = match delete {
      Some(delete) => delete,
      None => return error_json("INVALID_ARGUMENT", "missing delete callback"),
    };
    let result = session::delete_entry_session(state(), &path, permanent != 0, |entry, permanent| {
      let native = match CString::new(shell_path(entry)) {
        Ok(native) => native,
        Err(_) => return DiskDelete::Failed(E_INVALIDARG),
      };
      match unsafe { delete(native.as_ptr(), i32::from(permanent)) } {
        0 => DiskDelete::Deleted,
        1 => DiskDelete::NotRecyclable,
        code => DiskDelete::Failed(code),
      }
    });
    match result {
      CommandResult::Ok { data, .. } => json!({
        "ok": true,
        "path": data.path,
        "isDir": data.is_dir,
        "permanent": data.permanent,
        "closedSession": data.closed_session,
      }),
      CommandResult::Err { code, message, .. } => error_json(&code, &message),
    }
  })
}

/// Reports whether the current session still matches `path`.
///
/// # Safety
///
/// `path` must either be null or point to a valid NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn vellora_session_matches(path: *const c_char) -> *mut c_char {
  guarded(|| {
    let path = unsafe { from_c(path) };
    let matches = session::require_session_document(state(), &path).is_ok();
    json!({ "ok": true, "matches": matches })
  })
}

#[cfg(test)]
mod tests {
  #[test]
  fn task_leading_marks_survive_plan_export_and_reparse() {
    let source = "- [ ] **bold** `code` end\n  - [x] **nested *marks***\n";
    let mut document = vellora_md::parse(source);
    let plan = plan_json(&document);
    let runs = &plan["blocks"][0]["items"][0][0]["runs"];
    assert_eq!(runs[0]["text"], "bold");
    assert_eq!(runs[0]["bold"], true);
    assert!(runs.as_array().unwrap().iter().any(|r| r["text"] == "code" && r["kind"] == "code"));
    let nested = &plan["blocks"][0]["items"][0][1]["items"][0][0]["runs"];
    assert_eq!(nested[0]["text"], "nested ");
    assert_eq!(nested[0]["bold"], true);
    assert_eq!(nested[1]["text"], "marks");
    assert_eq!(nested[1]["bold"], true);
    assert_eq!(nested[1]["italic"], true);
    document.segments[0].mark_dirty();
    let exported = vellora_md::to_markdown(&document, "\n");
    assert!(document.content_eq(&vellora_md::parse(&exported)), "{exported}");
    assert_eq!(plan_json(&vellora_md::parse(&exported))["blocks"][0]["items"], plan["blocks"][0]["items"]);
  }

  #[test]
  fn structured_task_plan_aligns_states_and_keeps_source() {
    let source = "- [ ] todo `code`\n- normal\n- [X] done\n  1. [x] child [link](https://example.com)\n";
    let plan = plan_json(&vellora_md::parse(source));
    let list = &plan["blocks"][0];
    assert_eq!(list["type"], "list");
    assert_eq!(list["tasks"], json!([false, null, true]));
    assert_eq!(list["source"], source);
    assert_eq!(list["items"][2][1]["tasks"], json!([true]));
    assert_eq!(list["items"][2][1]["ordered"], true);
  }

  use super::*;

  #[test]
  fn nonvisual_definitions_and_comments_are_explicit_but_unknown_raw_is_not_hidden() {
    for source in
      ["[id]: https://example.com/ \"title\"\n", "<!-- note -->\n", "<!-- first\nsecond -->\n\n[id]: /path\n"]
    {
      let plan = plan_json(&vellora_md::parse(source));
      for block in plan["blocks"].as_array().unwrap() {
        assert_eq!(block["hidden"], true, "{source}: {plan}");
        assert!(block["source"].as_str().is_some());
      }
    }
    for source in [
      "<script>hidden by sanitization</script>\n",
      "<!-- unclosed",
      "---\ntitle: metadata\n---\n",
      "<unknown>content</unknown>\n",
    ] {
      let plan = plan_json(&vellora_md::parse(source));
      assert!(plan["blocks"].as_array().unwrap().iter().all(|b| b["hidden"] != true), "{source}: {plan}");
    }
  }

  #[test]
  fn reference_and_image_fidelity_metadata_crosses_bridge() {
    let source = "[**bold** text][Ref] [second][Ref] ![**picture**][image]\n\n[Ref]: https://example.com/ \"title\"\n[image]: sample.png\n";
    let plan = plan_json(&vellora_md::parse(source));
    let runs = plan["blocks"][0]["runs"].as_array().unwrap();
    assert_eq!(plan["blocks"][0]["type"], "paragraph");
    assert_eq!(runs[0]["link"]["reference"]["textSource"], "**bold** text");
    assert_eq!(runs[0]["link"]["reference"]["kind"], "full");
    assert_eq!(runs[0]["link"]["reference"]["label"], "Ref");
    assert_eq!(runs[0]["link"]["reference"]["sourceId"], runs[1]["link"]["reference"]["sourceId"]);
    let next = runs.iter().find(|run| run["text"] == "second").unwrap();
    assert_ne!(runs[0]["link"]["reference"]["sourceId"], next["link"]["reference"]["sourceId"]);
    let image = runs.iter().find(|run| run["kind"] == "image").unwrap();
    assert_eq!(image["alt"], "picture");
    assert_eq!(image["altSource"], "**picture**");
    assert_eq!(image["altOriginal"], "picture");
    assert_eq!(image["reference"]["label"], "image");
  }

  #[test]
  fn plan_marks_bold_and_table_structure() {
    let plan = plan_json(&vellora_md::parse("**bold** and | a |\n\n| c | d |\n| --- | --- |\n| 1 | 2 |\n"));
    let blocks = plan["blocks"].as_array().unwrap();
    assert!(blocks.iter().any(|b| b["type"] == "table"));
    let paragraph = blocks.iter().find(|b| b["type"] == "paragraph").unwrap();
    assert_eq!(paragraph["runs"][0]["bold"], true);
  }

  #[test]
  fn plan_carries_segment_indices_and_sources() {
    let plan = plan_json(&vellora_md::parse("alpha\n\nbeta\n"));
    let blocks = plan["blocks"].as_array().unwrap();
    assert_eq!(blocks[0]["segment"], 0);
    assert_eq!(blocks[1]["segment"], 1);
    assert!(blocks[0]["source"].as_str().unwrap().contains("alpha"));
  }

  #[test]
  fn plan_carries_link_targets() {
    let plan = plan_json(&vellora_md::parse("[docs](./a.md)\n"));
    let blocks = plan["blocks"].as_array().unwrap();
    assert_eq!(blocks[0]["runs"][0]["link"]["href"], "./a.md");
  }

  #[test]
  fn outline_offsets_follow_render_order_and_normalized_utf16_positions() {
    let source = "😀 repeated\r\n\r\n# **repeated**\r\n\r\n> ## [nested][ref]\r\n\r\n[ref]: https://example.com\r\n\r\n<div><h3>HTML😀</h3><script></div><h3>hidden</h3></script><h4>last</h4></div>\r\n";
    let normalized = source.replace("\r\n", "\n");
    let plan = plan_json(&vellora_md::parse(source));
    let outline = plan["outline"].as_array().unwrap();
    assert_eq!(outline.len(), 4, "{outline:?}");
    for (index, (marker, level, title)) in
      [("# **", 1, "repeated"), ("## [", 2, "nested"), ("<h3>", 3, "HTML😀"), ("<h4>", 4, "last")]
        .iter()
        .enumerate()
    {
      let offset = normalized[..normalized.find(marker).unwrap()].encode_utf16().count();
      assert_eq!(outline[index]["level"], *level);
      assert_eq!(outline[index]["text"], *title);
      assert_eq!(outline[index]["sourceOffset"], offset);
    }
  }

  #[test]
  fn raw_plan_previews_keep_source_and_resolve_context_headings() {
    let source = "# [Heading][ref]\n\n[ref]: https://example.com\n\n<div><h2>HTML title</h2><pre><code>copy me</code></pre></div>\n";
    let plan = plan_json(&vellora_md::parse(source));
    let blocks = plan["blocks"].as_array().unwrap();
    let heading = &blocks[0];
    assert_eq!(heading["type"], "heading");
    assert_eq!(heading["source"], "# [Heading][ref]\n");
    assert_eq!(heading["runs"][0]["link"]["href"], "https://example.com");
    assert_eq!(heading["runs"][0]["link"]["reference"]["label"], "ref");
    let html =
      blocks.iter().find(|b| b["text"].as_str().is_some_and(|text| text.starts_with("<div>"))).unwrap();
    assert_eq!(html["preview"]["blocks"][0]["level"], 2);
    assert_eq!(html["preview"]["blocks"][1]["text"], "copy me");
    assert!(html["preview"]["blocks"][0].get("source").is_none());
  }

  #[test]
  fn image_resolution_rejects_traversal() {
    let path = std::ffi::CString::new("C:/notes/a.md").unwrap();
    let src = std::ffi::CString::new("../secret.png").unwrap();
    let raw = unsafe { vellora_image(path.as_ptr(), src.as_ptr()) };
    let text = unsafe { CStr::from_ptr(raw).to_string_lossy().into_owned() };
    unsafe { vellora_free(raw) };
    assert!(text.contains("UNSUPPORTED_IMAGE_SOURCE"), "{text}");
  }

  #[test]
  fn document_with_nul_bytes_round_trips_through_into_c_string() {
    let original = "before\0middle\0after\n";
    let preserved = PreservedMarkdown::new(original);
    let raw = into_c_string(json!({
      "ok": true,
      "content": original,
      "plan": plan_json(preserved.document()),
    }));
    assert!(!raw.is_null());
    let payload: Value = serde_json::from_str(unsafe { CStr::from_ptr(raw) }.to_str().unwrap()).unwrap();
    unsafe { vellora_free(raw) };
    assert_eq!(payload["ok"], true, "{payload}");
    assert_eq!(payload["content"].as_str(), Some(original));
    assert_eq!(payload["plan"]["blocks"][0]["source"].as_str(), Some(original));
  }

  #[test]
  fn guarded_catches_panic_and_returns_panic_error_json() {
    let raw = guarded(|| panic!("simulated bridge panic"));
    assert!(!raw.is_null());
    let text = unsafe { CStr::from_ptr(raw).to_str().unwrap().to_owned() };
    unsafe { vellora_free(raw) };
    let parsed: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["code"], "PANIC");
    assert_eq!(parsed["message"], "native bridge failed");
  }
}

#[cfg(test)]
mod splice_tests {
  use super::*;

  fn splice(source: &str, edits: Value) -> Value {
    let source = CString::new(source).unwrap();
    let edits = CString::new(edits.to_string()).unwrap();
    let raw = unsafe { vellora_splice(source.as_ptr(), edits.as_ptr()) };
    let value = serde_json::from_str(unsafe { CStr::from_ptr(raw) }.to_str().unwrap()).unwrap();
    unsafe { vellora_free(raw) };
    value
  }

  #[test]
  fn splice_is_pure_repeatable_and_uses_the_explicit_draft() {
    let edits = json!([{"index": 0, "markdown": "new\n\nextra"}]);
    let first = splice("old\n\ntail\n", edits.clone());
    assert_eq!(first["ok"], true);
    assert_eq!(first["content"], "new\n\nextra\n\ntail\n");
    assert_eq!(first, splice("old\n\ntail\n", edits));
    assert_eq!(first["plan"]["blocks"].as_array().unwrap().len(), 3);
    let second = splice(first["content"].as_str().unwrap(), json!([{"index":2,"markdown":"TAIL"}]));
    assert_eq!(second["content"], "new\n\nextra\n\nTAIL\n");
  }

  #[test]
  fn malformed_partial_duplicate_and_stale_batches_fail() {
    for edits in [
      json!({}),
      json!([{}]),
      json!([{"index":0}]),
      json!([{"index":-1,"markdown":"x"}]),
      json!([{"index":0.5,"markdown":"x"}]),
      json!([{"index":0,"markdown":null}]),
      json!([{"index":0,"markdown":"x"},{"index":9,"markdown":"y"}]),
      json!([{"index":0,"markdown":"x"},{"index":0,"markdown":"y"}]),
    ] {
      let result = splice("original\n", edits);
      assert_eq!(result["ok"], false, "{result}");
      assert_eq!(result["code"], "BAD_EDITS");
    }
    assert_eq!(splice("original\n", json!([]))["content"], "original\n");
  }

  #[test]
  fn empty_edits_and_source_spelling_are_byte_exact() {
    for source in
      ["", "\n\n", "\r\na\r\n\r\nb\n", "[ref]: https://example.com\r\n", "<script>alert(1)</script>\n"]
    {
      assert_eq!(splice(source, json!([]))["content"], source);
    }
    assert_eq!(splice("only\n", json!([{"index":0,"markdown":""}]))["content"], "");
    assert_eq!(splice("a\n", json!([{"index":0,"markdown":"a\n"}]))["content"], "a\n");
  }
}

#[cfg(test)]
mod session_splice_tests {
  use super::*;

  fn read_result(raw: *mut c_char) -> Value {
    let result = serde_json::from_str(unsafe { CStr::from_ptr(raw) }.to_str().unwrap()).unwrap();
    unsafe { vellora_free(raw) };
    result
  }

  #[test]
  fn source_draft_splice_save_reopen_uses_current_bytes() {
    let filename = format!(
      "vellora-splice-test-{}-{}.md",
      std::process::id(),
      std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    );
    let path = std::env::temp_dir().join(filename);
    std::fs::write(&path, "original\n\ntail\n").unwrap();
    let cpath = CString::new(path.to_str().unwrap()).unwrap();
    let opened = read_result(unsafe { vellora_open(cpath.as_ptr()) });
    assert_eq!(opened["ok"], true);
    let cpath = CString::new(opened["document"]["path"].as_str().unwrap()).unwrap();
    let draft = "source first\r\n\r\ninserted\r\n\r\nsource tail\n";
    let result = splice_json(draft, r#"[{"index":1,"markdown":"edited"}]"#);
    let expected = "source first\r\n\r\nedited\r\n\r\nsource tail\n";
    assert_eq!(result["content"], expected);
    let content = CString::new(expected).unwrap();
    let empty = CString::new("").unwrap();
    let saved = read_result(unsafe { vellora_save(cpath.as_ptr(), content.as_ptr(), empty.as_ptr()) });
    assert_eq!(saved["ok"], true, "{saved}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), expected);
    let reopened = read_result(unsafe { vellora_open(cpath.as_ptr()) });
    assert_eq!(reopened["document"]["content"], expected);
    assert_eq!(reopened["plan"], result["plan"]);
    // U+0000 is document content: the length-delimited save must keep every byte after it.
    let with_nul = "before\0after\n\ntail\n";
    let saved = read_result(unsafe {
      vellora_save_n(cpath.as_ptr(), with_nul.as_ptr(), with_nul.len(), empty.as_ptr())
    });
    assert_eq!(saved["ok"], true, "{saved}");
    assert_eq!(std::fs::read(&path).unwrap(), with_nul.as_bytes());
    let linked = path.with_extension("linked.md");
    std::fs::write(&linked, "linked\r\n\r\nbody\r\n").unwrap();
    let href = CString::new(linked.file_name().unwrap().to_str().unwrap()).unwrap();
    let followed = read_result(unsafe { vellora_open_link(cpath.as_ptr(), href.as_ptr()) });
    assert_eq!(followed["ok"], true, "{followed}");
    assert_eq!(followed["lineEnding"], "\r\n");
    assert_eq!(followed["document"]["content"], "linked\r\n\r\nbody\r\n");
    std::fs::remove_file(&linked).unwrap();
    std::fs::remove_file(&path).unwrap();
  }
}

#[cfg(test)]
mod text_splice_tests {
  use super::*;
  #[test]
  fn text_endpoint_matches_full_endpoint_without_plan() {
    for source in ["", "one\r\n\r\ntwo\r\n", "<h2>raw</h2>\n"] {
      for edits in [
        "[]",
        r#"[{"index":0,"markdown":"changed"}]"#,
        r#"[{"index":0,"markdown":""}]"#,
        r#"[{"index":99,"markdown":"x"}]"#,
        r#"[{"index":0,"markdown":"x"},{"index":0,"markdown":"y"}]"#,
        "{}",
        r#"[{"index":-1,"markdown":2}]"#,
      ] {
        let source_c = std::ffi::CString::new(source).unwrap();
        let edits_c = std::ffi::CString::new(edits).unwrap();
        let pointer = unsafe { vellora_splice_text(source_c.as_ptr(), edits_c.as_ptr()) };
        let text: Value =
          serde_json::from_str(unsafe { std::ffi::CStr::from_ptr(pointer) }.to_str().unwrap()).unwrap();
        unsafe { vellora_free(pointer) };
        let mut full = splice_json(source, edits);
        full.as_object_mut().unwrap().remove("plan");
        assert_eq!(text, full, "source={source:?} edits={edits}");
      }
    }
  }
}

#[cfg(test)]
mod image_read_tests {
  use super::*;

  fn read_raw(path: Option<&str>, src: Option<&str>) -> (Value, Vec<u8>) {
    let path_c = path.map(|p| CString::new(p).unwrap());
    let src_c = src.map(|s| CString::new(s).unwrap());
    let mut data: *mut u8 = std::ptr::null_mut();
    let mut len: usize = 0;
    let pointer = unsafe {
      vellora_image_read(
        path_c.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
        src_c.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
        &mut data,
        &mut len,
      )
    };
    let status: Value = serde_json::from_str(unsafe { CStr::from_ptr(pointer) }.to_str().unwrap()).unwrap();
    unsafe { vellora_free(pointer) };
    let bytes = if data.is_null() || len == 0 {
      assert!(data.is_null() && len == 0);
      Vec::new()
    } else {
      unsafe { std::slice::from_raw_parts(data, len) }.to_vec()
    };
    unsafe { vellora_free_bytes(data, len) };
    (status, bytes)
  }

  #[test]
  fn image_read_returns_raw_bytes_without_path_and_revalidates_each_request() {
    let root = std::env::temp_dir().join(format!(
      "vellora-image-read-{}-{}",
      std::process::id(),
      std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    std::fs::create_dir(&root).unwrap();
    let doc = root.join("doc.md");
    let image = root.join("pic.gif");
    std::fs::write(&doc, "# doc").unwrap();
    std::fs::write(&image, b"GIF89a").unwrap();

    let (first, bytes) = read_raw(Some(doc.to_str().unwrap()), Some("pic.gif"));
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(first["mime"], "image/gif");
    assert!(first.get("path").is_none());
    assert!(first.get("dataUrl").is_none());
    assert_eq!(bytes, b"GIF89a");

    std::fs::File::create(&image)
      .unwrap()
      .set_len(image_access::DEFAULT_MAX_MARKDOWN_IMAGE_BYTES + 1)
      .unwrap();
    let (oversized, empty) = read_raw(Some(doc.to_str().unwrap()), Some("pic.gif"));
    assert_eq!(oversized["code"], "IMAGE_TOO_LARGE");
    assert!(empty.is_empty());

    assert_eq!(
      read_raw(Some(doc.to_str().unwrap()), Some("../pic.gif")).0["code"],
      "UNSUPPORTED_IMAGE_SOURCE"
    );
    assert_eq!(
      read_raw(Some(doc.to_str().unwrap()), Some("https://example.com/pic.gif")).0["code"],
      "UNSUPPORTED_IMAGE_SOURCE"
    );

    std::fs::remove_file(&image).unwrap();
    assert_eq!(read_raw(Some(doc.to_str().unwrap()), Some("pic.gif")).0["code"], "IMAGE_NOT_FOUND");

    // Null pointer guards
    assert_eq!(read_raw(None, Some("pic.gif")).0["code"], "INVALID_ARGUMENT");
    assert_eq!(read_raw(Some(doc.to_str().unwrap()), None).0["code"], "INVALID_ARGUMENT");
    let cdoc = CString::new(doc.to_str().unwrap()).unwrap();
    let csrc = CString::new("pic.gif").unwrap();
    let mut len = 99usize;
    let raw_null_data =
      unsafe { vellora_image_read(cdoc.as_ptr(), csrc.as_ptr(), std::ptr::null_mut(), &mut len) };
    let err_null_data: Value =
      serde_json::from_str(unsafe { CStr::from_ptr(raw_null_data) }.to_str().unwrap()).unwrap();
    unsafe { vellora_free(raw_null_data) };
    assert_eq!(len, 0);
    assert_eq!(err_null_data["code"], "INVALID_ARGUMENT");

    std::fs::remove_file(&doc).unwrap();
    std::fs::remove_dir(&root).unwrap();
  }

  #[test]
  fn image_stat_reports_size_and_mtime_without_path() {
    let root = std::env::temp_dir().join(format!(
      "vellora-image-stat-{}-{}",
      std::process::id(),
      std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    std::fs::create_dir(&root).unwrap();
    let doc = root.join("doc.md");
    let image = root.join("pic.png");
    std::fs::write(&doc, "# doc").unwrap();
    std::fs::write(&image, b"123456").unwrap();

    let stat_call = |src: &str| -> Value {
      let cdoc = CString::new(doc.to_str().unwrap()).unwrap();
      let csrc = CString::new(src).unwrap();
      let raw = unsafe { vellora_image_stat(cdoc.as_ptr(), csrc.as_ptr()) };
      let val: Value = serde_json::from_str(unsafe { CStr::from_ptr(raw) }.to_str().unwrap()).unwrap();
      unsafe { vellora_free(raw) };
      val
    };

    let first = stat_call("pic.png");
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(first["size"], 6);
    assert!(!first["modifiedAt"].as_str().unwrap().is_empty());
    assert!(first.get("path").is_none());

    std::fs::write(&image, b"123456789").unwrap();
    let second = stat_call("pic.png");
    assert_eq!(second["ok"], true);
    assert_eq!(second["size"], 9);

    assert_eq!(stat_call("../pic.png")["code"], "UNSUPPORTED_IMAGE_SOURCE");
    std::fs::remove_file(&image).unwrap();
    assert_eq!(stat_call("pic.png")["code"], "IMAGE_NOT_FOUND");
    std::fs::remove_file(&doc).unwrap();
    std::fs::remove_dir(&root).unwrap();
  }
}

#[cfg(test)]
mod length_delimited_tests {
  use super::*;

  fn read_result(raw: *mut c_char) -> Value {
    let result = serde_json::from_str(unsafe { CStr::from_ptr(raw) }.to_str().unwrap()).unwrap();
    unsafe { vellora_free(raw) };
    result
  }

  #[test]
  fn length_delimited_text_keeps_nul_and_rejects_invalid_utf8() {
    let text = "a\0b\n";
    assert_eq!(unsafe { from_c_len(text.as_ptr(), text.len()) }.unwrap(), text);
    assert_eq!(unsafe { from_c_len(std::ptr::null(), 0) }.unwrap(), "");
    assert!(unsafe { from_c_len(std::ptr::null(), 3) }.is_err());
    let invalid = [b'a', 0xff];
    let error = unsafe { from_c_len(invalid.as_ptr(), invalid.len()) }.unwrap_err();
    assert_eq!(error["code"], "INVALID_ARGUMENT");
  }

  #[test]
  fn plan_and_splice_see_text_after_nul() {
    let text = "first\0tail\n\nsecond\n";
    let plan = read_result(unsafe { vellora_plan_n(text.as_ptr(), text.len()) });
    assert_eq!(plan["ok"], true, "{plan}");
    let sources: String = plan["plan"]["blocks"]
      .as_array()
      .unwrap()
      .iter()
      .map(|block| block["source"].as_str().unwrap_or_default())
      .collect();
    assert_eq!(sources, text);

    let edits = CString::new(r#"[{"index":1,"markdown":"changed"}]"#).unwrap();
    let spliced = read_result(unsafe { vellora_splice_text_n(text.as_ptr(), text.len(), edits.as_ptr()) });
    assert_eq!(spliced["ok"], true, "{spliced}");
    assert_eq!(spliced["content"], "first\0tail\n\nchanged\n");
  }

  #[test]
  fn relative_targets_list_each_local_link_and_image_once() {
    let source = [
      "![a](img/a.png) [doc](../other.md) [again](../other.md)",
      "[web](https://example.com) [top](#top) ![drive](C:/p.png) ![root](/r.png)",
      "[mail](mailto:a@b.c)",
      "> - [deep](notes/deep.md \"title\")",
      "| x |\n|---|\n| ![t](t.png) |",
      "<img src=\"html.png\" alt=\"x\">",
      "[ref]",
      "[ref]: refs/r.md\n",
    ]
    .join("\n\n");
    let mut found = super::relative_targets(&source);
    found.sort();
    assert_eq!(found, ["../other.md", "html.png", "img/a.png", "notes/deep.md", "refs/r.md", "t.png"]);
    assert!(super::relative_targets("# Title\n\n[web](https://example.com)\n").is_empty());
  }
}
