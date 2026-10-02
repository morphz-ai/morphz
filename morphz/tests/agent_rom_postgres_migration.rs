//! Isolated real PostgreSQL upgrade and independent-store concurrency checks.
use morphz::agent_rom::{AgentRomKey, AgentRomMutation, PutAgentRomCommand};
use morphz::memory::postgres::PostgresStore;
use morphz::memory::{
    AgentRomStore, NewAgent, NewCognitiveContext, NewPrincipal, NewSession, NewThread,
    SessionDirectoryStore, SessionMountKind, ThreadKind, ThreadStore, ThreadSupervision,
};
use std::sync::Arc;

fn command(id: &str, revision: u64, name: &str) -> PutAgentRomCommand {
    PutAgentRomCommand {
        command_id: id.into(),
        expected_revision: revision,
        key: AgentRomKey {
            agent_id: "agent".into(),
            namespace: "example.profile".into(),
            principal_scope: None,
        },
        schema_tag: "example/v1".into(),
        body_sexpr: format!("(profile (name {name}))"),
        authoring_state_sexpr: None,
        enabled: true,
    }
}

async fn thread(store: &PostgresStore, id: &str) {
    store
        .ensure_thread(NewThread {
            id: id.into(),
            agent_id: "agent".into(),
            context_id: "context".into(),
            session_id: "session".into(),
            initiating_principal_id: Some("human".into()),
            root_turn_id: format!("{id}-root"),
            kind: ThreadKind::Execution,
            executor_kind: "runtime".into(),
            executor_id: None,
            target_id: None,
            model_alias: None,
            reasoning_effort: None,
            supervision: ThreadSupervision::legacy(),
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn postgres_legacy_mount_and_two_independent_store_instances() {
    let Ok(url) = std::env::var("MORPHZ_TEST_POSTGRES_URL") else {
        return;
    };
    // Generated identifier is the only schema that this test can drop.
    let schema = format!(
        "rom_upgrade_{}_{}",
        std::process::id(),
        chrono::Utc::now()
            .timestamp_nanos_opt()
            .unwrap()
            .unsigned_abs()
    );
    let admin = sqlx::PgPool::connect(&url).await.unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await
        .unwrap();
    let separator = if url.contains('?') { '&' } else { '?' };
    let scoped = format!("{url}{separator}options=-csearch_path%3D{schema}%2Cpublic");
    let pool = sqlx::PgPool::connect(&scoped).await.unwrap();
    let store = PostgresStore::new(&scoped, 4).await.unwrap();
    store
        .create_agent_bundle(
            NewAgent {
                id: "agent".into(),
                title: "Agent".into(),
                root_context_id: "context".into(),
            },
            NewCognitiveContext {
                id: "context".into(),
                agent_id: "agent".into(),
                title: "Context".into(),
            },
            NewSession {
                id: "session".into(),
                agent_id: "agent".into(),
                context_id: "context".into(),
                parent_session_id: None,
                title: "Session".into(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await
        .unwrap();
    store
        .ensure_principal(NewPrincipal {
            id: "human".into(),
            provider_id: "test".into(),
            assurance: "authenticated".into(),
            display_name: None,
        })
        .await
        .unwrap();
    thread(&store, "old").await;
    drop(store);
    // Reconstruct only the pre-ROM boundary; all existing identity/work rows remain.
    let mut tx = pool.begin().await.unwrap();
    for table in [
        "thread_rom_bindings",
        "thread_rom_mounts",
        "agent_rom_command_receipts",
        "agent_rom_versions",
        "agent_rom_heads",
    ] {
        sqlx::query(&format!("DROP TABLE {table}"))
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    sqlx::query("DELETE FROM schema_migrations WHERE version IN ('20261002_01_agent_rom','20261002_02_agent_rom_authoring_state')")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let first = Arc::new(PostgresStore::new(&scoped, 4).await.unwrap());
    let legacy = first.get_thread_rom("old").await.unwrap().unwrap();
    assert!(legacy.entries.is_empty());
    assert!(legacy.context_rom().unwrap().is_none());
    assert!(matches!(
        first
            .put_agent_rom(command("create", 0, "Nora"), "host")
            .await
            .unwrap(),
        AgentRomMutation::Committed { .. }
    ));
    thread(&first, "new").await;
    let second = Arc::new(PostgresStore::new(&scoped, 4).await.unwrap());
    assert!(second
        .bind_thread_rom("old")
        .await
        .unwrap()
        .entries
        .is_empty());
    // Opening a second Host must not backfill a post-upgrade Thread as empty.
    let (a, b) = tokio::join!(first.bind_thread_rom("new"), second.bind_thread_rom("new"));
    let mounted = a.unwrap();
    assert_eq!(mounted, b.unwrap());
    assert_eq!(mounted.entries.len(), 1);
    assert_eq!(mounted.entries[0].revision, 1);
    let (a, b) = tokio::join!(
        first.put_agent_rom(command("write-a", 1, "A"), "host"),
        second.put_agent_rom(command("write-b", 1, "B"), "host")
    );
    let results = [a.unwrap(), b.unwrap()];
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, AgentRomMutation::Committed { .. }))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, AgentRomMutation::Conflict { .. }))
            .count(),
        1
    );
    let (winner, receipt) = results
        .iter()
        .find_map(|r| match r {
            AgentRomMutation::Committed {
                record, receipt, ..
            } => Some((record, receipt)),
            _ => None,
        })
        .unwrap();
    assert_eq!(winner.revision, 2);
    let replay = if receipt.command_id == "write-a" {
        command("write-a", 1, "A")
    } else {
        command("write-b", 1, "B")
    };
    assert!(
        matches!(second.put_agent_rom(replay.clone(), "host").await.unwrap(), AgentRomMutation::Committed { duplicate: true, record, .. } if record == *winner)
    );
    assert!(second.put_agent_rom(replay, "other-host").await.is_err());
    assert_eq!(first.bind_thread_rom("new").await.unwrap(), mounted);
    thread(&second, "latest").await;
    assert_eq!(
        second.bind_thread_rom("latest").await.unwrap().entries[0].revision,
        2
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM schema_migrations WHERE version='20261002_01_agent_rom'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    let winner = winner.clone();
    let old = mounted.clone();
    drop(first);
    drop(second);
    // Reconstruct the actual previous ROM schema, preserving its current head,
    // historical version/receipt rows and Thread bindings for the upgrade.
    sqlx::query("ALTER TABLE agent_rom_versions DROP COLUMN canonical_authoring_state")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "DELETE FROM schema_migrations WHERE version='20261002_02_agent_rom_authoring_state'",
    )
    .execute(&pool)
    .await
    .unwrap();
    let upgraded = PostgresStore::new(&scoped, 4).await.unwrap();
    assert_eq!(
        upgraded
            .get_agent_rom(&command("read", 0, "unused").key)
            .await
            .unwrap(),
        Some(winner)
    );
    assert_eq!(
        upgraded.get_thread_rom("new").await.unwrap(),
        Some(old.clone())
    );
    assert_eq!(upgraded.bind_thread_rom("new").await.unwrap(), old);
    let legacy_hash = sqlx::query_scalar::<_, String>(
        "SELECT request_hash FROM agent_rom_command_receipts WHERE command_id='create'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    match upgraded
        .put_agent_rom(command("create", 0, "Nora"), "host")
        .await
        .unwrap()
    {
        AgentRomMutation::Committed {
            record,
            receipt,
            duplicate,
        } => {
            assert!(duplicate);
            assert_eq!(record.revision, 1);
            assert!(record.canonical_authoring_state.is_none());
            assert_eq!(receipt.request_hash, legacy_hash);
        }
        other => panic!("{other:?}"),
    }
    let mut authored = command("save-authoring", 2, "Nora");
    authored.authoring_state_sexpr =
        Some("(editor (custom RETAIN_PG_EDITOR) (enabled false))".into());
    let v3 = match upgraded
        .put_agent_rom(authored.clone(), "host")
        .await
        .unwrap()
    {
        AgentRomMutation::Committed { record, .. } => record,
        other => panic!("{other:?}"),
    };
    thread(&upgraded, "after-authoring").await;
    let projection = upgraded.bind_thread_rom("after-authoring").await.unwrap();
    assert_eq!(projection.entries[0].revision, 3);
    assert!(!serde_json::to_string(&projection)
        .unwrap()
        .contains("RETAIN_PG_EDITOR"));
    drop(upgraded);
    for _ in 0..2 {
        let reopened = PostgresStore::new(&scoped, 4).await.unwrap();
        assert_eq!(
            reopened.get_agent_rom(&authored.key).await.unwrap(),
            Some(v3.clone())
        );
        assert_eq!(reopened.bind_thread_rom("new").await.unwrap(), old);
        assert!(
            matches!(reopened.put_agent_rom(authored.clone(), "host").await.unwrap(), AgentRomMutation::Committed { duplicate: true, record, .. } if record == v3)
        );
    }
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM schema_migrations WHERE version='20261002_02_agent_rom_authoring_state'").fetch_one(&pool).await.unwrap(), 1);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM agent_rom_versions WHERE canonical_authoring_state IS NULL"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        2
    );
    pool.close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}
