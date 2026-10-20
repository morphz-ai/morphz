# Locked optional npm license records

`manifest.json` binds every production optional package in the application
lockfile to its exact name, version, declared SPDX expression, official registry
URL and SRI integrity. Bundle generation uses these records on every host,
including when that package is absent from `node_modules`. Local platform
selection must not change license text, attribution, text ordering or labels.

The content-addressed `.txt` files preserve upstream bytes. The manifest checks
their SHA-256 on every generation, independently of the bundle's whitespace
normalization. The ordinary `--check` operation is offline and does not download
or execute package code.
The parent `.gitattributes` preserves archive bytes and the existing
supplements' LF endings even with `core.autocrlf=true`; the tests exercise an
actual Git checkout with that setting.

## Evidence and attribution boundaries

Verified 2026-10-20 against `application/package-lock.json`:

- `npm-archive` sources were downloaded from the exact lockfile `resolved` URL,
  verified against its SHA-512 `integrity`, and checked against the archive's
  package name, version and declared license. Only text is retained. This
  includes `@emnapi/runtime`, `@napi-rs/canvas`, `pg-cloudflare`, and each
  `@img/sharp-*` 0.35.5 wrapper/native package (not the libvips archives).
- Sharp stores the Lovell Fuller attribution and, on Windows/WASM, component
  license notices in `README.md`. Its `LICENSE` file alone contains only Apache
  2.0, even for packages declaring `AND LGPL-3.0-or-later` / `AND MIT`. Therefore
  the complete archive README and LICENSE are included. The Windows/WASM
  records additionally include the existing GNU LGPLv3 and GPLv3 terms; those
  files' upstream provenance remains in `../sharp-libvips-1.3.4/SOURCE.md`.
- The verified `@img/sharp-wasm32` 0.35.5 `versions.json` identifies Emscripten
  6.0.10. Its README identifies Emscripten's MIT license. The complete LICENSE
  (including its other retained terms) and AUTHORS are from upstream tag
  6.0.10, commit `d6c521a7f05449857c76bd99e396895583cf2083`, not `main`.
- The `@napi-rs/canvas-*` 1.0.8 native packages inherit the exact same-version
  parent MIT notice, including `Copyright (c) 2020 lynweklm@gmail.com`, as the
  existing generator intended. The parent archive is integrity-verified;
  this is **not** a claim that all native archives were downloaded/re-audited.
- `@img/sharp-libvips-*` 1.3.4 uses the existing reviewed upstream notice
  inventory and LGPL/GPL texts from `../sharp-libvips-1.3.4/SOURCE.md`, now
  checksum-pinned. Its source kind is deliberately
  `reviewed-upstream-notices`, not `npm-archive`. No binary audit or new
  verification of every libvips archive is claimed.

This remains a source-license inventory, not a legal opinion, exhaustive binary
audit, or satisfaction of corresponding-source/relinking requirements. Preserve
Electron/Chromium notices alongside distributed runtimes. Never replace an
`AND` expression with one permissive license or treat a missing notice as a
license exception.

## Updating

After reviewing a lockfile change:

```sh
python3 scripts/update-npm-license-records.py
python3 -m unittest discover -s scripts/tests -p test_npm_license_records.py -v
python3 scripts/generate-third-party-licenses.py application
python3 scripts/generate-third-party-licenses.py application --check
```

Refresh requires network access to the locked official npm archives and `gh`
for the pinned Emscripten source files. Archives have a 64 MiB bound and exist
only as temporary files. No lifecycle scripts run. New inherited-license or
WASM component versions require explicit review; they do not use templates.
Review manifest/text/bundle diffs together. The offline CI regression simulates
macOS, Linux, Windows and absent optional installations, rejects stale lock
identities or modified texts, and preserves the combined-license notices.
