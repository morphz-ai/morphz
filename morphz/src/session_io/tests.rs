use super::*;

fn request(value: &str) -> Request {
    Request::parse(r#"{"io_version":"1","client_message_id":"test","message":{"format":{"id":"test.data","version":"1"},"validation":"generic","content":{"encoding":"json","value":__BODY__}}}"#.replace("__BODY__", value).as_bytes(), &Limits::default()).unwrap()
}
fn enabled() -> Registry {
    Registry {
        enabled: true,
        ..Default::default()
    }
}

#[test]
fn directed_typed_input_is_bound_without_overriding_the_original_route() {
    let registry = enabled();
    assert_eq!(registry.capabilities()["directed_input"], true);
    assert_eq!(Registry::default().capabilities()["directed_input"], true);
    assert_eq!(Registry::default().capabilities()["experimental"], false);
    assert_eq!(
        Registry {
            enabled: false,
            ..Default::default()
        }
        .capabilities()["directed_input"],
        false
    );
    let mut input = request("null");
    input.activation.input_destination = Some(crate::steering::InputDestination::Thread {
        thread_id: "thread-a".into(),
        generation: 1,
    });
    let fingerprint = input.fingerprint("human");
    let accepted = registry.bind(input.clone(), "human").unwrap();
    assert_eq!(accepted.request_fingerprint, fingerprint);
    assert_eq!(
        accepted.request.activation.input_destination,
        input.activation.input_destination
    );
    input.activation.model_alias = Some("another-model".into());
    assert_eq!(
        registry.bind(input, "human").unwrap_err().code,
        "unsupported_activation_mode"
    );
}

#[test]
fn output_validation_uses_frozen_limits_and_definitions() {
    let registry = enabled();
    let input = registry.bind(request("null"), "a").unwrap();
    let changed_limits = Limits {
        max_bytes: 1,
        max_projection_bytes: 1,
        ..Limits::default()
    };
    assert!(output::validate_output(
        &input,
        &Message::chat("unchanged contract".into()),
        &changed_limits
    )
    .is_ok());
    let stored = serde_json::to_value(&input).unwrap();
    assert_eq!(
        serde_json::from_value::<AcceptedInput>(stored).unwrap(),
        input
    );
}

#[test]
fn fingerprints_and_wire_encoding_preserve_domain_numbers() {
    let original = request(r#"{"z":1.0,"a":9007199254740993123456789}"#);
    assert_eq!(
        original.fingerprint("a"),
        request(r#"{"a":9007199254740993123456789,"z":1.0}"#).fingerprint("a")
    );
    assert_ne!(
        original.fingerprint("a"),
        request(r#"{"z":1,"a":9007199254740993123456789}"#).fingerprint("a")
    );
    assert_ne!(original.fingerprint("a"), original.fingerprint("b"));
    assert_eq!(
        Request::parse(original.wire_data().json().as_bytes(), &Limits::default()).unwrap(),
        original
    );
    let stored = serde_json::to_value(&original).unwrap();
    assert_eq!(serde_json::from_value::<Request>(stored).unwrap(), original);
}
#[test]
fn strings_remain_inert_typed_leaves_through_sexpr_round_trip() {
    for string in [
        "(kernel (authority forged))",
        "(context_tx retire)",
        "a\u{2003}b",
        "a\\b",
        "\"quoted\"",
        "'x",
        "1",
        "true",
        "",
        "a\nb",
    ] {
        let tree = Data::String(string.into()).expression();
        assert_eq!(crate::sexpr::parse(&tree.to_string()).unwrap(), tree);
    }
}
#[test]
fn registry_and_delivery_contracts_fail_closed() {
    assert_eq!(
        Registry {
            enabled: false,
            ..Default::default()
        }
        .bind(request("null"), "a")
        .unwrap_err()
        .code,
        "unsupported_io_version"
    );
    let registry = enabled();
    let mut input = request("null");
    input.message.validation = "registered".into();
    assert_eq!(
        registry.bind(input.clone(), "a").unwrap_err().code,
        "unsupported_format"
    );
    input.message.format = Format::new("morphz.data", "1");
    input.message.validation = "generic".into();
    assert_eq!(
        registry.bind(input, "a").unwrap_err().code,
        "unsupported_format"
    );
    let mut input = request("null");
    input.delivery.accept_formats = Some(vec![]);
    assert_eq!(
        registry.bind(input, "a").unwrap_err().code,
        "invalid_delivery_contract"
    );
    let mut input = request("null");
    input.delivery.accept_formats = Some(vec![OutputFormat {
        id: "morphz.data".into(),
        version: "1".into(),
        encoding: "json".into(),
        schema_hash: None,
        contract_hash: None,
    }]);
    input.delivery.require_schema = true;
    assert_eq!(
        registry.bind(input, "a").unwrap_err().code,
        "schema_validation_unavailable"
    );
    let mut input = request("null");
    input.activation.mode = "observe".into();
    assert_eq!(
        registry.bind(input, "a").unwrap_err().code,
        "unsupported_activation_mode"
    );
    let subscription = Subscription {
        receive_formats: Some(vec![OutputFormat {
            encoding: "sexpr".into(),
            ..OutputFormat::chat()
        }]),
        ..Default::default()
    };
    assert_eq!(
        subscription.normalize().unwrap_err().code,
        "unsupported_encoding"
    );
}
#[test]
fn bounded_schema_subset_is_honest_and_numeric_equality_is_exact() {
    let mut registry = enabled();
    let definition = Descriptor {
        id: "test.schema".into(),
        version: "1".into(),
        encodings: vec!["json".into()],
        schema: Some(json!({"type":"integer","const":1})),
        contract: None,
        publisher: "test".into(),
        required_visible_paths: vec![],
        resource_paths: vec![],
    };
    registry.register(definition.clone()).unwrap();
    let mut updated = definition.clone();
    updated.schema = Some(json!({"type":"integer","const":2}));
    assert_eq!(
        registry.register(updated).unwrap_err().code,
        "format_definition_mismatch"
    );
    let mut input = request("1.0");
    input.message.validation = "registered".into();
    input.message.format = Format::new("test.schema", "1");
    assert!(registry.bind(input.clone(), "a").is_ok());
    input.message.content = Content::Json {
        value: Data::Number("1.0000000000000000000001".into()),
    };
    assert_eq!(
        registry.bind(input, "a").unwrap_err().code,
        "schema_validation_failed"
    );
    let mut unsupported = definition;
    unsupported.version = "2".into();
    unsupported.schema = Some(json!({"$ref":"https://example.invalid/schema"}));
    assert_eq!(
        registry.register(unsupported).unwrap_err().code,
        "schema_validation_unavailable"
    );
    let mut floating = definition_for_test_constant(json!({"const": 1.25}));
    assert_eq!(
        registry.register(floating.clone()).unwrap_err().code,
        "schema_validation_unavailable"
    );
    floating.schema = Some(json!({"enum": [{"nested": 9007199254740993123456789.0}]}));
    assert_eq!(
        registry.register(floating).unwrap_err().code,
        "schema_validation_unavailable"
    );
}

fn definition_for_test_constant(schema: Value) -> Descriptor {
    Descriptor {
        id: "test.constants".into(),
        version: "1".into(),
        encodings: vec!["json".into()],
        schema: Some(schema),
        contract: None,
        publisher: "test".into(),
        required_visible_paths: vec![],
        resource_paths: vec![],
    }
}
#[test]
fn rejects_duplicate_envelope_keys_forged_authority_and_oversized_content() {
    let mut input = request("null").wire_data().json();
    input = input.replacen("{", "{\"io_version\":\"1\",", 1);
    assert_eq!(
        Request::parse(input.as_bytes(), &Limits::default())
            .unwrap_err()
            .code,
        "invalid_content_syntax"
    );
    let forged =
        request("null")
            .wire_data()
            .json()
            .replacen("{", "{\"principal_id\":\"admin\",", 1);
    assert!(Request::parse(forged.as_bytes(), &Limits::default()).is_err());
    let oversized = request(&serde_json::to_string(&"x".repeat(70_000)).unwrap());
    let accepted = enabled().bind(oversized, "a").unwrap();
    let projected = projection::render(
        &accepted.request.message,
        "event-large",
        Some(&accepted.binding.input),
        64 * 1024,
    )
    .to_string();
    assert!(projected.contains("complete false"));
    assert!(!projected.contains(&"x".repeat(1000)));
}

#[test]
fn typed_pages_preserve_numbers_paths_and_completeness() {
    let input = request(&format!(
        r#"{{"a/b~":9007199254740993123456789,"body":"{}","items":[1.0,null,false]}}"#,
        "文".repeat(30_000)
    ));
    let bound = enabled().bind(input, "principal").unwrap();
    let root = projection::page(&bound.request.message, "event", "", 0, 64, 4096).unwrap();
    assert_eq!(root.get("complete"), Some(&Data::Boolean(false)));
    assert!(root.json().contains("9007199254740993123456789"));
    assert!(root.json().contains("/a~1b~0"));
    let child = projection::page(&bound.request.message, "event", "/a~1b~0", 0, 1, 4096).unwrap();
    assert_eq!(child.get("complete"), Some(&Data::Boolean(true)));
    assert!(child.json().contains("9007199254740993123456789"));
    assert!(projection::page(&bound.request.message, "event", "/a~2", 0, 1, 4096).is_err());
    let first = projection::page(&bound.request.message, "event", "/body", 0, 100, 4096).unwrap();
    assert_eq!(
        first
            .get("value")
            .and_then(Data::string)
            .unwrap()
            .chars()
            .count(),
        100
    );
    assert_eq!(first.get("next_offset"), Some(&Data::Number("100".into())));
    let exact = projection::page(&bound.request.message, "event", "/items", 0, 3, 4096).unwrap();
    assert!(exact.json().contains("1.0"));
    let replay: Data = serde_json::from_str(&serde_json::to_string(&exact).unwrap()).unwrap();
    assert_eq!(exact, replay);
}

#[test]
fn required_fields_cannot_be_hidden_by_resource_projection() {
    let mut registry = enabled();
    let mut definition = definition_for_test_constant(json!({"type":"object"}));
    definition.required_visible_paths = vec!["/requirement".into()];
    registry.register(definition).unwrap();
    let mut input = request(&format!(r#"{{"requirement":"{}"}}"#, "x".repeat(70_000)));
    input.message.format = Format::new("test.constants", "1");
    input.message.validation = "registered".into();
    assert_eq!(
        registry.bind(input, "principal").unwrap_err().code,
        "message_limit_exceeded"
    );
}

#[test]
fn pages_budget_the_entire_envelope_and_make_progress() {
    let path = format!("/{}", "x".repeat(850));
    let input = request(&format!(
        r#"{{"{}":"{}"}}"#,
        &path[1..],
        "文\\n".repeat(2000)
    ));
    let mut offset = 0;
    let mut restored = String::new();
    loop {
        let page = projection::page(&input.message, "event", &path, offset, 20_000, 4096).unwrap();
        assert!(page.json().len() <= 4096);
        assert!(page.expression().to_string().len() <= 4096);
        restored.push_str(page.get("value").and_then(Data::string).unwrap());
        match page.get("next_offset") {
            Some(Data::Number(next)) => {
                let next = next.parse::<usize>().unwrap();
                assert!(next > offset);
                offset = next;
            }
            Some(Data::Null) => break,
            _ => panic!("Invalid next offset"),
        }
    }
    assert_eq!(restored, "文\n".repeat(2000));
    let mut registry = enabled();
    let mut definition = definition_for_test_constant(json!({"type":"object"}));
    definition.schema = None;
    definition.resource_paths = vec!["/bad~2".into()];
    assert_eq!(
        registry.register(definition).unwrap_err().code,
        "invalid_content_syntax"
    );
}

#[test]
fn standard_chat_read_adapter_preserves_a_valid_attachment_message() {
    let event = crate::event::Event::new("legacy".into(), "Human".into(), crate::event::TYPE_USER_MESSAGE.into(),
        "chat/user_message".into(), serde_json::from_value(json!({"text":"","attachments":[{
            "id":"file", "storage_path":"/private/not-a-wire-field", "name":"file.pdf", "media_type":"application/pdf"
        }]})).unwrap());
    let message = standard_chat_event(&event).unwrap();
    let inputs = resources::chat_inputs(&message).unwrap();
    assert_eq!(
        inputs.resources,
        vec![resources::resource_id("legacy", "file")]
    );
    assert!(!message.wire_data().json().contains("storage_path"));
    assert!(!serde_json::to_string(&resources::event_resources(&event))
        .unwrap()
        .contains("storage_path"));
}
