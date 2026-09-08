use super::activation::activation_from_row;
use super::approval::approval_from_row;
use super::execution::execution_job_from_row;
use super::*;
use crate::memory::activation_approval_wait;
use crate::memory::{ActivationApprovalWaitRequest, ThreadActivationMutation};

pub(super) async fn migrate(pool: &PgPool) -> Result<(), StoreError> {
    sqlx::query(activation_approval_wait::TABLE)
        .execute(pool)
        .await?;
    sqlx::query(activation_approval_wait::PLAN_TABLE)
        .execute(pool)
        .await?;
    sqlx::query(activation_approval_wait::INFER_TABLE)
        .execute(pool)
        .await?;
    sqlx::query(activation_approval_wait::INFER_INDEX)
        .execute(pool)
        .await?;
    sqlx::query(&format!(
        "CREATE OR REPLACE VIEW activation_pending_approval_waits AS {}",
        activation_approval_wait::VIEW_QUERY
    ))
    .execute(pool)
    .await?;
    let schema: String = sqlx::query_scalar("SELECT current_schema()")
        .fetch_one(pool)
        .await?;
    let schema = format!("\"{}\"", schema.replace('"', "\"\""));
    let mut checkpoint_schema = pool.begin().await?;
    // Fully qualify both the trigger function and its target table. A caller's
    // search_path must never route cleanup into a neighboring Runtime schema.
    sqlx::query(&format!(
        r#"CREATE OR REPLACE FUNCTION {schema}.morphz_clear_activation_approval_wait()
        RETURNS trigger LANGUAGE plpgsql AS $body$
        BEGIN
            DELETE FROM {schema}.activation_approval_waits WHERE activation_id = NEW.id;
            DELETE FROM {schema}.activation_approval_plan_waits WHERE activation_id = NEW.id;
            DELETE FROM {schema}.activation_approval_infer_waits WHERE activation_id = NEW.id;
            RETURN NEW;
        END
        $body$"#
    ))
    .execute(&mut *checkpoint_schema)
    .await?;
    sqlx::query(&format!(
        "DROP TRIGGER IF EXISTS activation_approval_wait_cleared ON {schema}.thread_activations"
    ))
    .execute(&mut *checkpoint_schema)
    .await?;
    sqlx::query(&format!(
        r#"CREATE TRIGGER activation_approval_wait_cleared
        AFTER UPDATE OF status ON {schema}.thread_activations FOR EACH ROW
        WHEN (NEW.status IN ('completed', 'failed', 'cancelled'))
        EXECUTE FUNCTION {schema}.morphz_clear_activation_approval_wait()"#
    ))
    .execute(&mut *checkpoint_schema)
    .await?;
    checkpoint_schema.commit().await?;
    Ok(())
}

impl PostgresStore {
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
        let mut tx = self.pool.begin().await?;
        // Match Thread cancellation's lock order; Approval writers lock Job
        // before Approval, which is also the order used below.
        sqlx::query("SELECT t.id FROM threads t JOIN thread_activations a ON a.root_turn_id = t.root_turn_id WHERE a.id = $1 FOR UPDATE OF t")
            .bind(&request.activation_id).fetch_optional(&mut *tx).await?;
        let Some(row) = sqlx::query("SELECT * FROM thread_activations WHERE id = $1 FOR UPDATE")
            .bind(&request.activation_id)
            .fetch_optional(&mut *tx)
            .await?
        else {
            return Ok(ThreadActivationMutation::NotFound);
        };
        let activation = activation_from_row(&row)?;
        if activation.revision != request.expected_revision {
            return Ok(ThreadActivationMutation::Conflict {
                current: activation,
            });
        }
        let row = sqlx::query("SELECT * FROM threads WHERE root_turn_id = $1")
            .bind(&activation.root_turn_id)
            .fetch_one(&mut *tx)
            .await?;
        let thread = thread::thread_from_row(&row)?;
        let call = stored_event_in_tx(
            &mut tx,
            &request.assistant_call_event_id,
            &activation.context_id,
        )
        .await?
        .ok_or("Approval checkpoint assistant call is not durable")?;
        // Enroll the complete immutable Plan frontier under cancellation's
        // owner -> Group -> Plan -> Job lock order before taking Approval locks.
        let groups = sqlx::query(
            "SELECT * FROM action_groups WHERE activation_id = $1 ORDER BY id FOR UPDATE",
        )
        .bind(&activation.id)
        .fetch_all(&mut *tx)
        .await?
        .iter()
        .map(action_group::group_from_row)
        .collect::<Result<Vec<_>, _>>()?;
        let plans = sqlx::query(
            "SELECT * FROM plan_executions WHERE activation_id = $1 ORDER BY id FOR UPDATE",
        )
        .bind(&activation.id)
        .fetch_all(&mut *tx)
        .await?
        .iter()
        .map(plan_execution::record_from_row)
        .collect::<Result<Vec<_>, _>>()?;
        let jobs = sqlx::query(
            "SELECT * FROM execution_jobs WHERE activation_id = $1 ORDER BY id FOR UPDATE",
        )
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
            let row = sqlx::query("SELECT * FROM approval_requests WHERE id = $1 FOR UPDATE")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or("Approval checkpoint request is not durable")?;
            approvals.push(approval_from_row(&row)?);
        }
        let mut outputs = Vec::new();
        for id in &request.completed_output_event_ids {
            outputs.push(
                stored_event_in_tx(&mut tx, id, &activation.context_id)
                    .await?
                    .ok_or("Approval checkpoint sibling output is not durable")?,
            );
        }
        // Child state is sampled without taking descendant row locks: that
        // would invert cancellation's owner -> Group -> Plan lock order. Any
        // concurrent decision/change invalidates the stored revision edge in
        // the readiness view, including changes committed after this snapshot.
        let mut infer_children = Vec::new();
        for id in &request.pending_infer_activation_ids {
            let row = sqlx::query("SELECT c.* FROM thread_activations c JOIN threads t ON t.root_turn_id = c.root_turn_id WHERE c.id = $1 AND c.status = 'queued' AND t.status = 'open' AND t.control_state = 'active' AND EXISTS (SELECT 1 FROM activation_pending_approval_waits w WHERE w.activation_id = c.id) AND NOT EXISTS (SELECT 1 FROM thread_activations a WHERE a.root_turn_id = c.root_turn_id AND a.status IN ('queued','running') AND a.id <> c.id) AND NOT EXISTS (SELECT 1 FROM thread_signals s WHERE s.thread_id = t.id AND s.thread_generation = t.generation AND s.status = 'pending')")
                .bind(id).fetch_optional(&mut *tx).await?
                .ok_or(crate::memory::ActivationApprovalWaitChanged)?;
            let child = activation_from_row(&row)?;
            let row = sqlx::query("SELECT * FROM threads WHERE root_turn_id = $1")
                .bind(&child.root_turn_id)
                .fetch_one(&mut *tx)
                .await?;
            let child_thread = thread::thread_from_row(&row)?;
            let request_event = stored_event_in_tx(&mut tx, &child.root_turn_id, &child.context_id)
                .await?
                .ok_or("Approval checkpoint infer request is not durable")?;
            let row = sqlx::query("SELECT * FROM thread_activations WHERE id = $1")
                .bind(crate::memory::stable_thread_activation_id(
                    &request_event.id,
                ))
                .fetch_one(&mut *tx)
                .await?;
            let initial_activation = activation_from_row(&row)?;
            let row = sqlx::query("SELECT * FROM thread_signals WHERE id = $1")
                .bind(crate::memory::stable_thread_signal_id(&request_event.id))
                .fetch_one(&mut *tx)
                .await?;
            infer_children.push(activation_approval_wait::InferApprovalDependency {
                activation: child,
                initial_activation,
                thread: child_thread,
                request: request_event,
                signal: activation::signal_from_row(&row)?,
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
        sqlx::query("DELETE FROM activation_approval_waits WHERE activation_id = $1")
            .bind(&activation.id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM activation_approval_plan_waits WHERE activation_id = $1")
            .bind(&activation.id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM activation_approval_infer_waits WHERE activation_id = $1")
            .bind(&activation.id)
            .execute(&mut *tx)
            .await?;
        for child in &infer_children {
            sqlx::query("INSERT INTO activation_approval_infer_waits (activation_id, child_activation_id, child_revision, child_thread_id, child_thread_revision, child_generation, assistant_call_event_id) VALUES ($1, $2, $3, $4, $5, $6, $7)")
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
            sqlx::query("INSERT INTO activation_approval_plan_waits (activation_id, plan_id, plan_revision, plan_status, group_id, group_revision, group_status) VALUES ($1, $2, $3, $4, $5, $6, $7)")
                .bind(&activation.id).bind(snapshot.id).bind(i64::try_from(snapshot.revision)?).bind(snapshot.status)
                .bind(group_id).bind(group_revision).bind(group_status)
                .execute(&mut *tx).await?;
        }
        for approval in &approvals {
            let job = jobs
                .iter()
                .find(|j| j.id == approval.job_id)
                .expect("validated Job");
            sqlx::query("INSERT INTO activation_approval_waits (activation_id, approval_id, approval_revision, job_id, job_revision, assistant_call_event_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)")
                .bind(&activation.id).bind(&approval.id).bind(i64::try_from(approval.revision)?)
                .bind(&job.id).bind(i64::try_from(job.revision)?)
                .bind(&call.id).bind(&now).execute(&mut *tx).await?;
        }
        sqlx::query("UPDATE thread_activations SET revision = revision + 1, status = 'queued', claimed_by = NULL, lease_expires_at = NULL, updated_at = $1 WHERE id = $2")
            .bind(&now).bind(&activation.id).execute(&mut *tx).await?;
        sqlx::query("UPDATE runtime_timers SET status = 'cancelled', claimed_by = NULL, claim_expires_at = NULL, updated_at = $1 WHERE kind = 'activation_lease' AND owner_id = $2 AND status IN ('pending','claimed')")
            .bind(&now).bind(&activation.id).execute(&mut *tx).await?;
        let row = sqlx::query("SELECT * FROM thread_activations WHERE id = $1")
            .bind(&activation.id)
            .fetch_one(&mut *tx)
            .await?;
        let updated = activation_from_row(&row)?;
        tx.commit().await?;
        Ok(ThreadActivationMutation::Updated(updated))
    }
}
