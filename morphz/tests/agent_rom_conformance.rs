//! Actual SQL authority tests, shared by SQLite and PostgreSQL.
use morphz::agent_rom::*;
use morphz::memory::postgres::PostgresStore;
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{
    AgentRomStore, NewAgent, NewCognitiveContext, NewPrincipal, NewSession, NewThread,
    RuntimeStore, SessionMountKind, ThreadKind, ThreadSupervision,
};
use std::sync::Arc;

fn command(
    agent: &str,
    namespace: &str,
    principal: Option<&str>,
    id: &str,
    revision: u64,
    body: &str,
) -> PutAgentRomCommand {
    PutAgentRomCommand {
        command_id: id.into(),
        expected_revision: revision,
        key: AgentRomKey {
            agent_id: agent.into(),
            namespace: namespace.into(),
            principal_scope: principal.map(str::to_owned),
        },
        schema_tag: "example/v1".into(),
        body_sexpr: body.into(),
        enabled: true,
    }
}

async fn setup<S: RuntimeStore>(
    store: &S,
    prefix: &str,
) -> (String, String, String, String, String) {
    let (agent, context, session, a, b) = (
        format!("{prefix}-agent"),
        format!("{prefix}-context"),
        format!("{prefix}-session"),
        format!("{prefix}-alice"),
        format!("{prefix}-bob"),
    );
    store
        .create_agent_bundle(
            NewAgent {
                id: agent.clone(),
                title: "ROM conformance".into(),
                root_context_id: context.clone(),
            },
            NewCognitiveContext {
                id: context.clone(),
                agent_id: agent.clone(),
                title: "Context".into(),
            },
            NewSession {
                id: session.clone(),
                agent_id: agent.clone(),
                context_id: context.clone(),
                parent_session_id: None,
                title: "Session".into(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await
        .unwrap();
    for principal in [&a, &b] {
        store
            .ensure_principal(NewPrincipal {
                id: principal.clone(),
                provider_id: "test-ingress".into(),
                assurance: "authenticated".into(),
                display_name: None,
            })
            .await
            .unwrap();
    }
    (agent, context, session, a, b)
}

async fn thread<S: RuntimeStore>(
    store: &S,
    ids: &(String, String, String, String, String),
    suffix: &str,
    principal: Option<&str>,
) -> String {
    let id = format!("{}-{suffix}", ids.0);
    store
        .ensure_thread(NewThread {
            model_alias: None,
            reasoning_effort: None,
            id: id.clone(),
            agent_id: ids.0.clone(),
            context_id: ids.1.clone(),
            session_id: ids.2.clone(),
            initiating_principal_id: principal.map(str::to_owned),
            root_turn_id: format!("{id}-root"),
            kind: ThreadKind::Execution,
            executor_kind: "runtime".into(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::legacy(),
        })
        .await
        .unwrap();
    id
}

fn committed(result: AgentRomMutation) -> AgentRomRecord {
    match result {
        AgentRomMutation::Committed { record, .. } => record,
        other => panic!("Expected commit: {other:?}"),
    }
}

async fn conformance<S: RuntimeStore + 'static>(store: Arc<S>, prefix: &str) {
    let ids = setup(&*store, prefix).await;
    let empty_thread = thread(&*store, &ids, "bound-empty", Some(&ids.3)).await;
    let empty = store.bind_thread_rom(&empty_thread).await.unwrap();
    assert!(empty.entries.is_empty());
    assert_eq!(empty.context_rom().unwrap(), None);
    let initial = command(
        &ids.0,
        "example.agent",
        None,
        &format!("{prefix}-create"),
        0,
        "(factory (public-name Nora))",
    );
    let first = store
        .put_agent_rom(initial.clone(), "trusted-host")
        .await
        .unwrap();
    let v1 = committed(first.clone());
    assert_eq!(v1.revision, 1);
    assert_eq!(
        store.get_agent_rom(&initial.key).await.unwrap(),
        Some(v1.clone())
    );
    assert_eq!(
        store.list_agent_rom(&ids.0, None).await.unwrap(),
        vec![v1.clone()]
    );
    assert_eq!(
        store.bind_thread_rom(&empty_thread).await.unwrap(),
        empty,
        "None is a frozen binding, not unbound"
    );
    let mut duplicate = initial.clone();
    duplicate.body_sexpr = " ( factory ( public-name \"Nora\" ) ) ".into();
    match store
        .put_agent_rom(duplicate, "trusted-host")
        .await
        .unwrap()
    {
        AgentRomMutation::Committed {
            record, duplicate, ..
        } => {
            assert!(duplicate);
            assert_eq!(record, v1)
        }
        other => panic!("{other:?}"),
    }
    assert!(store
        .put_agent_rom(initial.clone(), "other-host")
        .await
        .unwrap_err()
        .is::<AgentRomError>());
    let mut altered = initial.clone();
    altered.body_sexpr = "(factory (public-name other))".into();
    assert!(store.put_agent_rom(altered, "trusted-host").await.is_err());
    let stale = command(
        &ids.0,
        "example.agent",
        None,
        &format!("{prefix}-stale"),
        0,
        "(factory changed)",
    );
    assert!(
        matches!(store.put_agent_rom(stale,"trusted-host").await.unwrap(),AgentRomMutation::Conflict{current:Some(record)} if record==v1)
    );
    for (scope, name) in [(&ids.3, "Alice"), (&ids.4, "Bob")] {
        store
            .put_agent_rom(
                command(
                    &ids.0,
                    "example.human",
                    Some(scope),
                    &format!("{prefix}-{name}"),
                    0,
                    &format!("(human (call-me {name}))"),
                ),
                "trusted-host",
            )
            .await
            .unwrap();
    }
    let private = store.list_agent_rom(&ids.0, Some(&ids.3)).await.unwrap();
    assert_eq!(private.len(), 1);
    assert!(private[0].canonical_sexpr.contains("Alice"));
    assert_eq!(
        store.list_agent_rom(&ids.0, None).await.unwrap().len(),
        1,
        "No private records in public listing"
    );
    let old_id = thread(&*store, &ids, "alice-old", Some(&ids.3)).await;
    let old = store.bind_thread_rom(&old_id).await.unwrap();
    assert_eq!(old.entries.len(), 2);
    assert!(!old
        .context_rom()
        .unwrap()
        .unwrap()
        .to_string()
        .contains("Bob"));
    let anonymous = store
        .bind_thread_rom(&thread(&*store, &ids, "anonymous", None).await)
        .await
        .unwrap();
    assert_eq!(
        anonymous.entries.len(),
        1,
        "None initiator never falls back to Session participant"
    );
    let v2 = committed(
        store
            .put_agent_rom(
                command(
                    &ids.0,
                    "example.agent",
                    None,
                    &format!("{prefix}-rename"),
                    1,
                    "(factory (public-name Vega))",
                ),
                "trusted-host",
            )
            .await
            .unwrap(),
    );
    assert_eq!(v2.revision, 2);
    assert_eq!(
        store.bind_thread_rom(&old_id).await.unwrap(),
        old,
        "Existing Thread cannot jump to latest head"
    );
    assert_eq!(
        store.get_thread_rom(&old_id).await.unwrap(),
        Some(old.clone())
    );
    let new = store
        .bind_thread_rom(&thread(&*store, &ids, "alice-new", Some(&ids.3)).await)
        .await
        .unwrap();
    assert_ne!(new.manifest_hash, old.manifest_hash);
    assert!(new
        .context_rom()
        .unwrap()
        .unwrap()
        .to_string()
        .contains("Vega"));
    match store.put_agent_rom(initial, "trusted-host").await.unwrap() {
        AgentRomMutation::Committed {
            record, duplicate, ..
        } => {
            assert!(duplicate);
            assert_eq!(
                record, v1,
                "Receipt retries return original immutable version, not current head"
            )
        }
        other => panic!("{other:?}"),
    }
    let mut disabled = command(
        &ids.0,
        "example.agent",
        None,
        &format!("{prefix}-disable"),
        2,
        "(factory (public-name Vega))",
    );
    disabled.enabled = false;
    committed(store.put_agent_rom(disabled, "trusted-host").await.unwrap());
    assert_eq!(
        store.bind_thread_rom(&old_id).await.unwrap(),
        old,
        "Disable cannot rewrite historical mount"
    );
    assert_eq!(
        store
            .bind_thread_rom(&thread(&*store, &ids, "after-disable", None).await)
            .await
            .unwrap()
            .entries
            .len(),
        0
    );
    let bad_principal = command(
        &ids.0,
        "example.missing",
        Some("absent-principal"),
        &format!("{prefix}-missing-principal"),
        0,
        "(human nope)",
    );
    assert!(store
        .put_agent_rom(bad_principal.clone(), "trusted-host")
        .await
        .is_err());
    assert!(
        store
            .get_agent_rom(&bad_principal.key)
            .await
            .unwrap()
            .is_none(),
        "Failed FK must roll back head and version"
    );
    assert!(matches!(
        store
            .put_agent_rom(
                command(
                    "absent-agent",
                    "example.profile",
                    None,
                    &format!("{prefix}-absent"),
                    0,
                    "(a b)"
                ),
                "host"
            )
            .await
            .unwrap(),
        AgentRomMutation::NotFound
    ));
    // Concurrent clients cannot both commit from the same exact revision.
    let x = command(
        &ids.0,
        "example.race",
        None,
        &format!("{prefix}-race-a"),
        0,
        "(config a)",
    );
    let mut y = x.clone();
    y.command_id = format!("{prefix}-race-b");
    y.body_sexpr = "(config b)".into();
    let (x, y) = tokio::join!(
        store.put_agent_rom(x, "host"),
        store.put_agent_rom(y, "host")
    );
    assert_eq!(
        [x.unwrap(), y.unwrap()]
            .iter()
            .filter(|result| matches!(result, AgentRomMutation::Committed { .. }))
            .count(),
        1
    );
    let race_thread = thread(&*store, &ids, "bind-race", Some(&ids.4)).await;
    let (a, b) = tokio::join!(
        store.bind_thread_rom(&race_thread),
        store.bind_thread_rom(&race_thread)
    );
    assert_eq!(a.unwrap(), b.unwrap());
    // A second Agent with the same namespace must have isolated authority.
    let other = setup(&*store, &format!("{prefix}-other")).await;
    assert!(store
        .list_agent_rom(&other.0, None)
        .await
        .unwrap()
        .is_empty());
    assert!(store
        .bind_thread_rom(&thread(&*store, &other, "other", Some(&other.3)).await)
        .await
        .unwrap()
        .entries
        .is_empty());
    // Invalid canonical bodies and selected aggregate overflow never commit.
    let limits = setup(&*store, &format!("{prefix}-limits")).await;
    let large = format!("(config \"{}\")", "x".repeat(8000));
    for n in 0..4 {
        committed(
            store
                .put_agent_rom(
                    command(
                        &limits.0,
                        &format!("example.item{n}"),
                        None,
                        &format!("{prefix}-large{n}"),
                        0,
                        &large,
                    ),
                    "host",
                )
                .await
                .unwrap(),
        );
    }
    let overflow = command(
        &limits.0,
        "example.human",
        Some(&limits.3),
        &format!("{prefix}-overflow"),
        0,
        &large,
    );
    assert!(store.put_agent_rom(overflow.clone(), "host").await.is_err());
    assert!(store.get_agent_rom(&overflow.key).await.unwrap().is_none());
    let invalid = command(
        &limits.0,
        "example.invalid",
        None,
        &format!("{prefix}-invalid"),
        0,
        "(unterminated",
    );
    assert!(store.put_agent_rom(invalid.clone(), "host").await.is_err());
    assert!(store.get_agent_rom(&invalid.key).await.unwrap().is_none());

    // A new public entry must not invalidate an existing private selection.
    let private_first = setup(&*store, &format!("{prefix}-private-first")).await;
    committed(
        store
            .put_agent_rom(
                command(
                    &private_first.0,
                    "example.human",
                    Some(&private_first.3),
                    &format!("{prefix}-private-first-human"),
                    0,
                    &large,
                ),
                "host",
            )
            .await
            .unwrap(),
    );
    for n in 0..3 {
        committed(
            store
                .put_agent_rom(
                    command(
                        &private_first.0,
                        &format!("example.public{n}"),
                        None,
                        &format!("{prefix}-private-first-public{n}"),
                        0,
                        &large,
                    ),
                    "host",
                )
                .await
                .unwrap(),
        );
    }
    let overflow_public = command(
        &private_first.0,
        "example.public3",
        None,
        &format!("{prefix}-private-first-public3"),
        0,
        &large,
    );
    let error = store
        .put_agent_rom(overflow_public.clone(), "host")
        .await
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<AgentRomError>(),
        Some(AgentRomError::Invalid(_))
    ));
    assert!(store
        .get_agent_rom(&overflow_public.key)
        .await
        .unwrap()
        .is_none());

    // Disabling does not evade the configuration-head bound or delete history.
    let head_limits = setup(&*store, &format!("{prefix}-head-limits")).await;
    for n in 0..ROM_MAX_SELECTED_ENTRIES {
        let mut disabled = command(
            &head_limits.0,
            &format!("example.disabled{n}"),
            None,
            &format!("{prefix}-disabled{n}"),
            0,
            "(config disabled)",
        );
        disabled.enabled = false;
        committed(store.put_agent_rom(disabled, "host").await.unwrap());
    }
    let excess_head = command(
        &head_limits.0,
        "example.excess",
        None,
        &format!("{prefix}-excess-head"),
        0,
        "(config excess)",
    );
    let error = store
        .put_agent_rom(excess_head.clone(), "host")
        .await
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<AgentRomError>(),
        Some(AgentRomError::Invalid(_))
    ));
    assert!(store
        .get_agent_rom(&excess_head.key)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        store
            .list_agent_rom(&head_limits.0, None)
            .await
            .unwrap()
            .len(),
        ROM_MAX_SELECTED_ENTRIES
    );
}

#[tokio::test]
async fn sqlite_rom_authority_conformance_and_reopen() {
    let dir = tempfile::TempDir::new().unwrap();
    let db = dir.path().join("rom.db");
    let store = Arc::new(SqliteStore::new(db.to_str().unwrap()).await.unwrap());
    conformance(store.clone(), "sqlite-rom").await;
    let before = store
        .get_thread_rom("sqlite-rom-agent-alice-old")
        .await
        .unwrap();
    drop(store);
    let reopened = SqliteStore::new(db.to_str().unwrap()).await.unwrap();
    assert_eq!(
        reopened
            .get_thread_rom("sqlite-rom-agent-alice-old")
            .await
            .unwrap(),
        before
    );
    assert_eq!(
        reopened
            .bind_thread_rom("sqlite-rom-agent-alice-old")
            .await
            .unwrap(),
        before.unwrap()
    );
}

#[tokio::test]
async fn postgres_rom_authority_conformance_and_reopen() {
    let Ok(url) = std::env::var("MORPHZ_TEST_POSTGRES_URL") else {
        eprintln!("SKIP: MORPHZ_TEST_POSTGRES_URL is not configured");
        return;
    };
    let store = Arc::new(PostgresStore::new(&url, 8).await.unwrap());
    let prefix = format!(
        "pg-rom-{}",
        chrono::Utc::now().timestamp_nanos_opt().unwrap()
    );
    conformance(store.clone(), &prefix).await;
    let old_id = format!("{prefix}-agent-alice-old");
    let before = store.get_thread_rom(&old_id).await.unwrap();
    drop(store);
    let reopened = PostgresStore::new(&url, 8).await.unwrap();
    assert_eq!(reopened.get_thread_rom(&old_id).await.unwrap(), before);
    assert_eq!(
        reopened.bind_thread_rom(&old_id).await.unwrap(),
        before.unwrap()
    );
}

#[tokio::test]
async fn sqlite_upgrade_freezes_legacy_thread_empty_once() {
    let dir = tempfile::TempDir::new().unwrap();
    let db = dir.path().join("legacy.db");
    let store = SqliteStore::new(db.to_str().unwrap()).await.unwrap();
    let ids = setup(&store, "legacy-rom").await;
    let old_id = thread(&store, &ids, "old-unbound", Some(&ids.3)).await;
    drop(store);
    // Simulate the pre-ROM migration marker in this isolated disposable DB.
    let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}", db.display()))
        .await
        .unwrap();
    sqlx::query("DELETE FROM schema_migrations WHERE version='20261002_01_agent_rom'")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let store = SqliteStore::new(db.to_str().unwrap()).await.unwrap();
    assert!(store
        .get_thread_rom(&old_id)
        .await
        .unwrap()
        .unwrap()
        .entries
        .is_empty());
    committed(
        store
            .put_agent_rom(
                command(
                    &ids.0,
                    "example.agent",
                    None,
                    "legacy-rom-persona",
                    0,
                    "(factory name)",
                ),
                "host",
            )
            .await
            .unwrap(),
    );
    let new_id = thread(&store, &ids, "new-unbound", Some(&ids.3)).await;
    drop(store);
    let reopened = SqliteStore::new(db.to_str().unwrap()).await.unwrap();
    assert!(reopened
        .bind_thread_rom(&old_id)
        .await
        .unwrap()
        .entries
        .is_empty());
    assert_eq!(
        reopened
            .bind_thread_rom(&new_id)
            .await
            .unwrap()
            .entries
            .len(),
        1,
        "Restart must not backfill post-migration new work empty"
    );
}

#[cfg(feature = "remote-store")]
#[tokio::test]
#[ignore = "requires an isolated real Agent Cell workerd conformance endpoint"]
async fn remote_rom_authority_conformance_real_workerd() {
    use morphz::memory::remote::{
        http::HttpRemoteStoreTransport,
        protocol::{Commit, Fence, Head, Page, RemoteStoreTransport, StoreError},
        RemoteRuntimeStore,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    struct ResponseLoss {
        inner: HttpRemoteStoreTransport,
        lose: AtomicBool,
    }
    #[async_trait::async_trait]
    impl RemoteStoreTransport for ResponseLoss {
        async fn head(&self, fence: &Fence) -> Result<Head, StoreError> {
            self.inner.head(fence).await
        }
        async fn page(
            &self,
            fence: &Fence,
            revision: u64,
            after: Option<&str>,
        ) -> Result<Page, StoreError> {
            self.inner.page(fence, revision, after).await
        }
        async fn commit(&self, fence: &Fence, request: &Commit) -> Result<Head, StoreError> {
            let result = self.inner.commit(fence, request).await?;
            if self.lose.swap(false, Ordering::SeqCst) {
                Err("injected ROM receipt response loss after durable commit".into())
            } else {
                Ok(result)
            }
        }
    }
    let base = std::env::var("MORPHZ_TEST_REMOTE_STORE_URL")
        .expect("Explicit isolated workerd endpoint required");
    assert!(
        base.starts_with("http://127.0.0.1:"),
        "This destructive fixture gate accepts loopback only, not production"
    );
    let prefix = format!(
        "remote-rom-{}",
        chrono::Utc::now().timestamp_nanos_opt().unwrap()
    );
    let transport = Arc::new(ResponseLoss {
        inner: HttpRemoteStoreTransport::new(&format!("{base}{prefix}"), "conformance-only")
            .unwrap(),
        lose: AtomicBool::new(false),
    });
    let fence = Fence {
        owner_id: "runtime-conformance-owner".into(),
        epoch: 1,
    };
    let store = Arc::new(
        RemoteRuntimeStore::connect(transport.clone(), fence.clone())
            .await
            .unwrap(),
    );
    conformance(store.clone(), &prefix).await;
    let agent = format!("{prefix}-agent");
    let command = command(
        &agent,
        "example.response-loss",
        None,
        &format!("{prefix}-response-loss"),
        0,
        "(factory durable)",
    );
    transport.lose.store(true, Ordering::SeqCst);
    assert!(
        store.put_agent_rom(command.clone(), "host").await.is_err(),
        "An ambiguous remote commit cannot acknowledge the speculative record"
    );
    assert_eq!(
        store
            .get_agent_rom(&command.key)
            .await
            .unwrap()
            .unwrap()
            .revision,
        1,
        "Next read restores the actual remote authority"
    );
    match store.put_agent_rom(command.clone(), "host").await.unwrap() {
        AgentRomMutation::Committed { duplicate, .. } => assert!(duplicate),
        other => panic!("{other:?}"),
    }
    assert!(
        store
            .put_agent_rom(command, "forged-other-host")
            .await
            .unwrap_err()
            .is::<AgentRomError>(),
        "Remote Store preserves domain command-reuse errors after its independent fence validation"
    );
    let old_id = format!("{prefix}-agent-alice-old");
    let old = store.get_thread_rom(&old_id).await.unwrap();
    drop(store);
    let recovered = RemoteRuntimeStore::connect(transport, fence).await.unwrap();
    assert_eq!(recovered.get_thread_rom(&old_id).await.unwrap(), old);
    assert_eq!(
        recovered.bind_thread_rom(&old_id).await.unwrap(),
        old.unwrap()
    );
}
