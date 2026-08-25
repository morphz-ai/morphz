use morphz_evals::me06_long_horizon_eval::{
    generate_me06_fixtures, run_me06_fake_adapter_gate, run_me06_no_model_gate,
};
use std::path::Path;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [command] if command == "fixtures" => {
            println!(
                "{}",
                serde_json::to_string_pretty(&generate_me06_fixtures()?)?
            );
        }
        [command] if command == "no-model-gate" => {
            let report = run_me06_no_model_gate(None).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        [command, base] if command == "no-model-gate" => {
            let report = run_me06_no_model_gate(Some(Path::new(base))).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        [command] if command == "fake-adapter-gate" => {
            let report = run_me06_fake_adapter_gate(None)?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        [command, base] if command == "fake-adapter-gate" => {
            let report = run_me06_fake_adapter_gate(Some(Path::new(base)))?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        _ => {
            return Err(
                "usage:\n  me06_long_horizon_eval fixtures\n  me06_long_horizon_eval no-model-gate [BASE_DIR]\n  me06_long_horizon_eval fake-adapter-gate [BASE_DIR]"
                    .into(),
            );
        }
    }
    Ok(())
}
