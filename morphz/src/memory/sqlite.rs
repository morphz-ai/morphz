use crate::approval_authority::{
    approval_decision_event, stable_approval_identity, stable_grant_id,
};
use crate::config::SqliteStorageConfig;
use crate::event::Event;
use crate::memory::{
    causal_payload_string, ActionGroupFilter, ActionGroupMemberCommit, ActionGroupMemberRecord,
    ActionGroupMemberStatus, ActionGroupRecord, ActionGroupStatus, ActionGroupStore,
    ActivationOutcomeCommit, ActivationStore, AgentBootstrapRecord, AgentRecord,
    ApprovalAuditCommit, ApprovalFilter, ApprovalMutation, ApprovalRecord, ApprovalResolution,
    ApprovalStatus, ApprovalStore, AttentionAcknowledgementRecord, CapabilityLeaseFilter,
    CapabilityLeaseMutation, CapabilityLeaseRecord, CapabilityLeaseStatus, CapabilityLeaseStore,
    CognitiveClockStore, CognitiveContextRecord, ContextCognitiveClock, ContextUpdate,
    DelegationRecord, DelegationStatus, DelegationStore, DeliveryFlushCommit, DeliveryIngressStore,
    DeliveryStatus, DialogueTurnRetryMutation, DialogueTurnRetryRequest, EdgeCommandMutation,
    EdgeCommandOutputChunk, EdgeCommandRecord, EdgeCommandStatus, EdgeExecutionStore,
    EdgeOutputStream, EdgeReconciliationReport, EventAppend, EventStore, ExecutionApprovalMutation,
    ExecutionApprovalStore, ExecutionJobFilter, ExecutionJobMutation, ExecutionJobRecord,
    ExecutionJobStatus, ExecutionJobStore, ExecutionJobTerminal, ExecutionNodeMutation,
    ExecutionNodeRecord, ExecutionNodeStatus, ExecutionRetrySafety,
    ExecutionTargetAuthorizationFilter, ExecutionTargetAuthorizationMutation,
    ExecutionTargetAuthorizationRecord, ExecutionTargetAuthorizationScope,
    ExecutionTargetAuthorizationStatus, ExecutionTargetAuthorizationStore, ExecutionTargetFilter,
    ExecutionTargetKind, ExecutionTargetMutation, ExecutionTargetRecord,
    ExecutionTargetRegistration, ExecutionTargetStatus, ExecutionTargetStore, MessageClaim,
    MindProjectionCommit, MindProjectionRecord, MindProjectionStore, MindSnapshotRecord,
    NewActionGroup, NewActionGroupMember, NewAgent, NewApprovalRequest, NewCapabilityLease,
    NewCognitiveContext, NewDelegation, NewEdgeCommand, NewExecutionJob, NewExecutionNodeChallenge,
    NewExecutionTargetAuthorization, NewMindProjection, NewNodePairingCode, NewObjective,
    NewPrincipal, NewRuntimeTimer, NewSchedule, NewSession, NewThread, NewThreadActivation,
    NewThreadSignal, ObjectiveMutation, ObjectiveRecord, ObjectiveStatus, ObjectiveStore,
    ObjectiveWaitCondition, PairExecutionNode, PrincipalRecord, QueryFilter, RecallDocument,
    RecallDocumentKind, RecallIndexAudit, RecallIndexCapability, RecallProjectionBatch,
    RecallProjectionStore, RecallSearchHit, RuntimeTimerKind, RuntimeTimerRecord,
    RuntimeTimerStatus, ScheduleMutation, ScheduleRecord, ScheduleStatus, ScheduleStore,
    SessionAttentionState, SessionAttentionUpdate, SessionDirectoryStore, SessionMountKind,
    SessionPrincipalBinding, SessionProjectionMutation, SessionProjectionStore, SessionRecord,
    SessionStatus, SessionUpdate, SignalOutboxRecord, SignalOutboxStatus, ThreadActivationMutation,
    ThreadActivationRecord, ThreadActivationStatus, ThreadKind, ThreadLifecycle, ThreadMutation,
    ThreadRecord, ThreadSignalRecord, ThreadSignalStatus, ThreadStore, TimerStore,
};
use chrono::{DateTime, Utc};
// SQLx supplies the Rust FFI surface; hotbundle supplies a current SQLite
// amalgamation to the release binary instead of relying on the host library.
use libsqlite3_hotbundle as _;
use serde_json::Value as JsonValue;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteRow};
use sqlx::{Acquire, QueryBuilder, Row, SqlitePool};

mod plan_execution;

pub struct SqliteStore {
    pool: SqlitePool,
}

fn sqlite_has_wal_reset_fix(version: &str) -> bool {
    let components = version
        .split('.')
        .take(3)
        .map(|component| {
            component
                .chars()
                .take_while(|ch| ch.is_ascii_digit())
                .collect::<String>()
                .parse::<u64>()
        })
        .collect::<Result<Vec<_>, _>>();
    let Ok(components) = components else {
        return false;
    };
    let [major, minor, patch] = components.as_slice() else {
        return false;
    };

    (*major, *minor, *patch) >= (3, 51, 3)
        || (*major == 3 && *minor == 50 && *patch >= 7)
        || (*major == 3 && *minor == 44 && *patch >= 6)
}

impl SqliteStore {
    pub async fn new(db_path: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Self::new_with_config(db_path, &SqliteStorageConfig::default()).await
    }

    pub async fn new_with_config(
        db_path: &str,
        config: &SqliteStorageConfig,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let options = SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true)
            .busy_timeout(std::time::Duration::from_secs(5)); // 5秒锁重试

        // 启用连接池并发，利用 WAL 模式的单写多读优势。
        let pool = SqlitePoolOptions::new()
            .max_connections(config.max_connections.max(1))
            .connect_with(options)
            .await?;

        let sqlite_version: String = sqlx::query_scalar("SELECT sqlite_version()")
            .fetch_one(&pool)
            .await?;
        if !sqlite_has_wal_reset_fix(&sqlite_version) {
            pool.close().await;
            return Err(format!(
                "SQLite {sqlite_version} 存在已知 WAL-reset 并发竞态；Morphz 要求 SQLite 3.51.3+（或官方回移版本 3.50.7 / 3.44.6）"
            )
            .into());
        }
        tracing::info!(
            sqlite_version = %sqlite_version,
            max_connections = config.max_connections.max(1),
            "SQLite WAL Storage 已启用"
        );

        // 启用外键约束，以支持 ON DELETE CASCADE 级联删除
        sqlx::query("PRAGMA foreign_keys = ON;")
            .execute(&pool)
            .await?;

        // Morphz is not yet released, so the Scheduler Kernel adopts its
        // canonical domain name directly. SQLite rewrites existing foreign
        // key targets during ALTER TABLE, preserving local development data.
        let has_legacy_activations = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'evaluation_work_items'",
        )
        .fetch_one(&pool)
        .await?
            > 0;
        let has_thread_activations = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'thread_activations'",
        )
        .fetch_one(&pool)
        .await?
            > 0;
        if has_legacy_activations && has_thread_activations {
            return Err(
                "SQLite 同时存在 evaluation_work_items 与 thread_activations，拒绝猜测迁移来源"
                    .into(),
            );
        }
        if has_legacy_activations {
            sqlx::query("ALTER TABLE evaluation_work_items RENAME TO thread_activations")
                .execute(&pool)
                .await?;
        }
        if has_legacy_activations || has_thread_activations {
            let activation_columns = sqlx::query("PRAGMA table_info(thread_activations)")
                .fetch_all(&pool)
                .await?
                .into_iter()
                .map(|row| row.get::<String, _>("name"))
                .collect::<std::collections::HashSet<_>>();
            if activation_columns.contains("parent_work_item_id")
                && !activation_columns.contains("parent_activation_id")
            {
                sqlx::query(
                    "ALTER TABLE thread_activations RENAME COLUMN parent_work_item_id TO parent_activation_id",
                )
                .execute(&pool)
                .await?;
            }
        }

        for (legacy, canonical) in [
            ("work_threads", "threads"),
            ("work_thread_outcomes", "thread_outcomes"),
            ("scheduled_intents", "schedules"),
            ("scheduled_intent_dependencies", "schedule_dependencies"),
        ] {
            let has_legacy = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .bind(legacy)
            .fetch_one(&pool)
            .await?
                > 0;
            let has_canonical = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .bind(canonical)
            .fetch_one(&pool)
            .await?
                > 0;
            if has_legacy && has_canonical {
                return Err(
                    format!("SQLite 同时存在 {legacy} 与 {canonical}，拒绝猜测迁移来源").into(),
                );
            }
            if has_legacy {
                sqlx::query(&format!("ALTER TABLE {legacy} RENAME TO {canonical}"))
                    .execute(&pool)
                    .await?;
            }
        }

        let has_schedule_dependencies = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'schedule_dependencies'",
        )
        .fetch_one(&pool)
        .await?
            > 0;
        if has_schedule_dependencies {
            let dependency_columns = sqlx::query("PRAGMA table_info(schedule_dependencies)")
                .fetch_all(&pool)
                .await?
                .into_iter()
                .map(|row| row.get::<String, _>("name"))
                .collect::<std::collections::HashSet<_>>();
            if dependency_columns.contains("scheduled_intent_id")
                && !dependency_columns.contains("schedule_id")
            {
                sqlx::query(
                    "ALTER TABLE schedule_dependencies RENAME COLUMN scheduled_intent_id TO schedule_id",
                )
                .execute(&pool)
                .await?;
            }
        }

        for table in ["evaluation_outcomes", "thread_outcomes"] {
            let exists = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .bind(table)
            .fetch_one(&pool)
            .await?
                > 0;
            if !exists {
                continue;
            }
            let columns = sqlx::query(&format!("PRAGMA table_info({table})"))
                .fetch_all(&pool)
                .await?
                .into_iter()
                .map(|row| row.get::<String, _>("name"))
                .collect::<std::collections::HashSet<_>>();
            if columns.contains("work_item_id") && !columns.contains("activation_id") {
                sqlx::query(&format!(
                    "ALTER TABLE {table} RENAME COLUMN work_item_id TO activation_id"
                ))
                .execute(&pool)
                .await?;
            }
        }
        migrate_threads_to_canonical_domain(&pool).await?;

        // 初始化建表 DDL
        let ddl = r#"
        CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            timestamp TEXT NOT NULL,
            actor TEXT NOT NULL,
            type TEXT NOT NULL,
            topic TEXT NOT NULL,
            context_id TEXT,
            session_id TEXT,
            thread_id TEXT,
            activation_id TEXT,
            root_turn_id TEXT,
            objective_id TEXT,
            payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_events_topic ON events(topic);
        CREATE INDEX IF NOT EXISTS idx_events_session_time ON events(session_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_events_context_time ON events(context_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_events_context_topic_time
            ON events(context_id, topic, timestamp);
        CREATE TABLE IF NOT EXISTS event_causal_projection_backfills (
            context_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            topic TEXT NOT NULL,
            completed_at TEXT NOT NULL,
            PRIMARY KEY(context_id, session_id, thread_id, topic)
        );

        CREATE TABLE IF NOT EXISTS attention_acknowledgements (
            context_id TEXT NOT NULL,
            key TEXT NOT NULL,
            event_id TEXT NOT NULL UNIQUE,
            event_sequence INTEGER NOT NULL,
            source_kind TEXT NOT NULL,
            source_id TEXT NOT NULL,
            source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
            acknowledged_by TEXT NOT NULL,
            rationale TEXT,
            acknowledged_at TEXT NOT NULL,
            PRIMARY KEY(context_id, key),
            FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_attention_ack_context_time
            ON attention_acknowledgements(context_id, acknowledged_at DESC, event_sequence DESC);

        CREATE TABLE IF NOT EXISTS session_projections (
            event_id TEXT PRIMARY KEY,
            context_id TEXT NOT NULL,
            session_id TEXT,
            FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_session_projections_context_session
            ON session_projections(context_id, session_id, event_id);

        CREATE TABLE IF NOT EXISTS schema_migrations (
            version TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS signal_outbox (
            event_id TEXT PRIMARY KEY,
            status TEXT NOT NULL CHECK(status IN ('pending', 'materialized', 'discarded')),
            signal_id TEXT,
            created_at TEXT NOT NULL,
            resolved_at TEXT,
            FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
            FOREIGN KEY(signal_id) REFERENCES thread_signals(id)
        );
        CREATE INDEX IF NOT EXISTS idx_signal_outbox_status_created
            ON signal_outbox(status, created_at, event_id);

        CREATE TABLE IF NOT EXISTS runtime_timers (
            id TEXT PRIMARY KEY,
            generation INTEGER NOT NULL CHECK(generation >= 0),
            kind TEXT NOT NULL CHECK(kind IN ('schedule', 'objective_wait', 'objective_lease', 'background_wake', 'activation_lease', 'delivery_flush')),
            owner_id TEXT NOT NULL,
            due_at TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'fired', 'cancelled')),
            payload_json TEXT NOT NULL,
            claimed_by TEXT,
            claim_expires_at TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            fired_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_runtime_timers_due
            ON runtime_timers(status, due_at, claim_expires_at, id);
        CREATE INDEX IF NOT EXISTS idx_runtime_timers_owner
            ON runtime_timers(kind, owner_id, generation);

        CREATE TABLE IF NOT EXISTS agents (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
            root_context_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS cognitive_contexts (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            title TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            seed_context_id TEXT,
            seed_context_version INTEGER,
            seed_snapshot_hash TEXT,
            seed_projection TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_contexts_agent_updated
            ON cognitive_contexts(agent_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS context_cognitive_clocks (
            context_id TEXT PRIMARY KEY,
            tick INTEGER NOT NULL CHECK(tick >= 0),
            last_signal_batch_id TEXT UNIQUE,
            revision INTEGER NOT NULL CHECK(revision >= 0),
            FOREIGN KEY(context_id) REFERENCES cognitive_contexts(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS context_heads (
            context_id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL CHECK(revision >= 0),
            projection_hash TEXT NOT NULL,
            head_event_id TEXT,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(context_id) REFERENCES cognitive_contexts(id) ON DELETE CASCADE,
            FOREIGN KEY(head_event_id) REFERENCES events(id)
        );

        CREATE TABLE IF NOT EXISTS mind_projections (
            context_id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL CHECK(revision >= 0),
            state_json TEXT NOT NULL,
            state_hash TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(context_id) REFERENCES cognitive_contexts(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS mind_snapshots (
            id TEXT PRIMARY KEY,
            context_id TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK(revision >= 0),
            state_json TEXT NOT NULL,
            state_hash TEXT NOT NULL,
            head_event_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(context_id, revision),
            FOREIGN KEY(context_id) REFERENCES cognitive_contexts(id) ON DELETE CASCADE,
            FOREIGN KEY(head_event_id) REFERENCES events(id)
        );
        CREATE INDEX IF NOT EXISTS idx_mind_snapshots_context_revision
            ON mind_snapshots(context_id, revision DESC);

        CREATE TABLE IF NOT EXISTS principals (
            id TEXT PRIMARY KEY,
            provider_id TEXT NOT NULL,
            assurance TEXT NOT NULL,
            display_name TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            context_id TEXT NOT NULL,
            parent_session_id TEXT,
            title TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_activity_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_agent_activity
            ON sessions(agent_id, last_activity_at DESC);
        CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);

        CREATE TABLE IF NOT EXISTS session_principal_bindings (
            session_id TEXT NOT NULL,
            principal_id TEXT NOT NULL,
            bound_at TEXT NOT NULL,
            unbound_at TEXT,
            PRIMARY KEY(session_id, principal_id),
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            FOREIGN KEY(principal_id) REFERENCES principals(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_session_principal_bindings_principal
            ON session_principal_bindings(principal_id, unbound_at, session_id);

        CREATE TABLE IF NOT EXISTS session_mounts (
            session_id TEXT NOT NULL,
            generation INTEGER NOT NULL,
            context_id TEXT NOT NULL,
            mount_kind TEXT NOT NULL,
            mounted_at TEXT NOT NULL,
            unmounted_at TEXT,
            attention_state TEXT NOT NULL DEFAULT 'active' CHECK(attention_state IN ('active', 'retired')),
            attention_revision INTEGER NOT NULL DEFAULT 0 CHECK(attention_revision >= 0),
            attention_reason TEXT,
            attention_changed_at TEXT,
            attention_event_id TEXT,
            PRIMARY KEY(session_id, generation),
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_session_mounts_context
            ON session_mounts(context_id, unmounted_at);

        CREATE TABLE IF NOT EXISTS delegations (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            parent_context_id TEXT NOT NULL,
            parent_session_id TEXT NOT NULL,
            child_context_id TEXT NOT NULL,
            child_session_id TEXT NOT NULL,
            initiating_principal_id TEXT,
            task TEXT NOT NULL,
            success_when TEXT,
            context_scope TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
            result_event_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_delegations_parent
            ON delegations(parent_session_id, updated_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_delegations_child
            ON delegations(child_session_id);

        CREATE TABLE IF NOT EXISTS objectives (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            context_id TEXT NOT NULL,
            coordinator_session_id TEXT NOT NULL,
            delivery_session_id TEXT NOT NULL,
            parent_objective_id TEXT,
            source_event_id TEXT NOT NULL,
            initiating_principal_id TEXT,
            stated_objective TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK(revision >= 1),
            status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'blocked', 'completed', 'cancelled', 'failed')),
            status_reason TEXT,
            wait_condition_json TEXT,
            active_evaluation_id TEXT,
            evaluation_lease_expires_at TEXT,
            continuation_sequence INTEGER NOT NULL DEFAULT 0 CHECK(continuation_sequence >= 0),
            token_budget INTEGER,
            tokens_used INTEGER NOT NULL DEFAULT 0 CHECK(tokens_used >= 0),
            time_used_seconds INTEGER NOT NULL DEFAULT 0 CHECK(time_used_seconds >= 0),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(context_id) REFERENCES cognitive_contexts(id),
            FOREIGN KEY(coordinator_session_id) REFERENCES sessions(id),
            FOREIGN KEY(delivery_session_id) REFERENCES sessions(id),
            FOREIGN KEY(parent_objective_id) REFERENCES objectives(id)
        );
        CREATE INDEX IF NOT EXISTS idx_objectives_context_status_updated
            ON objectives(context_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_objectives_coordinator_status
            ON objectives(coordinator_session_id, status);

        CREATE TABLE IF NOT EXISTS session_message_requests (
            session_id TEXT NOT NULL,
            client_message_id TEXT NOT NULL,
            event_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(session_id, client_message_id),
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS thread_activations (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
            generation INTEGER NOT NULL DEFAULT 1 CHECK(generation >= 1),
            agent_id TEXT NOT NULL,
            context_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            initiating_principal_id TEXT,
            trigger_event_id TEXT NOT NULL UNIQUE,
            trigger_sequence INTEGER NOT NULL CHECK(trigger_sequence >= 0),
            trigger_kind TEXT NOT NULL,
            parent_activation_id TEXT,
            root_turn_id TEXT NOT NULL,
            context_snapshot_version INTEGER,
            status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'cancelled', 'failed')),
            claimed_by TEXT,
            lease_expires_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            FOREIGN KEY(parent_activation_id) REFERENCES thread_activations(id)
        );
        CREATE INDEX IF NOT EXISTS idx_thread_activations_session_status
            ON thread_activations(session_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_thread_activations_context_status
            ON thread_activations(context_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_thread_activations_lease
            ON thread_activations(status, lease_expires_at);
        CREATE INDEX IF NOT EXISTS idx_thread_activations_root_turn
            ON thread_activations(root_turn_id, updated_at);

        CREATE TABLE IF NOT EXISTS evaluation_outcomes (
            activation_id TEXT NOT NULL PRIMARY KEY,
            session_id TEXT NOT NULL,
            disposition TEXT NOT NULL,
            event_id TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            FOREIGN KEY(activation_id) REFERENCES thread_activations(id) ON DELETE CASCADE,
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS threads (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
            generation INTEGER NOT NULL DEFAULT 1 CHECK(generation >= 1),
            agent_id TEXT NOT NULL,
            context_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            initiating_principal_id TEXT,
            root_turn_id TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL CHECK(kind IN ('dialogue_turn', 'execution', 'objective', 'delivery')),
            status TEXT NOT NULL CHECK(status IN ('open', 'completed', 'failed', 'cancelled')),
            executor_kind TEXT NOT NULL,
            executor_id TEXT,
            target_id TEXT,
            result_text TEXT,
            result_event_id TEXT,
            delivery_status TEXT NOT NULL DEFAULT 'none' CHECK(delivery_status IN ('none', 'pending', 'deferred', 'delivered')),
            delivery_event_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_threads_context_status
            ON threads(context_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_threads_session_delivery
            ON threads(session_id, delivery_status, updated_at);

        CREATE TABLE IF NOT EXISTS execution_targets (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
            owner_principal_id TEXT,
            provider_node_id TEXT,
            kind TEXT NOT NULL CHECK(kind IN (
                'in_process_local', 'edge_node', 'managed_ssh', 'managed_cloud_worker'
            )),
            name TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('online', 'offline', 'disabled')),
            platform TEXT,
            workspace_root TEXT,
            capabilities_json TEXT NOT NULL DEFAULT '[]',
            metadata_json TEXT NOT NULL DEFAULT '{}',
            policy_digest TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_seen_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_execution_targets_owner_status
            ON execution_targets(owner_principal_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_execution_targets_provider_status
            ON execution_targets(provider_node_id, status, updated_at DESC);

        CREATE TABLE IF NOT EXISTS execution_target_authorizations (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
            target_id TEXT NOT NULL,
            owner_principal_id TEXT NOT NULL,
            scope TEXT NOT NULL CHECK(scope IN ('agent', 'context', 'thread')),
            scope_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            revoked_at TEXT,
            revoke_reason TEXT,
            UNIQUE(target_id, owner_principal_id, scope, scope_id),
            FOREIGN KEY(target_id) REFERENCES execution_targets(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_target_authorizations_lookup
            ON execution_target_authorizations(target_id, owner_principal_id, status, scope, scope_id);

        CREATE TABLE IF NOT EXISTS execution_nodes (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
            owner_principal_id TEXT NOT NULL,
            name TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('online', 'offline', 'revoked')),
            device_key_fingerprint TEXT NOT NULL,
            device_public_key TEXT NOT NULL DEFAULT '',
            device_token_hash TEXT NOT NULL,
            device_token_expires_at TEXT,
            protocol_version INTEGER NOT NULL,
            platform TEXT,
            capabilities_json TEXT NOT NULL DEFAULT '[]',
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_seen_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_execution_nodes_owner_status
            ON execution_nodes(owner_principal_id, status, updated_at DESC);

        CREATE TABLE IF NOT EXISTS execution_node_pairing_codes (
            code_hash TEXT PRIMARY KEY,
            owner_principal_id TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            consumed_at TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS execution_node_challenges (
            id TEXT PRIMARY KEY,
            node_id TEXT NOT NULL,
            nonce_hash TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            consumed_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY(node_id) REFERENCES execution_nodes(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_execution_node_challenges_node_expiry
            ON execution_node_challenges(node_id, expires_at);

        CREATE TABLE IF NOT EXISTS execution_jobs (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
            activation_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            context_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            initiating_principal_id TEXT,
            target_id TEXT NOT NULL DEFAULT 'target-default',
            tool_call_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            request_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN (
                'queued', 'waiting_approval', 'running', 'succeeded',
                'failed', 'cancelled', 'lost'
            )),
            retry_safety TEXT NOT NULL CHECK(retry_safety IN (
                'idempotent', 'reconcile_required', 'at_most_once'
            )),
            claimed_by TEXT,
            claim_token TEXT,
            lease_expires_at TEXT,
            heartbeat_at TEXT,
            approval_ref TEXT,
            side_effect_started_at TEXT,
            cancel_requested_at TEXT,
            cancel_reason TEXT,
            progress_ref TEXT,
            result_event_id TEXT,
            result_refs_json TEXT NOT NULL DEFAULT '[]',
            error TEXT,
            exit_code INTEGER,
            created_at TEXT NOT NULL,
            started_at TEXT,
            updated_at TEXT NOT NULL,
            finished_at TEXT,
            UNIQUE(activation_id, tool_call_id),
            FOREIGN KEY(activation_id) REFERENCES thread_activations(id) ON DELETE CASCADE,
            FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE,
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            FOREIGN KEY(target_id) REFERENCES execution_targets(id)
        );
        CREATE INDEX IF NOT EXISTS idx_execution_jobs_queue
            ON execution_jobs(status, created_at, id);
        CREATE INDEX IF NOT EXISTS idx_execution_jobs_context_status
            ON execution_jobs(context_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_execution_jobs_thread_status
            ON execution_jobs(thread_id, status, created_at, id);
        -- idx_execution_jobs_target_status is intentionally created by
        -- migrate_execution_targets after legacy execution_jobs tables have
        -- received target_id. Creating it in the base DDL would make startup
        -- fail before the additive migration can run.
        CREATE INDEX IF NOT EXISTS idx_execution_jobs_lease
            ON execution_jobs(status, lease_expires_at, id);
        CREATE TRIGGER IF NOT EXISTS execution_jobs_terminal_status_is_irreversible
        BEFORE UPDATE OF status ON execution_jobs
        WHEN OLD.status IN ('succeeded', 'failed', 'cancelled', 'lost')
             AND NEW.status <> OLD.status
        BEGIN
            SELECT RAISE(ABORT, 'execution job terminal status is irreversible');
        END;

        CREATE TABLE IF NOT EXISTS plan_executions (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
            activation_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            context_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            initiating_principal_id TEXT,
            tool_call_id TEXT NOT NULL,
            objective_id TEXT,
            objective_evaluation_id TEXT,
            harness_id TEXT,
            harness_version TEXT,
            source_artifact_hash TEXT NOT NULL,
            ir_schema_version INTEGER NOT NULL CHECK(ir_schema_version >= 1),
            program_json TEXT NOT NULL,
            state_json TEXT NOT NULL,
            budget_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN (
                'queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'
            )),
            pending_kind TEXT CHECK(pending_kind IN (
                'execution_job', 'action_group', 'evaluation'
            )),
            pending_id TEXT,
            claimed_by TEXT,
            claim_token TEXT,
            lease_expires_at TEXT,
            result_json TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            finished_at TEXT,
            UNIQUE(activation_id, tool_call_id),
            FOREIGN KEY(activation_id) REFERENCES thread_activations(id) ON DELETE CASCADE,
            FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE,
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            CHECK((status = 'waiting' AND pending_kind IS NOT NULL AND pending_id IS NOT NULL)
               OR (status <> 'waiting' AND pending_kind IS NULL AND pending_id IS NULL))
        );
        CREATE INDEX IF NOT EXISTS idx_plan_executions_queue
            ON plan_executions(status, lease_expires_at, created_at, id);
        CREATE INDEX IF NOT EXISTS idx_plan_executions_context_status
            ON plan_executions(context_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_plan_executions_pending
            ON plan_executions(pending_kind, pending_id)
            WHERE status = 'waiting';
        CREATE TRIGGER IF NOT EXISTS plan_executions_terminal_status_is_irreversible
        BEFORE UPDATE OF status ON plan_executions
        WHEN OLD.status IN ('succeeded', 'failed', 'cancelled')
             AND NEW.status <> OLD.status
        BEGIN
            SELECT RAISE(ABORT, 'plan execution terminal status is irreversible');
        END;

        CREATE TABLE IF NOT EXISTS edge_execution_commands (
            job_id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
            target_id TEXT NOT NULL,
            provider_node_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            arguments TEXT NOT NULL,
            route_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN (
                'queued', 'claimed', 'succeeded', 'failed',
                'cancel_requested', 'cancelled', 'lost'
            )),
            claimed_by TEXT,
            claim_token TEXT,
            lease_expires_at TEXT,
            heartbeat_at TEXT,
            side_effect_started_at TEXT,
            progress TEXT,
            output TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            finished_at TEXT,
            FOREIGN KEY(job_id) REFERENCES execution_jobs(id) ON DELETE CASCADE,
            FOREIGN KEY(target_id) REFERENCES execution_targets(id),
            FOREIGN KEY(provider_node_id) REFERENCES execution_nodes(id)
        );
        CREATE INDEX IF NOT EXISTS idx_edge_commands_node_queue
            ON edge_execution_commands(provider_node_id, status, created_at, job_id);
        CREATE INDEX IF NOT EXISTS idx_edge_commands_lease
            ON edge_execution_commands(status, lease_expires_at, job_id);
        CREATE TRIGGER IF NOT EXISTS edge_commands_terminal_status_is_irreversible
        BEFORE UPDATE OF status ON edge_execution_commands
        WHEN OLD.status IN ('succeeded', 'failed', 'cancelled', 'lost')
             AND NEW.status <> OLD.status
        BEGIN
            SELECT RAISE(ABORT, 'edge command terminal status is irreversible');
        END;

        CREATE TABLE IF NOT EXISTS edge_command_output_chunks (
            job_id TEXT NOT NULL,
            sequence INTEGER NOT NULL CHECK(sequence >= 1),
            stream TEXT NOT NULL CHECK(stream IN ('stdout', 'stderr')),
            text TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(job_id, sequence),
            FOREIGN KEY(job_id) REFERENCES edge_execution_commands(job_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_edge_output_job_sequence
            ON edge_command_output_chunks(job_id, sequence);

        CREATE TABLE IF NOT EXISTS action_groups (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
            activation_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            context_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            assistant_call_event_id TEXT NOT NULL UNIQUE,
            objective_id TEXT,
            objective_evaluation_id TEXT,
            objective_revision INTEGER,
            status TEXT NOT NULL CHECK(status IN ('running', 'settled', 'cancelled', 'lost')),
            member_count INTEGER NOT NULL CHECK(member_count >= 2),
            terminal_member_count INTEGER NOT NULL DEFAULT 0
                CHECK(terminal_member_count >= 0 AND terminal_member_count <= member_count),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            settled_at TEXT,
            FOREIGN KEY(activation_id) REFERENCES thread_activations(id) ON DELETE CASCADE,
            FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE,
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            FOREIGN KEY(objective_id) REFERENCES objectives(id)
        );
        CREATE INDEX IF NOT EXISTS idx_action_groups_context_status
            ON action_groups(context_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_action_groups_session_status
            ON action_groups(session_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_action_groups_activation
            ON action_groups(activation_id, created_at, id);

        CREATE TABLE IF NOT EXISTS action_group_members (
            group_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
            tool_call_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            execution_job_id TEXT,
            status TEXT NOT NULL CHECK(status IN (
                'pending', 'succeeded', 'failed', 'cancelled', 'lost', 'skipped'
            )),
            result_event_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(group_id, tool_call_id),
            UNIQUE(group_id, ordinal),
            FOREIGN KEY(group_id) REFERENCES action_groups(id) ON DELETE CASCADE,
            FOREIGN KEY(execution_job_id) REFERENCES execution_jobs(id),
            FOREIGN KEY(result_event_id) REFERENCES events(id),
            CHECK(
                (status = 'pending' AND result_event_id IS NULL)
                OR (status <> 'pending' AND result_event_id IS NOT NULL)
            )
        );
        CREATE INDEX IF NOT EXISTS idx_action_group_members_group_status
            ON action_group_members(group_id, status, ordinal);

        CREATE TABLE IF NOT EXISTS approval_requests (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
            job_id TEXT NOT NULL,
            request_digest TEXT NOT NULL,
            policy_digest TEXT NOT NULL,
            action_json TEXT NOT NULL,
            requested_json TEXT NOT NULL,
            justification TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN (
                'pending_auto', 'pending_human', 'allowed', 'denied', 'cancelled'
            )),
            rationale TEXT,
            risk_tags_json TEXT NOT NULL DEFAULT '[]',
            grant_id TEXT,
            grant_consumed_at TEXT,
            consumed_by_claim_token TEXT,
            cancel_reason TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            decided_at TEXT,
            cancelled_at TEXT,
            UNIQUE(job_id, request_digest, policy_digest),
            FOREIGN KEY(job_id) REFERENCES execution_jobs(id) ON DELETE CASCADE,
            CHECK(
                (status = 'allowed' AND grant_id IS NOT NULL)
                OR (status <> 'allowed' AND grant_id IS NULL)
            ),
            CHECK(
                (grant_consumed_at IS NULL AND consumed_by_claim_token IS NULL)
                OR (grant_consumed_at IS NOT NULL AND consumed_by_claim_token IS NOT NULL)
            )
        );
        CREATE INDEX IF NOT EXISTS idx_approval_requests_status
            ON approval_requests(status, created_at, id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_job
            ON approval_requests(job_id, created_at, id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_requests_one_active_per_job
            ON approval_requests(job_id)
            WHERE status IN ('pending_auto', 'pending_human', 'allowed');
        CREATE TRIGGER IF NOT EXISTS approval_terminal_status_is_irreversible
        BEFORE UPDATE OF status ON approval_requests
        WHEN OLD.status IN ('denied', 'cancelled') AND NEW.status <> OLD.status
        BEGIN
            SELECT RAISE(ABORT, 'approval terminal status is irreversible');
        END;

        CREATE TABLE IF NOT EXISTS capability_leases (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
            principal_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            target_id TEXT NOT NULL,
            capabilities_json TEXT NOT NULL,
            requested_json TEXT NOT NULL,
            policy_digest TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
            issued_by_approval_id TEXT,
            issued_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            revoked_at TEXT,
            revoke_reason TEXT,
            FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE,
            FOREIGN KEY(target_id) REFERENCES execution_targets(id),
            FOREIGN KEY(issued_by_approval_id) REFERENCES approval_requests(id)
        );
        CREATE INDEX IF NOT EXISTS idx_capability_leases_scope
            ON capability_leases(principal_id, agent_id, thread_id, target_id, status, expires_at);
        CREATE INDEX IF NOT EXISTS idx_capability_leases_approval
            ON capability_leases(issued_by_approval_id);

        CREATE TABLE IF NOT EXISTS thread_signals (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            event_id TEXT NOT NULL UNIQUE,
            principal_id TEXT,
            sequence INTEGER NOT NULL CHECK(sequence >= 0),
            kind TEXT NOT NULL,
            parent_activation_id TEXT,
            status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'acknowledged')),
            created_at TEXT NOT NULL,
            claimed_at TEXT,
            acknowledged_at TEXT,
            FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE,
            FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
            FOREIGN KEY(parent_activation_id) REFERENCES thread_activations(id)
        );
        CREATE INDEX IF NOT EXISTS idx_thread_signals_thread_status_sequence
            ON thread_signals(thread_id, status, sequence, id);

        CREATE TABLE IF NOT EXISTS activation_signals (
            activation_id TEXT NOT NULL,
            signal_id TEXT NOT NULL UNIQUE,
            ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
            PRIMARY KEY(activation_id, ordinal),
            FOREIGN KEY(activation_id) REFERENCES thread_activations(id) ON DELETE CASCADE,
            FOREIGN KEY(signal_id) REFERENCES thread_signals(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_activation_signals_signal
            ON activation_signals(signal_id);

        CREATE TABLE IF NOT EXISTS schedules (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
            thread_id TEXT NOT NULL,
            source_turn_id TEXT NOT NULL,
            intent TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('queued', 'paused', 'dispatched', 'completed', 'cancelled')),
            not_before TEXT,
            interval_seconds INTEGER CHECK(interval_seconds IS NULL OR interval_seconds > 0),
            dependency_thread_ids_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_schedules_due
            ON schedules(status, not_before, created_at);
        CREATE TRIGGER IF NOT EXISTS schedules_terminal_status_is_irreversible
        BEFORE UPDATE OF status ON schedules
        WHEN OLD.status IN ('completed', 'cancelled') AND NEW.status <> OLD.status
        BEGIN
            SELECT RAISE(ABORT, 'scheduled intent terminal status is irreversible');
        END;

        CREATE TABLE IF NOT EXISTS schedule_dependencies (
            schedule_id TEXT NOT NULL,
            dependency_thread_id TEXT NOT NULL,
            PRIMARY KEY(schedule_id, dependency_thread_id),
            FOREIGN KEY(schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
            FOREIGN KEY(dependency_thread_id) REFERENCES threads(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_schedule_dependencies_thread
            ON schedule_dependencies(dependency_thread_id, schedule_id);

        CREATE TABLE IF NOT EXISTS thread_outcomes (
            thread_id TEXT PRIMARY KEY,
            root_turn_id TEXT NOT NULL UNIQUE,
            activation_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            disposition TEXT NOT NULL,
            event_id TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE,
            FOREIGN KEY(activation_id) REFERENCES thread_activations(id) ON DELETE CASCADE,
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        "#;

        sqlx::query(ddl).execute(&pool).await?;
        migrate_execution_targets(&pool).await?;
        migrate_edge_execution(&pool).await?;
        for (table, column) in [
            ("thread_activations", "initiating_principal_id"),
            ("threads", "initiating_principal_id"),
            ("thread_signals", "principal_id"),
            ("execution_jobs", "initiating_principal_id"),
            ("threads", "target_id"),
        ] {
            let columns = sqlx::query(&format!("PRAGMA table_info({table})"))
                .fetch_all(&pool)
                .await?
                .into_iter()
                .map(|row| row.get::<String, _>("name"))
                .collect::<std::collections::HashSet<_>>();
            if !columns.contains(column) {
                sqlx::query(&format!("ALTER TABLE {table} ADD COLUMN {column} TEXT"))
                    .execute(&pool)
                    .await?;
            }
        }
        for table in ["threads", "thread_activations"] {
            let columns = sqlx::query(&format!("PRAGMA table_info({table})"))
                .fetch_all(&pool)
                .await?
                .into_iter()
                .map(|row| row.get::<String, _>("name"))
                .collect::<std::collections::HashSet<_>>();
            if !columns.contains("generation") {
                sqlx::query(&format!(
                    "ALTER TABLE {table} ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK(generation >= 1)"
                ))
                .execute(&pool)
                .await?;
            }
        }
        sqlx::query(
            r#"CREATE INDEX IF NOT EXISTS idx_thread_activations_root_generation_status
               ON thread_activations(root_turn_id, generation, status, updated_at)"#,
        )
        .execute(&pool)
        .await?;
        migrate_runtime_timer_delivery_flush_kind(&pool).await?;
        migrate_schedule_paused_status(&pool).await?;
        // Backfill databases created before the reverse dependency index was
        // introduced. JSON remains on the owner row as the public record; the
        // index only makes terminal dependency wakes deterministic and cheap.
        let dependency_rows = sqlx::query("SELECT id, dependency_thread_ids_json FROM schedules")
            .fetch_all(&pool)
            .await?;
        let mut dependency_tx = pool.begin().await?;
        for row in dependency_rows {
            let schedule_id: String = row.get("id");
            let encoded: String = row.get("dependency_thread_ids_json");
            let dependency_ids: Vec<String> = serde_json::from_str(&encoded)?;
            for dependency_thread_id in dependency_ids {
                sqlx::query(
                    "INSERT OR IGNORE INTO schedule_dependencies (schedule_id, dependency_thread_id) VALUES (?, ?)",
                )
                .bind(&schedule_id)
                .bind(dependency_thread_id)
                .execute(&mut *dependency_tx)
                .await?;
            }
        }
        dependency_tx.commit().await?;
        sqlx::query(
            "UPDATE thread_activations SET status = 'completed' WHERE status IN ('waiting_tool', 'waiting_external')",
        )
        .execute(&pool)
        .await?;
        let mount_columns = sqlx::query("PRAGMA table_info(session_mounts)")
            .fetch_all(&pool)
            .await?;
        let mount_columns = mount_columns
            .iter()
            .map(|row| row.get::<String, _>("name"))
            .collect::<std::collections::HashSet<_>>();
        for (name, definition) in [
            (
                "attention_state",
                "TEXT NOT NULL DEFAULT 'active' CHECK(attention_state IN ('active', 'retired'))",
            ),
            (
                "attention_revision",
                "INTEGER NOT NULL DEFAULT 0 CHECK(attention_revision >= 0)",
            ),
            ("attention_reason", "TEXT"),
            ("attention_changed_at", "TEXT"),
            ("attention_event_id", "TEXT"),
        ] {
            if !mount_columns.contains(name) {
                sqlx::query(&format!(
                    "ALTER TABLE session_mounts ADD COLUMN {name} {definition}"
                ))
                .execute(&pool)
                .await?;
            }
        }

        // Objective reasons were originally present only in the immutable
        // event ledger. Keep the current-state projection self-contained for
        // product surfaces while preserving those source events.
        let objective_columns = sqlx::query("PRAGMA table_info(objectives)")
            .fetch_all(&pool)
            .await?;
        if !objective_columns
            .iter()
            .any(|row| row.get::<String, _>("name") == "initiating_principal_id")
        {
            sqlx::query("ALTER TABLE objectives ADD COLUMN initiating_principal_id TEXT")
                .execute(&pool)
                .await?;
        }
        if !objective_columns
            .iter()
            .any(|row| row.get::<String, _>("name") == "status_reason")
        {
            sqlx::query("ALTER TABLE objectives ADD COLUMN status_reason TEXT")
                .execute(&pool)
                .await?;
            backfill_objective_status_reasons(&pool).await?;
        }

        let delegation_columns = sqlx::query("PRAGMA table_info(delegations)")
            .fetch_all(&pool)
            .await?;
        if !delegation_columns
            .iter()
            .any(|row| row.get::<String, _>("name") == "initiating_principal_id")
        {
            sqlx::query("ALTER TABLE delegations ADD COLUMN initiating_principal_id TEXT")
                .execute(&pool)
                .await?;
        }

        migrate_session_projections(&pool).await?;
        migrate_event_causal_columns(&pool).await?;
        migrate_recall_projection(&pool).await?;
        migrate_attention_acknowledgements(&pool).await?;

        Ok(Self { pool })
    }
}

const ATTENTION_PROJECTION_BACKFILL_MIGRATION: &str =
    "20260723_01_attention_acknowledgement_projection";
const RECALL_FTS_BACKFILL_MIGRATION: &str = "20260722_01_recall_fts_backfill";
const RECALL_SEGMENTED_INDEX_MIGRATION: &str = "20260725_01_recall_segmented_index";

/// Rewrites every stored Recall document under the current Runtime segmenter
/// and refills the freshly created FTS index.
///
/// Documents are read in bounded pages so a large Context does not have to be
/// held in memory at once. Stored text is already NFKC-folded and lowercased,
/// and both operations are idempotent, so re-deriving from it yields exactly
/// what the write path would produce for the original input.
async fn resegment_recall_documents(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    const PAGE: i64 = 500;
    let mut cursor: Option<(String, String, String)> = None;
    loop {
        let page = match &cursor {
            Some((context_id, document_kind, document_id)) => sqlx::query(
                r#"SELECT context_id, document_kind, document_id, searchable_text, retired
                   FROM recall_documents
                   WHERE (context_id, document_kind, document_id) > (?, ?, ?)
                   ORDER BY context_id, document_kind, document_id
                   LIMIT ?"#,
            )
            .bind(context_id)
            .bind(document_kind)
            .bind(document_id)
            .bind(PAGE),
            None => sqlx::query(
                r#"SELECT context_id, document_kind, document_id, searchable_text, retired
                   FROM recall_documents
                   ORDER BY context_id, document_kind, document_id
                   LIMIT ?"#,
            )
            .bind(PAGE),
        }
        .fetch_all(&mut **tx)
        .await?;
        if page.is_empty() {
            break;
        }
        for row in &page {
            let context_id = row.get::<String, _>("context_id");
            let document_kind = row.get::<String, _>("document_kind");
            let document_id = row.get::<String, _>("document_id");
            let stored = row.get::<String, _>("searchable_text");
            let retired = row.get::<i64, _>("retired") != 0;
            let segmented = crate::memory::segment_recall_text(&stored);
            if segmented == stored {
                continue;
            }
            sqlx::query(
                r#"UPDATE recall_documents SET searchable_text = ?, state_hash = ?
                   WHERE context_id = ? AND document_kind = ? AND document_id = ?"#,
            )
            .bind(&segmented)
            .bind(crate::memory::recall_state_hash(&segmented, retired))
            .bind(&context_id)
            .bind(&document_kind)
            .bind(&document_id)
            .execute(&mut **tx)
            .await?;
        }
        let last = &page[page.len() - 1];
        cursor = Some((
            last.get::<String, _>("context_id"),
            last.get::<String, _>("document_kind"),
            last.get::<String, _>("document_id"),
        ));
    }

    // The index was dropped and recreated in this same transaction, and the
    // maintenance triggers are recreated only after it commits, so fill it
    // directly rather than relying on the UPDATE statements above.
    sqlx::query(
        r#"INSERT INTO recall_documents_fts(context_id, document_kind, document_id, searchable_text)
           SELECT context_id, document_kind, document_id, searchable_text FROM recall_documents"#,
    )
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Event payload remains the immutable source of record, while these columns
/// are its query projection for causal routing.  In particular, the
/// Dashboard's Thread inspector must never search an unindexed JSON blob just
/// to discover events already routed to a known Thread.
async fn migrate_event_causal_columns(
    pool: &SqlitePool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let columns = sqlx::query("PRAGMA table_info(events)")
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|row| row.get::<String, _>("name"))
        .collect::<std::collections::HashSet<_>>();
    for column in ["thread_id", "activation_id", "root_turn_id", "objective_id"] {
        if !columns.contains(column) {
            sqlx::query(&format!("ALTER TABLE events ADD COLUMN {column} TEXT"))
                .execute(pool)
                .await?;
        }
    }
    // This order matches the exact lookup used by `Runtime::thread_detail`.
    // It keeps a three-second Dashboard refresh bounded even when a Context
    // has accumulated a large Event Ledger.
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_events_context_session_topic_thread_time \
         ON events(context_id, session_id, topic, thread_id, timestamp)",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_events_context_thread_time \
         ON events(context_id, thread_id, timestamp)",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS event_causal_projection_backfills (\
         context_id TEXT NOT NULL, session_id TEXT NOT NULL, thread_id TEXT NOT NULL, \
         topic TEXT NOT NULL, completed_at TEXT NOT NULL, \
         PRIMARY KEY(context_id, session_id, thread_id, topic))",
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn migrate_recall_projection(
    pool: &SqlitePool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    sqlx::query(
        r#"CREATE TABLE IF NOT EXISTS recall_documents (
               context_id TEXT NOT NULL,
               document_kind TEXT NOT NULL CHECK(document_kind IN ('event', 'frame')),
               document_id TEXT NOT NULL,
               revision INTEGER NOT NULL CHECK(revision >= 0),
               searchable_text TEXT NOT NULL,
               preview TEXT NOT NULL,
               retired INTEGER NOT NULL CHECK(retired IN (0, 1)),
               updated_sequence INTEGER NOT NULL CHECK(updated_sequence >= 0),
               state_hash TEXT NOT NULL,
               PRIMARY KEY(context_id, document_kind, document_id)
           );
           CREATE INDEX IF NOT EXISTS idx_recall_documents_context_updated
             ON recall_documents(context_id, updated_sequence DESC, document_id);
           CREATE TABLE IF NOT EXISTS recall_projection_outbox (
               context_id TEXT NOT NULL,
               document_kind TEXT NOT NULL CHECK(document_kind IN ('event', 'frame')),
               document_id TEXT NOT NULL,
               generation INTEGER NOT NULL CHECK(generation > 0),
               document_json TEXT NOT NULL,
               status TEXT NOT NULL CHECK(status IN ('pending', 'processing')),
               attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
               available_at TEXT NOT NULL,
               claimed_by TEXT,
               claim_expires_at TEXT,
               last_error TEXT,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               PRIMARY KEY(context_id, document_kind, document_id)
           );
           CREATE INDEX IF NOT EXISTS idx_recall_outbox_ready
             ON recall_projection_outbox(status, available_at, claim_expires_at, updated_at);"#,
    )
    .execute(pool)
    .await?;

    // The Runtime segments text before it reaches storage, so the physical
    // index only has to split on whitespace. `trigram` held no entry for any
    // term shorter than three characters, which silently dropped the most
    // common Chinese word form out of Recall entirely.
    //
    // Claim, retire and rebuild inside one transaction: an interrupted rebuild
    // rolls back and is retried on the next start, instead of leaving Recall
    // with an index that is present but half populated.
    let mut tx = pool.begin().await?;
    let claimed =
        sqlx::query("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
            .bind(RECALL_SEGMENTED_INDEX_MIGRATION)
            .bind(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
            .execute(&mut *tx)
            .await?;
    let rebuilding = claimed.rows_affected() > 0;
    if rebuilding {
        for statement in [
            "DROP TRIGGER IF EXISTS recall_documents_ai",
            "DROP TRIGGER IF EXISTS recall_documents_ad",
            "DROP TRIGGER IF EXISTS recall_documents_au",
            "DROP TABLE IF EXISTS recall_documents_fts",
        ] {
            sqlx::query(statement).execute(&mut *tx).await?;
        }
    }
    let fts = sqlx::query(
        r#"CREATE VIRTUAL TABLE IF NOT EXISTS recall_documents_fts USING fts5(
               context_id UNINDEXED,
               document_kind UNINDEXED,
               document_id UNINDEXED,
               searchable_text,
               tokenize='unicode61'
           )"#,
    )
    .execute(&mut *tx)
    .await;
    if let Err(error) = fts {
        tracing::warn!(error = %error, "SQLite 不支持 FTS5，Recall 仅允许精确文档 ID 查询");
        tx.rollback().await?;
        return Ok(());
    }
    if rebuilding {
        resegment_recall_documents(&mut tx).await?;
    }
    tx.commit().await?;

    // `CREATE TRIGGER IF NOT EXISTS` cannot upgrade an existing trigger.  The
    // original UPDATE trigger rebuilt the trigram index for every projection
    // metadata change (revision, retired, updated_sequence, state_hash, ...).
    // Under concurrent Context maintenance that turned cheap MVCC bookkeeping
    // into a full FTS delete+insert and held SQLite's single-writer slot for
    // seconds.  Recreate only this derived trigger on startup; the FTS table is
    // a rebuildable Projection and no Ledger data is affected.
    sqlx::query("DROP TRIGGER IF EXISTS recall_documents_au")
        .execute(pool)
        .await?;

    for statement in [
        r#"CREATE TRIGGER IF NOT EXISTS recall_documents_ai AFTER INSERT ON recall_documents BEGIN
             INSERT INTO recall_documents_fts(context_id, document_kind, document_id, searchable_text)
             VALUES (new.context_id, new.document_kind, new.document_id, new.searchable_text);
           END"#,
        r#"CREATE TRIGGER IF NOT EXISTS recall_documents_ad AFTER DELETE ON recall_documents BEGIN
             DELETE FROM recall_documents_fts
             WHERE context_id = old.context_id AND document_kind = old.document_kind
               AND document_id = old.document_id;
           END"#,
        r#"CREATE TRIGGER IF NOT EXISTS recall_documents_au
           AFTER UPDATE OF context_id, document_kind, document_id, searchable_text
           ON recall_documents
           WHEN old.context_id IS NOT new.context_id
             OR old.document_kind IS NOT new.document_kind
             OR old.document_id IS NOT new.document_id
             OR old.searchable_text IS NOT new.searchable_text
           BEGIN
             DELETE FROM recall_documents_fts
             WHERE context_id = old.context_id AND document_kind = old.document_kind
               AND document_id = old.document_id;
             INSERT INTO recall_documents_fts(context_id, document_kind, document_id, searchable_text)
             VALUES (new.context_id, new.document_kind, new.document_id, new.searchable_text);
           END"#,
    ] {
        sqlx::query(statement).execute(pool).await?;
    }

    let mut tx = pool.begin().await?;
    let claimed =
        sqlx::query("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
            .bind(RECALL_FTS_BACKFILL_MIGRATION)
            .bind(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
            .execute(&mut *tx)
            .await?;
    if claimed.rows_affected() == 0 {
        tx.rollback().await?;
        return Ok(());
    }
    sqlx::query(
        r#"INSERT INTO recall_documents_fts(context_id, document_kind, document_id, searchable_text)
           SELECT d.context_id, d.document_kind, d.document_id, d.searchable_text
           FROM recall_documents d
           WHERE NOT EXISTS (
             SELECT 1 FROM recall_documents_fts f
             WHERE f.context_id = d.context_id AND f.document_kind = d.document_kind
               AND f.document_id = d.document_id
           )"#,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn migrate_attention_acknowledgements(
    pool: &SqlitePool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    let mut tx = pool.begin().await?;
    let claimed =
        sqlx::query("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
            .bind(ATTENTION_PROJECTION_BACKFILL_MIGRATION)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
    if claimed.rows_affected() == 0 {
        tx.rollback().await?;
        return Ok(());
    }
    sqlx::query(
        r#"INSERT INTO attention_acknowledgements
           (context_id, key, event_id, event_sequence, source_kind, source_id,
            source_revision, acknowledged_by, rationale, acknowledged_at)
           SELECT context_id,
                  json_extract(payload, '$.key'),
                  id,
                  rowid,
                  json_extract(payload, '$.source_kind'),
                  json_extract(payload, '$.source_id'),
                  CAST(json_extract(payload, '$.source_revision') AS INTEGER),
                  json_extract(payload, '$.acknowledged_by'),
                  json_extract(payload, '$.rationale'),
                  timestamp
           FROM events
           WHERE topic = 'runtime/attention_acknowledged'
             AND context_id IS NOT NULL
             AND json_extract(payload, '$.key') IS NOT NULL
           ORDER BY rowid ASC
           ON CONFLICT(context_id, key) DO UPDATE SET
             event_id = excluded.event_id,
             event_sequence = excluded.event_sequence,
             source_kind = excluded.source_kind,
             source_id = excluded.source_id,
             source_revision = excluded.source_revision,
             acknowledged_by = excluded.acknowledged_by,
             rationale = excluded.rationale,
             acknowledged_at = excluded.acknowledged_at
           WHERE excluded.event_sequence > attention_acknowledgements.event_sequence"#,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

const EXECUTION_TARGET_MIGRATION: &str = "20260721_01_execution_targets";
const EDGE_EXECUTION_MIGRATION: &str = "20260721_02_edge_execution";

async fn migrate_execution_targets(
    pool: &SqlitePool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // The default row must exist before old Jobs are backfilled or a fresh
    // Runtime creates its first Job. Startup later refreshes this placeholder
    // with the real platform, workspace, capabilities and policy digest.
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    sqlx::query(
        r#"INSERT OR IGNORE INTO execution_targets
           (id, revision, kind, name, status, capabilities_json, metadata_json,
            policy_digest, created_at, updated_at, last_seen_at)
           VALUES ('target-default', 1, 'in_process_local',
                   'Default local execution environment', 'online', '[]', '{}',
                   '', ?, ?, ?)"#,
    )
    .bind(&now)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;

    let columns = sqlx::query("PRAGMA table_info(execution_jobs)")
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|row| row.get::<String, _>("name"))
        .collect::<std::collections::HashSet<_>>();
    if !columns.contains("target_id") {
        sqlx::query(
            "ALTER TABLE execution_jobs ADD COLUMN target_id TEXT NOT NULL DEFAULT 'target-default'",
        )
        .execute(pool)
        .await?;
    }
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_execution_jobs_target_status ON execution_jobs(target_id, status, created_at, id)",
    )
    .execute(pool)
    .await?;
    sqlx::query("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .bind(EXECUTION_TARGET_MIGRATION)
        .bind(&now)
        .execute(pool)
        .await?;
    Ok(())
}

async fn migrate_edge_execution(
    pool: &SqlitePool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Development builds may have created an early command projection before
    // the side-effect boundary became explicit. Additive migration keeps that
    // database readable without replaying or deleting any command.
    let columns = sqlx::query("PRAGMA table_info(edge_execution_commands)")
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|row| row.get::<String, _>("name"))
        .collect::<std::collections::HashSet<_>>();
    if !columns.contains("side_effect_started_at") {
        sqlx::query("ALTER TABLE edge_execution_commands ADD COLUMN side_effect_started_at TEXT")
            .execute(pool)
            .await?;
    }
    if !columns.contains("route_json") {
        sqlx::query(
            "ALTER TABLE edge_execution_commands ADD COLUMN route_json TEXT NOT NULL DEFAULT '{}'",
        )
        .execute(pool)
        .await?;
    }
    let node_columns = sqlx::query("PRAGMA table_info(execution_nodes)")
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|row| row.get::<String, _>("name"))
        .collect::<std::collections::HashSet<_>>();
    if !node_columns.contains("device_public_key") {
        sqlx::query(
            "ALTER TABLE execution_nodes ADD COLUMN device_public_key TEXT NOT NULL DEFAULT ''",
        )
        .execute(pool)
        .await?;
    }
    if !node_columns.contains("device_token_expires_at") {
        sqlx::query("ALTER TABLE execution_nodes ADD COLUMN device_token_expires_at TEXT")
            .execute(pool)
            .await?;
    }
    sqlx::query(
        r#"CREATE TABLE IF NOT EXISTS execution_node_challenges (
            id TEXT PRIMARY KEY,
            node_id TEXT NOT NULL,
            nonce_hash TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            consumed_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY(node_id) REFERENCES execution_nodes(id) ON DELETE CASCADE
        )"#,
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_execution_node_challenges_node_expiry ON execution_node_challenges(node_id, expires_at)",
    )
    .execute(pool)
    .await?;
    sqlx::query("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .bind(EDGE_EXECUTION_MIGRATION)
        .bind(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
        .execute(pool)
        .await?;
    Ok(())
}

const SESSION_PROJECTION_MIGRATION: &str = "20260719_01_session_projections";

async fn migrate_session_projections(
    pool: &SqlitePool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let applied =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM schema_migrations WHERE version = ?")
            .bind(SESSION_PROJECTION_MIGRATION)
            .fetch_one(pool)
            .await?
            > 0;
    if applied {
        return Ok(());
    }

    let mut tx = pool.begin().await?;
    let claimed =
        sqlx::query("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
            .bind(SESSION_PROJECTION_MIGRATION)
            .bind(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
            .execute(&mut *tx)
            .await?;
    if claimed.rows_affected() == 0 {
        tx.rollback().await?;
        return Ok(());
    }
    sqlx::query(
        r#"INSERT OR IGNORE INTO session_projections (event_id, context_id, session_id)
           SELECT id, context_id, session_id
           FROM events
           WHERE context_id IS NOT NULL
             AND (session_id IS NOT NULL
                  OR (topic = 'chat/context_observation'
                      AND json_extract(payload, '$.context_wide') = 1))
             AND type IN ('user_message', 'tool_output', 'agent_call', 'exception', 'file_change')
             AND topic NOT IN ('chat/assistant_call', 'chat/progress', 'chat/no_reply',
                               'chat/context_inspect', 'chat/context_tx_committed',
                               'chat/runtime_error')
                 AND substr(topic, 1, 8) != 'runtime/'
             AND NOT (
                 type = 'tool_output'
                 AND json_extract(payload, '$.tool_name') = 'context_tx'
                     AND substr(COALESCE(json_extract(payload, '$.text'), ''), 1, 5) != '执行失败:'
                     AND substr(COALESCE(json_extract(payload, '$.text'), ''), 1, 5) != '执行拒绝:'
             )"#,
    )
    .execute(&mut *tx)
    .await?;

    let projections = sqlx::query("SELECT state_json FROM mind_projections")
        .fetch_all(&mut *tx)
        .await?;
    for row in projections {
        let state: JsonValue = serde_json::from_str(&row.get::<String, _>("state_json"))?;
        if let Some(retired) = state.get("retired").and_then(JsonValue::as_array) {
            for event_id in retired.iter().filter_map(JsonValue::as_str) {
                sqlx::query("DELETE FROM session_projections WHERE event_id = ?")
                    .bind(event_id)
                    .execute(&mut *tx)
                    .await?;
            }
        }
    }
    tx.commit().await?;
    Ok(())
}

impl crate::memory::RuntimeStore for SqliteStore {
    fn worker_coordination_mode(&self) -> crate::memory::WorkerCoordinationMode {
        crate::memory::WorkerCoordinationMode::SharedHostLeases
    }
}

/// Replace the pre-release Thread discriminator and state vocabulary in one
/// transaction. Public and persistence layers intentionally share the same
/// canonical values; old spellings exist only as migration input.
async fn migrate_threads_to_canonical_domain(
    pool: &SqlitePool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let table_sql = sqlx::query_scalar::<_, String>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'threads'",
    )
    .fetch_optional(pool)
    .await?
    .unwrap_or_default();
    if table_sql.is_empty()
        || (table_sql.contains("'dialogue_turn'")
            && table_sql.contains("'execution'")
            && table_sql.contains("'open'"))
    {
        return Ok(());
    }

    let unknown_rows = sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*) FROM threads
           WHERE kind NOT IN ('dialogue', 'dialogue_turn', 'work', 'execution', 'objective', 'delegation', 'delivery')
              OR status NOT IN ('active', 'waiting', 'open', 'completed', 'failed', 'cancelled')"#,
    )
    .fetch_one(pool)
    .await?;
    if unknown_rows != 0 {
        return Err(
            format!("threads 中存在 {unknown_rows} 条无法映射到规范 Thread 领域的记录").into(),
        );
    }

    // Rebuilding a parent table is SQLite's documented way to change CHECK
    // constraints. Foreign keys are disabled only on this initialization
    // connection, then verified before it is returned to the pool.
    let mut connection = pool.acquire().await?;
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut *connection)
        .await?;
    let migration = async {
        let mut tx = connection.begin().await?;
        sqlx::query("DROP TABLE IF EXISTS threads_canonical_migration")
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            r#"CREATE TABLE threads_canonical_migration (
                id TEXT PRIMARY KEY,
                revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
                agent_id TEXT NOT NULL,
                context_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                root_turn_id TEXT NOT NULL UNIQUE,
                kind TEXT NOT NULL CHECK(kind IN ('dialogue_turn', 'execution', 'objective', 'delivery')),
                status TEXT NOT NULL CHECK(status IN ('open', 'completed', 'failed', 'cancelled')),
                executor_kind TEXT NOT NULL,
                executor_id TEXT,
                result_text TEXT,
                result_event_id TEXT,
                delivery_status TEXT NOT NULL DEFAULT 'none' CHECK(delivery_status IN ('none', 'pending', 'deferred', 'delivered')),
                delivery_event_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )"#,
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"INSERT INTO threads_canonical_migration
               (id, revision, agent_id, context_id, session_id, root_turn_id,
                kind, status, executor_kind, executor_id, result_text,
                result_event_id, delivery_status, delivery_event_id,
                created_at, updated_at)
               SELECT id, revision, agent_id, context_id, session_id, root_turn_id,
                      CASE kind
                          WHEN 'dialogue' THEN 'dialogue_turn'
                          WHEN 'work' THEN 'execution'
                          WHEN 'delegation' THEN 'execution'
                          ELSE kind
                      END,
                      CASE status
                          WHEN 'active' THEN 'open'
                          WHEN 'waiting' THEN 'open'
                          ELSE status
                      END,
                      executor_kind, executor_id, result_text, result_event_id,
                      delivery_status, delivery_event_id, created_at, updated_at
               FROM threads"#,
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query("DROP TABLE threads")
            .execute(&mut *tx)
            .await?;
        sqlx::query("ALTER TABLE threads_canonical_migration RENAME TO threads")
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
    }
    .await;
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut *connection)
        .await?;
    migration?;

    let violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut *connection)
        .await?;
    if !violations.is_empty() {
        return Err(format!("Thread 领域迁移后发现 {} 条外键违规", violations.len()).into());
    }
    Ok(())
}

/// SQLite cannot widen a CHECK constraint in place. Preserve every Timer row
/// while adding the Runtime-owned Delivery Flush kind used by completion
/// coalescing. Runtime timers have no inbound foreign keys, so rebuilding only
/// this table is sufficient and remains transactional.
async fn migrate_runtime_timer_delivery_flush_kind(
    pool: &SqlitePool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let table_sql = sqlx::query_scalar::<_, Option<String>>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runtime_timers'",
    )
    .fetch_one(pool)
    .await?
    .unwrap_or_default();
    if table_sql.contains("'delivery_flush'") {
        return Ok(());
    }

    let mut tx = pool.begin().await?;
    sqlx::query("ALTER TABLE runtime_timers RENAME TO runtime_timers_legacy")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        r#"CREATE TABLE runtime_timers (
            id TEXT PRIMARY KEY,
            generation INTEGER NOT NULL CHECK(generation >= 0),
            kind TEXT NOT NULL CHECK(kind IN ('schedule', 'objective_wait', 'objective_lease', 'background_wake', 'activation_lease', 'delivery_flush')),
            owner_id TEXT NOT NULL,
            due_at TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'fired', 'cancelled')),
            payload_json TEXT NOT NULL,
            claimed_by TEXT,
            claim_expires_at TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            fired_at TEXT
        )"#,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"INSERT INTO runtime_timers
           (id, generation, kind, owner_id, due_at, status, payload_json,
            claimed_by, claim_expires_at, last_error, created_at, updated_at, fired_at)
           SELECT id, generation, kind, owner_id, due_at, status, payload_json,
                  claimed_by, claim_expires_at, last_error, created_at, updated_at, fired_at
           FROM runtime_timers_legacy"#,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query("DROP TABLE runtime_timers_legacy")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "CREATE INDEX idx_runtime_timers_due ON runtime_timers(status, due_at, claim_expires_at, id)",
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "CREATE INDEX idx_runtime_timers_owner ON runtime_timers(kind, owner_id, generation)",
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// SQLite cannot widen a CHECK constraint in place. Rebuild only the Schedule
/// owner table and its reverse dependency index so pre-Phase-4 databases can
/// persist `paused` without dropping either the Schedule rows or dependency
/// routing. The whole migration is transactional.
async fn migrate_schedule_paused_status(
    pool: &SqlitePool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let table_sql = sqlx::query_scalar::<_, Option<String>>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schedules'",
    )
    .fetch_one(pool)
    .await?
    .unwrap_or_default();
    if table_sql.contains("'paused'") {
        return Ok(());
    }

    let mut tx = pool.begin().await?;
    sqlx::query("DROP TABLE IF EXISTS schedule_dependencies_migration")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        r#"CREATE TEMP TABLE schedule_dependencies_migration AS
           SELECT schedule_id, dependency_thread_id
           FROM schedule_dependencies"#,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query("DROP TABLE schedule_dependencies")
        .execute(&mut *tx)
        .await?;
    sqlx::query("ALTER TABLE schedules RENAME TO schedules_legacy")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        r#"CREATE TABLE schedules (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
            thread_id TEXT NOT NULL,
            source_turn_id TEXT NOT NULL,
            intent TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('queued', 'paused', 'dispatched', 'completed', 'cancelled')),
            not_before TEXT,
            interval_seconds INTEGER CHECK(interval_seconds IS NULL OR interval_seconds > 0),
            dependency_thread_ids_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
        )"#,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"INSERT INTO schedules
           (id, revision, thread_id, source_turn_id, intent, status, not_before,
            interval_seconds, dependency_thread_ids_json, created_at, updated_at)
           SELECT id, revision, thread_id, source_turn_id, intent, status, not_before,
                  interval_seconds, dependency_thread_ids_json, created_at, updated_at
           FROM schedules_legacy"#,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query("DROP TABLE schedules_legacy")
        .execute(&mut *tx)
        .await?;
    sqlx::query("CREATE INDEX idx_schedules_due ON schedules(status, not_before, created_at)")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        r#"CREATE TRIGGER schedules_terminal_status_is_irreversible
           BEFORE UPDATE OF status ON schedules
           WHEN OLD.status IN ('completed', 'cancelled') AND NEW.status <> OLD.status
           BEGIN
               SELECT RAISE(ABORT, 'scheduled intent terminal status is irreversible');
           END"#,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"CREATE TABLE schedule_dependencies (
            schedule_id TEXT NOT NULL,
            dependency_thread_id TEXT NOT NULL,
            PRIMARY KEY(schedule_id, dependency_thread_id),
            FOREIGN KEY(schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
            FOREIGN KEY(dependency_thread_id) REFERENCES threads(id) ON DELETE CASCADE
        )"#,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "CREATE INDEX idx_schedule_dependencies_thread ON schedule_dependencies(dependency_thread_id, schedule_id)",
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"INSERT INTO schedule_dependencies
           (schedule_id, dependency_thread_id)
           SELECT schedule_id, dependency_thread_id
           FROM schedule_dependencies_migration"#,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query("DROP TABLE schedule_dependencies_migration")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

async fn backfill_objective_status_reasons(
    pool: &SqlitePool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let events = sqlx::query(
        "SELECT payload FROM events WHERE type = 'objective_control' AND topic = 'objective/updated' ORDER BY timestamp",
    )
    .fetch_all(pool)
    .await?;
    for row in events {
        let payload = serde_json::from_str::<JsonValue>(&row.get::<String, _>("payload"))?;
        let Some(objective_id) = payload.get("objective_id").and_then(JsonValue::as_str) else {
            continue;
        };
        let Some(reason) = payload.get("reason").and_then(JsonValue::as_str) else {
            continue;
        };
        sqlx::query("UPDATE objectives SET status_reason = ? WHERE id = ?")
            .bind(reason)
            .bind(objective_id)
            .execute(pool)
            .await?;
    }
    Ok(())
}

fn parse_session_status(value: &str) -> SessionStatus {
    match value {
        "archived" => SessionStatus::Archived,
        _ => SessionStatus::Active,
    }
}

fn parse_session_attention_state(value: &str) -> SessionAttentionState {
    match value {
        "retired" => SessionAttentionState::Retired,
        _ => SessionAttentionState::Active,
    }
}

fn parse_thread_activation_status(
    value: &str,
) -> Result<ThreadActivationStatus, Box<dyn std::error::Error + Send + Sync>> {
    match value {
        "queued" => Ok(ThreadActivationStatus::Queued),
        "running" => Ok(ThreadActivationStatus::Running),
        "waiting_tool" | "waiting_external" | "completed" | "succeeded" => {
            Ok(ThreadActivationStatus::Succeeded)
        }
        "cancelled" => Ok(ThreadActivationStatus::Cancelled),
        "failed" => Ok(ThreadActivationStatus::Failed),
        other => Err(format!("未知 Thread Activation 状态：'{other}'").into()),
    }
}

fn thread_activation_status_storage(status: ThreadActivationStatus) -> &'static str {
    match status {
        ThreadActivationStatus::Queued => "queued",
        ThreadActivationStatus::Running => "running",
        ThreadActivationStatus::Succeeded => "completed",
        ThreadActivationStatus::Cancelled => "cancelled",
        ThreadActivationStatus::Failed => "failed",
    }
}

fn parse_thread_signal_status(
    value: &str,
) -> Result<ThreadSignalStatus, Box<dyn std::error::Error + Send + Sync>> {
    match value {
        "pending" => Ok(ThreadSignalStatus::Pending),
        "claimed" => Ok(ThreadSignalStatus::Claimed),
        "acknowledged" => Ok(ThreadSignalStatus::Acknowledged),
        other => Err(format!("未知 Thread Signal 状态：'{other}'").into()),
    }
}

fn parse_thread_kind(value: &str) -> Result<ThreadKind, Box<dyn std::error::Error + Send + Sync>> {
    match value {
        "dialogue_turn" => Ok(ThreadKind::DialogueTurn),
        "execution" => Ok(ThreadKind::Execution),
        "objective" => Ok(ThreadKind::Objective),
        "delivery" => Ok(ThreadKind::Delivery),
        other => Err(format!("未知 Thread kind：'{other}'").into()),
    }
}

fn parse_thread_lifecycle(
    value: &str,
) -> Result<ThreadLifecycle, Box<dyn std::error::Error + Send + Sync>> {
    match value {
        "open" => Ok(ThreadLifecycle::Open),
        "completed" => Ok(ThreadLifecycle::Completed),
        "failed" => Ok(ThreadLifecycle::Failed),
        "cancelled" => Ok(ThreadLifecycle::Cancelled),
        other => Err(format!("未知 Thread lifecycle：'{other}'").into()),
    }
}

fn parse_delivery_status(
    value: &str,
) -> Result<DeliveryStatus, Box<dyn std::error::Error + Send + Sync>> {
    match value {
        "none" => Ok(DeliveryStatus::None),
        "pending" => Ok(DeliveryStatus::Pending),
        "deferred" => Ok(DeliveryStatus::Deferred),
        "delivered" => Ok(DeliveryStatus::Delivered),
        other => Err(format!("未知 Thread delivery status：'{other}'").into()),
    }
}

fn parse_schedule_status(
    value: &str,
) -> Result<ScheduleStatus, Box<dyn std::error::Error + Send + Sync>> {
    match value {
        "queued" => Ok(ScheduleStatus::Queued),
        "paused" => Ok(ScheduleStatus::Paused),
        "dispatched" => Ok(ScheduleStatus::Dispatched),
        "completed" => Ok(ScheduleStatus::Completed),
        "cancelled" => Ok(ScheduleStatus::Cancelled),
        other => Err(format!("未知 Schedule status：'{other}'").into()),
    }
}

fn parse_delegation_status(value: &str) -> DelegationStatus {
    match value {
        "running" => DelegationStatus::Running,
        "completed" => DelegationStatus::Completed,
        "failed" => DelegationStatus::Failed,
        "cancelled" => DelegationStatus::Cancelled,
        _ => DelegationStatus::Queued,
    }
}

fn parse_objective_status(
    value: &str,
) -> Result<ObjectiveStatus, Box<dyn std::error::Error + Send + Sync>> {
    match value {
        "active" => Ok(ObjectiveStatus::Active),
        "paused" => Ok(ObjectiveStatus::Paused),
        "blocked" => Ok(ObjectiveStatus::Blocked),
        "completed" => Ok(ObjectiveStatus::Completed),
        "cancelled" => Ok(ObjectiveStatus::Cancelled),
        "failed" => Ok(ObjectiveStatus::Failed),
        other => Err(format!("未知 Objective 状态：'{other}'").into()),
    }
}

fn sqlite_u64(
    row: &sqlx::sqlite::SqliteRow,
    column: &str,
) -> Result<u64, Box<dyn std::error::Error + Send + Sync>> {
    let value = row.get::<i64, _>(column);
    u64::try_from(value).map_err(|_| format!("Objective 字段 '{column}' 不能为负数").into())
}

fn sqlite_optional_u64(
    row: &sqlx::sqlite::SqliteRow,
    column: &str,
) -> Result<Option<u64>, Box<dyn std::error::Error + Send + Sync>> {
    row.get::<Option<i64>, _>(column)
        .map(|value| {
            u64::try_from(value).map_err(|_| format!("Objective 字段 '{column}' 不能为负数"))
        })
        .transpose()
        .map_err(Into::into)
}

fn agent_from_row(row: &sqlx::sqlite::SqliteRow) -> AgentRecord {
    AgentRecord {
        id: row.get("id"),
        title: row.get("title"),
        status: parse_session_status(row.get::<String, _>("status").as_str()),
        root_context_id: row.get("root_context_id"),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
    }
}

fn delegation_from_row(row: &sqlx::sqlite::SqliteRow) -> DelegationRecord {
    DelegationRecord {
        id: row.get("id"),
        agent_id: row.get("agent_id"),
        parent_context_id: row.get("parent_context_id"),
        parent_session_id: row.get("parent_session_id"),
        child_context_id: row.get("child_context_id"),
        child_session_id: row.get("child_session_id"),
        initiating_principal_id: row.get("initiating_principal_id"),
        task: row.get("task"),
        success_when: row.get("success_when"),
        context_scope: row.get("context_scope"),
        status: parse_delegation_status(row.get::<String, _>("status").as_str()),
        result_event_id: row.get("result_event_id"),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
    }
}

fn session_from_row(row: &sqlx::sqlite::SqliteRow) -> SessionRecord {
    SessionRecord {
        id: row.get("id"),
        agent_id: row.get("agent_id"),
        context_id: row.get("context_id"),
        parent_session_id: row.get("parent_session_id"),
        title: row.get("title"),
        status: parse_session_status(row.get::<String, _>("status").as_str()),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
        last_activity_at: parse_time(&row.get::<String, _>("last_activity_at")),
        attention_state: parse_session_attention_state(&row.get::<String, _>("attention_state")),
        attention_revision: u64::try_from(row.get::<i64, _>("attention_revision"))
            .expect("Session attention revision 不能为负数"),
        attention_reason: row.get("attention_reason"),
        attention_changed_at: row
            .get::<Option<String>, _>("attention_changed_at")
            .map(|value| parse_time(&value)),
        attention_event_id: row.get("attention_event_id"),
    }
}

fn principal_from_row(row: &sqlx::sqlite::SqliteRow) -> PrincipalRecord {
    PrincipalRecord {
        id: row.get("id"),
        provider_id: row.get("provider_id"),
        assurance: row.get("assurance"),
        display_name: row.get("display_name"),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
    }
}

fn session_principal_binding_from_row(row: &sqlx::sqlite::SqliteRow) -> SessionPrincipalBinding {
    SessionPrincipalBinding {
        session_id: row.get("session_id"),
        principal_id: row.get("principal_id"),
        bound_at: parse_time(&row.get::<String, _>("bound_at")),
        unbound_at: row
            .get::<Option<String>, _>("unbound_at")
            .map(|value| parse_time(&value)),
    }
}

fn thread_activation_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<ThreadActivationRecord, Box<dyn std::error::Error + Send + Sync>> {
    Ok(ThreadActivationRecord {
        id: row.get("id"),
        revision: sqlite_u64(row, "revision")?,
        generation: sqlite_u64(row, "generation")?,
        agent_id: row.get("agent_id"),
        context_id: row.get("context_id"),
        session_id: row.get("session_id"),
        initiating_principal_id: row.get("initiating_principal_id"),
        trigger_event_id: row.get("trigger_event_id"),
        trigger_sequence: sqlite_u64(row, "trigger_sequence")?,
        trigger_kind: row.get("trigger_kind"),
        parent_activation_id: row.get("parent_activation_id"),
        root_turn_id: row.get("root_turn_id"),
        context_snapshot_version: sqlite_optional_u64(row, "context_snapshot_version")?,
        status: parse_thread_activation_status(&row.get::<String, _>("status"))?,
        claimed_by: row.get("claimed_by"),
        lease_expires_at: row
            .get::<Option<String>, _>("lease_expires_at")
            .map(|value| parse_time(&value)),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
    })
}

fn thread_signal_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<ThreadSignalRecord, Box<dyn std::error::Error + Send + Sync>> {
    Ok(ThreadSignalRecord {
        id: row.get("id"),
        thread_id: row.get("thread_id"),
        event_id: row.get("event_id"),
        principal_id: row.get("principal_id"),
        sequence: sqlite_u64(row, "sequence")?,
        kind: row.get("kind"),
        parent_activation_id: row.get("parent_activation_id"),
        status: parse_thread_signal_status(&row.get::<String, _>("status"))?,
        created_at: parse_time(&row.get::<String, _>("created_at")),
        claimed_at: row
            .get::<Option<String>, _>("claimed_at")
            .map(|value| parse_time(&value)),
        acknowledged_at: row
            .get::<Option<String>, _>("acknowledged_at")
            .map(|value| parse_time(&value)),
    })
}

fn thread_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<ThreadRecord, Box<dyn std::error::Error + Send + Sync>> {
    Ok(ThreadRecord {
        id: row.get("id"),
        revision: sqlite_u64(row, "revision")?,
        generation: sqlite_u64(row, "generation")?,
        agent_id: row.get("agent_id"),
        context_id: row.get("context_id"),
        session_id: row.get("session_id"),
        initiating_principal_id: row.get("initiating_principal_id"),
        root_turn_id: row.get("root_turn_id"),
        kind: parse_thread_kind(&row.get::<String, _>("kind"))?,
        lifecycle: parse_thread_lifecycle(&row.get::<String, _>("status"))?,
        executor_kind: row.get("executor_kind"),
        executor_id: row.get("executor_id"),
        target_id: row.get("target_id"),
        result_text: row.get("result_text"),
        result_event_id: row.get("result_event_id"),
        delivery_status: parse_delivery_status(&row.get::<String, _>("delivery_status"))?,
        delivery_event_id: row.get("delivery_event_id"),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
    })
}

fn schedule_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<ScheduleRecord, Box<dyn std::error::Error + Send + Sync>> {
    let dependency_thread_ids =
        serde_json::from_str::<Vec<String>>(&row.get::<String, _>("dependency_thread_ids_json"))?;
    Ok(ScheduleRecord {
        id: row.get("id"),
        revision: sqlite_u64(row, "revision")?,
        thread_id: row.get("thread_id"),
        source_turn_id: row.get("source_turn_id"),
        intent: row.get("intent"),
        status: parse_schedule_status(&row.get::<String, _>("status"))?,
        not_before: row
            .get::<Option<String>, _>("not_before")
            .map(|value| parse_time(&value)),
        interval_seconds: sqlite_optional_u64(row, "interval_seconds")?,
        dependency_thread_ids,
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
    })
}

async fn schedule_mutation_failure(
    store: &SqliteStore,
    id: &str,
    expected_revision: u64,
    reason: impl Into<String>,
) -> Result<ScheduleMutation, Box<dyn std::error::Error + Send + Sync>> {
    Ok(match store.get_schedule(id).await? {
        Some(current) if current.revision != expected_revision => {
            ScheduleMutation::Conflict { current }
        }
        Some(current) => ScheduleMutation::Rejected {
            current,
            reason: reason.into(),
        },
        None => ScheduleMutation::NotFound,
    })
}

fn context_from_row(row: &sqlx::sqlite::SqliteRow) -> CognitiveContextRecord {
    CognitiveContextRecord {
        id: row.get("id"),
        agent_id: row.get("agent_id"),
        title: row.get("title"),
        status: parse_session_status(row.get::<String, _>("status").as_str()),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
        seed_context_id: row.get("seed_context_id"),
        seed_context_version: row
            .get::<Option<i64>, _>("seed_context_version")
            .and_then(|version| u64::try_from(version).ok()),
        seed_snapshot_hash: row.get("seed_snapshot_hash"),
        seed_projection: row.get("seed_projection"),
    }
}

fn objective_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<ObjectiveRecord, Box<dyn std::error::Error + Send + Sync>> {
    let wait_condition = row
        .get::<Option<String>, _>("wait_condition_json")
        .map(|json| serde_json::from_str::<ObjectiveWaitCondition>(&json))
        .transpose()?;
    Ok(ObjectiveRecord {
        id: row.get("id"),
        agent_id: row.get("agent_id"),
        context_id: row.get("context_id"),
        coordinator_session_id: row.get("coordinator_session_id"),
        delivery_session_id: row.get("delivery_session_id"),
        parent_objective_id: row.get("parent_objective_id"),
        source_event_id: row.get("source_event_id"),
        initiating_principal_id: row.get("initiating_principal_id"),
        stated_objective: row.get("stated_objective"),
        revision: sqlite_u64(row, "revision")?,
        status: parse_objective_status(&row.get::<String, _>("status"))?,
        status_reason: row.get("status_reason"),
        wait_condition,
        active_evaluation_id: row.get("active_evaluation_id"),
        evaluation_lease_expires_at: row
            .get::<Option<String>, _>("evaluation_lease_expires_at")
            .as_deref()
            .map(parse_time),
        continuation_sequence: sqlite_u64(row, "continuation_sequence")?,
        token_budget: sqlite_optional_u64(row, "token_budget")?,
        tokens_used: sqlite_u64(row, "tokens_used")?,
        time_used_seconds: sqlite_u64(row, "time_used_seconds")?,
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
    })
}

fn signal_outbox_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<SignalOutboxRecord, Box<dyn std::error::Error + Send + Sync>> {
    Ok(SignalOutboxRecord {
        event_id: row.get("event_id"),
        status: match row.get::<String, _>("status").as_str() {
            "pending" => SignalOutboxStatus::Pending,
            "materialized" => SignalOutboxStatus::Materialized,
            "discarded" => SignalOutboxStatus::Discarded,
            value => return Err(format!("未知 Signal Outbox 状态: {value}").into()),
        },
        signal_id: row.get("signal_id"),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        resolved_at: row
            .get::<Option<String>, _>("resolved_at")
            .as_deref()
            .map(parse_time),
    })
}

fn parse_execution_job_status(
    value: &str,
) -> Result<ExecutionJobStatus, Box<dyn std::error::Error + Send + Sync>> {
    match value {
        "queued" => Ok(ExecutionJobStatus::Queued),
        "waiting_approval" => Ok(ExecutionJobStatus::WaitingApproval),
        "running" => Ok(ExecutionJobStatus::Running),
        "succeeded" => Ok(ExecutionJobStatus::Succeeded),
        "failed" => Ok(ExecutionJobStatus::Failed),
        "cancelled" => Ok(ExecutionJobStatus::Cancelled),
        "lost" => Ok(ExecutionJobStatus::Lost),
        other => Err(format!("未知 Execution Job status：'{other}'").into()),
    }
}

fn parse_execution_target_kind(
    value: &str,
) -> Result<ExecutionTargetKind, Box<dyn std::error::Error + Send + Sync>> {
    ExecutionTargetKind::parse(value)
        .ok_or_else(|| format!("未知 Execution Target 类型: {value}").into())
}

fn parse_execution_target_status(
    value: &str,
) -> Result<ExecutionTargetStatus, Box<dyn std::error::Error + Send + Sync>> {
    ExecutionTargetStatus::parse(value)
        .ok_or_else(|| format!("未知 Execution Target 状态: {value}").into())
}

fn parse_execution_node_status(
    value: &str,
) -> Result<ExecutionNodeStatus, Box<dyn std::error::Error + Send + Sync>> {
    ExecutionNodeStatus::parse(value)
        .ok_or_else(|| format!("未知 Execution Node 状态: {value}").into())
}

fn parse_edge_command_status(
    value: &str,
) -> Result<EdgeCommandStatus, Box<dyn std::error::Error + Send + Sync>> {
    EdgeCommandStatus::parse(value).ok_or_else(|| format!("未知 Edge Command 状态: {value}").into())
}

fn parse_execution_retry_safety(
    value: &str,
) -> Result<ExecutionRetrySafety, Box<dyn std::error::Error + Send + Sync>> {
    match value {
        "idempotent" => Ok(ExecutionRetrySafety::Idempotent),
        "reconcile_required" => Ok(ExecutionRetrySafety::ReconcileRequired),
        "at_most_once" => Ok(ExecutionRetrySafety::AtMostOnce),
        other => Err(format!("未知 Execution Job retry safety：'{other}'").into()),
    }
}

fn parse_action_group_status(
    value: &str,
) -> Result<ActionGroupStatus, Box<dyn std::error::Error + Send + Sync>> {
    match value {
        "running" => Ok(ActionGroupStatus::Running),
        "settled" => Ok(ActionGroupStatus::Settled),
        "cancelled" => Ok(ActionGroupStatus::Cancelled),
        "lost" => Ok(ActionGroupStatus::Lost),
        other => Err(format!("未知 Action Group status：'{other}'").into()),
    }
}

fn parse_action_group_member_status(
    value: &str,
) -> Result<ActionGroupMemberStatus, Box<dyn std::error::Error + Send + Sync>> {
    match value {
        "pending" => Ok(ActionGroupMemberStatus::Pending),
        "succeeded" => Ok(ActionGroupMemberStatus::Succeeded),
        "failed" => Ok(ActionGroupMemberStatus::Failed),
        "cancelled" => Ok(ActionGroupMemberStatus::Cancelled),
        "lost" => Ok(ActionGroupMemberStatus::Lost),
        "skipped" => Ok(ActionGroupMemberStatus::Skipped),
        other => Err(format!("未知 Action Group member status：'{other}'").into()),
    }
}

fn action_group_from_row(
    row: &SqliteRow,
) -> Result<ActionGroupRecord, Box<dyn std::error::Error + Send + Sync>> {
    Ok(ActionGroupRecord {
        id: row.get("id"),
        revision: sqlite_u64(row, "revision")?,
        activation_id: row.get("activation_id"),
        thread_id: row.get("thread_id"),
        agent_id: row.get("agent_id"),
        context_id: row.get("context_id"),
        session_id: row.get("session_id"),
        assistant_call_event_id: row.get("assistant_call_event_id"),
        objective_id: row.get("objective_id"),
        objective_evaluation_id: row.get("objective_evaluation_id"),
        objective_revision: row
            .get::<Option<i64>, _>("objective_revision")
            .map(|value| u64::try_from(value).map_err(|_| "Objective revision 小于零"))
            .transpose()?,
        status: parse_action_group_status(&row.get::<String, _>("status"))?,
        member_count: sqlite_u64(row, "member_count")?,
        terminal_member_count: sqlite_u64(row, "terminal_member_count")?,
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
        settled_at: row
            .get::<Option<String>, _>("settled_at")
            .as_deref()
            .map(parse_time),
    })
}

fn action_group_member_from_row(
    row: &SqliteRow,
) -> Result<ActionGroupMemberRecord, Box<dyn std::error::Error + Send + Sync>> {
    Ok(ActionGroupMemberRecord {
        group_id: row.get("group_id"),
        ordinal: sqlite_u64(row, "ordinal")?,
        tool_call_id: row.get("tool_call_id"),
        tool_name: row.get("tool_name"),
        execution_job_id: row.get("execution_job_id"),
        status: parse_action_group_member_status(&row.get::<String, _>("status"))?,
        result_event_id: row.get("result_event_id"),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
    })
}

fn parse_approval_status(
    value: &str,
) -> Result<ApprovalStatus, Box<dyn std::error::Error + Send + Sync>> {
    match value {
        "pending_auto" => Ok(ApprovalStatus::PendingAuto),
        "pending_human" => Ok(ApprovalStatus::PendingHuman),
        "allowed" => Ok(ApprovalStatus::Allowed),
        "denied" => Ok(ApprovalStatus::Denied),
        "cancelled" => Ok(ApprovalStatus::Cancelled),
        other => Err(format!("未知 Approval status：'{other}'").into()),
    }
}

fn approval_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<ApprovalRecord, Box<dyn std::error::Error + Send + Sync>> {
    Ok(ApprovalRecord {
        id: row.get("id"),
        revision: sqlite_u64(row, "revision")?,
        job_id: row.get("job_id"),
        request_digest: row.get("request_digest"),
        policy_digest: row.get("policy_digest"),
        action: serde_json::from_str(&row.get::<String, _>("action_json"))?,
        requested: serde_json::from_str(&row.get::<String, _>("requested_json"))?,
        justification: row.get("justification"),
        status: parse_approval_status(&row.get::<String, _>("status"))?,
        rationale: row.get("rationale"),
        risk_tags: serde_json::from_str(&row.get::<String, _>("risk_tags_json"))?,
        grant_id: row.get("grant_id"),
        grant_consumed_at: row
            .get::<Option<String>, _>("grant_consumed_at")
            .as_deref()
            .map(parse_time),
        consumed_by_claim_token: row.get("consumed_by_claim_token"),
        cancel_reason: row.get("cancel_reason"),
        last_error: row.get("last_error"),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
        decided_at: row
            .get::<Option<String>, _>("decided_at")
            .as_deref()
            .map(parse_time),
        cancelled_at: row
            .get::<Option<String>, _>("cancelled_at")
            .as_deref()
            .map(parse_time),
    })
}

fn capability_lease_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<CapabilityLeaseRecord, Box<dyn std::error::Error + Send + Sync>> {
    Ok(CapabilityLeaseRecord {
        id: row.get("id"),
        revision: sqlite_u64(row, "revision")?,
        principal_id: row.get("principal_id"),
        agent_id: row.get("agent_id"),
        thread_id: row.get("thread_id"),
        target_id: row.get("target_id"),
        capabilities: serde_json::from_str(&row.get::<String, _>("capabilities_json"))?,
        requested: serde_json::from_str(&row.get::<String, _>("requested_json"))?,
        policy_digest: row.get("policy_digest"),
        status: CapabilityLeaseStatus::parse(&row.get::<String, _>("status"))
            .ok_or("未知 Capability Lease status")?,
        issued_by_approval_id: row.get("issued_by_approval_id"),
        issued_at: parse_time(&row.get::<String, _>("issued_at")),
        expires_at: parse_time(&row.get::<String, _>("expires_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
        revoked_at: row
            .get::<Option<String>, _>("revoked_at")
            .as_deref()
            .map(parse_time),
        revoke_reason: row.get("revoke_reason"),
    })
}

fn execution_job_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<ExecutionJobRecord, Box<dyn std::error::Error + Send + Sync>> {
    Ok(ExecutionJobRecord {
        id: row.get("id"),
        revision: sqlite_u64(row, "revision")?,
        activation_id: row.get("activation_id"),
        thread_id: row.get("thread_id"),
        agent_id: row.get("agent_id"),
        context_id: row.get("context_id"),
        session_id: row.get("session_id"),
        initiating_principal_id: row.get("initiating_principal_id"),
        target_id: row.get("target_id"),
        tool_call_id: row.get("tool_call_id"),
        tool_name: row.get("tool_name"),
        request: serde_json::from_str(&row.get::<String, _>("request_json"))?,
        status: parse_execution_job_status(&row.get::<String, _>("status"))?,
        retry_safety: parse_execution_retry_safety(&row.get::<String, _>("retry_safety"))?,
        claimed_by: row.get("claimed_by"),
        claim_token: row.get("claim_token"),
        lease_expires_at: row
            .get::<Option<String>, _>("lease_expires_at")
            .as_deref()
            .map(parse_time),
        heartbeat_at: row
            .get::<Option<String>, _>("heartbeat_at")
            .as_deref()
            .map(parse_time),
        approval_ref: row.get("approval_ref"),
        side_effect_started_at: row
            .get::<Option<String>, _>("side_effect_started_at")
            .as_deref()
            .map(parse_time),
        cancel_requested_at: row
            .get::<Option<String>, _>("cancel_requested_at")
            .as_deref()
            .map(parse_time),
        cancel_reason: row.get("cancel_reason"),
        progress_ref: row.get("progress_ref"),
        result_event_id: row.get("result_event_id"),
        result_refs: serde_json::from_str(&row.get::<String, _>("result_refs_json"))?,
        error: row.get("error"),
        exit_code: row.get("exit_code"),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        started_at: row
            .get::<Option<String>, _>("started_at")
            .as_deref()
            .map(parse_time),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
        finished_at: row
            .get::<Option<String>, _>("finished_at")
            .as_deref()
            .map(parse_time),
    })
}

fn execution_target_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<ExecutionTargetRecord, Box<dyn std::error::Error + Send + Sync>> {
    Ok(ExecutionTargetRecord {
        id: row.get("id"),
        revision: sqlite_u64(row, "revision")?,
        owner_principal_id: row.get("owner_principal_id"),
        provider_node_id: row.get("provider_node_id"),
        kind: parse_execution_target_kind(&row.get::<String, _>("kind"))?,
        name: row.get("name"),
        status: parse_execution_target_status(&row.get::<String, _>("status"))?,
        platform: row.get("platform"),
        workspace_root: row.get("workspace_root"),
        capabilities: serde_json::from_str(&row.get::<String, _>("capabilities_json"))?,
        metadata: serde_json::from_str(&row.get::<String, _>("metadata_json"))?,
        policy_digest: row.get("policy_digest"),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
        last_seen_at: row
            .get::<Option<String>, _>("last_seen_at")
            .as_deref()
            .map(parse_time),
    })
}

fn execution_target_authorization_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<ExecutionTargetAuthorizationRecord, Box<dyn std::error::Error + Send + Sync>> {
    Ok(ExecutionTargetAuthorizationRecord {
        id: row.get("id"),
        revision: sqlite_u64(row, "revision")?,
        target_id: row.get("target_id"),
        owner_principal_id: row.get("owner_principal_id"),
        scope: ExecutionTargetAuthorizationScope::parse(&row.get::<String, _>("scope"))
            .ok_or("未知 Execution Target authorization scope")?,
        scope_id: row.get("scope_id"),
        status: ExecutionTargetAuthorizationStatus::parse(&row.get::<String, _>("status"))
            .ok_or("未知 Execution Target authorization status")?,
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
        revoked_at: row
            .get::<Option<String>, _>("revoked_at")
            .as_deref()
            .map(parse_time),
        revoke_reason: row.get("revoke_reason"),
    })
}

fn execution_node_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<ExecutionNodeRecord, Box<dyn std::error::Error + Send + Sync>> {
    Ok(ExecutionNodeRecord {
        id: row.get("id"),
        revision: sqlite_u64(row, "revision")?,
        owner_principal_id: row.get("owner_principal_id"),
        name: row.get("name"),
        status: parse_execution_node_status(&row.get::<String, _>("status"))?,
        device_key_fingerprint: row.get("device_key_fingerprint"),
        device_public_key: row.get("device_public_key"),
        protocol_version: u32::try_from(row.get::<i64, _>("protocol_version"))?,
        platform: row.get("platform"),
        capabilities: serde_json::from_str(&row.get::<String, _>("capabilities_json"))?,
        metadata: serde_json::from_str(&row.get::<String, _>("metadata_json"))?,
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
        last_seen_at: row
            .get::<Option<String>, _>("last_seen_at")
            .as_deref()
            .map(parse_time),
    })
}

fn edge_command_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<EdgeCommandRecord, Box<dyn std::error::Error + Send + Sync>> {
    Ok(EdgeCommandRecord {
        job_id: row.get("job_id"),
        revision: sqlite_u64(row, "revision")?,
        target_id: row.get("target_id"),
        provider_node_id: row.get("provider_node_id"),
        tool_name: row.get("tool_name"),
        arguments: row.get("arguments"),
        route: serde_json::from_str(&row.get::<String, _>("route_json"))?,
        status: parse_edge_command_status(&row.get::<String, _>("status"))?,
        claimed_by: row.get("claimed_by"),
        claim_token: row.get("claim_token"),
        lease_expires_at: row
            .get::<Option<String>, _>("lease_expires_at")
            .as_deref()
            .map(parse_time),
        heartbeat_at: row
            .get::<Option<String>, _>("heartbeat_at")
            .as_deref()
            .map(parse_time),
        side_effect_started_at: row
            .get::<Option<String>, _>("side_effect_started_at")
            .as_deref()
            .map(parse_time),
        progress: row.get("progress"),
        output: row.get("output"),
        error: row.get("error"),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
        finished_at: row
            .get::<Option<String>, _>("finished_at")
            .as_deref()
            .map(parse_time),
    })
}

fn edge_output_chunk_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<EdgeCommandOutputChunk, Box<dyn std::error::Error + Send + Sync>> {
    Ok(EdgeCommandOutputChunk {
        job_id: row.get("job_id"),
        sequence: sqlite_u64(row, "sequence")?,
        stream: EdgeOutputStream::parse(&row.get::<String, _>("stream"))
            .ok_or("unknown Edge output stream")?,
        text: row.get("text"),
        created_at: parse_time(&row.get::<String, _>("created_at")),
    })
}

fn runtime_timer_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<RuntimeTimerRecord, Box<dyn std::error::Error + Send + Sync>> {
    let generation = u64::try_from(row.get::<i64, _>("generation"))
        .map_err(|_| "Runtime Timer generation 不能为负数")?;
    let kind = match row.get::<String, _>("kind").as_str() {
        "schedule" => RuntimeTimerKind::Schedule,
        "objective_wait" => RuntimeTimerKind::ObjectiveWait,
        "objective_lease" => RuntimeTimerKind::ObjectiveLease,
        "background_wake" => RuntimeTimerKind::BackgroundWake,
        "activation_lease" => RuntimeTimerKind::ActivationLease,
        "delivery_flush" => RuntimeTimerKind::DeliveryFlush,
        value => return Err(format!("未知 Runtime Timer kind: {value}").into()),
    };
    let status = match row.get::<String, _>("status").as_str() {
        "pending" => RuntimeTimerStatus::Pending,
        "claimed" => RuntimeTimerStatus::Claimed,
        "fired" => RuntimeTimerStatus::Fired,
        "cancelled" => RuntimeTimerStatus::Cancelled,
        value => return Err(format!("未知 Runtime Timer status: {value}").into()),
    };
    Ok(RuntimeTimerRecord {
        id: row.get("id"),
        generation,
        kind,
        owner_id: row.get("owner_id"),
        due_at: parse_time(&row.get::<String, _>("due_at")),
        status,
        payload: serde_json::from_str(&row.get::<String, _>("payload_json"))?,
        claimed_by: row.get("claimed_by"),
        claim_expires_at: row
            .get::<Option<String>, _>("claim_expires_at")
            .as_deref()
            .map(parse_time),
        last_error: row.get("last_error"),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
        fired_at: row
            .get::<Option<String>, _>("fired_at")
            .as_deref()
            .map(parse_time),
    })
}

async fn project_attention_acknowledgement_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    event: &Event,
    context_id: &str,
    sequence: u64,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if event.topic != "runtime/attention_acknowledged" {
        return Ok(());
    }
    let key = event
        .payload
        .get("key")
        .and_then(JsonValue::as_str)
        .ok_or("attention acknowledgement 缺少 key")?;
    let source_kind = event
        .payload
        .get("source_kind")
        .and_then(JsonValue::as_str)
        .ok_or("attention acknowledgement 缺少 source_kind")?;
    let source_id = event
        .payload
        .get("source_id")
        .and_then(JsonValue::as_str)
        .ok_or("attention acknowledgement 缺少 source_id")?;
    let source_revision = event
        .payload
        .get("source_revision")
        .and_then(JsonValue::as_u64)
        .ok_or("attention acknowledgement 缺少 source_revision")?;
    let acknowledged_by = event
        .payload
        .get("acknowledged_by")
        .and_then(JsonValue::as_str)
        .ok_or("attention acknowledgement 缺少 acknowledged_by")?;
    sqlx::query(
        r#"INSERT INTO attention_acknowledgements
           (context_id, key, event_id, event_sequence, source_kind, source_id,
            source_revision, acknowledged_by, rationale, acknowledged_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(context_id, key) DO UPDATE SET
             event_id = excluded.event_id,
             event_sequence = excluded.event_sequence,
             source_kind = excluded.source_kind,
             source_id = excluded.source_id,
             source_revision = excluded.source_revision,
             acknowledged_by = excluded.acknowledged_by,
             rationale = excluded.rationale,
             acknowledged_at = excluded.acknowledged_at
           WHERE excluded.event_sequence > attention_acknowledgements.event_sequence"#,
    )
    .bind(context_id)
    .bind(key)
    .bind(&event.id)
    .bind(i64::try_from(sequence)?)
    .bind(source_kind)
    .bind(source_id)
    .bind(i64::try_from(source_revision)?)
    .bind(acknowledged_by)
    .bind(event.payload.get("rationale").and_then(JsonValue::as_str))
    .bind(
        event
            .timestamp
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
    )
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn enqueue_recall_document_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    document: &RecallDocument,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    let document = crate::memory::bound_recall_document(document.clone());
    sqlx::query(
        r#"INSERT INTO recall_projection_outbox
           (context_id, document_kind, document_id, generation, document_json,
            status, attempts, available_at, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, 'pending', 0, ?, ?, ?)
           ON CONFLICT(context_id, document_kind, document_id) DO UPDATE SET
             generation = recall_projection_outbox.generation + 1,
             document_json = excluded.document_json,
             status = 'pending', attempts = 0,
             available_at = excluded.available_at,
             claimed_by = NULL, claim_expires_at = NULL, last_error = NULL,
             updated_at = excluded.updated_at"#,
    )
    .bind(&document.context_id)
    .bind(document.document_kind.as_str())
    .bind(&document.document_id)
    .bind(serde_json::to_string(&document)?)
    .bind(&now)
    .bind(&now)
    .bind(&now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn enqueue_event_recall_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    event: &Event,
    context_id: &str,
    retired: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if !crate::memory::event_has_recall_value(event) {
        return Ok(());
    }
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    sqlx::query(
        r#"INSERT INTO recall_projection_outbox
           (context_id, document_kind, document_id, generation, document_json,
            status, attempts, available_at, created_at, updated_at)
           VALUES (?, 'event', ?, 1, ?, 'pending', 0, ?, ?, ?)
           ON CONFLICT(context_id, document_kind, document_id) DO UPDATE SET
             generation = recall_projection_outbox.generation + 1,
             document_json = excluded.document_json,
             status = 'pending', attempts = 0,
             available_at = excluded.available_at,
             claimed_by = NULL, claim_expires_at = NULL, last_error = NULL,
             updated_at = excluded.updated_at"#,
    )
    .bind(context_id)
    .bind(&event.id)
    .bind(serde_json::json!({ "retired": retired }).to_string())
    .bind(&now)
    .bind(&now)
    .bind(&now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn append_event_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    event: &Event,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let payload = serde_json::to_string(&event.payload)?;
    let timestamp = event
        .timestamp
        .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    let session_id = event.payload.get("session_id").and_then(JsonValue::as_str);
    let context_id = event
        .payload
        .get("context_id")
        .and_then(JsonValue::as_str)
        .or(session_id);
    let thread_id = causal_payload_string(event, "thread_id");
    let activation_id = causal_payload_string(event, "activation_id");
    let root_turn_id = causal_payload_string(event, "root_turn_id");
    let objective_id = causal_payload_string(event, "objective_id");
    sqlx::query(
        "INSERT INTO events \
         (id, timestamp, actor, type, topic, context_id, session_id, thread_id, activation_id, root_turn_id, objective_id, payload) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&event.id)
    .bind(timestamp)
    .bind(&event.actor)
    .bind(&event.event_type)
    .bind(&event.topic)
    .bind(context_id)
    .bind(session_id)
    .bind(thread_id)
    .bind(activation_id)
    .bind(root_turn_id)
    .bind(objective_id)
    .bind(payload)
    .execute(&mut **tx)
    .await?;
    if let Some(context_id) = context_id {
        let sequence = u64::try_from(
            sqlx::query_scalar::<_, i64>("SELECT rowid FROM events WHERE id = ?")
                .bind(&event.id)
                .fetch_one(&mut **tx)
                .await?,
        )
        .map_err(|_| "Event sequence 不能为负数")?;
        project_attention_acknowledgement_in_transaction(tx, event, context_id, sequence).await?;
        enqueue_event_recall_in_transaction(tx, event, context_id, false).await?;
    }
    project_observation_in_transaction(tx, event).await?;
    Ok(())
}

async fn upsert_recall_document_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    document: &RecallDocument,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let started = std::time::Instant::now();
    sqlx::query(
        r#"INSERT INTO recall_documents
           (context_id, document_kind, document_id, revision, searchable_text, preview,
            retired, updated_sequence, state_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(context_id, document_kind, document_id) DO UPDATE SET
             revision = excluded.revision,
             searchable_text = excluded.searchable_text,
             preview = excluded.preview,
             retired = excluded.retired,
             updated_sequence = excluded.updated_sequence,
             state_hash = excluded.state_hash
           WHERE excluded.updated_sequence >= recall_documents.updated_sequence"#,
    )
    .bind(&document.context_id)
    .bind(document.document_kind.as_str())
    .bind(&document.document_id)
    .bind(i64::try_from(document.revision)?)
    .bind(&document.searchable_text)
    .bind(&document.preview)
    .bind(i64::from(document.retired))
    .bind(i64::try_from(document.updated_sequence)?)
    .bind(&document.state_hash)
    .execute(&mut **tx)
    .await?;
    let elapsed = started.elapsed();
    if elapsed >= std::time::Duration::from_millis(500) {
        tracing::warn!(
            context_id = %document.context_id,
            document_kind = %document.document_kind.as_str(),
            document_id = %document.document_id,
            searchable_chars = document.searchable_text.chars().count(),
            elapsed_ms = elapsed.as_millis(),
            "Recall document UPSERT（含同步 FTS trigger）耗时过长"
        );
    } else {
        tracing::debug!(
            context_id = %document.context_id,
            document_kind = %document.document_kind.as_str(),
            document_id = %document.document_id,
            searchable_chars = document.searchable_text.chars().count(),
            elapsed_ms = elapsed.as_millis(),
            "Recall document UPSERT 完成"
        );
    }
    Ok(())
}

fn mind_projection_from_row(
    row: &SqliteRow,
) -> Result<MindProjectionRecord, Box<dyn std::error::Error + Send + Sync>> {
    let revision = u64::try_from(row.get::<i64, _>("revision"))
        .map_err(|_| "Mind Projection revision 不能为负数")?;
    Ok(MindProjectionRecord {
        context_id: row.get("context_id"),
        revision,
        state: serde_json::from_str(&row.get::<String, _>("state_json"))?,
        state_hash: row.get("state_hash"),
        head_event_id: row.get("head_event_id"),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
    })
}

fn mind_snapshot_from_row(
    row: &SqliteRow,
) -> Result<MindSnapshotRecord, Box<dyn std::error::Error + Send + Sync>> {
    Ok(MindSnapshotRecord {
        id: row.get("id"),
        context_id: row.get("context_id"),
        revision: u64::try_from(row.get::<i64, _>("revision"))
            .map_err(|_| "Mind Snapshot revision 不能为负数")?,
        state: serde_json::from_str(&row.get::<String, _>("state_json"))?,
        state_hash: row.get("state_hash"),
        head_event_id: row.get("head_event_id"),
        created_at: parse_time(&row.get::<String, _>("created_at")),
    })
}

async fn get_mind_projection_from_executor<'e, E>(
    executor: E,
    context_id: &str,
) -> Result<Option<MindProjectionRecord>, Box<dyn std::error::Error + Send + Sync>>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let row = sqlx::query(
        r#"SELECT p.context_id, p.revision, p.state_json, p.state_hash,
                  h.head_event_id, p.updated_at
           FROM mind_projections p
           JOIN context_heads h ON h.context_id = p.context_id
           WHERE p.context_id = ?
             AND h.revision = p.revision
             AND h.projection_hash = p.state_hash"#,
    )
    .bind(context_id)
    .fetch_optional(executor)
    .await?;
    row.as_ref().map(mind_projection_from_row).transpose()
}

/// Read the Projection pair and its consistency markers from one SQLite
/// statement. Performing a valid JOIN first and separate existence probes
/// afterwards creates a TOCTOU window: another Runtime may atomically install
/// the pair between those statements, making a healthy Projection look
/// one-sided. One statement observes one WAL snapshot and can distinguish the
/// three real states without that false corruption report.
async fn get_mind_projection_consistent(
    pool: &SqlitePool,
    context_id: &str,
) -> Result<Option<MindProjectionRecord>, Box<dyn std::error::Error + Send + Sync>> {
    let row = sqlx::query(
        r#"SELECT h.context_id AS head_context_id,
                  h.revision AS head_revision,
                  h.projection_hash AS head_projection_hash,
                  p.context_id AS projection_context_id,
                  p.context_id, p.revision, p.state_json, p.state_hash,
                  h.head_event_id, p.updated_at
           FROM (SELECT 1) anchor
           LEFT JOIN context_heads h ON h.context_id = ?
           LEFT JOIN mind_projections p ON p.context_id = ?"#,
    )
    .bind(context_id)
    .bind(context_id)
    .fetch_one(pool)
    .await?;
    let head_context_id = row.get::<Option<String>, _>("head_context_id");
    let projection_context_id = row.get::<Option<String>, _>("projection_context_id");
    match (head_context_id, projection_context_id) {
        (None, None) => Ok(None),
        (Some(_), Some(_)) => {
            let head_revision = row
                .get::<Option<i64>, _>("head_revision")
                .ok_or("Context Head 缺少 revision")?;
            let projection_revision = row
                .get::<Option<i64>, _>("revision")
                .ok_or("Mind Projection 缺少 revision")?;
            let head_hash = row
                .get::<Option<String>, _>("head_projection_hash")
                .ok_or("Context Head 缺少 projection_hash")?;
            let projection_hash = row
                .get::<Option<String>, _>("state_hash")
                .ok_or("Mind Projection 缺少 state_hash")?;
            if head_revision != projection_revision || head_hash != projection_hash {
                return Err(format!(
                    "Context '{context_id}' 的 Mind Projection head/hash/revision 不一致"
                )
                .into());
            }
            mind_projection_from_row(&row).map(Some)
        }
        _ => Err(format!("Context '{context_id}' 的 Mind Projection 不完整").into()),
    }
}

async fn update_attention_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    update: &SessionAttentionUpdate,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let expected_revision = i64::try_from(update.expected_revision)
        .map_err(|_| "Session attention revision 超出 SQLite INTEGER 范围")?;
    let changed_at = update
        .changed_at
        .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    let result = sqlx::query(
        r#"UPDATE session_mounts
           SET attention_state = ?, attention_revision = attention_revision + 1,
               attention_reason = ?, attention_changed_at = ?, attention_event_id = ?
           WHERE session_id = ? AND context_id = ? AND unmounted_at IS NULL
             AND attention_revision = ?"#,
    )
    .bind(update.state.as_str())
    .bind(&update.reason)
    .bind(changed_at)
    .bind(&update.event_id)
    .bind(&update.session_id)
    .bind(&update.context_id)
    .bind(expected_revision)
    .execute(&mut **tx)
    .await?;
    if result.rows_affected() != 1 {
        return Err(format!(
            "Session '{}' attention revision 冲突或 Context mount 不存在",
            update.session_id
        )
        .into());
    }
    Ok(())
}

fn context_transaction_requires_snapshot(event: &Event, revision: u64) -> bool {
    revision.is_multiple_of(64)
        || event
            .payload
            .get("changes")
            .and_then(JsonValue::as_array)
            .is_some_and(|changes| {
                changes.iter().any(|change| {
                    matches!(
                        change.get("operation").and_then(JsonValue::as_str),
                        Some("checkpoint" | "rollback")
                    )
                })
            })
}

async fn insert_mind_snapshot_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    context_id: &str,
    revision: u64,
    state_json: &str,
    state_hash: &str,
    head_event_id: &str,
    created_at: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let revision_sql =
        i64::try_from(revision).map_err(|_| "Mind Snapshot revision 超出 SQLite INTEGER 范围")?;
    sqlx::query(
        r#"INSERT INTO mind_snapshots
           (id, context_id, revision, state_json, state_hash, head_event_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(context_id, revision) DO UPDATE SET
             id = excluded.id,
             state_json = excluded.state_json,
             state_hash = excluded.state_hash,
             head_event_id = excluded.head_event_id,
             created_at = excluded.created_at"#,
    )
    .bind(format!("mind_snapshot_{context_id}_{revision}"))
    .bind(context_id)
    .bind(revision_sql)
    .bind(state_json)
    .bind(state_hash)
    .bind(head_event_id)
    .bind(created_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn append_event_idempotent_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    event: &Event,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    let payload = serde_json::to_string(&event.payload)?;
    let timestamp = event
        .timestamp
        .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    let session_id = event.payload.get("session_id").and_then(JsonValue::as_str);
    let context_id = event
        .payload
        .get("context_id")
        .and_then(JsonValue::as_str)
        .or(session_id);
    let thread_id = causal_payload_string(event, "thread_id");
    let activation_id = causal_payload_string(event, "activation_id");
    let root_turn_id = causal_payload_string(event, "root_turn_id");
    let objective_id = causal_payload_string(event, "objective_id");
    let inserted = sqlx::query(
        "INSERT OR IGNORE INTO events \
         (id, timestamp, actor, type, topic, context_id, session_id, thread_id, activation_id, root_turn_id, objective_id, payload) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&event.id)
    .bind(&timestamp)
    .bind(&event.actor)
    .bind(&event.event_type)
    .bind(&event.topic)
    .bind(context_id)
    .bind(session_id)
    .bind(thread_id)
    .bind(activation_id)
    .bind(root_turn_id)
    .bind(objective_id)
    .bind(&payload)
    .execute(&mut **tx)
    .await?;
    if inserted.rows_affected() == 1 {
        if let Some(context_id) = context_id {
            let sequence = u64::try_from(
                sqlx::query_scalar::<_, i64>("SELECT rowid FROM events WHERE id = ?")
                    .bind(&event.id)
                    .fetch_one(&mut **tx)
                    .await?,
            )
            .map_err(|_| "Event sequence 不能为负数")?;
            project_attention_acknowledgement_in_transaction(tx, event, context_id, sequence)
                .await?;
            enqueue_event_recall_in_transaction(tx, event, context_id, false).await?;
        }
        project_observation_in_transaction(tx, event).await?;
        return Ok(true);
    }
    let existing = sqlx::query(
        "SELECT timestamp, actor, type, topic, context_id, session_id, payload FROM events WHERE id = ?",
    )
    .bind(&event.id)
    .fetch_one(&mut **tx)
    .await?;
    let same = existing.get::<String, _>("timestamp") == timestamp
        && existing.get::<String, _>("actor") == event.actor
        && existing.get::<String, _>("type") == event.event_type
        && existing.get::<String, _>("topic") == event.topic
        && existing.get::<Option<String>, _>("context_id").as_deref() == context_id
        && existing.get::<Option<String>, _>("session_id").as_deref() == session_id
        && existing.get::<String, _>("payload") == payload;
    if !same {
        return Err(format!("Event ID '{}' 已被不同内容占用", event.id).into());
    }
    // Idempotent replay must not re-enqueue an already projected Event.
    Ok(false)
}

fn event_has_projection_route(event: &Event) -> bool {
    event
        .payload
        .get("context_id")
        .and_then(JsonValue::as_str)
        .is_some()
        && (event
            .payload
            .get("session_id")
            .and_then(JsonValue::as_str)
            .is_some()
            || (event.topic == "chat/context_observation"
                && event
                    .payload
                    .get("context_wide")
                    .and_then(JsonValue::as_bool)
                    == Some(true)))
}

async fn project_observation_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    event: &Event,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if !crate::event::is_context_observation(event) || !event_has_projection_route(event) {
        return Ok(());
    }
    let context_id = event
        .payload
        .get("context_id")
        .and_then(JsonValue::as_str)
        .expect("event_has_projection_route 已验证 context_id");
    let session_id = event.payload.get("session_id").and_then(JsonValue::as_str);
    sqlx::query(
        r#"INSERT OR IGNORE INTO session_projections (event_id, context_id, session_id)
           VALUES (?, ?, ?)"#,
    )
    .bind(&event.id)
    .bind(context_id)
    .bind(session_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn stored_event_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    event_id: &str,
    context_id: &str,
) -> Result<Option<Event>, Box<dyn std::error::Error + Send + Sync>> {
    let row = sqlx::query(
        r#"SELECT rowid AS event_sequence, id, timestamp, actor, type, topic, payload
           FROM events WHERE id = ? AND context_id = ?"#,
    )
    .bind(event_id)
    .bind(context_id)
    .fetch_optional(&mut **tx)
    .await?;
    row.map(|row| {
        let payload = serde_json::from_str(&row.get::<String, _>("payload"))?;
        Ok(Event {
            id: row.get("id"),
            sequence: u64::try_from(row.get::<i64, _>("event_sequence")).ok(),
            timestamp: parse_time(&row.get::<String, _>("timestamp")),
            actor: row.get("actor"),
            event_type: row.get("type"),
            topic: row.get("topic"),
            payload,
        })
    })
    .transpose()
}

async fn mutate_session_projection_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    context_id: &str,
    mutation: &SessionProjectionMutation,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    for event_id in &mutation.retired_event_ids {
        sqlx::query("DELETE FROM session_projections WHERE event_id = ? AND context_id = ?")
            .bind(event_id)
            .bind(context_id)
            .execute(&mut **tx)
            .await?;
        if let Some(event) = stored_event_in_transaction(tx, event_id, context_id).await? {
            enqueue_event_recall_in_transaction(tx, &event, context_id, true).await?;
        }
    }
    for event_id in &mutation.restored_event_ids {
        if let Some(event) = stored_event_in_transaction(tx, event_id, context_id).await? {
            project_observation_in_transaction(tx, &event).await?;
            enqueue_event_recall_in_transaction(tx, &event, context_id, false).await?;
        }
    }
    Ok(())
}

async fn append_signal_outbox_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    event: &Event,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if event
        .payload
        .get("session_id")
        .and_then(JsonValue::as_str)
        .is_none()
        || event
            .payload
            .get("context_id")
            .and_then(JsonValue::as_str)
            .is_none()
    {
        return Err(format!(
            "Signal Outbox Event '{}' 缺少 context_id/session_id 路由",
            event.id
        )
        .into());
    }
    let created_at = event
        .timestamp
        .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    sqlx::query(
        "INSERT OR IGNORE INTO signal_outbox (event_id, status, created_at) VALUES (?, 'pending', ?)",
    )
    .bind(&event.id)
    .bind(created_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[async_trait::async_trait]
impl MindProjectionStore for SqliteStore {
    async fn get_mind_projection(
        &self,
        context_id: &str,
    ) -> Result<Option<MindProjectionRecord>, Box<dyn std::error::Error + Send + Sync>> {
        get_mind_projection_consistent(&self.pool, context_id).await
    }

    async fn get_latest_mind_snapshot(
        &self,
        context_id: &str,
    ) -> Result<Option<MindSnapshotRecord>, Box<dyn std::error::Error + Send + Sync>> {
        sqlx::query(
            r#"SELECT id, context_id, revision, state_json, state_hash,
                      head_event_id, created_at
               FROM mind_snapshots
               WHERE context_id = ?
               ORDER BY revision DESC
               LIMIT 1"#,
        )
        .bind(context_id)
        .fetch_optional(&self.pool)
        .await?
        .as_ref()
        .map(mind_snapshot_from_row)
        .transpose()
    }

    async fn initialize_mind_projection(
        &self,
        projection: NewMindProjection,
    ) -> Result<MindProjectionRecord, Box<dyn std::error::Error + Send + Sync>> {
        let revision = i64::try_from(projection.revision)
            .map_err(|_| "Mind Projection revision 超出 SQLite INTEGER 范围")?;
        let state_json = serde_json::to_string(&projection.state)?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;

        // Acquire SQLite's single-writer slot before checking for a lazily
        // initialized row, so concurrent Runtime instances converge cleanly.
        let context =
            sqlx::query("UPDATE cognitive_contexts SET updated_at = updated_at WHERE id = ?")
                .bind(&projection.context_id)
                .execute(&mut *tx)
                .await?;
        if context.rows_affected() != 1 {
            return Err(format!("Context '{}' 不存在", projection.context_id).into());
        }

        let head_count =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM context_heads WHERE context_id = ?")
                .bind(&projection.context_id)
                .fetch_one(&mut *tx)
                .await?;
        let projection_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM mind_projections WHERE context_id = ?",
        )
        .bind(&projection.context_id)
        .fetch_one(&mut *tx)
        .await?;
        if head_count != projection_count {
            return Err(format!(
                "Context '{}' 的 Mind Projection 仅存在部分记录，拒绝自动修补",
                projection.context_id
            )
            .into());
        }
        if head_count == 0 {
            sqlx::query(
                r#"INSERT INTO context_heads
                   (context_id, revision, projection_hash, head_event_id, updated_at)
                   VALUES (?, ?, ?, ?, ?)"#,
            )
            .bind(&projection.context_id)
            .bind(revision)
            .bind(&projection.state_hash)
            .bind(&projection.head_event_id)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                r#"INSERT INTO mind_projections
                   (context_id, revision, state_json, state_hash, updated_at)
                   VALUES (?, ?, ?, ?, ?)"#,
            )
            .bind(&projection.context_id)
            .bind(revision)
            .bind(state_json)
            .bind(&projection.state_hash)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            for document in &projection.recall_documents {
                enqueue_recall_document_in_transaction(&mut tx, document).await?;
            }
        }
        let installed = get_mind_projection_from_executor(&mut *tx, &projection.context_id)
            .await?
            .ok_or_else(|| {
                format!(
                    "Context '{}' 的 Mind Projection head/hash/revision 不一致",
                    projection.context_id
                )
            })?;
        tx.commit().await?;
        Ok(installed)
    }

    async fn commit_mind_projection_transaction(
        &self,
        event: &Event,
        attention_updates: &[SessionAttentionUpdate],
        session_projection: &SessionProjectionMutation,
        expected_revision: u64,
        next_projection: NewMindProjection,
    ) -> Result<MindProjectionCommit, Box<dyn std::error::Error + Send + Sync>> {
        if next_projection.head_event_id.as_deref() != Some(event.id.as_str()) {
            return Err(
                "Mind Projection head_event_id 必须指向本次 Context transaction Event".into(),
            );
        }
        if next_projection.revision != expected_revision.saturating_add(1) {
            return Err("Mind Projection 下一 revision 必须等于 expected_revision + 1".into());
        }
        if event.payload.get("context_id").and_then(JsonValue::as_str)
            != Some(next_projection.context_id.as_str())
        {
            return Err("Context transaction Event 与 Mind Projection 的 context_id 不一致".into());
        }
        let expected = i64::try_from(expected_revision)
            .map_err(|_| "Context expected revision 超出 SQLite INTEGER 范围")?;
        let next = i64::try_from(next_projection.revision)
            .map_err(|_| "Mind Projection revision 超出 SQLite INTEGER 范围")?;
        let state_json = serde_json::to_string(&next_projection.state)?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;

        let head = sqlx::query(
            r#"UPDATE context_heads
               SET revision = ?, projection_hash = ?, updated_at = ?
               WHERE context_id = ? AND revision = ?"#,
        )
        .bind(next)
        .bind(&next_projection.state_hash)
        .bind(&now)
        .bind(&next_projection.context_id)
        .bind(expected)
        .execute(&mut *tx)
        .await?;
        if head.rows_affected() != 1 {
            tx.rollback().await?;
            let current_revision = sqlx::query_scalar::<_, i64>(
                "SELECT revision FROM context_heads WHERE context_id = ?",
            )
            .bind(&next_projection.context_id)
            .fetch_optional(&self.pool)
            .await?
            .map(u64::try_from)
            .transpose()
            .map_err(|_| "Context head revision 不能为负数")?;
            return Ok(MindProjectionCommit::Conflict { current_revision });
        }

        let materialized = sqlx::query(
            r#"UPDATE mind_projections
               SET revision = ?, state_json = ?, state_hash = ?, updated_at = ?
               WHERE context_id = ? AND revision = ?"#,
        )
        .bind(next)
        .bind(&state_json)
        .bind(&next_projection.state_hash)
        .bind(&now)
        .bind(&next_projection.context_id)
        .bind(expected)
        .execute(&mut *tx)
        .await?;
        if materialized.rows_affected() != 1 {
            return Err(format!(
                "Context '{}' 的 Mind Projection revision 与 head 不一致",
                next_projection.context_id
            )
            .into());
        }
        for update in attention_updates {
            update_attention_in_transaction(&mut tx, update).await?;
        }
        append_event_in_transaction(&mut tx, event).await?;
        mutate_session_projection_in_transaction(
            &mut tx,
            &next_projection.context_id,
            session_projection,
        )
        .await?;
        for document in &next_projection.recall_documents {
            enqueue_recall_document_in_transaction(&mut tx, document).await?;
        }
        if context_transaction_requires_snapshot(event, next_projection.revision) {
            insert_mind_snapshot_in_transaction(
                &mut tx,
                &next_projection.context_id,
                next_projection.revision,
                &state_json,
                &next_projection.state_hash,
                &event.id,
                &now,
            )
            .await?;
        }
        sqlx::query(
            "UPDATE context_heads SET head_event_id = ? WHERE context_id = ? AND revision = ?",
        )
        .bind(&event.id)
        .bind(&next_projection.context_id)
        .bind(next)
        .execute(&mut *tx)
        .await?;

        let committed = get_mind_projection_from_executor(&mut *tx, &next_projection.context_id)
            .await?
            .ok_or("提交后 Mind Projection 不完整")?;
        tx.commit().await?;
        Ok(MindProjectionCommit::Committed {
            projection: committed,
        })
    }

    async fn commit_mind_seed_projection(
        &self,
        event: &Event,
        source_context_id: &str,
        source_version: u64,
        snapshot_hash: &str,
        projection_kind: &str,
        next_projection: NewMindProjection,
    ) -> Result<MindProjectionCommit, Box<dyn std::error::Error + Send + Sync>> {
        if next_projection.revision != 0 {
            return Err("Seed Mind Projection revision 必须为 0".into());
        }
        if next_projection.head_event_id.as_deref() != Some(event.id.as_str()) {
            return Err("Seed Mind Projection head_event_id 必须指向本次 seed Event".into());
        }
        if event.payload.get("context_id").and_then(JsonValue::as_str)
            != Some(next_projection.context_id.as_str())
        {
            return Err("Seed Event 与 Mind Projection 的 context_id 不一致".into());
        }
        let source_version = i64::try_from(source_version)
            .map_err(|_| "Seed source version 超出 SQLite INTEGER 范围")?;
        let state_json = serde_json::to_string(&next_projection.state)?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;

        let head = sqlx::query(
            r#"UPDATE context_heads
               SET projection_hash = ?, updated_at = ?
               WHERE context_id = ? AND revision = 0 AND head_event_id IS NULL"#,
        )
        .bind(&next_projection.state_hash)
        .bind(&now)
        .bind(&next_projection.context_id)
        .execute(&mut *tx)
        .await?;
        if head.rows_affected() != 1 {
            tx.rollback().await?;
            let current_revision = sqlx::query_scalar::<_, i64>(
                "SELECT revision FROM context_heads WHERE context_id = ?",
            )
            .bind(&next_projection.context_id)
            .fetch_optional(&self.pool)
            .await?
            .map(u64::try_from)
            .transpose()
            .map_err(|_| "Context head revision 不能为负数")?;
            return Ok(MindProjectionCommit::Conflict { current_revision });
        }
        let materialized = sqlx::query(
            r#"UPDATE mind_projections
               SET state_json = ?, state_hash = ?, updated_at = ?
               WHERE context_id = ? AND revision = 0"#,
        )
        .bind(&state_json)
        .bind(&next_projection.state_hash)
        .bind(&now)
        .bind(&next_projection.context_id)
        .execute(&mut *tx)
        .await?;
        if materialized.rows_affected() != 1 {
            return Err("Seed Mind Projection 与 Context head 不一致".into());
        }
        let context = sqlx::query(
            r#"UPDATE cognitive_contexts
               SET seed_context_id = ?, seed_context_version = ?, seed_snapshot_hash = ?,
                   seed_projection = ?, updated_at = ?
               WHERE id = ? AND seed_context_id IS NULL"#,
        )
        .bind(source_context_id)
        .bind(source_version)
        .bind(snapshot_hash)
        .bind(projection_kind)
        .bind(&now)
        .bind(&next_projection.context_id)
        .execute(&mut *tx)
        .await?;
        if context.rows_affected() != 1 {
            return Err("目标 Context 已存在 seed provenance，拒绝覆盖".into());
        }
        append_event_in_transaction(&mut tx, event).await?;
        for document in &next_projection.recall_documents {
            enqueue_recall_document_in_transaction(&mut tx, document).await?;
        }
        insert_mind_snapshot_in_transaction(
            &mut tx,
            &next_projection.context_id,
            0,
            &state_json,
            &next_projection.state_hash,
            &event.id,
            &now,
        )
        .await?;
        sqlx::query(
            "UPDATE context_heads SET head_event_id = ? WHERE context_id = ? AND revision = 0",
        )
        .bind(&event.id)
        .bind(&next_projection.context_id)
        .execute(&mut *tx)
        .await?;
        let committed = get_mind_projection_from_executor(&mut *tx, &next_projection.context_id)
            .await?
            .ok_or("Seed 提交后 Mind Projection 不完整")?;
        tx.commit().await?;
        Ok(MindProjectionCommit::Committed {
            projection: committed,
        })
    }
}

#[async_trait::async_trait]
impl SessionDirectoryStore for SqliteStore {
    async fn ensure_principal(
        &self,
        principal: NewPrincipal,
    ) -> Result<PrincipalRecord, Box<dyn std::error::Error + Send + Sync>> {
        if principal.id.trim().is_empty()
            || principal.provider_id.trim().is_empty()
            || principal.assurance.trim().is_empty()
        {
            return Err("Principal id/provider_id/assurance 不能为空".into());
        }
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            r#"INSERT INTO principals
               (id, provider_id, assurance, display_name, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 assurance = excluded.assurance,
                 display_name = COALESCE(excluded.display_name, principals.display_name),
                 updated_at = excluded.updated_at
               WHERE principals.provider_id = excluded.provider_id"#,
        )
        .bind(&principal.id)
        .bind(&principal.provider_id)
        .bind(&principal.assurance)
        .bind(&principal.display_name)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        let existing = self
            .get_principal(&principal.id)
            .await?
            .ok_or("Principal ensure 后无法读取")?;
        if existing.provider_id != principal.provider_id {
            return Err(format!(
                "Principal '{}' 已由 Provider '{}' 管理，不能改由 '{}' 接管",
                principal.id, existing.provider_id, principal.provider_id
            )
            .into());
        }
        Ok(existing)
    }

    async fn get_principal(
        &self,
        id: &str,
    ) -> Result<Option<PrincipalRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let row = sqlx::query(
            "SELECT id, provider_id, assurance, display_name, created_at, updated_at FROM principals WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(principal_from_row))
    }

    async fn bind_session_principal(
        &self,
        session_id: &str,
        principal_id: &str,
    ) -> Result<SessionPrincipalBinding, Box<dyn std::error::Error + Send + Sync>> {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            r#"INSERT INTO session_principal_bindings
               (session_id, principal_id, bound_at, unbound_at)
               VALUES (?, ?, ?, NULL)
               ON CONFLICT(session_id, principal_id) DO UPDATE SET unbound_at = NULL"#,
        )
        .bind(session_id)
        .bind(principal_id)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        let row = sqlx::query(
            "SELECT session_id, principal_id, bound_at, unbound_at FROM session_principal_bindings WHERE session_id = ? AND principal_id = ?",
        )
        .bind(session_id)
        .bind(principal_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(session_principal_binding_from_row(&row))
    }

    async fn bind_all_sessions_to_principal(
        &self,
        principal_id: &str,
        include_archived: bool,
    ) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"INSERT INTO session_principal_bindings
               (session_id, principal_id, bound_at, unbound_at)
               SELECT id, ?, ?, NULL FROM sessions
               WHERE (? OR status != 'archived')
               ON CONFLICT(session_id, principal_id) DO UPDATE SET unbound_at = NULL
               WHERE session_principal_bindings.unbound_at IS NOT NULL"#,
        )
        .bind(principal_id)
        .bind(&now)
        .bind(include_archived)
        .execute(&self.pool)
        .await?;
        usize::try_from(result.rows_affected())
            .map_err(|_| "Session Principal 批量绑定数超出 usize".into())
    }

    async fn list_session_principals(
        &self,
        session_id: &str,
    ) -> Result<Vec<SessionPrincipalBinding>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = sqlx::query(
            "SELECT session_id, principal_id, bound_at, unbound_at FROM session_principal_bindings WHERE session_id = ? AND unbound_at IS NULL ORDER BY principal_id",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .iter()
            .map(session_principal_binding_from_row)
            .collect())
    }

    async fn list_principal_sessions(
        &self,
        principal_id: &str,
        include_archived: bool,
    ) -> Result<Vec<SessionRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = sqlx::query(
            r#"SELECT s.id, s.agent_id, s.context_id, s.parent_session_id, s.title,
                      s.status, s.created_at, s.updated_at, s.last_activity_at,
                      sm.attention_state, sm.attention_revision, sm.attention_reason,
                      sm.attention_changed_at, sm.attention_event_id
               FROM sessions s
               JOIN session_principal_bindings b ON b.session_id = s.id
               JOIN session_mounts sm ON sm.session_id = s.id AND sm.unmounted_at IS NULL
               WHERE b.principal_id = ? AND b.unbound_at IS NULL
                 AND (? OR s.status != 'archived')
               ORDER BY s.last_activity_at DESC, s.id"#,
        )
        .bind(principal_id)
        .bind(include_archived)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(session_from_row).collect())
    }

    async fn list_context_principal_bindings(
        &self,
        context_id: &str,
    ) -> Result<Vec<SessionPrincipalBinding>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = sqlx::query(
            r#"SELECT b.session_id, b.principal_id, b.bound_at, b.unbound_at
               FROM session_principal_bindings b
               JOIN sessions s ON s.id = b.session_id
               WHERE s.context_id = ? AND b.unbound_at IS NULL
               ORDER BY b.session_id, b.principal_id"#,
        )
        .bind(context_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .iter()
            .map(session_principal_binding_from_row)
            .collect())
    }

    async fn verify_session_principal(
        &self,
        session_id: &str,
        principal_id: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let exists = sqlx::query_scalar::<_, i64>(
            "SELECT EXISTS(SELECT 1 FROM session_principal_bindings WHERE session_id = ? AND principal_id = ? AND unbound_at IS NULL)",
        )
        .bind(session_id)
        .bind(principal_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(exists != 0)
    }

    async fn create_agent_bundle(
        &self,
        agent: NewAgent,
        root_context: NewCognitiveContext,
        initial_session: NewSession,
    ) -> Result<AgentBootstrapRecord, Box<dyn std::error::Error + Send + Sync>> {
        if agent.id != root_context.agent_id
            || agent.id != initial_session.agent_id
            || agent.root_context_id != root_context.id
            || root_context.id != initial_session.context_id
            || initial_session.parent_session_id.is_some()
            || initial_session.mount_kind != SessionMountKind::NewBlankContext
        {
            return Err("Agent Bootstrap 的 Agent/Root Context/Initial Session 路由不一致".into());
        }
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO agents (id, title, status, root_context_id, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)",
        )
        .bind(&agent.id)
        .bind(&agent.title)
        .bind(&agent.root_context_id)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO cognitive_contexts (id, agent_id, title, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
        )
        .bind(&root_context.id)
        .bind(&root_context.agent_id)
        .bind(&root_context.title)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"INSERT INTO sessions
               (id, agent_id, context_id, parent_session_id, title, status, created_at, updated_at, last_activity_at)
               VALUES (?, ?, ?, NULL, ?, 'active', ?, ?, ?)"#,
        )
        .bind(&initial_session.id)
        .bind(&initial_session.agent_id)
        .bind(&initial_session.context_id)
        .bind(&initial_session.title)
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO session_mounts (session_id, generation, context_id, mount_kind, mounted_at, unmounted_at) VALUES (?, 1, ?, 'new_blank_context', ?, NULL)",
        )
        .bind(&initial_session.id)
        .bind(&initial_session.context_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(AgentBootstrapRecord {
            agent: self
                .get_agent(&agent.id)
                .await?
                .ok_or("Agent Bootstrap 提交后无法读取 Agent")?,
            root_context: self
                .get_context(&root_context.id)
                .await?
                .ok_or("Agent Bootstrap 提交后无法读取 Root Context")?,
            initial_session: self
                .get_session(&initial_session.id)
                .await?
                .ok_or("Agent Bootstrap 提交后无法读取 Initial Session")?,
        })
    }

    async fn create_agent(
        &self,
        agent: NewAgent,
    ) -> Result<AgentRecord, Box<dyn std::error::Error + Send + Sync>> {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            "INSERT INTO agents (id, title, status, root_context_id, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)",
        )
        .bind(&agent.id)
        .bind(&agent.title)
        .bind(&agent.root_context_id)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        self.get_agent(&agent.id)
            .await?
            .ok_or_else(|| "Agent 创建后无法读取".into())
    }

    async fn ensure_agent(
        &self,
        agent: NewAgent,
    ) -> Result<AgentRecord, Box<dyn std::error::Error + Send + Sync>> {
        if let Some(existing) = self.get_agent(&agent.id).await? {
            if existing.root_context_id != agent.root_context_id {
                return Err(format!(
                    "Agent '{}' 的 Root Context 已是 '{}'，不能改为 '{}'",
                    agent.id, existing.root_context_id, agent.root_context_id
                )
                .into());
            }
            return Ok(existing);
        }
        match self.create_agent(agent.clone()).await {
            Ok(created) => Ok(created),
            Err(_) => self
                .get_agent(&agent.id)
                .await?
                .ok_or_else(|| "并发创建 Agent 失败".into()),
        }
    }

    async fn get_agent(
        &self,
        id: &str,
    ) -> Result<Option<AgentRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let row = sqlx::query(
            "SELECT id, title, status, root_context_id, created_at, updated_at FROM agents WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(agent_from_row))
    }

    async fn list_agents(
        &self,
        include_archived: bool,
    ) -> Result<Vec<AgentRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = if include_archived {
            sqlx::query("SELECT id, title, status, root_context_id, created_at, updated_at FROM agents ORDER BY updated_at DESC")
                .fetch_all(&self.pool)
                .await?
        } else {
            sqlx::query("SELECT id, title, status, root_context_id, created_at, updated_at FROM agents WHERE status = 'active' ORDER BY updated_at DESC")
                .fetch_all(&self.pool)
                .await?
        };
        Ok(rows.iter().map(agent_from_row).collect())
    }

    async fn create_context(
        &self,
        context: NewCognitiveContext,
    ) -> Result<CognitiveContextRecord, Box<dyn std::error::Error + Send + Sync>> {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            "INSERT INTO cognitive_contexts (id, agent_id, title, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
        )
        .bind(&context.id)
        .bind(&context.agent_id)
        .bind(&context.title)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        self.get_context(&context.id)
            .await?
            .ok_or_else(|| "Context 创建后无法读取".into())
    }

    async fn ensure_context(
        &self,
        context: NewCognitiveContext,
    ) -> Result<CognitiveContextRecord, Box<dyn std::error::Error + Send + Sync>> {
        if let Some(existing) = self.get_context(&context.id).await? {
            if existing.agent_id != context.agent_id {
                return Err(format!(
                    "Context '{}' 已属于 Agent '{}'，不能重新挂载到 '{}'",
                    context.id, existing.agent_id, context.agent_id
                )
                .into());
            }
            return Ok(existing);
        }
        match self.create_context(context.clone()).await {
            Ok(created) => Ok(created),
            Err(_) => self
                .get_context(&context.id)
                .await?
                .ok_or_else(|| "并发创建 Context 失败".into()),
        }
    }

    async fn get_context(
        &self,
        id: &str,
    ) -> Result<Option<CognitiveContextRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let row = sqlx::query(
            "SELECT id, agent_id, title, status, created_at, updated_at, seed_context_id, seed_context_version, seed_snapshot_hash, seed_projection FROM cognitive_contexts WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(context_from_row))
    }

    async fn list_contexts(
        &self,
        include_archived: bool,
    ) -> Result<Vec<CognitiveContextRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = if include_archived {
            sqlx::query("SELECT id, agent_id, title, status, created_at, updated_at, seed_context_id, seed_context_version, seed_snapshot_hash, seed_projection FROM cognitive_contexts ORDER BY updated_at DESC")
                .fetch_all(&self.pool)
                .await?
        } else {
            sqlx::query("SELECT id, agent_id, title, status, created_at, updated_at, seed_context_id, seed_context_version, seed_snapshot_hash, seed_projection FROM cognitive_contexts WHERE status = 'active' ORDER BY updated_at DESC")
                .fetch_all(&self.pool)
                .await?
        };
        Ok(rows.iter().map(context_from_row).collect())
    }

    async fn update_context(
        &self,
        id: &str,
        update: ContextUpdate,
    ) -> Result<Option<CognitiveContextRecord>, Box<dyn std::error::Error + Send + Sync>> {
        if update.title.is_none() && update.status.is_none() {
            return self.get_context(id).await;
        }
        let Some(existing) = self.get_context(id).await? else {
            return Ok(None);
        };
        let title = update.title.unwrap_or(existing.title);
        let status = update.status.unwrap_or(existing.status);
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            "UPDATE cognitive_contexts SET title = ?, status = ?, updated_at = ? WHERE id = ?",
        )
        .bind(title)
        .bind(status.as_str())
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(None);
        }
        if status == SessionStatus::Archived {
            sqlx::query(
                "UPDATE sessions SET status = 'archived', updated_at = ? WHERE context_id = ? AND status != 'archived'",
            )
            .bind(&now)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        self.get_context(id).await
    }

    async fn set_context_seed(
        &self,
        context_id: &str,
        source_context_id: &str,
        source_version: u64,
        snapshot_hash: &str,
        projection: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let source_version = i64::try_from(source_version)
            .map_err(|_| "Context seed version 超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            "UPDATE cognitive_contexts SET seed_context_id = ?, seed_context_version = ?, seed_snapshot_hash = ?, seed_projection = ?, updated_at = ? WHERE id = ?",
        )
        .bind(source_context_id)
        .bind(source_version)
        .bind(snapshot_hash)
        .bind(projection)
        .bind(&now)
        .bind(context_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            return Err(format!("目标 Context '{}' 不存在", context_id).into());
        }
        Ok(())
    }

    async fn create_session(
        &self,
        session: NewSession,
    ) -> Result<SessionRecord, Box<dyn std::error::Error + Send + Sync>> {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let context = self
            .get_context(&session.context_id)
            .await?
            .ok_or_else(|| format!("父 Context '{}' 不存在", session.context_id))?;
        if context.agent_id != session.agent_id {
            return Err(format!(
                "Session '{}' 的 Agent '{}' 与 Context '{}' 的 Agent '{}' 不一致",
                session.id, session.agent_id, session.context_id, context.agent_id
            )
            .into());
        }
        if let Some(parent_id) = session.parent_session_id.as_deref() {
            let parent = self
                .get_session(parent_id)
                .await?
                .ok_or_else(|| format!("父 Session '{}' 不存在", parent_id))?;
            if parent.context_id != session.context_id {
                return Err(format!(
                    "父 Session '{}' 属于 Context '{}'，不能作为 Context '{}' 内 Session 的父级",
                    parent_id, parent.context_id, session.context_id
                )
                .into());
            }
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"INSERT INTO sessions
               (id, agent_id, context_id, parent_session_id, title, status, created_at, updated_at, last_activity_at)
               VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)"#,
        )
        .bind(&session.id)
        .bind(&session.agent_id)
        .bind(&session.context_id)
        .bind(&session.parent_session_id)
        .bind(&session.title)
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO session_mounts (session_id, generation, context_id, mount_kind, mounted_at, unmounted_at) VALUES (?, 1, ?, ?, ?, NULL)",
        )
        .bind(&session.id)
        .bind(&session.context_id)
        .bind(session.mount_kind.as_str())
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        self.get_session(&session.id)
            .await?
            .ok_or_else(|| "Session 创建后无法读取".into())
    }

    async fn create_session_for_principal(
        &self,
        session: NewSession,
        principal_id: &str,
    ) -> Result<SessionRecord, Box<dyn std::error::Error + Send + Sync>> {
        if self.get_principal(principal_id).await?.is_none() {
            return Err(format!("Principal '{principal_id}' 不存在").into());
        }
        let context = self
            .get_context(&session.context_id)
            .await?
            .ok_or_else(|| format!("父 Context '{}' 不存在", session.context_id))?;
        if context.agent_id != session.agent_id {
            return Err(format!(
                "Session '{}' 的 Agent '{}' 与 Context '{}' 的 Agent '{}' 不一致",
                session.id, session.agent_id, session.context_id, context.agent_id
            )
            .into());
        }
        if let Some(parent_id) = session.parent_session_id.as_deref() {
            let parent = self
                .get_session(parent_id)
                .await?
                .ok_or_else(|| format!("父 Session '{parent_id}' 不存在"))?;
            if parent.context_id != session.context_id {
                return Err(format!(
                    "父 Session '{}' 属于 Context '{}'，不能作为 Context '{}' 内 Session 的父级",
                    parent_id, parent.context_id, session.context_id
                )
                .into());
            }
        }

        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"INSERT INTO sessions
               (id, agent_id, context_id, parent_session_id, title, status, created_at, updated_at, last_activity_at)
               VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)"#,
        )
        .bind(&session.id)
        .bind(&session.agent_id)
        .bind(&session.context_id)
        .bind(&session.parent_session_id)
        .bind(&session.title)
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO session_mounts (session_id, generation, context_id, mount_kind, mounted_at, unmounted_at) VALUES (?, 1, ?, ?, ?, NULL)",
        )
        .bind(&session.id)
        .bind(&session.context_id)
        .bind(session.mount_kind.as_str())
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"INSERT INTO session_principal_bindings
               (session_id, principal_id, bound_at, unbound_at)
               VALUES (?, ?, ?, NULL)"#,
        )
        .bind(&session.id)
        .bind(principal_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        self.get_session(&session.id)
            .await?
            .ok_or_else(|| "Session 与 Principal 原子创建后无法读取".into())
    }

    async fn ensure_session(
        &self,
        session: NewSession,
    ) -> Result<SessionRecord, Box<dyn std::error::Error + Send + Sync>> {
        if let Some(existing) = self.get_session(&session.id).await? {
            if existing.context_id != session.context_id || existing.agent_id != session.agent_id {
                return Err(format!(
                    "Session '{}' 已挂载到 Agent '{}'/Context '{}'，拒绝重新路由到 Agent '{}'/Context '{}'",
                    session.id,
                    existing.agent_id,
                    existing.context_id,
                    session.agent_id,
                    session.context_id
                )
                .into());
            }
            return Ok(existing);
        }
        match self.create_session(session.clone()).await {
            Ok(created) => Ok(created),
            Err(_) => self
                .get_session(&session.id)
                .await?
                .ok_or_else(|| "并发创建 Session 失败".into()),
        }
    }

    async fn get_session(
        &self,
        id: &str,
    ) -> Result<Option<SessionRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let row = sqlx::query(
            r#"SELECT s.id, s.agent_id, s.context_id, s.parent_session_id, s.title, s.status,
                      s.created_at, s.updated_at, s.last_activity_at,
                      sm.attention_state, sm.attention_revision, sm.attention_reason,
                      sm.attention_changed_at, sm.attention_event_id
               FROM sessions s
               JOIN session_mounts sm ON sm.session_id = s.id AND sm.unmounted_at IS NULL
               WHERE s.id = ?"#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(session_from_row))
    }

    async fn list_sessions(
        &self,
        include_archived: bool,
    ) -> Result<Vec<SessionRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = if include_archived {
            sqlx::query(r#"SELECT s.id, s.agent_id, s.context_id, s.parent_session_id, s.title, s.status,
                                      s.created_at, s.updated_at, s.last_activity_at,
                                      sm.attention_state, sm.attention_revision, sm.attention_reason,
                                      sm.attention_changed_at, sm.attention_event_id
                               FROM sessions s
                               JOIN session_mounts sm ON sm.session_id = s.id AND sm.unmounted_at IS NULL
                               ORDER BY s.last_activity_at DESC, s.id ASC"#)
                .fetch_all(&self.pool)
                .await?
        } else {
            sqlx::query(r#"SELECT s.id, s.agent_id, s.context_id, s.parent_session_id, s.title, s.status,
                                      s.created_at, s.updated_at, s.last_activity_at,
                                      sm.attention_state, sm.attention_revision, sm.attention_reason,
                                      sm.attention_changed_at, sm.attention_event_id
                               FROM sessions s
                               JOIN session_mounts sm ON sm.session_id = s.id AND sm.unmounted_at IS NULL
                               WHERE s.status = 'active'
                               ORDER BY s.last_activity_at DESC, s.id ASC"#)
                .fetch_all(&self.pool)
                .await?
        };
        Ok(rows.iter().map(session_from_row).collect())
    }

    async fn list_context_sessions(
        &self,
        context_id: &str,
        include_archived: bool,
    ) -> Result<Vec<SessionRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = if include_archived {
            sqlx::query(r#"SELECT s.id, s.agent_id, s.context_id, s.parent_session_id, s.title, s.status,
                                      s.created_at, s.updated_at, s.last_activity_at,
                                      sm.attention_state, sm.attention_revision, sm.attention_reason,
                                      sm.attention_changed_at, sm.attention_event_id
                               FROM sessions s
                               JOIN session_mounts sm ON sm.session_id = s.id AND sm.unmounted_at IS NULL
                               WHERE s.context_id = ?
                               ORDER BY s.last_activity_at DESC, s.id ASC"#)
                .bind(context_id)
                .fetch_all(&self.pool)
                .await?
        } else {
            sqlx::query(r#"SELECT s.id, s.agent_id, s.context_id, s.parent_session_id, s.title, s.status,
                                      s.created_at, s.updated_at, s.last_activity_at,
                                      sm.attention_state, sm.attention_revision, sm.attention_reason,
                                      sm.attention_changed_at, sm.attention_event_id
                               FROM sessions s
                               JOIN session_mounts sm ON sm.session_id = s.id AND sm.unmounted_at IS NULL
                               WHERE s.context_id = ? AND s.status = 'active'
                               ORDER BY s.last_activity_at DESC, s.id ASC"#)
                .bind(context_id)
                .fetch_all(&self.pool)
                .await?
        };
        Ok(rows.iter().map(session_from_row).collect())
    }

    async fn update_session(
        &self,
        id: &str,
        update: SessionUpdate,
    ) -> Result<Option<SessionRecord>, Box<dyn std::error::Error + Send + Sync>> {
        if update.title.is_none() && update.status.is_none() {
            return self.get_session(id).await;
        }
        let existing = match self.get_session(id).await? {
            Some(existing) => existing,
            None => return Ok(None),
        };
        let title = update.title.unwrap_or(existing.title);
        let status = update.status.unwrap_or(existing.status);
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query("UPDATE sessions SET title = ?, status = ?, updated_at = ? WHERE id = ?")
            .bind(title)
            .bind(status.as_str())
            .bind(now)
            .bind(id)
            .execute(&self.pool)
            .await?;
        self.get_session(id).await
    }

    async fn touch_session(
        &self,
        id: &str,
        at: DateTime<Utc>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let at = at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query("UPDATE sessions SET updated_at = ?, last_activity_at = ? WHERE id = ?")
            .bind(&at)
            .bind(&at)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn update_session_attention(
        &self,
        update: SessionAttentionUpdate,
    ) -> Result<Option<SessionRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let expected_revision = i64::try_from(update.expected_revision)
            .map_err(|_| "Session attention revision 超出 SQLite INTEGER 范围")?;
        let changed_at = update
            .changed_at
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE session_mounts
               SET attention_state = ?, attention_revision = attention_revision + 1,
                   attention_reason = ?, attention_changed_at = ?, attention_event_id = ?
               WHERE session_id = ? AND context_id = ? AND unmounted_at IS NULL
                 AND attention_revision = ?"#,
        )
        .bind(update.state.as_str())
        .bind(update.reason)
        .bind(changed_at)
        .bind(update.event_id)
        .bind(&update.session_id)
        .bind(update.context_id)
        .bind(expected_revision)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Ok(None);
        }
        self.get_session(&update.session_id).await
    }
}

#[async_trait::async_trait]
impl ActivationStore for SqliteStore {
    async fn commit_context_transaction(
        &self,
        event: &Event,
        attention_updates: &[SessionAttentionUpdate],
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut tx = self.pool.begin().await?;
        for update in attention_updates {
            let expected_revision = i64::try_from(update.expected_revision)
                .map_err(|_| "Session attention revision 超出 SQLite INTEGER 范围")?;
            let changed_at = update
                .changed_at
                .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
            let result = sqlx::query(
                r#"UPDATE session_mounts
                   SET attention_state = ?, attention_revision = attention_revision + 1,
                       attention_reason = ?, attention_changed_at = ?, attention_event_id = ?
                   WHERE session_id = ? AND context_id = ? AND unmounted_at IS NULL
                     AND attention_revision = ?"#,
            )
            .bind(update.state.as_str())
            .bind(&update.reason)
            .bind(changed_at)
            .bind(&update.event_id)
            .bind(&update.session_id)
            .bind(&update.context_id)
            .bind(expected_revision)
            .execute(&mut *tx)
            .await?;
            if result.rows_affected() != 1 {
                return Err(format!(
                    "Session '{}' attention revision 冲突或 Context mount 不存在",
                    update.session_id
                )
                .into());
            }
        }
        append_event_in_transaction(&mut tx, event).await?;
        tx.commit().await?;
        Ok(())
    }

    async fn claim_thread_signal_batch(
        &self,
        signal: NewThreadSignal,
        activation: NewThreadActivation,
        max_signals: usize,
    ) -> Result<Option<ThreadActivationRecord>, Box<dyn std::error::Error + Send + Sync>> {
        if max_signals == 0 {
            return Err("Thread Signal batch 上限必须大于 0".into());
        }
        let sequence = i64::try_from(signal.sequence)
            .map_err(|_| "Thread Signal sequence 超出 SQLite INTEGER 范围")?;
        let max_signals = i64::try_from(max_signals)
            .map_err(|_| "Thread Signal batch 上限超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;

        // This first write serializes competing claims under SQLite WAL. The
        // immutable Event has already crossed the Ledger boundary before the
        // Orchestrator asks the scheduler to materialize its mailbox Signal.
        sqlx::query(
            r#"INSERT OR IGNORE INTO thread_signals
               (id, thread_id, event_id, principal_id, sequence, kind, parent_activation_id,
                status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)"#,
        )
        .bind(&signal.id)
        .bind(&signal.thread_id)
        .bind(&signal.event_id)
        .bind(&signal.principal_id)
        .bind(sequence)
        .bind(&signal.kind)
        .bind(&signal.parent_activation_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;

        let stored_signal = sqlx::query("SELECT * FROM thread_signals WHERE event_id = ?")
            .bind(&signal.event_id)
            .fetch_one(&mut *tx)
            .await?;
        let mut stored_signal = thread_signal_from_row(&stored_signal)?;
        if stored_signal.principal_id.is_none() && signal.principal_id.is_some() {
            sqlx::query(
                "UPDATE thread_signals SET principal_id = ? WHERE id = ? AND principal_id IS NULL",
            )
            .bind(&signal.principal_id)
            .bind(&stored_signal.id)
            .execute(&mut *tx)
            .await?;
            stored_signal.principal_id =
                sqlx::query("SELECT principal_id FROM thread_signals WHERE id = ?")
                    .bind(&stored_signal.id)
                    .fetch_one(&mut *tx)
                    .await?
                    .get("principal_id");
        }
        if stored_signal.thread_id != signal.thread_id {
            return Err(format!("Event '{}' 已路由到不同 Thread Signal", signal.event_id).into());
        }
        if signal.principal_id.is_some() && stored_signal.principal_id != signal.principal_id {
            return Err(format!(
                "Event '{}' 的 Thread Signal Principal 不一致",
                signal.event_id
            )
            .into());
        }

        if let Some(outbox) = sqlx::query("SELECT * FROM signal_outbox WHERE event_id = ?")
            .bind(&stored_signal.event_id)
            .fetch_optional(&mut *tx)
            .await?
        {
            let outbox = signal_outbox_from_row(&outbox)?;
            if outbox.status == SignalOutboxStatus::Materialized
                && outbox.signal_id.as_deref() != Some(stored_signal.id.as_str())
            {
                return Err(format!(
                    "Signal Outbox Event '{}' 已物化为不同 Signal",
                    stored_signal.event_id
                )
                .into());
            }
            sqlx::query(
                r#"UPDATE signal_outbox
                   SET status = 'materialized', signal_id = ?, resolved_at = ?
                   WHERE event_id = ? AND status = 'pending'"#,
            )
            .bind(&stored_signal.id)
            .bind(&now)
            .bind(&stored_signal.event_id)
            .execute(&mut *tx)
            .await?;
        }

        if let Some(row) = sqlx::query(
            r#"SELECT ew.* FROM activation_signals links
               JOIN thread_activations ew ON ew.id = links.activation_id
               JOIN threads thread ON thread.root_turn_id = ew.root_turn_id
                                  AND thread.generation = ew.generation
               WHERE links.signal_id = ?"#,
        )
        .bind(&stored_signal.id)
        .fetch_optional(&mut *tx)
        .await?
        {
            let existing = thread_activation_from_row(&row)?;
            tx.commit().await?;
            return Ok(Some(existing));
        }

        let thread = sqlx::query("SELECT * FROM threads WHERE id = ?")
            .bind(&signal.thread_id)
            .fetch_one(&mut *tx)
            .await?;
        let mut thread = thread_from_row(&thread)?;
        if thread.initiating_principal_id.is_none() && stored_signal.principal_id.is_some() {
            sqlx::query(
                "UPDATE threads SET initiating_principal_id = ? WHERE id = ? AND initiating_principal_id IS NULL",
            )
            .bind(&stored_signal.principal_id)
            .bind(&thread.id)
            .execute(&mut *tx)
            .await?;
            thread.initiating_principal_id =
                sqlx::query("SELECT initiating_principal_id FROM threads WHERE id = ?")
                    .bind(&thread.id)
                    .fetch_one(&mut *tx)
                    .await?
                    .get("initiating_principal_id");
        }
        if thread.agent_id != activation.agent_id
            || thread.context_id != activation.context_id
            || thread.session_id != activation.session_id
            || thread.root_turn_id != activation.root_turn_id
        {
            return Err(format!(
                "Thread Signal '{}' 与 Activation route 不一致",
                stored_signal.id
            )
            .into());
        }

        // A terminal Thread cannot accept another physical result.  Dialogue
        // retry reopens the logical Thread and advances its generation in one
        // transaction before the retry Event is dispatched, so acknowledging
        // pending Signals here cannot consume a legitimate retry trigger.
        if thread.lifecycle.is_terminal() {
            sqlx::query(
                r#"UPDATE thread_signals
                   SET status = 'acknowledged', acknowledged_at = ?
                   WHERE thread_id = ? AND status = 'pending'"#,
            )
            .bind(&now)
            .bind(&thread.id)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            return Ok(None);
        }

        // Signals produced by a physical Activation belong to that exact
        // Evaluation generation.  A late tool result from an old generation
        // must never be folded into a restarted DialogueTurn.  Signals without
        // a parent Activation (user input, retry and external wakeups) remain
        // eligible for the current generation.
        sqlx::query(
            r#"UPDATE thread_signals
               SET status = 'acknowledged', acknowledged_at = ?
               WHERE thread_id = ? AND status = 'pending'
                 AND parent_activation_id IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM thread_activations parent
                   WHERE parent.id = thread_signals.parent_activation_id
                     AND parent.generation = ?
                 )"#,
        )
        .bind(&now)
        .bind(&thread.id)
        .bind(
            i64::try_from(thread.generation)
                .map_err(|_| "Thread generation 超出 SQLite INTEGER 范围")?,
        )
        .execute(&mut *tx)
        .await?;

        // One-way adoption for durable Activations created before explicit
        // Thread Signals existed. The matching trigger Event is unambiguous;
        // attaching it here avoids creating a second Activation or stranding
        // the recovered plan behind its own queued row.
        if let Some(row) = sqlx::query(
            r#"SELECT * FROM thread_activations
               WHERE root_turn_id = ? AND trigger_event_id = ?
                 AND generation = ?
                 AND status IN ('queued', 'running') LIMIT 1"#,
        )
        .bind(&thread.root_turn_id)
        .bind(&stored_signal.event_id)
        .bind(
            i64::try_from(thread.generation)
                .map_err(|_| "Thread generation 超出 SQLite INTEGER 范围")?,
        )
        .fetch_optional(&mut *tx)
        .await?
        {
            let existing = thread_activation_from_row(&row)?;
            sqlx::query(
                "INSERT OR IGNORE INTO activation_signals (activation_id, signal_id, ordinal) VALUES (?, ?, 0)",
            )
            .bind(&existing.id)
            .bind(&stored_signal.id)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "UPDATE thread_signals SET status = 'claimed', claimed_at = ? WHERE id = ? AND status = 'pending'",
            )
            .bind(&now)
            .bind(&stored_signal.id)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            return Ok(Some(existing));
        }

        // queued/running are the only Activation states that own Thread
        // single-flight. Historical waiting_* rows represent a completed
        // model activation waiting on a new physical Signal and must not block
        // its successor.
        let active = sqlx::query(
            "SELECT id FROM thread_activations WHERE root_turn_id = ? AND generation = ? AND status IN ('queued', 'running') LIMIT 1",
        )
        .bind(&thread.root_turn_id)
        .bind(
            i64::try_from(thread.generation)
                .map_err(|_| "Thread generation 超出 SQLite INTEGER 范围")?,
        )
        .fetch_optional(&mut *tx)
        .await?;
        if active.is_some() {
            tx.commit().await?;
            return Ok(None);
        }

        let pending = sqlx::query(
            r#"SELECT * FROM thread_signals
               WHERE thread_id = ? AND status = 'pending'
               ORDER BY sequence, id LIMIT ?"#,
        )
        .bind(&thread.id)
        .bind(max_signals)
        .fetch_all(&mut *tx)
        .await?;
        if pending.is_empty() {
            tx.commit().await?;
            return Ok(None);
        }
        let primary = thread_signal_from_row(&pending[0])?;
        let activation_principal = activation
            .initiating_principal_id
            .as_ref()
            .or(primary.principal_id.as_ref());
        if activation.initiating_principal_id.is_some()
            && primary.principal_id.is_some()
            && activation.initiating_principal_id != primary.principal_id
        {
            return Err(format!(
                "Activation '{}' 与其首个 Signal Principal 不一致",
                activation.id
            )
            .into());
        }
        if thread.initiating_principal_id.is_some()
            && activation_principal.is_some()
            && thread.initiating_principal_id.as_ref() != activation_principal
        {
            return Err(format!(
                "Thread '{}' 与 Activation '{}' Principal 不一致",
                thread.id, activation.id
            )
            .into());
        }
        let trigger_sequence = i64::try_from(primary.sequence)
            .map_err(|_| "Activation trigger sequence 超出 SQLite INTEGER 范围")?;
        sqlx::query(
            r#"INSERT INTO thread_activations
               (id, revision, generation, agent_id, context_id, session_id, initiating_principal_id, trigger_event_id,
                trigger_sequence, trigger_kind, parent_activation_id, root_turn_id,
                status, created_at, updated_at)
               VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)"#,
        )
        .bind(&activation.id)
        .bind(i64::try_from(thread.generation).map_err(|_| "Thread generation 超出 SQLite INTEGER 范围")?)
        .bind(&activation.agent_id)
        .bind(&activation.context_id)
        .bind(&activation.session_id)
        .bind(activation_principal)
        .bind(&primary.event_id)
        .bind(trigger_sequence)
        .bind(&primary.kind)
        .bind(&primary.parent_activation_id)
        .bind(&activation.root_turn_id)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;

        let mut advances_clock = false;
        for row in &pending {
            let pending_signal = thread_signal_from_row(row)?;
            if let Some(event) =
                stored_event_in_transaction(&mut tx, &pending_signal.event_id, &thread.context_id)
                    .await?
            {
                if crate::event::advances_cognitive_clock(&event) {
                    advances_clock = true;
                    break;
                }
            }
        }
        if advances_clock {
            sqlx::query(
                r#"INSERT INTO context_cognitive_clocks
                   (context_id, tick, last_signal_batch_id, revision)
                   VALUES (?, 1, ?, 1)
                   ON CONFLICT(context_id) DO UPDATE SET
                     tick = context_cognitive_clocks.tick + 1,
                     last_signal_batch_id = excluded.last_signal_batch_id,
                     revision = context_cognitive_clocks.revision + 1
                   WHERE context_cognitive_clocks.last_signal_batch_id IS NULL
                      OR context_cognitive_clocks.last_signal_batch_id != excluded.last_signal_batch_id"#,
            )
            .bind(&thread.context_id)
            .bind(&activation.id)
            .execute(&mut *tx)
            .await?;
        }

        for (ordinal, row) in pending.iter().enumerate() {
            let pending_signal = thread_signal_from_row(row)?;
            let ordinal = i64::try_from(ordinal)
                .map_err(|_| "Activation Signal ordinal 超出 SQLite INTEGER 范围")?;
            sqlx::query(
                "INSERT INTO activation_signals (activation_id, signal_id, ordinal) VALUES (?, ?, ?)",
            )
            .bind(&activation.id)
            .bind(&pending_signal.id)
            .bind(ordinal)
            .execute(&mut *tx)
            .await?;
            let claimed = sqlx::query(
                "UPDATE thread_signals SET status = 'claimed', claimed_at = ? WHERE id = ? AND status = 'pending'",
            )
            .bind(&now)
            .bind(&pending_signal.id)
            .execute(&mut *tx)
            .await?;
            if claimed.rows_affected() != 1 {
                return Err(format!(
                    "Thread Signal '{}' 在 Activation claim 中发生并发冲突",
                    pending_signal.id
                )
                .into());
            }
        }
        tx.commit().await?;
        if advances_clock {
            tracing::debug!(
                context_id = %thread.context_id,
                activation_id = %activation.id,
                signal_count = pending.len(),
                "认知活动时钟已随唯一 Signal batch 推进"
            );
        }
        self.get_thread_activation(&activation.id).await
    }

    async fn list_signal_outbox(
        &self,
        status: SignalOutboxStatus,
        limit: usize,
    ) -> Result<Vec<SignalOutboxRecord>, Box<dyn std::error::Error + Send + Sync>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let limit =
            i64::try_from(limit).map_err(|_| "Signal Outbox 查询上限超出 SQLite INTEGER 范围")?;
        let rows = sqlx::query(
            r#"SELECT outbox.* FROM signal_outbox outbox
               JOIN events ON events.id = outbox.event_id
               WHERE outbox.status = ?
               ORDER BY events.rowid, outbox.event_id
               LIMIT ?"#,
        )
        .bind(status.as_str())
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(signal_outbox_from_row).collect()
    }

    async fn discard_signal_outbox(
        &self,
        event_id: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE signal_outbox
               SET status = 'discarded', resolved_at = ?
               WHERE event_id = ? AND status = 'pending'"#,
        )
        .bind(now)
        .bind(event_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    async fn list_context_thread_signals(
        &self,
        context_id: &str,
        status: Option<ThreadSignalStatus>,
    ) -> Result<Vec<ThreadSignalRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = if let Some(status) = status {
            sqlx::query(
                r#"SELECT signals.* FROM thread_signals signals
                   JOIN threads threads ON threads.id = signals.thread_id
                   WHERE threads.context_id = ? AND signals.status = ?
                   ORDER BY signals.sequence, signals.id"#,
            )
            .bind(context_id)
            .bind(status.as_str())
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                r#"SELECT signals.* FROM thread_signals signals
                   JOIN threads threads ON threads.id = signals.thread_id
                   WHERE threads.context_id = ?
                   ORDER BY signals.sequence, signals.id"#,
            )
            .bind(context_id)
            .fetch_all(&self.pool)
            .await?
        };
        rows.iter().map(thread_signal_from_row).collect()
    }

    async fn list_activation_signals(
        &self,
        activation_id: &str,
    ) -> Result<Vec<ThreadSignalRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = sqlx::query(
            r#"SELECT signals.* FROM activation_signals links
               JOIN thread_signals signals ON signals.id = links.signal_id
               WHERE links.activation_id = ? ORDER BY links.ordinal"#,
        )
        .bind(activation_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(thread_signal_from_row).collect()
    }

    async fn next_pending_thread_signal(
        &self,
        thread_id: &str,
    ) -> Result<Option<ThreadSignalRecord>, Box<dyn std::error::Error + Send + Sync>> {
        sqlx::query(
            r#"SELECT * FROM thread_signals WHERE thread_id = ? AND status = 'pending'
               ORDER BY sequence, id LIMIT 1"#,
        )
        .bind(thread_id)
        .fetch_optional(&self.pool)
        .await?
        .as_ref()
        .map(thread_signal_from_row)
        .transpose()
    }

    async fn ensure_thread_activation(
        &self,
        activation: NewThreadActivation,
    ) -> Result<ThreadActivationRecord, Box<dyn std::error::Error + Send + Sync>> {
        let trigger_sequence = i64::try_from(activation.trigger_sequence)
            .map_err(|_| "Thread Activation trigger sequence 超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            r#"INSERT OR IGNORE INTO thread_activations
               (id, revision, generation, agent_id, context_id, session_id, initiating_principal_id, trigger_event_id,
                trigger_sequence, trigger_kind, parent_activation_id, root_turn_id,
                status, created_at, updated_at)
               VALUES (?, 1, (SELECT generation FROM threads WHERE root_turn_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)"#,
        )
        .bind(&activation.id)
        .bind(&activation.root_turn_id)
        .bind(&activation.agent_id)
        .bind(&activation.context_id)
        .bind(&activation.session_id)
        .bind(&activation.initiating_principal_id)
        .bind(&activation.trigger_event_id)
        .bind(trigger_sequence)
        .bind(&activation.trigger_kind)
        .bind(&activation.parent_activation_id)
        .bind(&activation.root_turn_id)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        let row = sqlx::query("SELECT * FROM thread_activations WHERE trigger_event_id = ?")
            .bind(&activation.trigger_event_id)
            .fetch_one(&self.pool)
            .await?;
        let mut existing = thread_activation_from_row(&row)?;
        if existing.initiating_principal_id.is_none()
            && activation.initiating_principal_id.is_some()
        {
            sqlx::query(
                "UPDATE thread_activations SET initiating_principal_id = ? WHERE id = ? AND initiating_principal_id IS NULL",
            )
            .bind(&activation.initiating_principal_id)
            .bind(&existing.id)
            .execute(&self.pool)
            .await?;
            existing.initiating_principal_id = self
                .get_thread_activation(&existing.id)
                .await?
                .and_then(|record| record.initiating_principal_id);
        }
        if existing.context_id != activation.context_id
            || existing.session_id != activation.session_id
            || existing.root_turn_id != activation.root_turn_id
            || (activation.initiating_principal_id.is_some()
                && existing.initiating_principal_id != activation.initiating_principal_id)
        {
            return Err(format!(
                "Trigger Event '{}' 已被不同 Thread Activation 占用",
                activation.trigger_event_id
            )
            .into());
        }
        Ok(existing)
    }

    async fn get_thread_activation(
        &self,
        id: &str,
    ) -> Result<Option<ThreadActivationRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let row = sqlx::query("SELECT * FROM thread_activations WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(thread_activation_from_row).transpose()
    }

    async fn list_context_thread_activations(
        &self,
        context_id: &str,
        include_terminal: bool,
    ) -> Result<Vec<ThreadActivationRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = if include_terminal {
            sqlx::query(
                "SELECT * FROM thread_activations WHERE context_id = ? ORDER BY created_at, id",
            )
            .bind(context_id)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT * FROM thread_activations WHERE context_id = ? AND status NOT IN ('completed', 'cancelled', 'failed') ORDER BY created_at, id",
            )
            .bind(context_id)
            .fetch_all(&self.pool)
            .await?
        };
        rows.iter().map(thread_activation_from_row).collect()
    }

    async fn list_queued_thread_activations_for_admission(
        &self,
        limit: usize,
        dialogue_delivery_reserved_queue_slots: usize,
        aging_promotion_interval_ms: u64,
    ) -> Result<
        Vec<(ThreadActivationRecord, crate::admission::AdmissionClass)>,
        Box<dyn std::error::Error + Send + Sync>,
    > {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let limit = i64::try_from(limit)
            .map_err(|_| "Activation admission 查询上限超出 SQLite INTEGER 范围")?;
        let reserved_queue_slots =
            dialogue_delivery_reserved_queue_slots.min((limit as usize).saturating_sub(1));
        let general_limit =
            limit.saturating_sub(i64::try_from(reserved_queue_slots).unwrap_or(i64::MAX));
        let aging_promotion_interval_ms = aging_promotion_interval_ms.max(1) as f64;
        // Keep the DB read proportional to the configured in-memory window.
        // The CASE expression mirrors the Runtime-owned fixed classifier; no
        // model-provided priority enters this ordering.
        let rows = sqlx::query(
            r#"WITH classified AS (
                 SELECT activations.*,
                      CASE
                        WHEN events.type = 'user_message' THEN 0
                        WHEN activations.trigger_kind = 'chat/thread_completion_ready' THEN 1
                        -- objective_id is projected on append, but Objective
                        -- entry Events such as `objective/requested` carry
                        -- only `requested_objective_id`. Keep the topic prefix
                        -- so they are not admitted as background work.
                        WHEN events.objective_id IS NOT NULL
                          OR json_type(events.payload, '$.objective_evaluation_id') IS NOT NULL
                          OR substr(events.topic, 1, 10) = 'objective/' THEN 2
                        WHEN json_extract(events.payload, '$.runtime_maintenance') = 1
                          OR events.topic IN ('runtime/context_maintenance', 'chat/context_maintenance')
                          THEN 4
                        ELSE 3
                      END AS admission_rank
                 FROM thread_activations activations
                 JOIN events ON events.id = activations.trigger_event_id
                 WHERE activations.status = 'queued'
               ), aged AS (
                 SELECT classified.*,
                        MAX(
                          0,
                          admission_rank - CAST(
                            MAX(
                              0.0,
                              (julianday('now') - julianday(created_at)) * 86400000.0
                            ) / ? AS INTEGER
                          )
                        ) AS effective_rank
                 FROM classified
               ), reserved_candidates AS (
                 SELECT * FROM aged
                 WHERE admission_rank IN (0, 1)
                 ORDER BY effective_rank, created_at, id
                 LIMIT ?
               ), general_candidates AS (
                 SELECT * FROM aged
                 WHERE admission_rank NOT IN (0, 1)
                 ORDER BY effective_rank, created_at, id
                 LIMIT ?
               ), candidates AS (
                 SELECT * FROM reserved_candidates
                 UNION ALL
                 SELECT * FROM general_candidates
               )
               SELECT * FROM candidates
               ORDER BY effective_rank, created_at, id
               LIMIT ?"#,
        )
        .bind(aging_promotion_interval_ms)
        // Reserved work may use any slot, so keep up to the total window. The
        // general candidate set is the one capped to preserve reserved room.
        .bind(limit)
        .bind(general_limit)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|row| {
                let activation = thread_activation_from_row(row)?;
                let class = match row.get::<i64, _>("admission_rank") {
                    0 => crate::admission::AdmissionClass::InteractiveControl,
                    1 => crate::admission::AdmissionClass::Delivery,
                    2 => crate::admission::AdmissionClass::Objective,
                    3 => crate::admission::AdmissionClass::ScheduledBackground,
                    4 => crate::admission::AdmissionClass::Maintenance,
                    rank => {
                        return Err(
                            format!("SQLite 返回未知 Activation admission rank {rank}").into()
                        )
                    }
                };
                Ok((activation, class))
            })
            .collect()
    }

    async fn update_thread_activation(
        &self,
        id: &str,
        expected_revision: u64,
        status: ThreadActivationStatus,
        claimed_by: Option<&str>,
        lease_expires_at: Option<DateTime<Utc>>,
        context_snapshot_version: Option<u64>,
    ) -> Result<ThreadActivationMutation, Box<dyn std::error::Error + Send + Sync>> {
        let expected_revision = i64::try_from(expected_revision)
            .map_err(|_| "Thread Activation revision 超出 SQLite INTEGER 范围")?;
        let context_snapshot_version = context_snapshot_version
            .map(i64::try_from)
            .transpose()
            .map_err(|_| "Context snapshot version 超出 SQLite INTEGER 范围")?;
        let lease_expires_at =
            lease_expires_at.map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            r#"UPDATE thread_activations
               SET revision = revision + 1, status = ?, claimed_by = ?,
                   lease_expires_at = ?,
                   context_snapshot_version = COALESCE(?, context_snapshot_version),
                   updated_at = ?
               WHERE id = ? AND revision = ?"#,
        )
        .bind(thread_activation_status_storage(status))
        .bind(claimed_by)
        .bind(lease_expires_at)
        .bind(context_snapshot_version)
        .bind(&now)
        .bind(id)
        .bind(expected_revision)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() == 1 {
            if status.is_terminal() {
                sqlx::query(
                    r#"UPDATE thread_signals
                       SET status = 'acknowledged', acknowledged_at = ?
                       WHERE id IN (
                         SELECT signal_id FROM activation_signals WHERE activation_id = ?
                       ) AND status = 'claimed'"#,
                )
                .bind(&now)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            }
            let row = sqlx::query("SELECT * FROM thread_activations WHERE id = ?")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
            let updated = thread_activation_from_row(&row)?;
            tx.commit().await?;
            return Ok(ThreadActivationMutation::Updated(updated));
        }
        tx.commit().await?;
        Ok(match self.get_thread_activation(id).await? {
            Some(current) => ThreadActivationMutation::Conflict { current },
            None => ThreadActivationMutation::NotFound,
        })
    }

    async fn commit_activation_outcome(
        &self,
        activation_id: &str,
        event: &Event,
    ) -> Result<ActivationOutcomeCommit, Box<dyn std::error::Error + Send + Sync>> {
        let session_id = event
            .payload
            .get("session_id")
            .and_then(JsonValue::as_str)
            .ok_or("Evaluation outcome Event 缺少 session_id")?;
        let disposition = event
            .payload
            .get("disposition")
            .and_then(JsonValue::as_str)
            .unwrap_or("deliver");
        let root_turn_id = event
            .payload
            .get("root_turn_id")
            .and_then(JsonValue::as_str)
            .ok_or("Evaluation outcome Event 缺少 root_turn_id")?;
        let thread_id = event
            .payload
            .get("thread_id")
            .and_then(JsonValue::as_str)
            .ok_or("Evaluation outcome Event 缺少 thread_id")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        let activation_route = sqlx::query(
            r#"SELECT activation.generation AS activation_generation,
                      activation.status AS activation_status,
                      thread.generation AS thread_generation
               FROM thread_activations activation
               JOIN threads thread ON thread.root_turn_id = activation.root_turn_id
               WHERE activation.id = ? AND thread.id = ?"#,
        )
        .bind(activation_id)
        .bind(thread_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| {
            format!(
                "Activation '{}' 或其 Thread '{}' 不存在",
                activation_id, thread_id
            )
        })?;
        let activation_generation: i64 = activation_route.get("activation_generation");
        let thread_generation: i64 = activation_route.get("thread_generation");
        if activation_generation != thread_generation {
            tx.commit().await?;
            return Ok(ActivationOutcomeCommit::StaleGeneration);
        }
        let activation_status: String = activation_route.get("activation_status");
        if activation_status != ThreadActivationStatus::Running.as_str() {
            let existing = sqlx::query_scalar::<_, String>(
                "SELECT event_id FROM thread_outcomes WHERE root_turn_id = ?",
            )
            .bind(root_turn_id)
            .fetch_optional(&mut *tx)
            .await?;
            tx.commit().await?;
            return Ok(match existing {
                Some(event_id) => ActivationOutcomeCommit::Existing { event_id },
                None => ActivationOutcomeCommit::StaleActivation,
            });
        }
        let result = sqlx::query(
            "INSERT INTO thread_outcomes (thread_id, root_turn_id, activation_id, session_id, disposition, event_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(root_turn_id) DO NOTHING",
        )
        .bind(thread_id)
        .bind(root_turn_id)
        .bind(activation_id)
        .bind(session_id)
        .bind(disposition)
        .bind(&event.id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() == 0 {
            let existing =
                sqlx::query("SELECT event_id FROM thread_outcomes WHERE root_turn_id = ?")
                    .bind(root_turn_id)
                    .fetch_one(&mut *tx)
                    .await?;
            tx.commit().await?;
            return Ok(ActivationOutcomeCommit::Existing {
                event_id: existing.get("event_id"),
            });
        }
        let result_text = event.payload.get("text").and_then(JsonValue::as_str);
        let thread_status =
            if event.topic == "chat/reply" && event.payload.get("runtime_failure_kind").is_some() {
                ThreadLifecycle::Failed.as_str()
            } else {
                ThreadLifecycle::Completed.as_str()
            };
        let (delivery_status, delivery_event_id) = match event.topic.as_str() {
            "chat/reply" => ("delivered", Some(event.id.as_str())),
            "runtime/thread_result" => ("pending", None),
            _ => ("none", None),
        };
        let terminal = sqlx::query(
            r#"UPDATE threads
               SET revision = revision + 1,
                   status = ?,
                   result_text = COALESCE(?, result_text),
                   result_event_id = ?,
                   delivery_status = ?,
                   delivery_event_id = ?,
                   updated_at = ?
               WHERE id = ? AND root_turn_id = ? AND session_id = ?
                 AND status NOT IN ('completed', 'failed', 'cancelled')"#,
        )
        .bind(thread_status)
        .bind(result_text)
        .bind(&event.id)
        .bind(delivery_status)
        .bind(delivery_event_id)
        .bind(&now)
        .bind(thread_id)
        .bind(root_turn_id)
        .bind(session_id)
        .execute(&mut *tx)
        .await?;
        if terminal.rows_affected() != 1 {
            return Err(format!(
                "Evaluation outcome 无法原子提交 Thread '{}' 终态",
                thread_id
            )
            .into());
        }
        if let Some(covers) = event.payload.get("covers").and_then(JsonValue::as_array) {
            for thread_id in covers.iter().filter_map(JsonValue::as_str) {
                let updated = sqlx::query(
                    "UPDATE threads SET revision = revision + 1, delivery_status = 'delivered', delivery_event_id = ?, updated_at = ? WHERE id = ? AND session_id = ? AND delivery_status IN ('pending', 'deferred')",
                )
                .bind(&event.id)
                .bind(&now)
                .bind(thread_id)
                .bind(session_id)
                .execute(&mut *tx)
                .await?;
                if updated.rows_affected() != 1 {
                    return Err(format!(
                        "Delivery outcome 无法覆盖 Thread '{}'：它不属于当前 Session、已被交付或不是 pending/deferred",
                        thread_id
                    )
                    .into());
                }
            }
        }
        if let Some(covers) = event
            .payload
            .get("defer_covers")
            .and_then(JsonValue::as_array)
        {
            for thread_id in covers.iter().filter_map(JsonValue::as_str) {
                sqlx::query(
                    "UPDATE threads SET revision = revision + 1, delivery_status = 'deferred', updated_at = ? WHERE id = ? AND session_id = ? AND delivery_status = 'pending'",
                )
                .bind(&now)
                .bind(thread_id)
                .bind(session_id)
                .execute(&mut *tx)
                .await?;
            }
        }
        sqlx::query(
            "INSERT OR IGNORE INTO evaluation_outcomes (activation_id, session_id, disposition, event_id, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(activation_id)
        .bind(session_id)
        .bind(disposition)
        .bind(&event.id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        append_event_in_transaction(&mut tx, event).await?;
        let activity_at = event
            .timestamp
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query("UPDATE sessions SET updated_at = ?, last_activity_at = ? WHERE id = ?")
            .bind(&activity_at)
            .bind(&activity_at)
            .bind(session_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(ActivationOutcomeCommit::Committed)
    }

    async fn restart_dialogue_turn(
        &self,
        request: DialogueTurnRetryRequest,
    ) -> Result<DialogueTurnRetryMutation, Box<dyn std::error::Error + Send + Sync>> {
        let root_turn_id = request
            .event
            .payload
            .get("root_turn_id")
            .and_then(JsonValue::as_str)
            .ok_or("DialogueTurn retry Event 缺少 root_turn_id")?;
        let context_id = request
            .event
            .payload
            .get("context_id")
            .and_then(JsonValue::as_str)
            .ok_or("DialogueTurn retry Event 缺少 context_id")?;
        let session_id = request
            .event
            .payload
            .get("session_id")
            .and_then(JsonValue::as_str)
            .ok_or("DialogueTurn retry Event 缺少 session_id")?;
        let expected_revision = i64::try_from(request.expected_thread_revision)
            .map_err(|_| "DialogueTurn Thread revision 超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;

        // Take SQLite's single Writer before the idempotency read.  Without
        // this first no-op write, two concurrent requests can both observe a
        // missing retry Event in deferred read transactions; the loser then
        // fails with SQLITE_BUSY_SNAPSHOT instead of observing the winner's
        // durable Event as an idempotent retry.
        sqlx::query("UPDATE threads SET revision = revision WHERE root_turn_id = ?")
            .bind(root_turn_id)
            .execute(&mut *tx)
            .await?;
        if stored_event_in_transaction(&mut tx, &request.event.id, context_id)
            .await?
            .is_some()
        {
            let row = sqlx::query("SELECT * FROM threads WHERE root_turn_id = ?")
                .bind(root_turn_id)
                .fetch_optional(&mut *tx)
                .await?;
            let Some(row) = row else {
                tx.commit().await?;
                return Ok(DialogueTurnRetryMutation::NotFound);
            };
            let current = thread_from_row(&row)?;
            tx.commit().await?;
            return Ok(DialogueTurnRetryMutation::Existing {
                thread_id: current.id,
                generation: current.generation,
            });
        }

        let row = sqlx::query("SELECT * FROM threads WHERE root_turn_id = ?")
            .bind(root_turn_id)
            .fetch_optional(&mut *tx)
            .await?;
        let Some(row) = row else {
            tx.commit().await?;
            return Ok(DialogueTurnRetryMutation::NotFound);
        };
        let current = thread_from_row(&row)?;
        if current.revision != request.expected_thread_revision {
            tx.commit().await?;
            return Ok(DialogueTurnRetryMutation::Conflict { current });
        }
        let rejected = if current.kind != ThreadKind::DialogueTurn {
            Some("只有 DialogueTurn 可以通过此原语重启".to_string())
        } else if !current.lifecycle.is_terminal() {
            Some("DialogueTurn 尚未进入终态".to_string())
        } else if current.context_id != context_id || current.session_id != session_id {
            Some("Retry Event 与 DialogueTurn route 不一致".to_string())
        } else if current.result_event_id.as_deref()
            != Some(request.expected_result_event_id.as_str())
        {
            Some("DialogueTurn 的当前结果已经变化".to_string())
        } else {
            None
        };
        if let Some(reason) = rejected {
            tx.commit().await?;
            return Ok(DialogueTurnRetryMutation::Rejected { current, reason });
        }
        let result_event =
            stored_event_in_transaction(&mut tx, &request.expected_result_event_id, context_id)
                .await?;
        if !result_event.as_ref().is_some_and(|event| {
            event.topic == "chat/reply" && event.payload.get("runtime_failure_kind").is_some()
        }) {
            tx.commit().await?;
            return Ok(DialogueTurnRetryMutation::Rejected {
                current,
                reason: "只有 Runtime 失败回复可以原位重试".to_string(),
            });
        }
        // A runtime-failure reply is already the authoritative terminal
        // outcome for this generation.  If the process crashed between that
        // atomic outcome commit and Activation cleanup, the old row may still
        // say queued/running.  Fence and close it in the same transaction as
        // the generation bump instead of making the user restart the Runtime
        // merely to recover the stale lease.
        sqlx::query(
            r#"UPDATE thread_activations
               SET revision = revision + 1, status = 'cancelled',
                   claimed_by = NULL, lease_expires_at = NULL, updated_at = ?
               WHERE root_turn_id = ? AND generation = ?
                 AND status IN ('queued', 'running')"#,
        )
        .bind(&now)
        .bind(root_turn_id)
        .bind(i64::try_from(current.generation)?)
        .execute(&mut *tx)
        .await?;
        let generation = current.generation.saturating_add(1);
        let generation_i64 = i64::try_from(generation)
            .map_err(|_| "DialogueTurn generation 超出 SQLite INTEGER 范围")?;
        let updated = sqlx::query(
            r#"UPDATE threads
               SET revision = revision + 1, generation = ?, status = 'open',
                   result_text = NULL, result_event_id = NULL,
                   delivery_status = 'none', delivery_event_id = NULL,
                   updated_at = ?
               WHERE id = ? AND revision = ?"#,
        )
        .bind(generation_i64)
        .bind(&now)
        .bind(&current.id)
        .bind(expected_revision)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            let row = sqlx::query("SELECT * FROM threads WHERE id = ?")
                .bind(&current.id)
                .fetch_one(&mut *tx)
                .await?;
            let current = thread_from_row(&row)?;
            tx.commit().await?;
            return Ok(DialogueTurnRetryMutation::Conflict { current });
        }
        sqlx::query("DELETE FROM thread_outcomes WHERE thread_id = ?")
            .bind(&current.id)
            .execute(&mut *tx)
            .await?;
        append_event_idempotent_in_transaction(&mut tx, &request.event).await?;
        append_signal_outbox_in_transaction(&mut tx, &request.event).await?;
        tx.commit().await?;
        Ok(DialogueTurnRetryMutation::Accepted {
            thread_id: current.id,
            generation,
        })
    }
}

#[async_trait::async_trait]
impl ThreadStore for SqliteStore {
    async fn ensure_thread(
        &self,
        thread: NewThread,
    ) -> Result<ThreadRecord, Box<dyn std::error::Error + Send + Sync>> {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            r#"INSERT OR IGNORE INTO threads
               (id, revision, agent_id, context_id, session_id, initiating_principal_id, root_turn_id,
                kind, status, executor_kind, executor_id, target_id, delivery_status,
                created_at, updated_at)
               VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, 'none', ?, ?)"#,
        )
        .bind(&thread.id)
        .bind(&thread.agent_id)
        .bind(&thread.context_id)
        .bind(&thread.session_id)
        .bind(&thread.initiating_principal_id)
        .bind(&thread.root_turn_id)
        .bind(thread.kind.as_str())
        .bind(&thread.executor_kind)
        .bind(&thread.executor_id)
        .bind(&thread.target_id)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        let row = sqlx::query("SELECT * FROM threads WHERE root_turn_id = ?")
            .bind(&thread.root_turn_id)
            .fetch_one(&self.pool)
            .await?;
        let mut existing = thread_from_row(&row)?;
        if existing.initiating_principal_id.is_none() && thread.initiating_principal_id.is_some() {
            sqlx::query(
                "UPDATE threads SET initiating_principal_id = ? WHERE id = ? AND initiating_principal_id IS NULL",
            )
            .bind(&thread.initiating_principal_id)
            .bind(&existing.id)
            .execute(&self.pool)
            .await?;
            existing.initiating_principal_id = self
                .get_thread(&existing.id)
                .await?
                .and_then(|record| record.initiating_principal_id);
        }
        if existing.context_id != thread.context_id
            || existing.session_id != thread.session_id
            || existing.agent_id != thread.agent_id
        {
            return Err(format!("Root Turn '{}' 已被不同 Thread 占用", thread.root_turn_id).into());
        }
        if thread.initiating_principal_id.is_some()
            && existing.initiating_principal_id != thread.initiating_principal_id
        {
            return Err(format!(
                "Root Turn '{}' 的 initiating Principal 不一致",
                thread.root_turn_id
            )
            .into());
        }
        Ok(existing)
    }

    async fn get_thread(
        &self,
        id: &str,
    ) -> Result<Option<ThreadRecord>, Box<dyn std::error::Error + Send + Sync>> {
        sqlx::query("SELECT * FROM threads WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(thread_from_row)
            .transpose()
    }

    async fn get_thread_by_root(
        &self,
        root_turn_id: &str,
    ) -> Result<Option<ThreadRecord>, Box<dyn std::error::Error + Send + Sync>> {
        sqlx::query("SELECT * FROM threads WHERE root_turn_id = ?")
            .bind(root_turn_id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(thread_from_row)
            .transpose()
    }

    async fn list_context_threads(
        &self,
        context_id: &str,
        include_terminal: bool,
    ) -> Result<Vec<ThreadRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = if include_terminal {
            sqlx::query("SELECT * FROM threads WHERE context_id = ? ORDER BY created_at, id")
                .bind(context_id)
                .fetch_all(&self.pool)
                .await?
        } else {
            sqlx::query("SELECT * FROM threads WHERE context_id = ? AND status NOT IN ('completed', 'failed', 'cancelled') ORDER BY created_at, id")
                .bind(context_id)
                .fetch_all(&self.pool)
                .await?
        };
        rows.iter().map(thread_from_row).collect()
    }

    async fn list_session_delivery_threads(
        &self,
        session_id: &str,
        include_deferred: bool,
    ) -> Result<Vec<ThreadRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = if include_deferred {
            sqlx::query(
                "SELECT * FROM threads WHERE session_id = ? AND delivery_status IN ('pending', 'deferred') ORDER BY updated_at, id",
            )
            .bind(session_id)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT * FROM threads WHERE session_id = ? AND delivery_status = 'pending' ORDER BY updated_at, id",
            )
            .bind(session_id)
            .fetch_all(&self.pool)
            .await?
        };
        rows.iter().map(thread_from_row).collect()
    }

    async fn list_pending_delivery_sessions(
        &self,
    ) -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(sqlx::query_scalar::<_, String>(
            r#"SELECT DISTINCT pending.session_id
               FROM threads AS pending
               WHERE pending.delivery_status = 'pending'
                 AND NOT EXISTS (
                   SELECT 1
                   FROM signal_outbox AS outbox
                   JOIN events AS event ON event.id = outbox.event_id
                   WHERE event.session_id = pending.session_id
                     AND event.topic = 'chat/thread_completion_ready'
                     AND outbox.status = 'pending'
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM threads AS delivery
                   WHERE delivery.session_id = pending.session_id
                     AND delivery.kind = 'delivery'
                     AND delivery.status NOT IN ('completed', 'failed', 'cancelled')
                 )
               ORDER BY pending.session_id"#,
        )
        .fetch_all(&self.pool)
        .await?)
    }

    async fn arm_delivery_flush_timer(
        &self,
        timer_id: &str,
        session_id: &str,
        merge_window_secs: u64,
        max_wait_secs: u64,
    ) -> Result<Option<RuntimeTimerRecord>, Box<dyn std::error::Error + Send + Sync>> {
        if timer_id.trim().is_empty() || session_id.trim().is_empty() {
            return Err("Delivery Flush timer_id/session_id 不能为空".into());
        }
        if merge_window_secs == 0 || max_wait_secs == 0 {
            return Err("Delivery Flush merge_window/max_wait 必须大于 0".into());
        }
        let merge_window = chrono::Duration::seconds(
            i64::try_from(merge_window_secs).map_err(|_| "Delivery Flush merge_window 超出范围")?,
        );
        let max_wait = chrono::Duration::seconds(
            i64::try_from(max_wait_secs).map_err(|_| "Delivery Flush max_wait 超出范围")?,
        );

        // BEGIN IMMEDIATE serializes the aggregate read with the generation
        // bump. Two results completing concurrently can therefore never let
        // an older aggregate overwrite a newer due time.
        let mut connection = self.pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *connection)
            .await?;
        let operation: Result<
            Option<RuntimeTimerRecord>,
            Box<dyn std::error::Error + Send + Sync>,
        > = async {
            let aggregate = sqlx::query(
                r#"SELECT MIN(updated_at) AS first_pending_at,
                          MAX(updated_at) AS latest_pending_at
                   FROM threads
                   WHERE session_id = ?
                     AND delivery_status = 'pending'"#,
            )
            .bind(session_id)
            .fetch_one(&mut *connection)
            .await?;
            let Some(first_pending_at) =
                aggregate.get::<Option<String>, _>("first_pending_at")
            else {
                return Ok(None);
            };
            let latest_pending_at = aggregate
                .get::<Option<String>, _>("latest_pending_at")
                .ok_or("Delivery Flush pending aggregate 缺少 latest_pending_at")?;
            let first_pending = parse_time(&first_pending_at);
            let latest_pending = parse_time(&latest_pending_at);
            let due_at = std::cmp::min(latest_pending + merge_window, first_pending + max_wait);
            let delivery_rows = sqlx::query(
                "SELECT id, result_event_id FROM threads WHERE session_id = ? AND delivery_status IN ('pending', 'deferred') ORDER BY updated_at, id",
            )
            .bind(session_id)
            .fetch_all(&mut *connection)
            .await?;
            let completed_thread_ids = delivery_rows
                .iter()
                .map(|row| row.get::<String, _>("id"))
                .collect::<Vec<_>>();
            let result_event_ids = delivery_rows
                .iter()
                .filter_map(|row| row.get::<Option<String>, _>("result_event_id"))
                .collect::<Vec<_>>();

            let current_generation = sqlx::query_scalar::<_, i64>(
                "SELECT generation FROM runtime_timers WHERE id = ?",
            )
            .bind(timer_id)
            .fetch_optional(&mut *connection)
            .await?
            .unwrap_or(0);
            let generation = current_generation
                .checked_add(1)
                .ok_or("Delivery Flush generation 溢出")?;
            let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
            let due_at_text =
                due_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
            let payload = serde_json::to_string(&serde_json::json!({
                "session_id": session_id,
                "first_pending_at": first_pending_at,
                "latest_pending_at": latest_pending_at,
                "merge_window_secs": merge_window_secs,
                "max_wait_secs": max_wait_secs,
                "completed_thread_ids": completed_thread_ids,
                "result_event_ids": result_event_ids,
            }))?;
            sqlx::query(
                r#"INSERT INTO runtime_timers
                   (id, generation, kind, owner_id, due_at, status, payload_json,
                    created_at, updated_at)
                   VALUES (?, ?, 'delivery_flush', ?, ?, 'pending', ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                     generation = excluded.generation,
                     kind = 'delivery_flush',
                     owner_id = excluded.owner_id,
                     due_at = excluded.due_at,
                     status = 'pending',
                     payload_json = excluded.payload_json,
                     claimed_by = NULL,
                     claim_expires_at = NULL,
                     last_error = NULL,
                     updated_at = excluded.updated_at,
                     fired_at = NULL"#,
            )
            .bind(timer_id)
            .bind(generation)
            .bind(session_id)
            .bind(due_at_text)
            .bind(payload)
            .bind(&now)
            .bind(&now)
            .execute(&mut *connection)
            .await?;
            let row = sqlx::query("SELECT * FROM runtime_timers WHERE id = ?")
                .bind(timer_id)
                .fetch_one(&mut *connection)
                .await?;
            Ok(Some(runtime_timer_from_row(&row)?))
        }
        .await;
        match operation {
            Ok(timer) => {
                sqlx::query("COMMIT").execute(&mut *connection).await?;
                Ok(timer)
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
                Err(error)
            }
        }
    }

    async fn commit_delivery_flush(
        &self,
        timer_id: &str,
        generation: u64,
        event: &Event,
    ) -> Result<DeliveryFlushCommit, Box<dyn std::error::Error + Send + Sync>> {
        if event.topic != "chat/thread_completion_ready" {
            return Err("Delivery Flush 只能提交 chat/thread_completion_ready Event".into());
        }
        let session_id = event
            .payload
            .get("session_id")
            .and_then(JsonValue::as_str)
            .ok_or("Delivery Flush Event 缺少 session_id")?;
        let generation = i64::try_from(generation)
            .map_err(|_| "Delivery Flush generation 超出 SQLite INTEGER 范围")?;
        let mut tx = self.pool.begin().await?;
        let timer = sqlx::query(
            "SELECT generation, kind, owner_id, status FROM runtime_timers WHERE id = ?",
        )
        .bind(timer_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(timer) = timer else {
            tx.commit().await?;
            return Ok(DeliveryFlushCommit::Stale);
        };
        if timer.get::<i64, _>("generation") != generation
            || timer.get::<String, _>("kind") != "delivery_flush"
            || timer.get::<String, _>("owner_id") != session_id
            || timer.get::<String, _>("status") != "claimed"
        {
            tx.commit().await?;
            return Ok(DeliveryFlushCommit::Stale);
        }
        let has_pending = sqlx::query_scalar::<_, i64>(
            "SELECT EXISTS(SELECT 1 FROM threads WHERE session_id = ? AND delivery_status = 'pending')",
        )
        .bind(session_id)
        .fetch_one(&mut *tx)
        .await?
            != 0;
        if !has_pending {
            tx.commit().await?;
            return Ok(DeliveryFlushCommit::Empty);
        }

        let inserted = append_event_idempotent_in_transaction(&mut tx, event).await?;
        append_signal_outbox_in_transaction(&mut tx, event).await?;
        tx.commit().await?;
        Ok(if inserted {
            DeliveryFlushCommit::Committed
        } else {
            DeliveryFlushCommit::Existing {
                event_id: event.id.clone(),
            }
        })
    }

    async fn commit_delivery_flush_reply(
        &self,
        timer_id: &str,
        generation: u64,
        event: &Event,
    ) -> Result<DeliveryFlushCommit, Box<dyn std::error::Error + Send + Sync>> {
        if event.topic != "chat/reply" {
            return Err("Delivery Fast Path 只能提交 chat/reply Event".into());
        }
        let session_id = event
            .payload
            .get("session_id")
            .and_then(JsonValue::as_str)
            .ok_or("Delivery Fast Path Event 缺少 session_id")?;
        let covers = event
            .payload
            .get("covers")
            .and_then(JsonValue::as_array)
            .ok_or("Delivery Fast Path Event 缺少 covers")?
            .iter()
            .filter_map(JsonValue::as_str)
            .collect::<Vec<_>>();
        if covers.is_empty() {
            return Err("Delivery Fast Path 至少覆盖一个 Thread".into());
        }
        let generation = i64::try_from(generation)
            .map_err(|_| "Delivery Fast Path generation 超出 SQLite INTEGER 范围")?;
        let mut tx = self.pool.begin().await?;
        let timer = sqlx::query(
            "SELECT generation, kind, owner_id, status FROM runtime_timers WHERE id = ?",
        )
        .bind(timer_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(timer) = timer else {
            tx.commit().await?;
            return Ok(DeliveryFlushCommit::Stale);
        };
        if timer.get::<i64, _>("generation") != generation
            || timer.get::<String, _>("kind") != "delivery_flush"
            || timer.get::<String, _>("owner_id") != session_id
            || timer.get::<String, _>("status") != "claimed"
        {
            tx.commit().await?;
            return Ok(DeliveryFlushCommit::Stale);
        }
        if sqlx::query_scalar::<_, i64>("SELECT EXISTS(SELECT 1 FROM events WHERE id = ?)")
            .bind(&event.id)
            .fetch_one(&mut *tx)
            .await?
            != 0
        {
            tx.commit().await?;
            return Ok(DeliveryFlushCommit::Existing {
                event_id: event.id.clone(),
            });
        }

        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        for thread_id in covers {
            let updated = sqlx::query(
                "UPDATE threads SET revision = revision + 1, delivery_status = 'delivered', delivery_event_id = ?, updated_at = ? WHERE id = ? AND session_id = ? AND delivery_status IN ('pending', 'deferred')",
            )
            .bind(&event.id)
            .bind(&now)
            .bind(thread_id)
            .bind(session_id)
            .execute(&mut *tx)
            .await?;
            if updated.rows_affected() != 1 {
                tx.rollback().await?;
                return Ok(DeliveryFlushCommit::Stale);
            }
        }
        append_event_in_transaction(&mut tx, event).await?;
        let activity_at = event
            .timestamp
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query("UPDATE sessions SET updated_at = ?, last_activity_at = ? WHERE id = ?")
            .bind(&activity_at)
            .bind(&activity_at)
            .bind(session_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(DeliveryFlushCommit::Committed)
    }

    async fn update_thread(
        &self,
        id: &str,
        expected_revision: u64,
        kind: Option<ThreadKind>,
        lifecycle: Option<ThreadLifecycle>,
        result_text: Option<&str>,
        result_event_id: Option<&str>,
        delivery_status: Option<DeliveryStatus>,
        delivery_event_id: Option<&str>,
    ) -> Result<ThreadMutation, Box<dyn std::error::Error + Send + Sync>> {
        let expected_revision = i64::try_from(expected_revision)
            .map_err(|_| "Thread revision 超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE threads
               SET revision = revision + 1,
                   kind = COALESCE(?, kind),
                   status = COALESCE(?, status),
                   result_text = COALESCE(?, result_text),
                   result_event_id = COALESCE(?, result_event_id),
                   delivery_status = COALESCE(?, delivery_status),
                   delivery_event_id = COALESCE(?, delivery_event_id),
                   updated_at = ?
               WHERE id = ? AND revision = ?"#,
        )
        .bind(kind.map(ThreadKind::as_str))
        .bind(lifecycle.map(ThreadLifecycle::as_str))
        .bind(result_text)
        .bind(result_event_id)
        .bind(delivery_status.map(DeliveryStatus::as_str))
        .bind(delivery_event_id)
        .bind(now)
        .bind(id)
        .bind(expected_revision)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 1 {
            return Ok(ThreadMutation::Updated(
                self.get_thread(id).await?.ok_or("Thread 更新后无法读取")?,
            ));
        }
        Ok(match self.get_thread(id).await? {
            Some(current) => ThreadMutation::Conflict { current },
            None => ThreadMutation::NotFound,
        })
    }

    async fn bind_thread_target(
        &self,
        id: &str,
        expected_revision: u64,
        target_id: &str,
    ) -> Result<ThreadMutation, Box<dyn std::error::Error + Send + Sync>> {
        let expected_revision = i64::try_from(expected_revision)
            .map_err(|_| "Thread revision 超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE threads
               SET revision = revision + 1, target_id = ?, updated_at = ?
               WHERE id = ? AND revision = ? AND (target_id IS NULL OR target_id = ?)"#,
        )
        .bind(target_id)
        .bind(now)
        .bind(id)
        .bind(expected_revision)
        .bind(target_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 1 {
            return Ok(ThreadMutation::Updated(
                self.get_thread(id)
                    .await?
                    .ok_or("Thread Target 绑定后无法读取")?,
            ));
        }
        Ok(match self.get_thread(id).await? {
            Some(current) => ThreadMutation::Conflict { current },
            None => ThreadMutation::NotFound,
        })
    }
}

#[async_trait::async_trait]
impl ScheduleStore for SqliteStore {
    async fn ensure_schedule(
        &self,
        intent: NewSchedule,
    ) -> Result<ScheduleRecord, Box<dyn std::error::Error + Send + Sync>> {
        let interval_seconds = intent
            .interval_seconds
            .map(i64::try_from)
            .transpose()
            .map_err(|_| "Schedule interval 超出 SQLite INTEGER 范围")?;
        let not_before = intent
            .not_before
            .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
        let dependencies = serde_json::to_string(&intent.dependency_thread_ids)?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"INSERT OR IGNORE INTO schedules
               (id, revision, thread_id, source_turn_id, intent, status,
                not_before, interval_seconds, dependency_thread_ids_json,
                created_at, updated_at)
               VALUES (?, 1, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)"#,
        )
        .bind(&intent.id)
        .bind(&intent.thread_id)
        .bind(&intent.source_turn_id)
        .bind(&intent.intent)
        .bind(not_before)
        .bind(interval_seconds)
        .bind(&dependencies)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        for dependency_thread_id in &intent.dependency_thread_ids {
            sqlx::query(
                r#"INSERT OR IGNORE INTO schedule_dependencies
                   (schedule_id, dependency_thread_id)
                   SELECT ?, ?
                   WHERE EXISTS (
                     SELECT 1 FROM schedules
                     WHERE id = ? AND dependency_thread_ids_json = ?
                   )"#,
            )
            .bind(&intent.id)
            .bind(dependency_thread_id)
            .bind(&intent.id)
            .bind(&dependencies)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        let row = sqlx::query("SELECT * FROM schedules WHERE id = ?")
            .bind(&intent.id)
            .fetch_one(&self.pool)
            .await?;
        schedule_from_row(&row)
    }

    async fn get_schedule(
        &self,
        id: &str,
    ) -> Result<Option<ScheduleRecord>, Box<dyn std::error::Error + Send + Sync>> {
        sqlx::query("SELECT * FROM schedules WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(schedule_from_row)
            .transpose()
    }

    async fn inspect_schedule(
        &self,
        id: &str,
    ) -> Result<Option<ScheduleRecord>, Box<dyn std::error::Error + Send + Sync>> {
        self.get_schedule(id).await
    }

    async fn pause_schedule(
        &self,
        id: &str,
        expected_revision: u64,
    ) -> Result<ScheduleMutation, Box<dyn std::error::Error + Send + Sync>> {
        let revision = i64::try_from(expected_revision)
            .map_err(|_| "Schedule revision 超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut rows = sqlx::query(
            r#"UPDATE schedules
               SET status = 'paused', revision = revision + 1, updated_at = ?
               WHERE id = ? AND revision = ? AND status = 'queued'
               RETURNING *"#,
        )
        .bind(now)
        .bind(id)
        .bind(revision)
        .fetch_all(&self.pool)
        .await?;
        if let Some(row) = rows.pop() {
            return Ok(ScheduleMutation::Updated(schedule_from_row(&row)?));
        }
        schedule_mutation_failure(self, id, expected_revision, "只有 queued Schedule 可以暂停")
            .await
    }

    async fn resume_schedule(
        &self,
        id: &str,
        expected_revision: u64,
    ) -> Result<ScheduleMutation, Box<dyn std::error::Error + Send + Sync>> {
        let revision = i64::try_from(expected_revision)
            .map_err(|_| "Schedule revision 超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut rows = sqlx::query(
            r#"UPDATE schedules
               SET status = 'queued', revision = revision + 1, updated_at = ?
               WHERE id = ? AND revision = ? AND status = 'paused'
               RETURNING *"#,
        )
        .bind(now)
        .bind(id)
        .bind(revision)
        .fetch_all(&self.pool)
        .await?;
        if let Some(row) = rows.pop() {
            return Ok(ScheduleMutation::Updated(schedule_from_row(&row)?));
        }
        schedule_mutation_failure(self, id, expected_revision, "只有 paused Schedule 可以恢复")
            .await
    }

    async fn reschedule_schedule(
        &self,
        id: &str,
        expected_revision: u64,
        not_before: Option<DateTime<Utc>>,
        interval_seconds: Option<u64>,
    ) -> Result<ScheduleMutation, Box<dyn std::error::Error + Send + Sync>> {
        let revision = i64::try_from(expected_revision)
            .map_err(|_| "Schedule revision 超出 SQLite INTEGER 范围")?;
        let interval_seconds = interval_seconds
            .map(i64::try_from)
            .transpose()
            .map_err(|_| "Schedule interval 超出 SQLite INTEGER 范围")?;
        if interval_seconds == Some(0) {
            return Err("Schedule interval 必须大于 0".into());
        }
        let not_before =
            not_before.map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        // Paused rules keep their paused lifecycle while their timing rule is
        // edited. A dispatched one-shot is deliberately immutable: its wake
        // Event/Signal already exists and cannot be revoked by rewriting the
        // owner row. Dependency JSON and the reverse index are not touched by
        // this timing-only CAS, hence they cannot diverge through partial
        // writes.
        let mut rows = sqlx::query(
            r#"UPDATE schedules
               SET not_before = ?, interval_seconds = ?,
                   revision = revision + 1, updated_at = ?
               WHERE id = ? AND revision = ?
                 AND status IN ('queued', 'paused')
               RETURNING *"#,
        )
        .bind(not_before)
        .bind(interval_seconds)
        .bind(now)
        .bind(id)
        .bind(revision)
        .fetch_all(&self.pool)
        .await?;
        if let Some(row) = rows.pop() {
            return Ok(ScheduleMutation::Updated(schedule_from_row(&row)?));
        }
        schedule_mutation_failure(
            self,
            id,
            expected_revision,
            "只有尚未派发的 queued/paused Schedule 可以重新调度",
        )
        .await
    }

    async fn cancel_schedule(
        &self,
        id: &str,
        expected_revision: u64,
    ) -> Result<ScheduleMutation, Box<dyn std::error::Error + Send + Sync>> {
        let revision = i64::try_from(expected_revision)
            .map_err(|_| "Schedule revision 超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut rows = sqlx::query(
            r#"UPDATE schedules
               SET status = 'cancelled', revision = revision + 1, updated_at = ?
               WHERE id = ? AND revision = ?
                 AND status IN ('queued', 'paused')
               RETURNING *"#,
        )
        .bind(now)
        .bind(id)
        .bind(revision)
        .fetch_all(&self.pool)
        .await?;
        if let Some(row) = rows.pop() {
            return Ok(ScheduleMutation::Updated(schedule_from_row(&row)?));
        }
        schedule_mutation_failure(
            self,
            id,
            expected_revision,
            "只有尚未派发的 queued/paused Schedule 可以取消",
        )
        .await
    }

    async fn commit_schedule_transaction(
        &self,
        threads: &[NewThread],
        intents: &[NewSchedule],
    ) -> Result<Vec<ScheduleRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        for thread in threads {
            sqlx::query(
                r#"INSERT OR IGNORE INTO threads
                   (id, revision, agent_id, context_id, session_id, initiating_principal_id, root_turn_id,
                    kind, status, executor_kind, executor_id, delivery_status,
                    created_at, updated_at)
                   VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 'none', ?, ?)"#,
            )
            .bind(&thread.id)
            .bind(&thread.agent_id)
            .bind(&thread.context_id)
            .bind(&thread.session_id)
            .bind(&thread.initiating_principal_id)
            .bind(&thread.root_turn_id)
            .bind(thread.kind.as_str())
            .bind(&thread.executor_kind)
            .bind(&thread.executor_id)
            .bind(&now)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }
        for intent in intents {
            let target = sqlx::query("SELECT status FROM threads WHERE id = ?")
                .bind(&intent.thread_id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| format!("Schedule '{}' 的目标 Thread 不存在", intent.id))?;
            let target_status: String = target.get("status");
            if matches!(target_status.as_str(), "failed" | "cancelled") {
                return Err(format!(
                    "Schedule '{}' 不能写入状态为 '{}' 的 Thread",
                    intent.id, target_status
                )
                .into());
            }
            let interval_seconds = intent
                .interval_seconds
                .map(i64::try_from)
                .transpose()
                .map_err(|_| "Schedule interval 超出 SQLite INTEGER 范围")?;
            let not_before = intent
                .not_before
                .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
            let dependencies = serde_json::to_string(&intent.dependency_thread_ids)?;
            sqlx::query(
                r#"INSERT INTO schedules
                   (id, revision, thread_id, source_turn_id, intent, status,
                    not_before, interval_seconds, dependency_thread_ids_json,
                    created_at, updated_at)
                   VALUES (?, 1, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO NOTHING"#,
            )
            .bind(&intent.id)
            .bind(&intent.thread_id)
            .bind(&intent.source_turn_id)
            .bind(&intent.intent)
            .bind(not_before)
            .bind(interval_seconds)
            .bind(&dependencies)
            .bind(&now)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            for dependency_thread_id in &intent.dependency_thread_ids {
                sqlx::query(
                    r#"INSERT OR IGNORE INTO schedule_dependencies
                       (schedule_id, dependency_thread_id)
                       SELECT ?, ?
                       WHERE EXISTS (
                         SELECT 1 FROM schedules
                         WHERE id = ? AND dependency_thread_ids_json = ?
                       )"#,
                )
                .bind(&intent.id)
                .bind(dependency_thread_id)
                .bind(&intent.id)
                .bind(&dependencies)
                .execute(&mut *tx)
                .await?;
            }
        }
        tx.commit().await?;
        let mut records = Vec::with_capacity(intents.len());
        for intent in intents {
            records.push(
                self.get_schedule(&intent.id)
                    .await?
                    .ok_or_else(|| format!("Schedule '{}' 提交后不存在", intent.id))?,
            );
        }
        Ok(records)
    }

    async fn list_schedules(
        &self,
        thread_id: Option<&str>,
        status: Option<ScheduleStatus>,
    ) -> Result<Vec<ScheduleRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = match (thread_id, status) {
            (Some(thread_id), Some(status)) => {
                sqlx::query("SELECT * FROM schedules WHERE thread_id = ? AND status = ? ORDER BY COALESCE(not_before, created_at), id")
                    .bind(thread_id)
                    .bind(status.as_str())
                    .fetch_all(&self.pool)
                    .await?
            }
            (Some(thread_id), None) => {
                sqlx::query("SELECT * FROM schedules WHERE thread_id = ? ORDER BY COALESCE(not_before, created_at), id")
                    .bind(thread_id)
                    .fetch_all(&self.pool)
                    .await?
            }
            (None, Some(status)) => {
                sqlx::query("SELECT * FROM schedules WHERE status = ? ORDER BY COALESCE(not_before, created_at), id")
                    .bind(status.as_str())
                    .fetch_all(&self.pool)
                    .await?
            }
            (None, None) => {
                sqlx::query("SELECT * FROM schedules ORDER BY COALESCE(not_before, created_at), id")
                    .fetch_all(&self.pool)
                    .await?
            }
        };
        rows.iter().map(schedule_from_row).collect()
    }

    async fn list_context_schedules(
        &self,
        context_id: &str,
    ) -> Result<Vec<ScheduleRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = sqlx::query(
            r#"SELECT schedules.*
               FROM schedules
               INNER JOIN threads
                 ON threads.id = schedules.thread_id
               WHERE threads.context_id = ?
               ORDER BY COALESCE(schedules.not_before, schedules.created_at),
                        schedules.id"#,
        )
        .bind(context_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(schedule_from_row).collect()
    }

    async fn wake_schedules_for_dependency(
        &self,
        dependency_thread_id: &str,
    ) -> Result<Vec<ScheduleRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        // One write statement avoids the deferred-transaction read/write
        // upgrade race (`SQLITE_BUSY`) when multiple workers observe the same
        // terminal dependency concurrently. Each successful statement owns a
        // distinct revision generation; Timer/owner fencing suppresses all
        // but the newest occurrence.
        let rows = sqlx::query(
            r#"UPDATE schedules
               SET revision = revision + 1, updated_at = ?
               WHERE status = 'queued' AND id IN (
                 SELECT schedule_id
                 FROM schedule_dependencies
                 WHERE dependency_thread_id = ?
               )
               RETURNING *"#,
        )
        .bind(now)
        .bind(dependency_thread_id)
        .fetch_all(&self.pool)
        .await?;
        let mut records = rows
            .iter()
            .map(schedule_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        records.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(records)
    }

    async fn claim_schedule(
        &self,
        id: &str,
        expected_revision: u64,
        next_not_before: Option<DateTime<Utc>>,
    ) -> Result<Option<ScheduleRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let expected_revision = i64::try_from(expected_revision)
            .map_err(|_| "Schedule revision 超出 SQLite INTEGER 范围")?;
        let next_not_before =
            next_not_before.map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
        let next_status = if next_not_before.is_some() {
            ScheduleStatus::Queued
        } else {
            ScheduleStatus::Dispatched
        };
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            "UPDATE schedules SET revision = revision + 1, status = ?, not_before = COALESCE(?, not_before), updated_at = ? WHERE id = ? AND revision = ? AND status = 'queued'",
        )
        .bind(next_status.as_str())
        .bind(next_not_before)
        .bind(now)
        .bind(id)
        .bind(expected_revision)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Ok(None);
        }
        let row = sqlx::query("SELECT * FROM schedules WHERE id = ?")
            .bind(id)
            .fetch_one(&self.pool)
            .await?;
        Ok(Some(schedule_from_row(&row)?))
    }

    async fn commit_scheduled_dispatch(
        &self,
        id: &str,
        expected_revision: u64,
        next_not_before: Option<DateTime<Utc>>,
        event: &Event,
    ) -> Result<Option<ScheduleRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let expected_revision = i64::try_from(expected_revision)
            .map_err(|_| "Schedule revision 超出 SQLite INTEGER 范围")?;
        let next_not_before =
            next_not_before.map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
        let next_status = if next_not_before.is_some() {
            ScheduleStatus::Queued
        } else {
            ScheduleStatus::Dispatched
        };
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            "UPDATE schedules SET revision = revision + 1, status = ?, not_before = COALESCE(?, not_before), updated_at = ? WHERE id = ? AND revision = ? AND status = 'queued'",
        )
        .bind(next_status.as_str())
        .bind(next_not_before)
        .bind(&now)
        .bind(id)
        .bind(expected_revision)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() == 0 {
            tx.rollback().await?;
            return Ok(None);
        }
        append_event_in_transaction(&mut tx, event).await?;
        append_signal_outbox_in_transaction(&mut tx, event).await?;
        tx.commit().await?;
        self.get_schedule(id).await
    }
}

#[async_trait::async_trait]
impl DeliveryIngressStore for SqliteStore {
    async fn commit_thread_delivery(
        &self,
        thread_ids: &[String],
        event: &Event,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        if thread_ids.is_empty() {
            return Err("Thread delivery 至少覆盖一个 thread_id".into());
        }
        let session_id = event
            .payload
            .get("session_id")
            .and_then(JsonValue::as_str)
            .ok_or("Thread delivery Event 缺少 session_id")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        for thread_id in thread_ids {
            let result = sqlx::query(
                "UPDATE threads SET revision = revision + 1, delivery_status = 'delivered', delivery_event_id = ?, updated_at = ? WHERE id = ? AND session_id = ? AND delivery_status IN ('pending', 'deferred')",
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
        append_event_in_transaction(&mut tx, event).await?;
        tx.commit().await?;
        Ok(true)
    }

    async fn claim_message(
        &self,
        session_id: &str,
        client_message_id: &str,
        event: &Event,
    ) -> Result<MessageClaim, Box<dyn std::error::Error + Send + Sync>> {
        let session = self
            .get_session(session_id)
            .await?
            .ok_or_else(|| format!("Session '{}' 不存在", session_id))?;
        let event_session_id = event
            .payload
            .get("session_id")
            .and_then(|value| value.as_str())
            .ok_or("用户消息缺少 session_id")?;
        let event_context_id = event
            .payload
            .get("context_id")
            .and_then(|value| value.as_str())
            .ok_or("用户消息缺少 context_id")?;
        if event_session_id != session_id || event_context_id != session.context_id {
            return Err(format!(
                "消息路由与 Session Registry 不一致：请求 Session='{}'，Event Session='{}'，Event Context='{}'，Registry Context='{}'",
                session_id, event_session_id, event_context_id, session.context_id
            )
            .into());
        }
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            "INSERT OR IGNORE INTO session_message_requests (session_id, client_message_id, event_id, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(session_id)
        .bind(client_message_id)
        .bind(&event.id)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() == 1 {
            let timestamp = event
                .timestamp
                .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
            append_event_in_transaction(&mut tx, event).await?;
            append_signal_outbox_in_transaction(&mut tx, event).await?;
            sqlx::query("UPDATE sessions SET updated_at = ?, last_activity_at = ? WHERE id = ?")
                .bind(&timestamp)
                .bind(&timestamp)
                .bind(session_id)
                .execute(&mut *tx)
                .await?;
            let mount = sqlx::query(
                "SELECT attention_state, attention_revision FROM session_mounts WHERE session_id = ? AND context_id = ? AND unmounted_at IS NULL",
            )
            .bind(session_id)
            .bind(event_context_id)
            .fetch_one(&mut *tx)
            .await?;
            if mount.get::<String, _>("attention_state") == "retired" {
                let restore_event_id = format!("runtime_session_restored_{}", event.id);
                sqlx::query(
                    r#"UPDATE session_mounts
                       SET attention_state = 'active', attention_revision = attention_revision + 1,
                           attention_reason = 'new directed user message',
                           attention_changed_at = ?, attention_event_id = ?
                       WHERE session_id = ? AND context_id = ? AND unmounted_at IS NULL
                         AND attention_state = 'retired'"#,
                )
                .bind(&timestamp)
                .bind(&restore_event_id)
                .bind(session_id)
                .bind(event_context_id)
                .execute(&mut *tx)
                .await?;
                let restore = Event {
                    id: restore_event_id,
                    sequence: None,
                    timestamp: event.timestamp,
                    actor: "Runtime-SessionAttention".to_string(),
                    event_type: "runtime_control".to_string(),
                    topic: "runtime/session_restored".to_string(),
                    payload: [
                        (
                            "context_id".to_string(),
                            serde_json::json!(event_context_id),
                        ),
                        ("session_id".to_string(), serde_json::json!(session_id)),
                        ("trigger_event_id".to_string(), serde_json::json!(event.id)),
                        (
                            "trigger_kind".to_string(),
                            serde_json::json!("user_message"),
                        ),
                        (
                            "attention_revision".to_string(),
                            serde_json::json!(mount.get::<i64, _>("attention_revision") + 1),
                        ),
                    ]
                    .into_iter()
                    .collect(),
                };
                append_event_in_transaction(&mut tx, &restore).await?;
            }
            tx.commit().await?;
            return Ok(MessageClaim::Accepted);
        }
        let existing = sqlx::query(
            "SELECT event_id FROM session_message_requests WHERE session_id = ? AND client_message_id = ?",
        )
        .bind(session_id)
        .bind(client_message_id)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(MessageClaim::Existing {
            event_id: existing.get("event_id"),
        })
    }
}

#[async_trait::async_trait]
impl DelegationStore for SqliteStore {
    async fn create_delegation(
        &self,
        delegation: NewDelegation,
    ) -> Result<DelegationRecord, Box<dyn std::error::Error + Send + Sync>> {
        let parent = self
            .get_session(&delegation.parent_session_id)
            .await?
            .ok_or_else(|| format!("父 Session '{}' 不存在", delegation.parent_session_id))?;
        let child = self
            .get_session(&delegation.child_session_id)
            .await?
            .ok_or_else(|| format!("子 Session '{}' 不存在", delegation.child_session_id))?;
        if parent.context_id != delegation.parent_context_id
            || child.context_id != delegation.child_context_id
            || parent.agent_id != delegation.agent_id
            || child.agent_id != delegation.agent_id
        {
            return Err("Delegation 的 Agent/Context/Session 路由不一致".into());
        }
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            r#"INSERT INTO delegations
               (id, agent_id, parent_context_id, parent_session_id, child_context_id, child_session_id,
                initiating_principal_id, task, success_when, context_scope, status, result_event_id,
                created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?)"#,
        )
        .bind(&delegation.id)
        .bind(&delegation.agent_id)
        .bind(&delegation.parent_context_id)
        .bind(&delegation.parent_session_id)
        .bind(&delegation.child_context_id)
        .bind(&delegation.child_session_id)
        .bind(&delegation.initiating_principal_id)
        .bind(&delegation.task)
        .bind(&delegation.success_when)
        .bind(&delegation.context_scope)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        self.get_delegation(&delegation.id)
            .await?
            .ok_or_else(|| "Delegation 创建后无法读取".into())
    }

    async fn get_delegation(
        &self,
        id: &str,
    ) -> Result<Option<DelegationRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let row = sqlx::query(
            "SELECT id, agent_id, parent_context_id, parent_session_id, child_context_id, child_session_id, initiating_principal_id, task, success_when, context_scope, status, result_event_id, created_at, updated_at FROM delegations WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(delegation_from_row))
    }

    async fn get_delegation_by_child_session(
        &self,
        child_session_id: &str,
    ) -> Result<Option<DelegationRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let row = sqlx::query(
            "SELECT id, agent_id, parent_context_id, parent_session_id, child_context_id, child_session_id, initiating_principal_id, task, success_when, context_scope, status, result_event_id, created_at, updated_at FROM delegations WHERE child_session_id = ?",
        )
        .bind(child_session_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(delegation_from_row))
    }

    async fn list_delegations(
        &self,
    ) -> Result<Vec<DelegationRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = sqlx::query(
            "SELECT id, agent_id, parent_context_id, parent_session_id, child_context_id, child_session_id, initiating_principal_id, task, success_when, context_scope, status, result_event_id, created_at, updated_at FROM delegations ORDER BY updated_at DESC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(delegation_from_row).collect())
    }

    async fn update_delegation_status(
        &self,
        id: &str,
        status: DelegationStatus,
        result_event_id: Option<&str>,
    ) -> Result<Option<DelegationRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            "UPDATE delegations SET status = ?, result_event_id = COALESCE(?, result_event_id), updated_at = ? WHERE id = ?",
        )
        .bind(status.as_str())
        .bind(result_event_id)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Ok(None);
        }
        self.get_delegation(id).await
    }

    async fn commit_delegation_result(
        &self,
        id: &str,
        event: &Event,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let mut tx = self.pool.begin().await?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        // The first statement must be a write. Starting with SELECT creates a deferred read
        // snapshot which cannot always be upgraded while the child Activation is committing its
        // terminal outcome, yielding SQLITE_BUSY instead of honoring busy_timeout.
        let updated = sqlx::query(
            r#"UPDATE delegations
               SET status = 'completed', result_event_id = ?, updated_at = ?
               WHERE id = ? AND status IN ('queued', 'running')"#,
        )
        .bind(&event.id)
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            let exists =
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM delegations WHERE id = ?")
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await?
                    > 0;
            tx.commit().await?;
            return if exists {
                Ok(false)
            } else {
                Err(format!("Delegation '{id}' 不存在").into())
            };
        }
        let row = sqlx::query(
            "SELECT id, agent_id, parent_context_id, parent_session_id, child_context_id, child_session_id, initiating_principal_id, task, success_when, context_scope, status, result_event_id, created_at, updated_at FROM delegations WHERE id = ?",
        )
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        let delegation = delegation_from_row(&row);
        let event_context_id = event.payload.get("context_id").and_then(JsonValue::as_str);
        let event_session_id = event.payload.get("session_id").and_then(JsonValue::as_str);
        if event_context_id != Some(delegation.parent_context_id.as_str())
            || event_session_id != Some(delegation.parent_session_id.as_str())
        {
            tx.rollback().await?;
            return Err(
                format!("Delegation '{id}' 结果 Event 路由到错误的父 Context/Session").into(),
            );
        }
        append_event_idempotent_in_transaction(&mut tx, event).await?;
        append_signal_outbox_in_transaction(&mut tx, event).await?;
        tx.commit().await?;
        Ok(true)
    }
}

const OBJECTIVE_SELECT: &str = r#"SELECT id, agent_id, context_id,
    coordinator_session_id, delivery_session_id, parent_objective_id, source_event_id,
    initiating_principal_id, stated_objective, revision, status, status_reason, wait_condition_json, active_evaluation_id,
    evaluation_lease_expires_at, continuation_sequence, token_budget, tokens_used,
    time_used_seconds, created_at, updated_at
    FROM objectives"#;

fn validate_stated_objective(
    stated_objective: &str,
) -> Result<&str, Box<dyn std::error::Error + Send + Sync>> {
    let stated_objective = stated_objective.trim();
    if stated_objective.is_empty() {
        return Err("Objective 目标不能为空".into());
    }
    if stated_objective.chars().count() > 1_000_000 {
        return Err("Objective 目标超过 1,000,000 字符上限".into());
    }
    Ok(stated_objective)
}

async fn validate_new_objective(
    store: &SqliteStore,
    objective: &NewObjective,
) -> Result<(String, Option<i64>), Box<dyn std::error::Error + Send + Sync>> {
    let stated_objective = validate_stated_objective(&objective.stated_objective)?.to_string();
    let context = store
        .get_context(&objective.context_id)
        .await?
        .ok_or_else(|| format!("Objective Context '{}' 不存在", objective.context_id))?;
    let coordinator = store
        .get_session(&objective.coordinator_session_id)
        .await?
        .ok_or_else(|| {
            format!(
                "Objective 协调 Session '{}' 不存在",
                objective.coordinator_session_id
            )
        })?;
    let delivery = store
        .get_session(&objective.delivery_session_id)
        .await?
        .ok_or_else(|| {
            format!(
                "Objective 交付 Session '{}' 不存在",
                objective.delivery_session_id
            )
        })?;
    if context.agent_id != objective.agent_id
        || coordinator.agent_id != objective.agent_id
        || delivery.agent_id != objective.agent_id
        || coordinator.context_id != objective.context_id
        || delivery.context_id != objective.context_id
    {
        return Err("Objective 的 Agent/Context/Session 路由不一致".into());
    }
    if let Some(parent_id) = objective.parent_objective_id.as_deref() {
        let parent = store
            .get_objective(parent_id)
            .await?
            .ok_or_else(|| format!("父 Objective '{parent_id}' 不存在"))?;
        if parent.agent_id != objective.agent_id {
            return Err(format!(
                "父 Objective '{parent_id}' 属于 Agent '{}'，不能挂到 Agent '{}'",
                parent.agent_id, objective.agent_id
            )
            .into());
        }
    }
    let token_budget = objective
        .token_budget
        .map(i64::try_from)
        .transpose()
        .map_err(|_| "Objective token budget 超出 SQLite INTEGER 范围")?;
    Ok((stated_objective, token_budget))
}

async fn insert_new_objective_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    objective: &NewObjective,
    stated_objective: &str,
    token_budget: Option<i64>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    sqlx::query(
        r#"INSERT INTO objectives
           (id, agent_id, context_id, coordinator_session_id, delivery_session_id,
            parent_objective_id, source_event_id, initiating_principal_id, stated_objective, revision, status,
            wait_condition_json, active_evaluation_id, evaluation_lease_expires_at,
            continuation_sequence, token_budget, tokens_used, time_used_seconds,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', NULL, NULL, NULL, 0, ?, 0, 0, ?, ?)"#,
    )
    .bind(&objective.id)
    .bind(&objective.agent_id)
    .bind(&objective.context_id)
    .bind(&objective.coordinator_session_id)
    .bind(&objective.delivery_session_id)
    .bind(&objective.parent_objective_id)
    .bind(&objective.source_event_id)
    .bind(&objective.initiating_principal_id)
    .bind(stated_objective)
    .bind(token_budget)
    .bind(&now)
    .bind(&now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[async_trait::async_trait]
impl ObjectiveStore for SqliteStore {
    async fn create_objective(
        &self,
        objective: NewObjective,
    ) -> Result<ObjectiveRecord, Box<dyn std::error::Error + Send + Sync>> {
        let (stated_objective, token_budget) = validate_new_objective(self, &objective).await?;
        let mut tx = self.pool.begin().await?;
        insert_new_objective_in_transaction(&mut tx, &objective, &stated_objective, token_budget)
            .await?;
        tx.commit().await?;
        self.get_objective(&objective.id)
            .await?
            .ok_or_else(|| "Objective 创建后无法读取".into())
    }

    async fn create_objective_with_events(
        &self,
        objective: NewObjective,
        events: Vec<Event>,
    ) -> Result<ObjectiveRecord, Box<dyn std::error::Error + Send + Sync>> {
        let (stated_objective, token_budget) = validate_new_objective(self, &objective).await?;
        let mut tx = self.pool.begin().await?;
        insert_new_objective_in_transaction(&mut tx, &objective, &stated_objective, token_budget)
            .await?;
        for event in &events {
            append_event_in_transaction(&mut tx, event).await?;
        }
        tx.commit().await?;
        self.get_objective(&objective.id)
            .await?
            .ok_or_else(|| "Objective 与初始化事件提交后无法读取".into())
    }

    async fn get_objective(
        &self,
        id: &str,
    ) -> Result<Option<ObjectiveRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let row = sqlx::query(&format!("{OBJECTIVE_SELECT} WHERE id = ?"))
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(objective_from_row).transpose()
    }

    async fn list_context_objectives(
        &self,
        context_id: &str,
        include_terminal: bool,
    ) -> Result<Vec<ObjectiveRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let sql = if include_terminal {
            format!("{OBJECTIVE_SELECT} WHERE context_id = ? ORDER BY updated_at DESC")
        } else {
            format!(
                "{OBJECTIVE_SELECT} WHERE context_id = ? AND status NOT IN ('completed', 'cancelled', 'failed') ORDER BY updated_at DESC"
            )
        };
        let rows = sqlx::query(&sql)
            .bind(context_id)
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(objective_from_row).collect()
    }

    async fn list_recoverable_objectives(
        &self,
    ) -> Result<Vec<ObjectiveRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = sqlx::query(&format!(
            "{OBJECTIVE_SELECT} WHERE status IN ('active', 'paused', 'blocked') OR active_evaluation_id IS NOT NULL ORDER BY updated_at"
        ))
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(objective_from_row).collect()
    }

    async fn edit_objective(
        &self,
        id: &str,
        expected_revision: u64,
        stated_objective: &str,
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>> {
        let stated_objective = validate_stated_objective(stated_objective)?;
        let Some(current) = self.get_objective(id).await? else {
            return Ok(ObjectiveMutation::NotFound);
        };
        if current.revision != expected_revision {
            return Ok(ObjectiveMutation::Conflict { current });
        }
        if current.status.is_terminal() {
            return Err(format!("终态 Objective '{id}' 不能再修改目标").into());
        }
        let expected_revision = i64::try_from(expected_revision)
            .map_err(|_| "Objective revision 超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            "UPDATE objectives SET stated_objective = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
        )
        .bind(stated_objective)
        .bind(now)
        .bind(id)
        .bind(expected_revision)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 1 {
            return Ok(ObjectiveMutation::Updated(
                self.get_objective(id)
                    .await?
                    .ok_or("Objective 更新后无法读取")?,
            ));
        }
        Ok(match self.get_objective(id).await? {
            Some(current) => ObjectiveMutation::Conflict { current },
            None => ObjectiveMutation::NotFound,
        })
    }

    async fn update_objective_state(
        &self,
        id: &str,
        expected_revision: u64,
        status: ObjectiveStatus,
        wait_condition: Option<ObjectiveWaitCondition>,
        reason: Option<&str>,
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>> {
        let Some(current) = self.get_objective(id).await? else {
            return Ok(ObjectiveMutation::NotFound);
        };
        if current.revision != expected_revision {
            return Ok(ObjectiveMutation::Conflict { current });
        }
        if !current.status.can_transition_to(status) {
            return Err(format!(
                "Objective '{id}' 不允许从 '{}' 迁移到 '{}'",
                current.status.as_str(),
                status.as_str()
            )
            .into());
        }
        if status != ObjectiveStatus::Active && wait_condition.is_some() {
            return Err("只有 active Objective 可以携带等待条件".into());
        }
        let expected_revision = i64::try_from(expected_revision)
            .map_err(|_| "Objective revision 超出 SQLite INTEGER 范围")?;
        let wait_condition_json = wait_condition
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE objectives
               SET status = ?, status_reason = ?, wait_condition_json = ?,
                   revision = revision + 1, updated_at = ?
               WHERE id = ? AND revision = ?"#,
        )
        .bind(status.as_str())
        .bind(reason)
        .bind(wait_condition_json)
        .bind(now)
        .bind(id)
        .bind(expected_revision)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 1 {
            return Ok(ObjectiveMutation::Updated(
                self.get_objective(id)
                    .await?
                    .ok_or("Objective 状态更新后无法读取")?,
            ));
        }
        Ok(match self.get_objective(id).await? {
            Some(current) => ObjectiveMutation::Conflict { current },
            None => ObjectiveMutation::NotFound,
        })
    }

    async fn claim_objective_evaluation(
        &self,
        id: &str,
        expected_revision: u64,
        evaluation_id: &str,
        lease_expires_at: DateTime<Utc>,
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>> {
        if evaluation_id.trim().is_empty() {
            return Err("Objective Evaluation ID 不能为空".into());
        }
        let Some(current) = self.get_objective(id).await? else {
            return Ok(ObjectiveMutation::NotFound);
        };
        if current.revision != expected_revision
            || current.status != ObjectiveStatus::Active
            || current.wait_condition.is_some()
            || current
                .evaluation_lease_expires_at
                .is_some_and(|expires_at| expires_at > Utc::now())
        {
            return Ok(ObjectiveMutation::Conflict { current });
        }
        let expected_revision = i64::try_from(expected_revision)
            .map_err(|_| "Objective revision 超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let lease_expires_at = lease_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE objectives
               SET active_evaluation_id = ?, evaluation_lease_expires_at = ?,
                   continuation_sequence = continuation_sequence + 1,
                   revision = revision + 1, updated_at = ?
               WHERE id = ? AND revision = ? AND status = 'active'
                 AND wait_condition_json IS NULL
                 AND (active_evaluation_id IS NULL OR evaluation_lease_expires_at <= ?)"#,
        )
        .bind(evaluation_id)
        .bind(lease_expires_at)
        .bind(&now)
        .bind(id)
        .bind(expected_revision)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 1 {
            return Ok(ObjectiveMutation::Updated(
                self.get_objective(id)
                    .await?
                    .ok_or("Objective Evaluation 租约提交后无法读取")?,
            ));
        }
        Ok(match self.get_objective(id).await? {
            Some(current) => ObjectiveMutation::Conflict { current },
            None => ObjectiveMutation::NotFound,
        })
    }

    async fn claim_objective_evaluation_with_signal(
        &self,
        id: &str,
        expected_revision: u64,
        evaluation_id: &str,
        lease_expires_at: DateTime<Utc>,
        event: &Event,
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>> {
        if evaluation_id.trim().is_empty() {
            return Err("Objective Evaluation ID 不能为空".into());
        }
        let Some(current) = self.get_objective(id).await? else {
            return Ok(ObjectiveMutation::NotFound);
        };
        if current.revision != expected_revision
            || current.status != ObjectiveStatus::Active
            || current.wait_condition.is_some()
            || current
                .evaluation_lease_expires_at
                .is_some_and(|expires_at| expires_at > Utc::now())
        {
            return Ok(ObjectiveMutation::Conflict { current });
        }
        let event_context_id = event.payload.get("context_id").and_then(JsonValue::as_str);
        let event_session_id = event.payload.get("session_id").and_then(JsonValue::as_str);
        let event_objective_id = event
            .payload
            .get("objective_id")
            .and_then(JsonValue::as_str);
        let event_evaluation_id = event
            .payload
            .get("objective_evaluation_id")
            .and_then(JsonValue::as_str);
        if event_context_id != Some(current.context_id.as_str())
            || event_session_id != Some(current.coordinator_session_id.as_str())
            || event_objective_id != Some(id)
            || event_evaluation_id != Some(evaluation_id)
        {
            return Err(format!("Objective '{id}' continuation Event 路由不一致").into());
        }
        let expected_revision = i64::try_from(expected_revision)
            .map_err(|_| "Objective revision 超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let lease_expires_at = lease_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        let updated = sqlx::query(
            r#"UPDATE objectives
               SET active_evaluation_id = ?, evaluation_lease_expires_at = ?,
                   continuation_sequence = continuation_sequence + 1,
                   revision = revision + 1, updated_at = ?
               WHERE id = ? AND revision = ? AND status = 'active'
                 AND wait_condition_json IS NULL
                 AND (active_evaluation_id IS NULL OR evaluation_lease_expires_at <= ?)"#,
        )
        .bind(evaluation_id)
        .bind(lease_expires_at)
        .bind(&now)
        .bind(id)
        .bind(expected_revision)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(match self.get_objective(id).await? {
                Some(current) => ObjectiveMutation::Conflict { current },
                None => ObjectiveMutation::NotFound,
            });
        }
        append_event_idempotent_in_transaction(&mut tx, event).await?;
        append_signal_outbox_in_transaction(&mut tx, event).await?;
        tx.commit().await?;
        Ok(ObjectiveMutation::Updated(
            self.get_objective(id)
                .await?
                .ok_or("Objective Evaluation + Signal 提交后无法读取")?,
        ))
    }

    async fn finish_objective_evaluation(
        &self,
        id: &str,
        evaluation_id: &str,
        tokens_used: u64,
        time_used_seconds: u64,
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>> {
        let Some(current) = self.get_objective(id).await? else {
            return Ok(ObjectiveMutation::NotFound);
        };
        if current.active_evaluation_id.as_deref() != Some(evaluation_id) {
            return Ok(ObjectiveMutation::Conflict { current });
        }
        let revision = i64::try_from(current.revision)
            .map_err(|_| "Objective revision 超出 SQLite INTEGER 范围")?;
        let tokens_used = i64::try_from(tokens_used)
            .map_err(|_| "Objective token 增量超出 SQLite INTEGER 范围")?;
        let time_used_seconds = i64::try_from(time_used_seconds)
            .map_err(|_| "Objective time 增量超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE objectives
               SET active_evaluation_id = NULL, evaluation_lease_expires_at = NULL,
                   tokens_used = tokens_used + ?, time_used_seconds = time_used_seconds + ?,
                   revision = revision + 1, updated_at = ?
               WHERE id = ? AND revision = ? AND active_evaluation_id = ?"#,
        )
        .bind(tokens_used)
        .bind(time_used_seconds)
        .bind(now)
        .bind(id)
        .bind(revision)
        .bind(evaluation_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 1 {
            return Ok(ObjectiveMutation::Updated(
                self.get_objective(id)
                    .await?
                    .ok_or("Objective Evaluation 结束后无法读取")?,
            ));
        }
        Ok(match self.get_objective(id).await? {
            Some(current) => ObjectiveMutation::Conflict { current },
            None => ObjectiveMutation::NotFound,
        })
    }

    async fn renew_objective_evaluation(
        &self,
        id: &str,
        evaluation_id: &str,
        lease_expires_at: DateTime<Utc>,
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>> {
        if evaluation_id.trim().is_empty() {
            return Err("Objective Evaluation ID 不能为空".into());
        }
        if lease_expires_at <= Utc::now() {
            return Err("Objective Evaluation 续租时间必须在未来".into());
        }
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let lease_expires_at = lease_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE objectives
               SET evaluation_lease_expires_at = ?, updated_at = ?
               WHERE id = ? AND status = 'active' AND wait_condition_json IS NULL
                 AND active_evaluation_id = ?"#,
        )
        .bind(lease_expires_at)
        .bind(now)
        .bind(id)
        .bind(evaluation_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 1 {
            return Ok(ObjectiveMutation::Updated(
                self.get_objective(id)
                    .await?
                    .ok_or("Objective Evaluation 续租后无法读取")?,
            ));
        }
        Ok(match self.get_objective(id).await? {
            Some(current) => ObjectiveMutation::Conflict { current },
            None => ObjectiveMutation::NotFound,
        })
    }

    async fn record_objective_evaluation_usage(
        &self,
        id: &str,
        evaluation_id: &str,
        prompt_tokens_used: u64,
    ) -> Result<ObjectiveMutation, Box<dyn std::error::Error + Send + Sync>> {
        let prompt_tokens_used = i64::try_from(prompt_tokens_used)
            .map_err(|_| "Objective token 增量超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE objectives
               SET tokens_used = tokens_used + ?, updated_at = ?
               WHERE id = ? AND status = 'active' AND active_evaluation_id = ?"#,
        )
        .bind(prompt_tokens_used)
        .bind(now)
        .bind(id)
        .bind(evaluation_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 1 {
            return Ok(ObjectiveMutation::Updated(
                self.get_objective(id)
                    .await?
                    .ok_or("Objective Evaluation 记账后无法读取")?,
            ));
        }
        Ok(match self.get_objective(id).await? {
            Some(current) => ObjectiveMutation::Conflict { current },
            None => ObjectiveMutation::NotFound,
        })
    }
}

fn parse_time(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&Utc))
        .expect("Morphz 数据库时间戳必须是 RFC3339")
}

async fn execution_job_mutation_failure(
    store: &SqliteStore,
    id: &str,
    expected_revision: u64,
    reason: impl Into<String>,
) -> Result<ExecutionJobMutation, Box<dyn std::error::Error + Send + Sync>> {
    Ok(match store.get_execution_job(id).await? {
        Some(current) if current.revision != expected_revision => {
            ExecutionJobMutation::Conflict { current }
        }
        Some(current) => ExecutionJobMutation::Rejected {
            current,
            reason: reason.into(),
        },
        None => ExecutionJobMutation::NotFound,
    })
}

#[async_trait::async_trait]
impl TimerStore for SqliteStore {
    async fn upsert_runtime_timer(
        &self,
        timer: NewRuntimeTimer,
    ) -> Result<RuntimeTimerRecord, Box<dyn std::error::Error + Send + Sync>> {
        if timer.id.trim().is_empty() || timer.owner_id.trim().is_empty() {
            return Err("Runtime Timer id/owner_id 不能为空".into());
        }
        let generation = i64::try_from(timer.generation)
            .map_err(|_| "Runtime Timer generation 超出 SQLite INTEGER 范围")?;
        let due_at = timer
            .due_at
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let payload_json = serde_json::to_string(&timer.payload)?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            r#"INSERT INTO runtime_timers
               (id, generation, kind, owner_id, due_at, status, payload_json,
                created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 generation = excluded.generation,
                 kind = excluded.kind,
                 owner_id = excluded.owner_id,
                 due_at = excluded.due_at,
                 status = 'pending',
                 payload_json = excluded.payload_json,
                 claimed_by = NULL,
                 claim_expires_at = NULL,
                 last_error = NULL,
                 updated_at = excluded.updated_at,
                 fired_at = NULL
               WHERE excluded.generation > runtime_timers.generation
                  OR (excluded.generation = runtime_timers.generation
                      AND runtime_timers.status = 'cancelled')"#,
        )
        .bind(&timer.id)
        .bind(generation)
        .bind(timer.kind.as_str())
        .bind(&timer.owner_id)
        .bind(due_at)
        .bind(payload_json)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        self.get_runtime_timer(&timer.id)
            .await?
            .ok_or_else(|| format!("Runtime Timer '{}' upsert 后不存在", timer.id).into())
    }

    async fn get_runtime_timer(
        &self,
        id: &str,
    ) -> Result<Option<RuntimeTimerRecord>, Box<dyn std::error::Error + Send + Sync>> {
        sqlx::query("SELECT * FROM runtime_timers WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(runtime_timer_from_row)
            .transpose()
    }

    async fn list_runtime_timers(
        &self,
        status: Option<RuntimeTimerStatus>,
    ) -> Result<Vec<RuntimeTimerRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = if let Some(status) = status {
            sqlx::query("SELECT * FROM runtime_timers WHERE status = ? ORDER BY due_at, id")
                .bind(status.as_str())
                .fetch_all(&self.pool)
                .await?
        } else {
            sqlx::query("SELECT * FROM runtime_timers ORDER BY due_at, id")
                .fetch_all(&self.pool)
                .await?
        };
        rows.iter().map(runtime_timer_from_row).collect()
    }

    async fn next_runtime_timer_due_at(
        &self,
    ) -> Result<Option<DateTime<Utc>>, Box<dyn std::error::Error + Send + Sync>> {
        let due_at = sqlx::query_scalar::<_, Option<String>>(
            r#"SELECT MIN(
                   CASE WHEN status = 'pending' THEN due_at ELSE claim_expires_at END
               )
               FROM runtime_timers
               WHERE status = 'pending'
                  OR (status = 'claimed' AND claim_expires_at IS NOT NULL)"#,
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(due_at.as_deref().map(parse_time))
    }

    async fn claim_due_runtime_timers(
        &self,
        now: DateTime<Utc>,
        claim_token: &str,
        claim_expires_at: DateTime<Utc>,
        limit: usize,
    ) -> Result<Vec<RuntimeTimerRecord>, Box<dyn std::error::Error + Send + Sync>> {
        if claim_token.trim().is_empty() {
            return Err("Runtime Timer claim token 不能为空".into());
        }
        if limit == 0 {
            return Ok(Vec::new());
        }
        let limit = i64::try_from(limit)
            .map_err(|_| "Runtime Timer claim limit 超出 SQLite INTEGER 范围")?;
        let now = now.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let claim_expires_at = claim_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"UPDATE runtime_timers
               SET status = 'claimed', claimed_by = ?, claim_expires_at = ?, updated_at = ?
               WHERE id IN (
                 SELECT id FROM runtime_timers
                 WHERE (status = 'pending' AND due_at <= ?)
                    OR (status = 'claimed' AND claim_expires_at <= ?)
                 ORDER BY CASE WHEN status = 'pending' THEN due_at ELSE claim_expires_at END, id
                 LIMIT ?
               )
               AND ((status = 'pending' AND due_at <= ?)
                 OR (status = 'claimed' AND claim_expires_at <= ?))"#,
        )
        .bind(claim_token)
        .bind(&claim_expires_at)
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .bind(limit)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let rows = sqlx::query(
            "SELECT * FROM runtime_timers WHERE status = 'claimed' AND claimed_by = ? ORDER BY due_at, id",
        )
        .bind(claim_token)
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        rows.iter().map(runtime_timer_from_row).collect()
    }

    async fn complete_runtime_timer(
        &self,
        id: &str,
        generation: u64,
        claim_token: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let generation = i64::try_from(generation)
            .map_err(|_| "Runtime Timer generation 超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE runtime_timers
               SET status = 'fired', claimed_by = NULL, claim_expires_at = NULL,
                   last_error = NULL, updated_at = ?, fired_at = ?
               WHERE id = ? AND generation = ? AND status = 'claimed' AND claimed_by = ?"#,
        )
        .bind(&now)
        .bind(&now)
        .bind(id)
        .bind(generation)
        .bind(claim_token)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    async fn retry_runtime_timer(
        &self,
        id: &str,
        generation: u64,
        claim_token: &str,
        due_at: DateTime<Utc>,
        error: Option<&str>,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let generation = i64::try_from(generation)
            .map_err(|_| "Runtime Timer generation 超出 SQLite INTEGER 范围")?;
        let due_at = due_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let error = error.map(|value| value.chars().take(10_000).collect::<String>());
        let result = sqlx::query(
            r#"UPDATE runtime_timers
               SET status = 'pending', due_at = ?, claimed_by = NULL,
                   claim_expires_at = NULL, last_error = ?, updated_at = ?
               WHERE id = ? AND generation = ? AND status = 'claimed' AND claimed_by = ?"#,
        )
        .bind(due_at)
        .bind(error)
        .bind(now)
        .bind(id)
        .bind(generation)
        .bind(claim_token)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    async fn cancel_runtime_timer(
        &self,
        id: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE runtime_timers
               SET status = 'cancelled', claimed_by = NULL, claim_expires_at = NULL,
                   updated_at = ?
               WHERE id = ? AND status = 'pending'"#,
        )
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }
}

#[async_trait::async_trait]
impl ActionGroupStore for SqliteStore {
    async fn create_action_group(
        &self,
        group: NewActionGroup,
        members: Vec<NewActionGroupMember>,
    ) -> Result<ActionGroupRecord, Box<dyn std::error::Error + Send + Sync>> {
        if members.len() < 2 {
            return Err("Action Group 至少需要两个成员；单 Action 应直接使用 ExecutionJob".into());
        }
        for (field, value) in [
            ("id", group.id.as_str()),
            ("activation_id", group.activation_id.as_str()),
            ("thread_id", group.thread_id.as_str()),
            ("agent_id", group.agent_id.as_str()),
            ("context_id", group.context_id.as_str()),
            ("session_id", group.session_id.as_str()),
            (
                "assistant_call_event_id",
                group.assistant_call_event_id.as_str(),
            ),
        ] {
            if value.trim().is_empty() {
                return Err(format!("Action Group {field} 不能为空").into());
            }
        }
        let mut seen_calls = std::collections::HashSet::new();
        let mut seen_ordinals = std::collections::HashSet::new();
        for member in &members {
            if member.tool_call_id.trim().is_empty() || member.tool_name.trim().is_empty() {
                return Err("Action Group member tool_call_id/tool_name 不能为空".into());
            }
            if !seen_calls.insert(member.tool_call_id.as_str())
                || !seen_ordinals.insert(member.ordinal)
            {
                return Err("Action Group member 的 tool_call_id/ordinal 必须唯一".into());
            }
        }
        let member_count = i64::try_from(members.len())
            .map_err(|_| "Action Group member 数量超出 SQLite INTEGER 范围")?;
        let objective_revision = group
            .objective_revision
            .map(i64::try_from)
            .transpose()
            .map_err(|_| "Action Group Objective revision 超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        let inserted = sqlx::query(
            r#"INSERT OR IGNORE INTO action_groups
               (id, revision, activation_id, thread_id, agent_id, context_id, session_id,
                assistant_call_event_id, objective_id, objective_evaluation_id,
                objective_revision, status, member_count, terminal_member_count,
                created_at, updated_at, settled_at)
               VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, 0, ?, ?, NULL)"#,
        )
        .bind(&group.id)
        .bind(&group.activation_id)
        .bind(&group.thread_id)
        .bind(&group.agent_id)
        .bind(&group.context_id)
        .bind(&group.session_id)
        .bind(&group.assistant_call_event_id)
        .bind(&group.objective_id)
        .bind(&group.objective_evaluation_id)
        .bind(objective_revision)
        .bind(member_count)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        if inserted.rows_affected() == 1 {
            for member in &members {
                let ordinal = i64::try_from(member.ordinal)
                    .map_err(|_| "Action Group ordinal 超出 SQLite INTEGER 范围")?;
                sqlx::query(
                    r#"INSERT INTO action_group_members
                       (group_id, ordinal, tool_call_id, tool_name, execution_job_id,
                        status, result_event_id, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?)"#,
                )
                .bind(&group.id)
                .bind(ordinal)
                .bind(&member.tool_call_id)
                .bind(&member.tool_name)
                .bind(&member.execution_job_id)
                .bind(&now)
                .bind(&now)
                .execute(&mut *tx)
                .await?;
            }
        }
        let row = sqlx::query("SELECT * FROM action_groups WHERE id = ?")
            .bind(&group.id)
            .fetch_one(&mut *tx)
            .await?;
        let current = action_group_from_row(&row)?;
        let current_members = sqlx::query(
            "SELECT * FROM action_group_members WHERE group_id = ? ORDER BY ordinal, tool_call_id",
        )
        .bind(&group.id)
        .fetch_all(&mut *tx)
        .await?
        .iter()
        .map(action_group_member_from_row)
        .collect::<Result<Vec<_>, _>>()?;
        let exact_group = current.activation_id == group.activation_id
            && current.thread_id == group.thread_id
            && current.agent_id == group.agent_id
            && current.context_id == group.context_id
            && current.session_id == group.session_id
            && current.assistant_call_event_id == group.assistant_call_event_id
            && current.objective_id == group.objective_id
            && current.objective_evaluation_id == group.objective_evaluation_id
            && current.objective_revision == group.objective_revision;
        let exact_members = current_members.len() == members.len()
            && current_members
                .iter()
                .zip(members.iter())
                .all(|(current, requested)| {
                    current.ordinal == requested.ordinal
                        && current.tool_call_id == requested.tool_call_id
                        && current.tool_name == requested.tool_name
                        && current.execution_job_id == requested.execution_job_id
                });
        if !exact_group || !exact_members {
            tx.rollback().await?;
            return Err(format!("Action Group '{}' 的确定性身份被不同内容复用", group.id).into());
        }
        tx.commit().await?;
        Ok(current)
    }

    async fn get_action_group(
        &self,
        id: &str,
    ) -> Result<Option<ActionGroupRecord>, Box<dyn std::error::Error + Send + Sync>> {
        sqlx::query("SELECT * FROM action_groups WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(action_group_from_row)
            .transpose()
    }

    async fn list_action_groups(
        &self,
        filter: ActionGroupFilter,
    ) -> Result<Vec<ActionGroupRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let mut query = QueryBuilder::new("SELECT * FROM action_groups WHERE 1=1");
        if let Some(context_id) = filter.context_id {
            query.push(" AND context_id = ").push_bind(context_id);
        }
        if let Some(session_id) = filter.session_id {
            query.push(" AND session_id = ").push_bind(session_id);
        }
        if let Some(activation_id) = filter.activation_id {
            query.push(" AND activation_id = ").push_bind(activation_id);
        }
        if let Some(status) = filter.status {
            query.push(" AND status = ").push_bind(status.as_str());
        } else if !filter.include_terminal {
            query.push(" AND status = 'running'");
        }
        query.push(if filter.newest_first {
            " ORDER BY created_at DESC, id DESC"
        } else {
            " ORDER BY created_at, id"
        });
        if let Some(limit) = filter.limit {
            query.push(" LIMIT ").push_bind(i64::try_from(limit)?);
        }
        query
            .build()
            .fetch_all(&self.pool)
            .await?
            .iter()
            .map(action_group_from_row)
            .collect()
    }

    async fn list_action_group_members(
        &self,
        group_id: &str,
    ) -> Result<Vec<ActionGroupMemberRecord>, Box<dyn std::error::Error + Send + Sync>> {
        sqlx::query(
            "SELECT * FROM action_group_members WHERE group_id = ? ORDER BY ordinal, tool_call_id",
        )
        .bind(group_id)
        .fetch_all(&self.pool)
        .await?
        .iter()
        .map(action_group_member_from_row)
        .collect()
    }

    async fn commit_action_group_member_result(
        &self,
        group_id: &str,
        tool_call_id: &str,
        status: ActionGroupMemberStatus,
        result_event: &Event,
        settled_event: &Event,
    ) -> Result<ActionGroupMemberCommit, Box<dyn std::error::Error + Send + Sync>> {
        if !status.is_terminal() {
            return Err("Action Group member 只能提交终态结果".into());
        }
        if result_event
            .payload
            .get("action_group_id")
            .and_then(JsonValue::as_str)
            != Some(group_id)
            || result_event
                .payload
                .get("tool_call_id")
                .and_then(JsonValue::as_str)
                != Some(tool_call_id)
        {
            return Err("Action Group member 结果 Event 的 group/tool_call 路由不匹配".into());
        }
        if settled_event
            .payload
            .get("action_group_id")
            .and_then(JsonValue::as_str)
            != Some(group_id)
            || settled_event.topic != "runtime/action_group_settled"
        {
            return Err("Action Group settled Event 的路由或 topic 不匹配".into());
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE action_groups SET revision = revision WHERE id = ?")
            .bind(group_id)
            .execute(&mut *tx)
            .await?;
        let group_row = sqlx::query("SELECT * FROM action_groups WHERE id = ?")
            .bind(group_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| format!("Action Group '{group_id}' 不存在"))?;
        let mut group = action_group_from_row(&group_row)?;
        let member_row = sqlx::query(
            "SELECT * FROM action_group_members WHERE group_id = ? AND tool_call_id = ?",
        )
        .bind(group_id)
        .bind(tool_call_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| format!("Action Group '{group_id}' 不包含调用 '{tool_call_id}'"))?;
        let mut member = action_group_member_from_row(&member_row)?;
        append_event_idempotent_in_transaction(&mut tx, result_event).await?;
        if member.status.is_terminal() {
            if member.status != status
                || member.result_event_id.as_deref() != Some(&result_event.id)
            {
                tx.rollback().await?;
                return Err(format!(
                    "Action Group '{}' member '{}' 已由不同结果终结",
                    group_id, tool_call_id
                )
                .into());
            }
            tx.commit().await?;
            return Ok(ActionGroupMemberCommit {
                group,
                member,
                settled_now: false,
                existing: true,
            });
        }
        if group.status != ActionGroupStatus::Running {
            tx.rollback().await?;
            return Err(format!(
                "Action Group '{}' 已是 {}，不能再接收成员结果",
                group_id,
                group.status.as_str()
            )
            .into());
        }
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            r#"UPDATE action_group_members
               SET status = ?, result_event_id = ?, updated_at = ?
               WHERE group_id = ? AND tool_call_id = ? AND status = 'pending'"#,
        )
        .bind(status.as_str())
        .bind(&result_event.id)
        .bind(&now)
        .bind(group_id)
        .bind(tool_call_id)
        .execute(&mut *tx)
        .await?;
        let terminal_member_count = group.terminal_member_count.saturating_add(1);
        let settled_now = terminal_member_count == group.member_count;
        if settled_now {
            append_event_idempotent_in_transaction(&mut tx, settled_event).await?;
            append_signal_outbox_in_transaction(&mut tx, settled_event).await?;
            sqlx::query(
                r#"UPDATE action_groups
                   SET revision = revision + 1, status = 'settled',
                       terminal_member_count = ?, updated_at = ?, settled_at = ?
                   WHERE id = ? AND status = 'running'"#,
            )
            .bind(i64::try_from(terminal_member_count)?)
            .bind(&now)
            .bind(&now)
            .bind(group_id)
            .execute(&mut *tx)
            .await?;
        } else {
            sqlx::query(
                r#"UPDATE action_groups
                   SET revision = revision + 1, terminal_member_count = ?, updated_at = ?
                   WHERE id = ? AND status = 'running'"#,
            )
            .bind(i64::try_from(terminal_member_count)?)
            .bind(&now)
            .bind(group_id)
            .execute(&mut *tx)
            .await?;
        }
        let group_row = sqlx::query("SELECT * FROM action_groups WHERE id = ?")
            .bind(group_id)
            .fetch_one(&mut *tx)
            .await?;
        group = action_group_from_row(&group_row)?;
        let member_row = sqlx::query(
            "SELECT * FROM action_group_members WHERE group_id = ? AND tool_call_id = ?",
        )
        .bind(group_id)
        .bind(tool_call_id)
        .fetch_one(&mut *tx)
        .await?;
        member = action_group_member_from_row(&member_row)?;
        tx.commit().await?;
        Ok(ActionGroupMemberCommit {
            group,
            member,
            settled_now,
            existing: false,
        })
    }
}

fn validate_execution_target_registration(
    registration: &ExecutionTargetRegistration,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if registration.id.trim().is_empty() || registration.name.trim().is_empty() {
        return Err("Execution Target id/name 不能为空".into());
    }
    if !registration.metadata.is_object() {
        return Err("Execution Target metadata 必须是 JSON object".into());
    }
    fn contains_secret(value: &JsonValue) -> bool {
        match value {
            JsonValue::Object(object) => object.iter().any(|(key, value)| {
                matches!(
                    key.to_ascii_lowercase().as_str(),
                    "token"
                        | "api_key"
                        | "apikey"
                        | "password"
                        | "private_key"
                        | "secret"
                        | "credential"
                ) || contains_secret(value)
            }),
            JsonValue::Array(values) => values.iter().any(contains_secret),
            _ => false,
        }
    }
    if contains_secret(&registration.metadata) {
        return Err("Execution Target metadata 禁止包含凭证值".into());
    }
    if registration
        .capabilities
        .iter()
        .any(|capability| capability.trim().is_empty())
    {
        return Err("Execution Target capability 不能为空".into());
    }
    Ok(())
}

#[async_trait::async_trait]
impl ExecutionTargetStore for SqliteStore {
    async fn register_execution_target(
        &self,
        mut registration: ExecutionTargetRegistration,
    ) -> Result<ExecutionTargetRecord, Box<dyn std::error::Error + Send + Sync>> {
        validate_execution_target_registration(&registration)?;
        registration.capabilities.sort();
        registration.capabilities.dedup();
        let capabilities_json = serde_json::to_string(&registration.capabilities)?;
        let metadata_json = serde_json::to_string(&registration.metadata)?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let last_seen_at = registration
            .last_seen_at
            .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));

        let mut tx = self.pool.begin().await?;
        let inserted = sqlx::query(
            r#"INSERT OR IGNORE INTO execution_targets
               (id, revision, owner_principal_id, provider_node_id, kind, name, status,
                platform, workspace_root, capabilities_json, metadata_json, policy_digest,
                created_at, updated_at, last_seen_at)
               VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&registration.id)
        .bind(&registration.owner_principal_id)
        .bind(&registration.provider_node_id)
        .bind(registration.kind.as_str())
        .bind(&registration.name)
        .bind(registration.status.as_str())
        .bind(&registration.platform)
        .bind(&registration.workspace_root)
        .bind(&capabilities_json)
        .bind(&metadata_json)
        .bind(&registration.policy_digest)
        .bind(&now)
        .bind(&now)
        .bind(&last_seen_at)
        .execute(&mut *tx)
        .await?;

        let row = sqlx::query("SELECT * FROM execution_targets WHERE id = ?")
            .bind(&registration.id)
            .fetch_one(&mut *tx)
            .await?;
        let current = execution_target_from_row(&row)?;
        if inserted.rows_affected() == 0 {
            if current.kind != registration.kind
                || current.owner_principal_id != registration.owner_principal_id
            {
                return Err(format!(
                    "Execution Target '{}' 已被不同 kind/owner 占用",
                    registration.id
                )
                .into());
            }
            // A durable administrative disable cannot be undone by a stale
            // provider heartbeat. Re-enable requires the CAS control method.
            if current.status == ExecutionTargetStatus::Disabled
                && registration.status != ExecutionTargetStatus::Disabled
            {
                tx.commit().await?;
                return Ok(current);
            }
            let descriptor_changed = current.provider_node_id != registration.provider_node_id
                || current.name != registration.name
                || current.status != registration.status
                || current.platform != registration.platform
                || current.workspace_root != registration.workspace_root
                || current.capabilities != registration.capabilities
                || current.metadata != registration.metadata
                || current.policy_digest != registration.policy_digest;
            if descriptor_changed {
                sqlx::query(
                    r#"UPDATE execution_targets
                       SET revision = revision + 1, provider_node_id = ?, name = ?, status = ?,
                           platform = ?, workspace_root = ?, capabilities_json = ?,
                           metadata_json = ?, policy_digest = ?, updated_at = ?, last_seen_at = ?
                       WHERE id = ? AND revision = ?"#,
                )
                .bind(&registration.provider_node_id)
                .bind(&registration.name)
                .bind(registration.status.as_str())
                .bind(&registration.platform)
                .bind(&registration.workspace_root)
                .bind(&capabilities_json)
                .bind(&metadata_json)
                .bind(&registration.policy_digest)
                .bind(&now)
                .bind(&last_seen_at)
                .bind(&registration.id)
                .bind(i64::try_from(current.revision)?)
                .execute(&mut *tx)
                .await?;
            } else if last_seen_at.is_some() {
                sqlx::query("UPDATE execution_targets SET last_seen_at = ? WHERE id = ?")
                    .bind(&last_seen_at)
                    .bind(&registration.id)
                    .execute(&mut *tx)
                    .await?;
            }
        }
        let row = sqlx::query("SELECT * FROM execution_targets WHERE id = ?")
            .bind(&registration.id)
            .fetch_one(&mut *tx)
            .await?;
        let target = execution_target_from_row(&row)?;
        tx.commit().await?;
        Ok(target)
    }

    async fn get_execution_target(
        &self,
        id: &str,
    ) -> Result<Option<ExecutionTargetRecord>, Box<dyn std::error::Error + Send + Sync>> {
        sqlx::query("SELECT * FROM execution_targets WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(execution_target_from_row)
            .transpose()
    }

    async fn list_execution_targets(
        &self,
        filter: ExecutionTargetFilter,
    ) -> Result<Vec<ExecutionTargetRecord>, Box<dyn std::error::Error + Send + Sync>> {
        if filter.limit == Some(0) {
            return Ok(Vec::new());
        }
        let mut query =
            QueryBuilder::<sqlx::Sqlite>::new("SELECT * FROM execution_targets WHERE 1=1");
        if let Some(owner) = filter.owner_principal_id {
            query.push(" AND owner_principal_id = ").push_bind(owner);
        }
        if let Some(provider) = filter.provider_node_id {
            query.push(" AND provider_node_id = ").push_bind(provider);
        }
        if let Some(status) = filter.status {
            query.push(" AND status = ").push_bind(status.as_str());
        }
        query.push(" ORDER BY updated_at DESC, id");
        if let Some(limit) = filter.limit {
            query
                .push(" LIMIT ")
                .push_bind(i64::try_from(limit).map_err(|_| "Target 查询上限过大")?);
        }
        let rows = query.build().fetch_all(&self.pool).await?;
        rows.iter().map(execution_target_from_row).collect()
    }

    async fn set_execution_target_status(
        &self,
        id: &str,
        expected_revision: u64,
        status: ExecutionTargetStatus,
    ) -> Result<ExecutionTargetMutation, Box<dyn std::error::Error + Send + Sync>> {
        let Some(current) = self.get_execution_target(id).await? else {
            return Ok(ExecutionTargetMutation::NotFound);
        };
        if current.revision != expected_revision {
            return Ok(ExecutionTargetMutation::Conflict { current });
        }
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let updated = sqlx::query(
            "UPDATE execution_targets SET revision = revision + 1, status = ?, updated_at = ? WHERE id = ? AND revision = ?",
        )
        .bind(status.as_str())
        .bind(&now)
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .execute(&self.pool)
        .await?;
        let current = self
            .get_execution_target(id)
            .await?
            .ok_or("Execution Target 在状态更新后消失")?;
        if updated.rows_affected() == 1 {
            Ok(ExecutionTargetMutation::Updated(current))
        } else {
            Ok(ExecutionTargetMutation::Conflict { current })
        }
    }
}

#[async_trait::async_trait]
impl ExecutionTargetAuthorizationStore for SqliteStore {
    async fn authorize_execution_target(
        &self,
        authorization: NewExecutionTargetAuthorization,
    ) -> Result<ExecutionTargetAuthorizationMutation, Box<dyn std::error::Error + Send + Sync>>
    {
        if authorization.id.trim().is_empty()
            || authorization.target_id.trim().is_empty()
            || authorization.owner_principal_id.trim().is_empty()
            || authorization.scope_id.trim().is_empty()
        {
            return Err("Execution Target authorization 字段不能为空".into());
        }
        let mut tx = self.pool.begin().await?;
        let target = sqlx::query("SELECT owner_principal_id FROM execution_targets WHERE id = ?")
            .bind(&authorization.target_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or("Execution Target 不存在")?;
        if target
            .get::<Option<String>, _>("owner_principal_id")
            .as_deref()
            != Some(authorization.owner_principal_id.as_str())
        {
            return Err("只有 Target 所有者可以创建 scoped authorization".into());
        }
        let existing = sqlx::query(
            r#"SELECT * FROM execution_target_authorizations
               WHERE target_id = ? AND owner_principal_id = ? AND scope = ? AND scope_id = ?"#,
        )
        .bind(&authorization.target_id)
        .bind(&authorization.owner_principal_id)
        .bind(authorization.scope.as_str())
        .bind(&authorization.scope_id)
        .fetch_optional(&mut *tx)
        .await?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        if let Some(row) = existing {
            let current = execution_target_authorization_from_row(&row)?;
            if current.status == ExecutionTargetAuthorizationStatus::Active {
                tx.commit().await?;
                return Ok(ExecutionTargetAuthorizationMutation::Existing(current));
            }
            let updated = sqlx::query(
                r#"UPDATE execution_target_authorizations
                   SET revision = revision + 1, status = 'active', updated_at = ?,
                       revoked_at = NULL, revoke_reason = NULL
                   WHERE id = ? AND revision = ?"#,
            )
            .bind(&now)
            .bind(&current.id)
            .bind(i64::try_from(current.revision)?)
            .execute(&mut *tx)
            .await?;
            let row = sqlx::query("SELECT * FROM execution_target_authorizations WHERE id = ?")
                .bind(&current.id)
                .fetch_one(&mut *tx)
                .await?;
            let latest = execution_target_authorization_from_row(&row)?;
            tx.commit().await?;
            return Ok(if updated.rows_affected() == 1 {
                ExecutionTargetAuthorizationMutation::Updated(latest)
            } else {
                ExecutionTargetAuthorizationMutation::Conflict { current: latest }
            });
        }
        sqlx::query(
            r#"INSERT INTO execution_target_authorizations
               (id, revision, target_id, owner_principal_id, scope, scope_id, status,
                created_at, updated_at)
               VALUES (?, 1, ?, ?, ?, ?, 'active', ?, ?)"#,
        )
        .bind(&authorization.id)
        .bind(&authorization.target_id)
        .bind(&authorization.owner_principal_id)
        .bind(authorization.scope.as_str())
        .bind(&authorization.scope_id)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let row = sqlx::query("SELECT * FROM execution_target_authorizations WHERE id = ?")
            .bind(&authorization.id)
            .fetch_one(&mut *tx)
            .await?;
        let created = execution_target_authorization_from_row(&row)?;
        tx.commit().await?;
        Ok(ExecutionTargetAuthorizationMutation::Created(created))
    }

    async fn get_execution_target_authorization(
        &self,
        id: &str,
    ) -> Result<Option<ExecutionTargetAuthorizationRecord>, Box<dyn std::error::Error + Send + Sync>>
    {
        sqlx::query("SELECT * FROM execution_target_authorizations WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(execution_target_authorization_from_row)
            .transpose()
    }

    async fn list_execution_target_authorizations(
        &self,
        filter: ExecutionTargetAuthorizationFilter,
    ) -> Result<Vec<ExecutionTargetAuthorizationRecord>, Box<dyn std::error::Error + Send + Sync>>
    {
        if filter.limit == Some(0) {
            return Ok(Vec::new());
        }
        let mut query = QueryBuilder::<sqlx::Sqlite>::new(
            "SELECT * FROM execution_target_authorizations WHERE 1=1",
        );
        if let Some(target_id) = filter.target_id {
            query.push(" AND target_id = ").push_bind(target_id);
        }
        if let Some(owner) = filter.owner_principal_id {
            query.push(" AND owner_principal_id = ").push_bind(owner);
        }
        if let Some(scope) = filter.scope {
            query.push(" AND scope = ").push_bind(scope.as_str());
        }
        if let Some(scope_id) = filter.scope_id {
            query.push(" AND scope_id = ").push_bind(scope_id);
        }
        if filter.active_only {
            query.push(" AND status = 'active'");
        }
        query.push(" ORDER BY updated_at DESC, id");
        if let Some(limit) = filter.limit {
            query.push(" LIMIT ").push_bind(i64::try_from(limit)?);
        }
        let rows = query.build().fetch_all(&self.pool).await?;
        rows.iter()
            .map(execution_target_authorization_from_row)
            .collect()
    }

    async fn revoke_execution_target_authorization(
        &self,
        id: &str,
        expected_revision: u64,
        reason: &str,
    ) -> Result<ExecutionTargetAuthorizationMutation, Box<dyn std::error::Error + Send + Sync>>
    {
        let Some(current) = self.get_execution_target_authorization(id).await? else {
            return Ok(ExecutionTargetAuthorizationMutation::NotFound);
        };
        if current.status == ExecutionTargetAuthorizationStatus::Revoked {
            return Ok(ExecutionTargetAuthorizationMutation::Existing(current));
        }
        if current.revision != expected_revision {
            return Ok(ExecutionTargetAuthorizationMutation::Conflict { current });
        }
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let updated = sqlx::query(
            r#"UPDATE execution_target_authorizations
               SET revision = revision + 1, status = 'revoked', updated_at = ?,
                   revoked_at = ?, revoke_reason = ?
               WHERE id = ? AND revision = ? AND status = 'active'"#,
        )
        .bind(&now)
        .bind(&now)
        .bind(reason)
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .execute(&self.pool)
        .await?;
        let current = self
            .get_execution_target_authorization(id)
            .await?
            .ok_or("Execution Target authorization 在撤销后消失")?;
        Ok(if updated.rows_affected() == 1 {
            ExecutionTargetAuthorizationMutation::Updated(current)
        } else {
            ExecutionTargetAuthorizationMutation::Conflict { current }
        })
    }

    async fn has_execution_target_authorization_history(
        &self,
        target_id: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        Ok(sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM execution_target_authorizations WHERE target_id = ?",
        )
        .bind(target_id)
        .fetch_one(&self.pool)
        .await?
            > 0)
    }
}

#[async_trait::async_trait]
impl EdgeExecutionStore for SqliteStore {
    async fn create_node_pairing_code(
        &self,
        pairing: NewNodePairingCode,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if pairing.code_hash.trim().is_empty() || pairing.owner_principal_id.trim().is_empty() {
            return Err("Node pairing code hash/owner 不能为空".into());
        }
        let now = Utc::now();
        if pairing.expires_at <= now {
            return Err("Node pairing code 必须在未来过期".into());
        }
        sqlx::query(
            "INSERT INTO execution_node_pairing_codes (code_hash, owner_principal_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(pairing.code_hash)
        .bind(pairing.owner_principal_id)
        .bind(pairing.expires_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
        .bind(now.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn pair_execution_node(
        &self,
        mut request: PairExecutionNode,
    ) -> Result<ExecutionNodeRecord, Box<dyn std::error::Error + Send + Sync>> {
        for (field, value) in [
            ("code_hash", request.code_hash.as_str()),
            ("node_id", request.node_id.as_str()),
            ("name", request.name.as_str()),
            (
                "device_key_fingerprint",
                request.device_key_fingerprint.as_str(),
            ),
            ("device_public_key", request.device_public_key.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(format!("Pair Execution Node {field} 不能为空").into());
            }
        }
        if !request.metadata.is_object() {
            return Err("Execution Node metadata 必须是 JSON object".into());
        }
        request.capabilities.sort();
        request.capabilities.dedup();
        let capabilities_json = serde_json::to_string(&request.capabilities)?;
        let metadata_json = serde_json::to_string(&request.metadata)?;
        let now = Utc::now();
        let now_text = now.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        let pairing = sqlx::query(
            "SELECT owner_principal_id, expires_at, consumed_at FROM execution_node_pairing_codes WHERE code_hash = ?",
        )
        .bind(&request.code_hash)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or("Node pairing code 无效")?;
        if pairing.get::<Option<String>, _>("consumed_at").is_some() {
            return Err("Node pairing code 已使用".into());
        }
        if parse_time(&pairing.get::<String, _>("expires_at")) <= now {
            return Err("Node pairing code 已过期".into());
        }
        let owner_principal_id: String = pairing.get("owner_principal_id");
        sqlx::query(
            r#"INSERT INTO execution_nodes
               (id, revision, owner_principal_id, name, status, device_key_fingerprint,
                device_public_key, device_token_hash, protocol_version, platform, capabilities_json,
                metadata_json, created_at, updated_at, last_seen_at)
               VALUES (?, 1, ?, ?, 'online', ?, ?, '', ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&request.node_id)
        .bind(owner_principal_id)
        .bind(&request.name)
        .bind(&request.device_key_fingerprint)
        .bind(&request.device_public_key)
        .bind(i64::from(request.protocol_version))
        .bind(&request.platform)
        .bind(capabilities_json)
        .bind(metadata_json)
        .bind(&now_text)
        .bind(&now_text)
        .bind(&now_text)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE execution_node_pairing_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL",
        )
        .bind(&now_text)
        .bind(&request.code_hash)
        .execute(&mut *tx)
        .await?;
        let row = sqlx::query("SELECT * FROM execution_nodes WHERE id = ?")
            .bind(&request.node_id)
            .fetch_one(&mut *tx)
            .await?;
        let node = execution_node_from_row(&row)?;
        tx.commit().await?;
        Ok(node)
    }

    async fn create_execution_node_challenge(
        &self,
        challenge: NewExecutionNodeChallenge,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if challenge.id.trim().is_empty()
            || challenge.node_id.trim().is_empty()
            || challenge.nonce_hash.trim().is_empty()
            || challenge.expires_at <= Utc::now()
        {
            return Err("Execution Node challenge 参数无效".into());
        }
        let inserted = sqlx::query(
            r#"INSERT INTO execution_node_challenges
               (id, node_id, nonce_hash, expires_at, created_at)
               SELECT ?, ?, ?, ?, ? WHERE EXISTS (
                 SELECT 1 FROM execution_nodes WHERE id = ? AND status <> 'revoked'
               )"#,
        )
        .bind(&challenge.id)
        .bind(&challenge.node_id)
        .bind(&challenge.nonce_hash)
        .bind(challenge.expires_at.to_rfc3339())
        .bind(Utc::now().to_rfc3339())
        .bind(&challenge.node_id)
        .execute(&self.pool)
        .await?;
        if inserted.rows_affected() != 1 {
            return Err("Execution Node 不存在或已撤销".into());
        }
        Ok(())
    }

    async fn consume_execution_node_challenge(
        &self,
        node_id: &str,
        challenge_id: &str,
        nonce_hash: &str,
    ) -> Result<Option<ExecutionNodeRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool.begin().await?;
        let updated = sqlx::query(
            r#"UPDATE execution_node_challenges SET consumed_at = ?
               WHERE id = ? AND node_id = ? AND nonce_hash = ?
                 AND consumed_at IS NULL AND expires_at > ?"#,
        )
        .bind(&now)
        .bind(challenge_id)
        .bind(node_id)
        .bind(nonce_hash)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let node = if updated.rows_affected() == 1 {
            sqlx::query("SELECT * FROM execution_nodes WHERE id = ? AND status <> 'revoked'")
                .bind(node_id)
                .fetch_optional(&mut *tx)
                .await?
                .as_ref()
                .map(execution_node_from_row)
                .transpose()?
        } else {
            None
        };
        tx.commit().await?;
        Ok(node)
    }

    async fn issue_execution_node_connection_token(
        &self,
        node_id: &str,
        token_hash: &str,
        expires_at: DateTime<Utc>,
    ) -> Result<Option<ExecutionNodeRecord>, Box<dyn std::error::Error + Send + Sync>> {
        if token_hash.trim().is_empty() || expires_at <= Utc::now() {
            return Err("Execution Node connection token 参数无效".into());
        }
        sqlx::query(
            r#"UPDATE execution_nodes
               SET device_token_hash = ?, device_token_expires_at = ?
               WHERE id = ? AND status <> 'revoked'"#,
        )
        .bind(token_hash)
        .bind(expires_at.to_rfc3339())
        .bind(node_id)
        .execute(&self.pool)
        .await?;
        self.authenticate_execution_node(node_id, token_hash).await
    }

    async fn authenticate_execution_node(
        &self,
        node_id: &str,
        device_token_hash: &str,
    ) -> Result<Option<ExecutionNodeRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let row = sqlx::query(
            "SELECT * FROM execution_nodes WHERE id = ? AND device_token_hash = ? AND device_token_expires_at > ? AND status <> 'revoked'",
        )
        .bind(node_id)
        .bind(device_token_hash)
        .bind(Utc::now().to_rfc3339())
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref().map(execution_node_from_row).transpose()
    }

    async fn heartbeat_execution_node(
        &self,
        node_id: &str,
        platform: Option<String>,
        mut capabilities: Vec<String>,
        metadata: JsonValue,
    ) -> Result<Option<ExecutionNodeRecord>, Box<dyn std::error::Error + Send + Sync>> {
        if !metadata.is_object() {
            return Err("Execution Node metadata 必须是 JSON object".into());
        }
        capabilities.sort();
        capabilities.dedup();
        let Some(current_row) = sqlx::query("SELECT * FROM execution_nodes WHERE id = ?")
            .bind(node_id)
            .fetch_optional(&self.pool)
            .await?
        else {
            return Ok(None);
        };
        let current = execution_node_from_row(&current_row)?;
        if current.status == ExecutionNodeStatus::Revoked {
            return Ok(Some(current));
        }
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let changed = current.status != ExecutionNodeStatus::Online
            || current.platform != platform
            || current.capabilities != capabilities
            || current.metadata != metadata;
        let revision_delta = if changed { 1_i64 } else { 0_i64 };
        sqlx::query(
            r#"UPDATE execution_nodes SET revision = revision + ?, status = 'online',
               platform = ?, capabilities_json = ?, metadata_json = ?,
               updated_at = CASE WHEN ? THEN ? ELSE updated_at END, last_seen_at = ?
               WHERE id = ? AND status <> 'revoked'"#,
        )
        .bind(revision_delta)
        .bind(platform)
        .bind(serde_json::to_string(&capabilities)?)
        .bind(serde_json::to_string(&metadata)?)
        .bind(changed)
        .bind(&now)
        .bind(&now)
        .bind(node_id)
        .execute(&self.pool)
        .await?;
        let row = sqlx::query("SELECT * FROM execution_nodes WHERE id = ?")
            .bind(node_id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(execution_node_from_row).transpose()
    }

    async fn list_execution_nodes(
        &self,
        owner_principal_id: &str,
    ) -> Result<Vec<ExecutionNodeRecord>, Box<dyn std::error::Error + Send + Sync>> {
        sqlx::query(
            "SELECT * FROM execution_nodes WHERE owner_principal_id = ? ORDER BY updated_at DESC, id",
        )
        .bind(owner_principal_id)
        .fetch_all(&self.pool)
        .await?
        .iter()
        .map(execution_node_from_row)
        .collect()
    }

    async fn revoke_execution_node(
        &self,
        node_id: &str,
        owner_principal_id: &str,
        expected_revision: u64,
    ) -> Result<Option<ExecutionNodeRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            r#"UPDATE execution_nodes SET revision = revision + 1, status = 'revoked', updated_at = ?
               WHERE id = ? AND owner_principal_id = ? AND revision = ?"#,
        )
        .bind(now)
        .bind(node_id)
        .bind(owner_principal_id)
        .bind(i64::try_from(expected_revision)?)
        .execute(&self.pool)
        .await?;
        let row =
            sqlx::query("SELECT * FROM execution_nodes WHERE id = ? AND owner_principal_id = ?")
                .bind(node_id)
                .bind(owner_principal_id)
                .fetch_optional(&self.pool)
                .await?;
        row.as_ref().map(execution_node_from_row).transpose()
    }

    async fn rotate_execution_node_key(
        &self,
        node_id: &str,
        expected_revision: u64,
        device_key_fingerprint: &str,
        device_public_key: &str,
    ) -> Result<ExecutionNodeMutation, Box<dyn std::error::Error + Send + Sync>> {
        let row = sqlx::query("SELECT * FROM execution_nodes WHERE id = ?")
            .bind(node_id)
            .fetch_optional(&self.pool)
            .await?;
        let Some(row) = row else {
            return Ok(ExecutionNodeMutation::NotFound);
        };
        let current = execution_node_from_row(&row)?;
        if current.revision != expected_revision || current.status == ExecutionNodeStatus::Revoked {
            return Ok(ExecutionNodeMutation::Conflict { current });
        }
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let updated = sqlx::query(
            r#"UPDATE execution_nodes SET revision = revision + 1,
               device_key_fingerprint = ?, device_public_key = ?,
               device_token_hash = '', device_token_expires_at = NULL, updated_at = ?
               WHERE id = ? AND revision = ? AND status <> 'revoked'"#,
        )
        .bind(device_key_fingerprint)
        .bind(device_public_key)
        .bind(now)
        .bind(node_id)
        .bind(i64::try_from(expected_revision)?)
        .execute(&self.pool)
        .await?;
        let row = sqlx::query("SELECT * FROM execution_nodes WHERE id = ?")
            .bind(node_id)
            .fetch_one(&self.pool)
            .await?;
        let current = execution_node_from_row(&row)?;
        if updated.rows_affected() == 1 {
            Ok(ExecutionNodeMutation::Updated(current))
        } else {
            Ok(ExecutionNodeMutation::Conflict { current })
        }
    }

    async fn create_edge_command(
        &self,
        command: NewEdgeCommand,
    ) -> Result<EdgeCommandRecord, Box<dyn std::error::Error + Send + Sync>> {
        for (field, value) in [
            ("job_id", command.job_id.as_str()),
            ("target_id", command.target_id.as_str()),
            ("provider_node_id", command.provider_node_id.as_str()),
            ("tool_name", command.tool_name.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(format!("Edge Command {field} 不能为空").into());
            }
        }
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            r#"INSERT OR IGNORE INTO edge_execution_commands
               (job_id, revision, target_id, provider_node_id, tool_name, arguments, route_json,
                status, created_at, updated_at)
               VALUES (?, 1, ?, ?, ?, ?, ?, 'queued', ?, ?)"#,
        )
        .bind(&command.job_id)
        .bind(&command.target_id)
        .bind(&command.provider_node_id)
        .bind(&command.tool_name)
        .bind(&command.arguments)
        .bind(serde_json::to_string(&command.route)?)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        let row = sqlx::query("SELECT * FROM edge_execution_commands WHERE job_id = ?")
            .bind(&command.job_id)
            .fetch_one(&self.pool)
            .await?;
        let current = edge_command_from_row(&row)?;
        if current.target_id != command.target_id
            || current.provider_node_id != command.provider_node_id
            || current.tool_name != command.tool_name
            || current.arguments != command.arguments
            || current.route != command.route
        {
            return Err(format!(
                "Edge Command '{}' 的确定性身份被不同请求复用",
                command.job_id
            )
            .into());
        }
        Ok(current)
    }

    async fn get_edge_command(
        &self,
        job_id: &str,
    ) -> Result<Option<EdgeCommandRecord>, Box<dyn std::error::Error + Send + Sync>> {
        sqlx::query("SELECT * FROM edge_execution_commands WHERE job_id = ?")
            .bind(job_id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(edge_command_from_row)
            .transpose()
    }

    async fn claim_edge_command(
        &self,
        provider_node_id: &str,
        worker_id: &str,
        claim_token: &str,
        lease_expires_at: DateTime<Utc>,
        max_in_flight: usize,
    ) -> Result<Option<EdgeCommandRecord>, Box<dyn std::error::Error + Send + Sync>> {
        if max_in_flight == 0 {
            return Err("Edge Node max_in_flight 必须大于 0".into());
        }
        let now = Utc::now();
        let now_text = now.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let lease_text = lease_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"UPDATE edge_execution_commands
               SET revision = revision + 1,
                   status = CASE WHEN side_effect_started_at IS NULL THEN 'queued' ELSE 'lost' END,
                   claimed_by = CASE WHEN side_effect_started_at IS NULL THEN NULL ELSE claimed_by END,
                   claim_token = CASE WHEN side_effect_started_at IS NULL THEN NULL ELSE claim_token END,
                   lease_expires_at = CASE WHEN side_effect_started_at IS NULL THEN NULL ELSE lease_expires_at END,
                   finished_at = CASE WHEN side_effect_started_at IS NULL THEN NULL ELSE ? END,
                   error = CASE WHEN side_effect_started_at IS NULL THEN error ELSE 'Edge Worker lease expired after side-effect boundary' END,
                   updated_at = ?
               WHERE provider_node_id = ? AND status = 'claimed' AND lease_expires_at <= ?"#,
        )
        .bind(&now_text)
        .bind(&now_text)
        .bind(provider_node_id)
        .bind(&now_text)
        .execute(&mut *tx)
        .await?;
        let active = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM edge_execution_commands WHERE provider_node_id = ? AND status IN ('claimed', 'cancel_requested')",
        )
        .bind(provider_node_id)
        .fetch_one(&mut *tx)
        .await?;
        if usize::try_from(active)? >= max_in_flight {
            tx.commit().await?;
            return Ok(None);
        }
        let candidate = sqlx::query(
            r#"SELECT job_id, revision FROM edge_execution_commands
               WHERE provider_node_id = ? AND status = 'queued'
               ORDER BY created_at, job_id LIMIT 1"#,
        )
        .bind(provider_node_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(candidate) = candidate else {
            tx.commit().await?;
            return Ok(None);
        };
        let job_id: String = candidate.get("job_id");
        let revision: i64 = candidate.get("revision");
        let updated = sqlx::query(
            r#"UPDATE edge_execution_commands SET revision = revision + 1, status = 'claimed',
               claimed_by = ?, claim_token = ?, lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
               WHERE job_id = ? AND revision = ? AND status = 'queued'"#,
        )
        .bind(worker_id)
        .bind(claim_token)
        .bind(lease_text)
        .bind(&now_text)
        .bind(&now_text)
        .bind(&job_id)
        .bind(revision)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() == 0 {
            tx.commit().await?;
            return Ok(None);
        }
        let row = sqlx::query("SELECT * FROM edge_execution_commands WHERE job_id = ?")
            .bind(job_id)
            .fetch_one(&mut *tx)
            .await?;
        let command = edge_command_from_row(&row)?;
        tx.commit().await?;
        Ok(Some(command))
    }

    async fn heartbeat_edge_command(
        &self,
        job_id: &str,
        expected_revision: u64,
        claim_token: &str,
        lease_expires_at: DateTime<Utc>,
        side_effect_started: bool,
        progress: Option<String>,
    ) -> Result<EdgeCommandMutation, Box<dyn std::error::Error + Send + Sync>> {
        let Some(current) = self.get_edge_command(job_id).await? else {
            return Ok(EdgeCommandMutation::NotFound);
        };
        if current.revision != expected_revision
            || current.claim_token.as_deref() != Some(claim_token)
            || current.status != EdgeCommandStatus::Claimed
        {
            return Ok(EdgeCommandMutation::Conflict { current });
        }
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let updated = sqlx::query(
            r#"UPDATE edge_execution_commands SET revision = revision + 1,
               lease_expires_at = ?, heartbeat_at = ?,
               side_effect_started_at = CASE WHEN ? THEN COALESCE(side_effect_started_at, ?) ELSE side_effect_started_at END,
               progress = COALESCE(?, progress), updated_at = ?
               WHERE job_id = ? AND revision = ? AND status = 'claimed' AND claim_token = ?"#,
        )
        .bind(lease_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
        .bind(&now)
        .bind(side_effect_started)
        .bind(&now)
        .bind(progress)
        .bind(&now)
        .bind(job_id)
        .bind(i64::try_from(expected_revision)?)
        .bind(claim_token)
        .execute(&self.pool)
        .await?;
        let current = self
            .get_edge_command(job_id)
            .await?
            .ok_or("Edge Command 在 heartbeat 后消失")?;
        if updated.rows_affected() == 1 {
            Ok(EdgeCommandMutation::Updated(current))
        } else {
            Ok(EdgeCommandMutation::Conflict { current })
        }
    }

    async fn append_edge_command_output(
        &self,
        job_id: &str,
        claim_token: &str,
        stream: EdgeOutputStream,
        text: &str,
    ) -> Result<EdgeCommandOutputChunk, Box<dyn std::error::Error + Send + Sync>> {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let row = sqlx::query(
            r#"INSERT INTO edge_command_output_chunks
               (job_id, sequence, stream, text, created_at)
               SELECT ?, COALESCE((SELECT MAX(sequence) FROM edge_command_output_chunks WHERE job_id = ?), 0) + 1,
                      ?, ?, ?
               WHERE EXISTS (
                   SELECT 1 FROM edge_execution_commands
                   WHERE job_id = ? AND status = 'claimed' AND claim_token = ?
               )
               RETURNING *"#,
        )
        .bind(job_id)
        .bind(job_id)
        .bind(stream.as_str())
        .bind(text)
        .bind(now)
        .bind(job_id)
        .bind(claim_token)
        .fetch_optional(&self.pool)
        .await?;
        match row {
            Some(row) => edge_output_chunk_from_row(&row),
            None => Err(format!(
                "Edge Command '{}' 不存在、未处于 claimed，或 claim token 已失效",
                job_id
            )
            .into()),
        }
    }

    async fn list_edge_command_output(
        &self,
        job_id: &str,
        after_sequence: u64,
        limit: usize,
    ) -> Result<Vec<EdgeCommandOutputChunk>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = sqlx::query(
            r#"SELECT * FROM edge_command_output_chunks
               WHERE job_id = ? AND sequence > ?
               ORDER BY sequence ASC LIMIT ?"#,
        )
        .bind(job_id)
        .bind(i64::try_from(after_sequence)?)
        .bind(i64::try_from(limit.clamp(1, 1_000))?)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(edge_output_chunk_from_row).collect()
    }

    async fn finish_edge_command(
        &self,
        job_id: &str,
        expected_revision: u64,
        claim_token: &str,
        status: EdgeCommandStatus,
        output: Option<String>,
        error: Option<String>,
    ) -> Result<EdgeCommandMutation, Box<dyn std::error::Error + Send + Sync>> {
        if !status.is_terminal() {
            return Err("finish Edge Command 只接受终态".into());
        }
        let Some(current) = self.get_edge_command(job_id).await? else {
            return Ok(EdgeCommandMutation::NotFound);
        };
        if current.revision != expected_revision
            || current.claim_token.as_deref() != Some(claim_token)
            || !matches!(
                current.status,
                EdgeCommandStatus::Claimed | EdgeCommandStatus::CancelRequested
            )
        {
            return Ok(EdgeCommandMutation::Conflict { current });
        }
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let updated = sqlx::query(
            r#"UPDATE edge_execution_commands SET revision = revision + 1, status = ?, output = ?,
               error = ?, updated_at = ?, finished_at = ?
               WHERE job_id = ? AND revision = ? AND claim_token = ?
                 AND status IN ('claimed', 'cancel_requested')"#,
        )
        .bind(status.as_str())
        .bind(output)
        .bind(error)
        .bind(&now)
        .bind(&now)
        .bind(job_id)
        .bind(i64::try_from(expected_revision)?)
        .bind(claim_token)
        .execute(&self.pool)
        .await?;
        let current = self
            .get_edge_command(job_id)
            .await?
            .ok_or("Edge Command 在终态提交后消失")?;
        if updated.rows_affected() == 1 {
            Ok(EdgeCommandMutation::Updated(current))
        } else {
            Ok(EdgeCommandMutation::Conflict { current })
        }
    }

    async fn request_edge_command_cancel(
        &self,
        job_id: &str,
    ) -> Result<Option<EdgeCommandRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            r#"UPDATE edge_execution_commands SET revision = revision + 1,
               status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE 'cancel_requested' END,
               finished_at = CASE WHEN status = 'queued' THEN ? ELSE finished_at END,
               updated_at = ? WHERE job_id = ? AND status IN ('queued', 'claimed')"#,
        )
        .bind(&now)
        .bind(&now)
        .bind(job_id)
        .execute(&self.pool)
        .await?;
        self.get_edge_command(job_id).await
    }

    async fn reconcile_edge_execution(
        &self,
        now: DateTime<Utc>,
        node_stale_before: DateTime<Utc>,
    ) -> Result<EdgeReconciliationReport, Box<dyn std::error::Error + Send + Sync>> {
        let now = now.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let stale_before = node_stale_before.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut tx = self.pool.begin().await?;
        let nodes = sqlx::query(
            r#"UPDATE execution_nodes SET revision = revision + 1, status = 'offline', updated_at = ?
               WHERE status = 'online' AND (last_seen_at IS NULL OR last_seen_at < ?)"#,
        )
        .bind(&now)
        .bind(&stale_before)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        let targets = sqlx::query(
            r#"UPDATE execution_targets SET revision = revision + 1, status = 'offline', updated_at = ?
               WHERE status = 'online' AND provider_node_id IN (
                   SELECT id FROM execution_nodes WHERE status IN ('offline', 'revoked')
               )"#,
        )
        .bind(&now)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        let requeued = sqlx::query(
            r#"UPDATE edge_execution_commands SET revision = revision + 1, status = 'queued',
               claimed_by = NULL, claim_token = NULL, lease_expires_at = NULL,
               heartbeat_at = NULL, updated_at = ?
               WHERE status = 'claimed' AND lease_expires_at <= ?
                 AND side_effect_started_at IS NULL"#,
        )
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        let lost = sqlx::query(
            r#"UPDATE edge_execution_commands SET revision = revision + 1, status = 'lost',
               error = 'Edge Worker lease expired after side-effect boundary or cancellation request',
               finished_at = ?, updated_at = ?
               WHERE lease_expires_at <= ? AND (
                   (status = 'claimed' AND side_effect_started_at IS NOT NULL)
                   OR status = 'cancel_requested'
               )"#,
        )
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        tx.commit().await?;
        Ok(EdgeReconciliationReport {
            nodes_marked_offline: nodes,
            targets_marked_offline: targets,
            commands_requeued: requeued,
            commands_marked_lost: lost,
        })
    }
}

fn validate_new_execution_job(
    job: &NewExecutionJob,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    for (field, value) in [
        ("id", job.id.as_str()),
        ("activation_id", job.activation_id.as_str()),
        ("thread_id", job.thread_id.as_str()),
        ("agent_id", job.agent_id.as_str()),
        ("context_id", job.context_id.as_str()),
        ("session_id", job.session_id.as_str()),
        ("target_id", job.target_id.as_str()),
        ("tool_call_id", job.tool_call_id.as_str()),
        ("tool_name", job.tool_name.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(format!("Execution Job {field} 不能为空").into());
        }
    }
    Ok(())
}

async fn ensure_execution_job_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    job: &NewExecutionJob,
) -> Result<(ExecutionJobRecord, bool), Box<dyn std::error::Error + Send + Sync>> {
    validate_new_execution_job(job)?;
    let request_json = serde_json::to_string(&job.request)?;
    let status = if job.requires_approval {
        ExecutionJobStatus::WaitingApproval
    } else {
        ExecutionJobStatus::Queued
    };

    // This helper validates causal rows before inserting the Job. Acquire the
    // writer slot first so the validation read does not create a deferred
    // snapshot that later fails to upgrade when a sibling Job is concurrently
    // terminalizing. The parent Activation is immutable for this purpose; the
    // no-op write changes no logical revision.
    sqlx::query("UPDATE thread_activations SET revision = revision WHERE id = ?")
        .bind(&job.activation_id)
        .execute(&mut **tx)
        .await?;

    // A Job must route back through the same causal identity as both its
    // Activation and stable Thread. Foreign keys alone cannot prove this.
    let causal = sqlx::query(
        r#"SELECT activations.agent_id AS activation_agent_id,
                  activations.context_id AS activation_context_id,
                  activations.session_id AS activation_session_id,
                  activations.initiating_principal_id AS activation_principal_id,
                  activations.root_turn_id AS activation_root_turn_id,
                  threads.agent_id AS thread_agent_id,
                  threads.context_id AS thread_context_id,
                  threads.session_id AS thread_session_id,
                  threads.initiating_principal_id AS thread_principal_id,
                  threads.root_turn_id AS thread_root_turn_id
           FROM thread_activations activations, threads threads
           WHERE activations.id = ? AND threads.id = ?"#,
    )
    .bind(&job.activation_id)
    .bind(&job.thread_id)
    .fetch_optional(&mut **tx)
    .await?;
    let causal = causal.ok_or("Execution Job 引用的 Activation 或 Thread 不存在")?;
    let activation_agent_id: String = causal.get("activation_agent_id");
    let activation_context_id: String = causal.get("activation_context_id");
    let activation_session_id: String = causal.get("activation_session_id");
    let activation_root_turn_id: String = causal.get("activation_root_turn_id");
    let activation_principal_id: Option<String> = causal.get("activation_principal_id");
    let thread_agent_id: String = causal.get("thread_agent_id");
    let thread_context_id: String = causal.get("thread_context_id");
    let thread_session_id: String = causal.get("thread_session_id");
    let thread_root_turn_id: String = causal.get("thread_root_turn_id");
    let thread_principal_id: Option<String> = causal.get("thread_principal_id");
    if activation_agent_id != job.agent_id
        || thread_agent_id != job.agent_id
        || activation_context_id != job.context_id
        || thread_context_id != job.context_id
        || activation_session_id != job.session_id
        || thread_session_id != job.session_id
        || activation_root_turn_id != thread_root_turn_id
        || activation_principal_id
            .as_ref()
            .is_some_and(|principal| Some(principal) != job.initiating_principal_id.as_ref())
        || thread_principal_id
            .as_ref()
            .is_some_and(|principal| Some(principal) != job.initiating_principal_id.as_ref())
    {
        return Err("Execution Job 的 Agent/Context/Session/Root Turn 因果边界不一致".into());
    }

    let target = sqlx::query("SELECT status FROM execution_targets WHERE id = ?")
        .bind(&job.target_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or("Execution Job 引用的 Execution Target 不存在")?;
    if parse_execution_target_status(&target.get::<String, _>("status"))?
        == ExecutionTargetStatus::Disabled
    {
        return Err("Execution Job 引用的 Execution Target 已禁用".into());
    }

    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    let inserted = sqlx::query(
        r#"INSERT OR IGNORE INTO execution_jobs
           (id, revision, activation_id, thread_id, agent_id, context_id,
            session_id, initiating_principal_id, target_id, tool_call_id, tool_name, request_json, status,
            retry_safety, result_refs_json, created_at, updated_at)
           VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)"#,
    )
    .bind(&job.id)
    .bind(&job.activation_id)
    .bind(&job.thread_id)
    .bind(&job.agent_id)
    .bind(&job.context_id)
    .bind(&job.session_id)
    .bind(&job.initiating_principal_id)
    .bind(&job.target_id)
    .bind(&job.tool_call_id)
    .bind(&job.tool_name)
    .bind(&request_json)
    .bind(status.as_str())
    .bind(job.retry_safety.as_str())
    .bind(&now)
    .bind(&now)
    .execute(&mut **tx)
    .await?;
    let row =
        sqlx::query("SELECT * FROM execution_jobs WHERE activation_id = ? AND tool_call_id = ?")
            .bind(&job.activation_id)
            .bind(&job.tool_call_id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or("Execution Job 创建失败：ID 或因果唯一键已被其他记录占用")?;
    let existing = execution_job_from_row(&row)?;
    let pending_status_conflict = matches!(
        existing.status,
        ExecutionJobStatus::Queued | ExecutionJobStatus::WaitingApproval
    ) && existing.status != status;
    if existing.id != job.id
        || existing.thread_id != job.thread_id
        || existing.agent_id != job.agent_id
        || existing.context_id != job.context_id
        || existing.session_id != job.session_id
        || existing.target_id != job.target_id
        || existing.tool_name != job.tool_name
        || existing.request != job.request
        || pending_status_conflict
        || existing.retry_safety != job.retry_safety
    {
        return Err(format!(
            "Execution Job 因果键 ('{}', '{}') 已被不同请求占用",
            job.activation_id, job.tool_call_id
        )
        .into());
    }
    Ok((existing, inserted.rows_affected() == 1))
}

#[async_trait::async_trait]
impl ExecutionJobStore for SqliteStore {
    async fn create_execution_job(
        &self,
        job: NewExecutionJob,
    ) -> Result<ExecutionJobRecord, Box<dyn std::error::Error + Send + Sync>> {
        let mut tx = self.pool.begin().await?;
        let (existing, _) = ensure_execution_job_in_transaction(&mut tx, &job).await?;
        tx.commit().await?;
        Ok(existing)
    }

    async fn get_execution_job(
        &self,
        id: &str,
    ) -> Result<Option<ExecutionJobRecord>, Box<dyn std::error::Error + Send + Sync>> {
        sqlx::query("SELECT * FROM execution_jobs WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(execution_job_from_row)
            .transpose()
    }

    async fn list_execution_jobs(
        &self,
        filter: ExecutionJobFilter,
    ) -> Result<Vec<ExecutionJobRecord>, Box<dyn std::error::Error + Send + Sync>> {
        if filter.limit == Some(0) {
            return Ok(Vec::new());
        }
        let mut query = QueryBuilder::<sqlx::Sqlite>::new("SELECT * FROM execution_jobs WHERE 1=1");
        if let Some(context_id) = filter.context_id {
            query.push(" AND context_id = ").push_bind(context_id);
        }
        if let Some(session_id) = filter.session_id {
            query.push(" AND session_id = ").push_bind(session_id);
        }
        if let Some(thread_id) = filter.thread_id {
            query.push(" AND thread_id = ").push_bind(thread_id);
        }
        if let Some(activation_id) = filter.activation_id {
            query.push(" AND activation_id = ").push_bind(activation_id);
        }
        if let Some(target_id) = filter.target_id {
            query.push(" AND target_id = ").push_bind(target_id);
        }
        if let Some(status) = filter.status {
            query.push(" AND status = ").push_bind(status.as_str());
        } else if !filter.include_terminal {
            query.push(" AND status NOT IN ('succeeded', 'failed', 'cancelled', 'lost')");
        }
        if filter.newest_first {
            query.push(" ORDER BY created_at DESC, id DESC");
        } else {
            query.push(" ORDER BY created_at, id");
        }
        if let Some(limit) = filter.limit {
            let limit = i64::try_from(limit)
                .map_err(|_| "Execution Job 查询上限超出 SQLite INTEGER 范围")?;
            query.push(" LIMIT ").push_bind(limit);
        }
        let rows = query.build().fetch_all(&self.pool).await?;
        rows.iter().map(execution_job_from_row).collect()
    }

    async fn claim_execution_job(
        &self,
        id: &str,
        expected_revision: u64,
        worker_id: &str,
        claim_token: &str,
        lease_expires_at: DateTime<Utc>,
        approval_ref: Option<&str>,
    ) -> Result<ExecutionJobMutation, Box<dyn std::error::Error + Send + Sync>> {
        if worker_id.trim().is_empty() || claim_token.trim().is_empty() {
            return Err("Execution Job worker_id/claim_token 不能为空".into());
        }
        let now = Utc::now();
        if lease_expires_at <= now {
            return Err("Execution Job claim lease 必须在未来".into());
        }
        let Some(current) = self.get_execution_job(id).await? else {
            return Ok(ExecutionJobMutation::NotFound);
        };
        if current.revision != expected_revision {
            return Ok(ExecutionJobMutation::Conflict { current });
        }
        if current.cancel_requested_at.is_some() {
            return Ok(ExecutionJobMutation::Rejected {
                current,
                reason: "已请求取消的 Execution Job 不能再 claim".to_string(),
            });
        }
        match current.status {
            ExecutionJobStatus::Queued => {}
            ExecutionJobStatus::WaitingApproval => {
                if approval_ref.is_none_or(|value| value.trim().is_empty()) {
                    return Ok(ExecutionJobMutation::Rejected {
                        current,
                        reason: "waiting_approval Job 必须携带非空 approval_ref".to_string(),
                    });
                }
            }
            _ => {
                return Ok(ExecutionJobMutation::Rejected {
                    current,
                    reason: "只有 queued/waiting_approval Job 可以被 claim".to_string(),
                });
            }
        }
        let expected_revision = i64::try_from(expected_revision)
            .map_err(|_| "Execution Job revision 超出 SQLite INTEGER 范围")?;
        let now_text = now.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let lease_text = lease_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE execution_jobs
               SET revision = revision + 1, status = 'running', claimed_by = ?,
                   claim_token = ?, lease_expires_at = ?, heartbeat_at = ?,
                   approval_ref = COALESCE(?, approval_ref),
                   started_at = COALESCE(started_at, ?), updated_at = ?
               WHERE id = ? AND revision = ?
                 AND status IN ('queued', 'waiting_approval')
                 AND cancel_requested_at IS NULL"#,
        )
        .bind(worker_id)
        .bind(claim_token)
        .bind(lease_text)
        .bind(&now_text)
        .bind(approval_ref)
        .bind(&now_text)
        .bind(&now_text)
        .bind(id)
        .bind(expected_revision)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            return execution_job_mutation_failure(
                self,
                id,
                u64::try_from(expected_revision).expect("validated revision"),
                "Execution Job claim 前置条件不再成立",
            )
            .await;
        }
        Ok(ExecutionJobMutation::Updated(
            self.get_execution_job(id)
                .await?
                .ok_or("Execution Job claim 后无法读取")?,
        ))
    }

    async fn heartbeat_execution_job(
        &self,
        id: &str,
        expected_revision: u64,
        claim_token: &str,
        lease_expires_at: DateTime<Utc>,
        side_effect_started_at: Option<DateTime<Utc>>,
        progress_ref: Option<&str>,
    ) -> Result<ExecutionJobMutation, Box<dyn std::error::Error + Send + Sync>> {
        if claim_token.trim().is_empty() {
            return Err("Execution Job claim_token 不能为空".into());
        }
        let now = Utc::now();
        if lease_expires_at <= now {
            return Err("Execution Job heartbeat lease 必须在未来".into());
        }
        let expected_sql = i64::try_from(expected_revision)
            .map_err(|_| "Execution Job revision 超出 SQLite INTEGER 范围")?;
        let now_text = now.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let lease_text = lease_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let side_effect_started_at = side_effect_started_at
            .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
        let result = sqlx::query(
            r#"UPDATE execution_jobs
               SET revision = revision + 1, lease_expires_at = ?, heartbeat_at = ?,
                   side_effect_started_at = COALESCE(side_effect_started_at, ?),
                   progress_ref = COALESCE(?, progress_ref), updated_at = ?
               WHERE id = ? AND revision = ? AND status = 'running'
                 AND claim_token = ?"#,
        )
        .bind(lease_text)
        .bind(&now_text)
        .bind(side_effect_started_at)
        .bind(progress_ref)
        .bind(&now_text)
        .bind(id)
        .bind(expected_sql)
        .bind(claim_token)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            return execution_job_mutation_failure(
                self,
                id,
                expected_revision,
                "Execution Job heartbeat 需要当前 running claim token",
            )
            .await;
        }
        Ok(ExecutionJobMutation::Updated(
            self.get_execution_job(id)
                .await?
                .ok_or("Execution Job heartbeat 后无法读取")?,
        ))
    }

    async fn requeue_execution_job(
        &self,
        id: &str,
        expected_revision: u64,
    ) -> Result<ExecutionJobMutation, Box<dyn std::error::Error + Send + Sync>> {
        let expected_sql = i64::try_from(expected_revision)
            .map_err(|_| "Execution Job revision 超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE execution_jobs
               SET revision = revision + 1, status = 'queued', claimed_by = NULL,
                   claim_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
                   progress_ref = NULL, updated_at = ?
               WHERE id = ? AND revision = ? AND status = 'running'
                 AND retry_safety = 'idempotent'
                 AND side_effect_started_at IS NULL
                 AND cancel_requested_at IS NULL"#,
        )
        .bind(&now)
        .bind(id)
        .bind(expected_sql)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            return execution_job_mutation_failure(
                self,
                id,
                expected_revision,
                "只有尚未越过副作用边界的 idempotent running Job 可以恢复为 queued",
            )
            .await;
        }
        Ok(ExecutionJobMutation::Updated(
            self.get_execution_job(id)
                .await?
                .ok_or("Execution Job requeue 后无法读取")?,
        ))
    }

    async fn request_cancel_execution_job(
        &self,
        id: &str,
        expected_revision: u64,
        reason: Option<&str>,
    ) -> Result<ExecutionJobMutation, Box<dyn std::error::Error + Send + Sync>> {
        let Some(current) = self.get_execution_job(id).await? else {
            return Ok(ExecutionJobMutation::NotFound);
        };
        if current.revision != expected_revision {
            return Ok(ExecutionJobMutation::Conflict { current });
        }
        if current.status.is_terminal() {
            return Ok(ExecutionJobMutation::Rejected {
                current,
                reason: "Execution Job 终态不可请求取消".to_string(),
            });
        }
        let reason = reason.map(|value| value.chars().take(10_000).collect::<String>());
        if current.cancel_requested_at.is_some() && current.cancel_reason == reason {
            return Ok(ExecutionJobMutation::Updated(current));
        }
        let expected_sql = i64::try_from(expected_revision)
            .map_err(|_| "Execution Job revision 超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE execution_jobs
               SET revision = revision + 1,
                   cancel_requested_at = COALESCE(cancel_requested_at, ?),
                   cancel_reason = ?, updated_at = ?
               WHERE id = ? AND revision = ?
                 AND status NOT IN ('succeeded', 'failed', 'cancelled', 'lost')"#,
        )
        .bind(&now)
        .bind(reason)
        .bind(&now)
        .bind(id)
        .bind(expected_sql)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            return execution_job_mutation_failure(
                self,
                id,
                expected_revision,
                "Execution Job cancel 前置条件不再成立",
            )
            .await;
        }
        Ok(ExecutionJobMutation::Updated(
            self.get_execution_job(id)
                .await?
                .ok_or("Execution Job cancel request 后无法读取")?,
        ))
    }

    async fn finish_execution_job(
        &self,
        id: &str,
        expected_revision: u64,
        claim_token: Option<&str>,
        terminal: ExecutionJobTerminal,
    ) -> Result<ExecutionJobMutation, Box<dyn std::error::Error + Send + Sync>> {
        if !terminal.status.is_terminal() {
            return Err("Execution Job finish 只能提交终态".into());
        }
        let Some(current) = self.get_execution_job(id).await? else {
            return Ok(ExecutionJobMutation::NotFound);
        };
        if current.revision != expected_revision {
            return Ok(ExecutionJobMutation::Conflict { current });
        }
        if current.status.is_terminal() {
            return Ok(ExecutionJobMutation::Rejected {
                current,
                reason: "Execution Job 终态不可逆".to_string(),
            });
        }
        let worker_terminal = matches!(
            terminal.status,
            ExecutionJobStatus::Succeeded | ExecutionJobStatus::Failed
        );
        if worker_terminal
            && (current.status != ExecutionJobStatus::Running
                || claim_token.is_none_or(|token| {
                    token.is_empty() || current.claim_token.as_deref() != Some(token)
                }))
        {
            return Ok(ExecutionJobMutation::Rejected {
                current,
                reason: "succeeded/failed 需要当前 running claim token".to_string(),
            });
        }
        if worker_terminal && current.cancel_requested_at.is_some() {
            return Ok(ExecutionJobMutation::Rejected {
                current,
                reason: "已请求取消的 running Job 只能确认 cancelled，不能再提交 succeeded/failed"
                    .to_string(),
            });
        }
        if terminal.status == ExecutionJobStatus::Lost
            && current.status != ExecutionJobStatus::Running
        {
            return Ok(ExecutionJobMutation::Rejected {
                current,
                reason: "只有 running Job 可以被 reconcile 为 lost".to_string(),
            });
        }
        if terminal.status == ExecutionJobStatus::Cancelled
            && current.status == ExecutionJobStatus::Running
            && current.cancel_requested_at.is_none()
            && claim_token != current.claim_token.as_deref()
        {
            return Ok(ExecutionJobMutation::Rejected {
                current,
                reason: "running Job 只能由当前 worker 或已请求取消的控制面确认 cancelled"
                    .to_string(),
            });
        }

        let expected_sql = i64::try_from(expected_revision)
            .map_err(|_| "Execution Job revision 超出 SQLite INTEGER 范围")?;
        let result_refs_json = serde_json::to_string(&terminal.result_refs)?;
        let error = terminal
            .error
            .map(|value| value.chars().take(100_000).collect::<String>());
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = if worker_terminal {
            sqlx::query(
                r#"UPDATE execution_jobs
                   SET revision = revision + 1, status = ?, lease_expires_at = NULL,
                       result_event_id = ?, result_refs_json = ?, error = ?,
                       exit_code = ?, updated_at = ?, finished_at = ?
                   WHERE id = ? AND revision = ? AND status = 'running'
                     AND claim_token = ?"#,
            )
            .bind(terminal.status.as_str())
            .bind(terminal.result_event_id)
            .bind(result_refs_json)
            .bind(error)
            .bind(terminal.exit_code)
            .bind(&now)
            .bind(&now)
            .bind(id)
            .bind(expected_sql)
            .bind(claim_token)
            .execute(&self.pool)
            .await?
        } else {
            sqlx::query(
                r#"UPDATE execution_jobs
                   SET revision = revision + 1, status = ?, lease_expires_at = NULL,
                       result_event_id = ?, result_refs_json = ?, error = ?,
                       exit_code = ?, updated_at = ?, finished_at = ?
                   WHERE id = ? AND revision = ?
                     AND status NOT IN ('succeeded', 'failed', 'cancelled', 'lost')"#,
            )
            .bind(terminal.status.as_str())
            .bind(terminal.result_event_id)
            .bind(result_refs_json)
            .bind(error)
            .bind(terminal.exit_code)
            .bind(&now)
            .bind(&now)
            .bind(id)
            .bind(expected_sql)
            .execute(&self.pool)
            .await?
        };
        if result.rows_affected() != 1 {
            return execution_job_mutation_failure(
                self,
                id,
                expected_revision,
                "Execution Job terminal commit 前置条件不再成立",
            )
            .await;
        }
        Ok(ExecutionJobMutation::Updated(
            self.get_execution_job(id)
                .await?
                .ok_or("Execution Job terminal commit 后无法读取")?,
        ))
    }

    async fn finish_execution_job_with_event(
        &self,
        id: &str,
        expected_revision: u64,
        claim_token: Option<&str>,
        terminal: ExecutionJobTerminal,
        event: &Event,
        signal_outbox: bool,
    ) -> Result<ExecutionJobMutation, Box<dyn std::error::Error + Send + Sync>> {
        if !terminal.status.is_terminal() {
            return Err("Execution Job finish 只能提交终态".into());
        }
        if terminal.result_event_id.as_deref() != Some(event.id.as_str()) {
            return Err(
                "Execution Job terminal result_event_id 必须等于原子提交的 Event ID".into(),
            );
        }

        let mut tx = self.pool.begin().await?;
        // Acquire SQLite's single-writer slot before reading the current Job.
        // Starting this transaction with SELECT would create a deferred read
        // snapshot that cannot reliably upgrade when another tool in the same
        // batch is concurrently being prepared/claimed. In that interleaving
        // SQLite returns SQLITE_BUSY immediately instead of honoring the busy
        // timeout, stranding the batch after only one physical result.
        sqlx::query("UPDATE execution_jobs SET revision = revision WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let Some(row) = sqlx::query("SELECT * FROM execution_jobs WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
        else {
            tx.commit().await?;
            return Ok(ExecutionJobMutation::NotFound);
        };
        let current = execution_job_from_row(&row)?;

        // Validate the causal identity before every path, including exact
        // terminal replay. Otherwise a missing historical Event could be
        // "repaired" by inserting a same-id Event routed to another
        // Session/Thread while the Job itself already looks terminal.
        let event_context_id = event.payload.get("context_id").and_then(JsonValue::as_str);
        let event_session_id = event.payload.get("session_id").and_then(JsonValue::as_str);
        let event_tool_call_id = event
            .payload
            .get("tool_call_id")
            .and_then(JsonValue::as_str);
        let event_tool_name = event.payload.get("tool_name").and_then(JsonValue::as_str);
        let event_activation_id = event
            .payload
            .get("activation_id")
            .and_then(JsonValue::as_str);
        let event_thread_id = event.payload.get("thread_id").and_then(JsonValue::as_str);
        if event_context_id != Some(current.context_id.as_str())
            || event_session_id != Some(current.session_id.as_str())
            || event_tool_call_id != Some(current.tool_call_id.as_str())
            || event_tool_name != Some(current.tool_name.as_str())
            || event_activation_id != Some(current.activation_id.as_str())
            || event_thread_id != Some(current.thread_id.as_str())
            || event.topic != "chat/tool_output"
            || event.event_type != crate::event::TYPE_TOOL_OUTPUT
        {
            tx.rollback().await?;
            return Err(format!(
                "Execution Job '{}' 的结果 Event 路由或工具因果身份不匹配",
                current.id
            )
            .into());
        }

        if current.status.is_terminal() {
            let error = terminal
                .error
                .as_ref()
                .map(|value| value.chars().take(100_000).collect::<String>());
            let exact_replay = current.status == terminal.status
                && current.result_event_id.as_deref() == Some(event.id.as_str())
                && current.result_refs == terminal.result_refs
                && current.error == error
                && current.exit_code == terminal.exit_code;
            if exact_replay {
                append_event_idempotent_in_transaction(&mut tx, event).await?;
                if signal_outbox {
                    append_signal_outbox_in_transaction(&mut tx, event).await?;
                }
                tx.commit().await?;
                return Ok(ExecutionJobMutation::Existing(current));
            }
            tx.commit().await?;
            return Ok(ExecutionJobMutation::Rejected {
                current,
                reason: "Execution Job 已有不同终态或结果 Event，不能覆盖".to_string(),
            });
        }
        if current.revision != expected_revision {
            tx.commit().await?;
            return Ok(ExecutionJobMutation::Conflict { current });
        }

        let worker_terminal = matches!(
            terminal.status,
            ExecutionJobStatus::Succeeded | ExecutionJobStatus::Failed
        );
        if worker_terminal
            && (current.status != ExecutionJobStatus::Running
                || claim_token.is_none_or(|token| {
                    token.is_empty() || current.claim_token.as_deref() != Some(token)
                }))
        {
            tx.commit().await?;
            return Ok(ExecutionJobMutation::Rejected {
                current,
                reason: "succeeded/failed 需要当前 running claim token".to_string(),
            });
        }
        if worker_terminal && current.cancel_requested_at.is_some() {
            tx.commit().await?;
            return Ok(ExecutionJobMutation::Rejected {
                current,
                reason: "已请求取消的 running Job 只能确认 cancelled，不能再提交 succeeded/failed"
                    .to_string(),
            });
        }
        if terminal.status == ExecutionJobStatus::Lost
            && current.status != ExecutionJobStatus::Running
        {
            tx.commit().await?;
            return Ok(ExecutionJobMutation::Rejected {
                current,
                reason: "只有 running Job 可以被 reconcile 为 lost".to_string(),
            });
        }
        if terminal.status == ExecutionJobStatus::Cancelled
            && current.status == ExecutionJobStatus::Running
            && current.cancel_requested_at.is_none()
            && claim_token != current.claim_token.as_deref()
        {
            tx.commit().await?;
            return Ok(ExecutionJobMutation::Rejected {
                current,
                reason: "running Job 只能由当前 worker 或已请求取消的控制面确认 cancelled"
                    .to_string(),
            });
        }

        let expected_sql = i64::try_from(expected_revision)
            .map_err(|_| "Execution Job revision 超出 SQLite INTEGER 范围")?;
        let result_refs_json = serde_json::to_string(&terminal.result_refs)?;
        let error = terminal
            .error
            .as_ref()
            .map(|value| value.chars().take(100_000).collect::<String>());
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = if worker_terminal {
            sqlx::query(
                r#"UPDATE execution_jobs
                   SET revision = revision + 1, status = ?, lease_expires_at = NULL,
                       result_event_id = ?, result_refs_json = ?, error = ?,
                       exit_code = ?, updated_at = ?, finished_at = ?
                   WHERE id = ? AND revision = ? AND status = 'running'
                     AND claim_token = ?"#,
            )
            .bind(terminal.status.as_str())
            .bind(&terminal.result_event_id)
            .bind(&result_refs_json)
            .bind(&error)
            .bind(terminal.exit_code)
            .bind(&now)
            .bind(&now)
            .bind(id)
            .bind(expected_sql)
            .bind(claim_token)
            .execute(&mut *tx)
            .await?
        } else {
            sqlx::query(
                r#"UPDATE execution_jobs
                   SET revision = revision + 1, status = ?, lease_expires_at = NULL,
                       result_event_id = ?, result_refs_json = ?, error = ?,
                       exit_code = ?, updated_at = ?, finished_at = ?
                   WHERE id = ? AND revision = ?
                     AND status NOT IN ('succeeded', 'failed', 'cancelled', 'lost')"#,
            )
            .bind(terminal.status.as_str())
            .bind(&terminal.result_event_id)
            .bind(&result_refs_json)
            .bind(&error)
            .bind(terminal.exit_code)
            .bind(&now)
            .bind(&now)
            .bind(id)
            .bind(expected_sql)
            .execute(&mut *tx)
            .await?
        };
        if result.rows_affected() != 1 {
            tx.rollback().await?;
            return execution_job_mutation_failure(
                self,
                id,
                expected_revision,
                "Execution Job terminal/Event 原子提交前置条件不再成立",
            )
            .await;
        }
        append_event_idempotent_in_transaction(&mut tx, event).await?;
        if signal_outbox {
            append_signal_outbox_in_transaction(&mut tx, event).await?;
        }
        let updated = sqlx::query("SELECT * FROM execution_jobs WHERE id = ?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        let updated = execution_job_from_row(&updated)?;
        tx.commit().await?;
        Ok(ExecutionJobMutation::Updated(updated))
    }

    async fn reconcile_execution_job_from_event(
        &self,
        id: &str,
        expected_revision: u64,
        terminal: ExecutionJobTerminal,
        event: &Event,
        signal_outbox: bool,
    ) -> Result<ExecutionJobMutation, Box<dyn std::error::Error + Send + Sync>> {
        if !terminal.status.is_terminal() {
            return Err("Execution Job reconcile 只能提交终态".into());
        }
        if terminal.result_event_id.as_deref() != Some(event.id.as_str()) {
            return Err("Execution Job reconcile result_event_id 必须等于既存 Event ID".into());
        }

        let mut tx = self.pool.begin().await?;
        // Serialize the projection repair with every other SQLite writer. The
        // immutable Event is verified below; this no-op never changes Ledger.
        sqlx::query("UPDATE execution_jobs SET revision = revision WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let Some(row) = sqlx::query("SELECT * FROM execution_jobs WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
        else {
            tx.commit().await?;
            return Ok(ExecutionJobMutation::NotFound);
        };
        let current = execution_job_from_row(&row)?;
        validate_sqlite_result_event(&current, event)?;
        verify_existing_sqlite_event(&mut tx, event).await?;

        let error = terminal
            .error
            .as_ref()
            .map(|value| value.chars().take(100_000).collect::<String>());
        if current.status.is_terminal() {
            let exact_replay = current.status == terminal.status
                && current.result_event_id.as_deref() == Some(event.id.as_str())
                && current.result_refs == terminal.result_refs
                && current.error == error
                && current.exit_code == terminal.exit_code;
            if exact_replay {
                if signal_outbox {
                    append_signal_outbox_in_transaction(&mut tx, event).await?;
                }
                tx.commit().await?;
                return Ok(ExecutionJobMutation::Existing(current));
            }
            tx.commit().await?;
            return Ok(ExecutionJobMutation::Rejected {
                current,
                reason: "Execution Job 已有不同终态，不能用既存 Event 覆盖".to_string(),
            });
        }
        if current.revision != expected_revision {
            tx.commit().await?;
            return Ok(ExecutionJobMutation::Conflict { current });
        }

        let expected_sql = i64::try_from(expected_revision)
            .map_err(|_| "Execution Job revision 超出 SQLite INTEGER 范围")?;
        let result_refs_json = serde_json::to_string(&terminal.result_refs)?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE execution_jobs
               SET revision = revision + 1, status = ?, lease_expires_at = NULL,
                   result_event_id = ?, result_refs_json = ?, error = ?,
                   exit_code = ?, updated_at = ?, finished_at = ?
               WHERE id = ? AND revision = ?
                 AND status NOT IN ('succeeded', 'failed', 'cancelled', 'lost')"#,
        )
        .bind(terminal.status.as_str())
        .bind(&terminal.result_event_id)
        .bind(&result_refs_json)
        .bind(&error)
        .bind(terminal.exit_code)
        .bind(&now)
        .bind(&now)
        .bind(id)
        .bind(expected_sql)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
            tx.rollback().await?;
            return execution_job_mutation_failure(
                self,
                id,
                expected_revision,
                "Execution Job 既存 Event 恢复前置条件不再成立",
            )
            .await;
        }
        if signal_outbox {
            append_signal_outbox_in_transaction(&mut tx, event).await?;
        }
        let updated = sqlx::query("SELECT * FROM execution_jobs WHERE id = ?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        let updated = execution_job_from_row(&updated)?;
        tx.commit().await?;
        Ok(ExecutionJobMutation::Updated(updated))
    }
}

fn validate_sqlite_result_event(
    current: &ExecutionJobRecord,
    event: &Event,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let payload_str = |key: &str| event.payload.get(key).and_then(JsonValue::as_str);
    if payload_str("context_id") != Some(current.context_id.as_str())
        || payload_str("session_id") != Some(current.session_id.as_str())
        || payload_str("tool_call_id") != Some(current.tool_call_id.as_str())
        || payload_str("tool_name") != Some(current.tool_name.as_str())
        || payload_str("activation_id") != Some(current.activation_id.as_str())
        || payload_str("thread_id") != Some(current.thread_id.as_str())
        || event.topic != "chat/tool_output"
        || event.event_type != crate::event::TYPE_TOOL_OUTPUT
    {
        return Err(format!(
            "Execution Job '{}' 的结果 Event 路由或工具因果身份不匹配",
            current.id
        )
        .into());
    }
    Ok(())
}

async fn verify_existing_sqlite_event(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    event: &Event,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let Some(existing) = sqlx::query(
        "SELECT timestamp, actor, type, topic, context_id, session_id, payload FROM events WHERE id = ?",
    )
    .bind(&event.id)
    .fetch_optional(&mut **tx)
    .await?
    else {
        return Err(format!(
            "Execution Job 恢复只能使用已持久化 Event '{}'",
            event.id
        )
        .into());
    };
    let session_id = event.payload.get("session_id").and_then(JsonValue::as_str);
    let context_id = event
        .payload
        .get("context_id")
        .and_then(JsonValue::as_str)
        .or(session_id);
    let stored_timestamp =
        DateTime::parse_from_rfc3339(&existing.get::<String, _>("timestamp"))?.with_timezone(&Utc);
    let stored_payload: JsonValue = serde_json::from_str(&existing.get::<String, _>("payload"))?;
    let same = stored_timestamp == event.timestamp
        && existing.get::<String, _>("actor") == event.actor
        && existing.get::<String, _>("type") == event.event_type
        && existing.get::<String, _>("topic") == event.topic
        && existing.get::<Option<String>, _>("context_id").as_deref() == context_id
        && existing.get::<Option<String>, _>("session_id").as_deref() == session_id
        && stored_payload == JsonValue::Object(event.payload.clone());
    if !same {
        return Err(format!(
            "Execution Job 恢复引用的 Event '{}' 与 Ledger 内容不一致",
            event.id
        )
        .into());
    }
    Ok(())
}

fn validate_new_approval_request(
    request: &NewApprovalRequest,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    for (field, value) in [
        ("id", request.id.as_str()),
        ("job_id", request.job_id.as_str()),
        ("request_digest", request.request_digest.as_str()),
        ("policy_digest", request.policy_digest.as_str()),
        ("justification", request.justification.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(format!("Approval {field} 不能为空").into());
        }
    }
    if !request.pending_status.is_pending() {
        return Err("Approval 首次创建只能使用 pending_auto 或 pending_human".into());
    }
    let stable_identity = stable_approval_identity(
        &request.job_id,
        &request.action,
        &request.requested,
        &request.policy_digest,
    )?;
    if request.id != stable_identity.approval_id
        || request.request_digest != stable_identity.request_digest
    {
        return Err("Approval id/request_digest 与规范化请求身份不一致".into());
    }
    Ok(())
}

async fn ensure_approval_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    request: &NewApprovalRequest,
) -> Result<ApprovalMutation, Box<dyn std::error::Error + Send + Sync>> {
    validate_new_approval_request(request)?;
    let action_json = serde_json::to_string(&request.action)?;
    let requested_json = serde_json::to_string(&request.requested)?;

    let existing = sqlx::query(
        r#"SELECT * FROM approval_requests
           WHERE id = ? OR (job_id = ? AND request_digest = ? AND policy_digest = ?)
           ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
           LIMIT 1"#,
    )
    .bind(&request.id)
    .bind(&request.job_id)
    .bind(&request.request_digest)
    .bind(&request.policy_digest)
    .bind(&request.id)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(row) = existing {
        let current = approval_from_row(&row)?;
        let immutable_match = current.id == request.id
            && current.job_id == request.job_id
            && current.request_digest == request.request_digest
            && current.policy_digest == request.policy_digest
            && current.action == request.action
            && current.requested == request.requested
            && current.justification == request.justification
            && (!current.status.is_pending() || current.status == request.pending_status);
        return Ok(if immutable_match {
            ApprovalMutation::Existing(current)
        } else {
            ApprovalMutation::Conflict {
                current,
                reason: "Approval identity 或因果摘要已被不同请求占用".to_string(),
            }
        });
    }

    let job_status =
        sqlx::query_scalar::<_, String>("SELECT status FROM execution_jobs WHERE id = ?")
            .bind(&request.job_id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or("Approval 引用的 Execution Job 不存在")?;
    if parse_execution_job_status(&job_status)? != ExecutionJobStatus::WaitingApproval {
        return Err("Approval 只能绑定 waiting_approval Execution Job".into());
    }

    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    let inserted = sqlx::query(
        r#"INSERT OR IGNORE INTO approval_requests
           (id, revision, job_id, request_digest, policy_digest, action_json,
            requested_json, justification, status, risk_tags_json,
            created_at, updated_at)
           VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)"#,
    )
    .bind(&request.id)
    .bind(&request.job_id)
    .bind(&request.request_digest)
    .bind(&request.policy_digest)
    .bind(action_json)
    .bind(requested_json)
    .bind(&request.justification)
    .bind(request.pending_status.as_str())
    .bind(&now)
    .bind(&now)
    .execute(&mut **tx)
    .await?;
    if inserted.rows_affected() != 1 {
        let row = sqlx::query(
            r#"SELECT * FROM approval_requests
               WHERE id = ? OR (job_id = ? AND request_digest = ? AND policy_digest = ?)
               LIMIT 1"#,
        )
        .bind(&request.id)
        .bind(&request.job_id)
        .bind(&request.request_digest)
        .bind(&request.policy_digest)
        .fetch_optional(&mut **tx)
        .await?;
        return Ok(match row {
            Some(row) => ApprovalMutation::Conflict {
                current: approval_from_row(&row)?,
                reason: "Approval 并发创建时身份或活动 Job 前置条件发生冲突".to_string(),
            },
            None => return Err("Approval 创建失败且无法读取冲突记录".into()),
        });
    }
    let created = sqlx::query("SELECT * FROM approval_requests WHERE id = ?")
        .bind(&request.id)
        .fetch_one(&mut **tx)
        .await?;
    Ok(ApprovalMutation::Created(approval_from_row(&created)?))
}

async fn approval_job_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    approval: &ApprovalRecord,
) -> Result<ExecutionJobRecord, Box<dyn std::error::Error + Send + Sync>> {
    let row = sqlx::query("SELECT * FROM execution_jobs WHERE id = ?")
        .bind(&approval.job_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| {
            format!(
                "Approval '{}' 引用的 Execution Job '{}' 不存在",
                approval.id, approval.job_id
            )
        })?;
    execution_job_from_row(&row)
}

#[async_trait::async_trait]
impl ApprovalStore for SqliteStore {
    async fn ensure_approval_request(
        &self,
        request: NewApprovalRequest,
    ) -> Result<ApprovalMutation, Box<dyn std::error::Error + Send + Sync>> {
        let mut tx = self.pool.begin().await?;
        let result = ensure_approval_in_transaction(&mut tx, &request).await?;
        tx.commit().await?;
        Ok(result)
    }

    async fn get_approval(
        &self,
        id: &str,
    ) -> Result<Option<ApprovalRecord>, Box<dyn std::error::Error + Send + Sync>> {
        sqlx::query("SELECT * FROM approval_requests WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(approval_from_row)
            .transpose()
    }

    async fn list_approvals(
        &self,
        filter: ApprovalFilter,
    ) -> Result<Vec<ApprovalRecord>, Box<dyn std::error::Error + Send + Sync>> {
        if filter.limit == Some(0) {
            return Ok(Vec::new());
        }
        let mut query =
            QueryBuilder::<sqlx::Sqlite>::new("SELECT * FROM approval_requests WHERE 1=1");
        if let Some(job_id) = filter.job_id {
            query.push(" AND job_id = ").push_bind(job_id);
        }
        if let Some(status) = filter.status {
            query.push(" AND status = ").push_bind(status.as_str());
        }
        if filter.pending_only {
            query.push(" AND status IN ('pending_auto', 'pending_human')");
        }
        query.push(" ORDER BY created_at, id");
        if let Some(limit) = filter.limit {
            let limit =
                i64::try_from(limit).map_err(|_| "Approval 查询上限超出 SQLite INTEGER 范围")?;
            query.push(" LIMIT ").push_bind(limit);
        }
        let rows = query.build().fetch_all(&self.pool).await?;
        rows.iter().map(approval_from_row).collect()
    }

    async fn list_context_approvals(
        &self,
        context_id: &str,
    ) -> Result<Vec<ApprovalRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = sqlx::query(
            r#"SELECT approval_requests.*
               FROM approval_requests
               INNER JOIN execution_jobs
                 ON execution_jobs.id = approval_requests.job_id
               WHERE execution_jobs.context_id = ?
               ORDER BY approval_requests.created_at, approval_requests.id"#,
        )
        .bind(context_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(approval_from_row).collect()
    }

    async fn commit_approval_decision(
        &self,
        id: &str,
        expected_revision: u64,
        decision: ApprovalResolution,
    ) -> Result<ApprovalAuditCommit, Box<dyn std::error::Error + Send + Sync>> {
        let rationale = decision.rationale().trim();
        if rationale.is_empty() {
            return Err("Approval decision rationale 不能为空".into());
        }
        let rationale = rationale.chars().take(100_000).collect::<String>();
        let risk_tags = decision.risk_tags().to_vec();
        let risk_tags_json = serde_json::to_string(&risk_tags)?;
        let target_status = decision.status();
        let mut tx = self.pool.begin().await?;
        let Some(row) = sqlx::query("SELECT * FROM approval_requests WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
        else {
            tx.commit().await?;
            return Ok(ApprovalAuditCommit {
                mutation: ApprovalMutation::NotFound,
                event_created: false,
                event: None,
            });
        };
        let current = approval_from_row(&row)?;
        let exact_replay = current.status == target_status
            && current.rationale.as_deref() == Some(rationale.as_str())
            && current.risk_tags == risk_tags;
        if exact_replay {
            let job = approval_job_in_transaction(&mut tx, &current).await?;
            let event = approval_decision_event(&current, &job);
            let event_created = append_event_idempotent_in_transaction(&mut tx, &event).await?;
            tx.commit().await?;
            return Ok(ApprovalAuditCommit {
                mutation: ApprovalMutation::Existing(current),
                event_created,
                event: Some(event),
            });
        }
        if current.revision != expected_revision {
            tx.commit().await?;
            return Ok(ApprovalAuditCommit {
                mutation: ApprovalMutation::Conflict {
                    current,
                    reason: "Approval decision revision 已变化".to_string(),
                },
                event_created: false,
                event: None,
            });
        }
        if !current.status.is_pending() {
            tx.commit().await?;
            return Ok(ApprovalAuditCommit {
                mutation: ApprovalMutation::Rejected {
                    current,
                    reason: "Approval 已有不同决定或已取消，不能覆盖".to_string(),
                },
                event_created: false,
                event: None,
            });
        }
        let grant_id = if target_status == ApprovalStatus::Allowed {
            Some(stable_grant_id(
                &current.id,
                &current.request_digest,
                &current.policy_digest,
            )?)
        } else {
            None
        };
        let expected_sql = i64::try_from(expected_revision)
            .map_err(|_| "Approval revision 超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE approval_requests
               SET revision = revision + 1, status = ?, rationale = ?,
                   risk_tags_json = ?, grant_id = ?, last_error = NULL,
                   updated_at = ?, decided_at = ?
               WHERE id = ? AND revision = ?
                 AND status IN ('pending_auto', 'pending_human')"#,
        )
        .bind(target_status.as_str())
        .bind(&rationale)
        .bind(risk_tags_json)
        .bind(grant_id)
        .bind(&now)
        .bind(&now)
        .bind(id)
        .bind(expected_sql)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(ApprovalAuditCommit {
                mutation: approval_mutation_failure(
                    self,
                    id,
                    expected_revision,
                    "Approval decision 前置条件不再成立",
                )
                .await?,
                event_created: false,
                event: None,
            });
        }
        let updated = sqlx::query("SELECT * FROM approval_requests WHERE id = ?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        let updated = approval_from_row(&updated)?;
        let job = approval_job_in_transaction(&mut tx, &updated).await?;
        let event = approval_decision_event(&updated, &job);
        let event_created = append_event_idempotent_in_transaction(&mut tx, &event).await?;
        tx.commit().await?;
        Ok(ApprovalAuditCommit {
            mutation: ApprovalMutation::Updated(updated),
            event_created,
            event: Some(event),
        })
    }

    async fn commit_approval_cancellation(
        &self,
        id: &str,
        expected_revision: u64,
        reason: &str,
    ) -> Result<ApprovalAuditCommit, Box<dyn std::error::Error + Send + Sync>> {
        let reason = reason.trim();
        if reason.is_empty() {
            return Err("Approval cancel reason 不能为空".into());
        }
        let reason = reason.chars().take(100_000).collect::<String>();
        let mut tx = self.pool.begin().await?;
        let Some(row) = sqlx::query("SELECT * FROM approval_requests WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
        else {
            tx.commit().await?;
            return Ok(ApprovalAuditCommit {
                mutation: ApprovalMutation::NotFound,
                event_created: false,
                event: None,
            });
        };
        let current = approval_from_row(&row)?;
        if current.status == ApprovalStatus::Cancelled
            && current.cancel_reason.as_deref() == Some(reason.as_str())
        {
            let job = approval_job_in_transaction(&mut tx, &current).await?;
            let event = approval_decision_event(&current, &job);
            let event_created = append_event_idempotent_in_transaction(&mut tx, &event).await?;
            tx.commit().await?;
            return Ok(ApprovalAuditCommit {
                mutation: ApprovalMutation::Existing(current),
                event_created,
                event: Some(event),
            });
        }
        if current.revision != expected_revision {
            tx.commit().await?;
            return Ok(ApprovalAuditCommit {
                mutation: ApprovalMutation::Conflict {
                    current,
                    reason: "Approval cancellation revision 已变化".to_string(),
                },
                event_created: false,
                event: None,
            });
        }
        let cancellable = current.status.is_pending()
            || (current.status == ApprovalStatus::Allowed && current.grant_consumed_at.is_none());
        if !cancellable {
            tx.commit().await?;
            return Ok(ApprovalAuditCommit {
                mutation: ApprovalMutation::Rejected {
                    current,
                    reason: "Approval 已拒绝、已取消或授权已消费，不能取消".to_string(),
                },
                event_created: false,
                event: None,
            });
        }
        let expected_sql = i64::try_from(expected_revision)
            .map_err(|_| "Approval revision 超出 SQLite INTEGER 范围")?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE approval_requests
               SET revision = revision + 1, status = 'cancelled', grant_id = NULL,
                   cancel_reason = ?, updated_at = ?, cancelled_at = ?
               WHERE id = ? AND revision = ?
                 AND (status IN ('pending_auto', 'pending_human')
                      OR (status = 'allowed' AND grant_consumed_at IS NULL))"#,
        )
        .bind(&reason)
        .bind(&now)
        .bind(&now)
        .bind(id)
        .bind(expected_sql)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(ApprovalAuditCommit {
                mutation: approval_mutation_failure(
                    self,
                    id,
                    expected_revision,
                    "Approval cancellation 前置条件不再成立",
                )
                .await?,
                event_created: false,
                event: None,
            });
        }
        let updated = sqlx::query("SELECT * FROM approval_requests WHERE id = ?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        let updated = approval_from_row(&updated)?;
        let job = approval_job_in_transaction(&mut tx, &updated).await?;
        let event = approval_decision_event(&updated, &job);
        let event_created = append_event_idempotent_in_transaction(&mut tx, &event).await?;
        tx.commit().await?;
        Ok(ApprovalAuditCommit {
            mutation: ApprovalMutation::Updated(updated),
            event_created,
            event: Some(event),
        })
    }
}

#[async_trait::async_trait]
impl CapabilityLeaseStore for SqliteStore {
    async fn ensure_capability_lease(
        &self,
        lease: NewCapabilityLease,
    ) -> Result<CapabilityLeaseMutation, Box<dyn std::error::Error + Send + Sync>> {
        for (field, value) in [
            ("id", lease.id.as_str()),
            ("principal_id", lease.principal_id.as_str()),
            ("agent_id", lease.agent_id.as_str()),
            ("thread_id", lease.thread_id.as_str()),
            ("target_id", lease.target_id.as_str()),
            ("policy_digest", lease.policy_digest.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(format!("Capability Lease {field} 不能为空").into());
            }
        }
        if lease.capabilities.is_empty()
            || lease
                .capabilities
                .iter()
                .any(|value| value.trim().is_empty())
        {
            return Err("Capability Lease 至少需要一个非空 capability".into());
        }
        let now = Utc::now();
        if lease.expires_at <= now {
            return Err("Capability Lease expires_at 必须晚于当前时间".into());
        }
        let capabilities_json = serde_json::to_string(&lease.capabilities)?;
        let requested_json = serde_json::to_string(&lease.requested)?;
        let now = now.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let inserted = sqlx::query(
            r#"INSERT OR IGNORE INTO capability_leases
               (id, revision, principal_id, agent_id, thread_id, target_id,
                capabilities_json, requested_json, policy_digest, status,
                issued_by_approval_id, issued_at, expires_at, updated_at)
               VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)"#,
        )
        .bind(&lease.id)
        .bind(&lease.principal_id)
        .bind(&lease.agent_id)
        .bind(&lease.thread_id)
        .bind(&lease.target_id)
        .bind(&capabilities_json)
        .bind(&requested_json)
        .bind(&lease.policy_digest)
        .bind(&lease.issued_by_approval_id)
        .bind(&now)
        .bind(
            lease
                .expires_at
                .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
        )
        .bind(&now)
        .execute(&self.pool)
        .await?;
        let current = self
            .get_capability_lease(&lease.id)
            .await?
            .ok_or("Capability Lease insert 后不可见")?;
        let exact = current.principal_id == lease.principal_id
            && current.agent_id == lease.agent_id
            && current.thread_id == lease.thread_id
            && current.target_id == lease.target_id
            && current.capabilities == lease.capabilities
            && current.requested == lease.requested
            && current.policy_digest == lease.policy_digest
            && current.issued_by_approval_id == lease.issued_by_approval_id
            && current.expires_at == lease.expires_at;
        if !exact {
            return Ok(CapabilityLeaseMutation::Conflict { current });
        }
        if inserted.rows_affected() == 1 {
            Ok(CapabilityLeaseMutation::Created(current))
        } else {
            Ok(CapabilityLeaseMutation::Existing(current))
        }
    }

    async fn get_capability_lease(
        &self,
        id: &str,
    ) -> Result<Option<CapabilityLeaseRecord>, Box<dyn std::error::Error + Send + Sync>> {
        sqlx::query("SELECT * FROM capability_leases WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(capability_lease_from_row)
            .transpose()
    }

    async fn list_capability_leases(
        &self,
        filter: CapabilityLeaseFilter,
    ) -> Result<Vec<CapabilityLeaseRecord>, Box<dyn std::error::Error + Send + Sync>> {
        if filter.limit == Some(0) {
            return Ok(Vec::new());
        }
        let mut query =
            QueryBuilder::<sqlx::Sqlite>::new("SELECT * FROM capability_leases WHERE 1=1");
        if let Some(value) = filter.principal_id {
            query.push(" AND principal_id = ").push_bind(value);
        }
        if let Some(value) = filter.agent_id {
            query.push(" AND agent_id = ").push_bind(value);
        }
        if let Some(value) = filter.thread_id {
            query.push(" AND thread_id = ").push_bind(value);
        }
        if let Some(value) = filter.target_id {
            query.push(" AND target_id = ").push_bind(value);
        }
        if let Some(active_at) = filter.active_at {
            query
                .push(" AND status = 'active' AND expires_at > ")
                .push_bind(active_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
        }
        query.push(" ORDER BY issued_at DESC, id");
        if let Some(limit) = filter.limit {
            query.push(" LIMIT ").push_bind(i64::try_from(limit)?);
        }
        let rows = query.build().fetch_all(&self.pool).await?;
        rows.iter().map(capability_lease_from_row).collect()
    }

    async fn revoke_capability_lease(
        &self,
        id: &str,
        expected_revision: u64,
        reason: &str,
    ) -> Result<CapabilityLeaseMutation, Box<dyn std::error::Error + Send + Sync>> {
        let reason = reason.trim();
        if reason.is_empty() {
            return Err("Capability Lease revoke reason 不能为空".into());
        }
        let Some(current) = self.get_capability_lease(id).await? else {
            return Ok(CapabilityLeaseMutation::NotFound);
        };
        if current.status == CapabilityLeaseStatus::Revoked
            && current.revoke_reason.as_deref() == Some(reason)
        {
            return Ok(CapabilityLeaseMutation::Existing(current));
        }
        if current.revision != expected_revision || current.status != CapabilityLeaseStatus::Active
        {
            return Ok(CapabilityLeaseMutation::Conflict { current });
        }
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let result = sqlx::query(
            r#"UPDATE capability_leases
               SET revision = revision + 1, status = 'revoked', revoke_reason = ?,
                   revoked_at = ?, updated_at = ?
               WHERE id = ? AND revision = ? AND status = 'active'"#,
        )
        .bind(reason)
        .bind(&now)
        .bind(&now)
        .bind(id)
        .bind(i64::try_from(expected_revision)?)
        .execute(&self.pool)
        .await?;
        let updated = self
            .get_capability_lease(id)
            .await?
            .ok_or("Capability Lease revoke 后不可见")?;
        if result.rows_affected() == 1 {
            Ok(CapabilityLeaseMutation::Updated(updated))
        } else {
            Ok(CapabilityLeaseMutation::Conflict { current: updated })
        }
    }
}

fn approval_event_payload_str<'a>(
    event: &'a Event,
    key: &str,
) -> Result<&'a str, Box<dyn std::error::Error + Send + Sync>> {
    event
        .payload
        .get(key)
        .and_then(JsonValue::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Approval request Event 缺少非空字符串字段 '{key}'").into())
}

fn validate_approval_request_event(
    event: &Event,
    job: &NewExecutionJob,
    approval: &NewApprovalRequest,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if event.id.trim().is_empty() || event.actor.trim().is_empty() {
        return Err("Approval request Event id/actor 不能为空".into());
    }
    if event.event_type != "approval_requested" || event.topic != "runtime/approval_requested" {
        return Err(
            "Approval request Event 必须使用 approval_requested/runtime/approval_requested".into(),
        );
    }
    for (key, expected) in [
        ("approval_id", approval.id.as_str()),
        ("job_id", job.id.as_str()),
        ("request_digest", approval.request_digest.as_str()),
        ("policy_digest", approval.policy_digest.as_str()),
        ("activation_id", job.activation_id.as_str()),
        ("thread_id", job.thread_id.as_str()),
        ("context_id", job.context_id.as_str()),
        ("session_id", job.session_id.as_str()),
        ("tool_call_id", job.tool_call_id.as_str()),
    ] {
        if approval_event_payload_str(event, key)? != expected {
            return Err(format!("Approval request Event 字段 '{key}' 与权威记录不一致").into());
        }
    }
    if event.payload.get("action") != Some(&approval.action)
        || event.payload.get("requested") != Some(&approval.requested)
        || event
            .payload
            .get("justification")
            .and_then(JsonValue::as_str)
            != Some(approval.justification.as_str())
    {
        return Err("Approval request Event 的 action/requested/justification 与请求不一致".into());
    }
    Ok(())
}

fn validate_persisted_approval_authority(
    approval: &ApprovalRecord,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let identity = stable_approval_identity(
        &approval.job_id,
        &approval.action,
        &approval.requested,
        &approval.policy_digest,
    )?;
    if identity.approval_id != approval.id || identity.request_digest != approval.request_digest {
        return Err(format!("Approval '{}' 的持久化身份摘要已损坏", approval.id).into());
    }
    if let Some(grant_id) = approval.grant_id.as_deref() {
        let expected = stable_grant_id(
            &approval.id,
            &approval.request_digest,
            &approval.policy_digest,
        )?;
        if grant_id != expected {
            return Err(format!("Approval '{}' 的 Grant 摘要已损坏", approval.id).into());
        }
    }
    Ok(())
}

#[async_trait::async_trait]
impl ExecutionApprovalStore for SqliteStore {
    async fn ensure_execution_job_with_approval(
        &self,
        job: NewExecutionJob,
        approval: NewApprovalRequest,
        request_event: &Event,
    ) -> Result<ExecutionApprovalMutation, Box<dyn std::error::Error + Send + Sync>> {
        if !job.requires_approval {
            return Err("原子 Approval 创建要求 Execution Job.requires_approval=true".into());
        }
        if approval.job_id != job.id {
            return Err("Approval job_id 与 Execution Job id 不一致".into());
        }
        validate_new_execution_job(&job)?;
        validate_new_approval_request(&approval)?;
        validate_approval_request_event(request_event, &job, &approval)?;

        let mut tx = self.pool.begin().await?;
        let (job_record, job_created) = ensure_execution_job_in_transaction(&mut tx, &job).await?;
        let approval_mutation = ensure_approval_in_transaction(&mut tx, &approval).await?;
        let (approval_record, approval_created) = match approval_mutation {
            ApprovalMutation::Created(record) => (record, true),
            ApprovalMutation::Existing(record) => (record, false),
            ApprovalMutation::Conflict { current, reason } => {
                tx.rollback().await?;
                return Ok(ExecutionApprovalMutation::Conflict {
                    job: (!job_created).then_some(job_record),
                    approval: Some(current),
                    reason,
                });
            }
            ApprovalMutation::Rejected { current, reason } => {
                tx.rollback().await?;
                return Ok(ExecutionApprovalMutation::Rejected {
                    job: (!job_created).then_some(job_record),
                    approval: Some(current),
                    reason,
                });
            }
            ApprovalMutation::Updated(_) | ApprovalMutation::NotFound => {
                tx.rollback().await?;
                return Err("Approval ensure 返回了不可能的状态".into());
            }
        };
        let event_created = append_event_idempotent_in_transaction(&mut tx, request_event).await?;
        tx.commit().await?;

        if job_created || approval_created || event_created {
            Ok(ExecutionApprovalMutation::Created {
                job: job_record,
                approval: approval_record,
            })
        } else {
            Ok(ExecutionApprovalMutation::Existing {
                job: job_record,
                approval: approval_record,
            })
        }
    }

    async fn claim_execution_job_with_grant(
        &self,
        job_id: &str,
        expected_job_revision: u64,
        approval_id: &str,
        expected_approval_revision: u64,
        worker_id: &str,
        claim_token: &str,
        lease_expires_at: DateTime<Utc>,
    ) -> Result<ExecutionApprovalMutation, Box<dyn std::error::Error + Send + Sync>> {
        for (field, value) in [
            ("job_id", job_id),
            ("approval_id", approval_id),
            ("worker_id", worker_id),
            ("claim_token", claim_token),
        ] {
            if value.trim().is_empty() {
                return Err(format!("Grant claim {field} 不能为空").into());
            }
        }
        let now = Utc::now();
        if lease_expires_at <= now {
            return Err("Grant claim lease 必须在未来".into());
        }

        let mut tx = self.pool.begin().await?;
        // Acquire SQLite's single-writer slot before creating a deferred read
        // snapshot. Two Runtime workers may race to consume the same one-use
        // Grant; serializing this aggregate boundary makes the loser observe a
        // typed revision conflict instead of SQLITE_BUSY during read-to-write
        // snapshot upgrade.
        sqlx::query("UPDATE execution_jobs SET revision = revision WHERE id = ?")
            .bind(job_id)
            .execute(&mut *tx)
            .await?;
        let job_row = sqlx::query("SELECT * FROM execution_jobs WHERE id = ?")
            .bind(job_id)
            .fetch_optional(&mut *tx)
            .await?;
        let approval_row = sqlx::query("SELECT * FROM approval_requests WHERE id = ?")
            .bind(approval_id)
            .fetch_optional(&mut *tx)
            .await?;
        let (Some(job_row), Some(approval_row)) = (job_row, approval_row) else {
            tx.commit().await?;
            return Ok(ExecutionApprovalMutation::NotFound);
        };
        let job = execution_job_from_row(&job_row)?;
        let approval = approval_from_row(&approval_row)?;
        validate_persisted_approval_authority(&approval)?;

        let grant_id = approval.grant_id.clone();
        let exact_replay = job.status == ExecutionJobStatus::Running
            && job.claimed_by.as_deref() == Some(worker_id)
            && job.claim_token.as_deref() == Some(claim_token)
            && job.approval_ref == grant_id
            && approval.status == ApprovalStatus::Allowed
            && approval.grant_consumed_at.is_some()
            && approval.consumed_by_claim_token.as_deref() == Some(claim_token);
        if exact_replay {
            tx.commit().await?;
            return Ok(ExecutionApprovalMutation::Existing { job, approval });
        }

        if job.revision != expected_job_revision || approval.revision != expected_approval_revision
        {
            tx.commit().await?;
            return Ok(ExecutionApprovalMutation::Conflict {
                job: Some(job),
                approval: Some(approval),
                reason: "Execution Job 或 Approval revision 已变化".to_string(),
            });
        }
        if approval.job_id != job.id {
            tx.commit().await?;
            return Ok(ExecutionApprovalMutation::Rejected {
                job: Some(job),
                approval: Some(approval),
                reason: "Approval Grant 不属于目标 Execution Job".to_string(),
            });
        }
        if job.status != ExecutionJobStatus::WaitingApproval
            || job.cancel_requested_at.is_some()
            || job.approval_ref.is_some()
        {
            tx.commit().await?;
            return Ok(ExecutionApprovalMutation::Rejected {
                job: Some(job),
                approval: Some(approval),
                reason: "Execution Job 不处于可消费 Grant 的 waiting_approval 状态".to_string(),
            });
        }
        if approval.status != ApprovalStatus::Allowed
            || approval.grant_consumed_at.is_some()
            || approval.consumed_by_claim_token.is_some()
        {
            tx.commit().await?;
            return Ok(ExecutionApprovalMutation::Rejected {
                job: Some(job),
                approval: Some(approval),
                reason: "Approval 尚未允许、已取消或 Grant 已被消费".to_string(),
            });
        }
        let Some(grant_id) = grant_id else {
            return Err("Allowed Approval 缺少 Grant ID".into());
        };

        let expected_job_sql = i64::try_from(expected_job_revision)
            .map_err(|_| "Execution Job revision 超出 SQLite INTEGER 范围")?;
        let expected_approval_sql = i64::try_from(expected_approval_revision)
            .map_err(|_| "Approval revision 超出 SQLite INTEGER 范围")?;
        let now_text = now.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let lease_text = lease_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);

        let consumed = sqlx::query(
            r#"UPDATE approval_requests
               SET revision = revision + 1, grant_consumed_at = ?,
                   consumed_by_claim_token = ?, last_error = NULL, updated_at = ?
               WHERE id = ? AND revision = ? AND job_id = ? AND status = 'allowed'
                 AND grant_id = ? AND grant_consumed_at IS NULL
                 AND consumed_by_claim_token IS NULL"#,
        )
        .bind(&now_text)
        .bind(claim_token)
        .bind(&now_text)
        .bind(approval_id)
        .bind(expected_approval_sql)
        .bind(job_id)
        .bind(&grant_id)
        .execute(&mut *tx)
        .await?;
        if consumed.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(ExecutionApprovalMutation::Conflict {
                job: self.get_execution_job(job_id).await?,
                approval: self.get_approval(approval_id).await?,
                reason: "Approval Grant 消费前置条件不再成立".to_string(),
            });
        }

        let claimed = sqlx::query(
            r#"UPDATE execution_jobs
               SET revision = revision + 1, status = 'running', claimed_by = ?,
                   claim_token = ?, lease_expires_at = ?, heartbeat_at = ?,
                   approval_ref = ?, started_at = COALESCE(started_at, ?), updated_at = ?
               WHERE id = ? AND revision = ? AND status = 'waiting_approval'
                 AND approval_ref IS NULL AND cancel_requested_at IS NULL"#,
        )
        .bind(worker_id)
        .bind(claim_token)
        .bind(lease_text)
        .bind(&now_text)
        .bind(&grant_id)
        .bind(&now_text)
        .bind(&now_text)
        .bind(job_id)
        .bind(expected_job_sql)
        .execute(&mut *tx)
        .await?;
        if claimed.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(ExecutionApprovalMutation::Conflict {
                job: self.get_execution_job(job_id).await?,
                approval: self.get_approval(approval_id).await?,
                reason: "Execution Job claim 前置条件不再成立；Grant 消费已回滚".to_string(),
            });
        }

        let updated_job = sqlx::query("SELECT * FROM execution_jobs WHERE id = ?")
            .bind(job_id)
            .fetch_one(&mut *tx)
            .await?;
        let updated_approval = sqlx::query("SELECT * FROM approval_requests WHERE id = ?")
            .bind(approval_id)
            .fetch_one(&mut *tx)
            .await?;
        let updated_job = execution_job_from_row(&updated_job)?;
        let updated_approval = approval_from_row(&updated_approval)?;
        tx.commit().await?;
        Ok(ExecutionApprovalMutation::Updated {
            job: updated_job,
            approval: updated_approval,
        })
    }
}

async fn approval_mutation_failure(
    store: &SqliteStore,
    id: &str,
    expected_revision: u64,
    reason: impl Into<String>,
) -> Result<ApprovalMutation, Box<dyn std::error::Error + Send + Sync>> {
    Ok(match store.get_approval(id).await? {
        Some(current) if current.revision != expected_revision => ApprovalMutation::Conflict {
            current,
            reason: reason.into(),
        },
        Some(current) => ApprovalMutation::Rejected {
            current,
            reason: reason.into(),
        },
        None => ApprovalMutation::NotFound,
    })
}

#[async_trait::async_trait]
impl EventStore for SqliteStore {
    async fn append(&self, ev: Event) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.append_batch(vec![EventAppend {
            event: ev,
            signal_outbox: false,
        }])
        .await
    }

    async fn append_with_signal_outbox(
        &self,
        ev: Event,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.append_batch(vec![EventAppend {
            event: ev,
            signal_outbox: true,
        }])
        .await
    }

    async fn append_batch(
        &self,
        entries: Vec<EventAppend>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if entries.is_empty() {
            return Ok(());
        }
        let mut tx = self.pool.begin().await?;
        for entry in &entries {
            append_event_idempotent_in_transaction(&mut tx, &entry.event).await?;
            if entry.signal_outbox {
                append_signal_outbox_in_transaction(&mut tx, &entry.event).await?;
            }
        }
        tx.commit().await?;
        Ok(())
    }

    async fn query(
        &self,
        filter: QueryFilter,
    ) -> Result<Vec<Event>, Box<dyn std::error::Error + Send + Sync>> {
        let mut builder = QueryBuilder::new(
            "SELECT rowid AS event_sequence, id, timestamp, actor, type, topic, payload FROM events WHERE 1=1",
        );

        if let Some(event_id) = filter.event_id {
            builder.push(" AND id = ");
            builder.push_bind(event_id);
        }
        if !filter.event_ids.is_empty() {
            builder.push(" AND id IN (");
            let mut separated = builder.separated(", ");
            for event_id in &filter.event_ids {
                separated.push_bind(event_id);
            }
            builder.push(")");
        }

        if let Some(sequence) = filter.sequence {
            builder.push(" AND rowid = ");
            builder.push_bind(i64::try_from(sequence).unwrap_or(i64::MAX));
        }

        if let Some(context_id) = filter.context_id {
            builder.push(" AND context_id = ");
            builder.push_bind(context_id);
        }

        if let Some(session_id) = filter.session_id {
            builder.push(" AND session_id = ");
            builder.push_bind(session_id);
        } else if !filter.session_ids.is_empty() {
            builder.push(" AND (");
            if filter.include_context_wide {
                builder.push("session_id IS NULL OR ");
            }
            builder.push("session_id IN (");
            let mut separated = builder.separated(", ");
            for session_id in &filter.session_ids {
                separated.push_bind(session_id);
            }
            builder.push("))");
        } else if filter.include_context_wide {
            builder.push(" AND session_id IS NULL");
        }

        if let Some(after_sequence) = filter.after_sequence {
            builder.push(" AND rowid > ");
            builder.push_bind(i64::try_from(after_sequence).unwrap_or(i64::MAX));
        }

        if let Some(before_sequence) = filter.before_sequence {
            builder.push(" AND rowid < ");
            builder.push_bind(i64::try_from(before_sequence).unwrap_or(i64::MAX));
        }

        if let Some(st) = filter.start_time {
            builder.push(" AND timestamp >= ");
            builder.push_bind(st.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
        }
        if let Some(et) = filter.end_time {
            builder.push(" AND timestamp <= ");
            builder.push_bind(et.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true));
        }

        if !filter.actors.is_empty() {
            builder.push(" AND actor IN (");
            let mut separated = builder.separated(", ");
            for actor in &filter.actors {
                separated.push_bind(actor);
            }
            builder.push(")");
        }

        if !filter.types.is_empty() {
            builder.push(" AND type IN (");
            let mut separated = builder.separated(", ");
            for t in &filter.types {
                separated.push_bind(t);
            }
            builder.push(")");
        }

        if let Some(topic) = filter.topic {
            if topic != "*" {
                if topic.ends_with("/*") {
                    let prefix = &topic[..topic.len() - 2];
                    let (lower, upper) = sqlite_topic_prefix_bounds(prefix);
                    builder
                        .push(" AND topic >= ")
                        .push_bind(lower)
                        .push(" AND topic < ")
                        .push_bind(upper);
                } else {
                    builder.push(" AND topic = ");
                    builder.push_bind(topic);
                }
            }
        }

        for topic in filter.excluded_topics {
            if topic == "*" {
                builder.push(" AND 0=1");
            } else if topic.ends_with("/*") {
                let prefix = &topic[..topic.len() - 2];
                let (lower, upper) = sqlite_topic_prefix_bounds(prefix);
                builder
                    .push(" AND NOT (topic >= ")
                    .push_bind(lower)
                    .push(" AND topic < ")
                    .push_bind(upper)
                    .push(")");
            } else {
                builder.push(" AND topic != ");
                builder.push_bind(topic);
            }
        }

        if let Some(thread_id) = filter.thread_id {
            builder.push(" AND thread_id = ");
            builder.push_bind(thread_id);
        }
        if let Some(activation_id) = filter.activation_id {
            builder.push(" AND activation_id = ");
            builder.push_bind(activation_id);
        }
        if let Some(root_turn_id) = filter.root_turn_id {
            builder.push(" AND root_turn_id = ");
            builder.push_bind(root_turn_id);
        }
        if let Some(objective_id) = filter.objective_id {
            builder.push(" AND objective_id = ");
            builder.push_bind(objective_id);
        }

        let latest_k = filter.latest_k;
        if latest_k.is_some() {
            // Limit the tail in SQLite, then restore chronological order below.
            builder.push(" ORDER BY timestamp DESC, rowid DESC");
        } else {
            // 强制按时间戳升序排序，并在时间戳相同时按 rowid 物理插入顺序升序
            builder.push(" ORDER BY timestamp ASC, rowid ASC");
        }

        if let Some(top_k) = latest_k.or(filter.top_k) {
            builder.push(" LIMIT ");
            builder.push_bind(top_k as i64);
        }

        let query = builder.build();
        let rows = query.fetch_all(&self.pool).await?;

        let mut events = Vec::new();
        for row in rows {
            let sequence: i64 = row.get("event_sequence");
            let id: String = row.get("id");
            let timestamp_str: String = row.get("timestamp");
            let actor: String = row.get("actor");
            let event_type: String = row.get("type");
            let topic: String = row.get("topic");
            let payload_str: String = row.get("payload");

            let payload: serde_json::Map<String, JsonValue> = serde_json::from_str(&payload_str)?;
            let timestamp = parse_time(&timestamp_str);

            events.push(Event {
                id,
                sequence: u64::try_from(sequence).ok(),
                timestamp,
                actor,
                event_type,
                topic,
                payload,
            });
        }

        if latest_k.is_some() {
            events.reverse();
        }

        Ok(events)
    }

    async fn backfill_causal_projection_for_thread(
        &self,
        context_id: &str,
        session_id: &str,
        thread_id: &str,
        topic: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Existing Event payloads remain immutable.  The mutable causal
        // columns are only a query projection.  Most importantly, a
        // Dashboard read must never hold SQLite's single Writer while it
        // rewrites an unbounded legacy history: that used to block durable
        // outcomes, timers and Recall for the full busy timeout.
        //
        // Each inspection therefore migrates at most one small batch.  Until
        // all rows have crossed the projection boundary, later polls continue
        // where the previous one stopped.  The completion marker is written
        // only after the transaction proves that no matching legacy row
        // remains; a crash can at worst repeat one idempotent batch.
        const BACKFILL_BATCH_SIZE: i64 = 32;
        let filled = sqlx::query_scalar::<_, i64>(
            r#"SELECT COUNT(*) FROM event_causal_projection_backfills
               WHERE context_id = ? AND session_id = ? AND thread_id = ? AND topic = ?"#,
        )
        .bind(context_id)
        .bind(session_id)
        .bind(thread_id)
        .bind(topic)
        .fetch_one(&self.pool)
        .await?;
        if filled > 0 {
            return Ok(());
        }
        let mut tx = self.pool.begin().await?;
        let updated = sqlx::query(
            r#"UPDATE events
               SET thread_id = COALESCE(
                       thread_id,
                       json_extract(payload, '$.thread_id'),
                       json_extract(payload, '$.route.thread_id')
                   ),
                   activation_id = COALESCE(
                       activation_id,
                       json_extract(payload, '$.activation_id'),
                       json_extract(payload, '$.route.activation_id')
                   ),
                   root_turn_id = COALESCE(
                       root_turn_id,
                       json_extract(payload, '$.root_turn_id'),
                       json_extract(payload, '$.route.root_turn_id')
                   ),
                   objective_id = COALESCE(
                       objective_id,
                       json_extract(payload, '$.objective_id'),
                       json_extract(payload, '$.route.objective_id')
                   )
               WHERE rowid IN (
                   SELECT rowid FROM events
                   WHERE context_id = ? AND session_id = ? AND topic = ?
                     AND thread_id IS NULL
                     AND COALESCE(
                           json_extract(payload, '$.thread_id'),
                           json_extract(payload, '$.route.thread_id')
                       ) = ?
                   ORDER BY rowid
                   LIMIT ?
               )"#,
        )
        .bind(context_id)
        .bind(session_id)
        .bind(topic)
        .bind(thread_id)
        .bind(BACKFILL_BATCH_SIZE)
        .execute(&mut *tx)
        .await?;
        // Fewer rows than the batch limit proves exhaustion without another
        // unbounded JSON scan while the Writer is held.  Exactly-full final
        // batches need one harmless zero-row poll before receiving the marker.
        let complete = updated.rows_affected() < BACKFILL_BATCH_SIZE as u64;
        if complete {
            sqlx::query(
                r#"INSERT OR IGNORE INTO event_causal_projection_backfills
                   (context_id, session_id, thread_id, topic, completed_at)
                   VALUES (?, ?, ?, ?, ?)"#,
            )
            .bind(context_id)
            .bind(session_id)
            .bind(thread_id)
            .bind(topic)
            .bind(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        if updated.rows_affected() > 0 {
            tracing::debug!(
                context_id,
                session_id,
                thread_id,
                topic,
                rows = updated.rows_affected(),
                complete,
                "有界回填 Event causal projection"
            );
        }
        Ok(())
    }

    async fn list_attention_acknowledgements(
        &self,
        context_id: &str,
    ) -> Result<Vec<AttentionAcknowledgementRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = sqlx::query(
            r#"SELECT event_id, context_id, key, source_kind, source_id,
                      source_revision, acknowledged_by, rationale, acknowledged_at
               FROM attention_acknowledgements
               WHERE context_id = ?
               ORDER BY acknowledged_at DESC, event_sequence DESC"#,
        )
        .bind(context_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(AttentionAcknowledgementRecord {
                    event_id: row.get("event_id"),
                    context_id: row.get("context_id"),
                    key: row.get("key"),
                    source_kind: row.get("source_kind"),
                    source_id: row.get("source_id"),
                    source_revision: u64::try_from(row.get::<i64, _>("source_revision"))?,
                    acknowledged_by: row.get("acknowledged_by"),
                    rationale: row.get("rationale"),
                    acknowledged_at: parse_time(&row.get::<String, _>("acknowledged_at")),
                })
            })
            .collect()
    }
}

fn recall_kind_from_str(
    value: &str,
) -> Result<RecallDocumentKind, Box<dyn std::error::Error + Send + Sync>> {
    match value {
        "event" => Ok(RecallDocumentKind::Event),
        "frame" => Ok(RecallDocumentKind::Frame),
        other => Err(format!("未知 Recall document kind: {other}").into()),
    }
}

async fn sqlite_recall_capability(
    pool: &SqlitePool,
) -> Result<RecallIndexCapability, Box<dyn std::error::Error + Send + Sync>> {
    let indexed = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'recall_documents_fts'",
    )
    .fetch_one(pool)
    .await?
        > 0;
    Ok(RecallIndexCapability {
        mode: if indexed {
            crate::memory::LexicalSearchMode::SqliteFts5Segmented
        } else {
            crate::memory::LexicalSearchMode::ExactDocumentOnly
        },
        indexed,
        unicode_normalization: "nfkc+lowercase".to_string(),
        segmenter: crate::memory::RECALL_SEGMENTER.to_string(),
        detail: if indexed {
            "SQLite FTS5 unicode61 index over Runtime-segmented terms".to_string()
        } else {
            "SQLite FTS5 unavailable; exact Recall document id only".to_string()
        },
    })
}

/// Builds an FTS5 expression from already-segmented terms.
///
/// Every term is quoted, so FTS5 operators inside user text stay literal. A
/// phrase groups the terms into one quoted sequence and therefore requires
/// them to be adjacent; otherwise any distinct term may enter the candidate
/// set. Runtime-level coverage ranking removes weak one-word noise.
fn sqlite_fts_query(terms: &[String], phrase: bool) -> String {
    let quoted = |term: &String| term.replace('"', "\"\"");
    if phrase {
        return format!(
            "\"{}\"",
            terms.iter().map(quoted).collect::<Vec<_>>().join(" ")
        );
    }
    let mut seen = std::collections::HashSet::new();
    terms
        .iter()
        .filter(|term| seen.insert(term.as_str()))
        .map(|term| format!("\"{}\"", quoted(term)))
        .collect::<Vec<_>>()
        .join(" OR ")
}

/// Topics are Runtime-owned slash-separated identifiers.  SQLite's default
/// case-insensitive `LIKE` does not reliably use the B-tree topic index, even
/// for a deterministic `prefix/*` query.  Encode the prefix as a binary range
/// instead: `["prefix/", "prefix/\\u{10ffff}")` is exact for a slash
/// segment and is indexable by `idx_events_topic` and the Context/topic
/// composite index.
fn sqlite_topic_prefix_bounds(prefix: &str) -> (String, String) {
    let lower = format!("{prefix}/");
    let upper = format!("{lower}\u{10ffff}");
    (lower, upper)
}

#[derive(Debug)]
struct SqliteRecallOutboxClaim {
    context_id: String,
    document_kind: RecallDocumentKind,
    document_id: String,
    generation: u64,
    document_json: String,
    claim_token: String,
}

async fn claim_sqlite_recall_outbox(
    pool: &SqlitePool,
    worker_id: &str,
    limit: usize,
) -> Result<Vec<SqliteRecallOutboxClaim>, Box<dyn std::error::Error + Send + Sync>> {
    let now = Utc::now();
    let now_text = now.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    let lease_text =
        (now + chrono::Duration::seconds(30)).to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    let candidates = sqlx::query(
        r#"SELECT context_id, document_kind, document_id, generation, document_json
           FROM recall_projection_outbox
           WHERE (status = 'pending' AND available_at <= ?)
              OR (status = 'processing' AND claim_expires_at <= ?)
           ORDER BY updated_at ASC, context_id, document_kind, document_id
           LIMIT ?"#,
    )
    .bind(&now_text)
    .bind(&now_text)
    .bind(i64::try_from(limit.clamp(1, 64))?)
    .fetch_all(pool)
    .await?;
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let mut tx = pool.begin().await?;
    let mut claimed = Vec::new();
    for (index, row) in candidates.into_iter().enumerate() {
        let context_id = row.get::<String, _>("context_id");
        let kind_text = row.get::<String, _>("document_kind");
        let document_id = row.get::<String, _>("document_id");
        let generation = u64::try_from(row.get::<i64, _>("generation"))?;
        let claim_token = format!("{worker_id}:{now_text}:{index}");
        let updated = sqlx::query(
            r#"UPDATE recall_projection_outbox
               SET status = 'processing', claimed_by = ?, claim_expires_at = ?, updated_at = ?
               WHERE context_id = ? AND document_kind = ? AND document_id = ?
                 AND generation = ?
                 AND ((status = 'pending' AND available_at <= ?)
                   OR (status = 'processing' AND claim_expires_at <= ?))"#,
        )
        .bind(&claim_token)
        .bind(&lease_text)
        .bind(&now_text)
        .bind(&context_id)
        .bind(&kind_text)
        .bind(&document_id)
        .bind(i64::try_from(generation)?)
        .bind(&now_text)
        .bind(&now_text)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() == 1 {
            claimed.push(SqliteRecallOutboxClaim {
                context_id,
                document_kind: recall_kind_from_str(&kind_text)?,
                document_id,
                generation,
                document_json: row.get("document_json"),
                claim_token,
            });
        }
    }
    tx.commit().await?;
    Ok(claimed)
}

async fn materialize_sqlite_recall_claim(
    pool: &SqlitePool,
    claim: &SqliteRecallOutboxClaim,
) -> Result<Option<RecallDocument>, Box<dyn std::error::Error + Send + Sync>> {
    match claim.document_kind {
        RecallDocumentKind::Frame => Ok(Some(crate::memory::bound_recall_document(
            serde_json::from_str(&claim.document_json)?,
        ))),
        RecallDocumentKind::Event => {
            let Some(row) = sqlx::query(
                r#"SELECT rowid AS event_sequence, id, timestamp, actor, type, topic, payload
                   FROM events WHERE id = ? AND context_id = ?"#,
            )
            .bind(&claim.document_id)
            .bind(&claim.context_id)
            .fetch_optional(pool)
            .await?
            else {
                return Ok(None);
            };
            let event = Event {
                id: row.get("id"),
                sequence: u64::try_from(row.get::<i64, _>("event_sequence")).ok(),
                timestamp: parse_time(&row.get::<String, _>("timestamp")),
                actor: row.get("actor"),
                event_type: row.get("type"),
                topic: row.get("topic"),
                payload: serde_json::from_str(&row.get::<String, _>("payload"))?,
            };
            if !crate::memory::event_has_recall_value(&event) {
                return Ok(None);
            }
            let retired = serde_json::from_str::<JsonValue>(&claim.document_json)?
                .get("retired")
                .and_then(JsonValue::as_bool)
                .unwrap_or(false);
            Ok(Some(crate::memory::event_recall_document_with_retired(
                &event,
                &claim.context_id,
                event.sequence.unwrap_or_default(),
                retired,
            )))
        }
    }
}

async fn finish_sqlite_recall_claim(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    claim: &SqliteRecallOutboxClaim,
    document: Option<&RecallDocument>,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    // A deferred SQLite transaction does not acquire the Writer until its
    // first mutation. Make that boundary explicit so diagnostics can separate
    // waiting for another Writer from the Recall/FTS work performed after the
    // lock has been acquired. The no-op assignment preserves the durable claim.
    let writer_wait_started = std::time::Instant::now();
    let current = sqlx::query(
        r#"UPDATE recall_projection_outbox SET updated_at = updated_at
           WHERE context_id = ? AND document_kind = ? AND document_id = ?
             AND generation = ? AND status = 'processing' AND claimed_by = ?"#,
    )
    .bind(&claim.context_id)
    .bind(claim.document_kind.as_str())
    .bind(&claim.document_id)
    .bind(i64::try_from(claim.generation)?)
    .bind(&claim.claim_token)
    .execute(&mut **tx)
    .await?
    .rows_affected()
        == 1;
    let writer_wait = writer_wait_started.elapsed();
    if writer_wait >= std::time::Duration::from_millis(500) {
        tracing::warn!(
            context_id = %claim.context_id,
            document_kind = %claim.document_kind.as_str(),
            document_id = %claim.document_id,
            generation = claim.generation,
            writer_wait_ms = writer_wait.as_millis(),
            "Recall Projection 等待 SQLite Writer 过久"
        );
    } else {
        tracing::debug!(
            context_id = %claim.context_id,
            document_kind = %claim.document_kind.as_str(),
            document_id = %claim.document_id,
            generation = claim.generation,
            writer_wait_ms = writer_wait.as_millis(),
            "Recall Projection 已取得 SQLite Writer"
        );
    }
    if !current {
        return Ok(false);
    }
    if let Some(document) = document {
        upsert_recall_document_in_transaction(tx, document).await?;
    }
    sqlx::query(
        r#"DELETE FROM recall_projection_outbox
           WHERE context_id = ? AND document_kind = ? AND document_id = ?
             AND generation = ? AND claimed_by = ?"#,
    )
    .bind(&claim.context_id)
    .bind(claim.document_kind.as_str())
    .bind(&claim.document_id)
    .bind(i64::try_from(claim.generation)?)
    .bind(&claim.claim_token)
    .execute(&mut **tx)
    .await?;
    Ok(true)
}

#[async_trait::async_trait]
impl CognitiveClockStore for SqliteStore {
    async fn get_context_cognitive_clock(
        &self,
        context_id: &str,
    ) -> Result<ContextCognitiveClock, Box<dyn std::error::Error + Send + Sync>> {
        let row = sqlx::query(
            "SELECT tick, last_signal_batch_id, revision FROM context_cognitive_clocks WHERE context_id = ?",
        )
        .bind(context_id)
        .fetch_optional(&self.pool)
        .await?;
        match row {
            Some(row) => Ok(ContextCognitiveClock {
                context_id: context_id.to_string(),
                tick: u64::try_from(row.get::<i64, _>("tick"))?,
                last_signal_batch_id: row.get("last_signal_batch_id"),
                revision: u64::try_from(row.get::<i64, _>("revision"))?,
            }),
            None => Ok(ContextCognitiveClock {
                context_id: context_id.to_string(),
                tick: 0,
                last_signal_batch_id: None,
                revision: 0,
            }),
        }
    }
}

#[async_trait::async_trait]
impl RecallProjectionStore for SqliteStore {
    async fn recall_index_capability(
        &self,
    ) -> Result<RecallIndexCapability, Box<dyn std::error::Error + Send + Sync>> {
        sqlite_recall_capability(&self.pool).await
    }

    async fn search_recall_documents(
        &self,
        context_id: &str,
        normalized_query: &str,
        limit: usize,
    ) -> Result<Vec<RecallSearchHit>, Box<dyn std::error::Error + Send + Sync>> {
        let limit = limit.clamp(1, 100);
        let candidate_limit = (limit.saturating_mul(8)).clamp(64, 512);
        let capability = sqlite_recall_capability(&self.pool).await?;
        // The index stores Runtime-segmented terms, so the query has to be
        // segmented the same way or it cannot match the Projection. Every
        // term is indexable now: the previous three-character floor came from
        // the trigram tokenizer and silently dropped the most common Chinese
        // word form out of Recall.
        let (requested, phrase) = crate::memory::recall_phrase_request(normalized_query);
        let terms = crate::memory::segment_recall_terms(requested);
        let use_fts = capability.indexed && !terms.is_empty();
        let rows = if use_fts {
            let expression = sqlite_fts_query(&terms, phrase);
            sqlx::query(
                r#"SELECT d.document_kind, d.document_id, d.revision, d.retired,
                          d.preview, d.searchable_text, d.updated_sequence,
                          CASE WHEN d.document_id = ? THEN 1000000.0
                               ELSE -bm25(recall_documents_fts) END AS score
                   FROM recall_documents_fts
                   JOIN recall_documents d
                     ON d.context_id = recall_documents_fts.context_id
                    AND d.document_kind = recall_documents_fts.document_kind
                    AND d.document_id = recall_documents_fts.document_id
                   WHERE recall_documents_fts MATCH ?
                     AND recall_documents_fts.context_id = ?
                   ORDER BY (d.document_id = ?) DESC,
                            bm25(recall_documents_fts) ASC,
                            d.updated_sequence DESC, d.document_id ASC
                   LIMIT ?"#,
            )
            .bind(normalized_query)
            .bind(expression)
            .bind(context_id)
            .bind(normalized_query)
            .bind(i64::try_from(candidate_limit)?)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                r#"SELECT document_kind, document_id, revision, retired, preview,
                          searchable_text,
                          updated_sequence,
                          CASE WHEN document_id = ? THEN 1000000.0 ELSE 1.0 END AS score
                   FROM recall_documents
                   WHERE context_id = ? AND document_id = ?
                   ORDER BY (document_id = ?) DESC, updated_sequence DESC, document_id ASC
                   LIMIT ?"#,
            )
            .bind(normalized_query)
            .bind(context_id)
            .bind(normalized_query)
            .bind(normalized_query)
            .bind(i64::try_from(limit)?)
            .fetch_all(&self.pool)
            .await?
        };
        let candidates = rows
            .into_iter()
            .map(|row| {
                Ok(crate::memory::RecallSearchCandidate {
                    searchable_text: row.get("searchable_text"),
                    hit: RecallSearchHit {
                        document_kind: recall_kind_from_str(
                            &row.get::<String, _>("document_kind"),
                        )?,
                        document_id: row.get("document_id"),
                        revision: u64::try_from(row.get::<i64, _>("revision"))?,
                        retired: row.get::<i64, _>("retired") != 0,
                        score: row.get("score"),
                        preview: row.get("preview"),
                        updated_sequence: u64::try_from(row.get::<i64, _>("updated_sequence"))?,
                    },
                })
            })
            .collect::<Result<Vec<_>, Box<dyn std::error::Error + Send + Sync>>>()?;
        Ok(crate::memory::rank_recall_candidates(
            candidates,
            &terms,
            phrase,
            normalized_query,
            limit,
        ))
    }

    async fn replace_recall_documents(
        &self,
        context_id: &str,
        documents: &[RecallDocument],
    ) -> Result<RecallIndexAudit, Box<dyn std::error::Error + Send + Sync>> {
        if documents
            .iter()
            .any(|document| document.context_id != context_id)
        {
            return Err("Recall rebuild document 属于错误的 Context".into());
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM recall_projection_outbox WHERE context_id = ?")
            .bind(context_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM recall_documents WHERE context_id = ?")
            .bind(context_id)
            .execute(&mut *tx)
            .await?;
        for document in documents {
            upsert_recall_document_in_transaction(&mut tx, document).await?;
        }
        tx.commit().await?;
        self.inspect_recall_index(context_id).await
    }

    async fn inspect_recall_index(
        &self,
        context_id: &str,
    ) -> Result<RecallIndexAudit, Box<dyn std::error::Error + Send + Sync>> {
        let rows = sqlx::query(
            r#"SELECT document_kind, COUNT(*) AS count
               FROM recall_documents WHERE context_id = ? GROUP BY document_kind"#,
        )
        .bind(context_id)
        .fetch_all(&self.pool)
        .await?;
        let mut event_documents = 0;
        let mut frame_documents = 0;
        for row in rows {
            match row.get::<String, _>("document_kind").as_str() {
                "event" => event_documents = u64::try_from(row.get::<i64, _>("count"))?,
                "frame" => frame_documents = u64::try_from(row.get::<i64, _>("count"))?,
                _ => {}
            }
        }
        Ok(RecallIndexAudit {
            context_id: context_id.to_string(),
            capability: sqlite_recall_capability(&self.pool).await?,
            event_documents,
            frame_documents,
        })
    }

    async fn project_recall_outbox_batch(
        &self,
        worker_id: &str,
        limit: usize,
    ) -> Result<RecallProjectionBatch, Box<dyn std::error::Error + Send + Sync>> {
        let claims = claim_sqlite_recall_outbox(&self.pool, worker_id, limit).await?;
        let mut result = RecallProjectionBatch {
            claimed: claims.len(),
            ..RecallProjectionBatch::default()
        };
        if claims.is_empty() {
            return Ok(result);
        }
        for claim in claims {
            match materialize_sqlite_recall_claim(&self.pool, &claim).await {
                Ok(document) => {
                    let transaction_started = std::time::Instant::now();
                    let mut tx = self.pool.begin().await?;
                    let transaction_open_elapsed = transaction_started.elapsed();
                    let finished =
                        finish_sqlite_recall_claim(&mut tx, &claim, document.as_ref()).await?;
                    if finished {
                        if document.is_some() {
                            result.projected += 1;
                        } else {
                            result.skipped += 1;
                        }
                    } else {
                        result.skipped += 1;
                    }
                    let commit_started = std::time::Instant::now();
                    tx.commit().await?;
                    let commit_elapsed = commit_started.elapsed();
                    if transaction_open_elapsed >= std::time::Duration::from_millis(500)
                        || commit_elapsed >= std::time::Duration::from_millis(500)
                    {
                        tracing::warn!(
                            context_id = %claim.context_id,
                            document_kind = %claim.document_kind.as_str(),
                            document_id = %claim.document_id,
                            generation = claim.generation,
                            transaction_open_ms = transaction_open_elapsed.as_millis(),
                            commit_ms = commit_elapsed.as_millis(),
                            "Recall Projection 事务阶段耗时过长"
                        );
                    } else {
                        tracing::debug!(
                            context_id = %claim.context_id,
                            document_kind = %claim.document_kind.as_str(),
                            document_id = %claim.document_id,
                            generation = claim.generation,
                            transaction_open_ms = transaction_open_elapsed.as_millis(),
                            commit_ms = commit_elapsed.as_millis(),
                            "Recall Projection 事务提交完成"
                        );
                    }
                }
                Err(error) => {
                    let now = Utc::now();
                    let attempts = sqlx::query_scalar::<_, i64>(
                        r#"SELECT attempts FROM recall_projection_outbox
                           WHERE context_id = ? AND document_kind = ? AND document_id = ?
                             AND generation = ? AND claimed_by = ?"#,
                    )
                    .bind(&claim.context_id)
                    .bind(claim.document_kind.as_str())
                    .bind(&claim.document_id)
                    .bind(i64::try_from(claim.generation)?)
                    .bind(&claim.claim_token)
                    .fetch_optional(&self.pool)
                    .await?
                    .unwrap_or(0);
                    let backoff_secs = 1_i64 << u32::try_from(attempts.clamp(0, 6))?;
                    sqlx::query(
                        r#"UPDATE recall_projection_outbox
                           SET status = 'pending', attempts = attempts + 1,
                               available_at = ?, claimed_by = NULL, claim_expires_at = NULL,
                               last_error = ?, updated_at = ?
                           WHERE context_id = ? AND document_kind = ? AND document_id = ?
                             AND generation = ? AND claimed_by = ?"#,
                    )
                    .bind(
                        (now + chrono::Duration::seconds(backoff_secs))
                            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
                    )
                    .bind(error.to_string())
                    .bind(now.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
                    .bind(&claim.context_id)
                    .bind(claim.document_kind.as_str())
                    .bind(&claim.document_id)
                    .bind(i64::try_from(claim.generation)?)
                    .bind(&claim.claim_token)
                    .execute(&self.pool)
                    .await?;
                    result.failed += 1;
                }
            }
        }
        Ok(result)
    }
}

#[async_trait::async_trait]
impl SessionProjectionStore for SqliteStore {
    async fn query_session_projections(
        &self,
        context_id: &str,
        session_ids: &[String],
        include_context_wide: bool,
    ) -> Result<Vec<Event>, Box<dyn std::error::Error + Send + Sync>> {
        let mut builder = QueryBuilder::new(
            r#"SELECT e.rowid AS event_sequence, e.id, e.timestamp, e.actor,
                      e.type, e.topic, e.payload
               FROM session_projections projection
               JOIN events e ON e.id = projection.event_id
               WHERE projection.context_id = "#,
        );
        builder.push_bind(context_id);
        builder.push(" AND (");
        if include_context_wide {
            builder.push("projection.session_id IS NULL");
            if !session_ids.is_empty() {
                builder.push(" OR ");
            }
        }
        if !session_ids.is_empty() {
            builder.push("projection.session_id IN (");
            let mut separated = builder.separated(", ");
            for session_id in session_ids {
                separated.push_bind(session_id);
            }
            builder.push(")");
        } else if !include_context_wide {
            builder.push("0");
        }
        builder.push(") ORDER BY e.rowid ASC");
        let rows = builder.build().fetch_all(&self.pool).await?;
        rows.into_iter()
            .map(|row| {
                Ok(Event {
                    id: row.get("id"),
                    sequence: u64::try_from(row.get::<i64, _>("event_sequence")).ok(),
                    timestamp: parse_time(&row.get::<String, _>("timestamp")),
                    actor: row.get("actor"),
                    event_type: row.get("type"),
                    topic: row.get("topic"),
                    payload: serde_json::from_str(&row.get::<String, _>("payload"))?,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval_authority::stable_approval_identity;
    use crate::memory::QueryFilter;
    use std::collections::HashMap;
    use std::sync::Arc;
    use tempfile::NamedTempFile;

    #[test]
    fn wal_reset_fix_version_gate_matches_upstream_backports() {
        assert!(!sqlite_has_wal_reset_fix("3.46.0"));
        assert!(!sqlite_has_wal_reset_fix("3.51.2"));
        assert!(sqlite_has_wal_reset_fix("3.44.6"));
        assert!(sqlite_has_wal_reset_fix("3.50.7"));
        assert!(sqlite_has_wal_reset_fix("3.51.3"));
        assert!(sqlite_has_wal_reset_fix("3.53.3"));
        assert!(!sqlite_has_wal_reset_fix("invalid"));
    }

    #[tokio::test]
    async fn linked_sqlite_contains_wal_reset_fix() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(":memory:")
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        let version: String = sqlx::query_scalar("SELECT sqlite_version()")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(
            sqlite_has_wal_reset_fix(&version),
            "linked SQLite {version} is vulnerable to the WAL-reset race"
        );
    }

    async fn seed_identity_directory(store: &SqliteStore) {
        store
            .create_agent_bundle(
                NewAgent {
                    id: "identity-agent".to_string(),
                    title: "Identity Agent".to_string(),
                    root_context_id: "identity-context".to_string(),
                },
                NewCognitiveContext {
                    id: "identity-context".to_string(),
                    agent_id: "identity-agent".to_string(),
                    title: "Identity Context".to_string(),
                },
                NewSession {
                    id: "identity-session-a1".to_string(),
                    agent_id: "identity-agent".to_string(),
                    context_id: "identity-context".to_string(),
                    parent_session_id: None,
                    title: "A1".to_string(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        store
            .create_session(NewSession {
                id: "identity-session-a2".to_string(),
                agent_id: "identity-agent".to_string(),
                context_id: "identity-context".to_string(),
                parent_session_id: None,
                title: "A2".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn principal_directory_is_many_to_many_and_survives_restart() {
        let tmp_file = NamedTempFile::new().unwrap();
        let path = tmp_file.path().to_string_lossy().to_string();
        let store = SqliteStore::new(&path).await.unwrap();
        seed_identity_directory(&store).await;
        for id in ["principal:a", "principal:b"] {
            store
                .ensure_principal(NewPrincipal {
                    id: id.to_string(),
                    provider_id: "test-provider".to_string(),
                    assurance: "verified".to_string(),
                    display_name: Some("Alice".to_string()),
                })
                .await
                .unwrap();
        }
        store
            .bind_session_principal("identity-session-a1", "principal:a")
            .await
            .unwrap();
        store
            .bind_session_principal("identity-session-a2", "principal:a")
            .await
            .unwrap();
        store
            .bind_session_principal("identity-session-a1", "principal:b")
            .await
            .unwrap();

        assert!(store
            .verify_session_principal("identity-session-a2", "principal:a")
            .await
            .unwrap());
        assert!(!store
            .verify_session_principal("identity-session-a2", "principal:b")
            .await
            .unwrap());
        assert_eq!(
            store
                .list_session_principals("identity-session-a1")
                .await
                .unwrap()
                .into_iter()
                .map(|binding| binding.principal_id)
                .collect::<Vec<_>>(),
            ["principal:a", "principal:b"]
        );
        assert_eq!(
            store
                .list_context_principal_bindings("identity-context")
                .await
                .unwrap()
                .len(),
            3
        );
        let mismatch = store
            .ensure_principal(NewPrincipal {
                id: "principal:a".to_string(),
                provider_id: "other-provider".to_string(),
                assurance: "verified".to_string(),
                display_name: None,
            })
            .await
            .unwrap_err();
        assert!(mismatch.to_string().contains("provider"));

        store.pool.close().await;
        let restarted = SqliteStore::new(&path).await.unwrap();
        assert!(restarted
            .verify_session_principal("identity-session-a1", "principal:b")
            .await
            .unwrap());
        assert_eq!(
            restarted
                .get_principal("principal:a")
                .await
                .unwrap()
                .unwrap()
                .display_name
                .as_deref(),
            Some("Alice")
        );
    }

    #[tokio::test]
    async fn principal_causal_route_is_persistent_and_fences_conflicting_replay() {
        let tmp_file = NamedTempFile::new().unwrap();
        let path = tmp_file.path().to_string_lossy().to_string();
        let store = SqliteStore::new(&path).await.unwrap();
        seed_identity_directory(&store).await;
        let event = Event::new(
            "identity-event-a".to_string(),
            "User".to_string(),
            crate::event::TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            serde_json::json!({
                "context_id": "identity-context",
                "session_id": "identity-session-a1",
                "principal_id": "principal:a",
                "text": "hello"
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        store.append(event).await.unwrap();
        let sequence = store
            .query(QueryFilter {
                event_id: Some("identity-event-a".to_string()),
                ..Default::default()
            })
            .await
            .unwrap()[0]
            .sequence
            .unwrap();
        let thread = store
            .ensure_thread(NewThread {
                id: "identity-thread".to_string(),
                agent_id: "identity-agent".to_string(),
                context_id: "identity-context".to_string(),
                session_id: "identity-session-a1".to_string(),
                initiating_principal_id: Some("principal:a".to_string()),
                root_turn_id: "identity-event-a".to_string(),
                kind: ThreadKind::DialogueTurn,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
            })
            .await
            .unwrap();
        let activation = store
            .claim_thread_signal_batch(
                NewThreadSignal {
                    id: "identity-signal".to_string(),
                    thread_id: thread.id.clone(),
                    event_id: "identity-event-a".to_string(),
                    principal_id: Some("principal:a".to_string()),
                    sequence,
                    kind: "chat/user_message".to_string(),
                    parent_activation_id: None,
                },
                NewThreadActivation {
                    id: "identity-activation".to_string(),
                    agent_id: "identity-agent".to_string(),
                    context_id: "identity-context".to_string(),
                    session_id: "identity-session-a1".to_string(),
                    initiating_principal_id: Some("principal:a".to_string()),
                    trigger_event_id: "identity-event-a".to_string(),
                    trigger_sequence: sequence,
                    trigger_kind: "chat/user_message".to_string(),
                    parent_activation_id: None,
                    root_turn_id: "identity-event-a".to_string(),
                },
                32,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            activation.initiating_principal_id.as_deref(),
            Some("principal:a")
        );

        let conflict = store
            .ensure_thread(NewThread {
                id: "identity-thread-conflict".to_string(),
                agent_id: "identity-agent".to_string(),
                context_id: "identity-context".to_string(),
                session_id: "identity-session-a1".to_string(),
                initiating_principal_id: Some("principal:b".to_string()),
                root_turn_id: "identity-event-a".to_string(),
                kind: ThreadKind::DialogueTurn,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
            })
            .await
            .unwrap_err();
        assert!(conflict.to_string().contains("Principal"));

        store.pool.close().await;
        let restarted = SqliteStore::new(&path).await.unwrap();
        assert_eq!(
            restarted
                .get_thread("identity-thread")
                .await
                .unwrap()
                .unwrap()
                .initiating_principal_id
                .as_deref(),
            Some("principal:a")
        );
        assert_eq!(
            restarted
                .get_thread_activation("identity-activation")
                .await
                .unwrap()
                .unwrap()
                .initiating_principal_id
                .as_deref(),
            Some("principal:a")
        );
        assert_eq!(
            restarted
                .list_activation_signals("identity-activation")
                .await
                .unwrap()[0]
                .principal_id
                .as_deref(),
            Some("principal:a")
        );
    }

    #[tokio::test]
    async fn recall_projection_indexes_chinese_events_frames_and_nfkc() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        store
            .create_context(NewCognitiveContext {
                id: "recall-context".to_string(),
                agent_id: "recall-agent".to_string(),
                title: "Recall Context".to_string(),
            })
            .await
            .unwrap();

        let event = Event::new(
            "recall-event".to_string(),
            "User".to_string(),
            crate::event::TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            serde_json::json!({
                "context_id": "recall-context",
                "session_id": "recall-session",
                "text": "阳光电源需要检查沙箱权限审批"
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        store.append(event).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM recall_documents WHERE document_kind = 'event'",
            )
            .fetch_one(&store.pool)
            .await
            .unwrap(),
            0,
            "Ledger append must not synchronously maintain the lexical projection"
        );
        let batch = store
            .project_recall_outbox_batch("sqlite-recall-test", 8)
            .await
            .unwrap();
        assert_eq!(batch.projected, 1);
        let frame = RecallDocument {
            context_id: "recall-context".to_string(),
            document_kind: RecallDocumentKind::Frame,
            document_id: "memory/rust-sandbox".to_string(),
            revision: 3,
            // Must go through the same segmenter as the write path; a document
            // tokenized any other way silently stops matching queries.
            searchable_text: crate::memory::segment_recall_text(
                "memory/rust-sandbox Rust 沙箱 权限申请",
            ),
            preview: "Rust 沙箱权限经验".to_string(),
            retired: true,
            updated_sequence: 7,
            state_hash: "frame-hash".to_string(),
        };
        let deployment_frame = RecallDocument {
            context_id: "recall-context".to_string(),
            document_kind: RecallDocumentKind::Frame,
            document_id: "memory/shared-deployment".to_string(),
            revision: 1,
            searchable_text: crate::memory::segment_recall_text(
                "三个产品部署到同一个物理节点，共享服务器资源",
            ),
            preview: "三个产品共享物理部署节点".to_string(),
            retired: false,
            updated_sequence: 8,
            state_hash: "deployment-hash".to_string(),
        };
        let weak_frame = RecallDocument {
            context_id: "recall-context".to_string(),
            document_kind: RecallDocumentKind::Frame,
            document_id: "memory/server-only".to_string(),
            revision: 1,
            searchable_text: crate::memory::segment_recall_text("服务器健康检查"),
            preview: "服务器健康检查".to_string(),
            retired: false,
            updated_sequence: 9,
            state_hash: "server-hash".to_string(),
        };
        let mut documents = vec![frame, deployment_frame, weak_frame];
        let event_document = sqlx::query(
            "SELECT context_id, document_kind, document_id, revision, searchable_text, preview, retired, updated_sequence, state_hash FROM recall_documents WHERE document_kind = 'event'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        documents.push(RecallDocument {
            context_id: event_document.get("context_id"),
            document_kind: RecallDocumentKind::Event,
            document_id: event_document.get("document_id"),
            revision: u64::try_from(event_document.get::<i64, _>("revision")).unwrap(),
            searchable_text: event_document.get("searchable_text"),
            preview: event_document.get("preview"),
            retired: event_document.get::<i64, _>("retired") != 0,
            updated_sequence: u64::try_from(event_document.get::<i64, _>("updated_sequence"))
                .unwrap(),
            state_hash: event_document.get("state_hash"),
        });
        store
            .replace_recall_documents("recall-context", &documents)
            .await
            .unwrap();

        let chinese = store
            .search_recall_documents(
                "recall-context",
                &crate::memory::normalize_recall_text("权限审批"),
                10,
            )
            .await
            .unwrap();
        assert!(chinese.iter().any(|hit| hit.document_id == "recall-event"));
        let mixed = store
            .search_recall_documents(
                "recall-context",
                &crate::memory::normalize_recall_text("Ｒｕｓｔ 沙箱"),
                10,
            )
            .await
            .unwrap();
        assert_eq!(mixed[0].document_id, "memory/rust-sandbox");
        assert!(mixed[0].retired);
        // A two-character Chinese word is the most common word form in the
        // language and must be an ordinary indexed term, not a lookup that
        // silently returns nothing.
        let short = store
            .search_recall_documents("recall-context", "权限", 10)
            .await
            .unwrap();
        assert!(
            short.iter().any(|hit| hit.document_id == "recall-event"),
            "two-character Chinese query must stay searchable: {short:?}"
        );
        // Default Recall is broad rather than an implicit all-terms contract:
        // a useful document may omit several paraphrase terms. Coverage
        // ranking still removes a document that only shares one generic word.
        let broad = store
            .search_recall_documents(
                "recall-context",
                "三个产品 部署 节点 服务器 一起部署 统一部署",
                10,
            )
            .await
            .unwrap();
        assert_eq!(broad[0].document_id, "memory/shared-deployment");
        assert!(
            broad
                .iter()
                .all(|hit| hit.document_id != "memory/server-only"),
            "one generic term must not outrank meaningful coverage: {broad:?}"
        );
        let exact_id = store
            .search_recall_documents("recall-context", "memory/rust-sandbox", 1)
            .await
            .unwrap();
        assert_eq!(exact_id[0].document_id, "memory/rust-sandbox");

        // A quoted query narrows to an adjacent phrase. `沙箱` is adjacent in
        // the Frame, while these two terms never neighbour each other.
        let phrase_hit = store
            .search_recall_documents("recall-context", "\"沙箱\"", 10)
            .await
            .unwrap();
        assert!(phrase_hit
            .iter()
            .any(|hit| hit.document_id == "memory/rust-sandbox"));
        let phrase_miss = store
            .search_recall_documents("recall-context", "\"权限 沙箱\"", 10)
            .await
            .unwrap();
        assert!(
            phrase_miss.is_empty(),
            "phrase query must require adjacency: {phrase_miss:?}"
        );
        let audit = store.inspect_recall_index("recall-context").await.unwrap();
        assert_eq!(audit.event_documents, 1);
        assert_eq!(audit.frame_documents, 3);
    }

    #[tokio::test]
    async fn recall_fts_reindexes_only_when_search_identity_or_text_changes() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        sqlx::query(
            r#"INSERT INTO recall_documents
               (context_id, document_kind, document_id, revision, searchable_text,
                preview, retired, updated_sequence, state_hash)
               VALUES ('trigger-context', 'frame', 'trigger-frame', 1,
                       '原始 可检索 文本', '原始预览', 0, 1, 'hash-1')"#,
        )
        .execute(&store.pool)
        .await
        .unwrap();
        let original_rowid = sqlx::query_scalar::<_, i64>(
            "SELECT rowid FROM recall_documents_fts WHERE context_id = 'trigger-context' AND document_id = 'trigger-frame'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        // Keep a higher rowid alive so a delete+insert cannot reuse the same
        // numeric rowid and hide an accidental trigger execution.
        sqlx::query(
            r#"INSERT INTO recall_documents
               (context_id, document_kind, document_id, revision, searchable_text,
                preview, retired, updated_sequence, state_hash)
               VALUES ('trigger-context', 'frame', 'trigger-sentinel', 1,
                       '哨兵 文本', '哨兵', 0, 1, 'sentinel-hash')"#,
        )
        .execute(&store.pool)
        .await
        .unwrap();

        sqlx::query(
            r#"UPDATE recall_documents
               SET revision = 2, preview = '更新预览', retired = 1,
                   updated_sequence = 2, state_hash = 'hash-2'
               WHERE context_id = 'trigger-context' AND document_id = 'trigger-frame'"#,
        )
        .execute(&store.pool)
        .await
        .unwrap();
        let metadata_rowid = sqlx::query_scalar::<_, i64>(
            "SELECT rowid FROM recall_documents_fts WHERE context_id = 'trigger-context' AND document_id = 'trigger-frame'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(
            metadata_rowid, original_rowid,
            "metadata-only projection updates must not rebuild trigram entries"
        );

        sqlx::query(
            r#"UPDATE recall_documents SET searchable_text = '更新后的 可检索 文本'
               WHERE context_id = 'trigger-context' AND document_id = 'trigger-frame'"#,
        )
        .execute(&store.pool)
        .await
        .unwrap();
        let text_rowid = sqlx::query_scalar::<_, i64>(
            "SELECT rowid FROM recall_documents_fts WHERE context_id = 'trigger-context' AND document_id = 'trigger-frame'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_ne!(
            text_rowid, original_rowid,
            "searchable text changes must replace the trigram entry"
        );
    }

    #[tokio::test]
    async fn event_topic_query_uses_context_topic_time_index() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let rows = sqlx::query(
            r#"EXPLAIN QUERY PLAN
               SELECT rowid, id, timestamp FROM events
               WHERE context_id = ? AND topic = ?
               ORDER BY timestamp DESC, rowid DESC"#,
        )
        .bind("index-context")
        .bind("runtime/attention_acknowledged")
        .fetch_all(&store.pool)
        .await
        .unwrap();
        let plan = rows
            .iter()
            .map(|row| row.get::<String, _>("detail"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            plan.contains("idx_events_context_topic_time"),
            "unexpected query plan: {plan}"
        );
    }

    #[tokio::test]
    async fn event_topic_prefix_query_uses_indexed_binary_bounds() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let (lower, upper) = sqlite_topic_prefix_bounds("runtime");
        let rows = sqlx::query(
            r#"EXPLAIN QUERY PLAN
               SELECT rowid, id, timestamp FROM events
               WHERE context_id = ? AND topic >= ? AND topic < ?
               ORDER BY timestamp DESC, rowid DESC"#,
        )
        .bind("index-context")
        .bind(lower)
        .bind(upper)
        .fetch_all(&store.pool)
        .await
        .unwrap();
        let plan = rows
            .iter()
            .map(|row| row.get::<String, _>("detail"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            plan.contains("idx_events_context_topic_time"),
            "unexpected query plan: {plan}"
        );

        for (id, topic) in [
            ("prefix-match", "runtime/timer"),
            ("prefix-sibling", "runtimex/timer"),
        ] {
            store
                .append(Event::new(
                    id.to_string(),
                    "Runtime".to_string(),
                    "diagnostic".to_string(),
                    topic.to_string(),
                    serde_json::json!({ "context_id": "index-context" })
                        .as_object()
                        .unwrap()
                        .clone(),
                ))
                .await
                .unwrap();
        }
        let result = store
            .query(QueryFilter {
                context_id: Some("index-context".to_string()),
                topic: Some("runtime/*".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "prefix-match");
    }

    #[tokio::test]
    async fn recall_outbox_filters_diagnostics_bounds_text_and_fences_stale_claims() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        store
            .create_context(NewCognitiveContext {
                id: "recall-outbox-context".to_string(),
                agent_id: "recall-agent".to_string(),
                title: "Recall outbox".to_string(),
            })
            .await
            .unwrap();
        let diagnostic = Event::new(
            "recall-diagnostic".to_string(),
            "Runtime".to_string(),
            "diagnostic".to_string(),
            "chat/context_inspect".to_string(),
            serde_json::json!({
                "context_id": "recall-outbox-context",
                "payload": "x".repeat(100_000)
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        store.append(diagnostic).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM recall_projection_outbox")
                .fetch_one(&store.pool)
                .await
                .unwrap(),
            0,
            "diagnostic Events must never enter Recall"
        );

        let event = Event::new(
            "recall-large-user-event".to_string(),
            "User".to_string(),
            crate::event::TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            serde_json::json!({
                "context_id": "recall-outbox-context",
                "session_id": "recall-session",
                "text": "知识".repeat(100_000)
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        store.append(event.clone()).await.unwrap();
        let stale = claim_sqlite_recall_outbox(&store.pool, "stale-worker", 1)
            .await
            .unwrap()
            .pop()
            .unwrap();
        let stale_document = materialize_sqlite_recall_claim(&store.pool, &stale)
            .await
            .unwrap();
        let mut tx = store.pool.begin().await.unwrap();
        enqueue_event_recall_in_transaction(&mut tx, &event, "recall-outbox-context", true)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let mut tx = store.pool.begin().await.unwrap();
        assert!(
            !finish_sqlite_recall_claim(&mut tx, &stale, stale_document.as_ref())
                .await
                .unwrap(),
            "an older claimed generation must not overwrite a newer intent"
        );
        tx.commit().await.unwrap();

        let batch = store
            .project_recall_outbox_batch("current-worker", 4)
            .await
            .unwrap();
        assert_eq!(batch.projected, 1);
        let row = sqlx::query(
            "SELECT searchable_text, retired FROM recall_documents WHERE document_id = ?",
        )
        .bind(&event.id)
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert!(row.get::<i64, _>("retired") != 0);
        assert!(
            row.get::<String, _>("searchable_text").chars().count()
                <= crate::memory::RECALL_SEARCHABLE_TEXT_MAX_CHARS
        );
    }

    #[tokio::test]
    async fn recall_fts_backfill_runs_once_and_records_its_migration() {
        let tmp_file = NamedTempFile::new().unwrap();
        let path = tmp_file.path().to_str().unwrap().to_string();
        let store = SqliteStore::new(&path).await.unwrap();

        // Simulate a database written by a build that already had the ordinary
        // Recall Projection but had not yet completed the FTS backfill.
        sqlx::query(
            r#"INSERT INTO recall_documents
               (context_id, document_kind, document_id, revision,
                searchable_text, preview, retired, updated_sequence, state_hash)
               VALUES ('legacy-context', 'frame', 'legacy-frame', 1,
                       'legacy searchable text', 'legacy', 0, 1, 'legacy-hash')"#,
        )
        .execute(&store.pool)
        .await
        .unwrap();
        sqlx::query(
            "DELETE FROM recall_documents_fts WHERE context_id = 'legacy-context' AND document_id = 'legacy-frame'",
        )
        .execute(&store.pool)
        .await
        .unwrap();
        sqlx::query("DELETE FROM schema_migrations WHERE version = ?")
            .bind(RECALL_FTS_BACKFILL_MIGRATION)
            .execute(&store.pool)
            .await
            .unwrap();
        store.pool.close().await;
        drop(store);

        let migrated = SqliteStore::new(&path).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM recall_documents_fts WHERE context_id = 'legacy-context' AND document_id = 'legacy-frame'",
            )
            .fetch_one(&migrated.pool)
            .await
            .unwrap(),
            1
        );
        let first_applied_at = sqlx::query_scalar::<_, String>(
            "SELECT applied_at FROM schema_migrations WHERE version = ?",
        )
        .bind(RECALL_FTS_BACKFILL_MIGRATION)
        .fetch_one(&migrated.pool)
        .await
        .unwrap();
        migrated.pool.close().await;
        drop(migrated);

        let reopened = SqliteStore::new(&path).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = ?",
            )
            .bind(RECALL_FTS_BACKFILL_MIGRATION)
            .fetch_one(&reopened.pool)
            .await
            .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT applied_at FROM schema_migrations WHERE version = ?",
            )
            .bind(RECALL_FTS_BACKFILL_MIGRATION)
            .fetch_one(&reopened.pool)
            .await
            .unwrap(),
            first_applied_at,
            "subsequent startup must not rerun or rewrite the backfill marker"
        );
    }

    async fn seed_schedule(store: &SqliteStore, suffix: &str) -> ScheduleRecord {
        let context_id = format!("schedule-context-{suffix}");
        let session_id = format!("schedule-session-{suffix}");
        let target_thread_id = format!("schedule-thread-{suffix}");
        let dependency_thread_id = format!("schedule-dependency-{suffix}");
        store
            .create_context(NewCognitiveContext {
                id: context_id.clone(),
                agent_id: "schedule-agent".to_string(),
                title: "Schedule Context".to_string(),
            })
            .await
            .unwrap();
        store
            .create_session(NewSession {
                id: session_id.clone(),
                agent_id: "schedule-agent".to_string(),
                context_id: context_id.clone(),
                parent_session_id: None,
                title: "Schedule Session".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        for (thread_id, root_turn_id) in [
            (&target_thread_id, format!("schedule-root-{suffix}")),
            (
                &dependency_thread_id,
                format!("schedule-dependency-root-{suffix}"),
            ),
        ] {
            store
                .ensure_thread(NewThread {
                    id: thread_id.clone(),
                    agent_id: "schedule-agent".to_string(),
                    context_id: context_id.clone(),
                    session_id: session_id.clone(),
                    initiating_principal_id: None,
                    root_turn_id,
                    kind: ThreadKind::Execution,
                    executor_kind: "self".to_string(),
                    executor_id: None,
                    target_id: None,
                })
                .await
                .unwrap();
        }
        store
            .ensure_schedule(NewSchedule {
                id: format!("schedule-{suffix}"),
                thread_id: target_thread_id,
                source_turn_id: format!("schedule-source-{suffix}"),
                intent: format!("run schedule {suffix}"),
                not_before: Some(Utc::now() + chrono::Duration::hours(1)),
                interval_seconds: Some(60),
                dependency_thread_ids: vec![dependency_thread_id],
            })
            .await
            .unwrap()
    }

    async fn seed_delivery_fixture(
        store: &SqliteStore,
        suffix: &str,
        thread_count: usize,
    ) -> (String, String, Vec<ThreadRecord>) {
        let context_id = format!("delivery-context-{suffix}");
        let session_id = format!("delivery-session-{suffix}");
        store
            .create_context(NewCognitiveContext {
                id: context_id.clone(),
                agent_id: "delivery-agent".to_string(),
                title: "Delivery Context".to_string(),
            })
            .await
            .unwrap();
        store
            .create_session(NewSession {
                id: session_id.clone(),
                agent_id: "delivery-agent".to_string(),
                context_id: context_id.clone(),
                parent_session_id: None,
                title: "Delivery Session".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut threads = Vec::new();
        for index in 0..thread_count {
            threads.push(
                store
                    .ensure_thread(NewThread {
                        id: format!("delivery-thread-{suffix}-{index}"),
                        agent_id: "delivery-agent".to_string(),
                        context_id: context_id.clone(),
                        session_id: session_id.clone(),
                        initiating_principal_id: None,
                        root_turn_id: format!("delivery-root-{suffix}-{index}"),
                        kind: ThreadKind::Execution,
                        executor_kind: "self".to_string(),
                        executor_id: None,
                        target_id: None,
                    })
                    .await
                    .unwrap(),
            );
        }
        (context_id, session_id, threads)
    }

    async fn mark_delivery_pending(
        store: &SqliteStore,
        thread: &ThreadRecord,
        text: &str,
        event_id: &str,
        at: DateTime<Utc>,
    ) -> ThreadRecord {
        let updated = match store
            .update_thread(
                &thread.id,
                thread.revision,
                None,
                Some(ThreadLifecycle::Completed),
                Some(text),
                Some(event_id),
                Some(DeliveryStatus::Pending),
                None,
            )
            .await
            .unwrap()
        {
            ThreadMutation::Updated(thread) => thread,
            other => panic!("unexpected Thread mutation: {other:?}"),
        };
        sqlx::query("UPDATE threads SET updated_at = ? WHERE id = ?")
            .bind(at.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
            .bind(&thread.id)
            .execute(&store.pool)
            .await
            .unwrap();
        store.get_thread(&updated.id).await.unwrap().unwrap()
    }

    #[tokio::test]
    async fn schedule_control_plane_is_revision_fenced_and_atomic() {
        let tmp_file = NamedTempFile::new().unwrap();
        let path = tmp_file.path().to_str().unwrap();
        let store = SqliteStore::new(path).await.unwrap();
        let created = seed_schedule(&store, "control").await;
        assert_eq!(created.status, ScheduleStatus::Queued);
        assert_eq!(created.revision, 1);

        assert!(matches!(
            store.pause_schedule(&created.id, 0).await.unwrap(),
            ScheduleMutation::Conflict {
                current: ScheduleRecord { revision: 1, .. }
            }
        ));
        let paused = match store
            .pause_schedule(&created.id, created.revision)
            .await
            .unwrap()
        {
            ScheduleMutation::Updated(record) => record,
            other => panic!("unexpected pause result: {other:?}"),
        };
        assert_eq!(paused.status, ScheduleStatus::Paused);
        assert!(matches!(
            store
                .pause_schedule(&created.id, paused.revision)
                .await
                .unwrap(),
            ScheduleMutation::Rejected { .. }
        ));

        let next_due = Utc::now() + chrono::Duration::days(2);
        let rescheduled = match store
            .reschedule_schedule(&created.id, paused.revision, Some(next_due), Some(300))
            .await
            .unwrap()
        {
            ScheduleMutation::Updated(record) => record,
            other => panic!("unexpected reschedule result: {other:?}"),
        };
        assert_eq!(rescheduled.status, ScheduleStatus::Paused);
        assert_eq!(rescheduled.interval_seconds, Some(300));
        assert_eq!(rescheduled.not_before, Some(next_due));
        assert_eq!(
            rescheduled.dependency_thread_ids,
            created.dependency_thread_ids
        );
        let dependency_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM schedule_dependencies WHERE schedule_id = ?",
        )
        .bind(&created.id)
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(dependency_count, 1);

        let resumed = match store
            .resume_schedule(&created.id, rescheduled.revision)
            .await
            .unwrap()
        {
            ScheduleMutation::Updated(record) => record,
            other => panic!("unexpected resume result: {other:?}"),
        };
        assert_eq!(resumed.status, ScheduleStatus::Queued);
        assert_eq!(
            store.inspect_schedule(&created.id).await.unwrap().unwrap(),
            resumed
        );
    }

    #[tokio::test]
    async fn schedule_terminal_states_are_irreversible_and_paused_state_persists() {
        let tmp_file = NamedTempFile::new().unwrap();
        let path = tmp_file.path().to_str().unwrap();
        let store = SqliteStore::new(path).await.unwrap();

        let cancelled_source = seed_schedule(&store, "cancelled").await;
        let cancelled = match store
            .cancel_schedule(&cancelled_source.id, cancelled_source.revision)
            .await
            .unwrap()
        {
            ScheduleMutation::Updated(record) => record,
            other => panic!("unexpected cancel result: {other:?}"),
        };
        assert_eq!(cancelled.status, ScheduleStatus::Cancelled);
        assert!(matches!(
            store
                .reschedule_schedule(&cancelled.id, cancelled.revision, Some(Utc::now()), None,)
                .await
                .unwrap(),
            ScheduleMutation::Rejected { .. }
        ));
        assert!(matches!(
            store
                .cancel_schedule(&cancelled.id, cancelled.revision)
                .await
                .unwrap(),
            ScheduleMutation::Rejected { .. }
        ));
        assert!(
            sqlx::query("UPDATE schedules SET status = 'queued' WHERE id = ?")
                .bind(&cancelled.id)
                .execute(&store.pool)
                .await
                .is_err()
        );

        let completed_source = seed_schedule(&store, "completed").await;
        sqlx::query(
            "UPDATE schedules SET status = 'completed', revision = revision + 1 WHERE id = ?",
        )
        .bind(&completed_source.id)
        .execute(&store.pool)
        .await
        .unwrap();
        let completed = store
            .get_schedule(&completed_source.id)
            .await
            .unwrap()
            .unwrap();
        assert!(completed.status.is_terminal());
        assert!(matches!(
            store
                .pause_schedule(&completed.id, completed.revision)
                .await
                .unwrap(),
            ScheduleMutation::Rejected { .. }
        ));
        assert!(matches!(
            store
                .cancel_schedule(&completed.id, completed.revision)
                .await
                .unwrap(),
            ScheduleMutation::Rejected { .. }
        ));
        assert!(
            sqlx::query("UPDATE schedules SET status = 'queued' WHERE id = ?")
                .bind(&completed.id)
                .execute(&store.pool)
                .await
                .is_err()
        );

        let dispatched_source = seed_schedule(&store, "dispatched").await;
        sqlx::query(
            "UPDATE schedules SET status = 'dispatched', revision = revision + 1 WHERE id = ?",
        )
        .bind(&dispatched_source.id)
        .execute(&store.pool)
        .await
        .unwrap();
        let dispatched = store
            .get_schedule(&dispatched_source.id)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            store
                .reschedule_schedule(&dispatched.id, dispatched.revision, Some(Utc::now()), None,)
                .await
                .unwrap(),
            ScheduleMutation::Rejected { .. }
        ));
        assert!(matches!(
            store
                .cancel_schedule(&dispatched.id, dispatched.revision)
                .await
                .unwrap(),
            ScheduleMutation::Rejected { .. }
        ));

        let persistent_source = seed_schedule(&store, "persistent").await;
        let persistent_paused = match store
            .pause_schedule(&persistent_source.id, persistent_source.revision)
            .await
            .unwrap()
        {
            ScheduleMutation::Updated(record) => record,
            other => panic!("unexpected persistent pause result: {other:?}"),
        };
        store.pool.close().await;
        drop(store);

        let reopened = SqliteStore::new(path).await.unwrap();
        assert_eq!(
            reopened
                .inspect_schedule(&persistent_paused.id)
                .await
                .unwrap()
                .unwrap(),
            persistent_paused
        );
        assert_eq!(
            reopened
                .get_schedule(&cancelled.id)
                .await
                .unwrap()
                .unwrap()
                .status,
            ScheduleStatus::Cancelled
        );
        assert_eq!(
            reopened
                .get_schedule(&completed.id)
                .await
                .unwrap()
                .unwrap()
                .status,
            ScheduleStatus::Completed
        );
    }

    #[tokio::test]
    async fn migrates_pre_target_execution_jobs_before_creating_target_index() {
        let tmp_file = NamedTempFile::new().unwrap();
        let path = tmp_file.path().to_str().unwrap();
        let legacy = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query(
            r#"CREATE TABLE execution_jobs (
                id TEXT PRIMARY KEY,
                revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
                activation_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                context_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                initiating_principal_id TEXT,
                tool_call_id TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                request_json TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN (
                    'queued', 'waiting_approval', 'running', 'succeeded',
                    'failed', 'cancelled', 'lost'
                )),
                retry_safety TEXT NOT NULL CHECK(retry_safety IN (
                    'idempotent', 'reconcile_required', 'at_most_once'
                )),
                claimed_by TEXT,
                claim_token TEXT,
                lease_expires_at TEXT,
                heartbeat_at TEXT,
                approval_ref TEXT,
                side_effect_started_at TEXT,
                cancel_requested_at TEXT,
                cancel_reason TEXT,
                progress_ref TEXT,
                result_event_id TEXT,
                result_refs_json TEXT NOT NULL DEFAULT '[]',
                error TEXT,
                exit_code INTEGER,
                created_at TEXT NOT NULL,
                started_at TEXT,
                updated_at TEXT NOT NULL,
                finished_at TEXT,
                UNIQUE(activation_id, tool_call_id)
            )"#,
        )
        .execute(&legacy)
        .await
        .unwrap();
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            r#"INSERT INTO execution_jobs
               (id, revision, activation_id, thread_id, agent_id, context_id,
                session_id, tool_call_id, tool_name, request_json, status,
                retry_safety, result_refs_json, created_at, updated_at)
               VALUES ('legacy-job', 4, 'legacy-activation', 'legacy-thread',
                       'legacy-agent', 'legacy-context', 'legacy-session',
                       'legacy-call', 'read', '{}', 'succeeded', 'idempotent',
                       '[]', ?, ?)"#,
        )
        .bind(&now)
        .bind(&now)
        .execute(&legacy)
        .await
        .unwrap();
        legacy.close().await;

        let migrated = SqliteStore::new(path).await.unwrap();
        let target_id = sqlx::query_scalar::<_, String>(
            "SELECT target_id FROM execution_jobs WHERE id = 'legacy-job'",
        )
        .fetch_one(&migrated.pool)
        .await
        .unwrap();
        assert_eq!(
            target_id,
            crate::execution_target::DEFAULT_EXECUTION_TARGET_ID
        );
        let target_index = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_execution_jobs_target_status'",
        )
        .fetch_one(&migrated.pool)
        .await
        .unwrap();
        assert_eq!(target_index, 1);
        let migration_record = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM schema_migrations WHERE version = ?",
        )
        .bind(EXECUTION_TARGET_MIGRATION)
        .fetch_one(&migrated.pool)
        .await
        .unwrap();
        assert_eq!(migration_record, 1);
    }

    #[tokio::test]
    async fn migrates_legacy_schedule_schema_without_losing_rows_or_dependencies() {
        let tmp_file = NamedTempFile::new().unwrap();
        let path = tmp_file.path().to_str().unwrap();
        let legacy = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query(
            r#"CREATE TABLE sessions (
                id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, context_id TEXT NOT NULL,
                parent_session_id TEXT, title TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                last_activity_at TEXT NOT NULL
            )"#,
        )
        .execute(&legacy)
        .await
        .unwrap();
        sqlx::query(
            r#"CREATE TABLE work_threads (
                id TEXT PRIMARY KEY,
                revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
                agent_id TEXT NOT NULL, context_id TEXT NOT NULL,
                session_id TEXT NOT NULL, root_turn_id TEXT NOT NULL UNIQUE,
                kind TEXT NOT NULL CHECK(kind IN ('dialogue', 'work', 'objective', 'delegation', 'delivery')),
                status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'failed', 'cancelled')),
                executor_kind TEXT NOT NULL, executor_id TEXT, result_text TEXT,
                result_event_id TEXT,
                delivery_status TEXT NOT NULL DEFAULT 'none' CHECK(delivery_status IN ('none', 'pending', 'deferred', 'delivered')),
                delivery_event_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )"#,
        )
        .execute(&legacy)
        .await
        .unwrap();
        sqlx::query(
            r#"CREATE TABLE scheduled_intents (
                id TEXT PRIMARY KEY,
                revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
                thread_id TEXT NOT NULL, source_turn_id TEXT NOT NULL,
                intent TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('queued', 'dispatched', 'completed', 'cancelled')),
                not_before TEXT,
                interval_seconds INTEGER CHECK(interval_seconds IS NULL OR interval_seconds > 0),
                dependency_thread_ids_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                FOREIGN KEY(thread_id) REFERENCES work_threads(id) ON DELETE CASCADE
            )"#,
        )
        .execute(&legacy)
        .await
        .unwrap();
        sqlx::query(
            r#"CREATE TABLE scheduled_intent_dependencies (
                scheduled_intent_id TEXT NOT NULL,
                dependency_thread_id TEXT NOT NULL,
                PRIMARY KEY(scheduled_intent_id, dependency_thread_id),
                FOREIGN KEY(scheduled_intent_id) REFERENCES scheduled_intents(id) ON DELETE CASCADE,
                FOREIGN KEY(dependency_thread_id) REFERENCES work_threads(id) ON DELETE CASCADE
            )"#,
        )
        .execute(&legacy)
        .await
        .unwrap();
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            "INSERT INTO sessions (id, agent_id, context_id, title, status, created_at, updated_at, last_activity_at) VALUES ('legacy-session', 'legacy-agent', 'legacy-context', 'legacy', 'active', ?, ?, ?)",
        )
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .execute(&legacy)
        .await
        .unwrap();
        for (id, root) in [
            ("legacy-target", "legacy-target-root"),
            ("legacy-dependency", "legacy-dependency-root"),
        ] {
            sqlx::query(
                "INSERT INTO work_threads (id, revision, agent_id, context_id, session_id, root_turn_id, kind, status, executor_kind, delivery_status, created_at, updated_at) VALUES (?, 7, 'legacy-agent', 'legacy-context', 'legacy-session', ?, 'work', 'active', 'self', 'none', ?, ?)",
            )
            .bind(id)
            .bind(root)
            .bind(&now)
            .bind(&now)
            .execute(&legacy)
            .await
            .unwrap();
        }
        sqlx::query(
            "INSERT INTO scheduled_intents (id, revision, thread_id, source_turn_id, intent, status, not_before, interval_seconds, dependency_thread_ids_json, created_at, updated_at) VALUES ('legacy-schedule', 11, 'legacy-target', 'legacy-source', 'legacy intent', 'queued', ?, 90, '[\"legacy-dependency\"]', ?, ?)",
        )
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .execute(&legacy)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO scheduled_intent_dependencies (scheduled_intent_id, dependency_thread_id) VALUES ('legacy-schedule', 'legacy-dependency')",
        )
        .execute(&legacy)
        .await
        .unwrap();
        legacy.close().await;

        let migrated = SqliteStore::new(path).await.unwrap();
        let schedule = migrated
            .get_schedule("legacy-schedule")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(schedule.revision, 11);
        assert_eq!(schedule.status, ScheduleStatus::Queued);
        assert_eq!(schedule.interval_seconds, Some(90));
        assert_eq!(
            schedule.dependency_thread_ids,
            vec!["legacy-dependency".to_string()]
        );
        let reverse_index = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM schedule_dependencies WHERE schedule_id = 'legacy-schedule' AND dependency_thread_id = 'legacy-dependency'",
        )
        .fetch_one(&migrated.pool)
        .await
        .unwrap();
        assert_eq!(reverse_index, 1);
        let dependency_columns = sqlx::query("PRAGMA table_info(schedule_dependencies)")
            .fetch_all(&migrated.pool)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.get::<String, _>("name"))
            .collect::<std::collections::HashSet<_>>();
        assert!(dependency_columns.contains("schedule_id"));
        assert!(!dependency_columns.contains("scheduled_intent_id"));
        let migrated_thread = migrated.get_thread("legacy-target").await.unwrap().unwrap();
        assert_eq!(migrated_thread.kind, ThreadKind::Execution);
        assert_eq!(migrated_thread.lifecycle, ThreadLifecycle::Open);
        let raw_thread = sqlx::query("SELECT kind, status FROM threads WHERE id = 'legacy-target'")
            .fetch_one(&migrated.pool)
            .await
            .unwrap();
        assert_eq!(raw_thread.get::<String, _>("kind"), "execution");
        assert_eq!(raw_thread.get::<String, _>("status"), "open");
        let foreign_key_errors = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&migrated.pool)
            .await
            .unwrap();
        assert!(foreign_key_errors.is_empty());
        let table_sql = sqlx::query_scalar::<_, String>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schedules'",
        )
        .fetch_one(&migrated.pool)
        .await
        .unwrap();
        assert!(table_sql.contains("'paused'"));
    }

    async fn seed_execution_job_input(
        store: &SqliteStore,
        suffix: &str,
        requires_approval: bool,
        retry_safety: ExecutionRetrySafety,
    ) -> NewExecutionJob {
        let context_id = format!("job-context-{suffix}");
        let session_id = format!("job-session-{suffix}");
        let thread_id = format!("job-thread-{suffix}");
        let activation_id = format!("job-activation-{suffix}");
        let root_turn_id = format!("job-root-{suffix}");
        store
            .create_context(NewCognitiveContext {
                id: context_id.clone(),
                agent_id: "job-agent".to_string(),
                title: "Job Context".to_string(),
            })
            .await
            .unwrap();
        store
            .create_session(NewSession {
                id: session_id.clone(),
                agent_id: "job-agent".to_string(),
                context_id: context_id.clone(),
                parent_session_id: None,
                title: "Job Session".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        store
            .ensure_thread(NewThread {
                id: thread_id.clone(),
                agent_id: "job-agent".to_string(),
                context_id: context_id.clone(),
                session_id: session_id.clone(),
                initiating_principal_id: None,
                root_turn_id: root_turn_id.clone(),
                kind: ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
            })
            .await
            .unwrap();
        store
            .ensure_thread_activation(NewThreadActivation {
                id: activation_id.clone(),
                agent_id: "job-agent".to_string(),
                context_id: context_id.clone(),
                session_id: session_id.clone(),
                initiating_principal_id: None,
                trigger_event_id: format!("job-trigger-{suffix}"),
                trigger_sequence: 1,
                trigger_kind: "chat/user_message".to_string(),
                parent_activation_id: None,
                root_turn_id,
            })
            .await
            .unwrap();
        NewExecutionJob {
            id: format!("job-{suffix}"),
            activation_id,
            thread_id,
            agent_id: "job-agent".to_string(),
            context_id,
            session_id,
            initiating_principal_id: None,
            target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
            tool_call_id: format!("call-{suffix}"),
            tool_name: "exec".to_string(),
            request: serde_json::json!({"command": "printf ok"}),
            retry_safety,
            requires_approval,
        }
    }

    async fn seed_execution_job(
        store: &SqliteStore,
        suffix: &str,
        requires_approval: bool,
        retry_safety: ExecutionRetrySafety,
    ) -> ExecutionJobRecord {
        let job = seed_execution_job_input(store, suffix, requires_approval, retry_safety).await;
        store.create_execution_job(job).await.unwrap()
    }

    fn new_approval_request_for_job(
        job_id: &str,
        pending_status: ApprovalStatus,
    ) -> NewApprovalRequest {
        let action = serde_json::json!({
            "kind": "shell",
            "command": "cargo test",
            "cwd": "/workspace",
        });
        let requested = serde_json::json!({
            "network": true,
            "read_roots": ["/outside/read"],
        });
        let identity =
            stable_approval_identity(job_id, &action, &requested, "permission-profile-v1").unwrap();
        NewApprovalRequest {
            id: identity.approval_id,
            job_id: job_id.to_string(),
            request_digest: identity.request_digest,
            policy_digest: identity.policy_digest,
            action,
            requested,
            justification: "测试需要读取工作区外 fixture".to_string(),
            pending_status,
        }
    }

    fn new_approval_request(
        job: &ExecutionJobRecord,
        pending_status: ApprovalStatus,
    ) -> NewApprovalRequest {
        new_approval_request_for_job(&job.id, pending_status)
    }

    fn approval_request_event(job: &NewExecutionJob, approval: &NewApprovalRequest) -> Event {
        Event::new(
            format!("approval-requested-{}", approval.id),
            "System-PermissionBroker".to_string(),
            "approval_requested".to_string(),
            "runtime/approval_requested".to_string(),
            serde_json::json!({
                "approval_id": approval.id,
                "job_id": job.id,
                "request_digest": approval.request_digest,
                "policy_digest": approval.policy_digest,
                "activation_id": job.activation_id,
                "thread_id": job.thread_id,
                "context_id": job.context_id,
                "session_id": job.session_id,
                "tool_call_id": job.tool_call_id,
                "action": approval.action,
                "requested": approval.requested,
                "justification": approval.justification,
            })
            .as_object()
            .expect("approval Event payload must be an object")
            .clone(),
        )
    }

    #[tokio::test]
    async fn execution_job_approval_and_request_event_are_created_atomically_and_replayable() {
        let tmp_file = NamedTempFile::new().unwrap();
        let path = tmp_file.path().to_str().unwrap().to_string();
        let store = SqliteStore::new(&path).await.unwrap();
        let job = seed_execution_job_input(
            &store,
            "approval-atomic-create",
            true,
            ExecutionRetrySafety::AtMostOnce,
        )
        .await;
        let approval = new_approval_request_for_job(&job.id, ApprovalStatus::PendingHuman);
        let event = approval_request_event(&job, &approval);

        let (created_job, created_approval) = match store
            .ensure_execution_job_with_approval(job.clone(), approval.clone(), &event)
            .await
            .unwrap()
        {
            ExecutionApprovalMutation::Created { job, approval } => (job, approval),
            other => panic!("unexpected atomic ensure result: {other:?}"),
        };
        assert_eq!(created_job.status, ExecutionJobStatus::WaitingApproval);
        assert_eq!(created_approval.status, ApprovalStatus::PendingHuman);
        assert_eq!(created_job.revision, 1);
        assert_eq!(created_approval.revision, 1);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM events WHERE id = ?")
                .bind(&event.id)
                .fetch_one(&store.pool)
                .await
                .unwrap(),
            1
        );
        assert!(matches!(
            store
                .ensure_execution_job_with_approval(job, approval.clone(), &event)
                .await
                .unwrap(),
            ExecutionApprovalMutation::Existing { job, approval: replayed }
                if job == created_job && replayed == created_approval
        ));

        store.pool.close().await;
        drop(store);
        let restarted = SqliteStore::new(&path).await.unwrap();
        assert_eq!(
            restarted.get_execution_job(&created_job.id).await.unwrap(),
            Some(created_job)
        );
        assert_eq!(
            restarted.get_approval(&approval.id).await.unwrap(),
            Some(created_approval)
        );
    }

    #[tokio::test]
    async fn malformed_or_conflicting_approval_event_rolls_back_job_and_approval() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let job = seed_execution_job_input(
            &store,
            "approval-event-rollback",
            true,
            ExecutionRetrySafety::AtMostOnce,
        )
        .await;
        let approval = new_approval_request_for_job(&job.id, ApprovalStatus::PendingAuto);
        let mut malformed = approval_request_event(&job, &approval);
        malformed
            .payload
            .insert("session_id".to_string(), serde_json::json!("wrong-session"));
        assert!(store
            .ensure_execution_job_with_approval(job.clone(), approval.clone(), &malformed)
            .await
            .is_err());
        assert!(store.get_execution_job(&job.id).await.unwrap().is_none());
        assert!(store.get_approval(&approval.id).await.unwrap().is_none());

        let event = approval_request_event(&job, &approval);
        let mut conflicting_event = event.clone();
        conflicting_event.actor = "Different-Actor".to_string();
        store.append(conflicting_event).await.unwrap();
        assert!(store
            .ensure_execution_job_with_approval(job.clone(), approval.clone(), &event)
            .await
            .is_err());
        assert!(store.get_execution_job(&job.id).await.unwrap().is_none());
        assert!(store.get_approval(&approval.id).await.unwrap().is_none());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM events WHERE id = ?")
                .bind(&event.id)
                .fetch_one(&store.pool)
                .await
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn allowed_grant_is_atomically_consumed_with_job_claim_and_exact_retry() {
        let tmp_file = NamedTempFile::new().unwrap();
        let path = tmp_file.path().to_str().unwrap().to_string();
        let store = SqliteStore::new(&path).await.unwrap();
        let job = seed_execution_job_input(
            &store,
            "approval-grant-claim",
            true,
            ExecutionRetrySafety::AtMostOnce,
        )
        .await;
        let approval = new_approval_request_for_job(&job.id, ApprovalStatus::PendingAuto);
        let event = approval_request_event(&job, &approval);
        let (waiting_job, pending) = match store
            .ensure_execution_job_with_approval(job, approval, &event)
            .await
            .unwrap()
        {
            ExecutionApprovalMutation::Created { job, approval } => (job, approval),
            other => panic!("unexpected atomic ensure result: {other:?}"),
        };
        let allowed = match store
            .commit_approval_decision(
                &pending.id,
                pending.revision,
                ApprovalResolution::Allow {
                    rationale: "能力边界准确".to_string(),
                    risk_tags: vec!["network".to_string()],
                },
            )
            .await
            .unwrap()
            .mutation
        {
            ApprovalMutation::Updated(record) => record,
            other => panic!("unexpected allow result: {other:?}"),
        };
        store.pool.close().await;
        drop(store);

        let restarted = SqliteStore::new(&path).await.unwrap();
        let lease = Utc::now() + chrono::Duration::minutes(2);
        let (running, consumed) = match restarted
            .claim_execution_job_with_grant(
                &waiting_job.id,
                waiting_job.revision,
                &allowed.id,
                allowed.revision,
                "worker-a",
                "claim-a",
                lease,
            )
            .await
            .unwrap()
        {
            ExecutionApprovalMutation::Updated { job, approval } => (job, approval),
            other => panic!("unexpected grant claim result: {other:?}"),
        };
        assert_eq!(running.status, ExecutionJobStatus::Running);
        assert_eq!(running.revision, waiting_job.revision + 1);
        assert_eq!(running.approval_ref, consumed.grant_id);
        assert_eq!(consumed.revision, allowed.revision + 1);
        assert!(consumed.grant_consumed_at.is_some());
        assert_eq!(consumed.consumed_by_claim_token.as_deref(), Some("claim-a"));
        assert!(matches!(
            restarted
                .claim_execution_job_with_grant(
                    &waiting_job.id,
                    waiting_job.revision,
                    &allowed.id,
                    allowed.revision,
                    "worker-a",
                    "claim-a",
                    lease,
                )
                .await
                .unwrap(),
            ExecutionApprovalMutation::Existing { job, approval }
                if job == running && approval == consumed
        ));
        let decision_replay = restarted
            .commit_approval_decision(
                &allowed.id,
                allowed.revision,
                ApprovalResolution::Allow {
                    rationale: "能力边界准确".to_string(),
                    risk_tags: vec!["network".to_string()],
                },
            )
            .await
            .unwrap();
        assert!(matches!(
            decision_replay.mutation,
            ApprovalMutation::Existing(record) if record == consumed
        ));
        assert!(
            !decision_replay.event_created,
            "grant consumption advances Approval revision but must not create another decision Event"
        );
    }

    #[tokio::test]
    async fn stale_revision_never_consumes_grant_and_competing_claim_is_fenced() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let job = seed_execution_job_input(
            &store,
            "approval-grant-fence",
            true,
            ExecutionRetrySafety::ReconcileRequired,
        )
        .await;
        let approval = new_approval_request_for_job(&job.id, ApprovalStatus::PendingHuman);
        let event = approval_request_event(&job, &approval);
        let (waiting, pending) = match store
            .ensure_execution_job_with_approval(job, approval, &event)
            .await
            .unwrap()
        {
            ExecutionApprovalMutation::Created { job, approval } => (job, approval),
            other => panic!("unexpected ensure result: {other:?}"),
        };
        let allowed = match store
            .commit_approval_decision(
                &pending.id,
                pending.revision,
                ApprovalResolution::Allow {
                    rationale: "人工批准".to_string(),
                    risk_tags: vec![],
                },
            )
            .await
            .unwrap()
            .mutation
        {
            ApprovalMutation::Updated(record) => record,
            other => panic!("unexpected allow result: {other:?}"),
        };
        let lease = Utc::now() + chrono::Duration::minutes(1);
        assert!(matches!(
            store
                .claim_execution_job_with_grant(
                    &waiting.id,
                    waiting.revision + 1,
                    &allowed.id,
                    allowed.revision,
                    "worker-a",
                    "claim-a",
                    lease,
                )
                .await
                .unwrap(),
            ExecutionApprovalMutation::Conflict { .. }
        ));
        let unchanged = store.get_approval(&allowed.id).await.unwrap().unwrap();
        assert!(unchanged.grant_consumed_at.is_none());
        assert_eq!(unchanged.revision, allowed.revision);

        let claimed = match store
            .claim_execution_job_with_grant(
                &waiting.id,
                waiting.revision,
                &allowed.id,
                allowed.revision,
                "worker-a",
                "claim-a",
                lease,
            )
            .await
            .unwrap()
        {
            ExecutionApprovalMutation::Updated { job, approval } => (job, approval),
            other => panic!("unexpected claim result: {other:?}"),
        };
        assert!(matches!(
            store
                .claim_execution_job_with_grant(
                    &waiting.id,
                    claimed.0.revision,
                    &allowed.id,
                    claimed.1.revision,
                    "worker-b",
                    "claim-b",
                    lease,
                )
                .await
                .unwrap(),
            ExecutionApprovalMutation::Rejected { .. } | ExecutionApprovalMutation::Conflict { .. }
        ));
        assert_eq!(
            store
                .get_approval(&allowed.id)
                .await
                .unwrap()
                .unwrap()
                .consumed_by_claim_token
                .as_deref(),
            Some("claim-a")
        );
    }

    #[tokio::test]
    async fn pending_denied_or_wrong_job_grant_cannot_claim_execution_job() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let first_job = seed_execution_job_input(
            &store,
            "approval-grant-owner-a",
            true,
            ExecutionRetrySafety::AtMostOnce,
        )
        .await;
        let first_approval =
            new_approval_request_for_job(&first_job.id, ApprovalStatus::PendingHuman);
        let first_event = approval_request_event(&first_job, &first_approval);
        let (first_waiting, first_pending) = match store
            .ensure_execution_job_with_approval(first_job, first_approval, &first_event)
            .await
            .unwrap()
        {
            ExecutionApprovalMutation::Created { job, approval } => (job, approval),
            other => panic!("unexpected first ensure: {other:?}"),
        };
        let lease = Utc::now() + chrono::Duration::minutes(1);
        assert!(matches!(
            store
                .claim_execution_job_with_grant(
                    &first_waiting.id,
                    first_waiting.revision,
                    &first_pending.id,
                    first_pending.revision,
                    "worker-a",
                    "claim-pending",
                    lease,
                )
                .await
                .unwrap(),
            ExecutionApprovalMutation::Rejected { .. }
        ));

        let second_job = seed_execution_job_input(
            &store,
            "approval-grant-owner-b",
            true,
            ExecutionRetrySafety::AtMostOnce,
        )
        .await;
        let second_approval =
            new_approval_request_for_job(&second_job.id, ApprovalStatus::PendingAuto);
        let second_event = approval_request_event(&second_job, &second_approval);
        let (_second_waiting, second_pending) = match store
            .ensure_execution_job_with_approval(second_job, second_approval, &second_event)
            .await
            .unwrap()
        {
            ExecutionApprovalMutation::Created { job, approval } => (job, approval),
            other => panic!("unexpected second ensure: {other:?}"),
        };
        let second_allowed = match store
            .commit_approval_decision(
                &second_pending.id,
                second_pending.revision,
                ApprovalResolution::Allow {
                    rationale: "只允许第二个 Job".to_string(),
                    risk_tags: vec![],
                },
            )
            .await
            .unwrap()
            .mutation
        {
            ApprovalMutation::Updated(record) => record,
            other => panic!("unexpected second allow: {other:?}"),
        };
        assert!(matches!(
            store
                .claim_execution_job_with_grant(
                    &first_waiting.id,
                    first_waiting.revision,
                    &second_allowed.id,
                    second_allowed.revision,
                    "worker-a",
                    "claim-wrong-owner",
                    lease,
                )
                .await
                .unwrap(),
            ExecutionApprovalMutation::Rejected { .. }
        ));
        assert!(store
            .get_approval(&second_allowed.id)
            .await
            .unwrap()
            .unwrap()
            .grant_consumed_at
            .is_none());

        let denied = match store
            .commit_approval_decision(
                &first_pending.id,
                first_pending.revision,
                ApprovalResolution::Deny {
                    rationale: "拒绝第一个 Job".to_string(),
                    risk_tags: vec![],
                },
            )
            .await
            .unwrap()
            .mutation
        {
            ApprovalMutation::Updated(record) => record,
            other => panic!("unexpected deny: {other:?}"),
        };
        assert!(matches!(
            store
                .claim_execution_job_with_grant(
                    &first_waiting.id,
                    first_waiting.revision,
                    &denied.id,
                    denied.revision,
                    "worker-a",
                    "claim-denied",
                    lease,
                )
                .await
                .unwrap(),
            ExecutionApprovalMutation::Rejected { .. }
        ));
    }

    #[tokio::test]
    async fn approval_request_is_durable_and_exact_replay_is_fenced() {
        let tmp_file = NamedTempFile::new().unwrap();
        let path = tmp_file.path().to_str().unwrap().to_string();
        let store = SqliteStore::new(&path).await.unwrap();
        let job = seed_execution_job(
            &store,
            "approval-durable",
            true,
            ExecutionRetrySafety::AtMostOnce,
        )
        .await;
        let request = new_approval_request(&job, ApprovalStatus::PendingHuman);
        let created = match store
            .ensure_approval_request(request.clone())
            .await
            .unwrap()
        {
            ApprovalMutation::Created(record) => record,
            other => panic!("unexpected approval creation: {other:?}"),
        };
        assert_eq!(created.revision, 1);
        assert_eq!(created.status, ApprovalStatus::PendingHuman);
        let mut forged = request.clone();
        forged.id = "approval_forged".to_string();
        assert!(store.ensure_approval_request(forged).await.is_err());
        assert_eq!(
            store
                .ensure_approval_request(request.clone())
                .await
                .unwrap(),
            ApprovalMutation::Existing(created.clone())
        );

        let mut conflicting = request.clone();
        conflicting.justification = "不同说明不能伪装成精确重放".to_string();
        assert!(matches!(
            store.ensure_approval_request(conflicting).await.unwrap(),
            ApprovalMutation::Conflict { .. }
        ));
        let pending = store
            .list_approvals(ApprovalFilter {
                pending_only: true,
                ..ApprovalFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(pending, vec![created.clone()]);

        store.pool.close().await;
        drop(store);
        let restarted = SqliteStore::new(&path).await.unwrap();
        assert_eq!(
            restarted.get_approval(&request.id).await.unwrap(),
            Some(created)
        );
        assert_eq!(
            restarted
                .list_approvals(ApprovalFilter {
                    status: Some(ApprovalStatus::PendingHuman),
                    ..ApprovalFilter::default()
                })
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn approval_allow_and_deny_decisions_are_revision_fenced_and_idempotent() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let allow_job = seed_execution_job(
            &store,
            "approval-allow",
            true,
            ExecutionRetrySafety::AtMostOnce,
        )
        .await;
        let allow_request = new_approval_request(&allow_job, ApprovalStatus::PendingAuto);
        let pending = match store
            .ensure_approval_request(allow_request.clone())
            .await
            .unwrap()
        {
            ApprovalMutation::Created(record) => record,
            other => panic!("unexpected approval creation: {other:?}"),
        };
        let allow = ApprovalResolution::Allow {
            rationale: "范围准确且与用户任务直接相关".to_string(),
            risk_tags: vec!["network".to_string()],
        };
        let allowed = match store
            .commit_approval_decision(&pending.id, pending.revision, allow.clone())
            .await
            .unwrap()
            .mutation
        {
            ApprovalMutation::Updated(record) => record,
            other => panic!("unexpected allow decision: {other:?}"),
        };
        assert_eq!(allowed.status, ApprovalStatus::Allowed);
        assert_eq!(allowed.revision, 2);
        assert!(allowed.grant_id.is_some());
        assert!(matches!(
            store
                .commit_approval_decision(&pending.id, pending.revision, allow)
                .await
                .unwrap()
                .mutation,
            ApprovalMutation::Existing(record) if record == allowed
        ));
        assert!(matches!(
            store
                .commit_approval_decision(
                    &pending.id,
                    allowed.revision,
                    ApprovalResolution::Deny {
                        rationale: "opposite replay".to_string(),
                        risk_tags: vec![],
                    },
                )
                .await
                .unwrap()
                .mutation,
            ApprovalMutation::Rejected { .. }
        ));

        let deny_job = seed_execution_job(
            &store,
            "approval-deny",
            true,
            ExecutionRetrySafety::AtMostOnce,
        )
        .await;
        let deny_request = new_approval_request(&deny_job, ApprovalStatus::PendingHuman);
        let pending = match store.ensure_approval_request(deny_request).await.unwrap() {
            ApprovalMutation::Created(record) => record,
            other => panic!("unexpected approval creation: {other:?}"),
        };
        let deny = ApprovalResolution::Deny {
            rationale: "用户拒绝本次越界访问".to_string(),
            risk_tags: vec!["human-denied".to_string()],
        };
        assert!(matches!(
            store
                .commit_approval_decision(&pending.id, pending.revision + 1, deny.clone())
                .await
                .unwrap()
                .mutation,
            ApprovalMutation::Conflict { .. }
        ));
        let denied = match store
            .commit_approval_decision(&pending.id, pending.revision, deny.clone())
            .await
            .unwrap()
            .mutation
        {
            ApprovalMutation::Updated(record) => record,
            other => panic!("unexpected deny decision: {other:?}"),
        };
        assert_eq!(denied.status, ApprovalStatus::Denied);
        assert!(denied.grant_id.is_none());
        assert!(matches!(
            store
                .commit_approval_decision(&pending.id, pending.revision, deny)
                .await
                .unwrap()
                .mutation,
            ApprovalMutation::Existing(record) if record == denied
        ));
    }

    #[tokio::test]
    async fn approval_decision_event_is_atomic_and_exact_replay_repairs_legacy_gap() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();

        // Simulate data written by an older Runtime which committed the
        // authority transition but crashed before appending its audit Event.
        let legacy_job = seed_execution_job(
            &store,
            "approval-legacy-decision-gap",
            true,
            ExecutionRetrySafety::AtMostOnce,
        )
        .await;
        let pending = match store
            .ensure_approval_request(new_approval_request(
                &legacy_job,
                ApprovalStatus::PendingAuto,
            ))
            .await
            .unwrap()
        {
            ApprovalMutation::Created(record) => record,
            other => panic!("unexpected approval creation: {other:?}"),
        };
        let rationale = "legacy authority already allowed";
        let risk_tags = vec!["legacy-repair".to_string()];
        let grant_id =
            stable_grant_id(&pending.id, &pending.request_digest, &pending.policy_digest).unwrap();
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            "UPDATE approval_requests SET revision = 2, status = 'allowed', rationale = ?, risk_tags_json = ?, grant_id = ?, updated_at = ?, decided_at = ? WHERE id = ?",
        )
        .bind(rationale)
        .bind(serde_json::to_string(&risk_tags).unwrap())
        .bind(grant_id)
        .bind(&now)
        .bind(&now)
        .bind(&pending.id)
        .execute(&store.pool)
        .await
        .unwrap();

        let repaired = store
            .commit_approval_decision(
                &pending.id,
                pending.revision,
                ApprovalResolution::Allow {
                    rationale: rationale.to_string(),
                    risk_tags: risk_tags.clone(),
                },
            )
            .await
            .unwrap();
        let repaired_record = match repaired.mutation {
            ApprovalMutation::Existing(record) => record,
            other => panic!("unexpected legacy repair result: {other:?}"),
        };
        assert!(repaired.event_created);
        let repaired_event = repaired.event.as_ref().expect("repaired audit event");
        assert_eq!(
            repaired_event
                .payload
                .get("context_id")
                .and_then(JsonValue::as_str),
            Some(legacy_job.context_id.as_str())
        );
        assert_eq!(
            repaired_event
                .payload
                .get("session_id")
                .and_then(JsonValue::as_str),
            Some(legacy_job.session_id.as_str())
        );
        assert_eq!(
            repaired_event
                .payload
                .get("correlation_id")
                .and_then(JsonValue::as_str),
            Some(pending.id.as_str())
        );
        assert_eq!(repaired_record.revision, 2);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM events WHERE id = ?")
                .bind(format!(
                    "approval_decided_{}_{}",
                    pending.id,
                    repaired_record.status.as_str()
                ))
                .fetch_one(&store.pool)
                .await
                .unwrap(),
            1
        );
        let replay = store
            .commit_approval_decision(
                &pending.id,
                pending.revision,
                ApprovalResolution::Allow {
                    rationale: rationale.to_string(),
                    risk_tags,
                },
            )
            .await
            .unwrap();
        assert!(!replay.event_created);
        assert!(matches!(replay.mutation, ApprovalMutation::Existing(_)));

        // A conflicting immutable Event must abort the whole authority
        // transition, proving the state and audit fact share one transaction.
        let rollback_job = seed_execution_job(
            &store,
            "approval-decision-event-rollback",
            true,
            ExecutionRetrySafety::AtMostOnce,
        )
        .await;
        let rollback_pending = match store
            .ensure_approval_request(new_approval_request(
                &rollback_job,
                ApprovalStatus::PendingHuman,
            ))
            .await
            .unwrap()
        {
            ApprovalMutation::Created(record) => record,
            other => panic!("unexpected rollback approval creation: {other:?}"),
        };
        let mut conflicting_record = rollback_pending.clone();
        conflicting_record.revision += 1;
        conflicting_record.status = ApprovalStatus::Denied;
        conflicting_record.rationale = Some("denied atomically".to_string());
        conflicting_record.risk_tags = vec!["conflict".to_string()];
        conflicting_record.updated_at = Utc::now();
        conflicting_record.decided_at = Some(conflicting_record.updated_at);
        let mut conflicting_event = approval_decision_event(&conflicting_record, &rollback_job);
        conflicting_event.actor = "Conflicting-Authority".to_string();
        store.append(conflicting_event).await.unwrap();

        assert!(store
            .commit_approval_decision(
                &rollback_pending.id,
                rollback_pending.revision,
                ApprovalResolution::Deny {
                    rationale: "denied atomically".to_string(),
                    risk_tags: vec!["conflict".to_string()],
                },
            )
            .await
            .is_err());
        assert_eq!(
            store
                .get_approval(&rollback_pending.id)
                .await
                .unwrap()
                .unwrap(),
            rollback_pending
        );
    }

    #[tokio::test]
    async fn pending_or_unconsumed_allowed_approval_can_be_cancelled() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();

        let pending_job = seed_execution_job(
            &store,
            "approval-cancel-pending",
            true,
            ExecutionRetrySafety::AtMostOnce,
        )
        .await;
        let pending = match store
            .ensure_approval_request(new_approval_request(
                &pending_job,
                ApprovalStatus::PendingHuman,
            ))
            .await
            .unwrap()
        {
            ApprovalMutation::Created(record) => record,
            other => panic!("unexpected approval creation: {other:?}"),
        };
        let cancelled = match store
            .commit_approval_cancellation(&pending.id, pending.revision, "用户取消了对应任务")
            .await
            .unwrap()
            .mutation
        {
            ApprovalMutation::Updated(record) => record,
            other => panic!("unexpected approval cancellation: {other:?}"),
        };
        assert_eq!(cancelled.status, ApprovalStatus::Cancelled);
        assert!(cancelled.cancelled_at.is_some());
        assert!(matches!(
            store
                .commit_approval_cancellation(&pending.id, pending.revision, "用户取消了对应任务")
                .await
                .unwrap()
                .mutation,
            ApprovalMutation::Existing(record) if record == cancelled
        ));

        let allowed_job = seed_execution_job(
            &store,
            "approval-cancel-allowed",
            true,
            ExecutionRetrySafety::AtMostOnce,
        )
        .await;
        let allowed_pending = match store
            .ensure_approval_request(new_approval_request(
                &allowed_job,
                ApprovalStatus::PendingAuto,
            ))
            .await
            .unwrap()
        {
            ApprovalMutation::Created(record) => record,
            other => panic!("unexpected approval creation: {other:?}"),
        };
        let allowed = match store
            .commit_approval_decision(
                &allowed_pending.id,
                allowed_pending.revision,
                ApprovalResolution::Allow {
                    rationale: "允许一次".to_string(),
                    risk_tags: vec![],
                },
            )
            .await
            .unwrap()
            .mutation
        {
            ApprovalMutation::Updated(record) => record,
            other => panic!("unexpected allow decision: {other:?}"),
        };
        let cancelled = match store
            .commit_approval_cancellation(&allowed.id, allowed.revision, "执行前撤销")
            .await
            .unwrap()
            .mutation
        {
            ApprovalMutation::Updated(record) => record,
            other => panic!("unexpected allowed cancellation: {other:?}"),
        };
        assert_eq!(cancelled.status, ApprovalStatus::Cancelled);
        assert!(cancelled.grant_id.is_none());
        let cancellation_event_id = format!(
            "approval_decided_{}_{}",
            cancelled.id,
            ApprovalStatus::Cancelled.as_str()
        );
        let cancellation_event = store
            .query(QueryFilter {
                event_id: Some(cancellation_event_id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()
            .into_iter()
            .find(|event| event.id == cancellation_event_id)
            .expect("cancellation audit Event must be durable");
        assert_eq!(
            cancellation_event.payload["rationale"],
            serde_json::json!("执行前撤销")
        );
        assert_eq!(
            cancellation_event.payload["cancel_reason"],
            serde_json::json!("执行前撤销")
        );
        assert_eq!(
            cancellation_event.payload["risk_tags"],
            serde_json::json!([])
        );
        assert_eq!(
            cancellation_event.timestamp,
            cancelled.cancelled_at.unwrap()
        );
    }

    #[tokio::test]
    async fn execution_job_claim_heartbeat_cancel_and_terminal_are_fenced() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let created = seed_execution_job(
            &store,
            "fenced",
            true,
            ExecutionRetrySafety::ReconcileRequired,
        )
        .await;
        assert_eq!(created.status, ExecutionJobStatus::WaitingApproval);
        assert_eq!(created.revision, 1);

        let lease = Utc::now() + chrono::Duration::minutes(1);
        assert!(matches!(
            store
                .claim_execution_job(&created.id, 1, "worker-a", "claim-a", lease, None)
                .await
                .unwrap(),
            ExecutionJobMutation::Rejected { .. }
        ));
        let claimed = match store
            .claim_execution_job(
                &created.id,
                1,
                "worker-a",
                "claim-a",
                lease,
                Some("approval:event-1"),
            )
            .await
            .unwrap()
        {
            ExecutionJobMutation::Updated(job) => job,
            other => panic!("unexpected claim result: {other:?}"),
        };
        assert_eq!(claimed.status, ExecutionJobStatus::Running);
        assert_eq!(claimed.revision, 2);
        assert_eq!(claimed.approval_ref.as_deref(), Some("approval:event-1"));
        assert!(matches!(
            store
                .heartbeat_execution_job(
                    &created.id,
                    claimed.revision,
                    "stale-claim",
                    Utc::now() + chrono::Duration::minutes(2),
                    None,
                    None,
                )
                .await
                .unwrap(),
            ExecutionJobMutation::Rejected { .. }
        ));

        let effect_at = Utc::now();
        let heartbeat = match store
            .heartbeat_execution_job(
                &created.id,
                claimed.revision,
                "claim-a",
                Utc::now() + chrono::Duration::minutes(2),
                Some(effect_at),
                Some("artifact:progress"),
            )
            .await
            .unwrap()
        {
            ExecutionJobMutation::Updated(job) => job,
            other => panic!("unexpected heartbeat result: {other:?}"),
        };
        assert_eq!(heartbeat.revision, 3);
        assert!(heartbeat.side_effect_started_at.is_some());
        assert_eq!(heartbeat.progress_ref.as_deref(), Some("artifact:progress"));

        let cancelling = match store
            .request_cancel_execution_job(&created.id, heartbeat.revision, Some("user stopped it"))
            .await
            .unwrap()
        {
            ExecutionJobMutation::Updated(job) => job,
            other => panic!("unexpected cancel request: {other:?}"),
        };
        assert_eq!(cancelling.status, ExecutionJobStatus::Running);
        assert!(cancelling.cancel_requested_at.is_some());
        assert!(matches!(
            store
                .finish_execution_job(
                    &created.id,
                    heartbeat.revision,
                    Some("claim-a"),
                    ExecutionJobTerminal {
                        status: ExecutionJobStatus::Succeeded,
                        result_event_id: None,
                        result_refs: vec![],
                        error: None,
                        exit_code: Some(0),
                    },
                )
                .await
                .unwrap(),
            ExecutionJobMutation::Conflict { .. }
        ));
        assert!(matches!(
            store
                .finish_execution_job(
                    &created.id,
                    cancelling.revision,
                    Some("claim-a"),
                    ExecutionJobTerminal {
                        status: ExecutionJobStatus::Succeeded,
                        result_event_id: None,
                        result_refs: vec![],
                        error: None,
                        exit_code: Some(0),
                    },
                )
                .await
                .unwrap(),
            ExecutionJobMutation::Rejected { .. }
        ));
        let cancelled = match store
            .finish_execution_job(
                &created.id,
                cancelling.revision,
                None,
                ExecutionJobTerminal {
                    status: ExecutionJobStatus::Cancelled,
                    result_event_id: Some("job-cancelled-event".to_string()),
                    result_refs: vec![],
                    error: None,
                    exit_code: None,
                },
            )
            .await
            .unwrap()
        {
            ExecutionJobMutation::Updated(job) => job,
            other => panic!("unexpected terminal result: {other:?}"),
        };
        assert_eq!(cancelled.status, ExecutionJobStatus::Cancelled);
        assert!(cancelled.finished_at.is_some());
        assert!(matches!(
            store
                .finish_execution_job(
                    &created.id,
                    cancelled.revision,
                    None,
                    ExecutionJobTerminal {
                        status: ExecutionJobStatus::Lost,
                        result_event_id: None,
                        result_refs: vec![],
                        error: None,
                        exit_code: None,
                    },
                )
                .await
                .unwrap(),
            ExecutionJobMutation::Rejected { .. }
        ));
        assert!(
            sqlx::query("UPDATE execution_jobs SET status = 'running' WHERE id = ?")
                .bind(&created.id)
                .execute(&store.pool)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn execution_job_creation_is_causally_idempotent_and_results_are_durable() {
        let tmp_file = NamedTempFile::new().unwrap();
        let path = tmp_file.path().to_str().unwrap();
        let store = SqliteStore::new(path).await.unwrap();
        let created =
            seed_execution_job(&store, "durable", false, ExecutionRetrySafety::AtMostOnce).await;
        let duplicate = store
            .create_execution_job(NewExecutionJob {
                id: created.id.clone(),
                activation_id: created.activation_id.clone(),
                thread_id: created.thread_id.clone(),
                agent_id: created.agent_id.clone(),
                context_id: created.context_id.clone(),
                session_id: created.session_id.clone(),
                initiating_principal_id: None,
                target_id: created.target_id.clone(),
                tool_call_id: created.tool_call_id.clone(),
                tool_name: created.tool_name.clone(),
                request: created.request.clone(),
                retry_safety: created.retry_safety,
                requires_approval: false,
            })
            .await
            .unwrap();
        assert_eq!(duplicate, created);
        assert!(store
            .create_execution_job(NewExecutionJob {
                id: "different-id".to_string(),
                activation_id: created.activation_id.clone(),
                thread_id: created.thread_id.clone(),
                agent_id: created.agent_id.clone(),
                context_id: created.context_id.clone(),
                session_id: created.session_id.clone(),
                initiating_principal_id: None,
                target_id: created.target_id.clone(),
                tool_call_id: created.tool_call_id.clone(),
                tool_name: "read".to_string(),
                request: serde_json::json!({"path": "other"}),
                retry_safety: ExecutionRetrySafety::Idempotent,
                requires_approval: false,
            })
            .await
            .is_err());
        let listed = store
            .list_execution_jobs(ExecutionJobFilter {
                context_id: Some(created.context_id.clone()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(listed.len(), 1);

        let claimed = match store
            .claim_execution_job(
                &created.id,
                created.revision,
                "worker",
                "claim",
                Utc::now() + chrono::Duration::minutes(1),
                None,
            )
            .await
            .unwrap()
        {
            ExecutionJobMutation::Updated(job) => job,
            other => panic!("unexpected claim: {other:?}"),
        };
        let succeeded = match store
            .finish_execution_job(
                &created.id,
                claimed.revision,
                Some("claim"),
                ExecutionJobTerminal {
                    status: ExecutionJobStatus::Succeeded,
                    result_event_id: Some("job-result-event".to_string()),
                    result_refs: vec!["artifact:stdout".to_string()],
                    error: None,
                    exit_code: Some(0),
                },
            )
            .await
            .unwrap()
        {
            ExecutionJobMutation::Updated(job) => job,
            other => panic!("unexpected completion: {other:?}"),
        };
        assert_eq!(succeeded.result_refs, vec!["artifact:stdout"]);
        assert_eq!(succeeded.exit_code, Some(0));
        let replayed = store
            .create_execution_job(NewExecutionJob {
                id: created.id.clone(),
                activation_id: created.activation_id.clone(),
                thread_id: created.thread_id.clone(),
                agent_id: created.agent_id.clone(),
                context_id: created.context_id.clone(),
                session_id: created.session_id.clone(),
                initiating_principal_id: None,
                target_id: created.target_id.clone(),
                tool_call_id: created.tool_call_id.clone(),
                tool_name: created.tool_name.clone(),
                request: created.request.clone(),
                retry_safety: created.retry_safety,
                requires_approval: false,
            })
            .await
            .unwrap();
        assert_eq!(replayed.status, ExecutionJobStatus::Succeeded);
        assert_eq!(replayed.revision, succeeded.revision);
        assert!(store
            .list_execution_jobs(ExecutionJobFilter {
                context_id: Some(created.context_id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()
            .is_empty());

        store.pool.close().await;
        drop(store);
        let reopened = SqliteStore::new(path).await.unwrap();
        assert_eq!(
            reopened
                .get_execution_job(&created.id)
                .await
                .unwrap()
                .unwrap(),
            succeeded
        );
    }

    #[tokio::test]
    async fn execution_job_terminal_and_result_event_commit_atomically_before_batch_signal() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let created = seed_execution_job(
            &store,
            "atomic-result",
            false,
            ExecutionRetrySafety::AtMostOnce,
        )
        .await;
        let claimed = match store
            .claim_execution_job(
                &created.id,
                created.revision,
                "worker",
                "claim-atomic",
                Utc::now() + chrono::Duration::minutes(1),
                None,
            )
            .await
            .unwrap()
        {
            ExecutionJobMutation::Updated(job) => job,
            other => panic!("unexpected claim: {other:?}"),
        };
        let result_event = Event::new(
            "atomic-job-result".to_string(),
            "System-Executor".to_string(),
            crate::event::TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            serde_json::Map::from_iter([
                (
                    "context_id".to_string(),
                    serde_json::json!(created.context_id),
                ),
                (
                    "session_id".to_string(),
                    serde_json::json!(created.session_id),
                ),
                (
                    "activation_id".to_string(),
                    serde_json::json!(created.activation_id),
                ),
                (
                    "thread_id".to_string(),
                    serde_json::json!(created.thread_id),
                ),
                (
                    "tool_call_id".to_string(),
                    serde_json::json!(created.tool_call_id),
                ),
                (
                    "tool_name".to_string(),
                    serde_json::json!(created.tool_name),
                ),
                ("text".to_string(), serde_json::json!("ok")),
            ]),
        );
        let terminal = ExecutionJobTerminal {
            status: ExecutionJobStatus::Succeeded,
            result_event_id: Some(result_event.id.clone()),
            result_refs: Vec::new(),
            error: None,
            exit_code: Some(0),
        };

        let mut misrouted = result_event.clone();
        misrouted
            .payload
            .insert("thread_id".to_string(), serde_json::json!("another-thread"));
        assert!(store
            .finish_execution_job_with_event(
                &created.id,
                claimed.revision,
                Some("claim-atomic"),
                terminal.clone(),
                &misrouted,
                false,
            )
            .await
            .is_err());
        let after_rejection = store.get_execution_job(&created.id).await.unwrap().unwrap();
        assert_eq!(after_rejection.status, ExecutionJobStatus::Running);
        assert_eq!(after_rejection.revision, claimed.revision);
        assert!(store
            .query(QueryFilter {
                event_id: Some(result_event.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()
            .is_empty());

        let committed = match store
            .finish_execution_job_with_event(
                &created.id,
                claimed.revision,
                Some("claim-atomic"),
                terminal.clone(),
                &result_event,
                false,
            )
            .await
            .unwrap()
        {
            ExecutionJobMutation::Updated(job) => job,
            other => panic!("unexpected atomic completion: {other:?}"),
        };
        assert_eq!(committed.status, ExecutionJobStatus::Succeeded);
        assert_eq!(
            committed.result_event_id.as_deref(),
            Some(result_event.id.as_str())
        );
        assert_eq!(
            store
                .query(QueryFilter {
                    event_id: Some(result_event.id.clone()),
                    ..Default::default()
                })
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(store
            .list_signal_outbox(SignalOutboxStatus::Pending, 10)
            .await
            .unwrap()
            .is_empty());

        assert!(matches!(
            store
                .finish_execution_job_with_event(
                    &created.id,
                    claimed.revision,
                    Some("claim-atomic"),
                    terminal,
                    &result_event,
                    false,
                )
                .await
                .unwrap(),
            ExecutionJobMutation::Existing(_)
        ));
        store
            .append_with_signal_outbox(result_event.clone())
            .await
            .unwrap();
        let pending = store
            .list_signal_outbox(SignalOutboxStatus::Pending, 10)
            .await
            .unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].event_id, result_event.id);
    }

    #[tokio::test]
    async fn execution_job_exact_replay_cannot_repair_missing_event_with_wrong_route() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let created = seed_execution_job(
            &store,
            "legacy-terminal-without-event",
            false,
            ExecutionRetrySafety::AtMostOnce,
        )
        .await;
        let claimed = match store
            .claim_execution_job(
                &created.id,
                created.revision,
                "legacy-worker",
                "legacy-claim",
                Utc::now() + chrono::Duration::minutes(1),
                None,
            )
            .await
            .unwrap()
        {
            ExecutionJobMutation::Updated(job) => job,
            other => panic!("unexpected claim: {other:?}"),
        };
        let event_id = "legacy-missing-result".to_string();
        let terminal = ExecutionJobTerminal {
            status: ExecutionJobStatus::Succeeded,
            result_event_id: Some(event_id.clone()),
            result_refs: Vec::new(),
            error: None,
            exit_code: Some(0),
        };
        let terminal_job = match store
            .finish_execution_job(
                &created.id,
                claimed.revision,
                Some("legacy-claim"),
                terminal.clone(),
            )
            .await
            .unwrap()
        {
            ExecutionJobMutation::Updated(job) => job,
            other => panic!("unexpected legacy completion: {other:?}"),
        };
        let misrouted = Event::new(
            event_id.clone(),
            "System-Executor".to_string(),
            crate::event::TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            serde_json::Map::from_iter([
                (
                    "context_id".to_string(),
                    serde_json::json!(created.context_id),
                ),
                (
                    "session_id".to_string(),
                    serde_json::json!(created.session_id),
                ),
                (
                    "activation_id".to_string(),
                    serde_json::json!(created.activation_id),
                ),
                ("thread_id".to_string(), serde_json::json!("wrong-thread")),
                (
                    "tool_call_id".to_string(),
                    serde_json::json!(created.tool_call_id),
                ),
                (
                    "tool_name".to_string(),
                    serde_json::json!(created.tool_name),
                ),
            ]),
        );

        assert!(store
            .finish_execution_job_with_event(
                &created.id,
                terminal_job.revision,
                Some("legacy-claim"),
                terminal,
                &misrouted,
                false,
            )
            .await
            .is_err());
        assert!(store
            .query(QueryFilter {
                event_id: Some(event_id),
                ..Default::default()
            })
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn execution_job_requeue_only_accepts_clean_idempotent_recovery() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let created = seed_execution_job(
            &store,
            "safe-requeue",
            false,
            ExecutionRetrySafety::Idempotent,
        )
        .await;
        let claimed = match store
            .claim_execution_job(
                &created.id,
                created.revision,
                "crashed-worker",
                "claim-requeue",
                Utc::now() + chrono::Duration::minutes(1),
                None,
            )
            .await
            .unwrap()
        {
            ExecutionJobMutation::Updated(job) => job,
            other => panic!("unexpected claim: {other:?}"),
        };
        let requeued = match store
            .requeue_execution_job(&claimed.id, claimed.revision)
            .await
            .unwrap()
        {
            ExecutionJobMutation::Updated(job) => job,
            other => panic!("unexpected requeue: {other:?}"),
        };
        assert_eq!(requeued.status, ExecutionJobStatus::Queued);
        assert!(requeued.claim_token.is_none());
        assert!(requeued.claimed_by.is_none());

        let unsafe_created = seed_execution_job(
            &store,
            "unsafe-requeue",
            false,
            ExecutionRetrySafety::AtMostOnce,
        )
        .await;
        let unsafe_claimed = match store
            .claim_execution_job(
                &unsafe_created.id,
                unsafe_created.revision,
                "crashed-worker",
                "claim-unsafe",
                Utc::now() + chrono::Duration::minutes(1),
                None,
            )
            .await
            .unwrap()
        {
            ExecutionJobMutation::Updated(job) => job,
            other => panic!("unexpected unsafe claim: {other:?}"),
        };
        assert!(matches!(
            store
                .requeue_execution_job(&unsafe_claimed.id, unsafe_claimed.revision)
                .await
                .unwrap(),
            ExecutionJobMutation::Rejected { .. }
        ));
    }

    #[tokio::test]
    async fn delivery_flush_rearm_never_crosses_first_result_max_wait() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let (_context_id, session_id, threads) = seed_delivery_fixture(&store, "max-wait", 2).await;
        let first_at = Utc::now() - chrono::Duration::seconds(1);
        mark_delivery_pending(
            &store,
            &threads[0],
            "first result",
            "first-result-event",
            first_at,
        )
        .await;
        let first = store
            .arm_delivery_flush_timer("delivery-max-wait", &session_id, 10, 3)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.generation, 1);
        assert_eq!(first.due_at, first_at + chrono::Duration::seconds(3));

        let second_at = first_at + chrono::Duration::seconds(2);
        mark_delivery_pending(
            &store,
            &threads[1],
            "second result",
            "second-result-event",
            second_at,
        )
        .await;
        let rearmed = store
            .arm_delivery_flush_timer("delivery-max-wait", &session_id, 10, 3)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(rearmed.generation, 2);
        assert_eq!(
            rearmed.due_at,
            first_at + chrono::Duration::seconds(3),
            "a late adjacent completion must not extend the first result past max_wait"
        );
        assert_eq!(
            store.list_pending_delivery_sessions().await.unwrap(),
            vec![session_id.clone()]
        );

        store.pool.close().await;
        drop(store);
        let reopened = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let recovered = reopened
            .arm_delivery_flush_timer("delivery-max-wait", &session_id, 10, 3)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(recovered.generation, 3);
        assert_eq!(
            recovered.due_at,
            first_at + chrono::Duration::seconds(3),
            "restart recovery must preserve the original first-result deadline"
        );
    }

    #[tokio::test]
    async fn delivery_flush_generation_fence_and_event_outbox_are_idempotent() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let (context_id, session_id, threads) = seed_delivery_fixture(&store, "fence", 1).await;
        let pending_at = Utc::now();
        mark_delivery_pending(
            &store,
            &threads[0],
            "fenced result",
            "fenced-result-event",
            pending_at,
        )
        .await;
        let stale = store
            .arm_delivery_flush_timer("delivery-fence", &session_id, 1, 3)
            .await
            .unwrap()
            .unwrap();
        let current = store
            .arm_delivery_flush_timer("delivery-fence", &session_id, 1, 3)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(current.generation, stale.generation + 1);
        let claimed = store
            .claim_due_runtime_timers(
                Utc::now() + chrono::Duration::seconds(10),
                "delivery-claim",
                Utc::now() + chrono::Duration::seconds(40),
                8,
            )
            .await
            .unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].generation, current.generation);

        let mut event = Event::new(
            "delivery-ready-fenced".to_string(),
            "Runtime-Delivery".to_string(),
            crate::event::TYPE_TOOL_OUTPUT.to_string(),
            "chat/thread_completion_ready".to_string(),
            serde_json::Map::from_iter([
                ("context_id".to_string(), serde_json::json!(context_id)),
                ("session_id".to_string(), serde_json::json!(session_id)),
                (
                    "root_turn_id".to_string(),
                    serde_json::json!("delivery-ready-fenced"),
                ),
                ("thread_kind".to_string(), serde_json::json!("delivery")),
            ]),
        );
        event.timestamp = pending_at;
        assert_eq!(
            store
                .commit_delivery_flush("delivery-fence", stale.generation, &event)
                .await
                .unwrap(),
            DeliveryFlushCommit::Stale
        );
        assert_eq!(
            store
                .commit_delivery_flush("delivery-fence", current.generation, &event)
                .await
                .unwrap(),
            DeliveryFlushCommit::Committed
        );
        assert_eq!(
            store
                .commit_delivery_flush("delivery-fence", current.generation, &event)
                .await
                .unwrap(),
            DeliveryFlushCommit::Existing {
                event_id: event.id.clone()
            }
        );
        assert_eq!(
            store
                .query(QueryFilter {
                    event_id: Some(event.id.clone()),
                    ..Default::default()
                })
                .await
                .unwrap()
                .len(),
            1
        );
        let outbox = store
            .list_signal_outbox(SignalOutboxStatus::Pending, 8)
            .await
            .unwrap();
        assert_eq!(outbox.len(), 1);
        assert_eq!(outbox[0].event_id, event.id);
    }

    #[tokio::test]
    async fn delivery_flush_reply_atomically_covers_singleton_without_signal_outbox() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let (context_id, session_id, threads) =
            seed_delivery_fixture(&store, "direct-fence", 1).await;
        let pending_at = Utc::now();
        mark_delivery_pending(
            &store,
            &threads[0],
            "direct result",
            "direct-result-event",
            pending_at,
        )
        .await;
        let stale = store
            .arm_delivery_flush_timer("delivery-direct-fence", &session_id, 1, 3)
            .await
            .unwrap()
            .unwrap();
        let current = store
            .arm_delivery_flush_timer("delivery-direct-fence", &session_id, 1, 3)
            .await
            .unwrap()
            .unwrap();
        let claimed = store
            .claim_due_runtime_timers(
                Utc::now() + chrono::Duration::seconds(10),
                "delivery-direct-claim",
                Utc::now() + chrono::Duration::seconds(40),
                8,
            )
            .await
            .unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].generation, current.generation);

        let mut event = Event::new(
            "delivery-direct-reply".to_string(),
            "Runtime-Delivery".to_string(),
            crate::event::TYPE_AGENT_CALL.to_string(),
            "chat/reply".to_string(),
            serde_json::Map::from_iter([
                ("context_id".to_string(), serde_json::json!(context_id)),
                ("session_id".to_string(), serde_json::json!(session_id)),
                ("covers".to_string(), serde_json::json!([threads[0].id])),
                ("text".to_string(), serde_json::json!("direct result")),
            ]),
        );
        event.timestamp = pending_at;
        assert_eq!(
            store
                .commit_delivery_flush_reply("delivery-direct-fence", stale.generation, &event,)
                .await
                .unwrap(),
            DeliveryFlushCommit::Stale
        );
        assert_eq!(
            store
                .commit_delivery_flush_reply("delivery-direct-fence", current.generation, &event,)
                .await
                .unwrap(),
            DeliveryFlushCommit::Committed
        );
        assert_eq!(
            store
                .commit_delivery_flush_reply("delivery-direct-fence", current.generation, &event,)
                .await
                .unwrap(),
            DeliveryFlushCommit::Existing {
                event_id: event.id.clone()
            }
        );
        assert_eq!(
            store
                .get_thread(&threads[0].id)
                .await
                .unwrap()
                .unwrap()
                .delivery_status,
            DeliveryStatus::Delivered
        );
        assert!(store
            .list_signal_outbox(SignalOutboxStatus::Pending, 8)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn migrates_runtime_timer_check_to_delivery_flush_without_losing_rows() {
        let tmp_file = NamedTempFile::new().unwrap();
        let path = tmp_file.path().to_str().unwrap();
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query(
            r#"CREATE TABLE runtime_timers (
                id TEXT PRIMARY KEY,
                generation INTEGER NOT NULL CHECK(generation >= 0),
                kind TEXT NOT NULL CHECK(kind IN ('schedule', 'objective_wait', 'objective_lease', 'background_wake', 'activation_lease')),
                owner_id TEXT NOT NULL,
                due_at TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'fired', 'cancelled')),
                payload_json TEXT NOT NULL,
                claimed_by TEXT,
                claim_expires_at TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                fired_at TEXT
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            "INSERT INTO runtime_timers (id, generation, kind, owner_id, due_at, status, payload_json, created_at, updated_at) VALUES ('legacy-timer', 7, 'schedule', 'legacy-owner', ?, 'pending', '{}', ?, ?)",
        )
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        let store = SqliteStore::new(path).await.unwrap();
        let legacy = store
            .get_runtime_timer("legacy-timer")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(legacy.generation, 7);
        assert_eq!(legacy.kind, RuntimeTimerKind::Schedule);
        let delivery = store
            .upsert_runtime_timer(NewRuntimeTimer {
                id: "new-delivery-timer".to_string(),
                generation: 1,
                kind: RuntimeTimerKind::DeliveryFlush,
                owner_id: "delivery-session".to_string(),
                due_at: Utc::now(),
                payload: serde_json::json!({}),
            })
            .await
            .unwrap();
        assert_eq!(delivery.kind, RuntimeTimerKind::DeliveryFlush);
    }

    #[tokio::test]
    async fn runtime_timer_claim_is_leased_and_generation_safe() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let now = Utc::now();
        let created = store
            .upsert_runtime_timer(NewRuntimeTimer {
                id: "timer-generation-safe".to_string(),
                generation: 1,
                kind: RuntimeTimerKind::Schedule,
                owner_id: "schedule-generation-safe".to_string(),
                due_at: now - chrono::Duration::seconds(1),
                payload: serde_json::json!({"revision": 1}),
            })
            .await
            .unwrap();
        assert_eq!(created.status, RuntimeTimerStatus::Pending);

        let first = store
            .claim_due_runtime_timers(now, "claim-first", now + chrono::Duration::seconds(30), 8)
            .await
            .unwrap();
        assert_eq!(first.len(), 1);
        assert!(store
            .claim_due_runtime_timers(now, "claim-second", now + chrono::Duration::seconds(30), 8,)
            .await
            .unwrap()
            .is_empty());

        let advanced = store
            .upsert_runtime_timer(NewRuntimeTimer {
                id: "timer-generation-safe".to_string(),
                generation: 2,
                kind: RuntimeTimerKind::Schedule,
                owner_id: "schedule-generation-safe".to_string(),
                due_at: now,
                payload: serde_json::json!({"revision": 2}),
            })
            .await
            .unwrap();
        assert_eq!(advanced.generation, 2);
        assert_eq!(advanced.status, RuntimeTimerStatus::Pending);
        assert!(!store
            .complete_runtime_timer("timer-generation-safe", 1, "claim-first")
            .await
            .unwrap());

        let second = store
            .claim_due_runtime_timers(now, "claim-second", now + chrono::Duration::seconds(30), 8)
            .await
            .unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].generation, 2);
        assert!(!store
            .cancel_runtime_timer("timer-generation-safe")
            .await
            .unwrap());
        assert!(!store
            .retry_runtime_timer(
                "timer-generation-safe",
                2,
                "wrong-claim",
                now + chrono::Duration::minutes(1),
                Some("must not win"),
            )
            .await
            .unwrap());
        assert!(store
            .complete_runtime_timer("timer-generation-safe", 2, "claim-second")
            .await
            .unwrap());

        let same_generation = store
            .upsert_runtime_timer(NewRuntimeTimer {
                id: "timer-generation-safe".to_string(),
                generation: 2,
                kind: RuntimeTimerKind::Schedule,
                owner_id: "schedule-generation-safe".to_string(),
                due_at: now,
                payload: serde_json::json!({"revision": 2, "duplicate": true}),
            })
            .await
            .unwrap();
        assert_eq!(same_generation.status, RuntimeTimerStatus::Fired);
        assert!(!store
            .cancel_runtime_timer("timer-generation-safe")
            .await
            .unwrap());

        store
            .upsert_runtime_timer(NewRuntimeTimer {
                id: "timer-cancel-pending".to_string(),
                generation: 1,
                kind: RuntimeTimerKind::Schedule,
                owner_id: "schedule-cancel-pending".to_string(),
                due_at: now + chrono::Duration::minutes(1),
                payload: serde_json::json!({}),
            })
            .await
            .unwrap();
        assert!(store
            .cancel_runtime_timer("timer-cancel-pending")
            .await
            .unwrap());
        assert_eq!(
            store
                .get_runtime_timer("timer-cancel-pending")
                .await
                .unwrap()
                .unwrap()
                .status,
            RuntimeTimerStatus::Cancelled
        );

        store
            .upsert_runtime_timer(NewRuntimeTimer {
                id: "timer-expired-lease".to_string(),
                generation: 1,
                kind: RuntimeTimerKind::Schedule,
                owner_id: "schedule-expired-lease".to_string(),
                due_at: now,
                payload: serde_json::json!({}),
            })
            .await
            .unwrap();
        assert_eq!(
            store
                .claim_due_runtime_timers(
                    now,
                    "crashed-worker",
                    now + chrono::Duration::seconds(1),
                    8,
                )
                .await
                .unwrap()
                .len(),
            1
        );
        let recovered = store
            .claim_due_runtime_timers(
                now + chrono::Duration::seconds(2),
                "restarted-worker",
                now + chrono::Duration::seconds(32),
                8,
            )
            .await
            .unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].claimed_by.as_deref(), Some("restarted-worker"));
    }

    #[tokio::test]
    async fn migrates_legacy_evaluation_work_items_into_thread_activations() {
        let tmp_file = NamedTempFile::new().unwrap();
        let path = tmp_file.path().to_str().unwrap();
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query(
            r#"CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                context_id TEXT NOT NULL,
                parent_session_id TEXT,
                title TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_activity_at TEXT NOT NULL
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"CREATE TABLE evaluation_work_items (
                id TEXT PRIMARY KEY,
                revision INTEGER NOT NULL,
                agent_id TEXT NOT NULL,
                context_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                trigger_event_id TEXT NOT NULL UNIQUE,
                trigger_sequence INTEGER NOT NULL,
                trigger_kind TEXT NOT NULL,
                parent_work_item_id TEXT,
                root_turn_id TEXT NOT NULL,
                context_snapshot_version INTEGER,
                status TEXT NOT NULL,
                claimed_by TEXT,
                lease_expires_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"CREATE TABLE evaluation_outcomes (
                work_item_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                disposition TEXT NOT NULL,
                event_id TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                FOREIGN KEY(work_item_id) REFERENCES evaluation_work_items(id) ON DELETE CASCADE
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"CREATE TABLE work_threads (
                id TEXT PRIMARY KEY,
                revision INTEGER NOT NULL,
                agent_id TEXT NOT NULL,
                context_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                root_turn_id TEXT NOT NULL UNIQUE,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                executor_kind TEXT NOT NULL,
                executor_id TEXT,
                result_text TEXT,
                result_event_id TEXT,
                delivery_status TEXT NOT NULL,
                delivery_event_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"CREATE TABLE work_thread_outcomes (
                thread_id TEXT PRIMARY KEY,
                root_turn_id TEXT NOT NULL UNIQUE,
                work_item_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                disposition TEXT NOT NULL,
                event_id TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                FOREIGN KEY(thread_id) REFERENCES work_threads(id) ON DELETE CASCADE,
                FOREIGN KEY(work_item_id) REFERENCES evaluation_work_items(id) ON DELETE CASCADE
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO sessions (id, agent_id, context_id, title, status, created_at, updated_at, last_activity_at) VALUES ('session', 'agent', 'context', 'legacy', 'active', ?, ?, ?)",
        )
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"INSERT INTO evaluation_work_items
               (id, revision, agent_id, context_id, session_id, trigger_event_id,
                trigger_sequence, trigger_kind, parent_work_item_id, root_turn_id,
                status, created_at, updated_at)
               VALUES ('legacy-activation', 1, 'agent', 'context', 'session',
                       'event', 7, 'chat/tool_output', NULL, 'root',
                       'waiting_tool', ?, ?)"#,
        )
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO work_threads (id, revision, agent_id, context_id, session_id, root_turn_id, kind, status, executor_kind, delivery_status, created_at, updated_at) VALUES ('legacy-thread', 1, 'agent', 'context', 'session', 'root', 'work', 'active', 'self', 'none', ?, ?)",
        )
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO work_thread_outcomes (thread_id, root_turn_id, work_item_id, session_id, disposition, event_id, created_at) VALUES ('legacy-thread', 'root', 'legacy-activation', 'session', 'deliver', 'legacy-result', ?)",
        )
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        let store = SqliteStore::new(path).await.unwrap();
        let migrated = store
            .get_thread_activation("legacy-activation")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(migrated.status, ThreadActivationStatus::Succeeded);
        let columns = sqlx::query("PRAGMA table_info(thread_activations)")
            .fetch_all(&store.pool)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.get::<String, _>("name"))
            .collect::<std::collections::HashSet<_>>();
        assert!(columns.contains("parent_activation_id"));
        assert!(!columns.contains("parent_work_item_id"));
        let legacy_table = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'evaluation_work_items'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(legacy_table, 0);
        for legacy in ["work_threads", "work_thread_outcomes"] {
            let count = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .bind(legacy)
            .fetch_one(&store.pool)
            .await
            .unwrap();
            assert_eq!(count, 0);
        }
        assert_eq!(
            store
                .get_thread("legacy-thread")
                .await
                .unwrap()
                .unwrap()
                .kind,
            ThreadKind::Execution
        );
        let outcome_columns = sqlx::query("PRAGMA table_info(thread_outcomes)")
            .fetch_all(&store.pool)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.get::<String, _>("name"))
            .collect::<std::collections::HashSet<_>>();
        assert!(outcome_columns.contains("activation_id"));
        assert!(!outcome_columns.contains("work_item_id"));
        let outcome_foreign_keys = sqlx::query("PRAGMA foreign_key_list(evaluation_outcomes)")
            .fetch_all(&store.pool)
            .await
            .unwrap();
        assert!(outcome_foreign_keys
            .iter()
            .any(|row| row.get::<String, _>("table") == "thread_activations"));
    }

    #[tokio::test]
    async fn test_sqlite_event_store() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp_file.path().to_str().unwrap())
                .await
                .unwrap(),
        );

        let mut payload = serde_json::Map::new();
        payload.insert("key".to_string(), serde_json::json!("value"));
        payload.insert("session_id".to_string(), serde_json::json!("session-a"));

        let ev = Event::new(
            "ev_1".to_string(),
            "actor_1".to_string(),
            "type_1".to_string(),
            "chat/topic_1".to_string(),
            payload,
        );

        store.append(ev).await.unwrap();

        let filter = QueryFilter {
            session_id: Some("session-a".to_string()),
            topic: Some("chat/*".to_string()),
            ..Default::default()
        };

        let results = store.query(filter).await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "ev_1");
        assert_eq!(
            results[0].payload.get("key").unwrap().as_str().unwrap(),
            "value"
        );

        let other_session = store
            .query(QueryFilter {
                session_id: Some("session-b".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(other_session.is_empty());
    }

    #[tokio::test]
    async fn event_causal_route_is_projected_and_exactly_queryable() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let event = |id: &str, thread_id: &str| {
            Event::new(
                id.to_string(),
                "Runtime-Orchestrator".to_string(),
                "runtime_control".to_string(),
                "runtime/model_attempt_state".to_string(),
                [
                    ("context_id".to_string(), serde_json::json!("context-a")),
                    ("session_id".to_string(), serde_json::json!("session-a")),
                    ("thread_id".to_string(), serde_json::json!(thread_id)),
                    (
                        "activation_id".to_string(),
                        serde_json::json!("activation-a"),
                    ),
                    ("root_turn_id".to_string(), serde_json::json!("turn-root-a")),
                    ("objective_id".to_string(), serde_json::json!("objective-a")),
                ]
                .into_iter()
                .collect(),
            )
        };
        store.append(event("causal-a", "thread-a")).await.unwrap();
        store.append(event("causal-b", "thread-b")).await.unwrap();

        let events = store
            .query(QueryFilter {
                context_id: Some("context-a".to_string()),
                session_id: Some("session-a".to_string()),
                topic: Some("runtime/model_attempt_state".to_string()),
                thread_id: Some("thread-a".to_string()),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "causal-a");

        let projected = sqlx::query(
            "SELECT thread_id, activation_id, root_turn_id, objective_id FROM events WHERE id = ?",
        )
        .bind("causal-a")
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(
            projected.get::<Option<String>, _>("thread_id").as_deref(),
            Some("thread-a")
        );
        assert_eq!(
            projected
                .get::<Option<String>, _>("activation_id")
                .as_deref(),
            Some("activation-a")
        );
        assert_eq!(
            projected
                .get::<Option<String>, _>("root_turn_id")
                .as_deref(),
            Some("turn-root-a")
        );
        assert_eq!(
            projected
                .get::<Option<String>, _>("objective_id")
                .as_deref(),
            Some("objective-a")
        );
    }

    #[tokio::test]
    async fn legacy_thread_events_are_lazily_projected_once_without_payload_search() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        store
            .append(Event::new(
                "legacy-thread-event".to_string(),
                "Runtime-Orchestrator".to_string(),
                "runtime_control".to_string(),
                "runtime/model_attempt_state".to_string(),
                serde_json::json!({
                    "context_id": "legacy-context",
                    "session_id": "legacy-session",
                    "route": {
                        "thread_id": "legacy-thread",
                        "activation_id": "legacy-activation",
                        "root_turn_id": "legacy-root"
                    }
                })
                .as_object()
                .unwrap()
                .clone(),
            ))
            .await
            .unwrap();
        // Simulate an Event written before the causal projection migration.
        sqlx::query(
            "UPDATE events SET thread_id = NULL, activation_id = NULL, root_turn_id = NULL, objective_id = NULL WHERE id = ?",
        )
        .bind("legacy-thread-event")
        .execute(&store.pool)
        .await
        .unwrap();

        store
            .backfill_causal_projection_for_thread(
                "legacy-context",
                "legacy-session",
                "legacy-thread",
                "runtime/model_attempt_state",
            )
            .await
            .unwrap();
        let projected = store
            .query(QueryFilter {
                context_id: Some("legacy-context".to_string()),
                session_id: Some("legacy-session".to_string()),
                topic: Some("runtime/model_attempt_state".to_string()),
                thread_id: Some("legacy-thread".to_string()),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(projected.len(), 1);
        let markers = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM event_causal_projection_backfills WHERE context_id = ? AND session_id = ? AND thread_id = ?",
        )
        .bind("legacy-context")
        .bind("legacy-session")
        .bind("legacy-thread")
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(markers, 1);
    }

    #[tokio::test]
    async fn a_thread_spanning_the_projection_upgrade_is_filled_completely() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let event = |id: &str| {
            Event::new(
                id.to_string(),
                "Runtime-Orchestrator".to_string(),
                "runtime_control".to_string(),
                "runtime/model_attempt_state".to_string(),
                serde_json::json!({
                    "context_id": "mixed-context",
                    "session_id": "mixed-session",
                    "thread_id": "mixed-thread"
                })
                .as_object()
                .unwrap()
                .clone(),
            )
        };
        store.append(event("legacy-row")).await.unwrap();
        store.append(event("projected-row")).await.unwrap();
        // Only one row predates the causal columns, so the indexed query still
        // returns the other one. A caller that asks for the fill only when the
        // query came back empty would never repair this Thread.
        sqlx::query("UPDATE events SET thread_id = NULL WHERE id = ?")
            .bind("legacy-row")
            .execute(&store.pool)
            .await
            .unwrap();
        let filter = || QueryFilter {
            context_id: Some("mixed-context".to_string()),
            session_id: Some("mixed-session".to_string()),
            topic: Some("runtime/model_attempt_state".to_string()),
            thread_id: Some("mixed-thread".to_string()),
            ..QueryFilter::default()
        };
        assert_eq!(store.query(filter()).await.unwrap().len(), 1);

        store
            .backfill_causal_projection_for_thread(
                "mixed-context",
                "mixed-session",
                "mixed-thread",
                "runtime/model_attempt_state",
            )
            .await
            .unwrap();
        let repaired = store.query(filter()).await.unwrap();
        assert_eq!(repaired.len(), 2, "legacy half of the Thread stayed hidden");

        // The marker settles later polls without opening a write transaction.
        store
            .backfill_causal_projection_for_thread(
                "mixed-context",
                "mixed-session",
                "mixed-thread",
                "runtime/model_attempt_state",
            )
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM event_causal_projection_backfills WHERE thread_id = ?",
            )
            .bind("mixed-thread")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn legacy_causal_projection_backfill_is_bounded_and_resumable() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        for index in 0..40 {
            let id = format!("bounded-legacy-{index:02}");
            store
                .append(Event::new(
                    id.clone(),
                    "Runtime-Orchestrator".to_string(),
                    "runtime_control".to_string(),
                    "runtime/model_attempt_state".to_string(),
                    serde_json::json!({
                        "context_id": "bounded-context",
                        "session_id": "bounded-session",
                        "route": {
                            "thread_id": "bounded-thread",
                            "activation_id": format!("bounded-activation-{index:02}"),
                            "root_turn_id": "bounded-root"
                        }
                    })
                    .as_object()
                    .unwrap()
                    .clone(),
                ))
                .await
                .unwrap();
        }
        sqlx::query(
            "UPDATE events SET thread_id = NULL, activation_id = NULL, root_turn_id = NULL, objective_id = NULL WHERE context_id = ?",
        )
        .bind("bounded-context")
        .execute(&store.pool)
        .await
        .unwrap();

        store
            .backfill_causal_projection_for_thread(
                "bounded-context",
                "bounded-session",
                "bounded-thread",
                "runtime/model_attempt_state",
            )
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM events WHERE context_id = ? AND thread_id = ?",
            )
            .bind("bounded-context")
            .bind("bounded-thread")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
            32,
            "one Dashboard inspection must migrate only one bounded batch",
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM event_causal_projection_backfills WHERE thread_id = ?",
            )
            .bind("bounded-thread")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
            0,
            "a partial batch must not claim that the projection is complete",
        );

        store
            .backfill_causal_projection_for_thread(
                "bounded-context",
                "bounded-session",
                "bounded-thread",
                "runtime/model_attempt_state",
            )
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM events WHERE context_id = ? AND thread_id = ?",
            )
            .bind("bounded-context")
            .bind("bounded-thread")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
            40,
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM event_causal_projection_backfills WHERE thread_id = ?",
            )
            .bind("bounded-thread")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
            1,
        );
    }

    #[tokio::test]
    async fn failed_dialogue_turn_restarts_in_place_and_fences_old_generation() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        store
            .create_context(NewCognitiveContext {
                id: "retry-context".to_string(),
                agent_id: "retry-agent".to_string(),
                title: "Retry Context".to_string(),
            })
            .await
            .unwrap();
        store
            .create_session(NewSession {
                id: "retry-session".to_string(),
                agent_id: "retry-agent".to_string(),
                context_id: "retry-context".to_string(),
                parent_session_id: None,
                title: "Retry Session".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let root = Event::new(
            "retry-root".to_string(),
            "User".to_string(),
            crate::event::TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            serde_json::json!({
                "context_id": "retry-context",
                "session_id": "retry-session",
                "text": "do it"
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        store.append(root.clone()).await.unwrap();
        let root_sequence = store
            .query(QueryFilter {
                event_id: Some(root.id.clone()),
                ..QueryFilter::default()
            })
            .await
            .unwrap()[0]
            .sequence
            .unwrap();
        let thread = store
            .ensure_thread(NewThread {
                id: "retry-thread".to_string(),
                agent_id: "retry-agent".to_string(),
                context_id: "retry-context".to_string(),
                session_id: "retry-session".to_string(),
                initiating_principal_id: None,
                root_turn_id: root.id.clone(),
                kind: ThreadKind::DialogueTurn,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
            })
            .await
            .unwrap();
        let activation = store
            .claim_thread_signal_batch(
                NewThreadSignal {
                    id: "retry-root-signal".to_string(),
                    thread_id: thread.id.clone(),
                    event_id: root.id.clone(),
                    principal_id: None,
                    sequence: root_sequence,
                    kind: root.topic.clone(),
                    parent_activation_id: None,
                },
                NewThreadActivation {
                    id: "retry-old-activation".to_string(),
                    agent_id: "retry-agent".to_string(),
                    context_id: "retry-context".to_string(),
                    session_id: "retry-session".to_string(),
                    initiating_principal_id: None,
                    trigger_event_id: root.id.clone(),
                    trigger_sequence: root_sequence,
                    trigger_kind: root.topic.clone(),
                    parent_activation_id: None,
                    root_turn_id: root.id.clone(),
                },
                32,
            )
            .await
            .unwrap()
            .unwrap();
        let running = match store
            .update_thread_activation(
                &activation.id,
                activation.revision,
                ThreadActivationStatus::Running,
                Some("test-runtime"),
                Some(Utc::now() + chrono::Duration::seconds(30)),
                None,
            )
            .await
            .unwrap()
        {
            ThreadActivationMutation::Updated(record) => record,
            other => panic!("unexpected activation mutation: {other:?}"),
        };
        let failure = Event::new(
            "retry-failure-reply".to_string(),
            "Runtime-Orchestrator".to_string(),
            "assistant_message".to_string(),
            "chat/reply".to_string(),
            serde_json::json!({
                "context_id": "retry-context",
                "session_id": "retry-session",
                "root_turn_id": "retry-root",
                "thread_id": "retry-thread",
                "disposition": "deliver",
                "text": "provider failed",
                "runtime_failure_kind": "network",
                "runtime_failure_stage": "llm_completion"
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        assert_eq!(
            store
                .commit_activation_outcome(&running.id, &failure)
                .await
                .unwrap(),
            ActivationOutcomeCommit::Committed
        );
        // Reproduce a crash after the atomic failure outcome has committed but
        // before the Activation projection is closed.  The retry primitive
        // must recover this row itself rather than requiring a Runtime restart.
        assert_eq!(
            store
                .get_thread_activation(&running.id)
                .await
                .unwrap()
                .unwrap()
                .status,
            ThreadActivationStatus::Running
        );
        let failed_thread = store.get_thread("retry-thread").await.unwrap().unwrap();
        assert_eq!(failed_thread.lifecycle, ThreadLifecycle::Failed);
        assert_eq!(
            failed_thread.result_event_id.as_deref(),
            Some(failure.id.as_str())
        );

        let retry_event = Event::new(
            "retry-request-event".to_string(),
            "Runtime-DialogueRetry".to_string(),
            crate::event::TYPE_INFER_REQUEST.to_string(),
            "chat/dialogue_retry".to_string(),
            serde_json::json!({
                "context_id": "retry-context",
                "session_id": "retry-session",
                "root_turn_id": "retry-root",
                "thread_id": "retry-thread",
                "runtime_force_evaluation": true
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        let request = DialogueTurnRetryRequest {
            expected_thread_revision: failed_thread.revision,
            expected_result_event_id: failure.id.clone(),
            event: retry_event.clone(),
        };
        assert_eq!(
            store.restart_dialogue_turn(request.clone()).await.unwrap(),
            DialogueTurnRetryMutation::Accepted {
                thread_id: "retry-thread".to_string(),
                generation: 2,
            }
        );
        assert_eq!(
            store.restart_dialogue_turn(request).await.unwrap(),
            DialogueTurnRetryMutation::Existing {
                thread_id: "retry-thread".to_string(),
                generation: 2,
            }
        );
        let reopened = store.get_thread("retry-thread").await.unwrap().unwrap();
        assert_eq!(reopened.lifecycle, ThreadLifecycle::Open);
        assert_eq!(reopened.generation, 2);
        assert!(reopened.result_event_id.is_none());
        let fenced_activation = store
            .get_thread_activation(&running.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(fenced_activation.status, ThreadActivationStatus::Cancelled);
        assert!(fenced_activation.claimed_by.is_none());
        assert!(fenced_activation.lease_expires_at.is_none());
        assert_eq!(
            store
                .list_signal_outbox(SignalOutboxStatus::Pending, 16)
                .await
                .unwrap()[0]
                .event_id,
            retry_event.id
        );

        let stale_outcome = Event::new(
            "retry-stale-outcome".to_string(),
            "Runtime-Orchestrator".to_string(),
            "assistant_message".to_string(),
            "chat/reply".to_string(),
            serde_json::json!({
                "context_id": "retry-context",
                "session_id": "retry-session",
                "root_turn_id": "retry-root",
                "thread_id": "retry-thread",
                "disposition": "deliver",
                "text": "late old reply"
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        assert_eq!(
            store
                .commit_activation_outcome(&fenced_activation.id, &stale_outcome)
                .await
                .unwrap(),
            ActivationOutcomeCommit::StaleGeneration
        );
        assert!(store
            .query(QueryFilter {
                event_id: Some(stale_outcome.id),
                ..QueryFilter::default()
            })
            .await
            .unwrap()
            .is_empty());

        let retry_sequence = store
            .query(QueryFilter {
                event_id: Some(retry_event.id.clone()),
                ..QueryFilter::default()
            })
            .await
            .unwrap()[0]
            .sequence
            .unwrap();
        let retry_activation = store
            .claim_thread_signal_batch(
                NewThreadSignal {
                    id: "retry-generation-2-signal".to_string(),
                    thread_id: thread.id.clone(),
                    event_id: retry_event.id.clone(),
                    principal_id: None,
                    sequence: retry_sequence,
                    kind: retry_event.topic.clone(),
                    parent_activation_id: None,
                },
                NewThreadActivation {
                    id: "retry-generation-2-activation".to_string(),
                    agent_id: "retry-agent".to_string(),
                    context_id: "retry-context".to_string(),
                    session_id: "retry-session".to_string(),
                    initiating_principal_id: None,
                    trigger_event_id: retry_event.id.clone(),
                    trigger_sequence: retry_sequence,
                    trigger_kind: retry_event.topic.clone(),
                    parent_activation_id: None,
                    root_turn_id: root.id.clone(),
                },
                32,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(retry_activation.generation, 2);

        let late_tool = Event::new(
            "retry-late-tool-output".to_string(),
            "Runtime-Tool".to_string(),
            "tool_output".to_string(),
            "chat/tool_output".to_string(),
            serde_json::json!({
                "context_id": "retry-context",
                "session_id": "retry-session",
                "root_turn_id": "retry-root",
                "thread_id": "retry-thread",
                "activation_id": running.id,
                "text": "late generation-one tool result"
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        store.append(late_tool.clone()).await.unwrap();
        let late_sequence = store
            .query(QueryFilter {
                event_id: Some(late_tool.id.clone()),
                ..QueryFilter::default()
            })
            .await
            .unwrap()[0]
            .sequence
            .unwrap();
        assert!(store
            .claim_thread_signal_batch(
                NewThreadSignal {
                    id: "retry-late-tool-signal".to_string(),
                    thread_id: thread.id,
                    event_id: late_tool.id,
                    principal_id: None,
                    sequence: late_sequence,
                    kind: late_tool.topic,
                    parent_activation_id: Some(fenced_activation.id),
                },
                NewThreadActivation {
                    id: "retry-must-not-create-activation".to_string(),
                    agent_id: "retry-agent".to_string(),
                    context_id: "retry-context".to_string(),
                    session_id: "retry-session".to_string(),
                    initiating_principal_id: None,
                    trigger_event_id: "retry-late-tool-output".to_string(),
                    trigger_sequence: late_sequence,
                    trigger_kind: "chat/tool_output".to_string(),
                    parent_activation_id: Some("retry-old-activation".to_string()),
                    root_turn_id: root.id,
                },
                32,
            )
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            store
                .list_context_thread_signals(
                    "retry-context",
                    Some(ThreadSignalStatus::Acknowledged),
                )
                .await
                .unwrap()
                .iter()
                .filter(|signal| signal.id == "retry-late-tool-signal")
                .count(),
            1,
            "a late old-generation tool Signal must be acknowledged, never claimed",
        );
    }

    #[tokio::test]
    async fn event_batch_is_ordered_atomic_and_commits_signal_outbox_together() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let event = |id: &str, value: &str| {
            Event::new(
                id.to_string(),
                "batch-writer".to_string(),
                "user_message".to_string(),
                "chat/user_message".to_string(),
                [
                    ("context_id".to_string(), serde_json::json!("batch-context")),
                    ("session_id".to_string(), serde_json::json!("batch-session")),
                    ("text".to_string(), serde_json::json!(value)),
                ]
                .into_iter()
                .collect(),
            )
        };
        store
            .append_batch(vec![
                EventAppend {
                    event: event("batch-1", "one"),
                    signal_outbox: false,
                },
                EventAppend {
                    event: event("batch-2", "two"),
                    signal_outbox: true,
                },
                EventAppend {
                    event: event("batch-3", "three"),
                    signal_outbox: false,
                },
            ])
            .await
            .unwrap();
        let stored = store
            .query(QueryFilter {
                context_id: Some("batch-context".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(
            stored
                .iter()
                .map(|event| event.id.as_str())
                .collect::<Vec<_>>(),
            vec!["batch-1", "batch-2", "batch-3"]
        );
        let outbox_ids = sqlx::query("SELECT event_id FROM signal_outbox ORDER BY event_id")
            .fetch_all(&store.pool)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.get::<String, _>("event_id"))
            .collect::<Vec<_>>();
        assert_eq!(outbox_ids, vec!["batch-2"]);

        let conflicting = event("batch-2", "different");
        let error = store
            .append_batch(vec![
                EventAppend {
                    event: event("batch-rollback", "must not survive"),
                    signal_outbox: false,
                },
                EventAppend {
                    event: conflicting,
                    signal_outbox: false,
                },
            ])
            .await
            .unwrap_err();
        assert!(error.to_string().contains("已被不同内容占用"));
        assert!(store
            .query(QueryFilter {
                event_id: Some("batch-rollback".to_string()),
                ..Default::default()
            })
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn signal_outbox_survives_the_event_to_signal_crash_window() {
        let tmp_file = NamedTempFile::new().unwrap();
        let path = tmp_file.path().to_str().unwrap();
        let store = Arc::new(SqliteStore::new(path).await.unwrap());
        store
            .create_context(NewCognitiveContext {
                id: "outbox-context".to_string(),
                agent_id: "outbox-agent".to_string(),
                title: "Outbox Context".to_string(),
            })
            .await
            .unwrap();
        store
            .create_session(NewSession {
                id: "outbox-session".to_string(),
                agent_id: "outbox-agent".to_string(),
                context_id: "outbox-context".to_string(),
                parent_session_id: None,
                title: "Outbox Session".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let event = Event::new(
            "outbox-event".to_string(),
            "fixture".to_string(),
            crate::event::TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            [
                (
                    "context_id".to_string(),
                    serde_json::json!("outbox-context"),
                ),
                (
                    "session_id".to_string(),
                    serde_json::json!("outbox-session"),
                ),
                (
                    "client_message_id".to_string(),
                    serde_json::json!("outbox-client-message"),
                ),
                ("text".to_string(), serde_json::json!("continue")),
            ]
            .into_iter()
            .collect(),
        );
        assert_eq!(
            store
                .claim_message("outbox-session", "outbox-client-message", &event)
                .await
                .unwrap(),
            MessageClaim::Accepted
        );
        let pending = store
            .list_signal_outbox(SignalOutboxStatus::Pending, 16)
            .await
            .unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].event_id, event.id);

        // Simulate a process crash after the user Event transaction committed
        // but before EventBus could invoke the Orchestrator.
        store.pool.close().await;
        drop(store);
        let store = Arc::new(SqliteStore::new(path).await.unwrap());
        assert_eq!(
            store
                .list_signal_outbox(SignalOutboxStatus::Pending, 16)
                .await
                .unwrap()
                .len(),
            1
        );
        let stored_event = store
            .query(QueryFilter {
                event_id: Some(event.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()
            .pop()
            .unwrap();
        let sequence = stored_event.sequence.unwrap();
        let thread = store
            .ensure_thread(NewThread {
                id: "outbox-thread".to_string(),
                agent_id: "outbox-agent".to_string(),
                context_id: "outbox-context".to_string(),
                session_id: "outbox-session".to_string(),
                initiating_principal_id: None,
                root_turn_id: event.id.clone(),
                kind: ThreadKind::DialogueTurn,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
            })
            .await
            .unwrap();
        let activation = store
            .claim_thread_signal_batch(
                NewThreadSignal {
                    id: "outbox-signal".to_string(),
                    thread_id: thread.id,
                    event_id: event.id.clone(),
                    principal_id: None,
                    sequence,
                    kind: event.topic.clone(),
                    parent_activation_id: None,
                },
                NewThreadActivation {
                    id: "outbox-activation".to_string(),
                    agent_id: "outbox-agent".to_string(),
                    context_id: "outbox-context".to_string(),
                    session_id: "outbox-session".to_string(),
                    initiating_principal_id: None,
                    trigger_event_id: event.id.clone(),
                    trigger_sequence: sequence,
                    trigger_kind: event.topic.clone(),
                    parent_activation_id: None,
                    root_turn_id: event.id.clone(),
                },
                32,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(activation.id, "outbox-activation");
        assert!(store
            .list_signal_outbox(SignalOutboxStatus::Pending, 16)
            .await
            .unwrap()
            .is_empty());
        let materialized = store
            .list_signal_outbox(SignalOutboxStatus::Materialized, 16)
            .await
            .unwrap();
        assert_eq!(materialized.len(), 1);
        assert_eq!(materialized[0].signal_id.as_deref(), Some("outbox-signal"));

        // Re-appending the same routed Event cannot reopen the handoff.
        store
            .append_with_signal_outbox(event.clone())
            .await
            .unwrap();
        assert!(store
            .list_signal_outbox(SignalOutboxStatus::Pending, 16)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn signal_outbox_rejects_unroutable_events_atomically() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let event = Event::new(
            "unroutable-outbox-event".to_string(),
            "fixture".to_string(),
            crate::event::TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            serde_json::Map::new(),
        );
        assert!(store
            .append_with_signal_outbox(event.clone())
            .await
            .is_err());
        assert!(store
            .query(QueryFilter {
                event_id: Some(event.id),
                ..Default::default()
            })
            .await
            .unwrap()
            .is_empty());

        let discarded = Event::new(
            "discarded-outbox-event".to_string(),
            "fixture".to_string(),
            crate::event::TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            [
                ("context_id".to_string(), serde_json::json!("context")),
                ("session_id".to_string(), serde_json::json!("session")),
            ]
            .into_iter()
            .collect(),
        );
        store
            .append_with_signal_outbox(discarded.clone())
            .await
            .unwrap();
        assert!(store.discard_signal_outbox(&discarded.id).await.unwrap());
        assert!(!store.discard_signal_outbox(&discarded.id).await.unwrap());
        assert_eq!(
            store
                .list_signal_outbox(SignalOutboxStatus::Discarded, 16)
                .await
                .unwrap()[0]
                .event_id,
            discarded.id
        );
    }

    #[tokio::test]
    async fn queued_activation_admission_query_is_bounded_reserved_and_restart_safe() {
        let tmp_file = NamedTempFile::new().unwrap();
        let path = tmp_file.path().to_str().unwrap();
        let store = SqliteStore::new(path).await.unwrap();
        store
            .create_context(NewCognitiveContext {
                id: "admission-context".to_string(),
                agent_id: "admission-agent".to_string(),
                title: "Admission Context".to_string(),
            })
            .await
            .unwrap();
        store
            .create_session(NewSession {
                id: "admission-session".to_string(),
                agent_id: "admission-agent".to_string(),
                context_id: "admission-context".to_string(),
                parent_session_id: None,
                title: "Admission Session".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();

        let fixtures = [
            (
                "interactive",
                crate::event::TYPE_USER_MESSAGE,
                "chat/user_message",
                serde_json::Map::new(),
                crate::admission::AdmissionClass::InteractiveControl,
            ),
            (
                "delivery",
                crate::event::TYPE_TOOL_OUTPUT,
                "chat/thread_completion_ready",
                serde_json::Map::new(),
                crate::admission::AdmissionClass::Delivery,
            ),
            (
                "objective",
                crate::event::TYPE_TOOL_OUTPUT,
                "objective/resume",
                serde_json::Map::new(),
                crate::admission::AdmissionClass::Objective,
            ),
            (
                "scheduled",
                crate::event::TYPE_TOOL_OUTPUT,
                "chat/schedule_due",
                serde_json::Map::new(),
                crate::admission::AdmissionClass::ScheduledBackground,
            ),
            (
                "maintenance",
                crate::event::TYPE_TOOL_OUTPUT,
                "runtime/context_maintenance",
                serde_json::Map::new(),
                crate::admission::AdmissionClass::Maintenance,
            ),
        ];

        for (name, event_type, topic, extra_payload, _) in &fixtures {
            let event_id = format!("admission-event-{name}");
            let root_turn_id = format!("admission-root-{name}");
            let mut payload = serde_json::Map::from_iter([
                (
                    "context_id".to_string(),
                    serde_json::json!("admission-context"),
                ),
                (
                    "session_id".to_string(),
                    serde_json::json!("admission-session"),
                ),
                ("root_turn_id".to_string(), serde_json::json!(root_turn_id)),
            ]);
            payload.extend(extra_payload.clone());
            store
                .append(Event::new(
                    event_id.clone(),
                    "fixture".to_string(),
                    (*event_type).to_string(),
                    (*topic).to_string(),
                    payload,
                ))
                .await
                .unwrap();
            let sequence = store
                .query(QueryFilter {
                    event_id: Some(event_id.clone()),
                    ..Default::default()
                })
                .await
                .unwrap()[0]
                .sequence
                .unwrap();
            let thread = store
                .ensure_thread(NewThread {
                    id: format!("admission-thread-{name}"),
                    agent_id: "admission-agent".to_string(),
                    context_id: "admission-context".to_string(),
                    session_id: "admission-session".to_string(),
                    initiating_principal_id: None,
                    root_turn_id: root_turn_id.clone(),
                    kind: ThreadKind::Execution,
                    executor_kind: "self".to_string(),
                    executor_id: None,
                    target_id: None,
                })
                .await
                .unwrap();
            let activation = store
                .claim_thread_signal_batch(
                    NewThreadSignal {
                        id: format!("admission-signal-{name}"),
                        thread_id: thread.id,
                        event_id: event_id.clone(),
                        principal_id: None,
                        sequence,
                        kind: (*topic).to_string(),
                        parent_activation_id: None,
                    },
                    NewThreadActivation {
                        id: format!("admission-activation-{name}"),
                        agent_id: "admission-agent".to_string(),
                        context_id: "admission-context".to_string(),
                        session_id: "admission-session".to_string(),
                        initiating_principal_id: None,
                        trigger_event_id: event_id,
                        trigger_sequence: sequence,
                        trigger_kind: (*topic).to_string(),
                        parent_activation_id: None,
                        root_turn_id,
                    },
                    32,
                )
                .await
                .unwrap()
                .unwrap();
            assert_eq!(activation.status, ThreadActivationStatus::Queued);
        }

        let first_three = store
            .list_queued_thread_activations_for_admission(3, 1, 60_000)
            .await
            .unwrap();
        assert_eq!(first_three.len(), 3);
        assert_eq!(
            first_three
                .iter()
                .map(|(_, class)| *class)
                .collect::<Vec<_>>(),
            fixtures[..3]
                .iter()
                .map(|fixture| fixture.4)
                .collect::<Vec<_>>()
        );

        store.pool.close().await;
        drop(store);
        let restarted = SqliteStore::new(path).await.unwrap();
        let rebuilt = restarted
            .list_queued_thread_activations_for_admission(16, 4, 60_000)
            .await
            .unwrap();
        assert_eq!(rebuilt.len(), fixtures.len());
        assert_eq!(
            rebuilt.iter().map(|(_, class)| *class).collect::<Vec<_>>(),
            fixtures.iter().map(|fixture| fixture.4).collect::<Vec<_>>()
        );

        let old = (Utc::now() - chrono::Duration::minutes(5))
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        sqlx::query(
            "UPDATE thread_activations SET created_at = ?, updated_at = ? WHERE id = 'admission-activation-maintenance'",
        )
        .bind(&old)
        .bind(&old)
        .execute(&restarted.pool)
        .await
        .unwrap();
        let aged = restarted
            .list_queued_thread_activations_for_admission(1, 0, 30_000)
            .await
            .unwrap();
        assert_eq!(aged.len(), 1);
        assert_eq!(aged[0].1, crate::admission::AdmissionClass::Maintenance);
        assert_eq!(aged[0].0.id, "admission-activation-maintenance");

        let much_older = (Utc::now() - chrono::Duration::minutes(10))
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        for index in 0..8 {
            let event_id = format!("aged-general-event-{index}");
            restarted
                .append(Event::new(
                    event_id.clone(),
                    "fixture".to_string(),
                    crate::event::TYPE_TOOL_OUTPUT.to_string(),
                    "chat/tool_output".to_string(),
                    serde_json::Map::from_iter([
                        (
                            "context_id".to_string(),
                            serde_json::json!("admission-context"),
                        ),
                        (
                            "session_id".to_string(),
                            serde_json::json!("admission-session"),
                        ),
                    ]),
                ))
                .await
                .unwrap();
            let sequence = restarted
                .query(QueryFilter {
                    event_id: Some(event_id.clone()),
                    ..Default::default()
                })
                .await
                .unwrap()[0]
                .sequence
                .unwrap();
            sqlx::query(
                r#"INSERT INTO thread_activations
                   (id, revision, agent_id, context_id, session_id,
                    trigger_event_id, trigger_sequence, trigger_kind,
                    root_turn_id, status, created_at, updated_at)
                   VALUES (?, 1, 'admission-agent', 'admission-context',
                           'admission-session', ?, ?, 'chat/tool_output', ?,
                           'queued', ?, ?)"#,
            )
            .bind(format!("aged-general-activation-{index}"))
            .bind(event_id)
            .bind(i64::try_from(sequence).unwrap())
            .bind(format!("aged-general-root-{index}"))
            .bind(&much_older)
            .bind(&much_older)
            .execute(&restarted.pool)
            .await
            .unwrap();
        }
        let reserved_window = restarted
            .list_queued_thread_activations_for_admission(3, 1, 30_000)
            .await
            .unwrap();
        assert_eq!(reserved_window.len(), 3);
        assert!(reserved_window
            .iter()
            .any(|(activation, _)| activation.id == "admission-activation-interactive"));
        assert!(
            reserved_window
                .iter()
                .filter(|(_, class)| !class.uses_reserved_lane())
                .count()
                <= 2,
            "aged general rows must not consume the declared reserved queue seat"
        );

        // A bounded process-local window is not a durable queue bound. Rows
        // outside it stay queued in SQLite and become eligible after the
        // admitted row crosses to Running; no synthetic failed/cancelled state
        // is written for backpressure.
        let controller = crate::activation_admission::ActivationAdmissionController::new(
            crate::activation_admission::ActivationAdmissionLimits {
                total_slots: 1,
                dialogue_delivery_slots: 0,
                max_queued: 1,
                dialogue_delivery_queue_slots: 0,
                aging_promotion_interval_ms: 60_000,
            },
        );
        for (index, (activation, class)) in rebuilt.iter().enumerate() {
            let outcome = controller
                .restore_queued(crate::admission::AdmissionKey::new(
                    activation.id.clone(),
                    activation.agent_id.clone(),
                    activation.context_id.clone(),
                    activation.session_id.clone(),
                    *class,
                    activation.created_at.timestamp_millis(),
                ))
                .unwrap();
            assert_eq!(
                outcome,
                if index == 0 {
                    crate::activation_admission::RestoreQueuedOutcome::Restored
                } else {
                    crate::activation_admission::RestoreQueuedOutcome::DeferredWindowFull
                }
            );
            assert_eq!(
                restarted
                    .get_thread_activation(&activation.id)
                    .await
                    .unwrap()
                    .unwrap()
                    .status,
                ThreadActivationStatus::Queued
            );
        }
        let first = &rebuilt[0].0;
        let running = match restarted
            .update_thread_activation(
                &first.id,
                first.revision,
                ThreadActivationStatus::Running,
                Some("test-runtime"),
                Some(Utc::now() + chrono::Duration::seconds(30)),
                None,
            )
            .await
            .unwrap()
        {
            ThreadActivationMutation::Updated(record) => record,
            other => panic!("unexpected admission mutation: {other:?}"),
        };
        assert_eq!(running.status, ThreadActivationStatus::Running);
        assert!(controller.forget(&first.id));
        let next = restarted
            .list_queued_thread_activations_for_admission(1, 0, 60_000)
            .await
            .unwrap();
        assert_eq!(next.len(), 1);
        assert_ne!(next[0].0.id, first.id);
        assert_eq!(
            controller
                .restore_queued(crate::admission::AdmissionKey::new(
                    next[0].0.id.clone(),
                    next[0].0.agent_id.clone(),
                    next[0].0.context_id.clone(),
                    next[0].0.session_id.clone(),
                    next[0].1,
                    next[0].0.created_at.timestamp_millis(),
                ))
                .unwrap(),
            crate::activation_admission::RestoreQueuedOutcome::Restored
        );
    }

    #[tokio::test]
    async fn thread_signals_are_claimed_in_one_bounded_ordered_activation_batch() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp_file.path().to_str().unwrap())
                .await
                .unwrap(),
        );
        store
            .create_context(NewCognitiveContext {
                id: "signal-context".to_string(),
                agent_id: "signal-agent".to_string(),
                title: "Signal Context".to_string(),
            })
            .await
            .unwrap();
        store
            .create_session(NewSession {
                id: "signal-session".to_string(),
                agent_id: "signal-agent".to_string(),
                context_id: "signal-context".to_string(),
                parent_session_id: None,
                title: "Signal Session".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let thread = store
            .ensure_thread(NewThread {
                id: "signal-thread".to_string(),
                agent_id: "signal-agent".to_string(),
                context_id: "signal-context".to_string(),
                session_id: "signal-session".to_string(),
                initiating_principal_id: None,
                root_turn_id: "signal-root".to_string(),
                kind: ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
            })
            .await
            .unwrap();

        for event_id in ["signal-event-1", "signal-event-2", "signal-event-3"] {
            store
                .append(Event::new(
                    event_id.to_string(),
                    "fixture".to_string(),
                    crate::event::TYPE_TOOL_OUTPUT.to_string(),
                    "chat/tool_output".to_string(),
                    [
                        (
                            "context_id".to_string(),
                            serde_json::json!("signal-context"),
                        ),
                        (
                            "session_id".to_string(),
                            serde_json::json!("signal-session"),
                        ),
                        ("root_turn_id".to_string(), serde_json::json!("signal-root")),
                    ]
                    .into_iter()
                    .collect(),
                ))
                .await
                .unwrap();
        }
        let events = store
            .query(QueryFilter {
                context_id: Some("signal-context".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        let sequence = |event_id: &str| {
            events
                .iter()
                .find(|event| event.id == event_id)
                .and_then(|event| event.sequence)
                .unwrap()
        };
        let signal = |index: usize| NewThreadSignal {
            id: format!("signal-{index}"),
            thread_id: thread.id.clone(),
            event_id: format!("signal-event-{index}"),
            principal_id: None,
            sequence: sequence(&format!("signal-event-{index}")),
            kind: "chat/tool_output".to_string(),
            parent_activation_id: None,
        };
        let activation = |index: usize| NewThreadActivation {
            id: format!("activation-{index}"),
            agent_id: "signal-agent".to_string(),
            context_id: "signal-context".to_string(),
            session_id: "signal-session".to_string(),
            initiating_principal_id: None,
            trigger_event_id: format!("signal-event-{index}"),
            trigger_sequence: sequence(&format!("signal-event-{index}")),
            trigger_kind: "chat/tool_output".to_string(),
            parent_activation_id: None,
            root_turn_id: "signal-root".to_string(),
        };

        let first = store
            .claim_thread_signal_batch(signal(1), activation(1), 32)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            store
                .get_context_cognitive_clock("signal-context")
                .await
                .unwrap()
                .tick,
            1
        );
        assert_eq!(first.trigger_event_id, "signal-event-1");
        let first_signals = store.list_activation_signals(&first.id).await.unwrap();
        assert_eq!(first_signals.len(), 1);
        assert_eq!(first_signals[0].id, "signal-1");
        assert_eq!(first_signals[0].status, ThreadSignalStatus::Claimed);

        assert!(store
            .claim_thread_signal_batch(signal(2), activation(2), 32)
            .await
            .unwrap()
            .is_none());
        assert!(store
            .claim_thread_signal_batch(signal(3), activation(3), 32)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            store
                .list_context_thread_signals("signal-context", Some(ThreadSignalStatus::Pending))
                .await
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            store
                .get_context_cognitive_clock("signal-context")
                .await
                .unwrap()
                .tick,
            1,
            "pending Signals have not crossed the unique Activation claim boundary"
        );

        let completed = store
            .update_thread_activation(
                &first.id,
                first.revision,
                ThreadActivationStatus::Succeeded,
                None,
                None,
                None,
            )
            .await
            .unwrap();
        assert!(matches!(completed, ThreadActivationMutation::Updated(_)));
        assert_eq!(
            store.list_activation_signals(&first.id).await.unwrap()[0].status,
            ThreadSignalStatus::Acknowledged
        );

        let batched = store
            .claim_thread_signal_batch(signal(2), activation(2), 32)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(batched.trigger_event_id, "signal-event-2");
        let claimed = store.list_activation_signals(&batched.id).await.unwrap();
        assert_eq!(
            claimed
                .iter()
                .map(|signal| signal.event_id.as_str())
                .collect::<Vec<_>>(),
            vec!["signal-event-2", "signal-event-3"]
        );
        assert!(claimed
            .iter()
            .all(|signal| signal.status == ThreadSignalStatus::Claimed));
        let clock = store
            .get_context_cognitive_clock("signal-context")
            .await
            .unwrap();
        assert_eq!(clock.tick, 2, "one multi-Signal batch advances one tick");
        assert_eq!(clock.last_signal_batch_id.as_deref(), Some("activation-2"));

        let duplicate = store
            .claim_thread_signal_batch(signal(2), activation(2), 32)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(duplicate.id, "activation-2");
        assert_eq!(
            store
                .get_context_cognitive_clock("signal-context")
                .await
                .unwrap()
                .tick,
            2,
            "duplicate Signal delivery must be idempotent"
        );

        let batched = match store
            .update_thread_activation(
                &batched.id,
                batched.revision,
                ThreadActivationStatus::Succeeded,
                None,
                None,
                None,
            )
            .await
            .unwrap()
        {
            ThreadActivationMutation::Updated(updated) => updated,
            other => panic!("unexpected activation mutation: {other:?}"),
        };
        assert!(batched.status.is_terminal());

        for event_id in ["signal-event-4", "signal-event-5"] {
            store
                .append_with_signal_outbox(Event::new(
                    event_id.to_string(),
                    "fixture".to_string(),
                    crate::event::TYPE_TOOL_OUTPUT.to_string(),
                    "chat/tool_output".to_string(),
                    [
                        (
                            "context_id".to_string(),
                            serde_json::json!("signal-context"),
                        ),
                        (
                            "session_id".to_string(),
                            serde_json::json!("signal-session"),
                        ),
                        ("root_turn_id".to_string(), serde_json::json!("signal-root")),
                    ]
                    .into_iter()
                    .collect(),
                ))
                .await
                .unwrap();
        }
        let later = store
            .query(QueryFilter {
                context_id: Some("signal-context".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        let later_sequence = |event_id: &str| {
            later
                .iter()
                .find(|event| event.id == event_id)
                .and_then(|event| event.sequence)
                .unwrap()
        };
        let sequence_4 = later_sequence("signal-event-4");
        let sequence_5 = later_sequence("signal-event-5");
        let left_store = Arc::clone(&store);
        let right_store = Arc::clone(&store);
        let left = tokio::spawn(async move {
            left_store
                .claim_thread_signal_batch(
                    NewThreadSignal {
                        id: "signal-4".to_string(),
                        thread_id: "signal-thread".to_string(),
                        event_id: "signal-event-4".to_string(),
                        principal_id: None,
                        sequence: sequence_4,
                        kind: "chat/tool_output".to_string(),
                        parent_activation_id: None,
                    },
                    NewThreadActivation {
                        id: "activation-4".to_string(),
                        agent_id: "signal-agent".to_string(),
                        context_id: "signal-context".to_string(),
                        session_id: "signal-session".to_string(),
                        initiating_principal_id: None,
                        trigger_event_id: "signal-event-4".to_string(),
                        trigger_sequence: sequence_4,
                        trigger_kind: "chat/tool_output".to_string(),
                        parent_activation_id: None,
                        root_turn_id: "signal-root".to_string(),
                    },
                    1,
                )
                .await
                .unwrap()
        });
        let right = tokio::spawn(async move {
            right_store
                .claim_thread_signal_batch(
                    NewThreadSignal {
                        id: "signal-5".to_string(),
                        thread_id: "signal-thread".to_string(),
                        event_id: "signal-event-5".to_string(),
                        principal_id: None,
                        sequence: sequence_5,
                        kind: "chat/tool_output".to_string(),
                        parent_activation_id: None,
                    },
                    NewThreadActivation {
                        id: "activation-5".to_string(),
                        agent_id: "signal-agent".to_string(),
                        context_id: "signal-context".to_string(),
                        session_id: "signal-session".to_string(),
                        initiating_principal_id: None,
                        trigger_event_id: "signal-event-5".to_string(),
                        trigger_sequence: sequence_5,
                        trigger_kind: "chat/tool_output".to_string(),
                        parent_activation_id: None,
                        root_turn_id: "signal-root".to_string(),
                    },
                    1,
                )
                .await
                .unwrap()
        });
        let (left, right) = tokio::join!(left, right);
        let claimed_count = [left.unwrap(), right.unwrap()]
            .into_iter()
            .filter(Option::is_some)
            .count();
        assert_eq!(claimed_count, 1, "Thread Activation 必须 single-flight");
        assert_eq!(
            store
                .get_context_cognitive_clock("signal-context")
                .await
                .unwrap()
                .tick,
            3,
            "competing workers may create only one clock-advancing batch"
        );
        assert!(store
            .list_signal_outbox(SignalOutboxStatus::Pending, 16)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .list_signal_outbox(SignalOutboxStatus::Materialized, 16)
                .await
                .unwrap()
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn event_queries_bound_tail_incremental_reads_and_exclusions_in_sql() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let base = Utc::now();
        for (index, topic) in [
            "chat/user_message",
            "chat/context_inspect",
            "chat/tool_output",
            "chat/reply",
        ]
        .into_iter()
        .enumerate()
        {
            let mut event = Event::new(
                format!("bounded-{index}"),
                "fixture".to_string(),
                "fixture".to_string(),
                topic.to_string(),
                [(
                    "session_id".to_string(),
                    serde_json::json!("bounded-session"),
                )]
                .into_iter()
                .collect(),
            );
            event.timestamp = base + chrono::Duration::seconds(index as i64);
            store.append(event).await.unwrap();
        }

        let cognitive = store
            .query(QueryFilter {
                session_id: Some("bounded-session".to_string()),
                topic: Some("chat/*".to_string()),
                excluded_topics: vec!["chat/context_inspect".to_string()],
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(
            cognitive
                .iter()
                .map(|event| event.id.as_str())
                .collect::<Vec<_>>(),
            vec!["bounded-0", "bounded-2", "bounded-3"]
        );

        let tail = store
            .query(QueryFilter {
                session_id: Some("bounded-session".to_string()),
                latest_k: Some(2),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(
            tail.iter()
                .map(|event| event.id.as_str())
                .collect::<Vec<_>>(),
            vec!["bounded-2", "bounded-3"]
        );

        let second_sequence = cognitive[1].sequence.unwrap();
        let incremental = store
            .query(QueryFilter {
                session_id: Some("bounded-session".to_string()),
                after_sequence: Some(second_sequence),
                top_k: Some(1),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(incremental.len(), 1);
        assert_eq!(incremental[0].id, "bounded-3");
    }

    #[tokio::test]
    async fn incomplete_event_schema_is_rejected() {
        let tmp_file = NamedTempFile::new().unwrap();
        let url = format!("sqlite://{}", tmp_file.path().display());
        let incomplete_pool = SqlitePool::connect(&url).await.unwrap();
        sqlx::query(
            "CREATE TABLE events (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, topic TEXT NOT NULL, payload TEXT NOT NULL)",
        )
        .execute(&incomplete_pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO events (id, timestamp, actor, type, topic, payload) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind("incomplete-event")
        .bind(Utc::now().to_rfc3339())
        .bind("fixture")
        .bind("user_message")
        .bind("chat/user_message")
        .bind(r#"{"session_id":"incomplete-session","text":"hello"}"#)
        .execute(&incomplete_pool)
        .await
        .unwrap();
        incomplete_pool.close().await;

        let result = SqliteStore::new(tmp_file.path().to_str().unwrap()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn events_do_not_implicitly_create_session_registry_entries() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        store
            .append(Event::new(
                "routed-event".to_string(),
                "eval".to_string(),
                "tool_output".to_string(),
                "chat/tool_output".to_string(),
                [
                    (
                        "context_id".to_string(),
                        serde_json::json!("shared-context"),
                    ),
                    (
                        "session_id".to_string(),
                        serde_json::json!("mounted-session"),
                    ),
                    ("text".to_string(), serde_json::json!("seed")),
                ]
                .into_iter()
                .collect(),
            ))
            .await
            .unwrap();
        store.pool.close().await;
        drop(store);

        let reopened = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        let session = reopened.get_session("mounted-session").await.unwrap();
        assert!(session.is_none());
    }

    #[tokio::test]
    async fn session_registry_persists_lifecycle_and_message_idempotency() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        store
            .create_context(NewCognitiveContext {
                id: "context-api-1".to_string(),
                agent_id: "agent-main".to_string(),
                title: "共享认知 Context".to_string(),
            })
            .await
            .unwrap();

        let created = store
            .create_session(NewSession {
                id: "session-api-1".to_string(),
                agent_id: "agent-main".to_string(),
                context_id: "context-api-1".to_string(),
                parent_session_id: None,
                title: "第一条会话".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        assert_eq!(created.context_id, "context-api-1");
        assert_eq!(created.status, SessionStatus::Active);

        let event_1 = Event::new(
            "event-1".to_string(),
            "user".to_string(),
            crate::event::TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            vec![
                ("context_id".to_string(), serde_json::json!("context-api-1")),
                ("session_id".to_string(), serde_json::json!("session-api-1")),
                ("text".to_string(), serde_json::json!("first")),
            ]
            .into_iter()
            .collect(),
        );
        let event_2 = Event::new(
            "event-2".to_string(),
            "user".to_string(),
            crate::event::TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            vec![
                ("context_id".to_string(), serde_json::json!("context-api-1")),
                ("session_id".to_string(), serde_json::json!("session-api-1")),
                ("text".to_string(), serde_json::json!("duplicate")),
            ]
            .into_iter()
            .collect(),
        );
        let first = store
            .claim_message("session-api-1", "client-1", &event_1)
            .await
            .unwrap();
        let duplicate = store
            .claim_message("session-api-1", "client-1", &event_2)
            .await
            .unwrap();
        assert_eq!(first, MessageClaim::Accepted);
        assert_eq!(
            duplicate,
            MessageClaim::Existing {
                event_id: "event-1".to_string()
            }
        );
        assert_eq!(
            store
                .query(QueryFilter {
                    session_id: Some("session-api-1".to_string()),
                    ..QueryFilter::default()
                })
                .await
                .unwrap()
                .len(),
            1
        );

        let archived = store
            .update_session(
                "session-api-1",
                SessionUpdate {
                    title: Some("已完成".to_string()),
                    status: Some(SessionStatus::Archived),
                },
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(archived.title, "已完成");
        assert_eq!(archived.status, SessionStatus::Archived);
        assert!(store.list_sessions(false).await.unwrap().is_empty());
        assert_eq!(store.list_sessions(true).await.unwrap().len(), 1);

        drop(store);
        let restarted = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(
            restarted
                .get_session("session-api-1")
                .await
                .unwrap()
                .unwrap()
                .status,
            SessionStatus::Archived
        );
    }

    #[tokio::test]
    async fn archiving_context_atomically_archives_its_sessions_without_deleting_history() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        store
            .create_context(NewCognitiveContext {
                id: "context-archive-1".to_string(),
                agent_id: "agent-main".to_string(),
                title: "可归档 Context".to_string(),
            })
            .await
            .unwrap();
        store
            .create_session(NewSession {
                id: "session-archive-1".to_string(),
                agent_id: "agent-main".to_string(),
                context_id: "context-archive-1".to_string(),
                parent_session_id: None,
                title: "仍有历史的会话".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        store
            .append(Event::new(
                "event-archive-1".to_string(),
                "user".to_string(),
                crate::event::TYPE_USER_MESSAGE.to_string(),
                "chat/user_message".to_string(),
                [
                    (
                        "context_id".to_string(),
                        serde_json::json!("context-archive-1"),
                    ),
                    (
                        "session_id".to_string(),
                        serde_json::json!("session-archive-1"),
                    ),
                    ("text".to_string(), serde_json::json!("保留我")),
                ]
                .into_iter()
                .collect(),
            ))
            .await
            .unwrap();

        let archived = store
            .update_context(
                "context-archive-1",
                ContextUpdate {
                    title: Some("已归档 Context".to_string()),
                    status: Some(SessionStatus::Archived),
                },
            )
            .await
            .unwrap()
            .unwrap();

        assert_eq!(archived.title, "已归档 Context");
        assert_eq!(archived.status, SessionStatus::Archived);
        assert!(store.list_contexts(false).await.unwrap().is_empty());
        assert_eq!(
            store
                .get_session("session-archive-1")
                .await
                .unwrap()
                .unwrap()
                .status,
            SessionStatus::Archived
        );
        assert_eq!(
            store
                .query(QueryFilter {
                    session_id: Some("session-archive-1".to_string()),
                    ..QueryFilter::default()
                })
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn agent_bootstrap_mounts_and_delegations_are_persistent_and_auditable() {
        let tmp_file = NamedTempFile::new().unwrap();
        let db_path = tmp_file.path().to_path_buf();
        let store = SqliteStore::new(db_path.to_str().unwrap()).await.unwrap();

        let bootstrap = store
            .create_agent_bundle(
                NewAgent {
                    id: "agent-lifecycle".to_string(),
                    title: "Lifecycle Agent".to_string(),
                    root_context_id: "context-root".to_string(),
                },
                NewCognitiveContext {
                    id: "context-root".to_string(),
                    agent_id: "agent-lifecycle".to_string(),
                    title: "Root".to_string(),
                },
                NewSession {
                    id: "session-root".to_string(),
                    agent_id: "agent-lifecycle".to_string(),
                    context_id: "context-root".to_string(),
                    parent_session_id: None,
                    title: "Initial".to_string(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        assert_eq!(bootstrap.agent.root_context_id, "context-root");

        let collision = store
            .create_agent_bundle(
                NewAgent {
                    id: "agent-lifecycle".to_string(),
                    title: "Duplicate".to_string(),
                    root_context_id: "context-should-not-exist".to_string(),
                },
                NewCognitiveContext {
                    id: "context-should-not-exist".to_string(),
                    agent_id: "agent-lifecycle".to_string(),
                    title: "Never committed".to_string(),
                },
                NewSession {
                    id: "session-should-not-exist".to_string(),
                    agent_id: "agent-lifecycle".to_string(),
                    context_id: "context-should-not-exist".to_string(),
                    parent_session_id: None,
                    title: "Never committed".to_string(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await;
        assert!(collision.is_err());
        assert!(store
            .get_context("context-should-not-exist")
            .await
            .unwrap()
            .is_none());
        assert!(store
            .get_session("session-should-not-exist")
            .await
            .unwrap()
            .is_none());

        store
            .create_context(NewCognitiveContext {
                id: "context-child".to_string(),
                agent_id: "agent-lifecycle".to_string(),
                title: "Delegated".to_string(),
            })
            .await
            .unwrap();
        store
            .create_session(NewSession {
                id: "session-child".to_string(),
                agent_id: "agent-lifecycle".to_string(),
                context_id: "context-child".to_string(),
                parent_session_id: None,
                title: "Sub Agent".to_string(),
                mount_kind: SessionMountKind::DelegationProjection,
            })
            .await
            .unwrap();
        let delegation = store
            .create_delegation(NewDelegation {
                id: "delegation-1".to_string(),
                agent_id: "agent-lifecycle".to_string(),
                parent_context_id: "context-root".to_string(),
                parent_session_id: "session-root".to_string(),
                child_context_id: "context-child".to_string(),
                child_session_id: "session-child".to_string(),
                initiating_principal_id: Some("principal:delegator".to_string()),
                task: "verify lifecycle".to_string(),
                success_when: Some("done".to_string()),
                context_scope: "current_session".to_string(),
            })
            .await
            .unwrap();
        assert_eq!(delegation.status, DelegationStatus::Queued);
        assert_eq!(
            delegation.initiating_principal_id.as_deref(),
            Some("principal:delegator")
        );
        let misrouted_result = Event::new(
            "misrouted-result-event".to_string(),
            "sub-agent".to_string(),
            crate::event::TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            [
                ("context_id".to_string(), serde_json::json!("context-child")),
                ("session_id".to_string(), serde_json::json!("session-child")),
            ]
            .into_iter()
            .collect(),
        );
        assert!(store
            .commit_delegation_result("delegation-1", &misrouted_result)
            .await
            .is_err());
        assert_eq!(
            store
                .get_delegation("delegation-1")
                .await
                .unwrap()
                .unwrap()
                .status,
            DelegationStatus::Queued
        );
        assert!(store
            .query(QueryFilter {
                event_id: Some(misrouted_result.id),
                ..Default::default()
            })
            .await
            .unwrap()
            .is_empty());
        let result_event = Event::new(
            "result-event".to_string(),
            "sub-agent".to_string(),
            crate::event::TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            [
                ("context_id".to_string(), serde_json::json!("context-root")),
                ("session_id".to_string(), serde_json::json!("session-root")),
                (
                    "delegation_id".to_string(),
                    serde_json::json!("delegation-1"),
                ),
            ]
            .into_iter()
            .collect(),
        );
        assert!(store
            .commit_delegation_result("delegation-1", &result_event)
            .await
            .unwrap());
        assert!(!store
            .commit_delegation_result("delegation-1", &result_event)
            .await
            .unwrap());
        let completed = store.get_delegation("delegation-1").await.unwrap().unwrap();
        assert_eq!(completed.result_event_id.as_deref(), Some("result-event"));
        assert!(store
            .list_signal_outbox(SignalOutboxStatus::Pending, 16)
            .await
            .unwrap()
            .iter()
            .any(|entry| entry.event_id == "result-event"));

        let mounts =
            sqlx::query("SELECT session_id, mount_kind FROM session_mounts ORDER BY session_id")
                .fetch_all(&store.pool)
                .await
                .unwrap()
                .into_iter()
                .map(|row| {
                    (
                        row.get::<String, _>("session_id"),
                        row.get::<String, _>("mount_kind"),
                    )
                })
                .collect::<HashMap<_, _>>();
        assert_eq!(
            mounts.get("session-root").map(String::as_str),
            Some("new_blank_context")
        );
        assert_eq!(
            mounts.get("session-child").map(String::as_str),
            Some("delegation_projection")
        );

        drop(store);
        let restarted = SqliteStore::new(db_path.to_str().unwrap()).await.unwrap();
        assert_eq!(restarted.list_agents(false).await.unwrap().len(), 1);
        assert_eq!(
            restarted
                .get_delegation("delegation-1")
                .await
                .unwrap()
                .unwrap()
                .status,
            DelegationStatus::Completed
        );
    }

    #[tokio::test]
    async fn objective_and_initialization_events_commit_or_rollback_together() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        store
            .create_agent_bundle(
                NewAgent {
                    id: "objective-init-agent".to_string(),
                    title: "Objective Init Agent".to_string(),
                    root_context_id: "objective-init-context".to_string(),
                },
                NewCognitiveContext {
                    id: "objective-init-context".to_string(),
                    agent_id: "objective-init-agent".to_string(),
                    title: "Objective Init Context".to_string(),
                },
                NewSession {
                    id: "objective-init-session".to_string(),
                    agent_id: "objective-init-agent".to_string(),
                    context_id: "objective-init-context".to_string(),
                    parent_session_id: None,
                    title: "Objective Init Session".to_string(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        let objective = |id: &str| NewObjective {
            id: id.to_string(),
            agent_id: "objective-init-agent".to_string(),
            context_id: "objective-init-context".to_string(),
            coordinator_session_id: "objective-init-session".to_string(),
            delivery_session_id: "objective-init-session".to_string(),
            parent_objective_id: None,
            source_event_id: format!("{id}-source"),
            initiating_principal_id: None,
            stated_objective: "prove atomic initialization".to_string(),
            token_budget: None,
        };
        let initialization_event = |id: &str, objective_id: &str| {
            Event::new(
                id.to_string(),
                "runtime".to_string(),
                "harness_binding".to_string(),
                "runtime/harness_binding".to_string(),
                [
                    (
                        "context_id".to_string(),
                        serde_json::json!("objective-init-context"),
                    ),
                    ("objective_id".to_string(), serde_json::json!(objective_id)),
                ]
                .into_iter()
                .collect(),
            )
        };

        store
            .append(initialization_event(
                "conflicting-initialization",
                "other-objective",
            ))
            .await
            .unwrap();
        assert!(store
            .create_objective_with_events(
                objective("objective-init-rollback"),
                vec![initialization_event(
                    "conflicting-initialization",
                    "objective-init-rollback",
                )],
            )
            .await
            .is_err());
        assert!(store
            .get_objective("objective-init-rollback")
            .await
            .unwrap()
            .is_none());

        let event = initialization_event("objective-init-event", "objective-init-success");
        store
            .create_objective_with_events(objective("objective-init-success"), vec![event.clone()])
            .await
            .unwrap();
        assert!(store
            .get_objective("objective-init-success")
            .await
            .unwrap()
            .is_some());
        assert_eq!(
            store
                .query(QueryFilter {
                    event_id: Some(event.id),
                    ..Default::default()
                })
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn objective_claim_and_continuation_outbox_commit_atomically() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        store
            .create_agent_bundle(
                NewAgent {
                    id: "objective-outbox-agent".to_string(),
                    title: "Objective Outbox Agent".to_string(),
                    root_context_id: "objective-outbox-context".to_string(),
                },
                NewCognitiveContext {
                    id: "objective-outbox-context".to_string(),
                    agent_id: "objective-outbox-agent".to_string(),
                    title: "Objective Outbox Context".to_string(),
                },
                NewSession {
                    id: "objective-outbox-session".to_string(),
                    agent_id: "objective-outbox-agent".to_string(),
                    context_id: "objective-outbox-context".to_string(),
                    parent_session_id: None,
                    title: "Objective Outbox Session".to_string(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        store
            .create_objective(NewObjective {
                id: "objective-outbox".to_string(),
                agent_id: "objective-outbox-agent".to_string(),
                context_id: "objective-outbox-context".to_string(),
                coordinator_session_id: "objective-outbox-session".to_string(),
                delivery_session_id: "objective-outbox-session".to_string(),
                parent_objective_id: None,
                source_event_id: "objective-outbox-source".to_string(),
                initiating_principal_id: None,
                stated_objective: "prove atomic continuation".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        let event = |event_id: &str, evaluation_id: &str| {
            Event::new(
                event_id.to_string(),
                "objective-supervisor".to_string(),
                crate::event::TYPE_TOOL_OUTPUT.to_string(),
                "chat/tool_output".to_string(),
                [
                    (
                        "context_id".to_string(),
                        serde_json::json!("objective-outbox-context"),
                    ),
                    (
                        "session_id".to_string(),
                        serde_json::json!("objective-outbox-session"),
                    ),
                    (
                        "objective_id".to_string(),
                        serde_json::json!("objective-outbox"),
                    ),
                    (
                        "objective_evaluation_id".to_string(),
                        serde_json::json!(evaluation_id),
                    ),
                ]
                .into_iter()
                .collect(),
            )
        };
        let continuation = event("objective-continuation-event", "objective-evaluation");
        let claimed = store
            .claim_objective_evaluation_with_signal(
                "objective-outbox",
                1,
                "objective-evaluation",
                Utc::now() + chrono::Duration::minutes(1),
                &continuation,
            )
            .await
            .unwrap();
        assert!(matches!(
            claimed,
            ObjectiveMutation::Updated(ObjectiveRecord { revision: 2, .. })
        ));
        assert_eq!(
            store
                .list_signal_outbox(SignalOutboxStatus::Pending, 16)
                .await
                .unwrap()[0]
                .event_id,
            continuation.id
        );

        let stale = event("stale-objective-continuation", "stale-evaluation");
        assert!(matches!(
            store
                .claim_objective_evaluation_with_signal(
                    "objective-outbox",
                    1,
                    "stale-evaluation",
                    Utc::now() + chrono::Duration::minutes(1),
                    &stale,
                )
                .await
                .unwrap(),
            ObjectiveMutation::Conflict { .. }
        ));
        assert!(store
            .query(QueryFilter {
                event_id: Some(stale.id),
                ..Default::default()
            })
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn objectives_persist_wait_state_and_enforce_revisioned_lifecycle() {
        let tmp_file = NamedTempFile::new().unwrap();
        let db_path = tmp_file.path().to_path_buf();
        let store = SqliteStore::new(db_path.to_str().unwrap()).await.unwrap();
        store
            .create_agent_bundle(
                NewAgent {
                    id: "agent-objective".to_string(),
                    title: "Objective Agent".to_string(),
                    root_context_id: "context-objective".to_string(),
                },
                NewCognitiveContext {
                    id: "context-objective".to_string(),
                    agent_id: "agent-objective".to_string(),
                    title: "Objective Context".to_string(),
                },
                NewSession {
                    id: "session-objective".to_string(),
                    agent_id: "agent-objective".to_string(),
                    context_id: "context-objective".to_string(),
                    parent_session_id: None,
                    title: "Objective Session".to_string(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();

        let created = store
            .create_objective(NewObjective {
                id: "objective-1".to_string(),
                agent_id: "agent-objective".to_string(),
                context_id: "context-objective".to_string(),
                coordinator_session_id: "session-objective".to_string(),
                delivery_session_id: "session-objective".to_string(),
                parent_objective_id: None,
                source_event_id: "user-event-1".to_string(),
                initiating_principal_id: None,
                stated_objective: "完成一项可恢复的长程工作".to_string(),
                token_budget: Some(256_000),
            })
            .await
            .unwrap();
        assert_eq!(created.status, ObjectiveStatus::Active);
        assert_eq!(created.revision, 1);

        let waiting = store
            .update_objective_state(
                "objective-1",
                1,
                ObjectiveStatus::Active,
                Some(ObjectiveWaitCondition::ToolTask {
                    task_id: "task-1".to_string(),
                }),
                Some("等待后台任务完成"),
            )
            .await
            .unwrap();
        let ObjectiveMutation::Updated(waiting) = waiting else {
            panic!("expected an updated Objective");
        };
        assert_eq!(waiting.revision, 2);
        assert_eq!(waiting.status_reason.as_deref(), Some("等待后台任务完成"));
        assert_eq!(
            waiting.wait_condition,
            Some(ObjectiveWaitCondition::ToolTask {
                task_id: "task-1".to_string()
            })
        );

        let stale = store
            .edit_objective("objective-1", 1, "这个写入必须因修订号过期而失败")
            .await
            .unwrap();
        assert!(matches!(
            stale,
            ObjectiveMutation::Conflict {
                current: ObjectiveRecord { revision: 2, .. }
            }
        ));

        let paused = store
            .update_objective_state(
                "objective-1",
                2,
                ObjectiveStatus::Paused,
                None,
                Some("等待使用者决定"),
            )
            .await
            .unwrap();
        let ObjectiveMutation::Updated(paused) = paused else {
            panic!("expected a paused Objective");
        };
        assert_eq!(paused.status, ObjectiveStatus::Paused);
        assert_eq!(paused.status_reason.as_deref(), Some("等待使用者决定"));
        assert!(paused.wait_condition.is_none());
        assert!(store
            .update_objective_state(
                "objective-1",
                3,
                ObjectiveStatus::Completed,
                None,
                Some("不允许从暂停直接完成"),
            )
            .await
            .is_err());

        let resumed = store
            .update_objective_state(
                "objective-1",
                3,
                ObjectiveStatus::Active,
                None,
                Some("使用者要求继续"),
            )
            .await
            .unwrap();
        let ObjectiveMutation::Updated(resumed) = resumed else {
            panic!("expected a resumed Objective");
        };
        assert_eq!(resumed.revision, 4);
        let completed = store
            .update_objective_state(
                "objective-1",
                4,
                ObjectiveStatus::Completed,
                None,
                Some("验收完成"),
            )
            .await
            .unwrap();
        assert!(matches!(
            completed,
            ObjectiveMutation::Updated(ObjectiveRecord {
                status: ObjectiveStatus::Completed,
                revision: 5,
                ..
            })
        ));
        assert!(store
            .update_objective_state(
                "objective-1",
                5,
                ObjectiveStatus::Active,
                None,
                Some("终态不可恢复"),
            )
            .await
            .is_err());
        assert!(store
            .list_context_objectives("context-objective", false)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .list_context_objectives("context-objective", true)
                .await
                .unwrap()
                .len(),
            1
        );

        store
            .create_objective(NewObjective {
                id: "objective-usage".to_string(),
                agent_id: "agent-objective".to_string(),
                context_id: "context-objective".to_string(),
                coordinator_session_id: "session-objective".to_string(),
                delivery_session_id: "session-objective".to_string(),
                parent_objective_id: None,
                source_event_id: "user-event-usage".to_string(),
                initiating_principal_id: None,
                stated_objective: "验证 Evaluation 成本按租约隔离记账".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        let claimed = store
            .claim_objective_evaluation(
                "objective-usage",
                1,
                "evaluation-usage",
                Utc::now() + chrono::Duration::minutes(1),
            )
            .await
            .unwrap();
        assert!(matches!(claimed, ObjectiveMutation::Updated(_)));
        let accounted = store
            .record_objective_evaluation_usage("objective-usage", "evaluation-usage", 123)
            .await
            .unwrap();
        assert!(matches!(
            accounted,
            ObjectiveMutation::Updated(ObjectiveRecord {
                revision: 2,
                tokens_used: 123,
                ..
            })
        ));
        assert!(matches!(
            store
                .record_objective_evaluation_usage("objective-usage", "another-evaluation", 999)
                .await
                .unwrap(),
            ObjectiveMutation::Conflict { .. }
        ));
        let completed_with_lease = store
            .update_objective_state(
                "objective-usage",
                2,
                ObjectiveStatus::Completed,
                None,
                Some("usage 验收完成"),
            )
            .await
            .unwrap();
        assert!(matches!(
            completed_with_lease,
            ObjectiveMutation::Updated(ObjectiveRecord {
                revision: 3,
                tokens_used: 123,
                status: ObjectiveStatus::Completed,
                active_evaluation_id: Some(_),
                ..
            })
        ));
        let finished = store
            .finish_objective_evaluation("objective-usage", "evaluation-usage", 0, 3)
            .await
            .unwrap();
        assert!(matches!(
            finished,
            ObjectiveMutation::Updated(ObjectiveRecord {
                revision: 4,
                tokens_used: 123,
                time_used_seconds: 3,
                status: ObjectiveStatus::Completed,
                active_evaluation_id: None,
                ..
            })
        ));

        store.pool.close().await;
        drop(store);
        let restarted = SqliteStore::new(db_path.to_str().unwrap()).await.unwrap();
        let recovered = restarted
            .get_objective("objective-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(recovered.status, ObjectiveStatus::Completed);
        assert_eq!(recovered.status_reason.as_deref(), Some("验收完成"));
        assert_eq!(recovered.token_budget, Some(256_000));
        assert!(restarted
            .list_recoverable_objectives()
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn mind_projection_commit_is_atomic_and_cas_fenced() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        store
            .create_context(NewCognitiveContext {
                id: "projection-context".to_string(),
                agent_id: "projection-agent".to_string(),
                title: "Projection Context".to_string(),
            })
            .await
            .unwrap();

        let initialized = store
            .initialize_mind_projection(NewMindProjection {
                context_id: "projection-context".to_string(),
                revision: 0,
                state: serde_json::json!({"version": 0, "frames": []}),
                state_hash: "hash-0".to_string(),
                head_event_id: None,
                recall_documents: Vec::new(),
            })
            .await
            .unwrap();
        assert_eq!(initialized.revision, 0);

        let event = Event::new(
            "projection-event-1".to_string(),
            "Agent-Context".to_string(),
            "context_transaction".to_string(),
            "chat/context_tx_committed".to_string(),
            serde_json::json!({"context_id": "projection-context"})
                .as_object()
                .unwrap()
                .clone(),
        );
        let committed = store
            .commit_mind_projection_transaction(
                &event,
                &[],
                &SessionProjectionMutation::default(),
                0,
                NewMindProjection {
                    context_id: "projection-context".to_string(),
                    revision: 1,
                    state: serde_json::json!({"version": 1, "frames": []}),
                    state_hash: "hash-1".to_string(),
                    head_event_id: Some(event.id.clone()),
                    recall_documents: Vec::new(),
                },
            )
            .await
            .unwrap();
        assert!(matches!(
            committed,
            MindProjectionCommit::Committed {
                projection: MindProjectionRecord { revision: 1, .. }
            }
        ));

        let stale_event = Event::new(
            "projection-event-stale".to_string(),
            "Agent-Context".to_string(),
            "context_transaction".to_string(),
            "chat/context_tx_committed".to_string(),
            serde_json::json!({"context_id": "projection-context"})
                .as_object()
                .unwrap()
                .clone(),
        );
        let stale = store
            .commit_mind_projection_transaction(
                &stale_event,
                &[],
                &SessionProjectionMutation::default(),
                0,
                NewMindProjection {
                    context_id: "projection-context".to_string(),
                    revision: 1,
                    state: serde_json::json!({"version": 1, "frames": ["stale"]}),
                    state_hash: "stale-hash".to_string(),
                    head_event_id: Some(stale_event.id.clone()),
                    recall_documents: Vec::new(),
                },
            )
            .await
            .unwrap();
        assert_eq!(
            stale,
            MindProjectionCommit::Conflict {
                current_revision: Some(1)
            }
        );
        let projection = store
            .get_mind_projection("projection-context")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(projection.state_hash, "hash-1");
        let events = store
            .query(QueryFilter {
                context_id: Some("projection-context".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, event.id);
    }

    #[tokio::test]
    async fn session_projection_tracks_append_retire_restore_atomically() {
        let tmp_file = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(tmp_file.path().to_str().unwrap())
            .await
            .unwrap();
        store
            .create_context(NewCognitiveContext {
                id: "session-projection-context".to_string(),
                agent_id: "session-projection-agent".to_string(),
                title: "Session Projection Context".to_string(),
            })
            .await
            .unwrap();
        store
            .initialize_mind_projection(NewMindProjection {
                context_id: "session-projection-context".to_string(),
                revision: 0,
                state: serde_json::json!({"version": 0, "frames": [], "retired": []}),
                state_hash: "session-hash-0".to_string(),
                head_event_id: None,
                recall_documents: Vec::new(),
            })
            .await
            .unwrap();

        let observation = Event::new(
            "session-observation-1".to_string(),
            "User".to_string(),
            crate::event::TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            [
                (
                    "context_id".to_string(),
                    serde_json::json!("session-projection-context"),
                ),
                (
                    "session_id".to_string(),
                    serde_json::json!("session-projection-session"),
                ),
                ("text".to_string(), serde_json::json!("keep me")),
            ]
            .into_iter()
            .collect(),
        );
        let other_observation = Event::new(
            "session-observation-other-context".to_string(),
            "User".to_string(),
            crate::event::TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            [
                (
                    "context_id".to_string(),
                    serde_json::json!("session-projection-other-context"),
                ),
                (
                    "session_id".to_string(),
                    serde_json::json!("session-projection-other-session"),
                ),
                ("text".to_string(), serde_json::json!("other context")),
            ]
            .into_iter()
            .collect(),
        );
        store.append(observation.clone()).await.unwrap();
        store.append(other_observation.clone()).await.unwrap();
        let selected = vec!["session-projection-session".to_string()];
        assert_eq!(
            store
                .query_session_projections("session-projection-context", &selected, true,)
                .await
                .unwrap()
                .len(),
            1
        );

        let retire = Event::new(
            "session-projection-retire".to_string(),
            "Agent-Context".to_string(),
            crate::event::TYPE_CONTEXT_TRANSACTION.to_string(),
            "chat/context_tx_committed".to_string(),
            serde_json::json!({"context_id": "session-projection-context"})
                .as_object()
                .unwrap()
                .clone(),
        );
        store
            .commit_mind_projection_transaction(
                &retire,
                &[],
                &SessionProjectionMutation {
                    retired_event_ids: vec![observation.id.clone(), other_observation.id.clone()],
                    restored_event_ids: vec![],
                },
                0,
                NewMindProjection {
                    context_id: "session-projection-context".to_string(),
                    revision: 1,
                    state: serde_json::json!({"version": 1, "retired": [observation.id]}),
                    state_hash: "session-hash-1".to_string(),
                    head_event_id: Some(retire.id.clone()),
                    recall_documents: Vec::new(),
                },
            )
            .await
            .unwrap();
        assert!(store
            .query_session_projections("session-projection-context", &selected, true)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .query_session_projections(
                    "session-projection-other-context",
                    &["session-projection-other-session".to_string()],
                    true,
                )
                .await
                .unwrap()
                .iter()
                .filter(|event| event.id == other_observation.id)
                .count(),
            1,
            "one Context transaction must not mutate another Context's Projection",
        );

        // Idempotently writing an already committed Ledger Event must not
        // implicitly restore an Observation which the Agent retired later.
        store.append(observation.clone()).await.unwrap();
        assert!(store
            .query_session_projections("session-projection-context", &selected, true)
            .await
            .unwrap()
            .is_empty());

        let restore = Event::new(
            "session-projection-restore".to_string(),
            "Agent-Context".to_string(),
            crate::event::TYPE_CONTEXT_TRANSACTION.to_string(),
            "chat/context_tx_committed".to_string(),
            serde_json::json!({"context_id": "session-projection-context"})
                .as_object()
                .unwrap()
                .clone(),
        );
        store
            .commit_mind_projection_transaction(
                &restore,
                &[],
                &SessionProjectionMutation {
                    retired_event_ids: vec![],
                    restored_event_ids: vec![observation.id.clone()],
                },
                1,
                NewMindProjection {
                    context_id: "session-projection-context".to_string(),
                    revision: 2,
                    state: serde_json::json!({"version": 2, "retired": []}),
                    state_hash: "session-hash-2".to_string(),
                    head_event_id: Some(restore.id.clone()),
                    recall_documents: Vec::new(),
                },
            )
            .await
            .unwrap();
        let restored = store
            .query_session_projections("session-projection-context", &selected, true)
            .await
            .unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].id, observation.id);
    }

    #[tokio::test]
    async fn session_projection_migration_backfills_active_and_preserves_retired() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        let context_id = "session-projection-migration-context";
        let session_id = "session-projection-migration-session";
        let store = SqliteStore::new(path.to_str().unwrap()).await.unwrap();
        store
            .create_context(NewCognitiveContext {
                id: context_id.to_string(),
                agent_id: "session-projection-migration-agent".to_string(),
                title: "Session Projection Migration".to_string(),
            })
            .await
            .unwrap();
        store
            .initialize_mind_projection(NewMindProjection {
                context_id: context_id.to_string(),
                revision: 0,
                state: serde_json::json!({"version": 0, "retired": []}),
                state_hash: "migration-hash-0".to_string(),
                head_event_id: None,
                recall_documents: Vec::new(),
            })
            .await
            .unwrap();
        let observation = |id: &str, text: &str| {
            Event::new(
                id.to_string(),
                "User".to_string(),
                crate::event::TYPE_USER_MESSAGE.to_string(),
                "chat/user_message".to_string(),
                serde_json::json!({
                    "context_id": context_id,
                    "session_id": session_id,
                    "text": text
                })
                .as_object()
                .unwrap()
                .clone(),
            )
        };
        let retired = observation("projection-migration-retired", "retired");
        let active = observation("projection-migration-active", "active");
        store.append(retired.clone()).await.unwrap();
        store.append(active.clone()).await.unwrap();
        let transaction = Event::new(
            "projection-migration-tx".to_string(),
            "Agent-Context".to_string(),
            crate::event::TYPE_CONTEXT_TRANSACTION.to_string(),
            "chat/context_tx_committed".to_string(),
            serde_json::json!({"context_id": context_id})
                .as_object()
                .unwrap()
                .clone(),
        );
        assert!(matches!(
            store
                .commit_mind_projection_transaction(
                    &transaction,
                    &[],
                    &SessionProjectionMutation {
                        retired_event_ids: vec![retired.id.clone()],
                        restored_event_ids: Vec::new(),
                    },
                    0,
                    NewMindProjection {
                        context_id: context_id.to_string(),
                        revision: 1,
                        state: serde_json::json!({"version": 1, "retired": [retired.id.clone()]}),
                        state_hash: "migration-hash-1".to_string(),
                        head_event_id: Some(transaction.id.clone()),
                        recall_documents: Vec::new(),
                    },
                )
                .await
                .unwrap(),
            MindProjectionCommit::Committed { .. }
        ));

        // Simulate a pre-migration database: the immutable Ledger and current
        // Mind Projection exist, while the derived Session Projection does not.
        sqlx::query("DELETE FROM session_projections")
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM schema_migrations WHERE version = ?")
            .bind(SESSION_PROJECTION_MIGRATION)
            .execute(&store.pool)
            .await
            .unwrap();
        store.pool.close().await;

        let reopened = SqliteStore::new(path.to_str().unwrap()).await.unwrap();
        let projected = reopened
            .query_session_projections(context_id, &[session_id.to_string()], true)
            .await
            .unwrap();
        assert!(projected.iter().any(|event| event.id == active.id));
        assert!(projected.iter().all(|event| event.id != retired.id));
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = ?",
            )
            .bind(SESSION_PROJECTION_MIGRATION)
            .fetch_one(&reopened.pool)
            .await
            .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn independent_sqlite_stores_share_leases_and_context_cas() {
        let tmp_file = NamedTempFile::new().unwrap();
        let path = tmp_file.path().to_str().unwrap().to_string();
        let bootstrap = SqliteStore::new(&path).await.unwrap();
        bootstrap
            .create_context(NewCognitiveContext {
                id: "sqlite-shared-context".to_string(),
                agent_id: "sqlite-shared-agent".to_string(),
                title: "SQLite Shared Context".to_string(),
            })
            .await
            .unwrap();
        bootstrap
            .initialize_mind_projection(NewMindProjection {
                context_id: "sqlite-shared-context".to_string(),
                revision: 0,
                state: serde_json::json!({"version": 0}),
                state_hash: "sqlite-shared-0".to_string(),
                head_event_id: None,
                recall_documents: Vec::new(),
            })
            .await
            .unwrap();
        bootstrap.pool.close().await;

        let (first, second) = tokio::join!(SqliteStore::new(&path), SqliteStore::new(&path));
        let first = first.unwrap();
        let second = second.unwrap();
        assert_eq!(
            crate::memory::RuntimeStore::worker_coordination_mode(&first),
            crate::memory::WorkerCoordinationMode::SharedHostLeases
        );

        let event = |id: &str| {
            Event::new(
                id.to_string(),
                "Agent-Context".to_string(),
                crate::event::TYPE_CONTEXT_TRANSACTION.to_string(),
                "chat/context_tx_committed".to_string(),
                serde_json::json!({"context_id": "sqlite-shared-context"})
                    .as_object()
                    .unwrap()
                    .clone(),
            )
        };
        let event_a = event("sqlite-shared-a");
        let event_b = event("sqlite-shared-b");
        let mutation_a = SessionProjectionMutation::default();
        let mutation_b = SessionProjectionMutation::default();
        let (first_result, second_result) = tokio::join!(
            first.commit_mind_projection_transaction(
                &event_a,
                &[],
                &mutation_a,
                0,
                NewMindProjection {
                    context_id: "sqlite-shared-context".to_string(),
                    revision: 1,
                    state: serde_json::json!({"version": 1, "worker": "a"}),
                    state_hash: "sqlite-shared-a".to_string(),
                    head_event_id: Some(event_a.id.clone()),
                    recall_documents: Vec::new(),
                },
            ),
            second.commit_mind_projection_transaction(
                &event_b,
                &[],
                &mutation_b,
                0,
                NewMindProjection {
                    context_id: "sqlite-shared-context".to_string(),
                    revision: 1,
                    state: serde_json::json!({"version": 1, "worker": "b"}),
                    state_hash: "sqlite-shared-b".to_string(),
                    head_event_id: Some(event_b.id.clone()),
                    recall_documents: Vec::new(),
                },
            )
        );
        let results = [first_result.unwrap(), second_result.unwrap()];
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, MindProjectionCommit::Committed { .. }))
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, MindProjectionCommit::Conflict { .. }))
                .count(),
            1
        );
    }
}
