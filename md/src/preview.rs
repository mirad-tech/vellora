//! Read-only, allowlisted HTML/Markdown preview converted to native blocks.
//! Never use this tree for serialization. Source segments remain authoritative.
use std::cell::RefCell;
use html5ever::tokenizer::{BufferQueue, Token, TokenSink, TokenSinkResult, Tokenizer, TokenizerOpts, TagKind};
use pulldown_cmark::{Options, Parser};
use crate::model::{Alignment, Block, CellHeader, HeaderScope, Inline, Link, List, Marks, Table, push_text};

pub struct Preview { pub blocks: Vec<Block>, pub limited: bool }
pub struct PreviewContext { references: std::collections::HashMap<unicase::UniCase<String>, (String, String)>, limited: bool }
impl PreviewContext {
  pub fn new(document: &str) -> Self {
    let parser = Parser::new(document);
    let mut references = std::collections::HashMap::new();
    let mut bytes = 0usize;
    let mut limited = false;
    for (label, definition) in parser.reference_definitions().iter() {
      let title = definition.title.as_ref().map(|s| s.as_ref()).unwrap_or("");
      bytes = bytes.saturating_add(label.len() + definition.dest.len() + title.len());
      if bytes > 1024 * 1024 || definition.dest.len() > 16 * 1024 || title.len() > 16 * 1024 || references.len() >= 10_000 {
        limited = true; break;
      }
      references.insert(unicase::UniCase::new(label.split_whitespace().collect::<Vec<_>>().join(" ")),
        (definition.dest.to_string(), title.to_string()));
    }
    Self { references, limited }
  }

  pub fn render(&self, source: &str) -> Preview {
    if self.limited || source.len() > 1024 * 1024 { return Preview { blocks: Vec::new(), limited: true }; }
    let callback = |link: pulldown_cmark::BrokenLink<'_>| {
      let label = unicase::UniCase::new(link.reference.split_whitespace().collect::<Vec<_>>().join(" "));
      self.references.get(&label).map(|(href, title)| (href.clone().into(), title.clone().into()))
    };
    let mut html = BoundedHtml(String::new());
    // Match the legacy renderer: task markers remain ordinary [ ] / [x] text.
    if pulldown_cmark::html::write_html_fmt(&mut html,
      Parser::new_with_broken_link_callback(source, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH, Some(callback))).is_err() {
      return Preview { blocks: Vec::new(), limited: true };
    }
    let sink = Sink(RefCell::new(Tree::default()));
    let tokenizer = Tokenizer::new(sink, TokenizerOpts::default());
    let input = BufferQueue::default();
    input.push_back(html.0.into());
    let _ = tokenizer.feed(&input);
    tokenizer.end();
    let mut tree = tokenizer.sink.0.into_inner();
    if tree.limited { return Preview { blocks: Vec::new(), limited: true }; }
    while !tree.stack.is_empty() { tree.close(); }
    if !bounded_layout(&tree.root) || native_cost(&tree.root, 0) > 8 * 1024 * 1024 { return Preview { blocks: Vec::new(), limited: true }; }
    Preview { blocks: blocks(&tree.root), limited: false }
  }
}

struct BoundedHtml(String);
impl std::fmt::Write for BoundedHtml {
  fn write_str(&mut self, value: &str) -> std::fmt::Result {
    if self.0.len().saturating_add(value.len()) > 4 * 1024 * 1024 { return Err(std::fmt::Error); }
    self.0.push_str(value); Ok(())
  }
}

// Inline marks own their URLs; account for URL replication across descendant
// runs before allocating the native model, not just for input/HTML byte size.
fn native_cost(nodes: &[Node], link_bytes: usize) -> usize {
  let mut total = 0usize;
  for node in nodes {
    let link = if node.tag == "a" { node.attr("href").len() } else { link_bytes };
    total = total.saturating_add(256 + node.text.len() + link.saturating_mul(2));
    total = total.saturating_add(native_cost(&node.children, link));
    if total > 8 * 1024 * 1024 { break; }
  }
  total
}

#[derive(Default)]
struct Node { tag: String, text: String, attrs: Vec<(String, String)>, children: Vec<Node> }
impl Node {
  fn attr(&self, name: &str) -> &str {
    self.attrs.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str()).unwrap_or("")
  }
  fn text(&self) -> String {
    let mut text = self.text.clone();
    for node in &self.children { text.push_str(&node.text()); }
    text
  }
}
#[derive(Default)]
struct Tree { root: Vec<Node>, stack: Vec<Node>, suppressed: Vec<String>, count: usize, limited: bool }
impl Tree {
  fn push(&mut self, node: Node) {
    if let Some(parent) = self.stack.last_mut() { parent.children.push(node); }
    else { self.root.push(node); }
  }
  fn close(&mut self) { if let Some(node) = self.stack.pop() { self.push(node); } }
  fn implied_end(&mut self, targets: &[&str], boundaries: &[&str]) {
    if let Some(index) = self.stack.iter().rposition(|node| targets.contains(&node.tag.as_str()) || boundaries.contains(&node.tag.as_str())) {
      if targets.contains(&self.stack[index].tag.as_str()) {
        while self.stack.len() > index { self.close(); }
      }
    }
  }
}
struct Sink(RefCell<Tree>);
impl TokenSink for Sink {
  type Handle = ();
  fn process_token(&self, token: Token, _: u64) -> TokenSinkResult<()> {
    let mut tree = self.0.borrow_mut();
    tree.count += 1;
    if tree.count > 100_000 || tree.stack.len() > 64 || tree.suppressed.len() > 64 { tree.limited = true; }
    if tree.limited { return TokenSinkResult::Continue; }
    match token {
      Token::TagToken(tag) => {
        let name = tag.name.to_string();
        let dangerous = matches!(name.as_str(), "script"|"style"|"iframe"|"object"|"embed"|"svg"|"math"|"template"|"noscript"|"textarea"|"title"|"xmp"|"plaintext");
        if !tree.suppressed.is_empty() {
          if tag.kind == TagKind::EndTag && tree.suppressed.last() == Some(&name) { tree.suppressed.pop(); }
          else if tag.kind == TagKind::StartTag && dangerous && !tag.self_closing && name != "embed" { tree.suppressed.push(name); }
          return TokenSinkResult::Continue;
        }
        if dangerous {
          if tag.kind == TagKind::StartTag && !tag.self_closing && name != "embed" { tree.suppressed.push(name); }
          return TokenSinkResult::Continue;
        }
        if tag.kind == TagKind::EndTag {
          if let Some(index) = tree.stack.iter().rposition(|node| node.tag == name) {
            while tree.stack.len() > index { tree.close(); }
          }
        } else {
          // Common optional end tags, without browser layout or script semantics.
          if matches!(name.as_str(), "p"|"div"|"section"|"h1"|"h2"|"h3"|"h4"|"h5"|"h6"|"ul"|"ol"|"table"|"blockquote"|"pre") {
            tree.implied_end(&["p"], &["div", "section", "blockquote", "li", "td", "th"]);
          }
          match name.as_str() {
            "li" => tree.implied_end(&["li"], &["ul", "ol"]),
            "tr" => tree.implied_end(&["tr"], &["table"]),
            "td"|"th" => tree.implied_end(&["td", "th"], &["tr", "table"]),
            _ => {}
          }
          let node = Node { tag: name.clone(), attrs: tag.attrs.into_iter()
            .filter(|a| matches!(a.name.local.as_ref(), "href"|"src"|"title"|"alt"|"start"|"align"|"colspan"|"rowspan"|"scope"|"class"))
            .map(|a| (a.name.local.to_string(), a.value.to_string())).collect(), ..Node::default() };
          if tag.self_closing || matches!(name.as_str(), "br"|"hr"|"img"|"input"|"meta"|"link"|"wbr") { tree.push(node); }
          else { tree.stack.push(node); }
        }
      }
      Token::CharacterTokens(text) if tree.suppressed.is_empty() => tree.push(Node { text: text.to_string(), ..Node::default() }),
      _ => {}
    }
    TokenSinkResult::Continue
  }
}

// Keep resource resolution behind the existing core APIs. Even preview metadata
// must not contain active non-HTTP protocols or remote/protocol-relative images.
fn safe_target(value: &str, image: bool) -> bool {
  let value = value.trim();
  if value.is_empty() || value.chars().any(char::is_control) || value.starts_with("//") || value.starts_with('\\') { return false; }
  if let Some((scheme, _)) = value.split_once(':') {
    return !image && (scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https"));
  }
  !value.starts_with('/')
}
fn collapse(text: &str) -> String {
  let mut out = String::new(); let mut space = false;
  for ch in text.chars() {
    if matches!(ch, ' '|'\n'|'\r'|'\t'|'\u{c}') { if !space { out.push(' '); } space = true; }
    else { out.push(ch); space = false; }
  }
  out
}
fn inlines(nodes: &[Node], marks: &Marks) -> Vec<Inline> {
  let mut out = Vec::new();
  for node in nodes {
    let mut marks = marks.clone();
    match node.tag.as_str() {
      "" => push_text(&mut out, &collapse(&node.text), &marks),
      "br" => out.push(Inline::HardBreak { marks }),
      "strong"|"b" => { marks.bold = true; out.extend(inlines(&node.children, &marks)); }
      "em"|"i" => { marks.italic = true; out.extend(inlines(&node.children, &marks)); }
      "del"|"s" => { marks.strike = true; out.extend(inlines(&node.children, &marks)); }
      "code" => out.push(Inline::Code { text: node.text(), marks }),
      "a" => {
        if safe_target(node.attr("href"), false) { marks.link = Some(Link { href: node.attr("href").to_string(), title: title(node), reference: None }); }
        out.extend(inlines(&node.children, &marks));
      }
      "img" => {
        if safe_target(node.attr("src"), true) {
          out.push(Inline::Image { src: node.attr("src").into(), alt: node.attr("alt").into(), title: title(node), marks, alt_source: None, reference: None });
        } else { push_text(&mut out, node.attr("alt"), &marks); }
      }
      _ => out.extend(inlines(&node.children, &marks)),
    }
  }
  out
}
fn title(node: &Node) -> Option<String> {
  if node.attr("title").is_empty() { None } else { Some(node.attr("title").into()) }
}
fn flush(nodes: &mut Vec<&Node>, out: &mut Vec<Block>) {
  let mut runs = Vec::new();
  for node in nodes.drain(..) { runs.extend(inlines(std::slice::from_ref(node), &Marks::default())); }
  if runs.iter().any(|run| !run.plain().trim().is_empty() || matches!(run, Inline::Image { .. }|Inline::HardBreak { .. })) {
    out.push(Block::Paragraph(runs));
  }
}
fn blocks(nodes: &[Node]) -> Vec<Block> {
  let mut out = Vec::new(); let mut pending = Vec::new();
  for node in nodes {
    let tag = node.tag.as_str();
    if !matches!(tag, "p"|"div"|"section"|"h1"|"h2"|"h3"|"h4"|"h5"|"h6"|"blockquote"|"ul"|"ol"|"pre"|"hr"|"table") {
      pending.push(node); continue;
    }
    flush(&mut pending, &mut out);
    match tag {
      "p" => out.push(Block::Paragraph(inlines(&node.children, &Marks::default()))),
      "h1"|"h2"|"h3"|"h4"|"h5"|"h6" => out.push(Block::Heading { level: tag.as_bytes()[1] - b'0', content: inlines(&node.children, &Marks::default()) }),
      "div"|"section" => out.extend(blocks(&node.children)),
      "blockquote" => out.push(Block::BlockQuote(blocks(&node.children))),
      "ul"|"ol" => out.push(Block::List(List { ordered: tag == "ol", start: node.attr("start").parse().unwrap_or(1), delimiter: '.',
        tasks: node.children.iter().filter(|n| n.tag == "li").map(|_| None).collect(), loose: false,
        items: node.children.iter().filter(|n| n.tag == "li").map(|n| blocks(&n.children)).collect() })),
      "pre" => {
        let code = node.children.iter().find(|n| n.tag == "code");
        let language = code.and_then(|n| n.attr("class").split_whitespace().find_map(|c| c.strip_prefix("language-").map(str::to_string)));
        let text = node.text().strip_suffix('\n').unwrap_or(&node.text()).to_string();
        out.push(Block::CodeBlock { language, text });
      }
      "hr" => out.push(Block::HorizontalRule),
      "table" => out.push(table(node)),
      _ => {}
    }
  }
  flush(&mut pending, &mut out); out
}
fn table(node: &Node) -> Block {
  fn rows<'a>(nodes: &'a [Node], out: &mut Vec<&'a Node>) {
    for node in nodes { if node.tag == "tr" { out.push(node); } else if matches!(node.tag.as_str(), "thead"|"tbody"|"tfoot") { rows(&node.children, out); } }
  }
  let mut source_rows = Vec::new(); rows(&node.children, &mut source_rows);
  let mut values: Vec<Vec<Vec<Inline>>> = source_rows.iter().map(|row| row.children.iter()
    .filter(|n| matches!(n.tag.as_str(), "th"|"td")).map(|n| inlines(&n.children, &Marks::default())).collect()).collect();
  let header = if values.is_empty() { Vec::new() } else { values.remove(0) };
  let spans = source_rows.iter().map(|row| row.children.iter().filter(|n| matches!(n.tag.as_str(), "th"|"td"))
    .map(|n| (n.attr("colspan").parse::<usize>().unwrap_or(1).clamp(1, 1000),
      cell_rowspan(n, row, &node.children))).collect()).collect();
  let header_is_body = source_rows.first().is_some_and(|row| !row.children.iter().any(|n| n.tag == "th"));
  let cell_headers = source_rows.iter().map(|row| row.children.iter()
    .filter(|n| matches!(n.tag.as_str(), "th"|"td"))
    .map(|cell| CellHeader {
      header: cell.tag == "th",
      scope: match cell.attr("scope").to_ascii_lowercase().as_str() {
        ""|"auto" => HeaderScope::Auto, "row" => HeaderScope::Row, "col" => HeaderScope::Column,
        "rowgroup" => HeaderScope::RowGroup, "colgroup" => HeaderScope::ColumnGroup,
        _ => HeaderScope::Unknown,
      },
    }).collect()).collect();
  let align = source_rows.first().map(|row| row.children.iter().filter(|n| matches!(n.tag.as_str(), "td"|"th"))
    .map(|cell| match cell.attr("align").to_ascii_lowercase().as_str() {
      "left" => Alignment::Left, "center" => Alignment::Center, "right" => Alignment::Right, _ => Alignment::None
    }).collect()).unwrap_or_default();
  Block::Table(Table { align, header, rows: values, spans, cell_headers, header_is_body })
}

// HTML rowspans cannot cross row-group boundaries; zero means the rest of the
// current group. Keep that semantic explicit in the normalized preview plan.
fn cell_rowspan(cell: &Node, row: &Node, nodes: &[Node]) -> usize {
  fn remaining(nodes: &[Node], row: &Node) -> Option<usize> {
    if let Some(index) = nodes.iter().position(|node| std::ptr::eq(node, row)) {
      return Some(nodes[index..].iter().filter(|node| node.tag == "tr").count().max(1));
    }
    nodes.iter().find_map(|node| remaining(&node.children, row))
  }
  let available = remaining(nodes, row).unwrap_or(1);
  match cell.attr("rowspan").parse::<usize>().unwrap_or(1) {
    0 => available,
    value => value.clamp(1, available),
  }
}

// Bound native table allocation before publishing a plan. Over-limit content
// remains editable as its original source instead of silently losing cells.
fn bounded_layout(nodes: &[Node]) -> bool {
  for node in nodes {
    if node.tag == "table" {
      fn collect<'a>(nodes: &'a [Node], rows: &mut Vec<&'a Node>) {
        for node in nodes {
          if node.tag == "tr" { rows.push(node); }
          else if matches!(node.tag.as_str(), "thead"|"tbody"|"tfoot") { collect(&node.children, rows); }
        }
      }
      let mut rows = Vec::new(); collect(&node.children, &mut rows);
      if rows.len() > 256 { return false; }
      let mut occupied = vec![0usize; 256];
      let mut columns = 0usize;
      for row in &rows {
        let mut cursor = 0usize;
        for cell in row.children.iter().filter(|n| matches!(n.tag.as_str(), "td"|"th")) {
          let colspan = cell.attr("colspan").parse::<usize>().unwrap_or(1).max(1);
          let rowspan = cell_rowspan(cell, row, &node.children);
          if colspan > 256 { return false; }
          while cursor + colspan <= 256 && occupied[cursor..cursor+colspan].iter().any(|v| *v > 0) { cursor += 1; }
          if cursor + colspan > 256 { return false; }
          for entry in &mut occupied[cursor..cursor+colspan] { *entry = rowspan; }
          cursor += colspan;
          columns = columns.max(cursor);
        }
        for entry in &mut occupied { *entry = entry.saturating_sub(1); }
      }
      if rows.len().saturating_mul(columns) > 10_000 { return false; }
    }
    if !bounded_layout(&node.children) { return false; }
  }
  true
}

#[cfg(test)]
mod tests {
  use super::*;
  fn render(source: &str) -> Vec<Block> { PreviewContext::new(source).render(source).blocks }

  #[test]
  fn native_html_preview_supports_headings_marks_links_and_code_without_css() {
    let source = "<section style='position:fixed' onclick='evil()'><h2>Title &amp; text</h2><p><strong>bold</strong> <a href='https://example.com' title='safe'>link</a></p><pre><code class='language-rust'>let x = &lt;1&gt;;\n</code></pre></section>";
    let blocks = render(source);
    assert!(matches!(&blocks[0], Block::Heading { level: 2, .. }));
    assert_eq!(blocks[0].plain_text(), "Title & text");
    let Block::Paragraph(runs) = &blocks[1] else { panic!("paragraph"); };
    assert!(runs.iter().any(|run| run.marks().bold));
    assert!(runs.iter().any(|run| run.marks().link.as_ref().is_some_and(|link| link.href == "https://example.com")));
    assert!(matches!(&blocks[2], Block::CodeBlock { language: Some(language), text } if language == "rust" && text == "let x = <1>;"));
  }

  #[test]
  fn script_style_embeds_and_unsafe_urls_cannot_enter_native_preview() {
    let blocks = render("<div><script>alert(1)</script><style>evil</style><svg><text>hidden</text></svg><p><a href='jav&#x61;script:alert(1)'>visible</a><img src='https://remote/x' alt='remote'><img src='image.png' onerror='bad()' alt='local'></p></div>");
    let text = blocks.iter().map(Block::plain_text).collect::<String>();
    assert!(!text.contains("alert") && !text.contains("evil") && !text.contains("hidden"));
    let Block::Paragraph(runs) = &blocks[0] else { panic!("paragraph"); };
    assert!(runs.iter().all(|run| run.marks().link.is_none()));
    assert_eq!(runs.iter().filter(|run| matches!(run, Inline::Image { .. })).count(), 1);
    assert!(runs.iter().any(|run| matches!(run, Inline::Image { src, .. } if src == "image.png")));
  }

  #[test]
  fn reference_context_resolves_titles_and_images_without_rendering_definitions() {
    let context = PreviewContext::new("[REF]: https://example.com 'Title'\n[pic]: local.png\n");
    let preview = context.render("# [Heading][ref]\n\n![alt][pic]");
    assert_eq!(preview.blocks.len(), 2);
    let Block::Heading { content, .. } = &preview.blocks[0] else { panic!("heading"); };
    assert_eq!(content[0].marks().link.as_ref().unwrap().title.as_deref(), Some("Title"));
    assert!(matches!(&preview.blocks[1], Block::Paragraph(runs) if matches!(&runs[0], Inline::Image { src, .. } if src == "local.png")));
    assert!(context.render("[REF]: https://example.com 'Title'").blocks.is_empty());
  }

  #[test]
  fn native_tables_expose_spans_and_body_only_first_row() {
    let blocks = render("<table><tr><td colspan='2' rowspan='2'>wide</td><td>right</td></tr><tr><td>bottom</td></tr></table>");
    let Block::Table(table) = &blocks[0] else { panic!("table"); };
    assert!(table.header_is_body);
    assert_eq!(table.spans[0], vec![(2,2),(1,1)]);
    assert_eq!(table.spans[1], vec![(1,1)]);
    let groups = render("<table><thead><tr><th rowspan='2'>head</th></tr></thead><tbody><tr><td rowspan='0'>body</td></tr><tr><td>end</td></tr></tbody></table>");
    let Block::Table(groups) = &groups[0] else { panic!("table"); };
    assert_eq!(groups.spans[0][0], (1,1));
    assert_eq!(groups.spans[1][0], (1,2));
  }

  #[test]
  fn common_optional_end_tags_and_alignment_are_supported() {
    let list = render("<ul><li>one<li>two</ul>");
    assert!(matches!(&list[0], Block::List(list) if list.items.len() == 2));
    let table = render("<table><tr><th align='right'>A<th>B<tr><td>1<td>2</table>");
    let Block::Table(table) = &table[0] else { panic!("table"); };
    assert_eq!(table.header.len(), 2);
    assert_eq!(table.rows[0].len(), 2);
    assert_eq!(table.align[0], Alignment::Right);
  }

  #[test]
  fn table_headers_keep_authored_cell_tags_and_scope() {
    let blocks = render("<table><tr><th scope='COL'>column</th><td>data</td></tr><tr><th scope='Row' rowspan='2'>row</th><td>value</td></tr><tr><th scope='bogus'>unknown</th><th scope='colgroup'>group</th></tr></table>");
    let Block::Table(table) = &blocks[0] else { panic!("table"); };
    assert_eq!(table.cell_headers[0], vec![CellHeader { header: true, scope: HeaderScope::Column }, CellHeader { header: false, scope: HeaderScope::Auto }]);
    assert_eq!(table.cell_headers[1][0], CellHeader { header: true, scope: HeaderScope::Row });
    assert_eq!(table.spans[1][0], (1, 2));
    assert_eq!(table.cell_headers[2][0].scope, HeaderScope::Unknown);
    assert_eq!(table.cell_headers[2][1].scope, HeaderScope::ColumnGroup);
    let source = "<table><tr><th scope='row'>kept</th><td>data</td></tr></table>\r\n";
    assert_eq!(crate::splice_markdown(source, &[]).unwrap(), source);
  }

  #[test]
  fn excessive_depth_size_and_table_allocation_fall_back_to_source() {
    let context = PreviewContext::new("");
    assert!(context.render(&format!("{}x{}", "<div>".repeat(80), "</div>".repeat(80))).limited);
    assert!(context.render(&"x".repeat(1024*1024+1)).limited);
    assert!(context.render("<table><tr><td colspan='9999'>x</td></tr></table>").limited);
  }

  #[test]
  fn reference_and_intermediate_output_amplification_are_bounded() {
    use std::fmt::Write;
    let context = PreviewContext::new(&format!("[r]: https://example.com/{}", "x".repeat(20_000)));
    assert!(context.render("[link][r]").limited);
    let mut html = BoundedHtml(String::new());
    assert!(html.write_str(&"x".repeat(4 * 1024 * 1024)).is_ok());
    assert!(html.write_str("x").is_err());
    let source = format!("<a href='https://example.com/{}'>{}</a>", "x".repeat(4000), "<span>x</span>".repeat(2000));
    assert!(PreviewContext::new("").render(&source).limited);
  }

  #[test]
  fn task_markers_and_raw_html_remain_source_owned() {
    let source = "- [ ] task\n- [x] done\n";
    assert!(matches!(&render(source)[0], Block::List(_)));
    assert_eq!(crate::splice_markdown(source, &[]).unwrap(), source);
    let source = "<h1 onclick='evil()'>Hello</h1>\r\n";
    assert_eq!(crate::splice_markdown(source, &[]).unwrap(), source);
  }

  #[test]
  fn task_preview_preserves_inline_code_bold_and_link_contract() {
    let source = "- [ ] 中文 `Ctrl+F` **重点** [链接](https://example.com/docs \"说明\")\r\n- [x] done\r\n";
    let preview = PreviewContext::new(source).render(source);
    assert!(!preview.limited);
    assert_eq!(preview.blocks.len(), 1);
    let Block::List(list) = &preview.blocks[0] else { panic!("task preview must remain a list"); };
    assert!(!list.ordered);
    assert_eq!(list.items.len(), 2);
    let Block::Paragraph(runs) = &list.items[0][0] else { panic!("task paragraph"); };
    assert!(runs.iter().any(|run| matches!(run, Inline::Code { text, .. } if text == "Ctrl+F")));
    assert!(runs.iter().any(|run| run.plain() == "重点" && run.marks().bold));
    assert!(runs.iter().any(|run| run.plain() == "链接" && run.marks().link.as_ref().is_some_and(|link|
      link.href == "https://example.com/docs" && link.title.as_deref() == Some("说明"))));
    assert!(list.items[0][0].plain_text().starts_with("[ ] 中文 "));
    assert!(list.items[1][0].plain_text().starts_with("[x] done"));
    let document = crate::parse(source);
    assert!(matches!(&document.segments[0].block, Block::List(list) if list.tasks.iter().any(Option::is_some)));
    assert_eq!(document.segments.iter().map(|segment| segment.source.as_str()).collect::<String>(), source);
    assert_eq!(crate::splice_markdown(source, &[]).unwrap().as_bytes(), source.as_bytes());
  }

  #[test]
  fn task_preview_keeps_three_quote_levels_without_rewriting_source() {
    let task = "- [ ] task 😀\r\n  > outer\r\n  >\r\n  > > middle\r\n  > >\r\n  > > > inner `code` **bold**\r\n";
    let preview = PreviewContext::new(task).render(task);
    assert!(!preview.limited);
    let Block::List(list) = &preview.blocks[0] else { panic!("task list"); };
    let Block::BlockQuote(outer) = &list.items[0][1] else { panic!("first quote level"); };
    assert_eq!(outer[0].plain_text(), "outer");
    let Block::BlockQuote(middle) = &outer[1] else { panic!("second quote level"); };
    assert_eq!(middle[0].plain_text(), "middle");
    let Block::BlockQuote(inner) = &middle[1] else { panic!("third quote level"); };
    assert_eq!(inner.len(), 1);
    let Block::Paragraph(runs) = &inner[0] else { panic!("inner paragraph"); };
    assert!(runs.iter().any(|run| matches!(run, Inline::Code { text, .. } if text == "code")));
    assert!(runs.iter().any(|run| run.plain() == "bold" && run.marks().bold));
    let source = format!("{task}\r\nTail\r\n");
    let document = crate::parse(&source);
    assert!(matches!(&document.segments[0].block, Block::List(list) if list.tasks.iter().any(Option::is_some)));
    assert_eq!(crate::splice_markdown(&source, &[]).unwrap(), source);
    let last = document.segments.len() - 1;
    assert_eq!(document.segments[last].source, "Tail\r\n");
    let changed = crate::splice_markdown(&source, &[(last, "Changed".into())]).unwrap();
    assert_eq!(changed, format!("{task}\r\nChanged\r\n"));
  }

}
