use morphz_evals::context_metacognition_eval::{
    compare_metacognition_evals, compare_metacognition_suites, create_metacognition_eval,
    default_morphz_agent_binary, inspect_metacognition_eval, run_metacognition_eval,
    run_metacognition_model_matrix, run_metacognition_suite,
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
        [command] if command == "run" => {
            let binary = default_morphz_agent_binary()?;
            let report = run_metacognition_eval(None, &binary).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        [command, base] if command == "run" => {
            let binary = default_morphz_agent_binary()?;
            let report = run_metacognition_eval(Some(Path::new(base)), &binary).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        [command] if command == "suite" => {
            let binary = default_morphz_agent_binary()?;
            let report = run_metacognition_suite(None, 5, &binary).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        [command, base] if command == "suite" => {
            let binary = default_morphz_agent_binary()?;
            let report = run_metacognition_suite(Some(Path::new(base)), 5, &binary).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        [command, base, runs] if command == "suite" => {
            let runs = runs.parse::<usize>()?;
            let binary = default_morphz_agent_binary()?;
            let report = run_metacognition_suite(Some(Path::new(base)), runs, &binary).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        [command, baseline, candidate] if command == "compare-suites" => {
            let report = compare_metacognition_suites(Path::new(baseline), Path::new(candidate))?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        [command, profiles, base] if command == "model-matrix" => {
            let binary = default_morphz_agent_binary()?;
            let report = run_metacognition_model_matrix(
                Path::new(profiles),
                Some(Path::new(base)),
                5,
                &binary,
            )
            .await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        [command, profiles, base, runs] if command == "model-matrix" => {
            let binary = default_morphz_agent_binary()?;
            let report = run_metacognition_model_matrix(
                Path::new(profiles),
                Some(Path::new(base)),
                runs.parse::<usize>()?,
                &binary,
            )
            .await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        _ => {
            eprintln!(
                "usage:\n  cargo run -p morphz --bin context_metacognition_eval -- create [BASE_DIR]\n  cargo run -p morphz --bin context_metacognition_eval -- inspect RUN_ROOT\n  cargo run -p morphz --bin context_metacognition_eval -- compare BASELINE_RUN CANDIDATE_RUN\n  cargo run -p morphz --bin context_metacognition_eval -- run [BASE_DIR]\n  cargo run -p morphz --bin context_metacognition_eval -- suite [BASE_DIR] [RUNS]\n  cargo run -p morphz --bin context_metacognition_eval -- compare-suites BASELINE_SUITE CANDIDATE_SUITE\n  cargo run -p morphz --bin context_metacognition_eval -- model-matrix PROFILES.toml BASE_DIR [RUNS_PER_MODEL]"
            );
            std::process::exit(64);
        }
    }
    Ok(())
}
