use super::{ToolCategory, ToolDisplayStatus};
use serde_json::Value;

pub fn tool_presentation(name: &str, args: &Value) -> (ToolCategory, String) {
    let string = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or("");
    match name {
        "ls" => (ToolCategory::DocumentList, "列出项目笔记".into()),
        "read" => (
            ToolCategory::DocumentRead,
            short_target("读取", string("path")),
        ),
        "find" => (
            ToolCategory::DocumentFind,
            short_target("查找", string("pattern")),
        ),
        "grep" => (
            ToolCategory::DocumentSearch,
            short_target("搜索", string("pattern")),
        ),
        "edit" | "write" => (
            ToolCategory::DocumentWrite,
            short_target("修改", string("path")),
        ),
        "create_piece" => (
            ToolCategory::DocumentCreate,
            short_target("创建", string("title")),
        ),
        "web_search" => (
            ToolCategory::WebSearch,
            short_target("网页搜索", string("query")),
        ),
        "web_fetch" => (ToolCategory::WebFetch, "读取网页".into()),
        "list_tags" => (ToolCategory::Tag, "查看标签".into()),
        "tag_text" => (ToolCategory::Tag, "标注采集区文本".into()),
        "tag_create" => (ToolCategory::Tag, short_target("创建标签", string("name"))),
        "tag_update" => (ToolCategory::Tag, "修改标签".into()),
        "tag_delete" => (ToolCategory::Tag, "删除标签".into()),
        _ => (ToolCategory::Other, name.replace('_', " ")),
    }
}

fn short_target(action: &str, value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        return action.into();
    }
    let short = value.chars().take(48).collect::<String>();
    format!("{action} {short}")
}

pub fn display_status(is_error: bool) -> ToolDisplayStatus {
    if is_error {
        ToolDisplayStatus::Failed
    } else {
        ToolDisplayStatus::Succeeded
    }
}
