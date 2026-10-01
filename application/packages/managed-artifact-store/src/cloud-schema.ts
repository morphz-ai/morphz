// Generated from docs/storage-model-v1/cloud-artifact-store-extension.sql by scripts/generate-storage-schemas.mjs.
import { managedArtifactStoreSchemaSql } from "./schema.js";

export const cloudByteBindingSchemaSql =
  "-- A cloud Store uses the same version/receipt manifest as a managed Store, but\n-- binds it to one immutable object-storage location, not a local byte root.\nCREATE TABLE cloud_byte_binding (\n  id BIGINT PRIMARY KEY CHECK (id = 1),\n  locator_sha256 TEXT NOT NULL CHECK (length(locator_sha256) = 64)\n);\n";
export const cloudArtifactStoreSchemaSql =
  managedArtifactStoreSchemaSql + "\n" + cloudByteBindingSchemaSql;
