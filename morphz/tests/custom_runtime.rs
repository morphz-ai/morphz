//! Capture Custom in real Runtime requests (deterministic model transport, real SQL
//! Threads/Activations/Context compilation). This does not claim provider cache hits.
use morphz::config::AppConfig;
use morphz::context::*;
use morphz::llm::{model_visible_message_text, Client, Message, Response, ToolDefinition};
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{
    CustomStore, NewPrincipal, NewSession, QueryFilter, RuntimeStore, SessionDirectoryStore,
    SessionMountKind,
};
use morphz::runtime::{MorphzRuntime, RuntimeToolPolicy};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Default)]
struct CaptureClient {
    requests: Mutex<Vec<(Vec<Message>, Vec<ToolDefinition>)>>,
}
#[async_trait::async_trait]
impl Client for CaptureClient {
    fn supports_async_cancellation(&self) -> bool {
        true
    }
    fn model(&self) -> Option<String> {
        Some("rom-fixture".into())
    }
    async fn create_completion(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        self.requests.lock().unwrap().push((messages, tools));
        Ok(Response {
            content: "Custom test complete".into(),
            tool_calls: vec![],
        })
    }
}
fn custom_command(
    agent: &str,
    principal: Option<&str>,
    id: &str,
    revision: u64,
    name: &str,
) -> PutCustomCommand {
    PutCustomCommand {
        command_id: id.into(),
        expected_revision: revision,
        key: CustomKey {
            agent_id: agent.into(),
            namespace: if principal.is_some() {
                "example.human"
            } else {
                "example.agent"
            }
            .into(),
            principal_scope: principal.map(str::to_owned),
        },
        schema_tag: "example/v1".into(),
        body_sexpr: format!("(configuration (name {name}))"),
        authoring_state_sexpr: None,
        enabled: true,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn empty_enabled_agent_profile_saves_switch_without_model_custom_or_authoring_bytes() {
    let dir = tempfile::TempDir::new().unwrap();
    let db = dir.path().join("runtime-empty-enabled-profile.db");
    let store = Arc::new(SqliteStore::new(db.to_str().unwrap()).await.unwrap());
    let client = Arc::new(CaptureClient::default());
    let mut config = AppConfig::default();
    config.permissions.workspace_root = dir.path().to_string_lossy().into_owned();
    config.background_task.artifact_dir =
        dir.path().join("artifacts").to_string_lossy().into_owned();
    let runtime = MorphzRuntime::builder(config, client.clone() as Arc<dyn Client>)
        .store(
            "sqlite:empty-profile-test",
            store.clone() as Arc<dyn RuntimeStore>,
        )
        .tool_policy(RuntimeToolPolicy {
            context_only: true,
            coding_eval: false,
        })
        .build()
        .await
        .unwrap();
    runtime.start().await.unwrap();
    let identity = runtime.identity().clone();
    let session = runtime
        .ensure_session(NewSession {
            id: "empty-enabled-profile-session".into(),
            agent_id: identity.agent_id.clone(),
            context_id: identity.context_id.clone(),
            parent_session_id: None,
            title: "Empty profile test".into(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    let mut replies = runtime.subscribe("chat/reply", 16);
    session
        .send("baseline", "Test", Some("empty-profile-baseline".into()))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(30), replies.recv())
        .await
        .unwrap()
        .unwrap();

    let empty = PutCustomCommand {
        command_id: "runtime-empty-profile-on".into(),
        expected_revision: 0,
        key: CustomKey {
            agent_id: identity.agent_id.clone(),
            namespace: "morphz.profile.agent".into(),
            principal_scope: None,
        },
        schema_tag: "morphz-agent-profile/v2".into(),
        body_sexpr: "(agent-profile (version 2))".into(),
        authoring_state_sexpr: Some(
            "(editor (custom INACTIVE_EMPTY_STYLE_NEVER_MODEL) (custom-enabled false))".into(),
        ),
        enabled: true,
    };
    store
        .put_custom(empty.clone(), "trusted-host")
        .await
        .unwrap();
    let persisted = store.get_custom(&empty.key).await.unwrap().unwrap();
    assert!(persisted.enabled);
    assert!(persisted
        .canonical_authoring_state
        .as_ref()
        .unwrap()
        .contains("INACTIVE_EMPTY_STYLE_NEVER_MODEL"));
    let empty_receipt = session
        .send(
            "empty profile enabled",
            "Test",
            Some("empty-profile-request".into()),
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(30), replies.recv())
        .await
        .unwrap()
        .unwrap();
    let requests = client.requests.lock().unwrap().clone();
    let baseline = &requests[0];
    let enabled_empty = &requests[1];
    assert_eq!(
        baseline.0[0], enabled_empty.0[0],
        "Empty enabled Profile does not extend the legacy System contract"
    );
    assert_eq!(
        serde_json::to_value(&baseline.1).unwrap(),
        serde_json::to_value(&enabled_empty.1).unwrap()
    );
    let text = model_visible_message_text(&enabled_empty.0[1]);
    assert!(!text.contains("(custom "));
    assert!(!text.contains("(agent-profile "));
    assert!(!serde_json::to_string(&enabled_empty)
        .unwrap()
        .contains("INACTIVE_EMPTY_STYLE_NEVER_MODEL"));
    assert!(!enabled_empty.0[0].content.contains(CUSTOM_SYSTEM_RULE));
    let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}", db.display()))
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM thread_rom_bindings")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    let empty_thread_id =
        sqlx::query_scalar::<_, String>("SELECT id FROM threads WHERE root_turn_id=?")
            .bind(&empty_receipt.event_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let frozen = store
        .get_thread_custom(&empty_thread_id)
        .await
        .unwrap()
        .unwrap();
    assert!(frozen.entries.is_empty());
    assert_eq!(frozen.manifest_hash, manifest_hash(&[]));
    pool.close().await;

    let mut named = empty.clone();
    named.command_id = "runtime-empty-profile-name".into();
    named.expected_revision = 1;
    named.body_sexpr = "(agent-profile (version 2) (identity (name Nora)))".into();
    store.put_custom(named, "trusted-host").await.unwrap();
    session
        .send(
            "configured profile",
            "Test",
            Some("empty-profile-now-named".into()),
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(30), replies.recv())
        .await
        .unwrap()
        .unwrap();
    let requests = client.requests.lock().unwrap().clone();
    assert!(requests[2].0[0].content.contains(CUSTOM_SYSTEM_RULE));
    assert!(model_visible_message_text(&requests[2].0[1]).contains("(identity (name Nora))"));
    assert!(!serde_json::to_string(&requests)
        .unwrap()
        .contains("INACTIVE_EMPTY_STYLE_NEVER_MODEL"));
    assert_eq!(
        store.bind_thread_custom(&empty_thread_id).await.unwrap(),
        frozen
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_model_requests_mount_scoped_custom_and_record_immutable_attempt_binding() {
    let dir = tempfile::TempDir::new().unwrap();
    let db = dir.path().join("runtime-rom.db");
    let store = Arc::new(SqliteStore::new(db.to_str().unwrap()).await.unwrap());
    let client = Arc::new(CaptureClient::default());
    let mut config = AppConfig::default();
    config.permissions.workspace_root = dir.path().to_string_lossy().into_owned();
    config.background_task.artifact_dir =
        dir.path().join("artifacts").to_string_lossy().into_owned();
    let runtime = MorphzRuntime::builder(config, client.clone() as Arc<dyn Client>)
        .store("sqlite:rom-test", store.clone() as Arc<dyn RuntimeStore>)
        .tool_policy(RuntimeToolPolicy {
            context_only: true,
            coding_eval: false,
        })
        .build()
        .await
        .unwrap();
    runtime.start().await.unwrap();
    let identity = runtime.identity().clone();
    let session = runtime
        .ensure_session(NewSession {
            id: "rom-runtime-session".into(),
            agent_id: identity.agent_id.clone(),
            context_id: identity.context_id.clone(),
            parent_session_id: None,
            title: "Custom test".into(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    let mut replies = runtime.subscribe("chat/reply", 16);
    session
        .send("legacy request", "Test", Some("rom-runtime-legacy".into()))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(30), replies.recv())
        .await
        .unwrap()
        .unwrap();
    let baseline = client.requests.lock().unwrap()[0].0.clone();
    assert!(!model_visible_message_text(&baseline[1]).contains("(custom "));
    assert!(!baseline[0].content.contains(CUSTOM_SYSTEM_RULE));
    let mut first = custom_command(
        &identity.agent_id,
        None,
        "rom-runtime-agent-create",
        0,
        "Nora",
    );
    first.authoring_state_sexpr =
        Some("(editor (custom INACTIVE_STYLE_ONLY_CONTROL_PLANE) (custom-enabled false))".into());
    store
        .put_custom(first.clone(), "trusted-host")
        .await
        .unwrap();
    store
        .put_custom(
            custom_command(
                &identity.agent_id,
                Some(&identity.principal_id),
                "rom-runtime-human-create",
                0,
                "Alice",
            ),
            "trusted-host",
        )
        .await
        .unwrap();
    store
        .ensure_principal(NewPrincipal {
            id: "other-runtime-human".into(),
            provider_id: "test-ingress".into(),
            assurance: "authenticated".into(),
            display_name: None,
        })
        .await
        .unwrap();
    store
        .put_custom(
            custom_command(
                &identity.agent_id,
                Some("other-runtime-human"),
                "rom-runtime-other-human",
                0,
                "SECRET_BOB",
            ),
            "trusted-host",
        )
        .await
        .unwrap();
    let mind_before = runtime.mind_version(&identity.context_id).await.unwrap();
    session
        .send(
            "new configured request",
            "Test",
            Some("rom-runtime-configured".into()),
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(30), replies.recv())
        .await
        .unwrap()
        .unwrap();
    let requests = client.requests.lock().unwrap().clone();
    let (configured, tools) = &requests[1];
    let text = model_visible_message_text(&configured[1]);
    let parsed = morphz::sexpr::parse(text[text.find("(context ").unwrap()..].trim()).unwrap();
    let rom = parsed.get_path(&["custom"]).unwrap().to_string();
    assert!(rom.contains("Nora") && rom.contains("Alice"));
    assert!(!rom.contains("SECRET_BOB"));
    assert!(!serde_json::to_string(&configured)
        .unwrap()
        .contains("INACTIVE_STYLE_ONLY_CONTROL_PLANE"));
    assert!(!serde_json::to_string(&configured)
        .unwrap()
        .contains("canonical_authoring_state"));
    assert!(text.find("(protocol ").unwrap() < text.find("(custom ").unwrap());
    assert!(text.find("(custom ").unwrap() < text.find("(evaluation-profile ").unwrap());
    assert!(configured[0].content.starts_with(&baseline[0].content));
    assert!(configured[0].content.contains(CUSTOM_SYSTEM_RULE));
    assert!(
        !tools
            .iter()
            .any(|t| t.name.contains("rom") || t.name.contains("custom")),
        "No generic control-plane tool for Agent"
    );
    assert_eq!(
        runtime.mind_version(&identity.context_id).await.unwrap(),
        mind_before,
        "Custom does not mutate Mind version"
    );
    let version = runtime.get_custom(&first.key).await.unwrap().unwrap();
    assert!(version
        .canonical_authoring_state
        .as_deref()
        .unwrap()
        .contains("INACTIVE_STYLE_ONLY_CONTROL_PLANE"));
    for operation in [
        format!("(revise {} (configuration changed))", version.entry_id),
        format!("(retire {})", version.entry_id),
        format!("(protect {})", version.entry_id),
        format!("(unprotect {})", version.entry_id),
        format!("(rollback {})", version.entry_id),
    ] {
        let tx = format!(
            "(context-tx (base-version {mind_before}) (reason test-Custom-read-only) {operation})"
        );
        assert!(
            runtime
                .apply_context_transaction_strict(&identity.context_id, session.id(), &tx)
                .await
                .is_err(),
            "Agent operation {operation} cannot modify Custom"
        );
        assert_eq!(
            runtime.get_custom(&first.key).await.unwrap(),
            Some(version.clone())
        );
    }
    let events = runtime
        .query_events(QueryFilter {
            context_id: Some(identity.context_id.clone()),
            topic: Some("runtime/model_attempt_state".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let binding = events
        .iter()
        .find_map(|e| e.payload.get("custom"))
        .expect("Custom binding metadata must be durable, not ephemeral snapshot only");
    assert_eq!(binding["versions"].as_array().unwrap().len(), 2);
    let old_thread = binding["thread_id"].as_str().unwrap();
    let old = store.get_thread_custom(old_thread).await.unwrap().unwrap();
    assert!(old
        .entries
        .iter()
        .all(|entry| entry.canonical_authoring_state.is_none()));
    assert!(!serde_json::to_string(&old)
        .unwrap()
        .contains("INACTIVE_STYLE_ONLY_CONTROL_PLANE"));
    store
        .put_custom(
            custom_command(&identity.agent_id, None, "rom-runtime-rename", 1, "Vega"),
            "trusted-host",
        )
        .await
        .unwrap();
    assert_eq!(store.bind_thread_custom(old_thread).await.unwrap(), old);
    session
        .send(
            "new renamed request",
            "Test",
            Some("rom-runtime-renamed".into()),
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(30), replies.recv())
        .await
        .unwrap()
        .unwrap();
    let requests = client.requests.lock().unwrap();
    let text = model_visible_message_text(&requests[2].0[1]);
    let rom_start = text.find("(custom ").unwrap();
    let profile_start = text.find("(evaluation-profile ").unwrap();
    assert!(text[rom_start..profile_start].contains("Vega"));
    assert!(!text[rom_start..profile_start].contains("Nora"));
    assert!(
        !serde_json::to_string(&*requests)
            .unwrap()
            .contains("INACTIVE_STYLE_ONLY_CONTROL_PLANE"),
        "No actual model request or tool definition may carry editor-only text"
    );
}
