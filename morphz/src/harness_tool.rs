//! Model-visible, compact Harness discovery and Evaluation selection tools.
//!
//! The Runtime deliberately exposes descriptors rather than mounting the full
//! package catalog into every Context Encoding.  Selection is exact-version
//! and immutable for one Evaluation.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::json;

use crate::harness::HarnessRegistry;
use crate::harness_package::{load_evaluation_harness_binding, persist_evaluation_harness_binding};
use crate::llm::ToolDefinition;
use crate::memory::EventStore;
use crate::objective::ObjectiveEvaluationRegistry;
use crate::tool::{
    Tool, ToolExecutionClass, CURRENT_ATTEMPT_ID, CURRENT_CAUSAL_ROUTE, CURRENT_CONTEXT_ID,
};

type DynError = Box<dyn std::error::Error + Send + Sync>;

pub struct HarnessListTool {
    registry: Arc<HarnessRegistry>,
}

impl HarnessListTool {
    pub fn new(registry: Arc<HarnessRegistry>) -> Self {
        Self { registry }
    }
}

#[async_trait::async_trait]
impl Tool for HarnessListTool {
    fn name(&self) -> &str {
        "harness_list"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: "List installed Runtime Harnesses on demand, including exact versions, titles, and compact capability indexes. Use this when the current work may benefit from a domain Harness but no suitable Harness is mounted in Context. Do not call it for ordinary conversation. The detailed Contract is mounted only in a subsequent Evaluation after selection.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        }
    }

    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
    }

    async fn execute(&self, arguments: &str) -> Result<String, DynError> {
        let value: serde_json::Value = serde_json::from_str(arguments)?;
        if value.as_object().is_none_or(|object| !object.is_empty()) {
            return Err("harness_list 不接受参数".into());
        }
        Ok(serde_json::to_string_pretty(&json!({
            "harnesses": self.registry.descriptors(),
            "selection": "Use harness_select with an exact id and version. Each Evaluation may have only one Primary Harness."
        }))?)
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HarnessSelectArgs {
    id: String,
    version: String,
    reason: String,
}

pub struct HarnessSelectTool {
    registry: Arc<HarnessRegistry>,
    store: Arc<dyn EventStore>,
    objective_evaluations: Arc<ObjectiveEvaluationRegistry>,
}

impl HarnessSelectTool {
    pub fn new(
        registry: Arc<HarnessRegistry>,
        store: Arc<dyn EventStore>,
        objective_evaluations: Arc<ObjectiveEvaluationRegistry>,
    ) -> Self {
        Self {
            registry,
            store,
            objective_evaluations,
        }
    }
}

#[async_trait::async_trait]
impl Tool for HarnessSelectTool {
    fn name(&self) -> &str {
        "harness_select"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: "Select one installed Primary Harness for the current Runtime Evaluation. Selection is persisted by exact id and version and cannot be rebound. The result starts a subsequent Evaluation in which the Runtime mounts that Harness's Contract, Mind, and eval or infer entry. Do not call this for ordinary conversation or when a suitable Harness is already mounted.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "minLength": 1,
                        "description": "The exact Harness ID returned by harness_list"
                    },
                    "version": {
                        "type": "string",
                        "minLength": 1,
                        "description": "The exact version returned by harness_list; the Runtime does not guess latest"
                    },
                    "reason": {
                        "type": "string",
                        "minLength": 1,
                        "description": "A short reason why this Harness fits the current Evaluation"
                    }
                },
                "required": ["id", "version", "reason"],
                "additionalProperties": false
            }),
        }
    }

    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
    }

    async fn execute(&self, arguments: &str) -> Result<String, DynError> {
        let args: HarnessSelectArgs = serde_json::from_str(arguments)?;
        let id = args.id.trim();
        let version = args.version.trim();
        let reason = args.reason.trim();
        if id.is_empty() || version.is_empty() || reason.is_empty() {
            return Err("harness_select.id/version/reason 不能为空".into());
        }
        if reason.chars().count() > 4_000 {
            return Err("harness_select.reason 超过 4,000 字符上限".into());
        }
        let context_id = CURRENT_CONTEXT_ID
            .try_with(Clone::clone)
            .map_err(|_| "harness_select 缺少当前 Context 路由")?;
        let activation_id = CURRENT_ATTEMPT_ID
            .try_with(Clone::clone)
            .map_err(|_| "harness_select 缺少当前 Evaluation 路由")?;
        let active = self
            .objective_evaluations
            .get_for_activation(&activation_id);
        let ordinary_evaluation_id = CURRENT_CAUSAL_ROUTE
            .try_with(Clone::clone)
            .ok()
            .flatten()
            .map(|route| route.root_turn_id);
        let evaluation_id = active
            .as_ref()
            .map(|item| item.evaluation_id.as_str())
            .or(ordinary_evaluation_id.as_deref())
            // This fallback only applies to an embedding that executes a
            // logical tool without installing the normal causal route.
            .unwrap_or(activation_id.as_str());

        if let Some(existing) =
            load_evaluation_harness_binding(self.store.as_ref(), evaluation_id).await?
        {
            if existing.harness_id != id || existing.harness_version != version {
                return Err(format!(
                    "当前 Evaluation 已绑定 '{}@{}'，不能改绑为 '{}@{}'",
                    existing.harness_id, existing.harness_version, id, version
                )
                .into());
            }
            return Ok(serde_json::to_string_pretty(&json!({
                "status": "already_selected",
                "binding": existing,
                "guidance": "The current Evaluation already uses this Harness. Do not select it again; continue the work."
            }))?);
        }

        let harness = self
            .registry
            .get(id, version)
            .ok_or_else(|| format!("Harness '{id}@{version}' 未安装；先调用 harness_list"))?;
        let binding = persist_evaluation_harness_binding(
            self.store.as_ref(),
            &context_id,
            evaluation_id,
            active.as_ref().map(|item| item.objective_id.as_str()),
            None,
            harness.as_ref(),
        )
        .await?;
        Ok(serde_json::to_string_pretty(&json!({
            "status": "selected",
            "binding": binding,
            "reason": reason,
            "guidance": "The selection is durable. This tool result triggers a subsequent Evaluation where the Runtime mounts the Harness. Do not call harness_select again."
        }))?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness_package::HarnessPackage;
    use crate::memory::sqlite::SqliteStore;

    const PACKAGE: &str = r#"
        (manifest
          (id coding)
          (version "1.0.0")
          (title "Coding")
          (capabilities (tools read write) (skills rust)))
        (contract (identity "coding"))
        (infer (requires (tools)) (task "work carefully") (returns String))
    "#;

    #[tokio::test]
    async fn tools_discover_and_immutably_select_exact_evaluation_harness() {
        let registry = Arc::new(HarnessRegistry::default());
        registry
            .register_package(HarnessPackage::from_source("coding.hns", PACKAGE).unwrap())
            .unwrap();
        // SqliteStore uses multiple pooled connections, so `:memory:` would
        // create one private database per connection.  A temporary file keeps
        // the migration/schema visible to the whole pool just like production.
        let database = tempfile::NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_string_lossy().as_ref())
                .await
                .unwrap(),
        );
        let list = HarnessListTool::new(Arc::clone(&registry));
        let catalog = list.execute("{}").await.unwrap();
        assert!(catalog.contains("coding"));
        assert!(!catalog.contains("work carefully"));

        let select = HarnessSelectTool::new(
            Arc::clone(&registry),
            Arc::clone(&store) as Arc<dyn EventStore>,
            Arc::new(ObjectiveEvaluationRegistry::default()),
        );
        let arguments = json!({
            "id": "coding",
            "version": "1.0.0",
            "reason": "当前工作需要 Coding 纪律"
        })
        .to_string();
        let selected = CURRENT_CONTEXT_ID
            .scope("context-1".to_string(), async {
                CURRENT_ATTEMPT_ID
                    .scope("activation-1".to_string(), async {
                        CURRENT_CAUSAL_ROUTE
                            .scope(
                                Some(crate::tool::ToolCausalRoute {
                                    thread_id: "thread-1".to_string(),
                                    activation_id: "activation-1".to_string(),
                                    root_turn_id: "turn-1".to_string(),
                                    trigger_event_id: "message-1".to_string(),
                                    trigger_sequence: 1,
                                }),
                                async { select.execute(&arguments).await },
                            )
                            .await
                    })
                    .await
            })
            .await
            .unwrap();
        assert!(selected.contains("\"status\": \"selected\""));

        let repeated = CURRENT_CONTEXT_ID
            .scope("context-1".to_string(), async {
                CURRENT_ATTEMPT_ID
                    .scope("activation-1".to_string(), async {
                        CURRENT_CAUSAL_ROUTE
                            .scope(
                                Some(crate::tool::ToolCausalRoute {
                                    thread_id: "thread-1".to_string(),
                                    activation_id: "activation-1".to_string(),
                                    root_turn_id: "turn-1".to_string(),
                                    trigger_event_id: "message-1".to_string(),
                                    trigger_sequence: 1,
                                }),
                                async { select.execute(&arguments).await },
                            )
                            .await
                    })
                    .await
            })
            .await
            .unwrap();
        assert!(repeated.contains("already_selected"));
        let binding = load_evaluation_harness_binding(store.as_ref(), "turn-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(binding.harness_id, "coding");
        assert_eq!(binding.evaluation_id.as_deref(), Some("turn-1"));
    }
}
