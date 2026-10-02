//! Actual Custom SQL authority tests, shared by SQLite and PostgreSQL.
use morphz::context::*;
use morphz::memory::postgres::PostgresStore;
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{
    CustomStore, NewAgent, NewCognitiveContext, NewPrincipal, NewSession, NewThread, RuntimeStore,
    SessionMountKind, ThreadKind, ThreadSupervision,
};
use std::sync::Arc;

fn command(
    agent: &str,
    namespace: &str,
    principal: Option<&str>,
    id: &str,
    revision: u64,
    body: &str,
) -> PutCustomCommand {
    PutCustomCommand {
        command_id: id.into(),
        expected_revision: revision,
        key: CustomKey {
            agent_id: agent.into(),
            namespace: namespace.into(),
            principal_scope: principal.map(str::to_owned),
        },
        schema_tag: "example/v1".into(),
        body_sexpr: body.into(),
        authoring_state_sexpr: None,
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
                title: "Custom conformance".into(),
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
            response_annotations: morphz::response_annotations::Protocol::Off,
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

fn committed(result: CustomMutation) -> Custom {
    match result {
        CustomMutation::Committed { record, .. } => record,
        other => panic!("Expected commit: {other:?}"),
    }
}

async fn authoring_conformance<S: RuntimeStore + 'static>(store: Arc<S>, prefix: &str) {
    let ids = setup(&*store, &format!("{prefix}-authoring")).await;
    let mut on = command(
        &ids.0,
        "example.profile",
        None,
        &format!("{prefix}-author-on"),
        0,
        "(profile (name Nora) (custom RETAIN_THIS_STYLE))",
    );
    on.authoring_state_sexpr =
        Some("(editor (custom RETAIN_THIS_STYLE) (custom-enabled true))".into());
    let v1 = committed(store.put_custom(on.clone(), "host").await.unwrap());
    let old_id = thread(&*store, &ids, "old", Some(&ids.3)).await;
    let old = store.bind_thread_custom(&old_id).await.unwrap();
    assert!(old
        .entries
        .iter()
        .all(|entry| entry.canonical_authoring_state.is_none()));
    assert!(old
        .context_custom()
        .unwrap()
        .unwrap()
        .to_string()
        .contains("RETAIN_THIS_STYLE"));

    let mut off = command(
        &ids.0,
        "example.profile",
        None,
        &format!("{prefix}-author-off"),
        1,
        "(profile (name Nora))",
    );
    off.authoring_state_sexpr =
        Some("(editor (custom RETAIN_THIS_STYLE) (custom-enabled false))".into());
    let off_result = store.put_custom(off.clone(), "host").await.unwrap();
    let v2 = committed(off_result.clone());
    assert_eq!(v2.revision, 2);
    assert!(v2
        .canonical_authoring_state
        .as_deref()
        .unwrap()
        .contains("RETAIN_THIS_STYLE"));
    assert!(!v2.canonical_sexpr.contains("RETAIN_THIS_STYLE"));
    assert_eq!(store.get_custom(&off.key).await.unwrap(), Some(v2.clone()));
    assert_eq!(
        store.list_custom(&ids.0, None).await.unwrap(),
        vec![v2.clone()]
    );
    assert_eq!(store.bind_thread_custom(&old_id).await.unwrap(), old);
    let new_id = thread(&*store, &ids, "off", Some(&ids.3)).await;
    let new = store.bind_thread_custom(&new_id).await.unwrap();
    assert_eq!(
        store.get_thread_custom(&new_id).await.unwrap(),
        Some(new.clone())
    );
    assert!(new
        .entries
        .iter()
        .all(|entry| entry.canonical_authoring_state.is_none()));
    assert!(!new
        .context_custom()
        .unwrap()
        .unwrap()
        .to_string()
        .contains("RETAIN_THIS_STYLE"));
    let serialized = serde_json::to_string(&new).unwrap();
    assert!(!serialized.contains("canonical_authoring_state"));
    assert!(!serialized.contains("RETAIN_THIS_STYLE"));

    let mut retry = off.clone();
    retry.authoring_state_sexpr =
        Some(" ( editor ( custom \"RETAIN_THIS_STYLE\" ) ( custom-enabled false ) ) ".into());
    match store.put_custom(retry, "host").await.unwrap() {
        CustomMutation::Committed {
            record,
            receipt,
            duplicate,
        } => {
            assert!(duplicate);
            assert_eq!(record, v2);
            if let CustomMutation::Committed {
                receipt: original, ..
            } = off_result
            {
                assert_eq!(receipt, original);
            }
        }
        other => panic!("{other:?}"),
    }
    let mut reused = off.clone();
    reused.authoring_state_sexpr =
        Some("(editor (custom ALTERED_STYLE) (custom-enabled false))".into());
    assert!(matches!(
        store
            .put_custom(reused, "host")
            .await
            .unwrap_err()
            .downcast_ref::<CustomError>(),
        Some(CustomError::CommandReuse)
    ));
    let mut omitted = off.clone();
    omitted.authoring_state_sexpr = None;
    assert!(store.put_custom(omitted, "host").await.is_err());

    // Two simultaneous CAS commands must atomically choose one complete pair,
    // never a winning body combined with the losing editor state.
    let mut a = command(
        &ids.0,
        "example.profile",
        None,
        &format!("{prefix}-author-cas-a"),
        2,
        "(profile (name A))",
    );
    a.authoring_state_sexpr = Some("(editor (custom PRIVATE_A) (custom-enabled false))".into());
    let mut b = a.clone();
    b.command_id = format!("{prefix}-author-cas-b");
    b.body_sexpr = "(profile (name B))".into();
    b.authoring_state_sexpr = Some("(editor (custom PRIVATE_B) (custom-enabled false))".into());
    let (a_result, b_result) = tokio::join!(
        store.put_custom(a.clone(), "host"),
        store.put_custom(b.clone(), "host")
    );
    let results = [a_result.unwrap(), b_result.unwrap()];
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, CustomMutation::Committed { .. }))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, CustomMutation::Conflict { .. }))
            .count(),
        1
    );
    let winner = results
        .iter()
        .find_map(|r| match r {
            CustomMutation::Committed { record, .. } => Some(record),
            _ => None,
        })
        .unwrap();
    let winning_command = if winner.canonical_sexpr == a.body_sexpr {
        &a
    } else {
        &b
    };
    assert_eq!(winner.revision, 3);
    assert_eq!(
        winner.canonical_authoring_state,
        winning_command.authoring_state_sexpr
    );
    assert_eq!(
        store.get_custom(&off.key).await.unwrap().as_ref(),
        Some(winner)
    );
    assert_eq!(store.bind_thread_custom(&new_id).await.unwrap(), new);
    assert_eq!(
        committed(store.put_custom(off.clone(), "host").await.unwrap()),
        v2,
        "Unknown outcome replay returns the original authoring/body pair, not latest head"
    );

    let mut private = command(
        &ids.0,
        "example.human",
        Some(&ids.3),
        &format!("{prefix}-author-private"),
        0,
        "(human (name Alice))",
    );
    private.authoring_state_sexpr = Some("(editor (private PRIVATE_ALICE_EDITOR))".into());
    let private_v1 = committed(store.put_custom(private, "host").await.unwrap());
    assert_eq!(
        store.list_custom(&ids.0, Some(&ids.3)).await.unwrap(),
        vec![private_v1]
    );
    assert!(store
        .list_custom(&ids.0, Some(&ids.4))
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        store.list_custom(&ids.0, None).await.unwrap(),
        vec![winner.clone()]
    );
    let alice = store
        .bind_thread_custom(&thread(&*store, &ids, "alice", Some(&ids.3)).await)
        .await
        .unwrap();
    assert!(!serde_json::to_string(&alice)
        .unwrap()
        .contains("PRIVATE_ALICE_EDITOR"));
    assert!(alice
        .entries
        .iter()
        .all(|entry| entry.canonical_authoring_state.is_none()));

    let mut invalid = command(
        &ids.0,
        "example.invalid",
        None,
        &format!("{prefix}-author-invalid"),
        0,
        "(profile valid)",
    );
    for bad in [
        "(editor".to_owned(),
        format!("{}a{}", "(".repeat(33), ")".repeat(33)),
        format!("({})", "a ".repeat(4096)),
        format!("(editor \"{}\")", "x".repeat(CUSTOM_MAX_ENTRY_BYTES)),
    ] {
        invalid.authoring_state_sexpr = Some(bad);
        assert!(matches!(
            store
                .put_custom(invalid.clone(), "host")
                .await
                .unwrap_err()
                .downcast_ref::<CustomError>(),
            Some(CustomError::Invalid(_))
        ));
        assert!(store.get_custom(&invalid.key).await.unwrap().is_none());
    }
    assert_eq!(v1.canonical_authoring_state, on.authoring_state_sexpr);
}

async fn empty_enabled_profile_conformance<S: RuntimeStore + 'static>(
    store: &S,
    prefix: &str,
) -> (Custom, ThreadCustomManifest) {
    let ids = setup(store, prefix).await;
    let mut initial = command(
        &ids.0,
        "morphz.profile.agent",
        None,
        &format!("{prefix}-named"),
        0,
        "(agent-profile (version 2) (identity (name Nora)))",
    );
    initial.schema_tag = "morphz-agent-profile/v2".into();
    let named = committed(store.put_custom(initial.clone(), "host").await.unwrap());
    let named_id = thread(store, &ids, "named", None).await;
    let old = store.bind_thread_custom(&named_id).await.unwrap();
    assert_eq!(old.entries, vec![named]);
    let old_bytes = old.context_custom().unwrap().unwrap().to_string();
    let mut empty = initial.clone();
    empty.command_id = format!("{prefix}-empty-on");
    empty.expected_revision = 1;
    empty.body_sexpr = " ( agent-profile ( version 2 ) ) ".into();
    empty.authoring_state_sexpr =
        Some("(editor (custom RETAIN_EMPTY_PROFILE_EDITOR_ONLY) (custom-enabled false))".into());
    let saved = committed(store.put_custom(empty.clone(), "host").await.unwrap());
    assert!(saved.enabled);
    assert_eq!(saved.canonical_sexpr, "(agent-profile (version 2))");
    assert!(saved
        .canonical_authoring_state
        .as_ref()
        .unwrap()
        .contains("RETAIN_EMPTY_PROFILE_EDITOR_ONLY"));
    assert_eq!(
        store.get_custom(&empty.key).await.unwrap(),
        Some(saved.clone())
    );
    assert_eq!(
        store.list_custom(&ids.0, None).await.unwrap(),
        vec![saved.clone()]
    );
    assert_eq!(
        committed(store.put_custom(empty.clone(), "host").await.unwrap()),
        saved
    );
    let empty_id = thread(store, &ids, "empty", None).await;
    let blank = store.bind_thread_custom(&empty_id).await.unwrap();
    assert!(blank.entries.is_empty());
    assert_eq!(blank.manifest_hash, manifest_hash(&[]));
    assert_eq!(blank.compiler_hash, compiler_hash());
    assert_eq!(blank.context_custom().unwrap(), None);
    assert!(!serde_json::to_string(&blank)
        .unwrap()
        .contains("RETAIN_EMPTY_PROFILE_EDITOR_ONLY"));
    assert_eq!(
        store.get_thread_custom(&empty_id).await.unwrap(),
        Some(blank.clone())
    );
    assert_eq!(store.bind_thread_custom(&named_id).await.unwrap(), old);
    assert_eq!(
        store
            .get_thread_custom(&named_id)
            .await
            .unwrap()
            .unwrap()
            .context_custom()
            .unwrap()
            .unwrap()
            .to_string(),
        old_bytes
    );

    let mut restored = initial.clone();
    restored.command_id = format!("{prefix}-restore-named");
    restored.expected_revision = 2;
    let restored = committed(store.put_custom(restored, "host").await.unwrap());
    assert_eq!(
        store.bind_thread_custom(&empty_id).await.unwrap(),
        blank,
        "A frozen empty mount does not acquire later profile fields"
    );
    let restored_id = thread(store, &ids, "restored", None).await;
    assert_eq!(
        store
            .bind_thread_custom(&restored_id)
            .await
            .unwrap()
            .entries,
        vec![restored]
    );
    empty.command_id = format!("{prefix}-empty-again");
    empty.expected_revision = 3;
    let saved = committed(store.put_custom(empty.clone(), "host").await.unwrap());

    let mut other_namespace = empty.clone();
    other_namespace.command_id = format!("{prefix}-other-namespace");
    other_namespace.expected_revision = 0;
    other_namespace.key.namespace = "example.same-empty-body".into();
    let other_namespace = committed(store.put_custom(other_namespace, "host").await.unwrap());
    let mut other_schema = empty.clone();
    other_schema.command_id = format!("{prefix}-other-schema");
    other_schema.expected_revision = 0;
    other_schema.key.principal_scope = Some(ids.3.clone());
    other_schema.schema_tag = "example-agent-profile/v2".into();
    let other_schema = committed(store.put_custom(other_schema, "host").await.unwrap());
    let mut human = empty.clone();
    human.command_id = format!("{prefix}-human-empty");
    human.expected_revision = 0;
    human.key.namespace = "morphz.profile.human".into();
    human.key.principal_scope = Some(ids.3.clone());
    human.schema_tag = "morphz-human-profile/v2".into();
    human.body_sexpr = "(human-profile (version 2))".into();
    let human = committed(store.put_custom(human, "host").await.unwrap());
    let mixed_id = thread(store, &ids, "mixed", Some(&ids.3)).await;
    let mixed = store.bind_thread_custom(&mixed_id).await.unwrap();
    let mut expected = vec![other_namespace, other_schema, human];
    for entry in &mut expected {
        entry.canonical_authoring_state = None;
    }
    expected.sort_by(|a, b| a.key.namespace.cmp(&b.key.namespace));
    assert_eq!(mixed.entries, expected);
    assert!(!serde_json::to_string(&mixed)
        .unwrap()
        .contains("RETAIN_EMPTY_PROFILE_EDITOR_ONLY"));
    assert_eq!(
        store.get_custom(&empty.key).await.unwrap(),
        Some(saved.clone()),
        "Selection never rewrites the saved empty enable switch"
    );
    let historical_id = thread(store, &ids, "historical-empty", None).await;
    (
        saved.clone(),
        ThreadCustomManifest {
            thread_id: historical_id,
            agent_id: ids.0,
            initiating_principal_id: None,
            manifest_hash: manifest_hash(&[saved.clone()]),
            compiler_hash: compiler_hash(),
            bound_at: chrono::Utc::now(),
            entries: vec![saved],
        }
        .without_authoring_state(),
    )
}

#[tokio::test]
async fn sqlite_empty_enabled_agent_profile_omits_only_new_exact_consumer_mounts() {
    let dir = tempfile::TempDir::new().unwrap();
    let db = dir.path().join("empty-enabled-profile.db");
    let store = SqliteStore::new(db.to_str().unwrap()).await.unwrap();
    let (saved, historical) =
        empty_enabled_profile_conformance(&store, "sqlite-empty-enabled").await;
    let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}", db.display()))
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM thread_rom_bindings WHERE thread_id=?")
            .bind("sqlite-empty-enabled-agent-empty")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    // Persist the exact old-version binding shape into this disposable store;
    // a new binary must read it as-is, not retroactively apply head selection.
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO thread_rom_mounts(thread_id,agent_id,initiating_principal_id,manifest_hash,compiler_hash,bound_at) VALUES(?,?,NULL,?,?,?)")
        .bind(&historical.thread_id).bind(&historical.agent_id).bind(&historical.manifest_hash).bind(&historical.compiler_hash).bind(historical.bound_at.to_rfc3339()).execute(&mut *tx).await.unwrap();
    sqlx::query(
        "INSERT INTO thread_rom_bindings(thread_id,entry_id,revision,ordinal) VALUES(?,?,?,0)",
    )
    .bind(&historical.thread_id)
    .bind(&saved.entry_id)
    .bind(saved.revision as i64)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    pool.close().await;
    let historical_bytes = historical.context_custom().unwrap().unwrap().to_string();
    assert_eq!(
        store
            .get_thread_custom(&historical.thread_id)
            .await
            .unwrap(),
        Some(historical.clone())
    );
    assert_eq!(
        store
            .bind_thread_custom(&historical.thread_id)
            .await
            .unwrap(),
        historical
    );
    drop(store);
    let reopened = SqliteStore::new(db.to_str().unwrap()).await.unwrap();
    assert_eq!(reopened.get_custom(&saved.key).await.unwrap(), Some(saved));
    assert_eq!(
        reopened
            .bind_thread_custom(&historical.thread_id)
            .await
            .unwrap(),
        historical
    );
    assert_eq!(
        reopened
            .get_thread_custom(&historical.thread_id)
            .await
            .unwrap()
            .unwrap()
            .context_custom()
            .unwrap()
            .unwrap()
            .to_string(),
        historical_bytes
    );
}

#[tokio::test]
async fn postgres_empty_enabled_agent_profile_omits_only_new_exact_consumer_mounts() {
    let Ok(url) = std::env::var("MORPHZ_TEST_POSTGRES_URL") else {
        eprintln!("SKIP: MORPHZ_TEST_POSTGRES_URL is not configured");
        return;
    };
    let prefix = format!(
        "pg-empty-enabled-{}",
        chrono::Utc::now().timestamp_nanos_opt().unwrap()
    );
    let store = PostgresStore::new(&url, 4).await.unwrap();
    let (saved, historical) = empty_enabled_profile_conformance(&store, &prefix).await;
    let pool = sqlx::PgPool::connect(&url).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM thread_rom_bindings WHERE thread_id=$1")
            .bind(format!("{prefix}-agent-empty"))
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO thread_rom_mounts(thread_id,agent_id,initiating_principal_id,manifest_hash,compiler_hash,bound_at) VALUES($1,$2,NULL,$3,$4,$5)")
        .bind(&historical.thread_id).bind(&historical.agent_id).bind(&historical.manifest_hash).bind(&historical.compiler_hash).bind(historical.bound_at.to_rfc3339()).execute(&mut *tx).await.unwrap();
    sqlx::query(
        "INSERT INTO thread_rom_bindings(thread_id,entry_id,revision,ordinal) VALUES($1,$2,$3,0)",
    )
    .bind(&historical.thread_id)
    .bind(&saved.entry_id)
    .bind(saved.revision as i64)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    pool.close().await;
    let historical_bytes = historical.context_custom().unwrap().unwrap().to_string();
    assert_eq!(
        store
            .get_thread_custom(&historical.thread_id)
            .await
            .unwrap(),
        Some(historical.clone())
    );
    assert_eq!(
        store
            .bind_thread_custom(&historical.thread_id)
            .await
            .unwrap(),
        historical
    );
    drop(store);
    let reopened = PostgresStore::new(&url, 4).await.unwrap();
    assert_eq!(reopened.get_custom(&saved.key).await.unwrap(), Some(saved));
    assert_eq!(
        reopened
            .bind_thread_custom(&historical.thread_id)
            .await
            .unwrap(),
        historical
    );
    assert_eq!(
        reopened
            .get_thread_custom(&historical.thread_id)
            .await
            .unwrap()
            .unwrap()
            .context_custom()
            .unwrap()
            .unwrap()
            .to_string(),
        historical_bytes
    );
}

async fn conformance<S: RuntimeStore + 'static>(store: Arc<S>, prefix: &str) {
    let ids = setup(&*store, prefix).await;
    let empty_thread = thread(&*store, &ids, "bound-empty", Some(&ids.3)).await;
    let empty = store.bind_thread_custom(&empty_thread).await.unwrap();
    assert!(empty.entries.is_empty());
    assert_eq!(empty.context_custom().unwrap(), None);
    let initial = command(
        &ids.0,
        "example.agent",
        None,
        &format!("{prefix}-create"),
        0,
        "(factory (public-name Nora))",
    );
    let first = store
        .put_custom(initial.clone(), "trusted-host")
        .await
        .unwrap();
    let v1 = committed(first.clone());
    assert_eq!(v1.revision, 1);
    assert_eq!(
        store.get_custom(&initial.key).await.unwrap(),
        Some(v1.clone())
    );
    assert_eq!(
        store.list_custom(&ids.0, None).await.unwrap(),
        vec![v1.clone()]
    );
    assert_eq!(
        store.bind_thread_custom(&empty_thread).await.unwrap(),
        empty,
        "None is a frozen binding, not unbound"
    );
    let mut duplicate = initial.clone();
    duplicate.body_sexpr = " ( factory ( public-name \"Nora\" ) ) ".into();
    match store.put_custom(duplicate, "trusted-host").await.unwrap() {
        CustomMutation::Committed {
            record, duplicate, ..
        } => {
            assert!(duplicate);
            assert_eq!(record, v1)
        }
        other => panic!("{other:?}"),
    }
    assert!(store
        .put_custom(initial.clone(), "other-host")
        .await
        .unwrap_err()
        .is::<CustomError>());
    let mut altered = initial.clone();
    altered.body_sexpr = "(factory (public-name other))".into();
    assert!(store.put_custom(altered, "trusted-host").await.is_err());
    let stale = command(
        &ids.0,
        "example.agent",
        None,
        &format!("{prefix}-stale"),
        0,
        "(factory changed)",
    );
    assert!(
        matches!(store.put_custom(stale,"trusted-host").await.unwrap(),CustomMutation::Conflict{current:Some(record)} if record==v1)
    );
    for (scope, name) in [(&ids.3, "Alice"), (&ids.4, "Bob")] {
        store
            .put_custom(
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
    let private = store.list_custom(&ids.0, Some(&ids.3)).await.unwrap();
    assert_eq!(private.len(), 1);
    assert!(private[0].canonical_sexpr.contains("Alice"));
    assert_eq!(
        store.list_custom(&ids.0, None).await.unwrap().len(),
        1,
        "No private records in public listing"
    );
    let old_id = thread(&*store, &ids, "alice-old", Some(&ids.3)).await;
    let old = store.bind_thread_custom(&old_id).await.unwrap();
    assert_eq!(old.entries.len(), 2);
    assert!(!old
        .context_custom()
        .unwrap()
        .unwrap()
        .to_string()
        .contains("Bob"));
    let anonymous = store
        .bind_thread_custom(&thread(&*store, &ids, "anonymous", None).await)
        .await
        .unwrap();
    assert_eq!(
        anonymous.entries.len(),
        1,
        "None initiator never falls back to Session participant"
    );
    let v2 = committed(
        store
            .put_custom(
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
        store.bind_thread_custom(&old_id).await.unwrap(),
        old,
        "Existing Thread cannot jump to latest head"
    );
    assert_eq!(
        store.get_thread_custom(&old_id).await.unwrap(),
        Some(old.clone())
    );
    let new = store
        .bind_thread_custom(&thread(&*store, &ids, "alice-new", Some(&ids.3)).await)
        .await
        .unwrap();
    assert_ne!(new.manifest_hash, old.manifest_hash);
    assert!(new
        .context_custom()
        .unwrap()
        .unwrap()
        .to_string()
        .contains("Vega"));
    match store.put_custom(initial, "trusted-host").await.unwrap() {
        CustomMutation::Committed {
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
    committed(store.put_custom(disabled, "trusted-host").await.unwrap());
    assert_eq!(
        store.bind_thread_custom(&old_id).await.unwrap(),
        old,
        "Disable cannot rewrite historical mount"
    );
    assert_eq!(
        store
            .bind_thread_custom(&thread(&*store, &ids, "after-disable", None).await)
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
        .put_custom(bad_principal.clone(), "trusted-host")
        .await
        .is_err());
    assert!(
        store
            .get_custom(&bad_principal.key)
            .await
            .unwrap()
            .is_none(),
        "Failed FK must roll back head and version"
    );
    assert!(matches!(
        store
            .put_custom(
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
        CustomMutation::NotFound
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
    let (x, y) = tokio::join!(store.put_custom(x, "host"), store.put_custom(y, "host"));
    assert_eq!(
        [x.unwrap(), y.unwrap()]
            .iter()
            .filter(|result| matches!(result, CustomMutation::Committed { .. }))
            .count(),
        1
    );
    let race_thread = thread(&*store, &ids, "bind-race", Some(&ids.4)).await;
    let (a, b) = tokio::join!(
        store.bind_thread_custom(&race_thread),
        store.bind_thread_custom(&race_thread)
    );
    assert_eq!(a.unwrap(), b.unwrap());
    // A second Agent with the same namespace must have isolated authority.
    let other = setup(&*store, &format!("{prefix}-other")).await;
    assert!(store.list_custom(&other.0, None).await.unwrap().is_empty());
    assert!(store
        .bind_thread_custom(&thread(&*store, &other, "other", Some(&other.3)).await)
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
                .put_custom(
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
    assert!(store.put_custom(overflow.clone(), "host").await.is_err());
    assert!(store.get_custom(&overflow.key).await.unwrap().is_none());
    let invalid = command(
        &limits.0,
        "example.invalid",
        None,
        &format!("{prefix}-invalid"),
        0,
        "(unterminated",
    );
    assert!(store.put_custom(invalid.clone(), "host").await.is_err());
    assert!(store.get_custom(&invalid.key).await.unwrap().is_none());

    // A new public entry must not invalidate an existing private selection.
    let private_first = setup(&*store, &format!("{prefix}-private-first")).await;
    committed(
        store
            .put_custom(
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
                .put_custom(
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
        .put_custom(overflow_public.clone(), "host")
        .await
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<CustomError>(),
        Some(CustomError::Invalid(_))
    ));
    assert!(store
        .get_custom(&overflow_public.key)
        .await
        .unwrap()
        .is_none());

    // Disabling does not evade the configuration-head bound or delete history.
    let head_limits = setup(&*store, &format!("{prefix}-head-limits")).await;
    for n in 0..CUSTOM_MAX_SELECTED_ENTRIES {
        let mut disabled = command(
            &head_limits.0,
            &format!("example.disabled{n}"),
            None,
            &format!("{prefix}-disabled{n}"),
            0,
            "(config disabled)",
        );
        disabled.enabled = false;
        committed(store.put_custom(disabled, "host").await.unwrap());
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
        .put_custom(excess_head.clone(), "host")
        .await
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<CustomError>(),
        Some(CustomError::Invalid(_))
    ));
    assert!(store.get_custom(&excess_head.key).await.unwrap().is_none());
    assert_eq!(
        store.list_custom(&head_limits.0, None).await.unwrap().len(),
        CUSTOM_MAX_SELECTED_ENTRIES
    );
    authoring_conformance(store, prefix).await;
}

#[tokio::test]
async fn sqlite_custom_authority_conformance_and_reopen() {
    let dir = tempfile::TempDir::new().unwrap();
    let db = dir.path().join("rom.db");
    let store = Arc::new(SqliteStore::new(db.to_str().unwrap()).await.unwrap());
    conformance(store.clone(), "sqlite-rom").await;
    let before = store
        .get_thread_custom("sqlite-rom-agent-alice-old")
        .await
        .unwrap();
    drop(store);
    let reopened = SqliteStore::new(db.to_str().unwrap()).await.unwrap();
    assert_eq!(
        reopened
            .get_thread_custom("sqlite-rom-agent-alice-old")
            .await
            .unwrap(),
        before
    );
    assert_eq!(
        reopened
            .bind_thread_custom("sqlite-rom-agent-alice-old")
            .await
            .unwrap(),
        before.unwrap()
    );
}

#[tokio::test]
async fn postgres_custom_authority_conformance_and_reopen() {
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
    let before = store.get_thread_custom(&old_id).await.unwrap();
    drop(store);
    let reopened = PostgresStore::new(&url, 8).await.unwrap();
    assert_eq!(reopened.get_thread_custom(&old_id).await.unwrap(), before);
    assert_eq!(
        reopened.bind_thread_custom(&old_id).await.unwrap(),
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
    // Simulate the pre-Custom migration marker in this isolated disposable DB.
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
        .get_thread_custom(&old_id)
        .await
        .unwrap()
        .unwrap()
        .entries
        .is_empty());
    committed(
        store
            .put_custom(
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
        .bind_thread_custom(&old_id)
        .await
        .unwrap()
        .entries
        .is_empty());
    assert_eq!(
        reopened
            .bind_thread_custom(&new_id)
            .await
            .unwrap()
            .entries
            .len(),
        1,
        "Restart must not backfill post-migration new work empty"
    );
}

#[tokio::test]
async fn sqlite_v1_rom_schema_upgrade_preserves_receipts_and_authoring_on_reopen() {
    let dir = tempfile::TempDir::new().unwrap();
    let db = dir.path().join("v1-authoring-upgrade.db");
    let store = SqliteStore::new(db.to_str().unwrap()).await.unwrap();
    let ids = setup(&store, "v1-authoring-upgrade").await;
    let original = command(
        &ids.0,
        "example.profile",
        None,
        "v1-authoring-create",
        0,
        "(profile (name Nora))",
    );
    let initial = store.put_custom(original.clone(), "host").await.unwrap();
    let v1 = committed(initial.clone());
    let old_id = thread(&store, &ids, "old-mounted", None).await;
    let old = store.bind_thread_custom(&old_id).await.unwrap();
    let unbound_id = thread(&store, &ids, "v1-unbound", None).await;
    drop(store);
    // This disposable database now has the actual old v1 table shape, rows,
    // receipts and mounts, not merely a missing migration marker.
    let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}", db.display()))
        .await
        .unwrap();
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
    pool.close().await;

    let upgraded = SqliteStore::new(db.to_str().unwrap()).await.unwrap();
    assert_eq!(
        upgraded.get_custom(&original.key).await.unwrap(),
        Some(v1.clone())
    );
    assert_eq!(
        upgraded.get_thread_custom(&old_id).await.unwrap(),
        Some(old.clone())
    );
    assert_eq!(upgraded.bind_thread_custom(&old_id).await.unwrap(), old);
    assert_eq!(
        upgraded
            .bind_thread_custom(&unbound_id)
            .await
            .unwrap()
            .entries
            .len(),
        1,
        "Authoring migration must not perform legacy empty-mount backfill again"
    );
    match upgraded.put_custom(original, "host").await.unwrap() {
        CustomMutation::Committed {
            record,
            receipt,
            duplicate,
        } => {
            assert!(duplicate);
            assert_eq!(record, v1);
            if let CustomMutation::Committed {
                receipt: original, ..
            } = initial
            {
                assert_eq!(receipt, original);
            }
        }
        other => panic!("{other:?}"),
    }
    let mut authored = command(
        &ids.0,
        "example.profile",
        None,
        "v1-authoring-add-state",
        1,
        "(profile (name Nora))",
    );
    authored.authoring_state_sexpr =
        Some("(editor (custom RETAIN_AFTER_RESTART) (enabled false))".into());
    let v2 = committed(upgraded.put_custom(authored.clone(), "host").await.unwrap());
    drop(upgraded);
    for _ in 0..2 {
        let reopened = SqliteStore::new(db.to_str().unwrap()).await.unwrap();
        assert_eq!(
            reopened.get_custom(&authored.key).await.unwrap(),
            Some(v2.clone())
        );
        assert_eq!(
            reopened.get_thread_custom(&old_id).await.unwrap(),
            Some(old.clone())
        );
        assert!(
            matches!(reopened.put_custom(authored.clone(), "host").await.unwrap(), CustomMutation::Committed { record, duplicate: true, .. } if record == v2)
        );
    }
    let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}", db.display()))
        .await
        .unwrap();
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM schema_migrations WHERE version='20261002_02_agent_rom_authoring_state'").fetch_one(&pool).await.unwrap(), 1);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM agent_rom_versions WHERE canonical_authoring_state IS NULL"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM agent_rom_command_receipts")
            .fetch_one(&pool)
            .await
            .unwrap(),
        2
    );
    pool.close().await;
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
                Err("injected Custom receipt response loss after durable commit".into())
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
        store.put_custom(command.clone(), "host").await.is_err(),
        "An ambiguous remote commit cannot acknowledge the speculative record"
    );
    assert_eq!(
        store
            .get_custom(&command.key)
            .await
            .unwrap()
            .unwrap()
            .revision,
        1,
        "Next read restores the actual remote authority"
    );
    match store.put_custom(command.clone(), "host").await.unwrap() {
        CustomMutation::Committed { duplicate, .. } => assert!(duplicate),
        other => panic!("{other:?}"),
    }
    assert!(
        store
            .put_custom(command, "forged-other-host")
            .await
            .unwrap_err()
            .is::<CustomError>(),
        "Remote Store preserves domain command-reuse errors after its independent fence validation"
    );
    let old_id = format!("{prefix}-agent-alice-old");
    let old = store.get_thread_custom(&old_id).await.unwrap();
    drop(store);
    let recovered = RemoteRuntimeStore::connect(transport, fence).await.unwrap();
    assert_eq!(recovered.get_thread_custom(&old_id).await.unwrap(), old);
    assert_eq!(
        recovered.bind_thread_custom(&old_id).await.unwrap(),
        old.unwrap()
    );
}
