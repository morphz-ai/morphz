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
                        "description": "完整的 SExpr 心智事务。reason 只能写成 context-tx 的直接子项；正确：(context-tx (base-version 2) (reason \"证据已摘要\") (retire event:1))；错误：(retire event:1 \"证据已摘要\")"
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
        ToolDefinition {
            name: "recall".to_string(),
            description: "按稳定引用或查询词主动读取 Event Ledger 原文及已退役 frame。用于验证摘要、恢复遗忘内容或分段读取被 preview 截断的大型输出；结果只进入 inbox，不会自动写入 Mind。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "通常省略，由 Runtime 注入" },
                    "event_id": { "type": "string", "description": "Context observation 的 full-ref" },
                    "frame_id": { "type": "string", "description": "已存在或已退役的 frame ID" },
                    "query": { "type": "string", "description": "在当前 session Ledger 中搜索" },
                    "offset": { "type": "integer", "minimum": 0, "description": "读取 event 原文的字符偏移" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 20000, "description": "单次返回字符数，默认 4000" }
                }
            }),
        }
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let mut args: RecallArgs = serde_json::from_str(arguments)?;
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
            return event_chunk(event, args.offset.unwrap_or(0), args.limit.unwrap_or(4_000));
        }

        let query = args.query.unwrap_or_default();
        let limit = args.limit.unwrap_or(10).clamp(1, 50);
        let events = self
            .context_engine
            .search_events(&args.session_id, &query, limit)
            .await?;
        let matches = events
            .into_iter()
            .map(|event| {
                let text = recall_event_text(&event);
                let preview = text.chars().take(500).collect::<String>();
                serde_json::json!({
                    "event_id": event.id,
                    "kind": event.event_type,
                    "topic": event.topic,
                    "timestamp": event.timestamp,
                    "preview": preview,
                    "truncated": text.chars().count() > 500,
                })
            })
            .collect::<Vec<_>>();
        Ok(serde_json::to_string_pretty(&serde_json::json!({
            "query": query,
            "matches": matches,
        }))?)
    }
}

fn event_chunk(
    event: Event,
    requested_offset: usize,
    requested_limit: usize,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let text = recall_event_text(&event);
    let total_chars = text.chars().count();
    let offset = requested_offset.min(total_chars);
    let limit = requested_limit.clamp(1, 20_000);
    let chunk = text.chars().skip(offset).take(limit).collect::<String>();
    let next_offset =
        (offset + chunk.chars().count() < total_chars).then_some(offset + chunk.chars().count());
    Ok(serde_json::to_string_pretty(&serde_json::json!({
        "event_id": event.id,
        "kind": event.event_type,
        "topic": event.topic,
        "actor": event.actor,
        "timestamp": event.timestamp,
        "offset": offset,
        "total_chars": total_chars,
        "next_offset": next_offset,
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
        assert_eq!(result["next_offset"], 5);
        assert_eq!(result["total_chars"], 6);
    }
}
