//! Native authority inspection, executed under RemoteRuntimeStore's replica lock.
//! Cloud never interprets these schema/business states. Absence of HTTP traffic
//! is not evidence that any of these durable owners can be interrupted.
use super::protocol::StoreError;
use crate::memory::{sqlite::SqliteStore, TimerStore};
use chrono::{DateTime, Utc};

pub(super) struct Quiescence {
    pub blockers: Vec<&'static str>,
    pub next_wake: Option<DateTime<Utc>>,
}

// Reuse the native scheduler's recursive dependency proof. Merely being queued
// or waiting_approval is never sufficient. The replica lock keeps the proof and
// all owner queries at the same revision until Cell atomically checks that
// revision while releasing the compute fence.
const APPROVAL_OWNERS: &str = r#"WITH parked_approvals AS (
    SELECT a.id, t.id AS thread_id, t.generation AS thread_generation
    FROM activation_pending_approval_waits w
    JOIN thread_activations a ON a.id = w.activation_id
    JOIN threads t ON t.root_turn_id = a.root_turn_id
    WHERE a.status = 'queued' AND a.claimed_by IS NULL AND a.lease_expires_at IS NULL
      AND t.status = 'open' AND t.control_state = 'active' AND t.generation = a.generation
      AND t.agent_id = a.agent_id AND t.context_id = a.context_id AND t.session_id = a.session_id
      AND t.initiating_principal_id IS a.initiating_principal_id
) "#;

pub(super) async fn inspect(store: &SqliteStore) -> Result<Quiescence, StoreError> {
    let pool = store.computation_pool();
    let mut blockers = Vec::new();
    // EXISTS keeps each authority check bounded in result size. These are the
    // native kernel's live owners, not command-name/estimated-duration guesses.
    for (name, predicate) in [
        ("activation", "SELECT EXISTS(SELECT 1 FROM thread_activations a WHERE status IN ('queued','running') AND NOT EXISTS (SELECT 1 FROM parked_approvals w WHERE w.id = a.id))"),
        ("execution_job", r#"SELECT EXISTS(SELECT 1 FROM execution_jobs j
            WHERE j.status IN ('queued','waiting_approval','running') AND NOT EXISTS (
                SELECT 1 FROM activation_approval_waits aw JOIN parked_approvals w ON w.id = aw.activation_id
                WHERE aw.job_id = j.id AND aw.job_revision = j.revision AND j.activation_id = w.id
                  AND j.thread_id = w.thread_id AND j.status = 'waiting_approval'
                  AND j.claim_token IS NULL AND j.side_effect_started_at IS NULL))"#),
        ("plan", r#"SELECT EXISTS(SELECT 1 FROM plan_executions p
            WHERE p.status IN ('queued','running','waiting') AND NOT EXISTS (
                SELECT 1 FROM activation_approval_plan_waits pw JOIN parked_approvals w ON w.id = pw.activation_id
                WHERE pw.plan_id = p.id AND pw.plan_revision = p.revision AND pw.plan_status = p.status
                  AND p.activation_id = w.id AND p.thread_id = w.thread_id))"#),
        ("action_group", r#"SELECT EXISTS(SELECT 1 FROM action_groups g WHERE g.status = 'running' AND NOT EXISTS (
                SELECT 1 FROM activation_approval_plan_waits pw JOIN parked_approvals w ON w.id = pw.activation_id
                WHERE pw.group_id = g.id AND pw.group_revision = g.revision AND pw.group_status = g.status
                  AND g.activation_id = w.id))"#),
        ("edge_command", "SELECT EXISTS(SELECT 1 FROM edge_execution_commands WHERE status IN ('queued','claimed','cancel_requested'))"),
        ("signal_outbox", "SELECT EXISTS(SELECT 1 FROM signal_outbox WHERE status = 'pending')"),
        ("thread_signal", r#"SELECT EXISTS(SELECT 1 FROM thread_signals s
            WHERE s.status IN ('pending','claimed') AND NOT EXISTS (
                SELECT 1 FROM activation_signals link JOIN parked_approvals w ON w.id = link.activation_id
                WHERE link.signal_id = s.id AND s.status = 'claimed'
                  AND s.thread_id = w.thread_id AND s.thread_generation = w.thread_generation))"#),
        ("delivery", "SELECT EXISTS(SELECT 1 FROM threads WHERE delivery_status IN ('pending','deferred'))"),
        ("objective", "SELECT EXISTS(SELECT 1 FROM objectives WHERE active_evaluation_id IS NOT NULL OR (status = 'active' AND wait_condition_json IS NULL))"),
        ("delegation", "SELECT EXISTS(SELECT 1 FROM delegations WHERE status IN ('queued','running'))"),
        ("assignment", "SELECT EXISTS(SELECT 1 FROM work_assignments WHERE status IN ('queued','running'))"),
        ("timer_handler", "SELECT EXISTS(SELECT 1 FROM runtime_timers WHERE status = 'claimed')"),
        ("recall_projection", "SELECT EXISTS(SELECT 1 FROM recall_projection_outbox)"),
    ] {
        if sqlx::query_scalar::<_, i64>(&format!("{APPROVAL_OWNERS}{predicate}")).fetch_one(pool).await? != 0 { blockers.push(name); }
    }
    let now = Utc::now();
    if sqlx::query_scalar::<_, i64>(
        "SELECT EXISTS(SELECT 1 FROM provider_refresh_leases WHERE lease_expires_at > ?)",
    )
    .bind(now.to_rfc3339())
    .fetch_one(pool)
    .await?
        != 0
    {
        blockers.push("credential_refresh");
    }
    let next_wake = store.next_runtime_timer_due_at().await?;
    if next_wake.is_some_and(|deadline| deadline <= now) {
        blockers.push("due_timer");
    }
    Ok(Quiescence {
        blockers,
        next_wake,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{NewRuntimeTimer, RuntimeTimerKind};
    #[tokio::test]
    async fn future_native_timer_is_exported_but_due_or_claimed_work_blocks_sleep() {
        let replica = super::super::replica::Replica::create().await.unwrap();
        let store = replica.store;
        let empty = inspect(&store).await.unwrap();
        assert!(empty.blockers.is_empty());
        assert!(empty.next_wake.is_none());
        let due = Utc::now() + chrono::Duration::seconds(10);
        store
            .upsert_runtime_timer(NewRuntimeTimer {
                id: "park-test".into(),
                generation: 1,
                kind: RuntimeTimerKind::Schedule,
                owner_id: "schedule-test".into(),
                due_at: due,
                payload: serde_json::json!({}),
            })
            .await
            .unwrap();
        let future = inspect(&store).await.unwrap();
        assert!(future.blockers.is_empty());
        assert_eq!(future.next_wake, Some(due));
        store
            .upsert_runtime_timer(NewRuntimeTimer {
                id: "park-test".into(),
                generation: 2,
                kind: RuntimeTimerKind::Schedule,
                owner_id: "schedule-test".into(),
                due_at: Utc::now() - chrono::Duration::seconds(1),
                payload: serde_json::json!({}),
            })
            .await
            .unwrap();
        assert!(inspect(&store)
            .await
            .unwrap()
            .blockers
            .contains(&"due_timer"));
        store
            .claim_due_runtime_timers(
                Utc::now(),
                "claim",
                Utc::now() + chrono::Duration::seconds(30),
                1,
            )
            .await
            .unwrap();
        assert!(inspect(&store)
            .await
            .unwrap()
            .blockers
            .contains(&"timer_handler"));
    }
}
