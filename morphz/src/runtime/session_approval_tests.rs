use super::*;
use crate::approval_authority::stable_approval_identity;
use crate::llm::{Message, Response, ToolDefinition};
use crate::memory::{
    ExecutionApprovalMutation, ExecutionRetrySafety, NewApprovalRequest, NewExecutionJob,
    SessionMountKind,
};
use crate::sdk::{MorphzSdk, SdkErrorCode};
use serde_json::json;

struct OfflineClient;
#[async_trait::async_trait]
impl Client for OfflineClient {
    async fn create_completion(
        &self,
        _: Vec<Message>,
        _: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        panic!("approval contract tests must never call a Provider");
    }
}
fn principal(id: &str) -> PrincipalAssertion {
    PrincipalAssertion {
        principal_id: id.into(),
        provider_id: "test".into(),
        assurance: "test".into(),
        display_name: None,
    }
}
fn authority(session_id: &str, principal_id: &str) -> ApprovalDecisionAuthority {
    ApprovalDecisionAuthority {
        session_id: session_id.into(),
        principal_id: principal_id.into(),
    }
}

async fn fixture(store: Arc<dyn RuntimeStore>) -> (MorphzRuntime, MorphzSdk) {
    let runtime = MorphzRuntime::builder(AppConfig::default(), Arc::new(OfflineClient))
        .store("session-approval-test", store)
        .build()
        .await
        .unwrap();
    runtime
        .ensure_agent(NewAgent {
            id: "approval-agent".into(),
            title: "Test".into(),
            root_context_id: "approval-context".into(),
        })
        .await
        .unwrap();
    runtime
        .ensure_context(NewCognitiveContext {
            id: "approval-context".into(),
            agent_id: "approval-agent".into(),
            title: "Test".into(),
        })
        .await
        .unwrap();
    (runtime.clone(), MorphzSdk::new(runtime))
}

async fn seed(
    runtime: &MorphzRuntime,
    suffix: &str,
    status: ApprovalStatus,
    scope: ApprovalScope,
) -> (ExecutionJobRecord, ApprovalRecord) {
    let session_id = format!("session-{suffix}");
    runtime
        .create_session_for_principal(
            NewSession {
                id: session_id.clone(),
                agent_id: "approval-agent".into(),
                context_id: "approval-context".into(),
                parent_session_id: None,
                title: "Test".into(),
                mount_kind: SessionMountKind::ExistingContext,
            },
            principal("alice"),
        )
        .await
        .unwrap();
    let thread_id = format!("thread-{suffix}");
    let root_turn_id = format!("root-{suffix}");
    let store = &runtime.inner.store;
    store
        .ensure_thread(NewThread {
            id: thread_id.clone(),
            agent_id: "approval-agent".into(),
            context_id: "approval-context".into(),
            session_id: session_id.clone(),
            initiating_principal_id: Some("alice".into()),
            root_turn_id: root_turn_id.clone(),
            kind: ThreadKind::Execution,
            executor_kind: "self".into(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::legacy(),
        })
        .await
        .unwrap();
    let activation_id = format!("activation-{suffix}");
    store
        .ensure_thread_activation(NewThreadActivation {
            id: activation_id.clone(),
            agent_id: "approval-agent".into(),
            context_id: "approval-context".into(),
            session_id: session_id.clone(),
            initiating_principal_id: Some("alice".into()),
            trigger_event_id: format!("trigger-{suffix}"),
            trigger_sequence: 1,
            trigger_kind: "chat/user_message".into(),
            parent_activation_id: None,
            root_turn_id,
        })
        .await
        .unwrap();
    let job = NewExecutionJob {
        id: format!("job-{suffix}"),
        activation_id,
        thread_id,
        agent_id: "approval-agent".into(),
        context_id: "approval-context".into(),
        session_id,
        initiating_principal_id: Some("alice".into()),
        target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.into(),
        tool_call_id: format!("call-{suffix}"),
        tool_name: "exec".into(),
        request: json!({"command":"printf test", "approval_scope": scope}),
        retry_safety: ExecutionRetrySafety::AtMostOnce,
        requires_approval: true,
    };
    let action = json!({"kind":"shell", "command":"printf test", "cwd":"/workspace"});
    let requested =
        json!({"network":false, "write_roots":["/new-project"], "read_roots":[], "secret_env":[]});
    let identity = stable_approval_identity(&job.id, &action, &requested, "policy-test").unwrap();
    let approval = NewApprovalRequest {
        id: identity.approval_id,
        job_id: job.id.clone(),
        request_digest: identity.request_digest,
        policy_digest: identity.policy_digest,
        action,
        requested,
        justification: "Write the requested project".into(),
        pending_status: status,
    };
    let event = Event::new(format!("request-{suffix}"), "test".into(), "approval_requested".into(), "runtime/approval_requested".into(), json!({
        "approval_id":approval.id, "job_id":job.id, "request_digest":approval.request_digest, "policy_digest":approval.policy_digest,
        "activation_id":job.activation_id, "thread_id":job.thread_id, "context_id":job.context_id, "session_id":job.session_id,
        "tool_call_id":job.tool_call_id, "action":approval.action, "requested":approval.requested, "justification":approval.justification,
    }).as_object().unwrap().clone());
    match store
        .ensure_execution_job_with_approval(job, approval, &event)
        .await
        .unwrap()
    {
        ExecutionApprovalMutation::Created { job, approval } => (job, approval),
        other => panic!("unexpected seed: {other:?}"),
    }
}

async fn conformance(runtime: &MorphzRuntime, sdk: &MorphzSdk) {
    let (race_job, race_approval) = seed(
        runtime,
        "race",
        ApprovalStatus::PendingHuman,
        ApprovalScope::Thread,
    )
    .await;
    let actor = authority(&race_job.session_id, "alice");
    let store = &runtime.inner.store;
    let (allow, deny) = tokio::join!(
        store.commit_authorized_approval_decision(
            &race_approval.id,
            race_approval.revision,
            ApprovalResolution::Allow {
                rationale: "allow race".into(),
                risk_tags: vec![]
            },
            Some(actor.clone())
        ),
        store.commit_authorized_approval_decision(
            &race_approval.id,
            race_approval.revision,
            ApprovalResolution::Deny {
                rationale: "deny race".into(),
                risk_tags: vec![]
            },
            Some(actor)
        ),
    );
    let results = [allow.unwrap(), deny.unwrap()];
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result.mutation, ApprovalMutation::Updated(_)))
            .count(),
        1
    );
    assert_eq!(
        results.iter().filter(|result| result.event_created).count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(
                result.mutation,
                ApprovalMutation::Conflict { .. } | ApprovalMutation::Rejected { .. }
            ))
            .count(),
        1
    );
    let (job, approval) = seed(
        runtime,
        "normal",
        ApprovalStatus::PendingHuman,
        ApprovalScope::Thread,
    )
    .await;
    let alice = authority(&job.session_id, "alice");
    runtime
        .bind_session_principal(&job.session_id, principal("bob"))
        .await
        .unwrap();
    let list = sdk
        .session_pending_approvals("alice", &job.session_id)
        .await
        .unwrap();
    assert_eq!(list.approvals.len(), 1);
    assert!(!list.truncated);
    let view = &list.approvals[0];
    assert_eq!(
        view.available_scopes,
        vec![
            ApprovalScope::Once,
            ApprovalScope::Thread,
            ApprovalScope::Session
        ]
    );
    assert_eq!(
        view.requested.write_roots,
        vec![std::path::PathBuf::from("/new-project")]
    );
    assert!(view.lease_expires_at.is_some());
    assert!(sdk
        .session_pending_approvals("bob", &job.session_id)
        .await
        .unwrap()
        .approvals
        .is_empty());
    assert_eq!(
        sdk.session_approval("bob", &job.session_id, &approval.id)
            .await
            .unwrap_err()
            .code,
        SdkErrorCode::NotFound
    );
    assert_eq!(
        sdk.session_pending_approvals("eve", &job.session_id)
            .await
            .unwrap_err()
            .code,
        SdkErrorCode::Forbidden
    );
    let allow = SessionApprovalCommand {
        expected_revision: approval.revision,
        decision: SessionApprovalChoice::AllowSession,
    };
    assert_eq!(
        sdk.decide_session_approval(
            &principal("bob"),
            &job.session_id,
            &approval.id,
            allow.clone()
        )
        .await
        .unwrap_err()
        .code,
        SdkErrorCode::NotFound
    );
    let wrong_revision = SessionApprovalCommand {
        expected_revision: approval.revision + 1,
        ..allow.clone()
    };
    assert_eq!(
        sdk.decide_session_approval(
            &principal("alice"),
            &job.session_id,
            &approval.id,
            wrong_revision
        )
        .await
        .unwrap_err()
        .code,
        SdkErrorCode::Conflict
    );
    assert!(matches!(
        runtime
            .inner
            .store
            .commit_authorized_approval_decision(
                &approval.id,
                approval.revision,
                ApprovalResolution::Allow {
                    rationale: "forged actor".into(),
                    risk_tags: vec![]
                },
                Some(authority(&job.session_id, "bob"))
            )
            .await
            .unwrap()
            .mutation,
        ApprovalMutation::NotFound
    ));
    let allowed = sdk
        .decide_session_approval(
            &principal("alice"),
            &job.session_id,
            &approval.id,
            allow.clone(),
        )
        .await
        .unwrap();
    assert_eq!(allowed.status, ApprovalStatus::Allowed);
    assert!(allowed.available_scopes.is_empty());
    let replay = sdk
        .decide_session_approval(&principal("alice"), &job.session_id, &approval.id, allow)
        .await
        .unwrap();
    assert_eq!(replay.revision, allowed.revision);
    assert_eq!(
        sdk.decide_session_approval(
            &principal("alice"),
            &job.session_id,
            &approval.id,
            SessionApprovalCommand {
                expected_revision: allowed.revision,
                decision: SessionApprovalChoice::Deny
            }
        )
        .await
        .unwrap_err()
        .code,
        SdkErrorCode::Conflict
    );
    assert!(sdk
        .session_pending_approvals("alice", &job.session_id)
        .await
        .unwrap()
        .approvals
        .is_empty());
    let record = runtime
        .inner
        .store
        .get_principal_approval(&alice, &approval.id)
        .await
        .unwrap()
        .unwrap();
    assert!(record
        .risk_tags
        .iter()
        .any(|tag| tag == capability_lease_scope_risk_tag(CapabilityLeaseScope::Session)));
    assert!(record
        .risk_tags
        .iter()
        .any(|tag| tag == CAPABILITY_LEASE_APPROVED_RISK_TAG));
    // Approval never changes the Session's preset into Full Access.
    assert_ne!(
        runtime
            .get_session(&job.session_id)
            .await
            .unwrap()
            .unwrap()
            .permission_mode,
        Some(crate::permission::PermissionMode::FullAccess)
    );

    for (suffix, choice, scope) in [
        (
            "once",
            SessionApprovalChoice::AllowOnce,
            ApprovalScope::Once,
        ),
        (
            "thread",
            SessionApprovalChoice::AllowThread,
            ApprovalScope::Thread,
        ),
        ("deny", SessionApprovalChoice::Deny, ApprovalScope::Thread),
    ] {
        let (job, approval) = seed(runtime, suffix, ApprovalStatus::PendingHuman, scope).await;
        let decision = SessionApprovalCommand {
            expected_revision: approval.revision,
            decision: choice,
        };
        let view = sdk
            .session_approval("alice", &job.session_id, &approval.id)
            .await
            .unwrap();
        if scope == ApprovalScope::Once {
            assert_eq!(view.available_scopes, vec![ApprovalScope::Once]);
        }
        let receipt = sdk
            .decide_session_approval(
                &principal("alice"),
                &job.session_id,
                &approval.id,
                decision.clone(),
            )
            .await
            .unwrap();
        assert_eq!(
            receipt.status,
            if choice == SessionApprovalChoice::Deny {
                ApprovalStatus::Denied
            } else {
                ApprovalStatus::Allowed
            }
        );
        assert_eq!(
            sdk.decide_session_approval(
                &principal("alice"),
                &job.session_id,
                &approval.id,
                decision
            )
            .await
            .unwrap()
            .revision,
            receipt.revision
        );
    }
    let (job, approval) = seed(
        runtime,
        "auto",
        ApprovalStatus::PendingAuto,
        ApprovalScope::Thread,
    )
    .await;
    assert!(sdk
        .session_pending_approvals("alice", &job.session_id)
        .await
        .unwrap()
        .approvals
        .is_empty());
    assert_eq!(
        sdk.decide_session_approval(
            &principal("alice"),
            &job.session_id,
            &approval.id,
            SessionApprovalCommand {
                expected_revision: approval.revision,
                decision: SessionApprovalChoice::Deny
            }
        )
        .await
        .unwrap_err()
        .code,
        SdkErrorCode::Conflict
    );
    let (job, approval) = seed(
        runtime,
        "cancel",
        ApprovalStatus::PendingHuman,
        ApprovalScope::Thread,
    )
    .await;
    runtime
        .inner
        .store
        .commit_approval_cancellation(&approval.id, approval.revision, "test cancellation")
        .await
        .unwrap();
    assert_eq!(
        sdk.decide_session_approval(
            &principal("alice"),
            &job.session_id,
            &approval.id,
            SessionApprovalCommand {
                expected_revision: approval.revision,
                decision: SessionApprovalChoice::AllowOnce
            }
        )
        .await
        .unwrap_err()
        .code,
        SdkErrorCode::Conflict
    );
    let (job, approval) = seed(
        runtime,
        "terminal",
        ApprovalStatus::PendingHuman,
        ApprovalScope::Thread,
    )
    .await;
    let thread = runtime
        .inner
        .store
        .get_thread(&job.thread_id)
        .await
        .unwrap()
        .unwrap();
    runtime
        .inner
        .store
        .control_thread(
            &thread.id,
            thread.revision,
            ThreadControlAction::Cancel,
            Some("test"),
            Some("test"),
        )
        .await
        .unwrap();
    assert!(runtime
        .inner
        .store
        .list_principal_pending_approvals(&authority(&job.session_id, "alice"), 100)
        .await
        .unwrap()
        .is_empty());
    assert!(matches!(
        runtime
            .inner
            .store
            .commit_authorized_approval_decision(
                &approval.id,
                approval.revision,
                ApprovalResolution::Allow {
                    rationale: "late".into(),
                    risk_tags: vec![]
                },
                Some(authority(&job.session_id, "alice"))
            )
            .await
            .unwrap()
            .mutation,
        ApprovalMutation::Rejected { .. } | ApprovalMutation::Conflict { .. }
    ));
}

#[tokio::test]
async fn session_approval_sqlite_contract_and_recovery() {
    let db = tempfile::NamedTempFile::new().unwrap();
    let raw = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(db.path()))
        .await
        .unwrap();
    let store = Arc::new(SqliteStore::new(db.path().to_str().unwrap()).await.unwrap());
    let (runtime, sdk) = fixture(store.clone()).await;
    conformance(&runtime, &sdk).await;
    let (job, approval) = seed(
        &runtime,
        "revoke",
        ApprovalStatus::PendingHuman,
        ApprovalScope::Thread,
    )
    .await;
    let actor = authority(&job.session_id, "alice");
    sqlx::query("UPDATE session_principal_bindings SET unbound_at = 'test' WHERE session_id = ? AND principal_id = 'alice'")
        .bind(&job.session_id).execute(&raw).await.unwrap();
    assert!(store
        .get_principal_approval(&actor, &approval.id)
        .await
        .unwrap()
        .is_none());
    assert!(matches!(
        store
            .commit_authorized_approval_decision(
                &approval.id,
                approval.revision,
                ApprovalResolution::Deny {
                    rationale: "late".into(),
                    risk_tags: vec![]
                },
                Some(actor)
            )
            .await
            .unwrap()
            .mutation,
        ApprovalMutation::NotFound
    ));
    // Even an exact replay must re-check current participation.
    let normal = store
        .get_execution_job("job-normal")
        .await
        .unwrap()
        .unwrap();
    let record = store
        .list_approvals(ApprovalFilter {
            job_id: Some(normal.id),
            ..Default::default()
        })
        .await
        .unwrap()
        .remove(0);
    sqlx::query("UPDATE session_principal_bindings SET unbound_at = 'test' WHERE session_id = 'session-normal' AND principal_id = 'alice'")
        .execute(&raw).await.unwrap();
    assert!(matches!(
        store
            .commit_authorized_approval_decision(
                &record.id,
                record.revision,
                ApprovalResolution::Allow {
                    rationale: record.rationale.unwrap(),
                    risk_tags: record.risk_tags
                },
                Some(authority("session-normal", "alice"))
            )
            .await
            .unwrap()
            .mutation,
        ApprovalMutation::NotFound
    ));
    let (job, approval) = seed(
        &runtime,
        "restart",
        ApprovalStatus::PendingHuman,
        ApprovalScope::Thread,
    )
    .await;
    drop(sdk);
    drop(runtime);
    raw.close().await;
    drop(store);
    let restored = Arc::new(SqliteStore::new(db.path().to_str().unwrap()).await.unwrap());
    let (_, sdk) = fixture(restored.clone()).await;
    assert_eq!(
        sdk.session_pending_approvals("alice", &job.session_id)
            .await
            .unwrap()
            .approvals[0]
            .id,
        approval.id
    );
    let command = SessionApprovalCommand {
        expected_revision: approval.revision,
        decision: SessionApprovalChoice::AllowOnce,
    };
    let receipt = sdk
        .decide_session_approval(
            &principal("alice"),
            &job.session_id,
            &approval.id,
            command.clone(),
        )
        .await
        .unwrap();
    let receipt2 = sdk
        .decide_session_approval(&principal("alice"), &job.session_id, &approval.id, command)
        .await
        .unwrap();
    assert_eq!(receipt.revision, receipt2.revision);
    let claimed = restored
        .claim_execution_job_with_grant(
            &job.id,
            job.revision,
            &approval.id,
            receipt.revision,
            "restored-worker",
            "claim-once",
            chrono::Utc::now() + chrono::Duration::minutes(1),
        )
        .await
        .unwrap();
    assert!(
        matches!(claimed, ExecutionApprovalMutation::Updated { job, .. } if job.status == ExecutionJobStatus::Running)
    );
}

#[tokio::test]
#[ignore = "requires an explicitly configured isolated PostgreSQL test database"]
async fn session_approval_postgres_contract() {
    let url = std::env::var("MORPHZ_TEST_POSTGRES_URL").expect("isolated PostgreSQL URL required");
    let admin = sqlx::PgPool::connect(&url).await.unwrap();
    let schema = format!(
        "approval_test_{}_{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap()
    );
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await
        .unwrap();
    let separator = if url.contains('?') { '&' } else { '?' };
    let scoped = format!("{url}{separator}options=-csearch_path%3D{schema}%2Cpublic");
    let store = Arc::new(PostgresStore::new(&scoped, 4).await.unwrap());
    let (runtime, sdk) = fixture(store.clone()).await;
    conformance(&runtime, &sdk).await;
    let (job, approval) = seed(
        &runtime,
        "revoke",
        ApprovalStatus::PendingHuman,
        ApprovalScope::Thread,
    )
    .await;
    sqlx::query("UPDATE session_principal_bindings SET unbound_at = 'test' WHERE session_id = $1 AND principal_id = 'alice'")
        .bind(&job.session_id).execute(store.pool()).await.unwrap();
    assert!(matches!(
        store
            .commit_authorized_approval_decision(
                &approval.id,
                approval.revision,
                ApprovalResolution::Deny {
                    rationale: "late".into(),
                    risk_tags: vec![]
                },
                Some(authority(&job.session_id, "alice"))
            )
            .await
            .unwrap()
            .mutation,
        ApprovalMutation::NotFound
    ));
    drop(sdk);
    drop(runtime);
    store.pool().close().await;
    drop(store);
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

#[test]
fn session_approval_command_rejects_identity_and_capability_injection() {
    for extra in [
        json!({"principal_id":"bob"}),
        json!({"requested":{"write_roots":["/"]}}),
        json!({"risk_tags":["full_access"]}),
    ] {
        let mut command = json!({"expected_revision":1, "decision":"allow_once"});
        command
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert!(serde_json::from_value::<SessionApprovalCommand>(command).is_err());
    }
    assert!(serde_json::from_value::<SessionApprovalCommand>(
        json!({"expected_revision":1,"decision":"full_access"})
    )
    .is_err());
}
