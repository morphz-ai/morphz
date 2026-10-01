//! Capture real Runtime requests (deterministic model transport, real SQL
//! Threads/Activations/Context compilation). This does not claim provider cache hits.
use morphz::agent_rom::*;
use morphz::config::AppConfig;
use morphz::llm::{model_visible_message_text, Client, Message, Response, ToolDefinition};
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{
    AgentRomStore, NewPrincipal, NewSession, QueryFilter, RuntimeStore, SessionDirectoryStore,
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
            content: "ROM test complete".into(),
            tool_calls: vec![],
        })
    }
}
fn rom_command(
    agent: &str,
    principal: Option<&str>,
    id: &str,
    revision: u64,
    name: &str,
) -> PutAgentRomCommand {
    PutAgentRomCommand {
        command_id: id.into(),
        expected_revision: revision,
        key: AgentRomKey {
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
        enabled: true,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_model_requests_mount_scoped_rom_and_record_immutable_attempt_binding() {
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
            title: "ROM test".into(),
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
    assert!(!model_visible_message_text(&baseline[1]).contains("(agent-rom "));
    assert!(!baseline[0].content.contains(ROM_SYSTEM_RULE));
    let first = rom_command(
        &identity.agent_id,
        None,
        "rom-runtime-agent-create",
        0,
        "Nora",
    );
    store
        .put_agent_rom(first.clone(), "trusted-host")
        .await
        .unwrap();
    store
        .put_agent_rom(
            rom_command(
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
        .put_agent_rom(
            rom_command(
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
    let rom = parsed.get_path(&["agent-rom"]).unwrap().to_string();
    assert!(rom.contains("Nora") && rom.contains("Alice"));
    assert!(!rom.contains("SECRET_BOB"));
    assert!(text.find("(protocol ").unwrap() < text.find("(agent-rom ").unwrap());
    assert!(text.find("(agent-rom ").unwrap() < text.find("(evaluation-profile ").unwrap());
    assert!(configured[0].content.starts_with(&baseline[0].content));
    assert!(configured[0].content.contains(ROM_SYSTEM_RULE));
    assert!(
        !tools
            .iter()
            .any(|t| t.name.contains("rom") || t.name == "put_agent_rom"),
        "No generic control-plane tool for Agent"
    );
    assert_eq!(
        runtime.mind_version(&identity.context_id).await.unwrap(),
        mind_before,
        "ROM does not mutate Mind version"
    );
    let version = runtime.get_agent_rom(&first.key).await.unwrap().unwrap();
    for operation in [
        format!("(revise {} (configuration changed))", version.entry_id),
        format!("(retire {})", version.entry_id),
        format!("(protect {})", version.entry_id),
        format!("(unprotect {})", version.entry_id),
        format!("(rollback {})", version.entry_id),
    ] {
        let tx = format!(
            "(context-tx (base-version {mind_before}) (reason test-ROM-read-only) {operation})"
        );
        assert!(
            runtime
                .apply_context_transaction_strict(&identity.context_id, session.id(), &tx)
                .await
                .is_err(),
            "Agent operation {operation} cannot modify ROM"
        );
        assert_eq!(
            runtime.get_agent_rom(&first.key).await.unwrap(),
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
        .find_map(|e| e.payload.get("agent_rom"))
        .expect("ROM binding metadata must be durable, not ephemeral snapshot only");
    assert_eq!(binding["versions"].as_array().unwrap().len(), 2);
    let old_thread = binding["thread_id"].as_str().unwrap();
    let old = store.get_thread_rom(old_thread).await.unwrap().unwrap();
    store
        .put_agent_rom(
            rom_command(&identity.agent_id, None, "rom-runtime-rename", 1, "Vega"),
            "trusted-host",
        )
        .await
        .unwrap();
    assert_eq!(store.bind_thread_rom(old_thread).await.unwrap(), old);
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
    let rom_start = text.find("(agent-rom ").unwrap();
    let profile_start = text.find("(evaluation-profile ").unwrap();
    assert!(text[rom_start..profile_start].contains("Vega"));
    assert!(!text[rom_start..profile_start].contains("Nora"));
}
