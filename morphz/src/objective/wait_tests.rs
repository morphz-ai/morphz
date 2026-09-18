use super::tests::{seed_background_execution_job, seed_delegation, seed_objective_bundle};
use super::*;
use crate::memory::{sqlite::SqliteStore, *};

struct Fixture {
    database: tempfile::NamedTempFile,
    store: Arc<SqliteStore>,
    supervisor: Arc<ObjectiveSupervisor>,
    objective: ObjectiveRecord,
    job: ExecutionJobRecord,
}

impl Fixture {
    async fn new() -> Self {
        let database = tempfile::NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(database.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        let created = seed_objective_bundle(&store, "resolved-wait").await;
        let ObjectiveMutation::Updated(objective) = store
            .claim_objective_evaluation(
                &created.id,
                created.revision,
                "evaluation-wait",
                Utc::now() + Duration::minutes(10),
            )
            .await
            .unwrap()
        else {
            panic!("failed to claim fixture Evaluation")
        };
        let job = seed_background_execution_job(&store, &objective, "resolved-wait").await;
        let ExecutionJobMutation::Updated(job) = store
            .claim_execution_job(
                &job.id,
                job.revision,
                "test-worker",
                "test-claim",
                Utc::now() + Duration::minutes(10),
                None,
            )
            .await
            .unwrap()
        else {
            panic!("failed to claim fixture Job")
        };
        let evaluations = Arc::new(ObjectiveEvaluationRegistry::default());
        evaluations.bind_activation(
            "activation-update",
            ActiveObjectiveEvaluation {
                objective_id: objective.id.clone(),
                evaluation_id: "evaluation-wait".into(),
                revision: objective.revision,
                started_at: Utc::now(),
                pending_dependency_id: None,
            },
        );
        let supervisor = Arc::new(
            ObjectiveSupervisor::new(
                store.clone(),
                store.clone(),
                Arc::new(InMemoryEventBus::new()),
                evaluations,
                Arc::new(TimerEngine::new(store.clone())),
                std::time::Duration::from_secs(600),
            )
            .with_execution_job_store(store.clone())
            .with_delegation_store(store.clone())
            .with_thread_group_store(store.clone())
            .with_scheduler_dependency_store(store.clone())
            .with_scheduler_kernel(Arc::new(SchedulerKernel::new(store.clone()))),
        );
        // Exercise production reconciliation, without asynchronous bus handlers
        // or a live model. The fixture's current Evaluation owns the continuation.
        supervisor.started.store(true, Ordering::Release);
        Self {
            database,
            store,
            supervisor,
            objective,
            job,
        }
    }

    async fn pool(&self) -> sqlx::SqlitePool {
        sqlx::SqlitePool::connect(&format!("sqlite:{}", self.database.path().display()))
            .await
            .unwrap()
    }

    fn wait(&self) -> ObjectiveWaitCondition {
        ObjectiveWaitCondition::ToolTask {
            task_id: self.job.id.clone(),
        }
    }

    async fn finish_job(&self, status: ExecutionJobStatus, result_event: bool) {
        if result_event {
            self.append_result("existing-result").await;
        }
        let terminal = self
            .store
            .finish_execution_job(
                &self.job.id,
                self.job.revision,
                Some("test-claim"),
                ExecutionJobTerminal {
                    status,
                    result_event_id: result_event.then(|| "existing-result".into()),
                    result_refs: vec!["artifact-test-log".into()],
                    error: (status == ExecutionJobStatus::Failed)
                        .then(|| "focus assertion failed".into()),
                    exit_code: Some(if status == ExecutionJobStatus::Succeeded {
                        0
                    } else {
                        1
                    }),
                },
            )
            .await
            .unwrap();
        assert!(
            matches!(terminal, ExecutionJobMutation::Updated(_)),
            "{terminal:?}"
        );
    }

    async fn append_result(&self, id: &str) {
        self.store
            .append(Event::new(
                id.into(),
                "Runtime".into(),
                TYPE_TOOL_OUTPUT.into(),
                "chat/tool_output".into(),
                serde_json::Map::from_iter([
                    ("context_id".into(), json!(self.objective.context_id)),
                    (
                        "session_id".into(),
                        json!(self.objective.coordinator_session_id),
                    ),
                    ("task_id".into(), json!(self.job.id)),
                    ("tool_status".into(), json!("error")),
                    ("text".into(), json!("focus assertion failed")),
                ]),
            ))
            .await
            .unwrap();
    }

    async fn execute(
        &self,
        wait: ObjectiveWaitCondition,
        revision: u64,
    ) -> Result<JsonValue, DynError> {
        let tool = ObjectiveUpdateTool::new(
            self.supervisor.clone(),
            Arc::new(ContextEngine::new(
                self.store.clone(),
                crate::config::OrchestratorConfig::default(),
            )),
        );
        let arguments = json!({
            "objective_id": self.objective.id, "base_revision": revision,
            "status": "active", "reason": "consume test evidence and continue",
            "evidence_refs": [], "wait_condition": wait
        })
        .to_string();
        let response = CURRENT_SESSION_ID
            .scope(
                self.objective.coordinator_session_id.clone(),
                CURRENT_CONTEXT_ID.scope(
                    self.objective.context_id.clone(),
                    CURRENT_ATTEMPT_ID.scope("activation-update".into(), tool.execute(&arguments)),
                ),
            )
            .await?;
        Ok(serde_json::from_str(&response)?)
    }

    async fn assert_ready(&self, response: &JsonValue) {
        let current = self
            .store
            .get_objective(&self.objective.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response["status"], "committed");
        assert_eq!(response["objective_status"], "active");
        assert_eq!(response["revision"], current.revision);
        assert!(response["wait_condition"].is_null());
        assert!(!response["resolved_wait"].is_null());
        assert!(response["next_action"]
            .as_str()
            .unwrap()
            .contains("continue advancing"));
        assert_eq!(current.status, ObjectiveStatus::Active);
        assert_eq!(current.generation, self.objective.generation);
        assert_eq!(
            current.active_evaluation_id,
            self.objective.active_evaluation_id
        );
        assert!(current.wait_condition.is_none());
        let pending: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM scheduler_dependencies WHERE owner_id = ? AND status = 'pending'",
        )
        .bind(&current.id)
        .fetch_one(&self.pool().await)
        .await
        .unwrap();
        assert_eq!(
            pending, 0,
            "a terminal dependency must not strand the Objective"
        );
        let continuations = self
            .store
            .query(QueryFilter {
                context_id: Some(current.context_id),
                topic: Some("objective/continuation".into()),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
        assert!(
            continuations.is_empty(),
            "the current Evaluation already owns progress"
        );
    }
}

#[tokio::test]
async fn objective_update_resolves_finished_jobs_without_failing_or_completing_objective() {
    for status in [
        ExecutionJobStatus::Failed,
        ExecutionJobStatus::Succeeded,
        ExecutionJobStatus::Cancelled,
        ExecutionJobStatus::Lost,
    ] {
        let fixture = Fixture::new().await;
        fixture.finish_job(status, true).await;
        let response = fixture
            .execute(fixture.wait(), fixture.objective.revision)
            .await
            .unwrap();
        fixture.assert_ready(&response).await;
        assert_eq!(response["resolved_wait"]["status"], status.as_str());
        assert_eq!(
            response["resolved_wait"]["result_event_id"],
            "existing-result"
        );
        assert_eq!(
            response["resolved_wait"]["result_refs"],
            json!(["artifact-test-log"])
        );
        if status == ExecutionJobStatus::Failed {
            assert_eq!(response["resolved_wait"]["exit_code"], 1);
            assert_eq!(response["resolved_wait"]["error"], "focus assertion failed");
        }
    }
}

#[tokio::test]
async fn objective_update_does_not_invent_a_missing_terminal_result_event() {
    let fixture = Fixture::new().await;
    fixture
        .finish_job(ExecutionJobStatus::Cancelled, false)
        .await;
    let response = fixture
        .execute(fixture.wait(), fixture.objective.revision)
        .await
        .unwrap();
    fixture.assert_ready(&response).await;
    assert!(response["resolved_wait"]["result_event_id"].is_null());
}

#[tokio::test]
async fn objective_update_still_registers_live_jobs() {
    let fixture = Fixture::new().await;
    let response = fixture
        .execute(fixture.wait(), fixture.objective.revision)
        .await
        .unwrap();
    assert_eq!(response["status"], "committed");
    assert!(response["resolved_wait"].is_null());
    assert_eq!(response["wait_condition"], json!(fixture.wait()));
    let current = fixture
        .store
        .get_objective(&fixture.objective.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.wait_condition, Some(fixture.wait()));
}

#[tokio::test]
async fn objective_update_returns_reconciled_revision_when_job_ends_during_registration() {
    for reconcile_enabled in [true, false] {
        let fixture = Fixture::new().await;
        fixture
            .supervisor
            .started
            .store(reconcile_enabled, Ordering::Release);
        fixture.append_result("raced-result").await;
        // Deterministic interleaving: validation sees the live Job; the terminal
        // projection becomes visible with wait registration, before reconciliation.
        sqlx::query(
        "CREATE TRIGGER finish_job_during_wait AFTER UPDATE OF wait_condition_json ON objectives
         WHEN NEW.wait_condition_json IS NOT NULL BEGIN
           UPDATE execution_jobs SET status = 'failed', revision = revision + 1,
             result_event_id = 'raced-result', error = 'raced failure', exit_code = 1;
         END",
    )
    .execute(&fixture.pool().await)
    .await
    .unwrap();
        let response = fixture
            .execute(fixture.wait(), fixture.objective.revision)
            .await
            .unwrap();
        fixture.assert_ready(&response).await;
        assert_eq!(response["resolved_wait"]["result_event_id"], "raced-result");
        assert_eq!(response["resolved_wait"]["status"], "failed");
    }
}

#[tokio::test]
async fn objective_update_finished_job_does_not_override_a_newer_revision() {
    let fixture = Fixture::new().await;
    fixture.finish_job(ExecutionJobStatus::Failed, true).await;
    let ObjectiveMutation::Updated(paused) = fixture
        .store
        .update_objective_state(
            &fixture.objective.id,
            fixture.objective.revision,
            ObjectiveStatus::Paused,
            None,
            Some("user paused"),
        )
        .await
        .unwrap()
    else {
        panic!("pause failed")
    };
    let response = fixture
        .execute(fixture.wait(), fixture.objective.revision)
        .await
        .unwrap();
    assert_eq!(response["status"], "revision_conflict");
    assert_eq!(response["current_status"], "paused");
    let current = fixture
        .store
        .get_objective(&fixture.objective.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.revision, paused.revision);
    assert_eq!(current.status, ObjectiveStatus::Paused);
}

#[tokio::test]
async fn objective_update_terminal_jobs_still_require_route_identity_and_tool_kind() {
    let fixture = Fixture::new().await;
    fixture.finish_job(ExecutionJobStatus::Failed, true).await;
    seed_objective_bundle(&fixture.store, "other").await;
    for (field, value, expected) in [
        ("session_id", "session-other", "cross-route"),
        ("context_id", "context-other", "cross-route"),
        ("agent_id", "agent-other", "cross-route"),
        (
            "initiating_principal_id",
            "principal-other",
            "cross-identity",
        ),
        ("tool_name", "exec", "rather than a waitable"),
    ] {
        let pool = fixture.pool().await;
        let original: String =
            sqlx::query_scalar(&format!("SELECT {field} FROM execution_jobs WHERE id = ?"))
                .bind(&fixture.job.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        sqlx::query(&format!(
            "UPDATE execution_jobs SET {field} = ? WHERE id = ?"
        ))
        .bind(value)
        .bind(&fixture.job.id)
        .execute(&pool)
        .await
        .unwrap();
        let error = fixture
            .execute(fixture.wait(), fixture.objective.revision)
            .await
            .unwrap_err();
        assert!(error.to_string().contains(expected), "{error}");
        sqlx::query(&format!(
            "UPDATE execution_jobs SET {field} = ? WHERE id = ?"
        ))
        .bind(original)
        .bind(&fixture.job.id)
        .execute(&pool)
        .await
        .unwrap();
    }
    let missing = ObjectiveWaitCondition::ToolTask {
        task_id: "missing-job".into(),
    };
    assert!(fixture
        .execute(missing, fixture.objective.revision)
        .await
        .unwrap_err()
        .to_string()
        .contains("does not exist"));
    let current = fixture
        .store
        .get_objective(&fixture.objective.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.revision, fixture.objective.revision);
}

#[tokio::test]
async fn objective_update_resolves_finished_delegations() {
    let fixture = Fixture::new().await;
    let delegation = seed_delegation(&fixture.store, &fixture.objective, "resolved").await;
    let result = Event::new(
        "delegation-result".into(),
        "Sub-Agent".into(),
        TYPE_TOOL_OUTPUT.into(),
        "chat/tool_output".into(),
        serde_json::Map::from_iter([
            ("context_id".into(), json!(fixture.objective.context_id)),
            (
                "session_id".into(),
                json!(fixture.objective.coordinator_session_id),
            ),
            ("delegation_id".into(), json!(delegation.id)),
            ("tool_status".into(), json!("success")),
        ]),
    );
    assert!(fixture
        .store
        .commit_delegation_result(&delegation.id, &result)
        .await
        .unwrap());
    let response = fixture
        .execute(
            ObjectiveWaitCondition::Delegation {
                delegation_id: delegation.id,
            },
            fixture.objective.revision,
        )
        .await
        .unwrap();
    fixture.assert_ready(&response).await;
    assert_eq!(response["resolved_wait"]["status"], "completed");
    assert_eq!(
        response["resolved_wait"]["result_event_id"],
        "delegation-result"
    );
}

#[tokio::test]
async fn objective_update_resolves_only_its_own_finished_thread_group() {
    let fixture = Fixture::new().await;
    fixture.append_result("group-result").await;
    let mut supervision = ThreadSupervision::objective(
        fixture.objective.id.clone(),
        "evaluation-wait",
        fixture.objective.generation,
        None,
    );
    supervision.thread_group_id = Some("finished-group".into());
    fixture
        .store
        .commit_schedule_transaction(
            &[],
            &[],
            &[NewThread {
                id: "group-member".into(),
                agent_id: fixture.objective.agent_id.clone(),
                context_id: fixture.objective.context_id.clone(),
                session_id: fixture.objective.coordinator_session_id.clone(),
                initiating_principal_id: fixture.objective.initiating_principal_id.clone(),
                root_turn_id: "group-root".into(),
                kind: ThreadKind::Execution,
                executor_kind: "self".into(),
                executor_id: None,
                target_id: None,
                supervision,
            }],
            &[],
            &[NewThreadGroupPlan {
                group: NewThreadGroup {
                    id: "finished-group".into(),
                    context_id: fixture.objective.context_id.clone(),
                    session_id: fixture.objective.coordinator_session_id.clone(),
                    supervisor_kind: ThreadSupervisorKind::Objective,
                    supervisor_id: fixture.objective.id.clone(),
                    generation: 1,
                    policy: ThreadGroupPolicy::All,
                    completion_contract: json!({}),
                },
                members: vec![NewThreadGroupMember {
                    thread_id: "group-member".into(),
                    ordinal: 0,
                    required: true,
                }],
            }],
        )
        .await
        .unwrap();
    sqlx::query("UPDATE thread_groups SET status = 'failed', barrier_event_id = 'group-result' WHERE id = 'finished-group'")
        .execute(&fixture.pool().await).await.unwrap();
    let wait = ObjectiveWaitCondition::ThreadGroup {
        group_id: "finished-group".into(),
    };
    let response = fixture
        .execute(wait.clone(), fixture.objective.revision)
        .await
        .unwrap();
    fixture.assert_ready(&response).await;
    assert_eq!(response["resolved_wait"]["status"], "failed");
    assert_eq!(response["resolved_wait"]["result_event_id"], "group-result");
    sqlx::query(
        "UPDATE thread_groups SET supervisor_id = 'another-objective' WHERE id = 'finished-group'",
    )
    .execute(&fixture.pool().await)
    .await
    .unwrap();
    let revision = response["revision"].as_u64().unwrap();
    assert!(fixture
        .execute(wait, revision)
        .await
        .unwrap_err()
        .to_string()
        .contains("cross-route"));
}
