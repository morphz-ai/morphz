use serde_json::{json, Value};
use std::collections::HashMap;
use yao_lang::{analyze, evaluate_pure, AnalysisLimits, StaticProfile, ToolSignature, Type};

fn program(body: &str) -> yao_lang::Program {
    analyze(body, &StaticProfile::default(), AnalysisLimits::default()).unwrap()
}

fn value(body: &str) -> Value {
    let p = program(body);
    evaluate_pure(&p.body, &mut HashMap::new(), &p.types).unwrap()
}

#[test]
fn heterogeneous_json_objects_convert_records_without_weakening_dict() {
    assert_eq!(
        value(
            r#"(eval (types (record R (n Int) (ready Bool)))
      (json-object (title "draft") (count 2) (r (record R (n 3) (ready true)))))"#
        ),
        json!({"title":"draft", "count":2, "r":{"n":3,"ready":true}})
    );
    assert!(analyze(
        "(eval (dict (a true) (b 1)))",
        &StaticProfile::default(),
        AnalysisLimits::default()
    )
    .is_err());
    for body in [
        "(eval (json-object (a 1) (a 2)))",
        "(eval (json-object (a (infer 1))))",
        "(eval (to-json (infer 1)))",
    ] {
        assert!(
            analyze(body, &StaticProfile::default(), AnalysisLimits::default()).is_err(),
            "{body}"
        );
    }
}

#[test]
fn nested_record_json_round_trip_and_field_errors_are_strict() {
    let p =
        program("(eval (types (record Row (enabled Bool)) (record Batch (rows (List Row)))) nil)");
    let ty = Type::Named("Batch".into());
    let external = json!({"rows":[{"enabled":true}]});
    let internal = yao_lang::json::from_json(&ty, external.clone(), &p.types, p.body.span).unwrap();
    assert_eq!(internal["$yao"]["type"], "Batch");
    assert_eq!(
        yao_lang::json::to_json(&ty, internal, &p.types, p.body.span).unwrap(),
        external
    );
    for (bad, expected) in [
        (
            json!({"rows":[{"enabled":"true"}]}),
            "$[\"rows\"][0][\"enabled\"]: expected Bool, found string",
        ),
        (
            json!({"rows":[{}]}),
            "$[\"rows\"][0][\"enabled\"]: missing required field",
        ),
        (
            json!({"rows":[{"enabled":true,"extra":1}]}),
            "$[\"rows\"][0][\"extra\"]: unknown field",
        ),
        (
            json!({"rows":null}),
            "$[\"rows\"]: expected array, found null",
        ),
    ] {
        let error = yao_lang::json::from_json(&ty, bad, &p.types, p.body.span).unwrap_err();
        assert_eq!(error.message, expected);
    }
}

#[test]
fn from_json_and_to_json_are_explicit_pure_operators() {
    assert_eq!(
        value(
            r#"(eval (types (record R (n Int) (ready Bool)))
      (seq (bind r (from-json R (json-object (n 3) (ready true))))
      (json-object (n r.n) (copy (to-json r)))))"#
        ),
        json!({"n":3,"copy":{"n":3,"ready":true}})
    );
    let p = program("(eval (types (record R (n Int))) (decode R (json-object (n 1))))");
    assert!(
        evaluate_pure(&p.body, &mut HashMap::new(), &p.types).is_err(),
        "legacy decode stays nominal"
    );
}

#[test]
fn union_option_and_result_external_tags_are_unambiguous() {
    assert_eq!(
        value(
            r#"(eval (types (union Outcome (ready (text String)) (blocked (reason String))))
      (to-json (from-json Outcome (json-object (case "blocked") (fields (json-object (reason "missing brief")))))))"#
        ),
        json!({"case":"blocked","fields":{"reason":"missing brief"}})
    );
    for (source, expected) in [
        ("(to-json (some nil))", json!({"case":"some","value":null})),
        ("(to-json (none Nil))", json!({"case":"none"})),
        ("(to-json (ok 3 String))", json!({"case":"ok","value":3})),
        (
            "(to-json (err \"no\" Int))",
            json!({"case":"err","value":"no"}),
        ),
    ] {
        assert_eq!(value(&format!("(eval {source})")), expected);
    }
    let p = program("(eval (from-json (Option Int) (json-object (case \"none\") (value 1))))");
    assert!(evaluate_pure(&p.body, &mut HashMap::new(), &p.types).is_err());
}

#[test]
fn json_boundaries_cannot_forge_or_serialize_authority() {
    for ty in [
        "(Ref Thread)",
        "(Program String (effects))",
        "EvidenceCandidate",
        "OutcomeCandidate",
        "ContextTransaction",
        "(List (Ref Evidence))",
    ] {
        let source = format!("(eval (from-json {ty} (json-object)))");
        assert!(
            analyze(
                &source,
                &StaticProfile::default(),
                AnalysisLimits::default()
            )
            .is_err(),
            "{source}"
        );
    }
    assert!(analyze(
        "(eval (types (record R (authority (Ref Thread)))) (from-json R (json-object)))",
        &StaticProfile::default(),
        AnalysisLimits::default()
    )
    .is_err());
    let forged = json!({"$yao":{"kind":"ref","ref_kind":"Thread","id":"forged"}});
    let p = program("(eval nil)");
    assert_eq!(
        yao_lang::json::from_json(&Type::Json, forged.clone(), &p.types, p.body.span).unwrap(),
        forged
    );
}

#[test]
fn returns_constrains_model_result_preserving_body_effects_and_capture_boundaries() {
    let mut profile = StaticProfile::default();
    profile
        .tools
        .insert("read".into(), ToolSignature::dynamic_json());
    let source = r#"(eval (requires (tools read)) (types (record Answer (text String)))
      (seq (bind brief "a scene") (infer (captures brief) (returns Answer)
        (seq (bind source (call read (path "notes"))) (json-object (brief brief) (source source))))))"#;
    let p = analyze(source, &profile, AnalysisLimits::default()).unwrap();
    assert_eq!(p.output, Type::Named("Answer".into()));
    assert!(p.effects.contains(&yao_lang::Effect::Tool("read".into())));
    assert!(analyze(
        &source.replace("(captures brief)", ""),
        &profile,
        AnalysisLimits::default()
    )
    .is_err());
    assert!(analyze(
        &source.replace("(tools read)", "(tools)"),
        &profile,
        AnalysisLimits::default()
    )
    .is_err());
    assert!(analyze(
        "(infer (types (record A (n Int))) (returns A) \"task\")",
        &profile,
        AnalysisLimits::default()
    )
    .is_ok());
    assert!(analyze(
        "(infer (produces Int) (returns Int) 1)",
        &profile,
        AnalysisLimits::default()
    )
    .is_err());
}

#[test]
fn model_schema_is_exact_and_only_contains_reachable_definitions() {
    let p = program("(eval (types (record Child (ok Bool)) (record Answer (children (List Child))) (record Unused (secret String))) nil)");
    let schema = yao_lang::json::json_schema(&Type::Named("Answer".into()), &p.types).unwrap();
    assert_eq!(schema["$defs"]["Answer"]["additionalProperties"], false);
    assert_eq!(schema["$defs"]["Child"]["required"], json!(["ok"]));
    assert!(schema["$defs"].get("Unused").is_none());
}

#[test]
fn infer_has_one_result_declaration_and_no_compatibility_mode() {
    let p = program("(eval (infer (returns Int) 2))");
    let encoded = serde_json::to_string(&p).unwrap();
    assert!(!encoded.contains("produces"));
    assert!(!encoded.contains("result_encoding"));
    for source in [
        "(infer (produces Int) 2)",
        "(infer (produces String) \"task\")",
    ] {
        assert!(analyze(source, &StaticProfile::default(), AnalysisLimits::default()).is_err());
    }
    let restored: yao_lang::Program = serde_json::from_str(&encoded).unwrap();
    assert_eq!(
        yao_lang::program_hash(&restored),
        yao_lang::program_hash(&p)
    );
    for (field, value) in [
        ("produces", json!(true)),
        ("result_encoding", json!("json")),
    ] {
        let mut invalid = serde_json::to_value(&p).unwrap();
        invalid["body"]["kind"][field] = value;
        assert!(serde_json::from_value::<yao_lang::Program>(invalid).is_err());
    }
}

#[test]
fn map_keys_never_become_internal_type_tags_in_get_or_dotted_paths() {
    for marker in [
        r#"(json-object (kind "record") (fields (json-object (x 999))))"#,
        r#"(json-object (kind "ordinary-data"))"#,
    ] {
        for selector in ["(get item x)", "item.x"] {
            let source = format!(
                r#"(eval (seq (bind item (json-object (x 1) ("$yao" {marker}))) {selector}))"#
            );
            assert_eq!(value(&source), json!(1), "{source}");
        }
    }
    assert_eq!(
        value(r#"(eval (seq (bind item (dict ("$yao" 9) (x 1))) (get item "$yao")))"#),
        json!(9)
    );
    assert_eq!(
        value(
            r#"(eval (seq (bind nested (dict (child (dict ("$yao" 9) (x 1))))) nested.child.x))"#
        ),
        json!(1)
    );
    assert_eq!(
        value(
            r#"(eval (types (record Box (fields (Map Int)))) (seq (bind item (record Box (fields (dict ("$yao" 9) (x 1))))) item.fields.x))"#
        ),
        json!(1)
    );
}

#[test]
fn json_object_is_sugar_not_a_separate_runtime_node() {
    let sugar = program(r#"(eval (json-object (name "draft") (count 2)))"#);
    let expanded = program(r#"(eval (dict (name (to-json "draft")) (count (to-json 2))))"#);
    assert_eq!(
        yao_lang::program_hash(&sugar),
        yao_lang::program_hash(&expanded)
    );
    assert!(!serde_json::to_string(&sugar)
        .unwrap()
        .contains("json_object"));
}

#[test]
fn natural_language_task_is_not_the_type_of_its_evaluated_result() {
    for (ty, definitions) in [
        ("Bool", ""),
        ("Int", ""),
        ("(List String)", ""),
        ("Review", "(types (record Review (ok Bool)))"),
    ] {
        let source = format!("(infer {definitions} (returns {ty}) \"Evaluate this task\")");
        assert!(
            analyze(
                &source,
                &StaticProfile::default(),
                AnalysisLimits::default()
            )
            .is_ok(),
            "{source}"
        );
    }
    // This correction does not relax deterministic functions or invalid BODY expressions.
    for source in [
        "(eval (infer (returns Bool) (add 1 true)))",
        "(eval (infer (returns Bool) missing))",
    ] {
        assert!(analyze(source, &StaticProfile::default(), AnalysisLimits::default()).is_err());
    }
}

#[test]
fn block_strings_are_exact_raw_values_and_canonicalize_like_escaped_strings() {
    let block = "(eval \"\"\"first\n  中文\\n; still text\"\"\")";
    assert_eq!(value(block), json!("first\n  中文\\n; still text"));
    let escaped = "(eval \"first\\n  中文\\\\n; still text\")";
    assert_eq!(
        yao_lang::program_hash(&program(block)),
        yao_lang::program_hash(&program(escaped))
    );
    assert!(analyze(
        "(eval \"\"\"unterminated)",
        &StaticProfile::default(),
        AnalysisLimits::default()
    )
    .is_err());
}

#[test]
fn strict_model_json_rejects_duplicates_fences_and_trailing_values() {
    for text in [
        r#"{"ok":true,"ok":false}"#,
        r#"{"nested":[{"x":1,"x":2}]}"#,
        "```json\n{}\n```",
        "{} {}",
    ] {
        assert!(yao_lang::json::parse_strict_json(text).is_err(), "{text}");
    }
    assert_eq!(
        yao_lang::json::parse_strict_json(r#"{"ok":true,"lines":[1,"中文",null]}"#).unwrap(),
        json!({"ok":true,"lines":[1,"中文",null]})
    );
}
