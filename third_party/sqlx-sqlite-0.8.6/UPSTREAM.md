# SQLx SQLite dependency security backport

- Upstream: https://github.com/launchbadge/sqlx
- Published crate: `sqlx-sqlite` 0.8.6, from crates.io.
- Upstream commit: `bab1b022bd56a64f9a08b46b36b97c5cff19d77e` (`sqlx-sqlite/`).
- Original crate archive SHA-256:
  `c2d12fe70b2c1b4401038055f90f151b78208de1f9f89a7dbfd41587a10c3eea`.
- Licenses: MIT OR Apache-2.0; both upstream license files are preserved.

## Local change

Only the `libsqlite3-sys` requirement in `Cargo.toml` and `Cargo.toml.orig`
changes from `0.30.1` to `=0.39.1`. Every Rust source file remains byte-identical
to the published archive.

The official 0.39.1 crate supplies SQLite 3.54.1 and fixes the WAL page-size
memory disclosure in RUSTSEC-2026-0459. The ordinary SQLx `sqlite` feature now
selects this one fixed native implementation for every workspace consumer,
including the vector extension. The earlier second hotbundle implementation
is removed. No advisory exception, query API, database format, authorization,
transaction, pool or pagination behavior is added or replaced by this patch.

The workspace's startup version gate and link-level regressions check the
effective native library as well as the dependency graph. This narrow manifest
backport avoids SQLx 0.9's unrelated query API and driver changes. Remove it
after adopting an upstream SQLx release that supports the fixed dependency.
