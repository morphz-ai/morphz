#![cfg(feature = "remote-store")]
use morphz::event::Event;
use morphz::llm::{Client, Message, Response, ToolDefinition};
use morphz::memory::remote::{http::HttpRemoteStoreTransport, protocol::*, RemoteRuntimeStore};
use morphz::memory::{EventStore, QueryFilter};
use morphz::memory::{
    NewAgent, NewCognitiveContext, NewSession, SessionDirectoryStore, SessionMountKind,
};
use serde_json::json;
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc,
};
use tokio::sync::Notify;

struct FaultTransport {
    inner: HttpRemoteStoreTransport,
    fault: AtomicU8,
    entered: Notify,
    pending: Notify,
}

#[async_trait::async_trait]
impl RemoteStoreTransport for FaultTransport {
    async fn head(&self, fence: &Fence) -> Result<Head, StoreError> {
        self.inner.head(fence).await
    }
    async fn page(
        &self,
        fence: &Fence,
        revision: u64,
        after: Option<&str>,
    ) -> Result<Page, StoreError> {
        self.inner.page(fence, revision, after).await
    }
    async fn commit(&self, fence: &Fence, request: &Commit) -> Result<Head, StoreError> {
        let fault = self.fault.swap(0, Ordering::SeqCst);
        if fault == 1 {
            self.entered.notify_one();
            self.pending.notified().await;
        }
        let result = self.inner.commit(fence, request).await?;
        if fault == 2 {
            self.entered.notify_one();
            self.pending.notified().await;
        }
        if fault == 3 {
            return Err("injected response loss after durable commit".into());
        }
        Ok(result)
    }
}

fn event(id: &str) -> Event {
    Event::new(
        id.into(),
        "remote-recovery-test".into(),
        "test".into(),
        "test/remote".into(),
        json!({"text":"durable"}).as_object().unwrap().clone(),
    )
}

fn transport(label: &str) -> HttpRemoteStoreTransport {
    let base = std::env::var("MORPHZ_TEST_REMOTE_STORE_URL").expect("real workerd URL is required");
    HttpRemoteStoreTransport::new(&format!("{base}{label}"), "conformance-only").unwrap()
}
fn fence() -> Fence {
    Fence {
        owner_id: "runtime-conformance-owner".into(),
        epoch: 1,
    }
}

// Match the hosted binary's multi-thread runtime: synchronous credential I/O
// yields its Tokio worker so the independent compute lease can keep renewing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the real Agent Cell credential workerd conformance server"]
async fn credential_refresh_uses_captured_generation_across_key_rotation_and_new_login() {
    use morphz::memory::remote::host_credentials::HostCredentialBackend;
    use morphz::secret_store::{SecretScopeKind, SecretStore, SecretUseContext};
    let base = std::env::var("MORPHZ_TEST_REMOTE_STORE_URL").unwrap();
    let id = format!(
        "native-credentials-{}",
        chrono::Utc::now().timestamp_nanos_opt().unwrap()
    );
    let endpoint = format!(
        "{}{id}",
        base.replace("/runtime-store/", "/managed-runtime-store/")
    );
    let store = RemoteRuntimeStore::connect_owned(Arc::new(
        HttpRemoteStoreTransport::new(&endpoint, "conformance-only").unwrap(),
    ))
    .await
    .unwrap();
    let fence = store.compute_fence();
    let lost = store.ownership_flag();
    let endpoint = format!("{}{id}", base.replace("/runtime-store/", "/credentials/"));
    let backend = Arc::new(
        HostCredentialBackend::new(
            &endpoint,
            "conformance-only",
            fence.clone(),
            lost.clone(),
            false,
        )
        .unwrap(),
    );
    tokio::task::spawn_blocking(move || {
        let secrets = SecretStore::managed(backend).unwrap();
        secrets.put("TOKEN", "initial", SecretScopeKind::Runtime, None).unwrap();
        let snapshot = secrets.snapshot_for_update("TOKEN", SecretUseContext::default(), None).unwrap();
        let client = reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(5)).build().unwrap();
        let mutation = |operation: &str, expected: u64, request_id: &str, value: Option<&str>| {
            let mut body = json!({"protocol":"morphz-host-credentials/1", "fence":fence, "operation":operation,
                "name":"TOKEN", "expectedRevision":expected, "requestId":request_id});
            if let Some(value) = value { body["value"] = json!(value); body["metadata"] = json!(secrets.list().unwrap()[0]); }
            let response = client.post(&endpoint).bearer_auth("conformance-only").json(&body).send().unwrap();
            assert!(response.status().is_success());
        };
        mutation("rotate", 1, "rotate", None);
        assert!(secrets.replace_if_unchanged(&snapshot, "refreshed").unwrap());
        assert_eq!(secrets.resolve("TOKEN", SecretUseContext::default()).unwrap().as_deref(), Some("refreshed"));
        let snapshot = secrets.snapshot_for_update("TOKEN", SecretUseContext::default(), None).unwrap();
        // An external authority change bypasses this SecretStore's local cache:
        // rejection must come from the real encrypted Cell CAS, not only a lock.
        mutation("write", 3, "login", Some("new-login"));
        assert!(!secrets.replace_if_unchanged(&snapshot, "stale-refresh").unwrap());
        assert!(!lost.load(Ordering::Acquire)); // Expected conflict is not lease loss.
        assert_eq!(secrets.resolve("TOKEN", SecretUseContext::default()).unwrap().as_deref(), Some("new-login"));
        mutation("delete", 4, "logout", None);
        assert!(!secrets.replace_if_unchanged(&snapshot, "revived").unwrap());
        mutation("write", 5, "reauthorize", Some("new-login"));
        assert!(!secrets.replace_if_unchanged(&snapshot, "stale-again").unwrap());
        assert!(!lost.load(Ordering::Acquire));
    }).await.unwrap();
}

struct SlowReadTransport {
    inner: HttpRemoteStoreTransport,
    delay: AtomicU8,
    renewals: std::sync::atomic::AtomicUsize,
}

#[async_trait::async_trait]
impl RemoteStoreTransport for SlowReadTransport {
    async fn head(&self, fence: &Fence) -> Result<Head, StoreError> {
        if self.delay.swap(0, Ordering::SeqCst) != 0 {
            tokio::time::sleep(std::time::Duration::from_secs(32)).await;
        }
        self.inner.head(fence).await
    }
    async fn page(
        &self,
        fence: &Fence,
        revision: u64,
        after: Option<&str>,
    ) -> Result<Page, StoreError> {
        self.inner.page(fence, revision, after).await
    }
    async fn commit(&self, fence: &Fence, request: &Commit) -> Result<Head, StoreError> {
        self.inner.commit(fence, request).await
    }
}
#[async_trait::async_trait]
impl RemoteStoreLeaseTransport for SlowReadTransport {
    async fn park(
        &self,
        fence: &Fence,
        revision: u64,
        next_wake_at_ms: Option<i64>,
    ) -> Result<morphz::memory::remote::protocol::ParkReceipt, StoreError> {
        self.inner.park(fence, revision, next_wake_at_ms).await
    }
    async fn claim(&self, owner_id: &str) -> Result<Lease, StoreError> {
        self.inner.claim(owner_id).await
    }
    async fn renew(&self, fence: &Fence) -> Result<Lease, StoreError> {
        self.renewals.fetch_add(1, Ordering::SeqCst);
        self.inner.renew(fence).await
    }
    async fn complete_recovery(&self, fence: &Fence) -> Result<(), StoreError> {
        self.inner.complete_recovery(fence).await
    }
}

#[tokio::test]
#[ignore = "requires the real Agent Cell workerd conformance server; runs across its 30-second lease"]
async fn blocked_operation_does_not_starve_real_owner_renewal() {
    let base = std::env::var("MORPHZ_TEST_REMOTE_STORE_URL").expect("real workerd URL is required");
    let endpoint = format!(
        "{}long-read-{}",
        base.replace("/runtime-store/", "/managed-runtime-store/"),
        chrono::Utc::now().timestamp_nanos_opt().unwrap()
    );
    let transport = Arc::new(SlowReadTransport {
        inner: HttpRemoteStoreTransport::new(&endpoint, "conformance-only").unwrap(),
        delay: AtomicU8::new(0),
        renewals: std::sync::atomic::AtomicUsize::new(0),
    });
    let store = RemoteRuntimeStore::connect_owned(transport.clone())
        .await
        .unwrap();
    store.append(event("before-long-read")).await.unwrap();
    transport.delay.store(1, Ordering::SeqCst);
    assert_eq!(store.query(QueryFilter::default()).await.unwrap().len(), 1);
    assert!(transport.renewals.load(Ordering::SeqCst) >= 2);
    assert!(!store.ownership_lost());
    store.append(event("after-long-read")).await.unwrap();
}

#[tokio::test]
#[ignore = "requires the real Agent Cell workerd conformance server"]
async fn cancellation_and_ambiguous_commit_never_promote_a_speculative_replica() {
    let transport = Arc::new(FaultTransport {
        inner: transport(&format!(
            "cancel-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        )),
        fault: AtomicU8::new(0),
        entered: Notify::new(),
        pending: Notify::new(),
    });
    let store = Arc::new(
        RemoteRuntimeStore::connect(transport.clone(), fence())
            .await
            .unwrap(),
    );
    for (mode, id, expected) in [(1, "before-commit", false), (2, "after-commit", true)] {
        transport.fault.store(mode, Ordering::SeqCst);
        let writer = store.clone();
        let task = tokio::spawn(async move { writer.append(event(id)).await });
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            transport.entered.notified(),
        )
        .await
        .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        let events = store.query(QueryFilter::default()).await.unwrap();
        assert_eq!(
            events.iter().filter(|event| event.id == id).count(),
            usize::from(expected)
        );
    }
    transport.fault.store(3, Ordering::SeqCst);
    assert!(store.append(event("response-lost")).await.is_err());
    let events = store.query(QueryFilter::default()).await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.id == "response-lost")
            .count(),
        1
    );
    store.append(event("subsequent-operation")).await.unwrap();
    drop(store);
    let restored = RemoteRuntimeStore::connect(transport, fence())
        .await
        .unwrap();
    assert_eq!(
        restored.query(QueryFilter::default()).await.unwrap().len(),
        3
    );
}

#[test]
#[ignore = "requires the real Agent Cell workerd conformance server"]
fn new_rust_process_restores_from_cell_without_any_local_database() {
    if let Ok(label) = std::env::var("MORPHZ_REMOTE_RECOVERY_CHILD") {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let store = RemoteRuntimeStore::connect(Arc::new(transport(&label)), fence())
                .await
                .unwrap();
            if std::env::var("MORPHZ_REMOTE_RECOVERY_ACTION").unwrap() == "write" {
                store.append(event("process-exit-evidence")).await.unwrap();
            } else {
                assert_eq!(
                    store
                        .query(QueryFilter::default())
                        .await
                        .unwrap()
                        .iter()
                        .filter(|event| event.id == "process-exit-evidence")
                        .count(),
                    1
                );
            }
        });
        return;
    }
    let label = format!(
        "process-restart-{}",
        chrono::Utc::now().timestamp_nanos_opt().unwrap()
    );
    for action in ["write", "read"] {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "new_rust_process_restores_from_cell_without_any_local_database",
                "--ignored",
                "--nocapture",
            ])
            .env("MORPHZ_REMOTE_RECOVERY_CHILD", &label)
            .env("MORPHZ_REMOTE_RECOVERY_ACTION", action)
            .status()
            .unwrap();
        assert!(status.success(), "fresh {action} process failed");
    }
}

struct ReplyClient;
#[async_trait::async_trait]
impl Client for ReplyClient {
    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, StoreError> {
        Ok(Response {
            content: "remote-runtime-ok".into(),
            tool_calls: vec![],
        })
    }
}

#[tokio::test]
#[ignore = "requires the real Agent Cell workerd conformance server"]
async fn complete_runtime_starts_recovers_and_delivers_through_cell_store() {
    use morphz::config::AppConfig;
    use morphz::permission::{PermissionMode, ReviewerKind};
    use morphz::runtime::{MorphzRuntime, RuntimeIdentity, RuntimeToolPolicy};
    use morphz::secret_store::{HostEnvFileSecretBackend, SecretStore};
    let workspace = tempfile::tempdir().unwrap();
    let base = std::env::var("MORPHZ_TEST_REMOTE_STORE_URL").expect("real workerd URL is required");
    let endpoint = format!(
        "{}runtime-{}",
        base.replace("/runtime-store/", "/managed-runtime-store/"),
        chrono::Utc::now().timestamp_nanos_opt().unwrap()
    );
    let transport = Arc::new(HttpRemoteStoreTransport::new(&endpoint, "conformance-only").unwrap());
    let store = Arc::new(RemoteRuntimeStore::connect_owned(transport).await.unwrap());
    store
        .create_agent_bundle(
            NewAgent {
                id: "runtime-agent".into(),
                title: "Agent".into(),
                root_context_id: "runtime-context".into(),
            },
            NewCognitiveContext {
                id: "runtime-context".into(),
                agent_id: "runtime-agent".into(),
                title: "Context".into(),
            },
            NewSession {
                id: "runtime-session".into(),
                agent_id: "runtime-agent".into(),
                context_id: "runtime-context".into(),
                parent_session_id: None,
                title: "Session".into(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await
        .unwrap();
    let mut config = AppConfig::default();
    config.permissions.mode = PermissionMode::Custom;
    config.permissions.reviewer = ReviewerKind::Deny;
    config.permissions.workspace_root = workspace.path().to_string_lossy().into_owned();
    config.background_task.artifact_dir = workspace
        .path()
        .join("artifacts")
        .to_string_lossy()
        .into_owned();
    let secrets = Arc::new(
        SecretStore::new(
            workspace.path().join("secrets.json"),
            Arc::new(HostEnvFileSecretBackend::new(
                workspace.path().join("test.env"),
            )),
        )
        .unwrap(),
    );
    let runtime = MorphzRuntime::builder(config, Arc::new(ReplyClient))
        .store("remote:conformance", store.clone())
        .identity(RuntimeIdentity {
            agent_id: "runtime-agent".into(),
            context_id: "runtime-context".into(),
            principal_id: "runtime-principal".into(),
        })
        .tool_policy(RuntimeToolPolicy {
            context_only: true,
            coding_eval: true,
        })
        .secret_store(secrets)
        .build()
        .await
        .unwrap();
    runtime.start().await.unwrap();
    store.complete_recovery().await.unwrap();
    let mut replies = runtime.subscribe("chat/reply", 4);
    runtime
        .session("runtime-session")
        .send("hello", "Conformance", Some("remote-ingress-1".into()))
        .await
        .unwrap();
    let reply = tokio::time::timeout(std::time::Duration::from_secs(20), replies.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reply.payload["text"], "remote-runtime-ok");
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(200), replies.recv())
            .await
            .is_err()
    );
    let persisted = store
        .query(QueryFilter {
            topic: Some("chat/reply".into()),
            session_id: Some("runtime-session".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(persisted.len(), 1);
}
