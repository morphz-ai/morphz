-- Browser owns personal bookmarks. Saving a URL is not content registration,
-- a page fetch, or permission to control the browser.

CREATE TABLE bookmarks (
  tenant_id TEXT NOT NULL,
  bookmark_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 180),
  url TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 4000),
  revision BIGINT NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_principal_id TEXT NOT NULL,
  created_by_actant_id TEXT NOT NULL,
  updated_by_principal_id TEXT NOT NULL,
  updated_by_actant_id TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (tenant_id, bookmark_id)
);
CREATE UNIQUE INDEX bookmarks_active_url ON bookmarks(tenant_id, owner_principal_id, url) WHERE deleted_at IS NULL;
CREATE INDEX bookmarks_by_owner ON bookmarks(tenant_id, owner_principal_id, deleted_at, updated_at DESC, bookmark_id);

CREATE TABLE bookmark_command_receipts (
  tenant_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  owner_principal_id TEXT NOT NULL,
  bookmark_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  operation TEXT NOT NULL CHECK (operation IN ('bookmark-add','bookmark-update','bookmark-remove','bookmark-restore')),
  committed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, command_id),
  FOREIGN KEY (tenant_id, bookmark_id) REFERENCES bookmarks(tenant_id, bookmark_id)
);
CREATE INDEX bookmark_receipts_by_bookmark ON bookmark_command_receipts(tenant_id, bookmark_id, committed_at);
