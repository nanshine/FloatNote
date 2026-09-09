use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};

static SAVE_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum AssistantOutputMode {
    #[default]
    Compact,
    Detailed,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum OnboardingStatus {
    #[default]
    NotStarted,
    InProgress,
    Completed,
    Dismissed,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum OnboardingStep {
    #[default]
    Welcome,
    Capture,
    Writing,
    Tasks,
    Split,
    Assistant,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(default)]
pub struct OnboardingState {
    pub version: u8,
    pub status: OnboardingStatus,
    pub step: OnboardingStep,
    pub capture_succeeded: bool,
}

impl Default for OnboardingState {
    fn default() -> Self {
        Self {
            version: 1,
            status: OnboardingStatus::NotStarted,
            step: OnboardingStep::Welcome,
            capture_succeeded: false,
        }
    }
}

impl OnboardingState {
    pub fn migrated_existing_user() -> Self {
        Self {
            status: OnboardingStatus::Completed,
            ..Self::default()
        }
    }

    pub fn normalized(mut self) -> Self {
        self.version = 1;
        self
    }
}

impl<'de> Deserialize<'de> for Theme {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        Ok(match value.as_str() {
            Some("light") => Self::Light,
            Some("dark") => Self::Dark,
            _ => Self::System,
        })
    }
}

impl<'de> Deserialize<'de> for AssistantOutputMode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        Ok(match value.as_str() {
            Some("detailed") => Self::Detailed,
            _ => Self::Compact,
        })
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "lowercase")]
pub enum AiProviderId {
    Openai,
    Deepseek,
    Anthropic,
    Kimi,
    Zhipu,
    /// Old or unknown provider identifiers deserialize here, then normalization
    /// removes them so a retired provider cannot reset the whole config file.
    #[serde(other)]
    Unsupported,
}

impl AiProviderId {
    pub const ALL: [Self; 5] = [
        Self::Openai,
        Self::Deepseek,
        Self::Anthropic,
        Self::Kimi,
        Self::Zhipu,
    ];

    pub fn allows_base_url(self) -> bool {
        matches!(self, Self::Openai | Self::Anthropic)
    }

    pub fn is_supported(self) -> bool {
        !matches!(self, Self::Unsupported)
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AiProviderConfig {
    pub api_key: String,
    pub model: String,
    pub base_url: Option<String>,
}

impl AiProviderConfig {
    pub fn is_configured(&self) -> bool {
        !self.api_key.trim().is_empty() && !self.model.trim().is_empty()
    }

    pub fn normalized_for(&self, provider: AiProviderId) -> Result<Self, String> {
        if !provider.is_supported() {
            return Err("未知的 AI 提供商".into());
        }
        let api_key = self.api_key.trim().to_string();
        let model = self.model.trim().to_string();
        if api_key.is_empty() {
            return Err("请输入 API Key".into());
        }
        if model.is_empty() {
            return Err("请输入模型 ID".into());
        }
        let base_url = if provider.allows_base_url() {
            self.base_url
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| {
                    let parsed = tauri::Url::parse(value)
                        .map_err(|_| "Base URL 必须是 http 或 https 地址".to_string())?;
                    if !matches!(parsed.scheme(), "http" | "https") {
                        return Err("Base URL 必须是 http 或 https 地址".to_string());
                    }
                    if !parsed.username().is_empty() || parsed.password().is_some() {
                        return Err("Base URL 不能包含用户名或密码".to_string());
                    }
                    Ok(value.trim_end_matches('/').to_string())
                })
                .transpose()?
        } else {
            None
        };
        Ok(Self {
            api_key,
            model,
            base_url,
        })
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct AiSettings {
    pub providers: BTreeMap<AiProviderId, AiProviderConfig>,
    pub active_provider_id: Option<AiProviderId>,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            providers: AiProviderId::ALL
                .into_iter()
                .map(|provider| (provider, AiProviderConfig::default()))
                .collect(),
            active_provider_id: None,
        }
    }
}

impl AiSettings {
    fn normalize_loaded(&mut self) {
        self.providers.remove(&AiProviderId::Unsupported);
        for provider in AiProviderId::ALL {
            let profile = self.providers.entry(provider).or_default();
            if !provider.allows_base_url() {
                profile.base_url = None;
            }
        }
        self.active_provider_id = self.active_provider_id.filter(|provider| {
            if !provider.is_supported() {
                return false;
            }
            self.providers
                .get(provider)
                .is_some_and(|profile| profile.normalized_for(*provider).is_ok())
        });
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(default)]
pub struct WindowShortcuts {
    pub assistant: String,
    pub assistant_bubble: String,
    pub action_panel: String,
    pub add_action: String,
    pub new_conversation: String,
    pub view_inbox: String,
    pub view_piece: String,
    pub view_split: String,
}

impl Default for WindowShortcuts {
    fn default() -> Self {
        let modifier = primary_shortcut_modifier();
        WindowShortcuts {
            assistant: format!("{modifier}+J"),
            assistant_bubble: format!("{modifier}+B"),
            action_panel: format!("{modifier}+T"),
            add_action: format!("{modifier}+G"),
            new_conversation: format!("{modifier}+K"),
            view_inbox: format!("{modifier}+1"),
            view_piece: format!("{modifier}+2"),
            view_split: format!("{modifier}+3"),
        }
    }
}

#[cfg(target_os = "macos")]
fn primary_shortcut_modifier() -> &'static str {
    "Cmd"
}

#[cfg(not(target_os = "macos"))]
fn primary_shortcut_modifier() -> &'static str {
    "Ctrl"
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(default)]
pub struct Config {
    pub working_dir: Option<String>,
    pub shortcut_capture: String,
    pub shortcut_toggle: String,
    /// 划词悬浮窗快捷键（弹窗式抓取），默认 ⌥⌘P。与 shortcut_capture（直接抓取）独立。
    pub shortcut_popup: String,
    /// 划词悬浮窗模式："auto"（鼠标选区自动弹）/ "shortcut"（仅快捷键）/ "off"（关闭自动监听）。
    pub auto_popup_mode: String,
    /// 笔记窗内快捷键（窗口聚焦时生效，纯前端分派）。默认值见 WindowShortcuts::default。
    pub window_shortcuts: WindowShortcuts,
    pub launch_at_login: bool,
    /// Application appearance preference. System is the default and follows the OS scheme.
    pub theme: Theme,
    /// Persisted independently so a stale settings window cannot overwrite progress.
    pub onboarding: OnboardingState,
    /// 助手是否展开显示（折叠则隐藏）。助手始终活在笔记窗内，按窗宽自动 inline/floating。
    pub assistant_open: bool,
    /// Assistant process projection. Full session history is independent of this display setting.
    pub assistant_output_mode: AssistantOutputMode,
    /// 最近打开过的项目空间绝对路径，最近的在前（MRU）。上限由前端维护（8 条）。
    /// 项目可散落在磁盘任意位置，此列表是项目切换菜单的唯一数据来源。
    pub recent_projects: Vec<String>,
    /// 最近打开过的独立文档（loose `.md`，不在任何项目空间内）绝对路径，最近的在前。
    /// 与 `recent_projects` 平行，是文档切换菜单的数据来源。
    pub recent_documents: Vec<String>,
    // ── AI 助手持久化配置 ──
    pub ai_settings: AiSettings,
    /// Names of installed Skills intentionally excluded from the AI tutor.
    pub disabled_skills: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        let modifier = primary_shortcut_modifier();
        Config {
            working_dir: None,
            shortcut_capture: format!("Alt+{modifier}+C"),
            shortcut_toggle: format!("Alt+{modifier}+N"),
            shortcut_popup: format!("Alt+{modifier}+P"),
            auto_popup_mode: "auto".to_string(),
            window_shortcuts: WindowShortcuts::default(),
            launch_at_login: false,
            theme: Theme::System,
            onboarding: OnboardingState::default(),
            assistant_open: false,
            assistant_output_mode: AssistantOutputMode::Compact,
            recent_projects: Vec::new(),
            recent_documents: Vec::new(),
            ai_settings: AiSettings::default(),
            disabled_skills: Vec::new(),
        }
    }
}

pub fn load(path: &Path) -> Config {
    match std::fs::read_to_string(path) {
        Ok(contents) => {
            let has_onboarding = serde_json::from_str::<serde_json::Value>(&contents)
                .ok()
                .and_then(|value| {
                    value
                        .as_object()
                        .map(|object| object.contains_key("onboarding"))
                })
                .unwrap_or(false);
            let mut config: Config = serde_json::from_str(&contents).unwrap_or_default();
            config.onboarding = if has_onboarding {
                config.onboarding.normalized()
            } else {
                OnboardingState::migrated_existing_user()
            };
            let loaded = config.clone();
            config.auto_popup_mode = normalize_auto_popup_mode(&config.auto_popup_mode);
            migrate_windows_shortcuts(&mut config);
            config.ai_settings.normalize_loaded();
            if config != loaded || !has_onboarding {
                let _ = save(path, &config);
            }
            config
        }
        Err(_) => Config::default(),
    }
}

#[cfg(target_os = "windows")]
fn migrate_windows_shortcut(value: &mut String) {
    if value
        .split('+')
        .any(|part| part.trim().eq_ignore_ascii_case("cmd"))
        && !value
            .split('+')
            .any(|part| part.trim().eq_ignore_ascii_case("ctrl"))
    {
        *value = value
            .split('+')
            .map(|part| {
                if part.trim().eq_ignore_ascii_case("cmd") {
                    "Ctrl"
                } else {
                    part.trim()
                }
            })
            .collect::<Vec<_>>()
            .join("+");
    }
}

#[cfg(target_os = "windows")]
fn migrate_windows_shortcuts(config: &mut Config) {
    migrate_windows_shortcut(&mut config.shortcut_capture);
    migrate_windows_shortcut(&mut config.shortcut_toggle);
    migrate_windows_shortcut(&mut config.shortcut_popup);
    migrate_windows_shortcut(&mut config.window_shortcuts.assistant);
    migrate_windows_shortcut(&mut config.window_shortcuts.assistant_bubble);
    migrate_windows_shortcut(&mut config.window_shortcuts.action_panel);
    migrate_windows_shortcut(&mut config.window_shortcuts.add_action);
    migrate_windows_shortcut(&mut config.window_shortcuts.new_conversation);
    migrate_windows_shortcut(&mut config.window_shortcuts.view_inbox);
    migrate_windows_shortcut(&mut config.window_shortcuts.view_piece);
    migrate_windows_shortcut(&mut config.window_shortcuts.view_split);
}

#[cfg(not(target_os = "windows"))]
fn migrate_windows_shortcuts(_config: &mut Config) {}

pub fn normalize_auto_popup_mode(mode: &str) -> String {
    match mode {
        "every" | "auto" => "auto",
        "modifier" | "shortcut" => "shortcut",
        "off" => "off",
        _ => "auto",
    }
    .to_string()
}

pub fn save(path: &Path, config: &Config) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config.json");
    let sequence = SAVE_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temporary = path.with_file_name(format!(
        ".{file_name}.{}.{sequence}.tmp",
        std::process::id()
    ));
    let result = (|| {
        use std::io::Write;
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(serde_json::to_string_pretty(config).unwrap().as_bytes())?;
        file.sync_all()?;
        replace_file(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let ok = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_json_yields_defaults() {
        let config: Config = serde_json::from_str("{}").unwrap();
        assert_eq!(config, Config::default());
    }

    #[test]
    fn missing_file_is_a_genuine_new_install() {
        let dir = crate::testutil::tempdir();
        let config = load(&dir.path().join("missing.json"));
        assert_eq!(config.onboarding, OnboardingState::default());
    }

    #[test]
    fn existing_config_without_onboarding_migrates_to_completed() {
        let dir = crate::testutil::tempdir();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"launch_at_login":true}"#).unwrap();
        let config = load(&path);
        assert_eq!(config.onboarding.status, OnboardingStatus::Completed);
        assert!(config.launch_at_login);
        assert!(std::fs::read_to_string(path)
            .unwrap()
            .contains("onboarding"));
    }

    #[test]
    fn partial_json_keeps_other_defaults() {
        let config: Config = serde_json::from_str(r#"{"launch_at_login":true}"#).unwrap();
        assert!(config.launch_at_login);
        assert_eq!(
            config.shortcut_capture,
            format!("Alt+{}+C", primary_shortcut_modifier())
        );
        assert_eq!(config.assistant_output_mode, AssistantOutputMode::Compact);
    }

    #[test]
    fn assistant_output_mode_roundtrips_and_invalid_values_fall_back_without_losing_config() {
        let detailed: Config =
            serde_json::from_str(r#"{"assistant_output_mode":"detailed","launch_at_login":true}"#)
                .unwrap();
        assert_eq!(
            detailed.assistant_output_mode,
            AssistantOutputMode::Detailed
        );
        let invalid: Config =
            serde_json::from_str(r#"{"assistant_output_mode":42,"launch_at_login":true}"#).unwrap();
        assert_eq!(invalid.assistant_output_mode, AssistantOutputMode::Compact);
        assert!(invalid.launch_at_login);
    }

    #[test]
    fn theme_is_preserved_while_legacy_font_size_is_ignored() {
        let config: Config =
            serde_json::from_str(r#"{"theme":"dark","font_size":20,"launch_at_login":true}"#)
                .unwrap();
        assert!(config.launch_at_login);
        let saved = serde_json::to_value(config).unwrap();
        assert_eq!(
            saved.get("theme"),
            Some(&serde_json::Value::String("dark".into()))
        );
        assert!(saved.get("font_size").is_none());
    }

    #[test]
    fn theme_defaults_to_system_and_invalid_values_fall_back_to_system() {
        let default_config: Config = serde_json::from_str("{}").unwrap();
        assert_eq!(
            serde_json::to_value(default_config).unwrap()["theme"],
            "system"
        );

        let invalid: Config = serde_json::from_str(r#"{"theme":"sepia"}"#).unwrap();
        assert_eq!(serde_json::to_value(invalid).unwrap()["theme"], "system");
    }

    #[test]
    fn load_fills_missing_ai_providers_and_clears_an_invalid_active_provider() {
        let dir = crate::testutil::tempdir();
        let path = dir.path().join("config.json");
        std::fs::write(
            &path,
            r#"{"ai_settings":{"providers":{"openai":{"apiKey":"","model":""}},"activeProviderId":"openai"}}"#,
        )
        .unwrap();

        let config = load(&path);

        assert_eq!(config.ai_settings.providers.len(), AiProviderId::ALL.len());
        assert!(config
            .ai_settings
            .providers
            .contains_key(&AiProviderId::Zhipu));
        assert_eq!(config.ai_settings.active_provider_id, None);
    }

    #[test]
    fn roundtrip() {
        let config = Config {
            working_dir: Some("/tmp/x".to_string()),
            ..Config::default()
        };
        let serialized = serde_json::to_string(&config).unwrap();
        assert_eq!(serde_json::from_str::<Config>(&serialized).unwrap(), config);
    }

    #[test]
    fn popup_shortcut_has_default() {
        let config = Config::default();
        assert_eq!(
            config.shortcut_popup,
            format!("Alt+{}+P", primary_shortcut_modifier())
        );
    }

    #[test]
    fn partial_json_keeps_popup_default() {
        let config: Config = serde_json::from_str("{}").unwrap();
        assert_eq!(
            config.shortcut_popup,
            format!("Alt+{}+P", primary_shortcut_modifier())
        );
    }

    #[test]
    fn auto_popup_mode_defaults_auto() {
        let config = Config::default();
        assert_eq!(config.auto_popup_mode, "auto");
    }

    #[test]
    fn legacy_auto_popup_modes_are_migrated() {
        assert_eq!(normalize_auto_popup_mode("every"), "auto");
        assert_eq!(normalize_auto_popup_mode("modifier"), "shortcut");
        assert_eq!(normalize_auto_popup_mode("off"), "off");
    }

    #[test]
    fn window_shortcuts_default() {
        let c = Config::default();
        assert_eq!(
            c.window_shortcuts.assistant,
            format!("{}+J", primary_shortcut_modifier())
        );
        assert_eq!(
            c.window_shortcuts.view_split,
            format!("{}+3", primary_shortcut_modifier())
        );
    }

    #[test]
    fn partial_json_keeps_window_shortcuts_default() {
        let config: Config = serde_json::from_str("{}").unwrap();
        assert_eq!(
            config.window_shortcuts.assistant,
            format!("{}+J", primary_shortcut_modifier())
        );
    }

    #[test]
    fn ai_settings_default_to_five_empty_disabled_profiles() {
        let settings = AiSettings::default();
        assert_eq!(settings.providers.len(), 5);
        assert_eq!(settings.active_provider_id, None);
        for provider in AiProviderId::ALL {
            assert_eq!(settings.providers[&provider], AiProviderConfig::default());
        }
    }

    #[test]
    fn legacy_ai_fields_are_ignored_instead_of_migrated() {
        let config: Config = serde_json::from_str(
            r#"{"ai_provider":"anthropic","ai_model":"claude-sonnet-4-5","ai_api_key":"secret","ai_connections":[{"id":"old"}]}"#,
        )
        .unwrap();
        assert_eq!(config.ai_settings, AiSettings::default());
    }

    #[test]
    fn ai_settings_use_camel_case_and_roundtrip() {
        let mut config = Config::default();
        config.ai_settings.active_provider_id = Some(AiProviderId::Kimi);
        config.ai_settings.providers.insert(
            AiProviderId::Kimi,
            AiProviderConfig {
                api_key: "key".into(),
                model: "kimi-k2.5".into(),
                base_url: None,
            },
        );
        let value = serde_json::to_value(&config).unwrap();
        assert_eq!(value["ai_settings"]["activeProviderId"], "kimi");
        assert_eq!(value["ai_settings"]["providers"]["kimi"]["apiKey"], "key");
        assert_eq!(serde_json::from_value::<Config>(value).unwrap(), config);
    }

    #[test]
    fn only_openai_and_anthropic_allow_base_urls() {
        assert!(AiProviderId::Openai.allows_base_url());
        assert!(AiProviderId::Anthropic.allows_base_url());
        assert!(!AiProviderId::Deepseek.allows_base_url());
        assert!(!AiProviderId::Kimi.allows_base_url());
        assert!(!AiProviderId::Zhipu.allows_base_url());
    }

    #[test]
    fn retired_bailian_profile_is_dropped_without_resetting_other_settings() {
        let mut config: Config = serde_json::from_str(r#"{"theme":"dark","ai_settings":{"providers":{"bailian":{"apiKey":"old","model":"qwen"},"openai":{"apiKey":"new","model":"gpt-5"}},"activeProviderId":"bailian"}}"#).unwrap();
        config.ai_settings.normalize_loaded();
        assert_eq!(config.theme, Theme::Dark);
        assert_eq!(config.ai_settings.active_provider_id, None);
        assert!(!config
            .ai_settings
            .providers
            .contains_key(&AiProviderId::Unsupported));
        assert_eq!(
            config.ai_settings.providers[&AiProviderId::Openai].model,
            "gpt-5"
        );
    }

    #[test]
    fn load_persists_retired_provider_cleanup() {
        let dir = crate::testutil::tempdir();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"ai_settings":{"providers":{"bailian":{"apiKey":"old","model":"qwen"}},"activeProviderId":"bailian"}}"#).unwrap();
        let config = load(&path);
        assert_eq!(config.ai_settings.active_provider_id, None);
        let saved = std::fs::read_to_string(path).unwrap();
        assert!(!saved.contains("bailian"));
        assert!(!saved.contains("old"));
    }

    #[test]
    fn provider_config_normalizes_fields_and_rejects_bad_urls() {
        let normalized = AiProviderConfig {
            api_key: " key ".into(),
            model: " model ".into(),
            base_url: Some(" https://proxy.example/v1/// ".into()),
        }
        .normalized_for(AiProviderId::Openai)
        .unwrap();
        assert_eq!(normalized.api_key, "key");
        assert_eq!(normalized.model, "model");
        assert_eq!(
            normalized.base_url.as_deref(),
            Some("https://proxy.example/v1")
        );
        assert!(AiProviderConfig {
            api_key: "key".into(),
            model: "model".into(),
            base_url: Some("ftp://proxy.example/v1".into()),
        }
        .normalized_for(AiProviderId::Openai)
        .is_err());
        assert!(AiProviderConfig {
            api_key: "key".into(),
            model: "model".into(),
            base_url: Some("https://user:password@proxy.example/v1".into()),
        }
        .normalized_for(AiProviderId::Openai)
        .is_err());
        assert_eq!(
            AiProviderConfig {
                api_key: "key".into(),
                model: "model".into(),
                base_url: Some("https://ignored.example".into()),
            }
            .normalized_for(AiProviderId::Kimi)
            .unwrap()
            .base_url,
            None
        );
    }
}
