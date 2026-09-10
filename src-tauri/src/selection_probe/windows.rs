//! One process-lifetime, windowless MTA owns all UIA objects. Callers exchange
//! only values, wait at most 350ms, and never join a blocked foreign provider.
use std::sync::{mpsc, OnceLock};
use std::time::{Duration, Instant};
use windows::Win32::{
    System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    },
    UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern,
        UIA_TextPatternId,
    },
};

struct Query {
    target: crate::source::ForegroundTarget,
    deadline: Instant,
    reply: mpsc::SyncSender<Option<String>>,
}

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

fn service() -> &'static mpsc::SyncSender<Query> {
    static SERVICE: OnceLock<mpsc::SyncSender<Query>> = OnceLock::new();
    SERVICE.get_or_init(|| {
        let (sender, receiver) = mpsc::sync_channel::<Query>(1);
        std::thread::spawn(move || unsafe {
            if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
                return;
            }
            let _apartment = Apartment;
            // Declared after Apartment so every COM interface is released first.
            let Ok(client): Result<IUIAutomation, _> =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
            else {
                return;
            };
            while let Ok(query) = receiver.recv() {
                if query.deadline <= Instant::now()
                    || crate::source::foreground_target() != Some(query.target)
                {
                    continue;
                }
                let text = selected_text(&client, query.target.pid, query.deadline);
                if query.deadline > Instant::now()
                    && crate::source::foreground_target() == Some(query.target)
                {
                    let _ = query.reply.try_send(text);
                }
            }
        });
        sender
    })
}

pub fn current_selected_text(pid: i32) -> Option<String> {
    if pid == std::process::id() as i32 {
        return None;
    }
    let target = crate::source::foreground_target().filter(|target| target.pid == pid)?;
    let (reply, result) = mpsc::sync_channel(1);
    let timeout = Duration::from_millis(350);
    service()
        .try_send(Query {
            target,
            deadline: Instant::now() + timeout,
            reply,
        })
        .ok()?;
    result.recv_timeout(timeout).ok().flatten()
}

unsafe fn selected_text(client: &IUIAutomation, pid: i32, deadline: Instant) -> Option<String> {
    let mut element = client.GetFocusedElement().ok()?;
    let walker = client.ControlViewWalker().ok()?;
    for _ in 0..10 {
        if Instant::now() >= deadline || element.CurrentProcessId().ok()? != pid {
            return None;
        }
        if element.CurrentIsPassword().ok()?.as_bool() {
            return None;
        }
        if let Some(text) = text_pattern_selection(&element, deadline) {
            return Some(text);
        }
        element = walker.GetParentElement(&element).ok()?;
    }
    None
}

unsafe fn text_pattern_selection(
    element: &IUIAutomationElement,
    deadline: Instant,
) -> Option<String> {
    let pattern: IUIAutomationTextPattern = element.GetCurrentPatternAs(UIA_TextPatternId).ok()?;
    let ranges = pattern.GetSelection().ok()?;
    let count = ranges.Length().ok()?;
    // Never expand DocumentRange: an active caret is not a whole-document selection.
    // Cap work and reject oversized selections rather than silently truncate them.
    if !(1..=32).contains(&count) {
        return None;
    }
    let mut parts = Vec::new();
    let mut remaining = 131_072usize;
    for index in 0..count {
        if Instant::now() >= deadline {
            return None;
        }
        let raw = ranges
            .GetElement(index)
            .ok()?
            .GetText((remaining + 1) as i32)
            .ok()?;
        if raw.len() > remaining {
            return None;
        }
        remaining -= raw.len();
        let text = super::clean_uia_text(&raw.to_string());
        if !text.is_empty() {
            parts.push(text);
        }
    }
    let text = parts.join("\n");
    (!text.trim().is_empty()).then_some(text)
}
