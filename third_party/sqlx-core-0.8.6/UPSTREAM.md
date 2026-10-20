# SQLx core dependency backport

- Upstream: https://github.com/launchbadge/sqlx
- Published crate: `sqlx-core` 0.8.6, from crates.io.
- Upstream commit: `bab1b022bd56a64f9a08b46b36b97c5cff19d77e` (`sqlx-core/`).
- Original crate archive SHA-256:
  `ee6798b1838b6a0f69c007c133b8df5866302197e404e8b6ee8ed3e3a5e68dc6`.
- Licenses: MIT OR Apache-2.0; both upstream license files are preserved.

## Local change

The optional `webpki-roots` dependency requirement in `Cargo.toml` and
`Cargo.toml.orig` changes from `0.26` to `1.0.10`.

Three `query_statement` return types in `query.rs`, `query_as.rs`, and
`query_scalar.rs` spell their already constrained argument lifetime as
`'q` instead of `'_`. This resolves Rust 1.97.1's
`mismatched_lifetime_syntaxes` warning for the local dependency without
suppressing the warning gate. No query, storage, driver, or TLS verification
logic is changed.

The upstream 0.26.11 roots crate only re-exports the 1.x `TLS_SERVER_ROOTS`
constant. Selecting 1.x directly removes the obsolete compatibility wrapper
and requires the trust-store update for RUSTSEC-2026-0381. The workspace lock
also selects the patched rustls-webpki verifier for RUSTSEC-2026-0382.

This narrow dependency backport avoids introducing SQLx 0.9's unrelated query
API and driver changes during a security update. Remove it after upgrading to
an upstream SQLx release that directly selects the patched 1.x roots.
