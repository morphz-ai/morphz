//! Durable response-annotation protocol conformance. No model/provider calls.
//!
//! PostgreSQL uses the explicitly supplied annotation connection, or the shared
//! MORPHZ_TEST_POSTGRES_URL test connection, and only a freshly generated schema
//! without a public fallback. CI cannot silently omit this conformance lane.
use morphz::event::{Event, TYPE_INFER_REQUEST, TYPE_USER_MESSAGE};
use morphz::memory::postgres::PostgresStore;
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{
    stable_thread_signal_id, thread_supersede_event, ActivationOutcomeCommit,
    DialogueTurnRetryMutation, DialogueTurnRetryRequest, MessageClaim, MessageDispatchMode,
    NewAgent, NewCognitiveContext, NewPrincipal, NewSession, NewThread, NewThreadActivation,
    NewThreadSignal, QueryFilter, RuntimeStore, SessionMountKind, ThreadActivationMutation,
    ThreadActivationRecord, ThreadActivationStatus, ThreadKind, ThreadLifecycle, ThreadMutation,
    ThreadRecord, ThreadSignalBatchClaim, ThreadSignalRecord, ThreadSupervision,
};
use morphz::response_annotations::Protocol;
use serde_json::json;
use std::sync::Arc;

type TestError = Box<dyn std::error::Error + Send + Sync>;

struct Route {
    agent: String,
    context: String,
    session: String,
    principal: String,
}

async fn create_route<S: RuntimeStore + ?Sized>(
    store: &S,
    label: &str,
) -> Result<Route, TestError> {
    let route = Route {
        agent: format!("annotations-{label}-agent"),
        context: format!("annotations-{label}-context"),
        session: format!("annotations-{label}-session"),
        principal: format!("annotations-{label}-human"),
    };
    store
        .create_agent_bundle(
            NewAgent {
                id: route.agent.clone(),
                title: "Synthetic protocol test Agent".into(),
                root_context_id: route.context.clone(),
            },
            NewCognitiveContext {
                id: route.context.clone(),
                agent_id: route.agent.clone(),
                title: "Synthetic protocol test Context".into(),
            },
            NewSession {
                id: route.session.clone(),
                agent_id: route.agent.clone(),
                context_id: route.context.clone(),
                parent_session_id: None,
                title: "Synthetic protocol test Session".into(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await?;
    store
        .ensure_principal(NewPrincipal {
            id: route.principal.clone(),
            provider_id: "isolated-test".into(),
            assurance: "authenticated".into(),
            display_name: None,
        })
        .await?;
    store
        .bind_session_principal(&route.session, &route.principal)
        .await?;
    Ok(route)
}

fn thread(route: &Route, suffix: &str, kind: ThreadKind, protocol: Protocol) -> NewThread {
    NewThread {
        response_annotations: protocol,
        model_alias: None,
        reasoning_effort: None,
        id: format!("{}-{suffix}-thread", route.context),
        agent_id: route.agent.clone(),
        context_id: route.context.clone(),
        session_id: route.session.clone(),
        initiating_principal_id: Some(route.principal.clone()),
        root_turn_id: format!("{}-{suffix}-input", route.context),
        kind,
        executor_kind: "self".into(),
        executor_id: None,
        target_id: None,
        supervision: ThreadSupervision::legacy(),
    }
}

fn input(route: &Route, suffix: &str, protocol: Protocol) -> Event {
    let mut payload = json!({
        "agent_id": route.agent,
        "context_id": route.context,
        "session_id": route.session,
        "principal_id": route.principal,
        "text": format!("synthetic message {suffix}"),
        "dispatch_mode": "interrupt"
    })
    .as_object()
    .unwrap()
    .clone();
    if !protocol.is_off() {
        payload.insert("response_annotations".into(), json!(protocol));
    }
    Event::new(
        format!("{}-{suffix}-input", route.context),
        "User".into(),
        TYPE_USER_MESSAGE.into(),
        "chat/user_message".into(),
        payload,
    )
}

async fn persisted<S: RuntimeStore + ?Sized>(store: &S, event: &Event) -> Result<Event, TestError> {
    let mut events = store
        .query(QueryFilter {
            event_id: Some(event.id.clone()),
            ..Default::default()
        })
        .await?;
    assert_eq!(events.len(), 1, "the exact immutable Event must exist");
    Ok(events.remove(0))
}

async fn ingress<S: RuntimeStore + ?Sized>(
    store: &S,
    route: &Route,
    suffix: &str,
    protocol: Protocol,
) -> Result<Event, TestError> {
    let event = input(route, suffix, protocol);
    ingress_event(store, route, suffix, event).await
}

async fn ingress_event<S: RuntimeStore + ?Sized>(
    store: &S,
    route: &Route,
    suffix: &str,
    event: Event,
) -> Result<Event, TestError> {
    match store
        .claim_message(
            &route.session,
            &format!("{}-{suffix}-client", route.context),
            &event,
            MessageDispatchMode::Interrupt,
        )
        .await?
    {
        // Ingress acceptance returns the submitted Event shape, not a
        // hydrated immutable Store row. Read its physical sequence back;
        // Signal/Activation assertions must use durable facts, never a
        // transport return value or an invented test sequence.
        MessageClaim::Accepted { event, .. } => {
            let event = persisted(store, &event).await?;
            assert!(
                event.sequence.is_some(),
                "accepted input must have a durable physical sequence"
            );
            Ok(event)
        }
        other => panic!("synthetic ingress was not accepted: {other:?}"),
    }
}

async fn signal_for<S: RuntimeStore + ?Sized>(
    store: &S,
    event: &Event,
) -> Result<ThreadSignalRecord, TestError> {
    let signals = store
        .list_context_thread_signals(event.payload["context_id"].as_str().unwrap(), None)
        .await?;
    let matching = signals
        .into_iter()
        .filter(|signal| signal.event_id == event.id)
        .collect::<Vec<_>>();
    assert_eq!(matching.len(), 1);
    Ok(matching[0].clone())
}

async fn claim<S: RuntimeStore + ?Sized>(
    store: &S,
    route: &Route,
    thread: &ThreadRecord,
    event: &Event,
    suffix: &str,
) -> Result<ThreadSignalBatchClaim, TestError> {
    let sequence = event
        .sequence
        .expect("claim uses a real persisted sequence");
    store
        .claim_thread_signal_batch_observed(
            NewThreadSignal {
                id: stable_thread_signal_id(&event.id),
                thread_id: thread.id.clone(),
                thread_generation: thread.generation,
                event_id: event.id.clone(),
                principal_id: Some(route.principal.clone()),
                sequence,
                kind: event.topic.clone(),
                parent_activation_id: None,
            },
            NewThreadActivation {
                id: format!("{}-{suffix}-activation", route.context),
                agent_id: route.agent.clone(),
                context_id: route.context.clone(),
                session_id: route.session.clone(),
                initiating_principal_id: Some(route.principal.clone()),
                trigger_event_id: event.id.clone(),
                trigger_sequence: sequence,
                trigger_kind: event.topic.clone(),
                parent_activation_id: None,
                root_turn_id: thread.root_turn_id.clone(),
            },
            32,
        )
        .await
}

async fn claim_ingress<S: RuntimeStore + ?Sized>(
    store: &S,
    route: &Route,
    event: &Event,
    suffix: &str,
) -> Result<ThreadSignalBatchClaim, TestError> {
    let signal = signal_for(store, event).await?;
    let thread = store.get_thread(&signal.thread_id).await?.unwrap();
    claim(store, route, &thread, event, suffix).await
}

async fn assert_batch<S: RuntimeStore + ?Sized>(
    store: &S,
    activation: &ThreadActivationRecord,
    expected: &[&Event],
    protocol: Protocol,
) -> Result<(), TestError> {
    let signals = store.list_activation_signals(&activation.id).await?;
    let mut actual = signals
        .iter()
        .map(|signal| signal.event_id.as_str())
        .collect::<Vec<_>>();
    let mut expected_ids = expected
        .iter()
        .map(|event| event.id.as_str())
        .collect::<Vec<_>>();
    actual.sort_unstable();
    expected_ids.sort_unstable();
    assert_eq!(
        actual, expected_ids,
        "a batch must contain only matching protocol input"
    );
    for signal in signals {
        let owner = store.get_thread(&signal.thread_id).await?.unwrap();
        assert_eq!(owner.response_annotations, protocol);
        assert_eq!(owner.root_turn_id, activation.root_turn_id);
        assert_eq!(signal.thread_generation, activation.generation);
    }
    // Context builders consume the single-statement snapshots, not only the
    // direct Thread reader. Exercise the existing Off/On batch owners so
    // an omitted enabled protocol cannot silently deserialize as default Off.
    let owner = store
        .get_thread_by_root(&activation.root_turn_id)
        .await?
        .expect("the actual batch owner must remain persisted");
    assert_eq!(owner.response_annotations, protocol);
    let causality = store
        .read_context_activation_causality_snapshot(
            &activation.context_id,
            &activation.id,
            &activation.root_turn_id,
            &activation.trigger_event_id,
        )
        .await?;
    assert_eq!(
        causality.thread.as_ref(),
        Some(&owner),
        "causal snapshot must preserve the complete frozen {protocol:?} Thread row"
    );
    let scheduler = store
        .read_context_runtime_scheduler_snapshot(&activation.context_id, &[], 20, 32)
        .await?;
    let projected_owners = scheduler
        .threads
        .iter()
        .filter(|thread| thread.id == owner.id)
        .collect::<Vec<_>>();
    assert_eq!(
        projected_owners,
        vec![&owner],
        "scheduler snapshot must contain exactly the complete frozen {protocol:?} Thread row"
    );
    Ok(())
}

async fn frozen_protocol<S: RuntimeStore + ?Sized>(store: &S) -> Result<(), TestError> {
    let route = create_route(store, "frozen").await?;
    let request = thread(&route, "root", ThreadKind::Execution, Protocol::On);
    let original = store.ensure_thread(request.clone()).await?;
    assert_eq!(store.ensure_thread(request.clone()).await?, original);
    let mut conflict = request;
    conflict.response_annotations = Protocol::Off;
    assert!(store.ensure_thread(conflict).await.is_err());
    assert_eq!(store.get_thread(&original.id).await?.unwrap(), original);
    let request = thread(&route, "off-root", ThreadKind::Execution, Protocol::Off);
    let original_off = store.ensure_thread(request.clone()).await?;
    let mut conflict = request;
    conflict.response_annotations = Protocol::On;
    assert!(store.ensure_thread(conflict).await.is_err());
    assert_eq!(
        store.get_thread(&original_off.id).await?.unwrap(),
        original_off
    );
    // Legacy records may lack a Principal. A rejected frozen-protocol choice
    // must not perform the otherwise valid None -> Some authoring backfill.
    for protocol in [Protocol::Off, Protocol::On] {
        let mut request = thread(
            &route,
            &format!("unowned-{}", protocol.as_str()),
            ThreadKind::Execution,
            protocol,
        );
        request.initiating_principal_id = None;
        let unowned = store.ensure_thread(request.clone()).await?;
        let mut conflict = request.clone();
        conflict.response_annotations = match protocol {
            Protocol::Off => Protocol::On,
            Protocol::On => Protocol::Off,
        };
        conflict.initiating_principal_id = Some(route.principal.clone());
        assert!(store.ensure_thread(conflict).await.is_err());
        assert_eq!(
            store.get_thread(&unowned.id).await?.unwrap(),
            unowned,
            "a protocol rejection must leave the whole row, including Principal, unchanged"
        );
        request.initiating_principal_id = Some(route.principal.clone());
        let backfilled = store.ensure_thread(request).await?;
        assert_eq!(
            backfilled.initiating_principal_id.as_deref(),
            Some(route.principal.as_str())
        );
        assert_eq!(
            backfilled.response_annotations, protocol,
            "compatible legacy Principal backfill must remain supported"
        );
    }
    let mut off = original.clone();
    off.response_annotations = Protocol::Off;
    let serialized = serde_json::to_value(&off)?;
    assert!(serialized.get("response_annotations").is_none());
    assert_eq!(
        serde_json::from_value::<ThreadRecord>(serialized)?.response_annotations,
        Protocol::Off
    );
    Ok(())
}

async fn pending_batches<S: RuntimeStore + ?Sized>(store: &S) -> Result<(), TestError> {
    let route = create_route(store, "pending").await?;
    let off1 = ingress(store, &route, "off1", Protocol::Off).await?;
    let on_a = ingress(store, &route, "on_a", Protocol::On).await?;
    let on_b = ingress(store, &route, "on_b", Protocol::On).await?;
    let off2 = ingress(store, &route, "off2", Protocol::Off).await?;
    let on_c = ingress(store, &route, "on_c", Protocol::On).await?;
    let on_d = ingress(store, &route, "on_d", Protocol::On).await?;
    let off_signal = signal_for(store, &off1).await?;
    let on_signal = signal_for(store, &on_a).await?;
    assert_ne!(off_signal.thread_id, on_signal.thread_id);
    assert_eq!(
        off_signal.thread_id,
        signal_for(store, &off2).await?.thread_id
    );
    assert_eq!(
        on_signal.thread_id,
        signal_for(store, &on_b).await?.thread_id
    );
    assert_eq!(
        on_signal.thread_id,
        signal_for(store, &on_c).await?.thread_id
    );
    assert_eq!(
        signal_for(store, &on_c).await?.thread_id,
        signal_for(store, &on_d).await?.thread_id
    );
    let off = claim_ingress(store, &route, &off1, "off").await?;
    let enabled = claim_ingress(store, &route, &on_a, "on").await?;
    assert!(
        !off.fresh_activation && !enabled.fresh_activation,
        "a two-Signal batch is not fresh"
    );
    assert_batch(
        store,
        &off.activation.unwrap(),
        &[&off1, &off2],
        Protocol::Off,
    )
    .await?;
    assert_batch(
        store,
        &enabled.activation.unwrap(),
        &[&on_a, &on_b, &on_c, &on_d],
        Protocol::On,
    )
    .await?;
    Ok(())
}

async fn queued_batches<S: RuntimeStore + ?Sized>(
    store: &S,
    require_fresh_proof: bool,
) -> Result<(), TestError> {
    let route = create_route(store, "queued").await?;
    let off1 = ingress(store, &route, "off1", Protocol::Off).await?;
    let first = claim_ingress(store, &route, &off1, "off").await?;
    if require_fresh_proof {
        assert!(
            first.fresh_activation,
            "PostgreSQL fresh claim must exercise its specialized path"
        );
    }
    let off = first.activation.unwrap();
    assert_eq!(off.status, ThreadActivationStatus::Queued);
    let on_a = ingress(store, &route, "on_a", Protocol::On).await?;
    let enabled = claim_ingress(store, &route, &on_a, "on")
        .await?
        .activation
        .unwrap();
    assert_ne!(
        off.id, enabled.id,
        "different protocol must not merge into queued Activation"
    );
    let on_b = ingress(store, &route, "on_b", Protocol::On).await?;
    let off2 = ingress(store, &route, "off2", Protocol::Off).await?;
    assert_batch(store, &off, &[&off1, &off2], Protocol::Off).await?;
    assert_batch(store, &enabled, &[&on_a, &on_b], Protocol::On).await?;
    let on_c = ingress(store, &route, "on_c", Protocol::On).await?;
    let same_enabled = claim_ingress(store, &route, &on_c, "on")
        .await?
        .activation
        .unwrap();
    assert_eq!(same_enabled.id, enabled.id);
    let on_d = ingress(store, &route, "on_d", Protocol::On).await?;
    assert_batch(
        store,
        &same_enabled,
        &[&on_a, &on_b, &on_c, &on_d],
        Protocol::On,
    )
    .await?;
    let replay = claim_ingress(store, &route, &on_b, "unused-replay").await?;
    assert_eq!(replay.activation.unwrap().id, enabled.id);
    assert!(!replay.fresh_activation);
    assert_batch(store, &enabled, &[&on_a, &on_b, &on_c, &on_d], Protocol::On).await?;
    Ok(())
}

async fn claim_merge_batches<S: RuntimeStore + ?Sized>(store: &S) -> Result<(), TestError> {
    // Deliberately bypass claim_message's pending/queued routing: these are
    // independently materialized candidates merged by the Activation claim.
    let route = create_route(store, "claim").await?;
    let mut activations = Vec::new();
    let mut events = Vec::new();
    for (suffix, protocol) in [
        ("off", Protocol::Off),
        ("on_a", Protocol::On),
        ("on_b", Protocol::On),
        ("on_c", Protocol::On),
        ("on_d", Protocol::On),
    ] {
        let event = input(&route, suffix, protocol);
        store.append(event.clone()).await?;
        let event = persisted(store, &event).await?;
        let candidate = store
            .ensure_thread(thread(&route, suffix, ThreadKind::DialogueTurn, protocol))
            .await?;
        let claimed = claim(store, &route, &candidate, &event, suffix).await?;
        activations.push(claimed.activation.unwrap());
        events.push(event);
    }
    assert_ne!(activations[0].id, activations[1].id);
    assert_eq!(
        activations[1].id, activations[2].id,
        "same protocol candidate joins queued work"
    );
    assert_batch(store, &activations[0], &[&events[0]], Protocol::Off).await?;
    assert_batch(
        store,
        &activations[1],
        &[&events[1], &events[2], &events[3], &events[4]],
        Protocol::On,
    )
    .await?;
    assert_eq!(activations[1].id, activations[3].id);
    assert_eq!(activations[3].id, activations[4].id);
    assert_batch(
        store,
        &activations[3],
        &[&events[1], &events[2], &events[3], &events[4]],
        Protocol::On,
    )
    .await?;
    Ok(())
}

async fn retry_and_supersede<S: RuntimeStore + ?Sized>(
    store: &S,
    protocol: Protocol,
) -> Result<(), TestError> {
    let route = create_route(store, &format!("retry-{}", protocol.as_str())).await?;
    let root = input(&route, "root", protocol);
    store.append(root.clone()).await?;
    let root = persisted(store, &root).await?;
    let original = store
        .ensure_thread(thread(&route, "root", ThreadKind::DialogueTurn, protocol))
        .await?;
    let activation = claim(store, &route, &original, &root, "old")
        .await?
        .activation
        .unwrap();
    let running = match store
        .update_thread_activation(
            &activation.id,
            activation.revision,
            ThreadActivationStatus::Running,
            Some("isolated-test-host"),
            Some(chrono::Utc::now() + chrono::Duration::seconds(30)),
            None,
        )
        .await?
    {
        ThreadActivationMutation::Updated(record) => record,
        other => panic!("failed to start synthetic Activation: {other:?}"),
    };
    let failure = Event::new(
        format!("{}-failure", route.context),
        "Runtime-Orchestrator".into(),
        "assistant_message".into(),
        "chat/reply".into(),
        json!({"context_id":route.context,"session_id":route.session,
            "root_turn_id":root.id,"thread_id":original.id,"disposition":"deliver",
            "text":"synthetic provider failure","runtime_failure_kind":"network",
            "runtime_failure_stage":"llm_completion"})
        .as_object()
        .unwrap()
        .clone(),
    );
    assert!(matches!(
        store
            .commit_activation_outcome(&running.id, &failure)
            .await?,
        ActivationOutcomeCommit::Committed { .. }
    ));
    let failed = store.get_thread(&original.id).await?.unwrap();
    assert_eq!(failed.lifecycle, ThreadLifecycle::Failed);
    assert_eq!(failed.response_annotations, protocol);
    let retry = Event::new(
        format!("{}-retry-request", route.context), "Runtime-DialogueRetry".into(),
        TYPE_INFER_REQUEST.into(), "chat/dialogue_retry".into(),
        json!({"context_id":route.context,"session_id":route.session,"principal_id":route.principal,
            "root_turn_id":root.id,"thread_id":original.id,"runtime_force_evaluation":true})
            .as_object().unwrap().clone(),
    );
    let request = DialogueTurnRetryRequest {
        expected_thread_revision: failed.revision,
        expected_result_event_id: failure.id,
        recovery_target_id: None,
        event: retry.clone(),
    };
    let generation = original.generation + 1;
    assert_eq!(
        store.restart_dialogue_turn(request.clone()).await?,
        DialogueTurnRetryMutation::Accepted {
            thread_id: original.id.clone(),
            generation
        }
    );
    assert_eq!(
        store.restart_dialogue_turn(request).await?,
        DialogueTurnRetryMutation::Existing {
            thread_id: original.id.clone(),
            generation
        }
    );
    let resumed = store.get_thread(&original.id).await?.unwrap();
    assert_eq!(resumed.response_annotations, protocol);
    assert_eq!(resumed.generation, generation);
    assert_eq!(resumed.lifecycle, ThreadLifecycle::Open);
    assert!(resumed.result_event_id.is_none());
    assert_eq!(
        signal_for(store, &retry).await?.thread_generation,
        generation
    );

    let route = create_route(store, &format!("supersede-{}", protocol.as_str())).await?;
    let request = thread(&route, "root", ThreadKind::Execution, protocol);
    let original = store.ensure_thread(request).await?;
    let supersede = thread_supersede_event(
        &original,
        "corrected synthetic intent",
        "test",
        "isolated-test-host",
    );
    let next = match store
        .supersede_thread(&original.id, original.revision, &supersede)
        .await?
    {
        ThreadMutation::Updated(record) => record,
        other => panic!("supersede did not commit: {other:?}"),
    };
    assert_eq!(next.response_annotations, protocol);
    assert_eq!(next.generation, original.generation + 1);
    assert_eq!(next.id, original.id);
    assert_eq!(next.root_turn_id, original.root_turn_id);
    assert_eq!(
        signal_for(store, &supersede).await?.thread_generation,
        next.generation
    );
    assert!(matches!(
        store
            .supersede_thread(&original.id, original.revision, &supersede)
            .await?,
        ThreadMutation::Conflict { .. }
    ));
    Ok(())
}

struct NoPhysicalCalls;

#[async_trait::async_trait]
impl morphz::plan_execution::PlanCallPlanner for NoPhysicalCalls {
    async fn plan_call(
        &self,
        _: &morphz::memory::PlanExecutionRecord,
        _: &morphz::sexpr_eval::PlanEffect,
        _: &str,
    ) -> morphz::plan_execution::PlanExecutionResult<morphz::memory::NewExecutionJob> {
        panic!("annotation inheritance must not add a physical call")
    }
}

async fn infer_inherits_actual_owner(store: Arc<dyn RuntimeStore>) -> Result<(), TestError> {
    use morphz::plan_execution::{
        PlanArtifactBinding, PlanDriveReceipt, PlanExecutionCoordinator, PlanExecutionRoute,
    };
    for (mode, effort) in [Protocol::Off, Protocol::On].into_iter().flat_map(|mode| {
        [
            None,
            Some("max"),
            Some("low"),
            Some("none"),
            Some("provider_default"),
        ]
        .into_iter()
        .map(move |effort| (mode, effort))
    }) {
        let route = create_route(
            store.as_ref(),
            &format!("infer-{}-{}", mode.as_str(), effort.unwrap_or("absent")),
        )
        .await?;
        let mut event = input(&route, "root", mode);
        if let Some(effort) = effort {
            event
                .payload
                .insert("model_alias".into(), json!("task-model"));
            event
                .payload
                .insert("reasoning_effort".into(), json!(effort));
        }
        let root = ingress_event(store.as_ref(), &route, "root", event).await?;
        let parent = claim_ingress(store.as_ref(), &route, &root, "parent")
            .await?
            .activation
            .expect("one real parent Activation");
        let owner = store
            .get_thread_by_root(&parent.root_turn_id)
            .await?
            .unwrap();
        let registry = Arc::new(morphz::tool::Registry::new());
        let program = morphz::sexpr_eval::validate(
            "(eval (infer (returns Bool) \"synthetic branch decision\"))",
            &registry,
            &morphz::sexpr_eval::AllowList::new(Vec::<String>::new()),
        )?;
        let coordinator = PlanExecutionCoordinator::new(store.clone(), registry);
        let queued = coordinator
            .ensure(
                PlanExecutionRoute {
                    activation_id: parent.id.clone(),
                    thread_id: owner.id.clone(),
                    agent_id: route.agent,
                    context_id: route.context,
                    session_id: route.session,
                    initiating_principal_id: Some(route.principal),
                    tool_call_id: "owned-infer".into(),
                    objective_id: None,
                    objective_evaluation_id: None,
                },
                &program,
                PlanArtifactBinding::default(),
            )
            .await?;
        let PlanDriveReceipt::WaitingForEvaluation {
            plan,
            request_event,
            activation_id,
            ..
        } = coordinator
            .drive_once(
                &queued.id,
                queued.revision,
                "test-worker",
                "test-claim",
                chrono::Utc::now() + chrono::Duration::minutes(1),
                &NoPhysicalCalls,
            )
            .await?
        else {
            panic!("the real Plan must suspend behind its actual infer")
        };
        let child = store.get_thread_by_root(&request_event.id).await?.unwrap();
        assert_eq!(child.executor_kind, "plan_infer");
        assert_eq!(child.response_annotations, mode);
        assert_eq!(child.model_alias, owner.model_alias);
        assert_eq!(child.reasoning_effort.as_deref(), effort);
        assert_eq!(owner.reasoning_effort.as_deref(), effort);
        assert_eq!(
            child.supervision.parent_thread_id.as_deref(),
            Some(owner.id.as_str())
        );
        assert_eq!(child.initiating_principal_id, owner.initiating_principal_id);
        assert_eq!(child.session_id, owner.session_id);
        let persisted_request = persisted(store.as_ref(), &request_event).await?;
        assert_eq!(
            morphz::plan_execution::pending_infer_request_event(&plan, mode)?.payload,
            persisted_request.payload,
            "policy inheritance must not rewrite the immutable request or recovery protocol",
        );
        assert_eq!(
            persisted_request
                .payload
                .get("response_annotations")
                .map(|value| serde_json::from_value::<Protocol>(value.clone()))
                .transpose()?
                .unwrap_or_default(),
            mode
        );
        let replay = store
            .create_evaluation_and_suspend_plan(
                &plan.id,
                plan.revision,
                "released-claim",
                &plan.state_json,
                &plan.budget_json,
                &request_event,
                &activation_id,
            )
            .await?;
        assert!(replay.existing);
        let mut different_mode = request_event.clone();
        different_mode.payload.insert(
            "response_annotations".into(),
            json!(if mode.is_off() { "on" } else { "off" }),
        );
        assert!(store
            .create_evaluation_and_suspend_plan(
                &plan.id,
                plan.revision,
                "released-claim",
                &plan.state_json,
                &plan.budget_json,
                &different_mode,
                &activation_id,
            )
            .await
            .is_err());
        assert_eq!(store.get_thread(&child.id).await?.unwrap(), child);
        assert_eq!(
            persisted(store.as_ref(), &request_event).await?,
            persisted_request
        );
        assert_eq!(store.get_plan_execution(&plan.id).await?.unwrap(), plan);
    }
    Ok(())
}

async fn conformance<S: RuntimeStore + 'static>(
    store: Arc<S>,
    require_fresh_proof: bool,
) -> Result<(), TestError> {
    infer_inherits_actual_owner(store.clone()).await?;
    let store = store.as_ref();
    frozen_protocol(store).await?;
    pending_batches(store).await?;
    queued_batches(store, require_fresh_proof).await?;
    claim_merge_batches(store).await?;
    retry_and_supersede(store, Protocol::On).await?;
    retry_and_supersede(store, Protocol::Off).await?;
    annotation_source_windows(store).await?;
    native_companions_are_atomic_source_bound_and_idempotent(store).await?;
    Ok(())
}

async fn native_companions_are_atomic_source_bound_and_idempotent<S: RuntimeStore + ?Sized>(
    store: &S,
) -> Result<(), TestError> {
    use morphz::memory::EventAppend;
    use morphz::response_annotations::{
        normalize_delivery, AnnotationKind, ExecutionScope, NormalizationContext,
        PersistedAnnotations, Producer, BUNDLE_PAYLOAD_KEY,
    };
    use morphz::session_io::native::{self, Evidence};
    use morphz::session_io::response::{ReturnBinding, ANNOTATIONS_FORMAT};
    let route = create_route(store, "native-companions").await?;
    let owner = store
        .ensure_thread(thread(&route, "owner", ThreadKind::Execution, Protocol::On))
        .await?;
    let business_tool = morphz::llm::ToolDefinition {
        name: "synthetic_probe_read".into(),
        description: "Read the explicitly requested synthetic file.".into(),
        parameters: json!({
            "type":"object","additionalProperties":false,"required":["path"],
            "properties":{"path":{"type":"string"}}
        }),
    };
    let source = |id: &str, enabled: bool, working: bool| {
        let evaluation = format!("{id}-evaluation");
        let model = format!("{id}-model");
        let scope = ExecutionScope {
            execution_id: owner.id.clone(),
            generation: owner.generation,
        };
        let context = NormalizationContext {
            return_binding: Some(
                ReturnBinding::new(&owner.id, owner.generation, &evaluation, enabled)
                    .with_native_output(),
            ),
            protocol: if enabled { Protocol::On } else { Protocol::Off },
            scope: Some(scope.clone()),
            producer: Some(Producer {
                event_id: id.into(),
                attempt_id: model.clone(),
                sequence: None,
            }),
            ..Default::default()
        };
        let prepared = native::prepare(
            context.return_binding.as_ref().unwrap(),
            &[],
            std::slice::from_ref(&business_tool),
        )
        .unwrap();
        let raw = morphz::llm::Response {
            content: if working { "" } else { "synthetic body" }.into(),
            tool_calls: if working {
                vec![morphz::llm::ToolCallRepr {
                    id: "actual-read-call".into(),
                    r#type: "function".into(),
                    func_name: business_tool.name.clone(),
                    // Deliberately supplied even when off: Runtime must strip
                    // optional metadata without creating a fake IO receipt.
                    arguments: json!({"path":"synthetic-review.txt","_morphz":{
                        "execution":{"title":"合成执行","progress":"读取合成文件"},
                        "intent":"读取已请求的合成文件"
                    }})
                    .to_string(),
                }]
            } else {
                vec![]
            },
        };
        let evidence = Evidence {
            binding: prepared.binding,
            messages: vec![],
        };
        let normalized = normalize_delivery(&raw, &context, Some(&evidence)).unwrap();
        assert_eq!(
            serde_json::to_value(&normalized.raw_response).unwrap(),
            serde_json::to_value(&raw).unwrap()
        );
        assert_eq!(normalized.native_response.as_ref(), Some(&evidence));
        if working {
            assert_eq!(normalized.execution_response.tool_calls.len(), 1);
            let call = &normalized.execution_response.tool_calls[0];
            assert_eq!(call.id, "actual-read-call");
            assert_eq!(call.func_name, business_tool.name);
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&call.arguments).unwrap(),
                json!({"path":"synthetic-review.txt"})
            );
        } else {
            assert_eq!(normalized.execution_response.content, "synthetic body");
            assert!(normalized.execution_response.tool_calls.is_empty());
        }
        assert!(normalized
            .records
            .iter()
            .all(|record| record.kind != AnnotationKind::Result));
        assert_eq!(
            normalized
                .records
                .iter()
                .filter(|record| record.kind == AnnotationKind::Intent)
                .map(|record| record.call_id.as_deref())
                .collect::<Vec<_>>(),
            if enabled && working {
                vec![Some("actual-read-call")]
            } else {
                vec![]
            }
        );
        Event::new(id.into(),"Synthetic-Model".into(),morphz::event::TYPE_AGENT_CALL.into(),"chat/assistant_call".into(),
            json!({"context_id":route.context,"session_id":route.session,"principal_id":route.principal,"root_turn_id":owner.root_turn_id,
                "thread_id":owner.id,"thread_generation":owner.generation,"activation_id":evaluation,"attempt_id":evaluation,"model_attempt_id":model,
                "response_annotations":context.protocol,BUNDLE_PAYLOAD_KEY:PersistedAnnotations::from_normalized(scope,&normalized)})
                .as_object().unwrap().clone())
    };
    for enabled in [true, false] {
        let original = source(
            if enabled {
                "native-source-on"
            } else {
                "native-source-off"
            },
            enabled,
            true,
        );
        store.append(original.clone()).await?;
        store.append(original.clone()).await?;
        let all = store
            .query(QueryFilter {
                context_id: Some(route.context.clone()),
                ..Default::default()
            })
            .await?;
        let outputs = all
            .iter()
            .filter(|event| {
                event
                    .payload
                    .get("source_event_id")
                    .and_then(serde_json::Value::as_str)
                    == Some(original.id.as_str())
            })
            .collect::<Vec<_>>();
        assert_eq!(
            outputs.len(),
            usize::from(enabled),
            "source retry cannot duplicate native outputs"
        );
        let stored_sources = all
            .iter()
            .filter(|event| event.id == original.id)
            .collect::<Vec<_>>();
        assert_eq!(
            stored_sources.len(),
            1,
            "the immutable source itself is also idempotent"
        );
        assert_eq!(
            stored_sources[0].payload[BUNDLE_PAYLOAD_KEY],
            original.payload[BUNDLE_PAYLOAD_KEY]
        );
        if !enabled {
            continue;
        }
        let output = outputs[0];
        assert_eq!(output.topic, "session/io_output");
        assert!(
            !output.payload.contains_key("tool_call_id"),
            "a derived metadata publication is not a fabricated native call"
        );
        assert_eq!(
            output.payload["io_message"]["format"]["id"],
            ANNOTATIONS_FORMAT
        );
        let published: morphz::session_io::Message =
            serde_json::from_value(output.payload["io_message"].clone())?;
        assert_eq!(
            output.payload["io_message"],
            original.payload[BUNDLE_PAYLOAD_KEY]["annotation_messages"][0],
            "the publication preserves the exact typed metadata source"
        );
        assert_eq!(
            morphz::session_io::response::annotations_value(&published),
            Some(json!({
                "execution":{"title":"合成执行","progress":"读取合成文件"},
                "calls":[{"index":0,"intent":"读取已请求的合成文件"}]
            })),
            "decode the lossless persisted Data representation before checking native-call association"
        );
        for key in [
            "context_id",
            "session_id",
            "principal_id",
            "thread_id",
            "thread_generation",
            "activation_id",
            "attempt_id",
            "model_attempt_id",
            "root_turn_id",
        ] {
            assert_eq!(
                output.payload.get(key),
                original.payload.get(key),
                "source owns {key}"
            );
        }
        assert_eq!(output.payload["wake_policy"], "none");
        assert!(output.payload.contains_key("io_message"));
        assert!(!morphz::event::is_context_observation(output));
        assert!(!morphz::event::advances_cognitive_clock(output));
        assert_eq!(
            output.payload["target_delivery_id"],
            original.payload[BUNDLE_PAYLOAD_KEY]["return_binding"]["delivery_id"]
        );
    }
    let rollback = source("native-rollback-source", true, true);
    let mut collision = source("native-source-on", true, true);
    collision
        .payload
        .insert("text".into(), json!("different immutable payload"));
    assert!(store
        .append_batch(vec![
            EventAppend {
                event: rollback.clone()
            },
            EventAppend { event: collision }
        ])
        .await
        .is_err());
    let all = store
        .query(QueryFilter {
            context_id: Some(route.context.clone()),
            ..Default::default()
        })
        .await?;
    assert!(
        !all.iter().any(|event| event.id == rollback.id
            || event
                .payload
                .get("source_event_id")
                .and_then(serde_json::Value::as_str)
                == Some(rollback.id.as_str())),
        "source and companion must roll back together"
    );
    let mut mismatched = source("native-mismatched-source", true, true);
    mismatched
        .payload
        .insert("thread_id".into(), json!("another-thread"));
    store.append(mismatched.clone()).await?;
    let all = store
        .query(QueryFilter {
            context_id: Some(route.context.clone()),
            ..Default::default()
        })
        .await?;
    assert!(!all.iter().any(|event| event
        .payload
        .get("source_event_id")
        .and_then(serde_json::Value::as_str)
        == Some(mismatched.id.as_str())));
    for enabled in [true, false] {
        let terminal = source(
            if enabled {
                "native-final-on"
            } else {
                "native-final-off"
            },
            enabled,
            false,
        );
        store.append(terminal.clone()).await?;
        store.append(terminal.clone()).await?;
        let all = store
            .query(QueryFilter {
                context_id: Some(route.context.clone()),
                ..Default::default()
            })
            .await?;
        assert_eq!(
            all.iter().filter(|event| event.id == terminal.id).count(),
            1
        );
        assert!(
            !all.iter().any(|event| event
                .payload
                .get("source_event_id")
                .and_then(serde_json::Value::as_str)
                == Some(terminal.id.as_str())),
            "ordinary final text cannot manufacture annotation publications or extra receipts"
        );
    }
    Ok(())
}

async fn annotation_source_windows<S: RuntimeStore + ?Sized>(store: &S) -> Result<(), TestError> {
    let route = create_route(store, "source-window").await?;
    let ids = [
        format!("{}-long", route.context),
        format!("{}-short", route.context),
    ];
    for (owner, count) in [(&ids[0], 140), (&ids[1], 2)] {
        for number in 0..count {
            store.append(Event::new(format!("{owner}-source-{number}"), "Synthetic-Host".into(),
                morphz::event::TYPE_AGENT_CALL.into(), "chat/assistant_call".into(),
                json!({"context_id":route.context,"session_id":route.session,"thread_id":owner,"number":number})
                    .as_object().unwrap().clone())).await?;
        }
    }
    // Newer unrelated Context Events cannot starve an older selected Thread.
    store
        .append(Event::new(
            "window-foreign-context".into(),
            "Synthetic-Host".into(),
            morphz::event::TYPE_AGENT_CALL.into(),
            "chat/assistant_call".into(),
            json!({"context_id":"foreign-context","session_id":route.session,"thread_id":ids[0]})
                .as_object()
                .unwrap()
                .clone(),
        ))
        .await?;
    store
        .append(Event::new(
            "window-unrelated-topic".into(),
            "Synthetic-Host".into(),
            morphz::event::TYPE_AGENT_CALL.into(),
            "chat/reply".into(),
            json!({"context_id":route.context,"session_id":route.session,"thread_id":ids[0]})
                .as_object()
                .unwrap()
                .clone(),
        ))
        .await?;
    let selected = store
        .list_thread_event_sources(
            &route.context,
            &ids,
            morphz::event::TYPE_AGENT_CALL,
            &["chat/assistant_call", "runtime/thread_waiting"],
            129,
        )
        .await?;
    let long = selected
        .iter()
        .filter(|event| event.payload["thread_id"] == ids[0])
        .collect::<Vec<_>>();
    let short = selected
        .iter()
        .filter(|event| event.payload["thread_id"] == ids[1])
        .collect::<Vec<_>>();
    assert_eq!(long.len(), 129);
    assert_eq!(short.len(), 2);
    assert_eq!(long[0].payload["number"], 11);
    assert_eq!(long[128].payload["number"], 139);
    assert!(long
        .windows(2)
        .all(|pair| pair[0].sequence < pair[1].sequence));
    assert!(selected
        .iter()
        .all(|event| event.payload["context_id"] == route.context
            && event.topic == "chat/assistant_call"));
    assert!(store
        .list_thread_event_sources(
            &route.context,
            &[],
            morphz::event::TYPE_AGENT_CALL,
            &["chat/assistant_call", "runtime/thread_waiting"],
            129
        )
        .await?
        .is_empty());
    let first = ingress(store, &route, "revision-source-one", Protocol::On).await?;
    let second = ingress(store, &route, "revision-source-two", Protocol::On).await?;
    let first_signal = signal_for(store, &first).await?;
    let second_signal = signal_for(store, &second).await?;
    let owners = [
        first_signal.thread_id.clone(),
        second_signal.thread_id.clone(),
    ];
    let exact = store
        .list_annotation_revision_signals(&route.context, &owners, std::slice::from_ref(&first.id))
        .await?;
    assert_eq!(
        exact,
        vec![first_signal.clone()],
        "only the exact requested immutable revision witness may be read"
    );
    // Interrupt ingress may legitimately coalesce both inputs into the same
    // open Thread. Use a real distinct owner, not a guessed second Thread.
    let unrelated = store
        .ensure_thread(thread(
            &route,
            "unrelated-revision-owner",
            ThreadKind::Execution,
            Protocol::On,
        ))
        .await?;
    assert_ne!(unrelated.id, first_signal.thread_id);
    assert!(store
        .list_annotation_revision_signals(
            &route.context,
            &[unrelated.id],
            std::slice::from_ref(&first.id),
        )
        .await?
        .is_empty());
    assert!(store
        .list_annotation_revision_signals("foreign-context", &owners, &[first.id])
        .await?
        .is_empty());
    assert!(store
        .list_annotation_revision_signals(&route.context, &owners, &[])
        .await?
        .is_empty());
    for (number, owner) in ids.iter().enumerate() {
        store
            .append(Event::new(
                format!("physical-{number}"),
                "Runtime".into(),
                "runtime_control".into(),
                "runtime/model_attempt_state".into(),
                json!({"context_id":route.context,"session_id":route.session,"thread_id":owner})
                    .as_object()
                    .unwrap()
                    .clone(),
            ))
            .await?;
    }
    let models = store
        .list_thread_event_sources(
            &route.context,
            &ids,
            "runtime_control",
            &["runtime/model_attempt_state"],
            1,
        )
        .await?;
    assert_eq!(
        models.len(),
        2,
        "each selected Thread keeps its own bounded model source"
    );
    assert!(models
        .iter()
        .all(|source| source.topic == "runtime/model_attempt_state"));
    assert!(store
        .list_thread_event_sources(&route.context, &ids, "runtime_control", &[], 1)
        .await?
        .is_empty());
    Ok(())
}

#[tokio::test]
async fn sqlite_protocol_lifetime_and_batch_conformance() -> Result<(), TestError> {
    let directory = tempfile::TempDir::new()?;
    let path = directory.path().join("annotations.sqlite");
    let store = SqliteStore::new(path.to_str().unwrap()).await?;
    conformance(Arc::new(store), false).await
}

#[tokio::test]
async fn postgres_protocol_lifetime_and_batch_conformance() -> Result<(), TestError> {
    let Ok(url) = std::env::var("MORPHZ_ANNOTATIONS_TEST_POSTGRES_URL")
        .or_else(|_| std::env::var("MORPHZ_TEST_POSTGRES_URL"))
    else {
        assert!(
            std::env::var_os("CI").is_none(),
            "CI requires MORPHZ_TEST_POSTGRES_URL or MORPHZ_ANNOTATIONS_TEST_POSTGRES_URL for real PostgreSQL annotation conformance"
        );
        eprintln!("SKIPPED real PostgreSQL: set MORPHZ_TEST_POSTGRES_URL or MORPHZ_ANNOTATIONS_TEST_POSTGRES_URL to an explicitly approved test connection");
        return Ok(());
    };
    let schema = format!(
        "response_annotations_{}_{}",
        std::process::id(),
        chrono::Utc::now()
            .timestamp_nanos_opt()
            .unwrap()
            .unsigned_abs()
    );
    assert!(
        schema.starts_with("response_annotations_")
            && schema
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    );
    let admin = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await?;
    let mut scoped = reqwest::Url::parse(&url)?;
    let query = scoped
        .query_pairs()
        .filter(|(key, _)| key != "options")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    scoped.set_query(None);
    scoped
        .query_pairs_mut()
        .extend_pairs(query)
        .append_pair("options", &format!("-csearch_path={schema}"));
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await?;
    let expected_schema = schema.clone();
    // A panic is contained until cleanup, so a failed assertion cannot leave
    // this generated schema behind. No existing schema is a cleanup target.
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move {
                let store = Arc::new(PostgresStore::new(scoped.as_str(), 4).await?);
                let current_schema: String = sqlx::query_scalar("SELECT current_schema()")
                    .fetch_one(store.pool())
                    .await?;
                assert_eq!(current_schema, expected_schema);
                let search_path: String = sqlx::query_scalar("SHOW search_path")
                    .fetch_one(store.pool())
                    .await?;
                assert_eq!(
                    search_path, expected_schema,
                    "no public schema fallback is permitted"
                );
                conformance(store.clone(), true).await?;
                let result: Result<(), TestError> = Ok(());
                store.pool().close().await;
                result
            })
            .await
        })
        .await;
    let cleanup = sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await;
    admin.close().await;
    cleanup?;
    match result {
        Ok(result) => result,
        Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
        Err(error) => Err(error.into()),
    }
}
