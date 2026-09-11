//! Value-only automatic retrieval requests. Input threads never wait for AX,
//! UIA, clipboard polling or browser source attribution.
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Condvar, Mutex,
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

static EPOCH: AtomicU64 = AtomicU64::new(1);

pub fn invalidate() -> u64 {
    EPOCH.fetch_add(1, Ordering::SeqCst) + 1
}

pub fn current() -> u64 {
    EPOCH.load(Ordering::SeqCst)
}

pub fn is_current(epoch: u64) -> bool {
    current() == epoch
}

#[derive(Clone, Copy)]
pub struct Request {
    pub epoch: u64,
    pub target: crate::source::ForegroundTarget,
    /// Logical screen coordinates, fixed at mouse release.
    pub anchor: (f64, f64),
    pub allow_clipboard: bool,
    pub at: Instant,
}

impl Request {
    pub fn is_current(&self) -> bool {
        is_current(self.epoch)
            && self.at.elapsed() < Duration::from_secs(2)
            && crate::source::foreground_target() == Some(self.target)
    }
}

/// A newer gesture replaces the pending one; never keep a backlog of old selections.
struct Mailbox<T> {
    state: Mutex<(bool, Option<T>)>,
    wake: Condvar,
}
impl<T> Mailbox<T> {
    fn new() -> Self {
        Self {
            state: Mutex::new((false, None)),
            wake: Condvar::new(),
        }
    }
    fn put(&self, value: T) {
        let mut state = self.state.lock().unwrap();
        if !state.0 {
            state.1 = Some(value);
            self.wake.notify_one();
        }
    }
    fn take(&self) -> Option<T> {
        let mut state = self.state.lock().unwrap();
        while !state.0 && state.1.is_none() {
            state = self.wake.wait(state).unwrap();
        }
        if state.0 {
            None
        } else {
            state.1.take()
        }
    }
    fn close(&self) {
        let mut state = self.state.lock().unwrap();
        *state = (true, None);
        self.wake.notify_all();
    }
}

pub struct Worker {
    mailbox: Arc<Mailbox<Request>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Worker {
    pub fn start(app: tauri::AppHandle) -> Self {
        let mailbox = Arc::new(Mailbox::<Request>::new());
        let receiving = mailbox.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let thread = std::thread::spawn(move || {
            while let Some(request) = receiving.take() {
                if stopping.load(Ordering::SeqCst) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(70));
                if !stopping.load(Ordering::SeqCst) && request.is_current() {
                    crate::popup::run_auto_popup_capture(&app, request);
                }
            }
        });
        Self {
            mailbox,
            stop,
            thread: Some(thread),
        }
    }
    pub fn submit(&self, request: Request) {
        self.mailbox.put(request);
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        invalidate();
        self.mailbox.close();
        if let Some(thread) = self.thread.take() {
            // A foreign accessibility provider cannot be forcibly cancelled.
            // Bound shutdown; the owned worker observes stop before further work,
            // and the invalidated epoch prevents an abandoned result being shown.
            let deadline = Instant::now() + Duration::from_millis(300);
            while !thread.is_finished() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            if thread.is_finished() {
                let _ = thread.join();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn pending_gesture_is_replaced_and_shutdown_discards_it() {
        let mailbox = Mailbox::new();
        mailbox.put("old");
        mailbox.put("new");
        assert_eq!(mailbox.take(), Some("new"));
        mailbox.put("pending");
        mailbox.close();
        mailbox.put("too late");
        assert_eq!(mailbox.take(), None);
    }

    #[test]
    fn input_invalidates_a_request_without_waiting_for_retrieval() {
        let before = current();
        let (tx, rx) = mpsc::channel();
        let retrieval = std::thread::spawn(move || {
            rx.recv().unwrap();
            is_current(before)
        });
        invalidate();
        tx.send(()).unwrap();
        assert!(!retrieval.join().unwrap());
    }
}
