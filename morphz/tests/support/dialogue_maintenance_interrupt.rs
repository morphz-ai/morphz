use super::*;

async fn transition<S: ActivationStore>(
    store: &S,
    activation: &morphz::memory::ThreadActivationRecord,
    status: ThreadActivationStatus,
) -> morphz::memory::ThreadActivationRecord {
    match store
        .update_thread_activation(
            &activation.id,
            activation.revision,
            status,
            Some("maintenance-interrupt-worker"),
            Some(chrono::Utc::now() + chrono::Duration::seconds(30)),
            None,
        )
        .await
        .unwrap()
    {
        ThreadActivationMutation::Updated(record) => record,
        other => panic!("unexpected maintenance Activation transition: {other:?}"),
    }
}

async fn claim<S: morphz::memory::RuntimeStore>(
    store: &S,
    thread: &morphz::memory::ThreadRecord,
    event: &Event,
    parent: Option<String>,
) -> Option<morphz::memory::ThreadActivationRecord> {
    let sequence = store
        .query(QueryFilter {
            event_id: Some(event.id.clone()),
            ..Default::default()
        })
        .await
        .unwrap()
        .pop()
        .unwrap()
        .sequence
        .unwrap();
    store
        .claim_thread_signal_batch(
            NewThreadSignal {
                id: stable_thread_signal_id(&event.id),
                thread_id: thread.id.clone(),
                thread_generation: thread.generation,
                event_id: event.id.clone(),
                principal_id: None,
                sequence,
                kind: event.topic.clone(),
                parent_activation_id: parent.clone(),
            },
            NewThreadActivation {
                id: format!("activation-{}", event.id),
                agent_id: thread.agent_id.clone(),
                context_id: thread.context_id.clone(),
                session_id: thread.session_id.clone(),
                initiating_principal_id: None,
                trigger_event_id: event.id.clone(),
                trigger_sequence: sequence,
                trigger_kind: event.topic.clone(),
                parent_activation_id: parent,
                root_turn_id: thread.root_turn_id.clone(),
            },
            32,
        )
        .await
        .unwrap()
}

pub async fn assert_maintenance_handoff_keeps_lane<S: morphz::memory::RuntimeStore>(store: &S) {
    for released in [false, true] {
        let prefix = format!("maintenance-handoff-lane-{released}");
        let session = store
            .create_session(NewSession {
                id: prefix.clone(),
                agent_id: "conformance-agent".into(),
                context_id: "conformance-context".into(),
                parent_session_id: Some("conformance-session".into()),
                title: prefix.clone(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        // Trusted adapters may publish ordinary inputs without an explicit
        // after_thread_id. Durable lane ownership must still serialize them.
        let mut turns = Vec::new();
        for suffix in ["first", "second"] {
            let event = Event::new(
                format!("{prefix}-{suffix}"),
                "Store-Conformance".into(),
                morphz::event::TYPE_USER_MESSAGE.into(),
                "chat/user_message".into(),
                json!({"context_id": session.context_id, "session_id": session.id, "text": suffix})
                    .as_object()
                    .unwrap()
                    .clone(),
            );
            store.append(event.clone()).await.unwrap();
            let thread = store
                .ensure_thread(NewThread {
                    response_annotations: morphz::response_annotations::Protocol::Off,
                    model_alias: None,
                    reasoning_effort: None,
                    id: stable_thread_id(&event.id),
                    agent_id: session.agent_id.clone(),
                    context_id: session.context_id.clone(),
                    session_id: session.id.clone(),
                    initiating_principal_id: None,
                    root_turn_id: event.id.clone(),
                    kind: ThreadKind::DialogueTurn,
                    executor_kind: "self".into(),
                    executor_id: None,
                    target_id: None,
                    supervision: ThreadSupervision::runtime("maintenance-test"),
                })
                .await
                .unwrap();
            let activation = claim(store, &thread, &event, None).await.unwrap();
            let activation = if suffix == "first" {
                transition(store, &activation, ThreadActivationStatus::Running).await
            } else {
                activation
            };
            turns.push((thread, activation));
        }
        let (first, mut owner) = turns.remove(0);
        let (_, second) = turns.remove(0);
        if released {
            assert!(store
                .release_dialogue_turn_activation(&owner.id, chrono::Utc::now())
                .await
                .unwrap());
            owner = store
                .get_thread_activation(&owner.id)
                .await
                .unwrap()
                .unwrap();
        }
        let receipt = Event::new(
            format!("{prefix}-receipt"),
            "context_tx".into(),
            morphz::event::TYPE_TOOL_OUTPUT.into(),
            "chat/tool_output".into(),
            json!({"context_id": session.context_id, "session_id": session.id,
                "root_turn_id": first.root_turn_id, "parent_activation_id": owner.id,
                "tool": "context_tx", "result": "committed context maintenance"})
            .as_object()
            .unwrap()
            .clone(),
        );
        store
            .append_to_thread(receipt.clone(), &first.id)
            .await
            .unwrap();
        let owner = transition(store, &owner, ThreadActivationStatus::Succeeded).await;
        // Pause at the exact durable gap: the owner's transaction committed,
        // the receipt is pending, and no successor Activation exists yet.
        let runnable = store
            .dialogue_turn_activation_runnable(&second.id)
            .await
            .unwrap();
        let queued = store
            .list_queued_thread_activations_for_admission(64, 8, 60_000)
            .await
            .unwrap();
        let visible = queued
            .iter()
            .any(|(activation, _)| activation.id == second.id);
        let admission = store
            .update_thread_activation(
                &second.id,
                second.revision,
                ThreadActivationStatus::Running,
                Some("handoff-competing-worker"),
                Some(chrono::Utc::now() + chrono::Duration::seconds(30)),
                None,
            )
            .await
            .unwrap();
        assert_eq!((runnable, visible, matches!(admission, ThreadActivationMutation::Updated(_))),
            (released, released, released),
            "runnable read, queue refill and atomic running transition must all reserve an unreleased maintenance hand-off");
        if released {
            assert!(
                matches!(admission, ThreadActivationMutation::Updated(_)),
                "a prior physical-work release must still allow the next user turn"
            );
            continue;
        }
        assert!(
            matches!(admission, ThreadActivationMutation::Conflict { .. }),
            "the running transition must enforce the fence even without a preflight read"
        );
        let continuation = claim(store, &first, &receipt, Some(owner.id))
            .await
            .unwrap();
        assert!(store
            .dialogue_turn_activation_runnable(&continuation.id)
            .await
            .unwrap());
        let continuation = transition(store, &continuation, ThreadActivationStatus::Running).await;
        transition(store, &continuation, ThreadActivationStatus::Succeeded).await;
        let first = store.get_thread(&first.id).await.unwrap().unwrap();
        assert!(matches!(
            store
                .update_thread(
                    &first.id,
                    first.revision,
                    None,
                    Some(ThreadLifecycle::Completed),
                    Some("first reply"),
                    Some("handoff-reply"),
                    Some(DeliveryStatus::Delivered),
                    Some("handoff-reply")
                )
                .await
                .unwrap(),
            ThreadMutation::Updated(_)
        ));
        assert!(store
            .dialogue_turn_activation_runnable(&second.id)
            .await
            .unwrap());
        transition(store, &second, ThreadActivationStatus::Running).await;
    }
}

pub async fn assert_maintenance_interrupt<S: morphz::memory::RuntimeStore>(store: &S) {
    // The same immutable user Signal is acknowledged by the original model
    // pass; a context_tx receipt, not that Signal, drives the next pass.
    for (stage, released, referenced) in [
        ("running", false),
        ("queued", false),
        ("handoff", false),
        ("running", true),
        ("queued", true),
        ("handoff", true),
    ]
    .into_iter()
    .flat_map(|(stage, released)| [false, true].map(|referenced| (stage, released, referenced)))
    {
        // PostgreSQL has a one-statement ordinary ingress and a transactional
        // fallback for Session references. Both must enforce the same fence.
        let prefix = format!("maintenance-interrupt-{stage}-{released}-{referenced}");
        let session = store
            .create_session(NewSession {
                id: prefix.clone(),
                agent_id: "conformance-agent".into(),
                context_id: "conformance-context".into(),
                parent_session_id: Some("conformance-session".into()),
                title: prefix.clone(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        store
            .bind_session_principal(&session.id, "o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat")
            .await
            .unwrap();
        let message = |suffix: &str| {
            Event::new(
                format!("{prefix}-{suffix}"),
                "Store-Conformance".into(),
                morphz::event::TYPE_USER_MESSAGE.into(),
                "chat/user_message".into(),
                json!({
                    "context_id": session.context_id,
                    "session_id": session.id,
                    "principal_id": "o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat",
                    "text": suffix,
                    "references": if referenced { json!([{
                        "kind": "session",
                        "agent_id": session.agent_id,
                        "context_id": session.context_id,
                        "session_id": session.id
                    }]) } else { json!([]) }
                })
                .as_object()
                .unwrap()
                .clone(),
            )
        };
        let first = message("first");
        store
            .claim_message(
                &session.id,
                &first.id,
                &first,
                MessageDispatchMode::Interrupt,
            )
            .await
            .unwrap();
        let thread = store.get_thread_by_root(&first.id).await.unwrap().unwrap();
        let original = claim(store, &thread, &first, None).await.unwrap();
        let mut original = transition(store, &original, ThreadActivationStatus::Running).await;
        if released {
            assert!(store
                .release_dialogue_turn_activation(&original.id, chrono::Utc::now())
                .await
                .unwrap());
            original = store
                .get_thread_activation(&original.id)
                .await
                .unwrap()
                .unwrap();
        }
        let receipt = Event::new(
            format!("{prefix}-receipt"),
            "context_tx".into(),
            morphz::event::TYPE_TOOL_OUTPUT.into(),
            "chat/tool_output".into(),
            json!({
                "context_id": session.context_id,
                "session_id": session.id,
                "root_turn_id": first.id,
                "parent_activation_id": original.id,
                "tool": "context_tx",
                "result": "committed context maintenance"
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        store
            .append_to_thread(receipt.clone(), &thread.id)
            .await
            .unwrap();
        let original = transition(store, &original, ThreadActivationStatus::Succeeded).await;
        let current = if stage == "handoff" {
            original.clone()
        } else {
            let continuation = claim(store, &thread, &receipt, Some(original.id.clone()))
                .await
                .unwrap();
            if stage == "running" {
                transition(store, &continuation, ThreadActivationStatus::Running).await
            } else {
                continuation
            }
        };

        let second = message("second");
        let result = store
            .claim_message(
                &session.id,
                &second.id,
                &second,
                MessageDispatchMode::Interrupt,
            )
            .await
            .unwrap();
        if released {
            assert!(
                matches!(
                    result,
                    MessageClaim::Accepted {
                        interrupted: None,
                        ..
                    }
                ),
                "physical Execution in an earlier pass protects the whole generation: {result:?}"
            );
            assert_eq!(
                store
                    .get_thread(&thread.id)
                    .await
                    .unwrap()
                    .unwrap()
                    .lifecycle,
                ThreadLifecycle::Open
            );
            assert_eq!(
                store
                    .get_thread_activation(&current.id)
                    .await
                    .unwrap()
                    .unwrap()
                    .status,
                current.status
            );
            continue;
        }
        let interrupted = match result {
            MessageClaim::Accepted {
                interrupted: Some(interrupted),
                ..
            } => interrupted,
            other => panic!("{stage} maintenance must be interruptible: {other:?}"),
        };
        assert_eq!(interrupted.activation_id, current.id);
        assert_eq!(interrupted.thread_id, thread.id);
        assert_eq!(
            store
                .get_thread(&thread.id)
                .await
                .unwrap()
                .unwrap()
                .lifecycle,
            ThreadLifecycle::Cancelled
        );
        assert_eq!(
            store
                .get_thread_activation(&original.id)
                .await
                .unwrap()
                .unwrap()
                .status,
            ThreadActivationStatus::Succeeded,
            "committed maintenance is historical fact, not undone work"
        );
        if stage != "handoff" {
            assert_eq!(
                store
                    .get_thread_activation(&current.id)
                    .await
                    .unwrap()
                    .unwrap()
                    .status,
                ThreadActivationStatus::Cancelled
            );
            assert!(
                matches!(
                    store
                        .update_thread_activation(
                            &current.id,
                            current.revision,
                            ThreadActivationStatus::Running,
                            None,
                            None,
                            None
                        )
                        .await
                        .unwrap(),
                    ThreadActivationMutation::Conflict { .. }
                ),
                "stale worker must remain fenced"
            );
        } else {
            assert!(
                claim(store, &thread, &receipt, Some(original.id.clone()))
                    .await
                    .is_none(),
                "a late dispatcher cannot materialize the cancelled continuation"
            );
        }
        let stale_reply = Event::new(
            format!("{prefix}-stale-reply"),
            "Store-Conformance".into(),
            "agent_reply".into(),
            "chat/reply".into(),
            json!({
                "context_id": session.context_id,
                "session_id": session.id,
                "thread_id": thread.id,
                "root_turn_id": thread.root_turn_id,
                "text": "obsolete reply"
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        assert_eq!(
            store
                .commit_activation_outcome(&current.id, &stale_reply)
                .await
                .unwrap(),
            ActivationOutcomeCommit::StaleActivation
        );
        assert!(
            store
                .query(QueryFilter {
                    event_id: Some(stale_reply.id),
                    ..Default::default()
                })
                .await
                .unwrap()
                .is_empty(),
            "a late model response must not publish after replacement"
        );
        let replacement = store.get_thread_by_root(&second.id).await.unwrap().unwrap();
        let replacement_activation = claim(store, &replacement, &second, None).await.unwrap();
        let inputs = store
            .list_activation_signals(&replacement_activation.id)
            .await
            .unwrap();
        assert_eq!(
            inputs
                .iter()
                .map(|input| input.event_id.as_str())
                .collect::<Vec<_>>(),
            vec![first.id.as_str(), second.id.as_str()],
            "replay exactly the ordered user inputs, never the maintenance tool receipt"
        );
        assert!(store
            .dialogue_turn_activation_runnable(&replacement_activation.id)
            .await
            .unwrap());
        assert_eq!(
            store
                .query(QueryFilter {
                    event_id: Some(receipt.id),
                    ..Default::default()
                })
                .await
                .unwrap()
                .len(),
            1,
            "the committed receipt must remain intact"
        );
        assert!(
            matches!(
                store
                    .claim_message(
                        &session.id,
                        &second.id,
                        &second,
                        MessageDispatchMode::Interrupt
                    )
                    .await
                    .unwrap(),
                MessageClaim::Existing { .. }
            ),
            "retrying ingress must not replay the inputs twice"
        );
    }
}
