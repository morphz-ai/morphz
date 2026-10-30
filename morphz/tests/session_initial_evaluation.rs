#[path = "support/temp_sqlite.rs"]
mod temp_sqlite;

use morphz::llm::ReasoningEffort;
use morphz::memory::postgres::PostgresStore;
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{
    InitialSessionEvaluation, NewAgent, NewCognitiveContext, NewPrincipal, NewSession,
    SessionDirectoryStore, SessionMountKind, SessionUpdate,
};
use temp_sqlite::TempSqliteDb;

async fn creation_contract(store: &impl SessionDirectoryStore) -> Vec<String> {
    let prefix = format!(
        "initial-eval-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let agent = format!("{prefix}-agent");
    let context = format!("{prefix}-context");
    let principal = format!("{prefix}-human");
    let new_session = |name: &str| NewSession {
        id: format!("{prefix}-{name}"),
        agent_id: agent.clone(),
        context_id: context.clone(),
        parent_session_id: None,
        title: "TEST initial Session evaluation".into(),
        mount_kind: SessionMountKind::ExistingContext,
    };
    store
        .create_agent_bundle(
            NewAgent {
                id: agent.clone(),
                root_context_id: context.clone(),
                title: "TEST initial evaluation".into(),
            },
            NewCognitiveContext {
                id: context.clone(),
                agent_id: agent.clone(),
                title: "TEST initial evaluation".into(),
            },
            NewSession {
                mount_kind: SessionMountKind::NewBlankContext,
                ..new_session("root")
            },
        )
        .await
        .unwrap();
    store
        .ensure_principal(NewPrincipal {
            id: principal.clone(),
            provider_id: "test".into(),
            assurance: "verified".into(),
            display_name: None,
        })
        .await
        .unwrap();
    let mut ids = Vec::new();
    for (name, effort) in [
        ("inherited", None),
        ("none", Some(ReasoningEffort::Off)),
        ("max", Some(ReasoningEffort::Max)),
        ("xhigh", Some(ReasoningEffort::XHigh)),
    ] {
        let selection = InitialSessionEvaluation {
            model_alias: effort.map(|_| "fixture-model".to_string()),
            reasoning_effort: effort,
        };
        let command = new_session(name);
        let created = store
            .create_session_for_principal_with_evaluation(
                command.clone(),
                &principal,
                selection.clone(),
            )
            .await
            .unwrap();
        assert_eq!(created.model_alias, selection.model_alias);
        assert_eq!(
            created.reasoning_effort.as_deref(),
            effort.map(|e| e.as_str())
        );
        assert!(store
            .verify_session_principal(&created.id, &principal)
            .await
            .unwrap());
        ids.push(created.id.clone());
        // A retry after an explicit Human clear must conflict, not reinstall
        // the selection frozen in an old first-input receipt.
        store
            .update_session(
                &created.id,
                SessionUpdate {
                    model_alias: Some(None),
                    reasoning_effort: Some(None),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(store
            .create_session_for_principal_with_evaluation(command, &principal, selection)
            .await
            .is_err());
        let actual = store.get_session(&created.id).await.unwrap().unwrap();
        assert_eq!(actual.model_alias, None);
        assert_eq!(actual.reasoning_effort, None);
    }
    let missing_principal = new_session("missing-principal");
    assert!(store
        .create_session_for_principal_with_evaluation(
            missing_principal.clone(),
            "missing-test-principal",
            InitialSessionEvaluation {
                model_alias: Some("fixture-model".into()),
                reasoning_effort: Some(ReasoningEffort::High),
            },
        )
        .await
        .is_err());
    assert!(store
        .get_session(&missing_principal.id)
        .await
        .unwrap()
        .is_none());
    let shared_id = new_session("concurrent");
    let (a, b) = tokio::join!(
        store.create_session_for_principal_with_evaluation(
            shared_id.clone(),
            &principal,
            InitialSessionEvaluation {
                model_alias: Some("fixture-a".into()),
                reasoning_effort: Some(ReasoningEffort::High),
            },
        ),
        store.create_session_for_principal_with_evaluation(
            shared_id.clone(),
            &principal,
            InitialSessionEvaluation {
                model_alias: Some("fixture-b".into()),
                reasoning_effort: Some(ReasoningEffort::Off),
            },
        ),
    );
    assert_ne!(a.is_ok(), b.is_ok());
    let winner = a.or(b).unwrap();
    let actual = store.get_session(&shared_id.id).await.unwrap().unwrap();
    assert_eq!(actual.model_alias, winner.model_alias);
    assert_eq!(actual.reasoning_effort, winner.reasoning_effort);
    assert!(store
        .verify_session_principal(&shared_id.id, &principal)
        .await
        .unwrap());
    let legacy = store
        .create_session_for_principal(new_session("legacy"), &principal)
        .await
        .unwrap();
    assert_eq!(legacy.model_alias, None);
    assert_eq!(legacy.reasoning_effort, None);
    ids
}

#[tokio::test]
async fn sqlite_session_initial_evaluation_is_atomic_and_duplicate_does_not_reset() {
    let database = TempSqliteDb::new().unwrap();
    let store = SqliteStore::new(database.path().to_str().unwrap())
        .await
        .unwrap();
    let ids = creation_contract(&store).await;
    drop(store);
    let reopened = SqliteStore::new(database.path().to_str().unwrap())
        .await
        .unwrap();
    for id in ids {
        let actual = reopened.get_session(&id).await.unwrap().unwrap();
        assert_eq!(actual.model_alias, None);
        assert_eq!(actual.reasoning_effort, None);
    }
}

#[tokio::test]
#[ignore = "requires an explicitly configured disposable PostgreSQL database; required by PostgreSQL CI"]
async fn postgres_session_initial_evaluation_is_atomic_and_duplicate_does_not_reset() {
    let url = std::env::var("MORPHZ_TEST_POSTGRES_URL")
        .expect("MORPHZ_TEST_POSTGRES_URL must name a disposable test database");
    let store = PostgresStore::new(&url, 4).await.unwrap();
    creation_contract(&store).await;
}

#[test]
fn session_initial_evaluation_rejects_unknown_fields_and_non_session_efforts() {
    for value in [
        serde_json::json!({"model_alias":"fixture", "reasoning_effort":"max", "extra":true}),
        serde_json::json!({"model_alias":"fixture", "reasoning_effort":"provider_default"}),
    ] {
        assert!(serde_json::from_value::<InitialSessionEvaluation>(value).is_err());
    }
}
