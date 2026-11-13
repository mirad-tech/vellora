//! Source locations for native headings. Positions come from Markdown offsets
//! and HTML tag boundaries, never a search for the rendered heading text.
use pulldown_cmark::{Event, Options, Parser, Tag};

pub fn heading_offsets(source: &str) -> Vec<(u8, usize)> {
  let mut result = Vec::new();
  let mut html = HtmlOffsets::default();
  for (event, range) in Parser::new_ext(source, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH).into_offset_iter() {
    match event {
      Event::Start(Tag::Heading { level, .. }) => result.push((level as u8, range.start)),
      Event::Html(text) | Event::InlineHtml(text) => html.feed(&text, range.start, &mut result),
      _ => {}
    }
  }
  result.sort_by_key(|(_, offset)| *offset);
  result
}

#[derive(Default)]
struct HtmlOffsets { pending: String, start: usize, quote: Option<char>, stack: Vec<String>, suppressed: Vec<String> }
impl HtmlOffsets {
  fn feed(&mut self, text: &str, base: usize, result: &mut Vec<(u8, usize)>) {
    for (offset, ch) in text.char_indices() {
      if self.pending.is_empty() {
        if ch == '<' { self.start = base + offset; self.pending.push(ch); }
        continue;
      }
      self.pending.push(ch);
      if self.pending.starts_with("<!--") {
        if self.pending.ends_with("-->") { self.pending.clear(); }
        continue;
      }
      if let Some(quote) = self.quote {
        if ch == quote { self.quote = None; }
        continue;
      }
      if ch == '\'' || ch == '"' { self.quote = Some(ch); continue; }
      if ch != '>' { continue; }
      let token = std::mem::take(&mut self.pending);
      let inner = &token[1..token.len()-1];
      let closing = inner.starts_with('/');
      let name = inner.trim_start_matches('/').split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("").to_ascii_lowercase();
      let dangerous = matches!(name.as_str(), "script"|"style"|"iframe"|"object"|"embed"|"svg"|"math"|"template"|"noscript"|"textarea"|"title"|"xmp"|"plaintext");
      let self_closing = inner.trim_end().ends_with('/');
      if !self.suppressed.is_empty() {
        if closing && self.suppressed.last() == Some(&name) { self.suppressed.pop(); }
        else if !closing && dangerous && !self_closing && name != "embed" { self.suppressed.push(name); }
        continue;
      }
      if dangerous {
        if !closing && !self_closing && name != "embed" { self.suppressed.push(name); }
        continue;
      }
      if closing {
        if let Some(index) = self.stack.iter().rposition(|tag| tag == &name) { self.stack.truncate(index); }
        continue;
      }
      let blocked = self.stack.iter().any(|tag| matches!(tag.as_str(), "script"|"style"|"iframe"|"object"|"svg"|"math"|"template"|"noscript"|"textarea"|"title"|"xmp"|"plaintext"|"pre"|"code"|"table"));
      if !blocked && name.len() == 2 && name.starts_with('h') && matches!(name.as_bytes()[1], b'1'..=b'6') {
        result.push((name.as_bytes()[1]-b'0', self.start));
      }
      if !inner.trim_end().ends_with('/') && !matches!(name.as_str(), "br"|"hr"|"img"|"input"|"meta"|"link"|"wbr"|"embed") { self.stack.push(name); }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn offsets_are_markers_not_display_text_searches() {
    let source = "same title\n\n> ## **same** title\n\n- ### 嵌套😀\n\n<div><h2 title='>'>HTML😀</h2><!-- <h1>hidden</h1> --><script><h1>hidden</h1></script><h3>next</h3></div>\n";
    let offsets = heading_offsets(source);
    assert_eq!(offsets.iter().map(|(level,_)| *level).collect::<Vec<_>>(), vec![2,3,2,3]);
    assert!(source[offsets[0].1..].starts_with("##"));
    assert!(source[offsets[1].1..].starts_with("###"));
    assert!(source[offsets[2].1..].starts_with("<h2"));
    assert!(source[offsets[3].1..].starts_with("<h3"));
  }
}
