mod agent;
mod capture;
mod chat_history;
mod commands;
mod config;
mod cursor;
mod notes;
mod paths;
mod platform;
mod popup;
mod popup_hover;
mod project;
mod selection_intent;
mod selection_monitor;
mod selection_probe;
mod shortcuts;
mod source;
mod state;
mod trash;
mod tray;
mod versions;
mod watcher;
mod windows;

#[cfg(test)]
mod testutil;

use state::AppState;
use std::sync::Mutex;
use tauri::{Emitter, Manager, WindowEvent};

pub fn run() {
    // `mut` 仅在 debug 构建注册 wdio 插件时需要；release 下会被剥离，故关 unused_mut。
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .register_uri_scheme_protocol("floatnote-img", |ctx, request| {
            use std::path::PathBuf;
            // URI path is like "/<percent-encoded absolute path>". Strip the
            // leading "/", percent-decode, then validate + serve.
            let raw = request.uri().path();
            let encoded = raw.strip_prefix('/').unwrap_or(raw);
            let decoded = percent_encoding::percent_decode_str(encoded)
                .decode_utf8_lossy()
                .into_owned();
            let path = PathBuf::from(&decoded);
            let state = ctx.app_handle().state::<AppState>();
            if !crate::notes::is_safe_image_path(&path)
                || !state.authorized_roots.allows_image(&path)
            {
                return tauri::http::Response::builder()
                    .status(tauri::http::StatusCode::FORBIDDEN)
                    .header(tauri::http::header::CONTENT_TYPE, "text/plain")
                    .body("forbidden".as_bytes().to_vec())
                    .unwrap();
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            match std::fs::read(&path) {
                Ok(bytes) => tauri::http::Response::builder()
                    .header(
                        tauri::http::header::CONTENT_TYPE,
                        crate::notes::image_content_type(ext),
                    )
                    .body(bytes)
                    .unwrap(),
                Err(_) => tauri::http::Response::builder()
                    .status(tauri::http::StatusCode::NOT_FOUND)
                    .header(tauri::http::header::CONTENT_TYPE, "text/plain")
                    .body("not found".as_bytes().to_vec())
                    .unwrap(),
            }
        });

    // 原生 WebDriver 只用于显式 e2e-wdio debug 诊断；普通 dev/release 均不加载。
    #[cfg(all(debug_assertions, feature = "e2e-wdio"))]
    {
        builder = builder.plugin(tauri_plugin_wdio::init());
        builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    }

    builder
        .setup(|app| {
            let app_config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("FloatNote"));
            let runtime_profile = paths::initialize_runtime(app_config_dir).clone();
            if let Some(workspace) = runtime_profile.workspace_dir.as_ref() {
                std::fs::create_dir_all(workspace)?;
            }
            let path = commands::config_path(app.handle());
            let config_missing = !path.exists();
            let mut config = config::load(&path);
            if runtime_profile.is_debug && config_missing {
                if let Some(workspace) = runtime_profile.workspace_dir.as_ref() {
                    config.working_dir = Some(workspace.to_string_lossy().into_owned());
                    config::save(&path, &config)?;
                }
            }
            let write_suppress = watcher::new_suppress_list();
            let file_watcher =
                match watcher::FileWatcher::new(app.handle().clone(), write_suppress.clone()) {
                    Ok(w) => Some(w),
                    Err(e) => {
                        eprintln!("文件监听器不可用，外部修改将不会实时刷新: {e}");
                        None
                    }
                };
            let agent_service = std::sync::Arc::new(agent::AgentService::new());
            let _ = agent_service.reload_skills(
                agent::skill_paths_for_app(app.handle()),
                config.disabled_skills.clone(),
            );
            if let Some(provider) = config.ai_settings.active_provider_id {
                if let Some(profile) = config.ai_settings.providers.get(&provider) {
                    match agent::build_agent_model(provider, profile) {
                        Ok(model) => {
                            let _ = agent_service.configure(model);
                        }
                        Err(error) => eprintln!("agent configuration failed: {error}"),
                    }
                }
            }
            app.manage(windows::SettingsNavigation::default());
            app.manage(AppState {
                config: Mutex::new(config),
                ai_settings_tx: tokio::sync::Mutex::new(()),
                config_path: path,
                runtime_profile,
                onboarding_preview: Mutex::new(None),
                agent: agent_service,
                active_note: Mutex::new(None),
                agent_seq: std::sync::atomic::AtomicU64::new(0),
                watcher: Mutex::new(file_watcher),
                write_suppress,
                popup_cache: crate::popup::PopupCache::new(),
                mutations: Mutex::new(agent::MutationStore::default()),
                pending_permissions: Mutex::new(std::collections::HashMap::new()),
                authorized_roots: state::AuthorizedRoots::default(),
            });

            let _ = app.emit("agent://event", agent::AgentEvent::Ready);

            #[cfg(target_os = "macos")]
            let _ = app
                .handle()
                .set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Hide instead of close the note window so it can be re-opened later.
            if let Some(note_win) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                note_win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        crate::windows::set_note_visible(&handle, false);
                    }
                });
            }

            // Hide instead of close the settings window so it can be re-opened later.
            if let Some(settings_win) = app.get_webview_window("settings") {
                let win = settings_win.clone();
                settings_win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win.hide();
                    }
                });
            }

            tray::build_tray(app.handle())?;

            {
                let config = app.state::<AppState>().config.lock().unwrap().clone();
                if let Err(error) = shortcuts::apply(
                    app.handle(),
                    &config.shortcut_capture,
                    &config.shortcut_toggle,
                    &config.shortcut_popup,
                ) {
                    eprintln!("shortcut registration failed: {error}");
                }
                if commands::should_install_selection_monitor(&config.auto_popup_mode) {
                    selection_monitor::install(app.handle().clone());
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::set_config,
            commands::get_onboarding_state,
            commands::set_onboarding_state,
            commands::get_runtime_profile,
            commands::get_onboarding_preview,
            commands::set_onboarding_preview,
            commands::get_capture_permission_state,
            commands::request_capture_permission,
            commands::list_notes,
            commands::save_pasted_image,
            commands::import_image_files,
            commands::read_note,
            commands::write_note,
            commands::create_note,
            commands::rename_note,
            commands::list_projects,
            commands::resolve_projects,
            commands::create_project,
            commands::open_existing_project,
            commands::list_pieces,
            commands::resolve_documents,
            commands::rename_project,
            commands::delete_project,
            commands::delete_note,
            commands::list_versions,
            commands::snapshot_note,
            commands::read_version,
            commands::rename_version,
            commands::delete_version,
            commands::restore_version,
            commands::chat_get_for_scope,
            commands::chat_create,
            commands::chat_list_for_scope,
            commands::chat_list_all,
            commands::chat_open,
            commands::chat_update_title,
            commands::chat_delete,
            commands::chat_clear_before,
            commands::chat_clear_before_entries,
            commands::watch_dir,
            commands::unwatch_dir,
            commands::save_ai_provider,
            commands::set_active_ai_provider,
            commands::set_assistant_output_mode,
            commands::agent_send,
            commands::agent_rewind,
            commands::agent_new_session,
            commands::agent_open_session,
            commands::agent_discard_session,
            commands::agent_cancel,
            commands::agent_list_skills,
            commands::agent_reload_skills,
            commands::agent_import_skill,
            commands::resolve_permission,
            commands::set_active_note,
            commands::get_active_note,
            commands::get_assistant_state,
            commands::toggle_assistant,
            commands::apply_shortcuts,
            commands::set_auto_popup_mode,
            commands::get_window_shortcuts,
            commands::open_url,
            commands::reveal_in_file_manager,
            source::app_icon,
            popup::submit_popup_capture,
            popup::popup_selection_snapshot,
            popup::popup_ai_selection_snapshot,
            popup::set_popup_interaction_mode,
            popup::complete_popup_question,
            popup::translate_popup_selection,
            popup::open_ai_settings,
            windows::take_settings_navigation,
            commands::get_ai_readiness,
            commands::retry_ai_configuration,
            popup::dismiss_popup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running FloatNote");
}
