//! Native cancellation must close owned Plans without a running reconciler.
use chrono::{Duration, Utc};
use morphz::event::Event;
use morphz::memory::{sqlite::SqliteStore, *};
use morphz::plan_execution::{
    PlanArtifactBinding, PlanCallPlanner, PlanDriveReceipt, PlanExecutionCoordinator,
    PlanExecutionResult, PlanExecutionRoute, PlanResumeReceipt,
};
use serde_json::json;
use std::sync::Arc;

// Exercise public Objective cancellation with no running reconciler or model
// Future. The coordinator, not this fixture, creates each infer child.
mod cold_objective_infer_cancel {
    use super::*;
    use morphz::config::AppConfig;
    use morphz::llm::{Client, Message, Response, ToolDefinition};
    use morphz::permission::{PermissionMode, ReviewerKind};
    use morphz::runtime::{MorphzRuntime, RuntimeIdentity, RuntimeToolPolicy};
    use morphz::secret_store::{HostEnvFileSecretBackend, SecretStore};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FixtureScope {
        id: String,
        agent: String,
        context: String,
        session: String,
    }

    impl FixtureScope {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let id = format!(
                "cold-{}-{}-{}",
                std::process::id(),
                Utc::now().timestamp_nanos_opt().unwrap(),
                NEXT.fetch_add(1, Ordering::SeqCst),
            );
            Self {
                agent: format!("agent-{id}"),
                context: format!("context-{id}"),
                session: format!("session-{id}"),
                id,
            }
        }
    }

    #[derive(Debug, Clone, Copy)]
    enum CommitOrder {
        HandoffFirst { admitted: bool },
        CancellationFirst,
        HistoricalCancelledChild,
        NestedHandoffFirst,
    }

    #[derive(Default)]
    struct NoModelCalls(AtomicUsize);

    #[async_trait::async_trait]
    impl Client for NoModelCalls {
        async fn create_completion(
            &self,
            _: Vec<Message>,
            _: Vec<ToolDefinition>,
        ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Err("cold cancellation must not call a model".into())
        }
    }

    async fn admit(
        store: &dyn RuntimeStore,
        thread: &ThreadRecord,
        event: &Event,
        activation_id: &str,
    ) -> ThreadActivationRecord {
        // Use the committed Signal rather than fabricating its sequence or
        // parent route. Both primary and child admission use the normal CAS.
        let signal = store
            .thread_signal_for_event(&thread.context_id, &event.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(signal.thread_id, thread.id);
        assert_eq!(signal.status, ThreadSignalStatus::Pending);
        let queued = store
            .claim_thread_signal_batch(
                NewThreadSignal {
                    id: signal.id,
                    thread_id: signal.thread_id,
                    thread_generation: signal.thread_generation,
                    event_id: signal.event_id,
                    principal_id: signal.principal_id,
                    sequence: signal.sequence,
                    kind: signal.kind,
                    parent_activation_id: signal.parent_activation_id.clone(),
                },
                NewThreadActivation {
                    id: activation_id.into(),
                    agent_id: thread.agent_id.clone(),
                    context_id: thread.context_id.clone(),
                    session_id: thread.session_id.clone(),
                    initiating_principal_id: None,
                    trigger_event_id: event.id.clone(),
                    trigger_sequence: signal.sequence,
                    trigger_kind: event.topic.clone(),
                    parent_activation_id: signal.parent_activation_id,
                    root_turn_id: thread.root_turn_id.clone(),
                },
                1,
            )
            .await
            .unwrap()
            .expect("the real pending Signal must admit exactly one Activation");
        match store
            .update_thread_activation(
                &queued.id,
                queued.revision,
                ThreadActivationStatus::Running,
                Some("cold-fixture"),
                Some(Utc::now() + Duration::hours(1)),
                None,
            )
            .await
            .unwrap()
        {
            ThreadActivationMutation::Updated(running) => running,
            other => panic!("Activation admission lost its CAS: {other:?}"),
        }
    }

    async fn primary(
        store: &dyn RuntimeStore,
        scope: &FixtureScope,
        label: &str,
    ) -> (ObjectiveRecord, ThreadRecord, ThreadActivationRecord) {
        let label = format!("{}-{label}", scope.id);
        let source = Event::new(
            format!("source-{label}"),
            "Test".into(),
            "input".into(),
            "chat/user".into(),
            json!({"context_id": scope.context, "session_id": scope.session, "content": label})
                .as_object()
                .unwrap()
                .clone(),
        );
        store.append(source.clone()).await.unwrap();
        let objective = store
            .create_objective(NewObjective {
                model_alias: None,
                reasoning_effort: None,
                id: format!("objective-{label}"),
                agent_id: scope.agent.clone(),
                context_id: scope.context.clone(),
                coordinator_session_id: scope.session.clone(),
                delivery_session_id: scope.session.clone(),
                parent_objective_id: None,
                source_event_id: source.id,
                initiating_principal_id: None,
                stated_objective: format!("Synthetic cold cancellation: {label}"),
                token_budget: None,
            })
            .await
            .unwrap();
        let thread = morphz::steering::objective_thread(&objective);
        let evaluation_id = format!("evaluation-{label}");
        let event = Event::new(
            format!("continue-{label}"),
            "ObjectiveSupervisor".into(),
            "tool_output".into(),
            "chat/tool_output".into(),
            json!({
                "context_id": scope.context, "session_id": scope.session,
                "root_turn_id": thread.root_turn_id,
                "objective_id": objective.id,
                "objective_evaluation_id": evaluation_id,
                "tool_name": "objective_supervisor",
                "content": "Continue the synthetic Objective",
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        let claimed = match store
            .claim_objective_evaluation_with_signal(
                &objective.id,
                objective.revision,
                &evaluation_id,
                Utc::now() + Duration::hours(1),
                &event,
                &thread,
            )
            .await
            .unwrap()
        {
            ObjectiveMutation::Updated(claimed) => claimed,
            other => panic!("Objective continuation was not committed: {other:?}"),
        };
        let thread = store.get_thread(&thread.id).await.unwrap().unwrap();
        let activation = admit(store, &thread, &event, &format!("activation-{label}")).await;
        (claimed, thread, activation)
    }

    fn route(
        objective: &ObjectiveRecord,
        thread: &ThreadRecord,
        activation: &ThreadActivationRecord,
    ) -> PlanExecutionRoute {
        PlanExecutionRoute {
            activation_id: activation.id.clone(),
            thread_id: thread.id.clone(),
            agent_id: thread.agent_id.clone(),
            context_id: thread.context_id.clone(),
            session_id: thread.session_id.clone(),
            initiating_principal_id: None,
            tool_call_id: format!("eval-{}", objective.id),
            objective_id: Some(objective.id.clone()),
            objective_evaluation_id: objective.active_evaluation_id.clone(),
        }
    }

    async fn snapshot(
        store: &dyn RuntimeStore,
        objective: &ObjectiveRecord,
        thread: &ThreadRecord,
        activation: &ThreadActivationRecord,
        plan: &PlanExecutionRecord,
    ) -> serde_json::Value {
        json!({
            "objective": store.get_objective(&objective.id).await.unwrap(),
            "thread": store.get_thread(&thread.id).await.unwrap(),
            "activation": store.get_thread_activation(&activation.id).await.unwrap(),
            "plan": store.get_plan_execution(&plan.id).await.unwrap(),
            "outcome": store.get_thread_outcome(&thread.id).await.unwrap(),
            "signals": store.list_context_thread_signals(&thread.context_id, None).await.unwrap()
                .into_iter().filter(|signal| signal.thread_id == thread.id).collect::<Vec<_>>(),
        })
    }

    async fn contract(store: Arc<dyn RuntimeStore>, tmp: tempfile::TempDir, order: CommitOrder) {
        let scope = FixtureScope::new();
        std::fs::create_dir(tmp.path().join("workspace")).unwrap();
        store
            .create_agent_bundle(
                NewAgent {
                    id: scope.agent.clone(),
                    title: "Cold cancellation".into(),
                    root_context_id: scope.context.clone(),
                },
                NewCognitiveContext {
                    id: scope.context.clone(),
                    agent_id: scope.agent.clone(),
                    title: "Cold cancellation".into(),
                },
                NewSession {
                    id: scope.session.clone(),
                    agent_id: scope.agent.clone(),
                    context_id: scope.context.clone(),
                    parent_session_id: None,
                    title: "Shared synthetic Session".into(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.reviewer = ReviewerKind::User;
        config.permissions.workspace_root = tmp.path().join("workspace").to_string_lossy().into();
        config.background_task.artifact_dir = tmp.path().join("artifacts").to_string_lossy().into();
        let model = Arc::new(NoModelCalls::default());
        let runtime = MorphzRuntime::builder(config, model.clone())
            .store("cold-objective-infer-test", store.clone())
            .identity(RuntimeIdentity {
                agent_id: scope.agent.clone(),
                context_id: scope.context.clone(),
                principal_id: format!("principal-{}", scope.id),
            })
            .secret_store(Arc::new(
                SecretStore::new(
                    tmp.path().join("secrets.json"),
                    Arc::new(HostEnvFileSecretBackend::new(tmp.path().join("test.env"))),
                )
                .unwrap(),
            ))
            .tool_policy(RuntimeToolPolicy {
                context_only: true,
                coding_eval: false,
            })
            .build()
            .await
            .unwrap();
        // Deliberately do not start Runtime: no scheduler, model Future,
        // process-local Objective registry binding or repair poll can help.
        let (objective, parent, parent_activation) = primary(store.as_ref(), &scope, "owned").await;
        let (sibling, sibling_thread, sibling_activation) =
            primary(store.as_ref(), &scope, "unrelated").await;
        let registry = Arc::new(morphz::tool::Registry::new());
        let program = morphz::sexpr_eval::validate(
            "(eval (infer (returns String) \"synthetic infer\"))",
            &registry,
            &morphz::sexpr_eval::AllowList::new(Vec::<String>::new()),
        )
        .unwrap();
        let coordinator = PlanExecutionCoordinator::new(store.clone(), registry.clone());
        let queued = coordinator
            .ensure(
                route(&objective, &parent, &parent_activation),
                &program,
                PlanArtifactBinding::default(),
            )
            .await
            .unwrap();
        let sibling_plan = coordinator
            .ensure(
                route(&sibling, &sibling_thread, &sibling_activation),
                &program,
                PlanArtifactBinding::default(),
            )
            .await
            .unwrap();
        if matches!(order, CommitOrder::CancellationFirst) {
            cancellation_before_handoff(
                store.as_ref(),
                &runtime,
                &model,
                &registry,
                (&objective, &parent, &parent_activation, &queued),
                (
                    &sibling,
                    &sibling_thread,
                    &sibling_activation,
                    &sibling_plan,
                ),
            )
            .await;
            return;
        }
        let admitted = match order {
            CommitOrder::HandoffFirst { admitted } => admitted,
            CommitOrder::HistoricalCancelledChild | CommitOrder::NestedHandoffFirst => true,
            CommitOrder::CancellationFirst => unreachable!(),
        };
        let (waiting, event, child_activation_id) = match coordinator
            .drive_once(
                &queued.id,
                queued.revision,
                "cold-fixture",
                "infer-handoff",
                Utc::now() + Duration::hours(1),
                &NoPhysicalCalls,
            )
            .await
            .unwrap()
        {
            PlanDriveReceipt::WaitingForEvaluation {
                plan,
                request_event,
                activation_id,
                ..
            } => (plan, request_event, activation_id),
            other => panic!("real infer hand-off did not suspend the parent: {other:?}"),
        };
        let child = store.get_thread_by_root(&event.id).await.unwrap().unwrap();
        assert_eq!(child.lifecycle, ThreadLifecycle::Open);
        assert_eq!(child.executor_kind, "plan_infer");
        assert_eq!(
            child.supervision.origin_evaluation_id,
            objective.active_evaluation_id
        );
        assert_eq!(
            child.supervision.parent_thread_id.as_deref(),
            Some(parent.id.as_str())
        );
        assert!(store
            .get_thread_activation(&child_activation_id)
            .await
            .unwrap()
            .is_none());
        if admitted {
            admit(store.as_ref(), &child, &event, &child_activation_id).await;
        }
        let nested = if matches!(order, CommitOrder::NestedHandoffFirst) {
            let child_activation = store
                .get_thread_activation(&child_activation_id)
                .await
                .unwrap()
                .unwrap();
            let nested_queued = coordinator
                .ensure(
                    route(&objective, &child, &child_activation),
                    &program,
                    PlanArtifactBinding::default(),
                )
                .await
                .unwrap();
            let (nested_waiting, nested_event, nested_activation_id) = match coordinator
                .drive_once(
                    &nested_queued.id,
                    nested_queued.revision,
                    "cold-nested-fixture",
                    "nested-infer-handoff",
                    Utc::now() + Duration::hours(1),
                    &NoPhysicalCalls,
                )
                .await
                .unwrap()
            {
                PlanDriveReceipt::WaitingForEvaluation {
                    plan,
                    request_event,
                    activation_id,
                    ..
                } => (plan, request_event, activation_id),
                other => panic!("second real infer handoff must suspend its parent: {other:?}"),
            };
            let grandchild = store
                .get_thread_by_root(&nested_event.id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(grandchild.lifecycle, ThreadLifecycle::Open);
            assert_eq!(grandchild.executor_kind, "plan_infer");
            assert_eq!(
                grandchild.executor_id.as_deref(),
                Some(nested_waiting.id.as_str())
            );
            assert_eq!(
                grandchild.supervision.parent_thread_id.as_deref(),
                Some(child.id.as_str())
            );
            assert_eq!(
                grandchild.supervision.origin_evaluation_id,
                objective.active_evaluation_id
            );
            assert!(store
                .get_thread_activation(&nested_activation_id)
                .await
                .unwrap()
                .is_none());
            // Unlike the first child, this second-level child stays unadmitted.
            // Both links came from actual coordinator handoff transactions.
            Some((nested_waiting, grandchild, nested_activation_id))
        } else {
            None
        };
        let history_before = if matches!(order, CommitOrder::HistoricalCancelledChild) {
            // Establish genuine terminal history through the same atomic Store
            // control operation, not a fabricated Outcome or terminal projection.
            let current_child = store.get_thread(&child.id).await.unwrap().unwrap();
            assert!(matches!(
                store
                    .control_thread(
                        &current_child.id,
                        current_child.revision,
                        ThreadControlAction::Cancel,
                        Some("The child independently stopped before its Objective"),
                        Some("ColdHistoryTest"),
                    )
                    .await
                    .unwrap(),
                ThreadMutation::Updated(_)
            ));
            Some(infer_history(store.as_ref(), &child).await)
        } else {
            None
        };
        let sibling_before = snapshot(
            store.as_ref(),
            &sibling,
            &sibling_thread,
            &sibling_activation,
            &sibling_plan,
        )
        .await;
        let current = store.get_objective(&objective.id).await.unwrap().unwrap();
        let cancelled = match runtime
            .cancel_objective(
                &current.id,
                current.revision,
                "Cancel the cold synthetic infer owner",
            )
            .await
            .unwrap()
        {
            ObjectiveMutation::Updated(cancelled) => cancelled,
            other => panic!("cancellation must commit, not silently accept a conflict: {other:?}"),
        };
        let child_after = store.get_thread(&child.id).await.unwrap().unwrap();
        let child_activation_after = store
            .get_thread_activation(&child_activation_id)
            .await
            .unwrap();
        let child_outcome = store.get_thread_outcome(&child.id).await.unwrap();
        let child_signals = store
            .list_context_thread_signals(&scope.context, None)
            .await
            .unwrap()
            .into_iter()
            .filter(|signal| signal.thread_id == child.id)
            .collect::<Vec<_>>();
        let sibling_after = snapshot(
            store.as_ref(),
            &sibling,
            &sibling_thread,
            &sibling_activation,
            &sibling_plan,
        )
        .await;
        let history_after = if history_before.is_some() {
            Some(infer_history(store.as_ref(), &child).await)
        } else {
            None
        };
        // Capture all durable facts before the first assertion, so a failed
        // Thread projection does not hide Activation/Signal/sibling evidence.
        eprintln!(
            "cold_objective_infer_cancel={}",
            json!({
                "admitted": admitted, "cancellation": cancelled,
                "parent": snapshot(store.as_ref(), &objective, &parent, &parent_activation, &waiting).await,
                "child": child_after, "child_activation": child_activation_after,
                "child_outcome": child_outcome, "child_signals": child_signals,
                "history_before": history_before, "history_after": history_after,
                "sibling_before": sibling_before, "sibling_after": sibling_after,
                "model_calls": model.0.load(Ordering::SeqCst),
            })
        );
        assert_eq!(
            history_after, history_before,
            "Objective cancellation must preserve every already-terminal child fact"
        );
        assert_eq!(cancelled.status, ObjectiveStatus::Cancelled);
        assert!(cancelled.active_evaluation_id.is_none());
        assert!(cancelled.evaluation_lease_expires_at.is_none());
        assert_eq!(model.0.load(Ordering::SeqCst), 0);
        assert_eq!(
            sibling_after, sibling_before,
            "another Objective in the same Session must be untouched"
        );
        assert_eq!(
            store
                .get_thread_activation(&parent_activation.id)
                .await
                .unwrap()
                .unwrap()
                .status,
            ThreadActivationStatus::Cancelled
        );
        assert_eq!(
            store
                .get_plan_execution(&waiting.id)
                .await
                .unwrap()
                .unwrap()
                .status,
            PlanExecutionStatus::Cancelled
        );
        assert_eq!(
            child_after.lifecycle,
            ThreadLifecycle::Cancelled,
            "cancelling the owner must not leave a cold infer Thread open"
        );
        if admitted {
            assert_eq!(
                child_activation_after.unwrap().status,
                ThreadActivationStatus::Cancelled
            );
        } else {
            assert!(
                child_activation_after.is_none(),
                "cancellation must not dispatch an unadmitted infer"
            );
        }
        let outcome =
            child_outcome.expect("a terminal child needs the real durable cancellation Outcome");
        assert_eq!(outcome.thread_id, child.id);
        assert_eq!(outcome.thread_generation, child.generation);
        assert_eq!(outcome.root_turn_id, child.root_turn_id);
        assert_eq!(outcome.terminal_kind, ThreadLifecycle::Cancelled);
        assert_eq!(
            child_after.result_event_id.as_deref(),
            Some(outcome.result_event_id.as_str())
        );
        assert_eq!(
            store
                .query(QueryFilter {
                    event_id: Some(outcome.result_event_id),
                    ..Default::default()
                })
                .await
                .unwrap()
                .len(),
            1,
            "the Outcome must reference a real immutable Event"
        );
        assert!(!child_signals.is_empty());
        assert!(
            child_signals
                .iter()
                .all(|signal| signal.status == ThreadSignalStatus::Acknowledged),
            "owned infer Signals must not remain executable"
        );
        if let Some((nested_plan, grandchild, nested_activation_id)) = nested {
            let grandchild_after = store.get_thread(&grandchild.id).await.unwrap().unwrap();
            let nested_plan_after = store
                .get_plan_execution(&nested_plan.id)
                .await
                .unwrap()
                .unwrap();
            let nested_activation_after = store
                .get_thread_activation(&nested_activation_id)
                .await
                .unwrap();
            let grandchild_outcome = store.get_thread_outcome(&grandchild.id).await.unwrap();
            let grandchild_signals = store
                .list_context_thread_signals(&scope.context, None)
                .await
                .unwrap()
                .into_iter()
                .filter(|signal| signal.thread_id == grandchild.id)
                .collect::<Vec<_>>();
            eprintln!(
                "cold_objective_nested_infer_cancel={}",
                json!({
                    "child_after": child_after, "grandchild_after": grandchild_after,
                    "nested_plan": nested_plan_after,
                    "nested_activation": nested_activation_after,
                    "grandchild_outcome": grandchild_outcome,
                    "grandchild_signals": grandchild_signals,
                    "model_calls": model.0.load(Ordering::SeqCst),
                })
            );
            assert_eq!(nested_plan_after.status, PlanExecutionStatus::Cancelled);
            assert!(nested_plan_after.pending_id.is_none());
            assert!(nested_plan_after.pending_kind.is_none());
            assert!(nested_plan_after.claim_token.is_none());
            assert!(nested_plan_after.claimed_by.is_none());
            assert!(nested_plan_after.lease_expires_at.is_none());
            assert_eq!(grandchild_after.lifecycle, ThreadLifecycle::Cancelled);
            assert_eq!(grandchild_after.generation, grandchild.generation + 1);
            assert!(nested_activation_after.is_none());
            let outcome = grandchild_outcome
                .expect("the second-level infer must have its own real cancellation Outcome");
            assert_eq!(outcome.thread_id, grandchild.id);
            assert_eq!(outcome.thread_generation, grandchild.generation);
            assert_eq!(outcome.root_turn_id, grandchild.root_turn_id);
            assert_eq!(outcome.terminal_kind, ThreadLifecycle::Cancelled);
            assert_eq!(
                grandchild_after.result_event_id.as_deref(),
                Some(outcome.result_event_id.as_str())
            );
            assert_eq!(
                store
                    .query(QueryFilter {
                        event_id: Some(outcome.result_event_id),
                        ..Default::default()
                    })
                    .await
                    .unwrap()
                    .len(),
                1,
                "the second-level Outcome must reference its own immutable Event"
            );
            assert!(!grandchild_signals.is_empty());
            assert!(grandchild_signals
                .iter()
                .all(|signal| signal.status == ThreadSignalStatus::Acknowledged));
            assert_eq!(model.0.load(Ordering::SeqCst), 0);
        }
    }

    async fn infer_history(store: &dyn RuntimeStore, child: &ThreadRecord) -> serde_json::Value {
        let outcome = store
            .get_thread_outcome(&child.id)
            .await
            .unwrap()
            .expect("the child must already have a real terminal Outcome");
        let events = store
            .query(QueryFilter {
                event_id: Some(outcome.result_event_id.clone()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(events.len(), 1);
        json!({
            "thread": store.get_thread(&child.id).await.unwrap().unwrap(),
            "outcome": outcome,
            "event": events,
            "activations": store.list_context_thread_activations(&child.context_id, true)
                .await.unwrap().into_iter()
                .filter(|activation| activation.root_turn_id == child.root_turn_id)
                .collect::<Vec<_>>(),
            "signals": store.list_context_thread_signals(&child.context_id, None)
                .await.unwrap().into_iter()
                .filter(|signal| signal.thread_id == child.id)
                .collect::<Vec<_>>(),
        })
    }

    async fn cancellation_before_handoff(
        store: &dyn RuntimeStore,
        runtime: &MorphzRuntime,
        model: &NoModelCalls,
        registry: &morphz::tool::Registry,
        owned: (
            &ObjectiveRecord,
            &ThreadRecord,
            &ThreadActivationRecord,
            &PlanExecutionRecord,
        ),
        sibling: (
            &ObjectiveRecord,
            &ThreadRecord,
            &ThreadActivationRecord,
            &PlanExecutionRecord,
        ),
    ) {
        let (objective, parent, parent_activation, queued) = owned;
        let (sibling, sibling_thread, sibling_activation, sibling_plan) = sibling;
        // Capture a real running claim before cancellation. Calling drive_once
        // after cancellation would stop early and not exercise late Store commit.
        let running = updated(
            store
                .claim_plan_execution(
                    &queued.id,
                    queued.revision,
                    "cold-fixture",
                    "late-infer-handoff",
                    Utc::now() + Duration::hours(1),
                )
                .await
                .unwrap(),
        );
        assert_eq!(running.status, PlanExecutionStatus::Running);
        assert_eq!(running.claim_token.as_deref(), Some("late-infer-handoff"));
        let mut machine: morphz::sexpr_eval::PlanMachine =
            serde_json::from_value(running.state_json.clone()).unwrap();
        let sequence = match machine.advance(registry) {
            morphz::sexpr_eval::PlanAdvance::Suspended(morphz::sexpr_eval::PlanEffect::Infer {
                sequence,
                ..
            }) => sequence,
            _ => panic!("the same validated program must yield its first infer"),
        };
        let request_id =
            morphz::plan_execution::deterministic_infer_request_id(&running.id, sequence).unwrap();
        let child_activation_id =
            morphz::plan_execution::deterministic_infer_activation_id(&request_id).unwrap();
        let state = serde_json::to_value(&machine).unwrap();
        let budget = machine.budget_json().unwrap();
        // This in-memory shape only lets the public producer reconstruct the
        // exact request bytes. It is NEVER written as a waiting Plan or Outcome.
        // The actual handoff below must atomically admit or reject all records.
        let mut pending_shape = running.clone();
        pending_shape.status = PlanExecutionStatus::Waiting;
        pending_shape.pending_kind = Some(PlanExecutionWaitKind::Evaluation);
        pending_shape.pending_id = Some(child_activation_id.clone());
        pending_shape.state_json = state.clone();
        pending_shape.budget_json = budget.clone();
        let request = morphz::plan_execution::pending_infer_request_event(
            &pending_shape,
            parent.response_annotations,
        )
        .unwrap();
        assert_eq!(request.id, request_id);
        assert_eq!(request.timestamp, running.updated_at);
        assert_eq!(request.payload["plan_execution_id"], json!(running.id));
        assert_eq!(
            request.payload["parent_activation_id"],
            json!(parent_activation.id)
        );
        assert!(store
            .get_thread_by_root(&request.id)
            .await
            .unwrap()
            .is_none());
        let sibling_before = snapshot(
            store,
            sibling,
            sibling_thread,
            sibling_activation,
            sibling_plan,
        )
        .await;
        let current = store.get_objective(&objective.id).await.unwrap().unwrap();
        let cancelled = match runtime
            .cancel_objective(
                &current.id,
                current.revision,
                "Cancel before the cold infer handoff commits",
            )
            .await
            .unwrap()
        {
            ObjectiveMutation::Updated(cancelled) => cancelled,
            other => panic!("cancellation must commit before late handoff: {other:?}"),
        };
        assert_eq!(cancelled.status, ObjectiveStatus::Cancelled);
        assert!(cancelled.active_evaluation_id.is_none());
        assert!(cancelled.evaluation_lease_expires_at.is_none());
        let closed = store
            .get_plan_execution(&running.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(closed.status, PlanExecutionStatus::Cancelled);
        assert!(closed.revision > running.revision);
        assert!(closed.pending_kind.is_none() && closed.pending_id.is_none());
        assert!(closed.claimed_by.is_none() && closed.claim_token.is_none());
        assert!(closed.lease_expires_at.is_none() && closed.finished_at.is_some());
        assert_eq!(
            store
                .get_thread_activation(&parent_activation.id)
                .await
                .unwrap()
                .unwrap()
                .status,
            ThreadActivationStatus::Cancelled
        );
        let owner_after_cancel =
            snapshot(store, objective, parent, parent_activation, &closed).await;
        let handoff = store
            .create_evaluation_and_suspend_plan(
                &running.id,
                running.revision,
                "late-infer-handoff",
                &state,
                &budget,
                &request,
                &child_activation_id,
            )
            .await;
        let owner_after_handoff =
            snapshot(store, objective, parent, parent_activation, &closed).await;
        let sibling_after = snapshot(
            store,
            sibling,
            sibling_thread,
            sibling_activation,
            sibling_plan,
        )
        .await;
        let events = store
            .query(QueryFilter {
                event_id: Some(request.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap();
        let child = store.get_thread_by_root(&request.id).await.unwrap();
        let child_activation = store
            .get_thread_activation(&child_activation_id)
            .await
            .unwrap();
        let signal = store
            .thread_signal_for_event(&parent.context_id, &request.id)
            .await
            .unwrap();
        let child_outcome = store
            .get_thread_outcome(&stable_thread_id(&request.id))
            .await
            .unwrap();
        eprintln!(
            "cold_objective_cancel_before_handoff={}",
            json!({
                "handoff_error": handoff.as_ref().err().map(ToString::to_string),
                "cancelled": cancelled, "owner_after_cancel": owner_after_cancel,
                "owner_after_handoff": owner_after_handoff, "events": events,
                "child": child, "child_activation": child_activation, "signal": signal,
                "child_outcome": child_outcome,
                "sibling_before": sibling_before, "sibling_after": sibling_after,
                "model_calls": model.0.load(Ordering::SeqCst),
            })
        );
        assert!(
            handoff.is_err(),
            "a revoked running fence must not create an infer"
        );
        assert_eq!(owner_after_handoff, owner_after_cancel);
        assert_eq!(sibling_after, sibling_before);
        assert!(
            events.is_empty(),
            "rejected handoff must not append its request"
        );
        assert!(child.is_none() && child_activation.is_none());
        assert!(signal.is_none() && child_outcome.is_none());
        assert_eq!(model.0.load(Ordering::SeqCst), 0);
    }

    async fn sqlite_contract(order: CommitOrder) {
        let tmp = tempfile::tempdir().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp.path().join("store.sqlite").to_str().unwrap())
                .await
                .unwrap(),
        );
        contract(store, tmp, order).await;
    }

    #[tokio::test]
    async fn sqlite_objective_cancel_closes_unadmitted_cold_infer_without_touching_sibling() {
        sqlite_contract(CommitOrder::HandoffFirst { admitted: false }).await;
    }

    #[tokio::test]
    async fn sqlite_objective_cancel_closes_admitted_cold_infer_without_touching_sibling() {
        sqlite_contract(CommitOrder::HandoffFirst { admitted: true }).await;
    }

    #[tokio::test]
    async fn sqlite_objective_cancel_rejects_late_cold_infer_handoff() {
        sqlite_contract(CommitOrder::CancellationFirst).await;
    }

    #[tokio::test]
    async fn sqlite_objective_cancel_preserves_terminal_infer_history() {
        sqlite_contract(CommitOrder::HistoricalCancelledChild).await;
    }

    #[tokio::test]
    async fn sqlite_objective_cancel_closes_both_levels_of_nested_cold_infer() {
        sqlite_contract(CommitOrder::NestedHandoffFirst).await;
    }

    #[tokio::test]
    #[ignore = "requires MORPHZ_TEST_POSTGRES_URL pointing to an isolated disposable database"]
    async fn postgres_objective_cancel_covers_both_cold_infer_commit_orders() {
        let url = std::env::var("MORPHZ_TEST_POSTGRES_URL")
            .expect("explicit disposable PostgreSQL URL required");
        let store: Arc<dyn RuntimeStore> = Arc::new(
            morphz::memory::postgres::PostgresStore::new(&url, 4)
                .await
                .unwrap(),
        );
        for order in [
            CommitOrder::HandoffFirst { admitted: false },
            CommitOrder::HandoffFirst { admitted: true },
            CommitOrder::CancellationFirst,
            CommitOrder::HistoricalCancelledChild,
            CommitOrder::NestedHandoffFirst,
        ] {
            contract(store.clone(), tempfile::tempdir().unwrap(), order).await;
        }
    }
}

struct NoPhysicalCalls;

#[async_trait::async_trait]
impl PlanCallPlanner for NoPhysicalCalls {
    async fn plan_call(
        &self,
        _: &PlanExecutionRecord,
        _: &morphz::sexpr_eval::PlanEffect,
        _: &str,
    ) -> PlanExecutionResult<NewExecutionJob> {
        panic!("infer cancellation must not execute a physical call")
    }
}

async fn cancelled_infer_refills_parent(store: Arc<dyn RuntimeStore>, label: &str) {
    for completed_first_step in [false, true] {
        let new = seed(store.as_ref(), &format!("{label}-{completed_first_step}")).await;
        let registry = Arc::new(morphz::tool::Registry::new());
        let program = morphz::sexpr_eval::validate(
            "(eval (infer (returns String) \"synthetic infer\"))",
            &registry,
            &morphz::sexpr_eval::AllowList::new(Vec::<String>::new()),
        )
        .unwrap();
        let coordinator = PlanExecutionCoordinator::new(store.clone(), registry.clone());
        let queued = coordinator
            .ensure(
                PlanExecutionRoute {
                    activation_id: new.activation_id,
                    thread_id: new.thread_id,
                    agent_id: new.agent_id,
                    context_id: new.context_id,
                    session_id: new.session_id,
                    initiating_principal_id: None,
                    tool_call_id: new.tool_call_id,
                    objective_id: None,
                    objective_evaluation_id: None,
                },
                &program,
                PlanArtifactBinding::default(),
            )
            .await
            .unwrap();
        let (plan, event, child_id) = match coordinator
            .drive_once(
                &queued.id,
                queued.revision,
                "worker",
                "claim",
                Utc::now() + Duration::minutes(1),
                &NoPhysicalCalls,
            )
            .await
            .unwrap()
        {
            PlanDriveReceipt::WaitingForEvaluation {
                plan,
                request_event,
                activation_id,
                ..
            } => (plan, request_event, activation_id),
            other => panic!("{other:?}"),
        };
        let event = store
            .query(QueryFilter {
                event_id: Some(event.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()
            .pop()
            .unwrap();
        let child = store.get_thread_by_root(&event.id).await.unwrap().unwrap();
        let sequence = event.sequence.unwrap();
        let activation = store
            .claim_thread_signal_batch(
                NewThreadSignal {
                    id: stable_thread_signal_id(&event.id),
                    thread_id: child.id.clone(),
                    thread_generation: child.generation,
                    event_id: event.id.clone(),
                    principal_id: None,
                    sequence,
                    kind: event.topic.clone(),
                    parent_activation_id: Some(plan.activation_id.clone()),
                },
                NewThreadActivation {
                    id: child_id.clone(),
                    agent_id: plan.agent_id.clone(),
                    context_id: plan.context_id.clone(),
                    session_id: plan.session_id.clone(),
                    initiating_principal_id: None,
                    trigger_event_id: event.id.clone(),
                    trigger_sequence: sequence,
                    trigger_kind: event.topic.clone(),
                    parent_activation_id: Some(plan.activation_id.clone()),
                    root_turn_id: event.id,
                },
                1,
            )
            .await
            .unwrap()
            .unwrap();
        if completed_first_step {
            // A successful first Activation may only hand off to a tool step;
            // cancelling the logical infer Thread must still fail the infer.
            assert!(matches!(
                store
                    .update_thread_activation(
                        &activation.id,
                        activation.revision,
                        ThreadActivationStatus::Succeeded,
                        None,
                        None,
                        None
                    )
                    .await
                    .unwrap(),
                ThreadActivationMutation::Updated(_)
            ));
        }
        let child = store.get_thread(&child.id).await.unwrap().unwrap();
        if completed_first_step {
            // A projection flag alone cannot witness a closed generation.
            let false_terminal = match store
                .update_thread(
                    &child.id,
                    child.revision,
                    None,
                    Some(ThreadLifecycle::Cancelled),
                    None,
                    None,
                    None,
                    None,
                )
                .await
                .unwrap()
            {
                ThreadMutation::Updated(thread) => thread,
                other => panic!("{other:?}"),
            };
            let error = coordinator
                .reconcile_evaluation(&plan.id, &child_id)
                .await
                .unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("missing its durable cancellation Outcome"),
                "{error}"
            );
            assert_eq!(
                store.get_plan_execution(&plan.id).await.unwrap(),
                Some(plan.clone())
            );
            assert!(matches!(
                store
                    .update_thread(
                        &child.id,
                        false_terminal.revision,
                        None,
                        Some(ThreadLifecycle::Open),
                        None,
                        None,
                        None,
                        None
                    )
                    .await
                    .unwrap(),
                ThreadMutation::Updated(_)
            ));
        }
        let child = store.get_thread(&child.id).await.unwrap().unwrap();
        cancel(store.as_ref(), &child).await;
        let closed = store.get_thread(&child.id).await.unwrap().unwrap();
        drop(coordinator);
        let coordinator = PlanExecutionCoordinator::new(store.clone(), registry);
        let receipt = coordinator
            .reconcile_evaluation(&plan.id, &child_id)
            .await
            .expect(
            "a durably cancelled infer must refill its parent instead of failing route validation",
        );
        let resumed = match receipt {
            PlanResumeReceipt::Queued(plan) => plan,
            other => panic!("{other:?}"),
        };
        assert!(matches!(
            coordinator
                .drive_once(
                    &resumed.id,
                    resumed.revision,
                    "worker",
                    "finish",
                    Utc::now() + Duration::minutes(1),
                    &NoPhysicalCalls
                )
                .await
                .unwrap(),
            PlanDriveReceipt::Failed { .. }
        ));
        let terminal = store.get_plan_execution(&plan.id).await.unwrap().unwrap();
        assert_eq!(terminal.status, PlanExecutionStatus::Failed);
        assert!(terminal.error.as_deref().unwrap().contains("cancelled"));
        assert!(
            matches!(coordinator.reconcile_evaluation(&plan.id, &child_id).await.unwrap(), PlanResumeReceipt::Existing(p) if p == terminal)
        );
        assert_eq!(store.get_thread(&child.id).await.unwrap(), Some(closed));
    }
}

#[tokio::test]
async fn sqlite_cancelled_infer_refills_parent_without_live_child() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Arc::new(
        SqliteStore::new(tmp.path().join("store.sqlite").to_str().unwrap())
            .await
            .unwrap(),
    );
    cancelled_infer_refills_parent(store, "sqlite-infer-refill").await;
}

#[tokio::test]
#[ignore = "requires MORPHZ_TEST_POSTGRES_URL pointing to an isolated disposable database"]
async fn postgres_cancelled_infer_refills_parent_without_live_child() {
    let url = std::env::var("MORPHZ_TEST_POSTGRES_URL")
        .expect("explicit disposable PostgreSQL URL required");
    let store = Arc::new(
        morphz::memory::postgres::PostgresStore::new(&url, 4)
            .await
            .unwrap(),
    );
    cancelled_infer_refills_parent(
        store,
        &format!(
            "pg-infer-refill-{}",
            Utc::now().timestamp_nanos_opt().unwrap()
        ),
    )
    .await;
}

async fn seed(store: &dyn RuntimeStore, label: &str) -> NewPlanExecution {
    let agent = format!("agent-{label}");
    let context = format!("context-{label}");
    let session = format!("session-{label}");
    store
        .create_agent_bundle(
            NewAgent {
                id: agent.clone(),
                title: label.into(),
                root_context_id: context.clone(),
            },
            NewCognitiveContext {
                id: context.clone(),
                agent_id: agent.clone(),
                title: label.into(),
            },
            NewSession {
                id: session.clone(),
                agent_id: agent.clone(),
                context_id: context.clone(),
                parent_session_id: None,
                title: label.into(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await
        .unwrap();
    let thread = format!("thread-{label}");
    let root = format!("root-{label}");
    let activation = format!("activation-{label}");
    store
        .ensure_thread(NewThread {
            response_annotations: morphz::response_annotations::Protocol::Off,
            model_alias: None,
            reasoning_effort: None,
            id: thread.clone(),
            agent_id: agent.clone(),
            context_id: context.clone(),
            session_id: session.clone(),
            initiating_principal_id: None,
            root_turn_id: root.clone(),
            kind: ThreadKind::Execution,
            executor_kind: "self".into(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::runtime("plan-cancel-test"),
        })
        .await
        .unwrap();
    store
        .ensure_thread_activation(NewThreadActivation {
            id: activation.clone(),
            agent_id: agent.clone(),
            context_id: context.clone(),
            session_id: session.clone(),
            initiating_principal_id: None,
            trigger_event_id: root.clone(),
            trigger_sequence: 1,
            trigger_kind: "runtime/plan".into(),
            parent_activation_id: None,
            root_turn_id: root,
        })
        .await
        .unwrap();
    NewPlanExecution {
        id: format!("plan-{label}"),
        activation_id: activation,
        thread_id: thread,
        agent_id: agent,
        context_id: context,
        session_id: session,
        initiating_principal_id: None,
        tool_call_id: format!("call-{label}"),
        objective_id: None,
        objective_evaluation_id: None,
        harness_id: None,
        harness_version: None,
        source_artifact_hash: format!("sha256:{label}"),
        ir_schema_version: 1,
        program_json: json!({"synthetic":true}),
        state_json: json!({"steps":[]}),
        budget_json: json!({"steps_remaining":100}),
    }
}

fn updated(mutation: PlanExecutionMutation) -> PlanExecutionRecord {
    match mutation {
        PlanExecutionMutation::Updated(p) => p,
        other => panic!("{other:?}"),
    }
}

async fn cancel(store: &dyn RuntimeStore, thread: &ThreadRecord) {
    assert!(matches!(
        store
            .control_thread(
                &thread.id,
                thread.revision,
                ThreadControlAction::Cancel,
                Some("synthetic cancellation"),
                Some("Test")
            )
            .await
            .unwrap(),
        ThreadMutation::Updated(_)
    ));
}

fn assert_closed(p: &PlanExecutionRecord) {
    assert_eq!(p.status, PlanExecutionStatus::Cancelled, "{}", p.id);
    assert!(p.pending_kind.is_none() && p.pending_id.is_none());
    assert!(p.claimed_by.is_none() && p.claim_token.is_none() && p.lease_expires_at.is_none());
    assert!(p.finished_at.is_some());
    assert_eq!(p.error.as_deref(), Some("synthetic cancellation"));
}

fn group_request(plan: &NewPlanExecution) -> (NewActionGroup, Vec<NewActionGroupMember>) {
    (
        NewActionGroup {
            id: format!("group-{}", plan.id),
            activation_id: plan.activation_id.clone(),
            thread_id: plan.thread_id.clone(),
            agent_id: plan.agent_id.clone(),
            context_id: plan.context_id.clone(),
            session_id: plan.session_id.clone(),
            assistant_call_event_id: format!("group-call-{}", plan.id),
            objective_id: None,
            objective_evaluation_id: None,
            objective_revision: None,
        },
        (0..2)
            .map(|ordinal| NewActionGroupMember {
                ordinal,
                tool_call_id: format!("branch-{ordinal}"),
                tool_name: "read".into(),
                execution_job_id: None,
            })
            .collect(),
    )
}

fn group_event(group: &NewActionGroup, index: Option<usize>) -> Event {
    let topic = if index.is_some() {
        "tool/read"
    } else {
        "runtime/action_group_settled"
    };
    let mut payload = json!({ "action_group_id":group.id, "context_id":group.context_id,
        "session_id":group.session_id, "thread_id":group.thread_id, "activation_id":group.activation_id,
        "wake_policy":"direct_signal", "output":"synthetic result" });
    if let Some(i) = index {
        payload["tool_call_id"] = json!(format!("branch-{i}"));
    }
    Event::new(
        format!(
            "{}-{}",
            group.id,
            index.map_or("settled".into(), |i| i.to_string())
        ),
        "Test".into(),
        "tool_output".into(),
        topic.into(),
        payload.as_object().unwrap().clone(),
    )
}

async fn persist_group_call(store: &dyn RuntimeStore, group: &NewActionGroup) {
    store
        .append(Event::new(
            group.assistant_call_event_id.clone(),
            "Test".into(),
            morphz::event::TYPE_AGENT_CALL.into(),
            "chat/assistant_call".into(),
            json!({"context_id":group.context_id, "session_id":group.session_id,
            "activation_id":group.activation_id, "thread_id":group.thread_id})
            .as_object()
            .unwrap()
            .clone(),
        ))
        .await
        .unwrap();
}

async fn group_cancellation_contract(store: &dyn RuntimeStore, label: &str) {
    let plan = seed(store, label).await;
    let thread = store.get_thread(&plan.thread_id).await.unwrap().unwrap();
    let (group, members) = group_request(&plan);
    persist_group_call(store, &group).await;
    store
        .create_action_group(group.clone(), members.clone())
        .await
        .unwrap();
    let first = group_event(&group, Some(0));
    let settled = group_event(&group, None);
    let before = store
        .commit_action_group_member_result(
            &group.id,
            "branch-0",
            ActionGroupMemberStatus::Succeeded,
            &first,
            &settled,
        )
        .await
        .unwrap();
    cancel(store, &thread).await;
    let closed = store.get_action_group(&group.id).await.unwrap().unwrap();
    assert_eq!(closed.status, ActionGroupStatus::Cancelled);
    assert_eq!(closed.terminal_member_count, 1);
    assert!(closed.settled_at.is_some());
    assert_eq!(
        store
            .create_action_group(group.clone(), members.clone())
            .await
            .unwrap(),
        closed
    );
    let replay = store
        .commit_action_group_member_result(
            &group.id,
            "branch-0",
            ActionGroupMemberStatus::Succeeded,
            &first,
            &settled,
        )
        .await
        .unwrap();
    assert_eq!(replay.member, before.member);
    assert!(replay.existing);
    let remaining = store.list_action_group_members(&group.id).await.unwrap();
    assert_eq!(remaining[1].status, ActionGroupMemberStatus::Pending);
    assert!(
        remaining[1].result_event_id.is_none(),
        "do not manufacture unobserved member results"
    );
    let late_result = store
        .commit_action_group_member_result(
            &group.id,
            "branch-1",
            ActionGroupMemberStatus::Succeeded,
            &group_event(&group, Some(1)),
            &settled,
        )
        .await
        .unwrap();
    assert!(!late_result.settled_now);
    assert_eq!(late_result.group.status, ActionGroupStatus::Cancelled);
    assert_eq!(late_result.group.terminal_member_count, 2);
    assert!(store
        .query(QueryFilter {
            event_id: Some(settled.id.clone()),
            ..Default::default()
        })
        .await
        .unwrap()
        .is_empty());
    let mut late = group.clone();
    late.id.push_str("-late");
    late.assistant_call_event_id.push_str("-late");
    assert!(store
        .create_action_group(late.clone(), members)
        .await
        .is_err());
    assert!(store.get_action_group(&late.id).await.unwrap().is_none());
}

async fn group_races_cancel(store: &dyn RuntimeStore, label: &str) {
    for i in 0..12 {
        let plan = seed(store, &format!("{label}-{i}")).await;
        let thread = store.get_thread(&plan.thread_id).await.unwrap().unwrap();
        let (group, members) = group_request(&plan);
        persist_group_call(store, &group).await;
        let (created, ()) = tokio::join!(
            store.create_action_group(group.clone(), members),
            cancel(store, &thread)
        );
        let saved = store.get_action_group(&group.id).await.unwrap();
        match created {
            Ok(_) => assert_eq!(saved.unwrap().status, ActionGroupStatus::Cancelled),
            Err(e) => {
                assert!(e.to_string().contains("live owner"), "{e}");
                assert!(saved.is_none());
            }
        }
    }
    for i in 0..12 {
        let plan = seed(store, &format!("{label}-settle-{i}")).await;
        let thread = store.get_thread(&plan.thread_id).await.unwrap().unwrap();
        let (group, members) = group_request(&plan);
        persist_group_call(store, &group).await;
        store
            .create_action_group(group.clone(), members)
            .await
            .unwrap();
        let settled = group_event(&group, None);
        store
            .commit_action_group_member_result(
                &group.id,
                "branch-0",
                ActionGroupMemberStatus::Succeeded,
                &group_event(&group, Some(0)),
                &settled,
            )
            .await
            .unwrap();
        let second = group_event(&group, Some(1));
        let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(
                store.commit_action_group_member_result(
                    &group.id,
                    "branch-1",
                    ActionGroupMemberStatus::Succeeded,
                    &second,
                    &settled
                ),
                cancel(store, &thread)
            )
        })
        .await
        .expect("settlement/cancellation lock order must not deadlock");
        let closed = store.get_action_group(&group.id).await.unwrap().unwrap();
        let receipt = result.unwrap();
        assert_eq!(closed.terminal_member_count, 2);
        assert_eq!(
            closed.status,
            if receipt.settled_now {
                ActionGroupStatus::Settled
            } else {
                ActionGroupStatus::Cancelled
            }
        );
    }
}

async fn cancellation_contract(store: &dyn RuntimeStore, label: &str) -> Vec<String> {
    let new = seed(store, label).await;
    let thread = store.get_thread(&new.thread_id).await.unwrap().unwrap();
    let mut live = Vec::new();
    let mut terminal = None;
    for i in 0..7 {
        let mut request = new.clone();
        request.id = format!("{}-{i}", new.id);
        request.tool_call_id = format!("{}-{i}", new.tool_call_id);
        let mut plan = store.create_plan_execution(request).await.unwrap();
        if i > 0 {
            plan = updated(
                store
                    .claim_plan_execution(
                        &plan.id,
                        plan.revision,
                        "old-worker",
                        "old-claim",
                        Utc::now() + Duration::minutes(1),
                    )
                    .await
                    .unwrap(),
            );
        }
        if (2..6).contains(&i) {
            let kind = [
                PlanExecutionWaitKind::ExecutionJob,
                PlanExecutionWaitKind::Evaluation,
                PlanExecutionWaitKind::ActionGroup,
                PlanExecutionWaitKind::PlanExecution,
            ][i - 2];
            plan = updated(
                store
                    .suspend_plan_execution(
                        &plan.id,
                        plan.revision,
                        "old-claim",
                        &plan.state_json,
                        &plan.budget_json,
                        kind,
                        "synthetic-child",
                    )
                    .await
                    .unwrap(),
            );
        } else if i == 6 {
            plan = updated(
                store
                    .finish_plan_execution(
                        &plan.id,
                        plan.revision,
                        "old-claim",
                        PlanExecutionStatus::Succeeded,
                        &plan.state_json,
                        &plan.budget_json,
                        Some(&json!({"completed":true})),
                        None,
                    )
                    .await
                    .unwrap(),
            );
            terminal = Some(plan);
            continue;
        }
        live.push(plan);
    }
    // A different Thread in the SAME Session must remain untouched.
    let mut sibling = new.clone();
    sibling.id.push_str("-sibling");
    sibling.thread_id.push_str("-sibling");
    sibling.activation_id.push_str("-sibling");
    store
        .ensure_thread(NewThread {
            response_annotations: morphz::response_annotations::Protocol::Off,
            model_alias: None,
            reasoning_effort: None,
            id: sibling.thread_id.clone(),
            agent_id: new.agent_id.clone(),
            context_id: new.context_id.clone(),
            session_id: new.session_id.clone(),
            initiating_principal_id: None,
            root_turn_id: format!("sibling-root-{label}"),
            kind: ThreadKind::Execution,
            executor_kind: "self".into(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::runtime("plan-cancel-test"),
        })
        .await
        .unwrap();
    store
        .ensure_thread_activation(NewThreadActivation {
            id: sibling.activation_id.clone(),
            agent_id: new.agent_id.clone(),
            context_id: new.context_id.clone(),
            session_id: new.session_id.clone(),
            initiating_principal_id: None,
            trigger_event_id: format!("sibling-root-{label}"),
            trigger_sequence: 1,
            trigger_kind: "runtime/plan".into(),
            parent_activation_id: None,
            root_turn_id: format!("sibling-root-{label}"),
        })
        .await
        .unwrap();
    let sibling_plan = store.create_plan_execution(sibling.clone()).await.unwrap();
    assert!(matches!(
        store
            .control_thread(
                &thread.id,
                thread.revision + 100,
                ThreadControlAction::Cancel,
                None,
                None
            )
            .await
            .unwrap(),
        ThreadMutation::Conflict { .. }
    ));
    for p in &live {
        assert_eq!(
            store.get_plan_execution(&p.id).await.unwrap().as_ref(),
            Some(p)
        );
    }
    cancel(store, &thread).await;
    for old in &live {
        let closed = store.get_plan_execution(&old.id).await.unwrap().unwrap();
        assert_closed(&closed);
        assert_eq!(closed.revision, old.revision + 1);
        assert!(!matches!(
            store
                .claim_plan_execution(
                    &old.id,
                    old.revision,
                    "late-worker",
                    "late-claim",
                    Utc::now() + Duration::minutes(1)
                )
                .await
                .unwrap(),
            PlanExecutionMutation::Updated(_)
        ));
        if old.status == PlanExecutionStatus::Running {
            assert!(!matches!(
                store
                    .finish_plan_execution(
                        &old.id,
                        old.revision,
                        "old-claim",
                        PlanExecutionStatus::Succeeded,
                        &old.state_json,
                        &old.budget_json,
                        Some(&json!("late")),
                        None
                    )
                    .await
                    .unwrap(),
                PlanExecutionMutation::Updated(_)
            ));
        }
    }
    let terminal = terminal.unwrap();
    assert_eq!(
        store.get_plan_execution(&terminal.id).await.unwrap(),
        Some(terminal)
    );
    assert_eq!(
        store.get_plan_execution(&sibling_plan.id).await.unwrap(),
        Some(sibling_plan)
    );
    // Replaying an existing causal key is still valid after cancellation.
    let mut replay = new.clone();
    replay.id.push_str("-0");
    replay.tool_call_id.push_str("-0");
    assert_closed(&store.create_plan_execution(replay).await.unwrap());
    assert!(
        store.create_plan_execution(new.clone()).await.is_err(),
        "late child must not be created"
    );
    assert!(store.get_plan_execution(&new.id).await.unwrap().is_none());
    let mut wrong_route = sibling.clone();
    wrong_route.id.push_str("-wrong");
    wrong_route.tool_call_id.push_str("-wrong");
    wrong_route.thread_id = new.thread_id;
    assert!(store.create_plan_execution(wrong_route).await.is_err());
    live.into_iter().map(|p| p.id).collect()
}

async fn creation_races_cancel(store: &dyn RuntimeStore, label: &str) {
    for i in 0..12 {
        let new = seed(store, &format!("{label}-{i}")).await;
        let thread = store.get_thread(&new.thread_id).await.unwrap().unwrap();
        let (created, ()) = tokio::join!(
            store.create_plan_execution(new.clone()),
            cancel(store, &thread)
        );
        let persisted = store.get_plan_execution(&new.id).await.unwrap();
        match created {
            Ok(_) => assert_closed(&persisted.unwrap()),
            Err(error) => {
                assert!(error.to_string().contains("live owner"), "{error}");
                assert!(persisted.is_none());
            }
        }
    }
}

async fn activation_owner_contract(store: &dyn RuntimeStore, label: &str) {
    for (index, status) in [
        ThreadActivationStatus::Cancelled,
        ThreadActivationStatus::Failed,
    ]
    .into_iter()
    .enumerate()
    {
        let new = seed(store, &format!("{label}-{index}")).await;
        let activation = store
            .get_thread_activation(&new.activation_id)
            .await
            .unwrap()
            .unwrap();
        let queued = store.create_plan_execution(new.clone()).await.unwrap();
        let running = updated(
            store
                .claim_plan_execution(
                    &queued.id,
                    queued.revision,
                    "worker",
                    "claim",
                    Utc::now() + Duration::minutes(1),
                )
                .await
                .unwrap(),
        );
        let (group, members) = group_request(&new);
        persist_group_call(store, &group).await;
        store
            .create_action_group(group.clone(), members)
            .await
            .unwrap();
        store
            .commit_action_group_member_result(
                &group.id,
                "branch-0",
                ActionGroupMemberStatus::Succeeded,
                &group_event(&group, Some(0)),
                &group_event(&group, None),
            )
            .await
            .unwrap();

        // Another Activation in this very same Thread is not the target.
        let sibling_id = format!("{}-sibling", activation.id);
        store
            .ensure_thread_activation(NewThreadActivation {
                id: sibling_id.clone(),
                agent_id: new.agent_id.clone(),
                context_id: new.context_id.clone(),
                session_id: new.session_id.clone(),
                initiating_principal_id: None,
                trigger_event_id: format!("{}-sibling", activation.trigger_event_id),
                trigger_sequence: 2,
                trigger_kind: "runtime/plan".into(),
                parent_activation_id: None,
                root_turn_id: activation.root_turn_id.clone(),
            })
            .await
            .unwrap();
        let mut sibling_new = new.clone();
        sibling_new.id.push_str("-sibling");
        sibling_new.activation_id = sibling_id;
        let sibling = store.create_plan_execution(sibling_new).await.unwrap();

        assert!(matches!(
            store
                .update_thread_activation(
                    &activation.id,
                    activation.revision + 1,
                    status,
                    None,
                    None,
                    None
                )
                .await
                .unwrap(),
            ThreadActivationMutation::Conflict { .. }
        ));
        assert_eq!(
            store
                .get_plan_execution(&running.id)
                .await
                .unwrap()
                .unwrap(),
            running
        );
        assert!(matches!(
            store
                .update_thread_activation(
                    &activation.id,
                    activation.revision,
                    status,
                    None,
                    None,
                    None
                )
                .await
                .unwrap(),
            ThreadActivationMutation::Updated(_)
        ));
        let closed = store
            .get_plan_execution(&running.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(closed.status, PlanExecutionStatus::Cancelled);
        assert!(
            closed.claimed_by.is_none()
                && closed.claim_token.is_none()
                && closed.lease_expires_at.is_none()
        );
        assert!(
            closed.pending_id.is_none()
                && closed.pending_kind.is_none()
                && closed.finished_at.is_some()
        );
        let closed_group = store.get_action_group(&group.id).await.unwrap().unwrap();
        assert_eq!(closed_group.status, ActionGroupStatus::Cancelled);
        assert_eq!(closed_group.terminal_member_count, 1);
        assert_eq!(
            store
                .get_plan_execution(&sibling.id)
                .await
                .unwrap()
                .unwrap(),
            sibling
        );
        let mut late = new.clone();
        late.id.push_str("-late");
        late.tool_call_id.push_str("-late");
        assert!(store.create_plan_execution(late).await.is_err());
    }
    for index in 0..12 {
        let new = seed(store, &format!("{label}-race-{index}")).await;
        let activation = store
            .get_thread_activation(&new.activation_id)
            .await
            .unwrap()
            .unwrap();
        let (created, cancelled) = tokio::join!(
            store.create_plan_execution(new.clone()),
            store.update_thread_activation(
                &activation.id,
                activation.revision,
                ThreadActivationStatus::Cancelled,
                None,
                None,
                None
            )
        );
        assert!(matches!(
            cancelled.unwrap(),
            ThreadActivationMutation::Updated(_)
        ));
        let persisted = store.get_plan_execution(&new.id).await.unwrap();
        match created {
            Ok(_) => assert_eq!(persisted.unwrap().status, PlanExecutionStatus::Cancelled),
            Err(error) => {
                assert!(error.to_string().contains("live owner"), "{error}");
                assert!(persisted.is_none());
            }
        }
    }
}

async fn job_handoff_races_cancel(store: &dyn RuntimeStore, label: &str) {
    for i in 0..12 {
        let new = seed(store, &format!("{label}-{i}")).await;
        let thread = store.get_thread(&new.thread_id).await.unwrap().unwrap();
        let queued = store.create_plan_execution(new.clone()).await.unwrap();
        let plan = updated(
            store
                .claim_plan_execution(
                    &queued.id,
                    queued.revision,
                    "worker",
                    "claim",
                    Utc::now() + Duration::minutes(1),
                )
                .await
                .unwrap(),
        );
        let job = NewExecutionJob {
            id: format!("job-{}", new.id),
            activation_id: new.activation_id,
            thread_id: new.thread_id,
            agent_id: new.agent_id,
            context_id: new.context_id,
            session_id: new.session_id,
            initiating_principal_id: None,
            target_id: morphz::execution_target::DEFAULT_EXECUTION_TARGET_ID.into(),
            tool_call_id: new.tool_call_id,
            tool_name: "read".into(),
            request: json!({"path":"synthetic"}),
            retry_safety: ExecutionRetrySafety::Idempotent,
            requires_approval: false,
        };
        let job_id = job.id.clone();
        let (handoff, ()) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(
                store.create_execution_job_and_suspend_plan(
                    &plan.id,
                    plan.revision,
                    "claim",
                    &plan.state_json,
                    &plan.budget_json,
                    job
                ),
                cancel(store, &thread)
            )
        })
        .await
        .expect("physical handoff and cancellation must share the owner-first lock order");
        assert_closed(&store.get_plan_execution(&plan.id).await.unwrap().unwrap());
        let child = store.get_execution_job(&job_id).await.unwrap();
        match handoff {
            Ok(_) => assert!(child.unwrap().side_effect_started_at.is_none()),
            Err(e) => {
                assert!(e.to_string().contains("cancelled"), "{e}");
                assert!(child.is_none());
            }
        }
    }
}

async fn infer_reconciliation_races_cancel(store: &dyn RuntimeStore, label: &str) {
    for cancel_child in [false, true] {
        for i in 0..6 {
            let new = seed(store, &format!("{label}-{cancel_child}-{i}")).await;
            let queued = store.create_plan_execution(new.clone()).await.unwrap();
            let running = updated(
                store
                    .claim_plan_execution(
                        &queued.id,
                        queued.revision,
                        "worker",
                        "claim",
                        Utc::now() + Duration::minutes(1),
                    )
                    .await
                    .unwrap(),
            );
            let event_id = format!("infer-{}", new.id);
            let activation_id =
                morphz::plan_execution::deterministic_infer_activation_id(&event_id).unwrap();
            let request = Event::new(event_id.clone(), "Test".into(), morphz::event::TYPE_INFER_REQUEST.into(),
                "chat/infer_request".into(), json!({"agent_id":new.agent_id, "context_id":new.context_id,
                    "session_id":new.session_id, "plan_execution_id":new.id,
                    "parent_activation_id":new.activation_id, "root_turn_id":event_id, "text":"synthetic infer"})
                    .as_object().unwrap().clone());
            store
                .create_evaluation_and_suspend_plan(
                    &running.id,
                    running.revision,
                    "claim",
                    &running.state_json,
                    &running.budget_json,
                    &request,
                    &activation_id,
                )
                .await
                .unwrap();
            let persisted = store
                .query(QueryFilter {
                    event_id: Some(event_id.clone()),
                    ..Default::default()
                })
                .await
                .unwrap()
                .pop()
                .unwrap();
            let child = store.get_thread_by_root(&event_id).await.unwrap().unwrap();
            let sequence = persisted.sequence.unwrap();
            let activation = store
                .claim_thread_signal_batch(
                    NewThreadSignal {
                        id: stable_thread_signal_id(&event_id),
                        thread_id: child.id.clone(),
                        thread_generation: child.generation,
                        event_id: event_id.clone(),
                        principal_id: None,
                        sequence,
                        kind: request.topic.clone(),
                        parent_activation_id: Some(new.activation_id.clone()),
                    },
                    NewThreadActivation {
                        id: activation_id.clone(),
                        agent_id: new.agent_id.clone(),
                        context_id: new.context_id.clone(),
                        session_id: new.session_id.clone(),
                        initiating_principal_id: None,
                        trigger_event_id: event_id.clone(),
                        trigger_sequence: sequence,
                        trigger_kind: request.topic.clone(),
                        parent_activation_id: Some(new.activation_id.clone()),
                        root_turn_id: event_id,
                    },
                    1,
                )
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                store
                    .reconcile_plan_evaluation_activation(&running.id, &activation_id)
                    .await
                    .unwrap()
                    .unwrap()
                    .id,
                activation.id
            );
            let target = if cancel_child {
                child
            } else {
                store.get_thread(&new.thread_id).await.unwrap().unwrap()
            };
            let (reconciled, ()) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                tokio::join!(
                    store.reconcile_plan_evaluation_activation(&running.id, &activation_id),
                    cancel(store, &target)
                )
            })
            .await
            .expect("infer reconciliation must not deadlock with parent or child cancellation");
            if !cancel_child {
                assert_closed(
                    &store
                        .get_plan_execution(&running.id)
                        .await
                        .unwrap()
                        .unwrap(),
                );
            }
            if cancel_child {
                assert!(reconciled
                    .expect("child cancellation must retain a valid historical infer route")
                    .is_some());
                continue;
            }
            match reconciled {
                Ok(activation) => assert!(activation.is_some()),
                Err(e) => {
                    // Parent cancellation can invalidate the original wait,
                    // but must not produce a database/lock-order error.
                    let reason = e.to_string();
                    assert!(reason.contains("没有等待 child Activation")
                        || reason == "PlanExecution route is inconsistent with deterministic infer Activation"
                        || reason == "PlanExecution route is inconsistent with deterministic infer Signal"
                        || reason == "PlanExecution route is inconsistent with the existing parent Activation",
                        "{reason}");
                }
            }
        }
    }
}

#[tokio::test]
async fn sqlite_plan_owner_cancellation_survives_reopen_without_reconciler() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("store.sqlite");
    let store = SqliteStore::new(path.to_str().unwrap()).await.unwrap();
    let ids = cancellation_contract(&store, "sqlite-close").await;
    drop(store);
    let reopened = SqliteStore::new(path.to_str().unwrap()).await.unwrap();
    for id in ids {
        assert_closed(&reopened.get_plan_execution(&id).await.unwrap().unwrap());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_plan_creation_races_owner_cancellation() {
    let tmp = tempfile::tempdir().unwrap();
    let store = SqliteStore::new(tmp.path().join("store.sqlite").to_str().unwrap())
        .await
        .unwrap();
    creation_races_cancel(&store, "sqlite-race").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_activation_terminal_closes_only_its_logical_owners() {
    let tmp = tempfile::tempdir().unwrap();
    let store = SqliteStore::new(tmp.path().join("store.sqlite").to_str().unwrap())
        .await
        .unwrap();
    activation_owner_contract(&store, "sqlite-activation").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_action_group_owner_cancellation_and_races() {
    let tmp = tempfile::tempdir().unwrap();
    let store = SqliteStore::new(tmp.path().join("store.sqlite").to_str().unwrap())
        .await
        .unwrap();
    group_cancellation_contract(&store, "sqlite-group").await;
    group_races_cancel(&store, "sqlite-group-race").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_plan_job_handoff_races_owner_cancellation() {
    let tmp = tempfile::tempdir().unwrap();
    let store = SqliteStore::new(tmp.path().join("store.sqlite").to_str().unwrap())
        .await
        .unwrap();
    job_handoff_races_cancel(&store, "sqlite-handoff").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_infer_reconciliation_races_parent_and_child_cancellation() {
    let tmp = tempfile::tempdir().unwrap();
    let store = SqliteStore::new(tmp.path().join("store.sqlite").to_str().unwrap())
        .await
        .unwrap();
    infer_reconciliation_races_cancel(&store, "sqlite-infer").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MORPHZ_TEST_POSTGRES_URL pointing to an isolated disposable database"]
async fn postgres_plan_owner_cancellation_matches_sqlite() {
    let url = std::env::var("MORPHZ_TEST_POSTGRES_URL")
        .expect("explicit disposable PostgreSQL URL required");
    let store = morphz::memory::postgres::PostgresStore::new(&url, 4)
        .await
        .unwrap();
    let label = format!("pg-{}", Utc::now().timestamp_nanos_opt().unwrap());
    cancellation_contract(&store, &label).await;
    creation_races_cancel(&store, &format!("{label}-race")).await;
    group_cancellation_contract(&store, &format!("{label}-group")).await;
    group_races_cancel(&store, &format!("{label}-group-race")).await;
    job_handoff_races_cancel(&store, &format!("{label}-handoff")).await;
    infer_reconciliation_races_cancel(&store, &format!("{label}-infer")).await;
    activation_owner_contract(&store, &format!("{label}-activation")).await;
}
