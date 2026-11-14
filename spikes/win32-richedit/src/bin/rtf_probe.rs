//! Minimal EM_STREAMIN probe.
//!
//! Writes the outcome to a file so a GUI-subsystem crash cannot hide the result.
//! Purpose: decide whether RTF (and therefore tables/images) is a viable path in
//! this environment, instead of assuming it from documentation.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, LoadLibraryW};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

const EM_STREAMIN: u32 = 0x0449;
const SF_RTF: usize = 0x0002;
const ES_MULTILINE: u32 = 0x0004;

fn wide(value: &str) -> Vec<u16> {
  OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

#[repr(C)]
struct EditStream {
  dw_cookie: usize,
  dw_error: u32,
  pfn_callback: Option<unsafe extern "system" fn(usize, *mut u8, i32, *mut i32) -> u32>,
}

struct StreamBuffer {
  bytes: Vec<u8>,
  position: usize,
}

unsafe extern "system" fn stream_cb(
  cookie: usize,
  buffer: *mut u8,
  count: i32,
  transferred: *mut i32,
) -> u32 {
  let state = &mut *(cookie as *mut StreamBuffer);
  let remaining = state.bytes.len().saturating_sub(state.position);
  let take = remaining.min(count.max(0) as usize);
  if take == 0 {
    *transferred = 0;
    return 1;
  }
  std::ptr::copy_nonoverlapping(state.bytes.as_ptr().add(state.position), buffer, take);
  state.position += take;
  *transferred = take as i32;
  0
}

static mut EDIT: HWND = std::ptr::null_mut();

unsafe extern "system" fn probe_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
  if msg == WM_CREATE {
    LoadLibraryW(wide("Msftedit.dll").as_ptr());
    let edit = CreateWindowExW(
      0,
      wide("RICHEDIT50W").as_ptr(),
      std::ptr::null(),
      WS_CHILD | ES_MULTILINE,
      0,
      0,
      800,
      600,
      hwnd,
      std::ptr::null_mut(),
      GetModuleHandleW(std::ptr::null()),
      std::ptr::null(),
    );
    EDIT = edit;
    return 0;
  }
  DefWindowProcW(hwnd, msg, wparam, lparam)
}

fn main() {
  let out = std::env::temp_dir().join("vellora-rtf-probe.txt");
  let mut log = String::new();
  unsafe {
    let instance = GetModuleHandleW(std::ptr::null());
    let class = wide("VelloraRtfProbe");
    let wc = WNDCLASSW {
      style: 0,
      lpfnWndProc: Some(probe_proc),
      cbClsExtra: 0,
      cbWndExtra: 0,
      hInstance: instance,
      hIcon: std::ptr::null_mut(),
      hCursor: std::ptr::null_mut(),
      hbrBackground: std::ptr::null_mut(),
      lpszMenuName: std::ptr::null(),
      lpszClassName: class.as_ptr(),
    };
    RegisterClassW(&wc);
    let hwnd = CreateWindowExW(
      0,
      class.as_ptr(),
      wide("probe").as_ptr(),
      WS_OVERLAPPEDWINDOW,
      0,
      0,
      800,
      600,
      std::ptr::null_mut(),
      std::ptr::null_mut(),
      instance,
      std::ptr::null(),
    );
    log.push_str(&format!("hwnd={hwnd:?} edit={:?}\n", EDIT));

    let rtf = "{\\rtf1\\ansi\\deff0 {\\fonttbl{\\f0 Segoe UI;}}\\f0\\fs28\\b hello\\b0  world}";
    let mut buffer = StreamBuffer { bytes: rtf.as_bytes().to_vec(), position: 0 };
    let mut stream = EditStream {
      dw_cookie: &mut buffer as *mut StreamBuffer as usize,
      dw_error: 0,
      pfn_callback: Some(stream_cb),
    };
    let result = SendMessageW(EDIT, EM_STREAMIN, SF_RTF, &mut stream as *mut EditStream as isize);
    log.push_str(&format!("stream result={result} error={}\n", stream.dw_error));

    let length = SendMessageW(EDIT, WM_GETTEXTLENGTH, 0, 0);
    log.push_str(&format!("text length={length}\n"));
    let mut text = vec![0u16; length.max(1) as usize + 1];
    let copied = SendMessageW(EDIT, WM_GETTEXT, text.len(), text.as_mut_ptr() as isize);
    log.push_str(&format!(
      "text copied={copied} value={:?}\n",
      String::from_utf16_lossy(&text[..copied.max(0) as usize])
    ));
  }
  let _ = std::fs::write(&out, &log);
  println!("{log}");
}
