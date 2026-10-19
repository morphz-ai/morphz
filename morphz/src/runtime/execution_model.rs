//! Read-only physical request metadata, independent of model-authored annotations.
//! No current defaults, inherited aliases, secrets or provider account data are projected.
use super::{MorphzRuntime, RuntimeError, SchedulerThreadSnapshot};
use crate::event::Event;
use crate::llm::{ModelAttemptBinding, ReasoningEffort};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionModel {
    pub model_attempt_id: String,
    pub activation_id: String,
    pub model: String,
    pub requested_alias: String,
    /// None means the physical request did not specify an effort, not "off".
    pub reasoning_effort: Option<ReasoningEffort>,
    pub observed_at: chrono::DateTime<chrono::Utc>,
}

fn from_event(event: &Event, snapshot: &SchedulerThreadSnapshot) -> Option<ExecutionModel> {
    let thread = &snapshot.thread;
    let text = |key| event.payload.get(key).and_then(serde_json::Value::as_str);
    if event.topic != "runtime/model_attempt_state"
        || event.event_type != "runtime_control"
        || text("context_id") != Some(thread.context_id.as_str())
        || text("session_id") != Some(thread.session_id.as_str())
        || text("thread_id") != Some(thread.id.as_str())
        || text("root_turn_id") != Some(thread.root_turn_id.as_str())
        || text("principal_id") != thread.initiating_principal_id.as_deref()
        || event.payload.get("thread_generation")?.as_u64()? != thread.generation
    {
        return None;
    }
    // A recorded null is meaningful; an absent field is unknown, never a default.
    let effort = event.payload.get("effective_reasoning_effort")?;
    let reasoning_effort = if effort.is_null() {
        None
    } else {
        Some(serde_json::from_value(effort.clone()).ok()?)
    };
    let binding: ModelAttemptBinding =
        serde_json::from_value(event.payload.get("model_binding")?.clone()).ok()?;
    if binding.request_session_id.as_deref() != Some(thread.session_id.as_str())
        || binding.physical_model.is_empty()
        || binding.physical_model.len() > 256
        || binding.requested_alias.is_empty()
        || binding.requested_alias.len() > 256
    {
        return None;
    }
    Some(ExecutionModel {
        model_attempt_id: text("model_attempt_id")?.to_owned(),
        activation_id: text("activation_id")?.to_owned(),
        model: binding.physical_model,
        requested_alias: binding.requested_alias,
        reasoning_effort,
        observed_at: event.timestamp,
    })
}

impl MorphzRuntime {
    pub(super) async fn attach_execution_models(
        &self,
        context_id: &str,
        snapshots: &mut [SchedulerThreadSnapshot],
    ) -> Result<(), RuntimeError> {
        let ids = snapshots
            .iter()
            .filter(|s| s.thread.context_id == context_id)
            .map(|s| s.thread.id.clone())
            .collect::<Vec<_>>();
        if ids.is_empty() {
            return Ok(());
        }
        // One partitioned, indexed, bounded read; not one history fetch per row.
        let events = self
            .inner
            .store
            .list_thread_event_sources(
                context_id,
                &ids,
                "runtime_control",
                &["runtime/model_attempt_state"],
                32,
            )
            .await?;
        let mut by_thread = HashMap::<String, Vec<Event>>::new();
        for event in events {
            if let Some(id) = event
                .payload
                .get("thread_id")
                .and_then(serde_json::Value::as_str)
            {
                by_thread.entry(id.to_owned()).or_default().push(event);
            }
        }
        for snapshot in snapshots.iter_mut() {
            snapshot.execution_model = by_thread.get(&snapshot.thread.id).and_then(|events| {
                events
                    .iter()
                    .rev()
                    .find_map(|event| from_event(event, snapshot))
            });
        }
        let current = self
            .inner
            .store
            .list_threads_by_ids(context_id, &ids)
            .await?
            .into_iter()
            .map(|thread| (thread.id.clone(), thread))
            .collect::<HashMap<_, _>>();
        for snapshot in snapshots {
            if current.get(&snapshot.thread.id).is_none_or(|now| {
                now.generation != snapshot.thread.generation
                    || now.session_id != snapshot.thread.session_id
                    || now.root_turn_id != snapshot.thread.root_turn_id
                    || now.initiating_principal_id != snapshot.thread.initiating_principal_id
            }) {
                snapshot.execution_model = None;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::*;
    use serde_json::json;
    fn snapshot() -> SchedulerThreadSnapshot {
        let now = chrono::Utc::now();
        SchedulerThreadSnapshot {
            execution_model: None,
            source: None,
            response_annotations: None,
            intent: None,
            thread: ThreadRecord {
                response_annotations: crate::response_annotations::Protocol::Off,
                model_alias: Some("not-the-physical-model".into()),
                reasoning_effort: Some("high".into()),
                id: "thread".into(),
                revision: 1,
                generation: 2,
                agent_id: "agent".into(),
                context_id: "context".into(),
                session_id: "session".into(),
                initiating_principal_id: Some("human".into()),
                root_turn_id: "root".into(),
                kind: ThreadKind::Execution,
                lifecycle: ThreadLifecycle::Completed,
                control_state: ThreadControlState::Active,
                executor_kind: "self".into(),
                executor_id: None,
                target_id: None,
                supervision: ThreadSupervision::runtime("test"),
                result_text: None,
                result_event_id: None,
                delivery_status: DeliveryStatus::None,
                delivery_event_id: None,
                created_at: now,
                updated_at: now,
            },
            phase: ThreadPhase::Idle,
            outcome: None,
            pending_signals: vec![],
            activations: vec![],
            schedules: vec![],
        }
    }
    fn event() -> Event {
        Event::new("model-state".into(),"Runtime".into(),"runtime_control".into(),"runtime/model_attempt_state".into(),json!({
            "context_id":"context","session_id":"session","thread_id":"thread","root_turn_id":"root","principal_id":"human","thread_generation":2,
            "model_attempt_id":"actual-attempt","activation_id":"actual-activation","effective_reasoning_effort":"max",
            "model_binding":{"requested_alias":"review","route_id":"route","route_revision":"revision","provider_instance_id":"provider","auth_account_id":"private-account","physical_model":"actual-model","protocol":"openai-responses","provider_adapter":"protocol-compatible","provider_adapter_version":"1","endpoint":"private-endpoint","request_session_id":"session"}
        }).as_object().unwrap().clone())
    }
    #[test]
    fn physical_model_is_readable_with_annotations_off_and_excludes_private_binding_fields() {
        let result = from_event(&event(), &snapshot()).unwrap();
        assert_eq!(result.model, "actual-model");
        assert_eq!(result.reasoning_effort, Some(ReasoningEffort::Max));
        let encoded = serde_json::to_string(&result).unwrap();
        assert!(!encoded.contains("private-"));
        assert!(!encoded.contains("not-the-physical-model"));
    }
    #[test]
    fn absent_effort_and_wrong_generation_or_scope_never_turn_into_current_defaults() {
        let mut source = event();
        source.payload.remove("effective_reasoning_effort");
        assert!(from_event(&source, &snapshot()).is_none());
        source
            .payload
            .insert("effective_reasoning_effort".into(), json!(null));
        assert_eq!(
            from_event(&source, &snapshot()).unwrap().reasoning_effort,
            None
        );
        for (key, value) in [
            ("thread_generation", json!(1)),
            ("principal_id", json!("other")),
            ("session_id", json!("other")),
            ("thread_id", json!("other")),
        ] {
            let mut invalid = event();
            invalid.payload.insert(key.into(), value);
            assert!(from_event(&invalid, &snapshot()).is_none());
        }
    }
}
