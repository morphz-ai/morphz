use morphz_evals::context_metacognition_eval::default_morphz_agent_binary;
use morphz_evals::me01_context_reentry_eval::{
    load_me01_fixtures, run_me01_embedded_runtime_gate, run_me01_fake_gate,
    run_me01_process_probe_phase, run_me01_standalone_process_gate, Me01Arm, Me01ProbePhase,
};
use morphz_evals::me01_context_reentry_smoke::{
    rehash_me01_artifacts, run_me01_real_cell_suite, run_me01_real_smoke_suite,
    validate_me01_real_cell_preflight, validate_me01_real_smoke_preflight,
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
        [command] if command == "standalone-process-gate" => {
            let executable = std::env::current_exe()?;
            let summary = run_me01_standalone_process_gate(&executable, None).await?;
            println!("{}", serde_json::to_string_pretty(&summary)?);
        }
        [command, base] if command == "standalone-process-gate" => {
            let executable = std::env::current_exe()?;
            let summary =
                run_me01_standalone_process_gate(&executable, Some(Path::new(base))).await?;
            println!("{}", serde_json::to_string_pretty(&summary)?);
        }
        [command, episode_root, fixture_id, arm, phase] if command == "runtime-probe-phase" => {
            let report = run_me01_process_probe_phase(
                Path::new(episode_root),
                fixture_id,
                Me01Arm::parse(arm)?,
                Me01ProbePhase::parse(phase)?,
            )
            .await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        [command] if command == "real-smoke-preflight" => {
            let binary = default_morphz_agent_binary()?;
            let report = validate_me01_real_smoke_preflight(&binary).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        [command, fixture_id] if command == "real-cell-preflight" => {
            let binary = default_morphz_agent_binary()?;
            let report = validate_me01_real_cell_preflight(&binary, fixture_id).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        [command] if command == "real-smoke" => {
            let binary = default_morphz_agent_binary()?;
            let report = run_me01_real_smoke_suite(None, &binary).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        [command, base] if command == "real-smoke" => {
            let binary = default_morphz_agent_binary()?;
            let report = run_me01_real_smoke_suite(Some(Path::new(base)), &binary).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        [command, fixture_id] if command == "real-cell" => {
            let binary = default_morphz_agent_binary()?;
            let report = run_me01_real_cell_suite(None, &binary, fixture_id).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        [command, fixture_id, base] if command == "real-cell" => {
            let binary = default_morphz_agent_binary()?;
            let report =
                run_me01_real_cell_suite(Some(Path::new(base)), &binary, fixture_id).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        [command, suite_root] if command == "rehash-artifacts" => {
            rehash_me01_artifacts(Path::new(suite_root))?;
            println!("rehash complete: {suite_root}");
        }
        _ => {
            return Err("usage:\n  cargo run -p morphz-evals --bin me01_context_reentry_eval -- audit-fixtures\n  cargo run -p morphz-evals --bin me01_context_reentry_eval -- fake-gate [BASE_DIR]\n  cargo run -p morphz-evals --bin me01_context_reentry_eval -- embedded-runtime-gate [BASE_DIR]\n  cargo run -p morphz-evals --bin me01_context_reentry_eval -- standalone-process-gate [BASE_DIR]\n  cargo run -p morphz-evals --bin me01_context_reentry_eval -- real-smoke-preflight\n  cargo run -p morphz-evals --bin me01_context_reentry_eval -- real-smoke [BASE_DIR]\n  cargo run -p morphz-evals --bin me01_context_reentry_eval -- real-cell-preflight FIXTURE_ID\n  cargo run -p morphz-evals --bin me01_context_reentry_eval -- real-cell FIXTURE_ID [BASE_DIR]\n  cargo run -p morphz-evals --bin me01_context_reentry_eval -- rehash-artifacts SUITE_ROOT\n  me01_context_reentry_eval runtime-probe-phase EPISODE_ROOT FIXTURE_ID ARM PHASE".into());
        }
    }
    Ok(())
}
