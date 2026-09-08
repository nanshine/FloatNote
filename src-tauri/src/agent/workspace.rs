use super::protocol::{EditPreview, MutationOperation, NoteUpdated, WorkspaceEntry};
use crate::project::{INBOX_FILE, TASKS_FILE};
use crate::state::AppState;
use crate::versions;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub const LEASE_TTL: Duration = Duration::from_secs(120);

#[derive(Debug, Clone)]
pub struct PendingMutation {
    pub request_id: String,
    pub conversation_id: String,
    pub tool_call_id: String,
    pub operation: MutationOperation,
    pub dir: PathBuf,
    pub path: PathBuf,
    pub note_id: String,
    pub old_content: String,
    pub new_content: String,
    pub create_only: bool,
    pub can_snapshot: bool,
}

#[derive(Debug, Clone)]
pub struct ApprovedMutation {
    pub mutation: PendingMutation,
    pub write_mode: String,
    pub expires_at: Instant,
}

#[derive(Default)]
pub struct MutationStore {
    pending: HashMap<String, PendingMutation>,
    approved: HashMap<String, ApprovedMutation>,
}

impl MutationStore {
    pub fn insert_pending(&mut self, mutation: PendingMutation) {
        self.pending.insert(mutation.request_id.clone(), mutation);
    }

    pub fn pending(&self, request_id: &str) -> Option<PendingMutation> {
        self.pending.get(request_id).cloned()
    }

    pub fn deny(&mut self, request_id: &str) -> Option<PendingMutation> {
        self.pending.remove(request_id)
    }

    pub fn approve(
        &mut self,
        request_id: &str,
        write_mode: &str,
        now: Instant,
    ) -> Result<String, String> {
        self.retain_active(now);
        let mutation = self.pending.remove(request_id).ok_or("写入审核已失效")?;
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes).map_err(|error| format!("无法生成写入许可：{error}"))?;
        let lease = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        self.approved.insert(
            lease.clone(),
            ApprovedMutation {
                mutation,
                write_mode: write_mode.into(),
                expires_at: now + LEASE_TTL,
            },
        );
        Ok(lease)
    }

    pub fn take_approved(
        &mut self,
        lease: &str,
        tool_call_id: &str,
        conversation_id: &str,
        now: Instant,
    ) -> Result<ApprovedMutation, String> {
        let approved = self.approved.remove(lease).ok_or("写入许可无效或已使用")?;
        self.retain_active(now);
        if approved.expires_at <= now {
            return Err("写入许可已过期，请重新审核".into());
        }
        if approved.mutation.tool_call_id != tool_call_id
            || approved.mutation.conversation_id != conversation_id
        {
            return Err("写入许可与当前工具调用不匹配".into());
        }
        Ok(approved)
    }

    pub fn clear_conversation(&mut self, conversation_id: &str) {
        self.pending
            .retain(|_, mutation| mutation.conversation_id != conversation_id);
        self.approved
            .retain(|_, approved| approved.mutation.conversation_id != conversation_id);
    }

    pub fn pending_request_ids(&self, conversation_id: &str) -> Vec<String> {
        self.pending
            .values()
            .filter(|mutation| mutation.conversation_id == conversation_id)
            .map(|mutation| mutation.request_id.clone())
            .collect()
    }

    fn retain_active(&mut self, now: Instant) {
        self.approved
            .retain(|_, approved| approved.expires_at > now);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MutationCommitOutcome {
    pub ok: bool,
    pub version: Option<u32>,
    pub error: Option<String>,
}

fn failed_commit(message: impl Into<String>) -> MutationCommitOutcome {
    MutationCommitOutcome {
        ok: false,
        version: None,
        error: Some(message.into()),
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn commit_at_with<F: FnOnce()>(
    dir: &Path,
    note_id: &str,
    path: &Path,
    old_content: &str,
    new_content: &str,
    create_only: bool,
    write_mode: &str,
    can_snapshot: bool,
    operation: MutationOperation,
    before_write: F,
) -> MutationCommitOutcome {
    if write_mode != "direct" && write_mode != "snapshot" {
        return failed_commit("不支持的写入模式");
    }
    if write_mode == "snapshot"
        && (!can_snapshot || operation != MutationOperation::Rewrite || create_only)
    {
        return failed_commit("该操作不允许保存快照");
    }
    if create_only {
        if operation != MutationOperation::Create {
            return failed_commit("创建操作类型不匹配");
        }
        before_write();
        return match crate::notes::write_new_atomic(path, new_content) {
            Ok(()) => MutationCommitOutcome {
                ok: true,
                version: None,
                error: None,
            },
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                failed_commit("同名文档已存在")
            }
            Err(error) => failed_commit(error.to_string()),
        };
    }

    let on_disk = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) => return failed_commit(format!("无法读取当前笔记：{error}")),
    };
    if on_disk != old_content {
        return failed_commit("笔记已变更，请重读");
    }
    let version = if write_mode == "snapshot" {
        match versions::snapshot(dir, note_id, old_content, "ai") {
            Ok(version) => Some(version),
            Err(error) => return failed_commit(format!("保存快照失败：{error}")),
        }
    } else {
        None
    };
    before_write();
    if let Err(error) = crate::notes::write_atomic(path, new_content) {
        return failed_commit(error.to_string());
    }
    MutationCommitOutcome {
        ok: true,
        version,
        error: None,
    }
}

#[allow(clippy::too_many_arguments)]
#[cfg(test)]
fn commit_at(
    dir: &Path,
    note_id: &str,
    path: &Path,
    old_content: &str,
    new_content: &str,
    create_only: bool,
    write_mode: &str,
    can_snapshot: bool,
    operation: MutationOperation,
) -> MutationCommitOutcome {
    commit_at_with(
        dir,
        note_id,
        path,
        old_content,
        new_content,
        create_only,
        write_mode,
        can_snapshot,
        operation,
        || {},
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // Rewrite/create are consumed by the mutation transaction added in Task 6.
pub enum ResolveMode {
    ReadExisting,
    RewriteExisting,
    CreatePiece,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedWorkspaceFile {
    pub path: PathBuf,
    pub note_id: String,
    pub kind: String,
}

fn single_file_name(value: &str) -> Result<&str, String> {
    let path = Path::new(value);
    let mut components = path.components();
    let name = match (components.next(), components.next()) {
        (Some(Component::Normal(name)), None) => name.to_str().ok_or("路径必须是 UTF-8")?,
        _ => return Err("路径必须是当前项目根目录中的文件名".into()),
    };
    if name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
        || name == "."
        || name == ".."
    {
        return Err("路径不能包含目录或遍历片段".into());
    }
    Ok(name)
}

fn classify_file_name(name: &str) -> Result<(&str, &str), String> {
    match name {
        INBOX_FILE => Ok(("_inbox", "inbox")),
        TASKS_FILE => Ok(("_tasks", "tasks")),
        _ if name.starts_with('_') => Err("不支持访问该系统文件".into()),
        _ if name.ends_with(".md") && name.len() > 3 => Ok((name.trim_end_matches(".md"), "piece")),
        _ => Err("只支持当前项目中的 Markdown 笔记".into()),
    }
}

fn canonical_project_root(dir: &Path) -> Result<PathBuf, String> {
    if !dir.is_dir() {
        return Err("当前项目目录不存在".into());
    }
    dir.canonicalize()
        .map_err(|error| format!("无法解析当前项目路径：{error}"))
}

pub fn resolve_project_file(
    dir: &Path,
    virtual_path: &str,
    mode: ResolveMode,
) -> Result<ResolvedWorkspaceFile, String> {
    let name = single_file_name(virtual_path)?;
    let (note_id, kind) = classify_file_name(name)?;
    let root = canonical_project_root(dir)?;
    let joined = root.join(name);

    match mode {
        ResolveMode::CreatePiece => {
            if kind != "piece" {
                return Err("Agent 只能创建新的 piece，不能创建系统文件".into());
            }
            if joined.exists() {
                return Err("同名文档已存在".into());
            }
            let parent = joined
                .parent()
                .ok_or("无法解析目标目录")?
                .canonicalize()
                .map_err(|error| format!("无法解析目标目录：{error}"))?;
            if parent != root {
                return Err("目标路径不在当前项目中".into());
            }
        }
        ResolveMode::ReadExisting | ResolveMode::RewriteExisting => {
            if !joined.is_file() {
                return Err("笔记不存在".into());
            }
            let real = joined
                .canonicalize()
                .map_err(|error| format!("无法解析笔记路径：{error}"))?;
            if !real.starts_with(&root) || real.parent() != Some(root.as_path()) {
                return Err("笔记路径不在当前项目中".into());
            }
            return Ok(ResolvedWorkspaceFile {
                path: real,
                note_id: note_id.into(),
                kind: kind.into(),
            });
        }
    }

    Ok(ResolvedWorkspaceFile {
        path: joined,
        note_id: note_id.into(),
        kind: kind.into(),
    })
}

pub fn list_project_space(dir: &Path) -> Result<Vec<WorkspaceEntry>, String> {
    let root = canonical_project_root(dir)?;
    let mut entries = Vec::new();
    for (name, kind) in [(INBOX_FILE, "inbox"), (TASKS_FILE, "tasks")] {
        if resolve_project_file(&root, name, ResolveMode::ReadExisting).is_ok() {
            entries.push(WorkspaceEntry {
                path: name.into(),
                kind: kind.into(),
            });
        }
    }

    let mut pieces = std::fs::read_dir(&root)
        .map_err(|error| format!("无法列出当前项目：{error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| !name.starts_with('_') && name.ends_with(".md") && name.len() > 3)
        .filter(|name| resolve_project_file(&root, name, ResolveMode::ReadExisting).is_ok())
        .collect::<Vec<_>>();
    pieces.sort();
    entries.extend(pieces.into_iter().map(|path| WorkspaceEntry {
        path,
        kind: "piece".into(),
    }));
    Ok(entries)
}

pub(crate) fn active_project_dir(state: &AppState) -> Result<PathBuf, String> {
    let active = state
        .active_note
        .lock()
        .unwrap()
        .clone()
        .ok_or("当前没有活动项目")?;
    let dir = PathBuf::from(active.dir);
    if !state.authorized_roots.allows_project(&dir) {
        return Err("当前项目未由 FloatNote 授权".into());
    }
    if !crate::project::is_project_dir(&dir) {
        return Err("当前没有活动的 FloatNote project space".into());
    }
    Ok(dir)
}

#[derive(Debug, Clone)]
pub(crate) struct MutationDraft {
    pub operation: MutationOperation,
    pub path: String,
    pub old_content: String,
    pub new_content: String,
    pub create_only: bool,
    pub preview: EditPreview,
}

pub(crate) async fn review_and_commit(
    app: &AppHandle,
    conversation_id: &str,
    tool_call_id: &str,
    tool_name: &str,
    draft: MutationDraft,
) -> Result<String, String> {
    let state = app.state::<AppState>();
    if !mutation_matches_tool(tool_name, draft.operation) {
        return Err("工具名称与变更类型不匹配".into());
    }
    if draft.create_only != (draft.operation == MutationOperation::Create) {
        return Err("createOnly 与变更类型不匹配".into());
    }
    let dir = active_project_dir(&state)?;
    let mode = if draft.create_only {
        ResolveMode::CreatePiece
    } else {
        ResolveMode::RewriteExisting
    };
    let resolved = resolve_project_file(&dir, &draft.path, mode)?;
    if draft.operation == MutationOperation::Tag && resolved.kind != "inbox" {
        return Err("标签工具只能修改 _inbox.md".into());
    }
    if draft.create_only {
        if !draft.old_content.is_empty() {
            return Err("创建操作的旧内容必须为空".into());
        }
    } else {
        let current = std::fs::read_to_string(&resolved.path)
            .map_err(|error| format!("无法读取当前笔记：{error}"))?;
        if current != draft.old_content {
            return Err("笔记已变更，请重读".into());
        }
    }
    let can_snapshot = tool_name == "write"
        && draft.operation == MutationOperation::Rewrite
        && resolved.kind == "piece";
    let request_id = format!("permission-{}", random_token(12)?);
    let pending = PendingMutation {
        request_id: request_id.clone(),
        conversation_id: conversation_id.into(),
        tool_call_id: tool_call_id.into(),
        operation: draft.operation,
        dir,
        path: resolved.path,
        note_id: resolved.note_id,
        old_content: draft.old_content,
        new_content: draft.new_content,
        create_only: draft.create_only,
        can_snapshot,
    };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    state
        .mutations
        .lock()
        .unwrap()
        .insert_pending(pending.clone());
    state
        .pending_permissions
        .lock()
        .unwrap()
        .insert(request_id.clone(), sender);
    let payload = serde_json::json!({
        "request_id": request_id, "conversation_id": conversation_id, "tool_call_id": tool_call_id,
        "tool_name": tool_name, "operation": pending.operation, "old_content": pending.old_content,
        "new_content": pending.new_content, "preview": draft.preview, "can_snapshot": can_snapshot,
        "resolved_dir": pending.dir.to_string_lossy(), "resolved_note_id": pending.note_id,
        "resolved_path": pending.path.to_string_lossy(),
    });
    if let Err(error) = app.emit("permission://request", payload) {
        state.mutations.lock().unwrap().deny(&pending.request_id);
        state
            .pending_permissions
            .lock()
            .unwrap()
            .remove(&pending.request_id);
        return Err(format!("无法显示写入确认：{error}"));
    }
    let (lease, _selected_mode) =
        match tokio::time::timeout(Duration::from_secs(600), receiver).await {
            Ok(Ok(result)) => result?,
            Ok(Err(_)) => return Err("写入审核已取消".into()),
            Err(_) => {
                state.mutations.lock().unwrap().deny(&pending.request_id);
                state
                    .pending_permissions
                    .lock()
                    .unwrap()
                    .remove(&pending.request_id);
                return Err("写入审核已超时".into());
            }
        };
    let approved = state.mutations.lock().unwrap().take_approved(
        &lease,
        tool_call_id,
        conversation_id,
        Instant::now(),
    )?;
    let write_mode = approved.write_mode.clone();
    let mutation = approved.mutation;
    let path_text = mutation.path.to_string_lossy().into_owned();
    let outcome = commit_at_with(
        &mutation.dir,
        &mutation.note_id,
        &mutation.path,
        &mutation.old_content,
        &mutation.new_content,
        mutation.create_only,
        &write_mode,
        mutation.can_snapshot,
        mutation.operation,
        || crate::watcher::mark_self_write(&state.write_suppress, &path_text),
    );
    if !outcome.ok {
        return Err(outcome.error.unwrap_or_else(|| "写入失败".into()));
    }
    let _ = app.emit(
        "note://updated",
        NoteUpdated {
            note_id: mutation.note_id,
            path: path_text,
            version: outcome.version.unwrap_or(0),
        },
    );
    Ok(match mutation.operation {
        MutationOperation::Create => format!("已创建 {}", draft.path),
        _ => outcome.version.map_or_else(
            || format!("已更新 {}", draft.path),
            |version| format!("已更新 {}，版本 v{version}", draft.path),
        ),
    })
}

fn random_token(bytes_len: usize) -> Result<String, String> {
    let mut bytes = vec![0u8; bytes_len];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn mutation_matches_tool(tool_name: &str, operation: MutationOperation) -> bool {
    match tool_name {
        "edit" => operation == MutationOperation::Edit,
        "write" => operation == MutationOperation::Rewrite,
        "create_piece" => operation == MutationOperation::Create,
        "tag_text" | "tag_create" | "tag_update" | "tag_delete" => {
            operation == MutationOperation::Tag
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::tempdir;
    use std::time::{Duration, Instant};

    fn pending(request_id: &str, tool_call_id: &str, old: &str, new: &str) -> PendingMutation {
        PendingMutation {
            request_id: request_id.into(),
            conversation_id: "conversation-1".into(),
            tool_call_id: tool_call_id.into(),
            operation: MutationOperation::Rewrite,
            dir: PathBuf::from("/tmp"),
            path: PathBuf::from("/tmp/piece.md"),
            note_id: "piece".into(),
            old_content: old.into(),
            new_content: new.into(),
            create_only: false,
            can_snapshot: true,
        }
    }

    #[test]
    fn approved_lease_is_single_use_and_bound_to_tool_call() {
        let mut store = MutationStore::default();
        store.insert_pending(pending("request-1", "tool-1", "old", "new"));
        let now = Instant::now();
        let lease = store.approve("request-1", "direct", now).unwrap();
        assert!(store
            .take_approved(&lease, "tool-2", "conversation-1", now)
            .is_err());
        assert!(store
            .take_approved(&lease, "tool-1", "conversation-1", now)
            .is_err());

        store.insert_pending(pending("request-2", "tool-1", "old", "new"));
        let lease = store.approve("request-2", "direct", now).unwrap();
        assert!(store
            .take_approved(&lease, "tool-1", "conversation-1", now)
            .is_ok());
        assert!(store
            .take_approved(&lease, "tool-1", "conversation-1", now)
            .is_err());
    }

    #[test]
    fn approved_lease_is_bound_to_conversation() {
        let mut store = MutationStore::default();
        store.insert_pending(pending("request-1", "tool-1", "old", "new"));
        let now = Instant::now();
        let lease = store.approve("request-1", "direct", now).unwrap();
        assert!(store
            .take_approved(&lease, "tool-1", "conversation-2", now)
            .is_err());
    }

    #[test]
    fn expired_lease_cannot_commit() {
        let mut store = MutationStore::default();
        store.insert_pending(pending("request-1", "tool-1", "old", "new"));
        let now = Instant::now();
        let lease = store.approve("request-1", "direct", now).unwrap();
        assert!(store
            .take_approved(
                &lease,
                "tool-1",
                "conversation-1",
                now + LEASE_TTL + Duration::from_secs(1),
            )
            .is_err());
    }

    #[test]
    fn commit_rejects_stale_content_and_create_race() {
        let dir = tempdir();
        let path = dir.path().join("piece.md");
        std::fs::write(&path, "changed").unwrap();
        assert_eq!(
            commit_at(
                dir.path(),
                "piece",
                &path,
                "old",
                "new",
                false,
                "direct",
                true,
                MutationOperation::Rewrite,
            )
            .error
            .as_deref(),
            Some("笔记已变更，请重读")
        );
        assert!(commit_at(
            dir.path(),
            "piece",
            &path,
            "",
            "new",
            true,
            "direct",
            false,
            MutationOperation::Create,
        )
        .error
        .unwrap()
        .contains("已存在"));
    }

    #[test]
    fn lists_only_project_space_markdown() {
        let dir = tempdir();
        std::fs::write(dir.path().join("_inbox.md"), "inbox").unwrap();
        std::fs::write(dir.path().join("_tasks.md"), "tasks").unwrap();
        std::fs::write(dir.path().join("piece.md"), "piece").unwrap();
        std::fs::write(dir.path().join("_private.md"), "private").unwrap();
        std::fs::write(dir.path().join("image.png"), "png").unwrap();

        let entries = list_project_space(dir.path()).unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec!["_inbox.md", "_tasks.md", "piece.md"]
        );
    }

    #[test]
    fn rejects_traversal_subdirectories_and_unknown_system_files() {
        let dir = tempdir();
        for path in [
            "../escape.md",
            "nested/a.md",
            "nested\\a.md",
            "_private.md",
            "/tmp/a.md",
            r"C:\temp\a.md",
        ] {
            assert!(
                resolve_project_file(dir.path(), path, ResolveMode::ReadExisting).is_err(),
                "{path}"
            );
        }
    }

    #[test]
    fn create_mode_accepts_only_a_missing_piece() {
        let dir = tempdir();
        assert!(resolve_project_file(dir.path(), "Ideas.md", ResolveMode::CreatePiece).is_ok());
        assert!(resolve_project_file(dir.path(), "_tasks.md", ResolveMode::CreatePiece).is_err());
        assert!(resolve_project_file(dir.path(), "Ideas.MD", ResolveMode::CreatePiece).is_err());
        std::fs::write(dir.path().join("Ideas.md"), "exists").unwrap();
        assert!(resolve_project_file(dir.path(), "Ideas.md", ResolveMode::CreatePiece).is_err());
        assert!(resolve_project_file(dir.path(), "Ideas.md", ResolveMode::RewriteExisting).is_ok());
    }

    #[test]
    fn create_operation_belongs_only_to_create_piece() {
        assert!(mutation_matches_tool(
            "create_piece",
            MutationOperation::Create
        ));
        assert!(!mutation_matches_tool("write", MutationOperation::Create));
        assert!(mutation_matches_tool("write", MutationOperation::Rewrite));
    }
}
