//! Vellora native Markdown engine.
//!
//! * `parse` turns Markdown bytes into a neutral document model while retaining
//!   the source bytes of every top-level block.
//! * `export` serializes the model back to Markdown, touching only dirty blocks.
//! * `PreservedMarkdown` owns the baseline's "return the original spelling when
//!   the document is structurally unchanged" rule.
//!
//! No HTML/CSS renderer is involved: parsing produces semantic blocks, and the
//! native view consumes those blocks directly.

pub mod document;
pub mod edit;
pub mod export;
pub mod model;
pub mod parse;
pub mod preview;
pub mod outline;

pub use document::{document_line_ending, PreservedMarkdown};
pub use edit::{append_at_end, apply_edits, apply_edits_checked, insert_at_start, replace_segment, splice_markdown};
pub use export::{serialize_block, serialize_inlines, to_markdown};
pub use model::{
  Alignment, Block, Document, ImageAltSource, Inline, Link, List, Marks, Reference, ReferenceKind, Segment, Table,
};
pub use parse::parse;
