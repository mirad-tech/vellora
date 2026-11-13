//! Parser: Markdown bytes -> neutral document model.
//!
//! Mirrors the baseline import rules (`src/editor/markdownDocument.ts`):
//! leading frontmatter is retained verbatim, every top-level block that cannot
//! be represented becomes `RawSource` covering its own line range, and source
//! lines between blocks that produced no node are retained too.

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

use crate::model::{push_text, Alignment, Block, Document, ImageAltSource, Inline, Link, List, Marks, Reference, ReferenceKind, Segment, Table};

pub fn parse(source: &str) -> Document {
  let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
  let lines: Vec<&str> = normalized.split('\n').collect();

  let frontmatter_end = frontmatter_end_line(&lines);
  let body = if frontmatter_end > 0 {
    // Mask the header so token maps keep their original line offsets. Its source
    // must not become a horizontal rule or a setext heading when the body is edited.
    let mut masked = String::with_capacity(normalized.len());
    for (index, line) in lines.iter().enumerate() {
      if index < frontmatter_end {
        masked.push('\n');
      } else {
        masked.push_str(line);
        if index + 1 < lines.len() {
          masked.push('\n');
        }
      }
    }
    masked
  } else {
    normalized.clone()
  };

  let mut options = Options::empty();
  options.insert(Options::ENABLE_TABLES);
  options.insert(Options::ENABLE_STRIKETHROUGH);
  options.insert(Options::ENABLE_TASKLISTS);

  let events: Vec<(Event, std::ops::Range<usize>)> =
    Parser::new_ext(&body, options).into_offset_iter().collect();

  let ranges = top_level_ranges(&events);
  let body_offsets = line_offsets(&body);
  let mut entries: Vec<(usize, Block)> = Vec::new();

  if frontmatter_end > 0 {
    entries.push((0, Block::RawSource(lines[0..frontmatter_end].join("\n"))));
  }

  let mut cursor_line = frontmatter_end;
  for (start_idx, end_idx) in ranges {
    let byte_range = events[start_idx].1.start..events[end_idx].1.end;
    let (start_line, end_line) = byte_lines(&body, byte_range, &body_offsets);
    if start_line < cursor_line {
      continue;
    }
    if !lines[cursor_line..start_line].join("\n").trim().is_empty() {
      entries.push((cursor_line, Block::RawSource(lines[cursor_line..start_line].join("\n"))));
    }
    let block = convert_block(&events[start_idx..=end_idx], &body)
      .unwrap_or_else(|| Block::RawSource(lines[start_line..end_line].join("\n")));
    entries.push((start_line, block));
    cursor_line = end_line;
  }

  if cursor_line < lines.len() && !lines[cursor_line..].join("\n").trim().is_empty() {
    entries.push((cursor_line, Block::RawSource(lines[cursor_line..].join("\n"))));
  }

  // Source lines that produced no node (reference definitions, trailing text)
  // and any leading blank lines stay addressable as verbatim segments.
  if entries.is_empty() {
    let whole = normalized.clone();
    entries.push((0, Block::RawSource(whole)));
  }

  let mut segments = Vec::with_capacity(entries.len());
  let offsets = line_offsets(source);
  for index in 0..entries.len() {
    let (start_line, ref block) = entries[index];
    let end_line = entries
      .get(index + 1)
      .map(|(next, _)| *next)
      .unwrap_or(lines.len());
    let from = if index == 0 { 0 } else { offsets[start_line.min(lines.len())] };
    let to = offsets[end_line.min(lines.len())];
    let source = source[from..to].to_string();
    let block = if matches!(block, Block::RawSource(_)) && source.trim().is_empty() {
      // Whitespace-only gaps are not content; keep them in source only.
      Block::Paragraph(Vec::new())
    } else {
      block.clone()
    };
    segments.push(Segment::new(block, source));
  }

  if segments.is_empty() {
    segments.push(Segment::synthetic(Block::Paragraph(Vec::new())));
  }
  // A single synthetic empty paragraph must not claim source bytes.
  if segments.len() == 1 && segments[0].source.is_empty() {
    segments[0] = Segment::synthetic(Block::Paragraph(Vec::new()));
  }
  Document { segments }
}

/// Index of the first body line after a leading frontmatter block (0 when none).
pub fn frontmatter_end_line(lines: &[&str]) -> usize {
  let Some(first) = lines.first() else {
    return 0;
  };
  let trimmed = first.trim_start_matches('\u{feff}');
  if trimmed.trim_end() != "---" {
    return 0;
  }
  for (index, line) in lines.iter().enumerate().skip(1) {
    let value = line.trim_end();
    if value == "---" || value == "..." {
      return index + 1;
    }
  }
  0
}

fn byte_lines(body: &str, range: std::ops::Range<usize>, offsets: &[usize]) -> (usize, usize) {
  // Exclude the extra sentinel (a trailing newline already contributes an EOF
  // line start). This is equivalent to counting prefix newlines, without an
  // O(document_size * block_count) scan on large documents.
  let starts = &offsets[..offsets.len().saturating_sub(1)];
  let start_byte = range.start.min(body.len());
  let end_byte = range.end.min(body.len());
  let start = starts.partition_point(|offset| *offset <= start_byte).saturating_sub(1);
  let mut end = starts.partition_point(|offset| *offset <= end_byte).saturating_sub(1);
  if end_byte == 0 || body.as_bytes()[end_byte - 1] != b'\n' { end += 1; }
  (start, end.max(start + 1))
}

/// Depth-0 (start_event_index, end_event_index) pairs.
fn top_level_ranges(events: &[(Event, std::ops::Range<usize>)]) -> Vec<(usize, usize)> {
  let mut ranges = Vec::new();
  let mut depth: i32 = 0;
  let mut start_idx: Option<usize> = None;
  for (index, (event, _)) in events.iter().enumerate() {
    match event {
      Event::Start(_) => {
        if depth == 0 {
          start_idx = Some(index);
        }
        depth += 1;
      }
      Event::End(_) => {
        depth -= 1;
        if depth == 0 {
          if let Some(start) = start_idx.take() {
            ranges.push((start, index));
          }
        }
      }
      Event::Rule | Event::Html(_) => {
        if depth == 0 {
          ranges.push((index, index));
        }
      }
      _ => {}
    }
  }
  ranges
}

enum Frame {
  Root(Vec<Block>),
  BlockQuote(Vec<Block>),
  List(List),
  Item(Vec<Block>, Option<bool>),
  Paragraph { inlines: Vec<Inline>, implicit: bool },
  Heading { level: u8, content: Vec<Inline> },
  Table { align: Vec<Alignment>, header: Vec<Vec<Inline>>, rows: Vec<Vec<Vec<Inline>>>, in_header: bool },
  Cell(Vec<Inline>),
  CodeBlock { language: Option<String>, text: String },
  Mark(Marks),
  LinkMark(Link),
  ImageAlt { src: String, title: Option<String>, text: String, marks: Marks,
             source: Option<String>, reference: Option<Reference>, nested_images: usize },
}

struct Builder {
  stack: Vec<Frame>,
}

fn convert_block(events: &[(Event, std::ops::Range<usize>)], source: &str) -> Option<Block> {
  let mut builder = Builder { stack: vec![Frame::Root(Vec::new())] };
  for (event, range) in events {
    builder.handle(event)?;
    let authored = &source[range.clone()];
    match event {
      Event::Start(Tag::Link { link_type, id, .. }) => {
        if let Some(Frame::LinkMark(link)) = builder.stack.last_mut() {
          link.reference = reference_metadata(*link_type, id, authored, range.start);
        }
      }
      Event::Start(Tag::Image { link_type, id, .. }) => {
        if let Some(Frame::ImageAlt { source: alt, reference, nested_images: 0, .. }) = builder.stack.last_mut() {
          *alt = bracket_text(authored).map(|(text, _)| text.to_string());
          *reference = reference_metadata(*link_type, id, authored, range.start);
        }
      }
      _ => {}
    }
    if matches!(event, Event::Start(Tag::List(Some(_)))) {
      if let Some(Frame::List(list)) = builder.stack.last_mut() {
        let marker = source[range.start..range.end].trim_start();
        list.delimiter = marker.chars().find(|c| !c.is_ascii_digit()).filter(|c| *c == ')').unwrap_or('.');
      }
    }
  }
  match builder.stack.pop() {
    Some(Frame::Root(mut blocks)) if blocks.len() == 1 => blocks.pop(),
    Some(Frame::Root(blocks)) if blocks.is_empty() => Some(Block::Paragraph(Vec::new())),
    _ => None,
  }
}

impl Builder {
  /// `Some(())` on success, `None` when the construct cannot be represented.
  fn handle(&mut self, event: &Event) -> Option<()> {
    // An image's children describe alt text, not ordinary document runs. Keep
    // text beneath emphasis/link frames, code spans and nested images as text.
    if let Some(Frame::ImageAlt { text, nested_images, .. }) = self.stack.last_mut() {
      match event {
        Event::Text(value) | Event::Code(value) | Event::InlineHtml(value) | Event::Html(value) => text.push_str(value),
        Event::SoftBreak | Event::HardBreak => text.push(' '),
        Event::Start(Tag::Image { .. }) => *nested_images += 1,
        Event::End(TagEnd::Image) if *nested_images > 0 => *nested_images -= 1,
        Event::End(TagEnd::Image) => return self.end(&TagEnd::Image),
        _ => {}
      }
      return Some(());
    }
    match event {
      Event::Start(tag) => self.start(tag),
      Event::End(tag) => self.end(tag),
      Event::Text(text) => {
        self.push_text(text);
        Some(())
      }
      Event::Code(text) => {
        let marks = self.current_marks();
        self.ensure_inlines();
        let inlines = self.current_inlines()?;
        inlines.push(Inline::Code { text: text.to_string(), marks });
        Some(())
      }
      Event::SoftBreak => {
        let marks = self.current_marks();
        self.ensure_inlines();
        let inlines = self.current_inlines()?;
        inlines.push(Inline::SoftBreak { marks });
        Some(())
      }
      Event::HardBreak => {
        let marks = self.current_marks();
        self.ensure_inlines();
        let inlines = self.current_inlines()?;
        inlines.push(Inline::HardBreak { marks });
        Some(())
      }
      Event::Rule => {
        match self.stack.last_mut() {
          Some(Frame::Root(blocks)) => blocks.push(Block::HorizontalRule),
          _ => return None,
        }
        Some(())
      }
      Event::Html(_) => None,
      Event::InlineHtml(html) => {
        if !is_line_break_tag(html) {
          return None;
        }
        let marks = self.current_marks();
        self.ensure_inlines();
        let inlines = self.current_inlines()?;
        inlines.push(Inline::HardBreak { marks });
        Some(())
      }
      Event::TaskListMarker(checked) => {
        let task = self.stack.iter_mut().rev().find_map(|frame| match frame {
          Frame::Item(_, task) => Some(task), _ => None,
        })?;
        *task = Some(*checked);
        Some(())
      }
      Event::FootnoteReference(_)
      | Event::InlineMath(_)
      | Event::DisplayMath(_) => None,
    }
  }

  fn start(&mut self, tag: &Tag) -> Option<()> {
    match tag {
      Tag::Paragraph => {
        if matches!(self.stack.last(), Some(Frame::Item(_, _))) {
          if let Some(list) = self.stack.iter_mut().rev().find_map(|frame| match frame { Frame::List(list) => Some(list), _ => None }) { list.loose = true; }
        }
        self.close_implicit_paragraph();
        self.stack.push(Frame::Paragraph { inlines: Vec::new(), implicit: false })
      }
      Tag::Heading { level, .. } => self.stack.push(Frame::Heading {
        level: heading_level(*level),
        content: Vec::new(),
      }),
      Tag::BlockQuote(_) => {
        self.close_implicit_paragraph();
        self.stack.push(Frame::BlockQuote(Vec::new()))
      }
      Tag::CodeBlock(kind) => {
        self.close_implicit_paragraph();
        let language = match kind {
          CodeBlockKind::Fenced(info) => {
            let value = info.trim();
            if value.is_empty() { None } else { Some(value.to_string()) }
          }
          CodeBlockKind::Indented => None,
        };
        self.stack.push(Frame::CodeBlock { language, text: String::new() });
      }
      Tag::List(start) => {
        self.close_implicit_paragraph();
        self.stack.push(Frame::List(List {
          ordered: start.is_some(),
          start: start.unwrap_or(1),
          delimiter: '.',
          items: Vec::new(),
          tasks: Vec::new(),
          loose: false,
        }))
      }
      Tag::Item => {
        self.close_implicit_paragraph();
        self.stack.push(Frame::Item(Vec::new(), None))
      }
      Tag::Table(aligns) => {
        self.close_implicit_paragraph();
        self.stack.push(Frame::Table {
          align: aligns.iter().map(|a| convert_alignment(*a)).collect(),
          header: Vec::new(),
          rows: Vec::new(),
          in_header: false,
        })
      }
      Tag::TableHead => {
        if let Some(Frame::Table { in_header, .. }) = self.table_mut() {
          *in_header = true;
        }
      }
      Tag::TableRow => {
        if let Some(Frame::Table { rows, in_header, .. }) = self.table_mut() {
          if !*in_header {
            rows.push(Vec::new());
          }
        }
      }
      Tag::TableCell => self.stack.push(Frame::Cell(Vec::new())),
      Tag::Emphasis | Tag::Strong | Tag::Strikethrough => {
        let mut marks = self.current_marks();
        match tag {
          Tag::Emphasis => marks.italic = true,
          Tag::Strong => marks.bold = true,
          Tag::Strikethrough => marks.strike = true,
          _ => unreachable!(),
        }
        self.stack.push(Frame::Mark(marks));
      }
      Tag::Link { dest_url, title, .. } => {
        self.stack.push(Frame::LinkMark(Link {
          href: dest_url.to_string(),
          title: if title.is_empty() { None } else { Some(title.to_string()) },
          reference: None,
        }));
      }
      Tag::Image { dest_url, title, .. } => {
        let marks = self.current_marks();
        self.stack.push(Frame::ImageAlt {
          src: dest_url.to_string(),
          title: if title.is_empty() { None } else { Some(title.to_string()) },
          text: String::new(),
          marks,
          source: None, reference: None, nested_images: 0,
        });
      }
      _ => return None,
    }
    Some(())
  }

  fn end(&mut self, tag: &TagEnd) -> Option<()> {
    match tag {
      TagEnd::Paragraph => {
        if let Some(Frame::Paragraph { inlines, .. }) = self.stack.pop() {
          self.push_block(Block::Paragraph(inlines));
        }
      }
      TagEnd::Heading(_) => {
        if let Some(Frame::Heading { level, content }) = self.stack.pop() {
          self.push_block(Block::Heading { level, content });
        }
      }
      TagEnd::BlockQuote(_) => {
        self.close_implicit_paragraph();
        if let Some(Frame::BlockQuote(blocks)) = self.stack.pop() {
          self.push_block(Block::BlockQuote(blocks));
        }
      }
      TagEnd::CodeBlock => {
        if let Some(Frame::CodeBlock { language, text }) = self.stack.pop() {
          self.push_block(Block::CodeBlock { language, text });
        }
      }
      TagEnd::List(_) => {
        self.close_implicit_paragraph();
        if let Some(Frame::List(list)) = self.stack.pop() {
          self.push_block(Block::List(list));
        }
      }
      TagEnd::Item => {
        self.close_implicit_paragraph();
        if let Some(Frame::Item(blocks, task)) = self.stack.pop() {
          let list = self.stack.iter_mut().rev().find_map(|frame| match frame {
            Frame::List(list) => Some(list),
            _ => None,
          })?;
          list.items.push(blocks);
          list.tasks.push(task);
        }
      }
      TagEnd::Table => {
        self.close_implicit_paragraph();
        if let Some(Frame::Table { align, header, rows, .. }) = self.stack.pop() {
          self.push_block(Block::Table(Table { align, header, rows, spans: Vec::new(), cell_headers: Vec::new(), header_is_body: false }));
        }
      }
      TagEnd::TableHead => {
        if let Some(Frame::Table { in_header, .. }) = self.table_mut() {
          *in_header = false;
        }
      }
      TagEnd::TableRow => {}
      TagEnd::TableCell => {
        if let Some(Frame::Cell(inlines)) = self.stack.pop() {
          let table = self.table_mut()?;
          let Frame::Table { header, rows, in_header, .. } = table else {
            return None;
          };
          if *in_header {
            header.push(inlines);
          } else if let Some(row) = rows.last_mut() {
            row.push(inlines);
          } else {
            header.push(inlines);
          }
        }
      }
      TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough | TagEnd::Link => {
        self.stack.pop();
      }
      TagEnd::Image => {
        if let Some(Frame::ImageAlt { src, title, text, marks, source, reference, .. }) = self.stack.pop() {
          let inlines = self.current_inlines()?;
          let alt_source = source.map(|source| ImageAltSource { source, original: text.clone() });
          inlines.push(Inline::Image { src, alt: text, title, marks, alt_source, reference });
        }
      }
      _ => return None,
    }
    Some(())
  }

  fn table_mut(&mut self) -> Option<&mut Frame> {
    self.stack.iter_mut().rev().find(|frame| matches!(frame, Frame::Table { .. }))
  }

  fn push_block(&mut self, block: Block) {
    match self.stack.last_mut() {
      Some(Frame::Root(blocks)) | Some(Frame::BlockQuote(blocks)) | Some(Frame::Item(blocks, _)) => {
        blocks.push(block)
      }
      _ => {}
    }
  }

  /// Nearest enclosing inline container. Mark/Link frames sit on top of it while
  /// their `Start` is active, so the search must skip them instead of giving up.
  fn current_inlines(&mut self) -> Option<&mut Vec<Inline>> {
    for frame in self.stack.iter_mut().rev() {
      match frame {
        Frame::Paragraph { inlines, .. }
        | Frame::Heading { content: inlines, .. }
        | Frame::Cell(inlines) => return Some(inlines),
        Frame::Mark(_) | Frame::LinkMark(_) => continue,
        _ => return None,
      }
    }
    None
  }

  /// Tight list items and lazy continuation lines emit text without a
  /// `Paragraph` token. ProseMirror (and the baseline model) always store a
  /// paragraph, so open one implicitly when text arrives in a block container.
  fn ensure_inlines(&mut self) {
    if self.current_inlines().is_some() {
      return;
    }
    // Leading strong/emphasis/link tokens may already be above a tight item.
    // Insert the implicit paragraph beneath those marks, never above them:
    // End(Strong/Link) must still pop its own frame and retain the text runs.
    let mut at = self.stack.len();
    while at > 0 && matches!(&self.stack[at - 1], Frame::Mark(_) | Frame::LinkMark(_)) {
      at -= 1;
    }
    if at > 0 && matches!(&self.stack[at - 1], Frame::Item(_, _) | Frame::BlockQuote(_) | Frame::Root(_)) {
      self.stack.insert(at, Frame::Paragraph { inlines: Vec::new(), implicit: true });
    }
  }

  fn close_implicit_paragraph(&mut self) {
    if matches!(self.stack.last(), Some(Frame::Paragraph { implicit: true, .. })) {
      if let Some(Frame::Paragraph { inlines, .. }) = self.stack.pop() {
        self.push_block(Block::Paragraph(inlines));
      }
    }
  }

  fn current_marks(&self) -> Marks {
    let mut marks = Marks::default();
    for frame in &self.stack {
      match frame {
        Frame::Mark(own) => {
          marks.bold |= own.bold;
          marks.italic |= own.italic;
          marks.strike |= own.strike;
        }
        Frame::LinkMark(link) => marks.link = Some(link.clone()),
        Frame::ImageAlt { marks: own, .. } => {
          marks.bold |= own.bold;
          marks.italic |= own.italic;
          marks.strike |= own.strike;
          if let Some(link) = &own.link {
            marks.link = Some(link.clone());
          }
        }
        _ => {}
      }
    }
    marks
  }

  fn push_text(&mut self, text: &str) {
    match self.stack.last_mut() {
      Some(Frame::CodeBlock { text: body, .. }) => body.push_str(text),
      Some(Frame::ImageAlt { text: alt, .. }) => alt.push_str(text),
      _ => {
        self.ensure_inlines();
        let marks = self.current_marks();
        if let Some(inlines) = self.current_inlines() {
          push_text(inlines, text, &marks);
        }
      }
    }
  }
}

fn reference_metadata(link_type: pulldown_cmark::LinkType, id: &str, authored: &str, source_id: usize) -> Option<Reference> {
  use pulldown_cmark::LinkType::*;
  let kind = match link_type {
    Reference | ReferenceUnknown => ReferenceKind::Full,
    Collapsed | CollapsedUnknown => ReferenceKind::Collapsed,
    Shortcut | ShortcutUnknown => ReferenceKind::Shortcut,
    _ => return None,
  };
  let (text_source, after) = bracket_text(authored)?;
  let label = if kind == ReferenceKind::Full {
    bracket_text(authored[after..].trim_start()).map(|(label, _)| label).unwrap_or(id)
  } else { text_source };
  Some(crate::model::Reference { kind, label: label.into(), text_source: text_source.into(), source_id })
}

/// Return the authored first label, respecting escaped brackets and code spans.
fn bracket_text(source: &str) -> Option<(&str, usize)> {
  let bytes = source.as_bytes();
  let open = usize::from(bytes.first() == Some(&b'!'));
  if bytes.get(open) != Some(&b'[') { return None; }
  let mut depth = 1usize;
  let mut i = open + 1;
  while i < bytes.len() {
    match bytes[i] {
      b'\\' => { i += 2; continue; }
      b'`' => {
        let start = i;
        while bytes.get(i) == Some(&b'`') { i += 1; }
        let count = i - start;
        let mut j = i;
        while j < bytes.len() {
          if bytes[j] != b'`' { j += 1; continue; }
          let end_start = j;
          while bytes.get(j) == Some(&b'`') { j += 1; }
          if j - end_start == count { i = j; break; }
        }
        continue;
      }
      b'[' => depth += 1,
      b']' => {
        depth -= 1;
        if depth == 0 { return Some((&source[open + 1..i], i + 1)); }
      }
      _ => {}
    }
    i += 1;
  }
  None
}

/// Only confirmed reference definitions and closed HTML comments are invisible.
/// Unsupported HTML/unknown syntax must retain its accessible raw fallback.
pub fn is_nonvisual_source(source: &str) -> bool {
  // Valid definitions (including duplicate labels) emit no events. Everything
  // else must be a comment-only HTML block, not merely an empty sanitized view.
  let mut html = String::new();
  for event in Parser::new(source) {
    match event {
      Event::Start(Tag::HtmlBlock) | Event::End(TagEnd::HtmlBlock) => {},
      Event::Html(value) | Event::InlineHtml(value) => html.push_str(&value),
      _ => return false,
    }
  }
  let mut rest = html.trim();
  while let Some(comment) = rest.strip_prefix("<!--") {
    let Some(end) = comment.find("-->") else { return false; };
    rest = comment[end + 3..].trim_start();
  }
  rest.is_empty()
}

fn heading_level(level: HeadingLevel) -> u8 {
  match level {
    HeadingLevel::H1 => 1,
    HeadingLevel::H2 => 2,
    HeadingLevel::H3 => 3,
    HeadingLevel::H4 => 4,
    HeadingLevel::H5 => 5,
    HeadingLevel::H6 => 6,
  }
}

fn convert_alignment(align: pulldown_cmark::Alignment) -> Alignment {
  match align {
    pulldown_cmark::Alignment::None => Alignment::None,
    pulldown_cmark::Alignment::Left => Alignment::Left,
    pulldown_cmark::Alignment::Center => Alignment::Center,
    pulldown_cmark::Alignment::Right => Alignment::Right,
  }
}

fn is_line_break_tag(html: &str) -> bool {
  let trimmed = html.trim();
  let lower = trimmed.to_ascii_lowercase();
  if !lower.starts_with("<br") {
    return false;
  }
  let rest = &lower[3..];
  rest.starts_with('>') || rest.starts_with("/>") || rest.starts_with(' ') || rest.starts_with('\t')
}

/// Byte offset of the start of each line, plus a sentinel equal to the input
/// length. Slicing `normalized[offsets[a]..offsets[b]]` yields the exact bytes
/// of lines `a..b`, including every trailing newline.
fn line_offsets(text: &str) -> Vec<usize> {
  let mut offsets = vec![0usize];
  for (index, byte) in text.bytes().enumerate() {
    if byte == b'\n' || (byte == b'\r' && text.as_bytes().get(index + 1) != Some(&b'\n')) {
      offsets.push(index + 1);
    }
  }
  // Always push the sentinel so `offsets` has exactly `lines.len() + 1` entries.
  offsets.push(text.len());
  offsets
}

#[cfg(test)]
mod offset_tests {
  use super::*;
  #[test]
  fn binary_line_offsets_match_prefix_scans_at_every_utf8_boundary() {
    for body in ["", "a", "a\n", "\n\n", "a\n\nb", "😀你好\nnext\n", "\n# title\n\nbody"] {
      let offsets = line_offsets(body);
      let boundaries: Vec<_> = (0..=body.len()).filter(|index| body.is_char_boundary(*index)).collect();
      for start in &boundaries { for end in boundaries.iter().filter(|end| *end >= start) {
        let old_start = body[..*start].matches('\n').count();
        let prefix = &body[..*end];
        let old_end = prefix.matches('\n').count() + usize::from(!prefix.ends_with('\n'));
        assert_eq!(byte_lines(body, *start..*end, &offsets), (old_start, old_end.max(old_start + 1)), "{body:?} {start}..{end}");
      } }
    }
  }
}
