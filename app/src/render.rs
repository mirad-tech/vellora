//! Builds a native rendering plan from the neutral document model.
//!
//! The plan is plain text plus character/paragraph style ranges. The Win32 view
//! applies the styles with `EM_SETCHARFORMAT` / `EM_SETPARAFORMAT`; no HTML, CSS
//! or RTF parser is involved.
//!
//! Known milestone limits (tracked in docs/native/PROGRESS.md):
//! * tables are laid out as aligned pipe rows instead of a real grid
//! * images render as a labelled placeholder instead of the bitmap

use vellora_md::{Block, Document, Inline, Marks, Table};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StyleKind {
  Body,
  Heading1,
  Heading2,
  Heading3,
  Bold,
  Italic,
  Strike,
  Code,
  Link,
  Quote,
  Muted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StyledRange {
  pub start: usize,
  pub end: usize,
  pub style: StyleKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkRange {
  pub start: usize,
  pub end: usize,
  pub href: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParagraphRange {
  pub start: usize,
  pub end: usize,
  pub indent_twips: i32,
  pub space_before_twips: i32,
}

/// Rich Edit selection positions count UTF-16 code units, so every range in the
/// plan is expressed that way. Byte offsets would misplace styles after CJK text
/// or emoji.
#[derive(Clone, Debug, Default)]
pub struct RenderPlan {
  pub text: String,
  pub styles: Vec<StyledRange>,
  pub paragraphs: Vec<ParagraphRange>,
  /// Character ranges that carry a link target, used for Ctrl+click and Alt+Enter.
  pub links: Vec<LinkRange>,
  position: usize,
}

impl RenderPlan {
  fn push(&mut self, text: &str, style: StyleKind) {
    let start = self.position;
    self.text.push_str(text);
    self.position += text.encode_utf16().count();
    if !text.is_empty() && style != StyleKind::Body {
      self.styles.push(StyledRange { start, end: self.position, style });
    }
  }

  /// Rich Edit stores one paragraph mark per line, not CRLF. Using a single
  /// `\r` keeps `position` identical to the control's character index, which is
  /// what EM_SETCHARFORMAT ranges are expressed in.
  fn newline(&mut self) {
    self.text.push('\r');
    self.position += 1;
  }

  fn mark(&self) -> usize {
    self.position
  }
}

pub fn build(document: &Document) -> RenderPlan {
  let mut plan = RenderPlan::default();
  for (index, segment) in document.segments.iter().enumerate() {
    if index > 0 {
      plan.newline();
    }
    write_block(&mut plan, &segment.block, 0);
  }
  plan
}

fn write_block(plan: &mut RenderPlan, block: &Block, depth: usize) {
  match block {
    Block::Paragraph(inlines) => write_inlines(plan, inlines, StyleKind::Body),
    Block::Heading { level, content } => {
      let style = match level {
        1 => StyleKind::Heading1,
        2 => StyleKind::Heading2,
        _ => StyleKind::Heading3,
      };
      let start = plan.mark();
      write_inlines(plan, content, style);
      plan.styles.push(StyledRange { start, end: plan.position, style });
      plan.paragraphs.push(ParagraphRange {
        start,
        end: plan.position,
        indent_twips: 0,
        space_before_twips: if *level == 1 { 240 } else { 160 },
      });
    }
    Block::BlockQuote(blocks) => {
      for (index, child) in blocks.iter().enumerate() {
        if index > 0 {
          plan.newline();
        }
        let start = plan.mark();
        write_block(plan, child, depth);
        plan.paragraphs.push(ParagraphRange {
          start,
          end: plan.position,
          indent_twips: 360,
          space_before_twips: 0,
        });
        plan.styles.push(StyledRange { start, end: plan.position, style: StyleKind::Quote });
      }
    }
    Block::List(list) => {
      for (index, item) in list.items.iter().enumerate() {
        if index > 0 {
          plan.newline();
        }
        let start = plan.mark();
        let marker = if list.ordered {
          format!("{}{} ", list.start + index as u64, list.delimiter)
        } else {
          "•  ".to_string()
        };
        plan.push(&marker, StyleKind::Muted);
        for (child_index, child) in item.iter().enumerate() {
          if child_index > 0 {
            plan.newline();
          }
          write_block(plan, child, depth + 1);
        }
        plan.paragraphs.push(ParagraphRange {
          start,
          end: plan.position,
          indent_twips: 360 * (depth as i32 + 1),
          space_before_twips: 0,
        });
      }
    }
    Block::Table(table) => write_table(plan, table),
    Block::CodeBlock { text, .. } => {
      let start = plan.mark();
      for (index, line) in text.split('\n').enumerate() {
        if index > 0 {
          plan.newline();
        }
        plan.push(line, StyleKind::Code);
      }
      plan.paragraphs.push(ParagraphRange {
        start,
        end: plan.position,
        indent_twips: 360,
        space_before_twips: 0,
      });
    }
    Block::HorizontalRule => plan.push("────────", StyleKind::Muted),
    Block::RawSource(text) => {
      let start = plan.mark();
      for (index, line) in text.trim_end_matches('\n').split('\n').enumerate() {
        if index > 0 {
          plan.newline();
        }
        plan.push(line, StyleKind::Code);
      }
      plan.paragraphs.push(ParagraphRange {
        start,
        end: plan.position,
        indent_twips: 240,
        space_before_twips: 0,
      });
    }
  }
}

fn write_table(plan: &mut RenderPlan, table: &Table) {
  let columns = table
    .header
    .len()
    .max(table.rows.iter().map(Vec::len).max().unwrap_or(0))
    .max(1);
  let mut widths = vec![4usize; columns];
  let mut measure = |cells: &[Vec<Inline>]| {
    for (index, cell) in cells.iter().enumerate() {
      if index < columns {
        widths[index] = widths[index].max(cell_text(cell).chars().count());
      }
    }
  };
  measure(&table.header);
  for row in &table.rows {
    measure(row);
  }

  let line = |plan: &mut RenderPlan, cells: &[Vec<Inline>], style: StyleKind| {
    let start = plan.mark();
    for index in 0..columns {
      if index > 0 {
        plan.push(" │ ", StyleKind::Muted);
      }
      let content = cells.get(index).map(|cell| cell_text(cell)).unwrap_or_default();
      let padding = widths[index].saturating_sub(content.chars().count());
      plan.push(&content, style);
      for _ in 0..padding {
        plan.text.push(' ');
      }
    }
    plan.paragraphs.push(ParagraphRange {
      start,
      end: plan.position,
      indent_twips: 0,
      space_before_twips: 0,
    });
  };

  line(plan, &table.header, StyleKind::Bold);
  plan.newline();
  let separator: Vec<String> = widths.iter().map(|width| "─".repeat(*width)).collect();
  plan.push(&separator.join("─┼─"), StyleKind::Muted);
  for row in &table.rows {
    plan.newline();
    line(plan, row, StyleKind::Body);
  }
}

fn cell_text(cell: &[Inline]) -> String {
  cell.iter().map(Inline::plain).collect::<Vec<_>>().join("").replace('\n', " ")
}

fn write_inlines(plan: &mut RenderPlan, inlines: &[Inline], base: StyleKind) {
  for inline in inlines {
    match inline {
      Inline::Text { text, marks } => {
        let style = style_for(marks, base);
        let start = plan.mark();
        plan.push(text, style);
        if let Some(link) = &marks.link {
          plan.links.push(LinkRange { start, end: plan.mark(), href: link.href.clone() });
        }
      }
      Inline::Code { text, marks } => {
        let style = if style_for(marks, base) == StyleKind::Body {
          StyleKind::Code
        } else {
          style_for(marks, base)
        };
        let start = plan.mark();
        plan.push(text, style);
        if let Some(link) = &marks.link {
          plan.links.push(LinkRange { start, end: plan.mark(), href: link.href.clone() });
        }
      }
      Inline::HardBreak { .. } | Inline::SoftBreak { .. } => plan.newline(),
      Inline::Image { alt, marks, .. } => {
        let start = plan.mark();
        plan.push("[图片] ", StyleKind::Muted);
        plan.push(alt, StyleKind::Muted);
        if let Some(link) = &marks.link {
          plan.links.push(LinkRange { start, end: plan.mark(), href: link.href.clone() });
        }
      }
    }
  }
}

fn style_for(marks: &Marks, base: StyleKind) -> StyleKind {
  if base != StyleKind::Body {
    return base;
  }
  if marks.link.is_some() {
    StyleKind::Link
  } else if marks.bold {
    StyleKind::Bold
  } else if marks.italic {
    StyleKind::Italic
  } else if marks.strike {
    StyleKind::Strike
  } else {
    StyleKind::Body
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use vellora_md::parse;

  #[test]
  fn headings_and_bold_produce_style_ranges() {
    let plan = build(&parse("# Title\n\nsome **bold** text\n"));
    assert!(plan.styles.iter().any(|range| range.style == StyleKind::Heading1));
    assert!(plan.styles.iter().any(|range| range.style == StyleKind::Bold));
    assert!(plan.text.contains("Title"));
    assert!(plan.text.contains("bold"));
  }

  #[test]
  fn table_becomes_aligned_rows_not_markdown_pipes() {
    let plan = build(&parse("| a | b |\n| --- | --- |\n| 1 | 2 |\n"));
    assert!(plan.text.contains('│'), "{}", plan.text);
    assert!(plan.text.contains('a') && plan.text.contains('b'), "{}", plan.text);
    assert!(plan.text.contains("─┼"), "{}", plan.text);
    assert!(!plan.text.contains("| --- |"), "{}", plan.text);
  }

  #[test]
  fn links_record_their_character_range_and_target() {
    let plan = build(&parse("see [docs](./a.md) and [site](https://example.com)\n"));
    assert_eq!(plan.links.len(), 2, "{:?}", plan.links);
    assert_eq!(plan.links[0].href, "./a.md");
    let utf16: Vec<u16> = plan.text.encode_utf16().collect();
    let slice = String::from_utf16_lossy(&utf16[plan.links[0].start..plan.links[0].end]);
    assert_eq!(slice, "docs");
  }

  #[test]
  fn raw_source_stays_visible_as_source() {
    let plan = build(&parse("<div>raw</div>\n\nbody\n"));
    assert!(plan.text.contains("<div>raw</div>"), "{}", plan.text);
  }
}
