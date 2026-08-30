use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

const COMMIT_OVERRIDE: &str = "MORPHZ_BUILD_GIT_COMMIT";

fn main() {
    println!("cargo:rerun-if-env-changed={COMMIT_OVERRIDE}");
    register_git_inputs();
    configure_sqlite_hotbundle_link();

    let commit = env::var(COMMIT_OVERRIDE)
        .ok()
        .and_then(normalize_commit)
        .or_else(|| git_output(&["rev-parse", "--short=12", "HEAD"]).and_then(normalize_commit))
        .unwrap_or_else(|| "unknown".to_string());

    println!("cargo:rustc-env=MORPHZ_GIT_COMMIT={commit}");
}

fn configure_sqlite_hotbundle_link() {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();

    // SQLx 0.8.6 bundles SQLite 3.46.0 while Morphz deliberately hot-bundles
    // a current amalgamation containing the WAL-reset fix. Both archives expose
    // the same C ABI; retain the first archive (hotbundle) instead of rejecting
    // the intentional duplicate definitions at the final product link.
    match (target_os.as_str(), target_env.as_str()) {
        ("linux", _) => println!("cargo:rustc-link-arg=-Wl,--allow-multiple-definition"),
        ("windows", "msvc") => println!("cargo:rustc-link-arg=/FORCE:MULTIPLE"),
        _ => {}
    }
}

fn normalize_commit(value: String) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
    {
        return None;
    }
    Some(value.to_string())
}

fn git_output(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn register_git_inputs() {
    let Some(head_path) = git_output(&["rev-parse", "--git-path", "HEAD"]) else {
        return;
    };
    register_path(&head_path);

    let Some(reference) = git_output(&["symbolic-ref", "--quiet", "HEAD"]) else {
        return;
    };
    if let Some(reference_path) = git_output(&["rev-parse", "--git-path", &reference]) {
        register_path(&reference_path);
    }
}

fn register_path(path: &str) {
    let path = Path::new(path);
    let absolute = if path.is_absolute() {
        PathBuf::from(path)
    } else {
        env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    println!("cargo:rerun-if-changed={}", absolute.display());
}
