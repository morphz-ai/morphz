use morphz::context_long_run_eval::{
    advance_context_long_run_eval, create_context_long_run_eval, inspect_context_long_run_eval,
    snapshot_context_long_run_eval,
};
use std::path::Path;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [command] if command == "create" => {
            let environment = create_context_long_run_eval(None).await?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command, base] if command == "create" => {
            let environment = create_context_long_run_eval(Some(Path::new(base))).await?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command, run_root] if command == "advance" => {
            let advance = advance_context_long_run_eval(Path::new(run_root)).await?;
            println!("{}", serde_json::to_string_pretty(&advance)?);
        }
        [command, run_root, label] if command == "snapshot" => {
            let snapshot = snapshot_context_long_run_eval(Path::new(run_root), label).await?;
            println!("{}", serde_json::to_string_pretty(&snapshot)?);
        }
        [command, run_root] if command == "inspect" => {
            let report = inspect_context_long_run_eval(Path::new(run_root)).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !report.success {
                std::process::exit(2);
            }
        }
        _ => {
            eprintln!(
                "usage:\n  cargo run -p morphz --bin context_long_run_eval -- create [BASE_DIR]\n  cargo run -p morphz --bin context_long_run_eval -- advance RUN_ROOT\n  cargo run -p morphz --bin context_long_run_eval -- snapshot RUN_ROOT LABEL\n  cargo run -p morphz --bin context_long_run_eval -- inspect RUN_ROOT"
            );
            std::process::exit(64);
        }
    }
    Ok(())
}
