use morphz::harness_package::HarnessPackage;
use morphz::sexpr_eval::EvaluationOwner;

const TERMINAL_TASK_HARNESS_SOURCE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/harnesses/terminal-task.hns"
));

#[test]
fn terminal_task_harness_is_a_model_owned_portable_package() {
    let package =
        HarnessPackage::from_source("terminal-task.hns", TERMINAL_TASK_HARNESS_SOURCE).unwrap();

    assert_eq!(package.manifest.id, "terminal-task");
    assert_eq!(package.manifest.version, "0.1.0");
    assert_eq!(
        package.artifact_hash,
        "sha256:1d996a61459b7ffe3567f0d33fb5f8bf4a24d8d3c3fb8bd881a62ddb35a92741"
    );
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
    assert!(package.contract.to_string().contains("final-readiness"));
    assert!(package
        .contract
        .to_string()
        .contains("minimum-complete-outcome"));
    assert!(package.mind.is_some());
    assert!(!TERMINAL_TASK_HARNESS_SOURCE.contains("dna-assembly"));
    assert!(!TERMINAL_TASK_HARNESS_SOURCE.contains("pypi-server"));
    assert!(!TERMINAL_TASK_HARNESS_SOURCE.contains("mteb-leaderboard"));
}
