//! Process-local ownership of child Plan execution stacks. Durable Plan rows
//! remain authoritative; this registry only coalesces repeated recovery wakes.
use dashmap::{mapref::entry::Entry, DashMap};
use std::sync::Arc;
use tokio::sync::Notify;

pub(super) fn recovery_uses_child_handoff(
    activation: &crate::memory::ThreadActivationRecord,
    thread: &crate::memory::ThreadRecord,
) -> Result<bool, super::DynError> {
    if thread.root_turn_id != activation.root_turn_id
        || thread.agent_id != activation.agent_id
        || thread.context_id != activation.context_id
        || thread.session_id != activation.session_id
        || thread.initiating_principal_id != activation.initiating_principal_id
    {
        return Err("Activation recovery and durable Thread routes differ".into());
    }
    if thread.executor_kind != "plan_infer" {
        return Ok(false);
    }
    if thread
        .executor_id
        .as_ref()
        .is_none_or(|id| id.trim().is_empty())
    {
        return Err("Recovered infer Thread is missing its parent Plan identity".into());
    }
    Ok(true)
}

/// Parallel Plan joins use branch-result Events and their Plan coordinator,
/// not the ordinary assistant/tool-output batch recovery protocol. Classify
/// from the persisted control intent, with exact identity and route checks;
/// an ID prefix alone is not sufficient to skip ordinary recovery.
pub(super) fn uses_plan_group_recovery(
    group: &crate::memory::ActionGroupRecord,
    source: Option<&crate::event::Event>,
) -> Result<bool, super::DynError> {
    let Some(source) = source.filter(|e| e.topic == "runtime/plan_parallel_request") else {
        return Ok(false);
    };
    let text = |key: &str| source.payload.get(key).and_then(serde_json::Value::as_str);
    let plan = text("plan_execution_id").ok_or("Plan join intent has no Plan identity")?;
    let sequence = source
        .payload
        .get("effect_sequence")
        .and_then(serde_json::Value::as_u64)
        .ok_or("Plan join intent has no effect sequence")?;
    if source.id != group.assistant_call_event_id
        || source.id != format!("plan_par_request_{plan}_{sequence}")
        || crate::plan_execution::deterministic_plan_parallel_group_id(plan, sequence)? != group.id
        || text("action_group_id") != Some(group.id.as_str())
        || text("attempt_id") != Some(group.activation_id.as_str())
        || text("thread_id") != Some(group.thread_id.as_str())
        || text("context_id") != Some(group.context_id.as_str())
        || text("session_id") != Some(group.session_id.as_str())
        || source
            .payload
            .get("branches")
            .and_then(serde_json::Value::as_array)
            .is_none_or(|branches| branches.len() as u64 != group.member_count)
    {
        return Err("Plan join intent does not match its durable Action Group".into());
    }
    Ok(true)
}

#[derive(Clone, Default)]
pub(super) struct PlanChildRunners {
    active: Arc<DashMap<String, ()>>,
}

impl PlanChildRunners {
    pub(super) fn contains(&self, id: &str) -> bool {
        self.active.contains_key(id)
    }
    /// Register before spawning, not inside the task: two concurrent recovery
    /// passes must not both enqueue a runner before either task gets polled.
    pub(super) fn register(&self, id: &str, wakeup: Arc<Notify>) -> Option<PlanChildRun> {
        match self.active.entry(id.to_owned()) {
            Entry::Occupied(_) => None,
            Entry::Vacant(entry) => {
                entry.insert(());
                Some(PlanChildRun {
                    active: Arc::clone(&self.active),
                    id: id.to_owned(),
                    wakeup,
                })
            }
        }
    }

    #[cfg(any(feature = "remote-store", test))]
    pub(super) fn len(&self) -> usize {
        self.active.len()
    }
}

pub(super) struct PlanChildRun {
    active: Arc<DashMap<String, ()>>,
    id: String,
    wakeup: Arc<Notify>,
}

impl Drop for PlanChildRun {
    fn drop(&mut self) {
        // No external removal is exposed: a stale guard cannot erase a new
        // owner. Drop also covers panic and abort, including before first poll.
        self.active.remove(&self.id);
        self.wakeup.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::Barrier;

    #[test]
    fn recovery_child_lane_comes_only_from_the_matching_durable_thread() {
        use crate::memory::{ThreadActivationRecord, ThreadRecord, ThreadSupervision};
        use serde_json::json;
        let now = chrono::Utc::now();
        let activation: ThreadActivationRecord = serde_json::from_value(json!({
            "id": "activation", "revision": 2, "generation": 1,
            "agent_id": "agent", "context_id": "context", "session_id": "session",
            "initiating_principal_id": "principal", "root_turn_id": "root",
            "trigger_event_id": "output", "trigger_sequence": 2,
            "trigger_kind": "chat/tool_output", "status": "queued",
            "created_at": now, "updated_at": now,
        }))
        .unwrap();
        let thread: ThreadRecord = serde_json::from_value(json!({
            "id": "thread", "revision": 1, "generation": 1,
            "agent_id": "agent", "context_id": "context", "session_id": "session",
            "initiating_principal_id": "principal", "root_turn_id": "root",
            "kind": "execution", "lifecycle": "open", "control_state": "active",
            "executor_kind": "plan_infer", "executor_id": "parent-plan",
            "supervision": ThreadSupervision::runtime("test"),
            "delivery_status": "none", "created_at": now, "updated_at": now,
        }))
        .unwrap();
        // Continuation inputs need not themselves be infer-request Events.
        assert!(recovery_uses_child_handoff(&activation, &thread).unwrap());
        let mut ordinary = thread.clone();
        ordinary.executor_kind = "self".into();
        let mut infer_named = activation.clone();
        infer_named.id = "infer_request_looks_like_a_child".into();
        infer_named.trigger_kind = "chat/infer_request".into();
        assert!(!recovery_uses_child_handoff(&infer_named, &ordinary).unwrap());
        for key in [
            "root_turn_id",
            "agent_id",
            "context_id",
            "session_id",
            "initiating_principal_id",
        ] {
            let mut wrong = serde_json::to_value(&thread).unwrap();
            wrong[key] = json!("unrelated");
            assert!(
                recovery_uses_child_handoff(&activation, &serde_json::from_value(wrong).unwrap())
                    .is_err(),
                "{key}"
            );
        }
        for id in [None, Some("".to_string()), Some("   ".to_string())] {
            let mut wrong = thread.clone();
            wrong.executor_id = id;
            assert!(recovery_uses_child_handoff(&activation, &wrong).is_err());
        }
    }

    #[test]
    fn plan_group_recovery_requires_the_exact_durable_intent() {
        use crate::memory::{ActionGroupRecord, ActionGroupStatus};
        use serde_json::json;
        let now = chrono::Utc::now();
        let group = ActionGroupRecord {
            id: crate::plan_execution::deterministic_plan_parallel_group_id("plan-test", 1)
                .unwrap(),
            revision: 1,
            activation_id: "activation".into(),
            thread_id: "thread".into(),
            agent_id: "agent".into(),
            context_id: "context".into(),
            session_id: "session".into(),
            assistant_call_event_id: "plan_par_request_plan-test_1".into(),
            objective_id: None,
            objective_evaluation_id: None,
            objective_revision: None,
            status: ActionGroupStatus::Running,
            member_count: 2,
            terminal_member_count: 0,
            created_at: now,
            updated_at: now,
            settled_at: None,
        };
        let event = crate::event::Event::new(
            group.assistant_call_event_id.clone(),
            "Runtime-Yao".into(),
            "runtime_control".into(),
            "runtime/plan_parallel_request".into(),
            json!({
                "context_id": group.context_id, "session_id": group.session_id,
                "thread_id": group.thread_id, "attempt_id": group.activation_id,
                "action_group_id": group.id, "plan_execution_id": "plan-test",
                "effect_sequence": 1, "branches": ["one", "two"],
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        assert!(uses_plan_group_recovery(&group, Some(&event)).unwrap());
        assert!(!uses_plan_group_recovery(&group, None).unwrap());
        let mut ordinary = event.clone();
        ordinary.topic = "chat/assistant_call".into();
        assert!(!uses_plan_group_recovery(&group, Some(&ordinary)).unwrap());
        for key in [
            "context_id",
            "session_id",
            "thread_id",
            "attempt_id",
            "action_group_id",
            "plan_execution_id",
        ] {
            let mut wrong = event.clone();
            wrong.payload.insert(key.into(), json!("wrong"));
            assert!(
                uses_plan_group_recovery(&group, Some(&wrong)).is_err(),
                "{key}"
            );
        }
        let mut wrong = event.clone();
        wrong.payload.insert("branches".into(), json!(["one"]));
        assert!(uses_plan_group_recovery(&group, Some(&wrong)).is_err());
        wrong = event;
        wrong.payload.insert("effect_sequence".into(), json!(2));
        assert!(uses_plan_group_recovery(&group, Some(&wrong)).is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_recovery_registers_one_child_stack() {
        let runners = PlanChildRunners::default();
        let wakeup = Arc::new(Notify::new());
        let ready = Arc::new(Barrier::new(33));
        let attempted = Arc::new(Barrier::new(33));
        let release = Arc::new(Barrier::new(33));
        let owners = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..32 {
            let (runners, wakeup, ready, attempted, release, owners) = (
                runners.clone(),
                wakeup.clone(),
                ready.clone(),
                attempted.clone(),
                release.clone(),
                owners.clone(),
            );
            tasks.push(tokio::spawn(async move {
                ready.wait().await;
                let guard = runners.register("same-plan", wakeup);
                if guard.is_some() {
                    owners.fetch_add(1, Ordering::SeqCst);
                }
                attempted.wait().await;
                release.wait().await;
                drop(guard);
            }));
        }
        ready.wait().await;
        attempted.wait().await;
        assert_eq!(owners.load(Ordering::SeqCst), 1);
        assert_eq!(runners.len(), 1);
        // A different Plan is independent; this is not a global execution lock.
        let other = runners.register("other-plan", wakeup.clone()).unwrap();
        assert_eq!(runners.len(), 2);
        release.wait().await;
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(runners.len(), 1);
        drop(other);
        assert_eq!(runners.len(), 0);
        tokio::time::timeout(std::time::Duration::from_secs(1), wakeup.notified())
            .await
            .unwrap();
        assert!(runners.register("same-plan", wakeup).is_some());
    }

    #[tokio::test]
    async fn dropping_unpolled_or_aborted_child_releases_registration() {
        let runners = PlanChildRunners::default();
        let wakeup = Arc::new(Notify::new());
        let guard = runners.register("unpolled", wakeup.clone()).unwrap();
        let future = async move {
            let _guard = guard;
            std::future::pending::<()>().await;
        };
        drop(future);
        assert_eq!(runners.len(), 0);
        let guard = runners.register("aborted", wakeup).unwrap();
        let (entered, running) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _guard = guard;
            entered.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        running.await.unwrap();
        assert_eq!(runners.len(), 1);
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(runners.len(), 0);
    }

    #[tokio::test]
    async fn panicking_child_releases_registration_and_wakes_reconciliation() {
        let runners = PlanChildRunners::default();
        let wakeup = Arc::new(Notify::new());
        let guard = runners.register("panicking", wakeup.clone()).unwrap();
        let result = tokio::spawn(async move {
            let _guard = guard;
            panic!("synthetic child panic");
        })
        .await;
        assert!(result.unwrap_err().is_panic());
        assert_eq!(runners.len(), 0);
        tokio::time::timeout(std::time::Duration::from_secs(1), wakeup.notified())
            .await
            .unwrap();
        assert!(runners.register("panicking", wakeup).is_some());
    }
}
