//! Passive macOS/Windows selection monitoring.
//!
//! The event tap lives on its own CFRunLoop and is listen-only. The FFI
//! callback copies event metadata into a bounded channel; Tauri, AX and
//! clipboard work run outside the input thread on a separate retrieval worker. The structure is adapted
//! from selection-hook's MIT-licensed macOS implementation.

#[cfg(target_os = "macos")]
use std::sync::mpsc;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread::JoinHandle;
use std::time::Instant;
#[cfg(target_os = "macos")]
use std::{cell::Cell, ffi::c_void, sync::atomic::AtomicPtr};
use tauri::{AppHandle, Manager};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetDoubleClickTime, VK_LBUTTON, VK_SHIFT,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

#[cfg(any(target_os = "macos", test))]
use crate::selection_intent::Point;
#[cfg(target_os = "macos")]
use crate::selection_intent::{MouseDown, MouseUp, SelectionIntentTracker};

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy)]
struct LogicalRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[cfg(any(target_os = "macos", test))]
fn point_in_rect(point: Point, rect: LogicalRect) -> bool {
    point.x >= rect.x
        && point.x <= rect.x + rect.width
        && point.y >= rect.y
        && point.y <= rect.y + rect.height
}

#[cfg(any(target_os = "macos", test))]
fn should_dismiss_for_key(popup_visible: bool, popup_interactive: bool) -> bool {
    popup_visible && !popup_interactive
}

#[cfg(target_os = "macos")]
mod cg {
    use std::ffi::c_void;

    pub const KCG_SESSION_EVENT_TAP: i32 = 1;
    pub const KCG_TAIL_APPEND_EVENT_TAP: i32 = 1;
    pub const KCG_EVENT_TAP_OPTION_LISTEN_ONLY: u32 = 1;
    pub const KCG_LEFT_MOUSE_DOWN: u32 = 1;
    pub const KCG_LEFT_MOUSE_UP: u32 = 2;
    pub const KCG_KEY_DOWN: u32 = 10;
    pub const KCG_LEFT_MOUSE_DRAGGED: u32 = 6;
    pub const KCG_TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
    pub const KCG_TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;
    pub const EVENT_MASK: u64 = (1u64 << KCG_LEFT_MOUSE_DOWN)
        | (1u64 << KCG_LEFT_MOUSE_UP)
        | (1u64 << KCG_KEY_DOWN)
        | (1u64 << KCG_LEFT_MOUSE_DRAGGED);
    pub const KCG_MOUSE_EVENT_NUMBER: u32 = 0;
    pub const KCG_MOUSE_EVENT_CLICK_STATE: u32 = 1;

    pub type CGEventRef = *mut c_void;
    pub type CGEventTapCallBack =
        extern "C" fn(*mut c_void, u32, CGEventRef, *mut c_void) -> CGEventRef;

    #[repr(C)]
    pub struct CGPoint {
        pub x: f64,
        pub y: f64,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        pub fn CGEventTapCreate(
            tap: i32,
            place: i32,
            options: u32,
            event_mask: u64,
            callback: CGEventTapCallBack,
            user_info: *mut c_void,
        ) -> *mut c_void;
        pub fn CGEventGetLocation(event: CGEventRef) -> CGPoint;
        pub fn CGEventGetTimestamp(event: CGEventRef) -> u64;
        pub fn CGEventGetFlags(event: CGEventRef) -> u64;
        pub fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
        pub fn CGEventTapEnable(tap: *mut c_void, enable: bool);
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub fn CFMachPortCreateRunLoopSource(
            alloc: *mut c_void,
            port: *mut c_void,
            order: i32,
        ) -> *mut c_void;
        pub fn CFRunLoopGetCurrent() -> *mut c_void;
        pub fn CFRunLoopAddSource(rl: *mut c_void, source: *mut c_void, mode: *const c_void);
        pub fn CFRunLoopRemoveSource(rl: *mut c_void, source: *mut c_void, mode: *const c_void);
        pub fn CFRunLoopRunInMode(
            mode: *const c_void,
            seconds: f64,
            return_after_source: u8,
        ) -> i32;
        pub fn CFMachPortInvalidate(port: *mut c_void);
        pub fn CFRelease(cf: *const c_void);
        pub static kCFRunLoopDefaultMode: *const c_void;
    }
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
struct GlobalEvent {
    event_type: u32,
    point: Point,
    event_number: u64,
    click_count: u8,
    epoch: u64,
    pid: Option<i32>,
    timestamp_ms: u64,
    text_cursor: bool,
    shift: bool,
    at: Instant,
}

#[cfg(target_os = "macos")]
struct CallbackState {
    sender: mpsc::SyncSender<GlobalEvent>,
    port: AtomicPtr<c_void>,
    drag: Cell<crate::selection_intent::DragEvidence>,
}

#[cfg(target_os = "macos")]
extern "C" fn event_callback(
    _proxy: *mut c_void,
    event_type: u32,
    event: *mut c_void,
    user_info: *mut c_void,
) -> *mut c_void {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let state = unsafe { &*(user_info as *const CallbackState) };
        if matches!(
            event_type,
            cg::KCG_TAP_DISABLED_BY_TIMEOUT | cg::KCG_TAP_DISABLED_BY_USER_INPUT
        ) {
            crate::selection_worker::invalidate();
            state
                .drag
                .set(crate::selection_intent::DragEvidence::default());
            let port = state.port.load(Ordering::Acquire);
            if !port.is_null() {
                unsafe { cg::CGEventTapEnable(port, true) };
            }
            return;
        }
        // Ignore our synthesized Cmd+C so fallback does not cancel itself.
        if event_type == cg::KCG_KEY_DOWN
            && unsafe { cg::CGEventGetIntegerValueField(event, 41) } == std::process::id() as i64
        {
            return;
        }
        let timestamp_ms = unsafe { cg::CGEventGetTimestamp(event) } / 1_000_000;
        if matches!(event_type, cg::KCG_LEFT_MOUSE_DOWN | cg::KCG_KEY_DOWN) {
            crate::selection_worker::invalidate();
        }
        let mut drag = state.drag.get();
        if event_type == cg::KCG_LEFT_MOUSE_DOWN {
            drag.begin(timestamp_ms, is_text_cursor());
        } else if event_type == cg::KCG_LEFT_MOUSE_DRAGGED {
            if drag.should_sample(timestamp_ms) {
                drag.sample(timestamp_ms, is_text_cursor());
            }
            state.drag.set(drag);
            return;
        }
        let text_cursor = if event_type == cg::KCG_LEFT_MOUSE_UP {
            drag.finish(is_text_cursor())
        } else {
            false
        };
        state.drag.set(drag);
        let location = unsafe { cg::CGEventGetLocation(event) };
        let snapshot = GlobalEvent {
            event_type,
            point: Point {
                x: location.x,
                y: location.y,
            },
            event_number: unsafe {
                cg::CGEventGetIntegerValueField(event, cg::KCG_MOUSE_EVENT_NUMBER)
            } as u64,
            click_count: unsafe {
                cg::CGEventGetIntegerValueField(event, cg::KCG_MOUSE_EVENT_CLICK_STATE)
            }
            .clamp(1, u8::MAX as i64) as u8,
            at: Instant::now(),
            epoch: crate::selection_worker::current(),
            pid: crate::source::frontmost_pid(),
            timestamp_ms,
            text_cursor,
            shift: unsafe { cg::CGEventGetFlags(event) } & (1 << 17) != 0,
        };
        if state.sender.try_send(snapshot).is_err() {
            // Lost input must invalidate pending gestures rather than pair unrelated events.
            crate::selection_worker::invalidate();
        }
    }));
    event
}

#[cfg(target_os = "macos")]
struct MonitorRuntime {
    stop: Arc<AtomicBool>,
    event_thread: JoinHandle<()>,
    worker_thread: JoinHandle<()>,
}

#[cfg(target_os = "macos")]
static MONITOR: Mutex<Option<MonitorRuntime>> = Mutex::new(None);

#[cfg(target_os = "macos")]
fn is_text_cursor() -> bool {
    use objc2_app_kit::NSCursor;
    objc2::rc::autoreleasepool(|_| unsafe {
        NSCursor::currentSystemCursor().is_some_and(|cursor| {
            let hotspot = cursor.hotSpot();
            // currentSystemCursor can be a different object from the process-local
            // standard cursor. Compare cursor evidence, not object identity.
            hotspot == NSCursor::IBeamCursor().hotSpot()
                || hotspot == NSCursor::IBeamCursorForVerticalLayout().hotSpot()
                || matches!(
                    (hotspot.x, hotspot.y),
                    (4.0, 9.0) | (16.0, 16.0) | (12.0, 11.0)
                )
        })
    })
}

/// Owned handle to the Windows polling monitor. Holding the stop flag + thread
/// join lets `uninstall` actually stop the loop and lets `install` start a
/// fresh one, mirroring the macOS monitor lifecycle.
#[cfg(target_os = "windows")]
struct WindowsMonitorRuntime {
    stop: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

#[cfg(target_os = "windows")]
static WINDOWS_MONITOR: Mutex<Option<WindowsMonitorRuntime>> = Mutex::new(None);

#[cfg(target_os = "windows")]
#[derive(Clone, Copy)]
struct WinDownState {
    target: crate::source::ForegroundTarget,
    x: i32,
    y: i32,
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy)]
struct WinUpState {
    target: crate::source::ForegroundTarget,
    x: i32,
    y: i32,
    at: Instant,
}

#[cfg(target_os = "windows")]
fn cursor_pos() -> Option<(i32, i32)> {
    let mut point = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
    if unsafe { GetCursorPos(&mut point) } != 0 {
        Some((point.x, point.y))
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn popup_contains_physical_point(app: &AppHandle, x: i32, y: i32) -> Option<bool> {
    let popup = app.get_webview_window("selection-popup")?;
    if !popup.is_visible().ok()? {
        return None;
    }
    let position = popup.outer_position().ok()?;
    let size = popup.outer_size().ok()?;
    let x = i64::from(x);
    let y = i64::from(y);
    let left = i64::from(position.x);
    let top = i64::from(position.y);
    Some(
        x >= left
            && x <= left + i64::from(size.width)
            && y >= top
            && y <= top + i64::from(size.height),
    )
}

/// Whether a completed left-button press looks like a text-selection gesture.
/// A plain click (small movement, no double-click, no Shift held) is treated as
/// a no-op so we never synthesize a copy shortcut for it.
#[cfg(target_os = "windows")]
fn has_selection_intent(
    down: WinDownState,
    up: WinUpState,
    last_up: Option<WinUpState>,
    shift_held: bool,
) -> bool {
    let dx = (up.x - down.x) as f64;
    let dy = (up.y - down.y) as f64;
    if (dx * dx + dy * dy).sqrt() >= crate::selection_intent::DRAG_THRESHOLD {
        return true;
    }
    if shift_held {
        return true;
    }
    let double_click_ms = unsafe { GetDoubleClickTime() } as u64;
    last_up.is_some_and(|previous| {
        previous.target == down.target
            && up.at.duration_since(previous.at).as_millis() as u64 <= double_click_ms
            && (up.x - previous.x).abs() < crate::selection_intent::DRAG_THRESHOLD as i32
            && (up.y - previous.y).abs() < crate::selection_intent::DRAG_THRESHOLD as i32
    })
}

/// Windows polling monitor. Tracks left-button presses and only reports a
/// selection when the gesture indicates one (drag, double-click, or
/// Shift+click) and the foreground PID/window stayed the same from press to
/// release. Exits as soon as `stop` is set so `uninstall` can join it.
#[cfg(target_os = "windows")]
fn windows_monitor_loop(app: AppHandle, stop: Arc<AtomicBool>) {
    let capture_worker = crate::selection_worker::Worker::start(app.clone());
    let mut epoch = crate::selection_worker::current();
    let mut last_target = crate::source::foreground_target();
    let mut was_down = false;
    let mut down_state: Option<WinDownState> = None;
    let mut last_up: Option<WinUpState> = None;
    let mut keys = [false; 256];
    while !stop.load(Ordering::SeqCst) {
        let foreground = crate::source::foreground_target();
        if foreground != last_target {
            epoch = crate::selection_worker::invalidate();
            last_target = foreground;
            down_state = None;
            last_up = None;
        }
        let mut typed = false;
        for key in 8..256 {
            // Modifier transitions belong to Shift+click and should not erase its press.
            if matches!(key, 16..=18 | 160..=165) {
                continue;
            }
            let pressed = unsafe { GetAsyncKeyState(key as i32) } < 0;
            if pressed && !keys[key] && !crate::capture::is_pending_copy_key(key as u16) {
                typed = true;
            }
            keys[key] = pressed;
        }
        if typed {
            epoch = crate::selection_worker::invalidate();
            down_state = None;
            last_up = None;
            if crate::popup::is_visible(&app) && !crate::popup::is_interactive(&app) {
                crate::popup::dismiss_active(&app);
            }
        }
        let is_down = unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } < 0;
        if is_down && !was_down {
            epoch = crate::selection_worker::invalidate();
            let point = cursor_pos();
            if point.is_some_and(|(x, y)| popup_contains_physical_point(&app, x, y) == Some(false))
            {
                crate::popup::dismiss_active(&app);
            }
            down_state = crate::source::foreground_target()
                .and_then(|target| point.map(|(x, y)| WinDownState { target, x, y }));
        } else if !is_down && was_down {
            if let Some(down) = down_state.take() {
                let now = Instant::now();
                if let Some((x, y)) = cursor_pos() {
                    let up = WinUpState {
                        target: down.target,
                        x,
                        y,
                        at: now,
                    };
                    let shift_held = unsafe { GetAsyncKeyState(VK_SHIFT as i32) } < 0;
                    if has_selection_intent(down, up, last_up, shift_held)
                        && auto_mode_enabled(&app)
                        && crate::source::foreground_target() == Some(down.target)
                    {
                        if let Some(anchor) = crate::cursor::get_cursor_pos(&app) {
                            capture_worker.submit(crate::selection_worker::Request {
                                epoch,
                                target: down.target,
                                anchor,
                                allow_clipboard: windows_text_cursor(),
                                at: now,
                            });
                        }
                    }
                    last_up = Some(up);
                }
            }
        }
        was_down = is_down;
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

fn auto_mode_enabled(app: &AppHandle) -> bool {
    app.try_state::<crate::state::AppState>()
        .and_then(|state| {
            state
                .config
                .lock()
                .ok()
                .map(|config| config.auto_popup_mode == "auto")
        })
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn windows_text_cursor() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetCursorInfo, LoadCursorW, CURSORINFO, IDC_IBEAM,
    };
    let mut info: CURSORINFO = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<CURSORINFO>() as u32;
    unsafe {
        GetCursorInfo(&mut info) != 0
            && info.hCursor == LoadCursorW(std::ptr::null_mut(), IDC_IBEAM)
    }
}

#[cfg(target_os = "macos")]
fn popup_rect(app: &AppHandle) -> Option<LogicalRect> {
    let popup = app.get_webview_window("selection-popup")?;
    if !popup.is_visible().ok()? {
        return None;
    }
    let scale = popup.scale_factor().ok()?;
    let position = popup.outer_position().ok()?;
    let size = popup.outer_size().ok()?;
    Some(LogicalRect {
        x: position.x as f64 / scale,
        y: position.y as f64 / scale,
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
    })
}

#[cfg(target_os = "macos")]
fn worker_loop(app: AppHandle, receiver: mpsc::Receiver<GlobalEvent>, stop: Arc<AtomicBool>) {
    let capture_worker = crate::selection_worker::Worker::start(app.clone());
    let mut tracker = SelectionIntentTracker::default();
    let mut down_time = 0;
    while let Ok(event) = receiver.recv() {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        if !crate::selection_worker::is_current(event.epoch) {
            continue;
        }
        if event.event_type == cg::KCG_KEY_DOWN {
            if should_dismiss_for_key(
                crate::popup::is_visible(&app),
                crate::popup::is_interactive(&app),
            ) {
                crate::popup::dismiss_active(&app);
            }
            continue;
        }
        if event.event_type == cg::KCG_LEFT_MOUSE_DOWN {
            tracker = SelectionIntentTracker::default();
            if let Some(rect) = popup_rect(&app) {
                if point_in_rect(event.point, rect) {
                    continue;
                }
                crate::popup::dismiss_active(&app);
            }
            if !auto_mode_enabled(&app) {
                continue;
            }
            let Some(pid) = event.pid else {
                continue;
            };
            if !crate::capture::is_external_frontmost_process(Some(pid), std::process::id() as i32)
            {
                continue;
            }
            down_time = event.timestamp_ms;
            tracker.on_mouse_down(MouseDown {
                event_number: event.event_number,
                pid,
                point: event.point,
                // Cursor evidence is evaluated at release, including samples during drag.
                target: crate::selection_intent::AxTargetKind::WebArea,
            });
            continue;
        }
        if event.event_type != cg::KCG_LEFT_MOUSE_UP || !auto_mode_enabled(&app) {
            continue;
        }
        let Some(pid) = event.pid else {
            continue;
        };
        let candidate = tracker.on_mouse_up(MouseUp {
            event_number: event.event_number,
            pid,
            point: event.point,
            click_count: event.click_count,
            shift: event.shift,
        });
        if let Some(candidate) = candidate {
            if !event.text_cursor || event.timestamp_ms.saturating_sub(down_time) > 15_000 {
                continue;
            }
            capture_worker.submit(crate::selection_worker::Request {
                epoch: event.epoch,
                target: crate::source::ForegroundTarget {
                    pid: candidate.pid,
                    window_id: None,
                },
                anchor: (candidate.up.x, candidate.up.y),
                allow_clipboard: event.text_cursor,
                at: event.at,
            });
        }
    }
}

pub fn install(app: AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use tauri::Emitter;
        let mut slot = MONITOR.lock().expect("MONITOR mutex poisoned");
        if slot.is_some() || !macos_accessibility_client::accessibility::application_is_trusted() {
            return;
        }
        let (sender, receiver) = mpsc::sync_channel::<GlobalEvent>(128);
        let stop = Arc::new(AtomicBool::new(false));
        let worker_app = app.clone();
        let worker_stop = stop.clone();
        let worker_thread =
            std::thread::spawn(move || worker_loop(worker_app, receiver, worker_stop));
        let (ready_tx, ready_rx) = mpsc::sync_channel::<bool>(1);
        let stopping = stop.clone();
        let event_thread = std::thread::spawn(move || {
            let state = Box::new(CallbackState {
                sender,
                port: AtomicPtr::new(std::ptr::null_mut()),
                drag: Cell::new(crate::selection_intent::DragEvidence::default()),
            });
            let user_info = (&*state as *const CallbackState).cast_mut().cast();
            let port = unsafe {
                cg::CGEventTapCreate(
                    cg::KCG_SESSION_EVENT_TAP,
                    cg::KCG_TAIL_APPEND_EVENT_TAP,
                    cg::KCG_EVENT_TAP_OPTION_LISTEN_ONLY,
                    cg::EVENT_MASK,
                    event_callback,
                    user_info,
                )
            };
            if port.is_null() {
                let _ = ready_tx.send(false);
                return;
            }
            state.port.store(port, Ordering::Release);
            let source =
                unsafe { cg::CFMachPortCreateRunLoopSource(std::ptr::null_mut(), port, 0) };
            if source.is_null() {
                unsafe { cg::CFRelease(port) };
                let _ = ready_tx.send(false);
                return;
            }
            let run_loop = unsafe { cg::CFRunLoopGetCurrent() };
            unsafe {
                cg::CFRunLoopAddSource(run_loop, source, cg::kCFRunLoopDefaultMode);
                cg::CGEventTapEnable(port, true);
            }
            let _ = ready_tx.send(true);
            run_until_stopped(&stopping, || unsafe {
                cg::CFRunLoopRunInMode(cg::kCFRunLoopDefaultMode, 0.05, 1) != 1
            });
            unsafe {
                cg::CGEventTapEnable(port, false);
                cg::CFRunLoopRemoveSource(run_loop, source, cg::kCFRunLoopDefaultMode);
                cg::CFMachPortInvalidate(port);
                cg::CFRelease(source);
                cg::CFRelease(port);
            }
        });
        match ready_rx.recv_timeout(std::time::Duration::from_secs(1)) {
            Ok(true) => {
                *slot = Some(MonitorRuntime {
                    stop,
                    event_thread,
                    worker_thread,
                });
            }
            _ => {
                stop.store(true, Ordering::SeqCst);
                let _ = event_thread.join();
                let _ = worker_thread.join();
                let _ = app.emit_to("main", "selection-monitor-failed", ());
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        #[cfg(target_os = "windows")]
        {
            let mut slot = WINDOWS_MONITOR
                .lock()
                .expect("WINDOWS_MONITOR mutex poisoned");
            if slot.is_some() {
                return;
            }
            let stop = Arc::new(AtomicBool::new(false));
            let handle = {
                let stop = stop.clone();
                std::thread::spawn(move || windows_monitor_loop(app, stop))
            };
            *slot = Some(WindowsMonitorRuntime { stop, handle });
        }
        #[cfg(not(target_os = "windows"))]
        let _ = app;
    }
}

pub fn uninstall() {
    crate::selection_worker::invalidate();
    #[cfg(target_os = "macos")]
    if let Some(runtime) = MONITOR.lock().expect("MONITOR mutex poisoned").take() {
        runtime.stop.store(true, Ordering::SeqCst);
        let _ = runtime.event_thread.join();
        let _ = runtime.worker_thread.join();
    }
    #[cfg(target_os = "windows")]
    if let Some(runtime) = WINDOWS_MONITOR
        .lock()
        .expect("WINDOWS_MONITOR mutex poisoned")
        .take()
    {
        runtime.stop.store(true, Ordering::SeqCst);
        let _ = runtime.handle.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn stop_before_run_loop_start_is_not_lost() {
        let stop = AtomicBool::new(true);
        run_until_stopped(&stop, || panic!("stop was lost before first pass"));
    }

    #[test]
    fn stop_during_run_loop_pass_prevents_a_second_pass() {
        let stop = AtomicBool::new(false);
        let mut passes = 0;
        run_until_stopped(&stop, || {
            passes += 1;
            stop.store(true, Ordering::SeqCst);
            true
        });
        assert_eq!(passes, 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_run_loop_stop_between_check_and_entry_is_bounded() {
        // Reproduce the original stop-before-CFRunLoopRun window with an actual
        // CF source. No Accessibility permission or synthetic system input needed.
        #[link(name = "CoreFoundation", kind = "framework")]
        extern "C" {
            fn CFAbsoluteTimeGetCurrent() -> f64;
            fn CFRunLoopTimerCreate(
                allocator: *const c_void,
                date: f64,
                interval: f64,
                flags: usize,
                order: isize,
                callback: extern "C" fn(*mut c_void, *mut c_void),
                context: *mut c_void,
            ) -> *mut c_void;
            fn CFRunLoopAddTimer(run_loop: *mut c_void, timer: *mut c_void, mode: *const c_void);
            fn CFRunLoopRemoveTimer(run_loop: *mut c_void, timer: *mut c_void, mode: *const c_void);
        }
        extern "C" fn timer_callback(_: *mut c_void, _: *mut c_void) {}
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (go_tx, go_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let thread = std::thread::spawn(move || unsafe {
            let run_loop = cg::CFRunLoopGetCurrent();
            let timer = CFRunLoopTimerCreate(
                std::ptr::null(),
                CFAbsoluteTimeGetCurrent() + 3600.0,
                0.0,
                0,
                0,
                timer_callback,
                std::ptr::null_mut(),
            );
            assert!(!timer.is_null());
            CFRunLoopAddTimer(run_loop, timer, cg::kCFRunLoopDefaultMode);
            run_until_stopped(&stopping, || {
                ready_tx.send(()).unwrap();
                go_rx.recv().unwrap();
                cg::CFRunLoopRunInMode(cg::kCFRunLoopDefaultMode, 0.05, 1) != 1
            });
            CFRunLoopRemoveTimer(run_loop, timer, cg::kCFRunLoopDefaultMode);
            cg::CFRelease(timer);
            done_tx.send(()).unwrap();
        });
        ready_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        stop.store(true, Ordering::SeqCst);
        go_tx.send(()).unwrap();
        done_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        thread.join().unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn event_tap_is_tail_appended_and_listen_only() {
        assert_eq!(cg::KCG_TAIL_APPEND_EVENT_TAP, 1);
        assert_eq!(cg::KCG_EVENT_TAP_OPTION_LISTEN_ONLY, 1);
    }

    #[test]
    fn popup_hit_test_uses_visible_window_bounds() {
        let rect = LogicalRect {
            x: 100.0,
            y: 200.0,
            width: 80.0,
            height: 40.0,
        };
        assert!(point_in_rect(Point { x: 100.0, y: 200.0 }, rect));
        assert!(point_in_rect(Point { x: 180.0, y: 240.0 }, rect));
        assert!(!point_in_rect(Point { x: 99.0, y: 220.0 }, rect));
        assert!(!point_in_rect(Point { x: 140.0, y: 241.0 }, rect));
    }

    #[test]
    fn global_key_dismissal_only_applies_to_passive_popups() {
        assert!(!should_dismiss_for_key(false, false));
        assert!(should_dismiss_for_key(true, false));
        assert!(!should_dismiss_for_key(true, true));
    }

    #[cfg(target_os = "windows")]
    fn win_target(pid: i32, window_id: usize) -> crate::source::ForegroundTarget {
        crate::source::ForegroundTarget {
            pid,
            window_id: Some(window_id),
        }
    }

    #[cfg(target_os = "windows")]
    fn win_down() -> WinDownState {
        WinDownState {
            target: win_target(42, 1000),
            x: 100,
            y: 100,
        }
    }

    #[cfg(target_os = "windows")]
    fn win_up(pid: i32, window_id: usize, x: i32, y: i32) -> WinUpState {
        WinUpState {
            target: win_target(pid, window_id),
            x,
            y,
            at: Instant::now(),
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn plain_click_is_not_a_selection_gesture() {
        assert!(!has_selection_intent(
            win_down(),
            win_up(42, 1000, 100, 100),
            None,
            false
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn small_jitter_is_still_a_plain_click() {
        assert!(!has_selection_intent(
            win_down(),
            win_up(42, 1000, 101, 100),
            None,
            false
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn drag_beyond_threshold_is_selection_intent() {
        assert!(has_selection_intent(
            win_down(),
            win_up(42, 1000, 120, 100),
            None,
            false
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn shift_click_is_selection_intent_even_without_movement() {
        assert!(has_selection_intent(
            win_down(),
            win_up(42, 1000, 100, 100),
            None,
            true
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn quick_second_click_in_place_is_a_double_click() {
        let first = win_up(42, 1000, 100, 100);
        let second = WinUpState {
            at: Instant::now(),
            ..first
        };
        assert!(has_selection_intent(win_down(), second, Some(first), false));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn process_or_window_change_breaks_double_click_detection() {
        let first = win_up(42, 1000, 100, 100);
        let second = WinUpState {
            at: Instant::now(),
            ..first
        };
        let down = WinDownState {
            target: win_target(42, 2000),
            x: 100,
            y: 100,
        };
        assert!(!has_selection_intent(down, second, Some(first), false));
    }
}

/// Runtime health is independent from Accessibility trust.
pub fn is_running() -> bool {
    #[cfg(target_os = "macos")]
    {
        MONITOR.lock().expect("MONITOR mutex poisoned").is_some()
    }
    #[cfg(target_os = "windows")]
    {
        WINDOWS_MONITOR
            .lock()
            .expect("WINDOWS_MONITOR mutex poisoned")
            .is_some()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        false
    }
}

/// Stop is sticky even before the first run-loop pass; no cross-thread raw CF pointer.
#[cfg(any(target_os = "macos", test))]
fn run_until_stopped(stop: &AtomicBool, mut pass: impl FnMut() -> bool) {
    while !stop.load(Ordering::SeqCst) {
        if !pass() {
            break;
        }
    }
}
