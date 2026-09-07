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
pub(super) async fn inspect(store: &SqliteStore) -> Result<Quiescence, StoreError> {
    let pool = store.computation_pool();
    let mut blockers = Vec::new();
    // EXISTS keeps each authority check bounded in result size. These are the
    // native kernel's live owners, not command-name/estimated-duration guesses.
    for (name, predicate) in [
        ("activation", "SELECT EXISTS(SELECT 1 FROM thread_activations WHERE status IN ('queued','running'))"),
        ("execution_job", "SELECT EXISTS(SELECT 1 FROM execution_jobs WHERE status IN ('queued','waiting_approval','running'))"),
        ("plan", "SELECT EXISTS(SELECT 1 FROM plan_executions WHERE status IN ('queued','running','waiting'))"),
        ("action_group", "SELECT EXISTS(SELECT 1 FROM action_groups WHERE status = 'running')"),
        ("edge_command", "SELECT EXISTS(SELECT 1 FROM edge_execution_commands WHERE status IN ('queued','claimed','cancel_requested'))"),
        ("signal_outbox", "SELECT EXISTS(SELECT 1 FROM signal_outbox WHERE status = 'pending')"),
        ("thread_signal", "SELECT EXISTS(SELECT 1 FROM thread_signals WHERE status IN ('pending','claimed'))"),
        ("delivery", "SELECT EXISTS(SELECT 1 FROM threads WHERE delivery_status IN ('pending','deferred'))"),
        ("objective", "SELECT EXISTS(SELECT 1 FROM objectives WHERE active_evaluation_id IS NOT NULL OR (status = 'active' AND wait_condition_json IS NULL))"),
        ("delegation", "SELECT EXISTS(SELECT 1 FROM delegations WHERE status IN ('queued','running'))"),
        ("assignment", "SELECT EXISTS(SELECT 1 FROM work_assignments WHERE status IN ('queued','running'))"),
        ("timer_handler", "SELECT EXISTS(SELECT 1 FROM runtime_timers WHERE status = 'claimed')"),
        ("recall_projection", "SELECT EXISTS(SELECT 1 FROM recall_projection_outbox)"),
    ] {
        if sqlx::query_scalar::<_, i64>(predicate).fetch_one(pool).await? != 0 { blockers.push(name); }
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
