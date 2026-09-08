#[cfg(any(target_os = "macos", test))]
const HOVER_INTERVAL_NS: u64 = 33_333_333;

#[cfg(any(target_os = "macos", test))]
fn should_relay_move(enabled: bool, previous_timestamp: u64, timestamp: u64) -> bool {
    enabled
        && (previous_timestamp == 0
            || timestamp.saturating_sub(previous_timestamp) >= HOVER_INTERVAL_NS)
}

#[cfg(target_os = "macos")]
mod macos {
    use super::should_relay_move;
    use serde::Serialize;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU64, Ordering};
    use std::sync::{mpsc, Mutex};
    use std::thread::JoinHandle;
    use tauri::{AppHandle, Emitter};

    const KCG_SESSION_EVENT_TAP: i32 = 1;
    const KCG_TAIL_APPEND_EVENT_TAP: i32 = 1;
    const KCG_EVENT_TAP_OPTION_LISTEN_ONLY: u32 = 1;
    const KCG_MOUSE_MOVED: u32 = 5;
    const KCG_TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
    const KCG_TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;
    const EVENT_MASK: u64 = 1u64 << KCG_MOUSE_MOVED;

    type CGEventRef = *mut c_void;
    type CGEventTapCallBack =
        extern "C" fn(*mut c_void, u32, CGEventRef, *mut c_void) -> CGEventRef;

    #[repr(C)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventTapCreate(
            tap: i32,
            place: i32,
            options: u32,
            event_mask: u64,
            callback: CGEventTapCallBack,
            user_info: *mut c_void,
        ) -> *mut c_void;
        fn CGEventGetLocation(event: CGEventRef) -> CGPoint;
        fn CGEventGetTimestamp(event: CGEventRef) -> u64;
        fn CGEventTapEnable(tap: *mut c_void, enable: bool);
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFMachPortCreateRunLoopSource(
            alloc: *mut c_void,
            port: *mut c_void,
            order: i32,
        ) -> *mut c_void;
        fn CFRunLoopGetCurrent() -> *mut c_void;
        fn CFRunLoopAddSource(rl: *mut c_void, source: *mut c_void, mode: *const c_void);
        fn CFRunLoopRemoveSource(rl: *mut c_void, source: *mut c_void, mode: *const c_void);
        fn CFRunLoopRun();
        fn CFMachPortInvalidate(port: *mut c_void);
        fn CFRelease(cf: *const c_void);
        static kCFRunLoopDefaultMode: *const c_void;
    }

    #[derive(Clone, Copy, Serialize)]
    struct HoverPoint {
        x: f64,
        y: f64,
    }

    struct CallbackState {
        sender: mpsc::SyncSender<HoverPoint>,
        port: AtomicPtr<c_void>,
    }

    struct HoverRuntime {
        _event_thread: JoinHandle<()>,
        _worker_thread: JoinHandle<()>,
    }

    static ENABLED: AtomicBool = AtomicBool::new(false);
    static LAST_RELAYED_TIMESTAMP: AtomicU64 = AtomicU64::new(0);
    static EVENT_TAP: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
    static MONITOR: Mutex<Option<HoverRuntime>> = Mutex::new(None);

    extern "C" fn event_callback(
        _proxy: *mut c_void,
        event_type: u32,
        event: CGEventRef,
        user_info: *mut c_void,
    ) -> CGEventRef {
        let _ = std::panic::catch_unwind(|| {
            let state = unsafe { &*(user_info as *const CallbackState) };
            if matches!(
                event_type,
                KCG_TAP_DISABLED_BY_TIMEOUT | KCG_TAP_DISABLED_BY_USER_INPUT
            ) {
                let port = state.port.load(Ordering::Acquire);
                if !port.is_null() {
                    unsafe { CGEventTapEnable(port, true) };
                }
                return;
            }
            if event_type != KCG_MOUSE_MOVED {
                return;
            }
            let enabled = ENABLED.load(Ordering::Relaxed);
            let timestamp = unsafe { CGEventGetTimestamp(event) };
            let previous = LAST_RELAYED_TIMESTAMP.load(Ordering::Relaxed);
            if !should_relay_move(enabled, previous, timestamp) {
                return;
            }
            LAST_RELAYED_TIMESTAMP.store(timestamp, Ordering::Relaxed);
            let location = unsafe { CGEventGetLocation(event) };
            let _ = state.sender.try_send(HoverPoint {
                x: location.x,
                y: location.y,
            });
        });
        event
    }

    fn ensure_installed(app: &AppHandle) {
        let mut slot = MONITOR.lock().expect("popup hover monitor mutex poisoned");
        if slot.is_some() {
            return;
        }
        let (sender, receiver) = mpsc::sync_channel::<HoverPoint>(1);
        let worker_app = app.clone();
        let worker_thread = std::thread::spawn(move || {
            while let Ok(point) = receiver.recv() {
                if ENABLED.load(Ordering::Relaxed) {
                    let _ = worker_app.emit_to("selection-popup", "popup-hover-move", point);
                }
            }
        });
        let (ready_tx, ready_rx) = mpsc::sync_channel::<bool>(1);
        let event_thread = std::thread::spawn(move || {
            let state = Box::new(CallbackState {
                sender,
                port: AtomicPtr::new(std::ptr::null_mut()),
            });
            let user_info = (&*state as *const CallbackState).cast_mut().cast();
            let port = unsafe {
                CGEventTapCreate(
                    KCG_SESSION_EVENT_TAP,
                    KCG_TAIL_APPEND_EVENT_TAP,
                    KCG_EVENT_TAP_OPTION_LISTEN_ONLY,
                    EVENT_MASK,
                    event_callback,
                    user_info,
                )
            };
            if port.is_null() {
                let _ = ready_tx.send(false);
                return;
            }
            state.port.store(port, Ordering::Release);
            let source = unsafe { CFMachPortCreateRunLoopSource(std::ptr::null_mut(), port, 0) };
            if source.is_null() {
                unsafe { CFRelease(port) };
                let _ = ready_tx.send(false);
                return;
            }
            let run_loop = unsafe { CFRunLoopGetCurrent() };
            unsafe {
                CFRunLoopAddSource(run_loop, source, kCFRunLoopDefaultMode);
                CGEventTapEnable(port, false);
            }
            EVENT_TAP.store(port, Ordering::Release);
            let _ = ready_tx.send(true);
            unsafe { CFRunLoopRun() };
            EVENT_TAP.store(std::ptr::null_mut(), Ordering::Release);
            unsafe {
                CGEventTapEnable(port, false);
                CFRunLoopRemoveSource(run_loop, source, kCFRunLoopDefaultMode);
                CFMachPortInvalidate(port);
                CFRelease(source);
                CFRelease(port);
            }
        });
        match ready_rx.recv_timeout(std::time::Duration::from_secs(1)) {
            Ok(true) => {
                *slot = Some(HoverRuntime {
                    _event_thread: event_thread,
                    _worker_thread: worker_thread,
                });
            }
            _ => {
                let _ = event_thread.join();
                let _ = worker_thread.join();
                eprintln!("failed to install passive popup hover monitor");
            }
        }
    }

    pub fn activate(app: &AppHandle) {
        ensure_installed(app);
        LAST_RELAYED_TIMESTAMP.store(0, Ordering::Relaxed);
        ENABLED.store(true, Ordering::Release);
        let port = EVENT_TAP.load(Ordering::Acquire);
        if !port.is_null() {
            unsafe { CGEventTapEnable(port, true) };
        }
    }

    pub fn deactivate() {
        ENABLED.store(false, Ordering::Release);
        let port = EVENT_TAP.load(Ordering::Acquire);
        if !port.is_null() {
            unsafe { CGEventTapEnable(port, false) };
        }
        LAST_RELAYED_TIMESTAMP.store(0, Ordering::Relaxed);
    }
}

pub fn activate(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    macos::activate(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

pub fn deactivate() {
    #[cfg(target_os = "macos")]
    macos::deactivate();
}

#[cfg(test)]
mod tests {
    use super::{should_relay_move, HOVER_INTERVAL_NS};

    #[test]
    fn passive_hover_relay_is_disabled_with_the_popup() {
        assert!(!should_relay_move(false, 0, HOVER_INTERVAL_NS));
    }

    #[test]
    fn passive_hover_relay_sends_the_first_move_and_throttles_followups() {
        assert!(should_relay_move(true, 0, HOVER_INTERVAL_NS));
        assert!(!should_relay_move(
            true,
            HOVER_INTERVAL_NS,
            HOVER_INTERVAL_NS * 2 - 1
        ));
        assert!(should_relay_move(
            true,
            HOVER_INTERVAL_NS,
            HOVER_INTERVAL_NS * 2
        ));
    }
}
