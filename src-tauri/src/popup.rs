//! Selection-popup capture lifecycle: caches the eagerly-captured text,
//! emits the popup-payload event, and exposes submit/dismiss commands.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// Holds the text + source captured by `run_popup_capture` until the user
/// clicks 「加入采集区」 (submit) or cancels. Single-slot cache: a new capture
/// overwrites any pending one. `html` carries the clipboard's `text/html`
/// flavor so formatting survives the round-trip to the note window.
pub struct PopupCache {
    next_generation: AtomicU64,
    session: Mutex<Option<PopupSession>>,
}

struct PopupSession {
    generation_id: u64,
    capture: Option<CachedCapture>,
    interactive: bool,
    deferred_target: Option<crate::source::ForegroundTarget>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedCapture {
    pub text: String,
    pub html: Option<String>,
    pub source: Option<crate::source::Source>,
}

impl PopupCache {
    pub fn new() -> Self {
        Self {
            next_generation: AtomicU64::new(0),
            session: Mutex::new(None),
        }
    }

    fn next_generation(&self) -> u64 {
        self.next_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn set(
        &self,
        text: String,
        html: Option<String>,
        source: Option<crate::source::Source>,
    ) -> u64 {
        let generation_id = self.next_generation();
        *self.session.lock().unwrap() = Some(PopupSession {
            generation_id,
            capture: Some(CachedCapture { text, html, source }),
            interactive: false,
            deferred_target: None,
        });
        generation_id
    }

    fn set_deferred_target(&self, generation: u64, target: crate::source::ForegroundTarget) {
        let mut slot = self.session.lock().unwrap();
        if let Some(session) = slot
            .as_mut()
            .filter(|session| session.generation_id == generation)
        {
            session.deferred_target = Some(target);
        }
    }

    fn deferred_target(&self, generation: u64) -> Option<crate::source::ForegroundTarget> {
        self.session
            .lock()
            .unwrap()
            .as_ref()
            .filter(|session| session.generation_id == generation)?
            .deferred_target
    }

    pub fn begin_empty(&self) -> u64 {
        let generation_id = self.next_generation();
        *self.session.lock().unwrap() = Some(PopupSession {
            generation_id,
            capture: None,
            interactive: false,
            deferred_target: None,
        });
        generation_id
    }

    pub fn take(
        &self,
        generation_id: u64,
    ) -> Option<(String, Option<String>, Option<crate::source::Source>)> {
        let mut slot = self.session.lock().unwrap();
        if slot.as_ref()?.generation_id != generation_id {
            return None;
        }
        let capture = slot.take()?.capture?;
        Some((capture.text, capture.html, capture.source))
    }

    pub fn snapshot(&self, generation_id: u64) -> Option<CachedCapture> {
        let slot = self.session.lock().unwrap();
        let session = slot.as_ref()?;
        if session.generation_id != generation_id {
            return None;
        }
        session.capture.clone()
    }

    pub fn set_interactive(&self, generation_id: u64, interactive: bool) -> bool {
        let mut slot = self.session.lock().unwrap();
        let Some(session) = slot.as_mut() else {
            return false;
        };
        if session.generation_id != generation_id {
            return false;
        }
        session.interactive = interactive;
        true
    }

    #[cfg(any(target_os = "macos", target_os = "windows", test))]
    pub fn is_interactive(&self) -> bool {
        self.session
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|session| session.interactive)
    }

    pub fn complete(&self, generation_id: u64) -> bool {
        self.clear_if(generation_id)
    }

    pub fn clear(&self) {
        *self.session.lock().unwrap() = None;
    }

    pub fn clear_if(&self, generation_id: u64) -> bool {
        let mut slot = self.session.lock().unwrap();
        if slot
            .as_ref()
            .is_some_and(|session| session.generation_id == generation_id)
        {
            *slot = None;
            true
        } else {
            false
        }
    }
}

impl Default for PopupCache {
    fn default() -> Self {
        Self::new()
    }
}

use tauri::{AppHandle, Emitter, Manager, State};

use crate::agent::translate_system_prompt;
use crate::state::AppState;

const MAX_AI_SELECTION_CHARS: usize = 12_000;

fn validate_ai_capture(capture: Option<CachedCapture>) -> Result<CachedCapture, String> {
    let capture = capture.ok_or_else(|| "选区已失效，请重新选择".to_string())?;
    if capture.text.chars().count() > MAX_AI_SELECTION_CHARS {
        return Err("选中文字过长，请缩小选区后重试".into());
    }
    if capture.text.trim().is_empty() {
        return Err("选区已失效，请重新选择".into());
    }
    Ok(capture)
}

fn ensure_ai_ready(state: &AppState) -> Result<(), String> {
    let configured = {
        let config = state.config.lock().unwrap();
        config
            .ai_settings
            .active_provider_id
            .and_then(|id| config.ai_settings.providers.get(&id))
            .is_some_and(|profile| profile.is_configured())
    };
    if !configured {
        return Err("尚未启用 AI 提供商".into());
    }
    Ok(())
}

fn should_accept_interaction_mode_update(interactive: bool, matched_generation: bool) -> bool {
    matched_generation || !interactive
}

#[tauri::command]
pub fn popup_selection_snapshot(
    generation_id: u64,
    state: State<AppState>,
) -> Result<CachedCapture, String> {
    validate_ai_capture(state.popup_cache.snapshot(generation_id))
}

#[tauri::command]
pub fn popup_ai_selection_snapshot(
    generation_id: u64,
    state: State<AppState>,
) -> Result<CachedCapture, String> {
    ensure_ai_ready(&state)?;
    validate_ai_capture(state.popup_cache.snapshot(generation_id))
}

#[tauri::command]
pub fn set_popup_interaction_mode(
    generation_id: u64,
    interactive: bool,
    state: State<AppState>,
) -> Result<(), String> {
    let matched_generation = state
        .popup_cache
        .set_interactive(generation_id, interactive);
    should_accept_interaction_mode_update(interactive, matched_generation)
        .then_some(())
        .ok_or_else(|| "选区已失效，请重新选择".to_string())
}

#[tauri::command]
pub fn complete_popup_question(
    generation_id: u64,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    state
        .popup_cache
        .complete(generation_id)
        .then_some(())
        .ok_or_else(|| "选区已失效，请重新选择".to_string())?;
    hide_popup(&app);
    Ok(())
}

#[tauri::command]
pub async fn translate_popup_selection(
    generation_id: u64,
    _popup_request_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let capture = validate_ai_capture(state.popup_cache.snapshot(generation_id))?;
    ensure_ai_ready(&state)?;
    let system = translate_system_prompt(&capture.text);
    match tokio::time::timeout(
        std::time::Duration::from_secs(45),
        state.agent.one_shot(system, capture.text, 16_384),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err("请求超时，请重试".into()),
    }
}

#[tauri::command]
pub fn open_ai_settings(app: AppHandle) {
    *app.state::<crate::windows::SettingsNavigation>()
        .0
        .lock()
        .unwrap() = Some("ai".into());
    crate::windows::show_settings(&app);
    let _ = app.emit_to("settings", "settings://navigate", "ai");
}

/// Payload emitted to the `selection-popup` window on capture.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PopupPayload {
    pub x: f64,
    pub y: f64,
    pub generation_id: u64,
    pub origin: PopupOrigin,
    pub has_text: bool,
}

#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PopupOrigin {
    Auto,
    Shortcut,
}

fn should_emit(origin: PopupOrigin, has_text: bool, external_frontmost: bool) -> bool {
    external_frontmost && (has_text || origin == PopupOrigin::Shortcut)
}

/// User clicked 「加入采集区」: forward the cached {text, html, source} to the
/// note window exactly as the direct-capture path does.
#[tauri::command]
pub async fn submit_popup_capture(
    generation_id: u64,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let extra_html = if let (Some(target), Some(capture)) = (
        state.popup_cache.deferred_target(generation_id),
        state.popup_cache.snapshot(generation_id),
    ) {
        if capture.html.is_none() {
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                crate::capture::deferred_html(&app, target, &capture.text)
            })
            .await
            .ok()
            .flatten()
        } else {
            None
        }
    } else {
        None
    };
    // Re-check generation after asynchronous enrichment before consuming anything.
    let (text, html, source) = match state.popup_cache.take(generation_id) {
        Some((t, h, s)) if !t.trim().is_empty() => (t, h, s),
        _ => return Err("选区已失效或没有可加入的文本".to_string()),
    };
    let payload = crate::source::QuotePayload {
        text: text.trim().to_string(),
        html: html.or(extra_html),
        source,
    };
    app.emit_to("main", "quote-captured", payload)
        .map_err(|e| format!("emit failed: {e}"))?;

    // Hide the popup window (do not destroy it).
    hide_popup(&app);
    Ok(())
}

/// User cancelled (Esc / focus lost / empty state). Hide popup, drop cache.
#[tauri::command]
pub fn dismiss_popup(
    generation_id: Option<u64>,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let should_hide = if let Some(generation_id) = generation_id {
        state.popup_cache.clear_if(generation_id)
    } else {
        state.popup_cache.clear();
        true
    };
    if should_hide {
        hide_popup(&app);
    }
    Ok(())
}

/// Global shortcut entry: eagerly capture the selection while the source app
/// is still focused, cache it, then tell the popup window to show at the cursor.
pub fn run_popup_capture(app: &AppHandle) {
    crate::selection_worker::invalidate();
    run_popup_capture_with_origin(app, PopupOrigin::Shortcut, None);
}

pub fn run_auto_popup_capture(app: &AppHandle, request: crate::selection_worker::Request) {
    run_popup_capture_with_origin(app, PopupOrigin::Auto, Some(request));
}

fn run_popup_capture_with_origin(
    app: &AppHandle,
    origin: PopupOrigin,
    automatic: Option<crate::selection_worker::Request>,
) {
    // FloatNote never captures from its own windows. Check before the
    // accessibility prompt so the global popup shortcut is a silent no-op
    // while any FloatNote window is frontmost.
    let Some(target) = automatic
        .map(|request| request.target)
        .or_else(crate::capture::external_frontmost_target)
    else {
        return;
    };
    if target.pid == std::process::id() as i32 || crate::source::foreground_target() != Some(target)
    {
        return;
    }

    // Share capture.rs's guard so a popup capture and a direct capture can't
    // race the single shared system clipboard.
    let Some(_guard) = crate::capture::CaptureGuard::try_enter() else {
        return; // a capture is already in flight
    };

    #[cfg(target_os = "macos")]
    if automatic.is_some() && !macos_accessibility_client::accessibility::application_is_trusted() {
        return;
    }
    if !crate::capture::check_accessibility(app) {
        return;
    }

    if automatic.is_some_and(|request| !request.is_current()) {
        return;
    }
    let captured = crate::capture::capture_selection(app, target, automatic);
    if automatic.is_some_and(|request| !request.is_current()) {
        return;
    }
    let has_text = captured.is_some();
    if !should_emit(
        origin,
        has_text,
        crate::source::foreground_target() == Some(target),
    ) {
        return;
    }
    let generation_id = if let Some(ref c) = captured {
        // Source app is still frontmost here (popup window is shown only below).
        let source = crate::source::capture_source_for_pid(app, c.source_pid);
        if automatic.is_some_and(|request| !request.is_current()) {
            return;
        }
        let generation = state_set(app, c.text.clone(), c.html.clone(), source).unwrap_or(0);
        if automatic.is_some() && c.html.is_none() {
            if let Some(state) = app.try_state::<AppState>() {
                state.popup_cache.set_deferred_target(generation, target);
            }
        }
        generation
    } else {
        state_begin_empty(app).unwrap_or(0)
    };
    if generation_id == 0 {
        return;
    }

    if automatic.is_some_and(|request| !request.is_current()) {
        if let Some(state) = app.try_state::<AppState>() {
            state.popup_cache.clear_if(generation_id);
        }
        return;
    }
    let (x, y) = automatic
        .map(|request| request.anchor)
        .or_else(|| crate::cursor::get_cursor_pos(app))
        .unwrap_or((0.0, 0.0));

    let payload = PopupPayload {
        x,
        y,
        generation_id,
        origin,
        has_text,
    };
    crate::popup_hover::activate(app);
    if app
        .emit_to("selection-popup", "popup-payload", payload)
        .is_err()
    {
        crate::popup_hover::deactivate();
    }
}

/// Helper: stash the captured text + html + source into the managed AppState.
fn state_set(
    app: &AppHandle,
    text: String,
    html: Option<String>,
    source: Option<crate::source::Source>,
) -> Option<u64> {
    if let Some(state) = app.try_state::<AppState>() {
        return Some(state.popup_cache.set(text, html, source));
    }
    None
}

fn state_begin_empty(app: &AppHandle) -> Option<u64> {
    app.try_state::<AppState>()
        .map(|state| state.popup_cache.begin_empty())
}

pub fn dismiss_active(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.popup_cache.clear();
    }
    hide_popup(app);
}

fn hide_popup(app: &AppHandle) {
    crate::popup_hover::deactivate();
    if let Some(popup) = app.get_webview_window("selection-popup") {
        let _ = popup.hide();
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub fn is_visible(app: &AppHandle) -> bool {
    app.get_webview_window("selection-popup")
        .and_then(|popup| popup.is_visible().ok())
        .unwrap_or(false)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub fn is_interactive(app: &AppHandle) -> bool {
    app.try_state::<AppState>()
        .is_some_and(|state| state.popup_cache.is_interactive())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deferred_target_cannot_be_attached_to_or_read_from_a_new_generation() {
        let cache = PopupCache::new();
        let old = cache.set("old".into(), None, None);
        let target = crate::source::ForegroundTarget {
            pid: 42,
            window_id: None,
        };
        cache.set_deferred_target(old, target);
        let current = cache.set("new".into(), None, None);
        cache.set_deferred_target(old, target);
        assert!(cache.deferred_target(old).is_none());
        assert!(cache.deferred_target(current).is_none());
        assert!(cache.take(old).is_none());
        assert_eq!(cache.take(current).unwrap().0, "new");
    }

    #[test]
    fn take_returns_none_when_empty() {
        let cache = PopupCache::new();
        assert!(cache.take(1).is_none());
    }

    #[test]
    fn set_then_take_matching_generation_roundtrips() {
        let cache = PopupCache::new();
        let generation = cache.set("hello".to_string(), None, None);
        let (t, h, s) = cache.take(generation).unwrap();
        assert_eq!(t, "hello");
        assert!(h.is_none());
        assert!(s.is_none());
        assert!(cache.take(generation).is_none());
    }

    #[test]
    fn stale_generation_cannot_take_new_capture() {
        let cache = PopupCache::new();
        let stale = cache.set("a".to_string(), None, None);
        let current = cache.set("b".to_string(), Some("<b>x</b>".to_string()), None);
        assert!(cache.take(stale).is_none());
        let (t, h, _s) = cache.take(current).unwrap();
        assert_eq!(t, "b");
        assert_eq!(h.as_deref(), Some("<b>x</b>"));
    }

    #[test]
    fn stale_generation_cannot_dismiss_new_capture() {
        let cache = PopupCache::new();
        let stale = cache.set("a".to_string(), None, None);
        let current = cache.set("b".to_string(), None, None);
        assert!(!cache.clear_if(stale));
        assert!(cache.take(current).is_some());
    }

    #[test]
    fn snapshot_is_non_consuming_and_complete_is_generation_aware() {
        let cache = PopupCache::new();
        let generation = cache.set("hello".to_string(), Some("<b>hello</b>".to_string()), None);
        let first = cache.snapshot(generation).unwrap();
        let second = cache.snapshot(generation).unwrap();
        assert_eq!(first.text, "hello");
        assert_eq!(second.html.as_deref(), Some("<b>hello</b>"));
        assert!(cache.complete(generation));
        assert!(cache.snapshot(generation).is_none());
    }

    #[test]
    fn stale_generation_cannot_snapshot_or_complete_new_capture() {
        let cache = PopupCache::new();
        let stale = cache.set("old".to_string(), None, None);
        let current = cache.set("new".to_string(), None, None);
        assert!(cache.snapshot(stale).is_none());
        assert!(!cache.complete(stale));
        assert_eq!(cache.snapshot(current).unwrap().text, "new");
    }

    #[test]
    fn empty_shortcut_session_can_be_dismissed_by_generation() {
        let cache = PopupCache::new();
        let generation = cache.begin_empty();
        assert!(cache.clear_if(generation));
        assert!(!cache.clear_if(generation));
    }

    #[test]
    fn popup_interaction_mode_is_generation_aware() {
        let cache = PopupCache::new();
        let stale = cache.set("old".to_string(), None, None);
        let current = cache.set("new".to_string(), None, None);

        assert!(!cache.is_interactive());
        assert!(!cache.set_interactive(stale, true));
        assert!(!cache.is_interactive());
        assert!(cache.set_interactive(current, true));
        assert!(cache.is_interactive());
        assert!(cache.set_interactive(current, false));
        assert!(!cache.is_interactive());
    }

    #[test]
    fn deactivation_is_idempotent_after_the_popup_session_completes() {
        assert!(should_accept_interaction_mode_update(false, false));
        assert!(!should_accept_interaction_mode_update(true, false));
        assert!(should_accept_interaction_mode_update(true, true));
    }

    #[test]
    fn automatic_empty_capture_is_silent_but_shortcut_can_report_it() {
        assert!(!should_emit(PopupOrigin::Auto, false, true));
        assert!(should_emit(PopupOrigin::Shortcut, false, true));
        assert!(should_emit(PopupOrigin::Auto, true, true));
    }

    #[test]
    fn own_process_never_emits_a_popup() {
        assert!(!should_emit(PopupOrigin::Shortcut, false, false));
        assert!(!should_emit(PopupOrigin::Shortcut, true, false));
    }
}
