//! Neutral document model shared by the native view and the Markdown exporter.
//!
//! Two layers of fidelity are kept:
//!
//! 1. `Segment::source` holds the exact original bytes of every untouched
//!    top-level block (including the blank lines that separate it from the next
//!    block). Concatenating all sources reproduces the opened file byte for byte,
//!    so an unrelated edit cannot rewrite untouched constructs.
//! 2. `Block` is the structured form used for rendering, editing, search and
//!    outline. Only segments that actually changed are re-serialized.
//!
//! `RawSource` is the escape hatch the baseline already used: a construct the
//! model cannot represent (HTML, reference definitions, frontmatter)
//! keeps its source bytes instead of being silently flattened.

#[derive(Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct Document {
  pub segments: Vec<Segment>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Segment {
  pub block: Block,
  /// Exact original source bytes for this segment, including trailing blank
  /// lines up to the next segment. Empty when the segment was created by editing.
  pub source: String,
  /// True when the structured block no longer matches `source`.
  pub dirty: bool,
  /// Hash of `block` at the moment `source` was captured. Export uses it to
  /// detect a mutation that forgot to set `dirty`, so an edit can never be
  /// dropped silently in favour of stale source bytes.
  digest: u64,
}

impl Segment {
  pub fn new(block: Block, source: String) -> Self {
    let digest = block_digest(&block);
    Self { block, source, dirty: false, digest }
  }

  pub fn synthetic(block: Block) -> Self {
    let digest = block_digest(&block);
    Self { block, source: String::new(), dirty: true, digest }
  }

  pub fn mark_dirty(&mut self) {
    self.dirty = true;
  }

  /// True when the retained source still describes this segment exactly.
  pub fn source_is_current(&self) -> bool {
    !self.dirty && !self.source.is_empty() && self.digest == block_digest(&self.block)
  }

  /// Re-baselines the digest after a caller intentionally reset `dirty`.
  pub fn refresh_digest(&mut self) {
    self.digest = block_digest(&self.block);
  }
}

pub fn block_digest(block: &Block) -> u64 {
  use std::hash::{Hash, Hasher};
  let mut hasher = std::collections::hash_map::DefaultHasher::new();
  block.hash(&mut hasher);
  hasher.finish()
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Block {
  Paragraph(Vec<Inline>),
  Heading { level: u8, content: Vec<Inline> },
  BlockQuote(Vec<Block>),
  List(List),
  Table(Table),
  CodeBlock { language: Option<String>, text: String },
  HorizontalRule,
  /// Verbatim Markdown retained because the model cannot represent it.
  RawSource(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct List {
  pub ordered: bool,
  pub start: u64,
  /// `)` or `.`; preserved so `9)` does not silently become `9.`.
  pub delimiter: char,
  pub items: Vec<Vec<Block>>,
  /// Aligned with items: ordinary item, unchecked task, or checked task.
  pub tasks: Vec<Option<bool>>,
  /// Preserve paragraph-separated item layout when a list is edited.
  pub loose: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Alignment {
  None,
  Left,
  Center,
  Right,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Table {
  /// Preview-only HTML cell spans, in authored cell order, header then body rows.
  /// Empty for Markdown tables. Never used to regenerate the retained raw source.
  pub spans: Vec<Vec<(usize, usize)>>,
  /// Preview-only authored th/td and scope, in the same cell order as spans.
  /// Empty for Markdown tables, whose first row is always a column header.
  pub cell_headers: Vec<Vec<CellHeader>>,
  pub header_is_body: bool,
  pub align: Vec<Alignment>,
  pub header: Vec<Vec<Inline>>,
  pub rows: Vec<Vec<Vec<Inline>>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct CellHeader {
  pub header: bool,
  pub scope: HeaderScope,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HeaderScope { Auto, Row, Column, RowGroup, ColumnGroup, Unknown }

impl HeaderScope {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Auto => "auto", Self::Row => "row", Self::Column => "col",
      Self::RowGroup => "rowgroup", Self::ColumnGroup => "colgroup", Self::Unknown => "unknown",
    }
  }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct Marks {
  pub bold: bool,
  pub italic: bool,
  pub strike: bool,
  pub link: Option<Link>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Link {
  pub href: String,
  pub title: Option<String>,
  /// Authored reference syntax, not part of the resolved link's semantics.
  pub reference: Option<Reference>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Reference {
  pub kind: ReferenceKind,
  pub label: String,
  pub text_source: String,
  /// Identifies one occurrence, shared by all differently formatted child runs.
  pub source_id: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ReferenceKind { Full, Collapsed, Shortcut }

impl ReferenceKind {
  pub fn as_str(self) -> &'static str {
    match self { Self::Full => "full", Self::Collapsed => "collapsed", Self::Shortcut => "shortcut" }
  }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ImageAltSource {
  pub source: String,
  pub original: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Inline {
  Text { text: String, marks: Marks },
  Code { text: String, marks: Marks },
  HardBreak { marks: Marks },
  SoftBreak { marks: Marks },
  Image { src: String, alt: String, title: Option<String>, marks: Marks,
          alt_source: Option<ImageAltSource>, reference: Option<Reference> },
}

impl Inline {
  pub fn marks(&self) -> &Marks {
    match self {
      Inline::Text { marks, .. }
      | Inline::Code { marks, .. }
      | Inline::HardBreak { marks }
      | Inline::SoftBreak { marks }
      | Inline::Image { marks, .. } => marks,
    }
  }

  pub fn plain(&self) -> String {
    match self {
      Inline::Text { text, .. } | Inline::Code { text, .. } => text.clone(),
      Inline::HardBreak { .. } | Inline::SoftBreak { .. } => "\n".to_string(),
      Inline::Image { alt, .. } => alt.clone(),
    }
  }
}

impl Block {
  /// Plain text of the block, used by search, outline and the native view.
  pub fn plain_text(&self) -> String {
    let mut out = String::new();
    self.push_plain(&mut out);
    out
  }

  fn push_plain(&self, out: &mut String) {
    match self {
      Block::Paragraph(inlines) | Block::Heading { content: inlines, .. } => {
        push_inlines(inlines, out)
      }
      Block::BlockQuote(blocks) => {
        for block in blocks {
          block.push_plain(out);
          out.push('\n');
        }
      }
      Block::List(list) => {
        for item in &list.items {
          for block in item {
            block.push_plain(out);
            out.push('\n');
          }
        }
      }
      Block::Table(table) => {
        for cell in &table.header {
          push_inlines(cell, out);
          out.push('\t');
        }
        for row in &table.rows {
          out.push('\n');
          for cell in row {
            push_inlines(cell, out);
            out.push('\t');
          }
        }
      }
      Block::CodeBlock { text, .. } | Block::RawSource(text) => out.push_str(text),
      Block::HorizontalRule => {}
    }
  }

  /// Heading level when this block can appear in the outline.
  pub fn heading_level(&self) -> Option<u8> {
    match self {
      Block::Heading { level, .. } => Some(*level),
      _ => None,
    }
  }

  pub fn is_empty_paragraph(&self) -> bool {
    matches!(self, Block::Paragraph(inlines) if inlines.is_empty())
  }
}

fn push_inlines(inlines: &[Inline], out: &mut String) {
  for inline in inlines {
    match inline {
      Inline::Text { text, .. } | Inline::Code { text, .. } => out.push_str(text),
      Inline::HardBreak { .. } | Inline::SoftBreak { .. } => out.push('\n'),
      Inline::Image { alt, .. } => out.push_str(alt),
    }
  }
}

/// Append text into the last `Text` run when marks match, so an edit does not
/// explode the model into one run per character.
pub fn push_text(inlines: &mut Vec<Inline>, text: &str, marks: &Marks) {
  if text.is_empty() {
    return;
  }
  if let Some(Inline::Text { text: last, marks: last_marks }) = inlines.last_mut() {
    if last_marks == marks {
      last.push_str(text);
      return;
    }
  }
  inlines.push(Inline::Text { text: text.to_string(), marks: marks.clone() });
}

impl Document {
  /// Compares structure only: source bytes and dirty flags are not content.
  /// This is the native equivalent of the baseline's `doc.eq(...)` check that
  /// decides whether the originally opened spelling can be returned verbatim.
  ///
  /// Adjacent text runs with identical marks are merged before comparison.
  /// ProseMirror always stores one text node per run, so `["alpha", " beta"]`
  /// and `["alpha beta"]` are the same document there and must be here too.
  pub fn content_eq(&self, other: &Document) -> bool {
    if self.segments.len() != other.segments.len() {
      return false;
    }
    self
      .segments
      .iter()
      .zip(&other.segments)
      .all(|(a, b)| blocks_eq(&a.block, &b.block))
  }

  pub fn blocks(&self) -> impl Iterator<Item = &Block> {
    self.segments.iter().map(|segment| &segment.block)
  }

  pub fn plain_text(&self) -> String {
    self
      .segments
      .iter()
      .map(|segment| segment.block.plain_text())
      .collect::<Vec<_>>()
      .join("\n")
  }

  pub fn is_empty(&self) -> bool {
    self.segments.is_empty()
      || (self.segments.len() == 1 && self.segments[0].block.is_empty_paragraph())
  }
}

fn blocks_eq(a: &Block, b: &Block) -> bool {
  match (a, b) {
    (Block::Paragraph(x), Block::Paragraph(y)) => inlines_eq(x, y),
    (Block::Heading { level: l1, content: x }, Block::Heading { level: l2, content: y }) => {
      l1 == l2 && inlines_eq(x, y)
    }
    (Block::BlockQuote(x), Block::BlockQuote(y)) => {
      x.len() == y.len() && x.iter().zip(y).all(|(a, b)| blocks_eq(a, b))
    }
    (Block::List(x), Block::List(y)) => {
      x.ordered == y.ordered
        && x.start == y.start
        && x.delimiter == y.delimiter
        && x.tasks == y.tasks
        && x.items.len() == y.items.len()
        && x.items.iter().zip(&y.items).all(|(a, b)| {
          a.len() == b.len() && a.iter().zip(b).all(|(a, b)| blocks_eq(a, b))
        })
    }
    (Block::Table(x), Block::Table(y)) => {
      x.align == y.align
        && x.header.len() == y.header.len()
        && x.header.iter().zip(&y.header).all(|(a, b)| inlines_eq(a, b))
        && x.rows.len() == y.rows.len()
        && x.rows.iter().zip(&y.rows).all(|(arow, brow)| {
          arow.len() == brow.len() && arow.iter().zip(brow).all(|(a, b)| inlines_eq(a, b))
        })
    }
    (Block::CodeBlock { language: l1, text: t1 }, Block::CodeBlock { language: l2, text: t2 }) => {
      l1 == l2 && t1 == t2
    }
    (Block::HorizontalRule, Block::HorizontalRule) => true,
    (Block::RawSource(x), Block::RawSource(y)) => x == y,
    _ => false,
  }
}

/// Compares inline sequences with adjacent same-mark text runs merged.
fn inlines_eq(a: &[Inline], b: &[Inline]) -> bool {
  let mut left = InlineCursor::new(a);
  let mut right = InlineCursor::new(b);
  loop {
    match (left.next(), right.next()) {
      (None, None) => return true,
      (Some(x), Some(y)) if x == y => continue,
      _ => return false,
    }
  }
}

#[derive(PartialEq, Eq, Debug)]
enum Atom {
  Text { text: String, marks: Marks },
  Code { text: String, marks: Marks },
  HardBreak { marks: Marks },
  SoftBreak { marks: Marks },
  Image { src: String, alt: String, title: Option<String>, marks: Marks },
}

struct InlineCursor<'a> {
  items: &'a [Inline],
  index: usize,
  pending: Option<Atom>,
}

impl<'a> InlineCursor<'a> {
  fn new(items: &'a [Inline]) -> Self {
    Self { items, index: 0, pending: None }
  }

  fn next(&mut self) -> Option<Atom> {
    loop {
      if let Some(mut pending) = self.pending.take() {
        // Merge following same-mark text runs into the pending atom.
        while let Some(Inline::Text { text, marks }) = self.items.get(self.index) {
          if let Atom::Text { text: current, marks: current_marks } = &mut pending {
            if *current_marks == semantic_marks(marks) {
              current.push_str(text);
              self.index += 1;
              continue;
            }
          }
          break;
        }
        return Some(pending);
      }
      let item = self.items.get(self.index)?;
      self.index += 1;
      match item {
        Inline::Text { text, marks } => {
          self.pending = Some(Atom::Text { text: text.clone(), marks: semantic_marks(marks) });
        }
        Inline::Code { text, marks } => return Some(Atom::Code { text: text.clone(), marks: semantic_marks(marks) }),
        Inline::HardBreak { marks } => return Some(Atom::HardBreak { marks: semantic_marks(marks) }),
        Inline::SoftBreak { marks } => return Some(Atom::SoftBreak { marks: semantic_marks(marks) }),
        Inline::Image { src, alt, title, marks, .. } => {
          return Some(Atom::Image {
            src: src.clone(),
            alt: alt.clone(),
            title: title.clone(),
            marks: semantic_marks(marks),
          })
        }
      }
    }
  }
}

fn semantic_marks(marks: &Marks) -> Marks {
  let mut semantic = marks.clone();
  if let Some(link) = &mut semantic.link { link.reference = None; }
  semantic
}
