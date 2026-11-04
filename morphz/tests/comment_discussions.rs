//! Real transactional store coverage. These fixtures do not call a Provider
//! and are not a claim of original-app or model acceptance.
use morphz::discussion::{DiscussionInput, DiscussionSource, TimelineScope};
use morphz::event::Event;
use morphz::memory::{
    postgres::PostgresStore, sqlite::SqliteStore, MessageClaim, MessageDispatchMode, NewAgent,
    NewCognitiveContext, NewPrincipal, NewSession, NewThread, RuntimeStore, SessionMountKind,
    SessionTimelineCursor, ThreadKind, ThreadSupervision,
};
use morphz::session_io::{Activation, Delivery, Message, Registry, Request};
use serde_json::json;
use std::sync::atomic::{AtomicI64, Ordering};

type Error = Box<dyn std::error::Error + Send + Sync>;
const SESSION: &str = "discussion-session";
const PRINCIPAL: &str = "discussion-human";
const CONTEXT: &str = "discussion-context";
static EVENT_CLOCK: AtomicI64 = AtomicI64::new(1_793_750_400_000_000);

async fn setup<S: RuntimeStore>(store: &S) -> Result<(), Error> {
    store
        .create_agent_bundle(
            NewAgent {
                id: "discussion-agent".into(),
                title: "Discussion fixture".into(),
                root_context_id: CONTEXT.into(),
            },
            NewCognitiveContext {
                id: CONTEXT.into(),
                agent_id: "discussion-agent".into(),
                title: "Discussion fixture".into(),
            },
            NewSession {
                id: SESSION.into(),
                agent_id: "discussion-agent".into(),
                context_id: CONTEXT.into(),
                parent_session_id: None,
                title: "Discussion fixture".into(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await?;
    for principal in [PRINCIPAL, "other-human"] {
        store
            .ensure_principal(NewPrincipal {
                id: principal.into(),
                provider_id: "test".into(),
                assurance: "verified".into(),
                display_name: None,
            })
            .await?;
        store.bind_session_principal(SESSION, principal).await?;
    }
    let source = event(
        "source",
        "chat/reply",
        json!({"root_turn_id":"old-source-root","text":"Original selected passage"}),
    );
    store.append(source).await?;
    Ok(())
}

fn event(id: &str, topic: &str, payload: serde_json::Value) -> Event {
    let mut payload = payload.as_object().unwrap().clone();
    payload.insert("session_id".into(), json!(SESSION));
    payload.insert("context_id".into(), json!(CONTEXT));
    payload.insert("principal_id".into(), json!(PRINCIPAL));
    let mut event = Event::new(
        id.into(),
        "Human".into(),
        "session_message".into(),
        topic.into(),
        payload,
    );
    event.timestamp =
        chrono::DateTime::from_timestamp_micros(EVENT_CLOCK.fetch_add(1, Ordering::SeqCst))
            .unwrap();
    event
}

fn input(id: &str, command: &str, discussion: Option<DiscussionInput>, principal: &str) -> Event {
    let request = Request {
        io_version: "1".into(),
        client_message_id: command.into(),
        message: Message::chat(format!("Question {command}")),
        discussion: discussion.clone(),
        client_metadata: None,
        activation: Activation {
            dispatch_mode: Some(MessageDispatchMode::Parallel),
            ..Default::default()
        },
        delivery: Delivery::default(),
    };
    let accepted = Registry::default().bind(request, principal).unwrap();
    let mut event = event(
        id,
        "chat/user_message",
        json!({
            "client_message_id":command,"root_turn_id":id,"text":format!("Question {command}"),"session_io":accepted,
        }),
    );
    event
        .payload
        .insert("principal_id".into(), json!(principal));
    if let Some(discussion) = discussion {
        event.payload.insert("discussion".into(), json!(discussion));
    }
    event
}

fn start(id: &str, both: bool) -> DiscussionInput {
    DiscussionInput {
        id: id.into(),
        publish_to_session: Some(both),
        source: Some(DiscussionSource {
            key: "source:fixture".into(),
            title: "Original source".into(),
            text: "selected passage".into(),
            locator: json!({"kind":"runtime-event","event_id":"source","anchor":{"start":9,"end":25}}),
        }),
    }
}

async fn assertions<S: RuntimeStore>(store: &S) -> Result<(), Error> {
    setup(store).await?;
    for (id, both) in [("a", false), ("b", false), ("c", true)] {
        let root = format!("root-{id}");
        let command = format!("discussion-{id}");
        let question = input(&root, &command, Some(start(&command, both)), PRINCIPAL);
        assert!(matches!(
            store
                .claim_message(SESSION, &command, &question, MessageDispatchMode::Parallel)
                .await?,
            MessageClaim::Accepted { .. }
        ));
        store.append(event(&format!("reply-{id}"),"chat/reply",json!({"root_turn_id":root,"attempt_id":format!("attempt-{id}"),"text":format!("Answer {id}")}))).await?;
    }
    let a = TimelineScope::Discussion {
        id: "discussion-a".into(),
    };
    let b = TimelineScope::Discussion {
        id: "discussion-b".into(),
    };
    let a_page = store
        .query_scoped_session_timeline(SESSION, Some(PRINCIPAL), &a, None, 20, false)
        .await?;
    assert_eq!(a_page.len(), 2);
    assert!(a_page.iter().all(|item| item.root_turn_id == "root-a"));
    let b_page = store
        .query_scoped_session_timeline(SESSION, Some(PRINCIPAL), &b, None, 20, false)
        .await?;
    assert_eq!(b_page.len(), 2);
    assert!(b_page.iter().all(|item| item.root_turn_id == "root-b"));
    let main = store
        .query_scoped_session_timeline(
            SESSION,
            Some(PRINCIPAL),
            &TimelineScope::Main,
            None,
            20,
            false,
        )
        .await?;
    assert!(main.iter().any(|item| item.event.id == "reply-c"));
    assert!(main
        .iter()
        .all(|item| !["root-a", "root-b"].contains(&item.root_turn_id.as_str())));
    assert!(store
        .query_scoped_session_timeline(SESSION, Some("other-human"), &a, None, 20, false)
        .await
        .is_err());

    let continuation = input(
        "root-a-next",
        "next-a",
        Some(DiscussionInput {
            id: "discussion-a".into(),
            source: None,
            publish_to_session: None,
        }),
        PRINCIPAL,
    );
    assert!(matches!(
        store
            .claim_message(
                SESSION,
                "next-a",
                &continuation,
                MessageDispatchMode::Parallel
            )
            .await?,
        MessageClaim::Accepted { .. }
    ));
    let retry = input(
        "retry-event",
        "next-a",
        Some(DiscussionInput {
            id: "discussion-a".into(),
            source: None,
            publish_to_session: None,
        }),
        PRINCIPAL,
    );
    assert!(matches!(
        store
            .claim_message(SESSION, "next-a", &retry, MessageDispatchMode::Parallel)
            .await?,
        MessageClaim::Existing { .. }
    ));
    let foreign = input(
        "foreign-next",
        "foreign-command",
        Some(DiscussionInput {
            id: "discussion-a".into(),
            source: None,
            publish_to_session: None,
        }),
        "other-human",
    );
    assert!(store
        .claim_message(
            SESSION,
            "foreign-command",
            &foreign,
            MessageDispatchMode::Parallel
        )
        .await
        .is_err());
    assert!(
        store
            .message_event_id(SESSION, "foreign-command")
            .await?
            .is_none(),
        "rejected membership must roll back the input and receipt"
    );
    let page = store
        .query_scoped_session_timeline(SESSION, Some(PRINCIPAL), &a, None, 1, false)
        .await?;
    assert_eq!(page[0].event.id, "root-a-next");
    let before = SessionTimelineCursor {
        visible_at_micros: page[0].visible_at_micros,
        entry_id: page[0].entry_id.clone(),
    };
    let older = store
        .query_scoped_session_timeline(SESSION, Some(PRINCIPAL), &a, Some(&before), 1, false)
        .await?;
    assert_eq!(older[0].event.id, "reply-a");

    let parent = store.get_thread_by_root("root-a").await?.unwrap();
    store
        .ensure_thread(NewThread {
            id: "child-a-thread".into(),
            root_turn_id: "child-a-root".into(),
            agent_id: parent.agent_id.clone(),
            context_id: CONTEXT.into(),
            session_id: SESSION.into(),
            initiating_principal_id: Some(PRINCIPAL.into()),
            kind: ThreadKind::Execution,
            executor_kind: "self".into(),
            executor_id: None,
            target_id: None,
            model_alias: None,
            reasoning_effort: None,
            response_annotations: parent.response_annotations,
            supervision: ThreadSupervision::attached(
                parent.id,
                parent.generation,
                "test-parent-evaluation",
            ),
        })
        .await?;
    store
        .append(event(
            "child-reply-a",
            "chat/reply",
            json!({"root_turn_id":"child-a-root","text":"Child result A"}),
        ))
        .await?;
    let page = store
        .query_scoped_session_timeline(SESSION, Some(PRINCIPAL), &a, None, 20, false)
        .await?;
    assert!(page.iter().any(|item| item.event.id == "child-reply-a"));
    let main = store
        .query_scoped_session_timeline(
            SESSION,
            Some(PRINCIPAL),
            &TimelineScope::Main,
            None,
            20,
            false,
        )
        .await?;
    assert!(!main.iter().any(|item| item.event.id == "child-reply-a"));
    let directory = store
        .session_discussions(SESSION, Some(PRINCIPAL), "source:fixture", None, 2)
        .await?;
    assert_eq!(directory.len(), 2);
    assert!(directory
        .iter()
        .all(|item| item.preview == "selected passage"));
    assert!(store
        .session_discussions(SESSION, Some("other-human"), "source:fixture", None, 20)
        .await?
        .is_empty());
    assert_eq!(
        store
            .session_discussion(SESSION, Some(PRINCIPAL), "discussion-a")
            .await?
            .unwrap()
            .source_event_id,
        "root-a"
    );
    // A message larger than a page is an explicit content boundary, not an
    // empty/end page. Its cursor can still advance and its bytes are requested
    // independently with the exact immutable Event version.
    let large_text = "界".repeat(800_000);
    store
        .append(event(
            "large-a",
            "chat/progress",
            json!({"root_turn_id":"root-a","text":large_text}),
        ))
        .await?;
    let error = store
        .query_scoped_session_timeline(SESSION, Some(PRINCIPAL), &a, None, 20, true)
        .await
        .unwrap_err();
    let boundary = error
        .downcast_ref::<morphz::discussion::PageBudgetBoundary>()
        .expect("large entry must retain a continuation");
    assert_eq!(boundary.event_id, "large-a");
    let chunk = store
        .discussion_message_chunk(
            SESSION,
            Some(PRINCIPAL),
            "discussion-a",
            &boundary.entry_id,
            &boundary.event_id,
            0,
        )
        .await?
        .unwrap();
    assert_eq!(chunk.text.chars().count(), 32768);
    assert_eq!(chunk.next_offset, Some(32768));
    assert!(chunk.text.len() <= 128 * 1024);
    assert!(store
        .discussion_message_chunk(
            SESSION,
            Some(PRINCIPAL),
            "discussion-a",
            &boundary.entry_id,
            "obsolete-version",
            0
        )
        .await?
        .is_none());
    assert!(store
        .discussion_message_chunk(
            SESSION,
            Some("other-human"),
            "discussion-a",
            &boundary.entry_id,
            &boundary.event_id,
            0
        )
        .await
        .is_err());
    let previous = store
        .query_scoped_session_timeline(
            SESSION,
            Some(PRINCIPAL),
            &a,
            Some(&SessionTimelineCursor {
                visible_at_micros: boundary.visible_at_micros,
                entry_id: boundary.entry_id.clone(),
            }),
            20,
            true,
        )
        .await?;
    assert!(!previous.is_empty());
    assert!(previous.iter().all(|item| item.event.id != "large-a"));
    Ok(())
}

#[tokio::test]
async fn sqlite_discussion_receipts_scopes_children_and_keyset_pages() -> Result<(), Error> {
    let temporary = tempfile::TempDir::new()?;
    let store =
        SqliteStore::new(temporary.path().join("discussion.sqlite").to_str().unwrap()).await?;
    assertions(&store).await
}

#[tokio::test]
#[ignore = "requires a dedicated MORPHZ_TEST_POSTGRES_URL; CI runs this explicitly"]
async fn postgres_discussion_receipts_scopes_children_and_keyset_pages() -> Result<(), Error> {
    let url = std::env::var("MORPHZ_TEST_POSTGRES_URL")
        .expect("dedicated PostgreSQL test database required");
    let admin = sqlx::PgPool::connect(&url).await?;
    let schema = format!(
        "morphz_discussions_{}_{}",
        std::process::id(),
        chrono::Utc::now()
            .timestamp_nanos_opt()
            .unwrap()
            .unsigned_abs()
    );
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await?;
    let scoped = format!(
        "{url}{}options=-csearch_path%3D{schema}",
        if url.contains('?') { '&' } else { '?' }
    );
    let result = async {
        let store = PostgresStore::new(&scoped, 4).await?;
        assertions(&store).await
    }
    .await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await?;
    result
}
