use morphz_evals::context_prefix_cache_eval::{
    run_context_prefix_cache_eval, PrefixCacheEvalConfig, TokenPrices,
};
use std::path::PathBuf;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut config = PrefixCacheEvalConfig::default();
    let mut output = PathBuf::from("/private/tmp/morphz-context-prefix-cache-eval");
    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--output" => output = PathBuf::from(args.next().ok_or("--output requires PATH")?),
            "--history-chars" => {
                config.history_chars = args.next().ok_or("--history-chars requires N")?.parse()?;
            }
            "--observations" => {
                config.observations = args.next().ok_or("--observations requires N")?.parse()?;
            }
            "--cached-discount" => {
                config.cached_input_discount = args
                    .next()
                    .ok_or("--cached-discount requires RATIO")?
                    .parse()?;
            }
            "--output-multiplier" => {
                config.output_input_multiplier = args
                    .next()
                    .ok_or("--output-multiplier requires RATIO")?
                    .parse()?;
            }
            "--cache-write-multiplier" => {
                config.cache_write_input_multiplier = args
                    .next()
                    .ok_or("--cache-write-multiplier requires RATIO")?
                    .parse()?;
            }
            "--prices" => {
                let raw = args
                    .next()
                    .ok_or("--prices requires UNCACHED,CACHED,CACHE_WRITE,OUTPUT per million")?;
                let values = raw
                    .split(',')
                    .map(str::parse::<f64>)
                    .collect::<Result<Vec<_>, _>>()?;
                if values.len() != 4 {
                    return Err(
                        "--prices requires exactly UNCACHED,CACHED,CACHE_WRITE,OUTPUT".into(),
                    );
                }
                config.prices_per_million = Some(TokenPrices {
                    currency: "CUSTOM".to_string(),
                    version: "command-line".to_string(),
                    uncached_input: values[0],
                    cached_input: values[1],
                    cache_write_input: Some(values[2]),
                    output: values[3],
                });
            }
            "--help" | "-h" => {
                println!(
                    "usage: context_prefix_cache_eval [--output PATH] [--history-chars N] [--observations N] [--cached-discount RATIO] [--cache-write-multiplier RATIO] [--output-multiplier RATIO] [--prices UNCACHED,CACHED,CACHE_WRITE,OUTPUT]"
                );
                return Ok(());
            }
            _ => return Err(format!("unknown argument: {argument}").into()),
        }
    }
    let report = run_context_prefix_cache_eval(&output, config).await?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
