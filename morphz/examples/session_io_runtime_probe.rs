//! Explicit live gate in a disposable Runtime, never the user's business DB.
//! Uses real configured HTTP routing, durable SQLite, scheduler, tools, Context,
//! stream and original script-studio Harness. No repair or relay model calls.
//! The `injected-invalid-arguments` case corrupts ONE otherwise valid provider
//! tool invocation at the example boundary. It is explicitly not a naturally
//! failing model sample; its three real requests exercise normal tool recovery.
#[path = "support/live_native_probe_client.rs"]
mod live_native_probe_client;

use morphz::{
    config::AppConfig,
    llm::ReasoningEffort,
    memory::{ExecutionJobFilter, NewSession, QueryFilter, SessionMountKind},
    provider::build_configured_client,
    response_annotations::{AnnotationKind, PersistedAnnotations, Protocol, BUNDLE_PAYLOAD_KEY},
    runtime::{MorphzRuntime, RuntimeToolPolicy},
    secret_store::{NativeKeyringSecretBackend, SecretStore},
    session_io::{Limits, Request},
    tool::Tool,
};
use serde_json::{json, Value};
use std::{
    error::Error,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
type DynError = Box<dyn Error + Send + Sync>;

struct Read {
    root: std::path::PathBuf,
    calls: Arc<Mutex<Vec<String>>>,
}
#[async_trait::async_trait]
impl Tool for Read {
    fn name(&self) -> &str {
        "session_io_probe_read"
    }
    fn definition(&self) -> morphz::llm::ToolDefinition {
        morphz::llm::ToolDefinition {
            name: self.name().into(),
            description: "Read an explicitly authorized synthetic probe file, not any other file"
                .into(),
            parameters: json!({"type":"object","additionalProperties":false,"required":["path"],"properties":{"path":{"type":"string","enum":["review.txt","progress.txt"]}}}),
        }
    }
    async fn execute(&self, args: &str) -> Result<String, DynError> {
        let value: Value = serde_json::from_str(args)?;
        let path = value["path"].as_str().ok_or("missing path")?;
        if !matches!(path, "review.txt" | "progress.txt") {
            return Err("probe path not authorized".into());
        }
        self.calls.lock().unwrap().push(path.into());
        Ok(std::fs::read_to_string(self.root.join(path))?)
    }
}
struct Host {
    calls: Arc<Mutex<Vec<String>>>,
    nonce: String,
}
#[async_trait::async_trait]
impl Tool for Host {
    fn name(&self) -> &str {
        "host_morphz"
    }
    fn definition(&self) -> morphz::llm::ToolDefinition {
        morphz::llm::ToolDefinition {
            name: self.name().into(),
            description:
                "Read this synthetic project's actual input and catalogue; no mutation capability"
                    .into(),
            parameters: json!({"type":"object","required":["action"],"properties":{"action":{"type":"string"},"limit":{"type":"integer"},"script":{"type":"object"}}}),
        }
    }
    async fn execute(&self, args: &str) -> Result<String, DynError> {
        let args: Value = serde_json::from_str(args)?;
        match (args["action"].as_str(), args["script"]["action"].as_str()) {
            (Some("script"), Some("read-workflow")) => {
                self.calls.lock().unwrap().push("read-workflow".into());
                Ok(json!({"generating":false,"projectId":"TEST-sessionio-project","project":{"name":"TEST 灯塔"},"body":"仅讨论，不创建、不写稿：用 host_morphz 的 list 读取当前项目目录一次，只依据条目的 summary 用一句中文概括其故事冲突，并原样给出 summary 中的合成校验码。不读取正文，不执行其他操作。"}).to_string())
            }
            (Some("list"), _) => {
                self.calls.lock().unwrap().push("list".into());
                Ok(json!({"items":[{"id":"TEST-sessionio-outline","revision":1,"name":"合成大纲","summary":format!("灯塔守望者必须在守约与救人之间选择。合成校验码：{}",self.nonce)}],"nextCursor":null}).to_string())
            }
            _ => Err("This synthetic Host grants only read-workflow and list".into()),
        }
    }
}

async fn terminal(runtime: &MorphzRuntime, root: &str) -> Result<String, DynError> {
    tokio::time::timeout(Duration::from_secs(110), async {
        loop {
            if let Some(thread) = runtime
                .session_thread_by_root("TEST-sessionio-live", root)
                .await?
            {
                if thread.lifecycle.is_terminal() {
                    return Ok::<_, DynError>(thread.lifecycle.as_str().to_owned());
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await?
}

#[tokio::main]
async fn main() -> Result<(), DynError> {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("morphz=warn")
        .with_writer(std::io::stderr)
        .try_init();
    let mut args = std::env::args().skip(1);
    let config_path = args.next().ok_or("explicit model config path required")?;
    let model = args.next().ok_or("explicit model alias required")?;
    let selected = args.next();
    let protocol = if args.next().as_deref() == Some("off") {
        Protocol::Off
    } else {
        Protocol::On
    };
    let base: AppConfig = toml::from_str(&std::fs::read_to_string(config_path)?)?;
    let mut matched = false;
    for (case,input,harness,expected_calls) in [
        ("plain","直接用两行中文回答 2 加 3 等于多少。不需要任何工具。",None,1),
        ("review","必须先且仅用 session_io_probe_read 读取 review.txt，再独立判断故事是否完结，回答一句中文并原样包含文件中的合成校验码。不要根据已有印象判断。",None,2),
        ("annotated-review","必须先且仅用 session_io_probe_read 读取 review.txt，再独立判断故事是否完结，回答一句中文并原样包含文件中的合成校验码。启用注解时，在同一个实际工具调用的 _morphz 字段中提供标题和该步骤的 intent；不追加注解调用或推理轮次，最终回复保持普通正文。",None,2),
        ("progress","必须先且仅用 session_io_probe_read 读取 progress.txt，再回答已读到哪里，回答一句中文并原样包含文件中的合成校验码。不要虚构记忆。",None,2),
        ("memory","请只用 context_tx 将合成阅读进度‘已读至卷十四，贾谊陈述治安策’保存到一个新 Mind frame，读取真实提交回执后再用一句中文说明保存到了哪里。不读文件、不调用其他工具，不虚构提交成功。",None,2),
        ("infer","用两句中文解释 2 加 3，包含引号、换行和 🧠。不要调用工具。",Some("TEST-single-infer"),1),
        ("infer-record","执行合成类型校验，不调用工具。",Some("TEST-record-infer"),1),
        ("discuss-script","仅讨论，不创作。",Some("morphz.script-studio"),2),
        ("injected-invalid-arguments","必须先且仅用 session_io_probe_read 成功读取一次 review.txt，再根据实际内容判断故事是否完结，回答一句中文并原样包含文件中的合成校验码。不要凭已有印象回答；不调用其他工具。",None,3),
    ] {
        if selected.as_ref().is_some_and(|selected|selected!=case){continue;}
        matched = true;
        let injected = case == "injected-invalid-arguments";
        let temp=tempfile::TempDir::new()?;
        // The nonce never appears in the request. A correct answer must use the
        // actual tool output from this disposable directory, not prior Context.
        let nonce=format!("TEST-{}",temp.path().file_name().unwrap().to_string_lossy());
        std::fs::write(temp.path().join("review.txt"),format!("合成故事结尾：主角解决全部冲突，所有伏笔已经回收，最后一行是全书完。合成校验码：{nonce}"))?;
        std::fs::write(temp.path().join("progress.txt"),format!("合成阅读进度：已读至卷十四，贾谊陈述治安策。合成校验码：{nonce}"))?;
        let mut config=base.clone();config.llm.model=model.clone();config.llm.reasoning_effort=Some(ReasoningEffort::Max);
        config.llm.max_retries=0; // No unobserved HTTP retry inside a Client call.
        config.permissions.workspace_root=temp.path().to_string_lossy().into_owned();
        config.background_task.artifact_dir=temp.path().join("artifacts").to_string_lossy().into_owned();
        config.orchestrator.response_annotations=protocol;
        config.orchestrator.eval_callable_tools=vec!["host_morphz".into(),"session_io_probe_read".into()];
        config.orchestrator.model_attempt_hard_timeout_secs=Some(70);
        let (client,_)=build_configured_client(&config,None,Some(&model))?;
        // Keep the actual native directory intact. Stop an unexpected call at
        // the example boundary before dispatch rather than granting access to
        // arbitrary Runtime tools or user files.
        let allowed_tools = match case {
            "review" | "annotated-review" | "progress" | "injected-invalid-arguments" => vec!["session_io_probe_read".into()],
            "memory" => vec!["context_tx".into()],
            "discuss-script" => vec!["host_morphz".into()],
            _ => vec![],
        };
        let (client,audit)=live_native_probe_client::ObservedClient::new(client,injected,allowed_tools,expected_calls);
        let reads=Arc::new(Mutex::new(vec![]));let host=Arc::new(Mutex::new(vec![]));
        // Configured environment credential aliases are supplied only to this
        // process by the live runner. Keep metadata/audit in the disposable
        // directory, not the user's default Secret Store catalog.
        let secrets=Arc::new(SecretStore::new(temp.path().join("secrets.json"),Arc::new(NativeKeyringSecretBackend))?);
        let mut builder=MorphzRuntime::builder(config,client).database_path(temp.path().join("runtime.db").to_str().ok_or("invalid temp path")?)
            .secret_store(secrets)
            .tool_policy(RuntimeToolPolicy{context_only:false,coding_eval:false})
            .extra_tool(Arc::new(Read{root:temp.path().into(),calls:reads.clone()}))
            .extra_tool(Arc::new(Host{calls:host.clone(),nonce:nonce.clone()}));
        if let Some(harness)=harness {
            let source=match harness {
                "morphz.script-studio" => include_str!("../../application/harnesses/script-studio.hns"),
                "TEST-record-infer" => r#"(manifest (id "TEST-record-infer") (version "1.0.0") (title "TEST record infer") (capabilities (tools)))
                    (contract (identity "Synthetic typed value check"))
                    (eval (requires (tools)) (types (record Decision (ok Bool) (count Int) (note String)))
                      (seq (bind value (infer (returns Decision) "返回 Decision 业务记录：ok 必须是 false，count 必须是整数 9007199254740993，note 必须是字符串 中文 🧠。不调用工具，不生成活动注解。")) "合成类型校验完成"))"#,
                _ => r#"(manifest (id "TEST-single-infer") (version "1.0.0") (title "TEST single infer") (capabilities (tools))) (contract (identity "Synthetic arithmetic")) (infer (requires (tools)) (returns String) "用两句中文解释2加3：第一句给出结果，第二句解释相加的含义；包含引号、换行和🧠，返回完整String，不调用工具。")"#,
            };
            builder=builder.harness_package(morphz::harness_package::HarnessPackage::from_source("TEST-sessionio-live.hns",source)?);
        }
        let runtime=builder.build().await?;runtime.start().await?;
        let session=runtime.ensure_session(NewSession{id:"TEST-sessionio-live".into(),agent_id:runtime.identity().agent_id.clone(),context_id:runtime.identity().context_id.clone(),parent_session_id:None,title:"TEST isolated live IO gate".into(),mount_kind:SessionMountKind::ExistingContext}).await?;
        let mut request=Request::parse(json!({"io_version":"1","client_message_id":format!("TEST-sessionio-{case}"),"message":{"format":{"id":"morphz.chat","version":"1"},"content":{"encoding":"json","value":{"text":input}}}}).to_string().as_bytes(),&Limits::default())?;
        request.activation.model_alias=Some(model.clone());request.activation.reasoning_effort=Some("max".into());
        request.activation.response_annotations=Some(protocol);
        if let Some(harness)=harness {request.activation.harness=Some(morphz::harness::ExactHarnessRef{id:harness.into(),version:if harness=="morphz.script-studio"{"2.3.0"}else{"1.0.0"}.into()});}
        // The wildcard audit subscription is synchronous and ordered. Exact
        // topic subscriptions are asynchronous business handlers, not a delta
        // transport; concatenating them produced spurious stream failures.
        let mut stream=runtime.subscribe("*",8192);
        let start=Instant::now();let root=session.send_io_as_principal(request,&runtime.identity().principal_id).await?;
        let lifecycle=terminal(&runtime,&root.id).await;
        let events=runtime.query_events(QueryFilter{context_id:Some(runtime.identity().context_id.clone()),after_sequence:Some(0),..Default::default()}).await?;
        // Preserve synthetic provider responses and actual Runtime receipts
        // before any assertion/terminal error can exit the disposable process.
        // A capture is explicitly NOT a passing acceptance report.
        println!("{}",json!({
            "passed":false,"stage":"evidence_capture_before_acceptance","case":case,"protocol":protocol,
            "terminal":lifecycle.as_ref().ok(),"terminal_error":lifecycle.as_ref().err().map(ToString::to_string),
            "client_audit":audit.lock().unwrap().clone(),
            "host_reads":host.lock().unwrap().clone(),"file_reads":reads.lock().unwrap().clone(),
            "runtime_receipts":events.iter().filter(|event|matches!(event.topic.as_str(),"chat/tool_output"|"chat/runtime_error"|"runtime/response_protocol_error"|"runtime/inference_value"|"session/io_state"|"chat/reply")).map(|event|json!({"topic":event.topic,"payload":event.payload})).collect::<Vec<_>>(),
            "normalized_sources":events.iter().filter_map(|event|event.payload.get(BUNDLE_PAYLOAD_KEY)).collect::<Vec<_>>(),
            "evidence_kind":if injected {"real_provider_with_explicit_once_only_argument_fault_injection"}else{"unmodified_real_provider"}
        }));
        let lifecycle=lifecycle?;
        let replies=events.iter().filter(|event|event.topic=="chat/reply" && event.payload["root_turn_id"]==root.id).collect::<Vec<_>>();
        if lifecycle!="completed" || replies.len()!=1 || events.iter().any(|event|event.topic=="runtime/response_protocol_error") {
            let all=runtime.query_events(QueryFilter{context_id:Some(runtime.identity().context_id.clone()),after_sequence:Some(0),..Default::default()}).await?;
            let details=all.iter().filter(|event|event.topic.contains("error")||event.topic=="session/io_state"||event.topic=="chat/infer_result").map(|event|json!({"topic":event.topic,"reason":event.payload.get("reason"),"failure_kind":event.payload.get("runtime_failure_kind"),"sha256":event.payload.get("response_capture").and_then(|capture|capture.get("sha256")),"raw_response":event.payload.get("response_capture").and_then(|capture|capture.get("raw_response"))})).collect::<Vec<_>>();
            return Err(format!("Live {model}/{case} failed: {}",json!(details)).into());
        }
        let reply = replies[0];
        let bundles=events.iter().filter_map(|event|event.payload.get(BUNDLE_PAYLOAD_KEY)).map(|value|serde_json::from_value::<PersistedAnnotations>(value.clone())).collect::<Result<Vec<_>,_>>()?;
        let physical=events.iter().filter(|event|event.topic=="runtime/model_usage").count();
        let audit=audit.lock().unwrap().clone();
        assert_eq!(audit.unobserved_completion_entrypoints,0,"all real requests must be observed at the immutable bound options entrypoint");
        assert_eq!(audit.health_probes,0,"no hidden provider probe or recovery request");
        assert_eq!(audit.requests.len(),physical,"every physical call has an observed real client request");
        let directory_hashes=audit.requests.iter().map(|request|request["tools_sha256"].clone()).collect::<Vec<_>>();
        assert!(directory_hashes.windows(2).all(|pair|pair[0]==pair[1]),"work continuation mutated the tool directory");
        assert!(audit.requests.iter().all(|request|request["native_v3_in_context"]==true),"every request must use the approved native_v3 Context");
        assert_eq!(physical,expected_calls,"{case}: no metadata-repair, relay or extra business request");
        assert!(!bundles.is_empty());
        assert!(bundles.iter().all(|bundle|bundle.return_binding.as_ref().is_some_and(|binding|binding.is_native()) && bundle.native_response.is_some()),"native response evidence must persist in both annotation modes");
        assert!(bundles.iter().flat_map(|bundle|&bundle.raw_response.tool_calls).all(|call|!matches!(call.func_name.as_str(),"deliver_message"|"annotate_response"|"response_annotations")),"no annotation-only delivery call");
        if harness.is_none() {
            assert!(audit.requests.iter().all(|request|request["output_encoding"]=="None"),"ordinary body, including after work, must not require a JSON output shell");
        }
        if protocol.is_off() { assert!(bundles.iter().all(|bundle|bundle.records.is_empty() && bundle.annotation_messages.is_empty())); }
        if case=="plain" {
            assert!(reply.payload["text"].as_str().is_some_and(|text|text.contains('5')||text.contains('五')));
            assert!(bundles.iter().all(|bundle|bundle.raw_response.tool_calls.is_empty()),"ordinary no-work conversation must remain a body, not a fabricated action");
        }
        if matches!(case,"review"|"annotated-review"|"progress"|"injected-invalid-arguments") {
            assert_eq!(reads.lock().unwrap().len(),1);
            assert!(reply.payload["text"].as_str().is_some_and(|text|text.contains(&nonce) && if case=="progress" {text.contains("十四")||text.contains("14")}else{text.contains("完")}));
        }
        if case=="discuss-script" {
            assert_eq!(host.lock().unwrap().as_slice(),&["read-workflow","list"]);
            assert!(reply.payload["text"].as_str().is_some_and(|text|text.contains(&nonce)));
        }
        if case=="memory" {assert_eq!(runtime.mind_version(&runtime.identity().context_id).await?,1,"exactly one real Context commit, not a synthetic memory claim");}
        if case=="infer-record" {
            let values=events.iter().filter(|event|event.topic=="runtime/inference_value").collect::<Vec<_>>();
            assert_eq!(values.len(),1);
            let value:Value=serde_json::from_str(values[0].payload["text"].as_str().ok_or("missing typed value")?)?;
            assert_eq!(value,json!({"$yao":{"kind":"record","type":"Decision","fields":{"ok":false,"count":9007199254740993_i64,"note":"中文 🧠"}}}));
            let schema=bundles[0].return_binding.as_ref().unwrap().body_value_schema.as_ref().ok_or("typed generation schema missing")?;
            assert_eq!(schema["$defs"]["Decision"]["properties"]["ok"]["type"],"boolean");
            assert_eq!(schema["$defs"]["Decision"]["properties"]["count"]["type"],"integer");
            assert_eq!(reply.payload["text"],"合成类型校验完成");
        }
        let mut public=String::new();let mut chunks=0;let mut internal_chunks=0;let mut public_attempt=String::new();
        while let Ok(event)=stream.try_recv(){
            if event.topic!="runtime/model_stream" {continue;}
            let data=&event.payload["stream"];
            if !matches!(data["kind"].as_str(),Some("text_delta"|"text_snapshot")) {continue;}
            if event.payload["model_output_visibility"]=="internal" {
                if data["kind"]=="text_delta" {internal_chunks+=1;}
                continue;
            }
            let attempt=event.payload["attempt_id"].as_str().ok_or("stream lacks physical attempt ID")?;
            if public_attempt!=attempt {public_attempt=attempt.into();public.clear();chunks=0;}
            if data["kind"]=="text_snapshot" {public=data["text"].as_str().unwrap().into();}
            else {chunks+=1;public.push_str(data["text"].as_str().unwrap());}
        }
        if case=="infer-record" {
            assert!(public.is_empty(),"internal record must not become a public draft");
            assert!(internal_chunks>1,"typed record must retain its internal value stream");
        } else {
            assert!(!public.is_empty()&&chunks>1,"{case}: incremental public body missing: public_chars={}, chunks={}, internal_chunks={}",public.chars().count(),chunks,internal_chunks);
            assert_eq!(public,reply.payload["text"].as_str().unwrap(),"final physical attempt body stream must exactly equal its delivered reply");
        }
        let jobs=runtime.list_execution_jobs(ExecutionJobFilter{session_id:Some("TEST-sessionio-live".into()),include_terminal:true,..Default::default()}).await?;
        if injected {
            let receipt=audit.injection.as_ref().ok_or("injection was not applied")?;
            let rejected=events.iter().filter(|event|event.topic=="chat/tool_output" && event.payload["tool_call_id"]==receipt.call_id && event.payload["rejection_code"]=="INVALID_TOOL_ARGUMENTS").collect::<Vec<_>>();
            assert_eq!(rejected.len(),1,"exactly one durable, model-visible argument rejection");
            assert_eq!(rejected[0].payload["executed"],false);
            assert_eq!(rejected[0].payload["retryable_unchanged"],false);
            assert!(rejected[0].payload["error"].as_str().is_some_and(|error|error.contains("JSON")),"specific syntax error must not be replaced by a generic failure");
            assert!(jobs.iter().all(|job|job.tool_call_id!=receipt.call_id),"invalid native call must not create a Job");
            assert_eq!(jobs.iter().filter(|job|job.tool_name=="session_io_probe_read").count(),1,"only the corrected real read can own a Job");
            assert_eq!(reads.lock().unwrap().as_slice(),&["review.txt"],"rejected call must never enter the tool body");
            assert_eq!(audit.requests[1]["rejection_with_call_id_visible"],true,"real DeepSeek continuation must receive the rejected call identity and concrete correction instruction");
            assert!(bundles.iter().any(|bundle|bundle.raw_response.tool_calls.iter().any(|call|call.id==receipt.call_id && call.arguments==receipt.injected_arguments)),"persist the exact deliberately corrupted native response as diagnostic evidence");
        } else {
            assert!(audit.injection.is_none(),"normal cases must not inject or repair model responses");
        }
        let coverage = [AnnotationKind::Title,AnnotationKind::Intent,AnnotationKind::ObservationResult,AnnotationKind::Result].into_iter().map(|kind| (format!("{kind:?}"),json!(bundles.iter().flat_map(|bundle|&bundle.records).filter(|record|record.kind==kind).count()))).collect::<serde_json::Map<_,_>>();
        // Normal live cases gate annotation generation quality separately from
        // delivery. The deliberately corrupted call loses its metadata too;
        // recovery must not require metadata that production treats as optional.
        if !protocol.is_off() && matches!(case, "review" | "annotated-review" | "progress" | "discuss-script") {
            for kind in [AnnotationKind::Title, AnnotationKind::Intent] {
                assert!(
                    bundles.iter().flat_map(|bundle| &bundle.records).any(|record| record.kind == kind),
                    "{model}/{case}: successful work alone does not verify annotation generation; missing {kind:?}"
                );
            }
        }
        println!("{}",json!({"passed":true,"model":model,"case":case,"protocol":protocol,"terminal":lifecycle,"model_requests":physical,"tool_directory_sha256":directory_hashes,"jobs":jobs.len(),"public_body_chunks":chunks,"internal_value_chunks":internal_chunks,"body":reply.payload["text"],"elapsed_ms":start.elapsed().as_millis(),"annotation_records":bundles.iter().map(|bundle|bundle.records.len()).collect::<Vec<_>>(),"annotation_coverage":coverage,"diagnostics":bundles.iter().map(|bundle|bundle.diagnostics.len()).collect::<Vec<_>>(),"host_reads":host.lock().unwrap().clone(),"file_reads":reads.lock().unwrap().clone(),"client_audit":audit,"evidence_kind":if injected {"real_provider_with_explicit_once_only_argument_fault_injection"}else{"unmodified_real_provider"}}));
    }
    if !matched {
        return Err("unknown probe case; no live request was made".into());
    }
    Ok(())
}
