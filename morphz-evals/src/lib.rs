//! Morphz evaluation fixtures, scorers, model matrices, and benchmark runners.
//!
//! This crate may depend on the production Runtime. The Runtime must never
//! depend on this crate.

use morphz::config;
use morphz::llm::Client;
use morphz::provider::build_configured_client;
use std::path::Path;
use std::sync::Arc;

pub type EvalError = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug, Clone, Default)]
pub struct EvalRuntimeOverrides {
    pub model_provider_max_in_flight: Option<usize>,
    pub activation_max_in_flight: Option<usize>,
    pub context_soft_token_limit: Option<usize>,
    pub context_hard_token_limit: Option<usize>,
    pub context_maintenance_reserve_tokens: Option<usize>,
}

/// Build evaluation clients through exactly the same explicit
/// Provider/Protocol/Model/Credential path as the production Runtime.
pub fn configured_model_client() -> Result<(Arc<dyn Client>, String), EvalError> {
    let (client, model, _) = configured_model_client_with_config()?;
    Ok((client, model))
}

/// Build the production-equivalent evaluation client and retain its resolved
/// configuration for measurements that also need the operator's pricing
/// catalog or other non-secret model metadata.
pub fn configured_model_client_with_config(
) -> Result<(Arc<dyn Client>, String, config::AppConfig), EvalError> {
    if let Some(path) = config::host_env_path() {
        if let Err(error) = config::load_env(&path.to_string_lossy()) {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(format!(
                    "无法加载用户级 Morphz 环境文件 '{}': {error}",
                    path.display()
                )
                .into());
            }
        }
    }
    let cwd = std::env::current_dir()?;
    let active_profile = config::active_profile()?;
    let mut resolved = config::resolve_config(&cwd, None, active_profile.as_deref())?;
    resolved.config.apply_runtime_env_overrides()?;
    let (client, selected) = build_configured_client(&resolved.config, None, None)?;
    Ok((client, selected.model, resolved.config))
}

/// Give a spawned Morphz process an isolated, explicit Provider configuration.
/// Evaluation code uses the same Provider path as production and never maps
/// arbitrary models onto implicit `OPENAI_*` process variables.
pub fn configure_agent_model_profile(
    command: &mut tokio::process::Command,
    run_root: &Path,
    protocol: &str,
    base_url: &str,
    model: &str,
    api_key_env: &str,
) -> Result<(), EvalError> {
    configure_agent_model_profile_with_overrides(
        command,
        run_root,
        protocol,
        base_url,
        model,
        api_key_env,
        &EvalRuntimeOverrides::default(),
    )
}

/// Configure the production Provider path plus benchmark-only Runtime limits.
/// These limits live in the isolated evaluation config, not in the task prompt,
/// so the model cannot alter the physical concurrency budget.
pub fn configure_agent_model_profile_with_overrides(
    command: &mut tokio::process::Command,
    run_root: &Path,
    protocol: &str,
    base_url: &str,
    model: &str,
    api_key_env: &str,
    overrides: &EvalRuntimeOverrides,
) -> Result<(), EvalError> {
    if std::env::var_os(api_key_env).is_none() {
        return Err(format!("模型评测需要环境变量 {api_key_env}，但当前未设置").into());
    }
    let home = run_root.join("morphz-home");
    std::fs::create_dir_all(&home)?;
    let config_path = home.join("eval-provider.toml");
    let mut root = toml::map::Map::new();
    root.insert(
        "llm".to_string(),
        toml::Value::Table(toml::map::Map::from_iter([
            (
                "provider".to_string(),
                toml::Value::String("eval".to_string()),
            ),
            ("model".to_string(), toml::Value::String(model.to_string())),
        ])),
    );
    root.insert(
        "providers".to_string(),
        toml::Value::Table(toml::map::Map::from_iter([(
            "eval".to_string(),
            toml::Value::Table(toml::map::Map::from_iter([
                (
                    "protocol".to_string(),
                    toml::Value::String(protocol.to_string()),
                ),
                (
                    "base_url".to_string(),
                    toml::Value::String(base_url.to_string()),
                ),
                (
                    "credential".to_string(),
                    toml::Value::String("eval".to_string()),
                ),
            ])),
        )])),
    );
    root.insert(
        "credentials".to_string(),
        toml::Value::Table(toml::map::Map::from_iter([(
            "eval".to_string(),
            toml::Value::Table(toml::map::Map::from_iter([
                ("source".to_string(), toml::Value::String("env".to_string())),
                (
                    "name".to_string(),
                    toml::Value::String(api_key_env.to_string()),
                ),
            ])),
        )])),
    );
    let mut orchestrator = toml::map::Map::new();
    if let Some(value) = overrides.model_provider_max_in_flight {
        orchestrator.insert(
            "model_provider_max_in_flight".to_string(),
            toml::Value::Integer(value as i64),
        );
    }
    if let Some(value) = overrides.context_soft_token_limit {
        orchestrator.insert(
            "context_soft_token_limit".to_string(),
            toml::Value::Integer(value as i64),
        );
    }
    if let Some(value) = overrides.context_hard_token_limit {
        orchestrator.insert(
            "context_hard_token_limit".to_string(),
            toml::Value::Integer(value as i64),
        );
    }
    if let Some(value) = overrides.context_maintenance_reserve_tokens {
        orchestrator.insert(
            "context_maintenance_reserve_tokens".to_string(),
            toml::Value::Integer(value as i64),
        );
    }
    if let Some(value) = overrides.activation_max_in_flight {
        orchestrator.insert(
            "activation_admission".to_string(),
            toml::Value::Table(toml::map::Map::from_iter([(
                "max_in_flight".to_string(),
                toml::Value::Integer(value as i64),
            )])),
        );
    }
    if !orchestrator.is_empty() {
        root.insert("orchestrator".to_string(), toml::Value::Table(orchestrator));
    }
    std::fs::write(
        &config_path,
        toml::to_string_pretty(&toml::Value::Table(root))?,
    )?;
    command
        .env("MORPHZ_HOME", &home)
        .arg(format!("--config-file={}", config_path.to_string_lossy()));
    Ok(())
}

pub mod coding_frame_eval;
pub mod coding_harness_eval;
pub mod concurrent_objective_eval;
pub mod context_long_run_eval;
pub mod context_metacognition_eval;
pub mod context_prefix_cache_eval;
pub mod context_pressure_eval;
pub mod eval_sandbox;
pub mod long_horizon_agent_eval;
pub mod me01_context_reentry_eval;
pub mod me01_context_reentry_smoke;
pub mod me02_representation_eval;
pub mod me03_bounded_open_eval;
pub mod me05_model_target;
pub mod me06_long_horizon_eval;
pub mod principal_identity_eval;
pub mod roadshow_demo_001;
pub mod roadshow_demo_001_adapter;
pub mod roadshow_demo_001_smoke;
pub mod sexpr_bind_if_eval;
pub mod sexpr_process_eval;
pub mod sexpr_reply_eval;
pub mod yao_program_eval;
