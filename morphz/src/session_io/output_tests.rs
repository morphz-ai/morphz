#[cfg(test)]
mod concurrent_tests {
    use crate as morphz;
    use crate::{
        config::AppConfig,
        memory::{NewSession, QueryFilter, RuntimeStore, SessionMountKind},
        runtime::MorphzRuntime,
        session_io::{self, Limits, OutputFormat, Request},
    };
    use serde_json::json;
    use std::{
        sync::{Arc, Mutex},
        time::Duration,
    };
    use tempfile::TempDir;

    #[derive(Default)]
    struct Fixture {
        prompts: Mutex<Vec<()>>,
        gate: Option<Arc<tokio::sync::Semaphore>>,
    }
    #[async_trait::async_trait]
    impl crate::llm::Client for Fixture {
        async fn create_completion(
            &self,
            _: Vec<crate::llm::Message>,
            _: Vec<crate::llm::ToolDefinition>,
        ) -> Result<crate::llm::Response, Box<dyn std::error::Error + Send + Sync>> {
            self.prompts.lock().unwrap().push(());
            if let Some(gate) = &self.gate {
                gate.acquire().await.unwrap().forget();
            }
            Ok(crate::llm::Response {
                content: "Ready.".into(),
                tool_calls: vec![],
            })
        }
    }
    fn registry() -> session_io::Registry {
        let mut registry = session_io::Registry { enabled: true, ..Default::default() };
        registry
    }
    fn request(id: &str) -> Request {
        Request::parse(json!({"io_version":"1","client_message_id":id,"message":{
            "format":{"id":"morphz.chat","version":"1"},"content":{"encoding":"json","value":{"text":"fixture"}}
        }}).to_string().as_bytes(), &Limits::default()).unwrap()
    }
    async fn runtime(
        temp: &TempDir,
        client: Arc<Fixture>,
        registry: session_io::Registry,
        store: Arc<dyn RuntimeStore>,
    ) -> MorphzRuntime {
        let mut config = AppConfig::default();
        config.permissions.workspace_root = temp.path().to_string_lossy().into_owned();
        config.background_task.artifact_dir =
            temp.path().join("artifacts").to_string_lossy().into_owned();
        let runtime = MorphzRuntime::builder(config, client)
            .store("concurrent-output-fixture", store)
            .session_io_registry(registry)
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        runtime
    }
    async fn session(runtime: &MorphzRuntime) -> crate::runtime::SessionHandle {
        runtime
            .ensure_session(NewSession {
                id: "typed-session".into(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Typed IO".into(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap()
    }
    async fn terminal(runtime: &MorphzRuntime, root: &str) {
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                if !runtime
                    .query_events(QueryFilter {
                        root_turn_id: Some(root.into()),
                        topic: Some("chat/reply".into()),
                        ..Default::default()
                    })
                    .await
                    .unwrap()
                    .is_empty()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
    }
    async fn staged_chat(runtime: &MorphzRuntime, session: &str, id: &str) -> Request {
        let bytes = b"%PDF-1.4\nIO transport fixture\n%%EOF";
        let stages = runtime.message_attachment_stages();
        let principal = &runtime.identity().principal_id;
        stages
            .create(
                crate::model_input::NewMessageAttachmentStage {
                    stage_id: id.into(),
                    principal_id: principal.clone(),
                    session_id: session.into(),
                    client_message_id: id.into(),
                    name: "fixture.pdf".into(),
                    media_type: "application/pdf".into(),
                    size_bytes: bytes.len() as u64,
                    expected_sha256: None,
                },
                runtime.config().model_input.import_limits(),
            )
            .await
            .unwrap();
        stages
            .upload(
                principal,
                session,
                id,
                0,
                futures_util::stream::iter([Ok::<_, std::io::Error>(bytes.to_vec())]),
            )
            .await
            .unwrap();
        let mut input = request(id);
        input.message.content = session_io::Content::Json {
            value: session_io::Data::from_value(&json!({"attachments":[{"stage_id":id}]})),
        };
        input
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_resource_delivery_retries_preserve_committed_bytes() {
        concurrent_delivery(None).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "requires MORPHZ_SESSION_IO_TEST_POSTGRES_URL pointing to a fresh isolated test database"]
    async fn postgres_concurrent_resource_delivery_retries_preserve_committed_bytes() {
        let url = std::env::var("MORPHZ_SESSION_IO_TEST_POSTGRES_URL")
            .expect("Dedicated test database required");
        let parsed = reqwest::Url::parse(&url).unwrap();
        assert!(
            parsed.path().starts_with("/morphz_io_test_"),
            "Refusing a non-test database"
        );
        concurrent_delivery(Some(&url)).await;
    }

    async fn concurrent_delivery(postgres_url: Option<&str>) {
        use morphz::{
            event::InMemoryEventBus,
            memory::{postgres::PostgresStore, sqlite::SqliteStore},
            sdk::MorphzSdk,
            session_io::output::DeliverMessageTool,
            tool::{
                Tool, ToolCausalRoute, CURRENT_CAUSAL_ROUTE, CURRENT_CONTEXT_ID,
                CURRENT_PRINCIPAL_ID, CURRENT_SESSION_ID,
            },
        };
        let temp = TempDir::new().unwrap();
        let gate = Arc::new(tokio::sync::Semaphore::new(1));
        let client = Arc::new(Fixture {
            gate: Some(gate.clone()),
            ..Default::default()
        });
        let store: Arc<dyn RuntimeStore> = if let Some(url) = postgres_url {
            Arc::new(PostgresStore::new(url, 8).await.unwrap())
        } else {
            Arc::new(
                SqliteStore::new(&temp.path().join("io.db").to_string_lossy())
                    .await
                    .unwrap(),
            )
        };
        let runtime = runtime(&temp, client.clone(), registry(), store.clone()).await;
        let session = session(&runtime).await;
        let principal = runtime.identity().principal_id.clone();
        let source = session
            .send_io_as_principal(
                staged_chat(&runtime, session.id(), "concurrent-source").await,
                &principal,
            )
            .await
            .unwrap();
        terminal(&runtime, &source.id).await;
        let resource = source.payload["session_io"]["binding"]["resources"][0]["resource_id"]
            .as_str()
            .unwrap();
        let mut input = request("concurrent-output");
        input.delivery.required_formats.push(OutputFormat {
            id: "morphz.data".into(),
            version: "1".into(),
            encoding: "resource".into(),
            schema_hash: None,
            contract_hash: None,
        });
        let root = session
            .send_io_as_principal(input, &principal)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            while client.prompts.lock().unwrap().len() < 2 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let activation = runtime
            .active_thread_activations(&runtime.identity().context_id)
            .await
            .unwrap()
            .into_iter()
            .find(|a| a.root_turn_id == root.id)
            .unwrap();
        let route = ToolCausalRoute {
            thread_id: morphz::memory::stable_thread_id(&root.id),
            activation_id: activation.id,
            model_attempt_id: None,
            root_turn_id: root.id.clone(),
            trigger_event_id: root.id.clone(),
            trigger_sequence: root.sequence.unwrap(),
        };
        let tool = DeliverMessageTool::new(
            store,
            Arc::new(InMemoryEventBus::new()),
            Limits::default(),
            runtime.config().background_task.artifact_dir.clone().into(),
            runtime.config().model_input.import_limits(),
        );
        let args =
        json!({"delivery_id":"same-output","message":{"format":{"id":"morphz.data","version":"1"},
        "content":{"encoding":"resource","resource_id":resource}}})
        .to_string();
        let invoke = || {
            CURRENT_SESSION_ID.scope(
                session.id().to_string(),
                CURRENT_CONTEXT_ID.scope(
                    runtime.identity().context_id.clone(),
                    CURRENT_PRINCIPAL_ID.scope(
                        Some(principal.clone()),
                        CURRENT_CAUSAL_ROUTE.scope(Some(route.clone()), tool.execute(&args)),
                    ),
                ),
            )
        };
        let attempts = futures_util::future::join_all((0..16).map(|_| invoke())).await;
        assert!(
            attempts.iter().all(Result::is_ok),
            "Concurrent retries failed: {attempts:?}"
        );
        let receipts = attempts
            .into_iter()
            .map(|r| serde_json::from_str::<serde_json::Value>(&r.unwrap()).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            receipts.iter().filter(|r| r["duplicate"] == false).count(),
            1
        );
        let output_id = receipts[0]["event_id"].as_str().unwrap();
        assert!(receipts.iter().all(|r| r["event_id"] == output_id));
        let event = runtime
            .query_events(QueryFilter {
                event_id: Some(output_id.into()),
                ..Default::default()
            })
            .await
            .unwrap()
            .remove(0);
        tokio::fs::remove_file(
            source.payload["attachments"][0]["storage_path"]
                .as_str()
                .unwrap(),
        )
        .await
        .unwrap();
        assert!(
            invoke().await.is_ok(),
            "Committed retry must not re-read a removed source file"
        );
        let sdk = MorphzSdk::new(runtime.clone());
        let owned = event.payload["io_resources"][0]["resource_id"]
            .as_str()
            .unwrap();
        assert_eq!(
            sdk.read_io_resource(&sdk.default_principal(), session.id(), owned)
                .await
                .unwrap()
                .1
                .data,
            b"%PDF-1.4\nIO transport fixture\n%%EOF"
        );
        gate.add_permits(1);
        terminal(&runtime, &root.id).await;
    }
}
