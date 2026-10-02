//! Actual SQLite/Runtime steering acceptance with a native scripted Client.
//! This tests host binding and request cost, not real-model title quality.
//! Synthetic tools run as physical durable Jobs; no external provider is used.
use morphz::{
    config::AppConfig,
    event::Event,
    llm::{
        Client, Message, ModelAttemptBinding, ModelAttemptBindingError, ModelRequestContext,
        ModelRequestOptions, ModelStreamEvent, ModelStreamSender, PromptTokenCount, Response,
        ToolCallRepr, ToolDefinition,
    },
    memory::{
        sqlite::SqliteStore, ActivationStore, ExecutionJobFilter, ExecutionJobRecord,
        ExecutionJobStatus, ExecutionJobStore, NewSession, QueryFilter, RuntimeStore,
        SessionMountKind, ThreadLifecycle, ThreadRecord, ThreadStore,
    },
    response_annotations::{
        project_authorized_events, AnnotationKind, ExecutionFact, ExecutionScope,
        PersistedAnnotations, Protocol, BUNDLE_PAYLOAD_KEY,
    },
    runtime::{MorphzRuntime, RuntimeIdentity, RuntimeToolPolicy, SessionHandle},
    session_io::{Limits, Request},
    steering::InputDestination,
    tool::Tool,
};
use serde_json::{json, Value};
use std::{
    error::Error,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tempfile::TempDir;
use tokio::sync::Notify;

type DynError = Box<dyn Error + Send + Sync>;
const ORIGINAL_TEXT: &str = "读取合成系统与架构，完成后报告结果。";
const STEER_TEXT: &str = "请保留原检查，并将最终结果用中文概述，附加一句简短摘要。";
const ORIGINAL_TITLE: &str = "检查合成系统与架构";
const UPDATED_TITLE: &str = "检查合成环境并提供中文摘要";
const STEP_TITLE: &str = "读取架构这个步骤不能覆盖整项工作的标题";
const FINAL_TEXT: &str = "系统为 Linux，架构为 arm64。摘要：合成环境检查完成。";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Scenario {
    DirectTitle,
    DeferredTitle,
}
impl Scenario {
    fn request_count(self) -> usize {
        match self {
            Self::DirectTitle => 2,
            Self::DeferredTitle => 3,
        }
    }
}

struct ScriptClient {
    protocol: Protocol,
    scenario: Scenario,
    calls: AtomicUsize,
    messages: Mutex<Vec<Vec<Message>>>,
}

impl ScriptClient {
    fn work(&self, id: &str, part: &str, title: &str) -> ToolCallRepr {
        let mut arguments = json!({"part":part});
        if self.protocol == Protocol::V1 {
            arguments["_annotations"] = json!({
                "execution":{"title":title,"progress":"读取合成环境"},
                "intent":format!("读取{part}的合成事实")
            });
        }
        ToolCallRepr {
            id: id.into(),
            r#type: "function".into(),
            func_name: "steer_probe".into(),
            arguments: arguments.to_string(),
        }
    }
}

#[async_trait::async_trait]
impl Client for ScriptClient {
    fn supports_async_cancellation(&self) -> bool {
        true
    }
    fn model(&self) -> Option<String> {
        Some("steer-annotations-fixture".into())
    }
    async fn bind_model_attempt(
        &self,
        request: &ModelRequestContext,
    ) -> Result<ModelAttemptBinding, ModelAttemptBindingError> {
        Ok(ModelAttemptBinding {
            requested_alias: "steer-annotations-fixture".into(),
            route_id: "steer-synthetic-native-route".into(),
            route_revision: "fixture-v1".into(),
            provider_instance_id: "steer-synthetic-provider".into(),
            auth_account_id: "steer-synthetic-account".into(),
            physical_model: "steer-synthetic-model".into(),
            protocol: "openai-responses".into(),
            provider_adapter: "steer-synthetic-native".into(),
            provider_adapter_version: "1".into(),
            endpoint: "http://127.0.0.1:1/v1".into(),
            request_session_id: Some(request.session_id.clone()),
            capabilities: vec![],
            model_input_limits: Default::default(),
        })
    }
    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, DynError> {
        panic!("steer fixture must use the native bound-with-options path")
    }
    async fn create_completion_bound_stream_with_options(
        &self,
        _binding: &ModelAttemptBinding,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
        _measurement: Option<PromptTokenCount>,
        stream: ModelStreamSender,
        _options: ModelRequestOptions,
    ) -> Result<Response, DynError> {
        let index = self.calls.fetch_add(1, Ordering::SeqCst);
        assert!(
            index < self.scenario.request_count(),
            "no dedicated title request or repeated execution inference is allowed"
        );
        self.messages.lock().unwrap().push(messages.clone());
        let response = match index {
            0 => {
                assert!(messages
                    .iter()
                    .any(|message| message.content.contains(ORIGINAL_TEXT)));
                assert!(messages
                    .iter()
                    .all(|message| !message.content.contains(STEER_TEXT)));
                Response {
                    content: String::new(),
                    tool_calls: if self.scenario == Scenario::DirectTitle {
                        vec![
                            self.work("steer-system-call", "system", ORIGINAL_TITLE),
                            self.work("steer-architecture-call", "architecture", STEP_TITLE),
                        ]
                    } else {
                        vec![self.work("steer-system-call", "system", ORIGINAL_TITLE)]
                    },
                }
            }
            1 if self.scenario == Scenario::DeferredTitle => {
                assert!(messages.iter().any(|message| message.content.contains(STEER_TEXT)),
                    "the steering instruction must actually enter the work response before its first title");
                let mut call = self.work("steer-architecture-call", "architecture", STEP_TITLE);
                if self.protocol == Protocol::V1 {
                    let mut arguments: Value = serde_json::from_str(&call.arguments).unwrap();
                    arguments["_annotations"]["execution"]
                        .as_object_mut()
                        .unwrap()
                        .remove("title");
                    call.arguments = arguments.to_string();
                }
                Response {
                    content: String::new(),
                    tool_calls: vec![call],
                }
            }
            1 | 2 => {
                assert!(messages.iter().any(|message| message.content.contains(STEER_TEXT)),
                    "accepted steering text must be in the actual next model request, not just queued in SQL");
                if self.protocol == Protocol::V1 {
                    assert!(tools.iter().any(|tool| tool.name == "reply"));
                    Response {
                        content: String::new(),
                        tool_calls: vec![ToolCallRepr {
                            id: "steer-final-reply".into(),
                            r#type: "function".into(),
                            func_name: "reply".into(),
                            arguments: json!({"content":FINAL_TEXT,"annotations":{"execution":{
                                "title":UPDATED_TITLE,"result":"已读取合成系统与架构，并提供中文摘要"
                            }}}).to_string(),
                        }],
                    }
                } else {
                    assert!(!tools.iter().any(|tool| tool.name == "reply"));
                    Response {
                        content: FINAL_TEXT.into(),
                        tool_calls: vec![],
                    }
                }
            }
            _ => unreachable!(),
        };
        let _ = stream.send(ModelStreamEvent::Started);
        for character in response.content.chars() {
            let _ = stream.send(ModelStreamEvent::TextDelta {
                text: character.to_string(),
            });
        }
        for (index, call) in response.tool_calls.iter().enumerate() {
            let _ = stream.send(ModelStreamEvent::ToolCallStarted {
                index,
                id: call.id.clone(),
                name: call.func_name.clone(),
            });
            let characters = call.arguments.chars().collect::<Vec<_>>();
            for chunk in characters.chunks(5) {
                let _ = stream.send(ModelStreamEvent::ToolArgumentsDelta {
                    index,
                    delta: chunk.iter().collect(),
                });
                tokio::task::yield_now().await;
            }
            let _ = stream.send(ModelStreamEvent::ToolCallCompleted { index });
        }
        let _ = stream.send(ModelStreamEvent::Completed);
        Ok(response)
    }
}

struct ProbeTool {
    entered: Arc<Notify>,
    release: Arc<Notify>,
    invocations: Arc<Mutex<Vec<Value>>>,
}
#[async_trait::async_trait]
impl Tool for ProbeTool {
    fn name(&self) -> &str {
        "steer_probe"
    }
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().into(),
            description: "Read synthetic system or architecture facts, with no external effects."
                .into(),
            parameters: json!({"type":"object","additionalProperties":false,"required":["part"],
                "properties":{"part":{"type":"string","enum":["system","architecture"]}}}),
        }
    }
    async fn execute(&self, arguments: &str) -> Result<String, DynError> {
        let arguments: Value = serde_json::from_str(arguments)?;
        self.invocations.lock().unwrap().push(arguments.clone());
        match arguments["part"].as_str() {
            Some("system") => {
                self.entered.notify_one();
                tokio::time::timeout(Duration::from_secs(20), self.release.notified()).await?;
                Ok("Linux".into())
            }
            Some("architecture") => Ok("arm64".into()),
            _ => Err("unexpected synthetic part".into()),
        }
    }
}

struct Fixture {
    _temp: TempDir,
    runtime: MorphzRuntime,
    store: Arc<SqliteStore>,
    session: SessionHandle,
    client: Arc<ScriptClient>,
    entered: Arc<Notify>,
    release: Arc<Notify>,
    invocations: Arc<Mutex<Vec<Value>>>,
}
impl Fixture {
    async fn new(protocol: Protocol) -> Self {
        Self::with_scenario(protocol, Scenario::DirectTitle).await
    }
    async fn with_scenario(protocol: Protocol, scenario: Scenario) -> Self {
        let temp = TempDir::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(temp.path().join("steer.sqlite").to_str().unwrap())
                .await
                .unwrap(),
        );
        let client = Arc::new(ScriptClient {
            protocol,
            scenario,
            calls: AtomicUsize::new(0),
            messages: Mutex::new(vec![]),
        });
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let invocations = Arc::new(Mutex::new(vec![]));
        let mut config = AppConfig::default();
        config.llm.model = "steer-annotations-fixture".into();
        config.permissions.workspace_root = temp.path().to_string_lossy().into_owned();
        config.background_task.artifact_dir =
            temp.path().join("artifacts").to_string_lossy().into_owned();
        config.orchestrator.response_annotations = protocol;
        let runtime = MorphzRuntime::builder(config, client.clone() as Arc<dyn Client>)
            .identity(RuntimeIdentity {
                agent_id: "steer-test-agent".into(),
                context_id: "steer-test-context".into(),
                principal_id: "steer-test-human".into(),
            })
            .store(
                "sqlite:steer-annotations-fixture",
                store.clone() as Arc<dyn RuntimeStore>,
            )
            .tool_policy(RuntimeToolPolicy {
                context_only: false,
                coding_eval: false,
            })
            .extra_tool(Arc::new(ProbeTool {
                entered: entered.clone(),
                release: release.clone(),
                invocations: invocations.clone(),
            }))
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let session = runtime
            .ensure_session(NewSession {
                id: "steer-test-session".into(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Synthetic steer acceptance".into(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        Self {
            _temp: temp,
            runtime,
            store,
            session,
            client,
            entered,
            release,
            invocations,
        }
    }
    fn input(id: &str, text: &str) -> Request {
        Request::parse(json!({"io_version":"1","client_message_id":id,
            "message":{"format":{"id":"morphz.chat","version":"1"},"content":{"encoding":"json","value":{"text":text}}}
        }).to_string().as_bytes(), &Limits::default()).unwrap()
    }
    async fn jobs(&self) -> Vec<ExecutionJobRecord> {
        self.store
            .list_execution_jobs(ExecutionJobFilter {
                session_id: Some("steer-test-session".into()),
                include_terminal: true,
                limit: Some(10),
                ..Default::default()
            })
            .await
            .unwrap()
    }
    async fn events(&self, root: &str) -> Vec<Event> {
        self.runtime
            .query_events(QueryFilter {
                root_turn_id: Some(root.into()),
                latest_k: Some(100),
                ..Default::default()
            })
            .await
            .unwrap()
    }
    async fn exercise(&self, protocol: Protocol) -> (Event, Event, ThreadRecord, Vec<Event>) {
        let initial = self
            .session
            .send_io_as_principal(
                Self::input("steer-root", ORIGINAL_TEXT),
                &self.runtime.identity().principal_id,
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(15), self.entered.notified())
            .await
            .expect("first actual tool did not enter");
        let running_job = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Some(job) = self.jobs().await.into_iter().find(|job| {
                    job.tool_call_id == "steer-system-call"
                        && job.status == ExecutionJobStatus::Running
                }) {
                    break job;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("actual persisted Job never reached Running");
        let owner = self
            .store
            .get_thread(&running_job.thread_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(owner.root_turn_id, initial.id);
        assert_eq!(owner.response_annotations, protocol);
        let before = self.events(&initial.id).await;
        if protocol == Protocol::V1 {
            let work = before
                .iter()
                .find(|event| {
                    event.topic == "chat/assistant_call"
                        && event.payload.contains_key(BUNDLE_PAYLOAD_KEY)
                })
                .unwrap();
            let bundle: PersistedAnnotations =
                serde_json::from_value(work.payload[BUNDLE_PAYLOAD_KEY].clone()).unwrap();
            let titles = bundle
                .records
                .iter()
                .filter(|record| record.kind == AnnotationKind::Title)
                .collect::<Vec<_>>();
            assert_eq!(
                titles.len(),
                1,
                "ordinary same-input step metadata cannot rename the task"
            );
            assert_eq!(titles[0].value, ORIGINAL_TITLE);
            assert!(titles[0].title_input_revision.is_none());
            let fact = ExecutionFact {
                scope: ExecutionScope {
                    execution_id: owner.id.clone(),
                    generation: owner.generation,
                },
                status: "working".into(),
                terminal: false,
                terminal_sequence: None,
            };
            assert_eq!(
                project_authorized_events(&fact, &before)
                    .unwrap()
                    .title
                    .as_deref(),
                Some(ORIGINAL_TITLE)
            );
        }
        let mut supplement = Self::input("steer-supplement", STEER_TEXT);
        supplement.activation.input_destination = Some(InputDestination::Thread {
            thread_id: owner.id.clone(),
            generation: owner.generation,
        });
        assert!(supplement.activation.response_annotations.is_none());
        let directed = self
            .session
            .send_io_as_principal(supplement, &self.runtime.identity().principal_id)
            .await
            .unwrap();
        assert_eq!(directed.topic, "chat/steering");
        assert_eq!(directed.payload["thread_id"], owner.id);
        assert_eq!(directed.payload["thread_generation"], owner.generation);
        assert_eq!(directed.payload["root_turn_id"], initial.id);
        assert!(
            directed.payload["session_io"]["request"]["activation"]
                .get("response_annotations")
                .is_none(),
            "caller must not explicitly override the owner protocol"
        );
        if protocol == Protocol::V1 {
            assert_eq!(directed.payload["response_annotations"], "v1");
            assert_eq!(
                directed.payload["session_io"]["binding"]["execution"]["response_annotations"],
                "v1"
            );
        } else {
            assert!(directed.payload.get("response_annotations").is_none());
        }
        self.release.notify_one();
        let events = tokio::time::timeout(Duration::from_secs(25), async {
            loop {
                let events = self.events(&initial.id).await;
                if events
                    .iter()
                    .any(|event| event.topic == "chat/reply" && event.payload["text"] == FINAL_TEXT)
                    && self
                        .store
                        .get_thread(&owner.id)
                        .await
                        .unwrap()
                        .is_some_and(|thread| thread.lifecycle == ThreadLifecycle::Completed)
                {
                    break events;
                }
                if events.iter().any(|event| {
                    event.topic == "session/io_state" && event.payload["state"] == "failed"
                }) {
                    panic!("steer execution failed: {events:#?}");
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("steered Runtime did not deliver the final response");
        let current = self.store.get_thread(&owner.id).await.unwrap().unwrap();
        assert_eq!(current.generation, owner.generation);
        assert_eq!(current.root_turn_id, initial.id);
        assert_eq!(current.response_annotations, protocol);
        assert_eq!(current.lifecycle, ThreadLifecycle::Completed);
        let jobs = self.jobs().await;
        assert_eq!(
            jobs.len(),
            2,
            "the two real requested reads must each have exactly one durable Job"
        );
        assert!(jobs
            .iter()
            .all(|job| job.thread_id == owner.id && job.status == ExecutionJobStatus::Succeeded));
        assert_eq!(
            jobs.iter()
                .find(|job| job.tool_call_id == "steer-system-call")
                .unwrap()
                .id,
            running_job.id
        );
        let invocations = self.invocations.lock().unwrap();
        assert_eq!(
            invocations.len(),
            2,
            "accepted steering must not rerun a physical action"
        );
        assert_eq!(
            invocations
                .iter()
                .filter(|arguments| arguments["part"] == "system")
                .count(),
            1
        );
        assert_eq!(
            invocations
                .iter()
                .filter(|arguments| arguments["part"] == "architecture")
                .count(),
            1
        );
        assert!(invocations
            .iter()
            .all(|arguments| arguments.get("_annotations").is_none()));
        drop(invocations);
        let signals = self
            .store
            .list_context_thread_signals_for_threads(&owner.context_id, &[owner.id.clone()], None)
            .await
            .unwrap();
        let accepted_signal = signals
            .iter()
            .find(|signal| signal.event_id == directed.id)
            .unwrap();
        assert_eq!(accepted_signal.thread_id, owner.id);
        assert_eq!(accepted_signal.thread_generation, owner.generation);
        assert_eq!(accepted_signal.sequence, directed.sequence.unwrap());
        assert_eq!(
            self.client.calls.load(Ordering::SeqCst),
            self.client.scenario.request_count()
        );
        let requests = self.client.messages.lock().unwrap();
        assert_eq!(requests.len(), self.client.scenario.request_count());
        assert!(requests[1..].iter().all(|messages| messages
            .iter()
            .any(|message| message.content.contains(STEER_TEXT))));
        drop(requests);
        (initial, directed, current, events)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn first_steered_title_after_tool_receipt_uses_the_same_execution_input_revision() {
    let enabled = Fixture::with_scenario(Protocol::V1, Scenario::DeferredTitle).await;
    let (_initial, directed, owner, events) = enabled.exercise(Protocol::V1).await;
    let mut boundaries = events
        .iter()
        .filter(|event| {
            event.topic == "chat/assistant_call" && event.payload.contains_key(BUNDLE_PAYLOAD_KEY)
        })
        .map(|event| {
            (
                event,
                serde_json::from_value::<PersistedAnnotations>(
                    event.payload[BUNDLE_PAYLOAD_KEY].clone(),
                )
                .unwrap(),
            )
        })
        .collect::<Vec<_>>();
    boundaries.sort_by_key(|(event, _)| event.sequence.unwrap());
    assert_eq!(
        boundaries.len(),
        3,
        "three normal model requests have three immutable boundaries"
    );
    assert!(boundaries[0].1.title_input_revision.is_none());
    assert!(
        boundaries[1]
            .1
            .records
            .iter()
            .all(|record| record.kind != AnnotationKind::Title),
        "the first actual steering-visible work response deliberately supplies no title"
    );
    let revision = boundaries[1]
        .1
        .title_input_revision
        .as_ref()
        .expect("the actual steering-visible work response must own the new input revision");
    assert_eq!(revision.event_id, directed.id);
    assert_eq!(revision.sequence, directed.sequence.unwrap());
    assert_eq!(
        boundaries[2].1.title_input_revision.as_ref(),
        Some(revision),
        "the next tool-output Activation must retain the same Thread input revision"
    );
    let title = boundaries[2]
        .1
        .records
        .iter()
        .find(|record| record.kind == AnnotationKind::Title)
        .unwrap();
    assert_eq!(title.value, UPDATED_TITLE);
    assert_eq!(title.title_input_revision.as_ref(), Some(revision));
    assert_ne!(
        boundaries[1].0.payload["activation_id"], boundaries[2].0.payload["activation_id"],
        "this fixture must cross a real physical tool receipt into a successor Activation"
    );
    let fact = ExecutionFact {
        scope: ExecutionScope {
            execution_id: owner.id.clone(),
            generation: owner.generation,
        },
        status: "completed".into(),
        terminal: true,
        terminal_sequence: None,
    };
    assert_eq!(project_authorized_events(&fact, &events).unwrap().title.as_deref(), Some(UPDATED_TITLE),
        "a first valid title under the supplement revision must replace the original revision-zero title");
    let off = Fixture::with_scenario(Protocol::Off, Scenario::DeferredTitle).await;
    let (_, _, _, off_events) = off.exercise(Protocol::Off).await;
    assert!(off_events
        .iter()
        .all(|event| !event.payload.contains_key(BUNDLE_PAYLOAD_KEY)));
    assert_eq!(enabled.client.calls.load(Ordering::SeqCst), 3);
    assert_eq!(enabled.client.calls.load(Ordering::SeqCst), off.client.calls.load(Ordering::SeqCst),
        "the title is supplied by the existing terminal request, never a dedicated naming inference");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn accepted_steer_updates_whole_task_title_without_extra_inference_or_repeating_jobs() {
    let enabled = Fixture::new(Protocol::V1).await;
    let (_initial, directed, owner, events) = enabled.exercise(Protocol::V1).await;
    let scope = ExecutionScope {
        execution_id: owner.id.clone(),
        generation: owner.generation,
    };
    let bundle = events
        .iter()
        .filter_map(|event| event.payload.get(BUNDLE_PAYLOAD_KEY))
        .map(|value| serde_json::from_value::<PersistedAnnotations>(value.clone()).unwrap())
        .find(|bundle| {
            bundle
                .records
                .iter()
                .any(|record| record.kind == AnnotationKind::Title && record.value == UPDATED_TITLE)
        })
        .expect("actual second response must persist its updated whole-task title");
    let revision = bundle
        .title_input_revision
        .expect("revision must be host-derived from actual accepted model-visible steering");
    assert_eq!(revision.event_id, directed.id);
    assert_eq!(revision.sequence, directed.sequence.unwrap());
    assert!(bundle
        .records
        .iter()
        .filter(|record| record.kind == AnnotationKind::Title)
        .all(|record| record.title_input_revision.as_ref() == Some(&revision)));
    let fact = ExecutionFact {
        scope,
        status: "completed".into(),
        terminal: true,
        terminal_sequence: None,
    };
    assert_eq!(
        project_authorized_events(&fact, &events)
            .unwrap()
            .title
            .as_deref(),
        Some(UPDATED_TITLE)
    );

    let off = Fixture::new(Protocol::Off).await;
    let (_initial, _directed, _owner, events) = off.exercise(Protocol::Off).await;
    assert!(events
        .iter()
        .all(|event| !event.payload.contains_key(BUNDLE_PAYLOAD_KEY)));
    assert_eq!(enabled.client.calls.load(Ordering::SeqCst), off.client.calls.load(Ordering::SeqCst),
        "annotations and steer title updates must reuse ordinary requests, not add an inference round");
}
