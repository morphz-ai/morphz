# Morphz Dependency License Audit — 2026-09-03

> Scope: current Cargo metadata and JavaScript lockfiles
>
> Outcome: no GPL-, AGPL-, SSPL-, or BUSL-only dependency identified; release packaging review is
> still required

## 1. Purpose

This audit records a reproducible first pass over declared dependency-license metadata before the
initial public source release. It is an inventory check, not a legal opinion or proof that every
source file and binary combination satisfies every license.

## 2. Inputs and method

- Rust: `cargo metadata --format-version 1`, including resolved dependencies from `Cargo.lock`;
- Dashboard: every package entry in `dashboard/package-lock.json`;
- Website: every package entry in `website/package-lock.json`;
- vendored source: local `LICENSE`, `NOTICE`, `UPSTREAM.md`, manifest metadata, and README records
  under `third_party/`.

The review selected missing license fields and identifiers containing GPL, AGPL, LGPL, SSPL, BUSL,
MPL, or CDDL for manual attention. Package metadata can be incomplete or inaccurate, so source
license files remain authoritative.

## 3. Results

### Rust

- no resolved package reported a missing license expression;
- `option-ext` reports MPL-2.0;
- `r-efi` reports `MIT OR Apache-2.0 OR LGPL-2.1-or-later`, allowing a permissive option;
- no dependency reported GPL-, AGPL-, SSPL-, or BUSL-only terms.

### Dashboard

- no lockfile package reported a missing license field;
- Lightning CSS packages report MPL-2.0;
- no package reported GPL-, AGPL-, SSPL-, or BUSL-only terms.

### Website

- no lockfile package reported a missing license field;
- Lightning CSS, Resvg, Vercel OG, Axe Core, and Satori entries report MPL-2.0;
- platform `libvips` packages report LGPL-3.0-or-later;
- Sharp platform packages report combined Apache-2.0, LGPL, and MIT notices;
- no package reported GPL-, AGPL-, SSPL-, or BUSL-only terms.

### Vendored source

- derived Codex components retain Apache-2.0 license and upstream provenance records;
- applicable OpenAI and Ratatui attributions are preserved in the local NOTICE files and must be
  aggregated into release artifacts that contain those components;
- `third_party/codex-otel-stub` contains a Morphz-authored inert compatibility surface rather than
  copied Codex implementation and now carries explicit Apache-2.0 notice metadata.

## 4. Release implications

Publishing source does not copy dependency source merely because a manifest names it. A binary,
container, installer, or static website bundle may distribute additional dependency artifacts and
therefore needs an artifact-specific notice and license review.

Before shipping the first binary or container release:

1. generate an inventory from the exact release artifact and target platform;
2. determine whether Sharp/libvips or other optional native components are present;
3. include all license texts and notices required by the components actually shipped;
4. preserve source-availability and relinking obligations if an LGPL component is distributed in a
   form that triggers them; and
5. repeat the scan after lockfile changes.

Font, image, icon, model-weight, paper-source, benchmark-corpus, and external dataset provenance
remain separate release-readiness checks and are not closed by this audit.
