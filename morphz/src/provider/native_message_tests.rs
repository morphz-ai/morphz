//! Native message-phase regressions. Public fixtures contain only synthetic
//! work/progress; the opt-in exact capture replay never prints private output.
use super::*;
use crate::session_io::{native, response::ReturnBinding};

fn binding() -> native::Binding {
    native::prepare(&ReturnBinding::new("TEST-native-phase", 1, "turn", true).with_native_output(),
        &["native-json-schema".into()], &[ToolDefinition { name: "read".into(), description: "Synthetic read".into(),
            parameters: json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}) }]).unwrap().binding
}

fn replay(events: Vec<Value>) -> (Response, Vec<native::MessageItem>, String) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let mut accumulator = StreamAccumulator::default();
    for event in events {
        accumulator.apply_openai_responses(event, &tx).unwrap();
    }
    let response = accumulator.finish(&tx).unwrap();
    tx.send(ModelStreamEvent::Completed).unwrap();
    let mut stream = native::Stream::new(binding());
    let mut legacy = String::new();
    let mut visible = String::new();
    let mut completed = 0;
    while let Ok(event) = rx.try_recv() {
        if let ModelStreamEvent::TextDelta { text } = &event {
            legacy.push_str(text);
        }
        for event in stream.push(event) {
            match event {
                ModelStreamEvent::TextDelta { text } => visible.push_str(&text),
                ModelStreamEvent::TextSnapshot { text } => visible = text,
                ModelStreamEvent::Failed { .. } => panic!("native message replay failed"),
                ModelStreamEvent::Completed => completed += 1,
                _ => {}
            }
        }
    }
    assert_eq!(
        legacy, response.content,
        "legacy flattened byte stream stays unchanged"
    );
    assert_eq!(completed, 1);
    (response, stream.messages().unwrap(), visible)
}

#[test]
fn responses_native_phase_changes_at_item_done_without_losing_work() {
    // Exact public progress bytes and phase transition from the isolated
    // DeepSeek failure 1792462012800 request 10; identities are normalized.
    let text = "review.txt 已读取，现在读取 progress.txt。";
    let message = json!({"type":"message","id":"m","phase":"commentary","content":[{"type":"output_text","text":text}]});
    let call = json!({"type":"function_call","id":"f","call_id":"c","name":"read","arguments":"{\"path\":\"progress.txt\",\"_morphz\":{\"intent\":\"读取进度\"}}"});
    let mut events = vec![
        json!({"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"m","phase":"final_answer","content":[]}}),
    ];
    for chunk in [
        "review",
        ".txt",
        " ",
        "已",
        "读取",
        "，",
        "现在",
        "读取",
        " progress",
        ".txt",
        "。",
    ] {
        events.push(json!({"type":"response.output_text.delta","output_index":1,"content_index":0,"delta":chunk}));
    }
    events.push(json!({"type":"response.output_item.done","output_index":1,"item":message}));
    events.push(json!({"type":"response.output_item.done","output_index":2,"item":call}));
    events.push(json!({"type":"response.completed","response":{"status":"completed","output":[{"type":"reasoning","id":"r"},message,call]}}));
    let (raw, messages, visible) = replay(events);
    assert_eq!(messages[0].phase.as_deref(), Some("commentary"));
    assert_eq!(messages[0].id.as_deref(), Some("m"));
    assert_eq!(visible, text);
    let parts = native::decode_messages(&raw, &messages, &binding(), "a").unwrap();
    assert_eq!(
        parts.response.tool_calls[0].arguments,
        r#"{"path":"progress.txt"}"#
    );
    assert_eq!(parts.annotation_messages.len(), 1);
}

#[test]
fn native_message_terminal_backfills_indexed_text_without_inventing_phase_or_id() {
    let body = r#"{"body":"原样正文","annotations":null}"#;
    for with_text_done in [false, true] {
        let mut events = vec![
            json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":body}),
        ];
        if with_text_done {
            events.push(json!({"type":"response.output_text.done","output_index":0,"content_index":0,"text":body}));
        }
        events.push(json!({"type":"response.completed","response":{"status":"completed"}}));
        let (raw, messages, visible) = replay(events);
        assert_eq!(raw.content, body);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].phase, None);
        assert_eq!(messages[0].id, None);
        assert_eq!(visible, body, "the literal JSON example is never unwrapped");
    }
}

#[test]
fn completed_unindexed_text_closes_its_sole_announced_native_message() {
    let body = "查询已完成，未发现符合范围的告警。🧠";
    for delta_metadata in [
        json!({}),
        json!({"output_index":3}),
        json!({"content_index":0}),
    ] {
        let mut delta = json!({"type":"response.output_text.delta","delta":body});
        delta
            .as_object_mut()
            .unwrap()
            .extend(delta_metadata.as_object().unwrap().clone());
        let events = vec![
            json!({"type":"response.output_item.added","output_index":3,"item":{"type":"message","id":"synthetic-message","phase":"final_answer","content":[]}}),
            delta,
            json!({"type":"response.completed","response":{"status":"completed"}}),
        ];
        let (raw, messages, visible) = replay(events);
        assert_eq!(raw.content, body);
        assert_eq!(visible, body);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].index, 3);
        assert_eq!(messages[0].id.as_deref(), Some("synthetic-message"));
        assert_eq!(messages[0].phase.as_deref(), Some("final_answer"));
        assert_eq!(messages[0].text, body);
        let parts = native::decode_messages(&raw, &messages, &binding(), "test-unindexed").unwrap();
        assert_eq!(parts.response.content, body);
        assert!(parts.response.tool_calls.is_empty());
    }
}

#[test]
fn unindexed_message_completion_keeps_terminal_and_identity_fences() {
    for (second_message, conflicting_hint, complete) in [
        (true, false, true),
        (false, true, true),
        (false, false, false),
    ] {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let mut accumulator = StreamAccumulator::default();
        accumulator.apply_openai_responses(json!({"type":"response.output_item.added","output_index":3,"item":{"type":"message","id":"synthetic-message","phase":"final_answer","content":[]}}),&tx).unwrap();
        if second_message {
            accumulator.apply_openai_responses(json!({"type":"response.output_item.added","output_index":4,"item":{"type":"message","id":"another-message","content":[]}}),&tx).unwrap();
        }
        let mut delta = json!({"type":"response.output_text.delta","delta":"查询已完成"});
        if conflicting_hint {
            delta["output_index"] = json!(4);
        }
        accumulator.apply_openai_responses(delta, &tx).unwrap();
        if complete {
            accumulator
                .apply_openai_responses(
                    json!({"type":"response.completed","response":{"status":"completed"}}),
                    &tx,
                )
                .unwrap();
        }
        let error = accumulator.finish(&tx).unwrap_err().to_string();
        assert!(
            error.contains(if complete {
                "ambiguous or conflicting"
            } else {
                "disconnected before"
            }),
            "{error}"
        );
    }
}

#[test]
fn old_return_binding_does_not_publish_native_message_metadata() {
    let mut old = crate::session_io::response_stream::ModelStreamNormalizer::new(
        ReturnBinding::new("old", 1, "old", true).with_unified_output(),
    );
    assert!(old
        .push(ModelStreamEvent::ProviderMessageItem {
            index: 0,
            id: Some("m".into()),
            phase: Some("final_answer".into()),
            text: Some("internal carrier".into())
        })
        .is_empty());
    assert!(old
        .push(ModelStreamEvent::ProviderMessageDelta {
            index: 0,
            content_index: 0,
            text: "internal carrier".into()
        })
        .is_empty());
}

#[test]
#[ignore = "requires an explicit private isolated SSE capture path"]
fn native_candidate_replays_supplied_sse_capture() {
    let path = std::env::var("MORPHZ_NATIVE_SSE_REPLAY").expect("explicit capture required");
    let bytes = std::fs::read(path).unwrap();
    let mut rest = bytes.as_slice();
    let mut events = vec![];
    while let Some((frame, consumed)) = take_sse_frame(rest) {
        rest = &rest[consumed..];
        if let Some(data) = parse_sse_frame(&frame).unwrap().data {
            if data != "[DONE]" {
                events.push(serde_json::from_str(&data).unwrap());
            }
        }
    }
    assert!(rest.iter().all(u8::is_ascii_whitespace));
    let (raw, messages, visible) = replay(events);
    assert!(messages
        .iter()
        .any(|item| item.phase.as_deref() == Some("commentary")));
    assert_eq!(raw.tool_calls.len(), 1);
    assert_eq!(visible, raw.content);
    let parts = native::decode_messages(&raw, &messages, &binding(), "a").unwrap();
    assert_eq!(
        parts.response.tool_calls[0].arguments,
        r#"{"path":"progress.txt"}"#
    );
}
