# Application repository integration

Date: 2026-09-18

## Source ownership and preserved history

The user approved importing MorphzWork as the Desktop/Web application module in Morphz.
The import is a non-squashed subtree merge at `application/`:

- Morphz base: `0227fbf8c895162272a2c3dc3c96606a001dd09a`.
- Application source: `920bb8882bcbe594723d4f46ca4e605253d50721` (29 original commits).
- Import commit: `eaf7bf819b56ca940d2ac4c62050aa9b75bf903e`.

The imported tree exactly matched the source tree before integration changes. Original commit
identities, authors and messages remain reachable through the merge parent. The former checkout
is retained unchanged as a rollback/history copy; new work belongs only in `Morphz/application`.
This is a one-time import, not a submodule or a requirement to synchronize two repositories.

A bounded history check covered 1,184 unique blobs (18,403,641 bytes), suspicious credential/data
filenames, private-key markers and common token patterns. The only matches were three historical
versions of the same retrieval-test fixture containing a private-key header without key material.
No tracked environment/database file was found. This is not a claim of exhaustive secret detection.

## Module and release boundaries

- `morphz/` remains the Rust Runtime; its existing Cargo workspace and releases are unchanged.
- `application/apps/web` is the current shared React renderer.
- `application/apps/desktop` embeds the application host and SQLite behind restricted IPC.
- `application/apps/service` exposes the same application rules through the existing Web HTTP adapter.
- `application/packages/core` holds models, commands and contracts;
  `application/packages/application` holds the trusted Node application host.
- Dashboard remains the Runtime administration/diagnostic surface, not the application Web release.
- Mobile has not been implemented. It will consume the application contract; repository integration
  does not select a mobile UI framework, grant device capabilities or ship a mobile client.

The application keeps its npm lockfile and Node >=24.13 requirement. Runtime-only builds do not
install Node/Electron. Root README commands provide one checkout entry point. Application CI has
separate Web, native macOS and actual Runtime-contract jobs; existing Runtime release tags do not
publish the application. Production npm/Electron package notices have a dedicated generated inventory.

## Paths and existing installations

Integration scripts resolve the Runtime binary relative to this repository, not a sibling
`../Morphz` or the caller's cwd. Explicit `MORPHZ_APP_RUNTIME_BINARY` and its legacy alias remain
available; an explicitly empty path fails instead of selecting an unintended executable.

Moving source is not a data migration. Preserve the selected application center, Chromium
profile, environment-file reference, Runtime binary/configuration, namespace, credentials and
Host manifests. Do not load the Runtime repository's `.env` as application configuration. Local
and remote centers remain explicit choices; no database copying or cross-device sync is added.

The local development `.app` launcher records the application source root. Switching it requires
a normal application exit, a backup of the original launcher/profile and an online SQLite backup,
then rebuilding the same installed bundle with only its source root changed. Its system identity,
original data/profile and environment-file reference must remain unchanged. Verify the signature,
normal reopening, existing drafts, attachments, content and model connection before retiring the
old development path. Ad-hoc signed source changes can require renewed OS permissions; do not
reset TCC or weaken signature checks to conceal that boundary.

## Acceptance

Local verification on 2026-09-18 used macOS and Node 25.8.1:

- A fresh `npm ci`, production build/typecheck and 253/253 unit/integration tests passed.
- A locked Runtime build with `experimental-session-io` passed. The Runtime IPC,
  directed-continuation and identity-isolation smokes passed from the new application directory
  without a binary-path override. They use real Runtime processes and isolated synthetic providers.
- The full UI run passed 227/228 cases. The native sidebar case completed its UI checks but its
  final read-only `/api/workspace` request failed with `ECONNRESET`. The unchanged case then passed
  five consecutive repetitions. The initial trace is retained; this is not a single all-green run
  or a claim that the one-off TCP reset's root cause was established.
- The production embedded Electron smoke passed: `morphz://`, restricted preload, direct SQLite,
  idempotent commands, retained PDF rendering, in-place file access, isolated native browser,
  reload/close/reopen and no application TCP listener.
- The real Runtime + production Desktop model-settings smoke passed, including account/model
  persistence, draft/focus recovery and 200% native zoom. Its first attempt exposed an older test
  step waiting on a composer that had just collapsed; it now reuses the existing visible-entry
  `openInput` helper. No product layout, assertions or permissions were relaxed.
- Both application and unchanged Dashboard license inventories passed `--check`; the application
  inventory also retains PDF.js font/character-map/WASM notices. `actionlint`, changed-code
  formatting and `git diff --check` passed. The new CI workflow has not run on GitHub: nothing was
  pushed, and Linux/CI Node 24.13 results are not inferred from these macOS checks.

Logs use `/tmp/morphz-monorepo-`: `build-final.log`, `unit-final.log`, `ui.log`,
`sidebar-recheck.log`, `embedded.log`, `ipc.log`, `continuation.log`, `identity.log` and
`model-settings-final.log`. The initial sidebar trace is `sidebar-first-failure.zip` under the
same prefix. These are local execution evidence, not release artifacts.

### Original installation cutover

The existing `~/Applications/Morphz.app` was normally quit with no active Runtime work. Its complete
signed bundle and offline Chromium profile were copied to the private directory
`/private/tmp/morphz-monorepo-cutover.ZQ3HAB/`; the profile copy was compared byte-for-byte and the
backup bundle's signature verified. The online SQLite backup is
`workspace-2026-09-18T08-01-49-485Z-9a6b7d69.sqlite` in the original center's `backups/` directory.

The existing bundle generator rebuilt that same installation. A structural comparison of its
launcher configuration confirmed that **only the source root** changed, to `Morphz/application/`.
The `MorphzWork-development/center` data directory, `MorphzWork-development/desktop` profile,
legacy origins and original `MorphzWork/.env` file reference stayed unchanged. No secret was copied
into this repository. Keep the former checkout while that explicit private configuration reference
is still in use. Both original and updated bundle signatures verified; no TCC reset was performed.

After normal reopening, the actual process cwd was `Morphz/application` and its original-window
UI showed the same **TEST 完整工作流验收 0918** project, **试用准备验收** conversation and complete
unsent **TEST 重启草稿 0918** text. The original gpt-6-astra connection remained available, and
**TEST 试用清单 0918** opened at v3 with its human-added sentence and timing item. The window is
left on that document. The original Runtime process (PID 11872 at acceptance) was not restarted.

Comparison against the online backup found all original business objects, IDs, order, content,
406 command rows, 18 artifact-output rows, 8 assets and owners, PDF metadata and center identity
intact. Navigating away from and reopening the content application added two state-command
receipts for the same existing application instance; only that instance's revision/updatedAt and
the workspace revision changed, not its final state. Runtime namespace, endpoint, model, Sessions,
thread bindings and deliveries were identical. No message was sent and no ambient audio captured.

Cloud deployment, native mobile implementation, data synchronization and signed release packages
are outside this repository merge.
