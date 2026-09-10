//! Passive macOS selection monitor.
//!
//! The event tap lives on its own CFRunLoop and is listen-only. The FFI
//! callback copies event metadata into a bounded channel; Tauri, AX and
//! clipboard work only happen on the worker thread. The structure is adapted
//! from selection-hook's MIT-licensed macOS implementation.

#[cfg(target_os = "macos")]
use std::ffi::c_void;
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicPtr, AtomicU64, Ordering};
#[cfg(target_os = "windows")]
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
#[cfg(target_os = "macos")]
use std::sync::{mpsc, Mutex};
#[cfg(target_os = "macos")]
use std::thread::JoinHandle;
#[cfg(target_os = "windows")]
use std::thread::JoinHandle;
#[cfg(target_os = "windows")]
use std::time::Instant;
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
    pub const KCG_TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
    pub const KCG_TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;
    pub const EVENT_MASK: u64 =
        (1u64 << KCG_LEFT_MOUSE_DOWN) | (1u64 << KCG_LEFT_MOUSE_UP) | (1u64 << KCG_KEY_DOWN);
    pub const KCG_MOUSE_EVENT_NUMBER: u32 = 0;
    pub const KCG_MOUSE_EVENT_CLICK_STATE: u32 = 1;
    pub const KCG_KEYBOARD_EVENT_KEYCODE: u32 = 9;

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
        pub fn CFRunLoopRun();
        pub fn CFRunLoopStop(rl: *mut c_void);
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
    key_code: i64,
}

#[cfg(target_os = "macos")]
struct CallbackState {
    sender: mpsc::SyncSender<GlobalEvent>,
    port: AtomicPtr<c_void>,
}

#[cfg(target_os = "macos")]
extern "C" fn event_callback(
    _proxy: *mut c_void,
    event_type: u32,
    event: *mut c_void,
    user_info: *mut c_void,
) -> *mut c_void {
    let _ = std::panic::catch_unwind(|| {
        let state = unsafe { &*(user_info as *const CallbackState) };
        if matches!(
            event_type,
            cg::KCG_TAP_DISABLED_BY_TIMEOUT | cg::KCG_TAP_DISABLED_BY_USER_INPUT
        ) {
            let port = state.port.load(Ordering::Acquire);
            if !port.is_null() {
                unsafe { cg::CGEventTapEnable(port, true) };
            }
            return;
        }
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
            key_code: unsafe {
                cg::CGEventGetIntegerValueField(event, cg::KCG_KEYBOARD_EVENT_KEYCODE)
            },
        };
        let _ = state.sender.try_send(snapshot);
    });
    event
}

#[cfg(target_os = "macos")]
struct MonitorRuntime {
    run_loop: usize,
    event_thread: JoinHandle<()>,
    worker_thread: JoinHandle<()>,
}

#[cfg(target_os = "macos")]
static MONITOR: Mutex<Option<MonitorRuntime>> = Mutex::new(None);

#[cfg(target_os = "macos")]
static LATEST_SELECTION_EVENT: AtomicU64 = AtomicU64::new(0);

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
    let mut was_down = false;
    let mut down_state: Option<WinDownState> = None;
    let mut last_up: Option<WinUpState> = None;
    while !stop.load(Ordering::SeqCst) {
        let is_down = unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } < 0;
        if is_down && !was_down {
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
                        // Give the source app a moment to finish rendering the
                        // selection before capturing.
                        std::thread::sleep(std::time::Duration::from_millis(70));
                        if auto_mode_enabled(&app)
                            && crate::source::foreground_target() == Some(down.target)
                        {
                            crate::popup::run_windows_auto_popup_capture(&app, down.target);
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

#[cfg(target_os = "macos")]
pub fn is_current_selection_event(event_number: u64) -> bool {
    LATEST_SELECTION_EVENT.load(Ordering::SeqCst) == event_number
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
fn worker_loop(app: AppHandle, receiver: mpsc::Receiver<GlobalEvent>) {
    let mut tracker = SelectionIntentTracker::default();
    while let Ok(event) = receiver.recv() {
        if event.event_type == cg::KCG_KEY_DOWN {
            let _ = event.key_code;
            if should_dismiss_for_key(
                crate::popup::is_visible(&app),
                crate::popup::is_interactive(&app),
            ) {
                crate::popup::dismiss_active(&app);
            }
            continue;
        }

        if event.event_type == cg::KCG_LEFT_MOUSE_DOWN {
            if let Some(rect) = popup_rect(&app) {
                if point_in_rect(event.point, rect) {
                    continue;
                }
                crate::popup::dismiss_active(&app);
            }
            if !auto_mode_enabled(&app) {
                continue;
            }
            let Some(pid) = crate::source::frontmost_pid() else {
                continue;
            };
            if !crate::capture::is_external_frontmost_process(Some(pid), std::process::id() as i32)
            {
                continue;
            }
            LATEST_SELECTION_EVENT.store(event.event_number, Ordering::SeqCst);
            tracker.on_mouse_down(MouseDown {
                event_number: event.event_number,
                pid,
                point: event.point,
                // Gesture detection is deliberately AX-free. A drag on a
                // non-text surface is harmless: the post-gesture AX/clipboard
                // capture returns None and automatic mode stays silent.
                target: crate::selection_intent::AxTargetKind::WebArea,
            });
            continue;
        }

        if event.event_type != cg::KCG_LEFT_MOUSE_UP || !auto_mode_enabled(&app) {
            continue;
        }
        let Some(pid) = crate::source::frontmost_pid() else {
            continue;
        };
        if !crate::capture::is_external_frontmost_process(Some(pid), std::process::id() as i32) {
            continue;
        }
        let candidate = tracker.on_mouse_up(MouseUp {
            event_number: event.event_number,
            pid,
            point: event.point,
            click_count: event.click_count,
        });
        if let Some(candidate) = candidate {
            std::thread::sleep(std::time::Duration::from_millis(35));
            if is_current_selection_event(candidate.event_number) && auto_mode_enabled(&app) {
                crate::popup::run_auto_popup_capture(&app, candidate.event_number);
            }
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
        let worker_app = app.clone();
        let worker_thread = std::thread::spawn(move || worker_loop(worker_app, receiver));
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Option<usize>>(1);
        let event_thread = std::thread::spawn(move || {
            let state = Box::new(CallbackState {
                sender,
                port: AtomicPtr::new(std::ptr::null_mut()),
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
                let _ = ready_tx.send(None);
                return;
            }
            state.port.store(port, Ordering::Release);
            let source =
                unsafe { cg::CFMachPortCreateRunLoopSource(std::ptr::null_mut(), port, 0) };
            if source.is_null() {
                unsafe { cg::CFRelease(port) };
                let _ = ready_tx.send(None);
                return;
            }
            let run_loop = unsafe { cg::CFRunLoopGetCurrent() };
            unsafe {
                cg::CFRunLoopAddSource(run_loop, source, cg::kCFRunLoopDefaultMode);
                cg::CGEventTapEnable(port, true);
            }
            let _ = ready_tx.send(Some(run_loop as usize));
            unsafe { cg::CFRunLoopRun() };
            unsafe {
                cg::CGEventTapEnable(port, false);
                cg::CFRunLoopRemoveSource(run_loop, source, cg::kCFRunLoopDefaultMode);
                cg::CFMachPortInvalidate(port);
                cg::CFRelease(source);
                cg::CFRelease(port);
            }
        });
        match ready_rx.recv_timeout(std::time::Duration::from_secs(1)) {
            Ok(Some(run_loop)) => {
                *slot = Some(MonitorRuntime {
                    run_loop,
                    event_thread,
                    worker_thread,
                });
            }
            _ => {
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
    #[cfg(target_os = "macos")]
    if let Some(runtime) = MONITOR.lock().expect("MONITOR mutex poisoned").take() {
        unsafe { cg::CFRunLoopStop(runtime.run_loop as *mut c_void) };
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
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}
