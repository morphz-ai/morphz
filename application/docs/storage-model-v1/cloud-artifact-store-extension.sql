-- A cloud Store uses the same version/receipt manifest as a managed Store, but
-- binds it to one immutable object-storage location, not a local byte root.
CREATE TABLE cloud_byte_binding (
  id BIGINT PRIMARY KEY CHECK (id = 1),
  locator_sha256 TEXT NOT NULL CHECK (length(locator_sha256) = 64)
);
