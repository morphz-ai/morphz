//! Real SQLite/Runtime request-chain coverage of the experimental Delta
//! transport. The provider is scripted and the counter is explicitly a local
//! UTF-8-byte heuristic, not a real-provider tokenizer or quality benchmark.
#![cfg(feature = "experimental-structured-context-delta-cache")]

use morphz::{
    config::AppConfig,
    context::{CustomKey, PutCustomCommand},
    event::Event,
    llm::{
        model_visible_message_text, segmented_model_text, Client, Message, PromptTokenAccuracy,
        PromptTokenCount, Response, ToolCallRepr, ToolDefinition,
    },
    memory::{
        sqlite::SqliteStore, ActivationStore, CustomStore, ExecutionJobFilter, ExecutionJobStatus,
        ExecutionJobStore, NewSession, QueryFilter, RuntimeStore, SessionMountKind,
        ThreadLifecycle,
    },
    orchestrator::context::ContextViewManifest,
    response_annotations::{
        annotations_from_authorized_event, AnnotationKind, ExecutionScope, Protocol,
        BUNDLE_PAYLOAD_KEY, RECEIPT_ENCODING_VERSION,
    },
    runtime::{MorphzRuntime, RuntimeToolPolicy, SchedulerQuery},
    session_io::{Limits, Request},
    sexpr::{parse, SExpr},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

type DynError = Box<dyn std::error::Error + Send + Sync>;
const MODEL: &str = "annotation-receipt-delta-fixture";
const SESSION: &str = "annotation-receipt-delta-session";
const TITLE: &str = "Inspect the synthetic Delta task twice";

#[derive(Clone)]
struct CapturedRequest {
    messages: Vec<Message>,
    tools: Vec<ToolDefinition>,
}

#[derive(Default)]
struct DeltaClient {
    calls: AtomicUsize,
    captured: Mutex<Vec<CapturedRequest>>,
}

fn digest(value: &Value) -> String {
    format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(value).unwrap())
    )
}

fn hash_u64(bytes: &[u8]) -> u64 {
    let hash = Sha256::digest(bytes);
    u64::from_be_bytes(hash[..8].try_into().unwrap())
}

#[async_trait::async_trait]
impl Client for DeltaClient {
    fn supports_async_cancellation(&self) -> bool {
        true
    }

    fn model(&self) -> Option<String> {
        Some(MODEL.into())
    }

    fn prefers_structured_delta_cache_transport(&self, requested_model: Option<&str>) -> bool {
        assert_eq!(requested_model, Some(MODEL));
        true
    }

    async fn count_prompt_tokens(
        &self,
        _scope: &str,
        messages: &[Message],
        tools: &[ToolDefinition],
    ) -> Result<Option<PromptTokenCount>, DynError> {
        // Include every actual message field (including segment envelopes,
        // source receipts and raw tool arguments) and the complete tool
        // definitions. This deterministic test estimate is never marked Exact.
        let bytes = serde_json::to_vec(&json!({"messages":messages,"tools":tools}))?;
        let tokens = bytes.len().div_ceil(4).max(1);
        let shape = serde_json::to_vec(&json!({
            "protocol":"scripted-utf8-byte-counter/v1","model":MODEL,"tools":tools,
        }))?;
        Ok(Some(PromptTokenCount {
            tokens,
            base_estimate_tokens: tokens,
            source: "test-complete-request-utf8-byte-heuristic".into(),
            model: MODEL.into(),
            accuracy: PromptTokenAccuracy::HeuristicEstimate,
            calibration_key: Some(hash_u64(&bytes)),
            calibration_shape: Some(hash_u64(&shape)),
        }))
    }

    async fn count_prompt_tokens_for_requested_model(
        &self,
        scope: &str,
        requested_model: Option<&str>,
        messages: &[Message],
        tools: &[ToolDefinition],
    ) -> Result<Option<PromptTokenCount>, DynError> {
        assert_eq!(requested_model, Some(MODEL));
        self.count_prompt_tokens(scope, messages, tools).await
    }

    async fn create_completion(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, DynError> {
        let count = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        assert!(count <= 3, "unexpected physical request {count}");
        self.captured.lock().unwrap().push(CapturedRequest {
            messages,
            tools: tools.clone(),
        });
        let (name, arguments) = if count <= 2 {
            (
                "recall",
                json!({"query":"DELTA_RECEIPT_TASK","limit":10,"_annotations":{
                    "execution":{"title":TITLE,"progress":format!("Inspect synthetic task, read {count}")},
                    "intent":format!("Read synthetic task {count} without changing it")
                }}),
            )
        } else {
            (
                "reply",
                json!({"content":"Both synthetic reads completed.","annotations":{
                    "execution":{"title":TITLE,"result":"Both readonly Recall Jobs completed."}
                }}),
            )
        };
        assert!(
            tools.iter().any(|tool| tool.name == name),
            "actual request {count} lacks {name}; tools={:?}",
            tools.iter().map(|tool| &tool.name).collect::<Vec<_>>()
        );
        Ok(Response {
            content: String::new(),
            tool_calls: vec![ToolCallRepr {
                id: format!("delta-receipt-{count}"),
                r#type: "function".into(),
                func_name: name.into(),
                arguments: arguments.to_string(),
            }],
        })
    }
}

fn atom<'a>(node: &'a SExpr, name: &str) -> &'a str {
    match node.get_path(&[name]) {
        Some(SExpr::Atom(value)) => value,
        _ => panic!("actual canonical node lacks scalar {name}: {node}"),
    }
}

fn nodes_named<'a>(node: &'a SExpr, name: &str) -> Vec<&'a SExpr> {
    let mut pending = vec![node];
    let mut nodes = Vec::new();
    while let Some(node) = pending.pop() {
        if let SExpr::List(items) = node {
            if matches!(items.first(), Some(SExpr::Atom(head)) if head == name) {
                nodes.push(node);
            }
            pending.extend(items.iter().rev());
        }
    }
    nodes
}

fn actual_deltas(request: &CapturedRequest) -> Vec<SExpr> {
    // A Full/FC fallback is deliberately a failure, even if a Full Inbox
    // happens to carry the same acceptance metadata.
    assert_eq!(request.messages.len(), 2, "Delta must be system + one user");
    assert_eq!(request.messages[0].role, "system");
    assert_eq!(request.messages[1].role, "user");
    assert!(request
        .messages
        .iter()
        .all(|message| message.tool_calls.is_none()));
    let segmented = segmented_model_text(&request.messages[1])
        .expect("actual Delta user request must carry segmented model text");
    let deltas = segmented
        .parts
        .iter()
        .skip(1)
        .map(|part| {
            assert!(part.cache_boundary_after && part.cache_boundary_candidate_after);
            let node = parse(part.text.trim()).expect("actual Delta block is canonical SExpr");
            assert!(matches!(&node, SExpr::List(items)
            if matches!(items.first(), Some(SExpr::Atom(head)) if head == "context-delta")));
            node
        })
        .collect::<Vec<_>>();
    assert!(
        !deltas.is_empty(),
        "Full/FC fallback cannot pass the actual Delta gate"
    );
    deltas
}

fn source_for_call<'a>(events: &'a [Event], call_id: &str) -> &'a Event {
    let sources = events
        .iter()
        .filter(|event| {
            event.payload[BUNDLE_PAYLOAD_KEY]["raw_response"]["tool_calls"]
                .as_array()
                .is_some_and(|calls| calls.iter().any(|call| call["id"] == call_id))
        })
        .collect::<Vec<_>>();
    assert_eq!(
        sources.len(),
        1,
        "one persisted source for actual call {call_id}"
    );
    sources[0]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn accepted_receipts_enter_actual_delta_sources_without_extra_business_requests() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(
        SqliteStore::new(
            directory
                .path()
                .join("annotation-delta.sqlite")
                .to_str()
                .unwrap(),
        )
        .await
        .unwrap(),
    );
    let client = Arc::new(DeltaClient::default());
    let mut config = AppConfig::default();
    config.llm.model = MODEL.into();
    config.permissions.workspace_root = directory.path().to_string_lossy().into_owned();
    config.background_task.artifact_dir = directory
        .path()
        .join("artifacts")
        .to_string_lossy()
        .into_owned();
    let runtime = MorphzRuntime::builder(config, client.clone() as Arc<dyn Client>)
        .store(
            "sqlite:annotation-delta-fixture",
            store.clone() as Arc<dyn RuntimeStore>,
        )
        .tool_policy(RuntimeToolPolicy {
            context_only: false,
            coding_eval: false,
        })
        .build()
        .await
        .unwrap();
    runtime.start().await.unwrap();
    let identity = runtime.identity().clone();
    let session = runtime
        .ensure_session(NewSession {
            id: SESSION.into(),
            agent_id: identity.agent_id.clone(),
            context_id: identity.context_id.clone(),
            parent_session_id: None,
            title: "Actual annotation Delta regression".into(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    store
        .put_custom(
            PutCustomCommand {
                command_id: "annotation-delta-profile".into(),
                expected_revision: 0,
                key: CustomKey {
                    agent_id: identity.agent_id.clone(),
                    namespace: "morphz.profile.agent".into(),
                    principal_scope: None,
                },
                schema_tag: "morphz-agent-profile/v2".into(),
                body_sexpr: "(agent-profile (version 2) (identity (name DeltaEcho)))".into(),
                authoring_state_sexpr: Some("(editor NEVER_PROJECT_DELTA_AUTHORING)".into()),
                enabled: true,
            },
            "trusted-isolated-test-host",
        )
        .await
        .unwrap();
    let mut input = Request::parse(json!({"io_version":"1","client_message_id":"delta-receipt-task",
        "message":{"format":{"id":"morphz.chat","version":"1"},"content":{"encoding":"json","value":{
            "text":"DELTA_RECEIPT_TASK: inspect this synthetic persisted task twice using readonly Recall, then report the result."
        }}}
    }).to_string().as_bytes(), &Limits::default()).unwrap();
    input.activation.model_alias = Some(MODEL.into());
    input.activation.reasoning_effort = Some("low".into());
    input.activation.response_annotations = Some(Protocol::V2);
    session
        .send_io_as_principal(input, &identity.principal_id)
        .await
        .unwrap();

    let thread = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let errors = runtime
                .query_events(QueryFilter {
                    session_id: Some(SESSION.into()),
                    topic: Some("runtime/response_protocol_error".into()),
                    ..Default::default()
                })
                .await
                .unwrap();
            assert!(
                errors.is_empty(),
                "actual business response was rejected: {errors:?}"
            );
            let board = runtime
                .scheduler_snapshot(
                    &identity.context_id,
                    SchedulerQuery {
                        include_terminal: true,
                        limit: 16,
                    },
                )
                .await
                .unwrap();
            assert!(!board
                .threads
                .iter()
                .any(|snapshot| snapshot.thread.lifecycle == ThreadLifecycle::Failed));
            if board.threads.len() == 1
                && board.threads[0].thread.lifecycle == ThreadLifecycle::Completed
            {
                break board.threads[0].thread.clone();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("actual two-read business chain must finish before Delta assertions");

    let requests = client.captured.lock().unwrap().clone();
    assert_eq!(client.calls.load(Ordering::SeqCst), 3);
    assert_eq!(
        requests.len(),
        3,
        "two readonly requests + one reply, no metadata request"
    );
    let states = runtime
        .query_events(QueryFilter {
            session_id: Some(SESSION.into()),
            topic: Some("runtime/model_attempt_state".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let queued = states
        .iter()
        .filter(|event| event.payload["state"] == "queued")
        .collect::<Vec<_>>();
    assert_eq!(queued.len(), 3, "every actual physical request is counted");
    let events = runtime
        .query_events(QueryFilter {
            context_id: Some(thread.context_id.clone()),
            session_id: Some(SESSION.into()),
            root_turn_id: Some(thread.root_turn_id.clone()),
            topic: Some("chat/assistant_call".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(events.len(), 3);
    let jobs = store
        .list_execution_jobs(ExecutionJobFilter {
            session_id: Some(SESSION.into()),
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(jobs.len(), 2);
    for job in &jobs {
        assert_eq!(job.tool_name, "recall");
        assert_eq!(job.status, ExecutionJobStatus::Succeeded);
        assert_eq!(job.thread_id, thread.id);
        assert!(job.result_event_id.is_some());
        assert!(!job.request.to_string().contains("_annotations"));
    }
    let custom = store.get_thread_custom(&thread.id).await.unwrap().unwrap();
    assert_eq!(custom.entries.len(), 1);
    assert_eq!(custom.entries[0].revision, 1);
    for request in &requests {
        let text = request
            .messages
            .iter()
            .map(model_visible_message_text)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("DeltaEcho") && text.contains("(custom "));
        assert!(!text.contains("NEVER_PROJECT_DELTA_AUTHORING"));
    }

    let first = source_for_call(&events, "delta-receipt-1");
    let seed = &first.payload["prompt_cache_transport_seed"];
    assert_eq!(
        seed["version"], 3,
        "the actual request must persist its canonical seed"
    );
    assert!(seed["initial_deltas"].as_array().unwrap().is_empty());
    let seed_message: Message = serde_json::from_value(seed["context_message"].clone()).unwrap();
    assert_eq!(
        model_visible_message_text(&seed_message),
        model_visible_message_text(&requests[0].messages[1])
    );
    let first_queued = queued
        .iter()
        .find(|event| event.payload["attempt_id"] == first.payload["model_attempt_id"])
        .unwrap();
    assert_eq!(first_queued.payload["configured_reasoning_effort"], "low");
    let base_digest = digest(&json!({
        "version":3,"model_alias":MODEL,"reasoning_effort":"low",
        "phase":first_queued.payload["phase"],"system_role":requests[0].messages[0].role,
        "system_content":model_visible_message_text(&requests[0].messages[0]),
        "tools":requests[0].tools,
    }));
    let refs = custom
        .entries
        .iter()
        .map(|entry| (&entry.entry_id, entry.revision, &entry.content_hash))
        .collect::<Vec<_>>();
    let custom_digest = if custom.compiler_hash == morphz::context::legacy_compiler_hash() {
        digest(
            &json!({"base":base_digest,"rom_manifest":custom.manifest_hash,
            "rom_compiler":custom.compiler_hash,"rom_versions":refs}),
        )
    } else {
        digest(
            &json!({"base":base_digest,"custom_manifest":custom.manifest_hash,
            "custom_compiler":custom.compiler_hash,"custom_versions":refs}),
        )
    };
    let scope = ExecutionScope {
        execution_id: thread.id.clone(),
        generation: thread.generation,
    };
    let expected_fence = digest(&json!({"base":custom_digest,
        "response_annotation_receipt_encoding":RECEIPT_ENCODING_VERSION,
        "protocol":Protocol::V2,"scope":scope,
        "owner":{
            "agent_id":thread.agent_id,
            "context_id":thread.context_id,
            "session_id":thread.session_id,
            "root_turn_id":thread.root_turn_id,
            "initiating_principal_id":thread.initiating_principal_id,
        },
    }));
    assert_eq!(
        seed["contract_digest"], expected_fence,
        "the real seed contract includes actual model/tools/Custom/protocol/Thread/generation"
    );

    for (index, request) in requests.iter().enumerate().skip(1) {
        let deltas = actual_deltas(request);
        assert_eq!(
            deltas.len(),
            index,
            "actual selected Delta includes each prior readonly result exactly once"
        );
        let current_source = source_for_call(&events, &format!("delta-receipt-{}", index + 1));
        let manifest: ContextViewManifest =
            serde_json::from_value(current_source.payload["context_view_manifest"].clone())
                .unwrap();
        let current_activation = store
            .get_thread_activation(current_source.payload["activation_id"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(current_activation.root_turn_id, thread.root_turn_id);
        assert_eq!(current_activation.generation, thread.generation);
        assert!(queued.iter().any(|event| event.payload["attempt_id"]
            == current_source.payload["model_attempt_id"]
            && event.payload["activation_id"] == current_activation.id));
        let mut output_sequences = HashSet::new();
        for count in 1..=index {
            let call_id = format!("delta-receipt-{count}");
            let source = source_for_call(&events, &call_id);
            let source_activation = store
                .get_thread_activation(source.payload["activation_id"].as_str().unwrap())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(source_activation.context_id, thread.context_id);
            assert_eq!(source_activation.session_id, thread.session_id);
            assert_eq!(source_activation.agent_id, thread.agent_id);
            assert_eq!(
                source_activation.initiating_principal_id,
                thread.initiating_principal_id
            );
            assert_eq!(source_activation.root_turn_id, thread.root_turn_id);
            assert_eq!(source_activation.generation, thread.generation);
            assert!(source.sequence.unwrap() <= manifest.event_sequence_upper_bound);
            let bundle = annotations_from_authorized_event(source, &scope)
                .unwrap()
                .unwrap();
            assert!(bundle
                .records
                .iter()
                .any(|record| record.kind == AnnotationKind::Progress));
            assert!(bundle
                .records
                .iter()
                .any(|record| record.kind == AnnotationKind::Intent
                    && record.call_id.as_deref() == Some(call_id.as_str())));
            let raw = &bundle.raw_response.tool_calls[0];
            assert_eq!(
                source.payload["continuation_tool_calls"][0]["function"]["arguments"],
                raw.arguments
            );
            let mut expected_business: Value = serde_json::from_str(&raw.arguments).unwrap();
            expected_business
                .as_object_mut()
                .unwrap()
                .remove("_annotations");
            let actual_business: Value = serde_json::from_str(
                source.payload["tool_calls"][0]["function"]["arguments"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(actual_business, expected_business);

            let matching = deltas
                .iter()
                .filter(|delta| {
                    atom(delta.get_path(&["source", "tool-call"]).unwrap(), "id") == call_id
                })
                .collect::<Vec<_>>();
            assert_eq!(
                matching.len(),
                1,
                "actual source carrier {call_id} appears in one Delta"
            );
            let delta = matching[0];
            let delta_source = delta.get_path(&["source"]).unwrap();
            assert_eq!(
                atom(delta_source.get_path(&["tool-call"]).unwrap(), "arguments"),
                raw.arguments
            );
            let receipts = nodes_named(delta_source, "response-annotation-receipt");
            assert_eq!(
                receipts.len(),
                1,
                "actual Delta source, not Full fallback, carries its receipt"
            );
            let receipt = receipts[0];
            assert_eq!(atom(receipt, "source-event"), source.id);
            assert_eq!(
                atom(receipt, "source-seq"),
                source.sequence.unwrap().to_string()
            );
            assert_eq!(atom(receipt, "activation"), source_activation.id);
            assert_eq!(
                atom(receipt, "model-attempt"),
                source.payload["model_attempt_id"].as_str().unwrap()
            );
            assert_eq!(atom(receipt, "execution"), thread.id);
            assert_eq!(atom(receipt, "generation"), thread.generation.to_string());
            assert_eq!(atom(receipt, "protocol"), "v2");
            assert_eq!(atom(receipt, "state"), "accepted");
            assert_eq!(atom(receipt, "truncated"), "false");
            assert!(receipt.to_string().len() <= 2048);
            let records = nodes_named(receipt.get_path(&["accepted"]).unwrap(), "record");
            assert!(records
                .iter()
                .any(|record| atom(record, "kind") == "execution.progress"));
            assert!(records.iter().any(
                |record| atom(record, "kind") == "intent" && atom(record, "call-id") == call_id
            ));
            for record in records {
                assert!(record.get_path(&["value"]).is_none());
                assert!(record.get_path(&["effective"]).is_none());
                assert_ne!(atom(record, "kind"), "execution.result");
            }
            assert!(!receipt.to_string().contains("Read synthetic task"));
            let job = jobs.iter().find(|job| job.tool_call_id == call_id).unwrap();
            let output = runtime
                .query_events(QueryFilter {
                    event_id: job.result_event_id.clone(),
                    ..Default::default()
                })
                .await
                .unwrap();
            assert_eq!(output.len(), 1);
            let observations =
                nodes_named(delta.get_path(&["inbox-append"]).unwrap(), "observation");
            assert_eq!(observations.len(), 1);
            assert_eq!(
                atom(observations[0], "seq"),
                output[0].sequence.unwrap().to_string()
            );
            assert!(output_sequences.insert(output[0].sequence.unwrap()));
        }
    }
}
