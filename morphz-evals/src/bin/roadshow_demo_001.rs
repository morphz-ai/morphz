use morphz_evals::roadshow_demo_001::{inspect_dry_run, run_no_model_dry_run};
use morphz_evals::roadshow_demo_001_adapter::run_fake_client_contract_suite;
use morphz_evals::roadshow_demo_001_smoke::{
    run_real_model_normal_smoke_suite, validate_frozen_smoke_contract,
    validate_morphz_profile_binding,
};
use std::path::Path;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [command] if command == "dry-run" => {
            let report = run_no_model_dry_run(None)?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !report.passed {
                std::process::exit(2);
            }
        }
        [command, base] if command == "dry-run" => {
            let report = run_no_model_dry_run(Some(Path::new(base)))?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !report.passed {
                std::process::exit(2);
            }
        }
        [command, run_root] if command == "inspect-run" => {
            let report = inspect_dry_run(Path::new(run_root))?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !report.passed {
                std::process::exit(2);
            }
        }
        [command] if command == "fake-client-run" => {
            let report = run_fake_client_contract_suite(None)?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !report.all_adapters_passed {
                std::process::exit(2);
            }
        }
        [command, base] if command == "fake-client-run" => {
            let report = run_fake_client_contract_suite(Some(Path::new(base)))?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !report.all_adapters_passed {
                std::process::exit(2);
            }
        }
        [command] if command == "frozen-preflight" => {
            println!(
                "{}",
                serde_json::to_string_pretty(&validate_frozen_smoke_contract()?)?
            );
        }
        [command] if command == "profile-preflight" => {
            println!(
                "{}",
                serde_json::to_string_pretty(&validate_morphz_profile_binding(None).await?)?
            );
        }
        [command, base] if command == "profile-preflight" => {
            println!(
                "{}",
                serde_json::to_string_pretty(
                    &validate_morphz_profile_binding(Some(Path::new(base))).await?
                )?
            );
        }
        [command] if command == "real-normal-smoke" => {
            let report = run_real_model_normal_smoke_suite(None).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !report.all_passed {
                std::process::exit(2);
            }
        }
        [command, base] if command == "real-normal-smoke" => {
            let report = run_real_model_normal_smoke_suite(Some(Path::new(base))).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !report.all_passed {
                std::process::exit(2);
            }
        }
        _ => {
            eprintln!(
                "usage:\n  cargo run -p morphz-evals --bin roadshow_demo_001 -- dry-run [BASE_DIR]\n  cargo run -p morphz-evals --bin roadshow_demo_001 -- fake-client-run [BASE_DIR]\n  cargo run -p morphz-evals --bin roadshow_demo_001 -- frozen-preflight\n  cargo run -p morphz-evals --bin roadshow_demo_001 -- profile-preflight [BASE_DIR]\n  cargo run -p morphz-evals --bin roadshow_demo_001 -- real-normal-smoke [BASE_DIR]\n  cargo run -p morphz-evals --bin roadshow_demo_001 -- inspect-run RUN_ROOT"
            );
            std::process::exit(64);
        }
    }
    Ok(())
}
