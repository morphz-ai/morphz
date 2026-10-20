# Candle Core ZIP security patch

Source: the unmodified crates.io `candle-core` 0.10.2 archive.
Archive SHA-256:
`6bd9895436c1ba5dc1037a19935d084b838db066ff4e15ef7dded020b7c12a4a`.
Upstream source and LICENSE are retained. The package-local Cargo.lock is
excluded: the repository workspace Cargo.lock is authoritative.

The normalized Cargo.toml dependency on `zip` changes from 7.2.0 to 9.0.0,
still with default features disabled. The three archive-name reads in npy.rs
and pickle.rs propagate ZIP 9's new fallible name decoding and take owned
names where needed; they do not silently replace invalid names. Tensor,
inference, device and pickle decoding algorithms are unchanged.
Cargo.toml.orig is the original release metadata, not the manifest Cargo consumes.

Reason: RUSTSEC-2026-0367, RUSTSEC-2026-0368 and RUSTSEC-2026-0369 are fixed
in zip 9.0.0. Candle 0.11.0 still selects zip 8.6.0, so upgrading the entire
model stack would not resolve these advisories. Do not add an audit exception.

Remove this patch when a compatible upstream Candle release depends on a
patched zip release. Verify `cargo audit`, executor tensor/model tests and the
PyTorch archive reader before removal.
