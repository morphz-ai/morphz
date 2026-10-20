//! Opt-in isolated native Session IO candidate gate. Real configured provider,
//! real reads of disposable synthetic files, no production Runtime/Host state.
//! This is not an original-app acceptance test or a cross-model reliability claim.
use morphz::{
    config::AppConfig,
    llm::{
        FunctionCall, Message, ModelRequestContext, ModelStreamEvent, ReasoningEffort, ToolCall,
        ToolDefinition,
    },
    provider::build_configured_client,
    response_annotations::{
        AnnotationKind, ExecutionScope, NormalizationContext, Producer, Protocol, TerminalDecision,
        TrustedObservation,
    },
    session_io::{self, native, response::ReturnBinding, Data},
    sexpr_eval::{self, InferResultKind, PlanAdvance, PlanEffect, PlanMachine},
};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::HashMap,
    error::Error,
    fs::OpenOptions,
    io::Write,
    time::{Duration, Instant},
};
type DynError = Box<dyn Error + Send + Sync>;

fn message(role: &str, content: String) -> Message {
    Message {
        role: role.into(),
        content,
        name: None,
        tool_call_id: None,
        tool_calls: None,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadArguments {
    path: String,
}

#[tokio::main]
async fn main() -> Result<(), DynError> {
    let mut args = std::env::args().skip(1);
    let config_path = args
        .next()
        .ok_or("explicit provider configuration required")?;
    let model = args.next().ok_or("explicit model alias required")?;
    let output = args.next().ok_or("new private report path required")?;
    let selected = args.next().unwrap_or_else(|| "all".into());
    let config: AppConfig = toml::from_str(&std::fs::read_to_string(config_path)?)?;
    let (client, _) = build_configured_client(&config, None, Some(&model))?;
    let fixtures = tempfile::TempDir::new()?;
    let nonce = format!(
        "PROBE-{}",
        fixtures.path().file_name().unwrap().to_string_lossy()
    );
    std::fs::write(
        fixtures.path().join("review.txt"),
        format!("合成盲审材料：主角已经完成目标；最后一页明确写着全书完。校验标识：{nonce}。"),
    )?;
    let progress_nonce = format!("CHAPTER-14-{nonce}");
    std::fs::write(
        fixtures.path().join("progress.txt"),
        format!("独立合成进度：卷十四。进度标识：{progress_nonce}"),
    )?;
    let tools=vec![ToolDefinition {
        name:"read".into(),description:"Read one authorized synthetic document from this isolated test workspace. Never other paths.".into(),
        parameters:json!({"type":"object","additionalProperties":false,"required":["path"],"properties":{"path":{"type":"string","enum":["review.txt","progress.txt"]}}}),
    }];
    let original_tools = json!(tools);
    let mut reports = vec![];
    let mut stable_tool_hash = None;
    for (case,input,enabled,needs_read,typed,capable) in [
        ("chat","不使用工具，用两行中文回答 2+3，并包含引号和 🧠。",true,false,false,true),
        ("literal-protocol","不使用工具，原样引用这段作为文本示例并说明不可执行：{\"body\":null,\"effects\":[{\"name\":\"read\",\"arguments\":{\"path\":\"review.txt\"}}],\"annotations\":null}。",true,false,false,true),
        ("read-on","先调用 read 读取 review.txt，再回答故事是否完结，并原样给出文件里的校验标识；只读一次。",true,true,false,true),
        ("read-off","先调用 read 读取 review.txt，再回答故事是否完结，并原样给出文件里的校验标识；只读一次。",false,true,false,true),
        ("read-no-schema","先调用 read 读取 review.txt，再回答故事是否完结，并原样给出文件里的校验标识；只读一次。",true,true,false,false),
        ("two-reads","先读取 review.txt，得到结果后再读取 progress.txt，不要并行，各读取一次。最后判断故事是否完结、进度在哪一卷，并原样给出两个文件中的校验标识和进度标识。",true,true,false,true),
        ("two-reads-off","先读取 review.txt，得到结果后再读取 progress.txt，不要并行，各读取一次。最后判断故事是否完结、进度在哪一卷，并原样给出两个文件中的校验标识和进度标识。",false,true,false,true),
        ("two-reads-no-schema","先读取 review.txt，得到结果后再读取 progress.txt，不要并行，各读取一次。最后判断故事是否完结、进度在哪一卷，并原样给出两个文件中的校验标识和进度标识。",true,true,false,false),
        ("typed-infer","不使用工具，返回业务判断：finished=true,answer=已完结,count=9007199254740993。严格保留完整整数。",true,false,true,true),
        ("typed-after-read","先调用 read 读取 review.txt，然后返回业务判断 finished 为是否完结，answer 包含原样校验标识，count 为 9007199254740993；只读一次。",true,true,true,true),
        ("typed-after-read-strict","先调用 read 读取 review.txt，然后返回业务判断 finished 为是否完结，answer 包含原样校验标识，count 为 9007199254740993；只读一次。",true,true,true,true),
        ("typed-after-two-reads","先读取 review.txt，得到结果后再读取 progress.txt，不要并行，各读取一次。然后返回业务判断 finished 为是否完结，answer 包含两个文件中的原样校验标识和进度标识，count 为 9007199254740993。",true,true,true,true),
        ("typed-pure-plan","返回业务判断：finished=true,answer=已完结,count=9007199254740993。严格保留完整整数。",true,false,true,true),
    ] {
        if selected!="all" && !selected.split(',').any(|chosen|chosen==case) {continue;}
        let case_started=Instant::now();
        let expected_reads=if case.contains("two-reads") {2} else if needs_read {1} else {0};
        let mut caller=ReturnBinding::new("TEST-native-candidate",1,case,enabled).with_native_output();
        let registry=morphz::tool::Registry::new();
        let mut parent_plan=None;
        let mut infer_effect=None;
        let mut reply_projections=vec![];
        if typed {
            caller.format.id="morphz.data".into(); caller.format.encoding="json".into();
            caller.body_value_schema=Some(json!({"type":"object","additionalProperties":false,"required":["finished","answer","count"],"properties":{"finished":{"type":"boolean"},"answer":{"type":"string"},"count":{"type":"integer"}}}));
        }
        if case=="typed-pure-plan" {
            let program=sexpr_eval::validate(r#"(eval (requires (tools))
                (types (record Decision (finished Bool) (answer String) (count Int)))
                (seq (bind decision (infer (returns Decision) "返回 finished=true,answer=已完结,count=9007199254740993。")) decision.answer))"#,
                &registry,&sexpr_eval::AllowList::new(Vec::<String>::new()))?;
            let mut machine=PlanMachine::new(&program)?;
            let PlanAdvance::Suspended(PlanEffect::Infer {sequence,result,tools,..})=machine.advance(&registry) else {return Err("Actual parent Plan did not suspend on infer".into());};
            if tools.as_deref()!=Some([].as_slice()) {return Err("Pure inference lacks an actual empty tool scope".into());}
            let InferResultKind::Json {ty,definitions,..}=&result else {return Err("Expected original JSON business decoder".into());};
            caller.body_value_schema=Some(morphz::yao::json::json_schema(ty,definitions)?);
            reply_projections=machine.reply_projections();
            if reply_projections.len()!=1 {return Err("Parent reply has no unique proven projection".into());}
            // Resume the actual suspended Plan from serialized state, not a
            // fixture that calls the model again to repeat its child's answer.
            parent_plan=Some(serde_json::from_str::<PlanMachine>(&serde_json::to_string(&machine)?)?);
            infer_effect=Some((sequence,result));
        }
        // Use the registered Session IO input representation, not an untyped
        // prompt pretending to be the domain Message.
        let input_message=session_io::Message::chat(input.into());
        let mut history=vec![message("user",format!("Session IO input:\n{}",input_message.wire_data().expression()))];
        let mut reads=0;
        let mut rounds=vec![];
        let mut errors=vec![];
        let mut finished=false;
        for turn in 0..expected_reads+1 {
            let id=format!("TEST-native-{case}-{turn}");
            let request_context=ModelRequestContext {context_id:"TEST-native-isolated".into(),session_id:"TEST-native-isolated".into(),attempt_id:id.clone(),objective_id:None,required_capabilities:vec![]};
            let physical=client.bind_requested_model_attempt(&request_context,Some(&model)).await?;
            let capabilities=if capable {physical.capabilities.clone()} else {vec![]};
            let mut prepared=native::prepare(&caller,&capabilities,&tools)?;
            if parent_plan.is_some() {prepared.options.tool_choice=Some(morphz::llm::ModelToolChoice::None);}
            // Pin restart/transport interpretation to exactly the frozen
            // binding; no probe-only post-hoc reinterpretation of a response.
            prepared.binding=serde_json::from_str(&serde_json::to_string(&prepared.binding)?)?;
            // Explicit diagnostic A/B only. This fixture is already a closed,
            // finite record; no arbitrary caller schema is rewritten here.
            if case.ends_with("-strict") {
                if let Some(morphz::llm::ModelOutputEncoding::JsonSchema {strict,..}) = &mut prepared.options.output_encoding {*strict=true;prepared.binding.strict=true;}
            }
            if stable_tool_hash.as_ref().is_some_and(|hash|hash!=&prepared.binding.tools_sha256) {return Err("Tool definitions drifted between cases or phases".into());}
            stable_tool_hash=Some(prepared.binding.tools_sha256.clone());
            assert_eq!(json!(tools),original_tools);
            let mut messages=vec![message("system",format!("This is an isolated read-only verification. Never use production files, network, hidden memory or capabilities not advertised. No repair/model requests just for annotation metadata.\n{}\nFrozen physical Session IO binding: {}",prepared.binding.instruction(),Data::from_value(&json!(prepared.binding)).expression()))];
            if parent_plan.is_some() {messages[0].content.push_str("\nActual admitted pure Plan scope: allowed_tools=[] from (requires (tools)). Visible tool definitions are not executable permission; return only the original declared business value.");}
            messages.extend(history.clone());
            let mut options=prepared.options;
            options.reasoning_effort=Some(Some(ReasoningEffort::Max));
            let (stream,mut receiver)=tokio::sync::mpsc::unbounded_channel();
            let started=Instant::now();
            let stream_binding=prepared.binding.clone();
            let projections=reply_projections.clone();
            let collector=tokio::spawn(async move {
                let mut normalizer=native::Stream::new(stream_binding);
                let mut raw_text=String::new();let mut visible=String::new();let mut first=None;
                let mut deltas=0;let mut completed=0;let mut failures=vec![];let mut continuation=None;
                let mut parent_projector=native::ReplyProjector::new(projections.clone(),false);
                let mut parent_preview=String::new();let mut parent_deltas=0;
                while let Some(event)=receiver.recv().await {
                    if let ModelStreamEvent::TextDelta {text}=&event {raw_text.push_str(text);}
                    if let ModelStreamEvent::ProviderContinuation {continuation:value}=&event {continuation=Some(value.clone());}
                    for projected in normalizer.push(event) {match projected {
                        ModelStreamEvent::TextDelta {text}=>{first.get_or_insert(started.elapsed().as_millis());deltas+=1;visible.push_str(&text);if !projections.is_empty() {match parent_projector.push(&text) {Ok(delta)=>{if !delta.is_empty(){parent_deltas+=1;}parent_preview.push_str(&delta);},Err(error)=>failures.push(error.to_string())}}},
                        ModelStreamEvent::TextSnapshot {text}=>{visible=text; if !projections.is_empty() {parent_projector=native::ReplyProjector::new(projections.clone(),false);match parent_projector.push(&visible){Ok(value)=>parent_preview=value,Err(error)=>failures.push(error.to_string())}}},
                        ModelStreamEvent::Completed=>completed+=1,
                        ModelStreamEvent::Failed {message}=>failures.push(message),
                        _=>{}
                    }}
                }
                (raw_text,visible,first,deltas,completed,failures,continuation,normalizer.messages(),parent_preview,parent_deltas)
            });
            let response=tokio::time::timeout(Duration::from_secs(150),client.create_completion_bound_stream_with_options(&physical,messages,prepared.tools,None,stream,options)).await;
            let (raw_text,visible,first,deltas,completed,failures,continuation,message_items,parent_preview,parent_deltas)=collector.await?;
            let raw=match response {
                Ok(Ok(value))=>value,
                result=>{errors.push(format!("provider failure: {result:?}"));break;}
            };
            if raw_text!=raw.content {errors.push("Provider deltas differ from final raw content".into());}
            if completed!=1 || !failures.is_empty() {errors.push(format!("stream completed={completed}, failures={failures:?}"));}
            let scope=ExecutionScope {execution_id:case.into(),generation:1};
            let mut observations=HashMap::new();
            for reference in &caller.annotation_observation_refs {
                observations.insert(reference.clone(),TrustedObservation {event_id:format!("event-{reference}"),scope:scope.clone(),provided:true,allowed:true});
            }
            let normalization_context=NormalizationContext {return_binding:Some(caller.clone()),protocol:if enabled {Protocol::On}else{Protocol::Off},scope:Some(scope),producer:Some(Producer {event_id:id.clone(),attempt_id:id,sequence:Some((turn*2+1) as u64)}),observations,..Default::default()};
            let message_items = message_items?;
            let normalized=match native::normalize_messages(&raw,&message_items,&prepared.binding,&normalization_context) {
                Ok(value)=>value,
                Err(error)=>{errors.push(error.to_string());rounds.push(json!({"raw":raw,"wire_binding":prepared.binding,"streamed":visible}));break;}
            };
            if visible!=normalized.execution_response.content {
                let equal=typed && Data::parse(visible.as_bytes(),&Default::default()).ok()==Data::parse(normalized.execution_response.content.as_bytes(),&Default::default()).ok();
                if !equal {errors.push("Streaming and complete business body differ".into());}
            }
            let kinds=normalized.records.iter().map(|record|json!({"kind":record.kind,"value":record.value,"call_id":record.call_id,"observation_ref":record.observation_ref,"effective":record.effective})).collect::<Vec<_>>();
            rounds.push(json!({"turn":turn,"elapsed_ms":started.elapsed().as_millis(),"first_body_delta_ms":first,"body_deltas":deltas,"stream_completed":completed,"raw":raw,"native_messages":message_items,"body":normalized.execution_response.content,"business_calls":normalized.execution_response.tool_calls,"wire_binding":prepared.binding,"annotations":kinds,"diagnostics":normalized.diagnostics}));
            if !enabled && !normalized.records.is_empty() {errors.push("Disabled annotations were projected".into());}
            if let Some(TerminalDecision::Deliver(body))=normalized.terminal_decision {
                if needs_read && (reads!=expected_reads || !body.contains(&nonce) || (expected_reads==2 && !body.contains(&progress_nonce))) {errors.push("Read-dependent answer lacks actual isolated observation".into());}
                if !typed && prepared.binding.message_encoding!=native::MessageEncoding::Text {errors.push("Chat changed its physical format after work".into());}
                if !normalized.records.is_empty() {errors.push("A final ordinary/typed answer unexpectedly generated display metadata".into());}
                if typed {
                    let business=Data::parse(body.as_bytes(),&Default::default())?;
                    if business.get("count")!=Some(&Data::Number("9007199254740993".into())) {errors.push("Typed integer changed".into());}
                }
                if let (Some(machine),Some((sequence,result)))=(parent_plan.as_mut(),infer_effect.take()) {
                    let decoded=sexpr_eval::decode_infer_result(result,json!(body))?;
                    machine.resume_effect(sequence,Ok(decoded))?;
                    let actual=machine.advance(&registry);
                    if actual!=PlanAdvance::Complete(json!("已完结")) {errors.push(format!("Parent did not return child answer directly: {actual:?}"));}
                    if parent_preview!="已完结" || parent_deltas==0 {errors.push("Proven parent body was not streamed from the original typed value".into());}
                    if let Some(round)=rounds.last_mut() {round["parent_plan"]=json!({"restored_from_serialized_state":true,"complete_without_another_infer":matches!(actual,PlanAdvance::Complete(_)),"streamed_reply":parent_preview,"reply_deltas":parent_deltas,"empty_authorized_tool_scope":true});}
                }
                if deltas<1 || first.is_none() {errors.push("No incremental final body".into());}
                finished=true;break;
            }
            if !needs_read || reads>=expected_reads || normalized.execution_response.tool_calls.len()!=1 {errors.push("Unexpected extra work; no repair call is allowed".into());break;}
            let call=&normalized.execution_response.tool_calls[0];
            if call.func_name!="read" {errors.push("Unadvertised native action".into());break;}
            // Independent original business validator and exact workspace
            // allowlist. Metadata cannot expand the file authority.
            let arguments:ReadArguments=match serde_json::from_str(&call.arguments) {Ok(value)=>value,Err(error)=>{errors.push(format!("original argument validation: {error}"));break;}};
            let expected_path=if reads==0 {"review.txt"} else {"progress.txt"};
            if arguments.path!=expected_path {errors.push("Read outside isolated allowlist/order".into());break;}
            if enabled && !normalized.records.iter().any(|record|record.kind==AnnotationKind::Intent && record.call_id.as_deref()==Some(call.id.as_str())) {errors.push("Live step intent missing (not a receiver failure, but an annotation behavior test failure)".into());}
            if enabled && reads==0 && !normalized.records.iter().any(|record|record.kind==AnnotationKind::Title) {errors.push("Live initial task title missing (not a receiver failure, but an annotation behavior test failure)".into());}
            let observed=std::fs::read_to_string(fixtures.path().join(&arguments.path))?;
            reads+=1;
            caller.annotation_observation_refs.push(format!("isolated-read-{reads}"));
            let mut assistant=message("assistant",raw.content.clone());
            assistant.tool_calls=Some(raw.tool_calls.iter().map(|call|ToolCall {id:call.id.clone(),r#type:call.r#type.clone(),function:FunctionCall {name:call.func_name.clone(),arguments:call.arguments.clone()}}).collect());
            if let Some(continuation)=continuation {history.push(morphz::llm::provider_continuation_message(continuation)?);}
            history.push(assistant);
            let mut result=message("tool",json!({"status":"success","observation_ref":caller.annotation_observation_refs.last(),"content":observed}).to_string());
            result.tool_call_id=Some(call.id.clone());history.push(result);
        }
        if !finished {errors.push("No complete business answer within necessary request count".into());}
        let report=json!({"case":case,"pass":errors.is_empty(),"errors":errors,"requests":rounds.len(),"actual_isolated_reads":reads,"elapsed_ms":case_started.elapsed().as_millis(),"rounds":rounds});
        println!("{}",json!({"case":case,"pass":report["pass"],"requests":report["requests"],"reads":reads,"elapsed_ms":report["elapsed_ms"],"errors":report["errors"]}));
        reports.push(report);
    }
    if reports.is_empty() {
        return Err("No selected probe cases".into());
    }
    let pass = reports.iter().all(|report| report["pass"] == true);
    let mut file = OpenOptions::new();
    file.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        file.mode(0o600);
    }
    file.open(output)?.write_all(serde_json::to_string_pretty(&json!({"pass":pass,"scope":"isolated provider and native Session IO adapter; not production Runtime/Desktop","tool_digest":stable_tool_hash,"cases":reports}))?.as_bytes())?;
    if !pass {
        return Err("One or more isolated gates failed; do not deploy".into());
    }
    Ok(())
}
