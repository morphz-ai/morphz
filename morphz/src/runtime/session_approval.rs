//! Principal-scoped human approval. Public callers never borrow operator authority.
use super::*;
use crate::approval::{ApprovalAction, CapabilityDelta};
use crate::memory::{ApprovalDecisionAuthority, ApprovalRecord, ApprovalStatus};

#[cfg(test)]
#[path = "session_approval_tests.rs"]
mod tests;

#[derive(Debug)]
pub enum SessionApprovalError {
    NotFound,
    Conflict(String),
    Unavailable,
}

impl std::fmt::Display for SessionApprovalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::NotFound => "Approval does not exist for this Principal and Session",
            Self::Conflict(message) => message,
            Self::Unavailable => {
                "Approval storage or delivery is temporarily unavailable; retry the same decision"
            }
        })
    }
}
impl std::error::Error for SessionApprovalError {}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionApprovalChoice {
    AllowOnce,
    AllowThread,
    AllowObjective,
    AllowSession,
    Deny,
}

impl SessionApprovalChoice {
    fn scope(self) -> Option<ApprovalScope> {
        match self {
            Self::AllowOnce => Some(ApprovalScope::Once),
            Self::AllowThread => Some(ApprovalScope::Thread),
            Self::AllowObjective => Some(ApprovalScope::Objective),
            Self::AllowSession => Some(ApprovalScope::Session),
            Self::Deny => None,
        }
    }
}

/// The client chooses only a lifetime, never paths, identity, or a Permission Profile.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionApprovalCommand {
    pub expected_revision: u64,
    pub decision: SessionApprovalChoice,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionApprovalView {
    pub id: String,
    pub revision: u64,
    pub status: ApprovalStatus,
    pub action: ApprovalAction,
    pub requested: CapabilityDelta,
    pub justification: String,
    pub thread_id: String,
    pub target_id: String,
    pub objective_id: Option<String>,
    pub requested_scope: ApprovalScope,
    pub available_scopes: Vec<ApprovalScope>,
    pub lease_expires_at: Option<chrono::DateTime<chrono::Utc>>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub decided_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionApprovalPage {
    pub approvals: Vec<SessionApprovalView>,
    /// The next oldest requests become visible as displayed requests are resolved.
    pub truncated: bool,
}

fn unavailable(error: impl std::fmt::Display) -> SessionApprovalError {
    tracing::error!(event_code = "runtime.session_approval.failed", %error,
        "Session approval operation failed");
    SessionApprovalError::Unavailable
}

impl MorphzRuntime {
    pub async fn session_pending_approvals(
        &self,
        authority: &ApprovalDecisionAuthority,
    ) -> Result<SessionApprovalPage, SessionApprovalError> {
        const LIMIT: usize = 100;
        let mut records = self
            .inner
            .store
            .list_principal_pending_approvals(authority, LIMIT + 1)
            .await
            .map_err(unavailable)?;
        let truncated = records.len() > LIMIT;
        records.truncate(LIMIT);
        let mut approvals = Vec::with_capacity(records.len());
        for record in records {
            approvals.push(self.session_approval_view(record).await?);
        }
        Ok(SessionApprovalPage {
            approvals,
            truncated,
        })
    }

    pub async fn session_approval(
        &self,
        authority: &ApprovalDecisionAuthority,
        id: &str,
    ) -> Result<SessionApprovalView, SessionApprovalError> {
        let record = self
            .inner
            .store
            .get_principal_approval(authority, id)
            .await
            .map_err(unavailable)?
            .ok_or(SessionApprovalError::NotFound)?;
        self.session_approval_view(record).await
    }

    async fn session_approval_view(
        &self,
        record: ApprovalRecord,
    ) -> Result<SessionApprovalView, SessionApprovalError> {
        let job = self
            .inner
            .store
            .get_execution_job(&record.job_id)
            .await
            .map_err(unavailable)?
            .ok_or(SessionApprovalError::NotFound)?;
        let action: ApprovalAction =
            serde_json::from_value(record.action.clone()).map_err(unavailable)?;
        let requested: CapabilityDelta =
            serde_json::from_value(record.requested.clone()).map_err(unavailable)?;
        let requested_scope = job
            .request
            .get("approval_scope")
            .cloned()
            .map(serde_json::from_value::<ApprovalScope>)
            .transpose()
            .map_err(unavailable)?
            .unwrap_or_default();
        let objective_id = job
            .request
            .get(CAPABILITY_LEASE_OBJECTIVE_REQUEST_KEY)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let mut available_scopes = Vec::new();
        let mut lease_expires_at = None;
        if record.status == ApprovalStatus::PendingHuman
            && job.status == ExecutionJobStatus::WaitingApproval
        {
            let thread = self
                .inner
                .store
                .get_thread(&job.thread_id)
                .await
                .map_err(unavailable)?;
            let activation = self
                .inner
                .store
                .get_thread_activation(&job.activation_id)
                .await
                .map_err(unavailable)?;
            if thread.is_some_and(|thread| thread.lifecycle == ThreadLifecycle::Open)
                && activation.is_some_and(|activation| {
                    matches!(
                        activation.status,
                        ThreadActivationStatus::Queued | ThreadActivationStatus::Running
                    )
                })
            {
                available_scopes.push(ApprovalScope::Once);
                if let Some(offer) = self
                    .approval_lease_offer(&record, &job, &action, &requested)
                    .await
                {
                    lease_expires_at = Some(offer.expires_at);
                    available_scopes.push(ApprovalScope::Thread);
                    if objective_id.is_some() {
                        available_scopes.push(ApprovalScope::Objective);
                    }
                    available_scopes.push(ApprovalScope::Session);
                }
            }
        }
        Ok(SessionApprovalView {
            id: record.id,
            revision: record.revision,
            status: record.status,
            action,
            requested,
            justification: record.justification,
            thread_id: job.thread_id,
            target_id: job.target_id,
            objective_id,
            requested_scope,
            available_scopes,
            lease_expires_at,
            created_at: record.created_at,
            decided_at: record.decided_at,
        })
    }

    /// Shared by operator and Principal projections; no ephemeral Hub lookup or
    /// global approval scan is necessary to reconstruct a durable capability offer.
    pub(super) async fn approval_lease_offer(
        &self,
        record: &ApprovalRecord,
        job: &ExecutionJobRecord,
        action: &ApprovalAction,
        requested: &CapabilityDelta,
    ) -> Option<CapabilityLeaseOffer> {
        if !self.inner.config.edge_execution.capability_leases_enabled {
            return None;
        }
        let ttl = self
            .inner
            .config
            .edge_execution
            .capability_lease_ttl
            .as_secs();
        if ttl == 0 {
            return None;
        }
        let expires_at = record
            .created_at
            .checked_add_signed(chrono::Duration::try_seconds(i64::try_from(ttl).ok()?)?)?;
        if expires_at <= chrono::Utc::now() {
            return None;
        }
        let requested_scope = job
            .request
            .get("approval_scope")
            .cloned()
            .map(serde_json::from_value::<ApprovalScope>)
            .transpose()
            .ok()?
            .unwrap_or_default();
        let scope = requested_scope.lease_scope()?;
        let principal_id = job.initiating_principal_id.clone()?;
        let thread = self.inner.store.get_thread(&job.thread_id).await.ok()??;
        if thread.lifecycle != ThreadLifecycle::Open {
            return None;
        }
        let target = self
            .inner
            .store
            .get_execution_target(&job.target_id)
            .await
            .ok()??;
        let scope_id = match scope {
            CapabilityLeaseScope::Thread => job.thread_id.clone(),
            CapabilityLeaseScope::Session => job.session_id.clone(),
            CapabilityLeaseScope::Objective => job
                .request
                .get(CAPABILITY_LEASE_OBJECTIVE_REQUEST_KEY)?
                .as_str()?
                .to_string(),
        };
        Some(CapabilityLeaseOffer {
            principal_id,
            agent_id: job.agent_id.clone(),
            session_id: job.session_id.clone(),
            thread_id: job.thread_id.clone(),
            scope,
            scope_id,
            target_id: job.target_id.clone(),
            capability: action.lease_capability(),
            capabilities: reusable_capabilities(action, requested),
            requested: requested.clone(),
            policy_digest: capability_lease_policy_digest(
                &self.inner.permissions.policy_digest(),
                &target.policy_digest,
            ),
            expires_at,
        })
    }

    pub async fn decide_session_approval(
        &self,
        authority: ApprovalDecisionAuthority,
        id: &str,
        command: SessionApprovalCommand,
    ) -> Result<SessionApprovalView, SessionApprovalError> {
        let current = self.session_approval(&authority, id).await?;
        let scope = command.decision.scope();
        // Terminal requests still reach the atomic exact-replay check. A lost
        // receipt must not become a failed decision merely because work resumed.
        if current.status.is_pending()
            && scope.is_some_and(|scope| !current.available_scopes.contains(&scope))
        {
            return Err(SessionApprovalError::Conflict(
                "This approval scope is no longer available; refresh the request".into(),
            ));
        }
        let rationale =
            "The initiating Principal decided through the Session approval channel".to_string();
        let mut risk_tags = vec![format!("approval-principal:{}", authority.principal_id)];
        let (resolution, decision) = match scope {
            None => {
                risk_tags.push("human-denied".into());
                (
                    ApprovalResolution::Deny {
                        rationale: rationale.clone(),
                        risk_tags: risk_tags.clone(),
                    },
                    ApprovalDecision::Deny {
                        rationale,
                        risk_tags,
                    },
                )
            }
            Some(scope) => {
                risk_tags.push("human-approved".into());
                if let Some(scope) = scope.lease_scope() {
                    risk_tags.push(capability_lease_scope_risk_tag(scope).into());
                    risk_tags.push(CAPABILITY_LEASE_APPROVED_RISK_TAG.into());
                }
                let resolution = ApprovalResolution::Allow {
                    rationale: rationale.clone(),
                    risk_tags: risk_tags.clone(),
                };
                let decision = if scope == ApprovalScope::Once {
                    ApprovalDecision::AllowOnce {
                        rationale,
                        risk_tags,
                    }
                } else {
                    ApprovalDecision::AllowLease {
                        rationale,
                        risk_tags,
                    }
                };
                (resolution, decision)
            }
        };
        let commit = self
            .inner
            .store
            .commit_authorized_approval_decision(
                id,
                command.expected_revision,
                resolution,
                Some(authority.clone()),
            )
            .await
            .map_err(unavailable)?;
        match commit.mutation {
            ApprovalMutation::Updated(_) | ApprovalMutation::Existing(_) => {}
            ApprovalMutation::NotFound => return Err(SessionApprovalError::NotFound),
            ApprovalMutation::Conflict { .. } | ApprovalMutation::Rejected { .. } => {
                return Err(SessionApprovalError::Conflict(
                    "Approval changed or is no longer pending; refresh the request".into(),
                ))
            }
            ApprovalMutation::Created(_) => {
                return Err(unavailable("unexpected Created approval mutation"))
            }
        }
        self.publish_approval_decision(id, decision, commit.event_created, commit.event)
            .await
            .map_err(unavailable)?;
        // Re-authorize before returning the receipt; the durable decision remains
        // authoritative even if participation was revoked after commit.
        self.session_approval(&authority, id).await
    }
}
