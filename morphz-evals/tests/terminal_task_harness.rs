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
    assert_eq!(package.manifest.version, "0.4.0");
    assert_eq!(
        package.artifact_hash,
        "sha256:b6063a4a970362888f6194fdfa498421b417bb032f4b58bf96e0bf5a0571aae2"
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
    assert!(package.contract.to_string().contains("acceptance-ledger"));
    assert!(package.contract.to_string().contains("candidate universe"));
    assert!(package.contract.to_string().contains("executable evidence"));
    assert!(package.contract.to_string().contains("convergence-contract"));
    assert!(package.contract.to_string().contains("closure-protocol"));
    assert!(package
        .contract
        .to_string()
        .contains("best valid checkpoint"));
    assert!(package
        .contract
        .to_string()
        .contains("proof-to-final"));
    assert!(package
        .contract
        .to_string()
        .contains("return immediately"));
    assert!(package
        .contract
        .to_string()
        .contains("completed-with-limitations"));
    assert!(package
        .contract
        .to_string()
        .contains("decision-relevant evidence"));
    assert!(package.mind.is_some());
    assert!(!TERMINAL_TASK_HARNESS_SOURCE.contains("dna-assembly"));
    assert!(!TERMINAL_TASK_HARNESS_SOURCE.contains("pypi-server"));
    assert!(!TERMINAL_TASK_HARNESS_SOURCE.contains("mteb-leaderboard"));
}
