use vellora_md::{parse, to_markdown, Block, Inline};

#[test]
fn task_markers_align_with_mixed_items_and_preserve_original_bytes() {
  let source = "\r\n- [ ] todo\r\n- [x] done\r\n- [X] upper\r\n- ordinary\r\n\r\nTail\r\n";
  let doc = parse(source);
  let Block::List(list) = &doc.segments[0].block else { panic!("structured list"); };
  assert_eq!(list.tasks, vec![Some(false), Some(true), Some(true), None]);
  assert_eq!(list.tasks.len(), list.items.len());
  assert_eq!(to_markdown(&doc, "\r\n"), source);
  let plain = doc.plain_text();
  for text in ["todo", "done", "upper", "ordinary", "Tail"] { assert!(plain.contains(text)); }
  assert!(!plain.contains("[x]"));
}

#[test]
fn edited_tasks_roundtrip_nested_lists_code_links_and_loose_separators() {
  let source = "3) [ ] parent **bold** [link](https://example.com)\n\n   second paragraph\n\n   - [X] nested `code`\n   - normal\n\n   ```rust\n   let x = 1;\n   ```\n\n4) [x] done\n\nuntouched *spelling*\n";
  let mut doc = parse(source);
  let Block::List(list) = &mut doc.segments[0].block else { panic!("structured list"); };
  assert!(list.loose);
  assert_eq!(list.tasks, vec![Some(false), Some(true)]);
  list.tasks[0] = Some(true);
  let Block::Paragraph(runs) = &mut list.items[0][0] else { panic!("paragraph"); };
  let Inline::Text { text, .. } = &mut runs[0] else { panic!("text"); };
  text.insert_str(0, "EDIT ");
  let output = to_markdown(&doc, "\n");
  assert!(output.starts_with("3) [x] EDIT parent"), "{output}");
  assert!(output.contains("\n\n4) [x] done"), "{output}");
  assert!(output.ends_with("untouched *spelling*\n"), "{output}");
  assert!(output.contains("[link](https://example.com)"));
  let parsed = parse(&output);
  assert!(doc.content_eq(&parsed), "{output}\n{:#?}\n{:#?}", doc, parsed);
  assert!(parsed.plain_text().contains("let x = 1;"));
  assert!(parsed.plain_text().contains("nested code"));
}

#[test]
fn task_state_participates_in_content_equality_and_source_digest() {
  let original = parse("- [X] done\n");
  let mut changed = original.clone();
  let Block::List(list) = &mut changed.segments[0].block else { panic!(); };
  list.tasks[0] = Some(false);
  assert!(!original.content_eq(&changed));
  assert!(!changed.segments[0].source_is_current());
  assert!(to_markdown(&changed, "\n").starts_with("- [ ] done"));
}

#[test]
fn unsupported_task_children_remain_verbatim_raw() {
  for source in ["- [ ] <span>HTML</span>\n"] {
    let doc = parse(source);
    assert!(matches!(doc.segments[0].block, Block::RawSource(_)));
    assert_eq!(to_markdown(&doc, "\n"), source);
  }
}

#[test]
fn reference_task_children_are_structured_and_preserve_source() {
  let source = "- [x] [reference][id]\n\n[id]: https://example.com\n";
  let doc = parse(source);
  assert!(matches!(doc.segments[0].block, Block::List(_)));
  assert_eq!(to_markdown(&doc, "\n"), source);
}

#[test]
fn tight_task_leading_marks_and_adjacent_transitions_roundtrip() {
  for body in ["**bold** `code` end", "**nested *marks***", "**a*b***", "***a*b**", "**a***b*", "*a***b**", "~~a**b**~~", "[link](https://example.com) text"] {
    let source = format!("- [ ] {body}\n");
    let mut doc = parse(&source);
    assert!(!doc.plain_text().trim().is_empty(), "{source}");
    doc.segments[0].mark_dirty();
    let output = to_markdown(&doc, "\n");
    assert!(doc.content_eq(&parse(&output)), "input={source}\noutput={output}");
  }
  for (left, right) in [(1, 2), (2, 1), (1, 3), (3, 1), (2, 3), (3, 2)] {
    let mut doc = parse("- [ ] placeholder\n");
    let Block::List(list) = &mut doc.segments[0].block else { panic!(); };
    list.items[0][0] = Block::Paragraph([(left, "a"), (right, "b")].into_iter().map(|(flags, text)| {
      Inline::Text { text: text.into(), marks: vellora_md::Marks { bold: flags & 1 != 0, italic: flags & 2 != 0, ..Default::default() } }
    }).collect());
    let output = to_markdown(&doc, "\n");
    assert!(doc.content_eq(&parse(&output)), "flags={left}/{right}, {output}");
  }
}
