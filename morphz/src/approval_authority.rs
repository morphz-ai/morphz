//! Stable identities for the durable approval control plane.
//!
//! Approval identities are deterministic rather than process-local.  The
//! request digest binds the normalized action and requested capability delta;
//! the approval id additionally binds the physical Execution Job and effective
//! permission-policy digest.  Human-readable justification is deliberately not
//! part of the grant scope, but the Store still treats it as immutable request
//! content when checking an exact replay.

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::event::Event;
use crate::memory::{ApprovalRecord, ExecutionJobRecord};

const REQUEST_DOMAIN: &[u8] = b"morphz.approval-request.v1\0";
const APPROVAL_ID_DOMAIN: &[u8] = b"morphz.approval-id.v1\0";
const GRANT_ID_DOMAIN: &[u8] = b"morphz.approval-grant.v1\0";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StableApprovalIdentity {
    pub approval_id: String,
    pub request_digest: String,
    pub policy_digest: String,
}

pub fn stable_approval_identity(
    job_id: &str,
    action: &Value,
    requested: &Value,
    policy_digest: &str,
) -> Result<StableApprovalIdentity, String> {
    let job_id = require_nonempty("job_id", job_id)?;
    let policy_digest = require_nonempty("policy_digest", policy_digest)?;
    let action = canonical_json(action, false)?;
    // Capability collections (roots and secret names) are sets. Their order
    // must not manufacture a second approval identity for the same authority.
    let requested = canonical_json(requested, true)?;

    let request_digest = digest_parts(REQUEST_DOMAIN, &[&action, &requested]);
    let approval_id_digest = digest_parts(
        APPROVAL_ID_DOMAIN,
        &[
            job_id.as_bytes(),
            request_digest.as_bytes(),
            policy_digest.as_bytes(),
        ],
    );
    Ok(StableApprovalIdentity {
        approval_id: format!("approval_{approval_id_digest}"),
        request_digest,
        policy_digest: policy_digest.to_string(),
    })
}

pub fn stable_grant_id(
    approval_id: &str,
    request_digest: &str,
    policy_digest: &str,
) -> Result<String, String> {
    let approval_id = require_nonempty("approval_id", approval_id)?;
    let request_digest = require_nonempty("request_digest", request_digest)?;
    let policy_digest = require_nonempty("policy_digest", policy_digest)?;
    Ok(format!(
        "grant_{}",
        digest_parts(
            GRANT_ID_DOMAIN,
            &[
                approval_id.as_bytes(),
                request_digest.as_bytes(),
                policy_digest.as_bytes(),
            ],
        )
    ))
}

/// Immutable audit projection of the durable authority decision. The linked
/// Execution Job supplies the stable routing envelope, so every decision can
/// wake its Context/Session after either automatic or human review.
pub fn approval_decision_event(approval: &ApprovalRecord, job: &ExecutionJobRecord) -> Event {
    let is_cancellation = approval.status == crate::memory::ApprovalStatus::Cancelled;
    let rationale = if is_cancellation {
        approval.cancel_reason.as_deref()
    } else {
        approval.rationale.as_deref()
    };
    let risk_tags = if is_cancellation {
        serde_json::json!([])
    } else {
        serde_json::json!(approval.risk_tags)
    };
    let mut event = Event::new(
        format!(
            "approval_decided_{}_{}",
            approval.id,
            approval.status.as_str()
        ),
        "System-ApprovalAuthority".to_string(),
        "approval_decision".to_string(),
        "runtime/approval_decision".to_string(),
        serde_json::Map::from_iter([
            ("context_id".to_string(), serde_json::json!(job.context_id)),
            ("session_id".to_string(), serde_json::json!(job.session_id)),
            ("correlation_id".to_string(), serde_json::json!(approval.id)),
            ("approval_id".to_string(), serde_json::json!(approval.id)),
            ("job_id".to_string(), serde_json::json!(approval.job_id)),
            (
                "activation_id".to_string(),
                serde_json::json!(job.activation_id),
            ),
            (
                "activation_id".to_string(),
                serde_json::json!(job.activation_id),
            ),
            ("thread_id".to_string(), serde_json::json!(job.thread_id)),
            (
                "tool_call_id".to_string(),
                serde_json::json!(job.tool_call_id),
            ),
            (
                "status".to_string(),
                serde_json::json!(approval.status.as_str()),
            ),
            ("rationale".to_string(), serde_json::json!(rationale)),
            ("risk_tags".to_string(), risk_tags),
            (
                "cancel_reason".to_string(),
                serde_json::json!(approval.cancel_reason),
            ),
            ("grant_id".to_string(), serde_json::json!(approval.grant_id)),
            (
                "text".to_string(),
                serde_json::json!(format!(
                    "Approval {} has already been decided as {}",
                    approval.id,
                    approval.status.as_str()
                )),
            ),
        ]),
    );
    // The audit projection must be byte-for-byte reproducible on an exact
    // replay. Using Event::new's wall clock would make a retry conflict with
    // the Event that was atomically committed by the first attempt.
    event.timestamp = if is_cancellation {
        approval.cancelled_at.unwrap_or(approval.updated_at)
    } else {
        approval.decided_at.unwrap_or(approval.updated_at)
    };
    event
}

fn require_nonempty<'a>(field: &str, value: &'a str) -> Result<&'a str, String> {
    let value = value.trim();
    if value.is_empty() {
        Err(format!("{field} must not be empty"))
    } else {
        Ok(value)
    }
}

fn canonical_json(value: &Value, set_arrays: bool) -> Result<Vec<u8>, String> {
    let normalized = canonical_value(value, set_arrays);
    serde_json::to_vec(&normalized)
        .map_err(|error| format!("failed to serialize canonical approval input: {error}"))
}

fn canonical_value(value: &Value, set_arrays: bool) -> Value {
    match value {
        Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            Value::Object(
                keys.into_iter()
                    .map(|key| (key.clone(), canonical_value(&object[key], set_arrays)))
                    .collect(),
            )
        }
        Value::Array(values) => {
            let mut normalized = values
                .iter()
                .map(|value| canonical_value(value, set_arrays))
                .collect::<Vec<_>>();
            if set_arrays {
                normalized.sort_by_key(|value| serde_json::to_string(value).unwrap_or_default());
                normalized.dedup();
            }
            Value::Array(normalized)
        }
        value => value.clone(),
    }
}

fn digest_parts(domain: &[u8], parts: &[&[u8]]) -> String {
    let mut digest = Sha256::new();
    digest.update(domain);
    for part in parts {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part);
    }
    format!("{:x}", digest.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn identity_is_stable_across_object_and_capability_set_order() {
        let left = stable_approval_identity(
            "job-1",
            &json!({"cwd": "/work", "command": "cargo test"}),
            &json!({"network": true, "read_roots": ["/b", "/a", "/a"]}),
            "policy-v1",
        )
        .unwrap();
        let right = stable_approval_identity(
            "job-1",
            &json!({"command": "cargo test", "cwd": "/work"}),
            &json!({"read_roots": ["/a", "/b"], "network": true}),
            "policy-v1",
        )
        .unwrap();
        assert_eq!(left, right);
    }

    #[test]
    fn identity_changes_with_job_request_or_policy() {
        let base = stable_approval_identity(
            "job-1",
            &json!({"command": "cargo test"}),
            &json!({"network": true}),
            "policy-v1",
        )
        .unwrap();
        for changed in [
            stable_approval_identity(
                "job-2",
                &json!({"command": "cargo test"}),
                &json!({"network": true}),
                "policy-v1",
            )
            .unwrap(),
            stable_approval_identity(
                "job-1",
                &json!({"command": "cargo publish"}),
                &json!({"network": true}),
                "policy-v1",
            )
            .unwrap(),
            stable_approval_identity(
                "job-1",
                &json!({"command": "cargo test"}),
                &json!({"network": true}),
                "policy-v2",
            )
            .unwrap(),
        ] {
            assert_ne!(base.approval_id, changed.approval_id);
        }
    }

    #[test]
    fn grant_identity_is_stable_and_scoped() {
        let first = stable_grant_id("approval-1", "request-1", "policy-1").unwrap();
        assert_eq!(
            first,
            stable_grant_id("approval-1", "request-1", "policy-1").unwrap()
        );
        assert_ne!(
            first,
            stable_grant_id("approval-1", "request-2", "policy-1").unwrap()
        );
    }
}
