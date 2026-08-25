use morphz_evals::me03_bounded_open_eval::{
    run_binding_preflight, run_no_model_gate, run_real_pilot,
};
use std::path::Path;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [mode, output] if mode == "no-model-gate" => {
            let report = run_no_model_gate(Path::new(output))?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        [mode, output] if mode == "binding-preflight" => {
            let report = run_binding_preflight(Path::new(output)).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        [mode, output] if mode == "pilot" => {
            let report = run_real_pilot(Path::new(output), 2).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        [mode, output, repetitions] if mode == "pilot" => {
            let report = run_real_pilot(Path::new(output), repetitions.parse()?).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        _ => {
            eprintln!(
                "usage: me03_bounded_open_eval no-model-gate OUTPUT_DIR\n       me03_bounded_open_eval binding-preflight OUTPUT_DIR\n       me03_bounded_open_eval pilot OUTPUT_DIR [REPETITIONS]"
            );
            std::process::exit(64);
        }
    }
    Ok(())
}
