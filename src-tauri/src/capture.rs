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
    let Some(target) = external_frontmost_target() else {
        return;
    };

    let Some(_guard) = CaptureGuard::try_enter() else {
        log_line("already capturing, skipping");
        return;
    };

    if !check_accessibility(app) {
        return;
    }

    log_line("fired");

    let Some(captured) = capture_current_selection_for_target(app, target) else {
        return;
    };

    let source = crate::source::capture_source_for_pid(app, captured.source_pid);
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
/// On macOS, if untrusted, shows actionable guidance and emits `accessibility-needed` to
/// the `main` window; returns false. Windows uses the clipboard path below and
/// needs no separate accessibility permission.
pub fn check_accessibility(app: &AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        if !macos_accessibility_client::accessibility::application_is_trusted() {
            log_line("accessibility NOT trusted — cannot simulate Cmd+C");
            if let Some(window) = crate::windows::note_window(app) {
                let _ = window.show();
                let _ = window.set_focus();
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

#[cfg(any(target_os = "macos", test))]
fn normalized(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(any(target_os = "macos", test))]
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

pub(crate) fn external_frontmost_target() -> Option<crate::source::ForegroundTarget> {
    let target = crate::source::foreground_target()?;
    is_external_frontmost_process(Some(target.pid), std::process::id() as i32).then_some(target)
}

pub(crate) fn capture_current_selection_for_target(
    app: &AppHandle,
    target: crate::source::ForegroundTarget,
) -> Option<CurrentSelection> {
    #[cfg(not(target_os = "windows"))]
    let _ = app;
    if crate::source::foreground_target() != Some(target) {
        return None;
    }
    let pid = target.pid;
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
    return windows_capture::copy_selection(app, target);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    None
}

#[cfg(target_os = "windows")]
mod windows_capture {
    use super::*;
    use std::{mem::size_of, thread, time::Duration};
    use windows_sys::Win32::{
        Foundation::{GetLastError, GlobalFree, SetLastError, ERROR_SUCCESS, HANDLE},
        Graphics::Gdi::{DeleteEnhMetaFile, GetEnhMetaFileBits, SetEnhMetaFileBits, HENHMETAFILE},
        System::{
            DataExchange::{
                CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
                GetClipboardSequenceNumber, OpenClipboard, SetClipboardData,
            },
            Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE},
        },
        UI::Input::KeyboardAndMouse::{
            GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
            KEYEVENTF_KEYUP, VK_C, VK_CONTROL, VK_INSERT, VK_MENU, VK_SHIFT,
        },
    };

    const CF_TEXT: u32 = 1;
    const CF_UNICODETEXT: u32 = 13;
    const CF_BITMAP: u32 = 2;
    const CF_METAFILEPICT: u32 = 3;
    const CF_OEMTEXT: u32 = 7;
    const CF_DIB: u32 = 8;
    const CF_PALETTE: u32 = 9;
    const CF_ENHMETAFILE: u32 = 14;
    const CF_LOCALE: u32 = 16;
    const CF_DIBV5: u32 = 17;
    const CF_OWNERDISPLAY: u32 = 0x0080;
    const CF_DSPTEXT: u32 = 0x0081;
    const CF_DSPBITMAP: u32 = 0x0082;
    const CF_DSPMETAFILEPICT: u32 = 0x0083;
    const CF_DSPENHMETAFILE: u32 = 0x008E;
    const CF_PRIVATEFIRST: u32 = 0x0200;
    const CF_PRIVATELAST: u32 = 0x02FF;
    const CF_GDIOBJFIRST: u32 = 0x0300;
    const CF_GDIOBJLAST: u32 = 0x03FF;

    enum SnapshotData {
        Global(Vec<u8>),
        EnhancedMetafile(Vec<u8>),
    }

    struct SnapshotEntry {
        format: u32,
        data: SnapshotData,
    }

    struct ClipboardSnapshot {
        formats: Vec<SnapshotEntry>,
    }

    fn with_clipboard<T>(owner: Option<HANDLE>, f: impl FnOnce() -> T) -> Option<T> {
        let owner = owner.unwrap_or(std::ptr::null_mut());
        for _ in 0..12 {
            if unsafe { OpenClipboard(owner) } != 0 {
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

    fn synthesized_format(format: u32, formats: &[u32]) -> bool {
        match format {
            CF_TEXT | CF_OEMTEXT | CF_LOCALE => formats.contains(&CF_UNICODETEXT),
            CF_BITMAP | CF_PALETTE => formats.contains(&CF_DIB) || formats.contains(&CF_DIBV5),
            CF_METAFILEPICT => formats.contains(&CF_ENHMETAFILE),
            _ => false,
        }
    }

    fn unsupported_format(format: u32) -> bool {
        matches!(
            format,
            CF_OWNERDISPLAY
                | CF_DSPTEXT
                | CF_DSPBITMAP
                | CF_DSPMETAFILEPICT
                | CF_DSPENHMETAFILE
                | CF_PRIVATEFIRST..=CF_PRIVATELAST
                | CF_GDIOBJFIRST..=CF_GDIOBJLAST
        )
    }

    fn copy_bytes(handle: *mut std::ffi::c_void) -> Option<Vec<u8>> {
        let size = unsafe { GlobalSize(handle) };
        if size == 0 {
            return None;
        }
        let ptr = unsafe { GlobalLock(handle) } as *const u8;
        if ptr.is_null() {
            return None;
        }
        let bytes = unsafe { std::slice::from_raw_parts(ptr, size as usize).to_vec() };
        unsafe { GlobalUnlock(handle) };
        Some(bytes)
    }

    fn enumerate_formats() -> Option<Vec<u32>> {
        let mut formats = Vec::new();
        let mut previous = 0;
        loop {
            unsafe { SetLastError(ERROR_SUCCESS) };
            let next = unsafe { EnumClipboardFormats(previous) };
            if next == 0 {
                return (unsafe { GetLastError() } == ERROR_SUCCESS).then_some(formats);
            }
            formats.push(next);
            previous = next;
        }
    }

    fn copy_enhanced_metafile(handle: HENHMETAFILE) -> Option<Vec<u8>> {
        let size = unsafe { GetEnhMetaFileBits(handle, 0, std::ptr::null_mut()) };
        if size == 0 {
            return None;
        }
        let mut bytes = vec![0; size as usize];
        (unsafe { GetEnhMetaFileBits(handle, size, bytes.as_mut_ptr()) } == size).then_some(bytes)
    }

    /// Snapshot every non-synthesized clipboard representation. Enumeration
    /// errors and genuinely non-copyable formats abort before copy is sent.
    fn snapshot() -> Option<ClipboardSnapshot> {
        with_clipboard(None, || {
            let available = enumerate_formats()?;
            let mut formats = Vec::new();
            for &format in &available {
                if synthesized_format(format, &available) {
                    continue;
                }
                if unsupported_format(format) {
                    return None;
                }
                let handle = unsafe { GetClipboardData(format) };
                if handle.is_null() {
                    return None;
                }
                let data = if format == CF_ENHMETAFILE {
                    SnapshotData::EnhancedMetafile(copy_enhanced_metafile(handle)?)
                } else {
                    SnapshotData::Global(copy_bytes(handle)?)
                };
                formats.push(SnapshotEntry { format, data });
            }
            Some(ClipboardSnapshot { formats })
        })
        .flatten()
    }

    enum PreparedHandle {
        Global(HANDLE),
        EnhancedMetafile(HENHMETAFILE),
    }

    impl PreparedHandle {
        fn raw(&self) -> HANDLE {
            match self {
                Self::Global(handle) | Self::EnhancedMetafile(handle) => *handle,
            }
        }

        fn disarm(&mut self) {
            match self {
                Self::Global(handle) | Self::EnhancedMetafile(handle) => {
                    *handle = std::ptr::null_mut();
                }
            }
        }
    }

    impl Drop for PreparedHandle {
        fn drop(&mut self) {
            let handle = self.raw();
            if handle.is_null() {
                return;
            }
            unsafe {
                match self {
                    Self::Global(_) => {
                        GlobalFree(handle);
                    }
                    Self::EnhancedMetafile(_) => {
                        DeleteEnhMetaFile(handle);
                    }
                }
            }
        }
    }

    struct PreparedEntry {
        format: u32,
        handle: PreparedHandle,
    }

    fn prepare_snapshot(snapshot: &ClipboardSnapshot) -> Option<Vec<PreparedEntry>> {
        snapshot
            .formats
            .iter()
            .map(|entry| {
                let handle = match &entry.data {
                    SnapshotData::Global(bytes) => {
                        let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) };
                        if handle.is_null() {
                            return None;
                        }
                        let ptr = unsafe { GlobalLock(handle) } as *mut u8;
                        if ptr.is_null() {
                            unsafe { GlobalFree(handle) };
                            return None;
                        }
                        unsafe {
                            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
                            GlobalUnlock(handle);
                        }
                        PreparedHandle::Global(handle)
                    }
                    SnapshotData::EnhancedMetafile(bytes) => {
                        let handle =
                            unsafe { SetEnhMetaFileBits(bytes.len() as u32, bytes.as_ptr()) };
                        if handle.is_null() {
                            return None;
                        }
                        PreparedHandle::EnhancedMetafile(handle)
                    }
                };
                Some(PreparedEntry {
                    format: entry.format,
                    handle,
                })
            })
            .collect()
    }

    /// All restoration handles are allocated before copy is sent, so allocation
    /// failure cannot turn a successful snapshot into destructive restoration.
    struct RestoreGuard {
        entries: Vec<PreparedEntry>,
        owner: HANDLE,
        armed: bool,
    }

    impl RestoreGuard {
        fn prepare(snapshot: &ClipboardSnapshot, owner: HANDLE) -> Option<Self> {
            if owner.is_null() {
                return None;
            }
            Some(Self {
                entries: prepare_snapshot(snapshot)?,
                owner,
                armed: false,
            })
        }

        fn arm(&mut self) {
            self.armed = true;
        }

        fn restore(&mut self) -> bool {
            with_clipboard(Some(self.owner), || {
                if unsafe { EmptyClipboard() } == 0 {
                    return false;
                }
                for entry in &mut self.entries {
                    if unsafe { SetClipboardData(entry.format, entry.handle.raw()) }.is_null() {
                        return false;
                    }
                    entry.handle.disarm();
                }
                true
            })
            .unwrap_or(false)
        }
    }

    impl Drop for RestoreGuard {
        fn drop(&mut self) {
            if self.armed && !self.restore() {
                log_line("failed to restore the complete Windows clipboard snapshot");
            }
        }
    }

    fn is_pressed(vk: u16) -> bool {
        (unsafe { GetAsyncKeyState(vk as i32) }) < 0
    }

    fn copy_key_plan(
        vk: u16,
        ctrl_held: bool,
        shift_held: bool,
        alt_held: bool,
    ) -> Vec<(u16, bool)> {
        let mut plan = Vec::with_capacity(10);
        if alt_held {
            plan.push((VK_MENU, true));
        }
        if shift_held {
            plan.push((VK_SHIFT, true));
        }
        if !ctrl_held {
            plan.push((VK_CONTROL, false));
        }
        plan.extend([(vk, false), (vk, true)]);
        if !ctrl_held {
            plan.push((VK_CONTROL, true));
        }
        if shift_held {
            plan.push((VK_SHIFT, false));
        }
        if alt_held {
            plan.push((VK_MENU, false));
        }
        plan
    }

    fn send_copy(vk: u16) -> bool {
        let key = |vk| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    ..Default::default()
                },
            },
        };
        let release = |vk| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    dwFlags: KEYEVENTF_KEYUP,
                    ..Default::default()
                },
            },
        };
        let ctrl_held = is_pressed(VK_CONTROL);
        let shift_held = is_pressed(VK_SHIFT);
        let alt_held = is_pressed(VK_MENU);
        let inputs = copy_key_plan(vk, ctrl_held, shift_held, alt_held)
            .into_iter()
            .map(|(key_code, key_up)| {
                if key_up {
                    release(key_code)
                } else {
                    key(key_code)
                }
            })
            .collect::<Vec<_>>();
        unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                size_of::<INPUT>() as i32,
            ) == inputs.len() as u32
        }
    }

    /// Send `Ctrl+<vk>` and wait (polling `GetClipboardSequenceNumber`) until
    /// the clipboard actually changes. Returns false when the key was not sent
    /// or the target app did not copy anything.
    fn try_copy_and_wait(vk: u16) -> bool {
        let before = unsafe { GetClipboardSequenceNumber() };
        if !send_copy(vk) {
            return false;
        }
        (0..15).any(|_| {
            thread::sleep(Duration::from_millis(10));
            unsafe { GetClipboardSequenceNumber() != before }
        })
    }

    fn clipboard_owner(app: &AppHandle) -> Option<HANDLE> {
        use tauri::Manager;
        Some(app.get_webview_window("main")?.hwnd().ok()?.0)
    }

    pub fn copy_selection(
        app: &AppHandle,
        target: crate::source::ForegroundTarget,
    ) -> Option<CurrentSelection> {
        if target.window_id.is_none() || crate::source::foreground_target() != Some(target) {
            return None;
        }
        // Snapshot before anything else; abandoning here leaves the clipboard
        // untouched. The guard restores it on every exit path below.
        let snapshot = snapshot()?;
        let mut guard = RestoreGuard::prepare(&snapshot, clipboard_owner(app)?)?;

        if crate::source::foreground_target() != Some(target) {
            return None;
        }

        // Prefer Ctrl+Insert (which terminals and most editors map to copy and
        // never interrupts a running process); fall back to Ctrl+C only if the
        // clipboard did not change.
        guard.arm();
        if !try_copy_and_wait(VK_INSERT) && !try_copy_and_wait(VK_C) {
            return None;
        }
        // Discard the result if the foreground window changed during capture.
        if crate::source::foreground_target() != Some(target) {
            return None;
        }
        let copied = with_clipboard(None, read_text)
            .flatten()
            .filter(|text| !text.is_empty());
        let text = copied?;
        let text = String::from_utf16_lossy(&text).trim().to_string();
        (!text.is_empty()).then_some(CurrentSelection {
            text,
            html: None,
            source_pid: target.pid,
            anchor: None,
            method: SelectionMethod::Clipboard,
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn synthesized_image_formats_are_skipped_when_dib_is_available() {
            let formats = [CF_DIB, CF_BITMAP, CF_PALETTE];
            assert!(!synthesized_format(CF_DIB, &formats));
            assert!(synthesized_format(CF_BITMAP, &formats));
            assert!(synthesized_format(CF_PALETTE, &formats));
        }

        #[test]
        fn non_restorable_formats_abandon_the_fallback() {
            for format in [
                CF_OWNERDISPLAY,
                CF_DSPTEXT,
                CF_DSPBITMAP,
                CF_DSPMETAFILEPICT,
                CF_DSPENHMETAFILE,
                CF_PRIVATEFIRST,
                CF_PRIVATELAST,
                CF_GDIOBJFIRST,
                CF_GDIOBJLAST,
            ] {
                assert!(
                    unsupported_format(format),
                    "format {format} must be rejected"
                );
            }
        }

        #[test]
        fn copy_plan_preserves_preexisting_modifiers_without_adding_shift_or_alt() {
            assert_eq!(
                copy_key_plan(VK_C, true, true, true),
                [
                    (VK_MENU, true),
                    (VK_SHIFT, true),
                    (VK_C, false),
                    (VK_C, true),
                    (VK_SHIFT, false),
                    (VK_MENU, false),
                ]
            );
        }

        #[test]
        fn copy_plan_owns_control_only_when_user_did_not_hold_it() {
            assert_eq!(
                copy_key_plan(VK_INSERT, false, false, false),
                [
                    (VK_CONTROL, false),
                    (VK_INSERT, false),
                    (VK_INSERT, true),
                    (VK_CONTROL, true),
                ]
            );
        }
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
