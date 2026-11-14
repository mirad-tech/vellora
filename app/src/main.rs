//! Vellora native — Win32 shell hosting the system Rich Edit control.
//!
//! No WebView, no HTML/CSS engine, no browser runtime. The window owns:
//! * a single-document session (`vellora_core::session`) with the same conflict
//!   tokens, atomic replacement and close protection as the frozen baseline;
//! * a source editor that edits the raw Markdown text;
//! * a document view rendered from the neutral model into RTF.
//!
//! Document mode is read-only in this milestone: formatting is edited in source
//! mode, which matches the baseline rule that formatting and image attributes are
//! changed in source mode. Continuous rich editing is tracked in PROGRESS.md.

#![windows_subsystem = "windows"]

mod render;

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;

use vellora_core::session::{self, SessionState};
use vellora_core::types::{CommandResult, LinkInspectData, MarkdownDocument};
use vellora_core::{file_access, launch_args, link_access};
use vellora_md::PreservedMarkdown;

use windows_sys::Win32::Foundation::{GetLastError, HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
  CreateFontW, GetStockObject, SetBkColor, DEFAULT_GUI_FONT, UpdateWindow,
};
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, LoadLibraryW};
use windows_sys::Win32::System::Threading::CreateMutexW;
use windows_sys::Win32::UI::Controls::Dialogs::{
  GetOpenFileNameW, OFN_FILEMUSTEXIST, OFN_PATHMUSTEXIST, OPENFILENAMEW,
};
use windows_sys::Win32::UI::HiDpi::{
  SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, SetFocus, VK_CONTROL};
use windows_sys::Win32::UI::Shell::{
  DragAcceptFiles, DragFinish, DragQueryFileW, ShellExecuteW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

const ID_OPEN: usize = 1;
const ID_SAVE: usize = 2;
const ID_EXIT: usize = 3;
const ID_FIND: usize = 4;
const ID_REPLACE: usize = 5;
const ID_UNDO: usize = 6;
const ID_REDO: usize = 7;
const ID_TOGGLE_MODE: usize = 8;
const ID_OPEN_LINK: usize = 9;

const ID_FIND_TEXT: usize = 101;
const ID_REPLACE_TEXT: usize = 102;
const ID_FIND_PREV: usize = 103;
const ID_FIND_NEXT: usize = 104;
const ID_REPLACE_ONE: usize = 105;
const ID_REPLACE_ALL: usize = 106;
const ID_CLOSE_BAR: usize = 107;

const EM_REPLACESEL: u32 = 0x00C2;
const EM_EXLIMITTEXT: u32 = 0x0435;
const EM_SETSEL: u32 = 0x00B1;
const EM_SCROLLCARET: u32 = 0x00B7;
const EM_SETBKGNDCOLOR: u32 = 0x0443;
const ES_MULTILINE: u32 = 0x0004;
const ES_AUTOHSCROLL: u32 = 0x0080;
const BS_PUSHBUTTON: u32 = 0x0000_0000;
const ES_NOHIDESEL: u32 = 0x0100;
const ES_WANTRETURN: u32 = 0x1000;

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct CharRange {
  cp_min: i32,
  cp_max: i32,
}

#[repr(C)]
#[derive(Default)]
#[repr(C)]
struct CopyDataStruct {
  dw_data: usize,
  cb_data: u32,
  lp_data: *mut std::ffi::c_void,
}


#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
  Document,
  Source,
}

struct App {
  hwnd: HWND,
  edit: HWND,
  find_bar: HWND,
  find_text: HWND,
  replace_text: HWND,
  session: SessionState,
  path: Option<PathBuf>,
  name: String,
  preserved: Option<PreservedMarkdown>,
  mode: Mode,
  saved_text: String,
  modified: bool,
  find_visible: bool,
  links: Vec<render::LinkRange>,
}

static mut APP: Option<App> = None;

/// Minimal file logger: a windows-subsystem binary has no stderr, and a silent
/// exit would hide a real failure from the measurement harness.
fn log_line(message: &str) {
  use std::io::Write;
  // Diagnostics are opt-in: a normal launch must not create files.
  if std::env::var_os("VELLORA_NATIVE_LOG").is_none() {
    return;
  }
  let path = std::env::temp_dir().join("vellora-native.log");
  if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
    let _ = writeln!(file, "{message}");
  }
}

fn wide(value: &str) -> Vec<u16> {
  OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

unsafe fn app() -> &'static mut App {
  #[allow(static_mut_refs)]
  APP.as_mut().expect("app state")
}

fn utf16_len(hwnd: HWND) -> usize {
  unsafe { GetWindowTextLengthW(hwnd) as usize }
}

fn get_text(hwnd: HWND) -> String {
  let len = utf16_len(hwnd);
  if len == 0 {
    return String::new();
  }
  let mut buffer = vec![0u16; len + 1];
  let copied = unsafe { GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
  if copied <= 0 {
    return String::new();
  }
  String::from_utf16_lossy(&buffer[..copied as usize])
}

fn set_text(hwnd: HWND, text: &str) {
  let encoded = wide(text);
  unsafe {
    SendMessageW(hwnd, WM_SETTEXT, 0, encoded.as_ptr() as isize);
  }
}

fn message_box(hwnd: HWND, text: &str, caption: &str, style: MESSAGEBOX_STYLE) -> MESSAGEBOX_RESULT {
  unsafe {
    MessageBoxW(
      hwnd,
      wide(text).as_ptr(),
      wide(caption).as_ptr(),
      style,
    )
  }
}

/// Rich Edit uses CRLF for paragraph breaks; the document model uses LF.
fn normalize_newlines(text: &str) -> String {
  text.replace("\r\n", "\n").replace('\r', "\n")
}

impl App {
  fn update_title(&self) {
    let marker = if self.modified { " *" } else { "" };
    let title = if self.name.is_empty() {
      format!("Vellora{marker}")
    } else {
      format!("{} — Vellora{marker}", self.name)
    };
    unsafe {
      SetWindowTextW(self.hwnd, wide(&title).as_ptr());
    }
  }

  /// Markdown that should be written to disk right now.
  fn current_markdown(&mut self) -> String {
    match self.mode {
      Mode::Source => normalize_newlines(&get_text(self.edit)),
      Mode::Document => self
        .preserved
        .as_ref()
        .map(|preserved| preserved.serialize())
        .unwrap_or_default(),
    }
  }

  fn refresh_dirty(&mut self) {
    let current = self.current_markdown();
    self.modified = current != self.saved_text;
    self.update_title();
  }

  fn session_path(&self) -> Option<String> {
    self.path.as_ref().map(|path| path.to_string_lossy().into_owned())
  }

  fn adopt_document(&mut self, document: MarkdownDocument) {
    log_line("adopt_document");
    self.path = Some(PathBuf::from(&document.path));
    self.name = document.name.clone();
    self.saved_text = document.content.clone();
    self.modified = false;
    self.preserved = Some(PreservedMarkdown::new(&document.content));
    self.mode = Mode::Document;
    self.render_document();
    self.update_title();
  }

  fn render_document(&mut self) {
    let Some(preserved) = &self.preserved else {
      return;
    };
    let plan = render::build(preserved.document());
    self.links = plan.links.clone();
    set_text(self.edit, &plan.text);
    apply_plan(self.edit, &plan);
    unsafe {
      // Document mode is a rendered reading view in this milestone.
      SendMessageW(self.edit, EM_SETREADONLY, 1, 0);
      SendMessageW(self.edit, EM_SETSEL, 0, 0);
      SendMessageW(self.edit, EM_SCROLLCARET, 0, 0);
    }
  }

  fn set_source_text(&mut self, text: &str) {
    set_text(self.edit, text);
    unsafe {
      SendMessageW(self.edit, EM_SETREADONLY, 0, 0);
      SendMessageW(self.edit, EM_SETSEL, 0, 0);
    }
  }

  fn toggle_mode(&mut self) {
    match self.mode {
      Mode::Document => {
        let text = self
          .preserved
          .as_ref()
          .map(|preserved| preserved.serialize())
          .unwrap_or_default();
        self.mode = Mode::Source;
        self.set_source_text(&text);
        self.refresh_dirty();
      }
      Mode::Source => {
        let text = self.current_markdown();
        self.preserved = Some(PreservedMarkdown::new(&text));
        self.mode = Mode::Document;
        self.render_document();
        self.refresh_dirty();
      }
    }
  }

  fn open_path(&mut self, path: &str) {
    let result = file_access::read_markdown_file(path);
    match result {
      CommandResult::Ok { data, .. } => {
        session::remember_opened(&self.session, &CommandResult::success(data.clone()));
        self.adopt_document(data.document);
      }
      CommandResult::Err { code, message, .. } => {
        message_box(self.hwnd, &message, &format!("打开失败 ({code})"), MB_OK | MB_ICONERROR);
      }
    }
  }

  fn open_dialog(&mut self) {
    let mut buffer = vec![0u16; 2048];
    let filter: Vec<u16> = "Markdown 文件\0*.md;*.markdown\0所有文件\0*.*\0\0".encode_utf16().collect();
    let default_ext = wide("md");
    let mut ofn: OPENFILENAMEW = unsafe { std::mem::zeroed() };
    ofn.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
    ofn.hwndOwner = self.hwnd;
    ofn.lpstrFilter = filter.as_ptr();
    ofn.lpstrFile = buffer.as_mut_ptr();
    ofn.nMaxFile = buffer.len() as u32;
    ofn.lpstrDefExt = default_ext.as_ptr();
    ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST;

    let picked = unsafe { GetOpenFileNameW(&mut ofn) != 0 };
    if !picked {
      return;
    }
    let path = String::from_utf16_lossy(&buffer)
      .trim_end_matches('\0')
      .to_string();
    if path.is_empty() {
      return;
    }
    self.open_path(&path);
  }

  fn save(&mut self, conflict_token: Option<&str>) -> bool {
    let Some(path) = self.session_path() else {
      message_box(self.hwnd, "当前没有已打开的文档。", "保存", MB_OK | MB_ICONWARNING);
      return false;
    };
    let content = self.current_markdown();
    let result = session::save_document_session(&self.session, &path, &content, conflict_token);
    match result {
      CommandResult::Ok { data, .. } => {
        if let Some(preserved) = self.preserved.as_mut() {
          preserved.mark_saved(&content);
        }
        self.saved_text = data.document.content.clone();
        self.modified = false;
        self.update_title();
        true
      }
      CommandResult::Err {
        ok: _,
        code,
        message,
        conflict_token: token,
      } => {
        if code == "FILE_CHANGED" {
          let answer = message_box(
            self.hwnd,
            "文件已被其他程序修改。\n\n是：用当前内容覆盖\n否：放弃当前修改并重新加载\n取消：继续编辑",
            "文件已改变",
            MB_YESNOCANCEL | MB_ICONWARNING,
          );
          match answer {
            IDYES => {
              if let Some(token) = token {
                return self.save(Some(&token));
              }
              return false;
            }
            IDNO => {
              self.open_path(&path);
              return false;
            }
            _ => return false,
          }
        }
        message_box(self.hwnd, &message, &format!("保存失败 ({code})"), MB_OK | MB_ICONERROR);
        false
      }
    }
  }

  /// Returns false when the close must be cancelled.
  fn confirm_close(&mut self) -> bool {
    self.refresh_dirty();
    if self.modified {
      let answer = message_box(
        self.hwnd,
        "当前文档有未保存的修改。\n\n是：保存并退出\n否：不保存退出\n取消：返回编辑",
        "Vellora",
        MB_YESNOCANCEL | MB_ICONWARNING,
      );
      return match answer {
        IDYES => self.save(None),
        IDNO => true,
        _ => false,
      };
    }
    true
  }

  fn show_find_bar(&mut self, replace: bool) {
    self.find_visible = true;
    unsafe {
      ShowWindow(self.find_bar, SW_SHOW);
      SetFocus(self.find_text);
      if replace {
        ShowWindow(self.replace_text, SW_SHOW);
      } else {
        ShowWindow(self.replace_text, SW_HIDE);
      }
    }
    self.layout();
  }

  fn hide_find_bar(&mut self) {
    self.find_visible = false;
    unsafe {
      ShowWindow(self.find_bar, SW_HIDE);
      SetFocus(self.edit);
    }
    self.layout();
  }

  fn layout(&self) {
    unsafe {
      let mut rect = std::mem::zeroed();
      GetClientRect(self.hwnd, &mut rect);
      let bar_height = if self.find_visible { 64 } else { 0 };
      if self.find_visible {
        MoveWindow(self.find_bar, 0, 0, rect.right, bar_height, 1);
        let row = 28;
        MoveWindow(self.find_text, 8, 4, rect.right - 360, 24, 1);
        MoveWindow(self.replace_text, 8, 34, rect.right - 360, 24, 1);
        let mut x = rect.right - 344;
        for (hwnd, label) in [
          (find_button(self, 0), "上一个"),
          (find_button(self, 1), "下一个"),
          (find_button(self, 2), "替换"),
          (find_button(self, 3), "全部替换"),
          (find_button(self, 4), "关闭"),
        ] {
          if !hwnd.is_null() {
            let _ = label;
            MoveWindow(hwnd, x, 4, if label == "全部替换" { 76 } else { 60 }, 24, 1);
            x += if label == "全部替换" { 80 } else { 64 };
          }
        }
        let _ = row;
      }
      let inset = 12;
      let top = bar_height + if bar_height > 0 { 0 } else { 8 };
      MoveWindow(
        self.edit,
        inset,
        top,
        (rect.right - inset * 2).max(0),
        (rect.bottom - top - 8).max(0),
        1,
      );
    }
  }

  fn find(&mut self, backwards: bool) {
    let query = get_text(self.find_text);
    if query.is_empty() {
      return;
    }
    let text = normalize_newlines(&get_text(self.edit));
    let lowered = text.to_lowercase();
    let needle = query.to_lowercase();
    let selection = unsafe {
      let mut range = CharRange::default();
      SendMessageW(
        self.edit,
        EM_GETSEL,
        &mut range.cp_min as *mut i32 as usize,
        &mut range.cp_max as *mut i32 as isize,
      );
      range
    };
    let from = if backwards { selection.cp_min.max(0) as usize } else { selection.cp_max.max(0) as usize };

    let found = if backwards {
      lowered[..from.min(lowered.len())]
        .rfind(&needle)
        .map(|index| (index, index + needle.len()))
    } else {
      lowered[from.min(lowered.len())..]
        .find(&needle)
        .map(|index| (from + index, from + index + needle.len()))
    }
    .or_else(|| {
      // Wrap around like the baseline's cyclic navigation.
      if backwards {
        lowered.rfind(&needle).map(|index| (index, index + needle.len()))
      } else {
        lowered.find(&needle).map(|index| (index, index + needle.len()))
      }
    });

    match found {
      Some((start, end)) => unsafe {
        SendMessageW(self.edit, EM_SETSEL, start, end as isize);
        SendMessageW(self.edit, EM_SCROLLCARET, 0, 0);
        SetFocus(self.edit);
      },
      None => {
        message_box(self.hwnd, "未找到匹配内容。", "查找", MB_OK | MB_ICONINFORMATION);
      }
    }
  }

  fn replace_current(&mut self) {
    let query = get_text(self.find_text);
    let replacement = get_text(self.replace_text);
    if query.is_empty() {
      return;
    }
    if self.mode == Mode::Document {
      message_box(
        self.hwnd,
        "文档视图在本里程碑为只读。请切换到源码模式替换。",
        "替换",
        MB_OK | MB_ICONINFORMATION,
      );
      return;
    }
    unsafe {
      let mut range = CharRange::default();
      SendMessageW(
        self.edit,
        EM_GETSEL,
        &mut range.cp_min as *mut i32 as usize,
        &mut range.cp_max as *mut i32 as isize,
      );
      let selected = get_selected_text(self.edit);
      if selected.to_lowercase() == query.to_lowercase() && !selected.is_empty() {
        let encoded = wide(&replacement);
        SendMessageW(self.edit, EM_REPLACESEL, 1, encoded.as_ptr() as isize);
        self.refresh_dirty();
        return;
      }
    }
    self.find(false);
    self.replace_current();
  }

  fn replace_all(&mut self) {
    let query = get_text(self.find_text);
    let replacement = get_text(self.replace_text);
    if query.is_empty() {
      return;
    }
    if self.mode == Mode::Document {
      message_box(
        self.hwnd,
        "文档视图在本里程碑为只读。请切换到源码模式替换。",
        "替换",
        MB_OK | MB_ICONINFORMATION,
      );
      return;
    }
    let text = normalize_newlines(&get_text(self.edit));
    let (result, count) = replace_all_literal(&text, &query, &replacement);
    if count == 0 {
      message_box(self.hwnd, "未找到匹配内容。", "替换", MB_OK | MB_ICONINFORMATION);
      return;
    }
    let answer = message_box(
      self.hwnd,
      &format!("确认替换 {count} 处？"),
      "全部替换",
      MB_YESNO | MB_ICONQUESTION,
    );
    if answer != IDYES {
      return;
    }
    set_text(self.edit, &result);
    self.refresh_dirty();
  }
}

const EM_SETCHARFORMAT: u32 = 0x0444;
const EM_SETPARAFORMAT: u32 = 0x0447;
const SCF_SELECTION: usize = 0x0001;
const CFM_BOLD: u32 = 0x0000_0001;
const CFM_ITALIC: u32 = 0x0000_0002;
const CFM_UNDERLINE: u32 = 0x0000_0004;
const CFM_STRIKE: u32 = 0x0000_0008;
const CFM_FACE: u32 = 0x2000_0000;
const CFM_SIZE: u32 = 0x8000_0000;
const CFM_COLOR: u32 = 0x4000_0000;
const CFE_BOLD: u32 = 0x0000_0001;
const CFE_ITALIC: u32 = 0x0000_0002;
const CFE_UNDERLINE: u32 = 0x0000_0004;
const CFE_STRIKE: u32 = 0x0000_0008;
const PFM_STARTINDENT: u32 = 0x0000_0001;

#[repr(C)]
#[derive(Clone, Copy)]
struct CharFormatW {
  cb_size: u32,
  dw_mask: u32,
  dw_effects: u32,
  y_height: i32,
  y_offset: i32,
  cr_text_color: u32,
  b_char_set: u8,
  b_pitch_and_family: u8,
  sz_face_name: [u16; 32],
}

impl Default for CharFormatW {
  fn default() -> Self {
    Self {
      cb_size: std::mem::size_of::<CharFormatW>() as u32,
      dw_mask: 0,
      dw_effects: 0,
      y_height: 0,
      y_offset: 0,
      cr_text_color: 0,
      b_char_set: 0,
      b_pitch_and_family: 0,
      sz_face_name: [0; 32],
    }
  }
}

#[repr(C)]
#[derive(Clone, Copy)]
struct ParaFormatW {
  cb_size: u32,
  dw_mask: u32,
  w_numbering: u16,
  w_reserved: u16,
  dx_start_indent: i32,
  dx_right_indent: i32,
  dx_offset: i32,
  w_alignment: u16,
  c_tab_count: i16,
  rgx_tabs: [i32; 32],
}

impl Default for ParaFormatW {
  fn default() -> Self {
    Self {
      cb_size: std::mem::size_of::<ParaFormatW>() as u32,
      dw_mask: 0,
      w_numbering: 0,
      w_reserved: 0,
      dx_start_indent: 0,
      dx_right_indent: 0,
      dx_offset: 0,
      w_alignment: 0,
      c_tab_count: 0,
      rgx_tabs: [0; 32],
    }
  }
}

fn face_name(format: &mut CharFormatW, name: &str) {
  for (index, unit) in name.encode_utf16().take(31).enumerate() {
    format.sz_face_name[index] = unit;
  }
}

/// Applies a character format to a UTF-16 range.
fn format_range(hwnd: HWND, start: usize, end: usize, format: &CharFormatW) {
  unsafe {
    SendMessageW(hwnd, EM_SETSEL, start, end as isize);
    SendMessageW(
      hwnd,
      EM_SETCHARFORMAT,
      SCF_SELECTION,
      format as *const CharFormatW as isize,
    );
  }
}

fn apply_plan(hwnd: HWND, plan: &render::RenderPlan) {
  let mut base = CharFormatW::default();
  base.dw_mask = CFM_FACE | CFM_SIZE | CFM_COLOR;
  // CHARFORMAT yHeight is in twips: 10 pt = 200.
  base.y_height = 200;
  base.cr_text_color = 0x0020_2020;
  face_name(&mut base, "Segoe UI");
  format_range(hwnd, 0, plan.text.encode_utf16().count(), &base);

  for range in &plan.styles {
    use render::StyleKind::*;
    let mut format = CharFormatW::default();
    format.dw_mask = CFM_BOLD | CFM_ITALIC | CFM_STRIKE | CFM_COLOR | CFM_SIZE | CFM_FACE;
    let (size, color, face) = match range.style {
      Body => continue,
      Heading1 => (400, 0x0018_1614, "Segoe UI"),
      Heading2 => (320, 0x0018_1614, "Segoe UI"),
      Heading3 => (260, 0x0018_1614, "Segoe UI"),
      Bold => (200, 0x0020_2020, "Segoe UI"),
      Italic => (200, 0x0020_2020, "Segoe UI"),
      Strike => (200, 0x0060_6060, "Segoe UI"),
      Code => (190, 0x0034_2E2A, "Segoe UI"),
      Link => (200, 0x00A0_5A28, "Segoe UI"),
      Quote => (200, 0x0058_5850, "Segoe UI"),
      Muted => (190, 0x0080_8078, "Segoe UI"),
    };
    format.y_height = size;
    format.cr_text_color = color;
    face_name(&mut format, face);
    match range.style {
      Heading1 | Heading2 | Heading3 | Bold => format.dw_effects |= CFE_BOLD,
      Italic => format.dw_effects |= CFE_ITALIC,
      Strike => format.dw_effects |= CFE_STRIKE,
      Link => format.dw_effects |= CFE_UNDERLINE,
      _ => {}
    }
    format_range(hwnd, range.start, range.end, &format);
  }

  for link in &plan.links {
    let mut format = CharFormatW::default();
    format.dw_mask = CFM_UNDERLINE | CFM_COLOR;
    format.dw_effects = CFE_UNDERLINE | CFE_LINK;
    format.cr_text_color = 0x00A0_5A28;
    format.y_height = 200;
    face_name(&mut format, "Segoe UI");
    format_range(hwnd, link.start, link.end, &format);
  }

  for paragraph in &plan.paragraphs {
    if paragraph.indent_twips == 0 && paragraph.space_before_twips == 0 {
      continue;
    }
    if std::env::var("VELLORA_NATIVE_NO_PARA").is_ok() {
      continue;
    }
    let mut format = ParaFormatW::default();
    // PARAFORMAT v1 has no space-before field; PFM_SPACEBEFORE would make Rich
    // Edit read past this struct. Spacing comes from the blank separator lines.
    format.dw_mask = PFM_STARTINDENT;
    format.dx_start_indent = paragraph.indent_twips;
    format.dx_offset = 0;
    let _ = &mut format.dx_start_indent;
    unsafe {
      SendMessageW(hwnd, EM_SETSEL, paragraph.start, paragraph.end as isize);
      SendMessageW(
        hwnd,
        EM_SETPARAFORMAT,
        0,
        &format as *const ParaFormatW as isize,
      );
    }
    let _ = paragraph.space_before_twips;
  }
  unsafe {
    SendMessageW(hwnd, EM_SETSEL, 0, 0);
  }
}

impl App {
  fn link_at(&self, position: i32) -> Option<&render::LinkRange> {
    let position = position.max(0) as usize;
    self
      .links
      .iter()
      .find(|link| position >= link.start && position < link.end)
  }

  /// Every link entry point goes through core validation: relative Markdown only
  /// inside the document directory, external only http(s) after confirmation.
  fn open_link(&mut self, href: &str) {
    let Some(document_path) = self.session_path() else {
      return;
    };
    match link_access::inspect_markdown_link(&document_path, href) {
      CommandResult::Ok { data: LinkInspectData::Markdown { document, .. }, .. } => {
        self.refresh_dirty();
        if self.modified {
          let answer = message_box(
            self.hwnd,
            &format!("打开 {} 会放弃当前未保存的修改。\n\n继续？", document.name),
            "打开链接",
            MB_YESNO | MB_ICONWARNING,
          );
          if answer != IDYES {
            return;
          }
        }
        match session::open_link_session(&self.session, &document_path, href) {
          CommandResult::Ok { data, .. } => self.adopt_document(data.document),
          CommandResult::Err { message, .. } => {
            message_box(self.hwnd, &message, "打开链接失败", MB_OK | MB_ICONERROR);
          }
        }
      }
      CommandResult::Ok { data: LinkInspectData::External { url, .. }, .. } => {
        let answer = message_box(
          self.hwnd,
          &format!("在默认浏览器打开？\n\n{url}"),
          "外部链接",
          MB_YESNO | MB_ICONQUESTION,
        );
        if answer != IDYES {
          return;
        }
        let result = link_access::open_external_url(&url, |target| {
          let operation = wide("open");
          let file = wide(target);
          let value = unsafe {
            ShellExecuteW(
              std::ptr::null_mut(),
              operation.as_ptr(),
              file.as_ptr(),
              std::ptr::null(),
              std::ptr::null(),
              SW_SHOWNORMAL as i32,
            )
          };
          // ShellExecuteW returns a value > 32 on success.
          if value as isize > 32 {
            Ok(())
          } else {
            Err(std::io::Error::other("shell execute failed"))
          }
        });
        if let CommandResult::Err { message, .. } = result {
          message_box(self.hwnd, &message, "打开链接失败", MB_OK | MB_ICONERROR);
        }
      }
      CommandResult::Err { code, message, .. } => {
        message_box(self.hwnd, &message, &format!("已阻止 ({code})"), MB_OK | MB_ICONWARNING);
      }
    }
  }
}

fn current_caret(hwnd: &HWND) -> i32 {
  unsafe {
    let mut range = CharRange::default();
    SendMessageW(
      *hwnd,
      EM_GETSEL,
      &mut range.cp_min as *mut i32 as usize,
      &mut range.cp_max as *mut i32 as isize,
    );
    range.cp_max
  }
}

fn get_selected_text(hwnd: HWND) -> String {
  unsafe {
    let mut range = CharRange::default();
    SendMessageW(
      hwnd,
      EM_GETSEL,
      &mut range.cp_min as *mut i32 as usize,
      &mut range.cp_max as *mut i32 as isize,
    );
    if range.cp_max <= range.cp_min {
      return String::new();
    }
    let len = (range.cp_max - range.cp_min) as usize;
    let mut buffer = vec![0u16; len + 1];
    let mut text_range = TextRange { chrg: range, lpstr_text: buffer.as_mut_ptr() };
    SendMessageW(hwnd, EM_GETTEXTEX_RANGE, &mut text_range as *mut TextRange as usize, 0);
    let end = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
  }
}

#[repr(C)]
struct TextRange {
  chrg: CharRange,
  lpstr_text: *mut u16,
}

const EM_GETTEXTEX_RANGE: u32 = 0x00B2;

/// Literal, case-insensitive replacement that skips matches created by the
/// replacement text (the baseline's "全部替换" rule).
fn replace_all_literal(text: &str, query: &str, replacement: &str) -> (String, usize) {
  let lowered = text.to_lowercase();
  let needle = query.to_lowercase();
  if needle.is_empty() {
    return (text.to_string(), 0);
  }
  let mut out = String::with_capacity(text.len());
  let mut cursor = 0usize;
  let mut count = 0usize;
  let mut search_from = 0usize;
  while let Some(index) = lowered[search_from..].find(&needle) {
    let start = search_from + index;
    out.push_str(&text[cursor..start]);
    out.push_str(replacement);
    cursor = start + query.len();
    search_from = cursor;
    count += 1;
  }
  out.push_str(&text[cursor..]);
  (out, count)
}

fn find_button(app: &App, index: usize) -> HWND {
  let ids = [ID_FIND_PREV, ID_FIND_NEXT, ID_REPLACE_ONE, ID_REPLACE_ALL, ID_CLOSE_BAR];
  unsafe { GetDlgItem(app.find_bar, ids[index] as i32) }
}

unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
  match msg {
    WM_CREATE => {
      let msftedit = wide("Msftedit.dll");
      LoadLibraryW(msftedit.as_ptr());
      let class = wide("RICHEDIT50W");
      let edit = CreateWindowExW(
        0,
        class.as_ptr(),
        std::ptr::null(),
        WS_CHILD | WS_VISIBLE | WS_VSCROLL | ES_MULTILINE | ES_WANTRETURN | ES_NOHIDESEL,
        0,
        0,
        0,
        0,
        hwnd,
        std::ptr::null_mut(),
        GetModuleHandleW(std::ptr::null()),
        std::ptr::null(),
      );
      let find_bar = CreateWindowExW(
        0,
        wide("VelloraFindBar").as_ptr(),
        std::ptr::null(),
        WS_CHILD | WS_VISIBLE,
        0,
        0,
        0,
        0,
        hwnd,
        std::ptr::null_mut(),
        GetModuleHandleW(std::ptr::null()),
        std::ptr::null(),
      );
      log_line(&format!("wm_create edit={edit:?} bar={find_bar:?}"));
      let state = app();
      state.hwnd = hwnd;
      state.edit = edit;
      state.find_bar = find_bar;
      state.find_text = GetDlgItem(find_bar, ID_FIND_TEXT as i32);
      state.replace_text = GetDlgItem(find_bar, ID_REPLACE_TEXT as i32);

      SendMessageW(edit, EM_EXLIMITTEXT, 0, 0x7FFF_FFFF);
      SendMessageW(edit, EM_SETBKGNDCOLOR, 0, 0x00F7_F3_EF as isize);
      SendMessageW(edit, EM_SETMARGINS, EC_LEFTMARGIN | EC_RIGHTMARGIN, (28 | (28 << 16)) as isize);
      SendMessageW(edit, EM_SETEVENTMASK, 0, ENM_LINK as isize);
      let font = CreateFontW(-20, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, wide("Segoe UI").as_ptr());
      SendMessageW(edit, WM_SETFONT, font as usize, 1);
      SendMessageW(find_bar, WM_SETFONT, GetStockObject(DEFAULT_GUI_FONT) as usize, 1);
      ShowWindow(find_bar, SW_HIDE);
      DragAcceptFiles(hwnd, 1);
      state.layout();
      0
    }
    WM_SIZE => {
      app().layout();
      0
    }
    WM_SETFOCUS => {
      SetFocus(app().edit);
      0
    }
    WM_COMMAND => {
      let id = wparam & 0xFFFF;
      let state = app();
      match id {
        ID_OPEN => state.open_dialog(),
        ID_SAVE => {
          state.save(None);
        }
        ID_EXIT => {
          PostMessageW(hwnd, WM_CLOSE, 0, 0);
        }
        ID_FIND => state.show_find_bar(false),
        ID_REPLACE => state.show_find_bar(true),
        ID_UNDO => {
          SendMessageW(state.edit, WM_UNDO, 0, 0);
          state.refresh_dirty();
        }
        ID_REDO => {
          SendMessageW(state.edit, WM_REDO, 0, 0);
          state.refresh_dirty();
        }
        ID_TOGGLE_MODE => state.toggle_mode(),
        ID_OPEN_LINK => {
          let position = current_caret(&state.edit);
          if let Some(link) = state.link_at(position).cloned() {
            state.open_link(&link.href);
          } else {
            message_box(state.hwnd, "光标处没有链接。", "打开链接", MB_OK | MB_ICONINFORMATION);
          }
        }
        ID_FIND_NEXT => state.find(false),
        ID_FIND_PREV => state.find(true),
        ID_REPLACE_ONE => state.replace_current(),
        ID_REPLACE_ALL => state.replace_all(),
        ID_CLOSE_BAR => state.hide_find_bar(),
        _ => {
          let code = ((wparam >> 16) & 0xFFFF) as u32;
          if code == EN_CHANGE && lparam as HWND == state.edit {
            state.modified = true;
            state.update_title();
          }
        }
      }
      0
    }
    WM_CLOSE => {
      if app().confirm_close() {
        DestroyWindow(hwnd);
      }
      0
    }
    WM_DESTROY => {
      PostQuitMessage(0);
      0
    }
    WM_NOTIFY => {
      let header = lparam as *const EnLink;
      if !header.is_null() {
        let link = &*header;
        if link.code == EN_LINK && link.msg == WM_LBUTTONUP as u32 {
          let ctrl_down = (GetKeyState(VK_CONTROL as i32) as u16 & 0x8000) != 0;
          if ctrl_down {
            let state = app();
            if let Some(target) = state.link_at(link.chrg.cp_min).cloned() {
              state.open_link(&target.href);
            }
          }
        }
      }
      0
    }
    WM_DROPFILES => {
      let drop = wparam as *mut std::ffi::c_void;
      let mut buffer = vec![0u16; 1024];
      let copied = DragQueryFileW(drop as _, 0, buffer.as_mut_ptr(), buffer.len() as u32);
      DragFinish(drop as _);
      if copied > 0 {
        let path = String::from_utf16_lossy(&buffer[..copied as usize]);
        app().open_path(&path);
      }
      0
    }
    WM_COPYDATA => {
      let data = lparam as *const CopyDataStruct;
      if !data.is_null() {
        let copy = &*data;
        if copy.cb_data > 0 && !copy.lp_data.is_null() {
          let slice = std::slice::from_raw_parts(
            copy.lp_data as *const u8,
            copy.cb_data as usize,
          );
          let path = String::from_utf8_lossy(slice).trim_end_matches('\0').to_string();
          if !path.is_empty() {
            app().open_path(&path);
          }
        }
      }
      0
    }
    _ => DefWindowProcW(hwnd, msg, wparam, lparam),
  }
}

unsafe extern "system" fn find_bar_proc(
  hwnd: HWND,
  msg: u32,
  wparam: WPARAM,
  lparam: LPARAM,
) -> LRESULT {
  match msg {
    WM_CREATE => {
      let container = hwnd;
      CreateWindowExW(
        0,
        wide("EDIT").as_ptr(),
        std::ptr::null(),
        WS_CHILD | WS_VISIBLE | WS_BORDER | ES_AUTOHSCROLL,
        8,
        4,
        200,
        24,
        container,
        ID_FIND_TEXT as usize as *mut _,
        GetModuleHandleW(std::ptr::null()),
        std::ptr::null(),
      );
      CreateWindowExW(
        0,
        wide("EDIT").as_ptr(),
        std::ptr::null(),
        WS_CHILD | WS_VISIBLE | WS_BORDER | ES_AUTOHSCROLL,
        8,
        34,
        200,
        24,
        container,
        ID_REPLACE_TEXT as usize as *mut _,
        GetModuleHandleW(std::ptr::null()),
        std::ptr::null(),
      );
      for (id, label) in [
        (ID_FIND_PREV, "上一个"),
        (ID_FIND_NEXT, "下一个"),
        (ID_REPLACE_ONE, "替换"),
        (ID_REPLACE_ALL, "全部替换"),
        (ID_CLOSE_BAR, "关闭"),
      ] {
        CreateWindowExW(
          0,
          wide("BUTTON").as_ptr(),
          wide(label).as_ptr(),
          WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
          0,
          0,
          60,
          24,
          container,
          id as usize as *mut _,
          GetModuleHandleW(std::ptr::null()),
          std::ptr::null(),
        );
      }
      0
    }
    WM_COMMAND => {
      let id = wparam & 0xFFFF;
      let parent = GetParent(hwnd);
      PostMessageW(parent, WM_COMMAND, id, 0);
      0
    }
    WM_CTLCOLORSTATIC | WM_CTLCOLOREDIT => {
      let hdc = wparam as *mut std::ffi::c_void;
      let brush = GetStockObject(WHITE_BRUSH);
      SetBkColor(hdc as _, 0x00FF_FFFF);
      brush as isize
    }
    _ => DefWindowProcW(hwnd, msg, wparam, lparam),
  }
}

const WHITE_BRUSH: i32 = 0;
const EM_SETREADONLY: u32 = 0x00CF;
const EM_SETMARGINS: u32 = 0x00D3;
const EM_SETEVENTMASK: u32 = 0x0445;
const ENM_LINK: usize = 0x0400_0000;
const EN_LINK: u32 = 0x0700;
const CFE_LINK: u32 = 0x0000_0020;

#[repr(C)]
struct EnLink {
  hwnd_from: HWND,
  id_from: usize,
  code: u32,
  msg: u32,
  wparam: usize,
  lparam: isize,
  chrg: CharRange,
}
const EC_LEFTMARGIN: usize = 0x0001;
const EC_RIGHTMARGIN: usize = 0x0002;
const WM_REDO: u32 = 0x052D;
const EM_GETSEL: u32 = 0x00B0;

unsafe fn register_classes(instance: *mut std::ffi::c_void) {
  let class_name = wide("VelloraNativeMain");
  let wc = WNDCLASSW {
    style: CS_HREDRAW | CS_VREDRAW,
    lpfnWndProc: Some(wnd_proc),
    cbClsExtra: 0,
    cbWndExtra: 0,
    hInstance: instance,
    hIcon: LoadIconW(std::ptr::null_mut(), IDI_APPLICATION),
    hCursor: LoadCursorW(std::ptr::null_mut(), IDC_IBEAM),
    hbrBackground: GetStockObject(WHITE_BRUSH) as *mut std::ffi::c_void,
    lpszMenuName: std::ptr::null(),
    lpszClassName: class_name.as_ptr(),
  };
  RegisterClassW(&wc);

  let bar = wide("VelloraFindBar");
  let bar_class = WNDCLASSW {
    style: 0,
    lpfnWndProc: Some(find_bar_proc),
    cbClsExtra: 0,
    cbWndExtra: 0,
    hInstance: instance,
    hIcon: std::ptr::null_mut(),
    hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
    hbrBackground: GetStockObject(WHITE_BRUSH) as *mut std::ffi::c_void,
    lpszMenuName: std::ptr::null(),
    lpszClassName: bar.as_ptr(),
  };
  RegisterClassW(&bar_class);
}

unsafe fn build_menu() -> HMENU {
  let menu = CreateMenu();
  let file = CreatePopupMenu();
  AppendMenuW(file, MF_STRING, ID_OPEN, wide("打开(&O)...\tCtrl+O").as_ptr());
  AppendMenuW(file, MF_STRING, ID_SAVE, wide("保存(&S)\tCtrl+S").as_ptr());
  AppendMenuW(file, MF_SEPARATOR, 0, std::ptr::null());
  AppendMenuW(file, MF_STRING, ID_EXIT, wide("退出(&X)").as_ptr());
  AppendMenuW(menu, MF_POPUP, file as usize, wide("文件(&F)").as_ptr());

  let edit = CreatePopupMenu();
  AppendMenuW(edit, MF_STRING, ID_UNDO, wide("撤销(&U)\tCtrl+Z").as_ptr());
  AppendMenuW(edit, MF_STRING, ID_REDO, wide("重做(&R)\tCtrl+Y").as_ptr());
  AppendMenuW(edit, MF_SEPARATOR, 0, std::ptr::null());
  AppendMenuW(edit, MF_STRING, ID_FIND, wide("查找(&F)\tCtrl+F").as_ptr());
  AppendMenuW(edit, MF_STRING, ID_REPLACE, wide("替换(&H)\tCtrl+H").as_ptr());
  AppendMenuW(edit, MF_SEPARATOR, 0, std::ptr::null());
  AppendMenuW(edit, MF_STRING, ID_OPEN_LINK, wide("打开光标处链接(&K)").as_ptr());
  AppendMenuW(menu, MF_POPUP, edit as usize, wide("编辑(&E)").as_ptr());

  let view = CreatePopupMenu();
  AppendMenuW(view, MF_STRING, ID_TOGGLE_MODE, wide("切换源码/文档模式\tF6").as_ptr());
  AppendMenuW(menu, MF_POPUP, view as usize, wide("查看(&V)").as_ptr());
  menu
}

fn main() {
  std::panic::set_hook(Box::new(|info| {
    log_line(&format!("panic: {info}"));
  }));
  log_line("start");
  let args: Vec<String> = std::env::args().collect();
  let initial = launch_args::find_markdown_path_in_args(&args);
  log_line(&format!("args={args:?}"));

  unsafe {
    // Single instance: a second launch forwards its path to the running window.
    let mutex_name = wide(r"Local\VelloraNative.SingleInstance");
    let _mutex = CreateMutexW(std::ptr::null(), 0, mutex_name.as_ptr());
    let already_running = GetLastError() == 183; // ERROR_ALREADY_EXISTS
    if already_running {
      let class = wide("VelloraNativeMain");
      let existing = FindWindowW(class.as_ptr(), std::ptr::null());
      if !existing.is_null() {
        if let Some(path) = &initial {
          let mut bytes = path.clone().into_bytes();
          bytes.push(0);
          let data = CopyDataStruct {
            dw_data: 0,
            cb_data: bytes.len() as u32,
            lp_data: bytes.as_ptr() as *mut _,
          };
          SendMessageW(
            existing,
            WM_COPYDATA,
            0,
            &data as *const CopyDataStruct as isize,
          );
        }
        ShowWindow(existing, SW_RESTORE);
        SetForegroundWindow(existing);
      }
      return;
    }

    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    let instance = GetModuleHandleW(std::ptr::null());
    register_classes(instance);

    // The state must exist before CreateWindowExW: WM_CREATE runs inside it.
    APP = Some(App {
      hwnd: std::ptr::null_mut(),
      edit: std::ptr::null_mut(),
      find_bar: std::ptr::null_mut(),
      find_text: std::ptr::null_mut(),
      replace_text: std::ptr::null_mut(),
      session: SessionState::default(),
      path: None,
      name: String::new(),
      preserved: None,
      mode: Mode::Document,
      saved_text: String::new(),
      modified: false,
      find_visible: false,
      links: Vec::new(),
    });

    let menu = build_menu();
    let hwnd = CreateWindowExW(
      0,
      wide("VelloraNativeMain").as_ptr(),
      wide("Vellora").as_ptr(),
      WS_OVERLAPPEDWINDOW | WS_VISIBLE,
      CW_USEDEFAULT,
      CW_USEDEFAULT,
      1100,
      900,
      std::ptr::null_mut(),
      menu,
      instance,
      std::ptr::null(),
    );
    if hwnd.is_null() {
      return;
    }

    ShowWindow(hwnd, SW_SHOW);
    UpdateWindow(hwnd);

    log_line("window ready");
    if let Some(path) = initial {
      app().open_path(&path);
      log_line("initial document opened");
    }
    if std::env::args().any(|arg| arg == "--source-mode") {
      app().toggle_mode();
      log_line("source mode");
    }

    let mut message = MSG::default();
    while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
  }
}

#[cfg(test)]
mod tests {
  use super::replace_all_literal;

  #[test]
  fn replace_all_is_literal_and_case_insensitive() {
    let (result, count) = replace_all_literal("Alpha alpha ALPHA", "alpha", "x");
    assert_eq!(result, "x x x");
    assert_eq!(count, 3);
  }

  #[test]
  fn replace_all_does_not_reprocess_inserted_text() {
    let (result, count) = replace_all_literal("aaa", "a", "aa");
    assert_eq!(result, "aaaaaa");
    assert_eq!(count, 3);
  }
}
