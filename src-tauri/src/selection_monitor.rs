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
#[cfg(target_os = "macos")]
use std::sync::{mpsc, Mutex};
#[cfg(target_os = "macos")]
use std::thread::JoinHandle;
#[cfg(target_os = "windows")]
use std::sync::OnceLock;
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use tauri::{AppHandle, Manager};

use crate::selection_intent::Point;
#[cfg(target_os = "macos")]
use crate::selection_intent::{MouseDown, MouseUp, SelectionIntentTracker};

#[derive(Clone, Copy)]
struct LogicalRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn point_in_rect(point: Point, rect: LogicalRect) -> bool {
    point.x >= rect.x
        && point.x <= rect.x + rect.width
        && point.y >= rect.y
        && point.y <= rect.y + rect.height
}

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
#[cfg(target_os = "windows")]
static WINDOWS_MONITOR: OnceLock<()> = OnceLock::new();

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

pub fn is_current_selection_event(event_number: u64) -> bool {
    #[cfg(target_os = "macos")]
    return LATEST_SELECTION_EVENT.load(Ordering::SeqCst) == event_number;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = event_number;
        false
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
        if slot.is_some() || !crate::capture::check_accessibility(&app) {
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
                let _ = app.emit_to("main", "accessibility-needed", ());
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        #[cfg(target_os = "windows")]
        {
            if WINDOWS_MONITOR.set(()).is_err() {
                return;
            }
            std::thread::spawn(move || {
                let mut was_down = false;
                let mut source_pid = None;
                loop {
                    let is_down = unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } < 0;
                    if is_down && !was_down {
                        source_pid = crate::capture::external_frontmost_pid();
                    } else if !is_down && was_down {
                        if let Some(pid) = source_pid.take() {
                            if auto_mode_enabled(&app)
                                && crate::source::frontmost_pid() == Some(pid)
                            {
                                std::thread::sleep(std::time::Duration::from_millis(70));
                                if auto_mode_enabled(&app)
                                    && crate::source::frontmost_pid() == Some(pid)
                                {
                                    crate::popup::run_auto_popup_capture(&app, 0);
                                }
                            }
                        }
                    }
                    was_down = is_down;
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
            });
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
}
