//! Markdown exporter.
//!
//! Untouched segments are emitted from their retained source bytes, so an edit
//! in one block cannot rewrite another block's spelling. Only dirty segments go
//! through `serialize_block`, which follows the baseline's Markdown conventions
//! (`- ` bullets, `1. ` ordered markers, two-space nesting, pipe tables with an
//! alignment row, fenced code with an info string).

use crate::model::{Alignment, Block, Document, Inline, List, Marks, Reference, ReferenceKind, Table};

pub fn to_markdown(document: &Document, line_ending: &str) -> String {
  let mut out = String::new();
  for (index, segment) in document.segments.iter().enumerate() {
    let is_last = index + 1 == document.segments.len();
    if segment.source_is_current() {
      out.push_str(&segment.source);
      continue;
    }
    let text = serialize_block(&segment.block);
    if !text.is_empty() {
      if line_ending == "\r\n" {
        out.push_str(&text.replace("\r\n", "\n").replace('\n', "\r\n"));
      } else {
        out.push_str(&text);
      }
    }
    if !is_last {
      // A dirty segment has no retained separation; use the canonical blank line.
      out.push_str(line_ending);
      out.push_str(line_ending);
    }
  }
  out
}

pub fn serialize_block(block: &Block) -> String {
  let mut out = String::new();
  write_block(block, &mut out, "");
  out
}

fn write_block(block: &Block, out: &mut String, indent: &str) {
  match block {
    Block::Paragraph(inlines) => out.push_str(&serialize_inlines(inlines)),
    Block::Heading { level, content } => {
      out.push_str(&"#".repeat((*level).clamp(1, 6) as usize));
      out.push(' ');
      out.push_str(&serialize_inlines(content));
    }
    Block::BlockQuote(blocks) => {
      let mut inner = String::new();
      for (index, child) in blocks.iter().enumerate() {
        if index > 0 {
          inner.push('\n');
        }
        write_block(child, &mut inner, "");
      }
      for (index, line) in inner.split('\n').enumerate() {
        if index > 0 {
          out.push('\n');
        }
        if line.is_empty() {
          out.push('>');
        } else {
          out.push_str("> ");
          out.push_str(line);
        }
      }
    }
    Block::List(list) => write_list(list, out, indent),
    Block::Table(table) => write_table(table, out),
    Block::CodeBlock { language, text } => {
      let fence = fence_for(text);
      out.push_str(&fence);
      if let Some(language) = language {
        out.push_str(language);
      }
      out.push('\n');
      out.push_str(text);
      if !text.ends_with('\n') {
        out.push('\n');
      }
      out.push_str(&fence);
    }
    Block::HorizontalRule => out.push_str("---"),
    Block::RawSource(text) => out.push_str(text.trim_end_matches('\n')),
  }
}

fn write_list(list: &List, out: &mut String, indent: &str) {
  for (index, item) in list.items.iter().enumerate() {
    if index > 0 {
      out.push_str(if list.loose { "\n\n" } else { "\n" });
    }
    let marker = if list.ordered {
      format!("{}{}", list.start + index as u64, list.delimiter)
    } else {
      "-".to_string()
    };
    out.push_str(indent);
    out.push_str(&marker);
    out.push(' ');
    if let Some(checked) = list.tasks.get(index).copied().flatten() {
      out.push_str(if checked { "[x] " } else { "[ ] " });
    }
    let continuation = format!("{}{}", indent, " ".repeat(marker.len() + 1));

    for (child_index, child) in item.iter().enumerate() {
      let mut body = String::new();
      write_block(child, &mut body, &continuation);
      if child_index == 0 {
        // First child continues the marker line; subsequent lines of a
        // multi-line paragraph align with the item text.
        push_indented(out, &body, &continuation, false);
      } else if matches!(child, Block::List(_)) {
        // A nested list follows the item text directly (tight item).
        out.push('\n');
        out.push_str(&body);
      } else {
        // Loose item: a blank line separates block children.
        out.push_str("\n\n");
        out.push_str(&continuation);
        push_indented(out, &body, &continuation, true);
      }
    }
  }
}

/// Writes `body`, prefixing every line after the first with `continuation`.
/// `already_indented_first` skips the prefix for a line that was written by the
/// caller (used after an explicit separator).
fn push_indented(out: &mut String, body: &str, continuation: &str, already_indented_first: bool) {
  for (index, line) in body.split('\n').enumerate() {
    if index > 0 {
      out.push('\n');
      if !line.is_empty() {
        out.push_str(continuation);
      }
    }
    if index == 0 && already_indented_first {
      // Caller already emitted the continuation prefix.
      out.push_str(line);
    } else {
      out.push_str(line);
    }
  }
}

fn write_table(table: &Table, out: &mut String) {
  let columns = table
    .header
    .len()
    .max(table.rows.iter().map(Vec::len).max().unwrap_or(0));
  if columns == 0 {
    return;
  }

  out.push('|');
  for index in 0..columns {
    out.push(' ');
    if let Some(cell) = table.header.get(index) {
      out.push_str(&serialize_inlines(cell));
    }
    out.push_str(" |");
  }
  out.push('\n');

  out.push('|');
  for index in 0..columns {
    out.push(' ');
    out.push_str(match table.align.get(index).copied().unwrap_or(Alignment::None) {
      Alignment::None => "---",
      Alignment::Left => ":---",
      Alignment::Center => ":---:",
      Alignment::Right => "---:",
    });
    out.push_str(" |");
  }

  for row in &table.rows {
    out.push('\n');
    out.push('|');
    for index in 0..columns {
      out.push(' ');
      if let Some(cell) = row.get(index) {
        out.push_str(&serialize_inlines(cell));
      }
      out.push_str(" |");
    }
  }
}

fn fence_for(text: &str) -> String {
  let mut longest = 0usize;
  let mut current = 0usize;
  for ch in text.chars() {
    if ch == '`' {
      current += 1;
      longest = longest.max(current);
    } else {
      current = 0;
    }
  }
  "`".repeat(longest.max(2) + 1)
}

pub fn serialize_inlines(inlines: &[Inline]) -> String {
  let mut out = String::new();
  let mut index = 0;
  while index < inlines.len() {
    let inline = &inlines[index];
    if let Some(link) = inline.marks().link.as_ref().filter(|link| link.reference.is_some()) {
      let mut end = index + 1;
      while end < inlines.len() && inlines[end].marks().link.as_ref() == Some(link) { end += 1; }
      let mut children = inlines[index..end].to_vec();
      for child in &mut children {
        match child {
          Inline::Text { marks, .. } | Inline::Code { marks, .. } | Inline::HardBreak { marks } |
          Inline::SoftBreak { marks } | Inline::Image { marks, .. } => marks.link = None,
        }
      }
      out.push_str(&reference_link(&serialize_inlines(&children), link.reference.as_ref().unwrap()));
      index = end;
      continue;
    }
    // Keep a shared outer mark open across adjacent differently-marked runs.
    // Closing bold then immediately opening bold+italic creates ambiguous *****.
    let marks = inline.marks();
    let outer = if marks.bold { 1 } else if marks.italic { 2 } else if marks.strike { 3 } else { 0 };
    let mut end = index + 1;
    if outer != 0 && marks.link.is_none() {
      while end < inlines.len() {
        let m = inlines[end].marks();
        let shared = match outer { 1 => m.bold, 2 => m.italic, _ => m.strike };
        if !shared || m.link.is_some() { break; }
        end += 1;
      }
    }
    if end > index + 1 {
      let mut group = inlines[index..end].to_vec();
      for run in &mut group {
        let m = match run {
          Inline::Text { marks, .. } | Inline::Code { marks, .. } |
          Inline::HardBreak { marks } | Inline::SoftBreak { marks } |
          Inline::Image { marks, .. } => marks,
        };
        match outer { 1 => m.bold = false, 2 => m.italic = false, _ => m.strike = false }
      }
      let delimiter = match outer { 1 => "**", 2 => "*", _ => "~~" };
      out.push_str(delimiter);
      out.push_str(&serialize_inlines(&group));
      out.push_str(delimiter);
      index = end;
      continue;
    }
    index += 1;
    match inline {
      Inline::Text { text, marks } => out.push_str(&apply_marks(&escape_text(text), marks)),
      Inline::Code { text, marks } => {
        let body = format!("`{text}`");
        out.push_str(&apply_marks(&body, marks));
      }
      Inline::HardBreak { marks } => out.push_str(&apply_marks("\\\n", marks)),
      Inline::SoftBreak { marks } => out.push_str(&apply_marks("\n", marks)),
      Inline::Image { src, alt, title, marks, alt_source, reference } => {
        let label = alt_source.as_ref().filter(|saved| saved.original == *alt)
          .map(|saved| saved.source.clone()).unwrap_or_else(|| escape_text(alt));
        let body = if let Some(reference) = reference {
          format!("!{}", reference_link(&label, reference))
        } else {
          let mut body = format!("![{label}]({src}");
          if let Some(title) = title { body.push_str(&format!(" \"{title}\"")); }
          body.push(')');
          body
        };
        out.push_str(&apply_marks(&body, marks));
      }
    }
  }
  out
}

fn reference_link(text: &str, reference: &Reference) -> String {
  if text == reference.text_source {
    match reference.kind {
      ReferenceKind::Collapsed => return format!("[{text}][]"),
      ReferenceKind::Shortcut => return format!("[{text}]"),
      ReferenceKind::Full => {}
    }
  }
  format!("[{text}][{}]", reference.label)
}

fn apply_marks(text: &str, marks: &Marks) -> String {
  let mut out = text.to_string();
  if marks.strike {
    out = format!("~~{out}~~");
  }
  if marks.italic {
    out = format!("*{out}*");
  }
  if marks.bold {
    out = format!("**{out}**");
  }
  if let Some(link) = &marks.link {
    out = match &link.title {
      Some(title) => format!("[{out}]({} \"{title}\")", link.href),
      None => format!("[{}]({})", out, link.href),
    };
  }
  out
}

/// Escape only the characters that would otherwise be read back as syntax.
pub fn escape_text(text: &str) -> String {
  let mut out = String::with_capacity(text.len());
  for ch in text.chars() {
    match ch {
      '\\' | '`' | '*' | '_' | '[' | ']' | '~' => {
        out.push('\\');
        out.push(ch);
      }
      '\n' => out.push('\n'),
      _ => out.push(ch),
    }
  }
  out
}
