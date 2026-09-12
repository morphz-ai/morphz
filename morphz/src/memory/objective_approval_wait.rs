//! Durable Objective Evaluation ownership while its physical Activations wait.
//! This does not create an Objective wait dependency or complete an Evaluation.
use super::*;

pub(super) const TABLE: &str = r#"CREATE TABLE IF NOT EXISTS objective_approval_waits (
    objective_id TEXT PRIMARY KEY REFERENCES objectives(id) ON DELETE CASCADE,
    evaluation_id TEXT NOT NULL,
    objective_generation BIGINT NOT NULL,
    activation_id TEXT NOT NULL REFERENCES thread_activations(id),
    created_at TEXT NOT NULL
)"#;

/// A lease has been handed to durable approval checkpoints, not abandoned.
/// An invalidated approval wakes the same Evaluation; it must not acquire a
/// different Evaluation ID merely because wall time elapsed while waiting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectiveApprovalWait {
    pub objective_id: String,
    pub evaluation_id: String,
    pub objective_generation: u64,
    pub activation_id: String,
}

/// No ownership decision was made: the native transaction rolled back on a
/// lock conflict. Callers may retry, but must repeat every authority check.
#[derive(Debug)]
pub struct ApprovalOwnershipContended;

impl std::fmt::Display for ApprovalOwnershipContended {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Approval ownership transaction is contended; retry with current authority")
    }
}
impl std::error::Error for ApprovalOwnershipContended {}

/// Admission always locks Objective before Activation, including when no wait
/// exists. This serializes a new physical owner against the last owner's park.
#[derive(Debug, Clone)]
pub struct ObjectiveActivationAdmission {
    pub objective_id: String,
    pub evaluation_id: String,
    pub activation_id: String,
    pub claimed_by: String,
    pub lease_expires_at: DateTime<Utc>,
    pub pending_dependency_id: Option<String>,
}

pub(super) fn dependency_matches(
    objective: &ObjectiveRecord,
    pending: &[String],
    expected: Option<&str>,
) -> bool {
    match expected {
        Some(id) => pending.len() == 1 && pending[0] == id,
        None => pending.is_empty() && objective.wait_condition.is_none(),
    }
}

pub(super) fn route(call: &crate::event::Event) -> Result<Option<(&str, &str)>, DynError> {
    let id = call.payload.get("objective_id");
    let evaluation = call.payload.get("objective_evaluation_id");
    match (id, evaluation) {
        (None, None) => Ok(None),
        (Some(id), Some(evaluation)) => match (id.as_str(), evaluation.as_str()) {
            (Some(id), Some(evaluation)) if !id.is_empty() && !evaluation.is_empty() => {
                Ok(Some((id, evaluation)))
            }
            _ => Err("Objective approval checkpoint has an incomplete Evaluation route".into()),
        },
        _ => Err("Objective approval checkpoint has an incomplete Evaluation route".into()),
    }
}

pub(super) fn validate_owner(
    objective: &ObjectiveRecord,
    evaluation_id: &str,
    activation: &ThreadActivationRecord,
    session_principal_bound: bool,
) -> Result<(), DynError> {
    if objective.status != ObjectiveStatus::Active
        || objective.active_evaluation_id.as_deref() != Some(evaluation_id)
        || objective.agent_id != activation.agent_id
        || objective.context_id != activation.context_id
        || objective.coordinator_session_id != activation.session_id
        || !principal_matches(
            objective.initiating_principal_id.as_deref(),
            activation.initiating_principal_id.as_deref(),
            session_principal_bound,
        )
    {
        return Err("Objective approval checkpoint lost its exact Evaluation owner".into());
    }
    Ok(())
}

fn principal_matches(owner: Option<&str>, actor: Option<&str>, bound: bool) -> bool {
    owner == actor || (owner.is_none() && actor.is_some() && bound)
}

/// After native infer graph validation, only the parent's immutable tool
/// selection can supply an inherited interrupt dependency. Conflicting
/// selections never collapse into a guessed route.
pub(super) fn infer_selections_match(
    request: &ObjectiveActivationAdmission,
    plan: &PlanExecutionRecord,
    selected: &[crate::event::Event],
) -> Result<bool, DynError> {
    let mut binding: Option<crate::objective::ActiveObjectiveEvaluation> = None;
    for event in selected {
        let Some(route) = crate::objective::ActiveObjectiveEvaluation::from_event(event) else {
            continue;
        };
        if route.objective_id != request.objective_id
            || route.evaluation_id != request.evaluation_id
            || route.pending_dependency_id != request.pending_dependency_id
            || event.payload.get("session_id").and_then(JsonValue::as_str)
                != Some(plan.session_id.as_str())
            || event.payload.get("thread_id").and_then(JsonValue::as_str)
                != Some(plan.thread_id.as_str())
            || event
                .payload
                .get("principal_id")
                .and_then(JsonValue::as_str)
                != plan.initiating_principal_id.as_deref()
            || binding
                .as_ref()
                .is_some_and(|prior| prior.started_at != route.started_at)
        {
            return Err(
                "Objective infer admission has conflicting parent selection authority".into(),
            );
        }
        binding = Some(route);
    }
    Ok(binding.is_some())
}

type DynError = Box<dyn std::error::Error + Send + Sync>;

pub(super) fn optional_dependency(event: &crate::event::Event) -> Result<Option<&str>, DynError> {
    match event.payload.get("objective_pending_dependency_id") {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::String(id)) if !id.is_empty() => Ok(Some(id)),
        _ => Err("Objective checkpoint has an invalid dependency identity".into()),
    }
}

/// A routed trigger cannot silently become an unrelated ordinary batch.
/// Steering that only names a target Objective (no Evaluation) is not an
/// Evaluation binding; a successful creation prelude may bind it later.
pub(super) fn validate_trigger_binding(
    trigger: &crate::event::Event,
    call: &crate::event::Event,
    outputs: &[crate::event::Event],
) -> Result<(), DynError> {
    if trigger.payload.contains_key("objective_evaluation_id") {
        let binding = binding_event(call, outputs)?;
        if binding.map(route).transpose()?.flatten() != route(trigger)?
            || binding.map(optional_dependency).transpose()?.flatten()
                != optional_dependency(trigger)?
        {
            return Err(
                "Approval checkpoint cannot drop or replace its trigger Evaluation route".into(),
            );
        }
    }
    Ok(())
}

/// A creation prelude can bind an ordinary dialogue after the assistant call
/// was committed. Only a successful result of that exact immutable batch may
/// supply the late route; arbitrary later Events are not binding evidence.
pub(crate) fn binding_event<'a>(
    call: &'a crate::event::Event,
    outputs: &'a [crate::event::Event],
) -> Result<Option<&'a crate::event::Event>, DynError> {
    let calls: Vec<crate::llm::ToolCall> = serde_json::from_value(
        call.payload
            .get("continuation_tool_calls")
            .or_else(|| call.payload.get("tool_calls"))
            .cloned()
            .ok_or("Objective checkpoint has no immutable tool batch")?,
    )?;
    let mut binding = route(call)?.map(|_| call);
    for output in outputs {
        if output.event_type != crate::event::TYPE_TOOL_OUTPUT
            || output.payload.get("tool_name").and_then(JsonValue::as_str)
                != Some("objective_create")
            || output
                .payload
                .get("tool_status")
                .and_then(JsonValue::as_str)
                != Some("success")
            || ["context_id", "session_id", "attempt_id"]
                .iter()
                .any(|key| output.payload.get(*key) != call.payload.get(*key))
            || !calls.iter().any(|tool| {
                tool.function.name == "objective_create"
                    && output
                        .payload
                        .get("tool_call_id")
                        .and_then(JsonValue::as_str)
                        == Some(&tool.id)
            })
        {
            continue;
        }
        let Some(route) = route(output)? else {
            continue;
        };
        if binding.is_some_and(|event| self::route(event).ok().flatten() != Some(route)) {
            return Err("Objective checkpoint has conflicting Evaluation bindings".into());
        }
        binding = Some(output);
    }
    Ok(binding)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{Event, TYPE_TOOL_OUTPUT};
    use serde_json::json;

    fn event(payload: JsonValue) -> Event {
        Event::new(
            "fixture".into(),
            "test".into(),
            TYPE_TOOL_OUTPUT.into(),
            "chat/tool_output".into(),
            payload.as_object().unwrap().clone(),
        )
    }

    #[test]
    fn unowned_objective_requires_real_session_binding_for_a_principal() {
        assert!(principal_matches(None, None, false));
        assert!(principal_matches(Some("alice"), Some("alice"), false));
        assert!(principal_matches(None, Some("alice"), true));
        assert!(!principal_matches(None, Some("alice"), false));
        assert!(!principal_matches(Some("alice"), Some("bob"), true));
        assert!(!principal_matches(Some("alice"), None, true));
    }

    #[test]
    fn trigger_evaluation_cannot_be_erased_or_rebound() {
        let trigger = event(
            json!({"objective_id":"o", "objective_evaluation_id":"e", "objective_pending_dependency_id":"d"}),
        );
        let mut call = event(
            json!({"tool_calls":[], "objective_id":"o", "objective_evaluation_id":"e", "objective_pending_dependency_id":"d"}),
        );
        validate_trigger_binding(&trigger, &call, &[]).unwrap();
        call.payload.remove("objective_pending_dependency_id");
        assert!(validate_trigger_binding(&trigger, &call, &[]).is_err());
        call.payload.remove("objective_id");
        call.payload.remove("objective_evaluation_id");
        assert!(validate_trigger_binding(&trigger, &call, &[]).is_err());
        let target_only = event(json!({"objective_id":"o"}));
        validate_trigger_binding(&target_only, &call, &[]).unwrap();
    }

    #[test]
    fn missing_and_null_dependency_are_equivalent_but_malformed_is_not() {
        let trigger = event(json!({"objective_id":"o", "objective_evaluation_id":"e"}));
        let mut call = event(
            json!({"tool_calls":[], "objective_id":"o", "objective_evaluation_id":"e", "objective_pending_dependency_id":null}),
        );
        validate_trigger_binding(&trigger, &call, &[]).unwrap();
        for invalid in [json!(""), json!({}), json!(42), json!("other-dependency")] {
            call.payload
                .insert("objective_pending_dependency_id".into(), invalid);
            assert!(validate_trigger_binding(&trigger, &call, &[]).is_err());
        }
    }

    #[test]
    fn late_binding_requires_success_from_exact_creation_call() {
        let call = event(
            json!({"context_id":"c", "session_id":"s", "attempt_id":"a", "tool_calls":[{"id":"create", "type":"function", "function":{"name":"objective_create", "arguments":"{}"}}]}),
        );
        let output = event(
            json!({"context_id":"c", "session_id":"s", "attempt_id":"a", "tool_name":"objective_create", "tool_call_id":"create", "tool_status":"success", "objective_id":"o", "objective_evaluation_id":"e"}),
        );
        assert!(binding_event(&call, std::slice::from_ref(&output))
            .unwrap()
            .is_some());
        for (key, value) in [
            ("tool_status", "error"),
            ("tool_name", "read"),
            ("attempt_id", "other"),
            ("session_id", "other"),
            ("tool_call_id", "invented"),
        ] {
            let mut invalid = output.clone();
            invalid.payload.insert(key.into(), json!(value));
            assert!(binding_event(&call, &[invalid]).unwrap().is_none(), "{key}");
        }
    }
}
