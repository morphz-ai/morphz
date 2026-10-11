//! Real-store conformance for executable retention, not a UI catalog filter.
use morphz::event::Event;
use morphz::harness::{ExactHarnessRef, HarnessRegistry};
use morphz::harness_package::{
    collect_unused_harnesses, load_evaluation_harness_binding, load_persisted_harness_packages,
    persist_evaluation_harness_binding, persist_harness_package, persist_objective_harness_binding,
    recover_bound_harness, HarnessPackage, HARNESS_PACKAGE_TOPIC,
};
use morphz::memory::postgres::PostgresStore;
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::*;
use serde_json::json;

type TestError = Box<dyn std::error::Error + Send + Sync>;

fn package(version: &str) -> HarnessPackage {
    HarnessPackage::from_source(
        "TEST-lifecycle.hns",
        &format!(
            r#"
      (manifest (id "TEST-retention") (version "{version}") (title "Retention test")
        (capabilities (tools)))
      (contract (identity "retention test"))
      (infer (requires (tools)) "No effects")
    "#
        ),
    )
    .unwrap()
}

fn new_thread(root: &str) -> NewThread {
    NewThread {
        id: format!("thread-{root}"),
        agent_id: "agent-retention".into(),
        context_id: "context-retention".into(),
        session_id: "session-retention".into(),
        initiating_principal_id: None,
        root_turn_id: root.into(),
        kind: ThreadKind::Execution,
        executor_kind: "test".into(),
        executor_id: None,
        target_id: None,
        supervision: ThreadSupervision::runtime("TEST-retention"),
        response_annotations: Default::default(),
        model_alias: None,
        reasoning_effort: None,
    }
}

fn new_objective(id: &str) -> NewObjective {
    NewObjective {
        id: id.into(),
        agent_id: "agent-retention".into(),
        context_id: "context-retention".into(),
        coordinator_session_id: "session-retention".into(),
        delivery_session_id: "session-retention".into(),
        parent_objective_id: None,
        source_event_id: format!("source-{id}"),
        initiating_principal_id: None,
        stated_objective: "TEST durable retention".into(),
        token_budget: None,
        model_alias: None,
        reasoning_effort: None,
    }
}

async fn finish_thread<S: RuntimeStore>(store: &S, root: &str) -> Result<(), TestError> {
    let thread = store.get_thread_by_root(root).await?.unwrap();
    assert!(matches!(
        store
            .update_thread(
                &thread.id,
                thread.revision,
                None,
                Some(ThreadLifecycle::Completed),
                None,
                None,
                None,
                None
            )
            .await?,
        ThreadMutation::Updated(_)
    ));
    Ok(())
}

async fn bind<S: RuntimeStore>(
    store: &S,
    registry: &HarnessRegistry,
    version: &str,
    root: &str,
) -> Result<(), TestError> {
    persist_evaluation_harness_binding(
        store,
        "context-retention",
        root,
        None,
        None,
        registry.get("TEST-retention", version).unwrap().as_ref(),
    )
    .await?;
    Ok(())
}

async fn conformance<S: RuntimeStore>(store: &S) -> Result<(), TestError> {
    store
        .create_agent_bundle(
            NewAgent {
                id: "agent-retention".into(),
                title: "TEST retention".into(),
                root_context_id: "context-retention".into(),
            },
            NewCognitiveContext {
                id: "context-retention".into(),
                agent_id: "agent-retention".into(),
                title: "TEST retention".into(),
            },
            NewSession {
                id: "session-retention".into(),
                agent_id: "agent-retention".into(),
                context_id: "context-retention".into(),
                parent_session_id: None,
                title: "TEST retention".into(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await?;
    let registry = HarnessRegistry::default();
    for version in [
        "1.0.0", "1.0.1", "1.0.2", "1.0.3", "1.0.4", "1.0.5", "1.0.6", "1.0.7", "1.0.8", "1.0.9",
        "1.1.0", "2.0.0",
    ] {
        let package = package(version);
        assert!(persist_harness_package(store, &package).await?);
        assert!(!persist_harness_package(store, &package).await?);
        registry.register_package(package)?;
    }
    let archives_before = store
        .query(QueryFilter {
            topic: Some(HARNESS_PACKAGE_TOPIC.into()),
            ..Default::default()
        })
        .await?;
    // Terminal history is not an installation reference.
    store.ensure_thread(new_thread("terminal-root")).await?;
    bind(store, &registry, "1.0.0", "terminal-root").await?;
    finish_thread(store, "terminal-root").await?;

    // A paused live Thread, a paused Objective default, a waiting Plan, a
    // queued Activation, a timer on a terminal template, an orphan binding,
    // an unfinished child and a current Objective Evaluation each retain
    // their own exact source; none can be replaced by the latest package.
    let live = store.ensure_thread(new_thread("live-root")).await?;
    bind(store, &registry, "1.0.1", "live-root").await?;
    store
        .control_thread(
            &live.id,
            live.revision,
            ThreadControlAction::Pause,
            None,
            None,
        )
        .await?;

    let objective = store
        .create_objective(new_objective("paused-objective"))
        .await?;
    persist_objective_harness_binding(
        store,
        "context-retention",
        &objective.id,
        registry.get("TEST-retention", "1.0.2").unwrap().as_ref(),
    )
    .await?;
    store
        .update_objective_state(
            &objective.id,
            objective.revision,
            ObjectiveStatus::Paused,
            None,
            None,
        )
        .await?;

    let plan_thread = store.ensure_thread(new_thread("plan-root")).await?;
    store
        .ensure_thread_activation(NewThreadActivation {
            id: "plan-activation".into(),
            agent_id: "agent-retention".into(),
            context_id: "context-retention".into(),
            session_id: "session-retention".into(),
            initiating_principal_id: None,
            trigger_event_id: "plan-trigger".into(),
            trigger_sequence: 1,
            trigger_kind: "test".into(),
            parent_activation_id: None,
            root_turn_id: "plan-root".into(),
        })
        .await?;
    let plan = store
        .create_plan_execution(NewPlanExecution {
            id: "retention-plan".into(),
            activation_id: "plan-activation".into(),
            thread_id: plan_thread.id,
            agent_id: "agent-retention".into(),
            context_id: "context-retention".into(),
            session_id: "session-retention".into(),
            initiating_principal_id: None,
            tool_call_id: "test-retention-call".into(),
            objective_id: None,
            objective_evaluation_id: None,
            harness_id: Some("TEST-retention".into()),
            harness_version: Some("1.0.3".into()),
            source_artifact_hash: package("1.0.3").artifact_hash,
            ir_schema_version: 1,
            program_json: json!({}),
            state_json: json!({}),
            budget_json: json!({}),
        })
        .await?;
    let claimed = store
        .claim_plan_execution(
            &plan.id,
            plan.revision,
            "worker",
            "claim",
            chrono::Utc::now() + chrono::Duration::minutes(5),
        )
        .await?;
    let PlanExecutionMutation::Updated(claimed) = claimed else {
        panic!("Plan must be claimed")
    };
    let suspended = store
        .suspend_plan_execution(
            &plan.id,
            claimed.revision,
            "claim",
            &json!({}),
            &json!({}),
            PlanExecutionWaitKind::PlanExecution,
            "waiting-child",
        )
        .await?;
    assert!(
        matches!(suspended, PlanExecutionMutation::Updated(ref p) if p.status == PlanExecutionStatus::Waiting)
    );

    store.ensure_thread(new_thread("activation-root")).await?;
    bind(store, &registry, "1.0.4", "activation-root").await?;
    finish_thread(store, "activation-root").await?;
    let activation = store
        .ensure_thread_activation(NewThreadActivation {
            id: "retention-activation".into(),
            agent_id: "agent-retention".into(),
            context_id: "context-retention".into(),
            session_id: "session-retention".into(),
            initiating_principal_id: None,
            trigger_event_id: "test-trigger".into(),
            trigger_sequence: 1,
            trigger_kind: "test".into(),
            parent_activation_id: None,
            root_turn_id: "activation-root".into(),
        })
        .await?;

    let template = store.ensure_thread(new_thread("timer-root")).await?;
    bind(store, &registry, "1.0.5", "timer-root").await?;
    let timer = store
        .commit_schedule_transaction(
            &[],
            &[],
            &[],
            &[NewSchedule {
                id: "retention-timer".into(),
                thread_id: template.id,
                source_turn_id: "timer-root".into(),
                intent: "TEST future work".into(),
                model_alias: None,
                reasoning_effort: None,
                not_before: Some(chrono::Utc::now() + chrono::Duration::days(1)),
                interval_seconds: Some(86400),
                dependency_thread_ids: vec![],
            }],
            &[],
        )
        .await?
        .remove(0);
    finish_thread(store, "timer-root").await?;
    bind(store, &registry, "1.0.6", "unresolved-owner").await?;

    let parent = store.ensure_thread(new_thread("child-parent-root")).await?;
    bind(store, &registry, "1.0.7", "child-parent-root").await?;
    let mut child = new_thread("child-root");
    child.supervision = ThreadSupervision::attached(parent.id, 1, "child-parent-root");
    store.ensure_thread(child).await?;
    finish_thread(store, "child-parent-root").await?;

    let evaluation_objective = store
        .create_objective(new_objective("evaluation-objective"))
        .await?;
    store
        .claim_objective_evaluation(
            &evaluation_objective.id,
            evaluation_objective.revision,
            "objective-eval",
            chrono::Utc::now() + chrono::Duration::minutes(5),
        )
        .await?;
    persist_evaluation_harness_binding(
        store,
        "context-retention",
        "objective-eval",
        Some(&evaluation_objective.id),
        None,
        registry.get("TEST-retention", "1.0.8").unwrap().as_ref(),
    )
    .await?;

    // Accepted root before the first Harness mount is already a reference.
    let requested = Event::new("requested-root".into(), "Human".into(), "user_message".into(), "chat/user_message".into(),
        json!({"context_id":"context-retention", "requested_harness_id":"TEST-retention", "requested_harness_version":"1.0.9"})
        .as_object().unwrap().clone());
    store.append(requested).await?;
    store.ensure_thread(new_thread("requested-root")).await?;

    let required = store.required_harnesses().await?;
    for version in [
        "1.0.1", "1.0.2", "1.0.3", "1.0.4", "1.0.5", "1.0.6", "1.0.7", "1.0.8", "1.0.9",
    ] {
        assert!(
            required.contains(&ExactHarnessRef {
                id: "TEST-retention".into(),
                version: version.into()
            }),
            "missing {version}"
        );
    }
    let removed = collect_unused_harnesses(store, &registry).await?;
    assert_eq!(
        removed
            .iter()
            .map(|h| h.version.as_str())
            .collect::<Vec<_>>(),
        ["1.0.0", "1.1.0"]
    );
    assert_eq!(registry.discovery_descriptors()[0].version, "2.0.0");
    assert!(registry
        .get_for_new_work("TEST-retention", "1.0.1")
        .is_none());
    assert!(registry.get("TEST-retention", "1.0.0").is_none());

    // Restart derives the same executable set from durable owners, not from
    // an in-memory cache or a historical version count.
    let restarted = HarnessRegistry::default();
    for package in load_persisted_harness_packages(store).await? {
        restarted.register_package(package)?;
    }
    collect_unused_harnesses(store, &restarted).await?;
    assert_eq!(restarted.descriptors(), registry.descriptors());
    let binding = load_evaluation_harness_binding(store, "live-root")
        .await?
        .unwrap();
    assert_eq!(binding.harness_version, "1.0.1");
    let recovered = recover_bound_harness(
        store,
        &restarted,
        &binding.harness_id,
        &binding.harness_version,
    )
    .await?;
    assert_eq!(
        recovered.artifact_hash().as_deref(),
        Some(binding.artifact_hash.as_str())
    );
    drop(recovered);

    // Retention ends only when these exact owners end, regardless of results
    // continuing to exist in history.
    finish_thread(store, "live-root").await?;
    let paused = store.get_objective("paused-objective").await?.unwrap();
    store
        .update_objective_state(
            &paused.id,
            paused.revision,
            ObjectiveStatus::Cancelled,
            None,
            None,
        )
        .await?;
    let plan = store.get_plan_execution("retention-plan").await?.unwrap();
    store
        .cancel_plan_execution(&plan.id, plan.revision, Some("TEST finished"))
        .await?;
    store
        .update_thread_activation(
            &activation.id,
            activation.revision,
            ThreadActivationStatus::Succeeded,
            None,
            None,
            None,
        )
        .await?;
    store.cancel_schedule(&timer.id, timer.revision).await?;
    store.ensure_thread(new_thread("unresolved-owner")).await?;
    finish_thread(store, "unresolved-owner").await?;
    finish_thread(store, "child-root").await?;
    let objective = store.get_objective("evaluation-objective").await?.unwrap();
    store
        .update_objective_state(
            &objective.id,
            objective.revision,
            ObjectiveStatus::Cancelled,
            None,
            None,
        )
        .await?;
    finish_thread(store, "requested-root").await?;
    assert!(store.required_harnesses().await?.is_empty());
    assert_eq!(collect_unused_harnesses(store, &restarted).await?.len(), 9);
    assert_eq!(restarted.descriptors().len(), 1);
    let archives_after = store
        .query(QueryFilter {
            topic: Some(HARNESS_PACKAGE_TOPIC.into()),
            ..Default::default()
        })
        .await?;
    assert_eq!(
        serde_json::to_value(archives_before)?,
        serde_json::to_value(archives_after)?
    );
    assert_eq!(
        load_evaluation_harness_binding(store, "live-root")
            .await?
            .unwrap(),
        binding
    );
    assert!(store
        .get_thread_by_root("terminal-root")
        .await?
        .unwrap()
        .lifecycle
        .is_terminal());
    // An incomplete unfinished reference is not evidence that a version is
    // unused. A failed query/decoding pass must leave old executables intact.
    restarted.register_package(package("1.0.0"))?;
    store
        .append(Event::new(
            "invalid-retention-binding".into(),
            "TEST".into(),
            "harness_binding".into(),
            "runtime/evaluation_harness_binding".into(),
            json!({
                "context_id":"context-retention", "evaluation_id":"unknown-invalid-owner",
                "harness_id":"TEST-retention", "scope":"evaluation"
            })
            .as_object()
            .unwrap()
            .clone(),
        ))
        .await?;
    assert!(collect_unused_harnesses(store, &restarted).await.is_err());
    assert!(restarted.get("TEST-retention", "1.0.0").is_some());
    Ok(())
}

#[tokio::test]
async fn sqlite_harness_upgrade_retention_cleanup_restart_and_history() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let store = SqliteStore::new(file.path().to_str().unwrap())
        .await
        .unwrap();
    conformance(&store).await.unwrap();
}

#[tokio::test]
async fn postgres_harness_upgrade_retention_cleanup_restart_and_history() {
    let url = std::env::var("MORPHZ_TEST_POSTGRES_URL")
        .expect("Prepare dedicated test PostgreSQL before running this conformance test");
    let schema = format!(
        "morphz_harness_lifecycle_{}_{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap()
    );
    let administration = sqlx::PgPool::connect(&url).await.unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&administration)
        .await
        .unwrap();
    let separator = if url.contains('?') { '&' } else { '?' };
    let scoped = format!("{url}{separator}options=-csearch_path%3D{schema}%2Cpublic");
    let store = PostgresStore::new(&scoped, 8).await.unwrap();
    let result = conformance(&store).await;
    store.pool().close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&administration)
        .await
        .unwrap();
    administration.close().await;
    result.unwrap();
}
