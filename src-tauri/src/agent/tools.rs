use super::rig_adapter::{
    agent::{
        AgentHook, HookContext, ObservationAction, StepEventKind, ToolCall, ToolCallAction,
        ToolCallDelta, ToolResultAction, ToolResultEvent,
    },
    completion::Message,
    message::{ToolResultContent, UserContent},
    tool::{DynamicTool, ToolExecutionError, ToolOutput},
};
use super::{
    active_project_dir, add_annotation, apply_changes, decode_inbox, encode_inbox,
    exact_text_range, free_colors, list_project_space, locate_changes, map_annotations,
    map_quote_sources, remove_annotation, review_and_commit, tool_presentation, EditPreview,
    EditPreviewDetail, MutationDraft, MutationOperation, SkillSnapshot,
};
use crate::state::AppState;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager};
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Default)]
pub(crate) struct RunToolState {
    current: Arc<Mutex<Option<(String, String, Value)>>>,
    output_tokens: Arc<AtomicUsize>,
    failures: Arc<Mutex<HashMap<String, String>>>,
}

impl RunToolState {
    fn set(&self, id: String, name: String, args: Value) {
        *self.current.lock().unwrap() = Some((id, name, args));
    }
    fn id(&self) -> Result<String, ToolExecutionError> {
        self.current
            .lock()
            .unwrap()
            .as_ref()
            .map(|item| item.0.clone())
            .ok_or_else(|| ToolExecutionError::other("工具调用上下文不存在"))
    }
    fn clear(&self) {
        *self.current.lock().unwrap() = None;
    }
    fn add_output_tokens(&self, count: usize) -> usize {
        self.output_tokens.fetch_add(count, Ordering::Relaxed) + count
    }

    pub fn decorate_failures(&self, messages: &mut [Message]) {
        let failures = self.failures.lock().unwrap();
        for message in messages {
            let Message::User { content } = message else {
                continue;
            };
            for item in content {
                let UserContent::ToolResult(result) = item else {
                    continue;
                };
                let Some(error) = failures.get(result.call.as_str()) else {
                    continue;
                };
                result.content = vec![ToolResultContent::text(format!("[工具错误] {error}"))];
            }
        }
    }
}

#[derive(Clone)]
pub(crate) struct ToolLifecycleHook {
    app: AppHandle,
    request_id: String,
    conversation_id: String,
    state: RunToolState,
    prepared: Arc<Mutex<HashSet<String>>>,
    skills: SkillSnapshot,
}

impl ToolLifecycleHook {
    pub fn new(
        app: AppHandle,
        request_id: String,
        conversation_id: String,
        state: RunToolState,
        skills: SkillSnapshot,
    ) -> Self {
        Self {
            app,
            request_id,
            conversation_id,
            state,
            prepared: Arc::new(Mutex::new(HashSet::new())),
            skills,
        }
    }

    fn emit(
        &self,
        call_id: &str,
        name: &str,
        args: &Value,
        phase: &str,
        error: Option<String>,
        is_error: Option<bool>,
    ) {
        let (category, label) = if name == "read" {
            args.get("path")
                .and_then(Value::as_str)
                .and_then(|path| self.skills.resource_skill_name(path))
                .map_or_else(
                    || tool_presentation(name, args),
                    |skill| (super::ToolCategory::Skill, format!("读取 Skill {skill}")),
                )
        } else {
            tool_presentation(name, args)
        };
        let _ = self.app.emit(
            "agent://event",
            super::AgentEvent::Tool {
                request_id: self.request_id.clone(),
                conversation_id: self.conversation_id.clone(),
                call_id: call_id.into(),
                name: name.into(),
                category: Some(category),
                label: Some(label),
                phase: phase.into(),
                error,
                is_error,
            },
        );
    }
}

impl AgentHook for ToolLifecycleHook {
    async fn on_tool_call_delta(
        &self,
        _ctx: &HookContext,
        event: ToolCallDelta<'_>,
    ) -> ObservationAction {
        if let Some(name) = event.tool_name {
            if self
                .prepared
                .lock()
                .unwrap()
                .insert(event.internal_call_id.into())
            {
                self.emit(
                    event.internal_call_id,
                    name,
                    &json!({}),
                    "prepare",
                    None,
                    None,
                );
            }
        }
        ObservationAction::continue_run()
    }

    async fn on_tool_call(&self, _ctx: &HookContext, event: ToolCall<'_>) -> ToolCallAction {
        let args = serde_json::from_str(event.args).unwrap_or_else(|_| json!({}));
        if self
            .prepared
            .lock()
            .unwrap()
            .insert(event.internal_call_id.into())
        {
            self.emit(
                event.internal_call_id,
                event.tool_name,
                &args,
                "prepare",
                None,
                None,
            );
        }
        self.state.set(
            event.internal_call_id.into(),
            event.tool_name.into(),
            args.clone(),
        );
        self.emit(
            event.internal_call_id,
            event.tool_name,
            &args,
            "start",
            None,
            None,
        );
        ToolCallAction::run()
    }

    async fn on_tool_result(
        &self,
        _ctx: &HookContext,
        event: ToolResultEvent<'_>,
    ) -> ToolResultAction {
        let args = serde_json::from_str(event.args).unwrap_or_else(|_| json!({}));
        let failed = event.raw_result.is_error() || event.raw_result.is_refused();
        let error = event
            .raw_result
            .error()
            .or_else(|| event.raw_result.refusal())
            .map(|error| error.message().to_string());
        if failed {
            self.state.failures.lock().unwrap().insert(
                event
                    .tool_call_id
                    .unwrap_or(event.internal_call_id)
                    .to_string(),
                error.clone().unwrap_or_else(|| "工具执行失败".into()),
            );
        }
        self.emit(
            event.internal_call_id,
            event.tool_name,
            &args,
            "end",
            error,
            Some(failed),
        );
        self.state.clear();
        let rendered = event
            .presentation
            .as_text()
            .map(str::to_string)
            .or_else(|| event.presentation.as_json().map(Value::to_string))
            .unwrap_or_default();
        if self
            .state
            .add_output_tokens(super::estimate_text_tokens(&rendered))
            > 32_000
        {
            ToolResultAction::rewrite(
                "本轮工具结果累计超过上下文预算，已省略这次结果；请缩小读取或搜索范围。",
            )
        } else {
            ToolResultAction::keep()
        }
    }

    fn observes(&self, kind: StepEventKind) -> bool {
        matches!(
            kind,
            StepEventKind::ToolCallDelta | StepEventKind::ToolCall | StepEventKind::ToolResult
        )
    }
}

#[derive(Clone)]
struct ToolDeps {
    app: AppHandle,
    conversation_id: String,
    call: RunToolState,
    skills: SkillSnapshot,
}

pub(crate) fn create_agent_tools(
    app: AppHandle,
    conversation_id: String,
    call: RunToolState,
    skills: SkillSnapshot,
) -> Vec<DynamicTool> {
    let deps = ToolDeps {
        app,
        conversation_id,
        call,
        skills,
    };
    vec![
        make_tool(
            "ls",
            "列出当前 FloatNote 项目中的笔记。",
            json!({"type":"object","properties":{"path":{"type":"string"},"limit":{"type":"integer"}}}),
            deps.clone(),
            tool_ls,
        ),
        make_tool(
            "read",
            "读取项目笔记或可用 Skill 资源。",
            json!({"type":"object","properties":{"path":{"type":"string"},"offset":{"type":"integer"},"limit":{"type":"integer"}},"required":["path"]}),
            deps.clone(),
            tool_read,
        ),
        make_tool(
            "find",
            "按 glob 查找当前项目的笔记路径。",
            json!({"type":"object","properties":{"pattern":{"type":"string"},"limit":{"type":"integer"}},"required":["pattern"]}),
            deps.clone(),
            tool_find,
        ),
        make_tool(
            "grep",
            "在当前项目笔记中搜索文本或安全正则。",
            json!({"type":"object","properties":{"pattern":{"type":"string"},"path":{"type":"string"},"glob":{"type":"string"},"ignoreCase":{"type":"boolean"},"literal":{"type":"boolean"},"context":{"type":"integer"},"limit":{"type":"integer"}},"required":["pattern"]}),
            deps.clone(),
            tool_grep,
        ),
        make_tool(
            "edit",
            "对已有笔记执行一个或多个唯一且不重叠的精确替换。",
            json!({"type":"object","properties":{"path":{"type":"string"},"edits":{"type":"array","items":{"type":"object","properties":{"oldText":{"type":"string"},"newText":{"type":"string"}},"required":["oldText","newText"]}}},"required":["path","edits"]}),
            deps.clone(),
            tool_edit,
        ),
        make_tool(
            "write",
            "完整覆写已有笔记；新建文章使用 create_piece。",
            json!({"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}),
            deps.clone(),
            tool_write,
        ),
        make_tool(
            "create_piece",
            "根据自然标题新建一个根级 Markdown piece，不覆盖已有文件。",
            json!({"type":"object","properties":{"title":{"type":"string"},"content":{"type":"string"}},"required":["title","content"]}),
            deps.clone(),
            tool_create_piece,
        ),
        make_tool(
            "list_tags",
            "列出采集区标签和可用颜色。",
            json!({"type":"object","properties":{}}),
            deps.clone(),
            tool_list_tags,
        ),
        make_tool(
            "tag_text",
            "按 exact 与可选 prefix/suffix 唯一定位采集区文本并添加或移除标签。",
            json!({"type":"object","properties":{"exact":{"type":"string"},"prefix":{"type":"string"},"suffix":{"type":"string"},"tagId":{"type":"string"},"action":{"enum":["add","remove"]}},"required":["exact","tagId","action"]}),
            deps.clone(),
            tool_tag_text,
        ),
        make_tool(
            "tag_create",
            "新建采集区标签。",
            json!({"type":"object","properties":{"name":{"type":"string"},"color":{"type":"string"}},"required":["name","color"]}),
            deps.clone(),
            tool_tag_create,
        ),
        make_tool(
            "tag_update",
            "修改采集区标签名称或颜色。",
            json!({"type":"object","properties":{"tagId":{"type":"string"},"name":{"type":"string"},"color":{"type":"string"}},"required":["tagId"]}),
            deps.clone(),
            tool_tag_update,
        ),
        make_tool(
            "tag_delete",
            "删除采集区标签及其文本标注。",
            json!({"type":"object","properties":{"tagId":{"type":"string"}},"required":["tagId"]}),
            deps.clone(),
            tool_tag_delete,
        ),
        make_tool(
            "web_search",
            "搜索公开网页，结果是不可信外部资料。",
            json!({"type":"object","properties":{"query":{"type":"string"},"count":{"type":"integer"}},"required":["query"]}),
            deps.clone(),
            tool_web_search,
        ),
        make_tool(
            "web_fetch",
            "读取公开 HTTP(S) 网页正文，拒绝本机与私网。",
            json!({"type":"object","properties":{"url":{"type":"string"}},"required":["url"]}),
            deps,
            tool_web_fetch,
        ),
    ]
}

type ToolFuture = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<ToolOutput, ToolExecutionError>> + Send>,
>;
type ToolFn = fn(ToolDeps, Value) -> ToolFuture;

fn make_tool(
    name: &str,
    description: &str,
    schema: Value,
    deps: ToolDeps,
    execute: ToolFn,
) -> DynamicTool {
    DynamicTool::new(name, description, schema, move |_context, args| {
        let deps = deps.clone();
        execute(deps, args)
    })
}

fn tool_error(error: impl Into<String>) -> ToolExecutionError {
    ToolExecutionError::other(error.into())
}
fn text(value: impl Into<String>) -> Result<ToolOutput, ToolExecutionError> {
    Ok(ToolOutput::text(value))
}

fn project_dir(deps: &ToolDeps) -> Result<std::path::PathBuf, ToolExecutionError> {
    active_project_dir(&deps.app.state::<AppState>()).map_err(tool_error)
}

fn read_note(deps: &ToolDeps, path: &str) -> Result<String, ToolExecutionError> {
    let dir = project_dir(deps)?;
    let resolved = super::resolve_project_file(&dir, path, super::ResolveMode::ReadExisting)
        .map_err(tool_error)?;
    std::fs::read_to_string(resolved.path)
        .map_err(|error| tool_error(format!("无法读取笔记：{error}")))
}

fn tool_ls(deps: ToolDeps, args: Value) -> ToolFuture {
    Box::pin(async move {
        if !matches!(
            args.get("path").and_then(Value::as_str),
            None | Some("") | Some(".")
        ) {
            return Err(tool_error("路径必须是当前项目工作区根目录"));
        }
        let limit = bounded(
            args.get("limit").and_then(Value::as_u64),
            500,
            1,
            1000,
            "limit",
        )?;
        let entries = list_project_space(&project_dir(&deps)?).map_err(tool_error)?;
        text(serde_json::to_string_pretty(&json!({"workspace":{"kind":"floatnote_project","layout":"flat"},"notes":entries.into_iter().take(limit).collect::<Vec<_>>() })).unwrap())
    })
}

fn tool_read(deps: ToolDeps, args: Value) -> ToolFuture {
    Box::pin(async move {
        let path = required_str(&args, "path")?;
        if let Some(content) = deps.skills.read_resource(path).map_err(tool_error)? {
            return text(content);
        }
        let raw = read_note(&deps, path)?;
        let offset = bounded(
            args.get("offset").and_then(Value::as_u64),
            1,
            1,
            usize::MAX,
            "offset",
        )?;
        let limit = bounded(
            args.get("limit").and_then(Value::as_u64),
            200,
            1,
            2000,
            "limit",
        )?;
        let decoded = (path == "_inbox.md").then(|| decode_inbox(&raw));
        let source = decoded
            .as_ref()
            .map_or_else(|| raw.clone(), |item| item.markdown.clone());
        let lines = source
            .as_str()
            .split('\n')
            .map(|line| line.trim_end_matches('\r'))
            .collect::<Vec<_>>();
        let start = (offset - 1).min(lines.len());
        let end = (start + limit).min(lines.len());
        let mut result = lines[start..end].join("\n");
        let mut context = Vec::new();
        if let Some(decoded) = decoded {
            if !decoded.metadata.tags.is_empty() {
                context.push(format!(
                    "Tags: {}",
                    serde_json::to_string(&decoded.metadata.tags).unwrap()
                ));
            }
            let window_from = super::utf16_len(&lines[..start].join("\n")) + usize::from(start > 0);
            let window_to = window_from + super::utf16_len(&result);
            let names = decoded
                .metadata
                .tags
                .iter()
                .map(|tag| (tag.id.as_str(), tag.name.as_str()))
                .collect::<HashMap<_, _>>();
            for annotation in decoded
                .metadata
                .annotations
                .iter()
                .filter(|item| item.from < window_to && item.to > window_from)
            {
                let text =
                    &decoded.markdown[super::byte_at_utf16(&decoded.markdown, annotation.from)
                        ..super::byte_at_utf16(&decoded.markdown, annotation.to)];
                context.push(format!(
                    "Annotation: {}「{}」 → “{}”",
                    annotation.tag_id,
                    names
                        .get(annotation.tag_id.as_str())
                        .copied()
                        .unwrap_or(&annotation.tag_id),
                    text.replace(['\r', '\n'], " ")
                ));
            }
            for source in decoded
                .metadata
                .quote_sources
                .iter()
                .filter(|item| item.card_from >= window_from && item.card_from <= window_to)
            {
                context.push(format!(
                    "Quote source at {} → {}",
                    source.card_from, source.bundle_id
                ));
            }
            if !decoded.warnings.is_empty() {
                context.push(format!("Warnings: {}", decoded.warnings.join(", ")));
            }
        }
        if !context.is_empty() {
            result.push_str("\n\n[FloatNote context · read-only]\n");
            result.push_str(&context.join("\n"));
        }
        if end < lines.len() {
            result.push_str(&format!(
                "\n[More lines available. Continue with offset={}]",
                end + 1
            ));
        }
        text(result)
    })
}

fn tool_find(deps: ToolDeps, args: Value) -> ToolFuture {
    Box::pin(async move {
        let pattern = required_str(&args, "pattern")?;
        if pattern.contains(['/', '\\']) {
            return Err(tool_error("当前工作区不支持子目录 glob"));
        }
        let limit = bounded(
            args.get("limit").and_then(Value::as_u64),
            1000,
            1,
            1000,
            "limit",
        )?;
        let regex = glob_regex(pattern).map_err(tool_error)?;
        let entries = list_project_space(&project_dir(&deps)?).map_err(tool_error)?;
        text(
            entries
                .into_iter()
                .map(|entry| entry.path)
                .filter(|path| regex.is_match(path))
                .take(limit)
                .collect::<Vec<_>>()
                .join("\n"),
        )
    })
}

fn tool_grep(deps: ToolDeps, args: Value) -> ToolFuture {
    Box::pin(async move {
        let pattern = required_str(&args, "pattern")?;
        if pattern.chars().count() > 256 {
            return Err(tool_error("pattern 不能超过 256 个字符"));
        }
        let literal = args
            .get("literal")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let ignore_case = args
            .get("ignoreCase")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let context = bounded(
            args.get("context").and_then(Value::as_u64),
            0,
            0,
            10,
            "context",
        )?;
        let limit = bounded(
            args.get("limit").and_then(Value::as_u64),
            100,
            1,
            1000,
            "limit",
        )?;
        let matcher = if literal {
            None
        } else {
            Some(
                regex::RegexBuilder::new(pattern)
                    .case_insensitive(ignore_case)
                    .build()
                    .map_err(|e| tool_error(format!("正则表达式无效：{e}")))?,
            )
        };
        let dir = project_dir(&deps)?;
        let entries = list_project_space(&dir).map_err(tool_error)?;
        let selected = args.get("path").and_then(Value::as_str);
        let glob = args
            .get("glob")
            .and_then(Value::as_str)
            .map(glob_regex)
            .transpose()
            .map_err(tool_error)?;
        let mut output = Vec::new();
        let mut count = 0;
        'docs: for entry in entries {
            if selected.is_some_and(|value| value != "." && value != entry.path)
                || glob.as_ref().is_some_and(|g| !g.is_match(&entry.path))
            {
                continue;
            }
            let raw = std::fs::read_to_string(dir.join(&entry.path))
                .map_err(|e| tool_error(e.to_string()))?;
            let content = if entry.path == "_inbox.md" {
                decode_inbox(&raw).markdown
            } else {
                raw
            };
            let lines = content.lines().collect::<Vec<_>>();
            for (index, line) in lines.iter().enumerate() {
                let matched = matcher.as_ref().map_or_else(
                    || {
                        if ignore_case {
                            line.to_lowercase().contains(&pattern.to_lowercase())
                        } else {
                            line.contains(pattern)
                        }
                    },
                    |regex| regex.is_match(line),
                );
                if !matched {
                    continue;
                }
                if count >= limit {
                    output.push(format!("[Results truncated at {limit} matches]"));
                    break 'docs;
                }
                let from = index.saturating_sub(context);
                let to = (index + context + 1).min(lines.len());
                for (row, line) in lines.iter().enumerate().take(to).skip(from) {
                    output.push(if row == index {
                        format!(
                            "{}:{}:{}",
                            entry.path,
                            row + 1,
                            line.chars().take(500).collect::<String>()
                        )
                    } else {
                        format!(
                            "{}-{}-{}",
                            entry.path,
                            row + 1,
                            line.chars().take(500).collect::<String>()
                        )
                    });
                }
                count += 1;
            }
        }
        text(output.join("\n"))
    })
}

fn tool_edit(deps: ToolDeps, args: Value) -> ToolFuture {
    Box::pin(async move {
        let path = required_str(&args, "path")?.to_string();
        let edits = args
            .get("edits")
            .and_then(Value::as_array)
            .ok_or_else(|| tool_error("edits 必须是数组"))?
            .iter()
            .map(|edit| {
                Ok((
                    required_str(edit, "oldText")?.to_string(),
                    required_str(edit, "newText")?.to_string(),
                ))
            })
            .collect::<Result<Vec<_>, ToolExecutionError>>()?;
        let old_content = read_note(&deps, &path)?;
        let decoded = (path == "_inbox.md").then(|| decode_inbox(&old_content));
        if decoded
            .as_ref()
            .is_some_and(|item| !item.warnings.is_empty())
        {
            return Err(tool_error("Inbox metadata 已损坏，拒绝写入"));
        }
        let old_clean = decoded
            .as_ref()
            .map_or_else(|| old_content.clone(), |item| item.markdown.clone());
        let changes = locate_changes(&old_clean, &edits).map_err(tool_error)?;
        let new_clean = apply_changes(&old_clean, &changes);
        let new_content = if let Some(mut decoded) = decoded {
            decoded.metadata.annotations = map_annotations(&decoded.metadata.annotations, &changes);
            decoded.metadata.quote_sources = map_quote_sources(
                &old_clean,
                &new_clean,
                &decoded.metadata.quote_sources,
                &changes,
            );
            encode_inbox(&new_clean, &decoded.metadata)
        } else {
            new_clean.clone()
        };
        let draft = MutationDraft {
            operation: MutationOperation::Edit,
            path: path.clone(),
            old_content,
            new_content,
            create_only: false,
            preview: EditPreview {
                tool: "edit".into(),
                summary: format!("编辑「{path}」"),
                detail: EditPreviewDetail::Diff {
                    hunks: unified_diff(&old_clean, &new_clean),
                },
            },
        };
        let id = deps.call.id()?;
        review_and_commit(&deps.app, &deps.conversation_id, &id, "edit", draft)
            .await
            .map(ToolOutput::text)
            .map_err(tool_error)
    })
}

fn tool_write(deps: ToolDeps, args: Value) -> ToolFuture {
    Box::pin(async move {
        let path = required_str(&args, "path")?.to_string();
        let content = required_str(&args, "content")?.to_string();
        let old_content = read_note(&deps, &path)?;
        let mut old_clean = old_content.clone();
        let mut new_content = content.clone();
        if path == "_inbox.md" {
            let decoded = decode_inbox(&old_content);
            if !decoded.warnings.is_empty() {
                return Err(tool_error("Inbox metadata 已损坏，拒绝写入"));
            }
            if !decoded.metadata.annotations.is_empty() {
                return Err(tool_error("Inbox 含有文本标注，请使用 edit 保留标注"));
            }
            old_clean = decoded.markdown;
            new_content = encode_inbox(
                &content,
                &super::InboxMetadata {
                    tags: decoded.metadata.tags,
                    ..Default::default()
                },
            );
        }
        let draft = MutationDraft {
            operation: MutationOperation::Rewrite,
            path: path.clone(),
            old_content,
            new_content,
            create_only: false,
            preview: EditPreview {
                tool: "write".into(),
                summary: format!("覆写「{path}」"),
                detail: EditPreviewDetail::Diff {
                    hunks: unified_diff(&old_clean, &content),
                },
            },
        };
        let id = deps.call.id()?;
        review_and_commit(&deps.app, &deps.conversation_id, &id, "write", draft)
            .await
            .map(ToolOutput::text)
            .map_err(tool_error)
    })
}

fn tool_create_piece(deps: ToolDeps, args: Value) -> ToolFuture {
    Box::pin(async move {
        let title = required_str(&args, "title")?;
        let content = required_str(&args, "content")?.to_string();
        let path = normalize_piece_title(title)?;
        if list_project_space(&project_dir(&deps)?)
            .map_err(tool_error)?
            .iter()
            .any(|entry| entry.path.eq_ignore_ascii_case(&path))
        {
            return Err(tool_error(format!("PIECE_ALREADY_EXISTS: “{path}”已存在")));
        }
        let draft = MutationDraft {
            operation: MutationOperation::Create,
            path: path.clone(),
            old_content: String::new(),
            new_content: content.clone(),
            create_only: true,
            preview: EditPreview {
                tool: "create_piece".into(),
                summary: format!("创建文档「{path}」"),
                detail: EditPreviewDetail::NoteCreate {
                    filename: path.clone(),
                    content_preview: content.chars().take(240).collect(),
                },
            },
        };
        let id = deps.call.id()?;
        review_and_commit(&deps.app, &deps.conversation_id, &id, "create_piece", draft)
            .await
            .map(ToolOutput::text)
            .map_err(tool_error)
    })
}

fn tool_list_tags(deps: ToolDeps, _args: Value) -> ToolFuture {
    Box::pin(async move {
        let decoded = decode_inbox(&read_note(&deps, "_inbox.md")?);
        text(serde_json::to_string(&json!({"tags":decoded.metadata.tags,"freeColors":free_colors(&decoded.metadata.tags, None)})).unwrap())
    })
}

fn tool_tag_text(deps: ToolDeps, args: Value) -> ToolFuture {
    Box::pin(async move {
        let exact = required_str(&args, "exact")?;
        let tag_id = required_str(&args, "tagId")?;
        let action = required_str(&args, "action")?;
        let old_content = read_note(&deps, "_inbox.md")?;
        let mut decoded = decode_inbox(&old_content);
        reject_damaged(&decoded)?;
        let tag = decoded
            .metadata
            .tags
            .iter()
            .find(|tag| tag.id == tag_id)
            .cloned()
            .ok_or_else(|| tool_error(format!("未知标签：{tag_id}")))?;
        let (from, to) = exact_text_range(
            &decoded.markdown,
            exact,
            args.get("prefix").and_then(Value::as_str),
            args.get("suffix").and_then(Value::as_str),
        )
        .map_err(tool_error)?;
        if in_markdown_syntax(&decoded.markdown, from, to) {
            return Err(tool_error("目标文本不在可标注的 Markdown 正文中"));
        }
        decoded.metadata.annotations = match action {
            "add" => add_annotation(&decoded.metadata.annotations, tag_id, from, to),
            "remove" => remove_annotation(&decoded.metadata.annotations, tag_id, from, to),
            _ => return Err(tool_error("action 必须是 add 或 remove")),
        };
        let count = decoded
            .metadata
            .annotations
            .iter()
            .filter(|item| item.tag_id == tag_id)
            .count() as u32;
        let draft = MutationDraft {
            operation: MutationOperation::Tag,
            path: "_inbox.md".into(),
            old_content,
            new_content: encode_inbox(&decoded.markdown, &decoded.metadata),
            create_only: false,
            preview: EditPreview {
                tool: "tag_text".into(),
                summary: format!("{}文本标签", if action == "add" { "添加" } else { "移除" }),
                detail: EditPreviewDetail::TagAssign {
                    text_excerpt: exact.chars().take(80).collect(),
                    target_text: Some(exact.into()),
                    annotation_count: count,
                    action: action.into(),
                    tag_name: tag.name,
                    tag_color: tag.color,
                },
            },
        };
        let id = deps.call.id()?;
        review_and_commit(&deps.app, &deps.conversation_id, &id, "tag_text", draft)
            .await
            .map(ToolOutput::text)
            .map_err(tool_error)
    })
}

fn tool_tag_create(deps: ToolDeps, args: Value) -> ToolFuture {
    Box::pin(async move {
        let name = required_str(&args, "name")?;
        let color = required_str(&args, "color")?;
        if !super::valid_tag_name(name) {
            return Err(tool_error("标签名不能为空、不能换行，且不能超过 80 个字符"));
        }
        let old_content = read_note(&deps, "_inbox.md")?;
        let mut decoded = decode_inbox(&old_content);
        reject_damaged(&decoded)?;
        if !free_colors(&decoded.metadata.tags, None)
            .iter()
            .any(|item| item.eq_ignore_ascii_case(color))
        {
            return Err(tool_error(format!("颜色 {color} 不可用")));
        }
        let id_value = slug(
            name,
            decoded.metadata.tags.iter().map(|tag| tag.id.as_str()),
        );
        decoded.metadata.tags.push(super::TagDef {
            id: id_value,
            name: name.into(),
            color: color.into(),
        });
        tag_draft(
            deps,
            "tag_create",
            old_content,
            decoded,
            EditPreviewDetail::TagCreate {
                tag_name: name.into(),
                tag_color: color.into(),
            },
            format!("新建标签「{name}」"),
        )
        .await
    })
}

fn tool_tag_update(deps: ToolDeps, args: Value) -> ToolFuture {
    Box::pin(async move {
        let tag_id = required_str(&args, "tagId")?;
        let old_content = read_note(&deps, "_inbox.md")?;
        let mut decoded = decode_inbox(&old_content);
        reject_damaged(&decoded)?;
        let index = decoded
            .metadata
            .tags
            .iter()
            .position(|tag| tag.id == tag_id)
            .ok_or_else(|| tool_error(format!("未知标签：{tag_id}")))?;
        let old = decoded.metadata.tags[index].clone();
        let new_name = args
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&old.name);
        if !super::valid_tag_name(new_name) {
            return Err(tool_error("标签名无效"));
        }
        let new_color = args
            .get("color")
            .and_then(Value::as_str)
            .unwrap_or(&old.color);
        if new_color != old.color
            && !free_colors(&decoded.metadata.tags, Some(tag_id))
                .iter()
                .any(|item| item.eq_ignore_ascii_case(new_color))
        {
            return Err(tool_error("颜色不可用"));
        }
        decoded.metadata.tags[index].name = new_name.into();
        decoded.metadata.tags[index].color = new_color.into();
        let detail = EditPreviewDetail::TagUpdate {
            tag_id: tag_id.into(),
            old_name: old.name.clone(),
            old_color: old.color.clone(),
            new_name: new_name.into(),
            new_color: new_color.into(),
        };
        tag_draft(
            deps,
            "tag_update",
            old_content,
            decoded,
            detail,
            format!("修改标签「{}」", old.name),
        )
        .await
    })
}

fn tool_tag_delete(deps: ToolDeps, args: Value) -> ToolFuture {
    Box::pin(async move {
        let tag_id = required_str(&args, "tagId")?;
        let old_content = read_note(&deps, "_inbox.md")?;
        let mut decoded = decode_inbox(&old_content);
        reject_damaged(&decoded)?;
        let tag = decoded
            .metadata
            .tags
            .iter()
            .find(|tag| tag.id == tag_id)
            .cloned();
        let count = decoded
            .metadata
            .annotations
            .iter()
            .filter(|item| item.tag_id == tag_id)
            .count() as u32;
        decoded.metadata.tags.retain(|tag| tag.id != tag_id);
        decoded
            .metadata
            .annotations
            .retain(|item| item.tag_id != tag_id);
        let name = tag.map_or_else(|| tag_id.into(), |tag| tag.name);
        let detail = EditPreviewDetail::TagDelete {
            tag_name: name.clone(),
            annotation_count: count,
        };
        tag_draft(
            deps,
            "tag_delete",
            old_content,
            decoded,
            detail,
            format!("删除标签「{name}」"),
        )
        .await
    })
}

async fn tag_draft(
    deps: ToolDeps,
    tool: &str,
    old_content: String,
    decoded: super::DecodedInbox,
    detail: EditPreviewDetail,
    summary: String,
) -> Result<ToolOutput, ToolExecutionError> {
    let draft = MutationDraft {
        operation: MutationOperation::Tag,
        path: "_inbox.md".into(),
        old_content,
        new_content: encode_inbox(&decoded.markdown, &decoded.metadata),
        create_only: false,
        preview: EditPreview {
            tool: tool.into(),
            summary,
            detail,
        },
    };
    let id = deps.call.id()?;
    review_and_commit(&deps.app, &deps.conversation_id, &id, tool, draft)
        .await
        .map(ToolOutput::text)
        .map_err(tool_error)
}

fn tool_web_search(_deps: ToolDeps, args: Value) -> ToolFuture {
    Box::pin(async move {
        let query = required_str(&args, "query")?;
        let count = bounded(args.get("count").and_then(Value::as_u64), 5, 1, 10, "count")?;
        let mut url = reqwest::Url::parse("https://html.duckduckgo.com/html/")
            .map_err(|e| tool_error(e.to_string()))?;
        url.query_pairs_mut().append_pair("q", query);
        let response = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|e| tool_error(e.to_string()))?
            .get(url)
            .header(reqwest::header::USER_AGENT, "FloatNote/1.0")
            .send()
            .await
            .map_err(|e| ToolExecutionError::network(e.to_string()))?;
        if !response.status().is_success() {
            return Err(ToolExecutionError::network(format!(
                "搜索服务不可用：HTTP {}",
                response.status()
            )));
        }
        let html = response
            .text()
            .await
            .map_err(|e| ToolExecutionError::network(e.to_string()))?;
        let link = regex::Regex::new(r#"(?is)<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>.*?<a[^>]+class="result__snippet"[^>]*>(.*?)</a>"#).unwrap();
        let mut results = Vec::new();
        for cap in link.captures_iter(&html).take(count) {
            let raw = decode_html(&cap[1]);
            let redirected = reqwest::Url::parse(&raw)
                .or_else(|_| {
                    reqwest::Url::parse("https://duckduckgo.com").and_then(|base| base.join(&raw))
                })
                .ok();
            let target = redirected
                .as_ref()
                .and_then(|url| {
                    url.query_pairs()
                        .find(|(key, _)| key == "uddg")
                        .map(|(_, value)| value.into_owned())
                })
                .unwrap_or(raw);
            results.push(
                json!({"title":html_text(&cap[2]),"url":target,"snippet":html_text(&cap[3])}),
            );
        }
        text(untrusted(
            &serde_json::to_string(&json!({"query":query,"results":results})).unwrap(),
        ))
    })
}

fn tool_web_fetch(_deps: ToolDeps, args: Value) -> ToolFuture {
    Box::pin(async move {
        let mut url = reqwest::Url::parse(required_str(&args, "url")?)
            .map_err(|_| tool_error("网络链接无效"))?;
        for redirects in 0..=4 {
            let (client, checked) = public_client_for(&url).await?;
            let response = client
                .get(checked.clone())
                .header(reqwest::header::USER_AGENT, "FloatNote/1.0")
                .send()
                .await
                .map_err(|e| ToolExecutionError::network(e.to_string()))?;
            if response.status().is_redirection() {
                if redirects == 4 {
                    return Err(tool_error("网页重定向次数过多"));
                }
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or_else(|| tool_error("网页重定向缺少目标地址"))?;
                url = checked
                    .join(location)
                    .map_err(|_| tool_error("网页重定向目标无效"))?;
                continue;
            }
            if !response.status().is_success() {
                return Err(ToolExecutionError::network(format!(
                    "网页请求失败：HTTP {}",
                    response.status()
                )));
            }
            let kind = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("text/plain")
                .to_ascii_lowercase();
            if !kind.contains("text/")
                && !kind.contains("application/json")
                && !kind.contains("application/xhtml+xml")
            {
                return Err(tool_error(format!("不支持的网页内容类型：{kind}")));
            }
            if response
                .content_length()
                .is_some_and(|length| length > 1_000_000)
            {
                return Err(tool_error("网页内容过大"));
            }
            let bytes = response
                .bytes()
                .await
                .map_err(|e| ToolExecutionError::network(e.to_string()))?;
            if bytes.len() > 1_000_000 {
                return Err(tool_error("网页内容过大"));
            }
            let raw = String::from_utf8_lossy(&bytes);
            let content = if kind.contains("html") || kind.contains("xhtml") {
                html_text(&raw)
            } else {
                raw.into_owned()
            };
            return text(untrusted(
                &serde_json::to_string(&json!({"url":checked,"content":content})).unwrap(),
            ));
        }
        Err(tool_error("网页重定向次数过多"))
    })
}

async fn public_client_for(
    url: &reqwest::Url,
) -> Result<(reqwest::Client, reqwest::Url), ToolExecutionError> {
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(tool_error("仅支持不含凭据的 http/https 网络链接"));
    }
    let host = url
        .host_str()
        .ok_or_else(|| tool_error("网络链接缺少主机"))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| tool_error("网络链接端口无效"))?;
    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| ToolExecutionError::network(e.to_string()))?
        .collect::<Vec<_>>();
    if addresses.is_empty() || addresses.iter().any(|address| private_ip(address.ip())) {
        return Err(tool_error("拒绝访问非公网地址"));
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15))
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(|e| tool_error(e.to_string()))?;
    Ok((client, url.clone()))
}

fn private_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ip) => {
            let [a, b, _, _] = ip.octets();
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_unspecified()
                || ip.is_multicast()
                || (a == 100 && (64..=127).contains(&b))
                || (a == 198 && (18..=19).contains(&b))
                || (a == 192 && b == 0)
        }
        std::net::IpAddr::V6(ip) => {
            ip.to_ipv4_mapped()
                .is_some_and(|mapped| private_ip(mapped.into()))
                || ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || (ip.segments()[0] == 0x2001 && ip.segments()[1] == 0x0db8)
        }
    }
}
fn untrusted(value: &str) -> String {
    format!(
        "[不可信外部资料开始]\n{}\n[不可信外部资料结束]",
        value.chars().take(24_000).collect::<String>()
    )
}
fn html_text(value: &str) -> String {
    let mut without = value.to_string();
    for tag in ["script", "style", "noscript", "svg"] {
        let re = regex::Regex::new(&format!(r"(?is)<{tag}[^>]*>.*?</{tag}>")).unwrap();
        without = re.replace_all(&without, " ").into_owned();
    }
    let text = regex::Regex::new(r"(?s)<[^>]+>")
        .unwrap()
        .replace_all(&without, " ");
    decode_html(&text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn decode_html(value: &str) -> String {
    value
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn reject_damaged(decoded: &super::DecodedInbox) -> Result<(), ToolExecutionError> {
    if decoded.warnings.is_empty() {
        Ok(())
    } else {
        Err(tool_error(format!(
            "Inbox metadata 已损坏，拒绝写入：{}",
            decoded.warnings.join(", ")
        )))
    }
}
fn required_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, ToolExecutionError> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ToolExecutionError::invalid_args(format!("缺少字符串参数 {key}")))
}
fn bounded(
    value: Option<u64>,
    fallback: usize,
    min: usize,
    max: usize,
    name: &str,
) -> Result<usize, ToolExecutionError> {
    let value = value.map_or(fallback, |v| v as usize);
    if value < min || value > max {
        Err(ToolExecutionError::invalid_args(format!(
            "{name} 必须在 {min}..{max} 之间"
        )))
    } else {
        Ok(value)
    }
}
fn glob_regex(pattern: &str) -> Result<regex::Regex, String> {
    if pattern.is_empty() {
        return Err("pattern 不能为空".into());
    }
    let escaped = regex::escape(pattern)
        .replace("\\*", ".*")
        .replace("\\?", ".");
    regex::Regex::new(&format!("^{escaped}$")).map_err(|e| e.to_string())
}
fn unified_diff(before: &str, after: &str) -> String {
    let left = before.split('\n').collect::<Vec<_>>();
    let right = after.split('\n').collect::<Vec<_>>();
    let mut out = Vec::new();
    for index in 0..left.len().max(right.len()) {
        if left.get(index) == right.get(index) {
            if let Some(line) = left.get(index) {
                out.push(format!("  {line}"));
            }
        } else {
            if let Some(line) = left.get(index) {
                out.push(format!("- {line}"));
            }
            if let Some(line) = right.get(index) {
                out.push(format!("+ {line}"));
            }
        }
    }
    out.join("\n")
}
fn normalize_piece_title(title: &str) -> Result<String, ToolExecutionError> {
    let normalized = title.nfc().collect::<String>();
    let without = normalized
        .trim()
        .strip_suffix(".md")
        .unwrap_or(normalized.trim());
    let invalid = regex::Regex::new(r#"[/\\:*?"<>|\x00-\x1f]+"#).unwrap();
    let safe = invalid
        .replace_all(without, "-")
        .trim()
        .trim_matches(|ch: char| ch == '_' || ch == '.' || ch == '-' || ch.is_whitespace())
        .to_string();
    if safe.is_empty() {
        return Err(tool_error(
            "INVALID_PIECE_TITLE: title 需要包含可用的标题文字",
        ));
    }
    let reserved = regex::Regex::new(r"(?i)^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])$").unwrap();
    Ok(format!(
        "{}{}.md",
        safe,
        if reserved.is_match(&safe) {
            "-note"
        } else {
            ""
        }
    ))
}
fn slug<'a>(name: &str, existing: impl Iterator<Item = &'a str>) -> String {
    let base = regex::Regex::new("[^a-z0-9]+")
        .unwrap()
        .replace_all(&name.to_lowercase(), "-")
        .trim_matches('-')
        .to_string();
    let base = if base.is_empty() { "tag".into() } else { base };
    let used = existing.collect::<HashSet<_>>();
    if !used.contains(base.as_str()) {
        return base;
    }
    for suffix in 2.. {
        let candidate = format!("{base}-{suffix}");
        if !used.contains(candidate.as_str()) {
            return candidate;
        }
    }
    unreachable!()
}
fn in_markdown_syntax(markdown: &str, from: usize, to: usize) -> bool {
    let byte_from = super::byte_at_utf16(markdown, from);
    let byte_to = super::byte_at_utf16(markdown, to);
    let mut fenced = false;
    let mut cursor = 0;
    for line in markdown.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            if byte_from >= cursor && byte_to <= cursor + line.len() {
                return true;
            }
            fenced = !fenced;
        }
        if fenced && byte_from < cursor + line.len() && byte_to > cursor {
            return true;
        }
        cursor += line.len();
    }
    let line_start = markdown[..byte_from].rfind('\n').map_or(0, |i| i + 1);
    let line_end = markdown[byte_to..]
        .find('\n')
        .map_or(markdown.len(), |i| byte_to + i);
    let line = &markdown[line_start..line_end];
    let local_from = byte_from - line_start;
    let local_to = byte_to - line_start;
    if line[..local_from].matches('`').count() % 2 == 1 {
        return true;
    }
    let destinations = regex::Regex::new(r"!?\[[^\]]*\]\(([^)]*)\)").unwrap();
    for capture in destinations.captures_iter(line) {
        if let Some(target) = capture.get(1) {
            if local_from < target.end() && local_to > target.start() {
                return true;
            }
        }
    }
    let urls = regex::Regex::new(r"(?:https?://|mailto:)[^\s)>]+").unwrap();
    let overlaps_url = urls
        .find_iter(line)
        .any(|url| local_from < url.end() && local_to > url.start());
    overlaps_url
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn annotation_targets_reject_code_and_urls_but_allow_link_labels() {
        let markdown = "plain `inline` [label](https://example.com)\n```\ncode\n```";
        let range = |text: &str| {
            let byte = markdown.find(text).unwrap();
            (
                super::super::utf16_len(&markdown[..byte]),
                super::super::utf16_len(&markdown[..byte + text.len()]),
            )
        };
        let (from, to) = range("inline");
        assert!(in_markdown_syntax(markdown, from, to));
        let (from, to) = range("https://example.com");
        assert!(in_markdown_syntax(markdown, from, to));
        let (from, to) = range("label");
        assert!(!in_markdown_syntax(markdown, from, to));
        let (from, to) = range("code");
        assert!(in_markdown_syntax(markdown, from, to));
    }
    #[test]
    fn private_network_ranges_cover_shared_and_mapped_addresses() {
        assert!(private_ip("100.64.0.1".parse().unwrap()));
        assert!(private_ip("::ffff:127.0.0.1".parse().unwrap()));
        assert!(!private_ip("1.1.1.1".parse().unwrap()));
    }
}
