//! Vellora native core: file access, path containment, reliable save, links,
//! images, launch arguments and single-document session rules.
//!
//! This crate has no UI dependency and no Tauri dependency. Every safety rule
//! that the frozen baseline enforced in the Rust command layer lives here, so a
//! new view cannot bypass it by calling a different entry point.

pub mod file_access;
pub mod image_access;
pub mod launch_args;
pub mod link_access;
pub mod path_policy;
pub mod reliable_save;
pub mod session;
pub mod types;

pub use types::{CommandError, CommandResult, DocumentPayload, EmptyPayload, ImagePayload, LinkInspectData, MarkdownDocument};
