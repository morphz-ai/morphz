//! Typed human input routing. A mention is a reference; this is an explicit
//! delivery instruction, validated again inside the message transaction.
use crate::event::Event;
use crate::memory::{
    objective_primary_execution_root_id, stable_thread_id, NewThread, ObjectiveRecord,
    ObjectiveStatus, ObjectiveWaitCondition, ThreadControlState, ThreadKind, ThreadRecord,
    ThreadSupervision,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

pub(crate) fn conflict(message: &str) -> Box<dyn std::error::Error + Send + Sync> {
    Box::new(crate::runtime::MessageIngressError::new(
        crate::runtime::MessageIngressErrorKind::Conflict,
        message,
    ))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InputDestination {
    Thread {
        thread_id: String,
        generation: u64,
    },
    Objective {
        objective_id: String,
        generation: u64,
        /// A reply consumes only this exact question. Omit for supplemental
        /// steering, which must preserve unrelated waits.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reply_to_request_id: Option<String>,
    },
}

pub fn destination(event: &Event) -> Result<Option<InputDestination>, serde_json::Error> {
    event
        .payload
        .get("input_destination")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
}

pub fn input_request_id(objective: &ObjectiveRecord) -> Option<String> {
    match objective.wait_condition.as_ref()? {
        ObjectiveWaitCondition::UserInput { request_id, .. } => {
            Some(request_id.clone().unwrap_or_else(|| {
                // Old databases need no rewrite. The exact observed wait revision
                // fences their first reply; new waits carry a durable question ID.
                format!(
                    "legacy:{}:{}:{}",
                    objective.id, objective.generation, objective.revision
                )
            }))
        }
        _ => None,
    }
}

pub fn objective_thread(objective: &ObjectiveRecord) -> NewThread {
    let root = objective_primary_execution_root_id(&objective.id, objective.generation);
    NewThread {
        id: stable_thread_id(&root),
        agent_id: objective.agent_id.clone(),
        context_id: objective.context_id.clone(),
        session_id: objective.coordinator_session_id.clone(),
        initiating_principal_id: objective.initiating_principal_id.clone(),
        root_turn_id: root,
        kind: ThreadKind::Execution,
        executor_kind: "self".into(),
        executor_id: None,
        target_id: None,
        supervision: ThreadSupervision::objective_primary_execution(
            objective.id.clone(),
            objective.generation,
        ),
    }
}

/// Called with the target rows locked by the same transaction that appends
/// the Event and Signal. It never guesses a target from message text.
pub fn route(
    event: &mut Event,
    destination: &InputDestination,
    thread: &ThreadRecord,
    objective: Option<&ObjectiveRecord>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let session = event.payload.get("session_id").and_then(|v| v.as_str());
    let context = event.payload.get("context_id").and_then(|v| v.as_str());
    let principal = event.payload.get("principal_id").and_then(|v| v.as_str());
    if session != Some(thread.session_id.as_str())
        || context != Some(thread.context_id.as_str())
        || thread
            .initiating_principal_id
            .as_deref()
            .is_some_and(|owner| Some(owner) != principal)
    {
        return Err(Box::new(crate::runtime::MessageIngressError::new(
            crate::runtime::MessageIngressErrorKind::Forbidden,
            "Input destination is outside the current Principal/Session route",
        )));
    }
    if thread.lifecycle.is_terminal()
        || thread.control_state != ThreadControlState::Active
        || thread.kind == ThreadKind::Delivery
    {
        return Err(conflict("Input destination is not an active, open work Thread; explicitly resume or start follow-up work"));
    }
    match destination {
        InputDestination::Thread {
            thread_id,
            generation,
        } => {
            if thread.id != *thread_id || thread.generation != *generation {
                return Err(conflict(
                    "Input destination Thread generation changed; refresh before sending",
                ));
            }
            if thread.executor_kind != "self" {
                return Err("This executor does not accept human steering; address its supervising Objective instead".into());
            }
            if thread.supervision.supervisor_kind == crate::memory::ThreadSupervisorKind::Objective
                && thread.supervision.origin_evaluation_id.is_none()
            {
                return Err("Address the primary Objective by objective_id so its Evaluation ownership is preserved".into());
            }
        }
        InputDestination::Objective {
            objective_id,
            generation,
            reply_to_request_id,
        } => {
            let objective = objective.ok_or("Input destination Objective does not exist")?;
            if objective.id != *objective_id
                || objective.generation != *generation
                || objective.status != ObjectiveStatus::Active
                || objective.context_id != thread.context_id
                || objective.coordinator_session_id != thread.session_id
                || thread.root_turn_id
                    != objective_primary_execution_root_id(objective_id, *generation)
            {
                return Err(conflict(
                    "Input destination Objective is no longer active in this route/generation",
                ));
            }
            if let Some(request_id) = reply_to_request_id {
                if input_request_id(objective).as_deref() != Some(request_id.as_str()) {
                    return Err(conflict(
                        "This question is no longer pending; refresh before replying",
                    ));
                }
                event
                    .payload
                    .insert("reply_to_request_id".into(), json!(request_id));
            }
            event
                .payload
                .insert("objective_interrupt".into(), json!(true));
            event
                .payload
                .insert("objective_id".into(), json!(objective.id));
            event
                .payload
                .insert("objective_generation".into(), json!(objective.generation));
        }
    }
    event
        .payload
        .insert("root_turn_id".into(), json!(thread.root_turn_id));
    event.payload.insert("thread_id".into(), json!(thread.id));
    event
        .payload
        .insert("thread_generation".into(), json!(thread.generation));
    event
        .payload
        .insert("input_delivery".into(), json!("queued"));
    event.topic = "chat/steering".into();
    Ok(())
}

/// Natural-language routing uses the same durable ingress as the UI. The
/// model selects a destination but cannot manufacture a new human instruction.
pub struct SteerTool {
    pub context: std::sync::Arc<crate::orchestrator::context::ContextEngine>,
    pub bus: std::sync::Arc<crate::event::InMemoryEventBus>,
}

#[async_trait::async_trait]
impl crate::tool::Tool for SteerTool {
    fn name(&self) -> &str {
        "steer"
    }
    fn definition(&self) -> crate::llm::ToolDefinition {
        crate::llm::ToolDefinition {
            name: "steer".into(),
            description: "Forward the current user's original message to existing work when it clearly supplements/corrects that Thread or answers an Objective question. Do not execute the same work here. Use exact IDs and generations from current state; for a question copy its request_id into reply_to_request_id. When ambiguous, ask the user. This queues input without changing goal criteria, permissions, or cancelling physical jobs; objective_amend changes goal criteria. After success acknowledge delivery briefly or no_reply; the destination owns the substantive response.".into(),
            parameters: json!({"type":"object", "properties": {
                "input_destination": {"oneOf": [
                    {"type":"object","properties":{"kind":{"const":"thread"},"thread_id":{"type":"string"},"generation":{"type":"integer","minimum":1}},"required":["kind","thread_id","generation"],"additionalProperties":false},
                    {"type":"object","properties":{"kind":{"const":"objective"},"objective_id":{"type":"string"},"generation":{"type":"integer","minimum":1},"reply_to_request_id":{"type":"string"}},"required":["kind","objective_id","generation"],"additionalProperties":false}
                ]}
            },"required":["input_destination"],"additionalProperties":false}),
        }
    }
    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        use crate::memory::{MessageClaim, MessageDispatchMode};
        use crate::tool::{CURRENT_CAUSAL_ROUTE, CURRENT_PRINCIPAL_ID};
        use sha2::{Digest, Sha256};
        let args: serde_json::Value = serde_json::from_str(arguments)?;
        let destination: InputDestination =
            serde_json::from_value(args["input_destination"].clone())?;
        let route = CURRENT_CAUSAL_ROUTE
            .try_with(Clone::clone)?
            .ok_or("steer requires a durable Dialogue route")?;
        let principal = CURRENT_PRINCIPAL_ID
            .try_with(Clone::clone)?
            .ok_or("steer requires an authenticated Principal")?;
        let store = self
            .context
            .session_store()
            .ok_or("steer requires SessionStore")?;
        let thread = store
            .get_thread(&route.thread_id)
            .await?
            .ok_or("Source Thread is missing")?;
        let source = self
            .context
            .find_event(&thread.context_id, &thread.root_turn_id)
            .await?
            .ok_or("Source user message is missing")?;
        if source.event_type != crate::event::TYPE_USER_MESSAGE
            || source.payload.contains_key("input_destination")
            || source.payload.get("principal_id").and_then(|v| v.as_str())
                != Some(principal.as_str())
        {
            return Err(
                "steer requires an ordinary message from the current authenticated user".into(),
            );
        }
        let identity = format!("{}:{}", source.id, serde_json::to_string(&destination)?);
        let client_id = format!("steer-{:x}", Sha256::digest(identity.as_bytes()));
        let mut event = source.clone();
        event.id = client_id.clone();
        event.sequence = None;
        event.timestamp = chrono::Utc::now();
        event.payload.remove("target_id");
        event.payload.remove("model_alias");
        event.payload.remove("reasoning_effort");
        for key in [
            "after_thread_id",
            "requested_harness_id",
            "requested_harness_version",
            "requested_harness_artifact_hash",
            "root_turn_id",
            "thread_id",
            "thread_generation",
        ] {
            event.payload.remove(key);
        }
        event.payload.insert(
            "input_destination".into(),
            serde_json::to_value(destination)?,
        );
        event
            .payload
            .insert("source_event_id".into(), json!(source.id));
        event
            .payload
            .insert("client_message_id".into(), json!(client_id));
        match store
            .claim_message(
                &thread.session_id,
                &client_id,
                &event,
                MessageDispatchMode::Parallel,
            )
            .await?
        {
            MessageClaim::Accepted { event, .. } => {
                // Failure of in-process dispatch is recoverable from the
                // durable pending Signal, not a reason to submit it twice.
                if let Err(error) = self.bus.dispatch_persisted(event.clone()).await {
                    tracing::warn!(event_code="steering.dispatch_deferred", event_id=%event.id, %error, "Directed input is durable; dispatch deferred to recovery");
                }
                Ok(json!({"status":"queued","event_id":event.id,"thread_id":event.payload["thread_id"],"guidance":"Input is durably queued; the destination owns execution and its response. Do not duplicate it here."}).to_string())
            }
            MessageClaim::Existing { event_id } => {
                Ok(json!({"status":"queued","duplicate":true,"event_id":event_id}).to_string())
            }
            _ => Err("Directed input was rejected by the authenticated message boundary".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::sqlite::SqliteStore;
    use crate::memory::*;

    async fn fixture() -> (tempfile::NamedTempFile, SqliteStore, ThreadRecord, Event) {
        let file = tempfile::NamedTempFile::new().unwrap();
        let store = SqliteStore::new(&file.path().to_string_lossy())
            .await
            .unwrap();
        let (thread, event) = seed(&store).await;
        (file, store, thread, event)
    }

    async fn seed(store: &dyn RuntimeStore) -> (ThreadRecord, Event) {
        store
            .create_agent_bundle(
                NewAgent {
                    id: "agent-steer".into(),
                    title: "Steering".into(),
                    root_context_id: "context-steer".into(),
                },
                NewCognitiveContext {
                    id: "context-steer".into(),
                    agent_id: "agent-steer".into(),
                    title: "Steering".into(),
                },
                NewSession {
                    id: "session-steer".into(),
                    agent_id: "agent-steer".into(),
                    context_id: "context-steer".into(),
                    parent_session_id: None,
                    title: "Steering".into(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        store
            .ensure_principal(NewPrincipal {
                id: "principal-steer".into(),
                provider_id: "test".into(),
                assurance: "test".into(),
                display_name: None,
            })
            .await
            .unwrap();
        store
            .bind_session_principal("session-steer", "principal-steer")
            .await
            .unwrap();
        let event = Event::new("message-original".into(), "User".into(), crate::event::TYPE_USER_MESSAGE.into(), "chat/user_message".into(),
            serde_json::from_value(json!({"context_id":"context-steer", "session_id":"session-steer", "principal_id":"principal-steer", "text":"Implement the parser", "client_message_id":"original"})).unwrap());
        assert!(matches!(
            store
                .claim_message(
                    "session-steer",
                    "original",
                    &event,
                    MessageDispatchMode::Parallel
                )
                .await
                .unwrap(),
            MessageClaim::Accepted { .. }
        ));
        let thread = store.get_thread_by_root(&event.id).await.unwrap().unwrap();
        (thread, event)
    }

    fn directed(source: &Event, id: &str, destination: InputDestination) -> Event {
        let mut event = source.clone();
        event.id = id.into();
        event.payload.insert("client_message_id".into(), json!(id));
        event.payload.insert(
            "input_destination".into(),
            serde_json::to_value(destination).unwrap(),
        );
        event
    }

    #[tokio::test]
    async fn natural_steering_forwards_original_input_idempotently() {
        use crate::tool::{Tool, ToolCausalRoute, CURRENT_CAUSAL_ROUTE, CURRENT_PRINCIPAL_ID};
        use std::sync::Arc;

        let (_file, store, target, original) = fixture().await;
        let store = Arc::new(store);
        let mut source = original.clone();
        source.id = "human-correction".into();
        source
            .payload
            .insert("client_message_id".into(), json!(source.id));
        source
            .payload
            .insert("text".into(), json!("Keep the original public interface"));
        store
            .claim_message(
                "session-steer",
                &source.id,
                &source,
                MessageDispatchMode::Parallel,
            )
            .await
            .unwrap();
        let source_thread = store.get_thread_by_root(&source.id).await.unwrap().unwrap();
        let tool = SteerTool {
            context: Arc::new(
                crate::orchestrator::context::ContextEngine::new(
                    store.clone() as Arc<dyn EventStore>,
                    crate::config::AppConfig::default().orchestrator,
                )
                .with_session_store(store.clone() as Arc<dyn SessionStore>),
            ),
            bus: Arc::new(crate::event::InMemoryEventBus::new()),
        };
        let arguments = json!({"input_destination": {
            "kind":"thread", "thread_id":target.id, "generation":target.generation,
        }})
        .to_string();
        let route = ToolCausalRoute {
            thread_id: source_thread.id,
            activation_id: "routing-activation".into(),
            model_attempt_id: None,
            root_turn_id: source.id.clone(),
            trigger_event_id: source.id.clone(),
            trigger_sequence: 1,
        };
        CURRENT_PRINCIPAL_ID
            .scope(
                Some("principal-steer".into()),
                CURRENT_CAUSAL_ROUTE.scope(Some(route.clone()), async {
                    let first: serde_json::Value =
                        serde_json::from_str(&tool.execute(&arguments).await.unwrap()).unwrap();
                    let repeated: serde_json::Value =
                        serde_json::from_str(&tool.execute(&arguments).await.unwrap()).unwrap();
                    assert_eq!(first["status"], "queued");
                    assert_eq!(first["event_id"], repeated["event_id"]);
                    assert_eq!(repeated["duplicate"], true);
                }),
            )
            .await;
        let forwarded = store
            .query(QueryFilter {
                context_id: Some(target.context_id.clone()),
                topic: Some("chat/steering".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(forwarded.len(), 1);
        assert_eq!(forwarded[0].payload["text"], source.payload["text"]);
        assert_eq!(forwarded[0].payload["source_event_id"], source.id);
        assert_eq!(forwarded[0].payload["thread_id"], target.id);
        assert!(store
            .get_thread_by_root(&forwarded[0].id)
            .await
            .unwrap()
            .is_none());
        assert!(CURRENT_PRINCIPAL_ID
            .scope(
                Some("foreign-principal".into()),
                CURRENT_CAUSAL_ROUTE.scope(Some(route), tool.execute(&arguments)),
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn directed_input_is_atomic_idempotent_and_never_creates_a_dialogue() {
        let (file, store, thread, source) = fixture().await;
        let destination = InputDestination::Thread {
            thread_id: thread.id.clone(),
            generation: thread.generation,
        };
        let event = directed(&source, "directed", destination);
        let claim = store
            .claim_message(
                "session-steer",
                "directed",
                &event,
                MessageDispatchMode::Interrupt,
            )
            .await
            .unwrap();
        let MessageClaim::Accepted {
            event: accepted, ..
        } = claim
        else {
            panic!("not accepted: {claim:?}");
        };
        assert_eq!(accepted.topic, "chat/steering");
        assert_eq!(accepted.payload["root_turn_id"], thread.root_turn_id);
        assert_eq!(accepted.payload["thread_id"], thread.id);
        assert!(store.get_thread_by_root(&event.id).await.unwrap().is_none());
        assert_eq!(
            store
                .get_thread(&thread.id)
                .await
                .unwrap()
                .unwrap()
                .generation,
            thread.generation,
            "interrupt must not cancel the selected Thread"
        );
        assert!(matches!(
            store
                .claim_message(
                    "session-steer",
                    "directed",
                    &event,
                    MessageDispatchMode::Interrupt
                )
                .await
                .unwrap(),
            MessageClaim::Existing { .. }
        ));
        let mut changed = event.clone();
        changed.payload["input_destination"]["generation"] = json!(thread.generation + 1);
        assert!(matches!(
            store
                .claim_message(
                    "session-steer",
                    "directed",
                    &changed,
                    MessageDispatchMode::Interrupt
                )
                .await
                .unwrap(),
            MessageClaim::Conflict { .. }
        ));
        let reopened = SqliteStore::new(&file.path().to_string_lossy())
            .await
            .unwrap();
        let pending = reopened
            .list_context_thread_signals_for_threads(
                "context-steer",
                &[thread.id],
                Some(ThreadSignalStatus::Pending),
            )
            .await
            .unwrap();
        assert_eq!(
            pending
                .iter()
                .filter(|signal| signal.kind == "chat/steering")
                .count(),
            1,
            "durable Signal survives loss of in-process dispatch"
        );
        let thread = store.get_thread_by_root(&source.id).await.unwrap().unwrap();
        assert_terminal_fence(&store, &thread, &source).await;
    }

    #[tokio::test]
    async fn directed_input_fences_principal_generation_pause_and_terminal_state() {
        let (_file, store, thread, source) = fixture().await;
        let stale = directed(
            &source,
            "stale",
            InputDestination::Thread {
                thread_id: thread.id.clone(),
                generation: thread.generation + 1,
            },
        );
        assert!(store
            .claim_message(
                "session-steer",
                "stale",
                &stale,
                MessageDispatchMode::Parallel
            )
            .await
            .is_err());
        let mut foreign = directed(
            &source,
            "foreign",
            InputDestination::Thread {
                thread_id: thread.id.clone(),
                generation: thread.generation,
            },
        );
        foreign
            .payload
            .insert("principal_id".into(), json!("other-principal"));
        assert!(matches!(
            store
                .claim_message(
                    "session-steer",
                    "foreign",
                    &foreign,
                    MessageDispatchMode::Parallel
                )
                .await
                .unwrap(),
            MessageClaim::ForbiddenPrincipal { .. }
        ));
        store
            .control_thread(
                &thread.id,
                thread.revision,
                ThreadControlAction::Pause,
                None,
                None,
            )
            .await
            .unwrap();
        let paused = store.get_thread(&thread.id).await.unwrap().unwrap();
        let event = directed(
            &source,
            "paused",
            InputDestination::Thread {
                thread_id: paused.id.clone(),
                generation: paused.generation,
            },
        );
        assert!(store
            .claim_message(
                "session-steer",
                "paused",
                &event,
                MessageDispatchMode::Parallel
            )
            .await
            .is_err());
        store
            .control_thread(
                &paused.id,
                paused.revision,
                ThreadControlAction::Cancel,
                None,
                None,
            )
            .await
            .unwrap();
        assert!(store
            .claim_message(
                "session-steer",
                "terminal",
                &event,
                MessageDispatchMode::Parallel
            )
            .await
            .is_err());
        assert!(store
            .query(QueryFilter {
                event_id: Some("paused".into()),
                ..Default::default()
            })
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn concurrent_question_replies_reserve_exactly_one_durable_input() {
        let (_file, store, _thread, source) = fixture().await;
        assert_question_race(&store, &source).await;
    }

    #[tokio::test]
    #[ignore = "requires MORPHZ_TEST_POSTGRES_URL; uses a fresh isolated schema"]
    async fn postgres_directed_input_and_question_race() {
        let url = std::env::var("MORPHZ_TEST_POSTGRES_URL").expect("isolated test database URL");
        let admin = sqlx::PgPool::connect(&url).await.unwrap();
        let schema = format!(
            "steering_{}_{}",
            std::process::id(),
            chrono::Utc::now()
                .timestamp_nanos_opt()
                .unwrap()
                .unsigned_abs()
        );
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&admin)
            .await
            .unwrap();
        let separator = if url.contains('?') { '&' } else { '?' };
        let store = crate::memory::postgres::PostgresStore::new(
            &format!("{url}{separator}options=-csearch_path%3D{schema}%2Cpublic"),
            8,
        )
        .await
        .unwrap();
        let (thread, source) = seed(&store).await;
        for (id, mode) in [
            ("pg-interrupt", MessageDispatchMode::Interrupt),
            ("pg-followup", MessageDispatchMode::FollowUp),
            ("pg-parallel", MessageDispatchMode::Parallel),
        ] {
            let event = directed(
                &source,
                id,
                InputDestination::Thread {
                    thread_id: thread.id.clone(),
                    generation: thread.generation,
                },
            );
            let MessageClaim::Accepted {
                event: accepted, ..
            } = store
                .claim_message("session-steer", id, &event, mode)
                .await
                .unwrap()
            else {
                panic!("not accepted");
            };
            assert_eq!(accepted.payload["thread_id"], thread.id);
            assert_eq!(accepted.topic, "chat/steering");
            assert!(store.get_thread_by_root(&event.id).await.unwrap().is_none());
            assert!(matches!(
                store
                    .claim_message("session-steer", id, &event, mode)
                    .await
                    .unwrap(),
                MessageClaim::Existing { .. }
            ));
        }
        assert_question_race(&store, &source).await;
        assert_terminal_fence(&store, &thread, &source).await;
        drop(store);
        sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
            .execute(&admin)
            .await
            .unwrap();
    }

    async fn assert_question_race(store: &dyn RuntimeStore, source: &Event) {
        let objective = store
            .create_objective(NewObjective {
                id: "objective-steer".into(),
                agent_id: "agent-steer".into(),
                context_id: "context-steer".into(),
                coordinator_session_id: "session-steer".into(),
                delivery_session_id: "session-steer".into(),
                parent_objective_id: None,
                source_event_id: source.id.clone(),
                initiating_principal_id: Some("principal-steer".into()),
                stated_objective: "Choose a parser".into(),
                token_budget: None,
            })
            .await
            .unwrap();
        let ObjectiveMutation::Updated(waiting) = store
            .update_objective_state(
                &objective.id,
                objective.revision,
                ObjectiveStatus::Active,
                Some(ObjectiveWaitCondition::UserInput {
                    session_id: "session-steer".into(),
                    request_id: Some("question-1".into()),
                }),
                None,
            )
            .await
            .unwrap()
        else {
            panic!("wait failed");
        };
        let destination = InputDestination::Objective {
            objective_id: waiting.id.clone(),
            generation: waiting.generation,
            reply_to_request_id: Some("question-1".into()),
        };
        let a = directed(source, "reply-a", destination.clone());
        let b = directed(source, "reply-b", destination);
        // Both futures start together; serialization is provided by the Store,
        // not sleeps or in-process mutexes.
        let (a, b) = tokio::join!(
            store.claim_message(
                "session-steer",
                "reply-a",
                &a,
                MessageDispatchMode::Parallel
            ),
            store.claim_message(
                "session-steer",
                "reply-b",
                &b,
                MessageDispatchMode::Parallel
            )
        );
        assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
        let MessageClaim::Accepted { event, .. } = a.or(b).unwrap() else {
            panic!("reply not accepted");
        };
        assert_eq!(event.payload["reply_to_request_id"], "question-1");
        assert!(store.get_thread_by_root(&event.id).await.unwrap().is_none());
        assert_eq!(
            store
                .get_objective(&waiting.id)
                .await
                .unwrap()
                .unwrap()
                .wait_condition,
            waiting.wait_condition,
            "admission must not erase the wait before its owning Evaluation receives the reply"
        );
    }

    async fn assert_terminal_fence(
        store: &dyn RuntimeStore,
        thread: &ThreadRecord,
        source: &Event,
    ) {
        let persisted = store
            .query(QueryFilter {
                event_id: Some(source.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()
            .remove(0);
        let activation = store
            .ensure_thread_activation(NewThreadActivation {
                id: "activation-steering-terminal".into(),
                agent_id: thread.agent_id.clone(),
                context_id: thread.context_id.clone(),
                session_id: thread.session_id.clone(),
                initiating_principal_id: thread.initiating_principal_id.clone(),
                trigger_event_id: source.id.clone(),
                trigger_sequence: persisted.sequence.unwrap(),
                trigger_kind: source.topic.clone(),
                parent_activation_id: None,
                root_turn_id: source.id.clone(),
            })
            .await
            .unwrap();
        let ThreadActivationMutation::Updated(running) = store
            .update_thread_activation(
                &activation.id,
                activation.revision,
                ThreadActivationStatus::Running,
                Some("test-runtime"),
                Some(chrono::Utc::now() + chrono::Duration::seconds(30)),
                None,
            )
            .await
            .unwrap()
        else {
            panic!("activation not running");
        };
        let reply = Event::new("late-terminal-reply".into(), "Agent".into(), crate::event::TYPE_AGENT_CALL.into(), "chat/reply".into(), serde_json::from_value(json!({"session_id": thread.session_id, "context_id": thread.context_id, "root_turn_id": thread.root_turn_id, "thread_id": thread.id, "disposition":"deliver", "text":"premature"})).unwrap());
        assert_eq!(
            store
                .commit_activation_outcome(&running.id, &reply)
                .await
                .unwrap(),
            ActivationOutcomeCommit::DeferredByDirectedInput
        );
        assert!(store
            .query(QueryFilter {
                event_id: Some(reply.id),
                ..Default::default()
            })
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .get_thread(&thread.id)
                .await
                .unwrap()
                .unwrap()
                .lifecycle,
            ThreadLifecycle::Open
        );
    }
}
