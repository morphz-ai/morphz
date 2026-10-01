-- Reader schema v4. Reader-owned database/schema only.
-- Source bytes may live in Reader's SaaS store or a permitted Artifact Store;
-- the database never infers location from the Client or Platform project.

CREATE TABLE reader_schema_version (
  version BIGINT PRIMARY KEY CHECK (version > 0),
  schema_sha256 TEXT NOT NULL
);

CREATE TABLE books (
  tenant_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  edition TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL CHECK (format IN ('epub','pdf','docx','doc','rtf','html','markdown','text')),
  head_revision BIGINT NOT NULL CHECK (head_revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (tenant_id, book_id)
);
CREATE INDEX books_by_owner ON books(tenant_id, owner_principal_id, deleted_at, updated_at DESC, book_id);

CREATE TABLE book_revisions (
  tenant_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  storage_kind TEXT NOT NULL CHECK (storage_kind IN ('app_private','artifact_store','external_reference')),
  provider_id TEXT NOT NULL,
  object_ref TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  byte_length BIGINT NOT NULL CHECK (byte_length >= 0),
  parser_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, book_id, revision),
  FOREIGN KEY (tenant_id, book_id) REFERENCES books(tenant_id, book_id)
);

-- A reading surface can annotate a Reader-owned book or an external original
-- such as a Markdown document owned by the Objects app. This binding is not
-- a copied original: its app identity and exact version remain authoritative.
CREATE TABLE reading_sources (
  tenant_id TEXT NOT NULL,
  reading_source_id TEXT NOT NULL,
  source_app_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  source_object_id TEXT NOT NULL,
  source_version_ref TEXT NOT NULL,
  -- The old reader's sourceId may be a shared asset hash. It is a text
  -- locator, not an original-object identity; duplicate imports stay distinct.
  source_locator_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('reader_book','external_object')),
  book_id TEXT,
  book_revision BIGINT,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  edition TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, reading_source_id),
  UNIQUE (tenant_id, source_instance_id, source_object_id, source_version_ref),
  FOREIGN KEY (tenant_id, book_id, book_revision)
    REFERENCES book_revisions(tenant_id, book_id, revision),
  CHECK ((source_kind = 'reader_book' AND book_id IS NOT NULL AND book_revision IS NOT NULL)
      OR (source_kind = 'external_object' AND book_id IS NULL AND book_revision IS NULL))
);
CREATE INDEX reading_sources_by_original ON reading_sources(tenant_id, source_instance_id, source_object_id, source_version_ref);

CREATE TABLE book_sections (
  tenant_id TEXT NOT NULL,
  reading_source_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  ordinal BIGINT NOT NULL CHECK (ordinal >= 0),
  section_kind TEXT NOT NULL CHECK (section_kind IN ('native','ocr')),
  -- Page identity must survive even when the parsed page contains no text chunks.
  page_number BIGINT CHECK (page_number IS NULL OR page_number > 0),
  title TEXT NOT NULL,
  character_count BIGINT NOT NULL CHECK (character_count >= 0),
  source_html TEXT,
  PRIMARY KEY (tenant_id, reading_source_id, section_id),
  UNIQUE (tenant_id, reading_source_id, ordinal),
  FOREIGN KEY (tenant_id, reading_source_id) REFERENCES reading_sources(tenant_id, reading_source_id)
);

-- Parsed text is chunked for bounded page/selection reads. PDF page number
-- is separate from section/offset; do not reinterpret displayed scroll as
-- proof the Human has read or understood a position.
CREATE TABLE book_text_chunks (
  tenant_id TEXT NOT NULL,
  reading_source_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  chunk_index BIGINT NOT NULL CHECK (chunk_index >= 0),
  start_offset BIGINT NOT NULL CHECK (start_offset >= 0),
  end_offset BIGINT NOT NULL CHECK (end_offset > start_offset),
  page_number BIGINT CHECK (page_number IS NULL OR page_number > 0),
  body_text TEXT NOT NULL,
  extraction_kind TEXT NOT NULL CHECK (extraction_kind IN ('native','ocr')),
  PRIMARY KEY (tenant_id, reading_source_id, section_id, chunk_index),
  FOREIGN KEY (tenant_id, reading_source_id, section_id)
    REFERENCES book_sections(tenant_id, reading_source_id, section_id)
);
CREATE INDEX chunks_by_page ON book_text_chunks(tenant_id, reading_source_id, page_number, chunk_index);

CREATE TABLE reading_positions (
  tenant_id TEXT NOT NULL,
  reading_source_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  start_offset BIGINT NOT NULL CHECK (start_offset >= 0),
  end_offset BIGINT NOT NULL CHECK (end_offset >= start_offset),
  font_size BIGINT NOT NULL,
  font_family TEXT NOT NULL,
  theme TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, reading_source_id, principal_id),
  FOREIGN KEY (tenant_id, reading_source_id, section_id)
    REFERENCES book_sections(tenant_id, reading_source_id, section_id)
);

CREATE TABLE reading_marks (
  tenant_id TEXT NOT NULL,
  mark_id TEXT NOT NULL,
  reading_source_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  start_offset BIGINT NOT NULL CHECK (start_offset >= 0),
  end_offset BIGINT NOT NULL CHECK (end_offset >= start_offset),
  quote_text TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bookmark','highlight','note')),
  color TEXT NOT NULL CHECK (color IN ('yellow','green','blue','pink')),
  note_text TEXT NOT NULL DEFAULT '',
  revision BIGINT NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (tenant_id, mark_id),
  FOREIGN KEY (tenant_id, reading_source_id, section_id)
    REFERENCES book_sections(tenant_id, reading_source_id, section_id)
);
CREATE INDEX marks_by_source_user ON reading_marks(tenant_id, reading_source_id, principal_id, deleted_at, created_at, mark_id);
CREATE INDEX marks_history_by_source_user ON reading_marks(tenant_id, reading_source_id, principal_id, created_at, mark_id);
CREATE INDEX marks_by_section_user ON reading_marks(tenant_id, reading_source_id, principal_id, section_id, deleted_at, created_at, mark_id, start_offset, end_offset);

CREATE TABLE ocr_jobs (
  tenant_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  reading_source_id TEXT NOT NULL,
  page_number BIGINT NOT NULL CHECK (page_number > 0),
  engine_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed')),
  result_digest TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, job_id),
  UNIQUE (tenant_id, reading_source_id, page_number, engine_version),
  FOREIGN KEY (tenant_id, reading_source_id) REFERENCES reading_sources(tenant_id, reading_source_id)
);

-- OCR geometry, corrections, engine and lineage form a bounded immutable
-- specialist result. Keep the exact validated result rather than flattening
-- it into the Platform directory or silently discarding earlier corrections.
CREATE TABLE reading_ocr_versions (
  tenant_id TEXT NOT NULL,
  reading_source_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  page_number BIGINT NOT NULL CHECK (page_number > 0),
  result_digest TEXT NOT NULL CHECK (length(result_digest) = 64),
  engine TEXT NOT NULL,
  layout TEXT NOT NULL CHECK (layout IN ('horizontal','columns','vertical')),
  parent_section_id TEXT,
  result_body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, reading_source_id, section_id),
  UNIQUE (tenant_id, reading_source_id, result_digest),
  FOREIGN KEY (tenant_id, reading_source_id, section_id)
    REFERENCES book_sections(tenant_id, reading_source_id, section_id)
);

CREATE TABLE reader_command_receipts (
  tenant_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  operation TEXT NOT NULL,
  result_ref TEXT NOT NULL,
  result_revision BIGINT NOT NULL CHECK (result_revision > 0),
  committed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, command_id)
);

-- App-owned book commits are the only proof accepted by the Platform catalog.
-- The original bytes and parsed chapters commit before this event is projected.
CREATE TABLE reader_book_events (
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  book_id TEXT NOT NULL,
  book_revision BIGINT NOT NULL CHECK (book_revision > 0),
  project_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  actant_id TEXT NOT NULL,
  runtime_input_id TEXT,
  runtime_task_run_event_id TEXT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  projected_at TEXT,
  PRIMARY KEY (tenant_id, event_id),
  UNIQUE (tenant_id, command_id),
  FOREIGN KEY (tenant_id, book_id, book_revision)
    REFERENCES book_revisions(tenant_id, book_id, revision)
);
CREATE INDEX reader_book_events_pending
  ON reader_book_events(tenant_id, projected_at, created_at, event_id);

-- Parsed import cache: immutable provenance/index only, no duplicate book text.
-- Owner and parse options are part of lookup; the source's current permission
-- must still be checked before reading its canonical native sections/chunks.
-- One entry per exact source keeps committed retries bound to their original
-- parser/options after upgrades. It is never a digest-only public read API.
CREATE TABLE reader_import_cache (
  tenant_id TEXT NOT NULL,
  reading_source_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  format TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  options_sha256 TEXT NOT NULL CHECK (length(options_sha256) = 64),
  result_sha256 TEXT NOT NULL CHECK (length(result_sha256) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, reading_source_id),
  FOREIGN KEY (tenant_id, reading_source_id)
    REFERENCES reading_sources(tenant_id, reading_source_id)
);
CREATE INDEX reader_import_cache_lookup ON reader_import_cache(
  tenant_id, principal_id, sha256, format, parser_version, options_sha256,
  created_at DESC, reading_source_id
);
