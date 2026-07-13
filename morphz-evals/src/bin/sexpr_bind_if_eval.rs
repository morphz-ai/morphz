use morphz_evals::sexpr_bind_if_eval::run_bind_if_eval;
use std::path::Path;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let (output, repetitions) = match args.as_slice() {
        [] => ("/private/tmp/morphz-sexpr-bind-if-eval", 1usize),
        [output] => (output.as_str(), 1usize),
        [output, repetitions] => (output.as_str(), repetitions.parse::<usize>()?),
        _ => {
            eprintln!(
                "usage: cargo run -p morphz --bin sexpr_bind_if_eval -- [OUTPUT_DIR] [REPETITIONS]"
            );
            std::process::exit(64);
        }
    };
    let report = run_bind_if_eval(Path::new(output), repetitions).await?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
