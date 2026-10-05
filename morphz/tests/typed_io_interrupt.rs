//! Real typed Session ingress on both SQL backends, without starting a model.
//! The scheduler transitions below are durable API calls, not seeded SQL rows.
use morphz::{
    config::AppConfig,
    event::Event,
    llm::{Client, Message, Response, ToolDefinition},
    memory::{
        postgres::PostgresStore, sqlite::SqliteStore, NewAgent, NewCognitiveContext, NewSession,
        NewThreadActivation, QueryFilter, RuntimeStore, SessionMountKind, ThreadActivationMutation,
        ThreadActivationStatus, ThreadLifecycle, ThreadSignalStatus,
    },
    runtime::{MorphzRuntime, RuntimeIdentity, SessionHandle},
    session_io::{AcceptedInput, Limits, Request},
};
use serde_json::json;
use std::{error::Error, path::Path, sync::Arc};
use tempfile::TempDir;

type TestError = Box<dyn Error + Send + Sync>;
const AGENT: &str = "typed-interrupt-agent";
const CONTEXT: &str = "typed-interrupt-context";
const PRINCIPAL: &str = "typed-interrupt-principal";

struct NoModel;
#[async_trait::async_trait]
impl Client for NoModel {
    async fn create_completion(
        &self,
        _: Vec<Message>,
        _: Vec<ToolDefinition>,
    ) -> Result<Response, TestError> {
        panic!("Ingress regression must never call a provider");
    }
}

async fn runtime(
    store: Arc<dyn RuntimeStore>,
    workspace: &Path,
) -> Result<MorphzRuntime, TestError> {
    let mut config = AppConfig::default();
    config.permissions.workspace_root = workspace.to_string_lossy().into_owned();
    config.background_task.artifact_dir =
        workspace.join("artifacts").to_string_lossy().into_owned();
    let runtime = MorphzRuntime::builder(config, Arc::new(NoModel))
        .identity(RuntimeIdentity {
            agent_id: AGENT.into(),
            context_id: CONTEXT.into(),
            principal_id: PRINCIPAL.into(),
        })
        .store("typed-interrupt-fixture", store)
        .build()
        .await?;
    runtime
        .ensure_agent(NewAgent {
            id: AGENT.into(),
            title: "Typed interrupt fixture".into(),
            root_context_id: CONTEXT.into(),
        })
        .await?;
    runtime
        .ensure_context(NewCognitiveContext {
            id: CONTEXT.into(),
            agent_id: AGENT.into(),
            title: "Typed interrupt fixture".into(),
        })
        .await?;
    Ok(runtime)
}

async fn session(runtime: &MorphzRuntime, id: &str) -> Result<SessionHandle, TestError> {
    runtime
        .ensure_session(NewSession {
            id: id.into(),
            agent_id: AGENT.into(),
            context_id: CONTEXT.into(),
            parent_session_id: None,
            title: "Typed interrupt fixture".into(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
}

fn request(id: &str, referenced_session: Option<&str>) -> Request {
    let mut content = json!({"text":format!("Synthetic input {id}")});
    if let Some(session_id) = referenced_session {
        content["references"] = json!([{"kind":"session", "session_id":session_id}]);
    }
    Request::parse(
        json!({
            "io_version":"1", "client_message_id":id,
            // The Application composer explicitly selects Interrupt; omission in
            // the low-level typed API intentionally retains its Parallel contract.
            "activation":{"dispatch_mode":"interrupt"},
            "message":{"format":{"id":"morphz.chat","version":"1"},
                "content":{"encoding":"json","value":content}},
        })
        .to_string()
        .as_bytes(),
        &Limits::default(),
    )
    .unwrap()
}

async fn running(
    store: &dyn RuntimeStore,
    session: &SessionHandle,
    event: &Event,
) -> Result<String, TestError> {
    let signal = store
        .next_pending_thread_signal(&store.get_thread_by_root(&event.id).await?.unwrap().id)
        .await?
        .unwrap();
    let id = format!("activation-{}", event.id);
    store
        .ensure_thread_activation(NewThreadActivation {
            id: id.clone(),
            agent_id: AGENT.into(),
            context_id: CONTEXT.into(),
            session_id: session.id().into(),
            initiating_principal_id: Some(PRINCIPAL.into()),
            trigger_event_id: event.id.clone(),
            trigger_sequence: signal.sequence,
            trigger_kind: event.topic.clone(),
            parent_activation_id: None,
            root_turn_id: event.id.clone(),
        })
        .await?;
    assert!(matches!(
        store
            .update_thread_activation(
                &id,
                1,
                ThreadActivationStatus::Running,
                Some("isolated-ingress-worker"),
                Some(chrono::Utc::now() + chrono::Duration::minutes(10)),
                Some(1),
            )
            .await?,
        ThreadActivationMutation::Updated(_)
    ));
    store
        .bind_activation_input_signals(&id, std::slice::from_ref(&event.id))
        .await?;
    Ok(id)
}

async fn assertions(store: Arc<dyn RuntimeStore>, workspace: &Path) -> Result<(), TestError> {
    let runtime = runtime(store.clone(), workspace).await?;
    for with_reference in [false, true] {
        // A real Session reference forces PostgreSQL's general transactional
        // path, while the other case also validates its optimized admission.
        let label = if with_reference {
            "referenced"
        } else {
            "ordinary"
        };
        let session = session(&runtime, label).await?;
        let first_request = request(&format!("{label}-first"), None);
        assert_eq!(
            first_request.activation.dispatch_mode,
            Some(morphz::memory::MessageDispatchMode::Interrupt),
            "Keep the real composer default interrupt"
        );
        let first = session
            .send_io_as_principal(first_request.clone(), PRINCIPAL)
            .await?;
        let first_snapshot = first.payload["session_io"].clone();
        let old_thread = store.get_thread_by_root(&first.id).await?.unwrap();
        let activation = running(store.as_ref(), &session, &first).await?;
        let mut second_request = request(
            &format!("{label}-second"),
            with_reference.then_some(session.id()),
        );
        second_request.activation.reasoning_effort = Some("high".into());
        second_request.activation.response_annotations =
            Some(morphz::response_annotations::Protocol::V2);
        let second = session
            .send_io_as_principal(second_request.clone(), PRINCIPAL)
            .await?;
        assert_eq!(second.event_type, "session_message");
        let accepted: AcceptedInput = serde_json::from_value(second.payload["session_io"].clone())?;
        assert_eq!(
            accepted.request, second_request,
            "Typed request is immutable at acceptance"
        );
        let replacement = store.get_thread_by_root(&second.id).await?.unwrap();
        assert_ne!(replacement.id, old_thread.id);
        assert_eq!(replacement.generation, 1);
        assert_eq!(replacement.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(
            replacement.response_annotations,
            morphz::response_annotations::Protocol::V2
        );
        assert_eq!(
            replacement.initiating_principal_id.as_deref(),
            Some(PRINCIPAL)
        );
        assert_eq!(
            store
                .get_thread_activation(&activation)
                .await?
                .unwrap()
                .status,
            ThreadActivationStatus::Cancelled
        );
        assert_eq!(
            store.get_thread(&old_thread.id).await?.unwrap().lifecycle,
            ThreadLifecycle::Cancelled
        );
        let replayed = store
            .list_context_thread_signals(CONTEXT, Some(ThreadSignalStatus::Pending))
            .await?
            .into_iter()
            .filter(|signal| signal.thread_id == replacement.id)
            .collect::<Vec<_>>();
        assert_eq!(
            replayed
                .iter()
                .map(|signal| signal.event_id.as_str())
                .collect::<Vec<_>>(),
            vec![first.id.as_str(), second.id.as_str()],
            "Original input receipt must be replayed once in order"
        );
        assert!(store.list_activation_signals(&activation).await?.is_empty());
        assert_eq!(
            store
                .message_event_id(session.id(), &first_request.client_message_id)
                .await?
                .as_deref(),
            Some(first.id.as_str()),
            "Interrupt must not rewrite the original idempotency receipt"
        );
        assert_eq!(
            session
                .send_io_as_principal(second_request.clone(), PRINCIPAL)
                .await?
                .id,
            second.id
        );
        assert_eq!(
            session
                .send_io_as_principal(first_request, PRINCIPAL)
                .await?
                .payload["session_io"],
            first_snapshot
        );
        let threads = store.list_context_threads(CONTEXT, true).await?;
        assert_eq!(
            threads
                .iter()
                .filter(|thread| thread.session_id == session.id())
                .count(),
            2,
            "Retries may not duplicate either root"
        );

        // Typed messages must not be merged into an unrelated queued/pending
        // root by broadening the legacy user_message batching probes.
        let mut third_request = request(&format!("{label}-third"), None);
        third_request.activation = second_request.activation.clone();
        let third = session
            .send_io_as_principal(third_request.clone(), PRINCIPAL)
            .await?;
        assert_ne!(
            store.get_thread_by_root(&third.id).await?.unwrap().id,
            replacement.id
        );
        let mut other_format = request(&format!("{label}-data"), None);
        other_format.activation = third_request.activation;
        other_format.message.format.id = "test.distinct-format".into();
        other_format.message.validation = "generic".into();
        let data = session
            .send_io_as_principal(other_format.clone(), PRINCIPAL)
            .await?;
        assert_ne!(
            store.get_thread_by_root(&data.id).await?.unwrap().id,
            store.get_thread_by_root(&third.id).await?.unwrap().id
        );
        let data_snapshot: AcceptedInput =
            serde_json::from_value(data.payload["session_io"].clone())?;
        assert_eq!(data_snapshot.request, other_format);
        let rejected = session
            .send_io_as_principal(
                request(&format!("{label}-forbidden"), None),
                "unbound-principal",
            )
            .await
            .unwrap_err();
        assert_eq!(rejected.status(), 403);
        assert!(store
            .message_event_id(session.id(), &format!("{label}-forbidden"))
            .await?
            .is_none());
    }

    for typed_first in [true, false] {
        let label = if typed_first {
            "typed-to-legacy"
        } else {
            "legacy-to-typed"
        };
        let mixed = session(&runtime, label).await?;
        let typed = if typed_first {
            Some(
                mixed
                    .send_io_as_principal(request(&format!("{label}-typed"), None), PRINCIPAL)
                    .await?,
            )
        } else {
            None
        };
        mixed
            .send_as_principal(
                "Synthetic legacy input",
                "Human",
                PRINCIPAL,
                Some(format!("{label}-legacy")),
            )
            .await?;
        let typed = if let Some(typed) = typed {
            typed
        } else {
            mixed
                .send_io_as_principal(request(&format!("{label}-typed"), None), PRINCIPAL)
                .await?
        };
        let legacy_id = store
            .message_event_id(mixed.id(), &format!("{label}-legacy"))
            .await?
            .unwrap();
        let legacy_thread = store.get_thread_by_root(&legacy_id).await?.unwrap();
        let typed_thread = store.get_thread_by_root(&typed.id).await?.unwrap();
        assert_ne!(
            legacy_thread.id, typed_thread.id,
            "Legacy and typed pending formats must not coalesce"
        );
        for thread in [legacy_thread, typed_thread] {
            let signals = store
                .list_context_thread_signals(CONTEXT, Some(ThreadSignalStatus::Pending))
                .await?
                .into_iter()
                .filter(|signal| signal.thread_id == thread.id)
                .collect::<Vec<_>>();
            assert_eq!(
                signals.len(),
                1,
                "Each protocol retains its own original input Signal"
            );
        }
    }

    let execution = session(&runtime, "released-execution").await?;
    let first = execution
        .send_io_as_principal(request("released-first", None), PRINCIPAL)
        .await?;
    let thread = store.get_thread_by_root(&first.id).await?.unwrap();
    let activation = running(store.as_ref(), &execution, &first).await?;
    assert!(
        store
            .release_dialogue_turn_activation(&activation, chrono::Utc::now())
            .await?
    );
    let second = execution
        .send_io_as_principal(request("released-second", None), PRINCIPAL)
        .await?;
    assert_eq!(
        store
            .get_thread_activation(&activation)
            .await?
            .unwrap()
            .status,
        ThreadActivationStatus::Running
    );
    assert_eq!(
        store.get_thread(&thread.id).await?.unwrap().lifecycle,
        ThreadLifecycle::Open
    );
    assert_eq!(
        store.list_activation_signals(&activation).await?.len(),
        1,
        "Physical execution keeps its original input, without replay or cancellation"
    );
    assert_ne!(
        store.get_thread_by_root(&second.id).await?.unwrap().id,
        thread.id
    );
    let events = store
        .query(QueryFilter {
            session_id: Some(execution.id().into()),
            topic: Some("chat/user_message".into()),
            ..Default::default()
        })
        .await?;
    assert_eq!(events.len(), 2);
    Ok(())
}

#[tokio::test]
async fn sqlite_typed_io_default_interrupt_reuses_exact_replacement() -> Result<(), TestError> {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    let temp = TempDir::new()?;
    let store = Arc::new(SqliteStore::new(temp.path().join("typed.db").to_str().unwrap()).await?);
    assertions(store, temp.path()).await
}

#[tokio::test]
#[ignore = "Requires dedicated PostgreSQL; postgres-conformance runs --include-ignored"]
async fn postgres_typed_io_default_interrupt_reuses_exact_replacement() -> Result<(), TestError> {
    let database_url = std::env::var("MORPHZ_TEST_POSTGRES_URL")
        .map_err(|_| "PostgreSQL regression requires the isolated test environment preflight")?;
    let admin = sqlx::PgPool::connect(&database_url).await?;
    let schema = format!(
        "morphz_typed_interrupt_{}_{}",
        std::process::id(),
        chrono::Utc::now()
            .timestamp_nanos_opt()
            .unwrap()
            .unsigned_abs()
    );
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await?;
    let separator = if database_url.contains('?') { '&' } else { '?' };
    let scoped = format!("{database_url}{separator}options=-csearch_path%3D{schema}");
    let store = Arc::new(PostgresStore::new(&scoped, 8).await?);
    let temp = TempDir::new()?;
    let result = assertions(store, temp.path()).await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await?;
    result
}
