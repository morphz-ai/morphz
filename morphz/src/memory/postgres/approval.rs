//! PostgreSQL durable approval authority and one-use grant consumption.

use super::execution::{ensure_job_in_tx, execution_job_from_row, validate_new_job};
use super::{append_event_in_tx, now_text, parse_time, PostgresStore, StoreError};
use crate::approval_authority::{
    approval_decision_event, stable_approval_identity, stable_grant_id,
};
use crate::event::Event;
use crate::memory::{
    ApprovalAuditCommit, ApprovalFilter, ApprovalMutation, ApprovalRecord, ApprovalResolution,
    ApprovalStatus, ApprovalStore, CapabilityLeaseFilter, CapabilityLeaseMutation,
    CapabilityLeaseRecord, CapabilityLeaseStatus, CapabilityLeaseStore, ExecutionApprovalMutation,
    ExecutionApprovalStore, ExecutionJobRecord, ExecutionJobStatus, ExecutionJobStore,
    NewApprovalRequest, NewCapabilityLease, NewExecutionJob,
};
use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Postgres, QueryBuilder, Row};

pub(super) async fn migrate(pool: &PgPool) -> Result<(), StoreError> {
    for statement in [
        r#"CREATE TABLE IF NOT EXISTS approval_requests (
            id TEXT PRIMARY KEY,
            revision BIGINT NOT NULL DEFAULT 1,
            job_id TEXT NOT NULL REFERENCES execution_jobs(id) ON DELETE CASCADE,
            request_digest TEXT NOT NULL,
            policy_digest TEXT NOT NULL,
            action_json JSONB NOT NULL,
            requested_json JSONB NOT NULL,
            justification TEXT NOT NULL,
            status TEXT NOT NULL,
            rationale TEXT,
            risk_tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
            grant_id TEXT,
            grant_consumed_at TEXT,
            consumed_by_claim_token TEXT,
            cancel_reason TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            decided_at TEXT,
            cancelled_at TEXT,
            UNIQUE(job_id, request_digest, policy_digest),
            CHECK ((status = 'allowed' AND grant_id IS NOT NULL)
                   OR (status <> 'allowed' AND grant_id IS NULL)),
            CHECK ((grant_consumed_at IS NULL AND consumed_by_claim_token IS NULL)
                   OR (grant_consumed_at IS NOT NULL AND consumed_by_claim_token IS NOT NULL))
        )"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_approval_requests_status
           ON approval_requests(status, created_at, id)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_approval_requests_job
           ON approval_requests(job_id, created_at, id)"#,
        r#"CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_approval_one_active_per_job
           ON approval_requests(job_id)
           WHERE status IN ('pending_auto', 'pending_human', 'allowed')"#,
        r#"CREATE OR REPLACE FUNCTION morphz_approval_terminal_guard()
           RETURNS trigger AS $$
           BEGIN
             IF OLD.status IN ('denied', 'cancelled') AND NEW.status <> OLD.status THEN
               RAISE EXCEPTION 'approval terminal status is irreversible';
             END IF;
             RETURN NEW;
           END;
           $$ LANGUAGE plpgsql"#,
        r#"DO $$
           BEGIN
             IF NOT EXISTS (
               SELECT 1 FROM pg_trigger
               WHERE tgname = 'approval_terminal_status_is_irreversible'
             ) THEN
               CREATE TRIGGER approval_terminal_status_is_irreversible
               BEFORE UPDATE OF status ON approval_requests
               FOR EACH ROW EXECUTE FUNCTION morphz_approval_terminal_guard();
             END IF;
           END $$"#,
        r#"CREATE TABLE IF NOT EXISTS capability_leases (
            id TEXT PRIMARY KEY,
            revision BIGINT NOT NULL DEFAULT 1 CHECK(revision >= 1),
            principal_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
            target_id TEXT NOT NULL REFERENCES execution_targets(id),
            capabilities_json JSONB NOT NULL,
            requested_json JSONB NOT NULL,
            policy_digest TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
            issued_by_approval_id TEXT REFERENCES approval_requests(id),
            issued_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            revoked_at TEXT,
            revoke_reason TEXT
        )"#,
        r#"CREATE INDEX IF NOT EXISTS idx_capability_leases_scope
            ON capability_leases(principal_id, agent_id, thread_id, target_id, status, expires_at)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_capability_leases_approval
            ON capability_leases(issued_by_approval_id)"#,
    ] {
        sqlx::query(statement).execute(pool).await?;
    }
    Ok(())
}

fn parse_status(value: &str) -> Result<ApprovalStatus, StoreError> {
    match value {
        "pending_auto" => Ok(ApprovalStatus::PendingAuto),
        "pending_human" => Ok(ApprovalStatus::PendingHuman),
        "allowed" => Ok(ApprovalStatus::Allowed),
        "denied" => Ok(ApprovalStatus::Denied),
        "cancelled" => Ok(ApprovalStatus::Cancelled),
        other => Err(format!("未知 Approval status：'{other}'").into()),
    }
}

fn optional_time(row: &PgRow, column: &str) -> Result<Option<DateTime<Utc>>, StoreError> {
    row.get::<Option<String>, _>(column)
        .as_deref()
        .map(parse_time)
        .transpose()
}

fn approval_from_row(row: &PgRow) -> Result<ApprovalRecord, StoreError> {
    Ok(ApprovalRecord {
        id: row.get("id"),
        revision: u64::try_from(row.get::<i64, _>("revision"))?,
        job_id: row.get("job_id"),
        request_digest: row.get("request_digest"),
        policy_digest: row.get("policy_digest"),
        action: row.get("action_json"),
        requested: row.get("requested_json"),
        justification: row.get("justification"),
        status: parse_status(&row.get::<String, _>("status"))?,
        rationale: row.get("rationale"),
        risk_tags: serde_json::from_value(row.get("risk_tags_json"))?,
        grant_id: row.get("grant_id"),
        grant_consumed_at: optional_time(row, "grant_consumed_at")?,
        consumed_by_claim_token: row.get("consumed_by_claim_token"),
        cancel_reason: row.get("cancel_reason"),
        last_error: row.get("last_error"),
        created_at: parse_time(&row.get::<String, _>("created_at"))?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
        decided_at: optional_time(row, "decided_at")?,
        cancelled_at: optional_time(row, "cancelled_at")?,
    })
}

fn capability_lease_from_row(row: &PgRow) -> Result<CapabilityLeaseRecord, StoreError> {
    Ok(CapabilityLeaseRecord {
        id: row.get("id"),
        revision: u64::try_from(row.get::<i64, _>("revision"))?,
        principal_id: row.get("principal_id"),
        agent_id: row.get("agent_id"),
        thread_id: row.get("thread_id"),
        target_id: row.get("target_id"),
        capabilities: serde_json::from_value(row.get("capabilities_json"))?,
        requested: row.get("requested_json"),
        policy_digest: row.get("policy_digest"),
        status: CapabilityLeaseStatus::parse(&row.get::<String, _>("status"))
            .ok_or("未知 Capability Lease status")?,
        issued_by_approval_id: row.get("issued_by_approval_id"),
        issued_at: parse_time(&row.get::<String, _>("issued_at"))?,
        expires_at: parse_time(&row.get::<String, _>("expires_at"))?,
        updated_at: parse_time(&row.get::<String, _>("updated_at"))?,
        revoked_at: optional_time(row, "revoked_at")?,
        revoke_reason: row.get("revoke_reason"),
    })
}

fn validate_new_request(request: &NewApprovalRequest) -> Result<(), StoreError> {
    for (field, value) in [
        ("id", request.id.as_str()),
        ("job_id", request.job_id.as_str()),
        ("request_digest", request.request_digest.as_str()),
        ("policy_digest", request.policy_digest.as_str()),
        ("justification", request.justification.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(format!("Approval {field} 不能为空").into());
        }
    }
    if !request.pending_status.is_pending() {
        return Err("Approval 首次创建只能使用 pending_auto 或 pending_human".into());
    }
    let identity = stable_approval_identity(
        &request.job_id,
        &request.action,
        &request.requested,
        &request.policy_digest,
    )?;
    if request.id != identity.approval_id || request.request_digest != identity.request_digest {
        return Err("Approval id/request_digest 与规范化请求身份不一致".into());
    }
    Ok(())
}

async fn ensure_approval_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    request: &NewApprovalRequest,
) -> Result<ApprovalMutation, StoreError> {
    validate_new_request(request)?;
    let existing = sqlx::query(
        r#"SELECT * FROM approval_requests
           WHERE id = $1 OR (job_id = $2 AND request_digest = $3 AND policy_digest = $4)
           ORDER BY CASE WHEN id = $1 THEN 0 ELSE 1 END
           LIMIT 1"#,
    )
    .bind(&request.id)
    .bind(&request.job_id)
    .bind(&request.request_digest)
    .bind(&request.policy_digest)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(row) = existing {
        let current = approval_from_row(&row)?;
        let immutable_match = current.id == request.id
            && current.job_id == request.job_id
            && current.request_digest == request.request_digest
            && current.policy_digest == request.policy_digest
            && current.action == request.action
            && current.requested == request.requested
            && current.justification == request.justification
            && (!current.status.is_pending() || current.status == request.pending_status);
        return Ok(if immutable_match {
            ApprovalMutation::Existing(current)
        } else {
            ApprovalMutation::Conflict {
                current,
                reason: "Approval identity 或因果摘要已被不同请求占用".to_string(),
            }
        });
    }
    let job_status =
        sqlx::query_scalar::<_, String>("SELECT status FROM execution_jobs WHERE id = $1")
            .bind(&request.job_id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or("Approval 引用的 Execution Job 不存在")?;
    if job_status != ExecutionJobStatus::WaitingApproval.as_str() {
        return Err("Approval 只能绑定 waiting_approval Execution Job".into());
    }
    let now = now_text();
    let inserted = sqlx::query(
        r#"INSERT INTO approval_requests
           (id, revision, job_id, request_digest, policy_digest, action_json,
            requested_json, justification, status, risk_tags_json,
            created_at, updated_at)
           VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, '[]'::jsonb, $9, $9)
           ON CONFLICT DO NOTHING"#,
    )
    .bind(&request.id)
    .bind(&request.job_id)
    .bind(&request.request_digest)
    .bind(&request.policy_digest)
    .bind(&request.action)
    .bind(&request.requested)
    .bind(&request.justification)
    .bind(request.pending_status.as_str())
    .bind(now)
    .execute(&mut **tx)
    .await?;
    if inserted.rows_affected() != 1 {
        let row = sqlx::query(
            r#"SELECT * FROM approval_requests
               WHERE id = $1 OR (job_id = $2 AND request_digest = $3 AND policy_digest = $4)
               LIMIT 1"#,
        )
        .bind(&request.id)
        .bind(&request.job_id)
        .bind(&request.request_digest)
        .bind(&request.policy_digest)
        .fetch_optional(&mut **tx)
        .await?;
        return Ok(match row {
            Some(row) => ApprovalMutation::Conflict {
                current: approval_from_row(&row)?,
                reason: "Approval 并发创建时身份或活动 Job 前置条件发生冲突".to_string(),
            },
            None => return Err("Approval 创建失败且无法读取冲突记录".into()),
        });
    }
    let row = sqlx::query("SELECT * FROM approval_requests WHERE id = $1")
        .bind(&request.id)
        .fetch_one(&mut **tx)
        .await?;
    Ok(ApprovalMutation::Created(approval_from_row(&row)?))
}

async fn approval_job_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    approval: &ApprovalRecord,
) -> Result<ExecutionJobRecord, StoreError> {
    let row = sqlx::query("SELECT * FROM execution_jobs WHERE id = $1")
        .bind(&approval.job_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| {
            format!(
                "Approval '{}' 引用的 Execution Job '{}' 不存在",
                approval.id, approval.job_id
            )
        })?;
    execution_job_from_row(&row)
}

async fn mutation_failure(
    store: &PostgresStore,
    id: &str,
    expected_revision: u64,
    reason: impl Into<String>,
) -> Result<ApprovalMutation, StoreError> {
    let reason = reason.into();
    Ok(match store.get_approval(id).await? {
        Some(current) if current.revision != expected_revision => {
            ApprovalMutation::Conflict { current, reason }
        }
        Some(current) => ApprovalMutation::Rejected { current, reason },
        None => ApprovalMutation::NotFound,
    })
}

#[async_trait::async_trait]
impl ApprovalStore for PostgresStore {
    async fn ensure_approval_request(
        &self,
        request: NewApprovalRequest,
    ) -> Result<ApprovalMutation, StoreError> {
        let mut tx = self.pool.begin().await?;
        let result = ensure_approval_in_tx(&mut tx, &request).await?;
        tx.commit().await?;
        Ok(result)
    }

    async fn get_approval(&self, id: &str) -> Result<Option<ApprovalRecord>, StoreError> {
        sqlx::query("SELECT * FROM approval_requests WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(approval_from_row)
            .transpose()
    }

    async fn list_approvals(
        &self,
        filter: ApprovalFilter,
    ) -> Result<Vec<ApprovalRecord>, StoreError> {
        if filter.limit == Some(0) {
            return Ok(Vec::new());
        }
        let mut query = QueryBuilder::<Postgres>::new("SELECT * FROM approval_requests WHERE TRUE");
        if let Some(job_id) = filter.job_id {
            query.push(" AND job_id = ").push_bind(job_id);
        }
        if let Some(status) = filter.status {
            query.push(" AND status = ").push_bind(status.as_str());
        }
        if filter.pending_only {
            query.push(" AND status IN ('pending_auto', 'pending_human')");
        }
        query.push(" ORDER BY created_at, id");
        if let Some(limit) = filter.limit {
            query.push(" LIMIT ").push_bind(i64::try_from(limit)?);
        }
        let rows = query.build().fetch_all(&self.pool).await?;
        rows.iter().map(approval_from_row).collect()
    }

    async fn list_context_approvals(
        &self,
        context_id: &str,
    ) -> Result<Vec<ApprovalRecord>, StoreError> {
        let rows = sqlx::query(
            r#"SELECT approvals.* FROM approval_requests approvals
               INNER JOIN execution_jobs jobs ON jobs.id = approvals.job_id
               WHERE jobs.context_id = $1
               ORDER BY approvals.created_at, approvals.id"#,
        )
        .bind(context_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(approval_from_row).collect()
    }

    async fn list_context_pending_approvals(
        &self,
        context_id: &str,
    ) -> Result<Vec<ApprovalRecord>, StoreError> {
        let rows = sqlx::query(
            r#"SELECT approvals.* FROM approval_requests approvals
               INNER JOIN execution_jobs jobs ON jobs.id = approvals.job_id
               WHERE jobs.context_id = $1
                 AND approvals.status IN ('pending_auto', 'pending_human')
               ORDER BY approvals.created_at, approvals.id"#,
        )
        .bind(context_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(approval_from_row).collect()
    }

    async fn list_context_pending_approvals_bounded(
        &self,
        context_id: &str,
        limit: usize,
    ) -> Result<Vec<ApprovalRecord>, StoreError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let rows = sqlx::query(
            r#"SELECT approvals.* FROM approval_requests approvals
               INNER JOIN execution_jobs jobs ON jobs.id = approvals.job_id
               WHERE jobs.context_id = $1
                 AND approvals.status IN ('pending_auto', 'pending_human')
               ORDER BY approvals.created_at, approvals.id LIMIT $2"#,
        )
        .bind(context_id)
        .bind(i64::try_from(limit)?)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(approval_from_row).collect()
    }

    async fn count_context_pending_approvals(&self, context_id: &str) -> Result<usize, StoreError> {
        Ok(usize::try_from(
            sqlx::query_scalar::<_, i64>(
                r#"SELECT COUNT(*) FROM approval_requests approvals
                   INNER JOIN execution_jobs jobs ON jobs.id = approvals.job_id
                   INNER JOIN thread_activations activations ON activations.id = jobs.activation_id
                   INNER JOIN threads ON threads.id = jobs.thread_id
                   WHERE jobs.context_id = $1
                     AND approvals.status IN ('pending_auto', 'pending_human')
                     AND jobs.status IN ('queued', 'waiting_approval', 'running')
                     AND activations.status IN ('queued', 'running')
                     AND threads.status = 'open'"#,
            )
            .bind(context_id)
            .fetch_one(&self.pool)
            .await?,
        )?)
    }

    async fn list_job_approvals(
        &self,
        context_id: &str,
        job_ids: &[String],
    ) -> Result<Vec<ApprovalRecord>, StoreError> {
        if job_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut records = Vec::new();
        for job_ids in job_ids.chunks(500) {
            let mut query = QueryBuilder::<Postgres>::new(
                "SELECT approval_requests.* FROM approval_requests INNER JOIN execution_jobs ON execution_jobs.id = approval_requests.job_id WHERE execution_jobs.context_id = ",
            );
            query
                .push_bind(context_id)
                .push(" AND approval_requests.job_id IN (");
            {
                let mut values = query.separated(", ");
                for job_id in job_ids {
                    values.push_bind(job_id);
                }
            }
            query.push(") ORDER BY approval_requests.created_at, approval_requests.id");
            let rows = query.build().fetch_all(&self.pool).await?;
            records.extend(
                rows.iter()
                    .map(approval_from_row)
                    .collect::<Result<Vec<_>, _>>()?,
            );
        }
        Ok(records)
    }

    async fn commit_approval_decision(
        &self,
        id: &str,
        expected_revision: u64,
        decision: ApprovalResolution,
    ) -> Result<ApprovalAuditCommit, StoreError> {
        let rationale = decision.rationale().trim();
        if rationale.is_empty() {
            return Err("Approval decision rationale 不能为空".into());
        }
        let rationale = rationale.chars().take(100_000).collect::<String>();
        let risk_tags = decision.risk_tags().to_vec();
        let target_status = decision.status();
        let mut tx = self.pool.begin().await?;
        let Some(row) = sqlx::query("SELECT * FROM approval_requests WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
        else {
            tx.commit().await?;
            return Ok(audit(ApprovalMutation::NotFound, false, None));
        };
        let current = approval_from_row(&row)?;
        if current.status == target_status
            && current.rationale.as_deref() == Some(rationale.as_str())
            && current.risk_tags == risk_tags
        {
            let job = approval_job_in_tx(&mut tx, &current).await?;
            let event = approval_decision_event(&current, &job);
            let created = append_event_in_tx(&mut tx, &event).await?;
            tx.commit().await?;
            return Ok(audit(
                ApprovalMutation::Existing(current),
                created,
                Some(event),
            ));
        }
        if current.revision != expected_revision {
            tx.commit().await?;
            return Ok(audit(
                ApprovalMutation::Conflict {
                    current,
                    reason: "Approval decision revision 已变化".to_string(),
                },
                false,
                None,
            ));
        }
        if !current.status.is_pending() {
            tx.commit().await?;
            return Ok(audit(
                ApprovalMutation::Rejected {
                    current,
                    reason: "Approval 已有不同决定或已取消，不能覆盖".to_string(),
                },
                false,
                None,
            ));
        }
        let grant_id = if target_status == ApprovalStatus::Allowed {
            Some(stable_grant_id(
                &current.id,
                &current.request_digest,
                &current.policy_digest,
            )?)
        } else {
            None
        };
        let now = now_text();
        let updated = sqlx::query(
            r#"UPDATE approval_requests
               SET revision = revision + 1, status = $1, rationale = $2,
                   risk_tags_json = $3, grant_id = $4, last_error = NULL,
                   updated_at = $5, decided_at = $5
               WHERE id = $6 AND revision = $7
                 AND status IN ('pending_auto', 'pending_human')"#,
        )
        .bind(target_status.as_str())
        .bind(&rationale)
        .bind(serde_json::to_value(&risk_tags)?)
        .bind(grant_id)
        .bind(&now)
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(audit(
                mutation_failure(
                    self,
                    id,
                    expected_revision,
                    "Approval decision 前置条件不再成立",
                )
                .await?,
                false,
                None,
            ));
        }
        let row = sqlx::query("SELECT * FROM approval_requests WHERE id = $1")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        let updated = approval_from_row(&row)?;
        let job = approval_job_in_tx(&mut tx, &updated).await?;
        let event = approval_decision_event(&updated, &job);
        let created = append_event_in_tx(&mut tx, &event).await?;
        tx.commit().await?;
        Ok(audit(
            ApprovalMutation::Updated(updated),
            created,
            Some(event),
        ))
    }

    async fn commit_approval_cancellation(
        &self,
        id: &str,
        expected_revision: u64,
        reason: &str,
    ) -> Result<ApprovalAuditCommit, StoreError> {
        let reason = reason.trim();
        if reason.is_empty() {
            return Err("Approval cancel reason 不能为空".into());
        }
        let reason = reason.chars().take(100_000).collect::<String>();
        let mut tx = self.pool.begin().await?;
        let Some(row) = sqlx::query("SELECT * FROM approval_requests WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
        else {
            tx.commit().await?;
            return Ok(audit(ApprovalMutation::NotFound, false, None));
        };
        let current = approval_from_row(&row)?;
        if current.status == ApprovalStatus::Cancelled
            && current.cancel_reason.as_deref() == Some(reason.as_str())
        {
            let job = approval_job_in_tx(&mut tx, &current).await?;
            let event = approval_decision_event(&current, &job);
            let created = append_event_in_tx(&mut tx, &event).await?;
            tx.commit().await?;
            return Ok(audit(
                ApprovalMutation::Existing(current),
                created,
                Some(event),
            ));
        }
        if current.revision != expected_revision {
            tx.commit().await?;
            return Ok(audit(
                ApprovalMutation::Conflict {
                    current,
                    reason: "Approval cancellation revision 已变化".to_string(),
                },
                false,
                None,
            ));
        }
        let cancellable = current.status.is_pending()
            || (current.status == ApprovalStatus::Allowed && current.grant_consumed_at.is_none());
        if !cancellable {
            tx.commit().await?;
            return Ok(audit(
                ApprovalMutation::Rejected {
                    current,
                    reason: "Approval 已拒绝、已取消或授权已消费，不能取消".to_string(),
                },
                false,
                None,
            ));
        }
        let now = now_text();
        let updated = sqlx::query(
            r#"UPDATE approval_requests
               SET revision = revision + 1, status = 'cancelled', grant_id = NULL,
                   cancel_reason = $1, updated_at = $2, cancelled_at = $2
               WHERE id = $3 AND revision = $4
                 AND (status IN ('pending_auto', 'pending_human')
                      OR (status = 'allowed' AND grant_consumed_at IS NULL))"#,
        )
        .bind(&reason)
        .bind(&now)
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(audit(
                mutation_failure(
                    self,
                    id,
                    expected_revision,
                    "Approval cancellation 前置条件不再成立",
                )
                .await?,
                false,
                None,
            ));
        }
        let row = sqlx::query("SELECT * FROM approval_requests WHERE id = $1")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        let updated = approval_from_row(&row)?;
        let job = approval_job_in_tx(&mut tx, &updated).await?;
        let event = approval_decision_event(&updated, &job);
        let created = append_event_in_tx(&mut tx, &event).await?;
        tx.commit().await?;
        Ok(audit(
            ApprovalMutation::Updated(updated),
            created,
            Some(event),
        ))
    }
}

fn audit(
    mutation: ApprovalMutation,
    event_created: bool,
    event: Option<Event>,
) -> ApprovalAuditCommit {
    ApprovalAuditCommit {
        mutation,
        event_created,
        event,
    }
}

#[async_trait::async_trait]
impl CapabilityLeaseStore for PostgresStore {
    async fn ensure_capability_lease(
        &self,
        lease: NewCapabilityLease,
    ) -> Result<CapabilityLeaseMutation, StoreError> {
        for (field, value) in [
            ("id", lease.id.as_str()),
            ("principal_id", lease.principal_id.as_str()),
            ("agent_id", lease.agent_id.as_str()),
            ("thread_id", lease.thread_id.as_str()),
            ("target_id", lease.target_id.as_str()),
            ("policy_digest", lease.policy_digest.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(format!("Capability Lease {field} 不能为空").into());
            }
        }
        if lease.capabilities.is_empty()
            || lease
                .capabilities
                .iter()
                .any(|value| value.trim().is_empty())
        {
            return Err("Capability Lease 至少需要一个非空 capability".into());
        }
        let now = Utc::now();
        if lease.expires_at <= now {
            return Err("Capability Lease expires_at 必须晚于当前时间".into());
        }
        let now_text = now_text();
        let inserted = sqlx::query(
            r#"INSERT INTO capability_leases
               (id, revision, principal_id, agent_id, thread_id, target_id,
                capabilities_json, requested_json, policy_digest, status,
                issued_by_approval_id, issued_at, expires_at, updated_at)
               VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10, $11, $10)
               ON CONFLICT(id) DO NOTHING"#,
        )
        .bind(&lease.id)
        .bind(&lease.principal_id)
        .bind(&lease.agent_id)
        .bind(&lease.thread_id)
        .bind(&lease.target_id)
        .bind(serde_json::to_value(&lease.capabilities)?)
        .bind(&lease.requested)
        .bind(&lease.policy_digest)
        .bind(&lease.issued_by_approval_id)
        .bind(&now_text)
        .bind(
            lease
                .expires_at
                .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
        )
        .execute(&self.pool)
        .await?;
        let current = self
            .get_capability_lease(&lease.id)
            .await?
            .ok_or("Capability Lease insert 后不可见")?;
        let exact = current.principal_id == lease.principal_id
            && current.agent_id == lease.agent_id
            && current.thread_id == lease.thread_id
            && current.target_id == lease.target_id
            && current.capabilities == lease.capabilities
            && current.requested == lease.requested
            && current.policy_digest == lease.policy_digest
            && current.issued_by_approval_id == lease.issued_by_approval_id
            && current.expires_at == lease.expires_at;
        if !exact {
            return Ok(CapabilityLeaseMutation::Conflict { current });
        }
        if inserted.rows_affected() == 1 {
            Ok(CapabilityLeaseMutation::Created(current))
        } else {
            Ok(CapabilityLeaseMutation::Existing(current))
        }
    }

    async fn get_capability_lease(
        &self,
        id: &str,
    ) -> Result<Option<CapabilityLeaseRecord>, StoreError> {
        sqlx::query("SELECT * FROM capability_leases WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(capability_lease_from_row)
            .transpose()
    }

    async fn list_capability_leases(
        &self,
        filter: CapabilityLeaseFilter,
    ) -> Result<Vec<CapabilityLeaseRecord>, StoreError> {
        if filter.limit == Some(0) {
            return Ok(Vec::new());
        }
        let mut query = QueryBuilder::<Postgres>::new("SELECT * FROM capability_leases WHERE TRUE");
        if let Some(value) = filter.principal_id {
            query.push(" AND principal_id = ").push_bind(value);
        }
        if let Some(value) = filter.agent_id {
            query.push(" AND agent_id = ").push_bind(value);
        }
        if let Some(value) = filter.thread_id {
            query.push(" AND thread_id = ").push_bind(value);
        }
        if let Some(value) = filter.target_id {
            query.push(" AND target_id = ").push_bind(value);
        }
        if let Some(value) = filter.capability {
            query
                .push(" AND capabilities_json::jsonb @> ")
                .push_bind(serde_json::to_string(&vec![value])?)
                .push("::jsonb");
        }
        if let Some(active_at) = filter.active_at {
            query
                .push(" AND status = 'active' AND expires_at > ")
                .push_bind(active_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
        }
        query.push(" ORDER BY issued_at DESC, id");
        if let Some(limit) = filter.limit {
            query.push(" LIMIT ").push_bind(i64::try_from(limit)?);
        }
        let rows = query.build().fetch_all(&self.pool).await?;
        rows.iter().map(capability_lease_from_row).collect()
    }

    async fn revoke_capability_lease(
        &self,
        id: &str,
        expected_revision: u64,
        reason: &str,
    ) -> Result<CapabilityLeaseMutation, StoreError> {
        let reason = reason.trim();
        if reason.is_empty() {
            return Err("Capability Lease revoke reason 不能为空".into());
        }
        let Some(current) = self.get_capability_lease(id).await? else {
            return Ok(CapabilityLeaseMutation::NotFound);
        };
        if current.status == CapabilityLeaseStatus::Revoked
            && current.revoke_reason.as_deref() == Some(reason)
        {
            return Ok(CapabilityLeaseMutation::Existing(current));
        }
        if current.revision != expected_revision || current.status != CapabilityLeaseStatus::Active
        {
            return Ok(CapabilityLeaseMutation::Conflict { current });
        }
        let now = now_text();
        let result = sqlx::query(
            r#"UPDATE capability_leases
               SET revision = revision + 1, status = 'revoked', revoke_reason = $1,
                   revoked_at = $2, updated_at = $2
               WHERE id = $3 AND revision = $4 AND status = 'active'"#,
        )
        .bind(reason)
        .bind(&now)
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .execute(&self.pool)
        .await?;
        let updated = self
            .get_capability_lease(id)
            .await?
            .ok_or("Capability Lease revoke 后不可见")?;
        if result.rows_affected() == 1 {
            Ok(CapabilityLeaseMutation::Updated(updated))
        } else {
            Ok(CapabilityLeaseMutation::Conflict { current: updated })
        }
    }
}

fn event_payload_str<'a>(event: &'a Event, key: &str) -> Result<&'a str, StoreError> {
    event
        .payload
        .get(key)
        .and_then(JsonValue::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Approval request Event 缺少非空字符串字段 '{key}'").into())
}

fn validate_request_event(
    event: &Event,
    job: &NewExecutionJob,
    approval: &NewApprovalRequest,
) -> Result<(), StoreError> {
    if event.id.trim().is_empty() || event.actor.trim().is_empty() {
        return Err("Approval request Event id/actor 不能为空".into());
    }
    if event.event_type != "approval_requested" || event.topic != "runtime/approval_requested" {
        return Err(
            "Approval request Event 必须使用 approval_requested/runtime/approval_requested".into(),
        );
    }
    for (key, expected) in [
        ("approval_id", approval.id.as_str()),
        ("job_id", job.id.as_str()),
        ("request_digest", approval.request_digest.as_str()),
        ("policy_digest", approval.policy_digest.as_str()),
        ("activation_id", job.activation_id.as_str()),
        ("thread_id", job.thread_id.as_str()),
        ("context_id", job.context_id.as_str()),
        ("session_id", job.session_id.as_str()),
        ("tool_call_id", job.tool_call_id.as_str()),
    ] {
        if event_payload_str(event, key)? != expected {
            return Err(format!("Approval request Event 字段 '{key}' 与权威记录不一致").into());
        }
    }
    if event.payload.get("action") != Some(&approval.action)
        || event.payload.get("requested") != Some(&approval.requested)
        || event
            .payload
            .get("justification")
            .and_then(JsonValue::as_str)
            != Some(approval.justification.as_str())
    {
        return Err("Approval request Event 的 action/requested/justification 与请求不一致".into());
    }
    Ok(())
}

fn validate_persisted_authority(approval: &ApprovalRecord) -> Result<(), StoreError> {
    let identity = stable_approval_identity(
        &approval.job_id,
        &approval.action,
        &approval.requested,
        &approval.policy_digest,
    )?;
    if identity.approval_id != approval.id || identity.request_digest != approval.request_digest {
        return Err(format!("Approval '{}' 的持久化身份摘要已损坏", approval.id).into());
    }
    if let Some(grant_id) = approval.grant_id.as_deref() {
        let expected = stable_grant_id(
            &approval.id,
            &approval.request_digest,
            &approval.policy_digest,
        )?;
        if grant_id != expected {
            return Err(format!("Approval '{}' 的 Grant 摘要已损坏", approval.id).into());
        }
    }
    Ok(())
}

#[async_trait::async_trait]
impl ExecutionApprovalStore for PostgresStore {
    async fn ensure_execution_job_with_approval(
        &self,
        job: NewExecutionJob,
        approval: NewApprovalRequest,
        request_event: &Event,
    ) -> Result<ExecutionApprovalMutation, StoreError> {
        if !job.requires_approval {
            return Err("原子 Approval 创建要求 Execution Job.requires_approval=true".into());
        }
        if approval.job_id != job.id {
            return Err("Approval job_id 与 Execution Job id 不一致".into());
        }
        validate_new_job(&job)?;
        validate_new_request(&approval)?;
        validate_request_event(request_event, &job, &approval)?;
        let mut tx = self.pool.begin().await?;
        let (job_record, job_created) = ensure_job_in_tx(&mut tx, &job).await?;
        let approval_mutation = ensure_approval_in_tx(&mut tx, &approval).await?;
        let (approval_record, approval_created) = match approval_mutation {
            ApprovalMutation::Created(record) => (record, true),
            ApprovalMutation::Existing(record) => (record, false),
            ApprovalMutation::Conflict { current, reason } => {
                tx.rollback().await?;
                return Ok(ExecutionApprovalMutation::Conflict {
                    job: (!job_created).then_some(job_record),
                    approval: Some(current),
                    reason,
                });
            }
            ApprovalMutation::Rejected { current, reason } => {
                tx.rollback().await?;
                return Ok(ExecutionApprovalMutation::Rejected {
                    job: (!job_created).then_some(job_record),
                    approval: Some(current),
                    reason,
                });
            }
            ApprovalMutation::Updated(_) | ApprovalMutation::NotFound => {
                tx.rollback().await?;
                return Err("Approval ensure 返回了不可能的状态".into());
            }
        };
        let event_created = append_event_in_tx(&mut tx, request_event).await?;
        tx.commit().await?;
        if job_created || approval_created || event_created {
            Ok(ExecutionApprovalMutation::Created {
                job: job_record,
                approval: approval_record,
            })
        } else {
            Ok(ExecutionApprovalMutation::Existing {
                job: job_record,
                approval: approval_record,
            })
        }
    }

    async fn claim_execution_job_with_grant(
        &self,
        job_id: &str,
        expected_job_revision: u64,
        approval_id: &str,
        expected_approval_revision: u64,
        worker_id: &str,
        claim_token: &str,
        lease_expires_at: DateTime<Utc>,
    ) -> Result<ExecutionApprovalMutation, StoreError> {
        for (field, value) in [
            ("job_id", job_id),
            ("approval_id", approval_id),
            ("worker_id", worker_id),
            ("claim_token", claim_token),
        ] {
            if value.trim().is_empty() {
                return Err(format!("Grant claim {field} 不能为空").into());
            }
        }
        let now = Utc::now();
        if lease_expires_at <= now {
            return Err("Grant claim lease 必须在未来".into());
        }
        let mut tx = self.pool.begin().await?;
        // Lock in stable Job -> Approval order to avoid cross-worker deadlocks.
        let job_row = sqlx::query("SELECT * FROM execution_jobs WHERE id = $1 FOR UPDATE")
            .bind(job_id)
            .fetch_optional(&mut *tx)
            .await?;
        let approval_row = sqlx::query("SELECT * FROM approval_requests WHERE id = $1 FOR UPDATE")
            .bind(approval_id)
            .fetch_optional(&mut *tx)
            .await?;
        let (Some(job_row), Some(approval_row)) = (job_row, approval_row) else {
            tx.commit().await?;
            return Ok(ExecutionApprovalMutation::NotFound);
        };
        let job = execution_job_from_row(&job_row)?;
        let approval = approval_from_row(&approval_row)?;
        validate_persisted_authority(&approval)?;
        let grant_id = approval.grant_id.clone();
        let exact_replay = job.status == ExecutionJobStatus::Running
            && job.claimed_by.as_deref() == Some(worker_id)
            && job.claim_token.as_deref() == Some(claim_token)
            && job.approval_ref == grant_id
            && approval.status == ApprovalStatus::Allowed
            && approval.grant_consumed_at.is_some()
            && approval.consumed_by_claim_token.as_deref() == Some(claim_token);
        if exact_replay {
            tx.commit().await?;
            return Ok(ExecutionApprovalMutation::Existing { job, approval });
        }
        if job.revision != expected_job_revision || approval.revision != expected_approval_revision
        {
            tx.commit().await?;
            return Ok(ExecutionApprovalMutation::Conflict {
                job: Some(job),
                approval: Some(approval),
                reason: "Execution Job 或 Approval revision 已变化".to_string(),
            });
        }
        if approval.job_id != job.id {
            tx.commit().await?;
            return Ok(ExecutionApprovalMutation::Rejected {
                job: Some(job),
                approval: Some(approval),
                reason: "Approval Grant 不属于目标 Execution Job".to_string(),
            });
        }
        if job.status != ExecutionJobStatus::WaitingApproval
            || job.cancel_requested_at.is_some()
            || job.approval_ref.is_some()
        {
            tx.commit().await?;
            return Ok(ExecutionApprovalMutation::Rejected {
                job: Some(job),
                approval: Some(approval),
                reason: "Execution Job 不处于可消费 Grant 的 waiting_approval 状态".to_string(),
            });
        }
        if approval.status != ApprovalStatus::Allowed
            || approval.grant_consumed_at.is_some()
            || approval.consumed_by_claim_token.is_some()
        {
            tx.commit().await?;
            return Ok(ExecutionApprovalMutation::Rejected {
                job: Some(job),
                approval: Some(approval),
                reason: "Approval 尚未允许、已取消或 Grant 已被消费".to_string(),
            });
        }
        let Some(grant_id) = grant_id else {
            return Err("Allowed Approval 缺少 Grant ID".into());
        };
        let now_text = now.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let consumed = sqlx::query(
            r#"UPDATE approval_requests
               SET revision = revision + 1, grant_consumed_at = $1,
                   consumed_by_claim_token = $2, last_error = NULL, updated_at = $1
               WHERE id = $3 AND revision = $4 AND job_id = $5 AND status = 'allowed'
                 AND grant_id = $6 AND grant_consumed_at IS NULL
                 AND consumed_by_claim_token IS NULL"#,
        )
        .bind(&now_text)
        .bind(claim_token)
        .bind(approval_id)
        .bind(i64::try_from(expected_approval_revision)?)
        .bind(job_id)
        .bind(&grant_id)
        .execute(&mut *tx)
        .await?;
        if consumed.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(ExecutionApprovalMutation::Conflict {
                job: self.get_execution_job(job_id).await?,
                approval: self.get_approval(approval_id).await?,
                reason: "Approval Grant 消费前置条件不再成立".to_string(),
            });
        }
        let claimed = sqlx::query(
            r#"UPDATE execution_jobs
               SET revision = revision + 1, status = 'running', claimed_by = $1,
                   claim_token = $2, lease_expires_at = $3, heartbeat_at = $4,
                   approval_ref = $5, started_at = COALESCE(started_at, $4), updated_at = $4
               WHERE id = $6 AND revision = $7 AND status = 'waiting_approval'
                 AND approval_ref IS NULL AND cancel_requested_at IS NULL"#,
        )
        .bind(worker_id)
        .bind(claim_token)
        .bind(lease_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
        .bind(&now_text)
        .bind(&grant_id)
        .bind(job_id)
        .bind(i64::try_from(expected_job_revision)?)
        .execute(&mut *tx)
        .await?;
        if claimed.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(ExecutionApprovalMutation::Conflict {
                job: self.get_execution_job(job_id).await?,
                approval: self.get_approval(approval_id).await?,
                reason: "Execution Job claim 前置条件不再成立；Grant 消费已回滚".to_string(),
            });
        }
        let job = sqlx::query("SELECT * FROM execution_jobs WHERE id = $1")
            .bind(job_id)
            .fetch_one(&mut *tx)
            .await?;
        let approval = sqlx::query("SELECT * FROM approval_requests WHERE id = $1")
            .bind(approval_id)
            .fetch_one(&mut *tx)
            .await?;
        let job = execution_job_from_row(&job)?;
        let approval = approval_from_row(&approval)?;
        tx.commit().await?;
        Ok(ExecutionApprovalMutation::Updated { job, approval })
    }
}
