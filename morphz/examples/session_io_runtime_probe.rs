//! Explicit live gate in a disposable Runtime, never the user's business DB.
//! Uses real configured HTTP routing, durable SQLite, scheduler, tools, Context,
//! stream and original script-studio Harness. No repair or relay model calls.
use morphz::{
    config::AppConfig,
    event::Event,
    llm::ReasoningEffort,
    memory::{ExecutionJobFilter, NewSession, QueryFilter, SessionMountKind},
    provider::build_configured_client,
    response_annotations::{AnnotationKind, PersistedAnnotations, Protocol, BUNDLE_PAYLOAD_KEY},
    runtime::{MorphzRuntime, RuntimeToolPolicy},
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
                Ok(json!({"generating":false,"projectId":"TEST-sessionio-project","project":{"name":"TEST 灯塔"},"body":"仅讨论，不创建、不写稿：当前 TEST 灯塔项目目录中的故事有什么可讨论的冲突？请基于已经读取的真实目录，用一句中文回答。"}).to_string())
            }
            (Some("list"), _) => {
                self.calls.lock().unwrap().push("list".into());
                Ok(json!({"items":[{"id":"TEST-sessionio-outline","revision":1,"name":"合成大纲","summary":"灯塔守望者必须在守约与救人之间选择。"}],"nextCursor":null}).to_string())
            }
            _ => Err("This synthetic Host grants only read-workflow and list".into()),
        }
    }
}

async fn terminal(runtime: &MorphzRuntime, root: &str) -> Result<Event, DynError> {
    Ok(tokio::time::timeout(Duration::from_secs(110), async {
        loop {
            let events = runtime
                .query_events(QueryFilter {
                    root_turn_id: Some(root.into()),
                    ..Default::default()
                })
                .await?;
            if let Some(event) = events.into_iter().find(|event| {
                event.topic == "chat/reply"
                    || event.topic == "session/io_state"
                        && event.payload["terminal_kind"] == "failed"
            }) {
                return Ok::<_, DynError>(event);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await??)
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
    for (case,input,harness,expected_calls) in [
        ("plain","直接用两行中文回答 2 加 3 等于多少。不需要任何工具。",None,1),
        ("review","必须先且仅用 session_io_probe_read 读取 review.txt，再独立判断故事是否完结，回答一句中文。不要根据已有印象判断。",None,2),
        ("annotated-review","必须先且仅用 session_io_probe_read 读取 review.txt，再独立判断故事是否完结，回答一句中文。这个 TEST 也请在读取的同一次响应中，用现有通用 Session IO 提供 calls.intent 注解；读取结果之后，用同一次最终响应提供有依据的结果注解，正文照常交付。不要专门追加注解轮次。",None,2),
        ("progress","必须先且仅用 session_io_probe_read 读取 progress.txt，再回答已读到哪里，回答一句中文。不要虚构记忆。",None,2),
        ("memory","请只用 context_tx 将合成阅读进度‘已读至卷十四，贾谊陈述治安策’保存到一个新 Mind frame，读取真实提交回执后再用一句中文说明保存到了哪里。不读文件、不调用其他工具，不虚构提交成功。",None,2),
        ("infer","用两句中文解释 2 加 3，包含引号、换行和 🧠。不要调用工具。",Some("TEST-single-infer"),1),
        ("discuss-script","仅讨论，不创作。",Some("morphz.script-studio"),2),
    ] {
        if selected.as_ref().is_some_and(|selected|selected!=case){continue;}
        let temp=tempfile::TempDir::new()?;
        std::fs::write(temp.path().join("review.txt"),"合成故事结尾：主角解决全部冲突，所有伏笔已经回收，最后一行是全书完。")?;
        std::fs::write(temp.path().join("progress.txt"),"合成阅读进度：已读至卷十四，贾谊陈述治安策。")?;
        let mut config=base.clone();config.llm.model=model.clone();config.llm.reasoning_effort=Some(ReasoningEffort::Max);
        config.permissions.workspace_root=temp.path().to_string_lossy().into_owned();
        config.background_task.artifact_dir=temp.path().join("artifacts").to_string_lossy().into_owned();
        config.orchestrator.response_annotations=protocol;
        config.orchestrator.eval_callable_tools=vec!["host_morphz".into(),"session_io_probe_read".into()];
        config.orchestrator.model_attempt_hard_timeout_secs=Some(70);
        let (client,_)=build_configured_client(&config,None,Some(&model))?;
        let reads=Arc::new(Mutex::new(vec![]));let host=Arc::new(Mutex::new(vec![]));
        let mut builder=MorphzRuntime::builder(config,client).database_path(temp.path().join("runtime.db").to_str().ok_or("invalid temp path")?)
            .tool_policy(RuntimeToolPolicy{context_only:false,coding_eval:false})
            .extra_tool(Arc::new(Read{root:temp.path().into(),calls:reads.clone()}))
            .extra_tool(Arc::new(Host{calls:host.clone()}));
        if let Some(harness)=harness {
            let source=if harness=="morphz.script-studio" {include_str!("../../application/harnesses/script-studio.hns")}else{r#"(manifest (id "TEST-single-infer") (version "1.0.0") (title "TEST single infer") (capabilities (tools))) (contract (identity "Synthetic arithmetic")) (infer (requires (tools)) (returns String) "用两句中文解释2加3：第一句给出结果，第二句解释相加的含义；包含引号、换行和🧠，返回完整String，不调用工具。")"#};
            builder=builder.harness_package(morphz::harness_package::HarnessPackage::from_source("TEST-sessionio-live.hns",source)?);
        }
        let runtime=builder.build().await?;runtime.start().await?;
        let session=runtime.ensure_session(NewSession{id:"TEST-sessionio-live".into(),agent_id:runtime.identity().agent_id.clone(),context_id:runtime.identity().context_id.clone(),parent_session_id:None,title:"TEST isolated live IO gate".into(),mount_kind:SessionMountKind::ExistingContext}).await?;
        let mut request=Request::parse(json!({"io_version":"1","client_message_id":format!("TEST-sessionio-{case}"),"message":{"format":{"id":"morphz.chat","version":"1"},"content":{"encoding":"json","value":{"text":input}}}}).to_string().as_bytes(),&Limits::default())?;
        request.activation.model_alias=Some(model.clone());request.activation.reasoning_effort=Some("max".into());
        if let Some(harness)=harness {request.activation.harness=Some(morphz::harness::ExactHarnessRef{id:harness.into(),version:if harness=="morphz.script-studio"{"2.3.0"}else{"1.0.0"}.into()});}
        let mut stream=runtime.subscribe("runtime/model_stream",8192);
        let start=Instant::now();let root=session.send_io_as_principal(request,&runtime.identity().principal_id).await?;
        let reply=terminal(&runtime,&root.id).await?;
        let events=runtime.query_events(QueryFilter{context_id:Some(runtime.identity().context_id.clone()),after_sequence:Some(0),..Default::default()}).await?;
        if reply.topic!="chat/reply" || events.iter().any(|event|event.topic=="runtime/response_protocol_error") {
            let all=runtime.query_events(QueryFilter{context_id:Some(runtime.identity().context_id.clone()),after_sequence:Some(0),..Default::default()}).await?;
            let details=all.iter().filter(|event|event.topic.contains("error")||event.topic=="session/io_state"||event.topic=="chat/infer_result").map(|event|json!({"topic":event.topic,"reason":event.payload.get("reason"),"failure_kind":event.payload.get("runtime_failure_kind"),"sha256":event.payload.get("response_capture").and_then(|capture|capture.get("sha256")),"raw_response":event.payload.get("response_capture").and_then(|capture|capture.get("raw_response"))})).collect::<Vec<_>>();
            return Err(format!("Live {model}/{case} failed: {}",json!(details)).into());
        }
        let bundles=events.iter().filter_map(|event|event.payload.get(BUNDLE_PAYLOAD_KEY)).map(|value|serde_json::from_value::<PersistedAnnotations>(value.clone())).collect::<Result<Vec<_>,_>>()?;
        let physical=events.iter().filter(|event|event.topic=="runtime/model_usage").count();
        assert_eq!(physical,expected_calls,"{case}: no metadata-repair, relay or extra business request");
        assert!(!bundles.is_empty());
        assert!(bundles.iter().all(|bundle|bundle.return_binding.as_ref().is_some_and(|binding|binding.output.is_none())),"annotations cannot select an Evaluation envelope");
        if protocol.is_off() { assert!(bundles.iter().all(|bundle|bundle.records.is_empty() && bundle.annotation_messages.is_empty())); }
        if case=="review" || case=="annotated-review" || case=="progress" {
            assert_eq!(reads.lock().unwrap().len(),1);
            assert!(reply.payload["text"].as_str().is_some_and(|text| if case=="review" || case=="annotated-review" {text.contains("完")}else{text.contains("十四") || text.contains("14")}));
        }
        if case=="discuss-script" {assert_eq!(host.lock().unwrap().as_slice(),&["read-workflow","list"]);}
        if case=="memory" {assert_eq!(runtime.mind_version(&runtime.identity().context_id).await?,1,"exactly one real Context commit, not a synthetic memory claim");}
        let mut public=String::new();let mut chunks=0;let mut internal_chunks=0;
        while let Ok(event)=stream.try_recv(){if event.payload["stream"]["kind"]=="text_delta" {if event.payload["model_output_visibility"]=="internal" {internal_chunks+=1;} else {chunks+=1;public.push_str(event.payload["stream"]["text"].as_str().unwrap());}}}
        assert!(!public.is_empty()&&chunks>1,"{case}: incremental public body missing: public_chars={}, chunks={}, internal_chunks={}",public.chars().count(),chunks,internal_chunks);
        assert!(!public.contains("\"effects\"")&&!public.contains("\"execution\""),"metadata leaked into public body");
        let jobs=runtime.list_execution_jobs(ExecutionJobFilter{session_id:Some("TEST-sessionio-live".into()),include_terminal:true,..Default::default()}).await?;
        let coverage = [AnnotationKind::Title,AnnotationKind::Intent,AnnotationKind::ObservationResult,AnnotationKind::Result].into_iter().map(|kind| (format!("{kind:?}"),json!(bundles.iter().flat_map(|bundle|&bundle.records).filter(|record|record.kind==kind).count()))).collect::<serde_json::Map<_,_>>();
        println!("{}",json!({"model":model,"case":case,"protocol":protocol,"model_requests":physical,"jobs":jobs.len(),"public_body_chunks":chunks,"internal_value_chunks":internal_chunks,"body":reply.payload["text"],"elapsed_ms":start.elapsed().as_millis(),"annotation_records":bundles.iter().map(|bundle|bundle.records.len()).collect::<Vec<_>>(),"annotation_coverage":coverage,"diagnostics":bundles.iter().map(|bundle|bundle.diagnostics.len()).collect::<Vec<_>>(),"host_reads":host.lock().unwrap().clone(),"file_reads":reads.lock().unwrap().clone()}));
    }
    Ok(())
}
