# Third-Party Notices

Morphz depends on and, in limited cases, redistributes third-party software. Each third-party work
remains under its own license; the repository-level Apache-2.0 license does not replace those terms.

## Vendored or derived source

The authoritative license, attribution, and provenance records for vendored or derived source are
stored beside that source:

- `third_party/codex-utils-absolute-path/`
- `third_party/codex-utils-pty/`
- `third_party/morphz-windows-sandbox/`
- `third_party/codex-otel-stub/`

Redistributions must preserve each applicable `LICENSE`, `NOTICE`, and `UPSTREAM.md` file. The Codex
derived components identify their pinned upstream revision in those local records.

## Package dependencies

Rust and JavaScript dependencies are identified by `Cargo.toml`, `Cargo.lock`, `package.json`, and
the applicable package lockfiles. Their names in a manifest do not incorporate their source into
the Morphz copyright license. Binary distributors remain responsible for satisfying the licenses
of the dependency versions they ship.

The release-ready inventories and license texts for dependencies embedded in the Morphz binary are
generated from the locked dependency graphs and committed as:

- [`THIRD_PARTY_LICENSES_RUST.md`](THIRD_PARTY_LICENSES_RUST.md);
- [`dashboard/THIRD_PARTY_LICENSES.md`](dashboard/THIRD_PARTY_LICENSES.md).

Run `python3 scripts/generate-third-party-licenses.py rust` and
`python3 scripts/generate-third-party-licenses.py dashboard` after changing either lockfile. CI
rejects stale inventories. When an upstream package declares a permissive SPDX license but omits a
standalone license file from its package, the generator includes the corresponding canonical text
from `third_party/licenses/`.

The 2026-09-03 lockfile audit found no dependency identified solely as GPL, AGPL, SSPL, or BUSL.
It did identify separately licensed dependencies that require preservation and distribution review:

- Rust includes `option-ext` under MPL-2.0. `r-efi` offers a permissive MIT or Apache-2.0 option in
  addition to LGPL-2.1-or-later;
- Dashboard and website dependency graphs include MPL-2.0 packages;
- the website dependency graph includes platform `libvips` packages identified as
  LGPL-3.0-or-later and Sharp platform packages with combined Apache-2.0, LGPL, and MIT notices.

These findings do not relicense dependencies. Release packaging preserves the generated inventories,
license texts, and applicable vendored-source records. Platform-specific native artifacts still
require review whenever the release contents change. The audit record and limitations are in
[`docs/audits/dependency_license_audit_2026_09_03.md`](docs/audits/dependency_license_audit_2026_09_03.md).

## Other separately licensed material

Research papers, patent materials, website editorial content, model weights, benchmark corpora,
and generated job artifacts may have separate terms. See [LICENSE_SCOPE.md](LICENSE_SCOPE.md).

This index is informational. If it conflicts with a license distributed with a third-party work,
that third-party license controls.
