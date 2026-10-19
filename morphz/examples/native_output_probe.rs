//! Opt-in live Provider-boundary gate. Requires an explicit config and model;
//! uses synthetic data and a disposable read-only fixture, never a user Session.
//! This is not full Runtime or Desktop acceptance of the Session IO contract.
use morphz::{
    config::AppConfig,
    llm::{
        provider_continuation_message, FunctionCall, Message, ModelOutputEncoding,
        ModelRequestContext, ModelRequestOptions, ModelStreamEvent, ProviderContinuation,
        ReasoningEffort, ToolCall, ToolDefinition,
    },
    provider::build_configured_client,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    error::Error,
    time::{Duration, Instant},
};

type DynError = Box<dyn Error + Send + Sync>;
const SENTINEL: &str = "MORPHZ_NATIVE_SCHEMA_WIRE_20261020";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Answer {
    body: String,
    annotations: Option<Summary>,
    schema_probe: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Summary {
    title: String,
    result: String,
}

fn message(role: &str, content: String) -> Message {
    Message {
        role: role.into(),
        content,
        name: None,
        tool_call_id: None,
        tool_calls: None,
    }
}

#[tokio::main]
async fn main() -> Result<(), DynError> {
    let mut args = std::env::args().skip(1);
    let path = args.next().ok_or("explicit model config required")?;
    let model = args
        .next()
        .ok_or("explicit configured model alias required")?;
    let case_filter = args.next();
    let config: AppConfig = toml::from_str(&std::fs::read_to_string(path)?)?;
    let (client, selected) = build_configured_client(&config, None, Some(&model))?;
    let fixture = tempfile::TempDir::new()?;
    std::fs::write(
        fixture.path().join("book.txt"),
        "合成书籍记录：作者为测试作者。",
    )?;
    let tools = vec![ToolDefinition {
        name: "read_fixture".into(),
        description: "Read the explicitly authorized synthetic book.txt; no other files or actions are available".into(),
        parameters: json!({"type":"object","properties":{"path":{"type":"string","enum":["book.txt"]}},"required":["path"],"additionalProperties":false}),
    }];
    let directory = serde_json::to_string(&tools)?;
    let directory_hash = format!("{:x}", Sha256::digest(directory.as_bytes()));
    let schema = json!({"type":"object","additionalProperties":false,
        "required":["body","annotations","schema_probe"],"properties":{
        "body":{"type":"string"},
        "annotations":{"anyOf":[{"type":"null"},{"type":"object",
            "additionalProperties":false,"required":["title","result"],
            "properties":{"title":{"type":"string"},"result":{"type":"string"}}}]},
        "schema_probe":{"type":"string","enum":[SENTINEL]}
    }});
    let options = ModelRequestOptions {
        reasoning_effort: Some(Some(ReasoningEffort::Max)),
        output_encoding: Some(ModelOutputEncoding::JsonSchema {
            name: "session_io_provider_probe".into(),
            schema,
            strict: true,
        }),
    };
    for (case, work, annotations, input) in [
        (
            "plain",
            false,
            true,
            "用两行中文回答 2+3，包含双引号和 🌱，不用工具。",
        ),
        (
            "work",
            true,
            true,
            "先用 read_fixture 读取 book.txt，确认作者，然后用一句完整中文回答。",
        ),
        (
            "off",
            true,
            false,
            "先用 read_fixture 读取 book.txt，确认作者，然后用一句完整中文回答。",
        ),
    ] {
        if case_filter.as_deref().is_some_and(|filter| filter != case) {
            continue;
        }
        let mut messages = vec![message("system", format!(
            "This isolated probe returns one value according to the native API output schema. The body is the complete answer; annotations are display-only data in that same value, never a separate tool call or prose tag. Use real work tools when needed, then answer without a relay or metadata-repair request. Do not guess file contents. annotations_enabled={annotations}. When enabled and actual work was performed, provide a short truthful title and result summary. For plain chat or disabled annotations, use null. Do not put annotations in function arguments."
        )), message("user", input.into())];
        let mut reads = 0;
        let mut completed = false;
        for turn in 0..=usize::from(work) {
            assert_eq!(directory, serde_json::to_string(&tools)?);
            let context = ModelRequestContext {
                context_id: "TEST-native-output".into(),
                session_id: "TEST-native-output".into(),
                attempt_id: format!("TEST-{case}-{turn}"),
                objective_id: None,
                required_capabilities: vec![],
            };
            let binding = client
                .bind_requested_model_attempt(&context, Some(&model))
                .await?;
            let started = Instant::now();
            let (stream, mut events) = tokio::sync::mpsc::unbounded_channel();
            let collector = tokio::spawn(async move {
                let mut text = String::new();
                let mut chunks = 0;
                let mut first = None;
                let mut continuation: Option<ProviderContinuation> = None;
                while let Some(event) = events.recv().await {
                    match event {
                        ModelStreamEvent::TextDelta { text: delta } => {
                            first.get_or_insert(started.elapsed().as_millis());
                            chunks += 1;
                            text.push_str(&delta);
                        }
                        ModelStreamEvent::ProviderContinuation {
                            continuation: value,
                        } => continuation = Some(value),
                        _ => {}
                    }
                }
                (text, chunks, first, continuation)
            });
            let response = tokio::time::timeout(
                Duration::from_secs(55),
                client.create_completion_bound_stream_with_options(
                    &binding,
                    messages.clone(),
                    tools.clone(),
                    None,
                    stream,
                    options.clone(),
                ),
            )
            .await??;
            let (text, chunks, first, continuation) = collector.await?;
            assert_eq!(
                text, response.content,
                "complete raw stream and returned text must agree"
            );
            println!(
                "{}",
                json!({"case":case,"turn":turn,"protocol":selected.protocol.as_str(),
                "endpoint":binding.endpoint,"physical_model":binding.physical_model,
                "elapsed_ms":started.elapsed().as_millis(),"first_delta_ms":first,"raw_delta_count":chunks,
                "tool_definitions_sha256":directory_hash,
                "work_calls":response.tool_calls.iter().map(|c| &c.func_name).collect::<Vec<_>>() })
            );
            if response.tool_calls.is_empty() {
                let value: Value = serde_json::from_str(&response.content)?;
                assert!(
                    value.get("annotations").is_some(),
                    "the native schema requested a nullable field, not an omitted field"
                );
                let answer: Answer = serde_json::from_str(&response.content)?;
                assert_eq!(
                    answer.schema_probe, SENTINEL,
                    "schema-only sentinel must reach the model"
                );
                assert!(!answer.body.trim().is_empty());
                assert_eq!(
                    reads,
                    usize::from(work),
                    "do not invent a completed tool run"
                );
                if work {
                    assert!(answer.body.contains("测试作者"));
                    if annotations {
                        let summary = answer
                            .annotations
                            .as_ref()
                            .ok_or("expected generated work summary")?;
                        assert!(
                            !summary.title.trim().is_empty() && !summary.result.trim().is_empty()
                        );
                    } else {
                        assert!(answer.annotations.is_none());
                    }
                } else {
                    assert!(answer.annotations.is_none());
                    assert!(answer.body.contains('\n') && answer.body.contains('🌱'));
                }
                println!(
                    "{}",
                    json!({"case":case,"complete":true,"requests":turn+1,"reads":reads,
                    "body":answer.body,"annotations_present":answer.annotations.is_some(),
                    "stable_tools":true,"provider_boundary_only":true})
                );
                completed = true;
                break;
            }
            assert!(
                work && turn == 0,
                "no extra work, metadata or relay requests"
            );
            assert_eq!(response.tool_calls.len(), 1);
            let call = &response.tool_calls[0];
            assert_eq!(call.func_name, "read_fixture");
            let arguments: Value = serde_json::from_str(&call.arguments)?;
            assert_eq!(arguments, json!({"path":"book.txt"}));
            let observed = std::fs::read_to_string(fixture.path().join("book.txt"))?;
            reads += 1;
            if let Some(continuation) = continuation {
                messages.push(provider_continuation_message(continuation)?);
            }
            messages.push(Message {
                role: "assistant".into(),
                content: response.content,
                name: None,
                tool_call_id: None,
                tool_calls: Some(vec![ToolCall {
                    id: call.id.clone(),
                    r#type: "function".into(),
                    function: FunctionCall {
                        name: call.func_name.clone(),
                        arguments: call.arguments.clone(),
                    },
                }]),
            });
            messages.push(Message {
                role: "tool".into(),
                content: observed,
                name: None,
                tool_call_id: Some(call.id.clone()),
                tool_calls: None,
            });
        }
        assert!(
            completed,
            "required final answer did not arrive within the work-only request budget"
        );
    }
    Ok(())
}
