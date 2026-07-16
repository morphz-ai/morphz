//! Provider protocol conformance tests.
//!
//! These tests deliberately exercise protocol contracts and transport edge
//! cases rather than model quality. Add sanitized official/provider fixtures
//! here whenever a protocol evolves or a compatible endpoint exposes a new
//! wire shape.

use super::*;
use crate::llm::{FunctionCall, ToolCall};
use axum::{
    body::Body, http::StatusCode, response::Response as AxumResponse, routing::post, Router,
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

fn prompt() -> Vec<Message> {
    vec![Message {
        role: "user".to_string(),
        content: "hello".to_string(),
        name: None,
        tool_call_id: None,
        tool_calls: None,
    }]
}

fn client(protocol: ModelProtocol, base_url: String, max_retries: u32) -> ProtocolClient {
    ProtocolClient::new(
        &ProviderConfig {
            protocol,
            base_url,
            ..ProviderConfig::default()
        },
        "test-model".to_string(),
        None,
        &LlmConfig {
            request_timeout_secs: 5,
            max_retries,
            initial_backoff_secs: 0,
            ..LlmConfig::default()
        },
    )
    .unwrap()
}

fn decode_sse_chunks(payload: &[u8], split_at: usize) -> Vec<String> {
    let mut pending = Vec::new();
    let mut decoded = Vec::new();
    for chunk in [&payload[..split_at], &payload[split_at..]] {
        pending.extend_from_slice(chunk);
        while let Some((frame, consumed)) = take_sse_frame(&pending) {
            pending.drain(..consumed);
            if let Some(data) = sse_data(&frame).unwrap() {
                decoded.push(data);
            }
        }
    }
    if !pending.is_empty() {
        if let Some(data) = sse_data(&pending).unwrap() {
            decoded.push(data);
        }
    }
    decoded
}

#[test]
fn openai_chat_uses_the_current_completion_budget_field() {
    let request = build_openai_chat_request("gpt-test", Some(4096), None, &prompt(), &[]);

    assert_eq!(request["max_completion_tokens"], 4096);
    assert!(request.get("max_tokens").is_none());
}

#[test]
fn sse_decoder_is_invariant_to_every_transport_split() {
    let payload = concat!(
        ": keep-alive\r\n",
        "event: response.output_text.delta\r\n",
        "data: {\"type\":\"response.output_text.delta\",\r\n",
        "data: \"delta\":\"你好\"}\r\n\r\n",
        "data: [DONE]\n\n"
    )
    .as_bytes();
    let expected = vec![
        "{\"type\":\"response.output_text.delta\",\n\"delta\":\"你好\"}".to_string(),
        "[DONE]".to_string(),
    ];

    for split_at in 0..=payload.len() {
        assert_eq!(
            decode_sse_chunks(payload, split_at),
            expected,
            "split_at={split_at}"
        );
    }
}

#[test]
fn openai_responses_keeps_interleaved_parallel_tool_calls_separate() {
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let mut accumulator = StreamAccumulator::default();
    for event in [
        json!({"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call-a","name":"lookup"}}),
        json!({"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"call-b","name":"lookup"}}),
        json!({"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\"id\":2}"}),
        json!({"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\"id\":1}"}),
        json!({"type":"response.function_call_arguments.done","output_index":0}),
        json!({"type":"response.function_call_arguments.done","output_index":1}),
        json!({"type":"response.completed","response":{}}),
    ] {
        accumulator
            .apply(ModelProtocol::OpenaiResponses, event, &tx)
            .unwrap();
    }

    let response = accumulator.finish(&tx).unwrap();
    assert_eq!(response.tool_calls.len(), 2);
    assert_eq!(response.tool_calls[0].id, "call-a");
    assert_eq!(response.tool_calls[0].arguments, "{\"id\":1}");
    assert_eq!(response.tool_calls[1].id, "call-b");
    assert_eq!(response.tool_calls[1].arguments, "{\"id\":2}");
}

#[test]
fn anthropic_ignores_future_events_without_losing_known_content() {
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let mut accumulator = StreamAccumulator::default();
    for event in [
        json!({"type":"ping"}),
        json!({"type":"future_protocol_event","payload":{"value":1}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"message_stop"}),
    ] {
        accumulator
            .apply(ModelProtocol::AnthropicMessages, event, &tx)
            .unwrap();
    }

    assert_eq!(accumulator.finish(&tx).unwrap().content, "hello");
}

#[test]
fn truncated_stream_is_never_promoted_to_a_successful_response() {
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let mut accumulator = StreamAccumulator::default();
    accumulator
        .apply(
            ModelProtocol::OpenaiResponses,
            json!({"type":"response.output_text.delta","delta":"partial"}),
            &tx,
        )
        .unwrap();

    let error = accumulator.finish(&tx).unwrap_err().to_string();
    assert!(error.contains("终止事件"));
}

#[test]
fn responses_incomplete_event_is_an_explicit_failure() {
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let mut accumulator = StreamAccumulator::default();
    let error = accumulator
        .apply(
            ModelProtocol::OpenaiResponses,
            json!({
                "type":"response.incomplete",
                "response":{"incomplete_details":{"reason":"max_output_tokens"}}
            }),
            &tx,
        )
        .unwrap_err()
        .to_string();

    assert!(error.contains("response.incomplete"));
}

#[test]
fn gemini_parallel_calls_preserve_native_ids_in_both_directions() {
    let parsed = parse_gemini_response(json!({
        "candidates": [{
            "finishReason": "STOP",
            "content": {"parts": [
                {"functionCall":{"id":"call-a","name":"lookup","args":{"id":1}}},
                {"functionCall":{"id":"call-b","name":"lookup","args":{"id":2}}}
            ]}
        }]
    }))
    .unwrap();
    assert_eq!(parsed.tool_calls[0].id, "call-a");
    assert_eq!(parsed.tool_calls[1].id, "call-b");

    let assistant = Message {
        role: "assistant".to_string(),
        content: String::new(),
        name: None,
        tool_call_id: None,
        tool_calls: Some(
            parsed
                .tool_calls
                .iter()
                .map(|call| ToolCall {
                    id: call.id.clone(),
                    r#type: "function".to_string(),
                    function: FunctionCall {
                        name: call.func_name.clone(),
                        arguments: call.arguments.clone(),
                    },
                })
                .collect(),
        ),
    };
    let tool_result = |id: &str, value: i32| Message {
        role: "tool".to_string(),
        content: json!({"value":value}).to_string(),
        name: Some("lookup".to_string()),
        tool_call_id: Some(id.to_string()),
        tool_calls: None,
    };
    let request = build_gemini_request(
        None,
        None,
        &[
            assistant,
            tool_result("call-b", 2),
            tool_result("call-a", 1),
        ],
        &[],
    );

    assert_eq!(
        request["contents"][0]["parts"][0]["functionCall"]["id"],
        "call-a"
    );
    assert_eq!(
        request["contents"][0]["parts"][1]["functionCall"]["id"],
        "call-b"
    );
    assert_eq!(
        request["contents"][1]["parts"][0]["functionResponse"]["id"],
        "call-b"
    );
    assert_eq!(
        request["contents"][1]["parts"][1]["functionResponse"]["id"],
        "call-a"
    );
}

#[test]
fn gemini_reports_every_non_success_finish_reason() {
    for reason in ["SAFETY", "RECITATION", "UNEXPECTED_TOOL_CALL"] {
        let error = parse_gemini_response(json!({
            "candidates": [{"finishReason":reason,"content":{"parts":[]}}]
        }))
        .unwrap_err()
        .to_string();
        assert!(error.contains(reason), "reason={reason}, error={error}");
    }
}

#[test]
fn native_protocol_authentication_headers_are_exact() {
    let cases = [
        (
            ModelProtocol::OpenaiResponses,
            "authorization",
            "Bearer secret",
        ),
        (ModelProtocol::OpenaiChat, "authorization", "Bearer secret"),
        (ModelProtocol::AnthropicMessages, "x-api-key", "secret"),
        (ModelProtocol::GeminiContent, "x-goog-api-key", "secret"),
    ];
    for (protocol, header, expected) in cases {
        let client = ProtocolClient::new(
            &ProviderConfig {
                protocol,
                base_url: "https://provider.invalid/v1".to_string(),
                ..ProviderConfig::default()
            },
            "test-model".to_string(),
            Some("secret".to_string()),
            &LlmConfig::default(),
        )
        .unwrap();
        let request = client
            .authorize(client.http.post("https://provider.invalid/test"))
            .build()
            .unwrap();
        assert_eq!(request.headers()[header].to_str().unwrap(), expected);
        if protocol == ModelProtocol::AnthropicMessages {
            assert_eq!(request.headers()["anthropic-version"], "2023-06-01");
        }
    }
}

#[tokio::test]
async fn stream_retries_retryable_http_status_before_consuming_events() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let observed = attempts.clone();
    let app = Router::new().route(
        "/responses",
        post(move || {
            let observed = observed.clone();
            async move {
                if observed.fetch_add(1, Ordering::SeqCst) == 0 {
                    return AxumResponse::builder()
                        .status(StatusCode::TOO_MANY_REQUESTS)
                        .body(Body::from("rate limited"))
                        .unwrap();
                }
                AxumResponse::builder()
                    .header("content-type", "text/event-stream")
                    .body(Body::from(concat!(
                        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n",
                        "data: {\"type\":\"response.completed\",\"response\":{}}\n\n"
                    )))
                    .unwrap()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let client = client(
        ModelProtocol::OpenaiResponses,
        format!("http://{address}"),
        2,
    );
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();

    let response = client
        .create_completion_measured_stream(prompt(), vec![], None, tx)
        .await
        .unwrap();

    assert_eq!(response.content, "ok");
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
}
