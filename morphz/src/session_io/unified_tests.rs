use super::response::{annotations_value, split_response_for_attempt, ReturnBinding};
use super::unified::*;
use crate::llm::{Response, ToolCallRepr, ToolDefinition};
use serde_json::{json, Value};

fn bound(enabled: bool) -> ReturnBinding {
    ReturnBinding::new("execution", 3, "activation", enabled).with_unified_output()
}
fn raw(value: Value) -> Response {
    Response {
        content: value.to_string(),
        tool_calls: vec![],
    }
}
fn read(intent: Value) -> Value {
    json!({"name":"read","arguments":{"path":"book.txt"},"intent":intent})
}
fn decode_value(value: Value, enabled: bool) -> super::IoResult<super::response::ResponseParts> {
    split_response_for_attempt(&raw(value), &bound(enabled), "physical-attempt")
}

#[test]
fn optional_metadata_never_invalidates_independent_body_or_real_proposals() {
    for enabled in [true, false] {
        for annotations in [
            Value::Null,
            json!(false),
            json!("invalid"),
            json!({}),
            json!({"execution":{"title":"读取合成书籍","progress":null,"unexpected":5},"observations_note":null}),
        ] {
            for intent in [
                Value::Null,
                json!([]),
                json!("读取合成书籍以确认作者"),
                json!("长".repeat(257)),
            ] {
                let value = json!({"body":null,"effects":[read(intent)],"annotations":annotations});
                let parts = decode_value(value, enabled).unwrap();
                assert_eq!(parts.response.tool_calls.len(), 1);
                assert_eq!(parts.response.tool_calls[0].func_name, "read");
                if !enabled {
                    assert!(parts.annotation_messages.is_empty());
                }
                assert_eq!(
                    serde_json::from_str::<Value>(&parts.response.tool_calls[0].arguments).unwrap(),
                    json!({"path":"book.txt"})
                );
                let final_parts = decode_value(
                    json!({"body":"真实作者是测试作者。","effects":[],"annotations":annotations}),
                    enabled,
                )
                .unwrap();
                assert_eq!(final_parts.response.content, "真实作者是测试作者。");
                if !enabled {
                    assert!(final_parts.annotation_messages.is_empty());
                }
            }
        }
        let missing = decode_value(
            json!({"body":null,"effects":[{"name":"read","arguments":{"path":"book.txt"}}]}),
            enabled,
        )
        .unwrap();
        assert_eq!(missing.response.tool_calls.len(), 1);
        assert!(missing.annotation_messages.is_empty());
        assert_eq!(
            decode_value(json!({"body":"没有注解也保留正文"}), enabled)
                .unwrap()
                .response
                .content,
            "没有注解也保留正文"
        );
    }
}

#[test]
fn real_deepseek_unified_values_replay_without_display_fields_gating_business() {
    // Synthetic live transport evidence; this is decoder replay, not a live
    // Runtime, authorization, scheduling or original Desktop acceptance test.
    let evidence: Value = serde_json::from_str(include_str!(
        "../../../docs/session_io_unified_carrier_research_2026-10-20.json"
    ))
    .unwrap();
    let records = evidence["records"].as_array().unwrap();
    assert_eq!(records.len(), 9);
    let mut disabled_generated_annotation = false;
    let mut invalid_optional_metadata = false;
    for record in records {
        let raw_text = record["raw"].as_str().unwrap();
        let value: Value = serde_json::from_str(raw_text).unwrap();
        let typed = record["name"] == "typed-record";
        let response = Response {
            content: raw_text.into(),
            tool_calls: vec![],
        };
        let mut binding = bound(record["annotations_enabled"].as_bool().unwrap());
        if typed {
            binding.format = super::OutputFormat {
                id: "morphz.data".into(),
                version: "1".into(),
                encoding: "json".into(),
                schema_hash: None,
                contract_hash: None,
            };
        }
        let parts = split_response_for_attempt(&response, &binding, "live-replay").unwrap();
        assert_eq!(response.content, raw_text);
        let effects = value["effects"].as_array().unwrap();
        assert_eq!(parts.response.tool_calls.len(), effects.len());
        for (call, effect) in parts.response.tool_calls.iter().zip(effects) {
            assert_eq!(call.func_name, effect["name"].as_str().unwrap());
            assert_eq!(
                serde_json::from_str::<Value>(&call.arguments).unwrap(),
                effect["arguments"]
            );
        }
        if typed {
            assert_eq!(
                serde_json::from_str::<Value>(&parts.response.content).unwrap(),
                value["body"]
            );
        } else {
            assert_eq!(parts.response.content, value["body"].as_str().unwrap_or(""));
        }
        if !binding.annotations_enabled {
            assert!(parts.annotation_messages.is_empty());
            disabled_generated_annotation |= !value["annotations"].is_null();
        }
        if record["schema_valid"] == false {
            invalid_optional_metadata = true;
            assert!(parts
                .diagnostics
                .iter()
                .any(|note| note.contains("observations")));
            let annotations = annotations_value(&parts.annotation_messages[0].message).unwrap();
            assert!(annotations["execution"]["title"].as_str().is_some());
            assert!(annotations["calls"][0]["intent"].as_str().is_some());
        }
    }
    assert!(
        disabled_generated_annotation,
        "retain the real none/off counterexample"
    );
    assert!(
        invalid_optional_metadata,
        "retain the real null/array counterexample"
    );
}

#[test]
fn runtime_constructs_stable_work_identity_and_intent_association() {
    let value = json!({"body":null,"effects":[read(json!("读取指定书籍确认作者"))],"annotations":{"execution":{"title":"确认作者","progress":"正在读取"},"calls":[{"index":99,"intent":"不能替代真实步骤"}]}});
    let first = decode_value(value.clone(), true).unwrap();
    let replay = decode_value(value.clone(), true).unwrap();
    assert_eq!(first.response.tool_calls, replay.response.tool_calls);
    let next = split_response_for_attempt(&raw(value), &bound(true), "different-attempt").unwrap();
    assert_ne!(
        first.response.tool_calls[0].id,
        next.response.tool_calls[0].id
    );
    let annotations = annotations_value(&first.annotation_messages[0].message).unwrap();
    assert_eq!(
        annotations["calls"],
        json!([{"index":0,"intent":"读取指定书籍确认作者"}])
    );
    assert_eq!(annotations["execution"]["title"], "确认作者");
    assert!(!first.response.tool_calls[0].arguments.contains("intent"));
}

#[test]
fn extra_outer_display_fields_are_not_authority_or_duplicate_work() {
    let parts=decode_value(json!({"type":"function","body":null,"effects":[{"type":"function","name":"read","arguments":{"path":"book.txt"}}],"permission":"granted","annotations":null}),true).unwrap();
    assert_eq!(parts.response.tool_calls.len(), 1);
    assert!(parts
        .diagnostics
        .iter()
        .any(|note| note.contains("permission")));
    assert!(parts
        .diagnostics
        .iter()
        .any(|note| note.contains("/effects/0/type")));
    assert_eq!(
        parts.response.tool_calls[0].arguments,
        r#"{"path":"book.txt"}"#
    );
}

#[test]
fn plain_chat_and_literal_protocol_examples_remain_original_body() {
    let body="第一行 \"引号\" 🧠\n```json\n{\"body\":\"只是示例\"}\n```\n<context_annotation>这里只讨论标签</context_annotation>";
    for enabled in [true, false] {
        let parts = decode_value(json!({"body":body,"effects":[]}), enabled).unwrap();
        assert_eq!(parts.response.content, body);
        assert!(parts.response.tool_calls.is_empty());
        assert!(parts.annotation_messages.is_empty());
        let native = Response {
            content: body.into(),
            tool_calls: vec![],
        };
        assert_eq!(
            split_response_for_attempt(&native, &bound(enabled), "attempt")
                .unwrap()
                .response
                .content,
            body
        );
        let scalar = Response {
            content: "5".into(),
            tool_calls: vec![],
        };
        assert_eq!(
            split_response_for_attempt(&scalar, &bound(enabled), "attempt")
                .unwrap()
                .response
                .content,
            "5"
        );
    }
}

#[test]
fn no_body_cannot_be_mistaken_for_success_even_with_metadata() {
    for value in [
        json!({"annotations":{"execution":{"result":"完成"}}}),
        json!({"body":null,"effects":[],"annotations":{}}),
        json!({"body":"  ","effects":[]}),
    ] {
        assert!(decode_value(value, true).is_err());
    }
    assert!(split_response_for_attempt(
        &Response {
            content: String::new(),
            tool_calls: vec![]
        },
        &bound(true),
        "attempt"
    )
    .is_err());
}

#[test]
fn malformed_business_shape_is_not_repaired_to_match_a_tool() {
    for effect in [
        json!({"arguments":{}}),
        json!({"name":"read"}),
        json!({"name":"read","arguments":"book.txt"}),
        json!("read"),
        json!({"name":"","arguments":{}}),
    ] {
        assert!(decode_value(json!({"body":null,"effects":[effect]}), true).is_err());
    }
    assert!(decode_value(json!({"body":3,"effects":[]}), true).is_err());
    assert!(decode_value(json!({"body":"answer","effects":"none"}), true).is_err());
    let invalid = Response {
        content: "{\"body\":\"unclosed".into(),
        tool_calls: vec![],
    };
    assert!(split_response_for_attempt(&invalid, &bound(true), "attempt").is_err());
    // Exact business arguments survive. Their domain validation belongs to
    // the existing tool/permission boundary; no coerced aliases are invented.
    let parts = decode_value(
        json!({"body":null,"effects":[{"name":"read","arguments":{"wrong_argument":42}}]}),
        true,
    )
    .unwrap();
    assert_eq!(
        parts.response.tool_calls[0].arguments,
        r#"{"wrong_argument":42}"#
    );
}

#[test]
fn native_calls_without_metadata_remain_work_but_two_work_lists_are_rejected() {
    let call = ToolCallRepr {
        id: "native-id".into(),
        r#type: "function".into(),
        func_name: "read".into(),
        arguments: r#"{"path":"book.txt"}"#.into(),
    };
    let native = Response {
        content: String::new(),
        tool_calls: vec![call.clone()],
    };
    let parts = split_response_for_attempt(&native, &bound(true), "attempt").unwrap();
    assert_eq!(parts.response.tool_calls, [call.clone()]);
    assert!(parts.annotation_messages.is_empty());
    let mixed = Response {
        content: json!({"body":null,"effects":[read(Value::Null)]}).to_string(),
        tool_calls: vec![call],
    };
    assert!(split_response_for_attempt(&mixed, &bound(true), "attempt").is_err());
}

#[test]
fn no_reply_and_ordinary_business_publications_keep_their_distinct_meanings() {
    let waiting = json!({"name":"no_reply","arguments":{"reason":"waiting"}});
    assert_eq!(
        decode_value(json!({"body":null,"effects":[waiting.clone()]}), true)
            .unwrap()
            .response
            .tool_calls[0]
            .func_name,
        "no_reply"
    );
    assert!(decode_value(json!({"body":"answer","effects":[waiting]}), true).is_err());
    for arguments in [
        json!({"delivery_id":bound(true).delivery_id}),
        json!({"delivery_id":"other","message":{"format":{"id":"morphz.response.annotations"}}}),
    ] {
        assert!(decode_value(
            json!({"body":"body","effects":[{"name":"deliver_message","arguments":arguments}]}),
            true
        )
        .is_err());
    }
    let publication = json!({"name":"deliver_message","arguments":{"delivery_id":"business-publication","message":{"format":{"id":"business.note"}}}});
    assert_eq!(
        decode_value(json!({"body":null,"effects":[publication]}), true)
            .unwrap()
            .response
            .tool_calls[0]
            .func_name,
        "deliver_message"
    );
}

#[test]
fn caller_types_are_preserved_and_registered_business_schemas_are_checked() {
    let mut binding = bound(true);
    binding.format = super::OutputFormat {
        id: "morphz.data".into(),
        version: "1".into(),
        encoding: "json".into(),
        schema_hash: None,
        contract_hash: None,
    };
    for value in [
        json!(false),
        json!(null),
        json!(42),
        json!("完整 String"),
        json!({"answer":"complete","other":false}),
    ] {
        let response = raw(json!({"body":value,"effects":[],"annotations":null}));
        let parts = split_response_for_attempt(&response, &binding, "attempt").unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&parts.response.content).unwrap(),
            value
        );
    }
    assert!(split_response_for_attempt(
        &raw(json!({"body":false,"effects":[read(Value::Null)]})),
        &binding,
        "attempt"
    )
    .is_err());
    let mut registry = super::Registry::default();
    registry.register(super::Descriptor{id:"test.exact".into(),version:"1".into(),encodings:vec!["json".into()],schema:Some(json!({"type":"object","required":["answer"],"additionalProperties":false,"properties":{"answer":{"type":"boolean"}}})),contract:None,publisher:"test".into(),required_visible_paths:vec![],resource_paths:vec![]}).unwrap();
    let format = registry
        .resolve(&super::Format::new("test.exact", "1"), "json", "registered")
        .unwrap();
    binding.format = format.format.clone();
    binding.caller = Some(format);
    assert!(split_response_for_attempt(
        &raw(json!({"body":{"answer":"false"},"effects":[]})),
        &binding,
        "attempt"
    )
    .is_err());
    assert!(split_response_for_attempt(
        &raw(json!({"body":{"answer":false},"effects":[]})),
        &binding,
        "attempt"
    )
    .is_ok());
    assert!(
        split_response_for_attempt(&raw(json!({"answer": "false"})), &binding, "attempt").is_err()
    );
    assert!(
        split_response_for_attempt(&raw(json!({"answer": false})), &binding, "attempt").is_ok()
    );
}

#[test]
fn generation_schema_is_stable_across_annotation_modes_and_keeps_business_parameters() {
    let tools = vec![ToolDefinition {
        name: "read".into(),
        description: "read actual file".into(),
        parameters: json!({"type":"object","required":["path"],"properties":{"path":{"type":"string"}}}),
    }];
    let before = serde_json::to_value(&tools).unwrap();
    let on = generation_schema(&bound(true), &tools);
    let off = generation_schema(&bound(false), &tools);
    assert_eq!(on, off);
    assert_eq!(serde_json::to_value(&tools).unwrap(), before);
    assert_eq!(
        on["properties"]["effects"]["items"]["properties"]["name"]["enum"],
        json!(["read"])
    );
    assert_eq!(
        generation_schema(&bound(true), &[])["properties"]["effects"]["maxItems"],
        0
    );
}

#[test]
fn old_frozen_output_is_not_reinterpreted_with_the_new_decoder() {
    let legacy = ReturnBinding::new("execution", 3, "activation", true);
    assert!(!selected(&legacy));
    let mut v1 = legacy.clone();
    v1.output = Some(super::evaluation::binding());
    assert!(!selected(&v1));
    let saved = serde_json::to_value(&v1).unwrap();
    let restored: ReturnBinding = serde_json::from_value(saved.clone()).unwrap();
    assert_eq!(serde_json::to_value(&restored).unwrap(), saved);
    assert!(!selected(&restored));
    assert_ne!(
        binding().format.schema_hash,
        super::evaluation::binding().format.schema_hash
    );
}

#[test]
fn admitted_typed_schema_reaches_native_output_without_losing_nominal_definitions() {
    for schema in [
        json!({"type":"boolean"}),
        json!({"type":"string"}),
        json!({"$ref":"#/$defs/Decision","$defs":{"Decision":{
            "type":"object","additionalProperties":false,"required":["ok","count"],
            "properties":{"ok":{"type":"boolean"},"count":{"type":"integer","minimum":i64::MIN,"maximum":i64::MAX}}
        }}}),
    ] {
        let mut binding = bound(true);
        binding.format.id = "morphz.data".into();
        binding.body_value_schema = Some(schema.clone());
        let restored: ReturnBinding =
            serde_json::from_value(serde_json::to_value(&binding).unwrap()).unwrap();
        assert_eq!(restored.body_value_schema, Some(schema.clone()));
        let (Some(crate::llm::ModelOutputEncoding::JsonSchema { schema: native, .. }), _) =
            request_options(&restored, &[NATIVE_SCHEMA_CAPABILITY.into()], &[])
        else {
            panic!("missing native schema")
        };
        let mut expected = schema.clone();
        let defs = expected.as_object_mut().unwrap().remove("$defs");
        assert_eq!(native["properties"]["body"]["anyOf"][0], expected);
        assert_eq!(native.get("$defs"), defs.as_ref());
        // It is also in Context, not merely a native parameter the model's
        // weak transport may ignore. Caller validation is still the Yao Plan.
        assert!(restored
            .expression()
            .get_path(&["body_value_schema"])
            .is_some());
    }
}

#[test]
fn native_controls_require_an_explicit_physical_capability_not_a_model_name() {
    use crate::llm::{ModelOutputEncoding, ModelToolChoice};
    for enabled in [false, true] {
        for capabilities in [
            vec![],
            vec!["deepseek-flash".into()],
            vec!["openai-responses".into()],
        ] {
            let (encoding, choice) = request_options(&bound(enabled), &capabilities, &[]);
            assert!(encoding.is_none());
            assert!(choice.is_none());
        }
        let (encoding, choice) =
            request_options(&bound(enabled), &[NATIVE_SCHEMA_CAPABILITY.into()], &[]);
        let Some(ModelOutputEncoding::JsonSchema {
            name,
            schema,
            strict,
        }) = encoding
        else {
            panic!("native schema missing")
        };
        assert_eq!(name, "morphz_evaluation_v2");
        assert_eq!(schema, generation_schema(&bound(enabled), &[]));
        assert!(
            !strict,
            "open original arguments cannot be silently rewritten into a strict subset"
        );
        assert_eq!(choice, Some(ModelToolChoice::None));
    }
    let unbound = ReturnBinding::new("t", 1, "e", true);
    assert!(
        request_options(&unbound, &[NATIVE_SCHEMA_CAPABILITY.into()], &[])
            .0
            .is_none()
    );
    let mut v1 = unbound;
    v1.output = Some(super::evaluation::binding());
    assert!(matches!(
        request_options(&v1, &[NATIVE_SCHEMA_CAPABILITY.into()], &[]),
        (Some(ModelOutputEncoding::JsonObject), None)
    ));
}

#[test]
fn an_admitted_chat_definition_preserves_the_ordinary_implicit_string() {
    let chat = super::Registry::default()
        .resolve(
            &super::Format::new("morphz.chat", "1"),
            "json",
            "registered",
        )
        .unwrap();
    let binding = bound(true).with_formats(&[chat]);
    let response = Response {
        content: "Ready.\n完整正文".into(),
        tool_calls: vec![],
    };
    assert_eq!(
        split_response_for_attempt(&response, &binding, "attempt")
            .unwrap()
            .response
            .content,
        response.content
    );
}

// These are explicit failing reproductions, not passing acceptance coverage.
// Request-side wire selection currently cannot be supplied to the decoder or
// stream normalizer. Changing that carrier boundary is still under review.
#[test]
#[ignore = "Known original-window failure: the actual JSON carrier is not frozen into receiving interpretation"]
fn known_transport_boundary_regression_fenced_proposal_is_not_a_completed_answer() {
    use super::response_stream::ModelStreamNormalizer;
    use crate::llm::{ModelOutputEncoding, ModelStreamEvent, ModelToolChoice};

    let binding = bound(true);
    let tools = vec![ToolDefinition {
        name: "list_skills".into(),
        description: "List existing skills".into(),
        parameters: json!({"type":"object","properties":{}}),
    }];
    let (encoding, choice) =
        request_options(&binding, &[NATIVE_SCHEMA_CAPABILITY.into()], &tools);
    assert!(matches!(encoding, Some(ModelOutputEncoding::JsonSchema { .. })));
    assert_eq!(choice, Some(ModelToolChoice::None));

    // Same shape as the observed original-window response, with only a
    // synthetic title. No private Context and no actual tools are executed.
    let content = concat!(
        "```json\n",
        "{\"body\":null,\"effects\":[{\"name\":\"list_skills\",\"arguments\":{},",
        "\"intent\":\"确认现有阅读工具\"}],\"annotations\":{\"execution\":",
        "{\"title\":\"TEST 只读验收\"},\"observations\":[]}}\n```"
    );
    let response = Response { content: content.into(), tool_calls: vec![] };
    let decoded = split_response_for_attempt(&response, &binding, "TEST-fenced-work");
    let mut stream = ModelStreamNormalizer::new(binding);
    let mut events = vec![];
    for character in content.chars() {
        events.extend(stream.push(ModelStreamEvent::TextDelta { text: character.to_string() }));
    }
    events.extend(stream.push(ModelStreamEvent::Completed));
    let publicly_completed = events.iter().any(|event| matches!(event, ModelStreamEvent::Completed));

    // Reject this malformed response in its requested JSON carrier. Never
    // strip the fence and execute it, nor call an unexecuted proposal success.
    assert!(
        decoded.is_err() && !publicly_completed,
        "requested JSON carrier must not silently become prose: decoder accepted={}, public completed={publicly_completed}",
        decoded.is_ok()
    );
}

#[test]
#[ignore = "Known converse boundary failure: ordinary native text is sniffed for Evaluation field names"]
fn known_transport_boundary_regression_literal_json_does_not_propose_work() {
    let binding = bound(true);
    let tools = vec![ToolDefinition {
        name: "read".into(),
        description: "Read an authorized file".into(),
        parameters: json!({"type":"object","required":["path"],"properties":{"path":{"type":"string"}}}),
    }];
    // This physical transport did not request a structured message. A literal
    // JSON example in ordinary text must not become a new source of actions.
    assert_eq!(request_options(&binding, &[], &tools), (None, None));
    let content = json!({
        "body":"这是协议示例，不是执行请求",
        "effects":[{"name":"read","arguments":{"path":"TEST-not-executed.txt"},"intent":null}],
        "annotations":null
    }).to_string();
    let response = Response { content: content.clone(), tool_calls: vec![] };
    let decoded = split_response_for_attempt(&response, &binding, "TEST-literal-example").unwrap();
    assert!(
        decoded.response.tool_calls.is_empty() && decoded.response.content == content,
        "ordinary text must stay data: synthesized work proposals={}, body preserved={}",
        decoded.response.tool_calls.len(),
        decoded.response.content == content
    );
}
