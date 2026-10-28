use super::*;
use crate::llm::{ModelStreamEvent, ToolCallRepr};
use crate::response_annotations::{
    AnnotationKind, ExecutionScope, NormalizationContext, Producer, Protocol, TerminalDecision,
    TrustedObservation,
};

fn tools() -> Vec<ToolDefinition> {
    vec![ToolDefinition {
        name: "read".into(),
        description: "Read authorized synthetic text".into(),
        parameters: json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}),
    }]
}
fn prepared(enabled: bool, worked: bool) -> Prepared {
    let mut caller = ReturnBinding::new("execution", 1, "activation", enabled).with_native_output();
    if worked {
        caller
            .annotation_observation_refs
            .push("actual-earlier-read".into());
    }
    prepare(&caller, &["native-json-schema".into()], &tools()).unwrap()
}
fn raw(content: &str) -> Response {
    Response {
        content: content.into(),
        tool_calls: vec![],
    }
}
fn call(id: &str, arguments: &str) -> ToolCallRepr {
    ToolCallRepr {
        id: id.into(),
        r#type: "function".into(),
        func_name: "read".into(),
        arguments: arguments.into(),
    }
}

fn control_prepared(enabled: bool) -> Prepared {
    let mut directory = tools();
    directory.push(ToolDefinition {
        name: "no_reply".into(),
        description: "Finite waiting or intentional silence".into(),
        parameters: json!({"type":"object","properties":{"mode":{"type":"string","enum":["silent","wait"]},"wait_secs":{"type":"integer","minimum":1}},"required":["mode"],"additionalProperties":false}),
    });
    let caller = ReturnBinding::new("execution", 1, "activation", enabled).with_native_output();
    prepare(&caller, &[], &directory).unwrap()
}

#[test]
fn native_no_reply_runtime_metadata_is_separate_from_strict_control_arguments() {
    let on = control_prepared(true);
    let off = control_prepared(false);
    assert_eq!(
        serde_json::to_value(&on.tools).unwrap(),
        serde_json::to_value(&off.tools).unwrap(),
        "Annotation switch never changes the control directory"
    );
    assert_eq!(on.binding.tools_sha256, off.binding.tools_sha256);
    assert!(on.binding.metadata_tools.contains(&"no_reply".into()));
    assert_eq!(
        on.tools
            .iter()
            .find(|tool| tool.name == "no_reply")
            .unwrap()
            .parameters["additionalProperties"],
        false
    );
    for enabled in [true, false] {
        let binding = control_prepared(enabled).binding;
        for args in [
            json!({"mode":"silent"}),
            json!({"mode":"wait"}),
            json!({"mode":"wait","wait_secs":90}),
        ] {
            for metadata in [
                json!({"execution":{"title":"等待后台评估","progress":"等待后台结果"},"intent":"等待后台工作"}),
                json!({"execution":null,"observations_note":null}),
                Value::Null,
                json!("invalid display metadata"),
            ] {
                let mut wire = args.clone();
                wire[METADATA_KEY] = metadata;
                let response = Response {
                    content: String::new(),
                    tool_calls: vec![ToolCallRepr {
                        func_name: "no_reply".into(),
                        ..call("wait", &wire.to_string())
                    }],
                };
                let normalized = normalize(&response, &binding, &context(&binding)).unwrap();
                assert_eq!(normalized.raw_response.tool_calls, response.tool_calls);
                assert_eq!(
                    serde_json::from_str::<Value>(
                        &normalized.execution_response.tool_calls[0].arguments
                    )
                    .unwrap(),
                    args
                );
                assert!(matches!(
                    normalized.terminal_decision,
                    Some(TerminalDecision::NoReply(_))
                ));
                assert!(
                    normalized
                        .records
                        .iter()
                        .all(|record| record.kind != AnnotationKind::Intent),
                    "A control never becomes an executed work step"
                );
                if !enabled {
                    assert!(normalized.records.is_empty());
                }
                if args["mode"] == "wait" {
                    let explicit = args.get("wait_secs").is_some();
                    assert_eq!(
                        normalized.terminal_decision,
                        Some(TerminalDecision::NoReply(
                            crate::response_annotations::NoReplyMode::Wait {
                                wait_secs: if explicit { 90 } else { 60 },
                                explicitly_requested: explicit
                            }
                        ))
                    );
                }
            }
        }
    }
}

#[test]
fn no_reply_metadata_never_relaxes_mode_wait_exclusivity_or_a_frozen_unadvertised_contract() {
    for enabled in [true, false] {
        let binding = control_prepared(enabled).binding;
        for mut args in [
            json!({"mode":"wait","wait_secs":0}),
            json!({"mode":"wait","wait_secs":-1}),
            json!({"mode":"wait","wait_secs":1.5}),
            json!({"mode":"silent","wait_secs":90}),
            json!({"mode":"unknown"}),
            json!({"mode":"wait","business_extra":true}),
        ] {
            args[METADATA_KEY] = json!({"execution":{"progress":"等待后台结果"}});
            let response = Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    func_name: "no_reply".into(),
                    ..call("control", &args.to_string())
                }],
            };
            assert!(normalize(&response, &binding, &context(&binding)).is_err());
        }
        let response = Response {
            content: String::new(),
            tool_calls: vec![ToolCallRepr {
                func_name: "no_reply".into(),
                ..call(
                    "control",
                    r#"{"mode":"wait","wait_secs":90,"_morphz":{"execution":{"progress":"等待后台结果"}}}"#,
                )
            }],
        };
        let mut with_body = response.clone();
        with_body.content = "读取任务转入后台执行，等待其完成事件。".into();
        let normalized = normalize(&with_body, &binding, &context(&binding)).unwrap();
        assert_eq!(normalized.execution_response.content, with_body.content);
        assert!(matches!(
            normalized.terminal_decision,
            Some(TerminalDecision::NoReply(
                crate::response_annotations::NoReplyMode::Wait {
                    wait_secs: 90,
                    explicitly_requested: true,
                }
            ))
        ));
        let mut mixed = response.clone();
        mixed.tool_calls.push(call("work", r#"{"path":"file"}"#));
        assert!(normalize(&mixed, &binding, &context(&binding)).is_err());
        let mut frozen = binding.clone();
        frozen.metadata_tools.retain(|name| name != "no_reply");
        assert!(
            normalize(&response, &frozen, &context(&frozen)).is_err(),
            "Never reinterpret an old physical carrier that did not advertise metadata"
        );
    }
}

#[test]
fn malformed_native_tool_arguments_survive_metadata_decoding_for_per_call_rejection() {
    for enabled in [false, true] {
        let binding = prepared(enabled, false).binding;
        for arguments in [
            // Same syntax defect as the real DeepSeek kill_task response:
            // a bare object after the metadata field, without a property name.
            r#"{"_morphz":{"execution":{"progress":"读取进度"}} , {"intent":"读取"},"path":"file"}"#,
            r#"{"path":"first","path":"second"}"#,
            r#"{"path": "#,
            r#"["file"]"#,
            "null",
        ] {
            assert!(parse_tool_arguments(arguments).is_err());
            let response = Response {
                content: "先检查这两个文件。".into(),
                tool_calls: vec![
                    call("bad", arguments),
                    call(
                        "good",
                        r#"{"path":"ok","_morphz":{"intent":"读取已授权文件"}}"#,
                    ),
                ],
            };
            let result = normalize(&response, &binding, &context(&binding)).unwrap();
            assert_eq!(result.raw_response.content, response.content);
            assert_eq!(result.raw_response.tool_calls, response.tool_calls);
            assert_eq!(result.execution_response.content, response.content);
            assert_eq!(
                result.execution_response.tool_calls[0],
                response.tool_calls[0]
            );
            assert_eq!(
                result.execution_response.tool_calls[1].arguments,
                r#"{"path":"ok"}"#
            );
        }
    }
}

#[test]
fn malformed_argument_recovery_never_relaxes_native_call_identity() {
    for enabled in [false, true] {
        let binding = prepared(enabled, false).binding;
        for ids in [["", "good"], ["same", "same"]] {
            let response = Response {
                content: "检查文件".into(),
                tool_calls: vec![
                    call(ids[0], r#"{"path":"broken""#),
                    call(ids[1], r#"{"path":"ok","_morphz":{"intent":"读取文件"}}"#),
                ],
            };
            let raw_calls = response.tool_calls.clone();
            let scoped = [MessageItem {
                index: 0,
                id: Some("provider-message".into()),
                phase: Some("commentary".into()),
                text: response.content.clone(),
            }];
            for messages in [&[][..], &scoped[..]] {
                let error = decode_messages(&response, messages, &binding, "actual-attempt")
                    .expect_err("a malformed call ID must remain a fatal identity error");
                assert_eq!(error.code, "invalid_delivery_contract");
                assert_eq!(
                    error.message,
                    "Native call identities must be nonempty and unique"
                );
                assert_eq!(
                    response.tool_calls, raw_calls,
                    "never repair or mint call IDs"
                );
            }
            assert!(normalize(&response, &binding, &context(&binding)).is_err());
            let mut stream = Stream::new(binding.clone());
            let mut events = Vec::new();
            for (index, call) in response.tool_calls.iter().enumerate() {
                events.extend(stream.push(ModelStreamEvent::ToolCallStarted {
                    index,
                    id: call.id.clone(),
                    name: call.func_name.clone(),
                }));
                events.extend(stream.push(ModelStreamEvent::ToolArgumentsDelta {
                    index,
                    delta: call.arguments.clone(),
                }));
                events.extend(stream.push(ModelStreamEvent::ToolCallCompleted { index }));
            }
            events.extend(stream.push(ModelStreamEvent::Completed));
            assert!(events
                .iter()
                .any(|event| matches!(event, ModelStreamEvent::Failed { .. })));
            assert!(!events
                .iter()
                .any(|event| matches!(event, ModelStreamEvent::Completed)));
        }
    }
}

#[test]
fn malformed_native_no_reply_is_work_to_reject_not_a_terminal_decision() {
    for enabled in [false, true] {
        let binding = prepared(enabled, false).binding;
        for arguments in [
            r#"{"mode":"#,
            r#"{"mode":"wait","mode":"silent"}"#,
            r#"["silent"]"#,
        ] {
            for mixed in [false, true] {
                let mut response = Response {
                    content: String::new(),
                    tool_calls: vec![ToolCallRepr {
                        func_name: "no_reply".into(),
                        ..call("malformed-control", arguments)
                    }],
                };
                if mixed {
                    response.tool_calls.push(call("good", r#"{"path":"ok"}"#));
                }
                let normalized = normalize(&response, &binding, &context(&binding)).unwrap();
                assert_eq!(normalized.raw_response.tool_calls, response.tool_calls);
                assert_eq!(
                    normalized.execution_response.tool_calls,
                    response.tool_calls
                );
                assert_eq!(normalized.terminal_decision, None);
                let mut stream = Stream::new(binding.clone());
                let mut events = vec![];
                for (index, invocation) in response.tool_calls.iter().enumerate() {
                    events.extend(stream.push(ModelStreamEvent::ToolCallStarted {
                        index,
                        id: invocation.id.clone(),
                        name: invocation.func_name.clone(),
                    }));
                    events.extend(stream.push(ModelStreamEvent::ToolArgumentsDelta {
                        index,
                        delta: invocation.arguments.clone(),
                    }));
                    events.extend(stream.push(ModelStreamEvent::ToolCallCompleted { index }));
                }
                events.extend(stream.push(ModelStreamEvent::Completed));
                assert!(!events
                    .iter()
                    .any(|event| matches!(event, ModelStreamEvent::Failed { .. })));
                assert!(events
                    .iter()
                    .any(|event| matches!(event, ModelStreamEvent::Completed)));
            }
        }
    }
}

fn context(binding: &Binding) -> NormalizationContext {
    NormalizationContext {
        return_binding: Some(binding.caller.clone()),
        protocol: if binding.caller.annotations_enabled {
            Protocol::On
        } else {
            Protocol::Off
        },
        scope: Some(ExecutionScope {
            execution_id: "execution".into(),
            generation: 1,
        }),
        producer: Some(Producer {
            event_id: "response-event".into(),
            attempt_id: "attempt".into(),
            sequence: Some(3),
        }),
        ..Default::default()
    }
}
fn streamed(binding: &Binding, content: &str, size: usize) -> (String, bool, bool) {
    let mut stream = Stream::new(binding.clone());
    let mut events = vec![];
    for chunk in content.chars().collect::<Vec<_>>().chunks(size) {
        events.extend(stream.push(ModelStreamEvent::TextDelta {
            text: chunk.iter().collect(),
        }));
    }
    let incremental = events
        .iter()
        .any(|event| matches!(event, ModelStreamEvent::TextDelta { .. }));
    events.extend(stream.push(ModelStreamEvent::Completed));
    let mut text = String::new();
    for event in &events {
        if let ModelStreamEvent::TextDelta { text: delta } = event {
            text.push_str(delta);
        }
    }
    let completed = events
        .iter()
        .any(|event| matches!(event, ModelStreamEvent::Completed));
    let failed = events
        .iter()
        .any(|event| matches!(event, ModelStreamEvent::Failed { .. }));
    assert!(!(completed && failed));
    (text, completed, incremental)
}

fn item(index: usize, phase: &str, text: Option<&str>) -> ModelStreamEvent {
    ModelStreamEvent::ProviderMessageItem {
        index,
        id: Some(format!("message-{index}")),
        phase: Some(phase.into()),
        text: text.map(str::to_owned),
    }
}

fn scoped_text(
    stream: &mut Stream,
    index: usize,
    text: &str,
    size: usize,
) -> Vec<ModelStreamEvent> {
    let mut events = vec![];
    for chunk in text.chars().collect::<Vec<_>>().chunks(size) {
        let text = chunk.iter().collect::<String>();
        events.extend(stream.push(ModelStreamEvent::ProviderMessageDelta {
            index,
            content_index: 0,
            text: text.clone(),
        }));
        events.extend(stream.push(ModelStreamEvent::TextDelta { text }));
    }
    events
}

fn shown(events: &[ModelStreamEvent]) -> String {
    let mut text = String::new();
    for event in events {
        match event {
            ModelStreamEvent::TextDelta { text: delta } => text.push_str(delta),
            ModelStreamEvent::TextSnapshot { text: snapshot } => text = snapshot.clone(),
            ModelStreamEvent::Failed { message } => panic!("unexpected stream failure: {message}"),
            _ => {}
        }
    }
    text
}

#[test]
fn native_commentary_phase_change_preserves_literal_progress_and_actual_work() {
    let binding = prepared(true, true).binding;
    for text in [
        "review.txt 已读取，现在读取 progress.txt。",
        r#"{"body":"这只是协议示例","annotations":null}"#,
        "```json\n{\"effects\":[\"read\"]}\n``` 🧠",
    ] {
        for size in [1, 5, 100] {
            let mut stream = Stream::new(binding.clone());
            let mut events = stream.push(item(1, "final_answer", None));
            events.extend(scoped_text(&mut stream, 1, text, size));
            events.extend(stream.push(item(1, "commentary", Some(text))));
            events.extend(stream.push(ModelStreamEvent::ToolCallStarted {
                index: 2,
                id: "real-call".into(),
                name: "read".into(),
            }));
            let args = r#"{"path":"progress.txt","_morphz":{"intent":"读取进度"}}"#;
            events.extend(stream.push(ModelStreamEvent::ToolArgumentsDelta {
                index: 2,
                delta: args.into(),
            }));
            events.extend(stream.push(ModelStreamEvent::ToolCallCompleted { index: 2 }));
            events.extend(stream.push(ModelStreamEvent::Completed));
            assert_eq!(
                shown(&events),
                text,
                "the full protocol example is data, not a truncated body leaf"
            );
            assert_eq!(
                events
                    .iter()
                    .filter(|event| matches!(event, ModelStreamEvent::Completed))
                    .count(),
                1
            );
            let raw = Response {
                content: text.into(),
                tool_calls: vec![call("real-call", args)],
            };
            let value = normalize_messages(
                &raw,
                &stream.messages().unwrap(),
                &binding,
                &context(&binding),
            )
            .unwrap();
            assert!(
                value.terminal_decision.is_none(),
                "progress cannot close the Execution"
            );
            assert_eq!(value.execution_response.content, text);
            assert_eq!(value.execution_response.tool_calls.len(), 1);
            assert_eq!(
                value.execution_response.tool_calls[0].arguments,
                r#"{"path":"progress.txt"}"#
            );
            assert!(value
                .records
                .iter()
                .any(|record| record.kind == AnnotationKind::Intent
                    && record.call_id.as_deref() == Some("real-call")));
        }
    }
}

#[test]
fn native_commentary_and_final_items_do_not_merge_into_the_committed_answer() {
    let binding = prepared(true, true).binding;
    let mut stream = Stream::new(binding.clone());
    let progress = "正在整理。";
    let final_value = "完整的答案 🧠";
    let mut events = stream.push(item(0, "commentary", None));
    events.extend(scoped_text(&mut stream, 0, progress, 1));
    events.extend(stream.push(item(0, "commentary", Some(progress))));
    events.extend(stream.push(item(1, "final_answer", None)));
    events.extend(scoped_text(&mut stream, 1, final_value, 1));
    assert!(
        shown(&events).contains("完整的答案"),
        "actual final body streams before the item/response terminals"
    );
    events.extend(stream.push(item(1, "final_answer", Some(final_value))));
    events.extend(stream.push(ModelStreamEvent::Completed));
    assert_eq!(shown(&events), "完整的答案 🧠");
    let parts = decode_messages(
        &raw(&format!("{progress}{final_value}")),
        &stream.messages().unwrap(),
        &binding,
        "a",
    )
    .unwrap();
    assert_eq!(parts.response.content, "完整的答案 🧠");
}

#[test]
fn commentary_never_bypasses_typed_final_validation_or_ends_a_turn_alone() {
    let mut binding = prepared(true, true).binding;
    let messages = [MessageItem {
        index: 0,
        id: Some("m".into()),
        phase: Some("commentary".into()),
        text: "已读取".into(),
    }];
    assert!(decode_messages(&raw("已读取"), &messages, &binding, "a").is_err());
    binding.caller.format.id = "morphz.data".into();
    binding.caller.body_value_schema = Some(
        json!({"type":"object","properties":{"count":{"type":"integer"}},"required":["count"],"additionalProperties":false}),
    );
    binding.message_encoding = MessageEncoding::CallerJson;
    let work = Response {
        content: "已读取".into(),
        tool_calls: vec![call("c", r#"{"path":"next"}"#)],
    };
    let parts = decode_messages(&work, &messages, &binding, "a").unwrap();
    assert!(
        parts.response.content.is_empty(),
        "progress must not be parsed/published as the typed record"
    );
    let mut final_message = messages[0].clone();
    final_message.phase = Some("final_answer".into());
    assert!(
        decode_messages(&raw("已读取"), &[final_message], &binding, "a").is_err(),
        "no parse-error-to-text downgrade"
    );
    assert!(decode_messages(&raw("different"), &messages, &binding, "a").is_err());
}

#[test]
fn native_message_terminal_fences_phase_identity_and_incomplete_items() {
    let binding = prepared(true, false).binding;
    for change in [
        item(0, "commentary", Some("正文")),
        item(0, "final_answer", Some("改写")),
        ModelStreamEvent::ProviderMessageItem {
            index: 0,
            id: Some("another".into()),
            phase: Some("final_answer".into()),
            text: Some("正文".into()),
        },
    ] {
        let mut stream = Stream::new(binding.clone());
        stream.push(item(0, "final_answer", None));
        scoped_text(&mut stream, 0, "正文", 1);
        stream.push(item(0, "final_answer", Some("正文")));
        assert!(stream
            .push(change)
            .iter()
            .any(|event| matches!(event, ModelStreamEvent::Failed { .. })));
        assert!(stream.push(ModelStreamEvent::Completed).is_empty());
    }
    let mut stream = Stream::new(binding);
    stream.push(item(0, "final_answer", None));
    scoped_text(&mut stream, 0, "未完成", 1);
    assert!(stream.messages().is_err());
    assert!(stream
        .push(ModelStreamEvent::Completed)
        .iter()
        .any(|event| matches!(event, ModelStreamEvent::Failed { .. })));
}

#[test]
fn native_phase_omitted_from_item_done_can_be_supplied_by_response_completed() {
    let binding = prepared(true, true).binding;
    let mut stream = Stream::new(binding);
    let mut events = stream.push(item(0, "final_answer", None));
    events.extend(scoped_text(&mut stream, 0, "读取进度", 1));
    events.extend(stream.push(ModelStreamEvent::ProviderMessageItem {
        index: 0,
        id: None,
        phase: None,
        text: Some("读取进度".into()),
    }));
    events.extend(stream.push(item(0, "commentary", Some("读取进度"))));
    assert_eq!(shown(&events), "读取进度");
    assert_eq!(
        stream.messages().unwrap()[0].phase.as_deref(),
        Some("commentary")
    );
    // A real final-only turn still cannot complete on this progress alone.
    assert!(stream
        .push(ModelStreamEvent::Completed)
        .iter()
        .any(|event| matches!(event, ModelStreamEvent::Failed { .. })));
}

#[test]
fn tool_projection_is_stable_for_all_modes_and_never_mutates_business_schema() {
    let original = tools();
    let unchanged = json!(original);
    let first = prepared(true, false);
    for enabled in [true, false] {
        for worked in [true, false] {
            let candidate = prepared(enabled, worked);
            assert_eq!(json!(candidate.tools), json!(first.tools));
            assert_eq!(candidate.binding.tools_sha256, first.binding.tools_sha256);
            assert_eq!(candidate.tools[0].parameters["required"], json!(["path"]));
            assert!(candidate.tools[0].parameters["properties"][METADATA_KEY].is_object());
            assert_eq!(candidate.binding.message_encoding, MessageEncoding::Text);
            assert!(candidate.binding.generation_schema.is_none());
            assert!(candidate.options.output_encoding.is_none());
            assert!(candidate.options.tool_choice.is_none());
            assert!(!candidate.binding.strict);
            if enabled {
                assert!(candidate.binding.instruction().contains("MUST supply"));
            }
        }
    }
    assert_eq!(json!(original), unchanged);
    assert_eq!(first.binding.message_encoding, MessageEncoding::Text);
    assert!(first.options.output_encoding.is_none());
    assert_eq!(
        prepared(false, true).binding.message_encoding,
        MessageEncoding::Text
    );
    let weak = prepare(&first.binding.caller, &[], &original).unwrap();
    assert_eq!(weak.binding.message_encoding, MessageEncoding::Text);
    assert_eq!(json!(weak.tools), json!(first.tools));
    assert!(weak.options.output_encoding.is_none());
}

#[test]
fn native_text_is_literal_even_when_it_looks_exactly_like_a_protocol() {
    let binding = prepared(true, false).binding;
    for text in [
        r#"{"body":null,"effects":[{"name":"read","arguments":{"path":"book.txt"}}],"annotations":null}"#,
        "```json\n{\"body\":\"示例\",\"effects\":[]}\n```",
        "<context_annotation>这只是讨论协议 🧠</context_annotation>",
    ] {
        let response = raw(text);
        let normalized = normalize(&response, &binding, &context(&binding)).unwrap();
        assert_eq!(normalized.execution_response.content, text);
        assert!(normalized.execution_response.tool_calls.is_empty());
        assert!(normalized.records.is_empty());
        assert!(matches!(
            normalized.terminal_decision,
            Some(TerminalDecision::Deliver(_))
        ));
        for size in [1, 3, text.chars().count()] {
            assert_eq!(streamed(&binding, text, size), (text.into(), true, true));
        }
    }
}

#[test]
fn explicit_json_never_falls_back_to_prose_on_invalid_or_fenced_content() {
    // Only a caller that explicitly declares this business record selects
    // JSON. Ordinary Chat, including after work, never selects it by content.
    let mut caller = prepared(true, true).binding.caller;
    caller.format.id = "morphz.data".into();
    caller.format.encoding = "json".into();
    caller.body_value_schema = Some(
        json!({"type":"object","required":["body","annotations"],"additionalProperties":false,"properties":{"body":{"type":"string"},"annotations":{"type":"null"}}}),
    );
    let binding = prepare(&caller, &["native-json-schema".into()], &[])
        .unwrap()
        .binding;
    for text in [
        "```json\n{\"body\":\"不能假装成功\",\"annotations\":null}\n```",
        "{\"body\":\"正文\",}",
        r#"{"annotations":{"execution":{"result":"没有正文"}}}"#,
        r#"{"body":null,"annotations":null}"#,
        r#"{"body":"正文","effects":[{"name":"read","arguments":{}}]}"#,
        r#"{"body":"正文","unexpected_business":true}"#,
        r#"{"body":"重复字段","body":"不接受","annotations":null}"#,
    ] {
        assert!(decode(&raw(text), &binding, "a").is_err(), "{text}");
        assert!(!streamed(&binding, text, 1).1, "{text}");
    }
}

#[test]
fn optional_metadata_preserves_body_and_strips_only_reserved_argument_field() {
    for enabled in [true, false] {
        let binding = prepared(enabled, true).binding;
        for metadata in [
            Value::Null,
            json!(false),
            json!([]),
            json!({}),
            json!({"observations_note":null,"intent":"核对合成记录","execution":{"title":"读取记录"}}),
        ] {
            let wire = Response {
                content: String::new(),
                tool_calls: vec![call(
                    "c",
                    &json!({"path":"fixture.txt","_morphz":metadata}).to_string(),
                )],
            };
            let parts = decode(&wire, &binding, "a").unwrap();
            let business = Data::parse(
                parts.response.tool_calls[0].arguments.as_bytes(),
                &Limits::default(),
            )
            .unwrap();
            super::super::schema::validate(&tools()[0].parameters, &business, "").unwrap();
            assert_eq!(business.json(), r#"{"path":"fixture.txt"}"#);
            if !enabled {
                assert!(parts.annotation_messages.is_empty());
            }
            assert!(
                wire.tool_calls[0].arguments.contains("_morphz"),
                "raw evidence remains unchanged"
            );
            let body = "完整正文";
            assert_eq!(
                decode(&raw(body), &binding, "a").unwrap().response.content,
                "完整正文"
            );
        }
        let exact = "{ \"path\" : \"fixture.txt\" }";
        let parts = decode(
            &Response {
                content: String::new(),
                tool_calls: vec![call("c", exact)],
            },
            &binding,
            "a",
        )
        .unwrap();
        assert_eq!(parts.response.tool_calls[0].arguments, exact);
        let invalid = decode(&Response { content: String::new(), tool_calls: vec![call("c", r#"{"path":"fixture.txt","unknown_business":true,"_morphz":{"intent":"valid"}}"#)] }, &binding, "a").unwrap();
        let arguments = Data::parse(
            invalid.response.tool_calls[0].arguments.as_bytes(),
            &Limits::default(),
        )
        .unwrap();
        assert!(
            super::super::schema::validate(&tools()[0].parameters, &arguments, "").is_err(),
            "metadata must not hide unknown business fields"
        );
    }
    assert_eq!(
        decode(&raw("缺注解也完整"), &prepared(true, true).binding, "a")
            .unwrap()
            .response
            .content,
        "缺注解也完整"
    );
}

#[test]
fn annotation_identity_and_observation_ownership_come_from_runtime() {
    let binding = prepared(true, false).binding;
    let wire = Response {
        content: String::new(),
        tool_calls: vec![
            call(
                "actual-a",
                r#"{"path":"a","_morphz":{"intent":"第一步","calls":[{"index":1,"intent":"伪造关联"}],"execution":{"title":"真实任务","result":"提前成功"}}}"#,
            ),
            call(
                "actual-b",
                r#"{"path":"b","_morphz":{"intent":"第二步","observations":[{"ref":"other-execution","result":"越权引用"}]}}"#,
            ),
        ],
    };
    let normalized = normalize(&wire, &binding, &context(&binding)).unwrap();
    let intents = normalized
        .records
        .iter()
        .filter(|record| record.kind == AnnotationKind::Intent)
        .collect::<Vec<_>>();
    assert_eq!(intents.len(), 2);
    assert_eq!(intents[0].call_id.as_deref(), Some("actual-a"));
    assert_eq!(intents[0].value, "第一步");
    assert_eq!(intents[1].call_id.as_deref(), Some("actual-b"));
    assert!(normalized.terminal_decision.is_none());
    assert!(!normalized.records.iter().any(|record| matches!(
        record.kind,
        AnnotationKind::Result | AnnotationKind::ObservationResult
    )));
    let binding = prepared(true, true).binding;
    let response = Response {
        content: "已核对第一份，接着读取第二份".into(),
        tool_calls: vec![call(
            "next",
            r#"{"path":"next","_morphz":{"intent":"读取第二份","observations":[{"ref":"allowed","result":"已核实"},{"ref":"other","result":"错误作用域"}]}}"#,
        )],
    };
    let mut ctx = context(&binding);
    ctx.observations.insert(
        "allowed".into(),
        TrustedObservation {
            event_id: "observation-event".into(),
            scope: ctx.scope.clone().unwrap(),
            provided: true,
            allowed: true,
        },
    );
    let normalized = normalize(&response, &binding, &ctx).unwrap();
    assert_eq!(
        normalized
            .records
            .iter()
            .filter(|record| record.kind == AnnotationKind::ObservationResult)
            .count(),
        1
    );
    assert!(normalized.terminal_decision.is_none());
}

#[test]
fn post_work_body_streams_literally_across_unicode_and_protocol_boundaries() {
    let binding = prepared(true, true).binding;
    let text = "中文 \"引号\"\n🧠 <context_annotation> literal {body,effects}";
    for size in 1..=text.chars().count() {
        assert_eq!(streamed(&binding, text, size), (text.into(), true, true));
    }
    assert_eq!(
        streamed(
            &binding,
            r#"{"body":"\uD83E\uDDE0\n中文","annotations":null}"#,
            1
        ),
        (
            r#"{"body":"\uD83E\uDDE0\n中文","annotations":null}"#.into(),
            true,
            true
        )
    );
}

#[test]
fn native_call_stream_exposes_only_original_business_parameters() {
    let binding = prepared(true, false).binding;
    let mut stream = Stream::new(binding);
    let mut events = stream.push(ModelStreamEvent::ToolCallStarted {
        index: 0,
        id: "actual".into(),
        name: "read".into(),
    });
    for c in r#"{"path":"fixture.txt","_morphz":{"intent":"私有结构化注解"}}"#.chars() {
        assert!(stream
            .push(ModelStreamEvent::ToolArgumentsDelta {
                index: 0,
                delta: c.to_string()
            })
            .is_empty());
    }
    events.extend(stream.push(ModelStreamEvent::ToolCallCompleted { index: 0 }));
    events.extend(stream.push(ModelStreamEvent::Completed));
    let deltas = events
        .iter()
        .filter_map(|event| match event {
            ModelStreamEvent::ToolArgumentsDelta { delta, .. } => Some(delta.as_str()),
            _ => None,
        })
        .collect::<String>();
    assert_eq!(deltas, r#"{"path":"fixture.txt"}"#);
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, ModelStreamEvent::ToolCallCompleted { .. }))
            .count(),
        1
    );
    assert!(events
        .iter()
        .any(|event| matches!(event, ModelStreamEvent::Completed)));
    assert!(stream.push(ModelStreamEvent::Completed).is_empty());
}

#[test]
fn typed_values_keep_the_original_schema_and_numeric_precision() {
    let mut caller = ReturnBinding::new("execution", 1, "infer", true).with_native_output();
    caller.format.id = "morphz.data".into();
    caller.format.encoding = "json".into();
    caller.body_value_schema = Some(
        json!({"type":"object","required":["count","body","effects"],"additionalProperties":false,"properties":{"count":{"type":"integer"},"body":{"type":"string"},"effects":{"type":"array","items":{"type":"string"}}}}),
    );
    for worked in [false, true] {
        if worked {
            caller
                .annotation_observation_refs
                .push("actual-read".into());
        }
        let binding = prepare(&caller, &["native-json-schema".into()], &[])
            .unwrap()
            .binding;
        let value = r#"{"count":123456789012345678901234567890,"body":"业务同名字段","effects":["普通数据"]}"#;
        assert_eq!(binding.message_encoding, MessageEncoding::CallerJson);
        assert_eq!(binding.generation_schema, caller.body_value_schema);
        let wire = value.to_string();
        let decoded = decode(&raw(&wire), &binding, "a").unwrap();
        assert_eq!(
            Data::parse(decoded.response.content.as_bytes(), &Limits::default()).unwrap(),
            Data::parse(value.as_bytes(), &Limits::default()).unwrap()
        );
        for size in [1, 3, wire.chars().count()] {
            let (text, completed, incremental) = streamed(&binding, &wire, size);
            assert!(completed && incremental);
            assert_eq!(
                Data::parse(text.as_bytes(), &Limits::default()).unwrap(),
                Data::parse(value.as_bytes(), &Limits::default()).unwrap()
            );
        }
        let invalid = r#"{"count":"not integer","body":"x","effects":[]}"#;
        assert!(decode(&raw(invalid), &binding, "a").is_err());
    }
}

#[test]
fn reserved_collisions_duplicate_identity_and_companion_deliveries_are_rejected() {
    let unmarked = ReturnBinding::new("historical", 1, "activation", true);
    assert!(
        prepare(&unmarked, &[], &tools()).is_err(),
        "Absence of output must not silently upgrade an old task"
    );
    let admitted = ReturnBinding::new("existing", 1, "activation", true).with_unified_output();
    let snapshot = serde_json::to_string(&admitted).unwrap();
    assert!(prepare(&admitted, &["native-json-schema".into()], &tools()).is_err());
    assert_eq!(serde_json::to_string(&admitted).unwrap(), snapshot);
    let mut collision = tools();
    collision[0].parameters["properties"][METADATA_KEY] = json!({"type":"string"});
    assert!(model_tools(&collision).is_err());
    let binding = prepared(true, false).binding;
    assert!(decode(
        &Response {
            content: String::new(),
            tool_calls: vec![call("same", "{}"), call("same", "{}")]
        },
        &binding,
        "a"
    )
    .is_err());
    let companion = ToolCallRepr {
        func_name: "deliver_message".into(),
        arguments: json!({"delivery_id":binding.caller.delivery_id}).to_string(),
        ..call("c", "{}")
    };
    assert!(decode(
        &Response {
            content: "正文".into(),
            tool_calls: vec![companion]
        },
        &binding,
        "a"
    )
    .is_err());
    let no_reply = ToolCallRepr {
        func_name: "no_reply".into(),
        arguments: r#"{"mode":"silent"}"#.into(),
        ..call("silent", "{}")
    };
    assert!(normalize(
        &Response {
            content: "不能同时回复".into(),
            tool_calls: vec![no_reply.clone()]
        },
        &binding,
        &context(&binding)
    )
    .is_err());
    assert!(matches!(
        normalize(
            &Response {
                content: String::new(),
                tool_calls: vec![no_reply]
            },
            &binding,
            &context(&binding)
        )
        .unwrap()
        .terminal_decision,
        Some(TerminalDecision::NoReply(_))
    ));
}

#[test]
fn persisted_native_evidence_replays_the_exact_binding_without_text_sniffing() {
    use crate::response_annotations::{normalize_delivery, PersistedAnnotations};
    let binding = prepared(true, false).binding;
    let context = context(&binding);
    let body = r#"{"body":"a literal example","effects":[{"name":"delete","arguments":{}}]}"#;
    let response = raw(body);
    let messages = vec![MessageItem {
        index: 2,
        id: Some("actual-native-id".into()),
        phase: Some("final_answer".into()),
        text: body.into(),
    }];
    let normalized = normalize_messages(&response, &messages, &binding, &context).unwrap();
    let persisted =
        PersistedAnnotations::from_normalized(context.scope.clone().unwrap(), &normalized);
    let restored: PersistedAnnotations =
        serde_json::from_slice(&serde_json::to_vec(&persisted).unwrap()).unwrap();
    let replay = restored.replay(&context).unwrap();
    assert_eq!(replay.execution_response.content, body);
    assert!(replay.execution_response.tool_calls.is_empty());
    assert_eq!(replay.native_response, normalized.native_response);
    assert!(normalize_delivery(&response, &context, None).is_err());
    let mut wrong = restored.native_response.unwrap();
    wrong.binding.caller.carrier = None;
    assert!(normalize_delivery(&response, &context, Some(&wrong)).is_err());
    wrong.binding = binding;
    wrong.messages[0].text = "changed after persistence".into();
    assert!(normalize_delivery(&response, &context, Some(&wrong)).is_err());
}
