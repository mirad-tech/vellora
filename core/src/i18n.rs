//! Language of the messages the core returns to the user.
//!
//! The Qt shell picks the language once at startup from the system's preferred
//! UI language and sets it here through the bridge. Simplified Chinese is the
//! default, so a caller that never sets it sees the original messages. Error
//! codes never change with the language; only `message` text does.

use std::cell::Cell;
use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Language {
  Chinese,
  English,
}

impl Language {
  /// Reads a language tag: `zh` and any `zh-*` / `zh_*` (Simplified or
  /// Traditional) are Chinese, `en` and any `en-*` / `en_*` are English.
  pub fn from_tag(tag: &str) -> Option<Self> {
    let tag = tag.trim().to_ascii_lowercase();
    let primary = tag.split(['-', '_']).next().unwrap_or_default();
    match primary {
      "zh" => Some(Self::Chinese),
      "en" => Some(Self::English),
      _ => None,
    }
  }

  pub fn tag(self) -> &'static str {
    match self {
      Self::Chinese => "zh",
      Self::English => "en",
    }
  }
}

const CHINESE: u8 = 0;
const ENGLISH: u8 = 1;

static LANGUAGE: AtomicU8 = AtomicU8::new(CHINESE);

thread_local! {
  // Tests run in parallel threads of one process, so they pick a language per
  // thread instead of changing the process-wide one under each other.
  static OVERRIDE: Cell<Option<Language>> = const { Cell::new(None) };
}

/// Sets the language for every thread of the process.
pub fn set_language(language: Language) {
  let value = match language {
    Language::Chinese => CHINESE,
    Language::English => ENGLISH,
  };
  LANGUAGE.store(value, Ordering::Relaxed);
}

/// The language messages are returned in on this thread.
pub fn language() -> Language {
  OVERRIDE.with(Cell::get).unwrap_or_else(|| match LANGUAGE.load(Ordering::Relaxed) {
    ENGLISH => Language::English,
    _ => Language::Chinese,
  })
}

pub fn is_english() -> bool {
  language() == Language::English
}

/// Runs `f` with messages in `language` on the current thread only, then
/// restores the previous choice, also when `f` panics.
pub fn with_language<R>(language: Language, f: impl FnOnce() -> R) -> R {
  struct Restore(Option<Language>);
  impl Drop for Restore {
    fn drop(&mut self) {
      OVERRIDE.with(|cell| cell.set(self.0));
    }
  }
  let _restore = Restore(OVERRIDE.with(|cell| cell.replace(Some(language))));
  f()
}

/// Picks the message for the current language.
pub fn text(chinese: &'static str, english: &'static str) -> &'static str {
  match language() {
    Language::Chinese => chinese,
    Language::English => english,
  }
}

/// The system's name for the place deleted files go: the Recycle Bin on
/// Windows, the Trash elsewhere.
pub fn trash_name() -> &'static str {
  text("回收站", if cfg!(windows) { "Recycle Bin" } else { "Trash" })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn tags_map_every_chinese_variant_to_chinese_and_english_to_english() {
    for tag in ["zh", "zh-CN", "zh-TW", "zh-HK", "zh-Hant", "zh-Hans-CN", "ZH_tw", " zh "] {
      assert_eq!(Language::from_tag(tag), Some(Language::Chinese), "{tag}");
    }
    for tag in ["en", "en-US", "EN_gb"] {
      assert_eq!(Language::from_tag(tag), Some(Language::English), "{tag}");
    }
    for tag in ["", "ja", "de-DE", "zhx", "english"] {
      assert_eq!(Language::from_tag(tag), None, "{tag}");
    }
  }

  #[test]
  fn default_is_chinese_and_override_is_per_thread_and_restored() {
    assert_eq!(language(), Language::Chinese);
    assert_eq!(text("中文", "English"), "中文");
    let inside = with_language(Language::English, || {
      let other = std::thread::spawn(language).join().unwrap();
      (language(), text("中文", "English"), other)
    });
    assert_eq!(inside, (Language::English, "English", Language::Chinese));
    assert_eq!(language(), Language::Chinese);
    let panicked = std::panic::catch_unwind(|| with_language(Language::English, || panic!("boom")));
    assert!(panicked.is_err());
    assert_eq!(language(), Language::Chinese);
  }

  #[test]
  fn trash_name_follows_platform_in_english() {
    assert_eq!(trash_name(), "回收站");
    let english = with_language(Language::English, trash_name);
    assert_eq!(english, if cfg!(windows) { "Recycle Bin" } else { "Trash" });
  }
}
