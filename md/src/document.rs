//! Original-spelling preservation.
//!
//! The baseline decides what to write back with three structural comparisons
//! (`DocumentEditor.tsx::serialize`):
//!
//! ```text
//! doc == originalDoc -> original bytes
//! doc == savedDoc    -> savedMarkdown
//! otherwise          -> export(doc) with the original document's line endings
//! ```
//!
//! `PreservedMarkdown` reproduces that contract, including the "dirty" rule that
//! keeps a document dirty when the source spelling differs from the saved one
//! even though the tree is structurally identical.

use crate::export::to_markdown;
use crate::model::Document;
use crate::parse::parse;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreservedMarkdown {
  original: String,
  saved: String,
  document: Document,
  original_document: Document,
  saved_document: Document,
}

impl PreservedMarkdown {
  pub fn new(source: &str) -> Self {
    let document = parse(source);
    Self {
      original: source.to_string(),
      saved: source.to_string(),
      original_document: document.clone(),
      saved_document: document.clone(),
      document,
    }
  }

  /// Replaces the content (open, reload, or a source-mode edit).
  pub fn replace(&mut self, source: &str) {
    self.original = source.to_string();
    self.saved = source.to_string();
    self.document = parse(source);
    self.original_document = self.document.clone();
    self.saved_document = self.document.clone();
  }

  pub fn document(&self) -> &Document {
    &self.document
  }

  pub fn document_mut(&mut self) -> &mut Document {
    &mut self.document
  }

  pub fn original(&self) -> &str {
    &self.original
  }

  pub fn saved(&self) -> &str {
    &self.saved
  }

  pub fn line_ending(&self) -> &'static str {
    document_line_ending(&self.original)
  }

  /// Markdown bytes that should be written to disk right now.
  pub fn serialize(&self) -> String {
    if self.document.content_eq(&self.original_document) {
      return self.original.clone();
    }
    if self.document.content_eq(&self.saved_document) {
      return self.saved.clone();
    }
    to_markdown(&self.document, self.line_ending())
  }

  /// Records the bytes that were just written as the new saved baseline.
  pub fn mark_saved(&mut self, written: &str) {
    self.saved = written.to_string();
    self.saved_document = self.document.clone();
  }

  pub fn is_dirty(&self) -> bool {
    !self.document.content_eq(&self.saved_document)
      || (self.original != self.saved && self.document.content_eq(&self.original_document))
  }

  /// Structural change check used by tests and by the undo-to-original path.
  pub fn matches_original(&self) -> bool {
    self.document.content_eq(&self.original_document)
  }

  pub fn matches_saved(&self) -> bool {
    self.document.content_eq(&self.saved_document)
  }
}

pub fn document_line_ending(source: &str) -> &'static str {
  match source.find('\n') {
    Some(index) if index > 0 && source.as_bytes()[index - 1] == b'\r' => "\r\n",
    _ => "\n",
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::model::{Block, Inline, Marks};

  fn first_paragraph_mut(document: &mut Document) -> &mut Vec<Inline> {
    match &mut document.segments[0].block {
      Block::Paragraph(inlines) => inlines,
      other => panic!("expected paragraph, got {other:?}"),
    }
  }

  #[test]
  fn unedited_document_returns_original_bytes() {
    let source = "# Title\r\n\r\nbody  with   odd spacing\r\n";
    let preserved = PreservedMarkdown::new(source);
    assert_eq!(preserved.serialize(), source);
    assert!(!preserved.is_dirty());
    assert_eq!(preserved.line_ending(), "\r\n");
  }

  #[test]
  fn unrelated_edit_keeps_other_segments_byte_identical() {
    let source = "---\ntitle: \"Report\"\n---\n\nfirst *block*\n\n- ordinary\n- [ ] task\n";
    let mut preserved = PreservedMarkdown::new(source);
    let paragraph = preserved
      .document_mut()
      .segments
      .iter_mut()
      .find(|segment| matches!(segment.block, Block::Paragraph(_)))
      .expect("paragraph segment");
    if let Block::Paragraph(inlines) = &mut paragraph.block {
      inlines.push(Inline::Text { text: "!".into(), marks: Marks::default() });
    }
    paragraph.mark_dirty();

    let written = preserved.serialize();
    assert!(written.starts_with("---\ntitle: \"Report\"\n---\n\n"), "{written}");
    assert!(written.contains("- [ ] task"), "task list bytes must survive: {written}");
    assert!(written.contains("first *block*!"), "{written}");
    assert!(preserved.is_dirty());
  }

  #[test]
  fn undo_to_original_returns_original_spelling_even_after_a_source_style_edit() {
    let source = "hello   world\n";
    let mut preserved = PreservedMarkdown::new(source);
    first_paragraph_mut(preserved.document_mut())
      .push(Inline::Text { text: "!".into(), marks: Marks::default() });
    assert_ne!(preserved.serialize(), source);

    // Undo restores the parsed structure of the original bytes.
    preserved.document_mut().segments[0].block = parse(source).segments[0].block.clone();
    assert_eq!(preserved.serialize(), source);
    assert!(!preserved.is_dirty());
  }

  #[test]
  fn save_then_undo_restores_the_saved_spelling() {
    let source = "alpha\n";
    let mut preserved = PreservedMarkdown::new(source);
    first_paragraph_mut(preserved.document_mut())
      .push(Inline::Text { text: " beta".into(), marks: Marks::default() });
    let written = preserved.serialize();
    assert_eq!(written, "alpha beta");
    preserved.mark_saved(&written);
    assert!(!preserved.is_dirty());

    first_paragraph_mut(preserved.document_mut())
      .push(Inline::Text { text: " gamma".into(), marks: Marks::default() });
    assert!(preserved.is_dirty());
    // Undo back to the saved structure returns the saved bytes, not a re-export.
    preserved.document_mut().segments[0].block = parse(&written).segments[0].block.clone();
    assert_eq!(preserved.serialize(), written);
    assert!(!preserved.is_dirty());
  }

  #[test]
  fn source_equivalent_spelling_change_is_reported_dirty_until_saved() {
    let source = "a   b\n";
    let mut preserved = PreservedMarkdown::new(source);
    preserved.replace("a b\n");
    // The tree matches the new original, so nothing is dirty.
    assert!(!preserved.is_dirty());
    assert_eq!(preserved.serialize(), "a b\n");

    // A re-parse of the *old* spelling is structurally equal, so the baseline
    // reports the latest source spelling rather than a re-serialization.
    let mut replay = PreservedMarkdown::new("a b\n");
    replay.replace("a   b\n");
    assert_eq!(replay.serialize(), "a   b\n");
  }
}
