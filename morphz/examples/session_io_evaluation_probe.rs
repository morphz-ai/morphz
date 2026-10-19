//! Explicit, bounded live-provider probe. No user's Runtime database, Session,
//! tasks or files are touched. Passing this is a Provider-boundary gate, not
//! proof of complete Runtime/Desktop delivery.
use morphz::{
    config::AppConfig,
    llm::{
        Message, ModelOutputEncoding, ModelRequestContext, ModelRequestOptions, ModelStreamEvent,
        ReasoningEffort, ToolDefinition,
    },
    provider::build_configured_client,
    session_io::{evaluation, response::ReturnBinding, Data},
};
use serde_json::json;
use std::{error::Error, time::Instant};
type DynError = Box<dyn Error + Send + Sync>;

#[tokio::main]
async fn main() -> Result<(), DynError> {
    let mut args = std::env::args().skip(1);
    let path = args
        .next()
        .ok_or("explicit model configuration file required")?;
    let model = args
        .next()
        .ok_or("explicit configured model alias required")?;
    let config: AppConfig = toml::from_str(&std::fs::read_to_string(path)?)?;
    let (client, _) = build_configured_client(&config, None, Some(&model))?;
    let fixtures = tempfile::TempDir::new()?;
    std::fs::write(
        fixtures.path().join("synthetic-review.txt"),
        "合成审阅材料：所有伏笔均已解决，主角完成目标，末段明确写着全书完。",
    )?;
    std::fs::write(
        fixtures.path().join("synthetic-memory.txt"),
        "合成进度记录：已读至卷十四，贾谊陈述治安策。",
    )?;
    let tools=vec![ToolDefinition {
        name:"read".into(), description:"Read one supplied synthetic review document; this is an actual read-only probe capability".into(),
        parameters:json!({"type":"object","required":["path"],"additionalProperties":false,"properties":{"path":{"type":"string"}}}),
    }];
    let tools_hash = serde_json::to_string(&tools)?;
    for (case,input) in [
        ("plain","请用两行中文说明 2 加 3 等于多少，包含引号和 🧠。不需要外部资料。"),
        ("work","独立盲审：先使用 read 读取已授权的 synthetic-review.txt，然后判断故事是否完结。不要凭已有印象判断。"),
        ("memory","先使用 read 核对 synthetic-memory.txt 中记录的阅读进度，再回答读到哪里。不要虚构记忆。"),
    ] {
        let mut binding=ReturnBinding::new("isolated-provider-probe",1,case,true);
        let input=json!({"instruction":input});
        let mut messages=vec![
            Message{role:"system".into(),content:morphz::session_io::response::CONTRACT.into(),name:None,tool_call_id:None,tool_calls:None},
            Message{role:"user".into(),content:format!("(evaluation-environment {})\n{}",binding.expression(),Data::from_value(&input).expression()),name:None,tool_call_id:None,tool_calls:None},
        ];
        let mut complete=false;
        for turn in 0..2 {
            let id=format!("provider-probe-{case}-{turn}");
            let context=ModelRequestContext{context_id:"isolated-probe".into(),session_id:"isolated-probe".into(),attempt_id:id.clone(),objective_id:None,required_capabilities:vec![]};
            let physical=client.bind_requested_model_attempt(&context,Some(&model)).await?;
            let (stream,mut events)=tokio::sync::mpsc::unbounded_channel();
            let started=Instant::now();
            let collector=tokio::spawn(async move {
                let mut first=None;let mut deltas=0;let mut text=String::new();
                while let Some(event)=events.recv().await {
                    if let ModelStreamEvent::TextDelta{text:delta}=event {first.get_or_insert(started.elapsed().as_millis());deltas+=1;text.push_str(&delta);}
                }
                (first,deltas,text)
            });
            let response=tokio::time::timeout(std::time::Duration::from_secs(55),client.create_completion_bound_stream_with_options(
                &physical,messages.clone(),tools.clone(),None,stream,
                ModelRequestOptions{reasoning_effort:Some(Some(ReasoningEffort::Max)),output_encoding:Some(ModelOutputEncoding::JsonObject)},
            )).await??;
            let (first,deltas,streamed)=collector.await?;
            assert_eq!(streamed,response.content,"Provider stream and final value must agree");
            let decoded=evaluation::decode(&response,&binding,&id)?;
            assert_eq!(serde_json::to_string(&tools)?,tools_hash);
            println!("{}",json!({"model":physical.physical_model,"case":case,"turn":turn,"first_delta_ms":first,"deltas":deltas,"elapsed_ms":started.elapsed().as_millis(),"returning":decoded.returning,"proposals":decoded.response.tool_calls.iter().map(|call|call.func_name.as_str()).collect::<Vec<_>>(),"body":decoded.response.content,"annotations":decoded.annotations.wire_data().json(),"format":decoded.message.format.id}));
            if decoded.returning {complete=true;assert!(case=="plain" || turn==1,"Read-dependent answer returned without its actual observation");break;}
            assert_eq!(turn,0,"Probe forbids extra work or metadata repair requests");
            assert_eq!(decoded.response.tool_calls.len(),1);
            let call=&decoded.response.tool_calls[0];assert_eq!(call.func_name,"read");
            let arguments:serde_json::Value=serde_json::from_str(&call.arguments)?;
            let expected=if case=="work" {"synthetic-review.txt"} else {"synthetic-memory.txt"};
            assert_eq!(arguments["path"],expected);
            let observed = std::fs::read_to_string(fixtures.path().join(expected))?;
            binding.annotation_observation_refs=vec!["probe-observation-1".into()];
            messages.push(Message{role:"assistant".into(),content:response.content,name:None,tool_call_id:None,tool_calls:None});
            messages.push(Message{role:"user".into(),content:format!("(evaluation-environment {})\n{}",binding.expression(),Data::from_value(&json!({"observation":{"ref":"probe-observation-1","name":"read","arguments":arguments,"status":"success","result":observed}})).expression()),name:None,tool_call_id:None,tool_calls:None});
        }
        assert!(complete,"No complete answer within the necessary request count");
    }
    Ok(())
}
