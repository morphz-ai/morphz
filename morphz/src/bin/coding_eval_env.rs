use morphz::config::BackgroundTaskConfig;
use morphz::eval_sandbox::{
    audit_coding_eval, create_coding_eval_v1, create_coding_eval_v2,
    prepare_verification_workspace, record_verification, score_coding_eval, CodingEvalManifest,
};
use morphz::event::InMemoryEventBus;
use morphz::permission::{PermissionConfig, PermissionMode};
use morphz::tool::{ExecuteCommandTool, Tool};
use std::path::Path;
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [command] if command == "create" => {
            let environment = create_coding_eval_v1(None)?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command, version] if command == "create" && version == "v1" => {
            let environment = create_coding_eval_v1(None)?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command, version] if command == "create" && version == "v2" => {
            let environment = create_coding_eval_v2(None)?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command, version, base] if command == "create" && version == "v1" => {
            let environment = create_coding_eval_v1(Some(Path::new(base)))?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command, version, base] if command == "create" && version == "v2" => {
            let environment = create_coding_eval_v2(Some(Path::new(base)))?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command, base] if command == "create" => {
            let environment = create_coding_eval_v1(Some(Path::new(base)))?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command, run_root] if command == "audit" => {
            let report = audit_coding_eval(Path::new(run_root))?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !report.clean_scope {
                std::process::exit(2);
            }
        }
        [command, run_root] if command == "score" => {
            let report = score_coding_eval(Path::new(run_root)).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        [command, run_root] if command == "verify" => {
            let manifest = load_manifest(run_root)?;
            let verification_workspace =
                prepare_verification_workspace(Path::new(run_root), &manifest)?;
            let tool = seatbelt_tool(&manifest, &verification_workspace);
            let result = tool
                .execute(
                    &serde_json::json!({
                        "command": manifest.verify_command,
                        "cwd": ".",
                        "wait_ms": 120_000
                    })
                    .to_string(),
                )
                .await?;
            let success = result.contains("退出码: 0");
            record_verification(Path::new(run_root), &manifest, success, result.clone())?;
            println!("{result}");
            if !success {
                std::process::exit(1);
            }
        }
        [command, run_root] if command == "probe" => {
            let manifest = load_manifest(run_root)?;
            let tool = seatbelt_tool(&manifest, &manifest.workspace_root);
            let result = tool
                .execute(
                    &serde_json::json!({
                        "command": "if cat ../manifest.json >/dev/null 2>&1; then exit 90; fi; if touch ../escape-probe >/dev/null 2>&1; then exit 91; fi; exit 0",
                        "cwd": ".",
                        "wait_ms": 10_000
                    })
                    .to_string(),
                )
                .await?;
            println!("{result}");
            if !result.contains("退出码: 0") {
                std::process::exit(1);
            }
        }
        _ => {
            eprintln!(
                "usage:\n  cargo run -p morphz --bin coding_eval_env -- create [v1|v2] [BASE_DIR]\n  cargo run -p morphz --bin coding_eval_env -- probe RUN_ROOT\n  cargo run -p morphz --bin coding_eval_env -- verify RUN_ROOT\n  cargo run -p morphz --bin coding_eval_env -- audit RUN_ROOT\n  cargo run -p morphz --bin coding_eval_env -- score RUN_ROOT"
            );
            std::process::exit(64);
        }
    }
    Ok(())
}

fn load_manifest(
    run_root: impl AsRef<Path>,
) -> Result<CodingEvalManifest, Box<dyn std::error::Error + Send + Sync>> {
    let run_root = std::fs::canonicalize(run_root)?;
    Ok(serde_json::from_slice(&std::fs::read(
        run_root.join("manifest.json"),
    )?)?)
}

fn seatbelt_tool(manifest: &CodingEvalManifest, workspace_root: &Path) -> ExecuteCommandTool {
    let permissions = Arc::new(PermissionConfig {
        mode: PermissionMode::AutoReview,
        workspace_root: workspace_root.to_string_lossy().to_string(),
        read_roots: Vec::new(),
        write_roots: Vec::new(),
        network: false,
        ..Default::default()
    });
    let background = Arc::new(BackgroundTaskConfig {
        artifact_dir: manifest.artifact_dir.to_string_lossy().to_string(),
        ..Default::default()
    });
    ExecuteCommandTool::new_with_configs(
        Arc::new(InMemoryEventBus::new()),
        background,
        permissions,
        120,
    )
}
