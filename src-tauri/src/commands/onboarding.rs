use crate::config::{OnboardingState, OnboardingStatus};
use crate::state::AppState;
use serde::Serialize;
use tauri::{Emitter, State};

const PREVIEW_SCENES: &[&str] = &[
    "welcome",
    "capture-permission",
    "capture-ready",
    "capture-success",
    "writing",
    "tasks-closed",
    "tasks-open",
    "split-narrow",
    "split-wide",
    "assistant-unconfigured",
    "assistant-configured-empty",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfileDto {
    pub name: String,
    pub is_debug: bool,
    pub root: Option<String>,
}

#[tauri::command]
pub fn get_onboarding_state(state: State<AppState>) -> OnboardingState {
    state.config.lock().unwrap().onboarding
}

#[tauri::command]
pub async fn set_onboarding_state(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    onboarding: OnboardingState,
) -> Result<OnboardingState, String> {
    let _transaction = state.ai_settings_tx.lock().await;
    let mut candidate = state.config.lock().unwrap().clone();
    candidate.onboarding = onboarding.normalized();
    crate::config::save(&state.config_path, &candidate).map_err(|error| error.to_string())?;
    *state.config.lock().unwrap() = candidate.clone();
    let saved = candidate.onboarding;
    let _ = app.emit("onboarding://changed", saved);
    if matches!(
        saved.status,
        OnboardingStatus::InProgress | OnboardingStatus::NotStarted
    ) {
        if let Some(window) = crate::windows::note_window(&app) {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
    Ok(saved)
}

#[tauri::command]
pub fn get_runtime_profile(state: State<AppState>) -> RuntimeProfileDto {
    RuntimeProfileDto {
        name: state.runtime_profile.name.clone(),
        is_debug: state.runtime_profile.is_debug,
        root: state
            .runtime_profile
            .root
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
    }
}

#[tauri::command]
pub fn set_onboarding_preview(
    app: tauri::AppHandle,
    state: State<AppState>,
    scene: Option<String>,
) -> Result<(), String> {
    if !state.runtime_profile.is_debug {
        return Err("Onboarding preview is only available in debug builds".into());
    }
    if scene
        .as_deref()
        .is_some_and(|value| !PREVIEW_SCENES.contains(&value))
    {
        return Err("Unknown onboarding preview scene".into());
    }
    *state.onboarding_preview.lock().unwrap() = scene.clone();
    let _ = app.emit("onboarding://preview-changed", scene);
    Ok(())
}

#[tauri::command]
pub fn get_onboarding_preview(state: State<AppState>) -> Option<String> {
    state.onboarding_preview.lock().unwrap().clone()
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum CapturePermissionState {
    NotRequired,
    Required,
    Granted,
}

pub fn capture_permission_state() -> CapturePermissionState {
    #[cfg(target_os = "macos")]
    {
        if macos_accessibility_client::accessibility::application_is_trusted() {
            CapturePermissionState::Granted
        } else {
            CapturePermissionState::Required
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        CapturePermissionState::NotRequired
    }
}

#[tauri::command]
pub fn get_capture_permission_state() -> CapturePermissionState {
    capture_permission_state()
}

#[tauri::command]
pub fn request_capture_permission() -> CapturePermissionState {
    #[cfg(target_os = "macos")]
    if !macos_accessibility_client::accessibility::application_is_trusted() {
        macos_accessibility_client::accessibility::application_is_trusted_with_prompt();
    }
    capture_permission_state()
}

#[cfg(test)]
pub fn replay_state() -> OnboardingState {
    OnboardingState {
        status: OnboardingStatus::InProgress,
        step: crate::config::OnboardingStep::Welcome,
        ..OnboardingState::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replay_returns_welcome_without_capture_success() {
        assert_eq!(
            replay_state(),
            OnboardingState {
                status: OnboardingStatus::InProgress,
                step: crate::config::OnboardingStep::Welcome,
                version: 1,
                capture_succeeded: false
            }
        );
    }
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn capture_permission_is_not_required_off_macos() {
        assert_eq!(
            capture_permission_state(),
            CapturePermissionState::NotRequired
        );
    }
}
