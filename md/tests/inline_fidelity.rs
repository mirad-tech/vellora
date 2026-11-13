use vellora_md::{parse, to_markdown, Block, Inline};

#[test]
fn image_alt_keeps_emphasis_code_breaks_and_original_spelling_after_neighbor_edit() {
  for (source, expected) in [
    ("before ![plain **bold** tail](missing.png) after\n", "plain bold tail"),
    ("before ![前缀 *重点* **重要** `code` 后缀](missing.png) after\n", "前缀 重点 重要 code 后缀"),
    ("before ![first\nsecond](missing.png) after\n", "first second"),
  ] {
    let mut doc = parse(source);
    let Block::Paragraph(runs) = &mut doc.segments[0].block else { panic!("ordinary editable paragraph: {source}"); };
    let alt = runs.iter().find_map(|run| match run { Inline::Image { alt, .. } => Some(alt.clone()), _ => None }).unwrap();
    assert_eq!(alt, expected);
    let Inline::Text { text, .. } = &mut runs[0] else { panic!(); };
    text.insert_str(0, "EDIT ");
    assert_eq!(to_markdown(&doc, "\n"), format!("EDIT {}", source.trim_end()));
  }
}

#[test]
fn reference_links_are_structured_and_keep_definition_after_neighbor_edit() {
  for spelling in ["[shown][Ref]", "[Ref][]", "[Ref]", "[**bold** and *italic*][Ref]"] {
    let source = format!("before {spelling} after\n\n[Ref]: https://example.com/ \"title\"\n");
    let mut doc = parse(&source);
    let Block::Paragraph(runs) = &mut doc.segments[0].block else { panic!("reference paragraph must be editable: {spelling}"); };
    assert!(runs.iter().any(|run| run.marks().link.as_ref().is_some_and(|l| l.href == "https://example.com/")));
    let Inline::Text { text, .. } = &mut runs[0] else { panic!(); };
    text.insert_str(0, "EDIT ");
    let output = to_markdown(&doc, "\n");
    assert!(output.contains(spelling), "{output}");
    assert!(output.ends_with("[Ref]: https://example.com/ \"title\"\n"));
  }
}

#[test]
fn reference_images_keep_reference_and_formatted_alt() {
  let source = "before ![**picture**][image] after\n\n[image]: sample.png \"title\"\n";
  let mut doc = parse(source);
  let Block::Paragraph(runs) = &mut doc.segments[0].block else { panic!("reference image paragraph must be editable"); };
  assert!(runs.iter().any(|run| matches!(run, Inline::Image { alt, .. } if alt == "picture")));
  let Inline::Text { text, .. } = &mut runs[0] else { panic!(); }; text.insert_str(0, "EDIT ");
  assert!(to_markdown(&doc, "\n").contains("![**picture**][image]"));
}

#[test]
fn editing_shortcut_and_collapsed_labels_keeps_original_reference_target() {
  for spelling in ["[Ref]", "[Ref][]"] {
    let source = format!("{spelling}\n\n[Ref]: https://example.com/\n");
    let mut doc = parse(&source);
    let Block::Paragraph(runs) = &mut doc.segments[0].block else { panic!(); };
    let Inline::Text { text, .. } = &mut runs[0] else { panic!(); }; *text = "Renamed".into();
    let output = to_markdown(&doc, "\n");
    assert!(output.starts_with("[Renamed][Ref]"), "{output}");
    let mut reparsed = parse(&output);
    // Canonical separation before a verbatim definition may add a blank line;
    // compare the edited paragraph semantics, and retain definition bytes below.
    doc.segments.truncate(1); reparsed.segments.truncate(1);
    assert!(doc.content_eq(&reparsed), "{output}");
    assert!(output.ends_with("[Ref]: https://example.com/\n"));
  }
}

#[test]
fn alt_changes_do_not_restore_stale_original_alt_source() {
  let mut doc = parse("![**old**](sample.png)\n");
  let Block::Paragraph(runs) = &mut doc.segments[0].block else { panic!(); };
  let Inline::Image { alt, .. } = &mut runs[0] else { panic!(); }; *alt = "new [label]".into();
  assert_eq!(to_markdown(&doc, "\n"), "![new \\[label\\]](sample.png)");
}

#[test]
fn escaped_nested_and_code_brackets_in_image_alt_remain_exact() {
  for alt in [r"a \] b", "`[code]` and **bold**", "a [bracket] b", "outer ![inner](other.png)"] {
    let source = format!("before ![{alt}](sample.png) after\n");
    let mut doc = parse(&source);
    let Block::Paragraph(runs) = &mut doc.segments[0].block else { panic!("{source}"); };
    let Inline::Text { text, .. } = &mut runs[0] else { panic!(); }; text.insert_str(0, "EDIT ");
    assert_eq!(to_markdown(&doc, "\n"), format!("EDIT {}", source.trim_end()));
  }
}

#[test]
fn reference_metadata_preserves_occurrences_and_not_semantic_position() {
  let source = "[**one** two][MiXeD label] [three][MiXeD label]\r\n\r\n[MiXeD label]: https://example.com/ \"t\"\r\n";
  let mut doc = parse(source);
  assert_eq!(to_markdown(&doc, "\r\n"), source);
  let Block::Paragraph(runs) = &mut doc.segments[0].block else { panic!(); };
  let ids: Vec<_> = runs.iter().filter_map(|run| run.marks().link.as_ref()?.reference.as_ref().map(|r| r.source_id)).collect();
  assert_eq!(ids[0], ids[1]); assert_ne!(ids[0], *ids.last().unwrap());
  let Inline::Text { text, .. } = &mut runs[0] else { panic!(); }; text.push('!');
  let output = to_markdown(&doc, "\r\n");
  assert!(output.contains("[three][MiXeD label]"));
  assert!(output.ends_with("[MiXeD label]: https://example.com/ \"t\"\r\n"));
  let mut reparsed = parse(&output); doc.segments.truncate(1); reparsed.segments.truncate(1);
  assert!(doc.content_eq(&reparsed), "{output}");
}
