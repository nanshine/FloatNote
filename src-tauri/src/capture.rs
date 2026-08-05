use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

/// Re-entrancy guard. The global-shortcut callback can fire more than once per
/// physical press on macOS; two concurrent `run_capture` routines would race on
/// the single shared system clipboard (one clearing/restoring it while the other
/// reads → empty selection). Only one capture may run at a time.
static CAPTURING: AtomicBool = AtomicBool::new(false);

pub struct CaptureGuard {
    _priv: (),
}

impl CaptureGuard {
    /// Returns `Some` if this caller acquired the lock, `None` if a capture is
    /// already in flight.
    pub fn try_enter() -> Option<Self> {
        if CAPTURING.swap(true, Ordering::SeqCst) {
            None
        } else {
            Some(Self { _priv: () })
        }
    }
}

impl Drop for CaptureGuard {
    fn drop(&mut self) {
        CAPTURING.store(false, Ordering::SeqCst);
    }
}

#[cfg(target_os = "macos")]
fn log_line(msg: &str) {
    use std::io::Write;
    eprintln!("[capture] {msg}");
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/floatnote-capture.log")
    {
        let _ = writeln!(file, "{msg}");
    }
}

#[cfg(not(target_os = "macos"))]
fn log_line(msg: &str) {
    eprintln!("[capture] {msg}");
}

pub fn run_capture(app: &AppHandle) {
    if external_frontmost_pid().is_none() {
        return;
    }

    let Some(_guard) = CaptureGuard::try_enter() else {
        log_line("already capturing, skipping");
        return;
    };

    if !check_accessibility(app) {
        return;
    }

    log_line("fired");

    let Some(captured) = capture_current_selection() else {
        return;
    };

    let source = crate::source::capture_source(app);
    let payload = crate::source::QuotePayload {
        text: captured.text,
        html: captured.html,
        source,
    };
    let _ = app.emit_to("main", "quote-captured", payload);

    if let Some(window) = crate::windows::note_window(app) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

/// macOS Accessibility trust check. Returns true if capture may proceed.
/// On macOS, if untrusted, prompts once and emits `accessibility-needed` to
/// the `main` window; returns false. Windows uses the clipboard path below and
/// needs no separate accessibility permission.
pub fn check_accessibility(app: &AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        static PROMPTED: AtomicBool = AtomicBool::new(false);
        if !macos_accessibility_client::accessibility::application_is_trusted() {
            log_line("accessibility NOT trusted — cannot simulate Cmd+C");
            if !PROMPTED.swap(true, Ordering::SeqCst) {
                macos_accessibility_client::accessibility::application_is_trusted_with_prompt();
            }
            let _ = app.emit_to("main", "accessibility-needed", ());
            return false;
        }
    }
    let _ = app;
    true
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelectionMethod {
    Accessibility,
    Clipboard,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SelectionAnchor {
    pub x: f64,
    pub y: f64,
}

#[allow(dead_code)]
pub struct CurrentSelection {
    pub text: String,
    pub html: Option<String>,
    pub source_pid: i32,
    pub anchor: Option<SelectionAnchor>,
    pub method: SelectionMethod,
}

fn normalized(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn merge_html(mut ax: CurrentSelection, copied: Option<CurrentSelection>) -> CurrentSelection {
    if let Some(copied) = copied {
        if normalized(&ax.text) == normalized(&copied.text) {
            ax.html = copied.html;
        }
    }
    ax
}

#[cfg(target_os = "macos")]
mod pasteboard {
    use super::*;
    use objc2::runtime::ProtocolObject;
    use objc2::ClassType;
    use objc2_app_kit::{
        NSPasteboard, NSPasteboardContentsOptions, NSPasteboardItem, NSPasteboardTypeHTML,
        NSPasteboardTypeString, NSPasteboardWriting,
    };
    use objc2_foundation::{NSArray, NSData, NSString};

    struct ItemBackup(Vec<(String, Vec<u8>)>);

    fn backup(board: &NSPasteboard) -> Vec<ItemBackup> {
        let Some(items) = (unsafe { board.pasteboardItems() }) else {
            return Vec::new();
        };
        (0..items.len())
            .filter_map(|index| {
                let item = unsafe { items.objectAtIndex(index) };
                let types = unsafe { item.types() };
                let reps = (0..types.len())
                    .filter_map(|type_index| {
                        let ty = unsafe { types.objectAtIndex(type_index) };
                        let data = unsafe { item.dataForType(&ty) }?;
                        Some((ty.to_string(), data.bytes().to_vec()))
                    })
                    .collect::<Vec<_>>();
                (!reps.is_empty()).then_some(ItemBackup(reps))
            })
            .collect()
    }

    fn restore(board: &NSPasteboard, backup: Vec<ItemBackup>) {
        unsafe {
            board.prepareForNewContentsWithOptions(
                NSPasteboardContentsOptions::NSPasteboardContentsCurrentHostOnly,
            );
        }
        if backup.is_empty() {
            return;
        }
        let objects = backup
            .into_iter()
            .map(|item| {
                let object = unsafe { NSPasteboardItem::init(NSPasteboardItem::alloc()) };
                for (ty, bytes) in item.0 {
                    let ty = NSString::from_str(&ty);
                    let data = NSData::with_bytes(&bytes);
                    unsafe { object.setData_forType(&data, &ty) };
                }
                ProtocolObject::<dyn NSPasteboardWriting>::from_retained(object)
            })
            .collect::<Vec<_>>();
        unsafe { board.writeObjects(&NSArray::from_vec(objects)) };
    }

    fn send_copy(pid: i32) -> bool {
        use core_graphics::event::{CGEvent, CGEventFlags};
        use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
        let Ok(source) = CGEventSource::new(CGEventSourceStateID::CombinedSessionState) else {
            return false;
        };
        let Ok(down) = CGEvent::new_keyboard_event(source.clone(), 8, true) else {
            return false;
        };
        down.set_flags(CGEventFlags::CGEventFlagCommand);
        down.post_to_pid(pid);
        let Ok(up) = CGEvent::new_keyboard_event(source, 8, false) else {
            return false;
        };
        up.set_flags(CGEventFlags::CGEventFlagCommand);
        up.post_to_pid(pid);
        true
    }

    pub fn copy_selection(pid: i32) -> Option<CurrentSelection> {
        if crate::source::frontmost_pid() != Some(pid) {
            return None;
        }
        let board = unsafe { NSPasteboard::generalPasteboard() };
        let before = unsafe { board.changeCount() };
        let saved = backup(&board);
        if !send_copy(pid) {
            return None;
        }
        let changed = (0..15).any(|_| {
            std::thread::sleep(std::time::Duration::from_millis(10));
            unsafe { board.changeCount() != before }
        });
        if !changed {
            restore(&board, saved);
            return None;
        }
        if crate::source::frontmost_pid() != Some(pid) {
            restore(&board, saved);
            return None;
        }
        let text = unsafe { board.stringForType(NSPasteboardTypeString) }
            .map(|text| text.to_string())
            .unwrap_or_default();
        let html = unsafe { board.stringForType(NSPasteboardTypeHTML) }
            .map(|html| html.to_string())
            .filter(|html| !html.trim().is_empty());
        restore(&board, saved);
        (!text.trim().is_empty()).then(|| CurrentSelection {
            text: text.trim().to_string(),
            html,
            source_pid: pid,
            anchor: None,
            method: SelectionMethod::Clipboard,
        })
    }
}

pub(crate) fn is_external_frontmost_process(pid: Option<i32>, own_pid: i32) -> bool {
    pid.is_some_and(|pid| pid != own_pid)
}

pub(crate) fn external_frontmost_pid() -> Option<i32> {
    let pid = crate::source::frontmost_pid();
    is_external_frontmost_process(pid, std::process::id() as i32).then_some(pid?)
}

pub fn capture_current_selection() -> Option<CurrentSelection> {
    let pid = external_frontmost_pid()?;
    if let Some(text) = crate::selection_probe::current_selected_text(pid) {
        let ax = CurrentSelection {
            text,
            html: None,
            source_pid: pid,
            anchor: None,
            method: SelectionMethod::Accessibility,
        };
        #[cfg(target_os = "macos")]
        return Some(merge_html(ax, pasteboard::copy_selection(pid)));
        #[cfg(not(target_os = "macos"))]
        return Some(ax);
    }
    #[cfg(target_os = "macos")]
    return pasteboard::copy_selection(pid);
    #[cfg(target_os = "windows")]
    return windows_capture::copy_selection(pid);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    None
}

#[cfg(target_os = "windows")]
mod windows_capture {
    use super::*;
    use std::{mem::size_of, thread, time::Duration};
    use windows_sys::Win32::{
        System::{
            DataExchange::{CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData},
            Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE},
        },
        UI::{
            Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_C, VK_CONTROL},
            WindowsAndMessaging::GetForegroundWindow,
        },
    };

    const CF_UNICODETEXT: u32 = 13;

    fn with_clipboard<T>(f: impl FnOnce() -> T) -> Option<T> {
        for _ in 0..12 {
            if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
                let value = f();
                unsafe { CloseClipboard() };
                return Some(value);
            }
            thread::sleep(Duration::from_millis(10));
        }
        None
    }

    fn read_text() -> Option<Vec<u16>> {
        let handle = unsafe { GetClipboardData(CF_UNICODETEXT) };
        if handle.is_null() {
            return None;
        }
        let ptr = unsafe { GlobalLock(handle) } as *const u16;
        if ptr.is_null() {
            return None;
        }
        let capacity = unsafe { GlobalSize(handle) } / size_of::<u16>();
        let mut length = 0;
        while length < capacity && unsafe { *ptr.add(length) } != 0 {
            length += 1;
        }
        let text = unsafe { std::slice::from_raw_parts(ptr, length).to_vec() };
        unsafe { GlobalUnlock(handle) };
        Some(text)
    }

    fn write_text(text: Option<&[u16]>) {
        unsafe { EmptyClipboard() };
        let Some(text) = text else { return };
        let bytes = (text.len() + 1) * size_of::<u16>();
        let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes) };
        if handle.is_null() {
            return;
        }
        let ptr = unsafe { GlobalLock(handle) } as *mut u16;
        if ptr.is_null() {
            return;
        }
        unsafe {
            std::ptr::copy_nonoverlapping(text.as_ptr(), ptr, text.len());
            *ptr.add(text.len()) = 0;
            GlobalUnlock(handle);
            let _ = SetClipboardData(CF_UNICODETEXT, handle);
        }
    }

    fn send_copy() -> bool {
        let key = |vk| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT { wVk: vk, ..Default::default() },
            },
        };
        let release = |vk| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT { wVk: vk, dwFlags: KEYEVENTF_KEYUP, ..Default::default() },
            },
        };
        let inputs = [key(VK_CONTROL), key(VK_C), release(VK_C), release(VK_CONTROL)];
        unsafe {
            SendInput(inputs.len() as u32, inputs.as_ptr(), size_of::<INPUT>() as i32)
                == inputs.len() as u32
        }
    }

    pub fn copy_selection(pid: i32) -> Option<CurrentSelection> {
        if crate::source::frontmost_pid() != Some(pid)
            || unsafe { GetForegroundWindow() }.is_null()
        {
            return None;
        }
        let saved = with_clipboard(read_text)?;
        if !send_copy() {
            let _ = with_clipboard(|| write_text(saved.as_deref()));
            return None;
        }
        thread::sleep(Duration::from_millis(80));
        let copied = with_clipboard(read_text).flatten().filter(|text| !text.is_empty());
        let _ = with_clipboard(|| write_text(saved.as_deref()));
        let text = copied?;
        let text = String::from_utf16_lossy(&text).trim().to_string();
        (!text.is_empty()).then_some(CurrentSelection {
            text,
            html: None,
            source_pid: pid,
            anchor: None,
            method: SelectionMethod::Clipboard,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_scope_accepts_only_an_external_frontmost_process() {
        assert!(is_external_frontmost_process(Some(42), 7));
        assert!(!is_external_frontmost_process(Some(7), 7));
        assert!(!is_external_frontmost_process(None, 7));
    }

    #[test]
    fn ax_text_survives_failed_or_mismatched_html_enrichment() {
        let make = |text: &str, html: Option<&str>| CurrentSelection {
            text: text.into(),
            html: html.map(str::to_string),
            source_pid: 1,
            anchor: None,
            method: SelectionMethod::Accessibility,
        };
        let ax = make("hello world", None);
        assert_eq!(merge_html(ax, None).text, "hello world");

        let ax = make("hello world", None);
        let stale = make("old", Some("<b>old</b>"));
        assert!(merge_html(ax, Some(stale)).html.is_none());

        let ax = make("hello world", None);
        let copied = make("hello   world", Some("<b>hello world</b>"));
        assert_eq!(
            merge_html(ax, Some(copied)).html.as_deref(),
            Some("<b>hello world</b>")
        );
    }
}
