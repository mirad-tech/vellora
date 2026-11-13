//! Golden scenarios generated from the frozen baseline (see
//! `native/tools/goldens/emit.gen.ts`). Each scenario is a neutral operation,
//! the exact input bytes, and the Markdown bytes the baseline writes back.

use std::path::PathBuf;

use serde::Deserialize;
use vellora_md::{append_at_end, insert_at_start, PreservedMarkdown};

#[derive(Deserialize)]
struct Scenario {
  id: String,
  source: String,
  operation: Operation,
  expected: String,
}

#[derive(Deserialize)]
#[serde(tag = "kind")]
enum Operation {
  #[serde(rename = "appendAtEnd")]
  AppendAtEnd { text: String },
  #[serde(rename = "insertAtStart")]
  InsertAtStart { text: String },
}

fn scenarios() -> Vec<Scenario> {
  let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/golden/scenarios.json");
  let raw = std::fs::read_to_string(&path)
    .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
  serde_json::from_str(&raw).expect("parse scenarios")
}

fn run(scenario: &Scenario) -> String {
  let mut preserved = PreservedMarkdown::new(&scenario.source);
  let applied = match &scenario.operation {
    Operation::AppendAtEnd { text } => append_at_end(preserved.document_mut(), text),
    Operation::InsertAtStart { text } => insert_at_start(preserved.document_mut(), text),
  };
  assert!(applied, "{}: operation did not apply", scenario.id);
  preserved.serialize()
}

/// Scenarios where the baseline and the native exporter differ only by blank
/// lines. Content bytes are identical.
///
/// D-01 (task-list / reference-link): the native exporter keeps the file's own
/// separators; the baseline adds one extra newline because its raw node text
/// includes the trailing blank line.
/// D-02 (table): the baseline's table serializer wraps the table in a leading
/// and trailing newline; the native exporter emits the table without them.
/// Both forms parse back to the same document.
const WHITESPACE_ONLY_DEVIATIONS: &[&str] = &[
  "task-list-append",
  "reference-link-append",
  "table-append",
];

/// Collapses runs of blank lines and drops leading/trailing blank lines.
fn normalize_blank_lines(text: &str) -> String {
  let mut out = String::with_capacity(text.len());
  let mut run = 0usize;
  for ch in text.chars() {
    if ch == '\n' {
      run += 1;
      if run > 2 {
        continue;
      }
    } else {
      run = 0;
    }
    out.push(ch);
  }
  out.trim_matches('\n').to_string()
}

#[test]
fn every_scenario_matches_the_baseline_bytes() {
  let mut failures = Vec::new();
  let mut deviations = Vec::new();
  for scenario in scenarios() {
    let actual = run(&scenario);
    if actual == scenario.expected {
      continue;
    }
    if WHITESPACE_ONLY_DEVIATIONS.contains(&scenario.id.as_str())
      && normalize_blank_lines(&actual) == normalize_blank_lines(&scenario.expected)
    {
      deviations.push(scenario.id.clone());
      continue;
    }
    failures.push(format!(
      "{}:\n  expected {:?}\n  actual   {:?}",
      scenario.id, scenario.expected, actual
    ));
  }
  assert!(failures.is_empty(), "\n{}", failures.join("\n"));
  assert_eq!(deviations.len(), WHITESPACE_ONLY_DEVIATIONS.len(), "unexpected deviation set: {deviations:?}");
}

#[test]
fn unedited_scenarios_round_trip_byte_for_byte() {
  for scenario in scenarios() {
    let preserved = PreservedMarkdown::new(&scenario.source);
    assert_eq!(preserved.serialize(), scenario.source, "{}", scenario.id);
  }
}
