//! Stable DTOs shared by the in-process Rust agent and the WebView event API.

use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentEvent {
    Ready,
    SessionOpened {
        conversation_id: String,
        session_file: String,
        messages: Vec<ChatDisplayMessage>,
    },
    SessionSynced {
        conversation_id: String,
        session_file: String,
        messages: Vec<ChatDisplayMessage>,
    },
    Delta {
        request_id: String,
        conversation_id: String,
        text: String,
    },
    ThinkingStart {
        request_id: String,
        conversation_id: String,
        block_id: String,
    },
    ThinkingDelta {
        request_id: String,
        conversation_id: String,
        text: String,
    },
    ThinkingEnd {
        request_id: String,
        conversation_id: String,
    },
    Tool {
        request_id: String,
        conversation_id: String,
        call_id: String,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        category: Option<ToolCategory>,
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        phase: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
    },
    Done {
        request_id: String,
        conversation_id: String,
        #[serde(default)]
        outcome: AgentOutcome,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Title {
        conversation_id: String,
        title: String,
    },
    Error {
        request_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        conversation_id: Option<String>,
        message: String,
    },
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentOutcome {
    #[default]
    Completed,
    Cancelled,
    Failed,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptRef {
    pub kind: String,
    pub id: String,
    pub display: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note_kind: Option<String>,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptSkill {
    pub name: String,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(
    tag = "role",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ChatDisplayMessage {
    User {
        text: String,
        timestamp: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        entry_id: Option<String>,
    },
    Assistant {
        blocks: Vec<ChatDisplayBlock>,
        timestamp: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        entry_id: Option<String>,
    },
    Error {
        text: String,
        timestamp: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        entry_id: Option<String>,
    },
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ChatDisplayBlock {
    Text {
        text: String,
    },
    Thinking {
        text: String,
    },
    Tool {
        call_id: String,
        name: String,
        category: ToolCategory,
        label: String,
        status: ToolDisplayStatus,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ToolDisplayStatus {
    Succeeded,
    Failed,
    Incomplete,
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolCategory {
    Skill,
    DocumentRead,
    DocumentList,
    DocumentFind,
    DocumentSearch,
    WebSearch,
    WebFetch,
    DocumentWrite,
    DocumentCreate,
    Tag,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveNote {
    pub dir: String,
    pub note_id: String,
    pub path: String,
    pub kind: String,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub path: String,
    pub kind: String,
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MutationOperation {
    Create,
    Edit,
    Rewrite,
    Tag,
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WriteMode {
    Direct,
    Snapshot,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum EditPreviewDetail {
    Diff {
        hunks: String,
    },
    TagAssign {
        text_excerpt: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target_text: Option<String>,
        annotation_count: u32,
        action: String,
        tag_name: String,
        tag_color: String,
    },
    TagCreate {
        tag_name: String,
        tag_color: String,
    },
    TagUpdate {
        tag_id: String,
        old_name: String,
        old_color: String,
        new_name: String,
        new_color: String,
    },
    NoteCreate {
        filename: String,
        content_preview: String,
    },
    TagDelete {
        tag_name: String,
        annotation_count: u32,
    },
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditPreview {
    pub tool: String,
    pub summary: String,
    pub detail: EditPreviewDetail,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NoteUpdated {
    pub note_id: String,
    pub path: String,
    pub version: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn events_keep_the_frontend_wire_shape() {
        let value = serde_json::to_value(AgentEvent::ThinkingStart {
            request_id: "r1".into(),
            conversation_id: "c1".into(),
            block_id: "b1".into(),
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({"type":"thinking_start","requestId":"r1","conversationId":"c1","blockId":"b1"})
        );
    }
    #[test]
    fn previews_use_snake_case_tags_and_camel_case_fields() {
        let value = serde_json::to_value(EditPreviewDetail::TagDelete {
            tag_name: "x".into(),
            annotation_count: 2,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({"kind":"tag_delete","tagName":"x","annotationCount":2})
        );
    }
}
