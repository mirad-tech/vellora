//! Segment splicing is what keeps untouched Markdown bytes byte-identical while
//! the reading view edits one block at a time.

use vellora_md::{apply_edits, parse, replace_segment};

#[test]
fn replacing_a_middle_segment_leaves_the_others_byte_identical() {
  let source = "alpha\n\nbeta\n\ngamma\n";
  let mut document = parse(source);
  assert_eq!(document.segments.len(), 3);
  assert!(replace_segment(&mut document, 1, "BETA!"));
  let written = vellora_md::to_markdown(&document, "\n");
  assert_eq!(written, "alpha\n\nBETA!\n\ngamma\n");
}

#[test]
fn raw_source_blocks_keep_their_exact_spelling() {
  let source = "- [ ] todo\n- [x] done\n\nbody\n";
  let mut document = parse(source);
  // Segment 0 is the unchanged task-list block; only the paragraph is edited.
  assert!(replace_segment(&mut document, 1, "body edited"));
  let written = vellora_md::to_markdown(&document, "\n");
  assert!(written.starts_with("- [ ] todo\n- [x] done\n"), "{written:?}");
  assert!(written.contains("body edited"), "{written:?}");
}

#[test]
fn replacing_with_several_blocks_splits_the_segment() {
  let source = "one\n\ntwo\n";
  let mut document = parse(source);
  assert_eq!(document.segments.len(), 2);
  assert!(replace_segment(&mut document, 0, "first line\n\nsecond line"));
  let written = vellora_md::to_markdown(&document, "\n");
  assert_eq!(written, "first line\n\nsecond line\n\ntwo\n");
}

#[test]
fn edits_apply_from_the_highest_index_down() {
  let source = "a\n\nb\n\nc\n";
  let mut document = parse(source);
  let applied = apply_edits(
    &mut document,
    &[(0, "A".into()), (2, "C".into())],
  );
  assert_eq!(applied, 2);
  let written = vellora_md::to_markdown(&document, "\n");
  // A dirty final block carries no synthetic trailing newline (golden contract).
  assert_eq!(written, "A\n\nb\n\nC");
}

#[test]
fn out_of_range_index_is_rejected_without_touching_the_document() {
  let source = "only\n";
  let mut document = parse(source);
  assert!(!replace_segment(&mut document, 9, "nope"));
  assert_eq!(vellora_md::to_markdown(&document, "\n"), "only\n");
}

#[test]
fn deleting_empty_segments_and_batches_is_atomic() {
  let mut document = parse("a\n\nb\n\nc\n");
  let before = document.clone();
  assert!(vellora_md::apply_edits_checked(&mut document, &[(0, "A".into()), (9, "bad".into())]).is_err());
  assert_eq!(document, before);
  assert!(vellora_md::apply_edits_checked(&mut document, &[(0, "A".into()), (0, "B".into())]).is_err());
  assert_eq!(document, before);
  assert!(replace_segment(&mut document, 1, ""));
  assert_eq!(vellora_md::to_markdown(&document, "\n"), "a\n\nc\n");
  assert_eq!(apply_edits(&mut document, &[(0, "".into()), (1, "".into())]), 2);
  assert_eq!(vellora_md::to_markdown(&document, "\n"), "");
}

#[test]
fn retained_segments_keep_mixed_line_endings_and_leading_space() {
  let source = "\r\nalpha\r\n\r\nbeta\n\ngamma\r";
  let mut document = parse(source);
  assert_eq!(document.segments.iter().map(|s| s.source.as_str()).collect::<String>(), source);
  assert_eq!(vellora_md::to_markdown(&document, "\r\n"), source);
  assert!(replace_segment(&mut document, 1, "BETA"));
  assert_eq!(vellora_md::to_markdown(&document, "\r\n"), "\r\nalpha\r\n\r\nBETA\r\n\r\ngamma\r");
}

#[test]
fn editing_neighbor_cannot_remove_reference_definitions() {
  let source = "alpha\n\n[ref]: https://example.com\n\nbeta\n";
  let mut document = parse(source);
  assert_eq!(document.segments.len(), 3);
  assert!(replace_segment(&mut document, 0, "ALPHA"));
  assert!(vellora_md::to_markdown(&document, "\n").contains("[ref]: https://example.com\n\n"));
}

#[test]
fn task_lists_are_structured_and_ordered_delimiters_survive_editing() {
  let tasks = parse("- [ ] todo\n- [x] done\n");
  assert!(matches!(&tasks.segments[0].block, vellora_md::Block::List(list) if list.tasks == vec![Some(false), Some(true)]));
  let mut document = parse("9) first\n10) second\n");
  assert!(replace_segment(&mut document, 0, "9) FIRST\n10) second"));
  assert_eq!(vellora_md::to_markdown(&document, "\n"), "9) FIRST\n10) second");
}

#[test]
fn pure_splice_preserves_final_boundary_and_inserts_into_empty_document() {
  for (source, expected) in [("old\n", "new\n"), ("old", "new"), ("old\r\n\r\n", "new\r\n\r\n"), ("", "new")] {
    assert_eq!(vellora_md::splice_markdown(source, &[(0,"new".into())]).unwrap(), expected);
  }
  assert_eq!(vellora_md::splice_markdown("a\n\nb\n", &[(0,"A\n\n".into())]).unwrap(), "A\n\nb\n");
  assert_eq!(vellora_md::splice_markdown("old\n", &[(0,"9) a\n10) b".into())]).unwrap(), "9) a\n10) b\n");
}
