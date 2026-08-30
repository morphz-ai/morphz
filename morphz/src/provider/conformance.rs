//! Provider protocol conformance tests.
//!
//! These tests deliberately exercise protocol contracts and transport edge
//! cases rather than model quality. Add sanitized official/provider fixtures
//! here whenever a protocol evolves or a compatible endpoint exposes a new
//! wire shape.

use super::*;
use crate::llm::{provider_continuation_message, FunctionCall, ProviderContinuation, ToolCall};
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
            connect_timeout_secs: 5,
            stream_idle_timeout_secs: 5,
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
    let request = build_openai_chat_request(
        "gpt-test",
        Some(4096),
        None,
        &prompt(),
        &[],
        PromptCacheWireMode::ImplicitText,
    );

    assert_eq!(request["max_completion_tokens"], 4096);
    assert!(request.get("max_tokens").is_none());
}

#[test]
fn openai_chat_replays_reasoning_content_on_the_assistant_tool_call_message() {
    let continuation = ProviderContinuation::OpenaiChat {
        reasoning_content: "opaque deepseek reasoning".to_string(),
    };
    let messages = vec![
        provider_continuation_message(continuation).unwrap(),
        Message {
            role: "assistant".to_string(),
            content: String::new(),
            name: None,
            tool_call_id: None,
            tool_calls: Some(vec![ToolCall {
                id: "call-1".to_string(),
                r#type: "function".to_string(),
                function: FunctionCall {
                    name: "lookup".to_string(),
                    arguments: "{}".to_string(),
                },
            }]),
        },
        Message {
            role: "tool".to_string(),
            content: "result".to_string(),
            name: None,
            tool_call_id: Some("call-1".to_string()),
            tool_calls: None,
        },
    ];

    let request = build_openai_chat_request(
        "deepseek",
        None,
        None,
        &messages,
        &[],
        PromptCacheWireMode::ImplicitText,
    );

    assert_eq!(request["messages"].as_array().unwrap().len(), 2);
    assert_eq!(
        request["messages"][0]["reasoning_content"],
        "opaque deepseek reasoning"
    );
    assert_eq!(request["messages"][0]["tool_calls"][0]["id"], "call-1");
}

#[test]
fn openai_responses_replays_the_exact_reasoning_item_before_tool_protocol_items() {
    let reasoning_item = json!({
        "id": "rs_1",
        "type": "reasoning",
        "encrypted_content": "opaque-ciphertext",
        "summary": [{"type": "summary_text", "text": "safe summary"}]
    });
    let messages = vec![
        provider_continuation_message(ProviderContinuation::OpenaiResponses {
            reasoning_items: vec![reasoning_item.clone()],
        })
        .unwrap(),
        Message {
            role: "assistant".to_string(),
            content: String::new(),
            name: None,
            tool_call_id: None,
            tool_calls: Some(vec![ToolCall {
                id: "call-1".to_string(),
                r#type: "function".to_string(),
                function: FunctionCall {
                    name: "lookup".to_string(),
                    arguments: "{}".to_string(),
                },
            }]),
        },
        Message {
            role: "tool".to_string(),
            content: "result".to_string(),
            name: None,
            tool_call_id: Some("call-1".to_string()),
            tool_calls: None,
        },
    ];

    let request = build_openai_responses_request(
        "gateway-model",
        None,
        None,
        &messages,
        &[],
        PromptCacheWireMode::ImplicitText,
    );
    let input = request["input"].as_array().unwrap();

    assert_eq!(input[0], reasoning_item);
    assert_eq!(input[1]["type"], "function_call");
    assert_eq!(input[2]["type"], "function_call_output");
}

#[test]
fn provider_continuation_state_is_not_promoted_to_public_text_or_summary() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let mut chat = StreamAccumulator::default();
    for event in [
        json!({"choices":[{"delta":{"reasoning_content":"private "}}]}),
        json!({"choices":[{"delta":{"reasoning_content":"state","tool_calls":[{"index":0,"id":"call-1","function":{"name":"lookup","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}),
    ] {
        chat.apply(ModelProtocol::OpenaiChat, event, &tx).unwrap();
    }
    let response = chat.finish(&tx).unwrap();
    assert!(response.content.is_empty());
    assert_eq!(response.tool_calls.len(), 1);

    let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
    assert!(events.iter().any(|event| matches!(
        event,
        ModelStreamEvent::ProviderContinuation {
            continuation: ProviderContinuation::OpenaiChat { reasoning_content }
        } if reasoning_content == "private state"
    )));
    assert!(!events.iter().any(|event| matches!(
        event,
        ModelStreamEvent::TextDelta { .. } | ModelStreamEvent::ReasoningSummaryDelta { .. }
    )));
}

#[test]
fn responses_done_reasoning_item_becomes_opaque_continuation_state() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let mut accumulator = StreamAccumulator::default();
    let reasoning_item = json!({
        "id": "rs_2",
        "type": "reasoning",
        "encrypted_content": "gateway-state",
        "summary": []
    });
    for event in [
        json!({"type":"response.output_item.done","output_index":0,"item":reasoning_item.clone()}),
        json!({"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","call_id":"call-2","name":"lookup","arguments":"{}"}}),
        json!({"type":"response.completed","response":{}}),
    ] {
        accumulator
            .apply(ModelProtocol::OpenaiResponses, event, &tx)
            .unwrap();
    }
    let response = accumulator.finish(&tx).unwrap();
    assert_eq!(response.tool_calls.len(), 1);
    assert!(
        std::iter::from_fn(|| rx.try_recv().ok()).any(|event| matches!(
            event,
            ModelStreamEvent::ProviderContinuation {
                continuation: ProviderContinuation::OpenaiResponses { reasoning_items }
            } if reasoning_items == vec![reasoning_item.clone()]
        ))
    );
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
fn openai_chat_waits_for_complete_tool_identity_before_streaming_it() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let mut accumulator = StreamAccumulator::default();

    // Some compatible endpoints split `id`, `name`, and even arguments over
    // independent chunks. The normalized stream must never expose an empty
    // tool name, nor arguments before ToolCallStarted.
    accumulator
        .apply(
            ModelProtocol::OpenaiChat,
            json!({
                "choices":[{"delta":{"tool_calls":[{
                    "index":0,
                    "id":"call-split",
                    "function":{"arguments":"{\"path\":"}
                }]}}]
            }),
            &tx,
        )
        .unwrap();
    assert!(
        rx.try_recv().is_err(),
        "incomplete identity must stay buffered"
    );

    accumulator
        .apply(
            ModelProtocol::OpenaiChat,
            json!({
                "choices":[{"delta":{"tool_calls":[{
                    "index":0,
                    "function":{"name":"read","arguments":"\"README.md\"}"}
                }]}}]
            }),
            &tx,
        )
        .unwrap();
    accumulator
        .apply(
            ModelProtocol::OpenaiChat,
            json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}]}),
            &tx,
        )
        .unwrap();

    let response = accumulator.finish(&tx).unwrap();
    assert_eq!(response.tool_calls.len(), 1);
    assert_eq!(response.tool_calls[0].id, "call-split");
    assert_eq!(response.tool_calls[0].func_name, "read");
    assert_eq!(response.tool_calls[0].arguments, "{\"path\":\"README.md\"}");

    let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
    assert_eq!(
        events,
        vec![
            ModelStreamEvent::ToolCallStarted {
                index: 0,
                id: "call-split".to_string(),
                name: "read".to_string(),
            },
            ModelStreamEvent::ToolArgumentsDelta {
                index: 0,
                delta: "{\"path\":".to_string(),
            },
            ModelStreamEvent::ToolArgumentsDelta {
                index: 0,
                delta: "\"README.md\"}".to_string(),
            },
            ModelStreamEvent::ToolCallCompleted { index: 0 },
        ]
    );
}

#[test]
fn openai_responses_output_item_done_backfills_undelivered_arguments() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let mut accumulator = StreamAccumulator::default();
    for event in [
        json!({
            "type":"response.output_item.added",
            "output_index":0,
            "item":{"type":"function_call","call_id":"call-done","name":"lookup"}
        }),
        json!({
            "type":"response.output_item.done",
            "output_index":0,
            "item":{
                "type":"function_call",
                "call_id":"call-done",
                "name":"lookup",
                "arguments":"{\"id\":7}"
            }
        }),
        json!({"type":"response.completed","response":{}}),
    ] {
        accumulator
            .apply(ModelProtocol::OpenaiResponses, event, &tx)
            .unwrap();
    }

    let response = accumulator.finish(&tx).unwrap();
    assert_eq!(response.tool_calls.len(), 1);
    assert_eq!(response.tool_calls[0].id, "call-done");
    assert_eq!(response.tool_calls[0].func_name, "lookup");
    assert_eq!(response.tool_calls[0].arguments, "{\"id\":7}");
    assert!(std::iter::from_fn(|| rx.try_recv().ok()).any(|event| {
        matches!(
            event,
            ModelStreamEvent::ToolArgumentsDelta { index: 0, delta }
                if delta == "{\"id\":7}"
        )
    }));
}

#[test]
fn openai_responses_streams_reasoning_summary_without_promoting_it_to_reply_text() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let mut accumulator = StreamAccumulator::default();
    for event in [
        json!({
            "type":"response.reasoning_summary_text.delta",
            "delta":"Check the current state. "
        }),
        json!({
            "type":"response.reasoning_summary_text.delta",
            "delta":"Then answer concisely."
        }),
        json!({"type":"response.reasoning_summary_text.done"}),
        json!({"type":"response.output_text.delta","delta":"Public answer"}),
        json!({"type":"response.completed","response":{}}),
    ] {
        accumulator
            .apply(ModelProtocol::OpenaiResponses, event, &tx)
            .unwrap();
    }

    let response = accumulator.finish(&tx).unwrap();
    assert_eq!(response.content, "Public answer");
    let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
    assert_eq!(
        events,
        vec![
            ModelStreamEvent::ReasoningSummaryDelta {
                text: "Check the current state. ".to_string(),
            },
            ModelStreamEvent::ReasoningSummaryDelta {
                text: "Then answer concisely.".to_string(),
            },
            ModelStreamEvent::ReasoningSummaryCompleted,
            ModelStreamEvent::TextDelta {
                text: "Public answer".to_string(),
            },
        ]
    );
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
    assert!(error.contains("protocol terminal event"));
}

#[test]
fn responses_incomplete_event_preserves_partial_output_as_a_distinct_terminal() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let mut accumulator = StreamAccumulator::default();
    accumulator
        .apply(
            ModelProtocol::OpenaiResponses,
            json!({
                "type":"response.incomplete",
                "response":{
                    "status":"incomplete",
                    "error":null,
                    "incomplete_details":{"reason":"max_output_tokens"},
                    "output":[{
                        "type":"message",
                        "status":"in_progress",
                        "content":[{"type":"output_text","text":"authentication is user content, not an error code"}]
                    }]
                }
            }),
            &tx,
        )
        .unwrap();

    let error = accumulator.finish(&tx).unwrap_err();
    let failure = error.downcast_ref::<ModelFailure>().unwrap();
    assert_eq!(failure.kind, ModelFailureKind::OutputLimit);
    assert_eq!(failure.provider_code.as_deref(), Some("max_output_tokens"));
    assert!(!failure.message.contains("authentication"));
    assert!(!failure.message.contains("user content"));
    assert!(!failure.kind.uses_provider_recovery());
    assert!(
        std::iter::from_fn(|| rx.try_recv().ok()).any(|event| matches!(
            event,
            ModelStreamEvent::TextDelta { text }
                if text == "authentication is user content, not an error code"
        ))
    );
}

#[test]
fn responses_reasoning_only_output_limit_is_a_resumable_boundary() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let mut accumulator = StreamAccumulator::default();
    accumulator
        .apply(
            ModelProtocol::OpenaiResponses,
            json!({
                "type":"response.reasoning_summary_text.delta",
                "delta":"reasoning progress"
            }),
            &tx,
        )
        .unwrap();
    accumulator
        .apply(
            ModelProtocol::OpenaiResponses,
            json!({"type":"response.reasoning_summary_text.done"}),
            &tx,
        )
        .unwrap();
    accumulator
        .apply(
            ModelProtocol::OpenaiResponses,
            json!({
                "type":"response.incomplete",
                "response":{
                    "error":null,
                    "incomplete_details":{"reason":"max_output_tokens"},
                    "output":[{
                        "type":"reasoning",
                        "id":"reasoning-output-limit",
                        "encrypted_content":"opaque-output-limit-state"
                    }],
                    "usage":{
                        "input_tokens":100,
                        "output_tokens":4096,
                        "total_tokens":4196,
                        "output_tokens_details":{"reasoning_tokens":4096}
                    }
                }
            }),
            &tx,
        )
        .unwrap();

    let error = accumulator.finish(&tx).unwrap_err();
    let failure = error.downcast_ref::<ModelFailure>().unwrap();
    assert_eq!(failure.kind, ModelFailureKind::OutputLimit);
    assert!(!failure.kind.uses_provider_recovery());
    let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
    assert!(events.iter().any(|event| matches!(
        event,
        ModelStreamEvent::ProviderContinuation {
            continuation: ProviderContinuation::OpenaiResponses { reasoning_items }
        } if reasoning_items.iter().any(|item| {
            item["id"] == "reasoning-output-limit"
                && item["encrypted_content"] == "opaque-output-limit-state"
        })
    )));
}

#[test]
fn responses_summary_only_output_limit_does_not_require_a_reasoning_item() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let mut accumulator = StreamAccumulator::default();
    accumulator
        .apply(
            ModelProtocol::OpenaiResponses,
            json!({
                "type":"response.reasoning_summary_text.delta",
                "delta":"GLM still has useful reasoning progress"
            }),
            &tx,
        )
        .unwrap();
    accumulator
        .apply(
            ModelProtocol::OpenaiResponses,
            json!({"type":"response.reasoning_summary_text.done"}),
            &tx,
        )
        .unwrap();
    accumulator
        .apply(
            ModelProtocol::OpenaiResponses,
            json!({
                "type":"response.incomplete",
                "response":{
                    "status":"incomplete",
                    "error":null,
                    "incomplete_details":{"reason":"max_output_tokens"},
                    "output":[],
                    "usage":{
                        "input_tokens":100,
                        "output_tokens":4096,
                        "total_tokens":4196,
                        "output_tokens_details":{"reasoning_tokens":4096}
                    }
                }
            }),
            &tx,
        )
        .unwrap();

    let error = accumulator.finish(&tx).unwrap_err();
    let failure = error.downcast_ref::<ModelFailure>().unwrap();
    assert_eq!(failure.kind, ModelFailureKind::OutputLimit);
    let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
    assert!(events.iter().any(|event| matches!(
        event,
        ModelStreamEvent::ReasoningSummaryDelta { text }
            if text == "GLM still has useful reasoning progress"
    )));
    assert!(!events
        .iter()
        .any(|event| matches!(event, ModelStreamEvent::Failed { .. })));
}

#[test]
fn responses_completed_rejects_an_embedded_failed_state() {
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let mut accumulator = StreamAccumulator::default();
    let error = accumulator
        .apply(
            ModelProtocol::OpenaiResponses,
            json!({
                "type":"response.completed",
                "response":{
                    "status":"failed",
                    "error":{"code":"server_error","message":"upstream failed"}
                }
            }),
            &tx,
        )
        .unwrap_err();

    let failure = error.downcast_ref::<ModelFailure>().unwrap();
    assert_eq!(failure.kind, ModelFailureKind::ServerUnavailable);
    assert_eq!(failure.provider_code.as_deref(), Some("server_error"));
    assert!(failure.message.contains("upstream failed"));
}

#[test]
fn responses_zero_token_empty_completion_is_request_scoped() {
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let mut accumulator = StreamAccumulator::default();
    accumulator
        .apply(
            ModelProtocol::OpenaiResponses,
            json!({
                "type":"response.completed",
                "response":{
                    "status":"completed",
                    "output":[],
                    "usage":{"input_tokens":143476,"output_tokens":0,"total_tokens":143476}
                }
            }),
            &tx,
        )
        .unwrap();

    let error = accumulator.finish(&tx).unwrap_err();
    let failure = error.downcast_ref::<ModelFailure>().unwrap();
    assert_eq!(failure.kind, ModelFailureKind::EmptyResponse);
    assert!(!failure.kind.is_provider_transient());
    assert!(!failure.kind.uses_provider_recovery());
    assert!(failure.message.contains("output_tokens=0"));
}

#[test]
fn responses_completed_backfills_terminal_only_text() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let mut accumulator = StreamAccumulator::default();
    accumulator
        .apply(
            ModelProtocol::OpenaiResponses,
            json!({
                "type":"response.completed",
                "response":{
                    "status":"completed",
                    "output":[{
                        "type":"message",
                        "role":"assistant",
                        "status":"completed",
                        "content":[{"type":"output_text","text":"terminal answer"}]
                    }],
                    "usage":{"input_tokens":143476,"output_tokens":0,"total_tokens":143476}
                }
            }),
            &tx,
        )
        .unwrap();

    assert_eq!(accumulator.finish(&tx).unwrap().content, "terminal answer");
    assert!(std::iter::from_fn(|| rx.try_recv().ok()).any(|event| {
        matches!(event, ModelStreamEvent::TextDelta { text } if text == "terminal answer")
    }));
}

#[test]
fn responses_completed_backfills_terminal_only_function_call() {
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let mut accumulator = StreamAccumulator::default();
    accumulator
        .apply(
            ModelProtocol::OpenaiResponses,
            json!({
                "type":"response.completed",
                "response":{
                    "status":"completed",
                    "output":[{
                        "type":"function_call",
                        "call_id":"call-terminal",
                        "name":"lookup",
                        "arguments":"{\"id\":7}"
                    }],
                    "usage":{"input_tokens":143476,"output_tokens":0,"total_tokens":143476}
                }
            }),
            &tx,
        )
        .unwrap();

    let response = accumulator.finish(&tx).unwrap();
    assert_eq!(response.tool_calls.len(), 1);
    assert_eq!(response.tool_calls[0].id, "call-terminal");
    assert_eq!(response.tool_calls[0].func_name, "lookup");
    assert_eq!(response.tool_calls[0].arguments, "{\"id\":7}");
}

#[test]
fn responses_completed_does_not_duplicate_streamed_text() {
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let mut accumulator = StreamAccumulator::default();
    for event in [
        json!({"type":"response.output_text.delta","delta":"streamed answer"}),
        json!({
            "type":"response.completed",
            "response":{
                "status":"completed",
                "output":[{
                    "type":"message",
                    "role":"assistant",
                    "status":"completed",
                    "content":[{"type":"output_text","text":"streamed answer"}]
                }]
            }
        }),
    ] {
        accumulator
            .apply(ModelProtocol::OpenaiResponses, event, &tx)
            .unwrap();
    }

    assert_eq!(accumulator.finish(&tx).unwrap().content, "streamed answer");
}

#[test]
fn responses_nonstream_failed_status_preserves_the_provider_error() {
    let error = parse_openai_responses_response(json!({
        "status":"failed",
        "error":{"code":"upstream_failure","message":"gateway failed"},
        "output":[]
    }))
    .unwrap_err();

    let failure = error.downcast_ref::<ModelFailure>().unwrap();
    assert_eq!(failure.kind, ModelFailureKind::ServerUnavailable);
    assert_eq!(failure.provider_code.as_deref(), Some("upstream_failure"));
    assert!(failure.message.contains("gateway failed"));
}

#[test]
fn responses_nonstream_incomplete_status_is_not_a_provider_failure() {
    let error = parse_openai_responses_response(json!({
        "status":"incomplete",
        "error":null,
        "incomplete_details":{"reason":"max_output_tokens"},
        "output":[]
    }))
    .unwrap_err();

    let failure = error.downcast_ref::<ModelFailure>().unwrap();
    assert_eq!(failure.kind, ModelFailureKind::OutputLimit);
    assert_eq!(failure.provider_code.as_deref(), Some("max_output_tokens"));
    assert!(!failure.kind.uses_provider_recovery());
}

#[test]
fn responses_nonstream_content_filter_incomplete_is_a_safety_boundary() {
    let error = parse_openai_responses_response(json!({
        "status":"incomplete",
        "error":null,
        "incomplete_details":{"reason":"content_filter"},
        "output":[]
    }))
    .unwrap_err();

    let failure = error.downcast_ref::<ModelFailure>().unwrap();
    assert_eq!(failure.kind, ModelFailureKind::SafetyRefusal);
    assert_eq!(failure.provider_code.as_deref(), Some("content_filter"));
    assert!(!failure.kind.uses_provider_recovery());
}

#[test]
fn responses_nonstream_unknown_incomplete_reason_stays_distinct_from_failed() {
    let error = parse_openai_responses_response(json!({
        "status":"incomplete",
        "error":null,
        "incomplete_details":{"reason":"provider_specific_boundary"},
        "output":[]
    }))
    .unwrap_err();

    let failure = error.downcast_ref::<ModelFailure>().unwrap();
    assert_eq!(failure.kind, ModelFailureKind::IncompleteResponse);
    assert_eq!(
        failure.provider_code.as_deref(),
        Some("provider_specific_boundary")
    );
    assert!(!failure.kind.uses_provider_recovery());
}

#[test]
fn responses_nonstream_zero_token_empty_completion_is_request_scoped() {
    let error = parse_openai_responses_response(json!({
        "status":"completed",
        "output":[],
        "usage":{"input_tokens":143476,"output_tokens":0,"total_tokens":143476}
    }))
    .unwrap_err();

    let failure = error.downcast_ref::<ModelFailure>().unwrap();
    assert_eq!(failure.kind, ModelFailureKind::EmptyResponse);
    assert!(!failure.kind.is_provider_transient());
    assert!(!failure.kind.uses_provider_recovery());
    assert!(failure.message.contains("output_tokens=0"));
}

#[test]
fn anthropic_refusal_terminal_is_typed_and_request_scoped() {
    let error = parse_anthropic_response(json!({
        "id":"msg-refused",
        "type":"message",
        "role":"assistant",
        "content":[],
        "stop_reason":"refusal"
    }))
    .unwrap_err();

    let failure = error.downcast_ref::<ModelFailure>().unwrap();
    assert_eq!(failure.kind, ModelFailureKind::SafetyRefusal);
    assert_eq!(failure.provider_code.as_deref(), Some("refusal"));
    assert!(!failure.kind.uses_provider_recovery());
}

#[test]
fn anthropic_stream_refusal_terminal_is_typed_and_request_scoped() {
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let mut accumulator = StreamAccumulator::default();
    let error = accumulator
        .apply(
            ModelProtocol::AnthropicMessages,
            json!({
                "type":"message_delta",
                "delta":{"stop_reason":"refusal"},
                "usage":{"output_tokens":0}
            }),
            &tx,
        )
        .unwrap_err();

    let failure = error.downcast_ref::<ModelFailure>().unwrap();
    assert_eq!(failure.kind, ModelFailureKind::SafetyRefusal);
    assert_eq!(failure.provider_code.as_deref(), Some("refusal"));
    assert!(!failure.kind.uses_provider_recovery());
}

#[tokio::test]
async fn responses_done_without_native_terminal_is_a_provider_failure() {
    let requests = Arc::new(AtomicUsize::new(0));
    let observed = requests.clone();
    let app = Router::new().route(
        "/responses",
        post(move || {
            let observed = observed.clone();
            async move {
                observed.fetch_add(1, Ordering::SeqCst);
                AxumResponse::builder()
                    .header("content-type", "text/event-stream")
                    .body(Body::from("data: [DONE]\n\n"))
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
        5,
    );
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();

    let error = client
        .create_completion_measured_stream(prompt(), vec![], None, tx)
        .await
        .unwrap_err();
    let failure = error.downcast_ref::<ModelFailure>().unwrap();
    assert_eq!(failure.kind, ModelFailureKind::ServerUnavailable);
    assert!(failure.message.contains("[DONE]"));
    assert_eq!(requests.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn named_sse_error_without_a_json_type_is_preserved() {
    let app = Router::new().route(
        "/responses",
        post(|| async {
            AxumResponse::builder()
                .header("content-type", "text/event-stream")
                .body(Body::from(concat!(
                    "event: error\n",
                    "data: {\"error\":{\"code\":\"upstream_failure\",\"message\":\"gateway failed\"}}\n\n"
                )))
                .unwrap()
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
        1,
    );
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();

    let error = client
        .create_completion_measured_stream(prompt(), vec![], None, tx)
        .await
        .unwrap_err();
    let failure = error.downcast_ref::<ModelFailure>().unwrap();
    assert_eq!(failure.kind, ModelFailureKind::ServerUnavailable);
    assert_eq!(failure.provider_code.as_deref(), Some("upstream_failure"));
    assert!(failure.message.contains("gateway failed"));
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
        PromptCacheWireMode::ImplicitText,
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
fn gemini_never_exposes_thought_parts_as_assistant_text() {
    let fixture = json!({
        "candidates": [{
            "finishReason": "STOP",
            "content": {"parts": [
                {
                    "thought": true,
                    "text": "private chain of thought",
                    "thoughtSignature": "opaque-provider-signature"
                },
                {"text": "public answer"}
            ]}
        }]
    });

    let parsed = parse_gemini_response(fixture.clone()).unwrap();
    assert_eq!(parsed.content, "public answer");

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let mut accumulator = StreamAccumulator::default();
    accumulator
        .apply(ModelProtocol::GeminiContent, fixture, &tx)
        .unwrap();
    let streamed = accumulator.finish(&tx).unwrap();
    assert_eq!(streamed.content, "public answer");

    let deltas = std::iter::from_fn(|| rx.try_recv().ok())
        .filter_map(|event| match event {
            ModelStreamEvent::TextDelta { text } => Some(text),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(deltas, vec!["public answer"]);
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
            .authorize(protocol, client.http.post("https://provider.invalid/test"))
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
