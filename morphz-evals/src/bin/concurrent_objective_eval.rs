use morphz_evals::concurrent_objective_eval::{
    create_forgedepot_eval_with_arm, inspect_forgedepot_eval, run_forgedepot_eval_with_arm,
    SchedulingArm,
};
use morphz_evals::context_metacognition_eval::{default_morphz_agent_binary, load_model_profiles};
use std::path::Path;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if let Some(path) = morphz::config::host_env_path() {
        match morphz::config::load_env(path.to_string_lossy().as_ref()) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [command] if command == "create" => {
            let environment =
                create_forgedepot_eval_with_arm(None, SchedulingArm::Autonomous).await?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command, base] if command == "create" => {
            let environment =
                create_forgedepot_eval_with_arm(Some(Path::new(base)), SchedulingArm::Autonomous)
                    .await?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command, arm, base] if command == "create" => {
            let environment =
                create_forgedepot_eval_with_arm(Some(Path::new(base)), parse_arm(arm)?).await?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command, run_root] if command == "inspect" => {
            let report = inspect_forgedepot_eval(Path::new(run_root), None).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !report.success {
                std::process::exit(2);
            }
        }
        [command, profiles, base] if command == "run" => {
            run(profiles, base, SchedulingArm::Autonomous).await?;
        }
        [command, arm, profiles, base] if command == "run" => {
            run(profiles, base, parse_arm(arm)?).await?;
        }
        _ => {
            eprintln!(
                "usage:\n  cargo run -p morphz-evals --bin concurrent_objective_eval -- create [autonomous|objective_guided] [BASE_DIR]\n  cargo run -p morphz-evals --bin concurrent_objective_eval -- inspect RUN_ROOT\n  cargo run -p morphz-evals --bin concurrent_objective_eval -- run [autonomous|objective_guided] PROFILES.toml BASE_DIR"
            );
            std::process::exit(64);
        }
    }
    Ok(())
}

fn parse_arm(value: &str) -> Result<SchedulingArm, Box<dyn std::error::Error + Send + Sync>> {
    match value {
        "autonomous" => Ok(SchedulingArm::Autonomous),
        "objective_guided" | "objective-guided" => Ok(SchedulingArm::ObjectiveGuided),
        _ => Err(format!("unknown scheduling arm: {value}").into()),
    }
}

async fn run(
    profiles_path: &str,
    base: &str,
    arm: SchedulingArm,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let profiles = load_model_profiles(Path::new(profiles_path))?;
    if profiles.profiles.len() != 1 {
        return Err("concurrent-objective run 要求 profile 文件恰好包含一个模型".into());
    }
    let binary = default_morphz_agent_binary()?;
    let run = run_forgedepot_eval_with_arm(
        Some(Path::new(base)),
        &binary,
        profiles.profiles.first(),
        arm,
    )
    .await?;
    println!("{}", serde_json::to_string_pretty(&run)?);
    if !run.report.success {
        std::process::exit(2);
    }
    Ok(())
}
