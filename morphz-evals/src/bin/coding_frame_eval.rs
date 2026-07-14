use morphz_evals::coding_frame_eval::{
    create_coding_frame_eval_environment, parse_arm, run_coding_frame_eval, run_coding_frame_suite,
};
use morphz_evals::context_metacognition_eval::{default_morphz_agent_binary, load_model_profiles};
use std::path::Path;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [command, arm] if command == "create" => {
            let environment = create_coding_frame_eval_environment(None, parse_arm(arm)?).await?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command, arm, base] if command == "create" => {
            let environment =
                create_coding_frame_eval_environment(Some(Path::new(base)), parse_arm(arm)?)
                    .await?;
            println!("{}", serde_json::to_string_pretty(&environment)?);
        }
        [command, arm, profiles, base] if command == "run-arm" => {
            let profiles = load_model_profiles(Path::new(profiles))?;
            if profiles.profiles.len() != 1 {
                return Err("run-arm 要求 profile 文件恰好包含一个模型".into());
            }
            let binary = default_morphz_agent_binary()?;
            let run = run_coding_frame_eval(
                Some(Path::new(base)),
                parse_arm(arm)?,
                &binary,
                &profiles.profiles[0],
            )
            .await?;
            println!("{}", serde_json::to_string_pretty(&run)?);
        }
        [command, profiles, base] if command == "run" => {
            let profiles = load_model_profiles(Path::new(profiles))?;
            if profiles.profiles.len() != 1 {
                return Err("run 要求 profile 文件恰好包含一个模型".into());
            }
            let binary = default_morphz_agent_binary()?;
            let suite =
                run_coding_frame_suite(Some(Path::new(base)), &binary, &profiles.profiles[0])
                    .await?;
            println!("{}", serde_json::to_string_pretty(&suite)?);
        }
        _ => {
            eprintln!(
                "usage:\n  cargo run -p morphz-evals --bin coding_frame_eval -- create ARM [BASE_DIR]\n  cargo run -p morphz-evals --bin coding_frame_eval -- run-arm ARM PROFILES.toml BASE_DIR\n  cargo run -p morphz-evals --bin coding_frame_eval -- run PROFILES.toml BASE_DIR\n\nARM: fresh | coding_frame"
            );
            std::process::exit(64);
        }
    }
    Ok(())
}
