-- Script Studio's current domain schema. This file belongs to Script Studio,
-- never to Platform. Use script-studio.sqlite or a dedicated PostgreSQL schema.
-- External Platform project/principal/input IDs are checked through APIs,
-- not falsely declared as cross-database foreign keys.

CREATE TABLE script_productions (
  tenant_id TEXT NOT NULL,
  production_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 180),
  mode TEXT NOT NULL CHECK (mode IN ('original','adaptation')),
  audience TEXT NOT NULL DEFAULT '',
  genre TEXT NOT NULL DEFAULT '',
  episode_count BIGINT NOT NULL CHECK (episode_count BETWEEN 1 AND 500),
  episode_seconds BIGINT NOT NULL CHECK (episode_seconds BETWEEN 15 AND 14400),
  style TEXT NOT NULL DEFAULT '',
  constraints_text TEXT NOT NULL DEFAULT '',
  rights_statement TEXT NOT NULL DEFAULT '',
  model_processing_allowed BIGINT NOT NULL CHECK (model_processing_allowed IN (0,1)),
  template_title TEXT NOT NULL,
  template_include_notes BIGINT NOT NULL CHECK (template_include_notes IN (0,1)),
  template_include_continuity BIGINT NOT NULL CHECK (template_include_continuity IN (0,1)),
  template_page_break_episodes BIGINT NOT NULL CHECK (template_page_break_episodes IN (0,1)),
  template_font TEXT NOT NULL,
  template_font_size BIGINT NOT NULL CHECK (template_font_size BETWEEN 9 AND 24),
  template_scene_heading TEXT NOT NULL,
  metadata_revision BIGINT NOT NULL CHECK (metadata_revision > 0),
  -- Monotonic production-level projection version across app-domain writes.
  activity_revision BIGINT NOT NULL CHECK (activity_revision > 0),
  -- Increases on each creative-context change, including change-then-revert.
  creative_epoch BIGINT NOT NULL CHECK (creative_epoch > 0),
  created_by_principal_id TEXT NOT NULL,
  created_by_actant_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (tenant_id, production_id)
);
CREATE INDEX productions_by_owner ON script_productions(tenant_id, owner_principal_id, deleted_at, updated_at DESC, production_id);

CREATE TABLE script_reviewers (
  tenant_id TEXT NOT NULL,
  production_id TEXT NOT NULL,
  ordinal BIGINT NOT NULL CHECK (ordinal >= 0),
  principal_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, production_id, ordinal),
  FOREIGN KEY (tenant_id, production_id) REFERENCES script_productions(tenant_id, production_id)
);

CREATE TABLE script_metadata_versions (
  tenant_id TEXT NOT NULL,
  production_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  collection_ordinal BIGINT NOT NULL CHECK (collection_ordinal >= 0),
  title TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('original','adaptation')),
  audience TEXT NOT NULL,
  genre TEXT NOT NULL,
  episode_count BIGINT NOT NULL,
  episode_seconds BIGINT NOT NULL,
  style TEXT NOT NULL,
  constraints_text TEXT NOT NULL,
  rights_statement TEXT NOT NULL,
  model_processing_allowed BIGINT NOT NULL CHECK (model_processing_allowed IN (0,1)),
  template_title TEXT NOT NULL,
  template_include_notes BIGINT NOT NULL CHECK (template_include_notes IN (0,1)),
  template_include_continuity BIGINT NOT NULL CHECK (template_include_continuity IN (0,1)),
  template_page_break_episodes BIGINT NOT NULL CHECK (template_page_break_episodes IN (0,1)),
  template_font TEXT NOT NULL,
  template_font_size BIGINT NOT NULL,
  template_scene_heading TEXT NOT NULL,
  author_principal_id TEXT NOT NULL,
  author_actant_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, production_id, revision),
  FOREIGN KEY (tenant_id, production_id) REFERENCES script_productions(tenant_id, production_id)
);
CREATE TABLE script_metadata_reviewers (
  tenant_id TEXT NOT NULL,
  production_id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  ordinal BIGINT NOT NULL CHECK (ordinal >= 0),
  principal_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, production_id, revision, ordinal),
  FOREIGN KEY (tenant_id, production_id, revision)
    REFERENCES script_metadata_versions(tenant_id, production_id, revision)
);

CREATE TABLE script_items (
  tenant_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  production_id TEXT NOT NULL,
  collection_ordinal BIGINT NOT NULL CHECK (collection_ordinal >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('source','setting','character','outline','episode','scene')),
  parent_item_id TEXT,
  order_index BIGINT NOT NULL CHECK (order_index >= 0),
  head_revision BIGINT NOT NULL CHECK (head_revision > 0),
  workflow_revision BIGINT NOT NULL CHECK (workflow_revision > 0),
  status TEXT NOT NULL CHECK (status IN ('draft','in-review','approved','locked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, item_id),
  FOREIGN KEY (tenant_id, production_id) REFERENCES script_productions(tenant_id, production_id),
  FOREIGN KEY (tenant_id, parent_item_id) REFERENCES script_items(tenant_id, item_id)
);
CREATE INDEX items_by_production ON script_items(tenant_id, production_id, kind, parent_item_id, order_index, item_id);
CREATE INDEX items_by_parent_created ON script_items(tenant_id, production_id, parent_item_id, collection_ordinal, item_id);

CREATE TABLE script_item_approvals (
  tenant_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  context_revision BIGINT NOT NULL CHECK (context_revision > 0),
  note TEXT NOT NULL,
  author_principal_id TEXT NOT NULL,
  author_actant_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, item_id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES script_items(tenant_id, item_id)
);
CREATE TABLE script_item_events (
  tenant_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  ordinal BIGINT NOT NULL CHECK (ordinal >= 0),
  action TEXT NOT NULL CHECK (action IN ('submit','approve','request-changes','lock','unlock','revise','invalidate')),
  revision BIGINT NOT NULL CHECK (revision > 0),
  note TEXT NOT NULL,
  author_principal_id TEXT NOT NULL,
  author_actant_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, item_id, ordinal),
  FOREIGN KEY (tenant_id, item_id) REFERENCES script_items(tenant_id, item_id)
);

-- A draft is an immutable structured snapshot. It is reused by a candidate
-- and, if adopted, by the committed item version; no giant production JSON.
CREATE TABLE script_drafts (
  tenant_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  production_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 180),
  body_text TEXT NOT NULL,
  parent_item_id TEXT,
  order_index BIGINT NOT NULL CHECK (order_index >= 0),
  basis TEXT NOT NULL CHECK (basis IN ('original','source','adaptation')),
  location_text TEXT NOT NULL DEFAULT '',
  story_time TEXT NOT NULL DEFAULT '',
  audience_knowledge TEXT NOT NULL DEFAULT '',
  character_knowledge TEXT NOT NULL DEFAULT '',
  setup_payoff TEXT NOT NULL DEFAULT '',
  production_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, draft_id),
  FOREIGN KEY (tenant_id, production_id) REFERENCES script_productions(tenant_id, production_id)
);
CREATE INDEX drafts_by_production ON script_drafts(tenant_id, production_id, draft_id);

CREATE TABLE script_draft_sources (
  tenant_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  ordinal BIGINT NOT NULL CHECK (ordinal >= 0),
  source_app_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  source_object_id TEXT NOT NULL,
  source_version_ref TEXT NOT NULL,
  quote_text TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (tenant_id, draft_id, ordinal),
  FOREIGN KEY (tenant_id, draft_id) REFERENCES script_drafts(tenant_id, draft_id)
);
CREATE TABLE script_draft_dependencies (
  tenant_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  ordinal BIGINT NOT NULL CHECK (ordinal >= 0),
  depends_on_item_id TEXT NOT NULL,
  depends_on_revision BIGINT NOT NULL CHECK (depends_on_revision > 0),
  PRIMARY KEY (tenant_id, draft_id, ordinal),
  FOREIGN KEY (tenant_id, draft_id) REFERENCES script_drafts(tenant_id, draft_id),
  FOREIGN KEY (tenant_id, depends_on_item_id) REFERENCES script_items(tenant_id, item_id)
);
CREATE TABLE script_draft_characters (
  tenant_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  ordinal BIGINT NOT NULL CHECK (ordinal >= 0),
  character_item_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, draft_id, ordinal),
  FOREIGN KEY (tenant_id, draft_id) REFERENCES script_drafts(tenant_id, draft_id),
  FOREIGN KEY (tenant_id, character_item_id) REFERENCES script_items(tenant_id, item_id)
);

CREATE TABLE script_item_versions (
  tenant_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  collection_ordinal BIGINT NOT NULL CHECK (collection_ordinal >= 0),
  draft_id TEXT NOT NULL,
  candidate_id TEXT,
  author_principal_id TEXT NOT NULL,
  author_actant_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, item_id, revision),
  FOREIGN KEY (tenant_id, item_id) REFERENCES script_items(tenant_id, item_id),
  FOREIGN KEY (tenant_id, draft_id) REFERENCES script_drafts(tenant_id, draft_id)
);

CREATE TABLE script_candidates (
  tenant_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  production_id TEXT NOT NULL,
  collection_ordinal BIGINT NOT NULL CHECK (collection_ordinal >= 0),
  target_item_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  input_id TEXT NOT NULL,
  base_item_revision BIGINT NOT NULL CHECK (base_item_revision > 0),
  context_revision BIGINT NOT NULL CHECK (context_revision > 0),
  base_creative_epoch BIGINT NOT NULL CHECK (base_creative_epoch > 0),
  candidate_revision BIGINT NOT NULL CHECK (candidate_revision > 0),
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected')),
  explanation TEXT NOT NULL DEFAULT '',
  created_by_principal_id TEXT NOT NULL,
  created_by_actant_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by_principal_id TEXT,
  decided_by_actant_id TEXT,
  PRIMARY KEY (tenant_id, candidate_id),
  FOREIGN KEY (tenant_id, production_id) REFERENCES script_productions(tenant_id, production_id),
  FOREIGN KEY (tenant_id, target_item_id) REFERENCES script_items(tenant_id, item_id),
  FOREIGN KEY (tenant_id, draft_id) REFERENCES script_drafts(tenant_id, draft_id)
);
CREATE INDEX candidates_by_item ON script_candidates(tenant_id, target_item_id, status, created_at DESC, candidate_id);
CREATE INDEX candidates_by_input ON script_candidates(tenant_id, production_id, input_id, created_at, candidate_id);
CREATE TABLE script_candidate_references (
  tenant_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  ordinal BIGINT NOT NULL CHECK (ordinal >= 0),
  item_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  PRIMARY KEY (tenant_id, candidate_id, ordinal),
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES script_candidates(tenant_id, candidate_id)
);

CREATE TABLE script_reviews (
  tenant_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  collection_ordinal BIGINT NOT NULL CHECK (collection_ordinal >= 0),
  item_id TEXT NOT NULL,
  item_revision BIGINT NOT NULL,
  context_revision BIGINT,
  historical_only BIGINT CHECK (historical_only IN (0,1)),
  review_revision BIGINT NOT NULL CHECK (review_revision > 0),
  severity TEXT NOT NULL CHECK (severity IN ('note','warning','blocking')),
  quote_text TEXT NOT NULL,
  body_text TEXT NOT NULL,
  author_principal_id TEXT NOT NULL,
  author_actant_id TEXT NOT NULL,
  input_id TEXT,
  command_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by_principal_id TEXT,
  resolved_by_actant_id TEXT,
  resolution TEXT,
  PRIMARY KEY (tenant_id, review_id),
  FOREIGN KEY (tenant_id, item_id, item_revision) REFERENCES script_item_versions(tenant_id, item_id, revision)
);
CREATE INDEX reviews_by_item ON script_reviews(tenant_id, item_id, item_revision, resolved_at, review_id);
CREATE INDEX reviews_by_input ON script_reviews(tenant_id, input_id, created_at, review_id);

CREATE TABLE script_preparations (
  tenant_id TEXT NOT NULL,
  preparation_id TEXT NOT NULL,
  collection_ordinal BIGINT NOT NULL CHECK (collection_ordinal >= 0),
  production_id TEXT NOT NULL,
  input_id TEXT NOT NULL,
  requested_project_id TEXT NOT NULL,
  target_item_id TEXT NOT NULL,
  base_item_revision BIGINT NOT NULL CHECK (base_item_revision > 0),
  context_revision BIGINT NOT NULL CHECK (context_revision > 0),
  purpose TEXT NOT NULL CHECK (purpose IN ('draft','rewrite','continuity','impact')),
  max_candidates BIGINT NOT NULL CHECK (max_candidates BETWEEN 1 AND 3),
  max_output_characters BIGINT NOT NULL,
  max_review_passes BIGINT NOT NULL CHECK (max_review_passes BETWEEN 0 AND 2),
  created_by_principal_id TEXT NOT NULL,
  created_by_actant_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, preparation_id),
  FOREIGN KEY (tenant_id, production_id) REFERENCES script_productions(tenant_id, production_id)
);
CREATE TABLE script_preparation_references (
  tenant_id TEXT NOT NULL,
  preparation_id TEXT NOT NULL,
  ordinal BIGINT NOT NULL CHECK (ordinal >= 0),
  item_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  PRIMARY KEY (tenant_id, preparation_id, ordinal),
  FOREIGN KEY (tenant_id, preparation_id) REFERENCES script_preparations(tenant_id, preparation_id)
);

CREATE TABLE script_exports (
  tenant_id TEXT NOT NULL,
  export_id TEXT NOT NULL,
  collection_ordinal BIGINT NOT NULL CHECK (collection_ordinal >= 0),
  production_id TEXT NOT NULL,
  context_revision BIGINT NOT NULL CHECK (context_revision > 0),
  format TEXT NOT NULL CHECK (format = 'docx'),
  working_copy BIGINT CHECK (working_copy IN (0,1)),
  template_title TEXT NOT NULL,
  template_include_notes BIGINT NOT NULL CHECK (template_include_notes IN (0,1)),
  template_include_continuity BIGINT NOT NULL CHECK (template_include_continuity IN (0,1)),
  template_page_break_episodes BIGINT NOT NULL CHECK (template_page_break_episodes IN (0,1)),
  template_font TEXT NOT NULL,
  template_font_size BIGINT NOT NULL,
  template_scene_heading TEXT NOT NULL,
  created_by_principal_id TEXT NOT NULL,
  created_by_actant_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, export_id),
  FOREIGN KEY (tenant_id, production_id) REFERENCES script_productions(tenant_id, production_id)
);
CREATE TABLE script_export_items (
  tenant_id TEXT NOT NULL,
  export_id TEXT NOT NULL,
  ordinal BIGINT NOT NULL CHECK (ordinal >= 0),
  item_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  PRIMARY KEY (tenant_id, export_id, ordinal),
  FOREIGN KEY (tenant_id, export_id) REFERENCES script_exports(tenant_id, export_id)
);

CREATE TABLE script_command_receipts (
  tenant_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  input_id TEXT,
  task_run_event_id TEXT CHECK (task_run_event_id IS NULL OR length(task_run_event_id) BETWEEN 1 AND 100),
  operation TEXT NOT NULL,
  result_object_id TEXT NOT NULL,
  result_version_ref TEXT,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, command_id)
);
CREATE INDEX script_receipts_by_input ON script_command_receipts(tenant_id, input_id, committed_at, command_id);

-- Workflow reports are app-owned immutable results, including zero findings.
-- The two typed, bounded Harness checks are one report payload, not a workspace.
CREATE TABLE script_check_reports (
  tenant_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  production_id TEXT NOT NULL,
  input_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('draft','rewrite','continuity','impact')),
  explanation TEXT NOT NULL CHECK (length(explanation) <= 7000),
  checks_json TEXT NOT NULL CHECK (length(checks_json) <= 70000),
  author_principal_id TEXT NOT NULL,
  author_actant_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, command_id),
  FOREIGN KEY (tenant_id, command_id) REFERENCES script_command_receipts(tenant_id, command_id),
  FOREIGN KEY (tenant_id, production_id) REFERENCES script_productions(tenant_id, production_id),
  FOREIGN KEY (tenant_id, input_id) REFERENCES script_preparations(tenant_id, preparation_id)
);
CREATE INDEX script_reports_by_input ON script_check_reports(tenant_id, production_id, input_id, created_at, command_id);

CREATE TABLE script_outbox (
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  production_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  version_ref TEXT NOT NULL,
  -- Command context for initial directory registration, not app-owned
  -- current project membership; Platform alone owns that relation.
  requested_project_id TEXT,
  event_kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  PRIMARY KEY (tenant_id, event_id),
  FOREIGN KEY (tenant_id, production_id) REFERENCES script_productions(tenant_id, production_id)
);
CREATE INDEX script_outbox_pending ON script_outbox(delivered_at, created_at, event_id);

-- Bounded editor reads: stable headers and exact history without full drafts.
CREATE INDEX script_editor_items ON script_items(tenant_id, production_id, collection_ordinal, item_id);
CREATE INDEX script_editor_candidates ON script_candidates(tenant_id, production_id, target_item_id, collection_ordinal, candidate_id);
CREATE INDEX script_editor_candidate_versions ON script_item_versions(tenant_id, item_id, candidate_id, revision);
CREATE INDEX script_editor_reviews ON script_reviews(tenant_id, item_id, collection_ordinal, review_id);
CREATE INDEX script_editor_exports ON script_exports(tenant_id, production_id, collection_ordinal, export_id);
