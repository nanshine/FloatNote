//! User-home and app-data path resolution. Cross-platform (`HOME` on POSIX,
//! `USERPROFILE` on Windows). Shared by chat history and the agent skill
//! resolver so neither owns a helper that belongs to neither.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const DEV_PROFILE_ENV: &str = "FLOATNOTE_DEV_PROFILE";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfile {
    pub name: String,
    pub is_debug: bool,
    pub root: Option<PathBuf>,
    pub config_path: PathBuf,
    pub data_dir: PathBuf,
    pub workspace_dir: Option<PathBuf>,
}

static RUNTIME: OnceLock<RuntimeProfile> = OnceLock::new();

pub fn resolve_runtime_profile(
    app_config_dir: &Path,
    home: Option<&Path>,
    manifest_dir: &Path,
    debug: bool,
    override_name: Option<&str>,
) -> RuntimeProfile {
    if debug {
        let name = override_name
            .filter(|value| {
                !value.is_empty()
                    && value
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
            })
            .unwrap_or("default")
            .to_string();
        let root = manifest_dir.join("target").join("dev-profiles").join(&name);
        return RuntimeProfile {
            name,
            is_debug: true,
            config_path: root.join("config.json"),
            data_dir: root.join("data"),
            workspace_dir: Some(root.join("workspace")),
            root: Some(root),
        };
    }
    RuntimeProfile {
        name: "production".into(),
        is_debug: false,
        root: None,
        config_path: app_config_dir.join("config.json"),
        data_dir: home
            .map(|path| path.join(".floatnote"))
            .unwrap_or_else(|| app_config_dir.join("data")),
        workspace_dir: None,
    }
}

pub fn initialize_runtime(app_config_dir: PathBuf) -> &'static RuntimeProfile {
    RUNTIME.get_or_init(|| {
        let override_name = if cfg!(debug_assertions) {
            std::env::var(DEV_PROFILE_ENV).ok()
        } else {
            None
        };
        resolve_runtime_profile(
            &app_config_dir,
            user_home_dir().as_deref(),
            Path::new(env!("CARGO_MANIFEST_DIR")),
            cfg!(debug_assertions),
            override_name.as_deref(),
        )
    })
}

pub fn runtime_profile() -> Option<&'static RuntimeProfile> {
    RUNTIME.get()
}

pub(crate) fn user_home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

/// `~/.floatnote` — the app's per-user data dir. None when the home dir is
/// unset. Callers create the dir (and hide it on Windows) themselves so this
/// stays a pure path resolver.
pub(crate) fn floatnote_home() -> Option<PathBuf> {
    runtime_profile()
        .map(|profile| profile.data_dir.clone())
        .or_else(|| user_home_dir().map(|home| home.join(".floatnote")))
}

/// Resolve defaults per OS user, preserving explicit/saved locations and debug isolation.
/// Documents comes from Tauri's OS resolver (including redirected Windows folders).
pub fn resolve_project_root(
    requested: Option<&str>,
    saved: Option<&str>,
    profile: Option<&RuntimeProfile>,
    documents: Option<&Path>,
    home: Option<&Path>,
) -> Result<PathBuf, String> {
    let explicit = requested.filter(|value| !value.trim().is_empty());
    let saved = saved.filter(|value| !value.trim().is_empty());
    let root = explicit
        .or(saved)
        .map(PathBuf::from)
        .or_else(|| profile.and_then(|value| value.workspace_dir.clone()))
        .or_else(|| documents.or(home).map(|base| base.join("FloatNote")))
        .ok_or("无法确定当前用户的默认保存位置，请选择项目目录")?;
    if !root.is_absolute() {
        return Err("项目目录必须是绝对路径，请重新选择保存位置".into());
    }
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_defaults_preserve_user_paths_and_debug_isolation() {
        let root = crate::testutil::tempdir();
        let documents = root.path().join("redirected-documents");
        let home = root.path().join("user-home");
        let saved = root.path().join("my-notes");
        let explicit = root.path().join("chosen-location");
        let resolve = |requested, saved, profile, documents| {
            resolve_project_root(requested, saved, profile, documents, Some(&home)).unwrap()
        };
        assert_eq!(
            resolve(None, None, None, Some(&documents)),
            documents.join("FloatNote")
        );
        assert_eq!(resolve(None, None, None, None), home.join("FloatNote"));
        assert_eq!(resolve(None, saved.to_str(), None, Some(&documents)), saved);
        assert_eq!(
            resolve(explicit.to_str(), saved.to_str(), None, Some(&documents)),
            explicit
        );
        let profile = resolve_runtime_profile(
            root.path(),
            Some(&home),
            root.path(),
            true,
            Some("onboarding"),
        );
        assert_eq!(
            resolve(None, None, Some(&profile), Some(&documents)),
            profile.workspace_dir.unwrap()
        );
        assert!(resolve_project_root(None, None, None, None, None).is_err());
        assert!(resolve_project_root(Some("relative"), None, None, None, None).is_err());
    }

    #[test]
    fn debug_profiles_are_fully_isolated() {
        let profile = resolve_runtime_profile(
            Path::new("/app"),
            Some(Path::new("/home/me")),
            Path::new("/repo/src-tauri"),
            true,
            Some("onboarding"),
        );
        assert_eq!(
            profile.config_path,
            Path::new("/repo/src-tauri/target/dev-profiles/onboarding/config.json")
        );
        assert_eq!(
            profile.data_dir,
            Path::new("/repo/src-tauri/target/dev-profiles/onboarding/data")
        );
        assert_eq!(
            profile.workspace_dir.as_deref(),
            Some(Path::new(
                "/repo/src-tauri/target/dev-profiles/onboarding/workspace"
            ))
        );
    }

    #[test]
    fn release_ignores_profile_override() {
        let profile = resolve_runtime_profile(
            Path::new("/app"),
            Some(Path::new("/home/me")),
            Path::new("/repo/src-tauri"),
            false,
            Some("onboarding"),
        );
        assert_eq!(profile.name, "production");
        assert_eq!(profile.config_path, Path::new("/app/config.json"));
        assert_eq!(profile.data_dir, Path::new("/home/me/.floatnote"));
        assert!(profile.workspace_dir.is_none());
    }
}
