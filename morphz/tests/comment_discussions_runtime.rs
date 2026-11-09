//! Isolated real Runtime/Session IO/scheduler contract. Model replies are
//! scripted; no business task or external Provider is used.
use morphz::{
    config::AppConfig,
    discussion::TimelineScope,
    llm::{Client, Message, Response, ToolDefinition},
    memory::{NewSession, QueryFilter, SessionMountKind},
    runtime::MorphzRuntime,
    session_io::{Limits, Request},
};
use serde_json::json;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

struct Model {
    inputs: Mutex<Vec<Vec<Message>>>,
    started: tokio::sync::Semaphore,
    release: tokio::sync::Semaphore,
}
impl Default for Model {
    fn default() -> Self {
        Self {
            inputs: Mutex::new(Vec::new()),
            started: tokio::sync::Semaphore::new(0),
            release: tokio::sync::Semaphore::new(0),
        }
    }
}
#[async_trait::async_trait]
impl Client for Model {
    async fn create_completion(
        &self,
        messages: Vec<Message>,
        _: Vec<ToolDefinition>,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        self.inputs.lock().unwrap().push(messages);
        self.started.add_permits(1);
        self.release.acquire().await.unwrap().forget();
        Ok(Response {
            content: "TEST discussion result".into(),
            tool_calls: vec![],
        })
    }
}
fn request(id: &str, discussion: Option<(&str, bool)>, parallel: bool) -> Request {
    let mut value = json!({"io_version":"1","client_message_id":id,
        "message":{"format":{"id":"morphz.chat","version":"1"},"content":{"encoding":"utf8","value":"TEST question about the selected phrase"}},
        "activation":{"dispatch_mode":if parallel {"parallel"} else {"interrupt"}}});
    if let Some((discussion, first)) = discussion {
        value["discussion"] = if first {
            json!({"id":discussion,"source":{"key":"source:runtime-fixture","title":"TEST source","text":"Original selected phrase","locator":{"kind":"test-snapshot"}},"publish_to_session":false})
        } else {
            json!({"id":discussion})
        };
    }
    Request::parse(value.to_string().as_bytes(), &Limits::default()).unwrap()
}
async fn arrived(model: &Model, count: u32) {
    tokio::time::timeout(Duration::from_secs(20), model.started.acquire_many(count))
        .await
        .expect("parallel inputs must reach independent Evaluations")
        .unwrap()
        .forget();
}
async fn reply(runtime: &MorphzRuntime, root: &str) {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if !runtime
                .query_events(QueryFilter {
                    root_turn_id: Some(root.into()),
                    topic: Some("chat/reply".into()),
                    latest_k: Some(1),
                    ..Default::default()
                })
                .await
                .unwrap()
                .is_empty()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("scripted Evaluation did not publish its reply");
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_discussions_keep_native_context_and_main_interrupt_ownership() {
    let directory = tempfile::tempdir().unwrap();
    let mut config = AppConfig::default();
    config.permissions.workspace_root = directory.path().to_string_lossy().into_owned();
    config.background_task.artifact_dir = directory
        .path()
        .join("artifacts")
        .to_string_lossy()
        .into_owned();
    let model = Arc::new(Model::default());
    let runtime = MorphzRuntime::builder(config, model.clone())
        .database_path(directory.path().join("runtime.sqlite").to_string_lossy())
        .build()
        .await
        .unwrap();
    runtime.start().await.unwrap();
    let session = runtime
        .ensure_session(NewSession {
            id: "discussion-runtime".into(),
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            parent_session_id: None,
            title: "TEST discussions".into(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    let principal = &runtime.identity().principal_id;
    let a = request("discussion-a", Some(("discussion-a", true)), true);
    let b = request("discussion-b", Some(("discussion-b", true)), true);
    let (a, b) = tokio::join!(
        session.send_io_as_principal(a.clone(), principal),
        session.send_io_as_principal(b, principal)
    );
    let a = a.unwrap();
    let b = b.unwrap();
    arrived(&model, 2).await;
    let prompts = model
        .inputs
        .lock()
        .unwrap()
        .iter()
        .flatten()
        .map(|message| message.content.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        prompts.contains("discussion-id")
            && prompts.contains("discussion-a")
            && prompts.contains("discussion-b")
    );
    model.release.add_permits(2);
    tokio::join!(reply(&runtime, &a.id), reply(&runtime, &b.id));
    for (id, root) in [("discussion-a", &a.id), ("discussion-b", &b.id)] {
        let page = runtime
            .query_scoped_session_timeline(
                session.id(),
                Some(principal),
                &TimelineScope::Discussion { id: id.into() },
                None,
                20,
                true,
            )
            .await
            .unwrap();
        assert_eq!(page.len(), 2);
        assert!(page.iter().all(|item| &item.root_turn_id == root));
    }
    assert_eq!(
        session
            .send_io_as_principal(
                request("discussion-a", Some(("discussion-a", true)), true),
                principal
            )
            .await
            .unwrap()
            .id,
        a.id,
        "retry must retain the native receipt"
    );
    let next = session
        .send_io_as_principal(
            request("discussion-a-next", Some(("discussion-a", false)), true),
            principal,
        )
        .await
        .unwrap();
    arrived(&model, 1).await;
    let main = session
        .send_io_as_principal(request("main-input", None, false), principal)
        .await
        .unwrap();
    arrived(&model, 1).await;
    let active = runtime
        .session_thread_by_root(session.id(), &next.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        active.lifecycle.as_str(),
        "open",
        "a main interrupt must not cancel an independent discussion"
    );
    model.release.add_permits(2);
    tokio::join!(reply(&runtime, &next.id), reply(&runtime, &main.id));
    let main_page = runtime
        .query_scoped_session_timeline(
            session.id(),
            Some(principal),
            &TimelineScope::Main,
            None,
            20,
            true,
        )
        .await
        .unwrap();
    assert_eq!(main_page.len(), 2);
    assert!(main_page.iter().all(|item| item.root_turn_id == main.id));
    let a_page = runtime
        .query_scoped_session_timeline(
            session.id(),
            Some(principal),
            &TimelineScope::Discussion {
                id: "discussion-a".into(),
            },
            None,
            20,
            true,
        )
        .await
        .unwrap();
    assert_eq!(a_page.len(), 4);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discussion_http_history_live_stream_and_reconnect_keep_bodies_in_their_native_scope() {
    use morphz::web::{Server, ServerDefaults};
    let directory = tempfile::tempdir().unwrap();
    let mut config = AppConfig::default();
    config.permissions.workspace_root = directory.path().to_string_lossy().into_owned();
    config.background_task.artifact_dir = directory
        .path()
        .join("artifacts")
        .to_string_lossy()
        .into_owned();
    let model = Arc::new(Model::default());
    let runtime = MorphzRuntime::builder(config, model.clone())
        .database_path(directory.path().join("runtime.sqlite").to_string_lossy())
        .build()
        .await
        .unwrap();
    runtime.start().await.unwrap();
    let session = runtime
        .ensure_session(NewSession {
            id: "discussion-http".into(),
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            parent_session_id: None,
            title: "TEST discussion transport".into(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    let principal = &runtime.identity().principal_id;
    let server = Server::new(
        runtime.clone(),
        ServerDefaults {
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
        },
    );
    let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = reservation.local_addr().unwrap().to_string();
    drop(reservation);
    let url = format!("http://{address}");
    let handle = tokio::spawn(async move {
        server
            .start_with_dashboard_token(&address, Some("discussion-test-token".into()))
            .await
            .unwrap()
    });
    let client = reqwest::Client::new();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if client
                .get(format!("{url}/api/session-io/capabilities"))
                .bearer_auth("discussion-test-token")
                .send()
                .await
                .is_ok()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let a = session
        .send_io_as_principal(
            request("discussion-a", Some(("discussion-a", true)), true),
            principal,
        )
        .await
        .unwrap();
    let b = session
        .send_io_as_principal(
            request("discussion-b", Some(("discussion-b", true)), true),
            principal,
        )
        .await
        .unwrap();
    arrived(&model, 2).await;
    let base = format!("{url}/api/sessions/{}", session.id());
    async fn json(client: &reqwest::Client, url: String) -> serde_json::Value {
        client
            .get(url)
            .bearer_auth("discussion-test-token")
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
    }
    let main = json(
        &client,
        format!("{base}/events?scope=main&conversation_only=true&limit=20"),
    )
    .await;
    assert_eq!(
        main["events"],
        json!([]),
        "main conversation must not read hidden discussion bodies"
    );
    let page = json(
        &client,
        format!(
            "{base}/timeline?scope=discussion&discussion_id=discussion-a&text_only=true&limit=20"
        ),
    )
    .await;
    assert_eq!(page["entries"].as_array().unwrap().len(), 1);
    assert_eq!(page["entries"][0]["root_turn_id"], a.id);
    let raw = json(
        &client,
        format!("{base}/events?scope=discussion&discussion_id=discussion-a&limit=50"),
    )
    .await;
    assert!(!raw.to_string().contains(&b.id));
    let head = json(&client, format!("{base}/events?head_only=true")).await;
    assert!(
        head.get("events")
            .is_none_or(|events| events.as_array().unwrap().is_empty()),
        "metadata head must not materialize Event bodies"
    );
    let io = json(
        &client,
        format!("{base}/io/events?scope=discussion&discussion_id=discussion-a"),
    )
    .await;
    assert!(io.to_string().contains(&a.id));
    assert!(!io.to_string().contains(&b.id));
    let missing = client
        .get(format!(
            "{base}/timeline?scope=discussion&discussion_id=unavailable"
        ))
        .bearer_auth("discussion-test-token")
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), 404);
    async fn until(response: &mut reqwest::Response, needle: &str) -> String {
        tokio::time::timeout(Duration::from_secs(10), async {
            let mut body = String::new();
            while !body.contains(needle) {
                let bytes = response.chunk().await.unwrap().expect("stream ended early");
                body.push_str(&String::from_utf8_lossy(&bytes));
            }
            body
        })
        .await
        .expect("scoped SSE did not deliver expected data")
    }
    let mut stream = client
        .get(format!(
            "{base}/io/stream?scope=discussion&discussion_id=discussion-a"
        ))
        .bearer_auth("discussion-test-token")
        .send()
        .await
        .unwrap();
    let opened = until(&mut stream, "stream.opened").await;
    assert!(opened.contains("\"inputId\":\"discussion-a\""));
    assert!(opened.contains("\"phase\":\"model\""));
    assert!(!opened.contains(&b.id));
    runtime
        .publish(morphz::event::Event::new(
            "fixture-reasoning-before-text".into(),
            "TEST".into(),
            "runtime_control".into(),
            "runtime/model_attempt_state".into(),
            serde_json::from_value(json!({
                "context_id":runtime.identity().context_id,
                "session_id":session.id(),
                "root_turn_id":a.id,
                "state":"reasoning",
                "terminal":false,
                "detail":"PRIVATE_DIAGNOSTIC_SENTINEL",
            }))
            .unwrap(),
        ))
        .await
        .unwrap();
    let thinking = until(&mut stream, "\"phase\":\"reasoning\"").await;
    assert!(!thinking.contains("PRIVATE_DIAGNOSTIC_SENTINEL"));
    assert!(!thinking.contains(&b.id));
    let draft = |root: &str, attempt: &str, kind: &str, text: &str| {
        morphz::event::Event::new(format!("fixture-{attempt}-{kind}"),"TEST".into(),"agent_call".into(),"runtime/model_stream".into(),serde_json::from_value(json!({"context_id":runtime.identity().context_id,"session_id":session.id(),"root_turn_id":root,"model_attempt_id":attempt,"stream":{"kind":kind,"text":text}})).unwrap())
    };
    for (root, attempt, text) in [
        (&a.id, "a-transport", "DISCUSSION_A_ONLY"),
        (&b.id, "b-transport", "DISCUSSION_B_ONLY"),
    ] {
        runtime
            .publish(draft(root, attempt, "started", ""))
            .await
            .unwrap();
        runtime
            .publish(draft(root, attempt, "text_delta", text))
            .await
            .unwrap();
    }
    let delivered = until(&mut stream, "DISCUSSION_A_ONLY").await;
    assert!(!delivered.contains("DISCUSSION_B_ONLY"));
    drop(stream);
    let mut resumed = client
        .get(format!(
            "{base}/io/stream?scope=discussion&discussion_id=discussion-a"
        ))
        .bearer_auth("discussion-test-token")
        .send()
        .await
        .unwrap();
    let snapshot = until(&mut resumed, "DISCUSSION_A_ONLY").await;
    assert!(snapshot.contains("\"snapshot\":true"));
    assert!(snapshot.contains("\"phase\":\"reasoning\""));
    assert!(!snapshot.contains("DISCUSSION_B_ONLY"));
    let mut main_stream = client
        .get(format!("{base}/io/stream?scope=main"))
        .bearer_auth("discussion-test-token")
        .send()
        .await
        .unwrap();
    let main_snapshot = until(&mut main_stream, "stream.opened").await;
    assert!(
        !main_snapshot.contains("DISCUSSION_A_ONLY")
            && !main_snapshot.contains("DISCUSSION_B_ONLY")
            && !main_snapshot.contains("discussionActivity")
    );
    drop(main_stream);
    model.release.add_permits(2);
    let settled = until(&mut resumed, "\"phase\":\"settled\"").await;
    assert!(!settled.contains(&b.id));
    drop(resumed);
    handle.abort();
}
