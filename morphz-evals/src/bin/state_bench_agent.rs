use morphz_evals::state_bench_agent::{parse_agent_config, run_state_bench_agent};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let config = parse_agent_config(&arguments)?;
    run_state_bench_agent(config).await
}
