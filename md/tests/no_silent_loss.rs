//! Regression: parsing must never drop authored content without a RawSource fallback.

use vellora_md::{parse, Block};

#[test]
fn heading_after_text_in_tight_list_item_is_kept() {
  for source in ["- foo\n  # bar\n", "- **foo**\n  # bar\n", "1. foo\n   ## bar\n", "> - foo\n>   # bar\n"] {
    let document = parse(source);
    assert!(document.plain_text().contains("bar"), "heading dropped for {source:?}: {document:?}");
    let joined: String = document.segments.iter().map(|segment| segment.source.as_str()).collect();
    assert_eq!(joined, source, "segment sources must still cover the file");
  }
}

#[test]
fn heading_in_tight_item_follows_its_paragraph() {
  let document = parse("- foo\n  # bar\n");
  let Block::List(list) = &document.segments[0].block else {
    panic!("expected a list, got {document:?}");
  };
  assert!(
    matches!(list.items[0].as_slice(), [Block::Paragraph(_), Block::Heading { level: 1, .. }]),
    "{:?}",
    list.items[0]
  );
}
