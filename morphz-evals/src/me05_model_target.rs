use morphz::config;
use morphz::llm::{Client, ModelAttemptBinding, ModelRequestContext, ReasoningEffort};
use morphz::provider::build_configured_client;
use morphz::runtime::MorphzRuntime;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;

type DynError = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EvalModelTarget {
    pub requested_alias: String,
    pub physical_model: String,
    pub provider: String,
    pub protocol: String,
    pub endpoint: Option<String>,
    pub profile: Option<String>,
    pub explicit_config: Option<PathBuf>,
    pub reasoning_effort: ReasoningEffort,
}

impl EvalModelTarget {
    pub fn from_environment(
        default_profile: &str,
        default_provider: &str,
        default_model: &str,
    ) -> Result<Self, DynError> {
        let requested_alias =
            std::env::var("MORPHZ_EVAL_MODEL").unwrap_or_else(|_| default_model.to_string());
        let physical_model =
            std::env::var("MORPHZ_EVAL_PHYSICAL_MODEL").unwrap_or_else(|_| requested_alias.clone());
        let provider =
            std::env::var("MORPHZ_EVAL_PROVIDER").unwrap_or_else(|_| default_provider.to_string());
        let protocol = std::env::var("MORPHZ_EVAL_PROTOCOL")
            .unwrap_or_else(|_| "openai-responses".to_string());
        let endpoint = std::env::var("MORPHZ_EVAL_ENDPOINT").ok();
        let profile = match std::env::var("MORPHZ_EVAL_PROFILE") {
            Ok(value) if value.trim().is_empty() || value.trim() == "none" => None,
            Ok(value) => Some(value),
            Err(_) => Some(default_profile.to_string()),
        };
        let explicit_config = std::env::var_os("MORPHZ_EVAL_CONFIG_FILE").map(PathBuf::from);
        let reasoning = std::env::var("MORPHZ_EVAL_REASONING")
            .unwrap_or_else(|_| ReasoningEffort::Max.as_str().to_string());
        let reasoning_effort = ReasoningEffort::parse(&reasoning)
            .ok_or_else(|| format!("unsupported MORPHZ_EVAL_REASONING value: {reasoning}"))?;
        Ok(Self {
            requested_alias,
            physical_model,
            provider,
            protocol,
            endpoint,
            profile,
            explicit_config,
            reasoning_effort,
        })
    }
}

pub async fn build_exact_model_client(
    run_root: &Path,
    target: &EvalModelTarget,
    namespace: &str,
    max_output_tokens: u32,
) -> Result<(Arc<dyn Client>, MorphzRuntime, ModelAttemptBinding), DynError> {
    if let Some(path) = config::host_env_path() {
        if let Err(error) = config::load_env(&path.to_string_lossy()) {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(format!("failed to load Morphz host environment: {error}").into());
            }
        }
    }
    if let Some(path) = target.explicit_config.as_ref() {
        if !path.is_file() {
            return Err(format!("ME-05 explicit config does not exist: {}", path.display()).into());
        }
    }
    let cwd = std::env::current_dir()?;
    let mut resolved = config::resolve_config(
        &cwd,
        target.explicit_config.as_deref(),
        target.profile.as_deref(),
    )?;
    resolved.config.apply_runtime_env_overrides()?;
    let route = resolved
        .config
        .model_routes
        .get(&target.requested_alias)
        .ok_or_else(|| format!("ME-05 route is not configured: {}", target.requested_alias))?;
    if route.fallback || route.candidates.len() != 1 {
        return Err(format!(
            "ME-05 route {} must contain one candidate and fallback=false",
            target.requested_alias
        )
        .into());
    }
    let candidate = &route.candidates[0];
    if candidate.provider != target.provider || candidate.model != target.physical_model {
        return Err(format!(
            "ME-05 route mismatch for {}: expected {}/{}, found {}/{}",
            target.requested_alias,
            target.provider,
            target.physical_model,
            candidate.provider,
            candidate.model
        )
        .into());
    }
    resolved.config.llm.model = target.requested_alias.clone();
    resolved.config.llm.reasoning_effort = Some(target.reasoning_effort);
    resolved.config.llm.max_output_tokens = Some(max_output_tokens);
    let (client, selected) =
        build_configured_client(&resolved.config, None, Some(&target.requested_alias))?;
    if selected.id != target.provider || selected.model != target.physical_model {
        return Err(format!(
            "ME-05 configured client mismatch: expected {}/{}, found {}/{}",
            target.provider, target.physical_model, selected.id, selected.model
        )
        .into());
    }
    client.set_reasoning_effort(Some(target.reasoning_effort))?;
    if client.reasoning_effort() != Some(target.reasoning_effort) {
        return Err("ME-05 client did not retain the requested reasoning effort".into());
    }
    let runtime = MorphzRuntime::builder(resolved.config, Arc::clone(&client))
        .database_path(run_root.join("provider-control.db").to_string_lossy())
        .build()
        .await?;
    let preflight_id = format!("{namespace}-{}", target.requested_alias);
    let binding = client
        .bind_model_attempt(&ModelRequestContext {
            context_id: preflight_id.clone(),
            session_id: preflight_id.clone(),
            attempt_id: preflight_id,
            objective_id: None,
            required_capabilities: Vec::new(),
        })
        .await?;
    if binding.requested_alias != target.requested_alias
        || binding.physical_model != target.physical_model
        || binding.provider_instance_id != target.provider
        || binding.protocol != target.protocol
        || target
            .endpoint
            .as_ref()
            .is_some_and(|endpoint| binding.endpoint != *endpoint)
    {
        return Err(format!(
            "ME-05 immutable binding mismatch: alias={}, provider={}, physical={}, protocol={} (expected {}), endpoint={} (expected {:?})",
            binding.requested_alias,
            binding.provider_instance_id,
            binding.physical_model,
            binding.protocol,
            target.protocol,
            binding.endpoint,
            target.endpoint
        )
        .into());
    }
    Ok((client, runtime, binding))
}
