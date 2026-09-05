//! Model-facing Thread lifecycle control. Schedule control only changes a
//! wake source; this tool uses the same complete cancellation path as the UI.
use crate::memory::{ThreadControlAction, ThreadMutation};
use crate::orchestrator::orchestrator::Orchestrator;
use crate::tool::{Tool, ToolExecutionClass, CURRENT_CAUSAL_ROUTE, CURRENT_CONTEXT_ID};
use serde::Deserialize;
use serde_json::json;
use std::sync::{Arc, OnceLock, Weak};

#[derive(Default)]
pub(crate) struct ThreadControlTool {
    orchestrator: OnceLock<Weak<Orchestrator>>,
}

impl ThreadControlTool {
    pub(crate) fn bind(&self, orchestrator: &Arc<Orchestrator>) {
        self.orchestrator
            .set(Arc::downgrade(orchestrator))
            .expect("Thread control is bound once during Runtime construction");
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Arguments {
    thread_id: String,
    expected_revision: u64,
    action: ThreadControlAction,
    reason: String,
}

#[async_trait::async_trait]
impl Tool for ThreadControlTool {
    fn name(&self) -> &str {
        "thread_control"
    }
    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
    }
    fn definition(&self) -> crate::llm::ToolDefinition {
        crate::llm::ToolDefinition {
            name: self.name().into(),
            description: "Pause, resume, or cancel one existing Thread in the current Context using its latest revision from recall or schedule_tx inspect. To abandon work (including a child that never started), use action=cancel: it atomically closes the Thread, cancels pending schedules/signals, records a terminal outcome and settles its group/dependencies. Running physical work receives cancellation, not rollback. schedule_tx cancel only stops a timer and does NOT cancel the Thread. Stale revisions return conflict; inspect again instead of guessing. Cannot control the current Thread; use its normal completion or Objective control.".into(),
            parameters: json!({"type":"object","properties":{
                "thread_id":{"type":"string","minLength":1},
                "expected_revision":{"type":"integer","minimum":1},
                "action":{"type":"string","enum":["pause","resume","cancel"]},
                "reason":{"type":"string","minLength":1}
            },"required":["thread_id","expected_revision","action","reason"],"additionalProperties":false}),
        }
    }
    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: Arguments = serde_json::from_str(arguments)?;
        if args.thread_id.trim().is_empty()
            || args.reason.trim().is_empty()
            || args.expected_revision == 0
        {
            return Err("Thread control requires an exact Thread ID, positive revision, and non-empty reason".into());
        }
        let context_id = CURRENT_CONTEXT_ID.try_with(Clone::clone)?;
        let route = CURRENT_CAUSAL_ROUTE
            .try_with(Clone::clone)?
            .ok_or("Thread control requires a durable caller route")?;
        if route.thread_id == args.thread_id {
            return Err("thread_control cannot cancel or pause its own executing Thread; finish normally or use Objective control".into());
        }
        let orchestrator = self
            .orchestrator
            .get()
            .and_then(Weak::upgrade)
            .ok_or("Runtime is shutting down")?;
        let mutation = orchestrator
            .control_thread(
                &context_id,
                &args.thread_id,
                args.expected_revision,
                args.action,
                &args.reason,
                "Agent-ThreadControl",
            )
            .await?;
        Ok(match mutation {
            ThreadMutation::Updated(thread) => json!({"status":"ok","scope":"thread","thread":thread,"guidance":"Thread lifecycle control committed. Cancellation is a terminal result, not successful completion of the original task."}),
            ThreadMutation::Conflict { current } => json!({"status":"revision_conflict","current":current,"guidance":"Use current authoritative state; do not replay a stale revision."}),
            ThreadMutation::NotFound => json!({"status":"not_found"}),
        }.to_string())
    }
}
