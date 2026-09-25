use serde_json::{json, Value};
use std::collections::HashMap;
use yao_lang::{analyze, evaluate_pure, program_hash, AnalysisLimits, Program, StaticProfile};

// Frozen output from the unmodified Yao compiler in v0.1.2
// (6e45724285e4276406ac0d4b7f8e4f3001c77dfb). Do not regenerate with the current compiler:
// same-version round trips cannot detect a persisted-IR upgrade regression.
#[test]
fn v012_artifacts_preserve_admitted_identity_and_correct_reference_semantics() {
    let fixtures: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/v0.1.2-programs.json")).unwrap();
    for fixture in fixtures {
        let program: Program = serde_json::from_value(fixture["program"].clone()).unwrap();
        assert_eq!(serde_json::to_value(&program).unwrap(), fixture["program"]);
        assert_eq!(program_hash(&program), program.source_hash);
        if program.effects.is_empty() {
            assert_eq!(
                evaluate_pure(&program.body, &mut HashMap::new(), &program.types).unwrap(),
                json!(42),
                "{}",
                fixture["name"]
            );
        }
    }
}

#[test]
fn newly_compiled_references_do_not_emit_legacy_paths() {
    let program = analyze(
        "(eval (types (record Box (n Int))) (seq (bind x (record Box (n 42))) x.n))",
        &StaticProfile::default(),
        AnalysisLimits::default(),
    )
    .unwrap();
    let encoded = serde_json::to_string(&program).unwrap();
    assert!(!encoded.contains("\"path\":"));
    assert!(encoded.contains("\"op\":\"get\""));
    assert_eq!(program_hash(&program), program.source_hash);
}
