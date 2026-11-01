//! Transaction-maintained read ordering. These fields never authorize work,
//! replace native statuses, or change the original Session clock/revision.
use sqlx::Row;
type Error = Box<dyn std::error::Error + Send + Sync>;

fn json_field(postgres: bool, field: &str, key: &str) -> String {
    if postgres {
        format!("{field}->>'{key}'")
    } else {
        format!("CASE WHEN json_valid({field}) THEN json_extract({field},'$.{key}') END")
    }
}
fn rank(postgres: bool, session: &str) -> String {
    let wait = json_field(postgres, "o.wait_condition_json", "kind");
    let question = json_field(postgres, "d.metadata_json", "source");
    let goal = |condition: &str| {
        format!("EXISTS(SELECT 1 FROM objectives o WHERE o.context_id=s.context_id AND (o.coordinator_session_id=s.id OR o.delivery_session_id=s.id) AND o.status IN ('active','paused','blocked') AND ({condition}))")
    };
    let job = |status: &str| {
        format!("EXISTS(SELECT 1 FROM execution_jobs j WHERE j.context_id=s.context_id AND j.session_id=s.id AND j.status='{status}')")
    };
    let activation = |status: &str| {
        format!("EXISTS(SELECT 1 FROM thread_activations a WHERE a.session_id=s.id AND a.status='{status}')")
    };
    let human=format!("EXISTS(SELECT 1 FROM threads t JOIN scheduler_dependencies d ON d.owner_kind='thread' AND d.owner_id=t.id AND d.owner_generation=t.generation AND d.dependency_kind='user_input' AND d.status='pending' AND d.required=TRUE WHERE t.session_id=s.id AND t.status='open' AND t.control_state<>'paused' AND {question}='request_user_input')");
    let expression = format!("CASE WHEN {} OR {} OR {human} THEN 0 WHEN {} OR {} OR {} THEN 1 WHEN {} OR {} OR {} THEN 2 WHEN {} OR EXISTS(SELECT 1 FROM threads t WHERE t.session_id=s.id AND t.status='open') THEN 3 ELSE 4 END",
        goal(&format!("o.status='blocked' OR {wait} IN ('user_input','permission')")),job("waiting_approval"),
        activation("running"),job("running"),goal("o.status='active' AND o.wait_condition_json IS NULL AND (o.active_evaluation_id IS NOT NULL OR o.completion_intent_json IS NOT NULL)"),
        activation("queued"),job("queued"),goal("o.status='active' AND o.wait_condition_json IS NULL AND o.active_evaluation_id IS NULL AND o.completion_intent_json IS NULL"),goal("TRUE"));
    expression.replace("s.", &format!("{session}."))
}

struct Source {
    table: &'static str,
    columns: &'static [&'static str],
}
fn sources() -> [Source; 6] {
    [
        Source {
            table: "sessions",
            columns: &["context_id"],
        },
        Source {
            table: "objectives",
            columns: &[
                "context_id",
                "coordinator_session_id",
                "delivery_session_id",
                "status",
                "wait_condition_json",
                "active_evaluation_id",
                "completion_intent_json",
            ],
        },
        Source {
            table: "thread_activations",
            columns: &["context_id", "session_id", "status"],
        },
        Source {
            table: "execution_jobs",
            columns: &["context_id", "session_id", "status"],
        },
        Source {
            table: "threads",
            columns: &[
                "context_id",
                "session_id",
                "status",
                "control_state",
                "generation",
            ],
        },
        Source {
            table: "scheduler_dependencies",
            columns: &[
                "owner_kind",
                "owner_id",
                "owner_generation",
                "dependency_kind",
                "status",
                "required",
                "metadata_json",
            ],
        },
    ]
}
fn affected(source: &Source, refs: &[&str]) -> String {
    refs.iter().flat_map(|reference|match source.table {
        "sessions"=>vec![format!("SELECT {reference}.id")],
        "objectives"=>vec![format!("SELECT {reference}.coordinator_session_id"),format!("SELECT {reference}.delivery_session_id")],
        "scheduler_dependencies"=>vec![format!("SELECT t.session_id FROM threads t WHERE {reference}.owner_kind='thread' AND t.id={reference}.owner_id")],
        _=>vec![format!("SELECT {reference}.session_id")],
    }).collect::<Vec<_>>().join(" UNION ")
}
fn relevance(source: &Source, reference: &str) -> String {
    match source.table {
        "sessions" => "TRUE".into(),
        "objectives" => format!("{reference}.status IN ('active','paused','blocked')"),
        "threads" => format!("{reference}.status='open'"),
        "thread_activations" => format!("{reference}.status IN ('queued','running')"),
        "execution_jobs" => {
            format!("{reference}.status IN ('queued','running','waiting_approval')")
        }
        _ => {
            format!("{reference}.owner_kind='thread' AND {reference}.dependency_kind='user_input'")
        }
    }
}
fn indices() -> [&'static str; 7] {
    [
    "CREATE INDEX IF NOT EXISTS idx_session_priority_missing ON sessions(id) WHERE directory_priority IS NULL",
    "CREATE INDEX IF NOT EXISTS idx_session_context_priority ON sessions(context_id,directory_priority,last_activity_at DESC,id)",
    "CREATE INDEX IF NOT EXISTS idx_session_context_status_priority ON sessions(context_id,status,directory_priority,last_activity_at DESC,id)",
    "CREATE INDEX IF NOT EXISTS idx_session_status_priority ON sessions(status,directory_priority,last_activity_at DESC,id)",
    "CREATE INDEX IF NOT EXISTS idx_priority_goal_coordinator ON objectives(coordinator_session_id,context_id,status)",
    "CREATE INDEX IF NOT EXISTS idx_priority_goal_delivery ON objectives(delivery_session_id,context_id,status)",
    "CREATE INDEX IF NOT EXISTS idx_priority_job_session_status ON execution_jobs(session_id,status,context_id)",
]
}
macro_rules! backfill {
    ($db:ty,$pool:expr,$expression:expr) => {{
        let mut after = String::new();
        loop {
            let mut query = sqlx::QueryBuilder::<$db>::new(
                "SELECT id FROM sessions WHERE directory_priority IS NULL AND id>",
            );
            query
                .push_bind(after.clone())
                .push(" ORDER BY id LIMIT 200");
            let rows = query.build().fetch_all($pool).await?;
            if rows.is_empty() {
                break;
            }
            after = rows.last().unwrap().get("id");
            let mut update =
                sqlx::QueryBuilder::<$db>::new("UPDATE sessions AS s SET directory_priority=");
            update.push($expression).push(" WHERE s.id IN (");
            {
                let mut ids = update.separated(",");
                for row in &rows {
                    ids.push_bind(row.get::<String, _>("id"));
                }
            }
            update.push(")");
            update.build().execute($pool).await?;
        }
    }};
}
pub(crate) async fn sqlite(pool: &sqlx::SqlitePool) -> Result<(), Error> {
    if sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name='directory_priority'",
    )
    .fetch_one(pool)
    .await?
        == 0
    {
        sqlx::query("ALTER TABLE sessions ADD COLUMN directory_priority INTEGER")
            .execute(pool)
            .await?;
    }
    for sql in indices() {
        sqlx::query(sql).execute(pool).await?;
    }
    let expression = rank(false, "sessions");
    for source in sources() {
        for (event, refs) in [
            ("INSERT", vec!["NEW"]),
            ("UPDATE", vec!["OLD", "NEW"]),
            ("DELETE", vec!["OLD"]),
        ] {
            // Session deletion needs no projection update. Other cascaded
            // source deletes may still change a surviving delivery Session.
            if source.table == "sessions" && event == "DELETE" {
                continue;
            }
            let relevance = refs
                .iter()
                .map(|reference| format!("({})", relevance(&source, reference)))
                .collect::<Vec<_>>()
                .join(" OR ");
            let changed = if event == "UPDATE" {
                format!(
                    " AND ({})",
                    source
                        .columns
                        .iter()
                        .map(|column| format!("OLD.{column} IS NOT NEW.{column}"))
                        .collect::<Vec<_>>()
                        .join(" OR ")
                )
            } else {
                String::new()
            };
            let update = if event == "UPDATE" {
                format!("UPDATE OF {}", source.columns.join(","))
            } else {
                event.into()
            };
            let sql=format!("CREATE TRIGGER IF NOT EXISTS morphz_session_priority_{}_{} AFTER {update} ON {} WHEN ({relevance}){changed} BEGIN UPDATE sessions SET directory_priority={expression} WHERE sessions.id IN ({}); END",source.table,event.to_lowercase(),source.table,affected(&source,&refs));
            sqlx::query(&sql).execute(pool).await?;
        }
    }
    backfill!(sqlx::Sqlite, pool, rank(false, "s").as_str());
    Ok(())
}
pub(crate) async fn postgres(pool: &sqlx::PgPool) -> Result<(), Error> {
    sqlx::query("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS directory_priority INTEGER")
        .execute(pool)
        .await?;
    for sql in indices() {
        sqlx::query(sql).execute(pool).await?;
    }
    let expression = rank(true, "s");
    for source in sources() {
        for (event, refs) in [
            ("INSERT", vec!["NEW"]),
            ("UPDATE", vec!["OLD", "NEW"]),
            ("DELETE", vec!["OLD"]),
        ] {
            if source.table == "sessions" && event == "DELETE" {
                continue;
            }
            let function = format!(
                "morphz_session_priority_{}_{}",
                source.table,
                event.to_lowercase()
            );
            let sql=format!("CREATE OR REPLACE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE sessions AS s SET directory_priority={expression} WHERE s.id IN ({}); RETURN NULL; END $$",affected(&source,&refs));
            sqlx::query(&sql).execute(pool).await?;
            let relevance = refs
                .iter()
                .map(|reference| format!("({})", relevance(&source, reference)))
                .collect::<Vec<_>>()
                .join(" OR ");
            let changed = if event == "UPDATE" {
                format!(
                    " AND ({})",
                    source
                        .columns
                        .iter()
                        .map(|column| format!("OLD.{column} IS DISTINCT FROM NEW.{column}"))
                        .collect::<Vec<_>>()
                        .join(" OR ")
                )
            } else {
                String::new()
            };
            let update = if event == "UPDATE" {
                format!("UPDATE OF {}", source.columns.join(","))
            } else {
                event.into()
            };
            let sql=format!("CREATE TRIGGER morphz_session_priority_{}_{} AFTER {update} ON {} FOR EACH ROW WHEN (({relevance}){changed}) EXECUTE FUNCTION {function}()",source.table,event.to_lowercase(),source.table);
            let name = format!(
                "morphz_session_priority_{}_{}",
                source.table,
                event.to_lowercase()
            );
            let sql=format!("DO $morphz_trigger$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='{}'::regclass AND tgname='{name}') THEN {sql}; END IF; END $morphz_trigger$",source.table);
            sqlx::query(&sql).execute(pool).await?;
        }
    }
    backfill!(sqlx::Postgres, pool, expression.as_str());
    Ok(())
}

// Every branch seeks an already maintained, Context-leading index. The outer
// union contains only independently capped heads, never a lifetime window.
macro_rules! session_heads_query {
    ($db:ty,$contexts:expr,$archived:expr,$limit:expr,$postgres:expr)=>{{
        (||->Result<sqlx::QueryBuilder<'static,$db>,Box<dyn std::error::Error+Send+Sync>>{
            let contexts=$contexts;
            if contexts.len()>100 || $limit>201 {return Err("Session head budget exceeded".into());}
            let mut query=sqlx::QueryBuilder::<$db>::new("");
            for (ordinal,context) in contexts.iter().enumerate() {
                if ordinal>0 {query.push(" UNION ALL ");}
                query.push("SELECT * FROM (SELECT s.id,s.agent_id,s.context_id,s.parent_session_id,s.title,s.status,s.model_alias,s.reasoning_effort,s.permission_mode,s.sandbox_mode,s.default_target_id,s.context_sharing,s.created_at,s.updated_at,s.last_activity_at,")
                    .push(if $postgres {"s.attention_state,s.attention_revision,s.attention_reason,s.attention_changed_at,s.attention_event_id FROM sessions s"} else {"sm.attention_state,sm.attention_revision,sm.attention_reason,sm.attention_changed_at,sm.attention_event_id FROM sessions s JOIN session_mounts sm ON sm.session_id=s.id AND sm.unmounted_at IS NULL"})
                    .push(" WHERE s.context_id=").push_bind(context.clone());
                if !$archived {query.push(" AND s.status='active'");}
                query.push(" ORDER BY s.directory_priority,s.last_activity_at DESC,s.id LIMIT ").push_bind($limit.clamp(1,201) as i64).push(") session_head");
            }
            Ok(query)
        })()
    }};
}
pub(crate) use session_heads_query;
