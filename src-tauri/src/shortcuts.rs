use std::str::FromStr;
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[cfg(target_os = "windows")]
fn normalize_windows_shortcut(value: &str) -> String {
    value
        .split('+')
        .map(|part| match part.trim().to_ascii_lowercase().as_str() {
            "win" | "meta" | "super" => "Super".to_string(),
            "mod" => "Ctrl".to_string(),
            _ => part.trim().to_string(),
        })
        .collect::<Vec<_>>()
        .join("+")
}

fn parse_shortcut(value: &str) -> Result<Shortcut, String> {
    #[cfg(target_os = "windows")]
    let value = normalize_windows_shortcut(value);
    #[cfg(not(target_os = "windows"))]
    let value = value.to_string();
    Shortcut::from_str(&value).map_err(|error| format!("{error:?}"))
}

pub fn apply(app: &AppHandle, capture: &str, toggle: &str, popup: &str) -> Result<(), String> {
    let capture_shortcut = parse_shortcut(capture).map_err(|error| format!("capture: {error}"))?;
    let toggle_shortcut = parse_shortcut(toggle).map_err(|error| format!("toggle: {error}"))?;
    let popup_shortcut = parse_shortcut(popup).map_err(|error| format!("popup: {error}"))?;

    let global_shortcut = app.global_shortcut();
    let _ = global_shortcut.unregister_all();

    let capture_app = app.clone();
    global_shortcut
        .on_shortcut(capture_shortcut, move |_app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                crate::capture::run_capture(&capture_app);
            }
        })
        .map_err(|error| format!("register capture: {error:?}"))?;

    let toggle_app = app.clone();
    global_shortcut
        .on_shortcut(toggle_shortcut, move |_app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                crate::windows::toggle_note(&toggle_app);
            }
        })
        .map_err(|error| format!("register toggle: {error:?}"))?;

    let popup_app = app.clone();
    global_shortcut
        .on_shortcut(popup_shortcut, move |_app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                crate::popup::run_popup_capture(&popup_app);
            }
        })
        .map_err(|error| format!("register popup: {error:?}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_aliases_parse_as_global_hotkeys() {
        assert!(parse_shortcut("Alt+Win+C").is_ok());
        assert!(parse_shortcut("Ctrl+Win+P").is_ok());
        assert!(parse_shortcut("Alt+Mod+N").is_ok());
    }
}
