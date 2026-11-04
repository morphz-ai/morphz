//! Shared, transaction-local discussion projection. SQL adapters instantiate
//! this recipe with their own concrete database; no second message body store.

pub(crate) const TABLES: &[&str] = &[
    "CREATE INDEX IF NOT EXISTS idx_session_main_message_requests ON session_message_requests
       (session_id,created_at DESC,event_id DESC) WHERE discussion_id IS NULL",
    "CREATE TABLE IF NOT EXISTS session_discussions (
       session_id TEXT NOT NULL, id TEXT NOT NULL,
       principal_id TEXT NOT NULL, context_id TEXT NOT NULL,
       source_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
       source_key TEXT NOT NULL, title TEXT NOT NULL, preview TEXT NOT NULL, locator_json TEXT NOT NULL,
       main_visible INTEGER NOT NULL CHECK(main_visible IN (0,1)),
       created_at_micros BIGINT NOT NULL, PRIMARY KEY(session_id,id))",
    "CREATE INDEX IF NOT EXISTS idx_discussion_source_page ON session_discussions
       (session_id,principal_id,source_key,created_at_micros DESC,id DESC)",
    "CREATE INDEX IF NOT EXISTS idx_discussion_operator_source_page ON session_discussions
       (session_id,source_key,created_at_micros DESC,id DESC)",
    "CREATE TABLE IF NOT EXISTS session_discussion_roots (
       session_id TEXT NOT NULL, root_turn_id TEXT NOT NULL,
       discussion_id TEXT NOT NULL, principal_id TEXT NOT NULL,
       context_id TEXT NOT NULL, input_bytes_bound BIGINT NOT NULL CHECK(input_bytes_bound >= 0), main_visible INTEGER NOT NULL CHECK(main_visible IN (0,1)),
       PRIMARY KEY(session_id,root_turn_id),
       FOREIGN KEY(session_id,discussion_id) REFERENCES session_discussions(session_id,id) ON DELETE CASCADE)",
    "CREATE INDEX IF NOT EXISTS idx_discussion_roots_scope ON session_discussion_roots(session_id,discussion_id,root_turn_id)",
    "CREATE INDEX IF NOT EXISTS idx_discussion_timeline_page ON session_message_timeline
       (session_id,discussion_id,visible_at_micros DESC,entry_id DESC)
       WHERE discussion_id IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_discussion_timeline_text_page ON session_message_timeline
       (session_id,discussion_id,visible_at_micros DESC,entry_id DESC)
       WHERE discussion_id IS NOT NULL AND metadata_only = 0",
    "CREATE INDEX IF NOT EXISTS idx_main_timeline_page ON session_message_timeline
       (session_id,visible_at_micros DESC,entry_id DESC)
       WHERE main_visible = 1",
    "CREATE INDEX IF NOT EXISTS idx_main_timeline_text_page ON session_message_timeline
       (session_id,visible_at_micros DESC,entry_id DESC)
       WHERE main_visible = 1 AND metadata_only = 0",
];

// A child Thread's native supervisor, not a client label, inherits the route.
// Each edge is projected when created, so a deep tree never becomes a history
// traversal on a message read. The joins are exact primary-key lookups.
pub(crate) const INHERITED_ROUTE: &str = "
    SELECT NEW.session_id, NEW.root_turn_id, route.discussion_id,
           route.principal_id, route.context_id, MAX(route.input_bytes_bound), route.main_visible
    FROM session_discussion_roots route
    WHERE route.session_id = NEW.session_id
      AND route.context_id = NEW.context_id
      AND route.principal_id = NEW.initiating_principal_id
      AND route.root_turn_id IN (
        SELECT root_turn_id FROM threads WHERE id = NEW.parent_thread_id
          AND session_id = NEW.session_id AND context_id = NEW.context_id
          AND initiating_principal_id = NEW.initiating_principal_id
        UNION ALL
        SELECT root_turn_id FROM thread_activations WHERE id = NEW.origin_evaluation_id
          AND session_id = NEW.session_id AND context_id = NEW.context_id
          AND initiating_principal_id = NEW.initiating_principal_id
        UNION ALL
        SELECT COALESCE(source.root_turn_id, source.id) FROM objectives objective
          JOIN events source ON source.id = objective.source_event_id
          WHERE objective.id = NEW.supervisor_id AND NEW.supervisor_kind = 'objective'
          AND objective.coordinator_session_id = NEW.session_id AND objective.context_id = NEW.context_id
          AND objective.initiating_principal_id = NEW.initiating_principal_id
      ) GROUP BY route.discussion_id,route.principal_id,route.context_id,route.main_visible";

macro_rules! discussion_migration {
    ($database:ty, $sqlite:literal) => {
        async fn migrate_comment_discussions(
            pool: &sqlx::Pool<$database>,
        ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            for (column, definition) in [
                ("discussion_id", "TEXT"),
                ("main_visible", "INTEGER NOT NULL DEFAULT 1 CHECK(main_visible IN (0,1))"),
            ] {
                if $sqlite {
                    let sql = format!("SELECT name FROM pragma_table_info('session_message_timeline') WHERE name = '{column}' LIMIT 1");
                    if sqlx::query_scalar::<_, String>(&sql).fetch_optional(pool).await?.is_none() {
                        sqlx::query(&format!("ALTER TABLE session_message_timeline ADD COLUMN {column} {definition}")).execute(pool).await?;
                    }
                } else {
                    sqlx::query(&format!("ALTER TABLE session_message_timeline ADD COLUMN IF NOT EXISTS {column} {definition}")).execute(pool).await?;
                }
            }
            if $sqlite {
                if sqlx::query_scalar::<_, String>("SELECT name FROM pragma_table_info('session_message_requests') WHERE name = 'discussion_id' LIMIT 1").fetch_optional(pool).await?.is_none() {
                    sqlx::query("ALTER TABLE session_message_requests ADD COLUMN discussion_id TEXT").execute(pool).await?;
                }
            } else {
                sqlx::query("ALTER TABLE session_message_requests ADD COLUMN IF NOT EXISTS discussion_id TEXT").execute(pool).await?;
            }
            if $sqlite {
                if sqlx::query_scalar::<_,String>("SELECT name FROM pragma_table_info('events') WHERE name = 'main_presentation' LIMIT 1").fetch_optional(pool).await?.is_none() {
                    sqlx::query("ALTER TABLE events ADD COLUMN main_presentation INTEGER NOT NULL DEFAULT 1").execute(pool).await?;
                }
            } else {
                sqlx::query("ALTER TABLE events ADD COLUMN IF NOT EXISTS main_presentation INTEGER NOT NULL DEFAULT 1").execute(pool).await?;
            }
            let topics = crate::sdk::conversation_event_topics().iter().map(|topic| format!("'{topic}'")).collect::<Vec<_>>().join(",");
            let keys = if $sqlite { "session_id" } else { "session_id,sequence" };
            sqlx::query(&format!("CREATE INDEX IF NOT EXISTS idx_events_main_conversation ON events({keys}) WHERE main_presentation = 1 AND topic IN ({topics})")).execute(pool).await?;
            if $sqlite {
                if sqlx::query_scalar::<_,String>("SELECT name FROM pragma_table_info('events') WHERE name = 'discussion_id' LIMIT 1").fetch_optional(pool).await?.is_none() {
                    sqlx::query("ALTER TABLE events ADD COLUMN discussion_id TEXT").execute(pool).await?;
                }
            } else {
                sqlx::query("ALTER TABLE events ADD COLUMN IF NOT EXISTS discussion_id TEXT").execute(pool).await?;
            }
            let keys=if $sqlite {"session_id,discussion_id"}else{"session_id,discussion_id,sequence"};
            sqlx::query(&format!("CREATE INDEX IF NOT EXISTS idx_events_discussion_page ON events({keys}) WHERE discussion_id IS NOT NULL")).execute(pool).await?;
            let keys=if $sqlite {"session_id"}else{"session_id,sequence"};
            sqlx::query(&format!("CREATE INDEX IF NOT EXISTS idx_events_main_page ON events({keys}) WHERE main_presentation = 1")).execute(pool).await?;
            for statement in super::discussions::TABLES {
                let statement = if $sqlite { statement.to_string() } else { statement.replace("metadata_only = 0", "NOT metadata_only") };
                sqlx::query(&statement).execute(pool).await?;
            }
            let source = super::discussions::INHERITED_ROUTE;
            if $sqlite {
                sqlx::query(&format!(
                    "CREATE TRIGGER IF NOT EXISTS project_thread_discussion AFTER INSERT ON threads BEGIN
                     SELECT CASE WHEN (SELECT COUNT(DISTINCT discussion_id) FROM ({source})) > 1
                       THEN RAISE(ABORT,'Conflicting discussion supervision routes') END;
                     INSERT OR IGNORE INTO session_discussion_roots
                       (session_id,root_turn_id,discussion_id,principal_id,context_id,input_bytes_bound,main_visible)
                       {source}; END"
                )).execute(pool).await?;
            } else {
                sqlx::query(&format!(
                    "CREATE OR REPLACE FUNCTION project_thread_discussion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
                       IF (SELECT COUNT(DISTINCT discussion_id) FROM ({source}) inherited) > 1 THEN
                         RAISE EXCEPTION 'Conflicting discussion supervision routes';
                       END IF;
                       INSERT INTO session_discussion_roots
                         (session_id,root_turn_id,discussion_id,principal_id,context_id,input_bytes_bound,main_visible)
                         {source} ON CONFLICT(session_id,root_turn_id) DO NOTHING;
                       RETURN NEW;
                     END $$"
                )).execute(pool).await?;
                sqlx::query("DROP TRIGGER IF EXISTS project_thread_discussion ON threads").execute(pool).await?;
                sqlx::query("CREATE TRIGGER project_thread_discussion AFTER INSERT ON threads FOR EACH ROW EXECUTE FUNCTION project_thread_discussion()").execute(pool).await?;
            }
            Ok(())
        }
    };
}
pub(crate) use discussion_migration;

pub(crate) fn scoped_timeline_statement(
    base: &str,
    before: bool,
    scope: &crate::discussion::TimelineScope,
    postgres: bool,
    text_only: bool,
) -> String {
    let header = base
        .split("FROM session_message_timeline t")
        .next()
        .expect("timeline select");
    let mut parameter = 0;
    let mut bind = || {
        parameter += 1;
        if postgres {
            format!("${parameter}")
        } else {
            "?".into()
        }
    };
    let session = bind();
    let scope_predicate = match scope {
        crate::discussion::TimelineScope::Main => "main_visible = 1".to_string(),
        crate::discussion::TimelineScope::Discussion { .. } => {
            format!("discussion_id = {}", bind())
        }
    };
    let cursor = if before {
        format!(
            " AND (visible_at_micros,entry_id) < ({},{})",
            bind(),
            bind()
        )
    } else {
        String::new()
    };
    let limit = bind();
    let text = if !text_only {
        "TRUE"
    } else if postgres {
        "NOT metadata_only"
    } else {
        "metadata_only = 0"
    };
    let index = if postgres {
        ""
    } else {
        match (scope, text_only) {
            (crate::discussion::TimelineScope::Main, true) => {
                " INDEXED BY idx_main_timeline_text_page"
            }
            (crate::discussion::TimelineScope::Main, false) => " INDEXED BY idx_main_timeline_page",
            (crate::discussion::TimelineScope::Discussion { .. }, true) => {
                " INDEXED BY idx_discussion_timeline_text_page"
            }
            (crate::discussion::TimelineScope::Discussion { .. }, false) => {
                " INDEXED BY idx_discussion_timeline_page"
            }
        }
    };
    let parents = format!("SELECT * FROM session_message_timeline{index} WHERE {text} AND session_id = {session} AND {scope_predicate}{cursor} ORDER BY visible_at_micros DESC,entry_id DESC LIMIT {limit}");
    let joins = if postgres {
        "JOIN LATERAL (SELECT * FROM events WHERE id = t.source_event_id LIMIT 1) e ON TRUE
         LEFT JOIN LATERAL (SELECT * FROM events WHERE id = t.root_turn_id AND session_id = t.session_id AND id <> e.id LIMIT 1) r ON TRUE"
    } else {
        "JOIN events e ON e.id = t.source_event_id
         LEFT JOIN events r ON r.id = t.root_turn_id AND r.session_id = t.session_id AND r.id <> e.id"
    };
    format!("{header}FROM ({parents}) t {joins} ORDER BY t.visible_at_micros DESC,t.entry_id DESC")
}

pub(crate) fn discussion_text_sql(postgres: bool) -> String {
    let field = |path: &str| {
        if postgres {
            let path = path.replace('.', ",");
            format!("CASE WHEN jsonb_typeof(e.payload#>'{{{path}}}')='string' THEN e.payload#>>'{{{path}}}' END")
        } else {
            format!("CASE WHEN json_type(e.payload,'$.{path}')='text' THEN json_extract(e.payload,'$.{path}') END")
        }
    };
    let kind = field("session_io.request.client_metadata.value.kind.value");
    let platform = field("session_io.request.client_metadata.value.source.value.body.value");
    let dashboard = field("session_io.request.client_metadata.value.body.value");
    let plain = field("text");
    let error = field("error");
    let message = field("message");
    format!("COALESCE(CASE WHEN t.display_kind='input' THEN CASE WHEN ({kind})='morphz.platform-input' THEN ({platform}) WHEN ({kind})='morphz.dashboard-discussion' THEN ({dashboard}) END END,({plain}),({error}),({message}),'')")
}

macro_rules! discussion_reads {
    ($database:ty) => {
        async fn read_discussion_root_route(pool:&sqlx::Pool<$database>,session:&str,root:&str)
          -> Result<Option<crate::discussion::DiscussionRootRoute>,Box<dyn std::error::Error+Send+Sync>> {
            use sqlx::Row;
            let mut query=sqlx::QueryBuilder::<$database>::new("SELECT discussion_id,principal_id,main_visible FROM session_discussion_roots WHERE session_id = ");
            query.push_bind(session).push(" AND root_turn_id = ").push_bind(root);
            Ok(query.build().fetch_optional(pool).await?.map(|row|crate::discussion::DiscussionRootRoute {
                discussion_id:row.get("discussion_id"),principal_id:row.get("principal_id"),main_visible:row.get::<i32,_>("main_visible")!=0,
            }))
        }
        async fn discussion_page_budget(pool:&sqlx::Pool<$database>,session:&str,id:&str,before:Option<&super::SessionTimelineCursor>,limit:i64,text_only:bool)
          -> Result<(i64,bool),Box<dyn std::error::Error+Send+Sync>> {
            use sqlx::Row;
            let postgres=stringify!($database).contains("Postgres");
            let mut query=sqlx::QueryBuilder::<$database>::new("SELECT p.entry_id,p.source_event_id,p.root_turn_id,p.visible_at_micros,p.display_kind,p.attempt_id,p.is_final,e.id AS event_id,route.input_bytes_bound AS input_bound,");
            query.push(if postgres {"COALESCE(octet_length(e.payload::text),0)+COALESCE(octet_length(r.payload::text),0)+GREATEST(COALESCE(octet_length(e.payload::text),0),COALESCE(octet_length(r.payload::text),0),COALESCE(route.input_bytes_bound,0))"}else{"COALESCE(length(CAST(e.payload AS BLOB)),0)+COALESCE(length(CAST(r.payload AS BLOB)),0)+MAX(COALESCE(length(CAST(e.payload AS BLOB)),0),COALESCE(length(CAST(r.payload AS BLOB)),0),COALESCE(route.input_bytes_bound,0))"});
            query.push(" AS payload_bytes FROM (SELECT * FROM session_message_timeline");
            if !postgres {query.push(if text_only {" INDEXED BY idx_discussion_timeline_text_page"}else{" INDEXED BY idx_discussion_timeline_page"});}
            query.push(" WHERE session_id = ").push_bind(session).push(" AND discussion_id = ").push_bind(id);
            if text_only {query.push(if postgres {" AND NOT metadata_only"}else{" AND metadata_only = 0"});}
            if let Some(before)=before {query.push(" AND (visible_at_micros,entry_id) < (").push_bind(before.visible_at_micros).push(",").push_bind(&before.entry_id).push(")");}
            query.push(" ORDER BY visible_at_micros DESC,entry_id DESC LIMIT ").push_bind(limit).push(") p LEFT JOIN events e ON e.id=p.source_event_id LEFT JOIN events r ON r.id=p.root_turn_id AND r.id<>e.id AND r.session_id=p.session_id LEFT JOIN session_discussion_roots route ON route.session_id=p.session_id AND route.root_turn_id=p.root_turn_id ORDER BY p.visible_at_micros DESC,p.entry_id DESC");
            let rows=query.build().fetch_all(pool).await?;
            let mut total=0_i64;let mut count=0_i64;
            for row in &rows {
                if row.get::<Option<String>,_>("event_id").is_none()||row.get::<Option<i64>,_>("input_bound").is_none(){return Err("Discussion timeline has incomplete native input provenance".into())}
                let bytes=row.get::<i64,_>("payload_bytes").saturating_add(16*1024);
                if total.saturating_add(bytes)>crate::discussion::MAX_PAGE_BYTES as i64 {
                    if count==0 {return Err(Box::new(crate::discussion::PageBudgetBoundary{entry_id:row.get("entry_id"),event_id:row.get("source_event_id"),root_turn_id:row.get("root_turn_id"),visible_at_micros:row.get("visible_at_micros"),display_kind:row.get("display_kind"),attempt_id:row.get("attempt_id"),final_event:row.get("is_final"),content_bytes:bytes}));}
                    break;
                }
                total+=bytes;count+=1;
            }
            Ok((count,count<rows.len() as i64))
        }
        async fn read_discussion_chunk(pool:&sqlx::Pool<$database>,session:&str,discussion:&str,entry:&str,event:&str,offset:i64)
          -> Result<Option<crate::discussion::MessageChunk>,Box<dyn std::error::Error+Send+Sync>> {
            use sqlx::Row;
            let postgres=stringify!($database).contains("Postgres");
            let text=super::discussions::discussion_text_sql(postgres);
            let mut query=sqlx::QueryBuilder::<$database>::new(format!("WITH selected AS (SELECT t.entry_id,t.source_event_id,t.root_turn_id,t.visible_at_micros,t.display_kind,{text} AS body FROM session_message_timeline t JOIN events e ON e.id=t.source_event_id WHERE t.session_id = "));
            query.push_bind(session).push(" AND t.discussion_id = ").push_bind(discussion).push(" AND t.entry_id = ").push_bind(entry).push(" AND t.source_event_id = ").push_bind(event).push(" LIMIT 1) SELECT entry_id,source_event_id,root_turn_id,visible_at_micros,display_kind,");
            query.push(if postgres {"substring(body FROM "}else{"substr(body,"}).push_bind(offset+1).push(if postgres {"::integer FOR 32768)"}else{",32768)"}).push(" AS content,");
            query.push(if postgres {"char_length(body)::bigint"}else{"length(body)"}).push(" AS characters FROM selected");
            let Some(row)=query.build().fetch_optional(pool).await? else {return Ok(None)};
            let characters=row.get::<i64,_>("characters");let text=row.get::<String,_>("content");
            let next=offset+text.chars().count() as i64;
            Ok(Some(crate::discussion::MessageChunk{id:row.get("entry_id"),event_id:row.get("source_event_id"),root_id:row.get("root_turn_id"),created_at_micros:row.get("visible_at_micros"),kind:row.get("display_kind"),text,next_offset:(next<characters).then_some(next)}))
        }
        async fn read_discussion_descriptors(
            pool: &sqlx::Pool<$database>,
            session: &str,
            principal: Option<&str>,
            source: Option<&str>,
            id: Option<&str>,
            before: Option<&crate::discussion::DiscussionCursor>,
            limit: usize,
        ) -> Result<Vec<crate::discussion::DiscussionDescriptor>, Box<dyn std::error::Error + Send + Sync>> {
            use sqlx::Row;
            let mut query = sqlx::QueryBuilder::<$database>::new("SELECT session_id,id,principal_id,source_event_id,source_key,title,preview,locator_json,main_visible,created_at_micros FROM session_discussions WHERE session_id = ");
            query.push_bind(session);
            if let Some(principal) = principal { query.push(" AND principal_id = ").push_bind(principal); }
            if let Some(source) = source { query.push(" AND source_key = ").push_bind(source); }
            if let Some(id) = id { query.push(" AND id = ").push_bind(id); }
            if let Some(before) = before { query.push(" AND (created_at_micros,id) < (").push_bind(before.created_at_micros).push(",").push_bind(&before.id).push(")"); }
            query.push(" ORDER BY created_at_micros DESC,id DESC LIMIT ").push_bind(i64::try_from(limit.clamp(1,crate::discussion::MAX_PAGE_ROWS + 1))?);
            let rows = query.build().fetch_all(pool).await?;
            rows.into_iter().map(|row| Ok(crate::discussion::DiscussionDescriptor {
                id: row.get("id"),session_id:row.get("session_id"),principal_id:row.get("principal_id"),source_event_id:row.get("source_event_id"),source_key:row.get("source_key"),title:row.get("title"),preview:row.get("preview"),locator:serde_json::from_str(&row.get::<String,_>("locator_json"))?,publish_to_session:row.get::<i32,_>("main_visible") != 0,created_at_micros:row.get("created_at_micros"),
            })).collect()
        }
    };
}
pub(crate) use discussion_reads;

macro_rules! discussion_projection {
    ($database:ty) => {
        async fn project_event_discussion_route(
            tx: &mut sqlx::Transaction<'_, $database>, event: &crate::event::Event,
        ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            use sqlx::Row;
            let Some(session) = event.payload.get("session_id").and_then(serde_json::Value::as_str) else {return Ok(())};
            let Some(root) = event.payload.get("root_turn_id").and_then(serde_json::Value::as_str) else {return Ok(())};
            let mut read = sqlx::QueryBuilder::<$database>::new("SELECT main_visible,discussion_id FROM session_discussion_roots WHERE session_id = ");
            read.push_bind(session).push(" AND root_turn_id = ").push_bind(root);
            if let Some(row) = read.build().fetch_optional(&mut **tx).await? {
                let mut update = sqlx::QueryBuilder::<$database>::new("UPDATE events SET main_presentation = ");
                update.push_bind(row.get::<i32,_>("main_visible")).push(", discussion_id = ").push_bind(row.get::<String,_>("discussion_id")).push(" WHERE id = ").push_bind(&event.id);
                update.build().execute(&mut **tx).await?;
            }
            Ok(())
        }
        async fn project_discussion_in_transaction(
            tx: &mut sqlx::Transaction<'_, $database>,
            event: &crate::event::Event,
            entry: &super::session_timeline::TimelineMutation,
        ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            use sqlx::Row;
            let mut selected = None;
            if crate::event::is_input_event(event) {
                if let Some(request) = crate::discussion::from_event(event)? {
                    let client_id = event.payload.get("client_message_id").and_then(serde_json::Value::as_str).ok_or("Discussion input requires a command ID")?;
                    request.validate(client_id)?;
                    let native = event.payload.get("session_io").and_then(|io| io.pointer("/request/discussion"))
                        .cloned().map(serde_json::from_value::<crate::discussion::DiscussionInput>).transpose()?;
                    if native.as_ref() != Some(&request) {
                        return Err("Discussion route must come from the accepted native Session IO request".into());
                    }
                    let mut claim = sqlx::QueryBuilder::<$database>::new("SELECT 1 FROM session_message_requests WHERE session_id = ");
                    claim.push_bind(&entry.session_id).push(" AND client_message_id = ").push_bind(client_id).push(" AND event_id = ").push_bind(&event.id);
                    if claim.build().fetch_optional(&mut **tx).await?.is_none() {
                        return Err("Discussion source requires an atomic message acceptance receipt".into());
                    }
                    let principal = event.payload.get("principal_id").and_then(serde_json::Value::as_str).ok_or("Discussion input requires a Principal")?;
                    let context = event.payload.get("context_id").and_then(serde_json::Value::as_str).ok_or("Discussion input requires a Context")?;
                    if let Some(source) = request.source.as_ref() {
                        if source.locator.get("kind").and_then(serde_json::Value::as_str) == Some("runtime-event") {
                            let source_id = source.locator.get("event_id").and_then(serde_json::Value::as_str).filter(|value| !value.is_empty() && value.len() <= 512).ok_or("A native message source requires its exact Event identity")?;
                            let mut source_read = sqlx::QueryBuilder::<$database>::new("SELECT 1 FROM events WHERE id = ");
                            source_read.push_bind(source_id).push(" AND session_id = ").push_bind(&entry.session_id);
                            if source_read.build().fetch_optional(&mut **tx).await?.is_none() {
                                return Err("Discussion source is unavailable in the authorized Session".into());
                            }
                        }
                        let preview: String = source.text.chars().take(160).collect();
                        let metadata=event.payload.get("session_io").and_then(|io| io.pointer("/request/client_metadata")).cloned().and_then(|value|serde_json::from_value::<crate::session_io::Data>(value).ok());
                        let authored=metadata.as_ref().and_then(|data|match data.get("kind").and_then(crate::session_io::Data::string) {
                            Some("morphz.platform-input")=>data.get("source").and_then(|source|source.get("body")).and_then(crate::session_io::Data::string),
                            Some("morphz.dashboard-discussion")=>data.get("body").and_then(crate::session_io::Data::string),_=>None,
                        }).filter(|text|!text.trim().is_empty()).unwrap_or(&source.title);
                        let title:String=authored.chars().take(120).collect();

                        let mut insert = sqlx::QueryBuilder::<$database>::new("INSERT INTO session_discussions (session_id,id,principal_id,context_id,source_event_id,source_key,title,preview,locator_json,main_visible,created_at_micros) VALUES (");
                        insert.push_bind(&entry.session_id).push(",").push_bind(&request.id).push(",").push_bind(principal).push(",").push_bind(context).push(",").push_bind(&event.id).push(",").push_bind(&source.key).push(",").push_bind(title).push(",").push_bind(preview).push(",").push_bind(serde_json::to_string(&source.locator)?).push(",").push_bind(if request.publish_to_session.unwrap_or(false) { 1_i32 } else { 0_i32 }).push(",").push_bind(entry.visible_at_micros).push(") ON CONFLICT(session_id,id) DO NOTHING");
                        insert.build().execute(&mut **tx).await?;
                    }
                    let mut read = sqlx::QueryBuilder::<$database>::new("SELECT id,principal_id,context_id,source_event_id,main_visible FROM session_discussions WHERE session_id = ");
                    read.push_bind(&entry.session_id).push(" AND id = ").push_bind(&request.id);
                    let row = read.build().fetch_optional(&mut **tx).await?.ok_or("The discussion's first input has not been accepted")?;
                    if row.get::<String,_>("principal_id") != principal
                        || row.get::<String,_>("context_id") != context
                        || (request.source.is_some() && row.get::<String,_>("source_event_id") != event.id)
                    {
                        return Err(crate::steering::conflict("Discussion identity belongs to another accepted input or Principal"));
                    }
                    selected = Some((request.id, principal.to_owned(), context.to_owned(), row.get::<i32,_>("main_visible"),i64::try_from(serde_json::to_vec(&event.payload)?.len())?));
                }
            }
            // Directed supplements inherit the exact target root. Public
            // output and child work use the same native, transaction-bound map.
            let root = event.payload.get("root_turn_id").and_then(serde_json::Value::as_str).unwrap_or(&entry.root_turn_id);
            let mut read = sqlx::QueryBuilder::<$database>::new("SELECT discussion_id,principal_id,context_id,main_visible,input_bytes_bound FROM session_discussion_roots WHERE session_id = ");
            read.push_bind(&entry.session_id).push(" AND root_turn_id = ").push_bind(root);
            if let Some(row) = read.build().fetch_optional(&mut **tx).await? {
                let inherited = (row.get::<String,_>("discussion_id"),row.get::<String,_>("principal_id"),row.get::<String,_>("context_id"),row.get::<i32,_>("main_visible"),row.get::<i64,_>("input_bytes_bound"));
                if selected.as_ref().is_some_and(|value| (value.0.as_str(),value.1.as_str(),value.2.as_str(),value.3) != (inherited.0.as_str(),inherited.1.as_str(),inherited.2.as_str(),inherited.3)) {
                    return Err(crate::steering::conflict("A directed input cannot move work into another discussion"));
                }
                selected = Some(inherited);
            }
            let Some((id,principal,context,visible,_bound)) = selected else { return Ok(()) };
            if event.payload.get("principal_id").and_then(serde_json::Value::as_str).is_some_and(|value| value != principal)
                || event.payload.get("context_id").and_then(serde_json::Value::as_str).is_some_and(|value| value != context)
            {
                return Err("Discussion publication has conflicting native provenance".into());
            }
            if crate::event::is_input_event(event) {
                let mut insert = sqlx::QueryBuilder::<$database>::new("INSERT INTO session_discussion_roots(session_id,root_turn_id,discussion_id,principal_id,context_id,input_bytes_bound,main_visible) VALUES (");
                insert.push_bind(&entry.session_id).push(",").push_bind(&event.id).push(",").push_bind(&id).push(",").push_bind(&principal).push(",").push_bind(&context).push(",").push_bind(i64::try_from(serde_json::to_vec(&event.payload)?.len())?).push(",").push_bind(visible).push(") ON CONFLICT(session_id,root_turn_id) DO NOTHING");
                insert.build().execute(&mut **tx).await?;
                let mut request = sqlx::QueryBuilder::<$database>::new("UPDATE session_message_requests SET discussion_id = ");
                request.push_bind(&id).push(" WHERE session_id = ").push_bind(&entry.session_id).push(" AND event_id = ").push_bind(&event.id);
                request.build().execute(&mut **tx).await?;
            }
            let mut visibility = sqlx::QueryBuilder::<$database>::new("UPDATE events SET main_presentation = ");
            visibility.push_bind(visible).push(", discussion_id = ").push_bind(&id).push(" WHERE id = ").push_bind(&event.id);
            visibility.build().execute(&mut **tx).await?;
            let mut update = sqlx::QueryBuilder::<$database>::new("UPDATE session_message_timeline SET discussion_id = ");
            update.push_bind(&id).push(", main_visible = ").push_bind(visible).push(" WHERE session_id = ").push_bind(&entry.session_id).push(" AND entry_id = ").push_bind(&entry.entry_id);
            update.build().execute(&mut **tx).await?;
            Ok(())
        }
    };
}
pub(crate) use discussion_projection;
