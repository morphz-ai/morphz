//! Same-machine, two logical Target acceptance. The HTTP handlers, Edge
//! workers, physical tools, Job store and Artifact relay are production code;
//! only the provider's deterministic choices are synthetic.

use super::*;
use crate::artifact::{
    ArtifactLocation, ArtifactOverwritePolicy, ArtifactTransferReceipt, ArtifactTransferRequest,
};
use crate::edge_node::{
    generate_device_identity, EdgeGatewayClient, EdgeNodeAdvertisement, EdgeNodeCredentials,
    EdgeNodeWorker, EdgeWorkerConfig,
};
use crate::llm::{ModelAttemptBinding, ToolCallRepr};
use crate::memory::{ExecutionJobFilter, ExecutionJobStatus, ExecutionTargetKind, RuntimeStore};
use crate::permission::PermissionMode;
use crate::runtime::SessionMessageOptions;
use crate::sdk::{CreateNodePairingCodeCommand, PairExecutionNodeCommand};
use futures_util::FutureExt;
use sha2::{Digest, Sha256};
use std::panic::AssertUnwindSafe;
use std::time::Duration;

struct PhysicalTargetClient {
    workspaces: BTreeMap<String, PathBuf>,
    calls: Mutex<BTreeMap<String, usize>>,
    ingress: tokio::sync::Barrier,
    release: PathBuf,
}

#[async_trait::async_trait]
impl Client for PhysicalTargetClient {
    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, crate::runtime::RuntimeError> {
        Err("this acceptance requires an actual session-bound provider request".into())
    }

    async fn create_completion_bound_stream(
        &self,
        binding: &ModelAttemptBinding,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
        _measurement: Option<PromptTokenCount>,
        _stream: ModelStreamSender,
    ) -> Result<Response, crate::runtime::RuntimeError> {
        let session_id = binding
            .request_session_id
            .as_deref()
            .ok_or("the provider request omitted its durable Session")?;
        let workspace = self
            .workspaces
            .get(session_id)
            .ok_or("an unexpected Session requested a model evaluation")?;
        let call = {
            let mut calls = self.calls.lock().unwrap();
            let next = calls.entry(session_id.to_string()).or_default();
            let call = *next;
            *next += 1;
            call
        };
        match call {
            0 => {
                assert!(tools.iter().any(|tool| tool.name == "eval"));
                self.ingress.wait().await;
                let marker = if session_id.ends_with("-a") { "a" } else { "b" };
                let release = self.release.to_string_lossy();
                let command = crate::tool::platform_test_shell_command(
                    format!(
                        "printf 'exec-{marker}' > exec.txt; touch started; \
                         while [ ! -f '{release}' ]; do sleep 0.02; done; \
                         printf 'multi-target-exec-{marker}'"
                    ),
                    format!(
                        "Set-Content -NoNewline exec.txt 'exec-{marker}'; \
                         New-Item -ItemType File started | Out-Null; \
                         while (!(Test-Path '{release}')) {{ Start-Sleep -Milliseconds 20 }}; \
                         [Console]::Write('multi-target-exec-{marker}')"
                    ),
                );
                let path = serde_json::to_string(&workspace.join("payload.txt"))?;
                let cwd = serde_json::to_string(workspace)?;
                let command = serde_json::to_string(&command)?;
                Ok(Response {
                    content: String::new(),
                    tool_calls: vec![ToolCallRepr {
                        id: format!("mutate-{session_id}"),
                        r#type: "function".to_string(),
                        func_name: "eval".to_string(),
                        arguments: json!({
                            "program": format!(
                                "(eval (requires (tools write exec)) \
                                 (seq (bind created (call write (path {path}) \
                                 (content \"payload-{marker}\") (mode \"create\"))) \
                                 (call exec (command {command}) (cwd {cwd}) (wait_ms 20000))))"
                            )
                        })
                        .to_string(),
                    }],
                })
            }
            1 => {
                let marker = if session_id.ends_with("-a") { "a" } else { "b" };
                assert!(messages.iter().any(|message| {
                    message.role == "tool"
                        && message
                            .content
                            .contains(&format!("multi-target-exec-{marker}"))
                }));
                Ok(Response {
                    content: format!("physical-target-{marker}-complete"),
                    tool_calls: Vec::new(),
                })
            }
            _ => Err("a completed physical Target was evaluated again".into()),
        }
    }
}

struct AbortFixtureTasks(Vec<tokio::task::AbortHandle>);

impl Drop for AbortFixtureTasks {
    fn drop(&mut self) {
        for task in &self.0 {
            task.abort();
        }
    }
}

async fn exercise_two_physical_targets(store: Arc<dyn RuntimeStore>, root: &std::path::Path) {
    let workspaces = BTreeMap::from([
        ("session-physical-a".to_string(), root.join("node-a")),
        ("session-physical-b".to_string(), root.join("node-b")),
    ]);
    for workspace in workspaces.values() {
        tokio::fs::create_dir(workspace).await.unwrap();
    }
    let client = Arc::new(PhysicalTargetClient {
        workspaces: workspaces.clone(),
        calls: Mutex::new(BTreeMap::new()),
        ingress: tokio::sync::Barrier::new(2),
        release: root.join("release-both-execs"),
    });
    let mut config = AppConfig::default();
    if store.storage_backend_name() == "postgres" {
        config.storage.backend = crate::config::StorageBackend::Postgres;
    }
    config.permissions.mode = PermissionMode::FullAccess;
    config.permissions.workspace_root = root.to_string_lossy().into_owned();
    config.execution_targets.local_enabled = false;
    config.edge_execution.reconcile_interval = crate::config::HumanDuration::from_secs(1);
    config.edge_execution.node_stale_after = crate::config::HumanDuration::from_secs(3);
    config.background_task.artifact_dir = root.join("relay").to_string_lossy().into_owned();
    let secrets = Arc::new(
        SecretStore::new(
            root.join("central-secrets.json"),
            Arc::new(WebTestSecretBackend::default()),
        )
        .unwrap(),
    );
    let runtime = MorphzRuntime::builder(config, client.clone())
        .store("isolated-physical-contract", Arc::clone(&store))
        .secret_store(secrets)
        .tool_policy(RuntimeToolPolicy {
            context_only: false,
            coding_eval: true,
        })
        .build()
        .await
        .unwrap();
    runtime.start().await.unwrap();
    let principal_id = runtime.identity().principal_id.clone();
    let sdk = MorphzSdk::new(runtime.clone());
    let gateway_token = api_id("physical-gateway");
    let (broadcast_tx, _) = broadcast::channel(16);
    let state = Arc::new(AppState {
        runtime: runtime.clone(),
        sdk: sdk.clone(),
        broadcast_tx,
        auth_token: Some(api_id("physical-operator")),
        gateway_token: Some(gateway_token.clone()),
        default_agent_id: runtime.identity().agent_id.clone(),
        default_context_id: runtime.identity().context_id.clone(),
        identity: ServerIdentityConfig {
            mode: ServerIdentityMode::TrustedGateway,
            provider_id: "physical-fixture".into(),
            service_token_env: "MORPHZ_API_TOKEN".into(),
        },
        core_config_path: None,
        managed_config_path: None,
    });
    // Mount existing authenticated production handlers, not fake Edge ACKs.
    let router = Router::new()
        .route("/api/edge/nodes", get(handle_list_execution_nodes))
        .route("/api/execution-targets", get(handle_list_execution_targets))
        .route(
            "/api/execution-targets/:target_id",
            get(handle_inspect_execution_target),
        )
        .route("/api/sessions", post(handle_create_session))
        .route(
            "/api/sessions/:session_id/messages",
            post(handle_send_message),
        )
        .route("/api/edge/pair", post(handle_pair_execution_node))
        .route(
            "/api/edge/nodes/:node_id/challenge",
            post(handle_create_execution_node_challenge),
        )
        .route(
            "/api/edge/nodes/:node_id/connect",
            post(handle_connect_execution_node),
        )
        .route(
            "/api/edge/nodes/:node_id/heartbeat",
            post(handle_heartbeat_execution_node),
        )
        .route(
            "/api/edge/nodes/:node_id/jobs/claim",
            post(handle_claim_edge_command),
        )
        .route(
            "/api/edge/nodes/:node_id/jobs/:job_id/heartbeat",
            post(handle_heartbeat_edge_command),
        )
        .route(
            "/api/edge/nodes/:node_id/jobs/:job_id/output",
            post(handle_append_edge_command_output),
        )
        .route(
            "/api/edge/nodes/:node_id/jobs/:job_id/finish",
            post(handle_finish_edge_command),
        )
        .route(
            "/api/edge/nodes/:node_id/jobs/:job_id/artifact/download",
            get(handle_download_edge_artifact),
        )
        .route(
            "/api/edge/nodes/:node_id/jobs/:job_id/artifact/upload",
            get(handle_inspect_edge_artifact_upload).put(handle_upload_edge_artifact),
        )
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let mut tasks = AbortFixtureTasks(vec![server.abort_handle()]);
    let (shutdown, shutdown_rx) = tokio::sync::watch::channel(false);
    let mut sessions = Vec::new();
    let mut workers = Vec::new();
    for (session_id, workspace) in &workspaces {
        let marker = if session_id.ends_with("-a") { "a" } else { "b" };
        let target_id = format!("target-physical-{marker}");
        let device = generate_device_identity().unwrap();
        let gateway = EdgeGatewayClient::new(format!("http://{address}")).unwrap();
        let code = sdk
            .create_node_pairing_code(
                &principal_id,
                CreateNodePairingCodeCommand {
                    expires_in_seconds: 60,
                },
            )
            .await
            .unwrap();
        let node = gateway
            .pair(PairExecutionNodeCommand {
                code: code.code,
                node_id: None,
                name: format!("Isolated physical node {marker}"),
                device_key_fingerprint: device.fingerprint.clone(),
                device_public_key: device.public_key.clone(),
                protocol_version: 1,
                platform: Some("same-machine-test".into()),
                capabilities: vec!["write".into(), "exec".into(), "transfer".into()],
                metadata: json!({"test": "two-physical-targets"}),
            })
            .await
            .unwrap()
            .node;
        let credentials = EdgeNodeCredentials {
            server_url: format!("http://{address}"),
            node_id: node.id.clone(),
            device_key_fingerprint: device.fingerprint,
            device_public_key: device.public_key,
            device_private_key_pkcs8: device.private_key_pkcs8,
        };
        credentials
            .save(&workspace.join("edge-credential.json"))
            .unwrap();
        let mut config = AppConfig::default();
        config.permissions.mode = PermissionMode::FullAccess;
        config.permissions.workspace_root = workspace.to_string_lossy().into_owned();
        config.background_task.artifact_dir =
            workspace.join("artifacts").to_string_lossy().into_owned();
        let node_runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient::default()))
            .database_path(workspace.join("edge.sqlite").to_string_lossy())
            .secret_store(Arc::new(
                SecretStore::new(
                    workspace.join("secrets.json"),
                    Arc::new(WebTestSecretBackend::default()),
                )
                .unwrap(),
            ))
            .build()
            .await
            .unwrap();
        let advertisement = EdgeNodeAdvertisement {
            platform: Some("same-machine-test".into()),
            capabilities: vec!["write".into(), "exec".into(), "transfer".into()],
            metadata: json!({"test": "two-physical-targets"}),
            targets: vec![ExecutionTargetRegistration {
                id: target_id.clone(),
                owner_principal_id: Some(principal_id.clone()),
                provider_node_id: Some(node.id.clone()),
                kind: ExecutionTargetKind::EdgeNode,
                name: format!("Physical Target {marker}"),
                status: ExecutionTargetStatus::Online,
                platform: Some("same-machine-test".into()),
                workspace_root: Some(workspace.to_string_lossy().into_owned()),
                capabilities: vec!["write".into(), "exec".into(), "transfer".into()],
                metadata: json!({"test": "two-physical-targets"}),
                policy_digest: node_runtime.execution_policy_digest(),
                last_seen_at: Some(Utc::now()),
            }],
        };
        let worker = EdgeNodeWorker::new(
            gateway,
            credentials,
            advertisement,
            node_runtime,
            EdgeWorkerConfig {
                worker_id: format!("physical-worker-{marker}"),
                lease_seconds: 30,
                claim_wait_seconds: 1,
                heartbeat_interval: Duration::from_millis(50),
            },
        );
        worker.advertise().await.unwrap();
        let worker_shutdown = shutdown_rx.clone();
        let worker =
            tokio::spawn(async move { worker.run_until_shutdown(worker_shutdown).await.unwrap() });
        tasks.0.push(worker.abort_handle());
        workers.push(worker.abort_handle());
        let session = runtime
            .ensure_session(NewSession {
                id: session_id.clone(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: format!("Physical work {marker}"),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        sessions.push((session, target_id, node.id));
    }
    let (a, b) = (&sessions[0], &sessions[1]);
    let base = format!("http://{address}");
    let human_client = |principal: &str| {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {gateway_token}").parse().unwrap(),
        );
        headers.insert("x-morphz-principal", principal.parse().unwrap());
        reqwest::Client::builder()
            .default_headers(headers)
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap()
    };
    let owner = human_client(&principal_id);
    let nodes: Value = owner
        .get(format!("{base}/api/edge/nodes"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(nodes["nodes"].as_array().unwrap().len(), 2);
    for (_, _, node_id) in &sessions {
        assert!(nodes["nodes"].as_array().unwrap().iter().any(|node| {
            node["id"] == *node_id
                && node["owner_principal_id"] == principal_id
                && node["status"] == "online"
        }));
    }
    let targets: Value = owner
        .get(format!("{base}/api/execution-targets"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    for (_, target_id, node_id) in &sessions {
        assert!(targets["targets"].as_array().unwrap().iter().any(|target| {
            target["id"] == *target_id
                && target["provider_node_id"] == *node_id
                && target["owner_principal_id"] == principal_id
                && target["status"] == "online"
        }));
    }
    assert_eq!(
        reqwest::get(format!("{base}/api/edge/nodes"))
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    let foreign = human_client("physical-foreign-human");
    for (path, collection) in [
        ("/api/edge/nodes", "nodes"),
        ("/api/execution-targets", "targets"),
    ] {
        let body: Value = foreign
            .get(format!("{base}{path}"))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        let entries = body[collection].as_array().unwrap();
        if collection == "nodes" {
            assert!(entries.is_empty());
        } else {
            // Runtime-global Targets are deliberately public directory entries;
            // this identity must not see either private paired Target.
            assert!(entries.iter().all(|entry| {
                entry["owner_principal_id"].is_null() && entry["id"] != a.1 && entry["id"] != b.1
            }));
        }
    }
    for (_, target_id, _) in &sessions {
        assert_eq!(
            foreign
                .get(format!("{base}/api/execution-targets/{target_id}"))
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::FORBIDDEN
        );
    }
    let foreign_session = foreign
        .post(format!("{base}/api/sessions"))
        .json(&json!({
            "id": "session-physical-foreign",
            "mount": {"type": "new_blank_context", "context_id": "context-physical-foreign"}
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(foreign_session.status(), reqwest::StatusCode::CREATED);
    let rejected = foreign
        .post(format!(
            "{base}/api/sessions/session-physical-foreign/messages"
        ))
        .json(&json!({
            "text": "mutate the foreign target", "target_id": a.1,
            "client_message_id": "physical-forbidden-input"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(rejected.status(), reqwest::StatusCode::FORBIDDEN);
    assert!(runtime
        .list_execution_jobs(ExecutionJobFilter {
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap()
        .is_empty());
    assert!(client.calls.lock().unwrap().is_empty());
    let (receipt_a, receipt_b) = tokio::join!(
        a.0.send_as_principal_with_options(
            "mutate Target a",
            "Test-Human",
            principal_id.clone(),
            Some("physical-input-a".into()),
            SessionMessageOptions {
                target_id: Some(a.1.clone()),
                ..Default::default()
            }
        ),
        b.0.send_as_principal_with_options(
            "mutate Target b",
            "Test-Human",
            principal_id.clone(),
            Some("physical-input-b".into()),
            SessionMessageOptions {
                target_id: Some(b.1.clone()),
                ..Default::default()
            }
        ),
    );
    let receipts = [receipt_a.unwrap(), receipt_b.unwrap()];
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let jobs = runtime
                .list_execution_jobs(ExecutionJobFilter {
                    include_terminal: true,
                    ..Default::default()
                })
                .await
                .unwrap();
            let running = jobs
                .iter()
                .filter(|job| job.tool_name == "exec" && job.status == ExecutionJobStatus::Running)
                .count();
            if running == 2
                && workspaces
                    .values()
                    .all(|workspace| workspace.join("started").is_file())
            {
                assert!(jobs
                    .iter()
                    .filter(|job| job.tool_name == "exec")
                    .all(|job| job.side_effect_started_at.is_some()));
                break;
            }
            assert!(
                jobs.iter().all(|job| !matches!(
                    job.status,
                    ExecutionJobStatus::Failed | ExecutionJobStatus::Lost
                )),
                "physical Jobs failed: {jobs:#?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("both real exec Jobs must overlap before release");
    tokio::fs::write(&client.release, "release").await.unwrap();
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let jobs = runtime
                .list_execution_jobs(ExecutionJobFilter {
                    include_terminal: true,
                    ..Default::default()
                })
                .await
                .unwrap();
            if jobs.len() == 4
                && jobs.iter().all(|job| {
                    job.status == ExecutionJobStatus::Succeeded && job.result_event_id.is_some()
                })
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("write and exec must produce four actual durable successful Jobs");
    for (index, (session, target, node)) in sessions.iter().enumerate() {
        let thread = store
            .get_thread_by_root(&receipts[index].event_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(thread.target_id.as_deref(), Some(target.as_str()));
        let jobs = runtime
            .list_execution_jobs(ExecutionJobFilter {
                session_id: Some(session.id().into()),
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(jobs.len(), 2);
        for job in &jobs {
            assert_eq!(job.target_id, *target);
            assert_eq!(job.thread_id, thread.id);
            assert_eq!(
                job.initiating_principal_id.as_deref(),
                Some(principal_id.as_str())
            );
            let command = store.get_edge_command(&job.id).await.unwrap().unwrap();
            assert_eq!(command.provider_node_id, *node);
            assert_eq!(command.target_id, *target);
            assert_eq!(command.status, crate::memory::EdgeCommandStatus::Succeeded);
        }
        let workspace = &workspaces[session.id()];
        let marker = if index == 0 { "a" } else { "b" };
        assert_eq!(
            tokio::fs::read_to_string(workspace.join("payload.txt"))
                .await
                .unwrap(),
            format!("payload-{marker}")
        );
        assert_eq!(
            tokio::fs::read_to_string(workspace.join("exec.txt"))
                .await
                .unwrap(),
            format!("exec-{marker}")
        );
    }
    let source = workspaces["session-physical-a"].join("payload.txt");
    let destination = workspaces["session-physical-b"].join("from-a.txt");
    let digest = format!("sha256:{:x}", Sha256::digest(b"payload-a"));
    let request = ArtifactTransferRequest {
        transfer_id: "physical-target-explicit-transfer".into(),
        source: ArtifactLocation {
            target_id: a.1.clone(),
            workspace_identity: None,
            path: source.to_string_lossy().into_owned(),
        },
        destination: ArtifactLocation {
            target_id: b.1.clone(),
            workspace_identity: None,
            path: destination.to_string_lossy().into_owned(),
        },
        overwrite: ArtifactOverwritePolicy::Deny,
        expected_source_digest: Some(digest.clone()),
        media_type: Some("text/plain".into()),
        origin: None,
    };
    let transfer = runtime
        .submit_artifact_transfer(&principal_id, a.0.id(), request.clone())
        .await
        .unwrap();
    let terminal = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let job = runtime
                .get_execution_job(&transfer.job.id)
                .await
                .unwrap()
                .unwrap();
            if job.status.is_terminal() {
                break job;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        terminal.status,
        ExecutionJobStatus::Succeeded,
        "real Edge relay failed: {terminal:#?}"
    );
    let bytes = tokio::fs::read(&destination).await.unwrap();
    assert_eq!(bytes, b"payload-a");
    assert_eq!(format!("sha256:{:x}", Sha256::digest(&bytes)), digest);
    let outputs = store
        .query(QueryFilter {
            event_id: terminal.result_event_id.clone(),
            top_k: Some(2),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(outputs.len(), 1);
    let output = &outputs[0];
    assert_eq!(output.payload["tool_status"], "success");
    let persisted_receipt: ArtifactTransferReceipt =
        serde_json::from_str(output.payload["text"].as_str().unwrap()).unwrap();
    persisted_receipt.validate_against(&request).unwrap();
    assert_eq!(persisted_receipt.source.location, request.source);
    assert_eq!(persisted_receipt.destination.location, request.destination);
    assert_eq!(persisted_receipt.transport, "edge_relay_channel");
    assert_eq!(persisted_receipt.bytes_transferred, bytes.len() as u64);
    assert_eq!(
        persisted_receipt.source.content_digest.as_deref(),
        Some(digest.as_str())
    );
    assert_eq!(
        persisted_receipt.destination.content_digest.as_deref(),
        Some(digest.as_str())
    );
    let routes = crate::execution_target::artifact_transfer_routes_from_job(&terminal).unwrap();
    assert_eq!(routes.source.target_id, a.1);
    assert_eq!(
        routes.source.provider_node_id.as_deref(),
        Some(a.2.as_str())
    );
    assert_eq!(routes.destination.target_id, b.1);
    assert_eq!(
        routes.destination.provider_node_id.as_deref(),
        Some(b.2.as_str())
    );
    let before = tokio::fs::metadata(&destination)
        .await
        .unwrap()
        .modified()
        .unwrap();
    let before_jobs = runtime
        .list_execution_jobs(ExecutionJobFilter {
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap();
    let replay = runtime
        .submit_artifact_transfer(&principal_id, a.0.id(), request)
        .await
        .unwrap();
    assert_eq!(replay.job.id, transfer.job.id);
    assert_eq!(replay.thread.id, transfer.thread.id);
    assert_eq!(replay.activation.id, transfer.activation.id);
    assert_eq!(
        replay.request_event_sequence,
        transfer.request_event_sequence
    );
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        tokio::fs::metadata(&destination)
            .await
            .unwrap()
            .modified()
            .unwrap(),
        before
    );
    assert_eq!(
        runtime
            .list_execution_jobs(ExecutionJobFilter {
                include_terminal: true,
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        before_jobs.len()
    );
    assert_eq!(tokio::fs::read(&destination).await.unwrap(), bytes);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if client.calls.lock().unwrap().values().sum::<usize>() == 4 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(client
        .calls
        .lock()
        .unwrap()
        .values()
        .all(|count| *count == 2));
    // Stop only A's actual Worker. The existing configured reconciler must
    // expire its heartbeat without SQL status mutation; B remains connected.
    workers[0].abort();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let nodes: Value = owner
                .get(format!("{base}/api/edge/nodes"))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json()
                .await
                .unwrap();
            let targets: Value = owner
                .get(format!("{base}/api/execution-targets"))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json()
                .await
                .unwrap();
            let node_status = |id: &str, status: &str| {
                nodes["nodes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|node| node["id"] == id && node["status"] == status)
            };
            let target_status = |id: &str, status: &str| {
                targets["targets"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|target| target["id"] == id && target["status"] == status)
            };
            if node_status(&a.2, "offline")
                && node_status(&b.2, "online")
                && target_status(&a.1, "offline")
                && target_status(&b.1, "online")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("stopped Node A did not become offline while live Node B stayed online");
    eprintln!("PASS: authenticated Human HTTP discovery fences foreign reads/execution; stopping only Worker A expires its real heartbeat and exposes A offline, B online.");
    shutdown.send(true).unwrap();
    eprintln!("PASS: same-machine two real Target write/exec Jobs overlap; immutable target/node authority and files stay separate; explicit Edge relay digest/receipt and replay preserve the destination. Synthetic provider only.");
}

#[tokio::test]
async fn sqlite_two_targets_execute_physical_jobs_and_transfer_actual_bytes() {
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(
        SqliteStore::new(root.path().join("central.sqlite").to_str().unwrap())
            .await
            .unwrap(),
    );
    exercise_two_physical_targets(store, root.path()).await;
}

#[tokio::test]
async fn postgres_two_targets_execute_physical_jobs_and_transfer_actual_bytes_when_configured() {
    let Ok(url) = std::env::var("MORPHZ_TEST_POSTGRES_URL") else {
        return;
    };
    let root = tempfile::tempdir().unwrap();
    let schema = format!(
        "morphz_physical_targets_{}_{}",
        std::process::id(),
        Utc::now().timestamp_nanos_opt().unwrap()
    );
    let admin = sqlx::PgPool::connect(&url).await.unwrap();
    // Assertions may panic after DDL or physical execution. Keep the cleanup
    // outside that unwind boundary, and never address another fixture's schema.
    let outcome = AssertUnwindSafe(async {
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&admin)
            .await
            .unwrap();
        let separator = if url.contains('?') { '&' } else { '?' };
        let scoped = format!("{url}{separator}options=-csearch_path%3D{schema}%2Cpublic");
        let store = Arc::new(
            crate::memory::postgres::PostgresStore::new(&scoped, 8)
                .await
                .unwrap(),
        );
        let exercise = AssertUnwindSafe(exercise_two_physical_targets(store.clone(), root.path()))
            .catch_unwind()
            .await;
        tokio::time::timeout(Duration::from_secs(10), store.pool().close())
            .await
            .expect("physical Target fixture pool did not close");
        if let Err(panic) = exercise {
            std::panic::resume_unwind(panic);
        }
    })
    .catch_unwind()
    .await;
    let cleanup = tokio::time::timeout(
        Duration::from_secs(10),
        sqlx::query(&format!("DROP SCHEMA IF EXISTS {schema} CASCADE")).execute(&admin),
    )
    .await;
    let remaining = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1)",
    )
    .bind(&schema)
    .fetch_one(&admin)
    .await;
    admin.close().await;
    cleanup
        .expect("physical Target fixture schema cleanup timed out")
        .expect("physical Target fixture schema cleanup failed");
    assert!(!remaining.expect("could not verify physical Target fixture schema cleanup"));
    eprintln!("CLEANUP: removed only this fixture schema {schema}; both PostgreSQL pools closed.");
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}
