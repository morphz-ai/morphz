use morphz::context_metacognition_eval::{
    compare_metacognition_evals, create_metacognition_eval, inspect_metacognition_eval,
};
use std::path::Path;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [command] if command == "create" => {
            let environment = create_metacognition_eval(None).await?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command, base] if command == "create" => {
            let environment = create_metacognition_eval(Some(Path::new(base))).await?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command, run_root] if command == "inspect" => {
            let report = inspect_metacognition_eval(Path::new(run_root)).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !report.success {
                std::process::exit(2);
            }
        }
        [command, baseline, candidate] if command == "compare" => {
            let report =
                compare_metacognition_evals(Path::new(baseline), Path::new(candidate)).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        _ => {
            eprintln!(
                "usage:\n  cargo run -p morphz --bin context_metacognition_eval -- create [BASE_DIR]\n  cargo run -p morphz --bin context_metacognition_eval -- inspect RUN_ROOT\n  cargo run -p morphz --bin context_metacognition_eval -- compare BASELINE_RUN CANDIDATE_RUN"
            );
            std::process::exit(64);
        }
    }
    Ok(())
}
