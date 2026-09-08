use super::*;
use crate::memory::objective_approval_wait as contract;

impl SqliteStore {
    pub(super) async fn objective_approval_wait(
        &self,
        id: &str,
    ) -> Result<Option<ObjectiveApprovalWait>, Box<dyn std::error::Error + Send + Sync>> {
        let row = sqlx::query("SELECT w.* FROM objective_approval_waits w JOIN objectives o ON o.id = w.objective_id WHERE w.objective_id = ? AND o.status = 'active' AND o.active_evaluation_id = w.evaluation_id AND o.generation = w.objective_generation AND o.evaluation_lease_expires_at IS NULL")
            .bind(id).fetch_optional(&self.pool).await?;
        row.map(|row| {
            Ok(ObjectiveApprovalWait {
                objective_id: row.try_get("objective_id")?,
                evaluation_id: row.try_get("evaluation_id")?,
                objective_generation: u64::try_from(
                    row.try_get::<i64, _>("objective_generation")?,
                )?,
                activation_id: row.try_get("activation_id")?,
            })
        })
        .transpose()
    }

    pub(super) async fn admit_approval_objective(
        &self,
        request: ObjectiveActivationAdmission,
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>> {
        let mut tx = begin_immediate_sqlite_transaction(&self.pool).await?;
        let Some(row) = sqlx::query("SELECT * FROM objectives WHERE id = ?")
            .bind(&request.objective_id)
            .fetch_optional(&mut *tx)
            .await?
        else {
            return Ok(ObjectiveMutation::NotFound);
        };
        let objective = objective_from_row(&row)?;
        let row = sqlx::query("SELECT * FROM thread_activations WHERE id = ?")
            .bind(&request.activation_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or("Objective admission Activation is not durable")?;
        let activation = thread_activation_from_row(&row)?;
        if objective.status != ObjectiveStatus::Active
            || objective.active_evaluation_id.as_deref() != Some(request.evaluation_id.as_str())
        {
            return Ok(ObjectiveMutation::Conflict { current: objective });
        }
        validate_owner_in_tx(&mut tx, &objective, &request.evaluation_id, &activation).await?;
        let current_thread: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM threads WHERE root_turn_id = ? AND generation = ? AND status = 'open' AND control_state = 'active'")
            .bind(&activation.root_turn_id).bind(i64::try_from(activation.generation)?)
            .fetch_one(&mut *tx).await?;
        if current_thread != 1 {
            return Ok(ObjectiveMutation::Conflict { current: objective });
        }
        let now = Utc::now();
        if activation.status != ThreadActivationStatus::Running
            || activation.claimed_by.as_deref() != Some(request.claimed_by.as_str())
            || request.claimed_by.is_empty()
            || activation.lease_expires_at.is_none_or(|until| until <= now)
            || request.lease_expires_at <= now
        {
            return Err(
                "Objective admission requires the current physical Activation owner".into(),
            );
        }
        // A caller-supplied Objective ID does not establish authority. It must
        // occur on this Activation's immutable trigger or admitted tool batch.
        let routed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM events e WHERE (e.id = ? OR e.activation_id = ? OR json_extract(e.payload, '$.attempt_id') = ?) AND e.context_id = ? AND e.session_id = ? AND json_extract(e.payload, '$.objective_id') = ? AND json_extract(e.payload, '$.objective_evaluation_id') = ? AND json_extract(e.payload, '$.objective_pending_dependency_id') IS ?")
            .bind(&activation.trigger_event_id).bind(&activation.id).bind(&activation.id)
            .bind(&activation.context_id).bind(&activation.session_id)
            .bind(&objective.id).bind(&request.evaluation_id).bind(request.pending_dependency_id.as_deref())
            .fetch_one(&mut *tx).await?;
        if routed == 0 && !infer_route_in_tx(&mut tx, &request, &activation).await? {
            return Err("Objective admission has no durable Evaluation route".into());
        }
        let parked: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM objective_approval_waits WHERE objective_id = ? AND evaluation_id = ? AND objective_generation = ?")
            .bind(&objective.id).bind(&request.evaluation_id).bind(i64::try_from(objective.generation)?)
            .fetch_one(&mut *tx).await?;
        if parked == 0 {
            // Ordinary admission shares the same Objective lock as parking;
            // it never resurrects an expired, non-checkpointed Evaluation.
            return Ok(
                if objective
                    .evaluation_lease_expires_at
                    .is_some_and(|until| until > now)
                {
                    ObjectiveMutation::Updated(objective)
                } else {
                    ObjectiveMutation::Conflict { current: objective }
                },
            );
        }
        let pending: Vec<String> = sqlx::query_scalar("SELECT id FROM scheduler_dependencies WHERE owner_kind = 'objective' AND owner_id = ? AND owner_generation = ? AND required = TRUE AND status = 'pending' ORDER BY id LIMIT 2")
            .bind(&objective.id).bind(i64::try_from(objective.generation)?)
            .fetch_all(&mut *tx).await?;
        if !contract::dependency_matches(
            &objective,
            &pending,
            request.pending_dependency_id.as_deref(),
        ) {
            return Ok(ObjectiveMutation::Conflict { current: objective });
        }
        if objective.evaluation_lease_expires_at.is_some() {
            return Err("Objective approval ownership has a conflicting physical lease".into());
        }
        let now = now.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query("DELETE FROM objective_approval_waits WHERE objective_id = ?")
            .bind(&objective.id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "UPDATE objectives SET evaluation_lease_expires_at = ?, updated_at = ? WHERE id = ?",
        )
        .bind(
            request
                .lease_expires_at
                .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
        )
        .bind(&now)
        .bind(&objective.id)
        .execute(&mut *tx)
        .await?;
        let row = sqlx::query("SELECT * FROM objectives WHERE id = ?")
            .bind(&objective.id)
            .fetch_one(&mut *tx)
            .await?;
        let updated = objective_from_row(&row)?;
        tx.commit().await?;
        Ok(ObjectiveMutation::Updated(updated))
    }
}

/// Called inside the Activation's checkpoint transaction. Early children keep
/// the shared Objective lease alive; only the last live owner may hand it off.
pub(super) async fn park_if_covered(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    activation: &ThreadActivationRecord,
    call: &Event,
    now: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let Some((id, evaluation)) = contract::route(call)? else {
        return Ok(());
    };
    let row = sqlx::query("SELECT * FROM objectives WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or("Approval checkpoint Objective is not durable")?;
    let objective = objective_from_row(&row)?;
    validate_owner_in_tx(tx, &objective, evaluation, activation).await?;
    if objective.completion_intent.is_some()
        || objective
            .evaluation_lease_expires_at
            .is_none_or(|until| until <= Utc::now())
    {
        return Err("Approval checkpoint Objective lease has expired".into());
    }
    let pending: Vec<String> = sqlx::query_scalar("SELECT id FROM scheduler_dependencies WHERE owner_kind = 'objective' AND owner_id = ? AND owner_generation = ? AND required = TRUE AND status = 'pending' ORDER BY id LIMIT 2")
        .bind(id).bind(i64::try_from(objective.generation)?)
        .fetch_all(&mut **tx).await?;
    if !contract::dependency_matches(
        &objective,
        &pending,
        call.payload
            .get("objective_pending_dependency_id")
            .and_then(JsonValue::as_str),
    ) {
        return Err("Objective approval checkpoint cannot cross a changed dependency".into());
    }
    let uncovered: i64 = sqlx::query_scalar(r#"SELECT COUNT(*) FROM thread_activations a
        WHERE a.context_id = ? AND a.status IN ('queued', 'running')
          AND (EXISTS (SELECT 1 FROM events e
                  WHERE (e.id = a.trigger_event_id OR e.activation_id = a.id OR json_extract(e.payload, '$.attempt_id') = a.id)
                    AND json_extract(e.payload, '$.objective_id') = ?
                    AND json_extract(e.payload, '$.objective_evaluation_id') = ?)
              OR EXISTS (SELECT 1 FROM plan_executions p WHERE p.activation_id = a.id
                  AND p.objective_id = ? AND p.objective_evaluation_id = ?)
              OR EXISTS (SELECT 1 FROM action_groups g WHERE g.activation_id = a.id
                  AND g.objective_id = ? AND g.objective_evaluation_id = ?))
          AND NOT EXISTS (SELECT 1 FROM activation_pending_approval_waits w WHERE w.activation_id = a.id)"#)
        .bind(&objective.context_id).bind(id).bind(evaluation).bind(id).bind(evaluation).bind(id).bind(evaluation)
        .fetch_one(&mut **tx).await?;
    if uncovered != 0 {
        return Ok(());
    }
    sqlx::query("INSERT INTO objective_approval_waits (objective_id, evaluation_id, objective_generation, activation_id, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(id).bind(evaluation).bind(i64::try_from(objective.generation)?)
        .bind(&activation.id).bind(now).execute(&mut **tx).await?;
    sqlx::query(
        "UPDATE objectives SET evaluation_lease_expires_at = NULL, updated_at = ? WHERE id = ?",
    )
    .bind(now)
    .bind(id)
    .execute(&mut **tx)
    .await?;
    sqlx::query("UPDATE runtime_timers SET status = 'cancelled', claimed_by = NULL, claim_expires_at = NULL, updated_at = ? WHERE kind = 'objective_lease' AND owner_id = ? AND status IN ('pending', 'claimed')")
        .bind(now).bind(id).execute(&mut **tx).await?;
    Ok(())
}

async fn infer_route_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    request: &ObjectiveActivationAdmission,
    activation: &ThreadActivationRecord,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    let Some(trigger) =
        stored_event_in_transaction(tx, &activation.trigger_event_id, &activation.context_id)
            .await?
    else {
        return Ok(false);
    };
    if trigger.event_type != crate::event::TYPE_INFER_REQUEST {
        return Ok(false);
    }
    let id = trigger
        .payload
        .get("plan_execution_id")
        .and_then(JsonValue::as_str)
        .ok_or("Objective infer admission is missing its Plan")?;
    let row = sqlx::query("SELECT * FROM plan_executions WHERE id = ?")
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
    let plan = super::plan_execution::record_from_row(&row)?;
    if plan.objective_id.as_deref() != Some(request.objective_id.as_str())
        || plan.objective_evaluation_id.as_deref() != Some(request.evaluation_id.as_str())
    {
        return Err("Objective infer admission differs from its durable Plan".into());
    }
    let child = thread_from_row(
        &sqlx::query("SELECT * FROM threads WHERE root_turn_id = ?")
            .bind(&activation.root_turn_id)
            .fetch_one(&mut **tx)
            .await?,
    )?;
    let parent = thread_from_row(
        &sqlx::query("SELECT * FROM threads WHERE id = ?")
            .bind(&plan.thread_id)
            .fetch_one(&mut **tx)
            .await?,
    )?;
    let parent_activation = thread_activation_from_row(
        &sqlx::query("SELECT * FROM thread_activations WHERE id = ?")
            .bind(&plan.activation_id)
            .fetch_one(&mut **tx)
            .await?,
    )?;
    let signals = sqlx::query("SELECT s.* FROM thread_signals s JOIN activation_signals links ON links.signal_id = s.id WHERE links.activation_id = ? ORDER BY links.ordinal LIMIT 2")
        .bind(&activation.id).fetch_all(&mut **tx).await?;
    let [signal] = signals.as_slice() else {
        return Err("Objective infer admission requires one exact Signal".into());
    };
    let signal = thread_signal_from_row(signal)?;
    crate::memory::validate_plan_evaluation_activation_route(
        &plan,
        &trigger,
        &child,
        &signal,
        activation,
        &parent,
        &parent_activation,
        None,
    )?;
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM events WHERE activation_id = ? AND context_id = ? AND topic = 'runtime/tool_calls_selected' AND rowid <= ? ORDER BY rowid LIMIT 4097")
        .bind(&plan.activation_id).bind(&plan.context_id)
        .bind(i64::try_from(trigger.sequence.ok_or("infer trigger is missing its durable sequence")?)?)
        .fetch_all(&mut **tx).await?;
    if ids.len() > 4096 {
        return Err("Objective infer parent selection exceeds the bounded proof limit".into());
    }
    let mut selected = Vec::with_capacity(ids.len());
    for id in ids {
        selected.push(
            stored_event_in_transaction(tx, &id, &plan.context_id)
                .await?
                .ok_or("Objective infer parent selection disappeared")?,
        );
    }
    contract::infer_selections_match(request, &plan, &selected)
}

async fn validate_owner_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    objective: &ObjectiveRecord,
    evaluation: &str,
    activation: &ThreadActivationRecord,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let bound = if objective.initiating_principal_id.is_none()
        && activation.initiating_principal_id.is_some()
    {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM session_principal_bindings WHERE session_id = ? AND principal_id = ? AND unbound_at IS NULL")
            .bind(&activation.session_id).bind(&activation.initiating_principal_id)
            .fetch_one(&mut **tx).await? == 1
    } else {
        false
    };
    contract::validate_owner(objective, evaluation, activation, bound)
}
