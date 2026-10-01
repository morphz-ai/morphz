-- Objects is an internal Cognitive App, not a Platform content table.
-- Each immutable version has its own validated payload; no workspace-wide JSON.
-- File bytes remain in the app's declared byte provider, not this relation DB.

CREATE TABLE objects_schema_version (
  version BIGINT PRIMARY KEY CHECK (version > 0),
  schema_sha256 TEXT NOT NULL
);

CREATE TABLE objects (
  tenant_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('document','pdf','publication','image','website','interactive')),
  head_revision BIGINT NOT NULL CHECK (head_revision > 0),
  created_by_principal_id TEXT NOT NULL,
  created_by_actant_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  origin_conversation_id TEXT,
  origin_project_id TEXT,
  source_body TEXT,
  deleted_at TEXT,
  PRIMARY KEY (tenant_id, object_id)
);
CREATE INDEX objects_by_creator ON objects(tenant_id, created_by_principal_id, updated_at, object_id);

CREATE TABLE object_versions (
  tenant_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 180),
  kind TEXT NOT NULL CHECK (kind IN ('document','pdf','publication','image','website','interactive')),
  payload_body TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  historical_project_id TEXT,
  author_principal_id TEXT NOT NULL,
  author_actant_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, object_id, revision),
  FOREIGN KEY (tenant_id, object_id) REFERENCES objects(tenant_id, object_id)
);
CREATE INDEX object_versions_by_object ON object_versions(tenant_id, object_id, revision DESC);

-- Objects owns this exact byte reference; Store owns the manifest and bytes.
-- One immutable Objects version may point at one verified file version.
CREATE TABLE object_version_bytes (
  tenant_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_revision BIGINT NOT NULL CHECK (object_revision > 0),
  store_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_revision BIGINT NOT NULL CHECK (artifact_revision > 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  byte_length BIGINT NOT NULL CHECK (byte_length >= 0),
  mime TEXT NOT NULL,
  PRIMARY KEY (tenant_id, object_id, object_revision),
  FOREIGN KEY (tenant_id, object_id, object_revision)
    REFERENCES object_versions(tenant_id, object_id, revision)
);
CREATE INDEX object_version_bytes_by_store ON object_version_bytes(store_id, artifact_id, artifact_revision);
CREATE INDEX object_version_bytes_by_digest ON object_version_bytes(tenant_id, sha256, store_id, object_id, object_revision);

CREATE TABLE object_annotations (
  tenant_id TEXT NOT NULL,
  annotation_id TEXT NOT NULL,
  collection_ordinal BIGINT NOT NULL CHECK (collection_ordinal >= 0),
  object_id TEXT NOT NULL,
  object_revision BIGINT NOT NULL,
  quote_text TEXT NOT NULL,
  page_number BIGINT,
  body_text TEXT NOT NULL,
  author_principal_id TEXT NOT NULL,
  author_actant_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, annotation_id),
  UNIQUE (tenant_id, collection_ordinal),
  FOREIGN KEY (tenant_id, object_id, object_revision)
    REFERENCES object_versions(tenant_id, object_id, revision)
);
CREATE INDEX object_annotations_by_version ON object_annotations(tenant_id, object_id, object_revision, created_at, annotation_id);
CREATE INDEX object_annotations_by_object_order ON object_annotations(tenant_id, object_id, collection_ordinal);

CREATE TABLE object_command_receipts (
  tenant_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  operation TEXT NOT NULL,
  object_id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, command_id),
  FOREIGN KEY (tenant_id, object_id, revision)
    REFERENCES object_versions(tenant_id, object_id, revision)
);

CREATE TABLE object_outbox (
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_revision BIGINT NOT NULL,
  event_kind TEXT NOT NULL,
  payload_body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  attempts BIGINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  PRIMARY KEY (tenant_id, event_id),
  FOREIGN KEY (tenant_id, object_id, object_revision)
    REFERENCES object_versions(tenant_id, object_id, revision)
);
CREATE INDEX object_outbox_pending ON object_outbox(delivered_at, created_at, event_id);

-- Search is an Objects-owned, disposable projection of eligible current
-- originals. Platform does not copy body text or decide search eligibility.
-- Backend-specific trigram indexes accelerate this table; the exact fields
-- remain here so quoted slices always come from one immutable revision.
CREATE TABLE object_search_documents (
  tenant_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_revision BIGINT NOT NULL CHECK (object_revision > 0),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  title_fold TEXT NOT NULL,
  body_fold TEXT NOT NULL,
  search_fold TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, object_id),
  FOREIGN KEY (tenant_id, object_id, object_revision)
    REFERENCES object_versions(tenant_id, object_id, revision)
);
CREATE INDEX object_search_by_time ON object_search_documents(tenant_id, updated_at DESC, object_id);

-- Interactive tables are an Objects-owned relational original. Version roots,
-- definitions, row states, cells and ordered manifests are immutable. A save
-- reuses unchanged row states; its <=1000 manifest entries are still O(N).
-- Search documents above remain a disposable bounded O(N) text projection.
CREATE TABLE interactive_versions (
  tenant_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_revision BIGINT NOT NULL CHECK (object_revision > 0),
  schema_revision BIGINT NOT NULL CHECK (schema_revision > 0),
  layout TEXT NOT NULL CHECK (layout IN ('table','form','report')),
  description TEXT NOT NULL,
  row_count BIGINT NOT NULL CHECK (row_count BETWEEN 0 AND 1000),
  serialized_units BIGINT NOT NULL CHECK (serialized_units BETWEEN 0 AND 1000000),
  columns_sha256 TEXT NOT NULL CHECK (length(columns_sha256) = 64),
  snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
  PRIMARY KEY (tenant_id, object_id, object_revision),
  FOREIGN KEY (tenant_id, object_id, object_revision)
    REFERENCES object_versions(tenant_id, object_id, revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, object_id, schema_revision)
    REFERENCES object_versions(tenant_id, object_id, revision) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE interactive_columns (
  tenant_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  schema_revision BIGINT NOT NULL CHECK (schema_revision > 0),
  column_id TEXT NOT NULL,
  ordinal BIGINT NOT NULL CHECK (ordinal BETWEEN 0 AND 23),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  value_type TEXT NOT NULL CHECK (value_type IN ('text','number','boolean')),
  required BIGINT NOT NULL CHECK (required IN (0,1)),
  PRIMARY KEY (tenant_id, object_id, schema_revision, column_id),
  UNIQUE (tenant_id, object_id, schema_revision, ordinal),
  FOREIGN KEY (tenant_id, object_id, schema_revision)
    REFERENCES object_versions(tenant_id, object_id, revision) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE interactive_row_versions (
  tenant_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  row_id TEXT NOT NULL,
  row_revision BIGINT NOT NULL CHECK (row_revision > 0),
  schema_revision BIGINT NOT NULL CHECK (schema_revision > 0),
  cells_sha256 TEXT NOT NULL CHECK (length(cells_sha256) = 64),
  serialized_units BIGINT NOT NULL CHECK (serialized_units BETWEEN 0 AND 1000000),
  PRIMARY KEY (tenant_id, object_id, row_id, row_revision),
  FOREIGN KEY (tenant_id, object_id, row_revision)
    REFERENCES object_versions(tenant_id, object_id, revision) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE interactive_cells (
  tenant_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  row_id TEXT NOT NULL,
  row_revision BIGINT NOT NULL CHECK (row_revision > 0),
  column_id TEXT NOT NULL,
  value_kind TEXT NOT NULL CHECK (value_kind IN ('null','text','number','boolean')),
  text_value TEXT,
  number_value DOUBLE PRECISION,
  boolean_value BIGINT,
  search_fold TEXT NOT NULL,
  PRIMARY KEY (tenant_id, object_id, row_id, row_revision, column_id),
  FOREIGN KEY (tenant_id, object_id, row_id, row_revision)
    REFERENCES interactive_row_versions(tenant_id, object_id, row_id, row_revision),
  CHECK ((value_kind='null' AND text_value IS NULL AND number_value IS NULL AND boolean_value IS NULL)
    OR (value_kind='text' AND text_value IS NOT NULL AND number_value IS NULL AND boolean_value IS NULL)
    OR (value_kind='number' AND text_value IS NULL AND number_value IS NOT NULL AND boolean_value IS NULL)
    OR (value_kind='boolean' AND text_value IS NULL AND number_value IS NULL AND boolean_value IS NOT NULL AND boolean_value IN (0,1)))
);

CREATE TABLE interactive_version_rows (
  tenant_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_revision BIGINT NOT NULL CHECK (object_revision > 0),
  row_id TEXT NOT NULL,
  row_revision BIGINT NOT NULL CHECK (row_revision > 0),
  ordinal BIGINT NOT NULL CHECK (ordinal BETWEEN 0 AND 999),
  PRIMARY KEY (tenant_id, object_id, object_revision, row_id),
  UNIQUE (tenant_id, object_id, object_revision, ordinal),
  FOREIGN KEY (tenant_id, object_id, object_revision)
    REFERENCES interactive_versions(tenant_id, object_id, object_revision),
  FOREIGN KEY (tenant_id, object_id, row_id, row_revision)
    REFERENCES interactive_row_versions(tenant_id, object_id, row_id, row_revision)
);
CREATE INDEX interactive_rows_by_order ON interactive_version_rows(tenant_id, object_id, object_revision, ordinal, row_id);
