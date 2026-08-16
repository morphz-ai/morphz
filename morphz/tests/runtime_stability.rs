use morphz::config::AppConfig;
use morphz::llm::{
    Client, Message, ModelFailure, ModelFailureKind, Response, ToolCallRepr, ToolDefinition,
};
use morphz::memory::{ExecutionJobFilter, NewSession, QueryFilter, SessionMountKind};
use morphz::permission::PermissionMode;
use morphz::runtime::{MorphzRuntime, RuntimeToolPolicy, SchedulerQuery};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tempfile::TempDir;

const TURN_COUNT: usize = 24;
const TRANSIENT_FAILURE_TURN: usize = 7;

#[derive(Default)]
struct StabilityClient {
    failed_turns: Mutex<HashSet<usize>>,
    requests: AtomicUsize,
    health_probes: AtomicUsize,
}

fn latest_stability_turn(messages: &[Message]) -> Option<usize> {
    let marker = "stability-turn-";
    messages
        .iter()
        .flat_map(|message| {
            message
                .content
                .match_indices(marker)
                .map(move |(offset, _)| {
                    let digits = message.content[offset + marker.len()..]
                        .chars()
                        .take_while(char::is_ascii_digit)
                        .collect::<String>();
                    digits.parse::<usize>().ok()
                })
        })
        .flatten()
        .max()
}

#[async_trait::async_trait]
impl Client for StabilityClient {
    fn supports_async_cancellation(&self) -> bool {
        true
    }

    fn provider_resource_key(&self) -> String {
        "model-provider:runtime-stability".to_string()
    }

    fn model(&self) -> Option<String> {
        Some("stability-fixture".to_string())
    }

    async fn create_completion(
        &self,
        messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        self.requests.fetch_add(1, Ordering::SeqCst);
        let turn = latest_stability_turn(&messages)
            .ok_or("stability request did not carry its durable root input")?;
        if messages.iter().any(|message| message.role == "tool") {
            return Ok(Response {
                content: format!("stability-complete-{turn}"),
                tool_calls: Vec::new(),
            });
        }

        if turn == TRANSIENT_FAILURE_TURN
            && self
                .failed_turns
                .lock()
                .map_err(|_| "stability failure set was poisoned")?
                .insert(turn)
        {
            return Err(Box::new(
                ModelFailure::new(
                    ModelFailureKind::ServerUnavailable,
                    "deterministic one-shot stability outage",
                )
                .with_retry_after(Some(1)),
            ));
        }

        Ok(Response {
            content: String::new(),
            tool_calls: ["fixture-a.txt", "fixture-b.txt"]
                .into_iter()
                .enumerate()
                .map(|(index, path)| ToolCallRepr {
                    id: format!("stability-call-{turn}-{index}"),
                    r#type: "function".to_string(),
                    func_name: "read".to_string(),
                    arguments: json!({"path": path}).to_string(),
                })
                .collect(),
        })
    }

    async fn probe_health(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.health_probes.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

async fn assert_quiescent(runtime: &MorphzRuntime) {
    let snapshot = runtime
        .scheduler_snapshot(
            &runtime.identity().context_id,
            SchedulerQuery {
                include_terminal: false,
                limit: 2_000,
            },
        )
        .await
        .unwrap();
    assert_eq!(snapshot.summary.open_threads, 0, "{snapshot:#?}");
    assert_eq!(snapshot.summary.pending_signals, 0, "{snapshot:#?}");
    assert_eq!(snapshot.summary.queued_activations, 0, "{snapshot:#?}");
    assert_eq!(snapshot.summary.running_activations, 0, "{snapshot:#?}");
    assert_eq!(snapshot.summary.active_jobs, 0, "{snapshot:#?}");
    assert_eq!(snapshot.summary.pending_approvals, 0, "{snapshot:#?}");
    assert_eq!(snapshot.summary.active_schedules, 0, "{snapshot:#?}");
    assert_eq!(snapshot.summary.invariant_violations, 0, "{snapshot:#?}");
    assert!(snapshot.orphan_activations.is_empty(), "{snapshot:#?}");
    assert!(snapshot.orphan_signals.is_empty(), "{snapshot:#?}");
    assert!(snapshot.orphan_jobs.is_empty(), "{snapshot:#?}");
    assert!(snapshot.orphan_approvals.is_empty(), "{snapshot:#?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn repeated_parallel_actions_and_provider_recovery_converge_without_durable_residue() {
    let temp = TempDir::new().unwrap();
    std::fs::write(temp.path().join("fixture-a.txt"), "fixture-a\n").unwrap();
    std::fs::write(temp.path().join("fixture-b.txt"), "fixture-b\n").unwrap();
    let database = temp.path().join("runtime-stability.db");
    let client = Arc::new(StabilityClient::default());
    let mut config = AppConfig::default();
    config.permissions.mode = PermissionMode::FullAccess;
    config.permissions.workspace_root = temp.path().to_string_lossy().into_owned();
    let runtime = MorphzRuntime::builder(config, Arc::clone(&client) as Arc<dyn Client>)
        .database_path(database.to_string_lossy())
        .tool_policy(RuntimeToolPolicy {
            context_only: false,
            coding_eval: false,
        })
        .build()
        .await
        .unwrap();
    runtime.start().await.unwrap();
    let session = runtime
        .ensure_session(NewSession {
            id: "session-runtime-stability".to_string(),
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            parent_session_id: None,
            title: "Runtime stability".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    let mut replies = runtime.subscribe("chat/reply", TURN_COUNT + 8);

    for turn in 0..TURN_COUNT {
        session
            .send(
                format!("stability-turn-{turn}"),
                "Stability-Test",
                Some(format!("stability-client-{turn}")),
            )
            .await
            .unwrap();
        let reply = tokio::time::timeout(Duration::from_secs(8), replies.recv())
            .await
            .unwrap_or_else(|_| panic!("turn {turn} did not converge"))
            .expect("reply stream closed unexpectedly");
        assert_eq!(
            reply
                .payload
                .get("text")
                .and_then(serde_json::Value::as_str),
            Some(format!("stability-complete-{turn}").as_str())
        );
        assert_quiescent(&runtime).await;
    }

    let jobs = runtime
        .list_execution_jobs(ExecutionJobFilter {
            context_id: Some(runtime.identity().context_id.clone()),
            include_terminal: true,
            limit: Some(TURN_COUNT * 2 + 8),
            ..ExecutionJobFilter::default()
        })
        .await
        .unwrap();
    assert_eq!(jobs.len(), TURN_COUNT * 2);
    assert!(jobs.iter().all(|job| job.status.is_terminal()));
    assert!(jobs.iter().all(|job| job.result_event_id.is_some()));

    let replies = runtime
        .query_events(QueryFilter {
            context_id: Some(runtime.identity().context_id.clone()),
            session_id: Some(session.id().to_string()),
            topic: Some("chat/reply".to_string()),
            ..QueryFilter::default()
        })
        .await
        .unwrap();
    assert_eq!(replies.len(), TURN_COUNT);
    let settled_groups = runtime
        .query_events(QueryFilter {
            context_id: Some(runtime.identity().context_id.clone()),
            topic: Some("runtime/action_group_settled".to_string()),
            ..QueryFilter::default()
        })
        .await
        .unwrap();
    assert_eq!(settled_groups.len(), TURN_COUNT);

    let attempt_states = runtime
        .query_events(QueryFilter {
            context_id: Some(runtime.identity().context_id.clone()),
            topic: Some("runtime/model_attempt_state".to_string()),
            ..QueryFilter::default()
        })
        .await
        .unwrap();
    let mut latest_by_attempt = HashMap::new();
    for state in attempt_states {
        let attempt_id = state
            .payload
            .get("attempt_id")
            .and_then(serde_json::Value::as_str)
            .expect("Model Attempt state must carry attempt_id")
            .to_string();
        latest_by_attempt.insert(attempt_id, state);
    }
    assert!(!latest_by_attempt.is_empty());
    assert!(latest_by_attempt.values().all(|state| {
        state
            .payload
            .get("terminal")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
    }));
    assert_eq!(client.failed_turns.lock().unwrap().len(), 1);
    assert_eq!(client.health_probes.load(Ordering::SeqCst), 1);
    assert!(client.requests.load(Ordering::SeqCst) > TURN_COUNT * 2);
}
