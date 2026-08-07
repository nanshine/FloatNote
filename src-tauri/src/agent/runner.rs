//! sidecar 进程生命周期：spawn、stdout 读循环、消息分派、退出处理。
//!
//! 拉起 Node sidecar 子进程，单独线程按行读 stdout，把流式事件经 Tauri
//! `agent://event` 广播给所有助手视图；虚拟工作区消息分派到 `workspace`。

use crate::state::AppState;
#[cfg(debug_assertions)]
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
#[cfg(debug_assertions)]
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use tauri::{AppHandle, Emitter, Manager};
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

use super::protocol::{HostToSidecar, SidecarToHost};
use super::workspace::{
    handle_commit_mutation, handle_review_mutation, handle_workspace_list, handle_workspace_read,
};

type OneShotPending = std::sync::Mutex<
    std::collections::HashMap<String, tokio::sync::oneshot::Sender<Result<String, String>>>,
>;

pub(crate) fn resolve_one_shot_pending(
    pending: &OneShotPending,
    call_id: &str,
    result: Option<String>,
    error: Option<String>,
) -> bool {
    let Some(sender) = pending.lock().unwrap().remove(call_id) else {
        return false;
    };
    let outcome = match (result.filter(|value| !value.trim().is_empty()), error) {
        (Some(value), _) => Ok(value),
        (_, Some(message)) => Err(message),
        _ => Err("翻译结果为空".into()),
    };
    let _ = sender.send(outcome);
    true
}

pub(crate) fn expire_one_shot_pending(pending: &OneShotPending, call_id: &str) -> bool {
    pending.lock().unwrap().remove(call_id).is_some()
}

fn fail_all_one_shots(pending: &OneShotPending, message: &str) {
    for (_, sender) in pending.lock().unwrap().drain() {
        let _ = sender.send(Err(message.into()));
    }
}

/// 活的 sidecar 子进程句柄：持有子进程与其 stdin。
pub struct AgentHandle {
    #[cfg(debug_assertions)]
    #[allow(dead_code)]
    child: Child,
    #[cfg(debug_assertions)]
    stdin: ChildStdin,
    #[cfg(not(debug_assertions))]
    child: tauri_plugin_shell::process::CommandChild,
}

impl AgentHandle {
    /// 经 stdin 发一条协议命令（行分隔 JSON）。
    pub fn send(&mut self, msg: &HostToSidecar) -> std::io::Result<()> {
        let mut line = serde_json::to_string(msg)?;
        line.push('\n');
        #[cfg(debug_assertions)]
        {
            self.stdin.write_all(line.as_bytes())?;
            return self.stdin.flush();
        }
        #[cfg(not(debug_assertions))]
        self.child
            .write(line.as_bytes())
            .map_err(std::io::Error::other)
    }
}

/// 开发期 sidecar 启动命令。
/// 优先直接定位 tsx 的 JS CLI 入口（sidecar 本地或 npm workspaces hoist 到仓库根），
/// 用 node 执行，避免依赖 .bin shim 或全局 `npx`（Windows 下 npx 只有 .cmd/.ps1，
/// `std::process::Command` 无法直接执行），并提升从 Finder/Dock 启动时的可靠性。
#[cfg(debug_assertions)]
fn sidecar_command() -> Command {
    // CARGO_MANIFEST_DIR = <repo>/src-tauri，其父目录即仓库根。
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| Path::new(".").to_path_buf());
    let sidecar_dir = repo_root.join("sidecar");
    let main_ts = sidecar_dir.join("src").join("main.ts");

    // tsx 可能安装在 sidecar 本地，也可能被 npm workspaces hoist 到仓库根，
    // 因此直接定位 tsx 的 JS CLI 入口（dist/cli.mjs）并用 node 执行。
    let tsx_cli = [sidecar_dir.join("node_modules"), repo_root.join("node_modules")]
        .into_iter()
        .map(|base| base.join("tsx").join("dist").join("cli.mjs"))
        .find(|path| path.is_file());

    let mut cmd = match tsx_cli {
        Some(cli) => {
            let mut c = Command::new("node");
            c.arg(cli);
            c
        }
        None => {
            // 兜底：npx（macOS/Linux 下可通过 PATH 解析）。
            let mut c = Command::new("npx");
            c.arg("tsx");
            c
        }
    };
    cmd.arg(&main_ts)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .current_dir(&sidecar_dir);

    // macOS: Tauri 从 Finder 启动时 PATH 不含用户 shell 配置中的 node 路径，
    // 补充常见 Node.js 安装位置以确保 tsx 脚本内的 node 能被找到。
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let existing = std::env::var("PATH").unwrap_or_default();
        let mut extras: Vec<String> = vec![
            "/usr/local/bin".to_string(),
            "/opt/homebrew/bin".to_string(),
        ];
        // 扫描 nvm 安装目录，将所有已安装版本的 bin 加入 PATH。
        let nvm_dir = PathBuf::from(&home).join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
            for entry in entries.flatten() {
                let bin = entry.path().join("bin");
                if bin.is_dir() {
                    extras.push(bin.to_string_lossy().into_owned());
                }
            }
        }
        extras.push(existing);
        cmd.env("PATH", extras.join(":"));
    }

    cmd
}

/// 拉起 sidecar 子进程并起读线程；失败返回 io::Error（启动期仅打印不阻断）。
#[cfg(debug_assertions)]
pub fn spawn(app: &AppHandle) -> std::io::Result<AgentHandle> {
    let mut child = sidecar_command().spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("sidecar stdout unavailable"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| std::io::Error::other("sidecar stdin unavailable"))?;

    let app = app.clone();
    std::thread::spawn(move || read_loop(app, stdout));

    Ok(AgentHandle { child, stdin })
}

/// 读 sidecar stdout：按行解析协议并分派；EOF（崩溃/退出）后标记不可用。
#[cfg(debug_assertions)]
fn read_loop(app: AppHandle, stdout: ChildStdout) {
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("agent: stdout read error: {error}");
                break;
            }
        };
        handle_sidecar_line(&app, &line);
    }
    on_sidecar_exit(&app);
}

/// Release mode uses Tauri's external binary support. The bundled Node runtime
/// receives the bundled, self-contained ESM agent resource as its first arg;
/// neither the user's PATH nor the source checkout is involved.
#[cfg(not(debug_assertions))]
pub fn spawn(app: &AppHandle) -> std::io::Result<AgentHandle> {
    let resource = app
        .path()
        .resource_dir()
        .map_err(std::io::Error::other)?
        .join("sidecar")
        .join("floatnote-agent.mjs");
    if !resource.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("bundled sidecar resource missing: {}", resource.display()),
        ));
    }
    let command = app
        .shell()
        .sidecar("floatnote-node")
        .map_err(std::io::Error::other)?
        .arg(resource.to_string_lossy().into_owned());
    let (mut events, child) = command.spawn().map_err(std::io::Error::other)?;
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut buffer = String::new();
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    buffer.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(newline) = buffer.find('\n') {
                        let line = buffer[..newline].to_string();
                        buffer.drain(..=newline);
                        handle_sidecar_line(&app_handle, &line);
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    eprintln!("agent: {}", String::from_utf8_lossy(&bytes).trim());
                }
                _ => {}
            }
        }
        if !buffer.trim().is_empty() {
            handle_sidecar_line(&app_handle, &buffer);
        }
        on_sidecar_exit(&app_handle);
    });
    Ok(AgentHandle { child })
}

fn handle_sidecar_line(app: &AppHandle, line: &str) {
    if line.trim().is_empty() {
        return;
    }
    match serde_json::from_str::<SidecarToHost>(line) {
        Ok(msg) => handle_sidecar_msg(app, msg),
        Err(error) => eprintln!("agent: bad protocol line ({error}): {line}"),
    }
}

/// 分派单条 sidecar 消息。
fn handle_sidecar_msg(app: &AppHandle, msg: SidecarToHost) {
    match msg {
        SidecarToHost::OneShotResult {
            call_id,
            result,
            error,
        } => {
            if let Some(state) = app.try_state::<AppState>() {
                resolve_one_shot_pending(&state.pending_one_shots, &call_id, result, error);
            }
        }
        SidecarToHost::NewSessionResult { call_id, ok, error } => {
            if let Some(state) = app.try_state::<AppState>() {
                if let Some(sender) = state
                    .pending_agent_sessions
                    .lock()
                    .unwrap()
                    .remove(&call_id)
                {
                    let result = if ok {
                        Ok(())
                    } else {
                        Err(error.unwrap_or_else(|| "创建 AI 会话失败".into()))
                    };
                    let _ = sender.send(result);
                }
            }
        }
        SidecarToHost::Ready => {
            if let Some(state) = app.try_state::<AppState>() {
                *state.agent_ready.lock().unwrap() = true;
                // 无条件下发 skill 目录（与 AI 凭据正交：picker 可在配置 AI 前拉取列表）。
                let skill_paths = skill_paths_for_app(app);
                {
                    let mut guard = state.agent.lock().unwrap();
                    if let Some(agent) = guard.as_mut() {
                        if !skill_paths.is_empty() {
                            let disabled_skill_names =
                                state.config.lock().unwrap().disabled_skills.clone();
                            let _ = agent.send(&HostToSidecar::SetSkillPaths {
                                skill_paths,
                                disabled_skill_names,
                            });
                        }
                    }
                }
                // 从持久化配置自动恢复 AI 助手。
                let config = state.config.lock().unwrap().clone();
                let mut sent_configuration = false;
                if let Some(provider) = config.ai_settings.active_provider_id {
                    if let Some(profile) = config
                        .ai_settings
                        .providers
                        .get(&provider)
                        .filter(|profile| profile.is_configured())
                    {
                        let mut guard = state.agent.lock().unwrap();
                        if let Some(agent) = guard.as_mut() {
                            let _ = agent.send(&HostToSidecar::Configure {
                                call_id: "startup-config".into(),
                                provider,
                                model: profile.model.clone(),
                                api_key: Some(profile.api_key.clone()),
                                base_url: profile.base_url.clone(),
                            });
                            sent_configuration = true;
                        }
                    }
                }
                if !sent_configuration {
                    let mut guard = state.agent.lock().unwrap();
                    if let Some(agent) = guard.as_mut() {
                        let _ = agent.send(&HostToSidecar::ConfigurationReady);
                    }
                }
            }
            let _ = app.emit("agent://event", &SidecarToHost::Ready);
        }
        SidecarToHost::SessionOpened {
            conversation_id,
            session_file,
            messages,
        } => {
            sync_session_history(app, &conversation_id, &session_file, &messages);
            let _ = app.emit(
                "agent://event",
                &SidecarToHost::SessionOpened {
                    conversation_id,
                    session_file,
                    messages,
                },
            );
        }
        SidecarToHost::SessionSynced {
            conversation_id,
            session_file,
            messages,
        } => {
            sync_session_history(app, &conversation_id, &session_file, &messages);
            let _ = app.emit(
                "agent://event",
                &SidecarToHost::SessionSynced {
                    conversation_id,
                    session_file,
                    messages,
                },
            );
        }
        SidecarToHost::RewindResult { call_id, ok, error } => {
            if let Some(state) = app.try_state::<AppState>() {
                if let Some(sender) = state.pending_agent_rewinds.lock().unwrap().remove(&call_id) {
                    let result = if ok {
                        Ok(())
                    } else {
                        Err(error.unwrap_or_else(|| "对话回退失败".into()))
                    };
                    let _ = sender.send(result);
                }
            }
        }
        SidecarToHost::WorkspaceList { call_id, .. } => handle_workspace_list(app, call_id),
        SidecarToHost::WorkspaceRead { call_id, path, .. } => {
            handle_workspace_read(app, call_id, path)
        }
        SidecarToHost::ReviewMutation {
            call_id,
            conversation_id,
            tool_call_id,
            tool_name,
            operation,
            path,
            old_content,
            new_content,
            create_only,
            preview,
        } => handle_review_mutation(
            app,
            call_id,
            conversation_id,
            tool_call_id,
            tool_name,
            operation,
            path,
            old_content,
            new_content,
            create_only,
            preview,
        ),
        SidecarToHost::CommitMutation {
            call_id,
            conversation_id,
            tool_call_id,
            lease,
        } => handle_commit_mutation(app, call_id, conversation_id, tool_call_id, lease),
        SidecarToHost::ConfigureResult { call_id, ok, error } => {
            if let Some(state) = app.try_state::<AppState>() {
                if let Some(sender) = state.pending_agent_configs.lock().unwrap().remove(&call_id) {
                    let result = if ok {
                        Ok(())
                    } else {
                        Err(error.unwrap_or_else(|| "AI 提供商配置失败".into()))
                    };
                    let _ = sender.send(result);
                }
            }
        }
        SidecarToHost::SkillsList { call_id, skills } => {
            // 同步一次性请求-响应：取出 host 侧 oneshot sender 解除等待。
            if let Some(state) = app.try_state::<AppState>() {
                if let Some(sender) = state.pending_skill_lists.lock().unwrap().remove(&call_id) {
                    let _ = sender.send(skills);
                }
            }
        }
        SidecarToHost::Title {
            conversation_id,
            title,
        } => {
            let persisted = crate::chat_history::ChatHistoryStore::default_for_user()
                .ok()
                .and_then(|store| store.update_generated_title(&conversation_id, &title).ok())
                .flatten()
                .is_some_and(|entry| {
                    entry.title_state == crate::chat_history::ChatTitleState::Generated
                        && entry.title == title
                });
            if persisted {
                let _ = crate::tray::refresh_menu(app);
                let _ = app.emit("chat://history-changed", ());
                let _ = app.emit(
                    "agent://event",
                    &SidecarToHost::Title {
                        conversation_id,
                        title,
                    },
                );
            }
        }
        other => {
            // Delta / Tool / Done / Error 直接转发给前端。
            let _ = app.emit("agent://event", &other);
        }
    }
}

fn sync_session_history(
    app: &AppHandle,
    conversation_id: &str,
    session_file: &str,
    messages: &[super::protocol::ChatDisplayMessage],
) {
    let Ok(store) = crate::chat_history::ChatHistoryStore::default_for_user() else {
        return;
    };
    let model = app
        .try_state::<AppState>()
        .and_then(|state| {
            let config = state.config.lock().unwrap();
            let provider = config.ai_settings.active_provider_id?;
            Some(config.ai_settings.providers.get(&provider)?.model.clone())
        })
        .unwrap_or_default();
    let saved_messages = messages
        .iter()
        .filter_map(|message| match message {
            super::protocol::ChatDisplayMessage::User {
                text, timestamp, ..
            } => Some(crate::chat_history::ChatHistoryMessage {
                role: "user".into(),
                text: text.clone(),
                timestamp: *timestamp,
            }),
            super::protocol::ChatDisplayMessage::Assistant {
                blocks, timestamp, ..
            } => {
                let text = blocks
                    .iter()
                    .filter_map(|block| match block {
                        super::protocol::ChatDisplayBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<String>();
                (!text.is_empty()).then_some(crate::chat_history::ChatHistoryMessage {
                    role: "assistant".into(),
                    text,
                    timestamp: *timestamp,
                })
            }
            _ => None,
        })
        .collect();
    let tools = messages
        .iter()
        .flat_map(|message| match message {
            super::protocol::ChatDisplayMessage::Assistant {
                blocks, timestamp, ..
            } => blocks
                .iter()
                .filter_map(|block| match block {
                    super::protocol::ChatDisplayBlock::Tool { label, status, .. } => {
                        Some(crate::chat_history::ChatToolSummary {
                            name: label.clone(),
                            status: match status {
                                super::protocol::ToolDisplayStatus::Succeeded => "completed",
                                super::protocol::ToolDisplayStatus::Failed => "failed",
                                super::protocol::ToolDisplayStatus::Incomplete => "incomplete",
                            }
                            .into(),
                            timestamp: *timestamp,
                        })
                    }
                    _ => None,
                })
                .collect::<Vec<_>>(),
            _ => Vec::new(),
        })
        .collect();
    let _ = store.update_session_snapshot(
        conversation_id,
        session_file.to_string(),
        model,
        saved_messages,
        tools,
    );
}

/// sidecar 退出/崩溃：标记不可用、清空句柄、发错误事件，绝不 panic。
fn on_sidecar_exit(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        *state.agent_ready.lock().unwrap() = false;
        *state.agent.lock().unwrap() = None;
        state.mutations.lock().unwrap().clear();
        fail_all_one_shots(&state.pending_one_shots, "AI 助手暂时不可用，请稍后重试");
        for (_, sender) in state.pending_agent_sessions.lock().unwrap().drain() {
            let _ = sender.send(Err("AI 助手暂时不可用，请稍后重试".into()));
        }
    }
    let _ = app.emit(
        "agent://event",
        &SidecarToHost::Error {
            request_id: None,
            conversation_id: None,
            message: "助手已断开，请点击重连".to_string(),
        },
    );
}

/// 解析 skill 目录列表，下发给 sidecar。
///
/// - bundled：打包后走 Tauri 资源目录 `resource_dir()/skills`。
/// - dev 回退：`tauri dev` 下资源目录不含源码 `resources/skills`，回退到
///   `CARGO_MANIFEST_DIR/resources/skills`（编译期固化，仅 debug 构建有效）。
/// - 用户全局：`~/.floatnote/skills`（用户自建，复用 chat_history 的 home 解析）。
///
/// 仅返回已存在的目录；全无则空 vec（降级，不崩）。
pub const BUILTIN_SKILL_NAMES: &[&str] = &["organize", "plan-actions", "tutor", "write"];

pub(crate) fn current_builtin_skill_dirs(root: &Path) -> Vec<PathBuf> {
    BUILTIN_SKILL_NAMES
        .iter()
        .map(|name| root.join(name))
        .filter(|path| path.join("SKILL.md").is_file())
        .collect()
}

pub fn skill_paths_for_app(app: &AppHandle) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();

    let bundled = app.path().resource_dir().ok().map(|d| d.join("skills"));
    #[cfg(debug_assertions)]
    let builtin_root = {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("skills");
        if dev.is_dir() {
            Some(dev)
        } else {
            bundled
        }
    };
    #[cfg(not(debug_assertions))]
    let builtin_root = bundled;

    if let Some(root) = builtin_root.filter(|path| path.is_dir()) {
        paths.extend(
            current_builtin_skill_dirs(&root)
                .into_iter()
                .map(|path| path.to_string_lossy().into_owned()),
        );
    }

    if let Some(floatnote) = crate::paths::floatnote_home() {
        let user_skills = floatnote.join("skills");
        if user_skills.is_dir() {
            paths.push(user_skills.to_string_lossy().into_owned());
        }
    }

    paths
}

#[cfg(test)]
mod one_shot_pending_tests {
    use super::*;

    fn pending() -> OneShotPending {
        std::sync::Mutex::new(std::collections::HashMap::new())
    }

    #[test]
    fn success_and_error_resolve_and_remove_waiters() {
        let pending = pending();
        let (success_tx, mut success_rx) = tokio::sync::oneshot::channel();
        pending.lock().unwrap().insert("ok".into(), success_tx);
        assert!(resolve_one_shot_pending(
            &pending,
            "ok",
            Some("译文".into()),
            None
        ));
        assert_eq!(success_rx.try_recv().unwrap(), Ok("译文".into()));

        let (error_tx, mut error_rx) = tokio::sync::oneshot::channel();
        pending.lock().unwrap().insert("err".into(), error_tx);
        assert!(resolve_one_shot_pending(
            &pending,
            "err",
            None,
            Some("失败".into())
        ));
        assert_eq!(error_rx.try_recv().unwrap(), Err("失败".into()));
        assert!(pending.lock().unwrap().is_empty());
    }

    #[test]
    fn timeout_expiry_drops_the_waiter() {
        let pending = pending();
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        pending.lock().unwrap().insert("late".into(), tx);
        assert!(expire_one_shot_pending(&pending, "late"));
        assert!(matches!(
            rx.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Closed)
        ));
        assert!(pending.lock().unwrap().is_empty());
    }

    #[test]
    fn disconnect_fails_and_drains_all_waiters() {
        let pending = pending();
        let (first_tx, mut first_rx) = tokio::sync::oneshot::channel();
        let (second_tx, mut second_rx) = tokio::sync::oneshot::channel();
        pending.lock().unwrap().insert("a".into(), first_tx);
        pending.lock().unwrap().insert("b".into(), second_tx);
        fail_all_one_shots(&pending, "断开");
        assert_eq!(first_rx.try_recv().unwrap(), Err("断开".into()));
        assert_eq!(second_rx.try_recv().unwrap(), Err("断开".into()));
        assert!(pending.lock().unwrap().is_empty());
    }

    #[test]
    fn sidecar_paths_include_only_current_builtin_skills() {
        let dir = crate::testutil::tempdir();
        let root = dir.path().join("skills");
        for name in ["organize", "socratic-review"] {
            let skill = root.join(name);
            std::fs::create_dir_all(&skill).unwrap();
            std::fs::write(
                skill.join("SKILL.md"),
                "---\nname: sample\ndescription: sample\n---\n",
            )
            .unwrap();
        }

        let paths = current_builtin_skill_dirs(&root);

        assert_eq!(paths, vec![root.join("organize")]);
    }
}
