-- Proposed Platform migration v1. Run in platform.sqlite (SQLite, FK ON)
-- or in the dedicated platform schema with a platform-only role (PostgreSQL).
-- IDs and timestamps are supplied by the application. No app body or file bytes.

CREATE TABLE tenants (
  tenant_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- One transactionally advanced invalidation token per tenant. Clients use it
-- to avoid re-reading the entire authorized navigation catalog on every
-- Runtime status poll. It contains no object body or membership grant.
-- Navigation lists have independent transactionally advanced revisions.
-- A content revision must not invalidate the complete project/conversation/task
-- lists. access_revision invalidates every protected Client projection.
CREATE TABLE navigation_heads (
  tenant_id TEXT PRIMARY KEY,
  revision BIGINT NOT NULL CHECK (revision >= 0),
  projects_revision BIGINT NOT NULL DEFAULT 0 CHECK (projects_revision >= 0),
  conversations_revision BIGINT NOT NULL DEFAULT 0 CHECK (conversations_revision >= 0),
  tasks_revision BIGINT NOT NULL DEFAULT 0 CHECK (tasks_revision >= 0),
  access_revision BIGINT NOT NULL DEFAULT 0 CHECK (access_revision >= 0),
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
);

CREATE TABLE projects (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('project','desk','inbox','dialogue')),
  owner_principal_id TEXT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 180),
  revision BIGINT NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  deleted_at TEXT,
  PRIMARY KEY (tenant_id, project_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
  CHECK (kind = 'project' OR owner_principal_id IS NOT NULL)
);
CREATE INDEX projects_by_owner ON projects(tenant_id, owner_principal_id, kind);
CREATE UNIQUE INDEX one_personal_space_per_kind ON projects(tenant_id, owner_principal_id, kind)
  WHERE kind IN ('desk','inbox','dialogue');

CREATE TABLE project_members (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  -- Old memberships have no join timestamp; NULL means unknown, not created_at.
  joined_at TEXT,
  PRIMARY KEY (tenant_id, project_id, principal_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, project_id)
);
CREATE INDEX project_members_by_principal ON project_members(tenant_id, principal_id, project_id);

-- Published, project-visible projection of a committed Runtime public Context
-- frame. The frame remains Runtime authority; these immutable versions are
-- neither Cognitive App originals nor entries in the content catalog.
CREATE TABLE project_understanding_versions (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  frame_id TEXT NOT NULL CHECK (length(frame_id) BETWEEN 1 AND 200),
  frame_revision BIGINT NOT NULL CHECK (frame_revision > 0),
  mind_version BIGINT NOT NULL CHECK (mind_version > 0),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 30000),
  sources_json TEXT NOT NULL CHECK (length(sources_json) BETWEEN 2 AND 40000),
  published_by_principal_id TEXT NOT NULL,
  published_by_actant_id TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, project_id, revision),
  UNIQUE (tenant_id, project_id, frame_id, frame_revision),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, project_id)
);

-- Team authentication belongs to the Platform authority, not to one Host's
-- transport cache. Hosts must present the same operator configuration digest;
-- a divergent Host fails closed until its configuration is reloaded.
CREATE TABLE team_identity_config (
  tenant_id TEXT PRIMARY KEY,
  config_sha256 TEXT NOT NULL CHECK (length(config_sha256) = 64),
  revision BIGINT NOT NULL CHECK (revision > 0),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
);
CREATE TABLE team_login_sessions (
  tenant_id TEXT NOT NULL,
  session_hash TEXT NOT NULL CHECK (length(session_hash) = 64),
  csrf TEXT NOT NULL CHECK (length(csrf) = 64),
  principal_id TEXT NOT NULL,
  actant_id TEXT NOT NULL,
  credential_hash TEXT NOT NULL CHECK (length(credential_hash) = 64),
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, session_hash),
  FOREIGN KEY (tenant_id) REFERENCES team_identity_config(tenant_id)
);
CREATE INDEX team_login_sessions_by_expiry
  ON team_login_sessions(tenant_id, expires_at);

-- A durable admission fence exists only while a project retirement is being
-- checked against Runtime. It is not the archived/deleted state, and a failed
-- check removes it without changing the project's revision or visibility.
CREATE TABLE project_retirements (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  target_state TEXT NOT NULL CHECK (target_state IN ('archived','deleted')),
  expected_revision BIGINT NOT NULL CHECK (expected_revision > 0),
  begun_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, project_id),
  UNIQUE (tenant_id, command_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, project_id)
);

-- A user's notification choice and acknowledgements follow that identity
-- across Clients. Notification candidates remain derived from authorized
-- tasks; no task body or Client-local presentation state is copied here.
CREATE TABLE notification_preferences (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('all','off')),
  revision BIGINT NOT NULL CHECK (revision > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, principal_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
);

CREATE TABLE notification_reads (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  notification_id TEXT NOT NULL CHECK (length(notification_id) = 64),
  read_order BIGINT NOT NULL CHECK (read_order > 0),
  PRIMARY KEY (tenant_id, principal_id, notification_id),
  UNIQUE (tenant_id, principal_id, read_order),
  FOREIGN KEY (tenant_id, principal_id)
    REFERENCES notification_preferences(tenant_id, principal_id)
);
CREATE INDEX notification_reads_by_order
  ON notification_reads(tenant_id, principal_id, read_order);

-- BEGIN profile-avatar-v1
-- Presentation bytes only. Names, personality and private address are Runtime
-- ROM authority. Subject IDs are authenticated Human Principals or the actual
-- trusted Runtime Agent ID, never a Client-supplied owner.
CREATE TABLE profile_avatar_heads (
  tenant_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('human','agent')),
  subject_id TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 512),
  revision BIGINT NOT NULL CHECK (revision > 0),
  PRIMARY KEY (tenant_id, subject_kind, subject_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
);
CREATE TABLE profile_avatar_versions (
  tenant_id TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  original_store_id TEXT, original_artifact_id TEXT, original_revision BIGINT,
  original_sha256 TEXT, original_byte_length BIGINT, original_mime TEXT,
  poster_store_id TEXT, poster_artifact_id TEXT, poster_revision BIGINT,
  poster_sha256 TEXT, poster_byte_length BIGINT, poster_mime TEXT,
  width BIGINT, height BIGINT, frames BIGINT, duration_ms BIGINT,
  changed_by_principal_id TEXT NOT NULL, changed_by_actant_id TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, subject_kind, subject_id, revision),
  FOREIGN KEY (tenant_id, subject_kind, subject_id)
    REFERENCES profile_avatar_heads(tenant_id, subject_kind, subject_id),
  CHECK (
    (original_store_id IS NULL AND original_artifact_id IS NULL AND original_revision IS NULL
      AND original_sha256 IS NULL AND original_byte_length IS NULL AND original_mime IS NULL
      AND poster_store_id IS NULL AND poster_artifact_id IS NULL AND poster_revision IS NULL
      AND poster_sha256 IS NULL AND poster_byte_length IS NULL AND poster_mime IS NULL
      AND width IS NULL AND height IS NULL AND frames IS NULL AND duration_ms IS NULL)
    OR
    (original_store_id IS NOT NULL AND original_artifact_id IS NOT NULL
      AND original_revision IS NOT NULL AND original_sha256 IS NOT NULL
      AND original_byte_length IS NOT NULL AND original_mime IS NOT NULL
      AND original_revision > 0 AND length(original_sha256)=64
      AND original_byte_length BETWEEN 1 AND 4194304
      AND original_mime IN ('image/png','image/jpeg','image/gif','image/webp')
      AND poster_store_id IS NOT NULL AND poster_artifact_id IS NOT NULL
      AND poster_revision IS NOT NULL AND poster_sha256 IS NOT NULL
      AND poster_byte_length IS NOT NULL AND poster_mime IS NOT NULL
      AND poster_revision > 0 AND length(poster_sha256)=64
      AND poster_byte_length BETWEEN 1 AND 4194304 AND poster_mime='image/png'
      AND width IS NOT NULL AND height IS NOT NULL AND frames IS NOT NULL AND duration_ms IS NOT NULL
      AND width BETWEEN 1 AND 2048 AND height BETWEEN 1 AND 2048
      AND frames BETWEEN 1 AND 120 AND duration_ms BETWEEN 0 AND 30000)
  )
);
-- END profile-avatar-v1

-- A conversation is a project-scoped navigation/organization record. Runtime
-- alone owns the Session, messages and execution. The default conversation
-- deliberately retains its project's ID for existing input routes.
CREATE TABLE conversations (
  tenant_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('default','named')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 180),
  revision BIGINT NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  PRIMARY KEY (tenant_id, conversation_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, project_id),
  CHECK ((kind = 'default' AND conversation_id = project_id AND archived_at IS NULL)
      OR (kind = 'named' AND conversation_id <> project_id))
);
CREATE INDEX conversations_by_project ON conversations(tenant_id, project_id, archived_at, updated_at DESC, conversation_id);

CREATE TABLE task_order_heads (
  -- One semantic priority order spans the tenant's projects. A project is a
  -- filtered view of that order, not a second conflicting ordering authority.
  tenant_id TEXT PRIMARY KEY,
  revision BIGINT NOT NULL CHECK (revision >= 0),
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
);

CREATE TABLE tasks (
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 180),
  description TEXT NOT NULL DEFAULT '',
  assignee_id TEXT NOT NULL,
  execution TEXT NOT NULL CHECK (execution IN ('planned','active','waiting','completed','cancelled')),
  due_date TEXT,
  order_rank BIGINT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  created_by_principal_id TEXT NOT NULL,
  created_by_actant_id TEXT NOT NULL,
  origin_conversation_id TEXT,
  origin_project_id TEXT,
  source_body TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (tenant_id, task_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, project_id)
);
CREATE INDEX tasks_by_project_order ON tasks(tenant_id, project_id, deleted_at, order_rank, task_id);
CREATE INDEX tasks_by_assignee ON tasks(tenant_id, assignee_id, execution, task_id);

-- Task history is an immutable Platform aggregate, not a content catalog
-- object. The current tasks row is a query projection of its head version;
-- ordering lives outside the version so reordering cannot start execution.
CREATE TABLE task_versions (
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  -- Older versions may predate per-version project provenance.
  project_id TEXT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 180),
  description TEXT NOT NULL,
  assignee_id TEXT NOT NULL,
  model_id TEXT,
  reasoning_effort TEXT,
  legacy_priority TEXT NOT NULL CHECK (legacy_priority IN ('low','normal','high')),
  due_date TEXT,
  assignment TEXT NOT NULL CHECK (assignment IN ('proposed','accepted','declined')),
  execution TEXT NOT NULL CHECK (execution IN ('planned','active','waiting','completed','cancelled')),
  delivery TEXT NOT NULL CHECK (delivery IN ('none','ready','accepted')),
  run_requested BIGINT NOT NULL CHECK (run_requested >= 0),
  not_before TEXT,
  every_seconds BIGINT CHECK (every_seconds IS NULL OR every_seconds BETWEEN 60 AND 31536000),
  author_principal_id TEXT NOT NULL,
  author_actant_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, task_id, revision),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, task_id)
);
CREATE INDEX task_versions_by_task ON task_versions(tenant_id, task_id, revision DESC);

CREATE TABLE task_version_refs (
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  ref_kind TEXT NOT NULL CHECK (ref_kind IN ('result','dependency','watch_source')),
  ordinal BIGINT NOT NULL CHECK (ordinal >= 0),
  ref_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, task_id, revision, ref_kind, ordinal),
  FOREIGN KEY (tenant_id, task_id, revision) REFERENCES task_versions(tenant_id, task_id, revision)
);

CREATE TABLE task_responses (
  tenant_id TEXT NOT NULL,
  response_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_revision BIGINT NOT NULL,
  body TEXT NOT NULL,
  author_principal_id TEXT NOT NULL,
  author_actant_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, response_id),
  FOREIGN KEY (tenant_id, task_id, task_revision)
    REFERENCES task_versions(tenant_id, task_id, revision)
);
CREATE INDEX task_responses_by_task ON task_responses(tenant_id, task_id, created_at, response_id);

-- Platform owns the durable association between a task version and a Runtime
-- execution. Runtime remains the sole authority for Schedule/Thread lifecycle;
-- observed_* columns are a last-known projection, never an execution permit.
-- The immutable request fields permit exact idempotent recovery after a lost
-- acknowledgement without reconstructing intent from a later task version.
CREATE TABLE task_run_links (
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_number BIGINT NOT NULL CHECK (run_number > 0),
  task_revision BIGINT NOT NULL CHECK (task_revision > 0),
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  runtime_session_id TEXT NOT NULL,
  runtime_schedule_id TEXT NOT NULL,
  runtime_thread_id TEXT NOT NULL,
  request_intent TEXT NOT NULL,
  request_model_alias TEXT,
  request_reasoning_effort TEXT,
  request_not_before TEXT NOT NULL,
  request_interval_seconds BIGINT CHECK (request_interval_seconds IS NULL OR request_interval_seconds > 0),
  observed_schedule_revision BIGINT NOT NULL CHECK (observed_schedule_revision > 0),
  observed_schedule_status TEXT NOT NULL CHECK (observed_schedule_status IN ('queued','paused','dispatched','completed','cancelled')),
  observed_schedule_not_before TEXT,
  observed_schedule_interval_seconds BIGINT CHECK (observed_schedule_interval_seconds IS NULL OR observed_schedule_interval_seconds > 0),
  observed_thread_status TEXT CHECK (observed_thread_status IN ('open','completed','failed','cancelled')),
  source_signature TEXT NOT NULL,
  bridge_paused BIGINT NOT NULL CHECK (bridge_paused IN (0,1)),
  bridge_source_stopped BIGINT NOT NULL CHECK (bridge_source_stopped IN (0,1)),
  bridge_stop_requested BIGINT NOT NULL CHECK (bridge_stop_requested IN (0,1)),
  bridge_control_revision BIGINT NOT NULL CHECK (bridge_control_revision > 0),
  bridge_control_pending TEXT CHECK (bridge_control_pending IN ('pause','resume','cancel')),
  bridge_error TEXT NOT NULL,
  PRIMARY KEY (tenant_id, task_id, run_number),
  UNIQUE (tenant_id, sequence),
  UNIQUE (tenant_id, runtime_schedule_id),
  UNIQUE (tenant_id, runtime_thread_id),
  FOREIGN KEY (tenant_id, task_id, task_revision)
    REFERENCES task_versions(tenant_id, task_id, revision)
);
CREATE INDEX task_run_links_by_task ON task_run_links(tenant_id, task_id, run_number DESC);

-- Ordered references are part of the admitted request or source-watch
-- bridge, not foreign keys into Runtime's independent database.
CREATE TABLE task_run_dependencies (
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_number BIGINT NOT NULL,
  ordinal BIGINT NOT NULL CHECK (ordinal >= 0),
  runtime_thread_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, task_id, run_number, ordinal),
  FOREIGN KEY (tenant_id, task_id, run_number)
    REFERENCES task_run_links(tenant_id, task_id, run_number)
);
CREATE TABLE task_run_watch_sources (
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_number BIGINT NOT NULL,
  ordinal BIGINT NOT NULL CHECK (ordinal >= 0),
  source_object_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, task_id, run_number, ordinal),
  FOREIGN KEY (tenant_id, task_id, run_number)
    REFERENCES task_run_links(tenant_id, task_id, run_number)
);
CREATE TABLE task_run_source_events (
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_number BIGINT NOT NULL,
  ordinal BIGINT NOT NULL CHECK (ordinal >= 0),
  command_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, task_id, run_number, ordinal),
  FOREIGN KEY (tenant_id, task_id, run_number)
    REFERENCES task_run_links(tenant_id, task_id, run_number)
);

-- An admission error can exist before any Runtime Schedule was accepted.
CREATE TABLE task_execution_issues (
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  message TEXT NOT NULL,
  PRIMARY KEY (tenant_id, task_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, task_id)
);

CREATE TABLE app_installations (
  tenant_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','disabled','unavailable')),
  installed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, app_id),
  UNIQUE (tenant_id, installation_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
);

-- Installation of executable UI code is Platform state, not an App's private
-- professional data. The immutable package body is held by a configured
-- object Store; this relation contains only a bounded header and exact ref.
CREATE TABLE app_ui_packages (
  tenant_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  package_version TEXT NOT NULL,
  installed_by_principal_id TEXT NOT NULL,
  manifest_header TEXT NOT NULL CHECK (length(manifest_header) BETWEEN 2 AND 200000),
  store_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_revision BIGINT NOT NULL CHECK (artifact_revision > 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  byte_length BIGINT NOT NULL CHECK (byte_length BETWEEN 1 AND 1000000),
  installed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, app_id, package_version),
  UNIQUE (tenant_id, store_id, artifact_id, artifact_revision),
  FOREIGN KEY (tenant_id, app_id) REFERENCES app_installations(tenant_id, app_id)
);
CREATE INDEX app_ui_packages_by_installer
  ON app_ui_packages(tenant_id, installed_by_principal_id, installed_at DESC, app_id);

-- An app type may have multiple independent data authorities: one SaaS
-- connection and/or several Node-routed instances. Routing never declares
-- where an App keeps its professional data. route_ref may change.
CREATE TABLE app_instances (
  tenant_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  route_kind TEXT NOT NULL CHECK (route_kind IN ('service','node')),
  node_id TEXT,
  route_ref TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL CHECK (state IN ('active','unavailable','disabled')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, instance_id),
  UNIQUE (tenant_id, app_id, instance_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES app_installations(tenant_id, app_id),
  CHECK ((route_kind = 'node' AND node_id IS NOT NULL)
      OR (route_kind = 'service' AND node_id IS NULL))
);
CREATE INDEX app_instances_by_node ON app_instances(tenant_id, node_id, state, instance_id);

-- A personal, project-scoped UI window is not an App service instance.
-- It contains only bounded presentation state; App originals and Runtime
-- execution never move into this relation. The active tab stays on the Client.
CREATE TABLE app_view_instances (
  tenant_id TEXT NOT NULL,
  view_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  package_version TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (length(state_json) BETWEEN 2 AND 65536),
  revision BIGINT NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('open','closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, view_id),
  UNIQUE (tenant_id, owner_principal_id, project_id, app_id, package_version),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, project_id)
);
CREATE INDEX app_view_instances_by_owner
  ON app_view_instances(tenant_id, owner_principal_id, status, created_at, view_id);

-- One catalog row points to one app-owned original. The observed version is
-- a projection; only the app can certify an exact version or edit its body.
CREATE TABLE content_entries (
  tenant_id TEXT NOT NULL,
  content_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  app_object_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 180),
  observed_version_ref TEXT,
  observed_at TEXT,
  availability TEXT NOT NULL CHECK (availability IN ('available','unverified','unavailable','deleted')),
  revision BIGINT NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (tenant_id, content_id),
  UNIQUE (tenant_id, instance_id, app_object_id),
  FOREIGN KEY (tenant_id, app_id, instance_id) REFERENCES app_instances(tenant_id, app_id, instance_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, project_id)
);
CREATE INDEX content_by_project ON content_entries(tenant_id, project_id, deleted_at, updated_at DESC, content_id);
CREATE INDEX content_by_app ON content_entries(tenant_id, app_id, updated_at DESC, content_id);
CREATE INDEX content_by_app_object ON content_entries(tenant_id, app_id, app_object_id, deleted_at, content_id);

-- A work relation can connect a task to a catalog original (for example,
-- task produces document), two tasks, or two originals. Exactly one typed ID
-- is present at each end, retaining ordinary foreign keys on both backends.
CREATE TABLE work_relations (
  tenant_id TEXT NOT NULL,
  relation_id TEXT NOT NULL,
  source_task_id TEXT,
  source_content_id TEXT,
  source_version_ref TEXT,
  target_task_id TEXT,
  target_content_id TEXT,
  target_version_ref TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('references','uses','produces')),
  created_by_principal_id TEXT NOT NULL,
  created_by_actant_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, relation_id),
  FOREIGN KEY (tenant_id, source_task_id) REFERENCES tasks(tenant_id, task_id),
  FOREIGN KEY (tenant_id, source_content_id) REFERENCES content_entries(tenant_id, content_id),
  FOREIGN KEY (tenant_id, target_task_id) REFERENCES tasks(tenant_id, task_id),
  FOREIGN KEY (tenant_id, target_content_id) REFERENCES content_entries(tenant_id, content_id),
  CHECK ((source_task_id IS NOT NULL AND source_content_id IS NULL)
      OR (source_task_id IS NULL AND source_content_id IS NOT NULL)),
  CHECK ((target_task_id IS NOT NULL AND target_content_id IS NULL)
      OR (target_task_id IS NULL AND target_content_id IS NOT NULL))
);
CREATE INDEX relations_by_source_task ON work_relations(tenant_id, source_task_id, relation_id);
CREATE INDEX relations_by_source_content ON work_relations(tenant_id, source_content_id, relation_id);
CREATE INDEX relations_by_target_task ON work_relations(tenant_id, target_task_id, relation_id);
CREATE INDEX relations_by_target_content ON work_relations(tenant_id, target_content_id, relation_id);

CREATE TABLE command_receipts (
  tenant_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  actor_actant_id TEXT NOT NULL,
  runtime_input_id TEXT,
  operation TEXT NOT NULL,
  result_ref TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, command_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
);
CREATE INDEX receipts_by_input ON command_receipts(tenant_id, runtime_input_id, command_id);

CREATE TABLE outbox (
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  aggregate_kind TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_revision BIGINT NOT NULL,
  event_kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  attempts BIGINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  PRIMARY KEY (tenant_id, event_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
);
CREATE INDEX outbox_pending ON outbox(delivered_at, created_at, event_id);

-- BEGIN cognitive-app-v1
-- Only new cognitive bindings use these exact identities. Old installations,
-- UI-only ownership and personal windows retain their original rows and IDs.
CREATE UNIQUE INDEX app_installations_exact_identity
  ON app_installations(tenant_id, app_id, installation_id);
CREATE UNIQUE INDEX app_view_instances_exact_identity
  ON app_view_instances(tenant_id, view_id, owner_principal_id, project_id, app_id, package_version);

CREATE TABLE cognitive_app_versions (
  tenant_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  version TEXT NOT NULL CHECK (length(version) BETWEEN 1 AND 100),
  installation_id TEXT NOT NULL,
  definition_hash TEXT NOT NULL CHECK (length(definition_hash) = 64),
  definition_json TEXT NOT NULL CHECK (length(definition_json) BETWEEN 2 AND 262144),
  installed_by_principal_id TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, app_id, version),
  UNIQUE (tenant_id, app_id, version, definition_hash),
  FOREIGN KEY (tenant_id, app_id, installation_id)
    REFERENCES app_installations(tenant_id, app_id, installation_id)
);

CREATE TABLE cognitive_app_grants (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','disabled')),
  revision BIGINT NOT NULL CHECK (revision > 0),
  consented_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, principal_id, app_id, version),
  FOREIGN KEY (tenant_id, app_id, version)
    REFERENCES cognitive_app_versions(tenant_id, app_id, version)
);
CREATE INDEX cognitive_app_grants_by_principal
  ON cognitive_app_grants(tenant_id, principal_id, state, app_id, version);

-- A stable saving authority is shared by personal connections. It is not a
-- URL or a Host credential alias; replacing the saved data requires a new ID.
CREATE TABLE cognitive_app_authorities (
  tenant_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  service_id TEXT NOT NULL CHECK (length(service_id) BETWEEN 1 AND 200),
  data_authority_id TEXT NOT NULL CHECK (length(data_authority_id) BETWEEN 1 AND 200),
  PRIMARY KEY (tenant_id, app_id, instance_id),
  UNIQUE (tenant_id, app_id, service_id, data_authority_id),
  UNIQUE (tenant_id, app_id, instance_id, service_id, data_authority_id),
  FOREIGN KEY (tenant_id, app_id, instance_id)
    REFERENCES app_instances(tenant_id, app_id, instance_id)
);

CREATE TABLE cognitive_app_connections (
  tenant_id TEXT NOT NULL,
  connection_id TEXT NOT NULL CHECK (length(connection_id) BETWEEN 1 AND 100),
  owner_principal_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  data_authority_id TEXT NOT NULL,
  host_binding_id TEXT NOT NULL CHECK (length(host_binding_id) BETWEEN 1 AND 200),
  state TEXT NOT NULL CHECK (state IN ('active','disabled','unavailable')),
  revision BIGINT NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, connection_id),
  UNIQUE (tenant_id, connection_id, owner_principal_id, app_id, instance_id, service_id, data_authority_id),
  UNIQUE (tenant_id, connection_id, owner_principal_id, app_id, instance_id),
  FOREIGN KEY (tenant_id, app_id, instance_id, service_id, data_authority_id)
    REFERENCES cognitive_app_authorities(tenant_id, app_id, instance_id, service_id, data_authority_id)
);
CREATE INDEX cognitive_app_connections_by_owner
  ON cognitive_app_connections(tenant_id, owner_principal_id, state, app_id, instance_id, connection_id);

CREATE TABLE cognitive_app_view_bindings (
  tenant_id TEXT NOT NULL,
  view_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  version TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, view_id),
  FOREIGN KEY (tenant_id, view_id, owner_principal_id, project_id, app_id, version)
    REFERENCES app_view_instances(tenant_id, view_id, owner_principal_id, project_id, app_id, package_version),
  FOREIGN KEY (tenant_id, app_id, version)
    REFERENCES cognitive_app_versions(tenant_id, app_id, version),
  FOREIGN KEY (tenant_id, owner_principal_id, app_id, version)
    REFERENCES cognitive_app_grants(tenant_id, principal_id, app_id, version),
  FOREIGN KEY (tenant_id, connection_id, owner_principal_id, app_id, instance_id)
    REFERENCES cognitive_app_connections(tenant_id, connection_id, owner_principal_id, app_id, instance_id)
);

-- This is a side-effect admission ledger, not command_receipts or a business
-- request/result archive. JSON byte/shape budgets are also checked by Host.
-- Mutable grant/connection revisions are snapshots, never foreign keys to
-- current revisions: revocation cannot erase already admitted provenance.
CREATE TABLE cognitive_app_commands (
  tenant_id TEXT NOT NULL,
  command_id TEXT NOT NULL CHECK (length(command_id) BETWEEN 1 AND 100),
  app_id TEXT NOT NULL,
  version TEXT NOT NULL,
  definition_hash TEXT NOT NULL CHECK (length(definition_hash) = 64),
  instance_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  data_authority_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connection_revision BIGINT NOT NULL CHECK (connection_revision > 0),
  grant_principal_id TEXT NOT NULL,
  grant_revision BIGINT NOT NULL CHECK (grant_revision > 0),
  project_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 200),
  operation_scope TEXT NOT NULL CHECK (operation_scope IN ('project','objects')),
  effect TEXT NOT NULL CHECK (effect IN ('write','execute')),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human','agent')),
  actor_principal_id TEXT NOT NULL,
  actor_actant_id TEXT NOT NULL,
  initiating_human_actant_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('human','input','task-run')),
  runtime_input_id TEXT,
  runtime_session_id TEXT,
  runtime_schedule_id TEXT,
  runtime_task_run_event_id TEXT,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  resources_json TEXT NOT NULL CHECK (length(resources_json) BETWEEN 2 AND 32768),
  revision BIGINT NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL CHECK (state IN ('admitted','dispatching','unknown','committed','rejected','cancelled')),
  receipt_ref TEXT CHECK (receipt_ref IS NULL OR length(receipt_ref) BETWEEN 1 AND 200),
  receipt_hash TEXT CHECK (receipt_hash IS NULL OR length(receipt_hash) = 64),
  receipt_summary_json TEXT CHECK (receipt_summary_json IS NULL OR length(receipt_summary_json) BETWEEN 2 AND 65536),
  committed_at TEXT,
  projection_state TEXT NOT NULL CHECK (projection_state IN ('none','pending','projected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, command_id),
  FOREIGN KEY (tenant_id, app_id, version, definition_hash)
    REFERENCES cognitive_app_versions(tenant_id, app_id, version, definition_hash),
  FOREIGN KEY (tenant_id, grant_principal_id, app_id, version)
    REFERENCES cognitive_app_grants(tenant_id, principal_id, app_id, version),
  FOREIGN KEY (tenant_id, connection_id, actor_principal_id, app_id, instance_id, service_id, data_authority_id)
    REFERENCES cognitive_app_connections(tenant_id, connection_id, owner_principal_id, app_id, instance_id, service_id, data_authority_id),
  FOREIGN KEY (tenant_id, app_id, instance_id, service_id, data_authority_id)
    REFERENCES cognitive_app_authorities(tenant_id, app_id, instance_id, service_id, data_authority_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, project_id),
  CHECK (actor_principal_id = grant_principal_id),
  CHECK (
    (actor_kind = 'human' AND source_kind = 'human'
      AND actor_actant_id = initiating_human_actant_id
      AND runtime_input_id IS NULL AND runtime_session_id IS NULL
      AND runtime_schedule_id IS NULL AND runtime_task_run_event_id IS NULL)
    OR (actor_kind = 'agent' AND source_kind = 'input'
      AND runtime_input_id IS NOT NULL AND runtime_session_id IS NULL
      AND runtime_schedule_id IS NULL AND runtime_task_run_event_id IS NULL)
    OR (actor_kind = 'agent' AND source_kind = 'task-run'
      AND runtime_session_id IS NOT NULL AND runtime_schedule_id IS NOT NULL
      AND runtime_task_run_event_id IS NOT NULL)
  ),
  CHECK (
    (state = 'committed' AND receipt_ref IS NOT NULL AND receipt_hash IS NOT NULL
      AND committed_at IS NOT NULL AND receipt_summary_json IS NOT NULL)
    OR (state = 'rejected' AND receipt_ref IS NOT NULL AND receipt_hash IS NOT NULL
      AND committed_at IS NULL AND receipt_summary_json IS NULL AND projection_state = 'none')
    OR (state IN ('admitted','dispatching','unknown','cancelled')
      AND receipt_ref IS NULL AND receipt_hash IS NULL AND committed_at IS NULL
      AND receipt_summary_json IS NULL AND projection_state = 'none')
  )
);
CREATE INDEX cognitive_app_commands_by_project
  ON cognitive_app_commands(tenant_id, project_id, state, command_id);
CREATE INDEX cognitive_app_commands_by_input
  ON cognitive_app_commands(tenant_id, runtime_input_id, command_id);
CREATE INDEX cognitive_app_commands_by_task_run
  ON cognitive_app_commands(tenant_id, runtime_session_id, runtime_schedule_id, runtime_task_run_event_id, command_id);
CREATE INDEX cognitive_app_commands_by_state
  ON cognitive_app_commands(tenant_id, state, updated_at, command_id);
-- END cognitive-app-v1
