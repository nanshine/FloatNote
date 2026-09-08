//! Managed app state: the single `AppState` struct constructed at startup
//! and shared across Tauri commands, the Rust Agent, the popup,
//! and the selection monitor. Pulled out of `commands.rs` so the command file
//! is a thin handler layer and the state root has its own home.

use crate::agent::{ActiveNote, AgentService, MutationStore};
use crate::config::Config;
use crate::popup::PopupCache;
use crate::watcher::{FileWatcher, SuppressList};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

type PermissionDecision = tokio::sync::oneshot::Sender<Result<(String, String), String>>;

/// Project roots that have been explicitly opened by this app instance.
/// Custom image URLs are constrained to these roots so another local
/// `_assets` directory cannot be used as an arbitrary-file reader.
#[derive(Default)]
pub struct AuthorizedRoots {
    roots: Mutex<Vec<PathBuf>>,
}

impl AuthorizedRoots {
    pub fn authorize(&self, root: &std::path::Path) {
        let Ok(root) = root.canonicalize() else {
            return;
        };
        let mut roots = self.roots.lock().unwrap();
        if !roots.iter().any(|known| known == &root) {
            roots.push(root);
        }
    }

    pub fn allows_image(&self, path: &std::path::Path) -> bool {
        let Ok(path) = path.canonicalize() else {
            return false;
        };
        self.roots
            .lock()
            .unwrap()
            .iter()
            .any(|root| path.starts_with(root))
    }

    pub fn allows_project(&self, path: &std::path::Path) -> bool {
        let Ok(path) = path.canonicalize() else {
            return false;
        };
        self.roots.lock().unwrap().iter().any(|root| root == &path)
    }
}

pub struct AppState {
    pub config: Mutex<Config>,
    /// Serializes provider runtime → disk → memory transactions.
    pub ai_settings_tx: tokio::sync::Mutex<()>,
    pub config_path: PathBuf,
    /// In-process Rust agent runtime.
    pub agent: Arc<AgentService>,
    /// agent_send 记录的当前活动笔记，供 apply_write 定位文件。
    pub active_note: Mutex<Option<ActiveNote>>,
    /// 单调递增的 requestId 计数器。
    pub agent_seq: AtomicU64,
    /// 文件系统监听器；None 表示尚未初始化。
    pub watcher: Mutex<Option<FileWatcher>>,
    /// 自身写入抑制表，与 watcher 共享。
    pub write_suppress: SuppressList,
    /// 划词弹窗急切抓取的待提交文本。
    pub popup_cache: PopupCache,
    /// Structured mutation reviews and one-use approval leases.
    pub mutations: Mutex<MutationStore>,
    /// Pending human decisions for mutation tools.
    pub pending_permissions: Mutex<HashMap<String, PermissionDecision>>,
    /// Roots authorised by opening/watching a project in this app instance.
    pub authorized_roots: AuthorizedRoots,
}

#[cfg(test)]
mod tests {
    use super::AuthorizedRoots;
    use crate::testutil::tempdir;

    #[test]
    fn authorized_roots_only_allow_assets_in_registered_project() {
        let project = tempdir();
        let outside = tempdir();
        let allowed = project.path().join("_assets").join("photo.png");
        let denied = outside.path().join("_assets").join("photo.png");
        std::fs::create_dir_all(allowed.parent().unwrap()).unwrap();
        std::fs::create_dir_all(denied.parent().unwrap()).unwrap();
        std::fs::write(&allowed, b"image").unwrap();
        std::fs::write(&denied, b"image").unwrap();

        let roots = AuthorizedRoots::default();
        roots.authorize(project.path());

        assert!(roots.allows_image(&allowed));
        assert!(!roots.allows_image(&denied));
    }
}
