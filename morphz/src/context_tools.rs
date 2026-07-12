use crate::event::Event;
use crate::llm::ToolDefinition;
use crate::orchestrator::context::{context_tx_tool_description, ContextEngine};
use crate::tool::{Tool, CURRENT_SESSION_ID};
use serde::Deserialize;
use std::sync::Arc;

pub struct ContextTxTool {
    context_engine: Arc<ContextEngine>,
}

impl ContextTxTool {
    pub fn new(context_engine: Arc<ContextEngine>) -> Self {
        Self { context_engine }
    }
}

#[derive(Deserialize)]
struct ContextTxArgs {
    #[serde(default)]
    session_id: String,
    transaction: String,
}

#[async_trait::async_trait]
impl Tool for ContextTxTool {
    fn name(&self) -> &str {
        "context_tx"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "context_tx".to_string(),
            description: context_tx_tool_description(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "description": "当前 session ID；通常可省略，Runtime 会注入当前 session"
                    },
                    "transaction": {
                        "type": "string",
                        "description": "完整的单个 SExpr 心智事务。create/derive/revise 可直接并列一个或多个 BODY，Runtime 会把多项规范化为 (context-body BODY...)；create 不接受 from，有来源时使用 derive，derive/revise 的 (from SOURCE...) 必须紧跟 ID。一个 transaction 可包含多个 create/derive/revise/retire/restore/protect/unprotect/place/relate/unrelate，并整体原子提交；不要为多个修改并行调用多次 context_tx。reason 只能写成 context-tx 的直接子项；示例：(context-tx (base-version 2) (reason \"完成收口\") (revise task (status completed) (next none)) (derive result (from @e27) (tests passed) (confidence high)) (protect task result) (retire @e21 @e22))"
                    }
                },
                "required": ["transaction"]
            }),
        }
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let mut args: ContextTxArgs = serde_json::from_str(arguments)?;
        if args.session_id.trim().is_empty() {
            args.session_id = CURRENT_SESSION_ID
                .try_with(Clone::clone)
                .map_err(|_| "context_tx 缺少 session_id，且 Runtime 未注入当前 session")?;
        }
        let commit = self
            .context_engine
            .apply_transaction(&args.session_id, &args.transaction)
            .await?;
        Ok(serde_json::to_string_pretty(&serde_json::json!({
            "status": "committed",
            "transaction_id": commit.transaction_id,
            "before_version": commit.before_version,
            "after_version": commit.after_version,
            "reason": commit.reason,
            "changes": commit.changes,
        }))?)
    }
}

pub struct RecallTool {
    context_engine: Arc<ContextEngine>,
}

impl RecallTool {
    pub fn new(context_engine: Arc<ContextEngine>) -> Self {
        Self { context_engine }
    }
}

#[derive(Default, Deserialize)]
struct RecallArgs {
    #[serde(default)]
    session_id: String,
    event_id: Option<String>,
    frame_id: Option<String>,
    query: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
}

#[async_trait::async_trait]
impl Tool for RecallTool {
    fn name(&self) -> &str {
        "recall"
    }

    fn definition(&self) -> ToolDefinition {
        let max_chunk_chars = self.context_engine.recall_chunk_chars();
        ToolDefinition {
            name: "recall".to_string(),
            description: format!("按稳定短引用或查询词主动读取 Event Ledger 原文及已退役 frame。Context 中 observation 的 ref 形如 @e27，由 Ledger sequence 确定性派生；event_id 参数优先使用该 ref，Runtime 会解析为完整 ID。用于验证摘要、恢复遗忘内容或分段读取被 preview 截断的大型输出；结果只进入 inbox，不会自动写入 Mind。event_id 模式单次最多返回 {max_chunk_chars} 个字符；如果 next_offset 非空，下一次必须把它原样作为 offset 继续读取，不要重复 offset=0 或猜测偏移。query 模式返回命中位置附近的片段和建议 offset。"),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "通常省略，由 Runtime 注入" },
                    "event_id": { "type": "string", "description": "Context observation 的稳定短 ref（如 @e27）；兼容完整 Ledger event ID" },
                    "frame_id": { "type": "string", "description": "已存在或已退役的 frame ID" },
                    "query": { "type": "string", "description": "在当前 session Ledger 中搜索" },
                    "offset": { "type": "integer", "minimum": 0, "description": "读取 event 原文的字符偏移；连续分页时必须使用上次结果的 next_offset" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": max_chunk_chars, "description": format!("单次返回字符数，上限 {max_chunk_chars}") }
                }
            }),
        }
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let mut args: RecallArgs = serde_json::from_str(arguments)?;
        args.event_id = non_empty(args.event_id);
        args.frame_id = non_empty(args.frame_id);
        args.query = non_empty(args.query);
        if args.session_id.trim().is_empty() {
            args.session_id = CURRENT_SESSION_ID
                .try_with(Clone::clone)
                .map_err(|_| "recall 缺少 session_id，且 Runtime 未注入当前 session")?;
        }
        let selected = usize::from(args.event_id.is_some())
            + usize::from(args.frame_id.is_some())
            + usize::from(args.query.is_some());
        if selected != 1 {
            return Err("recall 必须且只能提供 event_id、frame_id、query 其中之一".into());
        }

        if let Some(frame_id) = args.frame_id {
            let frame = self
                .context_engine
                .find_frame(&args.session_id, &frame_id)
                .await?
                .ok_or_else(|| format!("frame '{}' 不存在", frame_id))?;
            return Ok(serde_json::to_string_pretty(&frame)?);
        }

        if let Some(event_id) = args.event_id {
            let event = self
                .context_engine
                .find_event(&args.session_id, &event_id)
                .await?
                .ok_or_else(|| format!("event '{}' 不存在或不属于当前 session", event_id))?;
            let event_reference = self.context_engine.event_reference(&event);
            return event_chunk(
                event,
                event_reference,
                args.offset.unwrap_or(0),
                args.limit.unwrap_or(4_000),
                self.context_engine.recall_chunk_chars(),
            );
        }

        let query = args.query.unwrap_or_default();
        let limit = args.limit.unwrap_or(10).clamp(1, 50);
        let events = self
            .context_engine
            .search_events(&args.session_id, &query, limit)
            .await?;
        let max_chunk_chars = self.context_engine.recall_chunk_chars();
        let matches = events
            .into_iter()
            .map(|event| {
                let event_reference = self.context_engine.event_reference(&event);
                let text = recall_event_text(&event);
                let (preview, match_offset) = query_preview(&text, &query, 500);
                let suggested_offset = match_offset.map(|offset| offset.saturating_sub(250));
                serde_json::json!({
                    "event_id": event_reference,
                    "kind": event.event_type,
                    "topic": event.topic,
                    "timestamp": event.timestamp,
                    "preview": preview,
                    "truncated": text.chars().count() > 500,
                    "match_offset": match_offset,
                    "suggested_recall": suggested_offset.map(|offset| serde_json::json!({
                        "event_id": event_reference,
                        "offset": offset,
                        "limit": max_chunk_chars,
                    })),
                })
            })
            .collect::<Vec<_>>();
        Ok(serde_json::to_string_pretty(&serde_json::json!({
            "query": query,
            "matches": matches,
        }))?)
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn event_chunk(
    event: Event,
    event_reference: String,
    requested_offset: usize,
    requested_limit: usize,
    max_visible_chars: usize,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let text = recall_event_text(&event);
    let total_chars = text.chars().count();
    let offset = requested_offset.min(total_chars);
    let limit = requested_limit
        .clamp(1, 20_000)
        .min(max_visible_chars.max(1));
    let chunk = text.chars().skip(offset).take(limit).collect::<String>();
    let next_offset =
        (offset + chunk.chars().count() < total_chars).then_some(offset + chunk.chars().count());
    Ok(serde_json::to_string_pretty(&serde_json::json!({
        "context_delivery": "full-event-chunk",
        "event_id": event_reference,
        "kind": event.event_type,
        "topic": event.topic,
        "actor": event.actor,
        "timestamp": event.timestamp,
        "offset": offset,
        "total_chars": total_chars,
        "next_offset": next_offset,
        "paging_instruction": next_offset.map(|next| format!("下一次对同一 event_id 使用 offset={next}")),
        "text": chunk,
    }))?)
}

fn recall_event_text(event: &Event) -> String {
    event
        .payload
        .get("text")
        .or_else(|| event.payload.get("delegation"))
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned)
        .or_else(|| event.payload.get("tool_calls").map(ToString::to_string))
        .unwrap_or_else(|| serde_json::Value::Object(event.payload.clone()).to_string())
}

fn query_preview(text: &str, query: &str, width: usize) -> (String, Option<usize>) {
    let chars = text.chars().collect::<Vec<_>>();
    let query_chars = query.chars().collect::<Vec<_>>();
    if query_chars.is_empty() || query_chars.len() > chars.len() {
        return (chars.into_iter().take(width).collect(), None);
    }
    let match_offset = chars
        .windows(query_chars.len())
        .position(|window| window == query_chars.as_slice());
    let Some(match_offset) = match_offset else {
        return (chars.into_iter().take(width).collect(), None);
    };
    let start = match_offset.saturating_sub(width / 2);
    let end = (start + width).min(chars.len());
    (chars[start..end].iter().collect(), Some(match_offset))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::OrchestratorConfig;
    use crate::memory::sqlite::SqliteStore;
    use crate::memory::EventStore;
    use tempfile::TempDir;

    #[tokio::test]
    async fn context_tx_tool_commits_versioned_frame() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("context-tool.db");
        let store = Arc::new(SqliteStore::new(db.to_str().unwrap()).await.unwrap());
        let engine = Arc::new(ContextEngine::new(
            Arc::clone(&store) as Arc<dyn EventStore>,
            OrchestratorConfig::default(),
        ));
        let tool = ContextTxTool::new(Arc::clone(&engine));
        let definition = tool.definition();
        assert!(definition.parameters["properties"]["final_reply"].is_null());
        assert_eq!(
            definition.parameters["required"],
            serde_json::json!(["transaction"])
        );
        let result = tool
            .execute(
                &serde_json::json!({
                    "session_id": "session_test",
                    "transaction": "(context-tx (base-version 0) (create objective (goal \"test\")))"
                })
                .to_string(),
            )
            .await
            .unwrap();

        assert!(result.contains("committed"));
        let view = engine.build_view("session_test").await.unwrap();
        assert_eq!(view.state.version, 1);
        assert_eq!(view.state.frames[0].id, "objective");
    }

    #[tokio::test]
    async fn recall_reads_exact_event_in_unicode_safe_chunks() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("recall-tool.db");
        let store = Arc::new(SqliteStore::new(db.to_str().unwrap()).await.unwrap());
        store
            .append(Event::new(
                "event:unicode".to_string(),
                "User".to_string(),
                crate::event::TYPE_USER_MESSAGE.to_string(),
                "chat/user_message".to_string(),
                vec![
                    (
                        "session_id".to_string(),
                        serde_json::json!("recall-session"),
                    ),
                    ("text".to_string(), serde_json::json!("甲乙丙丁戊己")),
                ]
                .into_iter()
                .collect(),
            ))
            .await
            .unwrap();
        let engine = Arc::new(ContextEngine::new(
            Arc::clone(&store) as Arc<dyn EventStore>,
            OrchestratorConfig::default(),
        ));
        let tool = RecallTool::new(engine);
        let result = tool
            .execute(
                &serde_json::json!({
                    "session_id": "recall-session",
                    "event_id": "event:unicode",
                    "offset": 2,
                    "limit": 3
                })
                .to_string(),
            )
            .await
            .unwrap();
        let result: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(result["text"], "丙丁戊");
        assert_eq!(result["event_id"], "@e1");
        assert_eq!(result["next_offset"], 5);
        assert_eq!(result["total_chars"], 6);

        let aliased = tool
            .execute(
                &serde_json::json!({
                    "session_id": "recall-session",
                    "event_id": "@e1",
                    "offset": 0,
                    "limit": 2
                })
                .to_string(),
            )
            .await
            .unwrap();
        let aliased: serde_json::Value = serde_json::from_str(&aliased).unwrap();
        assert_eq!(aliased["text"], "甲乙");
        assert_eq!(aliased["event_id"], "@e1");
    }

    #[tokio::test]
    async fn recall_ignores_empty_optional_selector_fields_from_compatible_proxies() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("recall-empty-fields.db");
        let store = Arc::new(SqliteStore::new(db.to_str().unwrap()).await.unwrap());
        store
            .append(Event::new(
                "event:source".to_string(),
                "Tool".to_string(),
                crate::event::TYPE_TOOL_OUTPUT.to_string(),
                "chat/tool_output".to_string(),
                vec![
                    (
                        "session_id".to_string(),
                        serde_json::json!("recall-session"),
                    ),
                    ("text".to_string(), serde_json::json!("evidence")),
                ]
                .into_iter()
                .collect(),
            ))
            .await
            .unwrap();
        let engine = Arc::new(ContextEngine::new(
            Arc::clone(&store) as Arc<dyn EventStore>,
            OrchestratorConfig::default(),
        ));
        let result = RecallTool::new(engine)
            .execute(
                &serde_json::json!({
                    "session_id": "recall-session",
                    "event_id": "event:source",
                    "frame_id": "",
                    "query": "",
                    "offset": 0,
                    "limit": 100
                })
                .to_string(),
            )
            .await
            .unwrap();
        assert!(result.contains("evidence"));
    }

    #[test]
    fn query_preview_is_centered_on_the_match_and_reports_character_offset() {
        let text = format!("{}LANTERN-731{}", "前".repeat(800), "后".repeat(800));
        let (preview, offset) = query_preview(&text, "LANTERN-731", 500);
        assert_eq!(offset, Some(800));
        assert!(preview.contains("LANTERN-731"));
        assert_eq!(preview.chars().count(), 500);
    }
}
