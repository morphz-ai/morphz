use super::{
    append_direct_thread_signal_in_tx, append_event_in_tx, now_text, PostgresStore, StoreError,
};
use crate::event::{Event, TYPE_RUNTIME_WAKE, TYPE_SESSION_SIGNAL};
use crate::memory::{
    message_request_fingerprint, stable_thread_id, stable_thread_signal_id,
    BackgroundSessionWakeClaim, BackgroundThreadWakeClaim, DeliveryIngressStore,
    InterruptedDialogueTurn, MessageClaim, MessageDispatchMode, SessionSignalClaim,
    DEFAULT_THREAD_SIGNAL_BATCH_LIMIT,
};
use serde_json::{json, Value as JsonValue};
use sqlx::{PgPool, Postgres, Row};
use std::collections::{HashMap, HashSet};

pub(super) async fn migrate(pool: &PgPool) -> Result<(), StoreError> {
    for statement in [
        r#"CREATE TABLE IF NOT EXISTS session_message_requests (
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            client_message_id TEXT NOT NULL,
            event_id TEXT NOT NULL,
            request_fingerprint TEXT,
            created_at TEXT NOT NULL,
            PRIMARY KEY(session_id, client_message_id),
            UNIQUE(event_id)
        )"#,
        r#"CREATE INDEX IF NOT EXISTS idx_pg_session_message_requests_event
           ON session_message_requests(event_id)"#,
        r#"ALTER TABLE session_message_requests
           ADD COLUMN IF NOT EXISTS request_fingerprint TEXT"#,
    ] {
        sqlx::query(statement).execute(pool).await?;
    }
    Ok(())
}

async fn append_dialogue_signal_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    agent_id: &str,
    context_id: &str,
    session_id: &str,
    event: &Event,
    dispatch_mode: MessageDispatchMode,
) -> Result<(), StoreError> {
    let principal_id = event
        .payload
        .get("principal_id")
        .and_then(JsonValue::as_str);
    let sequence: i64 = sqlx::query_scalar("SELECT sequence FROM events WHERE id = $1")
        .bind(&event.id)
        .fetch_one(&mut **tx)
        .await?;
    let batch_limit = i64::try_from(DEFAULT_THREAD_SIGNAL_BATCH_LIMIT)?;
    let now = now_text();

    let queued = if dispatch_mode == MessageDispatchMode::Interrupt {
        sqlx::query(
            r#"SELECT activation.id AS activation_id, thread.id AS thread_id,
                  thread.generation AS thread_generation
           FROM thread_activations activation
           JOIN threads thread
             ON thread.root_turn_id = activation.root_turn_id
            AND thread.generation = activation.generation
           LEFT JOIN events root_event ON root_event.id = thread.root_turn_id
           WHERE activation.session_id = $1
             AND activation.status = 'queued'
             AND activation.trigger_kind = 'chat/user_message'
             AND root_event.type = 'user_message'
             AND root_event.topic = 'chat/user_message'
             AND thread.kind = 'dialogue_turn'
             AND thread.status = 'open'
             AND thread.control_state = 'active'
             AND COALESCE(root_event.payload ->> 'dispatch_mode', 'interrupt') = 'interrupt'
             AND (
               SELECT COUNT(*) FROM activation_signals links
               WHERE links.activation_id = activation.id
             ) < $2
             AND activation.initiating_principal_id IS NOT DISTINCT FROM $3
           ORDER BY activation.trigger_sequence, activation.id
           LIMIT 1
           FOR UPDATE OF activation, thread"#,
        )
        .bind(session_id)
        .bind(batch_limit)
        .bind(principal_id)
        .fetch_optional(&mut **tx)
        .await?
    } else {
        None
    };

    let (thread_id, thread_generation, activation_id) = if let Some(row) = queued {
        (
            row.get::<String, _>("thread_id"),
            row.get::<i64, _>("thread_generation"),
            Some(row.get::<String, _>("activation_id")),
        )
    } else {
        let pending = if dispatch_mode == MessageDispatchMode::Interrupt {
            sqlx::query(
                r#"SELECT thread.id AS thread_id, thread.generation AS thread_generation
               FROM threads thread
               JOIN thread_signals signal ON signal.thread_id = thread.id
               LEFT JOIN events root_event ON root_event.id = thread.root_turn_id
               WHERE thread.session_id = $1
                 AND thread.kind = 'dialogue_turn'
                 AND thread.status = 'open'
                 AND thread.control_state = 'active'
                 AND signal.status = 'pending'
                 AND root_event.type = 'user_message'
                 AND root_event.topic = 'chat/user_message'
                 AND COALESCE(root_event.payload ->> 'dispatch_mode', 'interrupt') = 'interrupt'
                 AND thread.initiating_principal_id IS NOT DISTINCT FROM $2
                 AND NOT EXISTS (
                   SELECT 1 FROM thread_activations activation
                   WHERE activation.root_turn_id = thread.root_turn_id
                     AND activation.generation = thread.generation
                     AND activation.status IN ('queued', 'running')
                 )
               GROUP BY thread.id, thread.generation
               HAVING COUNT(*) < $3
               ORDER BY MIN(signal.sequence), thread.id
               LIMIT 1"#,
            )
            .bind(session_id)
            .bind(principal_id)
            .bind(batch_limit)
            .fetch_optional(&mut **tx)
            .await?
        } else {
            None
        };
        if let Some(row) = pending {
            (
                row.get::<String, _>("thread_id"),
                row.get::<i64, _>("thread_generation"),
                None,
            )
        } else {
            let thread_id = stable_thread_id(&event.id);
            sqlx::query(
                r#"INSERT INTO threads
                   (id, revision, generation, agent_id, context_id, session_id,
                    initiating_principal_id, root_turn_id, kind, status, control_state,
                    executor_kind, lifetime, supervisor_kind, supervisor_id,
                    supervision_generation, completion_contract_json, delivery_status,
                    created_at, updated_at)
                   VALUES ($1, 1, 1, $2, $3, $4, $5, $6, 'dialogue_turn', 'open',
                           'active', 'self', 'durable', 'runtime', 'dialogue-router', 1,
                           '{}'::jsonb, 'none', $7, $7)"#,
            )
            .bind(&thread_id)
            .bind(agent_id)
            .bind(context_id)
            .bind(session_id)
            .bind(principal_id)
            .bind(&event.id)
            .bind(&now)
            .execute(&mut **tx)
            .await?;
            (thread_id, 1, None)
        }
    };

    let signal_id = stable_thread_signal_id(&event.id);
    let status = if activation_id.is_some() {
        "claimed"
    } else {
        "pending"
    };
    sqlx::query(
        r#"INSERT INTO thread_signals
           (id, thread_id, thread_generation, event_id, principal_id, sequence, kind,
            parent_activation_id, status, created_at, claimed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10)"#,
    )
    .bind(&signal_id)
    .bind(&thread_id)
    .bind(thread_generation)
    .bind(&event.id)
    .bind(principal_id)
    .bind(sequence)
    .bind(&event.topic)
    .bind(status)
    .bind(&now)
    .bind(activation_id.as_ref().map(|_| now.as_str()))
    .execute(&mut **tx)
    .await?;

    if let Some(activation_id) = activation_id {
        let ordinal: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(ordinal), -1) + 1 FROM activation_signals WHERE activation_id = $1",
        )
        .bind(&activation_id)
        .fetch_one(&mut **tx)
        .await?;
        sqlx::query(
            "INSERT INTO activation_signals (activation_id, signal_id, ordinal) VALUES ($1, $2, $3)",
        )
        .bind(activation_id)
        .bind(signal_id)
        .bind(ordinal)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn interrupt_dialogue_turn_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    agent_id: &str,
    context_id: &str,
    session_id: &str,
    event: &Event,
) -> Result<Option<InterruptedDialogueTurn>, StoreError> {
    let Some(row) = sqlx::query(
        r#"WITH predecessor AS (
             SELECT request.event_id
             FROM session_message_requests request
             WHERE request.session_id = $1 AND request.event_id != $2
             ORDER BY request.created_at DESC, request.event_id DESC
             LIMIT 1
           )
           SELECT activation.id AS activation_id,
                  activation.root_turn_id AS root_turn_id,
                  thread.id AS thread_id,
                  thread.generation AS thread_generation
           FROM predecessor
           JOIN thread_signals signal ON signal.event_id = predecessor.event_id
           JOIN threads thread
             ON thread.id = signal.thread_id
            AND thread.generation = signal.thread_generation
           JOIN activation_signals link ON link.signal_id = signal.id
           JOIN thread_activations activation ON activation.id = link.activation_id
           WHERE activation.session_id = $1
             AND activation.status = 'running'
             AND activation.trigger_kind = 'chat/user_message'
             AND activation.dialogue_lane_released_at IS NULL
             AND thread.kind = 'dialogue_turn'
             AND thread.status = 'open'
             AND thread.control_state = 'active'
           LIMIT 1
           FOR UPDATE OF activation, thread, signal"#,
    )
    .bind(session_id)
    .bind(&event.id)
    .fetch_optional(&mut **tx)
    .await?
    else {
        return Ok(None);
    };

    let interrupted = InterruptedDialogueTurn {
        activation_id: row.get("activation_id"),
        root_turn_id: row.get("root_turn_id"),
        thread_id: row.get("thread_id"),
    };
    let thread_generation = row.get::<i64, _>("thread_generation");
    let replacement_thread_id = stable_thread_id(&event.id);
    let principal_id = event
        .payload
        .get("principal_id")
        .and_then(JsonValue::as_str);
    let now = now_text();
    sqlx::query(
        r#"INSERT INTO threads
           (id, revision, generation, agent_id, context_id, session_id,
            initiating_principal_id, root_turn_id, kind, status, control_state,
            executor_kind, lifetime, supervisor_kind, supervisor_id,
            supervision_generation, completion_contract_json, delivery_status,
            created_at, updated_at)
           VALUES ($1, 1, 1, $2, $3, $4, $5, $6, 'dialogue_turn', 'open',
                   'active', 'self', 'durable', 'runtime', 'dialogue-router', 1,
                   '{}'::jsonb, 'none', $7, $7)"#,
    )
    .bind(&replacement_thread_id)
    .bind(agent_id)
    .bind(context_id)
    .bind(session_id)
    .bind(principal_id)
    .bind(&event.id)
    .bind(&now)
    .execute(&mut **tx)
    .await?;

    let activation = sqlx::query(
        r#"UPDATE thread_activations
           SET revision = revision + 1, status = 'cancelled', claimed_by = NULL,
               lease_expires_at = NULL, updated_at = $1
           WHERE id = $2 AND status = 'running'
             AND dialogue_lane_released_at IS NULL"#,
    )
    .bind(&now)
    .bind(&interrupted.activation_id)
    .execute(&mut **tx)
    .await?;
    if activation.rows_affected() != 1 {
        return Err("DialogueTurn crossed the Execution boundary while being interrupted".into());
    }
    let thread = sqlx::query(
        r#"UPDATE threads
           SET revision = revision + 1, status = 'cancelled', updated_at = $1
           WHERE id = $2 AND generation = $3 AND kind = 'dialogue_turn'
             AND status = 'open'"#,
    )
    .bind(&now)
    .bind(&interrupted.thread_id)
    .bind(thread_generation)
    .execute(&mut **tx)
    .await?;
    if thread.rows_affected() != 1 {
        return Err("DialogueTurn terminated while being interrupted".into());
    }

    sqlx::query(
        r#"DELETE FROM activation_signals
           WHERE activation_id = $1
             AND signal_id IN (
               SELECT id FROM thread_signals
               WHERE thread_id = $2 AND thread_generation = $3
                 AND kind = 'chat/user_message'
             )"#,
    )
    .bind(&interrupted.activation_id)
    .bind(&interrupted.thread_id)
    .bind(thread_generation)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        r#"UPDATE thread_signals
           SET thread_id = $1, thread_generation = 1, status = 'pending',
               claimed_at = NULL, acknowledged_at = NULL,
               parent_activation_id = NULL
           WHERE thread_id = $2 AND thread_generation = $3
             AND kind = 'chat/user_message' AND status = 'claimed'"#,
    )
    .bind(&replacement_thread_id)
    .bind(&interrupted.thread_id)
    .bind(thread_generation)
    .execute(&mut **tx)
    .await?;

    Ok(Some(interrupted))
}

#[async_trait::async_trait]
impl DeliveryIngressStore for PostgresStore {
    async fn commit_thread_delivery(
        &self,
        thread_ids: &[String],
        event: &Event,
    ) -> Result<bool, StoreError> {
        if thread_ids.is_empty() {
            return Err("Thread delivery 至少覆盖一个 thread_id".into());
        }
        let session_id = event
            .payload
            .get("session_id")
            .and_then(JsonValue::as_str)
            .ok_or("Thread delivery Event 缺少 session_id")?;
        let now = now_text();
        let mut tx = self.pool.begin().await?;
        for thread_id in thread_ids {
            let result = sqlx::query(
                r#"UPDATE threads SET revision = revision + 1,
                   delivery_status = 'delivered', delivery_event_id = $1,
                   updated_at = $2
                   WHERE id = $3 AND session_id = $4
                     AND delivery_status IN ('pending', 'deferred')"#,
            )
            .bind(&event.id)
            .bind(&now)
            .bind(thread_id)
            .bind(session_id)
            .execute(&mut *tx)
            .await?;
            if result.rows_affected() != 1 {
                tx.rollback().await?;
                return Ok(false);
            }
        }
        append_event_in_tx(&mut tx, event).await?;
        tx.commit().await?;
        Ok(true)
    }

    async fn claim_message(
        &self,
        session_id: &str,
        client_message_id: &str,
        event: &Event,
        dispatch_mode: MessageDispatchMode,
    ) -> Result<MessageClaim, StoreError> {
        let mut routed_event = event.clone();
        routed_event
            .payload
            .insert("dispatch_mode".to_string(), json!(dispatch_mode.as_str()));
        let event = &routed_event;
        let event_session_id = event
            .payload
            .get("session_id")
            .and_then(JsonValue::as_str)
            .ok_or("用户消息缺少 session_id")?;
        let event_context_id = event
            .payload
            .get("context_id")
            .and_then(JsonValue::as_str)
            .ok_or("用户消息缺少 context_id")?;
        let event_principal_id = event
            .payload
            .get("principal_id")
            .and_then(JsonValue::as_str)
            .ok_or("用户消息缺少 principal_id")?;
        let request_fingerprint = message_request_fingerprint(&event.payload)?;
        let referenced_session_ids = event
            .payload
            .get("references")
            .and_then(JsonValue::as_array)
            .map(|references| {
                references
                    .iter()
                    .filter_map(|reference| {
                        reference
                            .get("session_id")
                            .and_then(JsonValue::as_str)
                            .map(str::to_string)
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut tx = self.pool.begin().await?;
        let mut locked_references = HashMap::new();
        if !referenced_session_ids.is_empty() {
            // Lock the source and every referenced Session in one stable order.
            // This preserves the authorization snapshot without introducing an
            // A -> B / B -> A lock-order deadlock between concurrent messages.
            let mut session_ids = referenced_session_ids.clone();
            session_ids.push(session_id.to_string());
            session_ids.sort();
            session_ids.dedup();
            for row in sqlx::query(
                r#"SELECT id, agent_id, context_id, status
                   FROM sessions WHERE id = ANY($1)
                   ORDER BY id FOR UPDATE"#,
            )
            .bind(&session_ids)
            .fetch_all(&mut *tx)
            .await?
            {
                locked_references.insert(
                    row.get::<String, _>("id"),
                    (
                        row.get::<String, _>("agent_id"),
                        row.get::<String, _>("context_id"),
                        row.get::<String, _>("status"),
                    ),
                );
            }
        }
        let session = sqlx::query(if referenced_session_ids.is_empty() {
            r#"SELECT agent_id, context_id, status, attention_state, attention_revision
               FROM sessions WHERE id = $1 FOR UPDATE"#
        } else {
            r#"SELECT agent_id, context_id, status, attention_state, attention_revision
               FROM sessions WHERE id = $1"#
        })
        .bind(session_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| format!("Session '{session_id}' 不存在"))?;
        let registry_context_id: String = session.get("context_id");
        if event_session_id != session_id || event_context_id != registry_context_id {
            return Err(format!(
                "消息路由与 Session Registry 不一致：请求 Session='{}'，Event Session='{}'，Event Context='{}'，Registry Context='{}'",
                session_id, event_session_id, event_context_id, registry_context_id
            )
            .into());
        }
        if session.get::<String, _>("status") == "archived" {
            tx.commit().await?;
            return Ok(MessageClaim::InactiveSession);
        }
        let principal_is_bound = sqlx::query_scalar::<_, bool>(
            r#"SELECT EXISTS(
                 SELECT 1 FROM session_principal_bindings
                 WHERE session_id = $1 AND principal_id = $2 AND unbound_at IS NULL
               )"#,
        )
        .bind(session_id)
        .bind(event_principal_id)
        .fetch_one(&mut *tx)
        .await?;
        if !principal_is_bound {
            tx.commit().await?;
            return Ok(MessageClaim::ForbiddenPrincipal {
                principal_id: event_principal_id.to_string(),
            });
        }

        let inserted = sqlx::query(
            r#"INSERT INTO session_message_requests
               (session_id, client_message_id, event_id, request_fingerprint, created_at)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT(session_id, client_message_id) DO NOTHING"#,
        )
        .bind(session_id)
        .bind(client_message_id)
        .bind(&event.id)
        .bind(&request_fingerprint)
        .bind(now_text())
        .execute(&mut *tx)
        .await?;
        if inserted.rows_affected() == 0 {
            let existing = sqlx::query(
                r#"SELECT event_id, request_fingerprint FROM session_message_requests
                   WHERE session_id = $1 AND client_message_id = $2"#,
            )
            .bind(session_id)
            .bind(client_message_id)
            .fetch_one(&mut *tx)
            .await?;
            let existing_event_id = existing.get::<String, _>("event_id");
            let existing_fingerprint =
                match existing.get::<Option<String>, _>("request_fingerprint") {
                    Some(fingerprint) => fingerprint,
                    None => {
                        let payload = sqlx::query_scalar::<_, JsonValue>(
                            "SELECT payload FROM events WHERE id = $1",
                        )
                        .bind(&existing_event_id)
                        .fetch_optional(&mut *tx)
                        .await?
                        .ok_or_else(|| {
                            format!("消息幂等记录引用了不存在的 Event '{}'", existing_event_id)
                        })?;
                        let payload = payload
                            .as_object()
                            .ok_or("用户消息 Event payload 不是对象")?;
                        let fingerprint = message_request_fingerprint(payload)?;
                        sqlx::query(
                            r#"UPDATE session_message_requests SET request_fingerprint = $1
                           WHERE session_id = $2 AND client_message_id = $3
                             AND request_fingerprint IS NULL"#,
                        )
                        .bind(&fingerprint)
                        .bind(session_id)
                        .bind(client_message_id)
                        .execute(&mut *tx)
                        .await?;
                        fingerprint
                    }
                };
            tx.commit().await?;
            return Ok(if existing_fingerprint == request_fingerprint {
                MessageClaim::Existing {
                    event_id: existing_event_id,
                }
            } else {
                MessageClaim::Conflict {
                    event_id: existing_event_id,
                }
            });
        }

        if let Some(references) = event
            .payload
            .get("references")
            .and_then(JsonValue::as_array)
        {
            let bound_sessions = if referenced_session_ids.is_empty() {
                HashSet::new()
            } else {
                sqlx::query_scalar::<_, String>(
                    r#"SELECT session_id FROM session_principal_bindings
                       WHERE principal_id = $1 AND session_id = ANY($2)
                         AND unbound_at IS NULL
                       ORDER BY session_id FOR SHARE"#,
                )
                .bind(event_principal_id)
                .bind(&referenced_session_ids)
                .fetch_all(&mut *tx)
                .await?
                .into_iter()
                .collect::<HashSet<_>>()
            };
            let source_agent_id = session.get::<String, _>("agent_id");
            for reference in references {
                if reference.get("kind").and_then(JsonValue::as_str) != Some("session") {
                    tx.rollback().await?;
                    return Ok(MessageClaim::InvalidReference {
                        message: "用户消息包含不支持的引用类型".to_string(),
                    });
                }
                let Some(referenced_session_id) =
                    reference.get("session_id").and_then(JsonValue::as_str)
                else {
                    tx.rollback().await?;
                    return Ok(MessageClaim::InvalidReference {
                        message: "Session 引用缺少 session_id".to_string(),
                    });
                };
                let Some((referenced_agent_id, referenced_context_id, referenced_status)) =
                    locked_references.get(referenced_session_id)
                else {
                    tx.rollback().await?;
                    return Ok(MessageClaim::InvalidReference {
                        message: format!("引用的 Session '{referenced_session_id}' 不存在"),
                    });
                };
                if reference.get("agent_id").and_then(JsonValue::as_str)
                    != Some(referenced_agent_id.as_str())
                    || reference.get("context_id").and_then(JsonValue::as_str)
                        != Some(referenced_context_id.as_str())
                {
                    tx.rollback().await?;
                    return Ok(MessageClaim::InvalidReference {
                        message: format!("Session 引用 '{referenced_session_id}' 的权威路由已改变"),
                    });
                }
                if referenced_agent_id != &source_agent_id {
                    tx.rollback().await?;
                    return Ok(MessageClaim::ForbiddenReference {
                        session_id: referenced_session_id.to_string(),
                        principal_id: event_principal_id.to_string(),
                    });
                }
                if referenced_status == "archived" {
                    tx.rollback().await?;
                    return Ok(MessageClaim::InactiveReference {
                        session_id: referenced_session_id.to_string(),
                    });
                }
                if !bound_sessions.contains(referenced_session_id) {
                    tx.rollback().await?;
                    return Ok(MessageClaim::ForbiddenReference {
                        session_id: referenced_session_id.to_string(),
                        principal_id: event_principal_id.to_string(),
                    });
                }
            }
        }

        let agent_id = session.get::<String, _>("agent_id");
        let interrupted = if dispatch_mode == MessageDispatchMode::Interrupt {
            interrupt_dialogue_turn_in_tx(
                &mut tx,
                &agent_id,
                &registry_context_id,
                session_id,
                event,
            )
            .await?
        } else {
            None
        };
        let mut claimed_event = event.clone();
        if dispatch_mode == MessageDispatchMode::FollowUp {
            let predecessor = sqlx::query_scalar::<_, String>(
                r#"SELECT thread.id
                   FROM session_message_requests request
                   JOIN thread_signals signal ON signal.event_id = request.event_id
                   JOIN threads thread ON thread.id = signal.thread_id
                   WHERE request.session_id = $1
                     AND thread.session_id = request.session_id
                     AND thread.kind IN ('dialogue_turn', 'execution')
                     AND request.event_id != $2
                   ORDER BY request.created_at DESC, request.event_id DESC
                   LIMIT 1
                   FOR SHARE OF signal, thread"#,
            )
            .bind(session_id)
            .bind(&event.id)
            .fetch_optional(&mut *tx)
            .await?;
            if let Some(predecessor) = predecessor {
                claimed_event
                    .payload
                    .insert("after_thread_id".to_string(), json!(predecessor));
            }
        }
        let encounter_id = format!("principal_encounter_{}", claimed_event.id);
        let first_seen = sqlx::query(
            r#"INSERT INTO principal_context_encounters
               (context_id, principal_id, encounter_id, first_event_id, first_session_id, first_seen_at)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT(context_id, principal_id) DO NOTHING"#,
        )
        .bind(event_context_id)
        .bind(event_principal_id)
        .bind(&encounter_id)
        .bind(&claimed_event.id)
        .bind(session_id)
        .bind(
            claimed_event
                .timestamp
                .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
        )
        .execute(&mut *tx)
        .await?
        .rows_affected()
            == 1;
        if first_seen {
            claimed_event
                .payload
                .insert("principal_first_seen_in_context".to_string(), json!(true));
            claimed_event
                .payload
                .insert("principal_encounter_id".to_string(), json!(encounter_id));
        }
        append_event_in_tx(&mut tx, &claimed_event).await?;
        append_dialogue_signal_in_tx(
            &mut tx,
            &agent_id,
            &registry_context_id,
            session_id,
            &claimed_event,
            dispatch_mode,
        )
        .await?;
        let timestamp = event
            .timestamp
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query("UPDATE sessions SET updated_at = $1, last_activity_at = $1 WHERE id = $2")
            .bind(&timestamp)
            .bind(session_id)
            .execute(&mut *tx)
            .await?;

        if session.get::<String, _>("attention_state") == "retired" {
            let restore_event_id = format!("runtime_session_restored_{}", event.id);
            let next_revision = session.get::<i64, _>("attention_revision") + 1;
            sqlx::query(
                r#"UPDATE sessions SET attention_state = 'active',
                   attention_revision = attention_revision + 1,
                   attention_reason = 'new directed user message',
                   attention_changed_at = $1, attention_event_id = $2,
                   updated_at = $1
                   WHERE id = $3 AND attention_state = 'retired'"#,
            )
            .bind(&timestamp)
            .bind(&restore_event_id)
            .bind(session_id)
            .execute(&mut *tx)
            .await?;
            let restore = Event {
                id: restore_event_id,
                sequence: None,
                timestamp: event.timestamp,
                actor: "Runtime-SessionAttention".to_string(),
                event_type: "runtime_control".to_string(),
                topic: "runtime/session_restored".to_string(),
                payload: json!({
                    "context_id": event_context_id,
                    "session_id": session_id,
                    "trigger_event_id": event.id,
                    "trigger_kind": "user_message",
                    "attention_revision": next_revision
                })
                .as_object()
                .unwrap()
                .clone(),
            };
            append_event_in_tx(&mut tx, &restore).await?;
        }
        tx.commit().await?;
        Ok(MessageClaim::Accepted {
            event: claimed_event,
            interrupted,
        })
    }

    async fn claim_session_signal(&self, event: &Event) -> Result<SessionSignalClaim, StoreError> {
        if event.event_type != TYPE_SESSION_SIGNAL || event.topic != "chat/session_signal" {
            return Err("Session Signal Event 类型或 topic 不正确".into());
        }
        let target_session_id = event
            .payload
            .get("session_id")
            .and_then(JsonValue::as_str)
            .ok_or("Session Signal 缺少目标 session_id")?;
        let target_context_id = event
            .payload
            .get("context_id")
            .and_then(JsonValue::as_str)
            .ok_or("Session Signal 缺少目标 context_id")?;
        let source_session_id = event
            .payload
            .get("source_session_id")
            .and_then(JsonValue::as_str)
            .ok_or("Session Signal 缺少 source_session_id")?;
        let source_context_id = event
            .payload
            .get("source_context_id")
            .and_then(JsonValue::as_str)
            .ok_or("Session Signal 缺少 source_context_id")?;
        if target_session_id == source_session_id {
            return Err("session_signal 只能投递给另一个 Session".into());
        }

        let mut tx = self.pool.begin().await?;
        let target = sqlx::query(
            "SELECT agent_id, context_id, status FROM sessions WHERE id = $1 FOR UPDATE",
        )
        .bind(target_session_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| format!("目标 Session '{target_session_id}' 不存在"))?;
        let target_agent_id = target.get::<String, _>("agent_id");
        let target_registry_context_id = target.get::<String, _>("context_id");
        if target_registry_context_id != target_context_id {
            return Err(format!(
                "Session Signal 目标 Context 路由不一致：Event='{}'，Registry='{}'",
                target_context_id, target_registry_context_id
            )
            .into());
        }
        if target.get::<String, _>("status") == "archived" {
            tx.commit().await?;
            return Ok(SessionSignalClaim::InactiveSession);
        }
        let source = sqlx::query("SELECT agent_id, context_id FROM sessions WHERE id = $1")
            .bind(source_session_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| format!("来源 Session '{source_session_id}' 不存在"))?;
        let source_agent_id = source.get::<String, _>("agent_id");
        let source_registry_context_id = source.get::<String, _>("context_id");
        if source_registry_context_id != source_context_id {
            return Err(format!(
                "Session Signal 来源 Context 路由不一致：Event='{}'，Registry='{}'",
                source_context_id, source_registry_context_id
            )
            .into());
        }
        if source_agent_id != target_agent_id {
            return Err("session_signal 暂不允许跨 Agent 投递".into());
        }

        if let Some(existing_payload) =
            sqlx::query_scalar::<_, JsonValue>("SELECT payload FROM events WHERE id = $1")
                .bind(&event.id)
                .fetch_optional(&mut *tx)
                .await?
        {
            if existing_payload != JsonValue::Object(event.payload.clone()) {
                return Err(
                    format!("Session Signal Event ID '{}' 已绑定到不同消息", event.id).into(),
                );
            }
            tx.commit().await?;
            return Ok(SessionSignalClaim::Existing {
                event_id: event.id.clone(),
            });
        }

        if let Some(principal_id) = event
            .payload
            .get("principal_id")
            .and_then(JsonValue::as_str)
        {
            let principal_is_bound = sqlx::query_scalar::<_, String>(
                r#"SELECT principal_id FROM session_principal_bindings
                   WHERE session_id = $1 AND principal_id = $2 AND unbound_at IS NULL
                   FOR SHARE"#,
            )
            .bind(target_session_id)
            .bind(principal_id)
            .fetch_optional(&mut *tx)
            .await?
            .is_some();
            if !principal_is_bound {
                tx.rollback().await?;
                return Ok(SessionSignalClaim::ForbiddenPrincipal {
                    principal_id: principal_id.to_string(),
                });
            }
        }

        if !append_event_in_tx(&mut tx, event).await? {
            return Err(
                format!("Session Signal Event '{}' 在原子提交期间发生冲突", event.id).into(),
            );
        }
        append_dialogue_signal_in_tx(
            &mut tx,
            &target_agent_id,
            &target_registry_context_id,
            target_session_id,
            event,
            MessageDispatchMode::FollowUp,
        )
        .await?;
        let timestamp = event
            .timestamp
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query("UPDATE sessions SET updated_at = $1, last_activity_at = $1 WHERE id = $2")
            .bind(&timestamp)
            .bind(target_session_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(SessionSignalClaim::Accepted {
            event: event.clone(),
        })
    }

    /// PostgreSQL counterpart of the atomic SQLite upgrade path: route validation, Event
    /// persistence, new DialogueTurn creation, and checkpoint-state cleanup complete in one
    /// transaction to remove the TOCTOU window. PostgreSQL has no session_mounts table, so route
    /// locking follows claim_session_signal and uses SELECT ... FOR UPDATE. The Wake Event itself
    /// becomes the new root_turn_id; the prior Thread and Activation are recorded only as
    /// source_thread_id and source_activation_id in the payload.
    async fn claim_background_thread_wake(
        &self,
        event: &Event,
        job_id: &str,
        expected_checkpoint_generation: u64,
        thread_id: &str,
    ) -> Result<BackgroundThreadWakeClaim, StoreError> {
        if event.event_type != crate::event::TYPE_TOOL_OUTPUT || event.topic != "chat/tool_output" {
            return Err("Background Thread Wake Event 类型或 topic 不正确".into());
        }
        let expected_generation_sql = i64::try_from(expected_checkpoint_generation)?;
        let mut tx = self.pool.begin().await?;
        let job = sqlx::query(
            "SELECT thread_id, context_id, session_id, tool_name, status, checkpoint_generation, checkpoint_due_at \
             FROM execution_jobs WHERE id = $1 FOR UPDATE",
        )
        .bind(job_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(job) = job else {
            tx.rollback().await?;
            return Ok(BackgroundThreadWakeClaim::StaleCheckpoint);
        };
        if job.get::<String, _>("thread_id") != thread_id
            || job.get::<String, _>("tool_name") != "exec/background"
        {
            return Err(format!(
                "Background Thread Wake Job '{}' 的 Thread/tool route 不一致",
                job_id
            )
            .into());
        }
        let job_context_id = job.get::<String, _>("context_id");
        let job_session_id = job.get::<String, _>("session_id");
        for (field, expected) in [
            ("task_id", job_id),
            ("thread_id", thread_id),
            ("context_id", job_context_id.as_str()),
            ("session_id", job_session_id.as_str()),
        ] {
            if event.payload.get(field).and_then(JsonValue::as_str) != Some(expected) {
                return Err(format!(
                    "Background Thread Wake Event '{}' 的 {field} 与 Job route 不一致",
                    event.id
                )
                .into());
            }
        }
        if let Some(existing) = sqlx::query(
            "SELECT s.thread_id, e.actor, e.type, e.topic, e.payload \
             FROM thread_signals s JOIN events e ON e.id = s.event_id \
             WHERE s.event_id = $1",
        )
        .bind(&event.id)
        .fetch_optional(&mut *tx)
        .await?
        {
            let existing_thread_id = existing.get::<String, _>("thread_id");
            if existing_thread_id != thread_id {
                return Err(format!(
                    "Background Thread Wake Event '{}' 已路由到不同 Thread",
                    event.id
                )
                .into());
            }
            if existing.get::<String, _>("actor") != event.actor
                || existing.get::<String, _>("type") != event.event_type
                || existing.get::<String, _>("topic") != event.topic
                || existing.get::<JsonValue, _>("payload")
                    != JsonValue::Object(event.payload.clone())
            {
                return Err(format!(
                    "Background Thread Wake Event ID '{}' 已绑定到不同事实",
                    event.id
                )
                .into());
            }
            sqlx::query(
                "UPDATE execution_jobs SET revision = revision + 1, checkpoint_due_at = NULL, \
                 updated_at = $1 WHERE id = $2 AND checkpoint_generation = $3 \
                 AND checkpoint_due_at IS NOT NULL",
            )
            .bind(now_text())
            .bind(job_id)
            .bind(expected_generation_sql)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            return Ok(BackgroundThreadWakeClaim::Existing {
                event_id: event.id.clone(),
            });
        }
        let generation_matches = job
            .get::<Option<i64>, _>("checkpoint_generation")
            .is_some_and(|value| value == expected_generation_sql)
            && job.get::<Option<String>, _>("checkpoint_due_at").is_some();
        let status = job.get::<String, _>("status");
        if !generation_matches
            || matches!(
                status.as_str(),
                "succeeded" | "failed" | "cancelled" | "lost"
            )
        {
            tx.rollback().await?;
            return Ok(BackgroundThreadWakeClaim::StaleCheckpoint);
        }
        let thread_status =
            sqlx::query_scalar::<_, String>("SELECT status FROM threads WHERE id = $1 FOR SHARE")
                .bind(thread_id)
                .fetch_optional(&mut *tx)
                .await?;
        let Some(thread_status) = thread_status else {
            tx.rollback().await?;
            return Ok(BackgroundThreadWakeClaim::MissingThread);
        };
        if matches!(thread_status.as_str(), "completed" | "failed" | "cancelled") {
            tx.rollback().await?;
            return Ok(BackgroundThreadWakeClaim::InactiveThread {
                status: thread_status,
            });
        }
        let cleared = sqlx::query(
            "UPDATE execution_jobs SET revision = revision + 1, checkpoint_due_at = NULL, \
             updated_at = $1 WHERE id = $2 AND checkpoint_generation = $3 \
             AND checkpoint_due_at IS NOT NULL",
        )
        .bind(now_text())
        .bind(job_id)
        .bind(expected_generation_sql)
        .execute(&mut *tx)
        .await?;
        if cleared.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(BackgroundThreadWakeClaim::StaleCheckpoint);
        }
        if !append_event_in_tx(&mut tx, event).await? {
            return Err(format!(
                "Background Thread Wake Event '{}' 在原子提交期间发生冲突",
                event.id
            )
            .into());
        }
        append_direct_thread_signal_in_tx(&mut tx, event, thread_id).await?;
        tx.commit().await?;
        Ok(BackgroundThreadWakeClaim::Accepted {
            event: event.clone(),
        })
    }

    async fn suppress_background_checkpoint(
        &self,
        event: &Event,
        job_id: &str,
        expected_checkpoint_generation: u64,
        outcome: &str,
        operator_attention: bool,
    ) -> Result<bool, StoreError> {
        let expected_generation_sql = i64::try_from(expected_checkpoint_generation)?;
        let mut tx = self.pool.begin().await?;
        let cleared = sqlx::query(
            "UPDATE execution_jobs SET revision = revision + 1, checkpoint_due_at = NULL, \
             updated_at = $1 WHERE id = $2 AND checkpoint_generation = $3 \
             AND checkpoint_due_at IS NOT NULL",
        )
        .bind(now_text())
        .bind(job_id)
        .bind(expected_generation_sql)
        .execute(&mut *tx)
        .await?;
        if cleared.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(false);
        }
        let audit = crate::memory::background_wake_audit_event(
            event,
            job_id,
            Some(expected_checkpoint_generation),
            outcome,
            operator_attention,
        );
        append_event_in_tx(&mut tx, &audit).await?;
        tx.commit().await?;
        Ok(true)
    }

    async fn claim_background_session_wake(
        &self,
        event: &Event,
        job_id: &str,
        expected_checkpoint_generation: Option<u64>,
    ) -> Result<BackgroundSessionWakeClaim, StoreError> {
        if event.event_type != TYPE_RUNTIME_WAKE || event.topic != "runtime/background_wake" {
            return Err("Background Session Wake Event 类型或 topic 不正确".into());
        }
        let target_session_id = event
            .payload
            .get("session_id")
            .and_then(JsonValue::as_str)
            .ok_or("Background Wake 缺少目标 session_id")?;
        let target_context_id = event
            .payload
            .get("context_id")
            .and_then(JsonValue::as_str)
            .ok_or("Background Wake 缺少目标 context_id")?;

        let mut tx = self.pool.begin().await?;
        let job_route = sqlx::query(
            "SELECT session_id, context_id, tool_name FROM execution_jobs WHERE id = $1 FOR UPDATE",
        )
        .bind(job_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(job_route) = job_route else {
            tx.rollback().await?;
            return Ok(BackgroundSessionWakeClaim::StaleCheckpoint);
        };
        let registered_session_id = job_route.get::<String, _>("session_id");
        let registered_context_id = job_route.get::<String, _>("context_id");
        if job_route.get::<String, _>("tool_name") != "exec/background" {
            return Err(format!("Background Wake Job '{job_id}' 不是 exec/background").into());
        }
        if registered_session_id != target_session_id || registered_context_id != target_context_id
        {
            if let Some(generation) = expected_checkpoint_generation {
                let cleared = sqlx::query(
                    "UPDATE execution_jobs SET revision = revision + 1, checkpoint_due_at = NULL, \
                     updated_at = $1 WHERE id = $2 AND checkpoint_generation = $3 \
                     AND checkpoint_due_at IS NOT NULL",
                )
                .bind(now_text())
                .bind(job_id)
                .bind(i64::try_from(generation)?)
                .execute(&mut *tx)
                .await?;
                if cleared.rows_affected() != 1 {
                    tx.rollback().await?;
                    return Ok(BackgroundSessionWakeClaim::StaleCheckpoint);
                }
            }
            let audit = crate::memory::background_wake_audit_event(
                event,
                job_id,
                expected_checkpoint_generation,
                "background_wake_job_route_conflict",
                true,
            );
            append_event_in_tx(&mut tx, &audit).await?;
            tx.commit().await?;
            return Ok(BackgroundSessionWakeClaim::RouteConflict {
                registered_context_id,
            });
        }
        let target = sqlx::query(
            "SELECT agent_id, context_id, status FROM sessions WHERE id = $1 FOR UPDATE",
        )
        .bind(target_session_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(target) = target else {
            if let Some(generation) = expected_checkpoint_generation {
                let cleared = sqlx::query(
                    "UPDATE execution_jobs SET revision = revision + 1, checkpoint_due_at = NULL, \
                     updated_at = $1 WHERE id = $2 AND checkpoint_generation = $3 \
                     AND checkpoint_due_at IS NOT NULL",
                )
                .bind(now_text())
                .bind(job_id)
                .bind(i64::try_from(generation)?)
                .execute(&mut *tx)
                .await?;
                if cleared.rows_affected() != 1 {
                    tx.rollback().await?;
                    return Ok(BackgroundSessionWakeClaim::StaleCheckpoint);
                }
            }
            let audit = crate::memory::background_wake_audit_event(
                event,
                job_id,
                expected_checkpoint_generation,
                "background_wake_session_missing",
                true,
            );
            append_event_in_tx(&mut tx, &audit).await?;
            tx.commit().await?;
            return Ok(BackgroundSessionWakeClaim::MissingSession);
        };
        let target_agent_id = target.get::<String, _>("agent_id");
        let target_registry_context_id = target.get::<String, _>("context_id");
        if target_registry_context_id != target_context_id {
            if let Some(generation) = expected_checkpoint_generation {
                let cleared = sqlx::query(
                    "UPDATE execution_jobs SET revision = revision + 1, checkpoint_due_at = NULL, \
                     updated_at = $1 WHERE id = $2 AND checkpoint_generation = $3 \
                     AND checkpoint_due_at IS NOT NULL",
                )
                .bind(now_text())
                .bind(job_id)
                .bind(i64::try_from(generation)?)
                .execute(&mut *tx)
                .await?;
                if cleared.rows_affected() != 1 {
                    tx.rollback().await?;
                    return Ok(BackgroundSessionWakeClaim::StaleCheckpoint);
                }
            }
            let audit = crate::memory::background_wake_audit_event(
                event,
                job_id,
                expected_checkpoint_generation,
                "background_wake_context_route_conflict",
                true,
            );
            append_event_in_tx(&mut tx, &audit).await?;
            tx.commit().await?;
            return Ok(BackgroundSessionWakeClaim::RouteConflict {
                registered_context_id: target_registry_context_id,
            });
        }
        if target.get::<String, _>("status") == "archived" {
            if let Some(generation) = expected_checkpoint_generation {
                let cleared = sqlx::query(
                    "UPDATE execution_jobs SET revision = revision + 1, checkpoint_due_at = NULL, \
                     updated_at = $1 WHERE id = $2 AND checkpoint_generation = $3 \
                     AND checkpoint_due_at IS NOT NULL",
                )
                .bind(now_text())
                .bind(job_id)
                .bind(i64::try_from(generation)?)
                .execute(&mut *tx)
                .await?;
                if cleared.rows_affected() != 1 {
                    tx.rollback().await?;
                    return Ok(BackgroundSessionWakeClaim::StaleCheckpoint);
                }
            }
            let audit = crate::memory::background_wake_audit_event(
                event,
                job_id,
                expected_checkpoint_generation,
                "background_wake_session_archived",
                false,
            );
            append_event_in_tx(&mut tx, &audit).await?;
            tx.commit().await?;
            return Ok(BackgroundSessionWakeClaim::ArchivedSession);
        }
        if let Some(principal_id) = event
            .payload
            .get("principal_id")
            .and_then(JsonValue::as_str)
        {
            let principal_is_bound = sqlx::query_scalar::<_, String>(
                r#"SELECT principal_id FROM session_principal_bindings
                   WHERE session_id = $1 AND principal_id = $2 AND unbound_at IS NULL
                   FOR SHARE"#,
            )
            .bind(target_session_id)
            .bind(principal_id)
            .fetch_optional(&mut *tx)
            .await?
            .is_some();
            if !principal_is_bound {
                if let Some(generation) = expected_checkpoint_generation {
                    let cleared = sqlx::query(
                        "UPDATE execution_jobs SET revision = revision + 1, checkpoint_due_at = NULL, \
                         updated_at = $1 WHERE id = $2 AND checkpoint_generation = $3 \
                         AND checkpoint_due_at IS NOT NULL",
                    )
                    .bind(now_text())
                    .bind(job_id)
                    .bind(i64::try_from(generation)?)
                    .execute(&mut *tx)
                    .await?;
                    if cleared.rows_affected() != 1 {
                        tx.rollback().await?;
                        return Ok(BackgroundSessionWakeClaim::StaleCheckpoint);
                    }
                }
                let audit = crate::memory::background_wake_audit_event(
                    event,
                    job_id,
                    expected_checkpoint_generation,
                    "background_wake_principal_unbound",
                    true,
                );
                append_event_in_tx(&mut tx, &audit).await?;
                tx.commit().await?;
                return Ok(BackgroundSessionWakeClaim::ForbiddenPrincipal {
                    principal_id: principal_id.to_string(),
                });
            }
        }
        // Exact replay is idempotent and must not create another DialogueTurn.
        if let Some(existing_payload) =
            sqlx::query_scalar::<_, JsonValue>("SELECT payload FROM events WHERE id = $1")
                .bind(&event.id)
                .fetch_optional(&mut *tx)
                .await?
        {
            if existing_payload != JsonValue::Object(event.payload.clone()) {
                return Err(
                    format!("Background Wake Event ID '{}' 已绑定到不同消息", event.id).into(),
                );
            }
            tx.commit().await?;
            return Ok(BackgroundSessionWakeClaim::Existing {
                event_id: event.id.clone(),
            });
        }
        // Generation-guarded checkpoint clear: a concurrently armed newer
        // checkpoint or a Job that no longer exists must not be clobbered.
        // Terminal-result Session fallback passes None and must not require a
        // live checkpoint generation.
        if let Some(expected_checkpoint_generation) = expected_checkpoint_generation {
            let expected_generation_sql = i64::try_from(expected_checkpoint_generation)
                .map_err(|_| "Background Wake checkpoint_generation 超出 INTEGER 范围")?;
            let cleared = sqlx::query(
                "UPDATE execution_jobs
                    SET revision = revision + 1, checkpoint_due_at = NULL, updated_at = $1
                  WHERE id = $2 AND checkpoint_generation = $3",
            )
            .bind(now_text())
            .bind(job_id)
            .bind(expected_generation_sql)
            .execute(&mut *tx)
            .await?;
            if cleared.rows_affected() != 1 {
                tx.rollback().await?;
                return Ok(BackgroundSessionWakeClaim::StaleCheckpoint);
            }
        }
        if !append_event_in_tx(&mut tx, event).await? {
            return Err(format!(
                "Background Wake Event '{}' 在原子提交期间发生冲突",
                event.id
            )
            .into());
        }
        // The wake Event is its own root: a fresh DialogueTurn that never
        // carries the terminal Thread's root_turn_id.
        let principal_id = event
            .payload
            .get("principal_id")
            .and_then(JsonValue::as_str);
        let now = now_text();
        let thread_id = stable_thread_id(&event.id);
        sqlx::query(
            r#"INSERT INTO threads
               (id, revision, generation, agent_id, context_id, session_id,
                initiating_principal_id, root_turn_id, kind, status, control_state,
                executor_kind, lifetime, supervisor_kind, supervisor_id,
                supervision_generation, completion_contract_json, delivery_status,
                created_at, updated_at)
               VALUES ($1, 1, 1, $2, $3, $4, $5, $6, 'dialogue_turn', 'open',
                       'active', 'self', 'durable', 'runtime', 'dialogue-router', 1,
                       '{}'::jsonb, 'none', $7, $7)"#,
        )
        .bind(&thread_id)
        .bind(&target_agent_id)
        .bind(&target_registry_context_id)
        .bind(target_session_id)
        .bind(principal_id)
        .bind(&event.id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let sequence: i64 = sqlx::query_scalar("SELECT sequence FROM events WHERE id = $1")
            .bind(&event.id)
            .fetch_one(&mut *tx)
            .await?;
        sqlx::query(
            r#"INSERT INTO thread_signals
               (id, thread_id, thread_generation, event_id, principal_id, sequence, kind,
                parent_activation_id, status, created_at)
               VALUES ($1, $2, 1, $3, $4, $5, $6, NULL, 'pending', $7)"#,
        )
        .bind(stable_thread_signal_id(&event.id))
        .bind(&thread_id)
        .bind(&event.id)
        .bind(principal_id)
        .bind(sequence)
        .bind(&event.topic)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE sessions SET updated_at = $1, last_activity_at = $1 WHERE id = $2")
            .bind(&now)
            .bind(target_session_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(BackgroundSessionWakeClaim::Accepted {
            event: event.clone(),
        })
    }
}
