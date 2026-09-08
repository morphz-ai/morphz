//! Read-only proof, under the caller's replica lock. A retained Evaluation is
//! not itself permission to park: every checkpoint's immutable binding must
//! still name that Evaluation and its exact current scheduler dependency.
use super::{StoreError, APPROVAL_OWNERS};
use crate::event::{Event, TYPE_TOOL_OUTPUT};
use crate::memory::{
    objective_approval_wait as contract, sqlite::SqliteStore, ActivationStore, EventStore,
    ObjectiveStore, QueryFilter,
};

pub(super) async fn bindings_are_current(store: &SqliteStore) -> Result<bool, StoreError> {
    let pool = store.computation_pool();
    let mut after = String::new();
    loop {
        let ids: Vec<String> = sqlx::query_scalar(&format!(
            "{APPROVAL_OWNERS} SELECT id FROM parked_approvals WHERE id > ? ORDER BY id LIMIT 128"
        ))
        .bind(&after)
        .fetch_all(pool)
        .await?;
        if ids.is_empty() {
            return Ok(true);
        }
        for id in &ids {
            let Some(activation) = store.get_thread_activation(id).await? else {
                return Ok(false);
            };
            let calls: Vec<String> = sqlx::query_scalar(
                "SELECT assistant_call_event_id FROM activation_approval_waits WHERE activation_id = ?
                 UNION SELECT assistant_call_event_id FROM activation_approval_infer_waits WHERE activation_id = ? LIMIT 2"
            ).bind(id).bind(id).fetch_all(pool).await?;
            let [call_id] = calls.as_slice() else {
                return Ok(false);
            };
            let Some(call) = store
                .query(QueryFilter {
                    event_id: Some(call_id.clone()),
                    context_id: Some(activation.context_id.clone()),
                    ..Default::default()
                })
                .await?
                .into_iter()
                .next()
            else {
                return Ok(false);
            };
            let outputs =
                creation_outputs(store, &activation.id, &activation.context_id, &call).await?;
            let Some(binding) = contract::binding_event(&call, &outputs)? else {
                // An Objective anchor may not silently become an ordinary batch.
                let anchored: i64 = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM objective_approval_waits WHERE activation_id = ?)",
                )
                .bind(id)
                .fetch_one(pool)
                .await?;
                if anchored != 0 {
                    return Ok(false);
                }
                continue;
            };
            let Some((objective_id, evaluation_id)) = contract::route(binding)? else {
                return Ok(false);
            };
            let Some(objective) = store.get_objective(objective_id).await? else {
                return Ok(false);
            };
            let Some(wait) = store.get_objective_approval_wait(objective_id).await? else {
                return Ok(false);
            };
            if wait.evaluation_id != evaluation_id
                || wait.objective_generation != objective.generation
                || objective.completion_intent.is_some()
                || objective.evaluation_lease_expires_at.is_some()
            {
                return Ok(false);
            }
            let bound = if objective.initiating_principal_id.is_none()
                && activation.initiating_principal_id.is_some()
            {
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM session_principal_bindings WHERE session_id = ? AND principal_id = ? AND unbound_at IS NULL")
                    .bind(&activation.session_id).bind(&activation.initiating_principal_id).fetch_one(pool).await? == 1
            } else {
                false
            };
            if contract::validate_owner(&objective, evaluation_id, &activation, bound).is_err() {
                return Ok(false);
            }
            let pending: Vec<String> = sqlx::query_scalar("SELECT id FROM scheduler_dependencies WHERE owner_kind = 'objective' AND owner_id = ? AND owner_generation = ? AND required = TRUE AND status = 'pending' ORDER BY id LIMIT 2")
                .bind(objective_id).bind(i64::try_from(objective.generation)?).fetch_all(pool).await?;
            if !contract::dependency_matches(
                &objective,
                &pending,
                contract::optional_dependency(binding)?,
            ) {
                return Ok(false);
            }
        }
        after = ids.last().expect("nonempty page").clone();
    }
}

async fn creation_outputs(
    store: &SqliteStore,
    activation_id: &str,
    context_id: &str,
    call: &Event,
) -> Result<Vec<Event>, StoreError> {
    let calls: Vec<crate::llm::ToolCall> = serde_json::from_value(
        call.payload
            .get("continuation_tool_calls")
            .or_else(|| call.payload.get("tool_calls"))
            .cloned()
            .ok_or("approval checkpoint has no immutable tool batch")?,
    )?;
    let creation_ids: Vec<_> = calls
        .into_iter()
        .filter(|tool| tool.function.name == "objective_create")
        .map(|tool| tool.id)
        .collect();
    if creation_ids.is_empty() {
        return Ok(Vec::new());
    }
    // Load only results of creation calls in this immutable batch, not an
    // arbitrary latest Event or the entire Session. binding_event rechecks
    // the native scope, tool identity, success and conflicting routes.
    // The native batch contract binds outputs by attempt_id. The optional
    // activation_id display projection is not a substitute for that field.
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM events WHERE json_extract(payload, '$.attempt_id') = ? AND context_id = ? AND type = ? AND json_extract(payload, '$.tool_name') = 'objective_create' AND json_extract(payload, '$.tool_call_id') IN (SELECT value FROM json_each(?)) ORDER BY rowid LIMIT 4097")
        .bind(activation_id).bind(context_id).bind(TYPE_TOOL_OUTPUT).bind(serde_json::to_string(&creation_ids)?)
        .fetch_all(store.computation_pool()).await?;
    if ids.len() > 4096 {
        return Err("Objective checkpoint exceeds the native bounded binding proof".into());
    }
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    store
        .query(QueryFilter {
            event_ids: ids,
            context_id: Some(context_id.into()),
            top_k: Some(4096),
            ..Default::default()
        })
        .await
}
