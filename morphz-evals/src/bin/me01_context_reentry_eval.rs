use morphz_evals::me01_context_reentry_eval::{
    load_me01_fixtures, run_me01_embedded_runtime_gate, run_me01_fake_gate,
};
use std::path::Path;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [command] if command == "audit-fixtures" => {
            let fixtures = load_me01_fixtures()?;
            println!("{}", serde_json::to_string_pretty(&fixtures)?);
        }
        [command] if command == "fake-gate" => {
            let summary = run_me01_fake_gate(None)?;
            println!("{}", serde_json::to_string_pretty(&summary)?);
        }
        [command, base] if command == "fake-gate" => {
            let summary = run_me01_fake_gate(Some(Path::new(base)))?;
            println!("{}", serde_json::to_string_pretty(&summary)?);
        }
        [command] if command == "embedded-runtime-gate" => {
            let summary = run_me01_embedded_runtime_gate(None).await?;
            println!("{}", serde_json::to_string_pretty(&summary)?);
        }
        [command, base] if command == "embedded-runtime-gate" => {
            let summary = run_me01_embedded_runtime_gate(Some(Path::new(base))).await?;
            println!("{}", serde_json::to_string_pretty(&summary)?);
        }
        _ => {
            return Err("usage:\n  cargo run -p morphz-evals --bin me01_context_reentry_eval -- audit-fixtures\n  cargo run -p morphz-evals --bin me01_context_reentry_eval -- fake-gate [BASE_DIR]\n  cargo run -p morphz-evals --bin me01_context_reentry_eval -- embedded-runtime-gate [BASE_DIR]".into());
        }
    }
    Ok(())
}
