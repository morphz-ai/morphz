# ForgeDepot

Build a complete local, offline-capable Rust package registry and dependency
installer in `/app`. Identify independently executable modules and advance them
in parallel while keeping public contracts, test evidence and current progress
coordinated. Continue until the product is implemented and verified; do not stop
at a design or scaffold.

The final binary must be named `forgedepot` and support:

```text
forgedepot --root ROOT init
forgedepot --root ROOT publish PACKAGE_DIR
forgedepot --root ROOT resolve NAME@REQ --lock LOCK_PATH
forgedepot --root ROOT install --lock LOCK_PATH --dest DEST
forgedepot --root ROOT search QUERY --json
forgedepot --root ROOT yank NAME@VERSION
forgedepot --root ROOT serve --bind HOST:PORT --ready-file PATH
```

Packages contain a `forgedepot.toml` manifest:

```toml
[package]
name = "demo"
version = "1.2.3"

[dependencies]
util = "^1.0"
```

Publishing must create immutable content-addressed blobs under
`ROOT/blobs/sha256/<hash>` and transactional metadata in `ROOT/registry.db`.
Identical repeat publishes are idempotent; different content for the same
name/version is rejected; concurrent publishers cannot leave partial state.

Resolution recursively chooses the highest SemVer satisfying all constraints
and writes deterministic JSON containing `version`, `root`, and a stable-sorted
`packages` list with `name`, `version`, `sha256`, and `dependencies`. Yanked
versions are excluded from new resolutions, while an existing lockfile remains
installable after its version is yanked.

Installation verifies every blob hash before copying package content to
`DEST/<name>/<version>/`; corruption or absence must fail without a false-success
installation. `search --json` performs name-substring search and returns name,
version, yanked and sha256 fields.

The HTTP server must provide `GET /health`, `GET /api/packages?q=...`, and
`GET /api/packages/{name}/{version}`, write its actual bound address to the ready
file, and stop cleanly on SIGTERM/Ctrl-C.

Use clear domain, storage, resolver, CLI and HTTP boundaries; report expected
errors without panic. Include tests for SemVer selection/conflict, publish
idempotency, yank compatibility, corruption detection and deterministic
lockfiles, plus a README with reproducible offline examples. The completed
workspace must pass `cargo test --offline --all-targets` and
`cargo build --offline`.
