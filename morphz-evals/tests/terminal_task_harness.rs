use morphz::harness_package::HarnessPackage;
use morphz::sexpr_eval::EvaluationOwner;

const TERMINAL_TASK_HARNESS_SOURCE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/harnesses/terminal-task.hns"
));
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
fn terminal_task_v0_5_is_a_minimal_model_owned_portable_package() {
    let package =
        HarnessPackage::from_source("terminal-task.hns", TERMINAL_TASK_HARNESS_SOURCE).unwrap();

    assert_eq!(package.manifest.id, "terminal-task");
    assert_eq!(package.manifest.version, "0.5.0");
    assert_eq!(
        package.artifact_hash,
        "sha256:82d9664e6014120d6d1d972e28360859a77123c92e1594d997faa91e25a26320"
    );
    assert_terminal_tools(&package);
    let contract = package.contract.to_string();
    assert!(contract.contains("optional-working-state"));
    assert!(!contract.contains("closure-protocol"));
    assert!(!contract.contains("domain-guards"));
    assert!(package.mind.is_some());
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
        "sha256:6ecfafdac4636b3de67022218eddd399812ae050f749c9f59193097f89440559"
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
        "sha256:b6063a4a970362888f6194fdfa498421b417bb032f4b58bf96e0bf5a0571aae2"
    );
    assert_terminal_tools(&package);
}
