use super::{append_event_in_tx, now_text, PostgresStore, StoreError};
use crate::event::Event;
use crate::memory::{
    message_request_fingerprint, stable_thread_id, stable_thread_signal_id, DeliveryIngressStore,
    InterruptedDialogueTurn, MessageClaim, MessageDispatchMode, DEFAULT_THREAD_SIGNAL_BATCH_LIMIT,
};
use serde_json::{json, Value as JsonValue};
use sqlx::{PgPool, Postgres, Row};

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
        let mut tx = self.pool.begin().await?;
        let session = sqlx::query(
            r#"SELECT agent_id, context_id, status, attention_state, attention_revision
               FROM sessions WHERE id = $1 FOR UPDATE"#,
        )
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
}
