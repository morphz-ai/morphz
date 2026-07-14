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

/// Build evaluation clients through exactly the same explicit
/// Provider/Protocol/Model/Credential path as the production Runtime.
pub fn configured_model_client() -> Result<(Arc<dyn Client>, String), EvalError> {
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
    Ok((client, selected.model))
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
    std::fs::write(
        &config_path,
        toml::to_string_pretty(&toml::Value::Table(root))?,
    )?;
    command
        .env("MORPHZ_HOME", &home)
        .arg("--config")
        .arg(config_path);
    Ok(())
}

pub mod context_long_run_eval;
pub mod context_metacognition_eval;
pub mod context_pressure_eval;
pub mod eval_sandbox;
pub mod long_horizon_agent_eval;
pub mod sexpr_bind_if_eval;
pub mod sexpr_process_eval;
pub mod sexpr_reply_eval;
