use super::*;
use crate::memory::activation_approval_wait;
use crate::memory::{ActivationApprovalWaitRequest, ThreadActivationMutation};

impl SqliteStore {
    pub(super) async fn checkpoint_approval_wait(
        &self,
        request: ActivationApprovalWaitRequest,
    ) -> Result<ThreadActivationMutation, Box<dyn std::error::Error + Send + Sync>> {
        if (request.pending_approval_ids.is_empty()
            && request.pending_infer_activation_ids.is_empty())
            || request.pending_approval_ids.len() > 4096
            || request.pending_infer_activation_ids.len() > 4096
            || request.completed_output_event_ids.len() > 4096
        {
            return Err("Approval checkpoint must contain a bounded nonempty wait set".into());
        }
        let mut tx = begin_immediate_sqlite_transaction(&self.pool).await?;

        let Some(row) = sqlx::query("SELECT * FROM thread_activations WHERE id = ?")
            .bind(&request.activation_id)
            .fetch_optional(&mut *tx)
            .await?
        else {
            return Ok(ThreadActivationMutation::NotFound);
        };
        let activation = thread_activation_from_row(&row)?;
        if activation.revision != request.expected_revision {
            return Ok(ThreadActivationMutation::Conflict {
                current: activation,
            });
        }
        let row = sqlx::query("SELECT * FROM threads WHERE root_turn_id = ?")
            .bind(&activation.root_turn_id)
            .fetch_one(&mut *tx)
            .await?;
        let thread = thread_from_row(&row)?;
        let call = stored_event_in_transaction(
            &mut tx,
            &request.assistant_call_event_id,
            &activation.context_id,
        )
        .await?
        .ok_or("Approval checkpoint assistant call is not durable")?;
        let jobs = sqlx::query("SELECT * FROM execution_jobs WHERE activation_id = ? ORDER BY id")
            .bind(&activation.id)
            .fetch_all(&mut *tx)
            .await?
            .iter()
            .map(execution_job_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        let mut approvals = Vec::new();
        // Stable order also prevents concurrent checkpoint transactions from
        // taking overlapping Approval locks in opposite orders.
        let mut ids = request.pending_approval_ids.clone();
        ids.sort();
        for id in &ids {
            let row = sqlx::query("SELECT * FROM approval_requests WHERE id = ?")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or("Approval checkpoint request is not durable")?;
            approvals.push(approval_from_row(&row)?);
        }
        let mut outputs = Vec::new();
        for id in &request.completed_output_event_ids {
            outputs.push(
                stored_event_in_transaction(&mut tx, id, &activation.context_id)
                    .await?
                    .ok_or("Approval checkpoint sibling output is not durable")?,
            );
        }
        let trigger = stored_event_in_transaction(
            &mut tx,
            &activation.trigger_event_id,
            &activation.context_id,
        )
        .await?
        .ok_or("Approval checkpoint trigger is not durable")?;
        crate::memory::objective_approval_wait::validate_trigger_binding(
            &trigger, &call, &outputs,
        )?;
        let plans =
            sqlx::query("SELECT * FROM plan_executions WHERE activation_id = ? ORDER BY id")
                .bind(&activation.id)
                .fetch_all(&mut *tx)
                .await?
                .iter()
                .map(plan_execution::record_from_row)
                .collect::<Result<Vec<_>, _>>()?;
        let groups = sqlx::query("SELECT * FROM action_groups WHERE activation_id = ? ORDER BY id")
            .bind(&activation.id)
            .fetch_all(&mut *tx)
            .await?
            .iter()
            .map(action_group_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        // Child state is sampled without taking descendant row locks: that
        // would invert cancellation's owner -> Group -> Plan lock order. Any
        // concurrent decision/change invalidates the stored revision edge in
        // the readiness view, including changes committed after this snapshot.
        let mut infer_children = Vec::new();
        for id in &request.pending_infer_activation_ids {
            let row = sqlx::query("SELECT c.* FROM thread_activations c JOIN threads t ON t.root_turn_id = c.root_turn_id WHERE c.id = ? AND c.status = 'queued' AND t.status = 'open' AND t.control_state = 'active' AND EXISTS (SELECT 1 FROM activation_pending_approval_waits w WHERE w.activation_id = c.id) AND NOT EXISTS (SELECT 1 FROM thread_activations a WHERE a.root_turn_id = c.root_turn_id AND a.status IN ('queued','running') AND a.id <> c.id) AND NOT EXISTS (SELECT 1 FROM thread_signals s WHERE s.thread_id = t.id AND s.thread_generation = t.generation AND s.status = 'pending')")
                .bind(id).fetch_optional(&mut *tx).await?
                .ok_or(crate::memory::ActivationApprovalWaitChanged)?;
            let child = thread_activation_from_row(&row)?;
            let row = sqlx::query("SELECT * FROM threads WHERE root_turn_id = ?")
                .bind(&child.root_turn_id)
                .fetch_one(&mut *tx)
                .await?;
            let child_thread = thread_from_row(&row)?;
            let request_event =
                stored_event_in_transaction(&mut tx, &child.root_turn_id, &child.context_id)
                    .await?
                    .ok_or("Approval checkpoint infer request is not durable")?;
            let row = sqlx::query("SELECT * FROM thread_activations WHERE id = ?")
                .bind(crate::memory::stable_thread_activation_id(
                    &request_event.id,
                ))
                .fetch_one(&mut *tx)
                .await?;
            let initial_activation = thread_activation_from_row(&row)?;
            let row = sqlx::query("SELECT * FROM thread_signals WHERE id = ?")
                .bind(crate::memory::stable_thread_signal_id(&request_event.id))
                .fetch_one(&mut *tx)
                .await?;
            infer_children.push(activation_approval_wait::InferApprovalDependency {
                activation: child,
                initial_activation,
                thread: child_thread,
                request: request_event,
                signal: thread_signal_from_row(&row)?,
            });
        }
        let plan_snapshots = activation_approval_wait::validate(
            &request,
            &activation,
            &thread,
            &call,
            &jobs,
            &approvals,
            &outputs,
            &plans,
            &groups,
            &infer_children,
        )?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query("DELETE FROM activation_approval_waits WHERE activation_id = ?")
            .bind(&activation.id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM activation_approval_plan_waits WHERE activation_id = ?")
            .bind(&activation.id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM activation_approval_infer_waits WHERE activation_id = ?")
            .bind(&activation.id)
            .execute(&mut *tx)
            .await?;
        for child in &infer_children {
            sqlx::query("INSERT INTO activation_approval_infer_waits (activation_id, child_activation_id, child_revision, child_thread_id, child_thread_revision, child_generation, assistant_call_event_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
                .bind(&activation.id).bind(&child.activation.id).bind(i64::try_from(child.activation.revision)?)
                .bind(&child.thread.id).bind(i64::try_from(child.thread.revision)?)
                .bind(i64::try_from(child.thread.generation)?).bind(&call.id)
                .execute(&mut *tx).await?;
        }
        for snapshot in plan_snapshots {
            let (group_id, group_revision, group_status) = match snapshot.group {
                Some((id, revision, status)) => {
                    (Some(id), Some(i64::try_from(revision)?), Some(status))
                }
                None => (None, None, None),
            };
            sqlx::query("INSERT INTO activation_approval_plan_waits (activation_id, plan_id, plan_revision, plan_status, group_id, group_revision, group_status) VALUES (?, ?, ?, ?, ?, ?, ?)")
                .bind(&activation.id).bind(snapshot.id).bind(i64::try_from(snapshot.revision)?).bind(snapshot.status)
                .bind(group_id).bind(group_revision).bind(group_status)
                .execute(&mut *tx).await?;
        }
        for approval in &approvals {
            let job = jobs
                .iter()
                .find(|j| j.id == approval.job_id)
                .expect("validated Job");
            sqlx::query("INSERT INTO activation_approval_waits (activation_id, approval_id, approval_revision, job_id, job_revision, assistant_call_event_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
                .bind(&activation.id).bind(&approval.id).bind(i64::try_from(approval.revision)?)
                .bind(&job.id).bind(i64::try_from(job.revision)?)
                .bind(&call.id).bind(&now).execute(&mut *tx).await?;
        }
        sqlx::query("UPDATE thread_activations SET revision = revision + 1, status = 'queued', claimed_by = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?")
            .bind(&now).bind(&activation.id).execute(&mut *tx).await?;
        sqlx::query("UPDATE runtime_timers SET status = 'cancelled', claimed_by = NULL, claim_expires_at = NULL, updated_at = ? WHERE kind = 'activation_lease' AND owner_id = ? AND status IN ('pending','claimed')")
            .bind(&now).bind(&activation.id).execute(&mut *tx).await?;
        if let Some(binding) =
            crate::memory::objective_approval_wait::binding_event(&call, &outputs)?
        {
            super::objective_approval_wait::park_if_covered(&mut tx, &activation, binding, &now)
                .await?;
        }
        let row = sqlx::query("SELECT * FROM thread_activations WHERE id = ?")
            .bind(&activation.id)
            .fetch_one(&mut *tx)
            .await?;
        let updated = thread_activation_from_row(&row)?;
        tx.commit().await?;
        Ok(ThreadActivationMutation::Updated(updated))
    }
}
