use morphz::harness_package::HarnessPackage;
use morphz::sexpr_eval::EvaluationOwner;

const DIALECTICAL_PRACTICE_HARNESS_SOURCE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/harnesses/terminal-task-dialectical-practice.hns"
));
const TERMINAL_TASK_V0_4_SOURCE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/harnesses/terminal-task-v0.4.0.hns"
));

fn assert_terminal_tools(package: &HarnessPackage) {
    assert_eq!(package.entry.owner, EvaluationOwner::Model);
    assert_eq!(
        package.manifest.tools,
        [
            "list_files",
            "search",
            "read",
            "write",
            "edit",
            "exec",
            "context_tx",
        ]
    );
}

#[test]
fn dialectical_practice_harness_is_a_separate_model_owned_package() {
    let package = HarnessPackage::from_source(
        "terminal-task-dialectical-practice.hns",
        DIALECTICAL_PRACTICE_HARNESS_SOURCE,
    )
    .unwrap();

    assert_eq!(package.manifest.id, "terminal-task-dialectical-practice");
    assert_eq!(package.manifest.version, "0.1.0");
    assert_eq!(
        package.artifact_hash,
        "sha256:832b0ad09484048beb300c828e82a0e3ea5b5b1deb966f09ab268dd85fd934e1"
    );
    assert_terminal_tools(&package);
    assert!(DIALECTICAL_PRACTICE_HARNESS_SOURCE.contains("concrete situation"));
    assert!(DIALECTICAL_PRACTICE_HARNESS_SOURCE.contains("practice"));
}

#[test]
fn closed_v0_4_package_remains_parseable_as_historical_evidence() {
    let package =
        HarnessPackage::from_source("terminal-task-v0.4.0.hns", TERMINAL_TASK_V0_4_SOURCE).unwrap();

    assert_eq!(package.manifest.id, "terminal-task");
    assert_eq!(package.manifest.version, "0.4.0");
    assert_eq!(
        package.artifact_hash,
        "sha256:eed08a74c3d5ec48270f9488b55a47a24c30ed34d022294351b56791aa8c3bf6"
    );
    assert_terminal_tools(&package);
}
