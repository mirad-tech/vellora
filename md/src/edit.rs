//! Neutral text operations used by the golden scenarios and by the editor.
//!
//! The scenarios describe user intent ("caret at end of the document, type"),
//! never an engine-internal position. These helpers implement that intent on the
//! neutral model so the same operation can be replayed against the baseline
//! golden bytes.

use crate::model::{Block, Document, Inline, Marks, Segment};
use std::{ops::Range, sync::{Arc, Mutex}};

/// Appends `text` at the end of the last editable block, inheriting the marks of
/// the character it follows (typing at the caret).
pub fn append_at_end(document: &mut Document, text: &str) -> bool {
  for index in (0..document.segments.len()).rev() {
    let segment = &mut document.segments[index];
    if append_into_block(&mut segment.block, text) {
      segment.mark_dirty();
      return true;
    }
  }
  false
}

/// Inserts `text` at the start of the first editable block.
pub fn insert_at_start(document: &mut Document, text: &str) -> bool {
  for index in 0..document.segments.len() {
    let segment = &mut document.segments[index];
    if insert_into_block(&mut segment.block, text) {
      segment.mark_dirty();
      return true;
    }
  }
  false
}

fn append_into_block(block: &mut Block, text: &str) -> bool {
  match block {
    Block::Paragraph(inlines) | Block::Heading { content: inlines, .. } => {
      append_inline(inlines, text)
    }
    Block::CodeBlock { text: body, .. } => {
      // Fenced code bodies carry a structural trailing newline; typing at the end
      // of the block lands before it.
      match body.strip_suffix('\n') {
        Some(head) => {
          body.truncate(head.len());
          body.push_str(text);
          body.push('\n');
        }
        None => body.push_str(text),
      }
      true
    }
    Block::BlockQuote(blocks) => blocks.iter_mut().rev().any(|child| append_into_block(child, text)),
    Block::List(list) => list
      .items
      .iter_mut()
      .rev()
      .any(|item| item.iter_mut().rev().any(|child| append_into_block(child, text))),
    Block::Table(table) => {
      if let Some(row) = table.rows.last_mut() {
        if let Some(cell) = row.last_mut() {
          return append_inline(cell, text);
        }
      }
      if let Some(cell) = table.header.last_mut() {
        return append_inline(cell, text);
      }
      false
    }
    Block::RawSource(source) => {
      source.push_str(text);
      true
    }
    Block::HorizontalRule => false,
  }
}

fn insert_into_block(block: &mut Block, text: &str) -> bool {
  match block {
    Block::Paragraph(inlines) | Block::Heading { content: inlines, .. } => {
      prepend_inline(inlines, text)
    }
    Block::CodeBlock { text: body, .. } => {
      body.insert_str(0, text);
      true
    }
    Block::BlockQuote(blocks) => blocks.iter_mut().any(|child| insert_into_block(child, text)),
    Block::List(list) => list
      .items
      .iter_mut()
      .any(|item| item.iter_mut().any(|child| insert_into_block(child, text))),
    Block::Table(table) => {
      if let Some(cell) = table.header.first_mut() {
        return prepend_inline(cell, text);
      }
      if let Some(row) = table.rows.first_mut() {
        if let Some(cell) = row.first_mut() {
          return prepend_inline(cell, text);
        }
      }
      false
    }
    Block::RawSource(source) => {
      source.insert_str(0, text);
      true
    }
    Block::HorizontalRule => false,
  }
}

fn append_inline(inlines: &mut Vec<Inline>, text: &str) -> bool {
  super::model::push_text(inlines, text, &last_marks(inlines));
  !inlines.is_empty()
}

fn prepend_inline(inlines: &mut Vec<Inline>, text: &str) -> bool {
  match inlines.first_mut() {
    Some(Inline::Text { text: first, .. }) => {
      first.insert_str(0, text);
      true
    }
    Some(Inline::Code { marks, .. }) => {
      let marks = marks.clone();
      inlines.insert(0, Inline::Text { text: text.to_string(), marks });
      true
    }
    _ => {
      inlines.insert(0, Inline::Text { text: text.to_string(), marks: Marks::default() });
      true
    }
  }
}

fn last_marks(inlines: &[Inline]) -> Marks {
  match inlines.last() {
    Some(Inline::Text { marks, .. })
    | Some(Inline::Code { marks, .. })
    | Some(Inline::HardBreak { marks })
    | Some(Inline::SoftBreak { marks })
    | Some(Inline::Image { marks, .. }) => marks.clone(),
    None => Marks::default(),
  }
}

/// Builds a segment for a block that did not exist in the source (Enter / paste).
pub fn synthetic_segment(block: Block) -> Segment {
  Segment::synthetic(block)
}

/// Replaces one top-level segment with the blocks parsed from `markdown`,
/// leaving every other segment's retained source bytes untouched.
///
/// The replacements are marked dirty so the exporter writes them with canonical
/// separators instead of trying to reuse the old block's trailing blank lines.
pub fn replace_segment(document: &mut Document, index: usize, markdown: &str) -> bool {
  if index >= document.segments.len() {
    return false;
  }
  if markdown.is_empty() {
    document.segments.remove(index);
    return true;
  }
  if document.segments[index].source == markdown {
    return true;
  }
  let normalized = markdown.replace("\r\n", "\n");
  let parsed = crate::parse(&normalized);
  if parsed.segments.is_empty() {
    return false;
  }
  let mut replacements = parsed.segments;
  for segment in &mut replacements {
    segment.mark_dirty();
  }
  document.segments.splice(index..=index, replacements);
  true
}

/// Applies `(segment index, markdown)` edits from the highest index down so the
/// earlier indices stay valid. Returns the number of edits applied.
pub fn apply_edits(document: &mut Document, edits: &[(usize, String)]) -> usize {
  apply_edits_checked(document, edits).unwrap_or(0)
}

/// Validates the complete batch before changing anything. Indices refer to the
/// same input document, and each segment may occur only once.
pub fn apply_edits_checked(document: &mut Document, edits: &[(usize, String)]) -> Result<usize, &'static str> {
  validate_edits(document, edits)?;
  let mut ordered: Vec<_> = edits.iter().collect();
  ordered.sort_by(|a, b| b.0.cmp(&a.0));
  for (index, markdown) in ordered {
    replace_segment(document, *index, markdown);
  }
  Ok(edits.len())
}

fn validate_edits(document: &Document, edits: &[(usize, String)]) -> Result<(), &'static str> {
  validate_indices(document.segments.len(), edits)
}

fn validate_indices(segment_count: usize, edits: &[(usize, String)]) -> Result<(), &'static str> {
  let mut seen = std::collections::HashSet::new();
  for (index, _) in edits {
    if *index >= segment_count {
      return Err("segment index is out of range");
    }
    if !seen.insert(*index) {
      return Err("duplicate segment index");
    }
  }
  Ok(())
}

// This is a memoized pure parser result, not a document/session state. A hit
// requires every source byte to match; no path, hash, or caller-supplied range
// can authorize reuse. One entry holds at most 8 MiB source + 8 MiB ranges.
const SPLICE_CACHE_SOURCE_LIMIT: usize = 8 * 1024 * 1024;
const SPLICE_CACHE_RANGE_LIMIT: usize = 8 * 1024 * 1024;
struct SpliceSource {
  source: Box<str>,
  ranges: Box<[Range<usize>]>,
}
static SPLICE_SOURCE_CACHE: Mutex<Option<Arc<SpliceSource>>> = Mutex::new(None);

fn splice_source(source: &str, cache: &Mutex<Option<Arc<SpliceSource>>>) -> Result<Arc<SpliceSource>, &'static str> {
  let cacheable_source = source.len() <= SPLICE_CACHE_SOURCE_LIMIT;
  if cacheable_source {
    let guard = cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(entry) = guard.as_ref().filter(|entry| entry.source.as_ref() == source) {
      return Ok(Arc::clone(entry));
    }
  }
  // Parse outside the mutex. Concurrent calls own their immutable snapshots,
  // so a later cache replacement never changes the ranges used by this call.
  let document = crate::parse(source);
  let mut ranges = Vec::with_capacity(document.segments.len());
  let mut offset: usize = 0;
  for segment in &document.segments {
    let end = offset.checked_add(segment.source.len()).ok_or("invalid source boundary")?;
    if source.get(offset..end) != Some(segment.source.as_str()) {
      return Err("parsed source boundaries do not match input");
    }
    ranges.push(offset..end);
    offset = end;
  }
  if offset != source.len() { return Err("parsed source boundaries do not cover input"); }
  let entry = Arc::new(SpliceSource { source: source.into(), ranges: ranges.into_boxed_slice() });
  if cacheable_source && entry.ranges.len() <= SPLICE_CACHE_RANGE_LIMIT / std::mem::size_of::<Range<usize>>() {
    *cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::clone(&entry));
  }
  Ok(entry)
}

/// Splices caller-authored Markdown without a lossy AST export. Existing segment
/// boundaries (including an absent final newline) belong to the original file.
pub fn splice_markdown(source: &str, edits: &[(usize, String)]) -> Result<String, &'static str> {
  if edits.is_empty() { return Ok(source.to_string()); }
  let snapshot = splice_source(source, &SPLICE_SOURCE_CACHE)?;
  validate_indices(snapshot.ranges.len(), edits)?;
  let replacements: std::collections::HashMap<_, _> = edits.iter().map(|(index, text)| (*index, text)).collect();
  let ending = crate::document_line_ending(source);
  let mut output = String::with_capacity(source.len());
  for (index, range) in snapshot.ranges.iter().enumerate() {
    let original = &snapshot.source[range.clone()];
    if let Some(text) = replacements.get(&index) {
      if text.is_empty() { continue; }
      if text.as_str() == original { output.push_str(text); continue; }
      let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
      let body = normalized.trim_end_matches('\n');
      output.push_str(&body.replace('\n', ending));
      let suffix_start = original.trim_end_matches([' ', '\t', '\r', '\n']).len();
      let suffix = &original[suffix_start..];
      if let Some(newline) = suffix.find(['\r', '\n']) {
        output.push_str(&suffix[newline..]);
      } else if index + 1 < snapshot.ranges.len() {
        output.push_str(ending); output.push_str(ending);
      }
    } else { output.push_str(original); }
  }
  Ok(output)
}

#[cfg(test)]
mod splice_cache_tests {
  use super::*;
  #[test]
  fn exact_source_cache_never_reuses_other_sources_and_snapshots_survive_replacement() {
    let cache = Mutex::new(None);
    let a = splice_source("# one\n\nbody\n", &cache).unwrap();
    let again = splice_source("# one\n\nbody\n", &cache).unwrap();
    assert!(Arc::ptr_eq(&a, &again));
    let b = splice_source("# two\n\nbody\n", &cache).unwrap();
    assert!(!Arc::ptr_eq(&a, &b)); // same byte length is not a valid cache key
    assert_eq!(&a.source[a.ranges[0].clone()], "# one\n\n");
    assert_eq!(&b.source[b.ranges[0].clone()], "# two\n\n");
    assert!(!Arc::ptr_eq(&a, &splice_source(&a.source, &cache).unwrap()));
  }

  #[test]
  fn oversized_source_is_not_retained_in_cache() {
    let cache = Mutex::new(None);
    let small = splice_source("small", &cache).unwrap();
    let large = "x".repeat(SPLICE_CACHE_SOURCE_LIMIT + 1);
    let parsed = splice_source(&large, &cache).unwrap();
    assert_eq!(&*parsed.source, large);
    assert!(Arc::ptr_eq(&small, cache.lock().unwrap().as_ref().unwrap()));
  }

  #[test]
  fn interleaved_and_threaded_sources_keep_unicode_crlf_and_atomic_validation() {
    let sources = ["# 中文😀\r\n\r\nbody\r\n", "different\n\nlast", "", "é\r\n"];
    std::thread::scope(|scope| {
      for source in sources {
        scope.spawn(move || {
          for _ in 0..20 {
            let edit = vec![(0, "changed😀".to_string())];
            let first = splice_markdown(source, &edit).unwrap();
            assert!(splice_markdown(source, &[(0,"x".into()),(999,"y".into())]).is_err());
            assert!(splice_markdown(source, &[(0,"x".into()),(0,"y".into())]).is_err());
            assert_eq!(splice_markdown(source, &edit).unwrap(), first);
            assert_eq!(splice_markdown(source, &[]).unwrap(), source);
            assert!(first.starts_with("changed😀"));
            if source.ends_with("\r\n") { assert!(first.ends_with("\r\n")); }
          }
        });
      }
    });
  }
}
