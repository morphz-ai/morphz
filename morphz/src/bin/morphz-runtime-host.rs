//! Explicit hosted embedding. Ordinary `morphz` startup never selects this
//! backend, uploads a HOME, or adopts hosted credentials implicitly.
use morphz::config::{self, ServerIdentityMode};
use morphz::llm::Client;
use morphz::memory::remote::host_configuration::HostConfiguration;
use morphz::memory::remote::host_credentials::HostCredentialBackend;
use morphz::memory::remote::host_lifecycle::HostRequestGate;
use morphz::memory::remote::{
    host_files::HostFiles, http::HttpRemoteStoreTransport, protocol::StoreError, RemoteRuntimeStore,
};
use morphz::memory::{NewSession, SessionDirectoryStore, SessionMountKind};
use morphz::provider::{build_configured_client, routing::RoutedClient};
use morphz::runtime::{MorphzRuntime, RuntimeIdentity};
use morphz::secret_store::SecretStore;
use morphz::web::{Server, ServerDefaults};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

fn required(name: &str) -> Result<String, StoreError> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!("{name} must be explicitly configured for the hosted Runtime").into()
        })
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    match run().await {
        Ok(()) => std::process::exit(0),
        Err(error) => {
            tracing::error!(event_code = "host.startup_or_ownership_failed", error = %error, "Hosted Runtime stopped; no local fallback is permitted");
            // Do not wait on blocking workers holding obsolete physical effects.
            std::process::exit(1);
        }
    }
}

async fn run() -> Result<(), StoreError> {
    let home = PathBuf::from(required("MORPHZ_HOME")?);
    if !home.is_absolute() {
        return Err("hosted MORPHZ_HOME must be an absolute, empty cache directory".into());
    }
    if std::fs::symlink_metadata(&home)?.file_type().is_symlink() {
        return Err("hosted cache cannot be a symlink".into());
    }
    let home = std::fs::canonicalize(home)?;
    std::env::set_var("MORPHZ_HOME", &home);
    let endpoint = required("MORPHZ_REMOTE_STORE_URL")?;
    let files_endpoint = required("MORPHZ_HOST_FILES_URL")?;
    let credentials_endpoint = required("MORPHZ_HOST_CREDENTIALS_URL")?;
    let configuration_endpoint = required("MORPHZ_HOST_CONFIGURATION_URL")?;
    let token = required("MORPHZ_REMOTE_STORE_TOKEN")?;
    let private = std::env::var("MORPHZ_HOST_PRIVATE_GATEWAY").as_deref() == Ok("1");
    let transport = Arc::new(if private {
        HttpRemoteStoreTransport::private_gateway(&endpoint, &token)?
    } else {
        HttpRemoteStoreTransport::new(&endpoint, &token)?
    });
    // File endpoint has the same deployment transport policy as the Store.
    if !private {
        HttpRemoteStoreTransport::new(&files_endpoint, &token)?;
    }
    required("MORPHZ_API_TOKEN")?;
    required("MORPHZ_DASHBOARD_TOKEN")?;
    let provider_id = required("MORPHZ_SERVER_IDENTITY_PROVIDER_ID")?;
    let store = Arc::new(RemoteRuntimeStore::connect_owned(transport).await?);
    let fence = store.compute_fence();
    let lost = store.ownership_flag();
    let file_root = home.clone();
    let credentials = HostCredentialBackend::new(
        &credentials_endpoint,
        &token,
        fence.clone(),
        lost.clone(),
        private,
    )?;
    let config_root = home.clone();
    let config_fence = fence.clone();
    let config_lost = lost.clone();
    let config_token = token.clone();
    tokio::task::spawn_blocking(move || {
        HostFiles::restore(file_root, &files_endpoint, &token, fence, lost)
    })
    .await??
    .install()?;
    tokio::task::spawn_blocking(move || {
        HostConfiguration::restore(
            config_root,
            &configuration_endpoint,
            &config_token,
            config_fence,
            config_lost,
            private,
        )
    })
    .await??
    .install()?;
    let secrets =
        tokio::task::spawn_blocking(move || SecretStore::managed(Arc::new(credentials))).await??;
    let mut app = config::resolve_config(&home, None, None)?.config;
    app.apply_runtime_env_overrides()?;
    // The Cloud compute instance is not the user's execution target.
    app.execution_targets.local_enabled = false;
    let workspace = home.join("workspace");
    std::fs::create_dir_all(&workspace)?;
    app.permissions.workspace_root = workspace.to_string_lossy().into_owned();
    app.background_task.artifact_dir = home.join("artifacts").to_string_lossy().into_owned();
    // Explicit hosted admission limits, also advertised by the Runtime API.
    // An import publishes event/workspace links together within one 34 MiB RPC.
    app.model_input.max_artifacts_per_import = app.model_input.max_artifacts_per_import.min(32);
    app.model_input.max_artifact_bytes = app.model_input.max_artifact_bytes.min(8 * 1024 * 1024);
    app.model_input.max_import_bytes = app.model_input.max_import_bytes.min(12 * 1024 * 1024);
    app.server.identity.mode = ServerIdentityMode::TrustedGateway;
    app.server.identity.provider_id = provider_id;
    app.server.identity.service_token_env = "MORPHZ_API_TOKEN".into();
    let client: Arc<dyn Client> = if app.provider_instances.is_empty()
        && app.model_routes.is_empty()
        && app.providers.is_empty()
        && app.llm.provider.is_none()
    {
        Arc::new(RoutedClient::empty(app.llm.clone()))
    } else {
        build_configured_client(&app, None, None)?.0
    };
    let secrets = Arc::new(secrets);
    let identity = RuntimeIdentity {
        agent_id: required("MORPHZ_AGENT_ID")?,
        context_id: required("MORPHZ_CONTEXT_ID")?,
        principal_id: "host-local-operator".into(),
    };
    let initial_session = NewSession {
        id: required("MORPHZ_SESSION_ID")?,
        agent_id: identity.agent_id.clone(),
        context_id: identity.context_id.clone(),
        parent_session_id: None,
        title: "Main".into(),
        mount_kind: SessionMountKind::ExistingContext,
    };
    let defaults = ServerDefaults {
        agent_id: identity.agent_id.clone(),
        context_id: identity.context_id.clone(),
    };
    let gateway_identity = app.server.identity.clone();
    let runtime = MorphzRuntime::builder(app, client)
        .identity(identity)
        .secret_store(secrets)
        .store("remote:agent-cell", store.clone())
        .principal_first_seen_cues(true)
        .build()
        .await?;
    runtime.start().await?;
    // Provision the one Agent's primary Session without claiming it for the
    // local operator. The verified user gateway binds its Principal separately.
    store.ensure_session(initial_session).await?;
    store.complete_recovery().await?;
    let bind = required("MORPHZ_BIND")?;
    let idle_seconds: u64 = std::env::var("MORPHZ_HOST_IDLE_SECONDS")
        .unwrap_or_else(|_| "60".into())
        .parse()
        .map_err(|_| "MORPHZ_HOST_IDLE_SECONDS must be a positive integer")?;
    if idle_seconds == 0 {
        return Err("MORPHZ_HOST_IDLE_SECONDS must be positive".into());
    }
    let gate = Arc::new(HostRequestGate::default());
    Server::new(runtime.clone(), defaults)
        .with_identity(gateway_identity)
        .with_host_request_gate(gate.clone())
        .start(&bind)
        .await?;
    tracing::info!(
        event_code = "host.ready",
        "Hosted Runtime restored and ready"
    );
    let mut next_park_probe = Instant::now() + Duration::from_secs(idle_seconds);
    loop {
        tokio::select! {
            result = tokio::signal::ctrl_c() => { result?; return Ok(()); },
            () = tokio::time::sleep(Duration::from_millis(100)) => {
                if store.ownership_lost() { return Err("compute ownership lost; process must be replaced".into()); }
                // A busy native owner must not cause a Store scan every 100ms.
                if Instant::now() >= next_park_probe {
                    next_park_probe = Instant::now() + Duration::from_secs(5);
                    if let Some(attempt) = gate.begin_park(Duration::from_secs(idle_seconds)) {
                        if store.try_park(|| runtime.hosted_process_is_quiescent()).await? {
                            attempt.commit();
                            tracing::info!(event_code = "host.parked", "Runtime quiescence and next deadline committed; exiting idle compute");
                            return Ok(());
                        }
                    }
                }
            }
        }
    }
}
