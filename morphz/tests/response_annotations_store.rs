//! Durable response-annotation protocol conformance. No model/provider calls.
//!
//! PostgreSQL runs only when MORPHZ_ANNOTATIONS_TEST_POSTGRES_URL is explicitly
//! supplied, and only inside a freshly generated schema without a public fallback.
use morphz::event::{Event, TYPE_INFER_REQUEST, TYPE_USER_MESSAGE};
use morphz::memory::postgres::PostgresStore;
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{
    stable_thread_signal_id, thread_supersede_event, ActivationOutcomeCommit,
    DialogueTurnRetryMutation, DialogueTurnRetryRequest, EventStore, MessageClaim,
    MessageDispatchMode, NewAgent, NewCognitiveContext, NewPrincipal, NewSession, NewThread,
    NewThreadActivation, NewThreadSignal, QueryFilter, RuntimeStore, SessionMountKind,
    ThreadActivationMutation, ThreadActivationRecord, ThreadActivationStatus, ThreadKind,
    ThreadLifecycle, ThreadMutation, ThreadRecord, ThreadSignalBatchClaim, ThreadSignalRecord,
    ThreadStore, ThreadSupervision,
};
use morphz::response_annotations::Protocol;
use serde_json::json;
use sqlx::Row;

type TestError = Box<dyn std::error::Error + Send + Sync>;

struct Route {
    agent: String,
    context: String,
    session: String,
    principal: String,
}

async fn create_route<S: RuntimeStore>(store: &S, label: &str) -> Result<Route, TestError> {
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

async fn persisted<S: RuntimeStore>(store: &S, event: &Event) -> Result<Event, TestError> {
    let mut events = store
        .query(QueryFilter {
            event_id: Some(event.id.clone()),
            ..Default::default()
        })
        .await?;
    assert_eq!(events.len(), 1, "the exact immutable Event must exist");
    Ok(events.remove(0))
}

async fn ingress<S: RuntimeStore>(
    store: &S,
    route: &Route,
    suffix: &str,
    protocol: Protocol,
) -> Result<Event, TestError> {
    let event = input(route, suffix, protocol);
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

async fn signal_for<S: RuntimeStore>(
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

async fn claim<S: RuntimeStore>(
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

async fn claim_ingress<S: RuntimeStore>(
    store: &S,
    route: &Route,
    event: &Event,
    suffix: &str,
) -> Result<ThreadSignalBatchClaim, TestError> {
    let signal = signal_for(store, event).await?;
    let thread = store.get_thread(&signal.thread_id).await?.unwrap();
    claim(store, route, &thread, event, suffix).await
}

async fn assert_batch<S: RuntimeStore>(
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
    Ok(())
}

async fn frozen_protocol<S: RuntimeStore>(store: &S) -> Result<(), TestError> {
    let route = create_route(store, "frozen").await?;
    let request = thread(&route, "root", ThreadKind::Execution, Protocol::V1);
    let original = store.ensure_thread(request.clone()).await?;
    assert_eq!(store.ensure_thread(request.clone()).await?, original);
    let mut conflict = request;
    conflict.response_annotations = Protocol::Off;
    assert!(store.ensure_thread(conflict).await.is_err());
    assert_eq!(store.get_thread(&original.id).await?.unwrap(), original);
    let request = thread(&route, "off-root", ThreadKind::Execution, Protocol::Off);
    let original_off = store.ensure_thread(request.clone()).await?;
    let mut conflict = request;
    conflict.response_annotations = Protocol::V1;
    assert!(store.ensure_thread(conflict).await.is_err());
    assert_eq!(
        store.get_thread(&original_off.id).await?.unwrap(),
        original_off
    );
    // Legacy records may lack a Principal. A rejected frozen-protocol choice
    // must not perform the otherwise valid None -> Some authoring backfill.
    for protocol in [Protocol::Off, Protocol::V1, Protocol::V2] {
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
            Protocol::Off => Protocol::V1,
            Protocol::V1 | Protocol::V2 => Protocol::Off,
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

async fn pending_batches<S: RuntimeStore>(store: &S) -> Result<(), TestError> {
    let route = create_route(store, "pending").await?;
    let off1 = ingress(store, &route, "off1", Protocol::Off).await?;
    let v1a = ingress(store, &route, "v1a", Protocol::V1).await?;
    let v1b = ingress(store, &route, "v1b", Protocol::V1).await?;
    let off2 = ingress(store, &route, "off2", Protocol::Off).await?;
    let v2a = ingress(store, &route, "v2a", Protocol::V2).await?;
    let v2b = ingress(store, &route, "v2b", Protocol::V2).await?;
    let off_signal = signal_for(store, &off1).await?;
    let v1_signal = signal_for(store, &v1a).await?;
    assert_ne!(off_signal.thread_id, v1_signal.thread_id);
    assert_eq!(
        off_signal.thread_id,
        signal_for(store, &off2).await?.thread_id
    );
    assert_eq!(
        v1_signal.thread_id,
        signal_for(store, &v1b).await?.thread_id
    );
    assert_ne!(
        v1_signal.thread_id,
        signal_for(store, &v2a).await?.thread_id
    );
    assert_eq!(
        signal_for(store, &v2a).await?.thread_id,
        signal_for(store, &v2b).await?.thread_id
    );
    let off = claim_ingress(store, &route, &off1, "off").await?;
    let v1 = claim_ingress(store, &route, &v1a, "v1").await?;
    assert!(
        !off.fresh_activation && !v1.fresh_activation,
        "a two-Signal batch is not fresh"
    );
    assert_batch(
        store,
        &off.activation.unwrap(),
        &[&off1, &off2],
        Protocol::Off,
    )
    .await?;
    assert_batch(store, &v1.activation.unwrap(), &[&v1a, &v1b], Protocol::V1).await?;
    let v2 = claim_ingress(store, &route, &v2a, "v2").await?;
    assert!(!v2.fresh_activation);
    assert_batch(store, &v2.activation.unwrap(), &[&v2a, &v2b], Protocol::V2).await?;
    Ok(())
}

async fn queued_batches<S: RuntimeStore>(
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
    let v1a = ingress(store, &route, "v1a", Protocol::V1).await?;
    let v1 = claim_ingress(store, &route, &v1a, "v1")
        .await?
        .activation
        .unwrap();
    assert_ne!(
        off.id, v1.id,
        "different protocol must not merge into queued Activation"
    );
    let v1b = ingress(store, &route, "v1b", Protocol::V1).await?;
    let off2 = ingress(store, &route, "off2", Protocol::Off).await?;
    assert_batch(store, &off, &[&off1, &off2], Protocol::Off).await?;
    assert_batch(store, &v1, &[&v1a, &v1b], Protocol::V1).await?;
    let v2a = ingress(store, &route, "v2a", Protocol::V2).await?;
    let v2 = claim_ingress(store, &route, &v2a, "v2")
        .await?
        .activation
        .unwrap();
    assert_ne!(v2.id, v1.id);
    let v2b = ingress(store, &route, "v2b", Protocol::V2).await?;
    assert_batch(store, &v2, &[&v2a, &v2b], Protocol::V2).await?;
    assert_batch(store, &v1, &[&v1a, &v1b], Protocol::V1).await?;
    let replay = claim_ingress(store, &route, &v1b, "unused-replay").await?;
    assert_eq!(replay.activation.unwrap().id, v1.id);
    assert!(!replay.fresh_activation);
    assert_batch(store, &v1, &[&v1a, &v1b], Protocol::V1).await?;
    Ok(())
}

async fn claim_merge_batches<S: RuntimeStore>(store: &S) -> Result<(), TestError> {
    // Deliberately bypass claim_message's pending/queued routing: these are
    // independently materialized candidates merged by the Activation claim.
    let route = create_route(store, "claim").await?;
    let mut activations = Vec::new();
    let mut events = Vec::new();
    for (suffix, protocol) in [
        ("off", Protocol::Off),
        ("v1a", Protocol::V1),
        ("v1b", Protocol::V1),
        ("v2a", Protocol::V2),
        ("v2b", Protocol::V2),
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
        &[&events[1], &events[2]],
        Protocol::V1,
    )
    .await?;
    assert_ne!(activations[1].id, activations[3].id);
    assert_eq!(activations[3].id, activations[4].id);
    assert_batch(
        store,
        &activations[3],
        &[&events[3], &events[4]],
        Protocol::V2,
    )
    .await?;
    Ok(())
}

async fn retry_and_supersede<S: RuntimeStore>(
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

async fn conformance<S: RuntimeStore>(
    store: &S,
    require_fresh_proof: bool,
) -> Result<(), TestError> {
    frozen_protocol(store).await?;
    pending_batches(store).await?;
    queued_batches(store, require_fresh_proof).await?;
    claim_merge_batches(store).await?;
    retry_and_supersede(store, Protocol::V1).await?;
    retry_and_supersede(store, Protocol::V2).await?;
    annotation_source_windows(store).await?;
    Ok(())
}

async fn annotation_source_windows<S: RuntimeStore>(store: &S) -> Result<(), TestError> {
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
        .list_thread_annotation_sources(&route.context, &ids, 129)
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
        .list_thread_annotation_sources(&route.context, &[], 129)
        .await?
        .is_empty());
    let first = ingress(store, &route, "revision-source-one", Protocol::V1).await?;
    let second = ingress(store, &route, "revision-source-two", Protocol::V1).await?;
    let first_signal = signal_for(store, &first).await?;
    let second_signal = signal_for(store, &second).await?;
    let owners = [
        first_signal.thread_id.clone(),
        second_signal.thread_id.clone(),
    ];
    let exact = store
        .list_annotation_revision_signals(&route.context, &owners, &[first.id.clone()])
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
            Protocol::V1,
        ))
        .await?;
    assert_ne!(unrelated.id, first_signal.thread_id);
    assert!(store
        .list_annotation_revision_signals(&route.context, &[unrelated.id], &[first.id.clone()])
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
    Ok(())
}

#[tokio::test]
async fn sqlite_protocol_lifetime_and_batch_conformance() -> Result<(), TestError> {
    let directory = tempfile::TempDir::new()?;
    let path = directory.path().join("annotations.sqlite");
    let store = SqliteStore::new(path.to_str().unwrap()).await?;
    conformance(&store, false).await
}

#[tokio::test]
async fn sqlite_legacy_schema_defaults_off_and_preserves_serialized_records(
) -> Result<(), TestError> {
    let directory = tempfile::TempDir::new()?;
    let path = directory.path().join("legacy.sqlite");
    let path = path.to_str().unwrap();
    let store = SqliteStore::new(path).await?;
    let route = create_route(&store, "legacy").await?;
    let request = thread(&route, "root", ThreadKind::Execution, Protocol::Off);
    let original = store.ensure_thread(request).await?;
    let before_thread = serde_json::to_vec(&original)?;
    assert!(!String::from_utf8_lossy(&before_thread).contains("response_annotations"));
    // Legacy tool arguments are business data even if a reserved-looking key
    // exists. A migration must not rewrite a stored continuation/prefix.
    let event = Event::new(
        "annotations-legacy-call".into(),
        "Legacy-Agent".into(),
        "agent_call".into(),
        "chat/assistant_call".into(),
        json!({"context_id":route.context,"session_id":route.session,"thread_id":original.id,
            "content":"old plain text 中文","tool_calls":[{"id":"legacy-call", "name":"legacy",
                "args":{"_annotations":{"business":"must stay"},"value":"old"}}],
            "prompt_cache_transport_seed":"old-prefix-bytes\\n中文\\u4e2d"})
        .as_object()
        .unwrap()
        .clone(),
    );
    store.append(event.clone()).await?;
    let before_event = serde_json::to_vec(&persisted(&store, &event).await?)?;
    drop(store);
    let pool = sqlx::SqlitePool::connect(&format!("sqlite://{path}")).await?;
    sqlx::query("ALTER TABLE threads DROP COLUMN response_annotations")
        .execute(&pool)
        .await?;
    let columns = sqlx::query("PRAGMA table_info(threads)")
        .fetch_all(&pool)
        .await?;
    assert!(columns
        .iter()
        .all(|row| row.get::<String, _>("name") != "response_annotations"));
    pool.close().await;
    let reopened = SqliteStore::new(path).await?;
    let migrated = reopened.get_thread(&original.id).await?.unwrap();
    assert_eq!(migrated.response_annotations, Protocol::Off);
    assert_eq!(serde_json::to_vec(&migrated)?, before_thread);
    assert_eq!(
        serde_json::to_vec(&persisted(&reopened, &event).await?)?,
        before_event
    );
    Ok(())
}

#[tokio::test]
async fn postgres_protocol_lifetime_and_batch_conformance() -> Result<(), TestError> {
    let Ok(url) = std::env::var("MORPHZ_ANNOTATIONS_TEST_POSTGRES_URL") else {
        eprintln!("SKIPPED real PostgreSQL: set MORPHZ_ANNOTATIONS_TEST_POSTGRES_URL to an explicitly approved test connection");
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
                let store = PostgresStore::new(scoped.as_str(), 4).await?;
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
                postgres_old_check_upgrade(&store, scoped.as_str()).await?;
                conformance(&store, true).await?;
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

#[tokio::test]
async fn sqlite_v1_check_upgrade_preserves_complete_rows_and_dependencies() -> Result<(), TestError>
{
    let directory = tempfile::TempDir::new()?;
    let path = directory.path().join("old-v1-check.sqlite");
    let store = SqliteStore::new(path.to_str().unwrap()).await?;
    let route = create_route(&store, "v2-migration").await?;
    let off = store
        .ensure_thread(thread(&route, "off", ThreadKind::Execution, Protocol::Off))
        .await?;
    let mut request = thread(&route, "v1", ThreadKind::Execution, Protocol::V1);
    request.model_alias = Some("original-model".into());
    request.reasoning_effort = Some("high".into());
    let v1 = store.ensure_thread(request.clone()).await?;
    let before_off = serde_json::to_vec(&off)?;
    let before_v1 = serde_json::to_vec(&v1)?;
    let event = input(&route, "evidence", Protocol::V1);
    store.append(event.clone()).await?;
    let before_event = serde_json::to_vec(&persisted(&store, &event).await?)?;
    drop(store);
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&path)
                .foreign_keys(true),
        )
        .await?;
    // Materialize a genuine old CHECK with public DDL, not a schema mock or
    // writable_schema. Restore the two original immutable selected values.
    sqlx::query("ALTER TABLE threads DROP COLUMN response_annotations")
        .execute(&pool)
        .await?;
    sqlx::query("ALTER TABLE threads ADD COLUMN response_annotations TEXT NOT NULL DEFAULT 'off' CHECK(response_annotations IN ('off', 'v1'))").execute(&pool).await?;
    sqlx::query("UPDATE threads SET response_annotations='v1' WHERE id=?")
        .bind(&v1.id)
        .execute(&pool)
        .await?;
    sqlx::query(
        "DELETE FROM schema_migrations WHERE version='20261002_02_thread_response_annotations_v2'",
    )
    .execute(&pool)
    .await?;
    sqlx::query("ALTER TABLE threads ADD COLUMN synthetic_blob BLOB")
        .execute(&pool)
        .await?;
    sqlx::query("ALTER TABLE threads ADD COLUMN synthetic_derived TEXT GENERATED ALWAYS AS (id || '-derived') VIRTUAL").execute(&pool).await?;
    sqlx::query("UPDATE threads SET rowid=4301, synthetic_blob=X'00FFDEAD' WHERE id=?")
        .bind(&off.id)
        .execute(&pool)
        .await?;
    sqlx::query("UPDATE threads SET rowid=9017, synthetic_blob=X'BEEF00' WHERE id=?")
        .bind(&v1.id)
        .execute(&pool)
        .await?;
    sqlx::query("CREATE TABLE annotation_migration_dependents(thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, payload BLOB NOT NULL)").execute(&pool).await?;
    sqlx::query("INSERT INTO annotation_migration_dependents VALUES (?, X'00FEED')")
        .bind(&v1.id)
        .execute(&pool)
        .await?;
    sqlx::query("CREATE TABLE annotation_migration_audit(thread_id TEXT)")
        .execute(&pool)
        .await?;
    sqlx::query("CREATE TRIGGER annotation_migration_thread_audit AFTER UPDATE ON threads BEGIN INSERT INTO annotation_migration_audit(thread_id) VALUES(NEW.id); END").execute(&pool).await?;
    sqlx::query("CREATE INDEX annotation_migration_expression_idx ON threads(length(id), revision) WHERE response_annotations='v1'").execute(&pool).await?;
    sqlx::query("CREATE VIEW annotation_migration_view AS SELECT id, response_annotations, model_alias FROM threads").execute(&pool).await?;
    let schema_before = sqlx::query_as::<_, (String,String)>("SELECT name,sql FROM sqlite_schema WHERE tbl_name='threads' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name").fetch_all(&pool).await?;
    let rows_before = sqlx::query_as::<_, (i64, String, String, String)>(
        "SELECT rowid,id,hex(synthetic_blob),synthetic_derived FROM threads ORDER BY rowid",
    )
    .fetch_all(&pool)
    .await?;
    assert!(
        sqlx::query("UPDATE threads SET response_annotations='v2' WHERE id=?")
            .bind(&v1.id)
            .execute(&pool)
            .await
            .is_err(),
        "fixture must really reject v2 before migration"
    );
    pool.close().await;
    let reopened = SqliteStore::new(path.to_str().unwrap()).await?;
    assert_eq!(
        serde_json::to_vec(&reopened.get_thread(&off.id).await?.unwrap())?,
        before_off
    );
    assert_eq!(
        serde_json::to_vec(&reopened.get_thread(&v1.id).await?.unwrap())?,
        before_v1
    );
    assert_eq!(
        serde_json::to_vec(&persisted(&reopened, &event).await?)?,
        before_event
    );
    let v2 = reopened
        .ensure_thread(thread(&route, "v2", ThreadKind::Execution, Protocol::V2))
        .await?;
    let mut conflict = request;
    conflict.response_annotations = Protocol::V2;
    assert!(reopened.ensure_thread(conflict).await.is_err());
    assert_eq!(
        serde_json::to_vec(&reopened.get_thread(&v1.id).await?.unwrap())?,
        before_v1
    );
    drop(reopened);
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&path)
                .foreign_keys(true),
        )
        .await?;
    let rows_after = sqlx::query_as::<_, (i64,String,String,String)>("SELECT rowid,id,hex(synthetic_blob),synthetic_derived FROM threads WHERE id<>? ORDER BY rowid").bind(&v2.id).fetch_all(&pool).await?;
    assert_eq!(rows_after, rows_before);
    assert_eq!(sqlx::query_as::<_, (String,String)>("SELECT name,sql FROM sqlite_schema WHERE tbl_name='threads' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name").fetch_all(&pool).await?,schema_before);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM annotation_migration_dependents")
            .fetch_one(&pool)
            .await?,
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT hex(payload) FROM annotation_migration_dependents")
            .fetch_one(&pool)
            .await?,
        "00FEED"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM annotation_migration_audit")
            .fetch_one(&pool)
            .await?,
        0,
        "copy must never replay user triggers"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM annotation_migration_view")
            .fetch_one(&pool)
            .await?,
        3
    );
    assert!(sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&pool)
        .await?
        .is_empty());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA foreign_keys")
            .fetch_one(&pool)
            .await?,
        1
    );
    assert!(
        sqlx::query("INSERT INTO annotation_migration_dependents VALUES ('missing', X'01')")
            .execute(&pool)
            .await
            .is_err()
    );
    pool.close().await;
    let reopened = SqliteStore::new(path.to_str().unwrap()).await?;
    assert_eq!(
        reopened.get_thread(&v2.id).await?.unwrap(),
        v2,
        "v2 must survive a second startup"
    );
    Ok(())
}

async fn postgres_old_check_upgrade(store: &PostgresStore, url: &str) -> Result<(), TestError> {
    let route = create_route(store, "old-pg-check").await?;
    let mut v1_request = thread(&route, "v1", ThreadKind::Execution, Protocol::V1);
    v1_request.model_alias = Some("original-pg-model".into());
    v1_request.reasoning_effort = Some("high".into());
    let v1 = store.ensure_thread(v1_request.clone()).await?;
    let off = store
        .ensure_thread(thread(&route, "off", ThreadKind::Execution, Protocol::Off))
        .await?;
    let before_v1 = serde_json::to_vec(&v1)?;
    let before_off = serde_json::to_vec(&off)?;
    let event = input(&route, "evidence", Protocol::V1);
    store.append(event.clone()).await?;
    let before_event = serde_json::to_vec(&persisted(store, &event).await?)?;
    sqlx::query("CREATE TABLE annotation_migration_pg_dependents(thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, payload BYTEA NOT NULL)").execute(store.pool()).await?;
    sqlx::query(
        "INSERT INTO annotation_migration_pg_dependents VALUES ($1,decode('00FEED','hex'))",
    )
    .bind(&v1.id)
    .execute(store.pool())
    .await?;
    // Run before V2 conformance inserts any V2 rows. This is a real validated
    // legacy CHECK, not a NOT VALID constraint or a mocked schema.
    sqlx::query("ALTER TABLE threads DROP CONSTRAINT threads_response_annotations_protocol_v2")
        .execute(store.pool())
        .await?;
    sqlx::query("ALTER TABLE threads ADD CONSTRAINT threads_response_annotations_check CHECK(response_annotations IN ('off','v1'))").execute(store.pool()).await?;
    sqlx::query(
        "DELETE FROM schema_migrations WHERE version='20261002_02_thread_response_annotations_v2'",
    )
    .execute(store.pool())
    .await?;
    assert!(store
        .ensure_thread(thread(
            &route,
            "rejected-v2",
            ThreadKind::Execution,
            Protocol::V2
        ))
        .await
        .is_err());
    let indexes_before = sqlx::query_as::<_,(String,String)>("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=current_schema() AND tablename='threads' ORDER BY indexname").fetch_all(store.pool()).await?;
    let rows_before: serde_json::Value =
        sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(threads) ORDER BY id) FROM threads")
            .fetch_one(store.pool())
            .await?;
    let constraints_before = sqlx::query_as::<_,(String,String)>("SELECT conname,pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='threads'::regclass AND conname<>'threads_response_annotations_check' ORDER BY conname").fetch_all(store.pool()).await?;
    let reopened = PostgresStore::new(url, 4).await?;
    assert_eq!(
        sqlx::query_scalar::<_, serde_json::Value>(
            "SELECT jsonb_agg(to_jsonb(threads) ORDER BY id) FROM threads"
        )
        .fetch_one(reopened.pool())
        .await?,
        rows_before,
        "migration must preserve every column of every existing Thread"
    );
    assert_eq!(
        serde_json::to_vec(&reopened.get_thread(&v1.id).await?.unwrap())?,
        before_v1
    );
    assert_eq!(
        serde_json::to_vec(&reopened.get_thread(&off.id).await?.unwrap())?,
        before_off
    );
    assert_eq!(
        serde_json::to_vec(&persisted(&reopened, &event).await?)?,
        before_event
    );
    assert_eq!(sqlx::query_as::<_,(String,String)>("SELECT conname,pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='threads'::regclass AND conname<>'threads_response_annotations_protocol_v2' ORDER BY conname").fetch_all(reopened.pool()).await?,constraints_before);
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT encode(payload,'hex') FROM annotation_migration_pg_dependents"
        )
        .fetch_one(reopened.pool())
        .await?,
        "00feed"
    );
    assert!(
        sqlx::query(
            "INSERT INTO annotation_migration_pg_dependents VALUES ('missing',decode('01','hex'))"
        )
        .execute(reopened.pool())
        .await
        .is_err(),
        "dependent foreign keys stay enforced"
    );
    let mut conflict = v1_request;
    conflict.response_annotations = Protocol::V2;
    assert!(reopened.ensure_thread(conflict).await.is_err());
    let v2 = reopened
        .ensure_thread(thread(&route, "v2", ThreadKind::Execution, Protocol::V2))
        .await?;
    assert_eq!(sqlx::query_as::<_,(String,String)>("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=current_schema() AND tablename='threads' ORDER BY indexname").fetch_all(reopened.pool()).await?,indexes_before);
    reopened.pool().close().await;
    let reopened = PostgresStore::new(url, 4).await?;
    assert_eq!(reopened.get_thread(&v2.id).await?.unwrap(), v2);
    reopened.pool().close().await;
    Ok(())
}
