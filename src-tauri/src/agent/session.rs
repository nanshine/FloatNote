use super::rig_adapter::{
    completion::Message,
    message::{
        AssistantContent, ProviderCallId, Reasoning, ReasoningContent, Text, ToolCall, ToolCallId,
        ToolFunction, ToolResult, ToolResultContent, UserContent,
    },
};
use super::{
    display_status, tool_presentation, ChatDisplayBlock, ChatDisplayMessage, ToolDisplayStatus,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

const SESSION_FORMAT: &str = "floatnote-agent-session";
const SESSION_VERSION: u32 = 1;
const MAX_INPUT_ESTIMATED_TOKENS: usize = 64_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Header {
    #[serde(rename = "type")]
    record_type: String,
    format: String,
    version: u32,
    id: String,
    cwd: String,
    created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum Record {
    Message {
        id: String,
        parent_id: Option<String>,
        timestamp: String,
        message: Message,
    },
    DisplayError {
        id: String,
        parent_id: Option<String>,
        timestamp: String,
        text: String,
    },
    DisplayAssistant {
        id: String,
        parent_id: Option<String>,
        timestamp: String,
        blocks: Vec<ChatDisplayBlock>,
    },
    HeadMoved {
        target_id: Option<String>,
        timestamp: String,
    },
}

impl Record {
    fn id(&self) -> Option<&str> {
        match self {
            Self::Message { id, .. }
            | Self::DisplayError { id, .. }
            | Self::DisplayAssistant { id, .. } => Some(id),
            Self::HeadMoved { .. } => None,
        }
    }

    fn parent_id(&self) -> Option<&str> {
        match self {
            Self::Message { parent_id, .. }
            | Self::DisplayError { parent_id, .. }
            | Self::DisplayAssistant { parent_id, .. } => parent_id.as_deref(),
            Self::HeadMoved { .. } => None,
        }
    }
}

#[derive(Debug)]
pub struct AgentSession {
    id: String,
    file: PathBuf,
    records: Vec<Record>,
    head: Option<String>,
}

impl AgentSession {
    pub fn create(id: String, cwd: String, session_dir: &Path) -> Result<Self, String> {
        validate_session_id(&id)?;
        fs::create_dir_all(session_dir).map_err(|error| error.to_string())?;
        let file = session_dir.join(format!("{id}.jsonl"));
        let header = Header {
            record_type: "session".into(),
            format: SESSION_FORMAT.into(),
            version: SESSION_VERSION,
            id: id.clone(),
            cwd: cwd.clone(),
            created_at: Utc::now().to_rfc3339(),
        };
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        let mut output = options.open(&file).map_err(|error| error.to_string())?;
        writeln!(
            output,
            "{}",
            serde_json::to_string(&header).map_err(|e| e.to_string())?
        )
        .map_err(|error| error.to_string())?;
        output.sync_data().map_err(|error| error.to_string())?;
        Ok(Self {
            id,
            file,
            records: Vec::new(),
            head: None,
        })
    }

    pub fn open(file: &Path) -> Result<Self, String> {
        let text = fs::read_to_string(file).map_err(|error| error.to_string())?;
        let mut lines = text.lines();
        let first = lines.next().ok_or("会话文件为空")?;
        let value: serde_json::Value = serde_json::from_str(first).map_err(|_| "会话文件头损坏")?;
        if value.get("format").and_then(|v| v.as_str()) != Some(SESSION_FORMAT) {
            return import_legacy_pi(file, &text);
        }
        let header: Header = serde_json::from_value(value).map_err(|error| error.to_string())?;
        if header.version != SESSION_VERSION {
            return Err(format!("不支持的会话版本：{}", header.version));
        }
        let mut records = Vec::new();
        let mut head = None;
        for line in lines.filter(|line| !line.trim().is_empty()) {
            match serde_json::from_str::<Record>(line) {
                Ok(record) => {
                    match &record {
                        Record::Message { id, .. }
                        | Record::DisplayError { id, .. }
                        | Record::DisplayAssistant { id, .. } => {
                            head = Some(id.clone());
                        }
                        Record::HeadMoved { target_id, .. } => head = target_id.clone(),
                    }
                    records.push(record);
                }
                Err(_) if line == text.lines().last().unwrap_or_default() => break,
                Err(error) => return Err(format!("会话记录损坏：{error}")),
            }
        }
        Ok(Self {
            id: header.id,
            file: file.to_path_buf(),
            records,
            head,
        })
    }

    pub fn file(&self) -> &Path {
        &self.file
    }
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn append_message(&mut self, message: Message) -> Result<String, String> {
        let id = new_id();
        let record = Record::Message {
            id: id.clone(),
            parent_id: self.head.clone(),
            timestamp: Utc::now().to_rfc3339(),
            message,
        };
        self.append(record)?;
        self.head = Some(id.clone());
        Ok(id)
    }

    pub fn append_error(&mut self, text: String) -> Result<String, String> {
        let id = new_id();
        let record = Record::DisplayError {
            id: id.clone(),
            parent_id: self.head.clone(),
            timestamp: Utc::now().to_rfc3339(),
            text,
        };
        self.append(record)?;
        self.head = Some(id.clone());
        Ok(id)
    }

    pub fn append_display_assistant(
        &mut self,
        blocks: Vec<ChatDisplayBlock>,
    ) -> Result<Option<String>, String> {
        if blocks.is_empty() {
            return Ok(None);
        }
        let id = new_id();
        let record = Record::DisplayAssistant {
            id: id.clone(),
            parent_id: self.head.clone(),
            timestamp: Utc::now().to_rfc3339(),
            blocks,
        };
        self.append(record)?;
        self.head = Some(id.clone());
        Ok(Some(id))
    }

    pub fn rewind_before_user(&mut self, user_entry_id: &str) -> Result<(), String> {
        let record = self
            .records
            .iter()
            .find(|record| record.id() == Some(user_entry_id))
            .ok_or("找不到要回退的用户消息")?;
        match record {
            Record::Message {
                message: Message::User { .. },
                ..
            } => {}
            _ => return Err("只能回退到用户消息之前".into()),
        }
        self.head = record.parent_id().map(str::to_string);
        self.append(Record::HeadMoved {
            target_id: self.head.clone(),
            timestamp: Utc::now().to_rfc3339(),
        })
    }

    pub fn history(&self, fixed_tokens: usize) -> Result<Vec<Message>, String> {
        if fixed_tokens >= MAX_INPUT_ESTIMATED_TOKENS {
            return Err("系统提示、Skill 与当前请求超过本地上下文预算".into());
        }
        let budget = MAX_INPUT_ESTIMATED_TOKENS - fixed_tokens;
        let branch = self.branch();
        let mut groups: Vec<Vec<Message>> = Vec::new();
        for record in branch {
            let Record::Message { message, .. } = record else {
                continue;
            };
            let starts_turn = matches!(message, Message::User { content } if content.iter().any(|part| matches!(part, UserContent::Text(_))));
            if starts_turn {
                groups.push(vec![message.clone()]);
            } else if let Some(group) = groups.last_mut() {
                group.push(message.clone());
            }
        }
        let mut kept_groups = Vec::new();
        let mut used = 0usize;
        for group in groups.into_iter().rev() {
            let cost = group.iter().map(estimate_message_tokens).sum::<usize>();
            if used + cost > budget {
                break;
            }
            used += cost;
            kept_groups.push(group);
        }
        kept_groups.reverse();
        Ok(kept_groups.into_iter().flatten().collect())
    }

    pub fn display_messages(&self) -> Vec<ChatDisplayMessage> {
        display_from_records(&self.branch())
    }

    fn branch(&self) -> Vec<&Record> {
        let by_id = self
            .records
            .iter()
            .filter_map(|record| record.id().map(|id| (id, record)))
            .collect::<HashMap<_, _>>();
        let mut output = Vec::new();
        let mut current = self.head.as_deref();
        let mut seen = HashSet::new();
        while let Some(id) = current {
            if !seen.insert(id) {
                break;
            }
            let Some(record) = by_id.get(id).copied() else {
                break;
            };
            output.push(record);
            current = record.parent_id();
        }
        output.reverse();
        output
    }

    fn append(&mut self, record: Record) -> Result<(), String> {
        let mut output = OpenOptions::new()
            .append(true)
            .open(&self.file)
            .map_err(|e| e.to_string())?;
        writeln!(
            output,
            "{}",
            serde_json::to_string(&record).map_err(|e| e.to_string())?
        )
        .map_err(|error| error.to_string())?;
        output.sync_data().map_err(|error| error.to_string())?;
        self.records.push(record);
        Ok(())
    }
}

fn display_from_records(records: &[&Record]) -> Vec<ChatDisplayMessage> {
    let mut tool_results = HashMap::<String, bool>::new();
    for record in records {
        if let Record::Message {
            message: Message::User { content },
            ..
        } = record
        {
            for item in content {
                if let UserContent::ToolResult(result) = item {
                    tool_results.insert(
                        result.call.to_string(),
                        result.content.iter().any(|part| {
                            part.as_text()
                                .is_some_and(|text| text.starts_with("[工具错误]"))
                        }),
                    );
                }
            }
        }
    }
    let mut output = Vec::new();
    let mut assistant_index = None;
    for record in records {
        match record {
            Record::Message {
                id,
                timestamp,
                message: Message::User { content },
                ..
            } => {
                let text = content
                    .iter()
                    .filter_map(|part| match part {
                        UserContent::Text(t) => Some(t.text.as_str()),
                        _ => None,
                    })
                    .collect::<String>();
                if !text.is_empty() {
                    assistant_index = None;
                    output.push(ChatDisplayMessage::User {
                        text,
                        timestamp: millis(timestamp),
                        entry_id: Some(id.clone()),
                    });
                }
            }
            Record::Message {
                id,
                timestamp,
                message: Message::Assistant { content, .. },
                ..
            } => {
                let mut blocks = Vec::new();
                for part in content {
                    match part {
                        AssistantContent::Text(text) if !text.text.is_empty() => {
                            blocks.push(ChatDisplayBlock::Text {
                                text: text.text.clone(),
                            })
                        }
                        AssistantContent::Reasoning(reasoning) => {
                            let text = reasoning.display_text();
                            if !text.is_empty() {
                                blocks.push(ChatDisplayBlock::Thinking { text });
                            }
                        }
                        AssistantContent::ToolCall(call) => {
                            let args = &call.function.arguments;
                            let (category, label) = tool_presentation(&call.function.name, args);
                            let is_error = tool_results.get(call.id.as_str()).copied();
                            blocks.push(ChatDisplayBlock::Tool {
                                call_id: call.id.to_string(),
                                name: call.function.name.clone(),
                                category,
                                label,
                                status: is_error
                                    .map(display_status)
                                    .unwrap_or(ToolDisplayStatus::Incomplete),
                                error: None,
                            });
                        }
                        _ => {}
                    }
                }
                if blocks.is_empty() {
                    continue;
                }
                if let Some(index) = assistant_index {
                    if let Some(ChatDisplayMessage::Assistant {
                        blocks: current, ..
                    }) = output.get_mut(index)
                    {
                        current.extend(blocks);
                        continue;
                    }
                }
                assistant_index = Some(output.len());
                output.push(ChatDisplayMessage::Assistant {
                    blocks,
                    timestamp: millis(timestamp),
                    entry_id: Some(id.clone()),
                });
            }
            Record::DisplayError {
                id,
                timestamp,
                text,
                ..
            } => {
                assistant_index = None;
                output.push(ChatDisplayMessage::Error {
                    text: text.clone(),
                    timestamp: millis(timestamp),
                    entry_id: Some(id.clone()),
                });
            }
            Record::DisplayAssistant {
                id,
                timestamp,
                blocks,
                ..
            } => {
                assistant_index = None;
                output.push(ChatDisplayMessage::Assistant {
                    blocks: blocks.clone(),
                    timestamp: millis(timestamp),
                    entry_id: Some(id.clone()),
                });
            }
            _ => {}
        }
    }
    output
}

fn estimate_message_tokens(message: &Message) -> usize {
    let text = serde_json::to_string(message).unwrap_or_default();
    let mut ascii = 0usize;
    let mut other = 0usize;
    for ch in text.chars() {
        if ch.is_ascii() {
            ascii += 1
        } else {
            other += 1
        }
    }
    ascii.div_ceil(4) + other + 8
}

pub fn estimate_text_tokens(text: &str) -> usize {
    let mut ascii = 0usize;
    let mut other = 0usize;
    for ch in text.chars() {
        if ch.is_ascii() {
            ascii += 1
        } else {
            other += 1
        }
    }
    ascii.div_ceil(4) + other + 8
}

fn millis(value: &str) -> u64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|date| date.timestamp_millis().max(0) as u64)
        .unwrap_or_else(|_| Utc::now().timestamp_millis() as u64)
}

fn validate_session_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err("无效的会话 ID".into());
    }
    Ok(())
}

fn new_id() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        return format!("{}", Utc::now().timestamp_nanos_opt().unwrap_or_default());
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn new_id_for_agent() -> String {
    new_id()
}

fn import_legacy_pi(file: &Path, text: &str) -> Result<AgentSession, String> {
    let values = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str::<serde_json::Value>(line).map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    let header = values.first().ok_or("旧会话为空")?;
    if header.get("type").and_then(|value| value.as_str()) != Some("session") {
        return Err("不是可识别的 Pi 会话".into());
    }
    let id = header
        .get("id")
        .and_then(|value| value.as_str())
        .ok_or("旧会话缺少 ID")?
        .to_string();
    let cwd = header
        .get("cwd")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    validate_session_id(&id)?;
    let entries = values
        .iter()
        .skip(1)
        .filter_map(|value| {
            value
                .get("id")
                .and_then(|id| id.as_str())
                .map(|id| (id.to_string(), value))
        })
        .collect::<HashMap<_, _>>();
    let mut branch = Vec::new();
    if entries.is_empty() {
        branch.extend(values.iter().skip(1));
    } else {
        let mut current = values.iter().rev().find_map(|value| {
            value
                .get("id")
                .and_then(|id| id.as_str())
                .map(str::to_string)
        });
        let mut seen = HashSet::new();
        while let Some(entry_id) = current {
            if !seen.insert(entry_id.clone()) {
                return Err("旧会话包含循环 parentId".into());
            }
            let entry = entries
                .get(&entry_id)
                .copied()
                .ok_or("旧会话 parentId 损坏")?;
            branch.push(entry);
            current = entry
                .get("parentId")
                .and_then(|value| value.as_str())
                .map(str::to_string);
        }
        branch.reverse();
    }
    let mut records = Vec::new();
    let mut parent_id = None;
    let mut tool_names = HashMap::new();
    for entry in branch {
        if entry.get("type").and_then(|value| value.as_str()) != Some("message") {
            continue;
        }
        let Some(message_value) = entry.get("message") else {
            continue;
        };
        let Some(message) = legacy_message(message_value, &mut tool_names) else {
            continue;
        };
        let entry_id = entry
            .get("id")
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .unwrap_or_else(new_id);
        records.push(Record::Message {
            id: entry_id.clone(),
            parent_id: parent_id.clone(),
            timestamp: entry
                .get("timestamp")
                .and_then(|value| value.as_str())
                .unwrap_or_else(|| {
                    header
                        .get("timestamp")
                        .and_then(|value| value.as_str())
                        .unwrap_or("1970-01-01T00:00:00Z")
                })
                .to_string(),
            message,
        });
        parent_id = Some(entry_id);
    }
    let native_header = Header {
        record_type: "session".into(),
        format: SESSION_FORMAT.into(),
        version: SESSION_VERSION,
        id: id.clone(),
        cwd: cwd.clone(),
        created_at: header
            .get("timestamp")
            .and_then(|value| value.as_str())
            .unwrap_or("1970-01-01T00:00:00Z")
            .into(),
    };
    let temp = file.with_extension("jsonl.rust.tmp");
    let backup = unique_backup(file);
    let write_result = (|| -> Result<(), String> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        let mut output = options.open(&temp).map_err(|e| e.to_string())?;
        writeln!(
            output,
            "{}",
            serde_json::to_string(&native_header).map_err(|e| e.to_string())?
        )
        .map_err(|e| e.to_string())?;
        for record in &records {
            writeln!(
                output,
                "{}",
                serde_json::to_string(record).map_err(|e| e.to_string())?
            )
            .map_err(|e| e.to_string())?;
        }
        output.sync_all().map_err(|e| e.to_string())?;
        fs::rename(file, &backup).map_err(|e| e.to_string())?;
        if let Err(error) = fs::rename(&temp, file) {
            let _ = fs::rename(&backup, file);
            return Err(error.to_string());
        }
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    write_result?;
    Ok(AgentSession {
        id,
        file: file.to_path_buf(),
        records,
        head: parent_id,
    })
}

fn legacy_message(
    value: &serde_json::Value,
    tool_names: &mut HashMap<String, String>,
) -> Option<Message> {
    match value.get("role")?.as_str()? {
        "user" => {
            let text = legacy_text(value.get("content"));
            (!text.is_empty()).then(|| Message::user(text))
        }
        "assistant" => {
            let mut content = Vec::new();
            for block in value
                .get("content")
                .and_then(|value| value.as_array())
                .into_iter()
                .flatten()
            {
                match block.get("type").and_then(|value| value.as_str()) {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(|value| value.as_str()) {
                            content.push(AssistantContent::Text(Text::new(text)));
                        }
                    }
                    Some("thinking") => {
                        let text = block
                            .get("thinking")
                            .or_else(|| block.get("text"))
                            .and_then(|value| value.as_str())
                            .unwrap_or("");
                        let signature = block
                            .get("signature")
                            .and_then(|value| value.as_str())
                            .map(str::to_string);
                        content.push(AssistantContent::Reasoning(Reasoning {
                            id: None,
                            content: vec![ReasoningContent::Text {
                                text: text.into(),
                                signature,
                            }],
                        }));
                    }
                    Some("toolCall") | Some("tool_call") => {
                        let id = block
                            .get("id")
                            .or_else(|| block.get("toolCallId"))
                            .and_then(|value| value.as_str())
                            .unwrap_or("");
                        let name = block
                            .get("name")
                            .or_else(|| block.get("toolName"))
                            .and_then(|value| value.as_str())
                            .unwrap_or("unknown");
                        let arguments = block
                            .get("arguments")
                            .or_else(|| block.get("args"))
                            .cloned()
                            .unwrap_or_else(|| serde_json::json!({}));
                        let call =
                            ToolCall::from_wire(id, ToolFunction::new(name.into(), arguments));
                        tool_names.insert(call.id.to_string(), name.into());
                        content.push(AssistantContent::ToolCall(call));
                    }
                    _ => {}
                }
            }
            (!content.is_empty()).then_some(Message::Assistant { id: None, content })
        }
        "toolResult" | "tool" => {
            let id = value
                .get("toolCallId")
                .or_else(|| value.get("callId"))
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let call = ToolCallId::new_or_mint(id);
            let name = value
                .get("toolName")
                .and_then(|value| value.as_str())
                .map(str::to_string)
                .or_else(|| tool_names.get(call.as_str()).cloned())
                .unwrap_or_else(|| "unknown".into());
            let mut text = legacy_text(value.get("content"));
            if value.get("isError").and_then(|value| value.as_bool()) == Some(true) {
                text = format!("[工具错误] {text}");
            }
            Some(Message::User {
                content: vec![UserContent::ToolResult(ToolResult {
                    call,
                    provider: ProviderCallId::new(id),
                    name,
                    content: vec![ToolResultContent::Text(Text::new(text))],
                })],
            })
        }
        _ => None,
    }
}

fn legacy_text(value: Option<&serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.get("text").and_then(|value| value.as_str()))
            .collect(),
        _ => String::new(),
    }
}

fn unique_backup(file: &Path) -> PathBuf {
    let base = PathBuf::from(format!("{}.pi-v3.bak", file.to_string_lossy()));
    if !base.exists() {
        return base;
    }
    for suffix in 2.. {
        let path = PathBuf::from(format!("{}.pi-v3.{suffix}.bak", file.to_string_lossy()));
        if !path.exists() {
            return path;
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::tempdir;

    #[test]
    fn session_rewind_persists_a_new_branch_head() {
        let dir = tempdir();
        let mut session = AgentSession::create(
            "chat-1".into(),
            dir.path().display().to_string(),
            dir.path(),
        )
        .unwrap();
        let first = session.append_message(Message::user("first")).unwrap();
        session
            .append_message(Message::assistant("answer"))
            .unwrap();
        session.rewind_before_user(&first).unwrap();
        session
            .append_message(Message::user("replacement"))
            .unwrap();
        let reopened = AgentSession::open(session.file()).unwrap();
        let display = reopened.display_messages();
        assert_eq!(display.len(), 1);
        assert!(
            matches!(&display[0], ChatDisplayMessage::User { text, .. } if text == "replacement")
        );
    }

    #[test]
    fn token_estimate_counts_non_ascii_conservatively() {
        assert!(estimate_text_tokens("中文内容") > estimate_text_tokens("four"));
    }

    #[test]
    fn imports_only_the_active_pi_branch_and_keeps_a_backup() {
        let dir = tempdir();
        let file = dir.path().join("legacy.jsonl");
        let lines = [
            serde_json::json!({"type":"session","version":3,"id":"chat-legacy","timestamp":"2026-01-01T00:00:00Z","cwd":"/notes"}),
            serde_json::json!({"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":"first"}}),
            serde_json::json!({"type":"message","id":"a1","parentId":"u1","timestamp":"2026-01-01T00:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"answer"}]}}),
            serde_json::json!({"type":"message","id":"old-user","parentId":"a1","timestamp":"2026-01-01T00:00:03Z","message":{"role":"user","content":"abandoned"}}),
            serde_json::json!({"type":"message","id":"old-answer","parentId":"old-user","timestamp":"2026-01-01T00:00:04Z","message":{"role":"assistant","content":[{"type":"text","text":"old"}]}}),
            serde_json::json!({"type":"message","id":"new-user","parentId":"a1","timestamp":"2026-01-01T00:00:05Z","message":{"role":"user","content":"replacement"}}),
            serde_json::json!({"type":"message","id":"new-answer","parentId":"new-user","timestamp":"2026-01-01T00:00:06Z","message":{"role":"assistant","content":[{"type":"text","text":"new"}]}}),
        ];
        std::fs::write(
            &file,
            lines
                .iter()
                .map(|line| format!("{line}\n"))
                .collect::<String>(),
        )
        .unwrap();
        let session = AgentSession::open(&file).unwrap();
        let display = session.display_messages();
        assert_eq!(display.len(), 4);
        assert!(
            matches!(&display[2], ChatDisplayMessage::User { text, entry_id: Some(id), .. } if text == "replacement" && id == "new-user")
        );
        assert!(!format!("{display:?}").contains("abandoned"));
        assert!(dir.path().join("legacy.jsonl.pi-v3.bak").is_file());
        assert!(std::fs::read_to_string(&file)
            .unwrap()
            .contains(SESSION_FORMAT));
    }

    #[test]
    fn history_window_keeps_complete_recent_turns() {
        let dir = tempdir();
        let mut session =
            AgentSession::create("window".into(), "/notes".into(), dir.path()).unwrap();
        session.append_message(Message::user("old")).unwrap();
        session
            .append_message(Message::assistant("x".repeat(300_000)))
            .unwrap();
        session.append_message(Message::user("recent")).unwrap();
        session
            .append_message(Message::assistant("answer"))
            .unwrap();
        let history = session.history(0).unwrap();
        assert_eq!(history.len(), 2);
        assert!(
            matches!(&history[0], Message::User { content } if matches!(content.first(), Some(UserContent::Text(text)) if text.text == "recent"))
        );
    }
}
