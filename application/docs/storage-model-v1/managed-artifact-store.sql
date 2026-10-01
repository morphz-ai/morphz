-- Managed Artifact Store manifest v2. Byte files are outside this DB,
-- under a private content-addressed directory controlled by the Store.

CREATE TABLE store_schema_version (
  version BIGINT PRIMARY KEY CHECK (version > 0),
  schema_sha256 TEXT NOT NULL
);

CREATE TABLE store_identity (
  store_id TEXT PRIMARY KEY,
  root_binding_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Counts unique, committed content-addressed bytes, not per-version copies.
-- Staging and orphan files remain subject to filesystem monitoring.
CREATE TABLE store_usage (
  id BIGINT PRIMARY KEY CHECK (id = 1),
  committed_bytes BIGINT NOT NULL CHECK (committed_bytes >= 0),
  limit_bytes BIGINT CHECK (limit_bytes >= 0)
);

CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  byte_length BIGINT NOT NULL CHECK (byte_length >= 0),
  state TEXT NOT NULL CHECK (state = 'verified'),
  verified_at TEXT NOT NULL
);

-- The full digest is verified before publish; bounded range reads verify only
-- their touched 1 MiB chunks instead of rehashing a large PDF every time.
CREATE TABLE blob_chunks (
  sha256 TEXT NOT NULL,
  ordinal BIGINT NOT NULL CHECK (ordinal >= 0),
  chunk_sha256 TEXT NOT NULL CHECK (length(chunk_sha256) = 64),
  byte_length BIGINT NOT NULL CHECK (byte_length > 0 AND byte_length <= 1048576),
  PRIMARY KEY (sha256, ordinal),
  FOREIGN KEY (sha256) REFERENCES blobs(sha256)
);

CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  owner_tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  head_revision BIGINT NOT NULL CHECK (head_revision > 0),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX artifacts_by_owner ON artifacts(owner_tenant_id, owner_principal_id, deleted_at, artifact_id);

CREATE TABLE artifact_versions (
  artifact_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL,
  byte_length BIGINT NOT NULL CHECK (byte_length >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, revision),
  FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id),
  FOREIGN KEY (sha256) REFERENCES blobs(sha256)
);
CREATE INDEX versions_by_blob ON artifact_versions(sha256, artifact_id, revision);

CREATE TABLE store_command_receipts (
  command_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('put','delete')),
  artifact_id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  FOREIGN KEY (artifact_id, revision) REFERENCES artifact_versions(artifact_id, revision)
);
