//! PostgreSQL parity for the atomic question / exact Human answer boundary.
use super::activation::activation_from_row;
use super::thread::thread_from_row;

pub(super) async fn signal_blocked_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    thread: &ThreadRecord,
    event_id: &str,
) -> Result<bool, StoreError> {
    let blocked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM scheduler_dependencies q WHERE q.owner_kind='thread' AND q.owner_id=$1 AND q.owner_generation=$2 AND q.dependency_kind='user_input' AND q.status='pending' AND q.required) OR EXISTS(SELECT 1 FROM scheduler_dependencies q JOIN scheduler_dependencies g ON g.dependency_id=q.dependency_id AND g.dependency_kind='user_input' AND g.owner_kind='objective' JOIN objectives o ON o.id=g.owner_id AND o.generation=g.owner_generation WHERE q.owner_kind='thread' AND q.owner_id=$1 AND q.owner_generation=$2 AND q.dependency_kind='user_input' AND q.status='satisfied' AND g.status='pending' AND g.metadata_json ->> 'accepted_answer_event_id'=q.satisfied_by_event_id AND (q.satisfied_by_event_id<>$3 OR o.active_evaluation_id IS NOT NULL OR EXISTS(SELECT 1 FROM scheduler_dependencies other_wait WHERE other_wait.owner_kind=g.owner_kind AND other_wait.owner_id=g.owner_id AND other_wait.owner_generation=g.owner_generation AND other_wait.required=TRUE AND other_wait.status='pending' AND other_wait.id<>g.id)))")
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
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM scheduler_dependencies WHERE owner_kind='objective' AND owner_id=$1 AND owner_generation=$2 AND dependency_kind='user_input' AND status='pending' AND required AND metadata_json ->> 'source'='request_user_input' AND (COALESCE(metadata_json ->> 'accepted_answer_event_id','')<>$3 OR COALESCE(metadata_json ->> 'thread_id','')<>$4))")
        .bind(objective_id).bind(i64::try_from(thread.supervision.generation)?).bind(event_id).bind(&thread.id).fetch_one(&mut **tx).await?)
}
use super::*;
use crate::memory::{
    ActivationOutcomeCommit, ThreadActivationStatus, ThreadRecord, ThreadSupervisorKind,
};
use crate::user_input::{self, UserInputReply};

pub(super) async fn is_consumed_reply_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    objective_id: &str,
    generation: u64,
    cause: Option<&str>,
) -> Result<bool, StoreError> {
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM scheduler_dependencies g JOIN events e ON e.id=g.satisfied_by_event_id WHERE g.owner_kind='objective' AND g.owner_id=$1 AND g.owner_generation=$2 AND g.dependency_kind='user_input' AND g.status='satisfied' AND g.satisfied_by_event_id=$3 AND g.metadata_json ->> 'source'='request_user_input' AND g.metadata_json ->> 'accepted_answer_event_id'=e.id AND e.payload #>> '{input_destination,kind}'='user_input' AND e.payload ->> 'reply_to_request_id'=g.dependency_id)")
        .bind(objective_id).bind(i64::try_from(generation)?).bind(cause).fetch_one(&mut **tx).await?)
}

pub(super) async fn has_pending_question(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    id: &str,
    generation: u64,
) -> Result<bool, StoreError> {
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM scheduler_dependencies WHERE owner_kind='objective' AND owner_id=$1 AND owner_generation=$2 AND dependency_kind='user_input' AND status='pending' AND metadata_json ->> 'source'='request_user_input')")
        .bind(id).bind(i64::try_from(generation)?).fetch_one(&mut **tx).await?)
}

impl PostgresStore {
    pub(super) async fn commit_user_input_request(
        &self,
        activation_id: &str,
        event: &Event,
    ) -> Result<ActivationOutcomeCommit, StoreError> {
        let thread_id = event
            .payload
            .get("thread_id")
            .and_then(JsonValue::as_str)
            .ok_or("Question has no Thread")?;
        let mut tx = self.pool.begin().await?;
        // All question paths take Objective -> Thread -> Activation, the same
        // order as cancellation and directed Objective input. Never invert it.
        let objective = if let Some(id) = event
            .payload
            .get("objective_id")
            .and_then(JsonValue::as_str)
        {
            let row = sqlx::query("SELECT * FROM objectives WHERE id=$1 FOR UPDATE")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or("Question Objective is missing")?;
            Some(objective_from_row(&row)?)
        } else {
            None
        };
        let row = sqlx::query("SELECT * FROM threads WHERE id=$1 FOR UPDATE")
            .bind(thread_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or("Question Thread is missing")?;
        let thread = thread_from_row(&row)?;
        if let Some(event_id) = sqlx::query_scalar::<_, String>(
            "SELECT event_id FROM evaluation_outcomes WHERE activation_id=$1",
        )
        .bind(activation_id)
        .fetch_optional(&mut *tx)
        .await?
        {
            return Ok(ActivationOutcomeCommit::Existing { event_id });
        }
        let row = sqlx::query("SELECT * FROM thread_activations WHERE id=$1 FOR UPDATE")
            .bind(activation_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or("Question Activation is missing")?;
        let activation = activation_from_row(&row)?;
        if activation.generation != thread.generation {
            return Ok(ActivationOutcomeCommit::StaleGeneration);
        }
        if activation.status != ThreadActivationStatus::Running {
            return Ok(ActivationOutcomeCommit::StaleActivation);
        }
        let request = user_input::validate_request_owner(event, &thread, &activation)?;
        // No Session write or Session row lock here: Human ingress locks the
        // Session before its Thread. Retain the binding fence without reversing
        // that order. Answer ingress independently rechecks the live Session.
        let authorized: Option<i32> = sqlx::query_scalar("SELECT 1 FROM session_principal_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.session_id=$1 AND b.principal_id=$2 AND b.unbound_at IS NULL AND s.status <> 'archived' FOR SHARE OF b")
            .bind(&thread.session_id).bind(thread.initiating_principal_id.as_deref()).fetch_optional(&mut *tx).await?;
        if authorized.is_none() {
            return Err("Question initiating Principal is no longer bound to this Session".into());
        }
        let call_id = event
            .payload
            .get("assistant_call_event_id")
            .and_then(JsonValue::as_str)
            .ok_or("Question has no native-call identity")?;
        let call = stored_event_in_tx(&mut tx, call_id, &thread.context_id)
            .await?
            .ok_or("Question native call is not durable")?;
        user_input::validate_request_call(event, &call)?;
        let directed: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM thread_signals WHERE thread_id=$1 AND thread_generation=$2 AND kind='chat/steering' AND status='pending')")
            .bind(thread_id).bind(i64::try_from(thread.generation)?).fetch_one(&mut *tx).await?;
        if directed {
            return Ok(ActivationOutcomeCommit::DeferredByDirectedInput);
        }
        let now = now_text();
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
        append_event_in_tx(&mut tx, event).await?;
        sqlx::query("UPDATE scheduler_dependencies SET status='cancelled',updated_at=$1 WHERE owner_kind='thread' AND owner_id=$2 AND owner_generation=$3 AND dependency_kind='user_input' AND status='pending'")
            .bind(&now).bind(thread_id).bind(generation).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO scheduler_dependencies (id,owner_kind,owner_id,owner_generation,dependency_kind,dependency_id,dependency_generation,required,status,metadata_json,created_at,updated_at) VALUES ($1,'thread',$2,$3,'user_input',$4,$3,TRUE,'pending',$5,$6,$6)")
            .bind(&dependency_id).bind(thread_id).bind(generation).bind(&request.request_id).bind(&metadata).bind(&now).execute(&mut *tx).await?;
        if let Some(objective) = objective.as_ref() {
            user_input::validate_objective_owner(event, &thread, objective)?;
            let wait = user_input::question_wait(&thread, &request.request_id);
            let projected_wait = user_input::objective_wait_projection(objective, &wait);
            let evaluation_id = event.payload["objective_evaluation_id"]
                .as_str()
                .ok_or("Question has no owning Evaluation")?;
            cancel_objective_questions(&mut tx, &objective.id, objective.generation, &now).await?;
            sqlx::query("UPDATE scheduler_dependencies SET status='cancelled',updated_at=$1 WHERE owner_kind='objective' AND owner_id=$2 AND owner_generation=$3 AND dependency_kind='user_input' AND status='pending'")
                .bind(&now).bind(&objective.id).bind(i64::try_from(objective.generation)?).execute(&mut *tx).await?;
            let id = stable_scheduler_dependency_id(
                SchedulerDependencyOwnerKind::Objective,
                &objective.id,
                objective.generation,
                SchedulerDependencyKind::UserInput,
                &request.request_id,
                thread.generation,
            );
            sqlx::query("INSERT INTO scheduler_dependencies (id,owner_kind,owner_id,owner_generation,dependency_kind,dependency_id,dependency_generation,required,status,metadata_json,created_at,updated_at) VALUES ($1,'objective',$2,$3,'user_input',$4,$5,TRUE,'pending',$6,$7,$7)")
                .bind(id).bind(&objective.id).bind(i64::try_from(objective.generation)?).bind(&request.request_id).bind(generation).bind(&metadata).bind(&now).execute(&mut *tx).await?;
            let changed = sqlx::query("UPDATE objectives SET revision=revision+1,wait_condition_json=$1,active_evaluation_id=NULL,evaluation_lease_expires_at=NULL,completion_intent_json=NULL,time_used_seconds=time_used_seconds+$2,updated_at=$3 WHERE id=$4 AND generation=$5 AND active_evaluation_id=$6 AND status='active'")
                .bind(projected_wait.as_ref().map(serde_json::to_value).transpose()?)
                .bind(i64::try_from(event.payload.get("objective_evaluation_elapsed_seconds").and_then(JsonValue::as_u64).unwrap_or_default())?)
                .bind(&now).bind(&objective.id).bind(i64::try_from(objective.generation)?).bind(evaluation_id).execute(&mut *tx).await?;
            if changed.rows_affected() != 1 {
                return Err("Question lost its owning Objective Evaluation".into());
            }
        }
        let changed = sqlx::query("UPDATE thread_activations SET revision=revision+1,status='completed',claimed_by=NULL,lease_expires_at=NULL,updated_at=$1 WHERE id=$2 AND generation=$3 AND status='running'")
            .bind(&now).bind(activation_id).bind(generation).execute(&mut *tx).await?;
        if changed.rows_affected() != 1 {
            return Err("Question could not atomically finish its Activation".into());
        }
        sqlx::query("UPDATE thread_signals SET status='acknowledged',acknowledged_at=$1 WHERE id IN (SELECT signal_id FROM activation_signals WHERE activation_id=$2) AND status='claimed'")
            .bind(&now).bind(activation_id).execute(&mut *tx).await?;
        sqlx::query("UPDATE threads SET revision=revision+1,kind='execution',updated_at=$1 WHERE id=$2 AND generation=$3 AND status='open' AND control_state='active'")
            .bind(&now).bind(thread_id).bind(generation).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO evaluation_outcomes (activation_id,session_id,disposition,event_id,created_at) VALUES ($1,$2,'user_input',$3,$4)")
            .bind(activation_id).bind(&thread.session_id).bind(&event.id).bind(&now).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(ActivationOutcomeCommit::Suspended { dependency_id })
    }
}

/// Discover only a saved question's Objective; caller still validates its
/// Principal/Session and exact Thread before consuming anything. Lock it before
/// acquiring the Thread row, not from inside answer validation afterwards.
pub(super) async fn lock_reply_objective(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    reply: &UserInputReply,
    context_id: &str,
    event: &Event,
) -> Result<(), StoreError> {
    sqlx::query("SELECT o.id FROM objectives o JOIN events e ON e.payload ->> 'objective_id'=o.id JOIN threads t ON t.id=$3 AND t.generation=$4 AND t.context_id=$2 AND t.session_id=$5 AND t.initiating_principal_id=$6 WHERE e.id=$1 AND e.context_id=$2 AND e.topic='runtime/user_input_requested' FOR UPDATE OF o")
        .bind(&reply.request_id).bind(context_id).bind(&reply.thread_id).bind(i64::try_from(reply.generation)?)
        .bind(event.payload.get("session_id").and_then(JsonValue::as_str)).bind(event.payload.get("principal_id").and_then(JsonValue::as_str))
        .fetch_optional(&mut **tx).await?;
    Ok(())
}

pub(super) struct PreparedReply {
    dependency_id: String,
    request_event: Event,
}

pub(super) async fn cancel_thread_question_barriers(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    thread: &ThreadRecord,
    now: &str,
) -> Result<(), StoreError> {
    sqlx::query("UPDATE scheduler_dependencies SET status='cancelled',updated_at=$1 WHERE owner_kind='objective' AND dependency_kind='user_input' AND status='pending' AND metadata_json ->> 'source'='request_user_input' AND metadata_json ->> 'thread_id'=$2 AND (metadata_json ->> 'thread_generation')::bigint=$3")
        .bind(now).bind(&thread.id).bind(i64::try_from(thread.generation)?).execute(&mut **tx).await?;
    Ok(())
}

pub(super) async fn cancel_objective_questions(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    objective_id: &str,
    generation: u64,
    now: &str,
) -> Result<(), StoreError> {
    sqlx::query("UPDATE scheduler_dependencies SET status='cancelled',updated_at=$1 WHERE owner_kind='thread' AND dependency_kind='user_input' AND status='pending' AND dependency_id IN (SELECT dependency_id FROM scheduler_dependencies WHERE owner_kind='objective' AND owner_id=$2 AND owner_generation=$3 AND dependency_kind='user_input' AND metadata_json ->> 'source'='request_user_input')")
        .bind(now).bind(objective_id).bind(i64::try_from(generation)?).execute(&mut **tx).await?;
    Ok(())
}

pub(super) async fn prepare_reply_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    event: &mut Event,
    reply: &UserInputReply,
    thread: &ThreadRecord,
) -> Result<PreparedReply, StoreError> {
    user_input::validate_reply_route(event, reply, thread)?;
    let request_event = stored_event_in_tx(tx, &reply.request_id, &thread.context_id)
        .await?
        .ok_or_else(|| {
            crate::steering::conflict("This question no longer exists in this Context")
        })?;
    let row = sqlx::query("SELECT * FROM scheduler_dependencies WHERE owner_kind='thread' AND owner_id=$1 AND owner_generation=$2 AND dependency_kind='user_input' AND dependency_id=$3 AND status='pending' FOR UPDATE")
        .bind(&thread.id).bind(i64::try_from(thread.generation)?).bind(&reply.request_id).fetch_optional(&mut **tx).await?
        .ok_or_else(|| crate::steering::conflict("This question was already answered, replaced or cancelled"))?;
    // Explicit owner deserialization keeps parity with focused snapshot reads.
    let dependency = super::scheduler::dependency_from_row(&row)?;
    user_input::pending_request(thread, &dependency, &request_event)?
        .ok_or_else(|| crate::steering::conflict("This question is no longer pending"))?;
    user_input::route_reply(event, reply, &request_event, thread)?;
    let now = now_text();
    if let Some(id) = request_event
        .payload
        .get("objective_id")
        .and_then(JsonValue::as_str)
    {
        let row = sqlx::query("SELECT * FROM objectives WHERE id=$1")
            .bind(id)
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
        let changed = sqlx::query("UPDATE scheduler_dependencies SET metadata_json=jsonb_set(metadata_json,'{accepted_answer_event_id}',to_jsonb($1::text)),updated_at=$2 WHERE owner_kind='objective' AND owner_id=$3 AND owner_generation=$4 AND dependency_kind='user_input' AND dependency_id=$5 AND status='pending' AND metadata_json ->> 'request_event_id'=$5 AND metadata_json ->> 'accepted_answer_event_id' IS NULL")
            .bind(&event.id).bind(&now).bind(id).bind(i64::try_from(objective.generation)?).bind(&reply.request_id).execute(&mut **tx).await?;
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

pub(super) async fn commit_reply_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    event: &Event,
    prepared: PreparedReply,
) -> Result<(), StoreError> {
    let now = now_text();
    let changed = sqlx::query("UPDATE scheduler_dependencies SET status='satisfied',satisfied_by_event_id=$1,satisfied_at=$2,updated_at=$2 WHERE id=$3 AND status='pending'")
        .bind(&event.id).bind(&now).bind(&prepared.dependency_id).execute(&mut **tx).await?;
    if changed.rows_affected() != 1 {
        return Err(crate::steering::conflict(
            "This question already has an accepted answer",
        ));
    }
    let receipt = user_input::answer_receipt(&prepared.request_event, event)?;
    append_event_in_tx(tx, &receipt).await?;
    Ok(())
}
