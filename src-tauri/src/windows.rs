use std::sync::Mutex;

/// Retain a navigation request until the settings webview consumes it.
#[derive(Default)]
pub struct SettingsNavigation(pub Mutex<Option<String>>);

#[tauri::command]
pub fn take_settings_navigation(state: tauri::State<SettingsNavigation>) -> Option<String> {
    state.0.lock().unwrap().take()
}

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub fn note_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

pub fn toggle_note(app: &AppHandle) {
    if let Some(window) = note_window(app) {
        let visible = window.is_visible().unwrap_or(false);
        set_note_visible(app, !visible);
    }
}

/// 显示或隐藏笔记窗（关闭按钮与托盘切换都走这里）。助手活在窗内，随之一并显隐。
pub fn set_note_visible(app: &AppHandle, visible: bool) {
    let Some(window) = note_window(app) else {
        return;
    };
    if visible {
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        let _ = window.hide();
    }
}

pub fn show_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn show_history(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("history") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    match WebviewWindowBuilder::new(app, "history", WebviewUrl::App("history.html".into()))
        .title("")
        .inner_size(760.0, 560.0)
        .min_inner_size(520.0, 360.0)
        .visible(false)
        .build()
    {
        Ok(window) => {
            let win = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = win.hide();
                }
            });
            let _ = window.show();
            let _ = window.set_focus();
        }
        Err(error) => eprintln!("failed to open history window: {error}"),
    }
}
