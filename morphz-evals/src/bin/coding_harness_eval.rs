use morphz_evals::coding_harness_eval::{
    create_coding_harness_eval_environment, parse_arm, parse_scenario, run_coding_harness_eval,
    run_coding_harness_suite,
};
use morphz_evals::context_metacognition_eval::{default_morphz_agent_binary, load_model_profiles};
use std::path::Path;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [command, arm, scenario] if command == "create" => {
            let environment = create_coding_harness_eval_environment(
                None,
                parse_arm(arm)?,
                parse_scenario(scenario)?,
            )?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command, arm, scenario, base] if command == "create" => {
            let environment = create_coding_harness_eval_environment(
                Some(Path::new(base)),
                parse_arm(arm)?,
                parse_scenario(scenario)?,
            )?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command, arm, scenario, profiles, base] if command == "run-arm" => {
            let profiles = load_model_profiles(Path::new(profiles))?;
            if profiles.profiles.len() != 1 {
                return Err("run-arm 要求 profile 文件恰好包含一个模型".into());
            }
            let binary = default_morphz_agent_binary()?;
            let run = run_coding_harness_eval(
                Some(Path::new(base)),
                parse_arm(arm)?,
                parse_scenario(scenario)?,
                &binary,
                &profiles.profiles[0],
            )
            .await?;
            println!("{}", serde_json::to_string_pretty(&run)?);
        }
        [command, scenario, profiles, base] if command == "run" => {
            let profiles = load_model_profiles(Path::new(profiles))?;
            if profiles.profiles.len() != 1 {
                return Err("run 要求 profile 文件恰好包含一个模型".into());
            }
            let binary = default_morphz_agent_binary()?;
            let suite = run_coding_harness_suite(
                Some(Path::new(base)),
                parse_scenario(scenario)?,
                &binary,
                &profiles.profiles[0],
            )
            .await?;
            println!("{}", serde_json::to_string_pretty(&suite)?);
        }
        _ => {
            eprintln!(
                "usage:\n  cargo run -p morphz-evals --bin coding_harness_eval -- create ARM SCENARIO [BASE_DIR]\n  cargo run -p morphz-evals --bin coding_harness_eval -- run-arm ARM SCENARIO PROFILES.toml BASE_DIR\n  cargo run -p morphz-evals --bin coding_harness_eval -- run SCENARIO PROFILES.toml BASE_DIR\n\nARM: baseline | harness\nSCENARIO: retry-state-machine | cache-coherence | procedure-adherence"
            );
            std::process::exit(64);
        }
    }
    Ok(())
}
