//! Opt-in official DeepSeek Chat canary. One synthetic, capped request; no
//! Runtime database, user Context, tool execution or production config writes.
//! Usage: chat_output_limit_probe <existing-config> <single-target-route> <new-report> <native-secret-catalog>
use morphz::{
    config::{AppConfig, CredentialSource, ModelProtocol},
    llm::{
        Message, ModelFailure, ModelFailureKind, ModelRequestContext, ModelStreamEvent,
        ReasoningEffort,
    },
    memory::sqlite::SqliteStore,
    provider::auth::ProviderAuthManager,
    provider::build_configured_client,
    secret_store::{NativeKeyringSecretBackend, SecretStore},
};
use serde_json::json;
use std::{error::Error, fs::OpenOptions, io::Write, sync::Arc, time::Duration};

fn managed_credential_alias<'a>(
    config: &'a AppConfig,
    reference: &str,
) -> Result<&'a str, Box<dyn Error + Send + Sync>> {
    let credential = config
        .credentials
        .get(reference)
        .ok_or("pinned credential configuration is missing")?;
    // The routing adapter resolves the credential's alias, not the catalog ID.
    // Require this same path, then prove the alias is native-managed below;
    // never execute a helper or fall back to a plaintext/environment value.
    if credential.source != CredentialSource::Env {
        return Err("canary requires a native-managed static credential alias".into());
    }
    credential
        .name
        .as_deref()
        .filter(|alias| !alias.is_empty())
        .ok_or_else(|| "pinned credential alias is missing".into())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 4 {
        return Err(
            "expected explicit config, single-target route, new report and native secret catalog"
                .into(),
        );
    }
    let mut config: AppConfig = toml::from_str(&std::fs::read_to_string(&args[0])?)?;
    let route = config
        .model_routes
        .get(&args[1])
        .ok_or("route is not configured")?;
    if route.candidates.len() != 1 {
        return Err("canary requires exactly one physical target; no fallback".into());
    }
    let account_id = route.candidates[0]
        .account
        .as_ref()
        .ok_or("canary requires an explicitly pinned account; no account fallback")?;
    let account = config
        .auth_accounts
        .get(account_id)
        .ok_or("pinned account is not configured")?;
    if account.auth_adapter != "credential" || !account.enabled {
        return Err("canary requires one enabled native credential account".into());
    }
    let credential_ref = account.credential_ref.clone();
    let credential_alias = managed_credential_alias(&config, &credential_ref)?.to_owned();
    let provider = config
        .provider_instances
        .get_mut(&route.candidates[0].provider)
        .ok_or("provider is not configured")?;
    let endpoint = reqwest::Url::parse(&provider.base_url)?;
    if endpoint.scheme() != "https"
        || endpoint.host_str() != Some("api.deepseek.com")
        || endpoint.port_or_known_default() != Some(443)
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
    {
        return Err("this canary only authorizes the configured official DeepSeek endpoint".into());
    }
    // Change only this in-memory copy. The installed connection may use Responses.
    provider.protocol = ModelProtocol::OpenaiChat;
    provider.chat_token_limit_parameter = None;
    config.llm.model = args[1].clone();
    config.llm.max_output_tokens = Some(32);
    config.llm.reasoning_effort = Some(ReasoningEffort::Off);
    config.llm.max_retries = 1;
    config.llm.first_byte_timeout_secs = 30;
    config.llm.stream_idle_timeout_secs = 30;
    let (client, selected) = build_configured_client(&config, None, Some(&args[1]))?;
    // Read the existing native credential through its normal authority. Copy
    // only catalog metadata; audits/account health stay in disposable storage.
    // There is no environment/plaintext credential fallback in this canary.
    let temp = tempfile::tempdir()?;
    let catalog = temp.path().join("managed-secrets.json");
    std::fs::copy(&args[3], &catalog)?;
    let secrets = Arc::new(SecretStore::new(
        catalog,
        Arc::new(NativeKeyringSecretBackend),
    )?);
    if !secrets
        .list()?
        .iter()
        .any(|entry| entry.name == credential_alias && entry.value_backend == secrets.backend_id())
    {
        return Err("pinned credential must already be managed by the native Secret Store".into());
    }
    let store = Arc::new(
        SqliteStore::new(
            temp.path()
                .join("canary.sqlite")
                .to_str()
                .ok_or("invalid private temporary path")?,
        )
        .await?,
    );
    client.attach_provider_auth_manager(Arc::new(ProviderAuthManager::new(
        config.auth_accounts.clone(),
        secrets,
        store,
    )));
    let binding = client
        .bind_model_attempt(&ModelRequestContext {
            context_id: "synthetic-chat-limit-canary".into(),
            session_id: "synthetic-chat-limit-canary".into(),
            attempt_id: format!("synthetic-chat-limit-{}", std::process::id()),
            objective_id: None,
            required_capabilities: vec![],
        })
        .await?;
    let (stream, mut events) = tokio::sync::mpsc::unbounded_channel();
    let outcome = tokio::time::timeout(Duration::from_secs(60), client.create_completion_bound_stream(
        &binding,
        vec![Message { role:"user".into(), content:"List the integers from 1 to 2000, in order, separated by spaces. Do not summarize or use ellipses. Start with 1.".into(), name:None, tool_call_id:None, tool_calls:None }],
        vec![], None, stream,
    )).await;
    let failure = match &outcome {
        Ok(Err(error)) => error.downcast_ref::<ModelFailure>(),
        _ => None,
    };
    let mut output_tokens = None;
    let mut text = String::new();
    let mut completed = false;
    for event in std::iter::from_fn(|| events.try_recv().ok()) {
        match event {
            ModelStreamEvent::Usage { usage } => {
                output_tokens = usage.output_tokens.or(output_tokens)
            }
            ModelStreamEvent::TextDelta { text: delta } => text.push_str(&delta),
            ModelStreamEvent::Completed => completed = true,
            _ => {}
        }
    }
    let passed = failure.is_some_and(|failure| {
        failure.kind == ModelFailureKind::OutputLimit
            && failure.provider_code.as_deref() == Some("length")
    }) && output_tokens == Some(32)
        && !completed
        && !text.is_empty();
    let report = json!({"passed":passed,"protocol":"openai-chat","endpoint":selected.base_url,
        "model":selected.model,"expected_output_tokens":32,"observed_output_tokens":output_tokens,
        "failure_kind":failure.map(|failure|format!("{:?}",failure.kind)),
        "http_status":failure.and_then(|failure|failure.http_status),
        "finish_reason":failure.and_then(|failure|failure.provider_code.as_deref()),
        "timed_out":outcome.is_err(),"synthetic_prefix":text,"completed":completed,
        "production_config_changed":false,"user_context_sent":false,"tools":0});
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(&args[2])?
        .write_all(serde_json::to_string_pretty(&report)?.as_bytes())?;
    println!("{}", report);
    if !passed {
        return Err("official Chat canary did not satisfy the output-limit gate".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use morphz::config::CredentialConfig;

    #[test]
    fn canary_uses_the_same_static_alias_as_production_routing() {
        let mut config = AppConfig::default();
        config.credentials.insert(
            "official-account-credential".into(),
            CredentialConfig {
                source: CredentialSource::Env,
                name: Some("SYNTHETIC_NATIVE_ALIAS".into()),
                ..Default::default()
            },
        );
        assert_eq!(
            managed_credential_alias(&config, "official-account-credential").unwrap(),
            "SYNTHETIC_NATIVE_ALIAS"
        );
        assert!(managed_credential_alias(&config, "missing").is_err());
        let credential = config
            .credentials
            .get_mut("official-account-credential")
            .unwrap();
        credential.source = CredentialSource::Command;
        assert!(managed_credential_alias(&config, "official-account-credential").is_err());
    }
}
