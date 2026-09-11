//! Explicit hosted embedding. Ordinary `morphz` startup never selects this
//! backend, uploads a HOME, or adopts hosted credentials implicitly.
use morphz::config::{self, ServerIdentityMode};
use morphz::llm::Client;
use morphz::memory::remote::compute_policy::HostComputePolicy;
use morphz::memory::remote::host_configuration::HostConfiguration;
use morphz::memory::remote::host_credentials::HostCredentialBackend;
use morphz::memory::remote::host_lifecycle::HostRequestGate;
use morphz::memory::remote::host_observers::{HostObserverFeed, ObserverQueue};
use morphz::memory::remote::http::HttpObserverTransport;
use morphz::memory::remote::{
    host_files::HostFiles, http::HttpRemoteStoreTransport, protocol::StoreError, RemoteRuntimeStore,
};
use morphz::memory::{
    EventStore, NewSession, QueryFilter, SessionDirectoryStore, SessionMountKind,
};
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
    let options: Vec<_> = std::env::args().skip(1).collect();
    // Maintenance validation branches BEFORE config, HOME, credentials, HTTP
    // clients and Runtime startup. Only stdin and an in-memory SQLite replica.
    if options.as_slice() == ["--verify-recovery"] {
        match morphz::memory::remote::recovery::verify_stream(tokio::io::BufReader::new(
            tokio::io::stdin(),
        ))
        .await
        {
            Ok(report) => {
                println!(
                    "{}",
                    serde_json::to_string(&report).expect("static recovery report")
                );
                std::process::exit(0);
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(2);
            }
        }
    }
    if options.as_slice() == ["--recovery-schema"] {
        match morphz::memory::remote::recovery::native_schema().await {
            Ok(schema) => {
                println!(
                    "{}",
                    serde_json::json!({ "protocol": morphz::memory::remote::recovery::RECOVERY_PROTOCOL, "schema": schema })
                );
                std::process::exit(0);
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(2);
            }
        }
    }
    if !options.is_empty() {
        eprintln!("unknown hosted Runtime option");
        std::process::exit(2);
    }
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
    // Payload-free startup checkpoints distinguish remote-store restoration
    // from platform readiness. Never include config, identities or errors.
    let startup_began = Instant::now();
    let mut previous_phase = startup_began;
    let mut startup_phase = |phase: &'static str| {
        let now = Instant::now();
        tracing::info!(
            event_code = "host.startup_phase",
            phase,
            phase_ms = now.duration_since(previous_phase).as_millis() as u64,
            elapsed_ms = now.duration_since(startup_began).as_millis() as u64,
            "Hosted startup phase completed"
        );
        previous_phase = now;
    };
    let compute_policy = HostComputePolicy::from_env()?;
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
    let observers_endpoint = required("MORPHZ_HOST_OBSERVERS_URL")?;
    let token = required("MORPHZ_REMOTE_STORE_TOKEN")?;
    let private = std::env::var("MORPHZ_HOST_PRIVATE_GATEWAY").as_deref() == Ok("1");
    let observers = HttpObserverTransport::new(&observers_endpoint, &token, private)?;
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
    startup_phase("store_claim_and_replica");
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
    startup_phase("files_restore");
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
    startup_phase("configuration_restore");
    let secrets =
        tokio::task::spawn_blocking(move || SecretStore::managed(Arc::new(credentials))).await??;
    startup_phase("credential_catalog_restore");
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
    startup_phase("configuration_and_client");
    let runtime = MorphzRuntime::builder(app, client)
        .identity(identity)
        .secret_store(secrets)
        .store("remote:agent-cell", store.clone())
        .principal_first_seen_cues(true)
        .build()
        .await?;
    startup_phase("runtime_build");
    // Register before capturing the startup frontier. Reset old readers before
    // opening HTTP; startup/recovery facts after this point must be published.
    let feed = runtime.subscribe_host_observer();
    let initial = store
        .query(QueryFilter {
            latest_k: Some(1),
            ..Default::default()
        })
        .await?
        .last()
        .and_then(|event| event.sequence)
        .unwrap_or(0);
    let mut observer_queue = ObserverQueue::new(store.compute_fence(), initial)?;
    store.install_observer_progress(observer_queue.progress())?;
    flush_observers(&mut observer_queue, &observers, &store).await?;
    startup_phase("observer_frontier");
    let mut observer_task = tokio::spawn(publish_observers(
        observer_queue,
        feed,
        store.clone(),
        observers,
    ));
    runtime.start().await?;
    startup_phase("runtime_start");
    // Provision the one Agent's primary Session without claiming it for the
    // local operator. The verified user gateway binds its Principal separately.
    store.ensure_session(initial_session).await?;
    startup_phase("primary_session");
    store.complete_recovery().await?;
    startup_phase("recovery_commit");
    let bind = required("MORPHZ_BIND")?;
    let gate = Arc::new(HostRequestGate::default());
    Server::new(runtime.clone(), defaults)
        .with_identity(gateway_identity)
        .with_host_request_gate(gate.clone())
        .start(&bind)
        .await?;
    startup_phase("http_ready");
    tracing::info!(
        event_code = "host.ready",
        compute_mode = compute_policy.name(),
        "Hosted Runtime restored and ready"
    );
    let mut last_park_probe = Instant::now();
    let mut park_probe_interval = compute_policy.idle_timeout();
    loop {
        tokio::select! {
            result = tokio::signal::ctrl_c() => { result?; return Ok(()); },
            result = &mut observer_task => {
                result??;
                return Err("host observer stopped; process must be replaced".into());
            },
            () = tokio::time::sleep(Duration::from_millis(100)) => {
                if store.ownership_lost() { return Err("compute ownership lost; process must be replaced".into()); }
                // A busy native owner must not cause a Store scan every 100ms.
                // Always-on only disables automatic idle park. The ownership
                // check above still stops obsolete or administratively fenced
                // compute, and the independent Store lease still renews.
                if park_probe_interval.is_some_and(|interval| last_park_probe.elapsed() >= interval) {
                    last_park_probe = Instant::now();
                    park_probe_interval = Some(Duration::from_secs(5));
                    if let Some(attempt) = gate.begin_park(compute_policy.idle_timeout().expect("on-demand park")) {
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

async fn flush_observers(
    queue: &mut ObserverQueue,
    transport: &HttpObserverTransport,
    store: &RemoteRuntimeStore,
) -> Result<(), StoreError> {
    while queue.is_pending() {
        let publication = queue
            .begin_publication()
            .ok_or("observer publication is fenced")?;
        let receipt = transport
            .publish(&store.compute_fence(), publication.batch())
            .await?;
        publication.acknowledge(receipt)?;
    }
    Ok(())
}

async fn publish_observers(
    mut queue: ObserverQueue,
    feed: HostObserverFeed,
    store: Arc<RemoteRuntimeStore>,
    transport: HttpObserverTransport,
) -> Result<(), StoreError> {
    let mut last_durable_read = Instant::now();
    let mut more = true;
    loop {
        if store.ownership_lost() {
            return Ok(());
        }
        if !more {
            tokio::select! {
                () = feed.changed() => {},
                () = tokio::time::sleep(Duration::from_secs(1)) => {},
            }
            // Batch rapid draft chunks without blocking their EventBus producer.
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let (drafts, reset, changed) = feed.take();
        let durable = if more || changed || last_durable_read.elapsed() >= Duration::from_secs(1) {
            let events = store
                .query(QueryFilter {
                    after_sequence: Some(queue.through()),
                    top_k: Some(64),
                    ..Default::default()
                })
                .await?;
            last_durable_read = Instant::now();
            events
        } else {
            Vec::new()
        };
        more = durable.len() == 64;
        // A park decision may temporarily freeze staging. Retain the exact
        // inputs until it reopens, or let ownership loss terminate this owner.
        while !queue.try_stage(&durable, &drafts, reset)? {
            if store.ownership_lost() {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        flush_observers(&mut queue, &transport, &store).await?;
    }
}
