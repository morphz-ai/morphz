//! Actual ingress, filesystem reads, SQLite Events/Jobs and model request assembly.
//! The model decisions are controlled; no external provider or user data is used.
use async_trait::async_trait;
use base64::Engine as _;
use morphz::{
    config::AppConfig,
    identity::PrincipalAssertion,
    llm::{
        model_attachments, model_visible_message_text, Client, Message, Response, ToolCallRepr,
        ToolDefinition,
    },
    memory::{NewSession, QueryFilter, SessionMountKind},
    permission::{PermissionConfig, PermissionMode},
    runtime::{MorphzRuntime, RuntimeToolPolicy, SessionMessageOptions},
    sdk::MessageAttachmentInput,
    tool::{ReadFileTool, Tool},
};
use serde_json::{json, Value};
use std::{
    error::Error,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tempfile::TempDir;

type DynError = Box<dyn Error + Send + Sync>;

fn call(id: &str, name: &str, arguments: Value) -> Response {
    Response {
        content: String::new(),
        tool_calls: vec![ToolCallRepr {
            id: id.into(),
            r#type: "function".into(),
            func_name: name.into(),
            arguments: arguments.to_string(),
        }],
    }
}

fn tool_receipt(messages: &[Message], id: &str) -> Value {
    let message = messages
        .iter()
        .find(|message| message.role == "tool" && message.tool_call_id.as_deref() == Some(id))
        .expect("the actual tool receipt must reach the model");
    serde_json::from_str(&message.content).unwrap()
}

struct AttachmentClient {
    workspace: PathBuf,
    image: bool,
    calls: AtomicUsize,
    requests: Mutex<Vec<Vec<Message>>>,
}

#[async_trait]
impl Client for AttachmentClient {
    fn supports_async_cancellation(&self) -> bool {
        true
    }
    fn model(&self) -> Option<String> {
        Some("progressive-fixture".into())
    }
    async fn create_completion(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, DynError> {
        let index = self.calls.fetch_add(1, Ordering::SeqCst);
        self.requests.lock().unwrap().push(messages.clone());
        let prompt = messages
            .iter()
            .map(model_visible_message_text)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            tools.iter().any(|tool| tool.name == "read"),
            "file size alone must not strand work in maintenance"
        );
        let name = if self.image { "pixel.png" } else { "long.txt" };
        let path = walkdir::WalkDir::new(self.workspace.join(".morphz/attachments"))
            .into_iter()
            .filter_map(Result::ok)
            .find(|entry| entry.file_name() == name)
            .expect("ingress must preserve a real readable workspace copy")
            .into_path();
        assert!(prompt.contains("workspace_path") && prompt.contains(name));
        match index {
            0 => {
                assert!(
                    messages
                        .iter()
                        .all(|message| model_attachments(message).is_none()),
                    "submitting an attachment is not a model read"
                );
                assert!(
                    !prompt.contains("HEAD_CONTENT_NOT_METADATA")
                        && !prompt.contains("TAIL_CONTENT_NOT_METADATA")
                );
                Ok(call("read-first", "read", json!({"path":path})))
            }
            1 if self.image => {
                let actual = messages
                    .iter()
                    .filter_map(model_attachments)
                    .flatten()
                    .collect::<Vec<_>>();
                assert_eq!(
                    actual.len(),
                    1,
                    "only the explicitly read image is delivered, never a second root-input copy"
                );
                assert_eq!(actual[0].name, "pixel.png");
                let bytes =
                    base64::engine::general_purpose::STANDARD.decode(&actual[0].data_base64)?;
                assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
                assert_eq!(tool_receipt(&messages, "read-first")["status"], "success");
                Ok(Response {
                    content: "Explicit image read verified.".into(),
                    tool_calls: vec![],
                })
            }
            1 => {
                assert!(messages
                    .iter()
                    .all(|message| model_attachments(message).is_none()));
                let result = tool_receipt(&messages, "read-first");
                let text = result["result"].as_str().unwrap();
                assert!(text.contains("HEAD_CONTENT_NOT_METADATA"));
                assert!(
                    text.chars().count() < 13_000,
                    "default read is physically bounded"
                );
                assert!(!text.contains("TAIL_CONTENT_NOT_METADATA"));
                assert!(text.contains("next_offset="));
                assert!(
                    !prompt.contains("TAIL_CONTENT_NOT_METADATA"),
                    "later Context assembly must not refill the file"
                );
                Ok(call(
                    "read-query",
                    "read",
                    json!({"path":path, "query":"TAIL_CONTENT_NOT_METADATA", "context_lines":0}),
                ))
            }
            2 => {
                assert!(messages
                    .iter()
                    .all(|message| model_attachments(message).is_none()));
                let result = tool_receipt(&messages, "read-query");
                assert!(result["result"]
                    .as_str()
                    .unwrap()
                    .contains("TAIL_CONTENT_NOT_METADATA"));
                Ok(Response {
                    content: "Explicit bounded text reads verified.".into(),
                    tool_calls: vec![],
                })
            }
            _ => panic!("unexpected maintenance or replay request {index}"),
        }
    }
}

async fn assert_attachment_is_read_only_on_request(image: bool, typed: bool) {
    let temp = TempDir::new().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let client = Arc::new(AttachmentClient {
        workspace: workspace.clone(),
        image,
        calls: AtomicUsize::new(0),
        requests: Mutex::new(vec![]),
    });
    let bytes = if image {
        base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap()
    } else {
        format!(
            "HEAD_CONTENT_NOT_METADATA\n{}\nTAIL_CONTENT_NOT_METADATA\n",
            "正文不是元数据。\n".repeat(40_000)
        )
        .into_bytes()
    };
    let original = bytes.clone();
    let mut config = AppConfig::default();
    config.llm.model = "progressive-fixture".into();
    config.permissions.mode = PermissionMode::FullAccess;
    config.permissions.workspace_root = workspace.to_string_lossy().into_owned();
    config.background_task.artifact_dir =
        temp.path().join("artifacts").to_string_lossy().into_owned();
    let read = Arc::new(ReadFileTool::new(Arc::new(PermissionConfig {
        mode: PermissionMode::FullAccess,
        workspace_root: workspace.to_string_lossy().into_owned(),
        ..Default::default()
    })));
    let runtime = MorphzRuntime::builder(config, client.clone() as Arc<dyn Client>)
        .database_path(temp.path().join("runtime.sqlite").to_string_lossy())
        .tool_policy(RuntimeToolPolicy {
            context_only: false,
            coding_eval: false,
        })
        .extra_tool(read)
        .build()
        .await
        .unwrap();
    runtime.start().await.unwrap();
    let session = runtime
        .ensure_session(NewSession {
            id: "progressive-session".into(),
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            parent_session_id: None,
            title: "Progressive disclosure".into(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    runtime
        .bind_session_principal(
            session.id(),
            PrincipalAssertion {
                principal_id: runtime.identity().principal_id.clone(),
                provider_id: "runtime-default".into(),
                assurance: "runtime-default".into(),
                display_name: None,
            },
        )
        .await
        .unwrap();
    let mut replies = runtime.subscribe("chat/reply", 4);
    let name = if image { "pixel.png" } else { "long.txt" };
    let media_type = if image { "image/png" } else { "text/plain" };
    let event_id = if typed {
        let stages = runtime.message_attachment_stages();
        stages
            .create(
                morphz::model_input::NewMessageAttachmentStage {
                    stage_id: "progressive-typed-stage".into(),
                    principal_id: runtime.identity().principal_id.clone(),
                    session_id: session.id().into(),
                    client_message_id: "progressive-input".into(),
                    name: name.into(),
                    media_type: media_type.into(),
                    size_bytes: bytes.len() as u64,
                    expected_sha256: None,
                },
                runtime.config().model_input.import_limits(),
            )
            .await
            .unwrap();
        stages
            .upload(
                &runtime.identity().principal_id,
                session.id(),
                "progressive-typed-stage",
                0,
                futures_util::stream::iter([Ok::<_, std::io::Error>(bytes)]),
            )
            .await
            .unwrap();
        let request = morphz::session_io::Request::parse(json!({
            "io_version":"1", "client_message_id":"progressive-input",
            "message":{"format":{"id":"morphz.chat","version":"1"},
                "content":{"encoding":"json","value":{"text":"Inspect the attached file with tools.",
                    "attachments":[{"stage_id":"progressive-typed-stage"}]}}}
        }).to_string().as_bytes(), &morphz::session_io::Limits::default()).unwrap();
        session
            .send_io_as_principal(request, &runtime.identity().principal_id)
            .await
            .unwrap()
            .id
    } else {
        session
            .send_as_principal_with_options(
                "Inspect the attached file with tools.",
                "Test",
                runtime.identity().principal_id.clone(),
                Some("progressive-input".into()),
                SessionMessageOptions {
                    attachments: vec![MessageAttachmentInput {
                        name: name.into(),
                        media_type: media_type.into(),
                        data: bytes,
                    }],
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .event_id
    };
    let reply = tokio::time::timeout(Duration::from_secs(20), replies.recv())
        .await
        .expect("bounded file inspection must finish without a maintenance loop")
        .unwrap();
    assert_eq!(
        reply.payload["text"],
        if image {
            "Explicit image read verified."
        } else {
            "Explicit bounded text reads verified."
        }
    );
    assert_eq!(
        client.calls.load(Ordering::SeqCst),
        if image { 2 } else { 3 }
    );
    let root = runtime
        .query_events(QueryFilter {
            event_id: Some(event_id),
            top_k: Some(1),
            ..Default::default()
        })
        .await
        .unwrap()
        .pop()
        .unwrap();
    let attachment = &root.payload["attachments"][0];
    if typed {
        assert_eq!(root.event_type, morphz::event::TYPE_SESSION_MESSAGE);
        assert!(!root.payload["session_io"]["binding"]["resources"]
            .as_array()
            .unwrap()
            .is_empty());
    }
    assert_eq!(
        tokio::fs::read(attachment["storage_path"].as_str().unwrap())
            .await
            .unwrap(),
        original
    );
    assert_eq!(
        tokio::fs::read(attachment["workspace_path"].as_str().unwrap())
            .await
            .unwrap(),
        original
    );
    assert!(!serde_json::to_string(&root.payload)
        .unwrap()
        .contains("HEAD_CONTENT_NOT_METADATA"));
}

#[tokio::test]
async fn large_text_attachment_is_metadata_until_agent_reads_bounded_pages() {
    assert_attachment_is_read_only_on_request(false, false).await;
}

#[tokio::test]
async fn image_attachment_is_metadata_until_agent_explicitly_reads_image() {
    assert_attachment_is_read_only_on_request(true, false).await;
}

#[tokio::test]
async fn typed_chat_text_stage_is_metadata_until_agent_reads_bounded_pages() {
    assert_attachment_is_read_only_on_request(false, true).await;
}

#[tokio::test]
async fn typed_chat_image_stage_is_metadata_until_agent_explicitly_reads_image() {
    assert_attachment_is_read_only_on_request(true, true).await;
}

struct LargeOutputTool;

#[async_trait]
impl Tool for LargeOutputTool {
    fn name(&self) -> &str {
        "fixture_report"
    }
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().into(),
            description: "Return synthetic persisted evidence for a disclosure regression.".into(),
            parameters: json!({"type":"object","properties":{}}),
        }
    }
    async fn execute(&self, _: &str) -> Result<String, DynError> {
        Ok(format!(
            "{}MIDDLE_EVIDENCE_NOT_IN_PREVIEW{}",
            "a".repeat(20_000),
            "z".repeat(20_000)
        ))
    }
}

struct LargeOutputClient {
    calls: AtomicUsize,
}

#[async_trait]
impl Client for LargeOutputClient {
    fn supports_async_cancellation(&self) -> bool {
        true
    }
    async fn create_completion(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, DynError> {
        match self.calls.fetch_add(1, Ordering::SeqCst) {
            0 => Ok(call("report", "fixture_report", json!({}))),
            1 => {
                let receipt = tool_receipt(&messages, "report");
                assert_eq!(receipt["truncated"], true);
                assert_eq!(receipt["total_chars"], 40_030);
                assert!(receipt["result"].as_str().unwrap().chars().count() <= 512);
                assert!(receipt["guidance"].as_str().unwrap().contains("recall"));
                assert!(messages
                    .iter()
                    .all(|m| !model_visible_message_text(m)
                        .contains("MIDDLE_EVIDENCE_NOT_IN_PREVIEW")));
                assert!(tools.iter().any(|tool| tool.name == "recall"));
                Ok(call(
                    "recall-middle",
                    "recall",
                    json!({
                        "event_id": receipt["observation_ref"], "offset": 20_000, "limit": 32,
                    }),
                ))
            }
            2 => {
                let receipt = tool_receipt(&messages, "recall-middle");
                assert_eq!(receipt["status"], "success");
                assert_eq!(receipt["truncated"], false);
                let page: Value = serde_json::from_str(receipt["result"].as_str().unwrap())?;
                assert_eq!(page["context_delivery"], "full-event-chunk");
                assert_eq!(page["text"], "MIDDLE_EVIDENCE_NOT_IN_PREVIEWzz");
                Ok(Response {
                    content: "Persisted evidence recalled without replaying the tool.".into(),
                    tool_calls: vec![],
                })
            }
            index => panic!("unexpected disclosure or maintenance request {index}"),
        }
    }
}

#[tokio::test]
async fn large_tool_result_is_bounded_on_the_wire_and_recall_keeps_the_full_event() {
    let temp = TempDir::new().unwrap();
    let client = Arc::new(LargeOutputClient {
        calls: AtomicUsize::new(0),
    });
    let mut config = AppConfig::default();
    config.orchestrator.observation_preview_chars = 512;
    config.permissions.workspace_root = temp.path().to_string_lossy().into_owned();
    config.background_task.artifact_dir =
        temp.path().join("artifacts").to_string_lossy().into_owned();
    let runtime = MorphzRuntime::builder(config, client.clone() as Arc<dyn Client>)
        .database_path(temp.path().join("runtime.sqlite").to_string_lossy())
        .tool_policy(RuntimeToolPolicy {
            context_only: false,
            coding_eval: false,
        })
        .extra_tool(Arc::new(LargeOutputTool))
        .build()
        .await
        .unwrap();
    runtime.start().await.unwrap();
    let session = runtime
        .ensure_session(NewSession {
            id: "tool-disclosure-session".into(),
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            parent_session_id: None,
            title: "Tool disclosure".into(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    let mut replies = runtime.subscribe("chat/reply", 4);
    session
        .send("Inspect persisted tool evidence.", "Test", None)
        .await
        .unwrap();
    let reply = tokio::time::timeout(Duration::from_secs(20), replies.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        reply.payload["text"],
        "Persisted evidence recalled without replaying the tool."
    );
    let events = runtime
        .query_events(QueryFilter {
            topic: Some("chat/tool_output".into()),
            session_id: Some(session.id().into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let report = events
        .iter()
        .find(|event| event.payload["tool_name"] == "fixture_report")
        .unwrap();
    assert_eq!(
        report.payload["text"].as_str().unwrap().chars().count(),
        40_030
    );
    assert!(report.payload["text"]
        .as_str()
        .unwrap()
        .contains("MIDDLE_EVIDENCE_NOT_IN_PREVIEW"));
    assert_eq!(
        events
            .iter()
            .filter(|event| event.payload["tool_name"] == "fixture_report")
            .count(),
        1
    );
    assert_eq!(client.calls.load(Ordering::SeqCst), 3);
}
