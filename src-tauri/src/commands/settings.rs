use crate::config::{AiProviderConfig, AiProviderId, AssistantOutputMode, WindowShortcuts};
use crate::state::AppState;
use tauri::{AppHandle, Emitter, State};

/// Local configuration readiness; never probes the network or returns credentials.
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AiReadiness {
    Unconfigured,
    Disabled,
    Incomplete { message: String },
    RuntimeUnavailable,
    Ready,
}

fn ai_readiness(settings: &crate::config::AiSettings, runtime_ready: bool) -> AiReadiness {
    if let Some(provider) = settings.active_provider_id {
        let Some(profile) = settings.providers.get(&provider) else {
            return AiReadiness::Incomplete {
                message: "当前服务配置已缺失".into(),
            };
        };
        if let Err(message) = profile.normalized_for(provider) {
            return AiReadiness::Incomplete { message };
        }
        return if runtime_ready {
            AiReadiness::Ready
        } else {
            AiReadiness::RuntimeUnavailable
        };
    }
    if settings
        .providers
        .iter()
        .any(|(id, profile)| profile.normalized_for(*id).is_ok())
    {
        AiReadiness::Disabled
    } else if settings
        .providers
        .values()
        .any(|profile| !profile.api_key.trim().is_empty() || !profile.model.trim().is_empty())
    {
        AiReadiness::Incomplete {
            message: "请补全服务配置并启用".into(),
        }
    } else {
        AiReadiness::Unconfigured
    }
}

#[tauri::command]
pub async fn get_ai_readiness(state: State<'_, AppState>) -> Result<AiReadiness, String> {
    let _transaction = state.ai_settings_tx.lock().await;
    let settings = state.config.lock().unwrap().ai_settings.clone();
    Ok(ai_readiness(&settings, state.agent.is_configured()))
}

#[tauri::command]
pub async fn retry_ai_configuration(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AiReadiness, String> {
    let _transaction = state.ai_settings_tx.lock().await;
    let settings = state.config.lock().unwrap().ai_settings.clone();
    if let Some(provider) = settings.active_provider_id {
        if let Some(profile) = settings.providers.get(&provider) {
            super::agent::configure_agent(&state, provider, profile).await?;
        }
    }
    let readiness = ai_readiness(&settings, state.agent.is_configured());
    let _ = app.emit(
        "agent://configuration-changed",
        readiness == AiReadiness::Ready,
    );
    Ok(readiness)
}

#[tauri::command]
pub async fn save_ai_provider(
    app: AppHandle,
    state: State<'_, AppState>,
    provider_id: AiProviderId,
    provider_config: AiProviderConfig,
) -> Result<(), String> {
    save_ai_provider_inner(&state, provider_id, provider_config).await?;
    let _ = app.emit("agent://configuration-changed", state.agent.is_configured());
    Ok(())
}

async fn save_ai_provider_inner(
    state: &AppState,
    provider_id: AiProviderId,
    provider_config: AiProviderConfig,
) -> Result<bool, String> {
    let _transaction = state.ai_settings_tx.lock().await;
    let normalized = provider_config.normalized_for(provider_id)?;
    let old = state.config.lock().unwrap().clone();
    let mut candidate = old.clone();
    candidate
        .ai_settings
        .providers
        .insert(provider_id, normalized.clone());
    let updates_runtime = old.ai_settings.active_provider_id == Some(provider_id);
    if updates_runtime {
        super::agent::configure_agent(state, provider_id, &normalized).await?;
    }
    if let Err(error) = crate::config::save(&state.config_path, &candidate) {
        let recovery = if updates_runtime {
            if let Some(previous) = old.ai_settings.providers.get(&provider_id) {
                super::agent::configure_agent(state, provider_id, previous).await
            } else {
                super::agent::clear_agent_configuration(state).await
            }
        } else {
            Ok(())
        };
        return match recovery {
            Ok(()) => Err(error.to_string()),
            Err(recovery_error) => Err(format!(
                "保存失败：{error}；运行配置恢复失败：{recovery_error}"
            )),
        };
    }
    *state.config.lock().unwrap() = candidate;
    Ok(updates_runtime)
}

#[tauri::command]
pub async fn set_active_ai_provider(
    app: AppHandle,
    state: State<'_, AppState>,
    provider_id: Option<AiProviderId>,
) -> Result<(), String> {
    set_active_ai_provider_inner(&state, provider_id).await?;
    let _ = app.emit("agent://configuration-changed", provider_id.is_some());
    Ok(())
}

async fn set_active_ai_provider_inner(
    state: &AppState,
    provider_id: Option<AiProviderId>,
) -> Result<(), String> {
    let _transaction = state.ai_settings_tx.lock().await;
    let old = state.config.lock().unwrap().clone();
    if old.ai_settings.active_provider_id == provider_id {
        return Ok(());
    }
    let mut candidate = old.clone();
    if let Some(provider) = provider_id {
        let profile = old
            .ai_settings
            .providers
            .get(&provider)
            .ok_or("未知的 AI 提供商")?
            .normalized_for(provider)?;
        super::agent::configure_agent(state, provider, &profile).await?;
    }
    candidate.ai_settings.active_provider_id = provider_id;
    if let Err(error) = crate::config::save(&state.config_path, &candidate) {
        let recovery = if let Some(previous_provider) = old.ai_settings.active_provider_id {
            if let Some(previous) = old.ai_settings.providers.get(&previous_provider) {
                super::agent::configure_agent(state, previous_provider, previous).await
            } else {
                super::agent::clear_agent_configuration(state).await
            }
        } else {
            super::agent::clear_agent_configuration(state).await
        };
        return match recovery {
            Ok(()) => Err(error.to_string()),
            Err(recovery_error) => Err(format!(
                "保存失败：{error}；运行配置恢复失败：{recovery_error}"
            )),
        };
    }
    *state.config.lock().unwrap() = candidate;
    Ok(())
}

#[tauri::command]
pub fn get_window_shortcuts(state: State<AppState>) -> WindowShortcuts {
    state.config.lock().unwrap().window_shortcuts.clone()
}

#[tauri::command]
pub async fn set_assistant_output_mode(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    mode: AssistantOutputMode,
) -> Result<(), String> {
    let _transaction = state.ai_settings_tx.lock().await;
    set_assistant_output_mode_inner(&state, mode, |saved| {
        let _ = app.emit("assistant-output-mode-changed", saved);
    })
}

fn set_assistant_output_mode_inner(
    state: &AppState,
    mode: AssistantOutputMode,
    emit: impl FnOnce(AssistantOutputMode),
) -> Result<(), String> {
    let mut candidate = state.config.lock().unwrap().clone();
    candidate.assistant_output_mode = mode;
    crate::config::save(&state.config_path, &candidate).map_err(|error| error.to_string())?;
    *state.config.lock().unwrap() = candidate;
    emit(mode);
    Ok(())
}

#[tauri::command]
pub async fn apply_shortcuts(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    capture: String,
    toggle: String,
    popup: String,
    window_shortcuts: WindowShortcuts,
) -> Result<(), String> {
    let _transaction = state.ai_settings_tx.lock().await;
    apply_shortcuts_inner(
        &state,
        capture,
        toggle,
        popup,
        window_shortcuts,
        |capture, toggle, popup| crate::shortcuts::apply(&app, capture, toggle, popup),
    )?;
    let _ = app.emit("window-shortcuts-changed", ());
    Ok(())
}

fn apply_shortcuts_inner(
    state: &AppState,
    capture: String,
    toggle: String,
    popup: String,
    window_shortcuts: WindowShortcuts,
    mut apply_runtime: impl FnMut(&str, &str, &str) -> Result<(), String>,
) -> Result<(), String> {
    let old = state.config.lock().unwrap().clone();
    if let Err(error) = apply_runtime(&capture, &toggle, &popup) {
        let recovery = apply_runtime(
            &old.shortcut_capture,
            &old.shortcut_toggle,
            &old.shortcut_popup,
        );
        return match recovery {
            Ok(()) => Err(error),
            Err(recovery_error) => Err(format!(
                "应用快捷键失败：{error}；恢复原快捷键失败：{recovery_error}"
            )),
        };
    }
    let mut candidate = old.clone();
    candidate.shortcut_capture = capture;
    candidate.shortcut_toggle = toggle;
    candidate.shortcut_popup = popup;
    candidate.window_shortcuts = window_shortcuts;
    if let Err(error) = crate::config::save(&state.config_path, &candidate) {
        let recovery = apply_runtime(
            &old.shortcut_capture,
            &old.shortcut_toggle,
            &old.shortcut_popup,
        );
        return match recovery {
            Ok(()) => Err(error.to_string()),
            Err(recovery_error) => Err(format!(
                "保存快捷键失败：{error}；恢复原快捷键失败：{recovery_error}"
            )),
        };
    }
    *state.config.lock().unwrap() = candidate;
    Ok(())
}

#[tauri::command]
pub async fn set_auto_popup_mode(
    mode: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if !is_valid_auto_popup_mode(&mode) {
        return Err(format!("无效的 auto_popup_mode: {mode}"));
    }
    let _transaction = state.ai_settings_tx.lock().await;
    let mut candidate = state.config.lock().unwrap().clone();
    candidate.auto_popup_mode = mode.clone();
    crate::config::save(&state.config_path, &candidate).map_err(|error| error.to_string())?;
    *state.config.lock().unwrap() = candidate;
    if should_install_selection_monitor(&mode) {
        crate::selection_monitor::install(app);
    } else {
        crate::selection_monitor::uninstall();
    }
    Ok(())
}

fn is_valid_auto_popup_mode(mode: &str) -> bool {
    matches!(mode, "off" | "auto" | "shortcut")
}

pub(crate) fn should_install_selection_monitor(mode: &str) -> bool {
    matches!(mode, "auto" | "shortcut")
}

#[cfg(test)]
mod tests {
    use super::{
        apply_shortcuts_inner, is_valid_auto_popup_mode, save_ai_provider_inner,
        set_active_ai_provider_inner, set_assistant_output_mode_inner,
        should_install_selection_monitor,
    };
    use crate::config::{AiProviderConfig, AiProviderId, Config, WindowShortcuts};
    use crate::state::{AppState, AuthorizedRoots};
    use std::collections::HashMap;
    use std::sync::atomic::AtomicU64;
    use std::sync::Mutex;

    fn state_at(config_path: std::path::PathBuf, config: Config) -> AppState {
        AppState {
            config: Mutex::new(config),
            ai_settings_tx: tokio::sync::Mutex::new(()),
            config_path,
            runtime_profile: crate::paths::resolve_runtime_profile(
                std::path::Path::new("/tmp/floatnote-test-config"),
                Some(std::path::Path::new("/tmp/floatnote-test-home")),
                std::path::Path::new("/tmp/floatnote-test-manifest"),
                false,
                None,
            ),
            onboarding_preview: Mutex::new(None),
            agent: std::sync::Arc::new(crate::agent::AgentService::new()),
            active_note: Mutex::new(None),
            agent_seq: AtomicU64::new(0),
            watcher: Mutex::new(None),
            write_suppress: crate::watcher::new_suppress_list(),
            popup_cache: crate::popup::PopupCache::default(),
            mutations: Mutex::new(crate::agent::MutationStore::default()),
            pending_permissions: Mutex::new(HashMap::new()),
            authorized_roots: AuthorizedRoots::default(),
        }
    }

    #[test]
    fn readiness_distinguishes_saved_active_invalid_and_unavailable_profiles() {
        use super::{ai_readiness, AiReadiness};
        let mut settings = crate::config::AiSettings::default();
        assert_eq!(ai_readiness(&settings, false), AiReadiness::Unconfigured);
        settings
            .providers
            .get_mut(&AiProviderId::Openai)
            .unwrap()
            .api_key = "secret".into();
        assert!(matches!(
            ai_readiness(&settings, false),
            AiReadiness::Incomplete { .. }
        ));
        settings
            .providers
            .get_mut(&AiProviderId::Openai)
            .unwrap()
            .model = "test-model".into();
        assert_eq!(ai_readiness(&settings, false), AiReadiness::Disabled);
        settings.active_provider_id = Some(AiProviderId::Openai);
        assert_eq!(
            ai_readiness(&settings, false),
            AiReadiness::RuntimeUnavailable
        );
        assert_eq!(ai_readiness(&settings, true), AiReadiness::Ready);
        settings.providers.remove(&AiProviderId::Openai);
        assert!(matches!(
            ai_readiness(&settings, true),
            AiReadiness::Incomplete { .. }
        ));
    }

    #[test]
    fn saved_history_can_open_after_disabling_the_provider() {
        let dir = crate::testutil::tempdir();
        let service = crate::agent::AgentService::new();
        service
            .configure(
                crate::agent::build_agent_model(
                    AiProviderId::Openai,
                    &AiProviderConfig {
                        api_key: "test-key".into(),
                        model: "test-model".into(),
                        base_url: None,
                    },
                )
                .unwrap(),
            )
            .unwrap();
        let path = dir.path().to_string_lossy().into_owned();
        let (file, _) = service
            .new_session("history-test".into(), path.clone(), path)
            .unwrap();
        service.clear_configuration().unwrap();
        assert!(service.open_session("history-test".into(), file).is_ok());
        assert!(!service.is_configured());
    }

    #[test]
    fn auto_popup_mode_is_an_explicit_allowlist() {
        assert!(is_valid_auto_popup_mode("off"));
        assert!(is_valid_auto_popup_mode("auto"));
        assert!(is_valid_auto_popup_mode("shortcut"));
        assert!(!is_valid_auto_popup_mode("every"));
        assert!(!is_valid_auto_popup_mode("modifier"));
        assert!(!is_valid_auto_popup_mode("always"));
        assert!(!is_valid_auto_popup_mode("OFF"));
        assert!(should_install_selection_monitor("auto"));
        assert!(should_install_selection_monitor("shortcut"));
        assert!(!should_install_selection_monitor("off"));
    }

    #[test]
    fn inactive_provider_save_commits_to_memory_and_disk_without_runtime_swap() {
        let dir = crate::testutil::tempdir();
        let path = dir.path().join("config.json");
        let state = state_at(path.clone(), Config::default());
        let updates_runtime = tauri::async_runtime::block_on(save_ai_provider_inner(
            &state,
            AiProviderId::Kimi,
            AiProviderConfig {
                api_key: " key ".into(),
                model: " kimi-k2.5 ".into(),
                base_url: Some("https://ignored.example".into()),
            },
        ))
        .unwrap();
        assert!(!updates_runtime);

        let memory = state.config.lock().unwrap().clone();
        let disk = crate::config::load(&path);
        assert_eq!(memory, disk);
        assert_eq!(
            memory.ai_settings.providers[&AiProviderId::Kimi].api_key,
            "key"
        );
        assert_eq!(
            memory.ai_settings.providers[&AiProviderId::Kimi].base_url,
            None
        );
    }

    #[test]
    fn deactivation_commits_and_clears_the_runtime_model() {
        let dir = crate::testutil::tempdir();
        let path = dir.path().join("config.json");
        let mut config = Config::default();
        config.ai_settings.providers.insert(
            AiProviderId::Openai,
            AiProviderConfig {
                api_key: "key".into(),
                model: "gpt-5".into(),
                base_url: None,
            },
        );
        config.ai_settings.active_provider_id = Some(AiProviderId::Openai);
        let state = state_at(path.clone(), config);

        tauri::async_runtime::block_on(set_active_ai_provider_inner(&state, None)).unwrap();

        assert_eq!(
            state.config.lock().unwrap().ai_settings.active_provider_id,
            None
        );
        assert_eq!(
            crate::config::load(&path).ai_settings.active_provider_id,
            None
        );
    }

    #[test]
    fn shortcut_persistence_failure_restores_previous_runtime_bindings() {
        let dir = crate::testutil::tempdir();
        let blocker = dir.path().join("blocker");
        std::fs::write(&blocker, "not a directory").unwrap();
        let state = state_at(blocker.join("config.json"), Config::default());
        let previous = state.config.lock().unwrap().clone();
        let mut applied = Vec::new();

        let error = apply_shortcuts_inner(
            &state,
            "Alt+Cmd+X".into(),
            "Alt+Cmd+Y".into(),
            "Alt+Cmd+Z".into(),
            WindowShortcuts::default(),
            |capture, toggle, popup| {
                applied.push((capture.to_string(), toggle.to_string(), popup.to_string()));
                Ok(())
            },
        )
        .unwrap_err();

        assert!(error.contains("No such file") || error.contains("os error"));
        assert_eq!(applied.len(), 2);
        assert_eq!(applied[1].0, previous.shortcut_capture);
        assert_eq!(*state.config.lock().unwrap(), previous);
    }

    #[test]
    fn output_mode_event_runs_only_after_successful_persistence() {
        use crate::config::AssistantOutputMode;
        let dir = crate::testutil::tempdir();
        let path = dir.path().join("config.json");
        let state = state_at(path, Config::default());
        let mut emitted = 0;
        set_assistant_output_mode_inner(&state, AssistantOutputMode::Detailed, |_| emitted += 1)
            .unwrap();
        assert_eq!(emitted, 1);

        let blocker = dir.path().join("blocker");
        std::fs::write(&blocker, "not a directory").unwrap();
        let state = state_at(blocker.join("config.json"), Config::default());
        let mut emitted = 0;
        assert!(
            set_assistant_output_mode_inner(&state, AssistantOutputMode::Detailed, |_| emitted +=
                1)
            .is_err()
        );
        assert_eq!(emitted, 0);
        assert_eq!(
            state.config.lock().unwrap().assistant_output_mode,
            AssistantOutputMode::Compact
        );
    }
}
