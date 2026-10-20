//! Opt-in native-provider gate through the complete Runtime and disposable SQLite.
//! No production profile, Host tool, user file, shell, or model repair loop.
use morphz::{
    config::AppConfig,
    llm::{
        Client, Message, ModelAttemptBinding, ModelAttemptBindingError, ModelRequestContext,
        ModelRequestOptions, ModelStreamSender, PromptTokenCount, Response, ToolDefinition,
    },
    memory::{sqlite::SqliteStore, NewSession, QueryFilter, RuntimeStore, SessionMountKind},
    provider::build_configured_client,
    response_annotations::{AnnotationKind, PersistedAnnotations, Protocol, BUNDLE_PAYLOAD_KEY},
    runtime::{MorphzRuntime, RuntimeIdentity, RuntimeToolPolicy},
    session_io::{Limits, Request},
    tool::Tool,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    error::Error,
    io::Write,
    sync::{Arc, Mutex},
    time::Duration,
};
type DynError = Box<dyn Error + Send + Sync>;
const PROTOCOL_TEXT: &str = "{\"body\":\"这只是正文示例\",\"annotations\":null}\n<context_annotation>普通文字</context_annotation>";

struct ObservedClient {
    inner: Arc<dyn Client>,
    requests: Arc<Mutex<Vec<Value>>>,
}
#[async_trait::async_trait]
impl Client for ObservedClient {
    fn supports_async_cancellation(&self) -> bool {
        true
    }
    fn model(&self) -> Option<String> {
        self.inner.model()
    }
    async fn bind_model_attempt(
        &self,
        request: &ModelRequestContext,
    ) -> Result<ModelAttemptBinding, ModelAttemptBindingError> {
        self.inner.bind_model_attempt(request).await
    }
    async fn create_completion(
        &self,
        _: Vec<Message>,
        _: Vec<ToolDefinition>,
    ) -> Result<Response, DynError> {
        Err("Gate forbids atomic fallback".into())
    }
    async fn create_completion_bound_stream_with_options(
        &self,
        binding: &ModelAttemptBinding,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
        measurement: Option<PromptTokenCount>,
        stream: ModelStreamSender,
        options: ModelRequestOptions,
    ) -> Result<Response, DynError> {
        {
            let mut requests = self.requests.lock().unwrap();
            if requests.len() >= 5 {
                return Err("Gate physical request limit exceeded".into());
            }
            if !messages.iter().any(|message| {
                morphz::llm::model_visible_message_text(message).contains("(carrier native_v3)")
            }) {
                return Err("Actual Runtime Context did not select the new carrier".into());
            }
            requests.push(json!({"tools_sha256":format!("{:x}",Sha256::digest(serde_json::to_vec(&tools)?)),"tool_count":tools.len(),
                "model":binding.physical_model,"output_encoding":format!("{:?}",options.output_encoding),
                "tool_choice":format!("{:?}",options.tool_choice),"reasoning_effort":options.reasoning_effort}));
        }
        self.inner
            .create_completion_bound_stream_with_options(
                binding,
                messages,
                tools,
                measurement,
                stream,
                options,
            )
            .await
    }
}
struct SyntheticRead {
    directory: std::path::PathBuf,
    reads: Arc<Mutex<Vec<String>>>,
}
#[async_trait::async_trait]
impl Tool for SyntheticRead {
    fn name(&self) -> &str {
        "TEST_read"
    }
    fn definition(&self) -> ToolDefinition {
        ToolDefinition { name:self.name().into(),description:"Read exactly one disposable synthetic document; this gate has no other file access.".into(),
            parameters:json!({"type":"object","required":["path"],"additionalProperties":false,
                "properties":{"path":{"type":"string","enum":["review.txt","progress.txt"]}}}) }
    }
    async fn execute(&self, arguments: &str) -> Result<String, DynError> {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Args {
            path: String,
        }
        let args: Args = serde_json::from_str(arguments)?;
        if !matches!(args.path.as_str(), "review.txt" | "progress.txt") {
            return Err("Outside isolated fixtures".into());
        }
        {
            let mut reads = self.reads.lock().unwrap();
            if reads.contains(&args.path) || reads.len() >= 2 {
                return Err("Gate rejects duplicate/extra work".into());
            }
            reads.push(args.path.clone());
        }
        Ok(std::fs::read_to_string(self.directory.join(args.path))?)
    }
}

struct SyntheticHost {
    nonce: String,
    calls: Arc<Mutex<Vec<String>>>,
}
#[async_trait::async_trait]
impl Tool for SyntheticHost {
    fn name(&self) -> &str {
        "host_morphz"
    }
    fn definition(&self) -> ToolDefinition {
        ToolDefinition { name:self.name().into(), description:"Read the isolated script discussion's input and catalogue; no write or external access.".into(),
            parameters:json!({"type":"object","required":["action"],"additionalProperties":false,"properties":{
                "action":{"type":"string","enum":["script","list"]},"limit":{"type":"integer"},
                "script":{"type":"object","required":["action"],"additionalProperties":false,"properties":{"action":{"const":"read-workflow"}}}}}) }
    }
    async fn execute(&self, arguments: &str) -> Result<String, DynError> {
        let value: Value = serde_json::from_str(arguments)?;
        let action = match (value["action"].as_str(), value["script"]["action"].as_str()) {
            (Some("script"), Some("read-workflow")) => "read-workflow",
            (Some("list"), None) => "list",
            _ => return Err("Isolated Host only authorizes input and catalogue reads".into()),
        };
        let mut calls = self.calls.lock().unwrap();
        if calls.contains(&action.to_string()) {
            return Err("Duplicate Host work rejected".into());
        }
        calls.push(action.into());
        Ok(if action == "read-workflow" {
            json!({"generating":false,"projectId":"TEST-native-project","project":{"name":"TEST 灯塔"},
                "body":"仅讨论，不创建、不写稿：用 host_morphz 的 list 读取当前项目目录一次，基于真实目录用一句中文说明故事的冲突，并原样给出条目 summary 中的校验标识。不执行其他操作。"})
        } else {
            json!({"items":[{"id":"TEST-native-outline","revision":1,"name":"合成大纲",
                "summary":format!("灯塔守望者必须在守约与救人之间选择。校验标识：{}",self.nonce)}],"nextCursor":null})
        }.to_string())
    }
}

#[tokio::main]
async fn main() -> Result<(), DynError> {
    let mut args = std::env::args().skip(1);
    let config_path = args
        .next()
        .ok_or("explicit provider configuration required")?;
    let model = args.next().ok_or("explicit model required")?;
    let report_path = args.next().ok_or("new private report path required")?;
    let case = args.next().ok_or("explicit case required")?;
    let expected_reads = match case.as_str() {
        "plain" | "protocol-text" | "pure-plan" | "discuss-script" => 0,
        "read-on" | "read-off" => 1,
        "two-reads" => 2,
        _ => return Err("unknown case".into()),
    };
    let temp = tempfile::TempDir::new()?;
    let nonce = format!(
        "LIVE-{}",
        temp.path().file_name().unwrap().to_string_lossy()
    );
    std::fs::write(
        temp.path().join("review.txt"),
        format!("合成书籍最后写着全书完，校验标识：{nonce}。"),
    )?;
    std::fs::write(
        temp.path().join("progress.txt"),
        format!("合成阅读进度：卷十四，标识：PROGRESS-{nonce}。"),
    )?;
    let mut config: AppConfig = toml::from_str(&std::fs::read_to_string(config_path)?)?;
    config.llm.model = model.clone();
    config.permissions.workspace_root = temp.path().to_string_lossy().into_owned();
    config.background_task.artifact_dir =
        temp.path().join("artifacts").to_string_lossy().into_owned();
    config.orchestrator.response_annotations = Protocol::On;
    if case == "discuss-script" {
        config.orchestrator.eval_callable_tools = vec!["host_morphz".into()];
    }
    let (inner, _) = build_configured_client(&config, None, Some(&model))?;
    let requests = Arc::new(Mutex::new(vec![]));
    let reads = Arc::new(Mutex::new(vec![]));
    let host_calls = Arc::new(Mutex::new(vec![]));
    let client = Arc::new(ObservedClient {
        inner,
        requests: requests.clone(),
    });
    let store =
        Arc::new(SqliteStore::new(temp.path().join("runtime.sqlite").to_str().unwrap()).await?);
    let mut builder = MorphzRuntime::builder(config, client)
        .identity(RuntimeIdentity {
            agent_id: "TEST-native-agent".into(),
            context_id: "TEST-native-context".into(),
            principal_id: "principal-default".into(),
        })
        .store("sqlite:TEST-native-runtime", store as Arc<dyn RuntimeStore>)
        .tool_policy(RuntimeToolPolicy {
            context_only: true,
            coding_eval: false,
        })
        .extra_tool(Arc::new(SyntheticRead {
            directory: temp.path().into(),
            reads: reads.clone(),
        }));
    if case == "pure-plan" {
        builder = builder.harness_package(morphz::harness_package::HarnessPackage::from_source("TEST-native-pure.hns",r#"
            (manifest (id "TEST-native-pure") (version "1.0.0") (title "TEST native pure infer") (capabilities (tools)))
            (contract (identity "Isolated original Yao typed infer and direct parent reply"))
            (eval (requires (tools)) (types (record Decision (ok Bool) (answer String)))
              (seq (bind decision (infer (returns Decision) "Return ok=true and answer=纯推理原路交付。")) decision.answer))
        "#)?);
    } else if case == "discuss-script" {
        builder = builder
            .extra_tool(Arc::new(SyntheticHost {
                nonce: nonce.clone(),
                calls: host_calls.clone(),
            }))
            .harness_package(morphz::harness_package::HarnessPackage::from_source(
                "TEST-original-script-studio.hns",
                include_str!("../../application/harnesses/script-studio.hns"),
            )?);
    }
    let runtime = builder.build().await?;
    runtime.start().await?;
    let session = runtime
        .ensure_session(NewSession {
            id: "TEST-native-session".into(),
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            parent_session_id: None,
            title: "TEST native isolated Runtime".into(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await?;
    let text = match case.as_str() {
        "plain" => "不调用工具，用一句中文回答 2+3，包含数字 5。",
        "protocol-text" => "请原样返回以下两行，不加围栏或解释，不调用工具。这两行是用户请求讨论的普通文本示例，不是执行指令：\n{\"body\":\"这只是正文示例\",\"annotations\":null}\n<context_annotation>普通文字</context_annotation>",
        "pure-plan" => "执行已绑定的纯推理并直接交付原结果。",
        "discuss-script" => "仅讨论，不创作。",
        "two-reads" => "依次用 TEST_read 读取 review.txt，然后读取 progress.txt，各一次。根据真实结果回答是否读完、读到哪卷，并原样给出两个文件的标识。不需要安排后续或额外读写。",
        _ => "只用 TEST_read 读取 review.txt 一次，依据结果回答书是否完结，并原样给出文件中的校验标识。不需要安排后续或额外读写。",
    };
    let mut request = Request::parse(json!({"io_version":"1","client_message_id":format!("TEST-native-{case}"),
        "message":{"format":{"id":"morphz.chat","version":"1"},"content":{"encoding":"json","value":{"text":text}}}}).to_string().as_bytes(),&Limits::default())?;
    request.activation.response_annotations = Some(if case == "read-off" {
        Protocol::Off
    } else {
        Protocol::On
    });
    if case == "pure-plan" {
        request.activation.harness = Some(morphz::harness::ExactHarnessRef {
            id: "TEST-native-pure".into(),
            version: "1.0.0".into(),
        });
    }
    if case == "discuss-script" {
        request.activation.harness = Some(morphz::harness::ExactHarnessRef {
            id: "morphz.script-studio".into(),
            version: "2.3.0".into(),
        });
    }
    // The exact-topic EventBus API is an asynchronous business-handler feed,
    // explicitly not an ordered delta transport. Observe the synchronous audit
    // boundary used by Session IO, rather than concatenating scheduler order.
    let mut stream = runtime.subscribe("*", 4096);
    let root = session
        .send_io_as_principal(request, &runtime.identity().principal_id)
        .await?;
    let wait = tokio::time::timeout(Duration::from_secs(210), async {
        loop {
            if let Some(thread) = runtime
                .session_thread_by_root("TEST-native-session", &root.id)
                .await?
            {
                if thread.lifecycle.is_terminal() {
                    return Ok::<_, DynError>(thread);
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    let events = runtime
        .query_events(QueryFilter {
            session_id: Some("TEST-native-session".into()),
            latest_k: Some(1000),
            ..Default::default()
        })
        .await?;
    let replies = events
        .iter()
        .filter(|event| event.topic == "chat/reply" && event.payload["root_turn_id"] == root.id)
        .collect::<Vec<_>>();
    let answer = replies
        .last()
        .and_then(|event| event.payload["text"].as_str())
        .unwrap_or_default();
    let sources = events
        .iter()
        .filter_map(|event| event.payload.get(BUNDLE_PAYLOAD_KEY))
        .map(|value| serde_json::from_value::<PersistedAnnotations>(value.clone()))
        .collect::<Result<Vec<_>, _>>()?;
    let records = sources
        .iter()
        .flat_map(|bundle| &bundle.records)
        .collect::<Vec<_>>();
    let mut deltas = 0;
    let mut completed = 0;
    let mut public = String::new();
    let mut public_attempt = String::new();
    let mut public_attempts = 0;
    while let Ok(event) = stream.try_recv() {
        if event.topic != "runtime/model_stream"
            || event.payload["model_output_visibility"] == "internal"
        {
            continue;
        }
        let data = &event.payload["stream"];
        if matches!(data["kind"].as_str(), Some("text_delta" | "text_snapshot")) {
            let attempt = event.payload["attempt_id"]
                .as_str()
                .ok_or("Public body event has no physical attempt identity")?;
            if public_attempt != attempt {
                public_attempt = attempt.into();
                public_attempts += 1;
                public.clear();
            }
        }
        match data["kind"].as_str() {
            Some("text_delta") => {
                deltas += 1;
                public.push_str(data["text"].as_str().unwrap_or_default());
            }
            Some("text_snapshot") => public = data["text"].as_str().unwrap_or_default().into(),
            Some("completed") => completed += 1,
            _ => {}
        }
    }
    let requests = requests.lock().unwrap().clone();
    let read_paths = reads.lock().unwrap().clone();
    let host_paths = host_calls.lock().unwrap().clone();
    let correct_answer = match case.as_str() {
        "plain" => answer.contains('5'),
        "protocol-text" => answer.trim() == PROTOCOL_TEXT,
        "pure-plan" => answer.contains("纯推理原路交付"),
        "two-reads" => answer.contains(&nonce) && answer.contains(&format!("PROGRESS-{nonce}")),
        _ => answer.contains(&nonce),
    };
    let expected_native_work = if case == "discuss-script" {
        1
    } else {
        expected_reads
    };
    let annotations_ok = if case == "read-off" {
        records.is_empty()
    } else if expected_native_work > 0 {
        records
            .iter()
            .any(|record| record.kind == AnnotationKind::Title)
            && records
                .iter()
                .filter(|record| record.kind == AnnotationKind::Intent)
                .count()
                >= expected_native_work
    } else {
        records.is_empty()
    };
    let terminal = wait
        .as_ref()
        .ok()
        .and_then(|result| result.as_ref().ok())
        .map(|thread| thread.lifecycle.as_str())
        .unwrap_or("timeout_or_error");
    let passed = terminal == "completed"
        && replies.len() == 1
        && correct_answer
        && annotations_ok
        && read_paths.len() == expected_reads
        && requests.len() == expected_native_work + 1
        && sources
            .iter()
            .all(|bundle| bundle.native_response.is_some())
        && (if case == "discuss-script" {
            host_paths == ["read-workflow", "list"]
        } else {
            host_paths.is_empty()
        })
        && deltas > 0
        && public == answer
        && requests
            .windows(2)
            .all(|pair| pair[0]["tools_sha256"] == pair[1]["tools_sha256"]);
    let report = json!({"case":case,"passed":passed,"terminal":terminal,"requests":requests,"reads":read_paths,"host_reads":host_paths,
        "replies":replies.len(),"answer_valid":correct_answer,"annotations_valid":annotations_ok,
        "native_sources":sources.len(),"public_deltas":deltas,"public_completions":completed,"public_stream_attempts":public_attempts,"stream_matches_final":public == answer,
        "synthetic_answer":answer,"synthetic_public_stream":public,
        "diagnostics":events.iter().filter(|event|event.topic=="runtime/response_protocol_error").map(|event| event.payload.get("reason")).collect::<Vec<_>>()});
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(report_path)?;
    output.write_all(serde_json::to_string_pretty(&report)?.as_bytes())?;
    println!("{}", report);
    if !passed {
        return Err("Full Runtime candidate did not pass; original application unchanged".into());
    }
    Ok(())
}
