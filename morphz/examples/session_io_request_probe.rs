//! Explicit one-request diagnostic replay. Reads a locally captured request and
//! frozen return binding, sends it only to the configured provider, and never
//! evaluates the returned proposals. Output files may contain private Context.
use morphz::{
    config::AppConfig,
    llm::{
        Message, ModelOutputEncoding, ModelRequestContext, ModelRequestOptions, ModelStreamEvent,
        ReasoningEffort, ToolDefinition,
    },
    provider::build_configured_client,
    session_io::{response::ReturnBinding, unified},
};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    error::Error,
    fs::OpenOptions,
    io::Write,
    time::{Duration, Instant},
};

type DynError = Box<dyn Error + Send + Sync>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Replay {
    messages: Vec<Message>,
    tools: Vec<ToolDefinition>,
    return_binding: ReturnBinding,
    max_output_tokens: Option<u32>,
    reasoning_effort: Option<ReasoningEffort>,
}

#[tokio::main]
async fn main() -> Result<(), DynError> {
    let mut args = std::env::args().skip(1);
    let config_path = args.next().ok_or("explicit model configuration required")?;
    let model = args.next().ok_or("explicit configured model required")?;
    let request_path = args.next().ok_or("private captured request required")?;
    let output_path = args.next().ok_or("new private output path required")?;
    let variant = args.next().ok_or("explicit diagnostic variant required")?;
    if ![
        "baseline",
        "native-work",
        "strict",
        "json-object",
        "serialization",
        "native-baseline",
    ]
    .contains(&variant.as_str())
    {
        return Err("unknown replay variant".into());
    }
    let mut config: AppConfig = toml::from_str(&std::fs::read_to_string(config_path)?)?;
    let mut replay: Replay = serde_json::from_slice(&std::fs::read(request_path)?)?;
    // Budget and effort belong to the explicit captured request, not to a
    // smaller synthetic probe that would confound the comparison.
    config.llm.max_output_tokens = replay.max_output_tokens;
    let request_hash = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&json!({
            "messages":replay.messages,"tools":replay.tools,"binding":replay.return_binding,
            "max_output_tokens":replay.max_output_tokens,"reasoning_effort":replay.reasoning_effort,
        }))?)
    );
    let (client, _) = build_configured_client(&config, None, Some(&model))?;
    let context = ModelRequestContext {
        context_id: "TEST-private-captured-request".into(),
        session_id: "TEST-private-captured-request".into(),
        attempt_id: format!("TEST-request-{variant}"),
        objective_id: None,
        required_capabilities: vec![],
    };
    let binding = client
        .bind_requested_model_attempt(&context, Some(&model))
        .await?;
    let (mut output_encoding, mut tool_choice) =
        unified::request_options(&replay.return_binding, &binding.capabilities, &replay.tools);
    if variant == "native-work" {
        tool_choice = None;
    }
    if variant == "strict" {
        if let Some(ModelOutputEncoding::JsonSchema { strict, .. }) = &mut output_encoding {
            *strict = true;
        }
    }
    if variant == "json-object" {
        output_encoding = Some(ModelOutputEncoding::JsonObject);
    }
    if variant == "native-baseline" {
        output_encoding = None;
        tool_choice = None;
        replay.messages.push(Message {
            role: "system".into(),
            content: "This isolated research request compares the original native transport. For this one physical request only, use actual API function calls with the exact original tool definitions for work, rather than generating body/effects/annotations JSON in message text. Plain message text is the ordinary original answer or work progress. Do not generate annotations or call deliver_message. This overrides only the earlier Evaluation serialization instructions; the current task, original arguments, scope and permissions remain unchanged. The test harness will inspect your proposal without executing it.".into(),
            name: None, tool_call_id: None, tool_calls: None,
        });
    }
    if variant == "serialization" {
        replay.messages.push(Message {
            role: "system".into(),
            content: "The frozen morphz.evaluation@2 output encoding is JSON. Serialize exactly one complete JSON value, without Markdown code fences or prose outside it. Markdown and protocol examples are ordinary data inside the body string. This clarifies serialization only; existing tool, authorization, body-type and annotation rules remain unchanged.".into(),
            name: None, tool_call_id: None, tool_calls: None,
        });
    }
    let (stream, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let collector = tokio::spawn(async move {
        let mut count = 0usize;
        let mut text = String::new();
        while let Some(event) = receiver.recv().await {
            count += 1;
            if let ModelStreamEvent::TextDelta { text: delta } = event {
                text.push_str(&delta);
            }
        }
        (count, text)
    });
    let started = Instant::now();
    let response = tokio::time::timeout(
        Duration::from_secs(180),
        client.create_completion_bound_stream_with_options(
            &binding,
            replay.messages,
            replay.tools,
            None,
            stream,
            ModelRequestOptions {
                reasoning_effort: Some(replay.reasoning_effort),
                output_encoding,
                tool_choice,
            },
        ),
    )
    .await
    .map_err(|error| Box::new(error) as DynError)
    .and_then(|result| result);
    let (stream_events, partial_text) = collector.await?;
    let decoded = response
        .as_ref()
        .ok()
        .map(|response| unified::decode(response, &replay.return_binding, &context.attempt_id));
    let report = json!({"variant":variant,"captured_request_sha256":request_hash,"elapsed_ms":started.elapsed().as_millis(),"stream_events":stream_events,
        "raw":response.as_ref().ok(),"partial_text":partial_text,"provider_error":response.as_ref().err().map(ToString::to_string),
        "decoded":decoded.as_ref().and_then(|result| result.as_ref().ok()).map(|parts| json!({"body":parts.response.content,"calls":parts.response.tool_calls,"diagnostics":parts.diagnostics})),
        "decode_error":decoded.as_ref().and_then(|result| result.as_ref().err()).map(ToString::to_string)});
    let mut file = OpenOptions::new();
    file.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        file.mode(0o600);
    }
    file.open(output_path)?
        .write_all(serde_json::to_string_pretty(&report)?.as_bytes())?;
    println!(
        "{}",
        json!({"variant":variant,"elapsed_ms":started.elapsed().as_millis(),"stream_events":stream_events,
        "raw_bytes":response.as_ref().ok().map(|r| r.content.len()),"native_work_calls":response.as_ref().ok().map(|r| r.tool_calls.len()),
        "decoded_work_calls":decoded.as_ref().and_then(|r| r.as_ref().ok()).map(|parts| parts.response.tool_calls.len()),"decode_ok":decoded.as_ref().is_some_and(Result::is_ok),"provider_ok":response.is_ok()})
    );
    Ok(())
}
