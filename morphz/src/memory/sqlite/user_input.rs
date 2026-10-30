//! Questions use the same Event, Activation, mailbox and dependency transaction
//! as other Runtime outcomes. No client-side question ledger is authoritative.
use super::*;
use crate::user_input::{self, UserInputReply};

pub(super) async fn signal_blocked_in_transaction(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    thread: &ThreadRecord,
    event_id: &str,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    let blocked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM scheduler_dependencies q WHERE q.owner_kind='thread' AND q.owner_id=?1 AND q.owner_generation=?2 AND q.dependency_kind='user_input' AND q.status='pending' AND q.required=1) OR EXISTS(SELECT 1 FROM scheduler_dependencies q JOIN scheduler_dependencies g ON g.dependency_id=q.dependency_id AND g.dependency_kind='user_input' AND g.owner_kind='objective' JOIN objectives o ON o.id=g.owner_id AND o.generation=g.owner_generation WHERE q.owner_kind='thread' AND q.owner_id=?1 AND q.owner_generation=?2 AND q.dependency_kind='user_input' AND q.status='satisfied' AND g.status='pending' AND json_extract(g.metadata_json,'$.accepted_answer_event_id')=q.satisfied_by_event_id AND (q.satisfied_by_event_id<>?3 OR o.active_evaluation_id IS NOT NULL OR EXISTS(SELECT 1 FROM scheduler_dependencies other_wait WHERE other_wait.owner_kind=g.owner_kind AND other_wait.owner_id=g.owner_id AND other_wait.owner_generation=g.owner_generation AND other_wait.required=1 AND other_wait.status='pending' AND other_wait.id<>g.id)))")
        .bind(&thread.id).bind(i64::try_from(thread.generation)?).bind(event_id).fetch_one(&mut **tx).await?;
    if blocked {
        return Ok(true);
    }
    if thread.supervision.supervisor_kind != ThreadSupervisorKind::Objective
        || thread.supervision.origin_evaluation_id.is_some()
        || thread.supervision.parent_thread_id.is_some()
    {
        return Ok(false);
    }
    let Some(objective_id) = thread.supervision.supervisor_id.as_deref() else {
        return Ok(false);
    };
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM scheduler_dependencies WHERE owner_kind='objective' AND owner_id=?1 AND owner_generation=?2 AND dependency_kind='user_input' AND status='pending' AND required=1 AND json_extract(metadata_json,'$.source')='request_user_input' AND (COALESCE(json_extract(metadata_json,'$.accepted_answer_event_id'),'')<>?3 OR COALESCE(json_extract(metadata_json,'$.thread_id'),'')<>?4))")
        .bind(objective_id).bind(i64::try_from(thread.supervision.generation)?).bind(event_id).bind(&thread.id).fetch_one(&mut **tx).await?)
}

pub(super) async fn is_consumed_reply_in_transaction(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    objective_id: &str,
    generation: u64,
    cause: Option<&str>,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM scheduler_dependencies g JOIN events e ON e.id=g.satisfied_by_event_id WHERE g.owner_kind='objective' AND g.owner_id=? AND g.owner_generation=? AND g.dependency_kind='user_input' AND g.status='satisfied' AND g.satisfied_by_event_id=? AND json_extract(g.metadata_json,'$.source')='request_user_input' AND json_extract(g.metadata_json,'$.accepted_answer_event_id')=e.id AND json_extract(e.payload,'$.input_destination.kind')='user_input' AND json_extract(e.payload,'$.reply_to_request_id')=g.dependency_id)")
        .bind(objective_id).bind(i64::try_from(generation)?).bind(cause).fetch_one(&mut **tx).await?)
}

pub(super) async fn has_pending_question(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    id: &str,
    generation: u64,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM scheduler_dependencies WHERE owner_kind='objective' AND owner_id=? AND owner_generation=? AND dependency_kind='user_input' AND status='pending' AND json_extract(metadata_json,'$.source')='request_user_input')")
        .bind(id).bind(i64::try_from(generation)?).fetch_one(&mut **tx).await?)
}

impl SqliteStore {
    pub(super) async fn commit_user_input_request(
        &self,
        activation_id: &str,
        event: &Event,
    ) -> Result<ActivationOutcomeCommit, Box<dyn std::error::Error + Send + Sync>> {
        let thread_id = event
            .payload
            .get("thread_id")
            .and_then(JsonValue::as_str)
            .ok_or("Question has no Thread")?;
        let mut tx = begin_immediate_sqlite_transaction(&self.pool).await?;
        if let Some(event_id) = sqlx::query_scalar::<_, String>(
            "SELECT event_id FROM evaluation_outcomes WHERE activation_id = ?",
        )
        .bind(activation_id)
        .fetch_optional(&mut *tx)
        .await?
        {
            return Ok(ActivationOutcomeCommit::Existing { event_id });
        }
        let row = sqlx::query("SELECT * FROM threads WHERE id = ?")
            .bind(thread_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or("Question Thread is missing")?;
        let thread = thread_from_row(&row)?;
        let row = sqlx::query("SELECT * FROM thread_activations WHERE id = ?")
            .bind(activation_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or("Question Activation is missing")?;
        let activation = thread_activation_from_row(&row)?;
        if activation.generation != thread.generation {
            return Ok(ActivationOutcomeCommit::StaleGeneration);
        }
        if activation.status != ThreadActivationStatus::Running {
            return Ok(ActivationOutcomeCommit::StaleActivation);
        }
        let request = user_input::validate_request_owner(event, &thread, &activation)?;
        let authorized: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session_principal_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.session_id=? AND b.principal_id=? AND b.unbound_at IS NULL AND s.status <> 'archived')")
            .bind(&thread.session_id).bind(thread.initiating_principal_id.as_deref()).fetch_one(&mut *tx).await?;
        if !authorized {
            return Err("Question initiating Principal is no longer bound to this Session".into());
        }
        let call_id = event
            .payload
            .get("assistant_call_event_id")
            .and_then(JsonValue::as_str)
            .ok_or("Question has no native-call identity")?;
        let call = stored_event_in_transaction(&mut tx, call_id, &thread.context_id)
            .await?
            .ok_or("Question native call is not durable")?;
        user_input::validate_request_call(event, &call)?;
        let directed: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM thread_signals WHERE thread_id=? AND thread_generation=? AND kind='chat/steering' AND status='pending')")
            .bind(thread_id).bind(i64::try_from(thread.generation)?).fetch_one(&mut *tx).await?;
        if directed {
            return Ok(ActivationOutcomeCommit::DeferredByDirectedInput);
        }
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let generation = i64::try_from(thread.generation)?;
        let metadata = user_input::dependency_metadata(event);
        let dependency_id = stable_scheduler_dependency_id(
            SchedulerDependencyOwnerKind::Thread,
            thread_id,
            thread.generation,
            SchedulerDependencyKind::UserInput,
            &request.request_id,
            thread.generation,
        );
        append_event_in_transaction(&mut tx, event).await?;
        sqlx::query("UPDATE scheduler_dependencies SET status='cancelled',updated_at=? WHERE owner_kind='thread' AND owner_id=? AND owner_generation=? AND dependency_kind='user_input' AND status='pending'")
            .bind(&now).bind(thread_id).bind(generation).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO scheduler_dependencies (id,owner_kind,owner_id,owner_generation,dependency_kind,dependency_id,dependency_generation,required,status,metadata_json,created_at,updated_at) VALUES (?,'thread',?,?,'user_input',?,?,1,'pending',?,?,?)")
            .bind(&dependency_id).bind(thread_id).bind(generation).bind(&request.request_id).bind(generation)
            .bind(metadata.to_string()).bind(&now).bind(&now).execute(&mut *tx).await?;
        if let Some(objective_id) = event
            .payload
            .get("objective_id")
            .and_then(JsonValue::as_str)
        {
            let row = sqlx::query("SELECT * FROM objectives WHERE id=?")
                .bind(objective_id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or("Question Objective is missing")?;
            let objective = objective_from_row(&row)?;
            user_input::validate_objective_owner(event, &thread, &objective)?;
            let wait = user_input::question_wait(&thread, &request.request_id);
            let projected_wait = user_input::objective_wait_projection(&objective, &wait);
            let evaluation_id = event.payload["objective_evaluation_id"]
                .as_str()
                .ok_or("Question has no owning Evaluation")?;
            cancel_objective_questions(&mut tx, objective_id, objective.generation, &now).await?;
            sqlx::query("UPDATE scheduler_dependencies SET status='cancelled',updated_at=? WHERE owner_kind='objective' AND owner_id=? AND owner_generation=? AND dependency_kind='user_input' AND status='pending'")
                .bind(&now).bind(objective_id).bind(i64::try_from(objective.generation)?).execute(&mut *tx).await?;
            let id = stable_scheduler_dependency_id(
                SchedulerDependencyOwnerKind::Objective,
                objective_id,
                objective.generation,
                SchedulerDependencyKind::UserInput,
                &request.request_id,
                thread.generation,
            );
            sqlx::query("INSERT INTO scheduler_dependencies (id,owner_kind,owner_id,owner_generation,dependency_kind,dependency_id,dependency_generation,required,status,metadata_json,created_at,updated_at) VALUES (?,'objective',?,?,'user_input',?,?,1,'pending',?,?,?)")
                .bind(id).bind(objective_id).bind(i64::try_from(objective.generation)?).bind(&request.request_id).bind(generation)
                .bind(metadata.to_string()).bind(&now).bind(&now).execute(&mut *tx).await?;
            let changed = sqlx::query("UPDATE objectives SET revision=revision+1,wait_condition_json=?,active_evaluation_id=NULL,evaluation_lease_expires_at=NULL,completion_intent_json=NULL,time_used_seconds=time_used_seconds+?,updated_at=? WHERE id=? AND generation=? AND active_evaluation_id=? AND status='active'")
                .bind(projected_wait.as_ref().map(serde_json::to_string).transpose()?)
                .bind(i64::try_from(event.payload.get("objective_evaluation_elapsed_seconds").and_then(JsonValue::as_u64).unwrap_or_default())?)
                .bind(&now).bind(objective_id).bind(i64::try_from(objective.generation)?).bind(evaluation_id).execute(&mut *tx).await?;
            if changed.rows_affected() != 1 {
                return Err("Question lost its owning Objective Evaluation".into());
            }
        }
        let changed = sqlx::query("UPDATE thread_activations SET revision=revision+1,status='completed',claimed_by=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND generation=? AND status='running'")
            .bind(&now).bind(activation_id).bind(generation).execute(&mut *tx).await?;
        if changed.rows_affected() != 1 {
            return Err("Question could not atomically finish its Activation".into());
        }
        sqlx::query("UPDATE thread_signals SET status='acknowledged',acknowledged_at=? WHERE id IN (SELECT signal_id FROM activation_signals WHERE activation_id=?) AND status='claimed'")
            .bind(&now).bind(activation_id).execute(&mut *tx).await?;
        sqlx::query("UPDATE threads SET revision=revision+1,kind='execution',updated_at=? WHERE id=? AND generation=? AND status='open' AND control_state='active'")
            .bind(&now).bind(thread_id).bind(generation).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO evaluation_outcomes (activation_id,session_id,disposition,event_id,created_at) VALUES (?,?,'user_input',?,?)")
            .bind(activation_id).bind(&thread.session_id).bind(&event.id).bind(&now).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(ActivationOutcomeCommit::Suspended { dependency_id })
    }
}

/// Called only after ingress has authenticated and reserved the Human command.
/// It consumes no state until the enclosing Event + Signal transaction commits.
pub(super) struct PreparedReply {
    dependency_id: String,
    request_event: Event,
}

pub(super) async fn cancel_thread_question_barriers(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    thread: &ThreadRecord,
    now: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Only this question's paired Objective edge, never unrelated waits. The
    // ordinary terminal event lets the supervisor reconcile its display mirror.
    sqlx::query("UPDATE scheduler_dependencies SET status='cancelled',updated_at=? WHERE owner_kind='objective' AND dependency_kind='user_input' AND status='pending' AND json_extract(metadata_json,'$.source')='request_user_input' AND json_extract(metadata_json,'$.thread_id')=? AND json_extract(metadata_json,'$.thread_generation')=?")
        .bind(now).bind(&thread.id).bind(i64::try_from(thread.generation)?).execute(&mut **tx).await?;
    Ok(())
}

pub(super) async fn cancel_objective_questions(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    objective_id: &str,
    generation: u64,
    now: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    sqlx::query("UPDATE scheduler_dependencies SET status='cancelled',updated_at=? WHERE owner_kind='thread' AND dependency_kind='user_input' AND status='pending' AND dependency_id IN (SELECT dependency_id FROM scheduler_dependencies WHERE owner_kind='objective' AND owner_id=? AND owner_generation=? AND dependency_kind='user_input' AND json_extract(metadata_json,'$.source')='request_user_input')")
        .bind(now).bind(objective_id).bind(i64::try_from(generation)?).execute(&mut **tx).await?;
    Ok(())
}

pub(super) async fn prepare_reply_in_transaction(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    event: &mut Event,
    reply: &UserInputReply,
    thread: &ThreadRecord,
) -> Result<PreparedReply, Box<dyn std::error::Error + Send + Sync>> {
    user_input::validate_reply_route(event, reply, thread)?;
    let request_event = stored_event_in_transaction(tx, &reply.request_id, &thread.context_id)
        .await?
        .ok_or_else(|| {
            crate::steering::conflict("This question no longer exists in this Context")
        })?;
    let row = sqlx::query("SELECT * FROM scheduler_dependencies WHERE owner_kind='thread' AND owner_id=? AND owner_generation=? AND dependency_kind='user_input' AND dependency_id=? AND status='pending'")
        .bind(&thread.id).bind(i64::try_from(thread.generation)?).bind(&reply.request_id).fetch_optional(&mut **tx).await?
        .ok_or_else(|| crate::steering::conflict("This question was already answered, replaced or cancelled"))?;
    let dependency = scheduler_dependency_from_row(&row)?;
    user_input::pending_request(thread, &dependency, &request_event)?
        .ok_or_else(|| crate::steering::conflict("This question is no longer pending"))?;
    user_input::route_reply(event, reply, &request_event, thread)?;
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    if let Some(objective_id) = request_event
        .payload
        .get("objective_id")
        .and_then(JsonValue::as_str)
    {
        let row = sqlx::query("SELECT * FROM objectives WHERE id=?")
            .bind(objective_id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(|| crate::steering::conflict("Question Objective no longer exists"))?;
        let objective = objective_from_row(&row)?;
        if objective.status != ObjectiveStatus::Active
            || request_event
                .payload
                .get("objective_generation")
                .and_then(JsonValue::as_u64)
                != Some(objective.generation)
        {
            return Err(crate::steering::conflict(
                "Question Objective is no longer active in this generation",
            ));
        }
        // Reserve rather than satisfy the Objective edge. Admission claims the
        // original asking Thread's Evaluation before removing this barrier.
        let changed = sqlx::query("UPDATE scheduler_dependencies SET metadata_json=json_set(metadata_json,'$.accepted_answer_event_id',?),updated_at=? WHERE owner_kind='objective' AND owner_id=? AND owner_generation=? AND dependency_kind='user_input' AND dependency_id=? AND status='pending' AND json_extract(metadata_json,'$.request_event_id')=? AND json_extract(metadata_json,'$.accepted_answer_event_id') IS NULL")
            .bind(&event.id).bind(&now).bind(objective_id).bind(i64::try_from(objective.generation)?).bind(&reply.request_id).bind(&reply.request_id).execute(&mut **tx).await?;
        if changed.rows_affected() != 1 {
            return Err(crate::steering::conflict(
                "Question no longer owns its Objective wait",
            ));
        }
    }
    Ok(PreparedReply {
        dependency_id: dependency.id,
        request_event,
    })
}

/// The Human Event must exist before a dependency can reference it. Both
/// preparation and this commit run under the same ingress write transaction.
pub(super) async fn commit_reply_in_transaction(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    event: &Event,
    prepared: PreparedReply,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    let changed = sqlx::query("UPDATE scheduler_dependencies SET status='satisfied',satisfied_by_event_id=?,satisfied_at=?,updated_at=? WHERE id=? AND status='pending'")
        .bind(&event.id).bind(&now).bind(&now).bind(&prepared.dependency_id).execute(&mut **tx).await?;
    if changed.rows_affected() != 1 {
        return Err(crate::steering::conflict(
            "This question already has an accepted answer",
        ));
    }
    let receipt = user_input::answer_receipt(&prepared.request_event, event)?;
    append_event_in_transaction(tx, &receipt).await?;
    Ok(())
}
