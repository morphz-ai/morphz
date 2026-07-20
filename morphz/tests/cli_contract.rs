use std::process::{Command, Output};

fn morphz(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_morphz"))
        .args(args)
        .output()
        .expect("morphz CLI should start")
}
#[test]
fn root_help_is_successful_and_side_effect_free() {
    let output = morphz(&["--help"]);
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("Usage: morphz"));
    assert!(stdout.contains("Text entered without a subcommand"));
    assert!(output.stderr.is_empty());
}

#[test]
fn nested_help_is_specific_to_its_subcommand() {
    let output = morphz(&["session", "create", "--help"]);
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("Usage: morphz session create"));
    assert!(stdout.contains("--independent"));
    assert!(stdout.contains("Create a Session mounted"));
    assert!(!stdout.contains("Manage long-lived Objectives"));
    assert!(output.stderr.is_empty());

    let help_command = morphz(&["help", "session", "create"]);
    assert!(
        help_command.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&help_command.stderr)
    );
    assert!(String::from_utf8(help_command.stdout)
        .unwrap()
        .contains("Usage: morphz session create"));
}

#[test]
fn command_typos_use_the_standard_argument_error_exit_code() {
    let output = morphz(&["sessoin", "list"]);
    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("unrecognized subcommand 'sessoin'"));
    assert!(stderr.contains("similar subcommand exists: 'session'"));
}

#[test]
fn version_and_completion_do_not_initialize_the_runtime() {
    let version = morphz(&["--version"]);
    assert!(version.status.success());
    let stdout = String::from_utf8(version.stdout).unwrap();
    assert_eq!(
        stdout.trim(),
        format!("morphz {}", morphz::build_info::VERSION)
    );
    assert!(stdout.contains(morphz::build_info::GIT_COMMIT));
    assert!(version.stderr.is_empty());

    let version_subcommand = morphz(&["version"]);
    assert!(version_subcommand.status.success());
    assert_eq!(
        String::from_utf8(version_subcommand.stdout).unwrap(),
        stdout
    );
    assert!(version_subcommand.stderr.is_empty());

    let completion = morphz(&["completion", "zsh"]);
    assert!(
        completion.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&completion.stderr)
    );
    let stdout = String::from_utf8(completion.stdout).unwrap();
    assert!(stdout.contains("_morphz"));
    assert!(completion.stderr.is_empty());
}
