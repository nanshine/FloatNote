use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const INDEX_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatScopeType {
    Project,
    Document,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatTitleState {
    Final,
    Temporary,
    Generated,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryMessage {
    pub role: String,
    pub text: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatToolSummary {
    pub name: String,
    pub status: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatConversationIndexEntry {
    pub id: String,
    pub session_file: String,
    pub scope_type: ChatScopeType,
    pub scope_path: String,
    pub scope_label: String,
    pub title: String,
    pub title_state: ChatTitleState,
    pub created_at: u64,
    pub updated_at: u64,
    pub last_opened_at: u64,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub messages: Vec<ChatHistoryMessage>,
    #[serde(default)]
    pub tool_summaries: Vec<ChatToolSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatHistoryIndex {
    version: u32,
    conversations: Vec<ChatConversationIndexEntry>,
}

impl Default for ChatHistoryIndex {
    fn default() -> Self {
        Self {
            version: INDEX_VERSION,
            conversations: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ChatHistoryStore {
    root: PathBuf,
}

impl ChatHistoryStore {
    pub fn default_for_user() -> io::Result<Self> {
        let floatnote = crate::paths::floatnote_home().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "user home directory not found")
        })?;
        try_hide_on_windows(&floatnote);
        Ok(Self::new_at(floatnote.join("chat-history")))
    }

    pub(crate) fn session_directory(&self) -> PathBuf {
        self.session_dir()
    }

    pub(crate) fn validate_session_file(&self, candidate: &Path) -> io::Result<PathBuf> {
        let root = self.session_dir().canonicalize()?;
        let file = candidate.canonicalize()?;
        if file.parent() != Some(root.as_path())
            || file.extension().and_then(|ext| ext.to_str()) != Some("jsonl")
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "session file is outside FloatNote chat history",
            ));
        }
        Ok(file)
    }

    pub fn new_at(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn session_dir(&self) -> PathBuf {
        self.root.join("sessions")
    }

    pub fn create(
        &self,
        scope_type: ChatScopeType,
        scope_path: &str,
        scope_label: &str,
    ) -> io::Result<ChatConversationIndexEntry> {
        let _guard = lock_store();
        self.ensure_dirs()?;
        let mut index = self.load_index()?;
        let now = now_millis();
        let id = next_conversation_id(now);
        let session_file = self.session_dir().join(format!("{id}.jsonl"));
        let entry = ChatConversationIndexEntry {
            id,
            session_file: session_file.to_string_lossy().into_owned(),
            scope_type,
            scope_path: scope_path.to_string(),
            scope_label: scope_label.to_string(),
            title: "新对话".to_string(),
            title_state: ChatTitleState::Temporary,
            created_at: now,
            updated_at: now,
            last_opened_at: now,
            model: String::new(),
            messages: Vec::new(),
            tool_summaries: Vec::new(),
        };
        index.conversations.push(entry.clone());
        self.save_index(&index)?;
        Ok(entry)
    }

    pub fn get_for_scope(
        &self,
        scope_type: ChatScopeType,
        scope_path: &str,
    ) -> io::Result<Option<ChatConversationIndexEntry>> {
        let _guard = lock_store();
        let mut entries = self
            .load_index()?
            .conversations
            .into_iter()
            .filter(|entry| entry.scope_type == scope_type && entry.scope_path == scope_path)
            .filter(|entry| self.has_persisted_history(entry))
            .collect::<Vec<_>>();
        sort_by_recent(&mut entries);
        Ok(entries.into_iter().next())
    }

    pub fn list_for_scope(
        &self,
        scope_type: ChatScopeType,
        scope_path: &str,
    ) -> io::Result<Vec<ChatConversationIndexEntry>> {
        let _guard = lock_store();
        let mut entries = self
            .load_index()?
            .conversations
            .into_iter()
            .filter(|entry| entry.scope_type == scope_type && entry.scope_path == scope_path)
            .filter(|entry| self.has_persisted_history(entry))
            .collect::<Vec<_>>();
        sort_by_recent(&mut entries);
        Ok(entries)
    }

    pub fn list_recent(&self, limit: usize) -> io::Result<Vec<ChatConversationIndexEntry>> {
        let _guard = lock_store();
        let mut entries = self
            .load_index()?
            .conversations
            .into_iter()
            .filter(|entry| self.has_persisted_history(entry))
            .collect::<Vec<_>>();
        sort_by_recent(&mut entries);
        entries.truncate(limit);
        Ok(entries)
    }

    pub fn list_all(
        &self,
        cursor: usize,
        limit: usize,
    ) -> io::Result<Vec<ChatConversationIndexEntry>> {
        let _guard = lock_store();
        let mut entries = self
            .load_index()?
            .conversations
            .into_iter()
            .filter(|entry| self.has_persisted_history(entry))
            .collect::<Vec<_>>();
        sort_by_recent(&mut entries);
        Ok(entries.into_iter().skip(cursor).take(limit).collect())
    }

    pub fn open(&self, conversation_id: &str) -> io::Result<Option<ChatConversationIndexEntry>> {
        let _guard = lock_store();
        let mut index = self.load_index()?;
        let Some(entry) = index
            .conversations
            .iter_mut()
            .find(|entry| entry.id == conversation_id)
        else {
            return Ok(None);
        };
        let mut repaired = false;
        if !Path::new(&entry.session_file).is_file() {
            if let Some(path) = self.session_files_by_id()?.remove(conversation_id) {
                entry.session_file = path.to_string_lossy().into_owned();
                repaired = true;
            }
        }
        let opened = entry.clone();
        if repaired {
            self.save_index(&index)?;
        }
        Ok(Some(opened))
    }

    pub fn touch_activity(
        &self,
        conversation_id: &str,
    ) -> io::Result<Option<ChatConversationIndexEntry>> {
        let _guard = lock_store();
        let mut index = self.load_index()?;
        let Some(entry) = index
            .conversations
            .iter_mut()
            .find(|entry| entry.id == conversation_id)
        else {
            return Ok(None);
        };
        entry.updated_at = now_millis();
        let updated = entry.clone();
        self.save_index(&index)?;
        Ok(Some(updated))
    }

    pub fn update_session_snapshot(
        &self,
        conversation_id: &str,
        session_file: String,
        model: String,
        messages: Vec<ChatHistoryMessage>,
        tool_summaries: Vec<ChatToolSummary>,
    ) -> io::Result<Option<ChatConversationIndexEntry>> {
        let _guard = lock_store();
        let mut index = self.load_index()?;
        let Some(entry) = index
            .conversations
            .iter_mut()
            .find(|entry| entry.id == conversation_id)
        else {
            return Ok(None);
        };
        entry.session_file = session_file;
        entry.model = model;
        entry.messages = messages;
        entry.tool_summaries = tool_summaries;
        let updated = entry.clone();
        self.save_index(&index)?;
        Ok(Some(updated))
    }

    pub fn update_generated_title(
        &self,
        conversation_id: &str,
        title: &str,
    ) -> io::Result<Option<ChatConversationIndexEntry>> {
        let _guard = lock_store();
        let mut index = self.load_index()?;
        let Some(entry) = index
            .conversations
            .iter_mut()
            .find(|entry| entry.id == conversation_id)
        else {
            return Ok(None);
        };
        if entry.title_state == ChatTitleState::Manual {
            return Ok(Some(entry.clone()));
        }
        entry.title = title.to_string();
        entry.title_state = ChatTitleState::Generated;
        let updated = entry.clone();
        self.save_index(&index)?;
        Ok(Some(updated))
    }

    pub fn update_title(
        &self,
        conversation_id: &str,
        title: &str,
        title_state: ChatTitleState,
    ) -> io::Result<Option<ChatConversationIndexEntry>> {
        let _guard = lock_store();
        let mut index = self.load_index()?;
        let Some(entry) = index
            .conversations
            .iter_mut()
            .find(|entry| entry.id == conversation_id)
        else {
            return Ok(None);
        };
        entry.title = title.to_string();
        entry.title_state = title_state;
        let updated = entry.clone();
        self.save_index(&index)?;
        Ok(Some(updated))
    }

    pub fn delete(&self, conversation_id: &str) -> io::Result<Option<ChatConversationIndexEntry>> {
        let _guard = lock_store();
        let mut index = self.load_index()?;
        let Some(pos) = index
            .conversations
            .iter()
            .position(|entry| entry.id == conversation_id)
        else {
            return Ok(None);
        };
        let removed = index.conversations.remove(pos);
        match std::fs::remove_file(&removed.session_file) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        self.save_index(&index)?;
        Ok(Some(removed))
    }

    pub fn clear_before_entries(
        &self,
        timestamp: u64,
    ) -> io::Result<Vec<ChatConversationIndexEntry>> {
        let _guard = lock_store();
        let mut index = self.load_index()?;
        let mut removed = Vec::new();
        let mut keep = Vec::new();
        for entry in index.conversations {
            if entry.updated_at < timestamp {
                match std::fs::remove_file(&entry.session_file) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
                removed.push(entry);
            } else {
                keep.push(entry);
            }
        }
        index.conversations = keep;
        self.save_index(&index)?;
        Ok(removed)
    }

    pub fn clear_before(&self, timestamp: u64) -> io::Result<usize> {
        let _guard = lock_store();
        let mut index = self.load_index()?;
        let original_len = index.conversations.len();
        let mut keep = Vec::new();
        for entry in index.conversations {
            if entry.updated_at < timestamp {
                match std::fs::remove_file(&entry.session_file) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
            } else {
                keep.push(entry);
            }
        }
        let removed = original_len - keep.len();
        index.conversations = keep;
        self.save_index(&index)?;
        Ok(removed)
    }

    fn ensure_dirs(&self) -> io::Result<()> {
        std::fs::create_dir_all(self.session_dir())
    }

    fn index_path(&self) -> PathBuf {
        self.root.join("index.json")
    }

    fn load_index(&self) -> io::Result<ChatHistoryIndex> {
        self.ensure_dirs()?;
        let path = self.index_path();
        if !path.exists() {
            return Ok(ChatHistoryIndex::default());
        }
        let raw = std::fs::read_to_string(&path)?;
        match serde_json::from_str::<ChatHistoryIndex>(&raw) {
            Ok(mut index) => {
                if index.version != INDEX_VERSION {
                    index.version = INDEX_VERSION;
                }
                self.recover_index(&mut index)?;
                Ok(index)
            }
            Err(error) => {
                let corrupt = path.with_extension(format!("json.corrupt-{}", now_millis()));
                let _ = std::fs::copy(&path, corrupt);
                let backup_path = path.with_extension("json.bak");
                if let Ok(raw) = std::fs::read_to_string(backup_path) {
                    if let Ok(mut backup) = serde_json::from_str::<ChatHistoryIndex>(&raw) {
                        backup.version = INDEX_VERSION;
                        self.recover_index(&mut backup)?;
                        return Ok(backup);
                    }
                }
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("chat history index is corrupt: {error}"),
                ))
            }
        }
    }

    fn save_index(&self, index: &ChatHistoryIndex) -> io::Result<()> {
        self.ensure_dirs()?;
        let index_path = self.index_path();
        if let Ok(current) = std::fs::read_to_string(&index_path) {
            if serde_json::from_str::<ChatHistoryIndex>(&current).is_ok() {
                crate::notes::write_atomic(&index_path.with_extension("json.bak"), &current)?;
            }
        }
        let mut content = serde_json::to_string_pretty(index)?;
        content.push('\n');
        crate::notes::write_atomic(&index_path, &content)
    }

    fn recover_index(&self, index: &mut ChatHistoryIndex) -> io::Result<()> {
        let sessions = self.session_files_by_id()?;
        for entry in &mut index.conversations {
            if !Path::new(&entry.session_file).is_file() {
                if let Some(path) = sessions.get(&entry.id) {
                    entry.session_file = path.to_string_lossy().into_owned();
                }
            }
        }

        let known_ids = index
            .conversations
            .iter()
            .map(|entry| entry.id.clone())
            .collect::<HashSet<_>>();
        let mut split_recoveries = Vec::new();
        for entry in &index.conversations {
            let indexed_path = Path::new(&entry.session_file);
            let Some(indexed_session_id) = read_session_id(indexed_path) else {
                continue;
            };
            if indexed_session_id == entry.id {
                continue;
            }
            let Some(original_path) = sessions.get(&entry.id) else {
                continue;
            };
            if original_path == indexed_path {
                continue;
            }
            let recovered_id = format!("{}-legacy", entry.id);
            if known_ids.contains(&recovered_id) {
                continue;
            }
            let mut recovered = entry.clone();
            recovered.id = recovered_id;
            recovered.session_file = original_path.to_string_lossy().into_owned();
            recovered.title = format!("{}（较早记录）", entry.title);
            recovered.messages.clear();
            recovered.tool_summaries.clear();
            if let Some(modified) = file_mtime_millis(original_path) {
                recovered.updated_at = modified;
                recovered.last_opened_at = modified;
            }
            split_recoveries.push(recovered);
        }
        index.conversations.extend(split_recoveries);

        let backup_path = self.index_path().with_extension("json.bak");
        let Ok(raw) = std::fs::read_to_string(backup_path) else {
            return Ok(());
        };
        let Ok(backup) = serde_json::from_str::<ChatHistoryIndex>(&raw) else {
            return Ok(());
        };
        for mut entry in backup.conversations {
            if index.conversations.iter().any(|known| known.id == entry.id) {
                continue;
            }
            let Some(path) = sessions.get(&entry.id) else {
                continue;
            };
            entry.session_file = path.to_string_lossy().into_owned();
            index.conversations.push(entry);
        }
        Ok(())
    }

    fn session_files_by_id(&self) -> io::Result<HashMap<String, PathBuf>> {
        let mut sessions = HashMap::new();
        for item in std::fs::read_dir(self.session_dir())? {
            let path = item?.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(id) = read_session_id(&path) else {
                continue;
            };
            sessions.entry(id).or_insert(path);
        }
        Ok(sessions)
    }

    fn has_persisted_history(&self, entry: &ChatConversationIndexEntry) -> bool {
        Path::new(&entry.session_file).is_file() || !entry.messages.is_empty()
    }
}

fn sort_by_recent(entries: &mut [ChatConversationIndexEntry]) {
    entries.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| b.created_at.cmp(&a.created_at))
    });
}

fn lock_store() -> MutexGuard<'static, ()> {
    static STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    STORE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read_session_id(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let first = io::BufReader::new(file).lines().next()?.ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&first).ok()?;
    (value.get("type")?.as_str()? == "session")
        .then(|| value.get("id")?.as_str().map(str::to_string))?
}

fn file_mtime_millis(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

fn now_millis() -> u64 {
    static LAST_NOW: AtomicU64 = AtomicU64::new(0);
    let current = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    loop {
        let last = LAST_NOW.load(Ordering::Relaxed);
        let next = current.max(last + 1);
        if LAST_NOW
            .compare_exchange(last, next, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
        {
            return next;
        }
    }
}

fn next_conversation_id(now: u64) -> String {
    static NEXT_ID: AtomicU64 = AtomicU64::new(0);
    format!(
        "c{now}-{}-{}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn try_hide_on_windows(path: &Path) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::fs::create_dir_all(path);
        let _ = std::process::Command::new("attrib")
            .arg("+H")
            .arg(path)
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_and_reopens_scope_conversation() {
        let dir = tempdir();
        let store = ChatHistoryStore::new_at(dir.path().join("chat-history"));

        let entry = store
            .create(ChatScopeType::Project, "/tmp/project", "Project")
            .unwrap();

        assert_eq!(entry.scope_type, ChatScopeType::Project);
        assert_eq!(entry.scope_path, "/tmp/project");
        assert_eq!(entry.scope_label, "Project");
        assert!(std::path::Path::new(&entry.session_file).starts_with(dir.path()));
        assert!(entry.title_state == ChatTitleState::Temporary);
        assert!(entry.model.is_empty());
        assert!(entry.messages.is_empty());
        assert!(entry.tool_summaries.is_empty());
        std::fs::write(&entry.session_file, "session\n").unwrap();

        let last = store
            .get_for_scope(ChatScopeType::Project, "/tmp/project")
            .unwrap()
            .unwrap();
        assert_eq!(last.id, entry.id);
    }

    #[test]
    fn lists_recent_conversations_by_activity() {
        let dir = tempdir();
        let store = ChatHistoryStore::new_at(dir.path().join("chat-history"));
        let first = store
            .create(ChatScopeType::Project, "/tmp/project-a", "Project A")
            .unwrap();
        let second = store
            .create(ChatScopeType::Document, "/tmp/doc.md", "doc")
            .unwrap();
        std::fs::write(&first.session_file, "session\n").unwrap();
        std::fs::write(&second.session_file, "session\n").unwrap();

        store.touch_activity(&first.id).unwrap();

        let recent = store.list_recent(2).unwrap();
        assert_eq!(
            recent
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            [first.id.as_str(), second.id.as_str(),]
        );
    }

    #[test]
    fn opening_is_read_only_and_does_not_reorder_conversations() {
        let dir = tempdir();
        let store = ChatHistoryStore::new_at(dir.path().join("chat-history"));
        let first = store
            .create(ChatScopeType::Project, "/tmp/project-a", "Project A")
            .unwrap();
        let second = store
            .create(ChatScopeType::Project, "/tmp/project-b", "Project B")
            .unwrap();
        std::fs::write(&first.session_file, "session\n").unwrap();
        std::fs::write(&second.session_file, "session\n").unwrap();
        store.touch_activity(&first.id).unwrap();
        let backup_path = store.index_path().with_extension("json.bak");
        std::fs::remove_file(&backup_path).unwrap();

        let before = store.open(&second.id).unwrap().unwrap();
        let opened = store.open(&second.id).unwrap().unwrap();
        let recent = store.list_recent(2).unwrap();

        assert_eq!(opened.updated_at, before.updated_at);
        assert_eq!(opened.last_opened_at, before.last_opened_at);
        assert_eq!(recent[0].id, first.id);
        assert_eq!(recent[1].id, second.id);
        assert!(!backup_path.exists(), "viewing should not write the index");
    }

    #[test]
    fn session_binding_and_snapshot_sync_do_not_touch_activity() {
        let dir = tempdir();
        let store = ChatHistoryStore::new_at(dir.path().join("chat-history"));
        let entry = store
            .create(ChatScopeType::Project, "/tmp/project", "Project")
            .unwrap();
        let actual = store.session_dir().join("timestamped-session.jsonl");
        std::fs::write(&actual, "session\n").unwrap();

        let bound = store
            .update_session_snapshot(
                &entry.id,
                actual.to_string_lossy().into_owned(),
                "model".into(),
                vec![ChatHistoryMessage {
                    role: "user".into(),
                    text: "hello".into(),
                    timestamp: 1,
                }],
                Vec::new(),
            )
            .unwrap()
            .unwrap();

        assert_eq!(bound.session_file, actual.to_string_lossy());
        assert_eq!(bound.updated_at, entry.updated_at);
        assert_eq!(bound.last_opened_at, entry.last_opened_at);
        assert_eq!(bound.messages.len(), 1);
    }

    #[test]
    fn title_updates_do_not_reorder_conversation_activity() {
        let dir = tempdir();
        let store = ChatHistoryStore::new_at(dir.path().join("chat-history"));
        let entry = store
            .create(ChatScopeType::Project, "/tmp/project", "Project")
            .unwrap();

        let generated = store
            .update_generated_title(&entry.id, "Generated")
            .unwrap()
            .unwrap();
        let manual = store
            .update_title(&entry.id, "Manual", ChatTitleState::Manual)
            .unwrap()
            .unwrap();

        assert_eq!(generated.updated_at, entry.updated_at);
        assert_eq!(manual.updated_at, entry.updated_at);
    }

    #[test]
    fn opening_recovers_a_legacy_timestamped_session_path_without_touching_activity() {
        let dir = tempdir();
        let store = ChatHistoryStore::new_at(dir.path().join("chat-history"));
        let entry = store
            .create(ChatScopeType::Project, "/tmp/project", "Project")
            .unwrap();
        let actual = store
            .session_dir()
            .join(format!("2026-07-14T12-00-00-000Z_{}.jsonl", entry.id));
        std::fs::write(
            &actual,
            format!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"{}\",\"timestamp\":\"2026-07-14T12:00:00.000Z\",\"cwd\":\"/tmp/project\"}}\n",
                entry.id
            ),
        )
        .unwrap();

        let opened = store.open(&entry.id).unwrap().unwrap();

        assert_eq!(opened.session_file, actual.to_string_lossy());
        assert_eq!(opened.updated_at, entry.updated_at);
        assert_eq!(opened.last_opened_at, entry.last_opened_at);
    }

    #[test]
    fn a_corrupt_index_is_reported_instead_of_being_replaced_with_an_empty_one() {
        let dir = tempdir();
        let store = ChatHistoryStore::new_at(dir.path().join("chat-history"));
        store.ensure_dirs().unwrap();
        std::fs::write(store.index_path(), "{ incomplete").unwrap();

        let error = store.list_recent(5).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(
            std::fs::read_to_string(store.index_path()).unwrap(),
            "{ incomplete"
        );
    }

    #[test]
    fn a_corrupt_current_index_does_not_overwrite_the_last_valid_backup() {
        let dir = tempdir();
        let store = ChatHistoryStore::new_at(dir.path().join("chat-history"));
        store.ensure_dirs().unwrap();
        let backup = store.index_path().with_extension("json.bak");
        std::fs::write(&backup, "valid backup").unwrap();
        std::fs::write(store.index_path(), "{ incomplete").unwrap();

        assert!(store.list_recent(5).is_err());

        assert_eq!(std::fs::read_to_string(backup).unwrap(), "valid backup");
    }

    #[test]
    fn falls_back_to_a_valid_backup_when_the_current_index_is_corrupt() {
        let dir = tempdir();
        let store = ChatHistoryStore::new_at(dir.path().join("chat-history"));
        let entry = store
            .create(ChatScopeType::Project, "/tmp/project", "Project")
            .unwrap();
        std::fs::write(
            &entry.session_file,
            format!("{{\"type\":\"session\",\"id\":\"{}\"}}\n", entry.id),
        )
        .unwrap();
        std::fs::copy(
            store.index_path(),
            store.index_path().with_extension("json.bak"),
        )
        .unwrap();
        std::fs::write(store.index_path(), "{ incomplete").unwrap();

        let recovered = store.list_recent(5).unwrap();

        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].id, entry.id);
        assert_eq!(
            serde_json::from_str::<ChatHistoryIndex>(
                &std::fs::read_to_string(store.index_path().with_extension("json.bak")).unwrap()
            )
            .unwrap()
            .conversations
            .len(),
            1
        );
    }

    #[test]
    fn keeps_the_previous_valid_index_as_a_backup() {
        let dir = tempdir();
        let store = ChatHistoryStore::new_at(dir.path().join("chat-history"));
        let first = store
            .create(ChatScopeType::Project, "/tmp/first", "First")
            .unwrap();

        store
            .create(ChatScopeType::Project, "/tmp/second", "Second")
            .unwrap();

        let backup: ChatHistoryIndex = serde_json::from_str(
            &std::fs::read_to_string(store.index_path().with_extension("json.bak")).unwrap(),
        )
        .unwrap();
        assert_eq!(backup.conversations.len(), 1);
        assert_eq!(backup.conversations[0].id, first.id);
    }

    #[test]
    fn merges_recoverable_conversations_from_the_last_valid_backup() {
        let dir = tempdir();
        let store = ChatHistoryStore::new_at(dir.path().join("chat-history"));
        let entry = store
            .create(ChatScopeType::Project, "/tmp/project", "Project")
            .unwrap();
        let actual = store
            .session_dir()
            .join(format!("2026-07-14T12-00-00-000Z_{}.jsonl", entry.id));
        std::fs::write(
            &actual,
            format!("{{\"type\":\"session\",\"id\":\"{}\"}}\n", entry.id),
        )
        .unwrap();
        std::fs::copy(
            store.index_path(),
            store.index_path().with_extension("json.bak"),
        )
        .unwrap();
        store.save_index(&ChatHistoryIndex::default()).unwrap();

        let recovered = store.list_recent(5).unwrap();

        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].id, entry.id);
        assert_eq!(recovered[0].session_file, actual.to_string_lossy());
    }

    #[test]
    fn preserves_both_files_when_a_legacy_conversation_was_split() {
        let dir = tempdir();
        let store = ChatHistoryStore::new_at(dir.path().join("chat-history"));
        let entry = store
            .create(ChatScopeType::Project, "/tmp/project", "Project")
            .unwrap();
        std::fs::write(
            &entry.session_file,
            "{\"type\":\"session\",\"id\":\"replacement-session\"}\n",
        )
        .unwrap();
        let original = store
            .session_dir()
            .join(format!("2026-07-14T12-00-00-000Z_{}.jsonl", entry.id));
        std::fs::write(
            &original,
            format!("{{\"type\":\"session\",\"id\":\"{}\"}}\n", entry.id),
        )
        .unwrap();

        let recovered = store.list_recent(5).unwrap();

        assert_eq!(recovered.len(), 2);
        assert!(recovered
            .iter()
            .any(|item| { item.id == entry.id && item.session_file == entry.session_file }));
        assert!(recovered.iter().any(|item| {
            item.id == format!("{}-legacy", entry.id)
                && item.session_file == original.to_string_lossy()
        }));
    }

    #[test]
    fn concurrent_updates_do_not_lose_index_entries() {
        let dir = tempdir();
        let root = dir.path().join("chat-history");
        let threads = (0..12)
            .map(|index| {
                let root = root.clone();
                std::thread::spawn(move || {
                    let store = ChatHistoryStore::new_at(root);
                    let entry = store
                        .create(
                            ChatScopeType::Project,
                            &format!("/tmp/project-{index}"),
                            &format!("Project {index}"),
                        )
                        .unwrap();
                    std::fs::write(
                        &entry.session_file,
                        format!("{{\"type\":\"session\",\"id\":\"{}\"}}\n", entry.id),
                    )
                    .unwrap();
                })
            })
            .collect::<Vec<_>>();
        for thread in threads {
            thread.join().unwrap();
        }

        let entries = ChatHistoryStore::new_at(root).list_all(0, 20).unwrap();

        assert_eq!(entries.len(), 12);
    }

    #[test]
    fn delete_removes_index_entry_and_session_file() {
        let dir = tempdir();
        let store = ChatHistoryStore::new_at(dir.path().join("chat-history"));
        let entry = store
            .create(ChatScopeType::Project, "/tmp/project", "Project")
            .unwrap();
        std::fs::write(&entry.session_file, "session\n").unwrap();

        store.delete(&entry.id).unwrap();

        assert!(!std::path::Path::new(&entry.session_file).exists());
        assert!(store.open(&entry.id).unwrap().is_none());
    }

    #[test]
    fn session_validation_rejects_files_outside_the_store() {
        let dir = tempdir();
        let store = ChatHistoryStore::new_at(dir.path().join("chat-history"));
        let entry = store
            .create(ChatScopeType::Project, "/tmp/project", "Project")
            .unwrap();
        std::fs::write(&entry.session_file, "{}\n").unwrap();
        let outside = dir.path().join("outside.jsonl");
        std::fs::write(&outside, "{}\n").unwrap();
        assert!(store
            .validate_session_file(std::path::Path::new(&entry.session_file))
            .is_ok());
        assert_eq!(
            store.validate_session_file(&outside).unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
    }

    use crate::testutil::tempdir;
}
