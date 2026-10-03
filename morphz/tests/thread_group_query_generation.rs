//! Real Store query contract: generation belongs in SQL before LIMIT, never in
//! a Runtime post-filter over the oldest or newest limited owner projection.
//! Both backends create the Groups through the actual schedule transaction.
//! This is a Group-query fixture, not a supervisor-graph or authorization
//! proof: owner identifiers/scope distractors deliberately exercise stored
//! fields, and terminal fixture statuses do not test barrier settlement.
use morphz::memory::{
    postgres::PostgresStore, sqlite::SqliteStore, NewAgent, NewCognitiveContext, NewSession,
    NewThread, NewThreadGroup, NewThreadGroupMember, NewThreadGroupPlan, ScheduleStore,
    SessionDirectoryStore, SessionMountKind, ThreadGroupFilter, ThreadGroupPolicy,
    ThreadGroupStatus, ThreadGroupStore, ThreadKind, ThreadSupervision, ThreadSupervisorKind,
};
use serde_json::json;

const CONTEXT: &str = "generation-context";
const SESSION: &str = "generation-session";
const OWNER: &str = "generation-owner";
const CURRENT: &str = "generation-current-open";
const OLD: &str = "generation-old-open";
const STALE: &str = "generation-newer-stale-open";

async fn seed_groups<S>(store: &S)
where
    S: SessionDirectoryStore + ScheduleStore + ThreadGroupStore,
{
    for (agent, context, session) in [
        ("generation-agent", CONTEXT, SESSION),
        (
            "generation-foreign-agent",
            "generation-foreign-context",
            "generation-foreign-context-session",
        ),
    ] {
        store
            .create_agent_bundle(
                NewAgent {
                    id: agent.into(),
                    title: "Generation query fixture".into(),
                    root_context_id: context.into(),
                },
                NewCognitiveContext {
                    id: context.into(),
                    agent_id: agent.into(),
                    title: "Generation query fixture".into(),
                },
                NewSession {
                    id: session.into(),
                    agent_id: agent.into(),
                    context_id: context.into(),
                    parent_session_id: None,
                    title: "Generation query fixture".into(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
    }
    store
        .ensure_session(NewSession {
            id: "generation-foreign-session".into(),
            agent_id: "generation-agent".into(),
            context_id: CONTEXT.into(),
            parent_session_id: None,
            title: "Other Session in the same Context".into(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();

    // Distractors precede CURRENT. The combined exact scope/status/generation
    // query must select CURRENT rather than an older or foreign persisted Group.
    for (id, context, session, owner, kind, generation) in [
        (
            OLD,
            CONTEXT,
            SESSION,
            OWNER,
            ThreadSupervisorKind::Thread,
            1,
        ),
        (
            "generation-other-owner",
            CONTEXT,
            SESSION,
            "foreign-owner",
            ThreadSupervisorKind::Thread,
            2,
        ),
        (
            "generation-other-context",
            "generation-foreign-context",
            "generation-foreign-context-session",
            OWNER,
            ThreadSupervisorKind::Thread,
            2,
        ),
        (
            "generation-other-session",
            CONTEXT,
            "generation-foreign-session",
            OWNER,
            ThreadSupervisorKind::Thread,
            2,
        ),
        (
            "generation-other-kind",
            CONTEXT,
            SESSION,
            OWNER,
            ThreadSupervisorKind::Runtime,
            2,
        ),
        (
            "generation-satisfied",
            CONTEXT,
            SESSION,
            OWNER,
            ThreadSupervisorKind::Thread,
            2,
        ),
        (
            "generation-failed",
            CONTEXT,
            SESSION,
            OWNER,
            ThreadSupervisorKind::Thread,
            2,
        ),
        (
            "generation-cancelled",
            CONTEXT,
            SESSION,
            OWNER,
            ThreadSupervisorKind::Thread,
            2,
        ),
        (
            CURRENT,
            CONTEXT,
            SESSION,
            OWNER,
            ThreadSupervisorKind::Thread,
            2,
        ),
        (
            STALE,
            CONTEXT,
            SESSION,
            OWNER,
            ThreadSupervisorKind::Thread,
            3,
        ),
    ] {
        let member_id = format!("{id}-member");
        let mut supervision = if kind == ThreadSupervisorKind::Thread {
            ThreadSupervision::attached(owner, generation, format!("{id}-origin"))
        } else {
            let mut supervision = ThreadSupervision::runtime(owner);
            supervision.generation = generation;
            supervision
        };
        supervision.thread_group_id = Some(id.into());
        store
            .commit_schedule_transaction(
                &[],
                &[],
                &[NewThread {
                    response_annotations: morphz::response_annotations::Protocol::Off,
                    model_alias: None,
                    reasoning_effort: None,
                    id: member_id.clone(),
                    agent_id: if context == CONTEXT {
                        "generation-agent"
                    } else {
                        "generation-foreign-agent"
                    }
                    .into(),
                    context_id: context.into(),
                    session_id: session.into(),
                    initiating_principal_id: None,
                    root_turn_id: format!("{id}-member-root"),
                    kind: ThreadKind::Execution,
                    executor_kind: "self".into(),
                    executor_id: None,
                    target_id: None,
                    supervision,
                }],
                &[],
                &[NewThreadGroupPlan {
                    group: NewThreadGroup {
                        id: id.into(),
                        context_id: context.into(),
                        session_id: session.into(),
                        supervisor_kind: kind,
                        supervisor_id: owner.into(),
                        generation,
                        policy: ThreadGroupPolicy::All,
                        completion_contract: json!({"query_fixture":true}),
                    },
                    members: vec![NewThreadGroupMember {
                        thread_id: member_id,
                        ordinal: 0,
                        required: true,
                    }],
                }],
            )
            .await
            .unwrap();
        assert_eq!(
            store
                .get_thread_group(id)
                .await
                .unwrap()
                .unwrap()
                .generation,
            generation
        );
    }
}

fn owner_filter(generation: Option<u64>) -> ThreadGroupFilter {
    ThreadGroupFilter {
        context_id: Some(CONTEXT.into()),
        session_id: Some(SESSION.into()),
        supervisor_kind: Some(ThreadSupervisorKind::Thread),
        supervisor_id: Some(OWNER.into()),
        generation,
        status: Some(ThreadGroupStatus::Open),
        limit: Some(1),
        ..Default::default()
    }
}

async fn assert_generation_before_limit<S: ThreadGroupStore>(store: &S) {
    // This is a real legacy counterexample, not a mocked query or a temporary
    // production rollback: the old limited query selects an older Open Group.
    let legacy = store.list_thread_groups(owner_filter(None)).await.unwrap();
    assert_eq!(legacy.len(), 1);
    assert_eq!(legacy[0].id, OLD);
    assert!(
        legacy
            .iter()
            .filter(|group| group.generation == 2)
            .next()
            .is_none(),
        "Post-LIMIT generation filtering would miss the actual current Open Group"
    );
    eprintln!("GENERATION_QUERY_LEGACY_COUNTEREXAMPLE: generation=None LIMIT 1 then filter generation=2 has no current Group");

    for newest_first in [false, true] {
        let current = store
            .list_thread_groups(ThreadGroupFilter {
                newest_first,
                ..owner_filter(Some(2))
            })
            .await
            .unwrap();
        assert_eq!(current.len(), 1);
        assert_eq!(current[0].id, CURRENT);
        assert_eq!(current[0].generation, 2);
        assert_eq!(current[0].status, ThreadGroupStatus::Open);
    }
    let newest_legacy = store
        .list_thread_groups(ThreadGroupFilter {
            newest_first: true,
            ..owner_filter(None)
        })
        .await
        .unwrap();
    assert_eq!(
        newest_legacy[0].id, STALE,
        "None must retain compatible all-generation ordering"
    );

    let all_current = store
        .list_thread_groups(ThreadGroupFilter {
            limit: None,
            ..owner_filter(Some(2))
        })
        .await
        .unwrap();
    assert_eq!(
        all_current
            .iter()
            .map(|group| group.id.as_str())
            .collect::<Vec<_>>(),
        vec![CURRENT],
        "Every foreign scope/kind/owner and terminal status is excluded by the actual query"
    );
    let default_open = store
        .list_thread_groups(ThreadGroupFilter {
            status: None,
            ..owner_filter(Some(2))
        })
        .await
        .unwrap();
    assert_eq!(default_open[0].id, CURRENT);
    for (status, expected) in [
        (ThreadGroupStatus::Satisfied, "generation-satisfied"),
        (ThreadGroupStatus::Failed, "generation-failed"),
        (ThreadGroupStatus::Cancelled, "generation-cancelled"),
    ] {
        let terminal = store
            .list_thread_groups(ThreadGroupFilter {
                status: Some(status),
                ..owner_filter(Some(2))
            })
            .await
            .unwrap();
        assert_eq!(terminal.len(), 1);
        assert_eq!(terminal[0].id, expected);
    }
    assert!(store
        .list_thread_groups(owner_filter(Some(99)))
        .await
        .unwrap()
        .is_empty());
    assert!(store
        .list_thread_groups(owner_filter(Some(0)))
        .await
        .unwrap()
        .is_empty());
    assert!(store
        .list_thread_groups(ThreadGroupFilter {
            limit: Some(0),
            ..owner_filter(Some(2))
        })
        .await
        .unwrap()
        .is_empty());
    assert!(
        store
            .list_thread_groups(owner_filter(Some(u64::MAX)))
            .await
            .is_err(),
        "Generation must not wrap the backend INTEGER type"
    );
    eprintln!("GENERATION_QUERY_SCOPED_GREEN: generation=2 WHERE-before-LIMIT selects current Open Group in both directions; None compatibility and scope/status boundaries passed");
}

#[tokio::test]
async fn sqlite_typed_group_generation_is_filtered_before_limit() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("group-generation.sqlite");
    let store = SqliteStore::new(database.to_str().unwrap()).await.unwrap();
    seed_groups(&store).await;
    // Query fixture only: Groups were created by the actual Store transaction.
    // Setting terminal statuses here does not claim to test barrier settlement.
    let inspection = sqlx::SqlitePool::connect(&format!("sqlite://{}", database.display()))
        .await
        .unwrap();
    for (id, status) in [
        ("generation-satisfied", "satisfied"),
        ("generation-failed", "failed"),
        ("generation-cancelled", "cancelled"),
    ] {
        sqlx::query("UPDATE thread_groups SET status = ? WHERE id = ?")
            .bind(status)
            .bind(id)
            .execute(&inspection)
            .await
            .unwrap();
    }
    assert_generation_before_limit(&store).await;
    inspection.close().await;
}

#[tokio::test]
async fn postgres_typed_group_generation_is_filtered_before_limit_when_configured() {
    let Ok(database_url) = std::env::var("MORPHZ_TEST_POSTGRES_URL") else {
        eprintln!("POSTGRES_GENERATION_QUERY_NOT_CONFIGURED: no actual PostgreSQL assertion ran");
        return;
    };
    let schema = format!(
        "morphz_group_generation_{}_{}",
        std::process::id(),
        chrono::Utc::now()
            .timestamp_nanos_opt()
            .unwrap()
            .unsigned_abs()
    );
    let administration = sqlx::PgPool::connect(&database_url).await.unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&administration)
        .await
        .unwrap();
    let separator = if database_url.contains('?') { '&' } else { '?' };
    let scoped_url = format!("{database_url}{separator}options=-csearch_path%3D{schema}%2Cpublic");
    let store = PostgresStore::new(&scoped_url, 4).await.unwrap();
    seed_groups(&store).await;
    for (id, status) in [
        ("generation-satisfied", "satisfied"),
        ("generation-failed", "failed"),
        ("generation-cancelled", "cancelled"),
    ] {
        sqlx::query("UPDATE thread_groups SET status = $1 WHERE id = $2")
            .bind(status)
            .bind(id)
            .execute(store.pool())
            .await
            .unwrap();
    }
    assert_generation_before_limit(&store).await;
    store.pool().close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&administration)
        .await
        .unwrap();
    administration.close().await;
    eprintln!("POSTGRES_GENERATION_QUERY_ACTUAL_PASS: isolated real backend completed and unique schema removed");
}
