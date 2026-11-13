//! C ABI bridge for the Qt shell.
//!
//! Every function returns a heap-allocated UTF-8 JSON string that the caller
//! must release with [`vellora_free`]. The Qt layer renders from this neutral
//! plan; it never parses Markdown or touches the filesystem itself, so the same
//! path, size and protocol rules apply as in the tested core.

use std::ffi::{c_char, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};

use serde_json::{json, Value};
use vellora_core::session::{self, SessionState};
use vellora_core::types::{CommandResult, LinkInspectData, MarkdownDocument};
use vellora_core::{file_access, image_access, link_access};
use vellora_md::{Alignment, Block, Document, Inline, Marks, PreservedMarkdown, Table};

static SESSION: std::sync::OnceLock<SessionState> = std::sync::OnceLock::new();

fn state() -> &'static SessionState {
  SESSION.get_or_init(SessionState::default)
}

fn into_c_string(value: Value) -> *mut c_char {
  let text = value.to_string();
  let sanitized = text.replace('\0', "");
  CString::new(sanitized).map(CString::into_raw).unwrap_or(std::ptr::null_mut())
}

unsafe fn from_c(value: *const c_char) -> String {
  if value.is_null() {
    return String::new();
  }
  CStr::from_ptr(value).to_string_lossy().into_owned()
}

fn error_json(code: &str, message: &str) -> Value {
  json!({ "ok": false, "code": code, "message": message })
}

fn command_error(result: &CommandResult<impl serde::Serialize>) -> Value {
  match result {
    CommandResult::Err { code, message, .. } => error_json(code, message),
    CommandResult::Ok { .. } => error_json("UNEXPECTED", "unexpected success payload"),
  }
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

fn document_json(document: &Document) -> Value {
  let mut segments = Vec::new();
  for segment in &document.segments {
    segments.push(json!({
      "block": block_json(&segment.block),
      "dirty": segment.dirty,
    }));
  }
  json!({ "segments": segments })
}

fn plan_json(document: &Document) -> Value {
  let source: String = document.segments.iter().map(|s| s.source.as_str()).collect();
  let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
  let previews = document.segments.iter().any(|s| matches!(s.block, Block::RawSource(_)))
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
          for block in &preview.blocks { collect_outline_headings(block, &mut headings); }
          map.insert("preview".to_string(), json!({ "blocks": blocks_json(&preview.blocks), "limited": preview.limited }));
        }
      }
      if !matches!(segment.block, Block::RawSource(_)) { collect_outline_headings(&segment.block, &mut headings); }
      let offsets = if headings.is_empty() { Vec::new() } else { vellora_md::outline::heading_offsets(&segment_source) };
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
  let outline: Vec<_> = outline_items.into_iter().map(|(level, text, offset)| {
    if offset >= previous { utf16 += normalized[previous..offset].encode_utf16().count(); }
    else { utf16 = normalized[..offset].encode_utf16().count(); }
    previous = offset;
    json!({ "level": level, "text": text, "sourceOffset": utf16 })
  }).collect();
  json!({ "blocks": blocks, "outline": outline })
}

fn collect_outline_headings(block: &Block, result: &mut Vec<(u8, String)>) {
  match block {
    Block::Heading { level, .. } => result.push((*level, block.plain_text().trim().to_string())),
    Block::BlockQuote(children) => { for child in children { collect_outline_headings(child, result); } }
    Block::List(list) => { for item in &list.items { for child in item { collect_outline_headings(child, result); } } }
    _ => {}
  }
}

fn document_payload(document: &MarkdownDocument, content: &str) -> Value {
  let preserved = PreservedMarkdown::new(content);
  let plan = plan_json(preserved.document());
  json!({
    "ok": true,
    "document": {
      "path": document.path,
      "name": document.name,
      "content": content,
      "modifiedAt": document.modified_at,
      "size": document.size,
    },
    "plan": plan,
    "lineEnding": preserved.line_ending(),
  })
}

#[no_mangle]
pub extern "C" fn vellora_version() -> *mut c_char {
  into_c_string(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }))
}

#[no_mangle]
pub extern "C" fn vellora_free(pointer: *mut c_char) {
  if pointer.is_null() {
    return;
  }
  unsafe {
    drop(CString::from_raw(pointer));
  }
}

/// Opens a Markdown file and returns `{ok, document, plan, lineEnding}`.
#[no_mangle]
pub extern "C" fn vellora_open(path: *const c_char) -> *mut c_char {
  let path = unsafe { from_c(path) };
  let guarded = catch_unwind(AssertUnwindSafe(|| {
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
  }));
  into_c_string(guarded.unwrap_or_else(|_| error_json("PANIC", "native bridge failed")))
}

fn document_line_ending(source: &str) -> &'static str {
  match source.find('\n') {
    Some(index) if index > 0 && source.as_bytes()[index - 1] == b'\r' => "\r\n",
    _ => "\n",
  }
}

/// Renders Markdown bytes into the neutral plan without touching the session.
#[no_mangle]
pub extern "C" fn vellora_plan(content: *const c_char) -> *mut c_char {
  let content = unsafe { from_c(content) };
  let guarded = catch_unwind(AssertUnwindSafe(|| {
    let preserved = PreservedMarkdown::new(&content);
    json!({ "ok": true, "plan": plan_json(preserved.document()) })
  }));
  into_c_string(guarded.unwrap_or_else(|_| error_json("PANIC", "native bridge failed")))
}

/// Saves through the session; `token` may be empty for a first attempt.
#[no_mangle]
pub extern "C" fn vellora_save(
  path: *const c_char,
  content: *const c_char,
  token: *const c_char,
) -> *mut c_char {
  let path = unsafe { from_c(path) };
  let content = unsafe { from_c(content) };
  let token = unsafe { from_c(token) };
  let token = if token.is_empty() { None } else { Some(token) };
  let guarded = catch_unwind(AssertUnwindSafe(|| {
    match session::save_document_session(state(), &path, &content, token.as_deref()) {
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
  }));
  into_c_string(guarded.unwrap_or_else(|_| error_json("PANIC", "native bridge failed")))
}

/// Pure splice: indices belong to the explicitly supplied draft, never global
/// session state. A failed batch has no side effects and a retry is deterministic.
#[no_mangle]
pub extern "C" fn vellora_splice(content: *const c_char, edits: *const c_char) -> *mut c_char {
  let content = unsafe { from_c(content) };
  let raw = unsafe { from_c(edits) };
  let guarded = catch_unwind(AssertUnwindSafe(|| splice_json(&content, &raw)));
  into_c_string(guarded.unwrap_or_else(|_| error_json("PANIC", "native bridge failed")))
}

/// Text-only pure splice for editor draft collection. The validation and source
/// preservation contract is identical to vellora_splice; no render plan is built.
#[no_mangle]
pub extern "C" fn vellora_splice_text(content: *const c_char, edits: *const c_char) -> *mut c_char {
  let content = unsafe { from_c(content) };
  let raw = unsafe { from_c(edits) };
  let guarded = catch_unwind(AssertUnwindSafe(|| splice_json_impl(&content, &raw, false)));
  into_c_string(guarded.unwrap_or_else(|_| error_json("PANIC", "native bridge failed")))
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
#[no_mangle]
pub extern "C" fn vellora_image(document_path: *const c_char, src: *const c_char) -> *mut c_char {
  let document_path = unsafe { from_c(document_path) };
  let src = unsafe { from_c(src) };
  let guarded = catch_unwind(AssertUnwindSafe(|| {
    match image_access::read_local_image(&document_path, &src, None) {
      CommandResult::Ok { data, .. } => json!({
        "ok": true,
        "path": data.path.to_string_lossy(),
        "mime": data.mime,
        "bytes": data.bytes.len(),
      }),
      CommandResult::Err { code, message, .. } => error_json(&code, &message),
    }
  }));
  into_c_string(guarded.unwrap_or_else(|_| error_json("PANIC", "native bridge failed")))
}

/// Reads validated owned image bytes. Decoders must consume dataUrl bytes rather
/// than reopening a pathname returned by the legacy metadata endpoint.
#[no_mangle]
pub extern "C" fn vellora_image_bytes(document_path: *const c_char, src: *const c_char) -> *mut c_char {
  let document_path = unsafe { from_c(document_path) };
  let src = unsafe { from_c(src) };
  let guarded = catch_unwind(AssertUnwindSafe(|| {
    match image_access::resolve_local_image(&document_path, &src, None) {
      CommandResult::Ok { data, .. } => json!({ "ok": true, "mime": data.mime, "dataUrl": data.src }),
      CommandResult::Err { code, message, .. } => error_json(&code, &message),
    }
  }));
  into_c_string(guarded.unwrap_or_else(|_| error_json("PANIC", "native bridge failed")))
}

/// Link inspection: relative Markdown or an external http(s) URL.
#[no_mangle]
pub extern "C" fn vellora_inspect_link(
  document_path: *const c_char,
  href: *const c_char,
) -> *mut c_char {
  let document_path = unsafe { from_c(document_path) };
  let href = unsafe { from_c(href) };
  let guarded = catch_unwind(AssertUnwindSafe(|| {
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
  }));
  into_c_string(guarded.unwrap_or_else(|_| error_json("PANIC", "native bridge failed")))
}

/// Opens a local Markdown link, switching the session on success.
#[no_mangle]
pub extern "C" fn vellora_open_link(
  document_path: *const c_char,
  href: *const c_char,
) -> *mut c_char {
  let document_path = unsafe { from_c(document_path) };
  let href = unsafe { from_c(href) };
  let guarded = catch_unwind(AssertUnwindSafe(|| {
    match session::open_link_session(state(), &document_path, &href) {
      CommandResult::Ok { data, .. } => {
        let preserved = PreservedMarkdown::new(&data.document.content);
        let plan = plan_json(preserved.document());
        json!({ "ok": true, "document": data.document, "plan": plan,
          "lineEnding": document_line_ending(&data.document.content) })
      }
      CommandResult::Err { code, message, .. } => error_json(&code, &message),
    }
  }));
  into_c_string(guarded.unwrap_or_else(|_| error_json("PANIC", "native bridge failed")))
}

/// Opens an HTTP(S) URL after the caller has confirmed.
#[no_mangle]
pub extern "C" fn vellora_open_external(url: *const c_char) -> *mut c_char {
  let url = unsafe { from_c(url) };
  let guarded = catch_unwind(AssertUnwindSafe(|| {
    let result = link_access::open_external_url(&url, |target| {
      std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", target])
        .spawn()
        .map(|_| ())
    });
    match result {
      CommandResult::Ok { .. } => json!({ "ok": true }),
      CommandResult::Err { code, message, .. } => error_json(&code, &message),
    }
  }));
  into_c_string(guarded.unwrap_or_else(|_| error_json("PANIC", "native bridge failed")))
}

/// Reports whether the current session still matches `path`.
#[no_mangle]
pub extern "C" fn vellora_session_matches(path: *const c_char) -> *mut c_char {
  let path = unsafe { from_c(path) };
  let matches = session::require_session_document(state(), &path).is_ok();
  into_c_string(json!({ "ok": true, "matches": matches }))
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
    for source in ["[id]: https://example.com/ \"title\"\n", "<!-- note -->\n", "<!-- first\nsecond -->\n\n[id]: /path\n"] {
      let plan = plan_json(&vellora_md::parse(source));
      for block in plan["blocks"].as_array().unwrap() {
        assert_eq!(block["hidden"], true, "{source}: {plan}");
        assert!(block["source"].as_str().is_some());
      }
    }
    for source in ["<script>hidden by sanitization</script>\n", "<!-- unclosed", "---\ntitle: metadata\n---\n", "<unknown>content</unknown>\n"] {
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
    for (index, (marker, level, title)) in [("# **", 1, "repeated"), ("## [", 2, "nested"), ("<h3>", 3, "HTML😀"), ("<h4>", 4, "last")].iter().enumerate() {
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
    let html = blocks.iter().find(|b| b["text"].as_str().is_some_and(|text| text.starts_with("<div>"))).unwrap();
    assert_eq!(html["preview"]["blocks"][0]["level"], 2);
    assert_eq!(html["preview"]["blocks"][1]["text"], "copy me");
    assert!(html["preview"]["blocks"][0].get("source").is_none());
  }

  #[test]
  fn image_resolution_rejects_traversal() {
    let path = std::ffi::CString::new("C:/notes/a.md").unwrap();
    let src = std::ffi::CString::new("../secret.png").unwrap();
    let raw = vellora_image(path.as_ptr(), src.as_ptr());
    let text = unsafe { CStr::from_ptr(raw).to_string_lossy().into_owned() };
    unsafe { vellora_free(raw) };
    assert!(text.contains("UNSUPPORTED_IMAGE_SOURCE"), "{text}");
  }
}

#[cfg(test)]
mod splice_tests {
  use super::*;

  fn splice(source: &str, edits: Value) -> Value {
    let source = CString::new(source).unwrap();
    let edits = CString::new(edits.to_string()).unwrap();
    let raw = vellora_splice(source.as_ptr(), edits.as_ptr());
    let value = serde_json::from_str(unsafe { CStr::from_ptr(raw) }.to_str().unwrap()).unwrap();
    vellora_free(raw);
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
    for edits in [json!({}), json!([{}]), json!([{"index":0}]),
      json!([{"index":-1,"markdown":"x"}]), json!([{"index":0.5,"markdown":"x"}]),
      json!([{"index":0,"markdown":null}]),
      json!([{"index":0,"markdown":"x"},{"index":9,"markdown":"y"}]),
      json!([{"index":0,"markdown":"x"},{"index":0,"markdown":"y"}])] {
      let result = splice("original\n", edits);
      assert_eq!(result["ok"], false, "{result}");
      assert_eq!(result["code"], "BAD_EDITS");
    }
    assert_eq!(splice("original\n", json!([]))["content"], "original\n");
  }

  #[test]
  fn empty_edits_and_source_spelling_are_byte_exact() {
    for source in ["", "\n\n", "\r\na\r\n\r\nb\n", "[ref]: https://example.com\r\n", "<script>alert(1)</script>\n"] {
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
    vellora_free(raw);
    result
  }

  #[test]
  fn source_draft_splice_save_reopen_uses_current_bytes() {
    let filename = format!("vellora-splice-test-{}-{}.md", std::process::id(),
      std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
    let path = std::env::temp_dir().join(filename);
    std::fs::write(&path, "original\n\ntail\n").unwrap();
    let cpath = CString::new(path.to_str().unwrap()).unwrap();
    let opened = read_result(vellora_open(cpath.as_ptr()));
    assert_eq!(opened["ok"], true);
    let cpath = CString::new(opened["document"]["path"].as_str().unwrap()).unwrap();
    let draft = "source first\r\n\r\ninserted\r\n\r\nsource tail\n";
    let result = splice_json(draft, r#"[{"index":1,"markdown":"edited"}]"#);
    let expected = "source first\r\n\r\nedited\r\n\r\nsource tail\n";
    assert_eq!(result["content"], expected);
    let content = CString::new(expected).unwrap();
    let empty = CString::new("").unwrap();
    let saved = read_result(vellora_save(cpath.as_ptr(), content.as_ptr(), empty.as_ptr()));
    assert_eq!(saved["ok"], true, "{saved}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), expected);
    let reopened = read_result(vellora_open(cpath.as_ptr()));
    assert_eq!(reopened["document"]["content"], expected);
    assert_eq!(reopened["plan"], result["plan"]);
    let linked = path.with_extension("linked.md");
    std::fs::write(&linked, "linked\r\n\r\nbody\r\n").unwrap();
    let href = CString::new(linked.file_name().unwrap().to_str().unwrap()).unwrap();
    let followed = read_result(vellora_open_link(cpath.as_ptr(), href.as_ptr()));
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
      for edits in ["[]", r#"[{"index":0,"markdown":"changed"}]"#, r#"[{"index":0,"markdown":""}]"#, r#"[{"index":99,"markdown":"x"}]"#, r#"[{"index":0,"markdown":"x"},{"index":0,"markdown":"y"}]"#, "{}", r#"[{"index":-1,"markdown":2}]"#] {
        let source_c = std::ffi::CString::new(source).unwrap();
        let edits_c = std::ffi::CString::new(edits).unwrap();
        let pointer = vellora_splice_text(source_c.as_ptr(), edits_c.as_ptr());
        let text: Value = serde_json::from_str(unsafe { std::ffi::CStr::from_ptr(pointer) }.to_str().unwrap()).unwrap();
        vellora_free(pointer);
        let mut full = splice_json(source, edits);
        full.as_object_mut().unwrap().remove("plan");
        assert_eq!(text, full, "source={source:?} edits={edits}");
      }
    }
  }
}

#[cfg(test)]
mod image_bytes_tests {
  use super::*;
  fn read(path: &str, src: &str) -> Value {
    let path = CString::new(path).unwrap();
    let src = CString::new(src).unwrap();
    let pointer = vellora_image_bytes(path.as_ptr(), src.as_ptr());
    let value = serde_json::from_str(unsafe { CStr::from_ptr(pointer) }.to_str().unwrap()).unwrap();
    vellora_free(pointer);
    value
  }
  #[test]
  fn image_endpoint_returns_owned_bytes_and_revalidates_each_request() {
    let root = std::env::temp_dir().join(format!("vellora-image-bytes-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    std::fs::create_dir(&root).unwrap();
    let doc = root.join("doc.md");
    let image = root.join("pic.gif");
    std::fs::write(&doc, "# doc").unwrap();
    std::fs::write(&image, b"GIF89a").unwrap();
    let first = read(doc.to_str().unwrap(), "pic.gif");
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(first["mime"], "image/gif");
    assert_eq!(first["dataUrl"], "data:image/gif;base64,R0lGODlh");
    assert!(first.get("path").is_none());
    std::fs::File::create(&image).unwrap().set_len(image_access::DEFAULT_MAX_MARKDOWN_IMAGE_BYTES + 1).unwrap();
    assert_eq!(read(doc.to_str().unwrap(), "pic.gif")["code"], "IMAGE_TOO_LARGE");
    assert_eq!(read(doc.to_str().unwrap(), "../pic.gif")["code"], "UNSUPPORTED_IMAGE_SOURCE");
    assert_eq!(read(doc.to_str().unwrap(), "https://example.com/pic.gif")["code"], "UNSUPPORTED_IMAGE_SOURCE");
    std::fs::remove_file(&image).unwrap();
    assert_eq!(read(doc.to_str().unwrap(), "pic.gif")["code"], "IMAGE_NOT_FOUND");
    std::fs::remove_file(&doc).unwrap();
    std::fs::remove_dir(&root).unwrap();
  }
}
