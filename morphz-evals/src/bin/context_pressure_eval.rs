use morphz_evals::context_pressure_eval::{
    create_context_pressure_eval, create_frame_consolidation_eval, create_frame_value_eval,
    inspect_context_pressure_eval,
};
use std::path::Path;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [command] if command == "create" => {
            let environment = create_context_pressure_eval(None).await?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command, base] if command == "create" => {
            let environment = create_context_pressure_eval(Some(Path::new(base))).await?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command] if command == "create-frame-value" => {
            let environment = create_frame_value_eval(None).await?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command, base] if command == "create-frame-value" => {
            let environment = create_frame_value_eval(Some(Path::new(base))).await?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command] if command == "create-frame-consolidation" => {
            let environment = create_frame_consolidation_eval(None).await?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command, base] if command == "create-frame-consolidation" => {
            let environment = create_frame_consolidation_eval(Some(Path::new(base))).await?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command, run_root] if command == "inspect" => {
            let report = inspect_context_pressure_eval(Path::new(run_root)).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !report.success {
                std::process::exit(2);
            }
        }
        _ => {
            eprintln!(
                "usage:\n  cargo run -p morphz-evals --bin context_pressure_eval -- create [BASE_DIR]\n  cargo run -p morphz-evals --bin context_pressure_eval -- create-frame-value [BASE_DIR]\n  cargo run -p morphz-evals --bin context_pressure_eval -- create-frame-consolidation [BASE_DIR]\n  cargo run -p morphz-evals --bin context_pressure_eval -- inspect RUN_ROOT"
            );
            std::process::exit(64);
        }
    }
    Ok(())
}
