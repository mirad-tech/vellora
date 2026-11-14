//! G1 spike: Win32 + system Rich Edit (RICHEDIT50W, TSF-enabled).
//!
//! Answers the G1 questions with measurements instead of assumptions:
//! * empty-state and 2 MiB document private commit
//! * software input -> forced paint latency (p50/p95)
//! * whether a mature native control can host the 2 MiB mixed document
//!
//! Usage:
//!   spike-richedit [--file <path>] [--measure-input[:n]] [--report <path>] [--exit-after-report]
//!
//! This binary is a measurement harness, not the product. It is excluded from
//! the workspace so it can never enter the installer manifest.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::time::Instant;

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{CreateFontW, UpdateWindow};
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, LoadLibraryW};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows_sys::Win32::UI::HiDpi::{
  SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

// Rich Edit messages are stable ABI values (richedit.h).
const EM_REPLACESEL: u32 = 0x00C2;
const EM_EXLIMITTEXT: u32 = 0x0435;
const ES_MULTILINE: u32 = 0x0004;
const ES_NOHIDESEL: u32 = 0x0100;
const ES_WANTRETURN: u32 = 0x1000;
const EM_STREAMIN: u32 = 0x0449;
const SF_RTF: usize = 0x0002;

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

unsafe extern "system" fn stream_in_callback(
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

fn stream_rtf(hwnd: HWND, rtf: &str) -> u32 {
  let mut buffer = StreamBuffer { bytes: rtf.as_bytes().to_vec(), position: 0 };
  let mut stream = EditStream {
    dw_cookie: &mut buffer as *mut StreamBuffer as usize,
    dw_error: 0,
    pfn_callback: Some(stream_in_callback),
  };
  unsafe { SendMessageW(hwnd, EM_STREAMIN, SF_RTF, &mut stream as *mut EditStream as isize) as u32 }
}

static mut EDIT_HWND: HWND = std::ptr::null_mut();

fn wide(value: &str) -> Vec<u16> {
  OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

struct Args {
  file: Option<PathBuf>,
  measure_input: bool,
  samples: usize,
  report: Option<PathBuf>,
  exit_after_report: bool,
}

fn parse_args() -> Args {
  let mut args =
    Args { file: None, measure_input: false, samples: 120, report: None, exit_after_report: false };
  let raw: Vec<String> = std::env::args().skip(1).collect();
  let mut index = 0;
  while index < raw.len() {
    match raw[index].as_str() {
      "--file" => {
        index += 1;
        if let Some(path) = raw.get(index) {
          args.file = Some(PathBuf::from(path));
        }
      }
      "--report" => {
        index += 1;
        if let Some(path) = raw.get(index) {
          args.report = Some(PathBuf::from(path));
        }
      }
      "--measure-input" => args.measure_input = true,
      "--exit-after-report" => args.exit_after_report = true,
      value if value.starts_with("--measure-input:") => {
        args.measure_input = true;
        if let Ok(parsed) = value["--measure-input:".len()..].parse::<usize>() {
          args.samples = parsed.max(10);
        }
      }
      _ => {}
    }
    index += 1;
  }
  args
}

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
  if sorted.is_empty() {
    return 0.0;
  }
  let index = ((sorted.len() - 1) as f64 * fraction).round() as usize;
  sorted[index]
}

fn measure_input_latency(edit: HWND, samples: usize) -> (f64, f64, f64) {
  let mut latencies = Vec::with_capacity(samples);
  let buffer = wide("a");
  // Warm-up so font fallback and first paint are excluded.
  for _ in 0..10 {
    unsafe {
      SendMessageW(edit, EM_REPLACESEL, 1, buffer.as_ptr() as isize);
      UpdateWindow(edit);
    }
  }
  for _ in 0..samples {
    let start = Instant::now();
    unsafe {
      SendMessageW(edit, EM_REPLACESEL, 1, buffer.as_ptr() as isize);
      // Force the paint so the sample ends at "content visible", not "queued".
      UpdateWindow(edit);
    }
    latencies.push(start.elapsed().as_secs_f64() * 1000.0);
    std::thread::sleep(std::time::Duration::from_millis(2));
  }
  latencies.sort_by(|a, b| a.partial_cmp(b).unwrap());
  (
    percentile(&latencies, 0.50),
    percentile(&latencies, 0.95),
    latencies.last().copied().unwrap_or(0.0),
  )
}

unsafe extern "system" fn wnd_proc(
  hwnd: HWND,
  msg: u32,
  wparam: WPARAM,
  lparam: LPARAM,
) -> LRESULT {
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
      if edit.is_null() {
        return -1;
      }
      EDIT_HWND = edit;
      SendMessageW(edit, EM_EXLIMITTEXT, 0, 0x7FFF_FFFF);
      let font_name = wide("Segoe UI");
      let font = CreateFontW(-20, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, font_name.as_ptr());
      SendMessageW(edit, WM_SETFONT, font as usize, 1);
      0
    }
    WM_SIZE => {
      let width = (lparam & 0xFFFF) as i32;
      let height = ((lparam >> 16) & 0xFFFF) as i32;
      MoveWindow(EDIT_HWND, 0, 0, width, height, 1);
      0
    }
    WM_SETFOCUS => {
      SetFocus(EDIT_HWND);
      0
    }
    WM_DESTROY => {
      PostQuitMessage(0);
      0
    }
    _ => DefWindowProcW(hwnd, msg, wparam, lparam),
  }
}

fn main() {
  let args = parse_args();
  unsafe {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

    let instance = GetModuleHandleW(std::ptr::null());
    let class_name = wide("VelloraSpikeRichEdit");
    let wc = WNDCLASSW {
      style: CS_HREDRAW | CS_VREDRAW,
      lpfnWndProc: Some(wnd_proc),
      cbClsExtra: 0,
      cbWndExtra: 0,
      hInstance: instance,
      hIcon: std::ptr::null_mut(),
      hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
      hbrBackground: std::ptr::null_mut(),
      lpszMenuName: std::ptr::null(),
      lpszClassName: class_name.as_ptr(),
    };
    RegisterClassW(&wc);

    let title = wide("Vellora native spike - Win32 Rich Edit");
    let hwnd = CreateWindowExW(
      0,
      class_name.as_ptr(),
      title.as_ptr(),
      WS_OVERLAPPEDWINDOW | WS_VISIBLE,
      CW_USEDEFAULT,
      CW_USEDEFAULT,
      820,
      900,
      std::ptr::null_mut(),
      std::ptr::null_mut(),
      instance,
      std::ptr::null(),
    );

    let edit = EDIT_HWND;

    if std::env::args().any(|a| a == "--rtf-test") {
      let result = stream_rtf(edit, "{\\rtf1\\ansi\\b hello}");
      println!("stream result={result}");
    }

    if let Some(path) = &args.file {
      let text = std::fs::read_to_string(path).unwrap_or_default();
      let wide_text = wide(&text);
      let started = Instant::now();
      SendMessageW(edit, WM_SETTEXT, 0, wide_text.as_ptr() as isize);
      println!(
        "loaded {} chars from {} in {:.1} ms",
        text.chars().count(),
        path.display(),
        started.elapsed().as_secs_f64() * 1000.0
      );
      let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
      let title = wide(&format!("{name} - Vellora native spike"));
      SetWindowTextW(hwnd, title.as_ptr());
    }

    ShowWindow(hwnd, SW_SHOW);
    UpdateWindow(hwnd);

    if args.measure_input {
      // Enter message-pump-free synchronous path: the control can paint without
      // a pump because UpdateWindow paints immediately.
      let (p50, p95, max) = measure_input_latency(edit, args.samples);
      println!("input->paint samples={} p50={p50:.3}ms p95={p95:.3}ms max={max:.3}ms", args.samples);
      if let Some(path) = &args.report {
        let report = format!(
          "{{\n  \"samples\": {},\n  \"p50_ms\": {p50:.3},\n  \"p95_ms\": {p95:.3},\n  \"max_ms\": {max:.3}\n}}\n",
          args.samples
        );
        let _ = std::fs::write(path, report);
        println!("latency report written to {}", path.display());
      }
      if args.exit_after_report {
        return;
      }
    }

    println!("window ready; pid={}", std::process::id());
    let mut message = MSG::default();
    while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
  }
}
