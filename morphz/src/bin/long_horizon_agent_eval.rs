use morphz::context_metacognition_eval::{default_morphz_agent_binary, load_model_profiles};
use morphz::long_horizon_agent_eval::{
    create_autonomous_transfer_eval, create_epistemic_reality_eval,
    create_operations_continuity_eval, inspect_long_horizon_eval, run_autonomous_transfer_eval,
    run_epistemic_reality_eval, run_operations_continuity_eval,
};
use std::path::Path;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [command] if command == "create" => {
            let environment = create_operations_continuity_eval(None).await?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command, base] if command == "create" => {
            let environment = create_operations_continuity_eval(Some(Path::new(base))).await?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command] if command == "create-transfer" => {
            let environment = create_autonomous_transfer_eval(None).await?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command, base] if command == "create-transfer" => {
            let environment = create_autonomous_transfer_eval(Some(Path::new(base))).await?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command] if command == "create-epistemic" => {
            let environment = create_epistemic_reality_eval(None).await?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command, base] if command == "create-epistemic" => {
            let environment = create_epistemic_reality_eval(Some(Path::new(base))).await?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command, run_root] if command == "inspect" => {
            let report = inspect_long_horizon_eval(Path::new(run_root), None).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !report.success {
                std::process::exit(2);
            }
        }
        [command, profiles, base] if command == "run" => {
            let profiles = load_model_profiles(Path::new(profiles))?;
            if profiles.profiles.len() != 1 {
                return Err("long-horizon run 当前要求 profile 文件恰好包含一个模型".into());
            }
            let binary = default_morphz_agent_binary()?;
            let run = run_operations_continuity_eval(
                Some(Path::new(base)),
                &binary,
                profiles.profiles.first(),
            )
            .await?;
            println!("{}", serde_json::to_string_pretty(&run)?);
            if !run.report.success {
                std::process::exit(2);
            }
        }
        [command, profiles, base] if command == "run-transfer" => {
            let profiles = load_model_profiles(Path::new(profiles))?;
            if profiles.profiles.len() != 1 {
                return Err(
                    "long-horizon run-transfer 当前要求 profile 文件恰好包含一个模型".into(),
                );
            }
            let binary = default_morphz_agent_binary()?;
            let run = run_autonomous_transfer_eval(
                Some(Path::new(base)),
                &binary,
                profiles.profiles.first(),
            )
            .await?;
            println!("{}", serde_json::to_string_pretty(&run)?);
            if !run.report.success {
                std::process::exit(2);
            }
        }
        [command, profiles, base] if command == "run-epistemic" => {
            let profiles = load_model_profiles(Path::new(profiles))?;
            if profiles.profiles.len() != 1 {
                return Err(
                    "long-horizon run-epistemic 当前要求 profile 文件恰好包含一个模型".into(),
                );
            }
            let binary = default_morphz_agent_binary()?;
            let run = run_epistemic_reality_eval(
                Some(Path::new(base)),
                &binary,
                profiles.profiles.first(),
            )
            .await?;
            println!("{}", serde_json::to_string_pretty(&run)?);
            if !run.report.success {
                std::process::exit(2);
            }
        }
        _ => {
            eprintln!(
                "usage:\n  cargo run -p morphz --bin long_horizon_agent_eval -- create [BASE_DIR]\n  cargo run -p morphz --bin long_horizon_agent_eval -- create-transfer [BASE_DIR]\n  cargo run -p morphz --bin long_horizon_agent_eval -- create-epistemic [BASE_DIR]\n  cargo run -p morphz --bin long_horizon_agent_eval -- inspect RUN_ROOT\n  cargo run -p morphz --bin long_horizon_agent_eval -- run PROFILES.toml BASE_DIR\n  cargo run -p morphz --bin long_horizon_agent_eval -- run-transfer PROFILES.toml BASE_DIR\n  cargo run -p morphz --bin long_horizon_agent_eval -- run-epistemic PROFILES.toml BASE_DIR"
            );
            std::process::exit(64);
        }
    }
    Ok(())
}
