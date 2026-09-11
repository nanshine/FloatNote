use crate::agent::{ActiveNote, AgentEvent, MutationOperation, PromptRef, PromptSkill, WriteMode};
use crate::{
    config::{AiProviderConfig, AiProviderId},
    state::AppState,
};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::atomic::Ordering,
};
use tauri::{Emitter, Manager, State};

pub(crate) async fn configure_agent(
    state: &AppState,
    provider: AiProviderId,
    config: &AiProviderConfig,
) -> Result<(), String> {
    state
        .agent
        .configure(crate::agent::build_agent_model(provider, config)?)
}

pub(crate) async fn clear_agent_configuration(state: &AppState) -> Result<(), String> {
    state.agent.clear_configuration()
}

#[tauri::command]
pub fn agent_send(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conversation_id: String,
    user_text: String,
    references: Option<Vec<PromptRef>>,
    skill: Option<PromptSkill>,
) -> Result<String, String> {
    if state
        .config
        .lock()
        .unwrap()
        .ai_settings
        .active_provider_id
        .is_none()
    {
        return Err("尚未启用 AI 提供商，请先前往设置完成配置并启用。".into());
    }
    let seq = state.agent_seq.fetch_add(1, Ordering::Relaxed) + 1;
    let request_id = format!("r{seq}");
    state.agent.prompt(
        app.clone(),
        request_id.clone(),
        conversation_id.clone(),
        user_text,
        references,
        skill,
    )?;
    if let Ok(store) = crate::chat_history::ChatHistoryStore::default_for_user() {
        if let Err(error) = store.touch_activity(&conversation_id) {
            eprintln!("failed to update chat activity for {conversation_id}: {error}");
        }
    }
    let _ = crate::tray::refresh_menu(&app);
    let _ = app.emit("chat://history-changed", ());
    Ok(request_id)
}

#[tauri::command]
pub async fn agent_rewind(
    state: State<'_, AppState>,
    conversation_id: String,
    user_entry_id: String,
) -> Result<(), String> {
    let _ = state.agent.rewind(&conversation_id, &user_entry_id)?;
    Ok(())
}

#[tauri::command]
pub async fn agent_new_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conversation_id: String,
    cwd: String,
    session_dir: String,
) -> Result<(), String> {
    let store = crate::chat_history::ChatHistoryStore::default_for_user()
        .map_err(|error| error.to_string())?;
    let requested_dir = std::path::Path::new(&session_dir)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let expected_dir = store
        .session_directory()
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if requested_dir != expected_dir {
        return Err("会话目录不属于 FloatNote 聊天历史".into());
    }
    let (session_file, messages) =
        state
            .agent
            .new_session(conversation_id.clone(), cwd, session_dir)?;
    crate::agent::sync_session_history(
        &app,
        &conversation_id,
        std::path::Path::new(&session_file),
        &messages,
    );
    app.emit(
        "agent://event",
        AgentEvent::SessionOpened {
            conversation_id,
            session_file,
            messages,
        },
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn agent_open_session(
    app: tauri::AppHandle,
    state: State<AppState>,
    conversation_id: String,
    session_file: String,
) -> Result<(), String> {
    let store = crate::chat_history::ChatHistoryStore::default_for_user()
        .map_err(|error| error.to_string())?;
    let indexed = store
        .open(&conversation_id)
        .map_err(|error| error.to_string())?
        .ok_or("对话不存在")?;
    let candidate = store
        .validate_session_file(std::path::Path::new(&session_file))
        .map_err(|error| error.to_string())?;
    let expected = store
        .validate_session_file(std::path::Path::new(&indexed.session_file))
        .map_err(|error| error.to_string())?;
    if candidate != expected {
        return Err("会话文件与历史索引不匹配".into());
    }
    let (session_file, messages) = state.agent.open_session(
        conversation_id.clone(),
        candidate.to_string_lossy().into_owned(),
    )?;
    crate::agent::sync_session_history(
        &app,
        &conversation_id,
        std::path::Path::new(&session_file),
        &messages,
    );
    app.emit(
        "agent://event",
        AgentEvent::SessionOpened {
            conversation_id,
            session_file,
            messages,
        },
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn agent_discard_session(
    state: State<AppState>,
    conversation_id: String,
) -> Result<(), String> {
    let pending = state
        .mutations
        .lock()
        .unwrap()
        .pending_request_ids(&conversation_id);
    state
        .mutations
        .lock()
        .unwrap()
        .clear_conversation(&conversation_id);
    let mut permissions = state.pending_permissions.lock().unwrap();
    for id in pending {
        if let Some(sender) = permissions.remove(&id) {
            let _ = sender.send(Err("对话已关闭".into()));
        }
    }
    drop(permissions);
    state.agent.discard_session(&conversation_id);
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantState {
    pub open: bool,
}

#[tauri::command]
pub fn get_assistant_state(state: State<AppState>) -> AssistantState {
    let config = state.config.lock().unwrap();
    AssistantState {
        open: config.assistant_open,
    }
}

#[tauri::command]
pub async fn toggle_assistant(state: State<'_, AppState>) -> Result<AssistantState, String> {
    let _transaction = state.ai_settings_tx.lock().await;
    let mut candidate = state.config.lock().unwrap().clone();
    candidate.assistant_open = !candidate.assistant_open;
    crate::config::save(&state.config_path, &candidate).map_err(|error| error.to_string())?;
    let open = candidate.assistant_open;
    *state.config.lock().unwrap() = candidate;
    Ok(AssistantState { open })
}

#[tauri::command]
pub fn set_active_note(
    state: State<AppState>,
    dir: String,
    note_id: String,
    path: String,
    kind: String,
) {
    *state.active_note.lock().unwrap() = Some(ActiveNote {
        dir,
        note_id,
        path,
        kind,
    });
}

#[tauri::command]
pub fn get_active_note(state: State<AppState>) -> Option<ActiveNote> {
    state.active_note.lock().unwrap().clone()
}

#[tauri::command]
pub fn agent_cancel(state: State<AppState>, request_id: String) -> Result<(), String> {
    if let Some(conversation_id) = state.agent.cancel(&request_id) {
        let pending = state
            .mutations
            .lock()
            .unwrap()
            .pending_request_ids(&conversation_id);
        state
            .mutations
            .lock()
            .unwrap()
            .clear_conversation(&conversation_id);
        let mut permissions = state.pending_permissions.lock().unwrap();
        for id in pending {
            if let Some(sender) = permissions.remove(&id) {
                let _ = sender.send(Err("工具调用已取消".into()));
            }
        }
    }
    Ok(())
}

#[derive(serde::Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillCatalogEntry {
    name: String,
    description: String,
    display_name: String,
    display_description: String,
    source: String,
    enabled: bool,
}

#[tauri::command]
pub fn agent_list_skills(
    app: tauri::AppHandle,
    state: State<AppState>,
) -> Result<Vec<SkillCatalogEntry>, String> {
    let disabled = state.config.lock().unwrap().disabled_skills.clone();
    let builtin = builtin_skill_roots(&app);
    let imported = crate::paths::floatnote_home().map(|path| path.join("skills"));
    catalog_skills(&builtin, imported.as_deref(), &disabled)
}

#[tauri::command]
pub fn agent_reload_skills(app: tauri::AppHandle, state: State<AppState>) -> Result<(), String> {
    let paths = crate::agent::skill_paths_for_app(&app);
    let disabled_skill_names = state.config.lock().unwrap().disabled_skills.clone();
    state.agent.reload_skills(paths, disabled_skill_names)
}

#[tauri::command]
pub fn agent_import_skill(app: tauri::AppHandle, source_path: String) -> Result<(), String> {
    let source = PathBuf::from(source_path);
    let root = crate::paths::floatnote_home()
        .ok_or("无法确定应用数据目录")?
        .join("skills");
    let reserved = catalog_skills(&builtin_skill_roots(&app), Some(&root), &[])?
        .into_iter()
        .map(|skill| skill.name)
        .collect::<Vec<_>>();
    import_skill_dir(&source, &root, &reserved)?;
    Ok(())
}

fn copy_skill_dir_inner(from: &cap_std::fs::Dir, to: &cap_std::fs::Dir) -> Result<(), String> {
    for entry in from.entries().map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let file_type = from
            .symlink_metadata(&name)
            .map_err(|e| e.to_string())?
            .file_type();
        if file_type.is_symlink() {
            return Err(format!(
                "Skill 目录包含符号链接：{}",
                name.to_string_lossy()
            ));
        }
        if file_type.is_dir() {
            to.create_dir(&name).map_err(|error| error.to_string())?;
            let source_child = from.open_dir(&name).map_err(|error| error.to_string())?;
            let destination_child = to.open_dir(&name).map_err(|error| error.to_string())?;
            copy_skill_dir_inner(&source_child, &destination_child)?;
        } else if file_type.is_file() {
            let mut source = from.open(&name).map_err(|error| {
                format!(
                    "无法在所选目录边界内读取 {}：{error}",
                    name.to_string_lossy()
                )
            })?;
            let mut options = cap_std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            let mut destination = to.open_with(&name, &options).map_err(|e| e.to_string())?;
            std::io::copy(&mut source, &mut destination).map_err(|e| e.to_string())?;
        } else {
            return Err(format!(
                "Skill 目录包含不支持的文件类型：{}",
                name.to_string_lossy()
            ));
        }
    }
    Ok(())
}

#[derive(Debug)]
struct SkillMetadata {
    name: String,
    description: String,
    display_name: String,
    display_description: String,
}

fn builtin_skill_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    #[cfg(debug_assertions)]
    {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("skills");
        if path.is_dir() {
            return vec![path];
        }
    }
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|path| path.join("skills"));
    if let Some(path) = bundled.filter(|path| path.is_dir()) {
        return vec![path];
    }
    Vec::new()
}

fn catalog_skills(
    builtin_roots: &[PathBuf],
    imported_root: Option<&Path>,
    disabled: &[String],
) -> Result<Vec<SkillCatalogEntry>, String> {
    let disabled: HashSet<&str> = disabled.iter().map(String::as_str).collect();
    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    for (source, root) in builtin_roots
        .iter()
        .map(|path| ("builtin", path.as_path()))
        .chain(imported_root.into_iter().map(|path| ("imported", path)))
    {
        if !root.is_dir() {
            continue;
        }
        let mut directories = Vec::new();
        for entry in fs::read_dir(root)
            .map_err(|error| format!("无法读取 Skills 目录 {}：{error}", root.display()))?
        {
            let entry = entry
                .map_err(|error| format!("无法读取 Skills 目录项 {}：{error}", root.display()))?;
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            if entry
                .file_type()
                .map_err(|error| {
                    format!("无法读取 Skill 类型 {}：{error}", entry.path().display())
                })?
                .is_dir()
            {
                directories.push(entry.path());
            }
        }
        directories.sort();
        for directory in directories {
            let metadata = validate_skill_dir(&directory).map_err(|error| {
                format!("无法读取 {source} Skill {}：{error}", directory.display())
            })?;
            if source == "builtin"
                && !crate::agent::BUILTIN_SKILL_NAMES.contains(&metadata.name.as_str())
            {
                continue;
            }
            if !seen.insert(metadata.name.clone()) {
                continue;
            }
            entries.push(SkillCatalogEntry {
                enabled: !disabled.contains(metadata.name.as_str()),
                name: metadata.name,
                description: metadata.description,
                display_name: metadata.display_name,
                display_description: metadata.display_description,
                source: source.into(),
            });
        }
    }
    Ok(entries)
}

fn validate_skill_dir(source: &Path) -> Result<SkillMetadata, String> {
    let source_type = fs::symlink_metadata(source)
        .map_err(|_| "请选择一个包含 SKILL.md 的目录".to_string())?
        .file_type();
    if !source_type.is_dir() || source_type.is_symlink() {
        return Err("请选择 Skill 目录，而不是单个文件或符号链接".into());
    }
    let mut skill_file = None;
    for entry in fs::read_dir(source).map_err(|error| format!("无法读取所选目录：{error}"))?
    {
        let entry = entry.map_err(|error| format!("无法读取所选目录项：{error}"))?;
        if entry.file_name() == std::ffi::OsStr::new("SKILL.md") {
            skill_file = Some(entry.path());
            break;
        }
    }
    let skill_file = skill_file.ok_or_else(|| "所选目录根部缺少 SKILL.md".to_string())?;
    let file_type = fs::symlink_metadata(&skill_file)
        .map_err(|_| "所选目录根部缺少 SKILL.md".to_string())?
        .file_type();
    if !file_type.is_file() || file_type.is_symlink() {
        return Err("所选目录根部的 SKILL.md 必须是普通文件".into());
    }
    let text =
        fs::read_to_string(&skill_file).map_err(|error| format!("无法读取 SKILL.md：{error}"))?;
    let metadata = parse_skill_metadata(&text)?;
    if !metadata
        .name
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_')
    {
        return Err("Skill name 只能包含 ASCII 字母、数字、-、_".into());
    }
    Ok(metadata)
}

fn validate_open_skill_dir(source: &cap_std::fs::Dir) -> Result<SkillMetadata, String> {
    let file_type = source
        .symlink_metadata("SKILL.md")
        .map_err(|_| "所选目录根部缺少 SKILL.md".to_string())?
        .file_type();
    if !file_type.is_file() || file_type.is_symlink() {
        return Err("所选目录根部的 SKILL.md 必须是普通文件".into());
    }
    let mut file = source
        .open("SKILL.md")
        .map_err(|error| format!("无法读取 SKILL.md：{error}"))?;
    let mut text = String::new();
    file.read_to_string(&mut text)
        .map_err(|error| format!("无法读取 SKILL.md：{error}"))?;
    let metadata = parse_skill_metadata(&text)?;
    if !metadata
        .name
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_')
    {
        return Err("Skill name 只能包含 ASCII 字母、数字、-、_".into());
    }
    Ok(metadata)
}

#[cfg(unix)]
fn open_bound_dir(path: &Path, label: &str) -> Result<cap_std::fs::Dir, String> {
    let before = fs::symlink_metadata(path).map_err(|error| format!("无法读取{label}：{error}"))?;
    if !before.is_dir() || before.file_type().is_symlink() {
        return Err(format!("{label}必须是普通目录，而不是符号链接"));
    }
    let directory = cap_std::fs::Dir::open_ambient_dir(path, cap_std::ambient_authority())
        .map_err(|error| format!("无法安全打开{label}：{error}"))?;
    let opened = directory
        .dir_metadata()
        .map_err(|error| format!("无法确认{label}：{error}"))?;
    if !directory_identity_matches(&before, &opened) {
        return Err(format!("{label}在打开过程中发生变化，请重试"));
    }
    Ok(directory)
}

#[cfg(windows)]
fn open_bound_dir(path: &Path, label: &str) -> Result<cap_std::fs::Dir, String> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    let before = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| format!("无法读取{label}：{error}"))?;
    let metadata = before
        .metadata()
        .map_err(|error| format!("无法读取{label}：{error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(format!("{label}必须是普通目录，而不是符号链接"));
    }
    let directory = cap_std::fs::Dir::open_ambient_dir(path, cap_std::ambient_authority())
        .map_err(|error| format!("无法安全打开{label}：{error}"))?;
    if !directory_identity_matches(&before, &directory)? {
        return Err(format!("{label}在打开过程中发生变化，请重试"));
    }
    Ok(directory)
}

#[cfg(unix)]
fn directory_identity_matches(before: &fs::Metadata, opened: &cap_std::fs::Metadata) -> bool {
    use cap_std::fs::MetadataExt as CapMetadataExt;
    use std::os::unix::fs::MetadataExt as StdMetadataExt;

    StdMetadataExt::dev(before) == CapMetadataExt::dev(opened)
        && StdMetadataExt::ino(before) == CapMetadataExt::ino(opened)
}

#[cfg(windows)]
fn directory_identity_matches(
    before: &fs::File,
    opened: &cap_std::fs::Dir,
) -> Result<bool, String> {
    use std::os::windows::io::AsRawHandle;

    Ok(windows_file_identity(before.as_raw_handle())?
        == windows_file_identity(opened.as_raw_handle())?)
}

#[cfg(windows)]
fn windows_file_identity(handle: std::os::windows::io::RawHandle) -> Result<(u32, u64), String> {
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
        return Err(format!(
            "无法确认目录身份：{}",
            std::io::Error::last_os_error()
        ));
    }
    let file_index = ((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64;
    Ok((information.dwVolumeSerialNumber, file_index))
}

fn temporary_skill_name(skill_name: &str) -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| format!("无法生成 Skill 临时目录名：{error}"))?;
    let random = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!(".{skill_name}.{random}.tmp"))
}

fn parse_skill_metadata(text: &str) -> Result<SkillMetadata, String> {
    let mut all_lines = text.lines();
    if all_lines.next().map(str::trim) != Some("---") {
        return Err("SKILL.md 必须以 YAML frontmatter 开头".into());
    }
    let mut frontmatter = Vec::new();
    let mut closed = false;
    for line in all_lines {
        if line.trim() == "---" {
            closed = true;
            break;
        }
        frontmatter.push(line);
    }
    if !closed {
        return Err("SKILL.md 的 YAML frontmatter 缺少结束标记".into());
    }

    #[derive(serde::Deserialize)]
    struct Frontmatter {
        name: String,
        description: String,
        #[serde(default)]
        metadata: std::collections::HashMap<String, String>,
    }
    let parsed: Frontmatter = serde_yaml::from_str(&frontmatter.join("\n"))
        .map_err(|error| format!("无效的 YAML frontmatter：{error}"))?;
    let name = parsed.name.trim().to_string();
    let description = parsed.description.trim().to_string();
    let display_name = parsed
        .metadata
        .get("floatnote-display-name")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or(&name)
        .to_string();
    let display_description = parsed
        .metadata
        .get("floatnote-short-description")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or(&description)
        .to_string();
    Ok(SkillMetadata {
        name: (!name.is_empty())
            .then_some(name)
            .ok_or("Skill 缺少 name")?,
        description: (!description.is_empty())
            .then_some(description)
            .ok_or("Skill 缺少 description")?,
        display_name,
        display_description,
    })
}

fn import_skill_dir(
    source: &Path,
    destination_root: &Path,
    reserved: &[String],
) -> Result<String, String> {
    let source = open_bound_dir(source, "所选 Skill 目录")?;
    let metadata = validate_open_skill_dir(&source)?;
    if reserved.iter().any(|name| name == &metadata.name) {
        return Err(format!("同名 Skill 已存在：{}", metadata.name));
    }
    fs::create_dir_all(destination_root).map_err(|error| error.to_string())?;
    let destination_root = open_bound_dir(destination_root, "Skills 目录")?;
    if destination_root.symlink_metadata(&metadata.name).is_ok() {
        return Err(format!("同名 Skill 已存在：{}", metadata.name));
    }
    let temporary_name = temporary_skill_name(&metadata.name)?;
    destination_root
        .create_dir(&temporary_name)
        .map_err(|error| format!("无法创建 Skill 临时目录：{error}"))?;
    let result = (|| {
        let temporary = destination_root
            .open_dir(&temporary_name)
            .map_err(|error| format!("无法打开 Skill 临时目录：{error}"))?;
        copy_skill_dir_inner(&source, &temporary)?;
        destination_root
            .rename(&temporary_name, &destination_root, &metadata.name)
            .map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = destination_root.remove_dir_all(&temporary_name);
    }
    result.map(|_| metadata.name)
}

#[cfg(test)]
mod skill_catalog_tests {
    use super::*;

    fn write_skill(root: &Path, folder: &str, name: &str, description: &str) -> PathBuf {
        let dir = root.join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\n"),
        )
        .unwrap();
        dir
    }

    #[test]
    fn catalog_combines_builtin_and_imported_skills_without_model_access() {
        let dir = crate::testutil::tempdir();
        let builtin = dir.path().join("builtin");
        let imported = dir.path().join("imported");
        write_skill(&builtin, "organize", "organize", "组织文章");
        write_skill(&imported, "my-skill", "my-skill", "自定义 Skill");

        let skills = catalog_skills(&[builtin], Some(&imported), &["my-skill".into()]).unwrap();

        assert_eq!(skills.len(), 2);
        assert_eq!(skills[0].source, "builtin");
        assert!(skills[0].enabled);
        assert_eq!(skills[1].source, "imported");
        assert!(!skills[1].enabled);
    }

    #[test]
    fn import_requires_a_directory_with_an_exact_skill_filename() {
        let dir = crate::testutil::tempdir();
        let source = dir.path().join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("skill.md"), "name: wrong\ndescription: wrong").unwrap();
        assert!(validate_skill_dir(&source)
            .unwrap_err()
            .contains("SKILL.md"));
        assert!(validate_skill_dir(&source.join("skill.md"))
            .unwrap_err()
            .contains("目录"));
    }

    #[cfg(unix)]
    #[test]
    fn import_rejects_symbolic_links_and_leaves_no_destination() {
        use std::os::unix::fs::symlink;
        let dir = crate::testutil::tempdir();
        let source = write_skill(dir.path(), "source", "linked", "含链接");
        fs::write(dir.path().join("outside.txt"), "secret").unwrap();
        symlink(dir.path().join("outside.txt"), source.join("linked.txt")).unwrap();
        let destination_root = dir.path().join("installed");

        let error = import_skill_dir(&source, &destination_root, &[]).unwrap_err();

        assert!(error.contains("符号链接"));
        assert!(!destination_root.join("linked").exists());
    }

    #[test]
    fn metadata_requires_frontmatter_and_decodes_block_descriptions() {
        let dir = crate::testutil::tempdir();
        let source = dir.path().join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("SKILL.md"),
            "---\nname: folded\ndescription: >\n  first line\n  second line\n---\n# Body\n",
        )
        .unwrap();
        assert_eq!(
            validate_skill_dir(&source).unwrap().description,
            "first line second line"
        );
        fs::write(
            source.join("SKILL.md"),
            "name: not-frontmatter\ndescription: invalid\n",
        )
        .unwrap();
        assert!(validate_skill_dir(&source)
            .unwrap_err()
            .contains("frontmatter"));
    }

    #[test]
    fn catalog_exposes_floatnote_display_metadata_with_fallbacks() {
        let dir = crate::testutil::tempdir();
        let builtin = dir.path().join("builtin");
        let localized = builtin.join("organize");
        fs::create_dir_all(&localized).unwrap();
        fs::write(
            localized.join("SKILL.md"),
            "---\nname: organize\ndescription: Organize source material.\nmetadata:\n  floatnote-display-name: 整理材料\n  floatnote-short-description: 按主题整理采集内容\n---\n",
        )
        .unwrap();
        write_skill(&builtin, "write", "write", "Plain description");

        let skills = catalog_skills(&[builtin], None, &[]).unwrap();

        assert_eq!(skills[0].name, "organize");
        assert_eq!(skills[0].display_name, "整理材料");
        assert_eq!(skills[0].display_description, "按主题整理采集内容");
        assert_eq!(skills[1].display_name, "write");
        assert_eq!(skills[1].display_description, "Plain description");
    }

    #[test]
    fn bundled_catalog_contains_the_four_localized_skills() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("skills");

        let skills = catalog_skills(&[root], None, &[]).unwrap();
        let organize = skills
            .iter()
            .find(|skill| skill.name == "organize")
            .unwrap();
        assert_eq!(organize.display_description, "理清主题和脉络");
        let plan_actions = skills
            .iter()
            .find(|skill| skill.name == "plan-actions")
            .unwrap();
        assert_eq!(
            plan_actions.display_description,
            "理清方向，定下眼前真正能做的事"
        );
        let write = skills.iter().find(|skill| skill.name == "write").unwrap();
        assert_eq!(
            write.display_description,
            "边说边想，把真正属于你的内容写成文章"
        );
        let summaries = skills
            .into_iter()
            .map(|skill| (skill.name, skill.display_name))
            .collect::<Vec<_>>();

        assert_eq!(
            summaries,
            vec![
                ("organize".into(), "梳理材料".into()),
                ("plan-actions".into(), "下一步".into()),
                ("tutor".into(), "问到真懂".into()),
                ("write".into(), "写出所想".into()),
            ]
        );
    }

    #[test]
    fn catalog_ignores_retired_builtin_skill_directories() {
        let dir = crate::testutil::tempdir();
        let builtin = dir.path().join("builtin");
        write_skill(&builtin, "organize", "organize", "Current skill");
        write_skill(
            &builtin,
            "socratic-review",
            "socratic-review",
            "Retired skill",
        );

        let skills = catalog_skills(&[builtin], None, &[]).unwrap();

        assert_eq!(
            skills
                .into_iter()
                .map(|skill| skill.name)
                .collect::<Vec<_>>(),
            vec!["organize"]
        );
    }

    #[test]
    fn damaged_builtin_catalog_is_reported_instead_of_silently_dropped() {
        let dir = crate::testutil::tempdir();
        let builtin = dir.path().join("builtin");
        fs::create_dir_all(builtin.join("broken")).unwrap();
        let error = catalog_skills(&[builtin], None, &[]).unwrap_err();
        assert!(error.contains("SKILL.md"));
    }
}

#[tauri::command]
pub fn resolve_permission(
    state: State<AppState>,
    request_id: String,
    decision: String,
    write_mode: String,
) -> Result<(), String> {
    let mutation = state.mutations.lock().unwrap().pending(&request_id);
    if let Some(mutation) = mutation {
        if decision != "allow" {
            state.mutations.lock().unwrap().deny(&request_id);
            if let Some(sender) = state
                .pending_permissions
                .lock()
                .unwrap()
                .remove(&request_id)
            {
                let _ = sender.send(Err("用户拒绝了此操作".into()));
            }
            return Ok(());
        }
        let selected_mode = match write_mode.as_str() {
            "direct" => WriteMode::Direct,
            "snapshot"
                if mutation.can_snapshot
                    && mutation.operation == MutationOperation::Rewrite
                    && !mutation.create_only =>
            {
                WriteMode::Snapshot
            }
            "snapshot" => {
                state.mutations.lock().unwrap().deny(&request_id);
                let message = "该操作不允许保存快照".to_string();
                if let Some(sender) = state
                    .pending_permissions
                    .lock()
                    .unwrap()
                    .remove(&request_id)
                {
                    let _ = sender.send(Err(message.clone()));
                }
                return Err(message);
            }
            _ => {
                state.mutations.lock().unwrap().deny(&request_id);
                let message = "不支持的写入模式".to_string();
                if let Some(sender) = state
                    .pending_permissions
                    .lock()
                    .unwrap()
                    .remove(&request_id)
                {
                    let _ = sender.send(Err(message.clone()));
                }
                return Err(message);
            }
        };
        let lease = match state.mutations.lock().unwrap().approve(
            &request_id,
            &write_mode,
            std::time::Instant::now(),
        ) {
            Ok(lease) => lease,
            Err(message) => {
                if let Some(sender) = state
                    .pending_permissions
                    .lock()
                    .unwrap()
                    .remove(&request_id)
                {
                    let _ = sender.send(Err(message.clone()));
                }
                return Err(message);
            }
        };
        if let Some(sender) = state
            .pending_permissions
            .lock()
            .unwrap()
            .remove(&request_id)
        {
            let mode = match selected_mode {
                WriteMode::Direct => "direct",
                WriteMode::Snapshot => "snapshot",
            };
            let _ = sender.send(Ok((lease, mode.into())));
        }
        return Ok(());
    }

    Ok(())
}
