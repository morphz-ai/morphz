# Session IO v0.1 — isolated acceptance record

Date: 2026-09-10. Scope: the experimental Session IO implementation and paired Desktop adapter. This is implementation evidence, not a stable-standard designation, release approval or production migration.

The requested remaining work comprised envelope attachments/resources and attachment-only Chat; type-preserving large-object projection and paging; verifiable upgrade/downgrade write exclusion; SQLite/PostgreSQL, Dashboard and Desktop regression; isolated end-to-end acceptance; and accurate records. None of these items is deferred to a later release in this record.

## Requirement-to-evidence audit

| Requirement | Authoritative implementation and observed evidence |
| --- | --- |
| Standard Chat and arbitrary JSON coexist on a Session | `session_io::{Request, Registry, Data}` and `tests/session_io.rs`: direct typed acceptance without discovery; generic non-Work `test.input`/`test.result`; legacy request receipt and payload remain unchanged; new opt-out rejects typed history. Existing Session/Context ownership is unchanged. |
| Exact data and explicit format policy | `session_io/tests.rs`: numeric-lexeme fingerprints, duplicate/envelope/authority rejection, registered-schema checks that generic cannot bypass, format-hash conflict rejection, frozen output limits/definitions, unsupported encodings and delivery constraints. `data.rs` tests invalid Unicode and JSON numbers. |
| Structured model input, not a rules prefix | `typed_input_reaches_context_and_retries_do_not_duplicate_execution` inspects actual model messages for typed numbers, definition references and the root Observation. `typed_observation_delta_replay_and_full_recall_preserve_one_data_tree` compares Full, Delta, persistence and recall. Desktop tests verify unchanged original text and actual-root `read-input` scoping. |
| Attachments and attachment-only Chat | `staged_attachment_only_chat_has_real_bytes_and_immutable_resource_identity`: actual staged bytes, immutable resource IDs, repeat acceptance, ownership and authorization failures. `resource_output_is_validated_owned_and_downloadable_after_delivery`: output-owned copies survive independently of the source. The HTTP test verifies authenticated download and defensive response headers. |
| Type-preserving large objects and paging | `large_typed_message_is_projected_by_reference_and_read_without_rounding`, `typed_pages_preserve_numbers_paths_and_completeness`, `required_fields_cannot_be_hidden_by_resource_projection`, `pages_budget_the_entire_envelope_and_make_progress`: explicit incomplete projections, immutable reference/hash, JSON Pointer escaping, exact large integers and `1.0`, essential fields, envelope byte bounds and advancing Unicode-string pages. |
| Durable retries, real typed output and cancellation | SQLite/PostgreSQL IO integration tests cover concurrent identical input, one accepted binding, durable tool output, content conflict, root terminal rejection, changed registry on reopen, missing required output and cancellation with late model output. Both backend resource stress tests submit 16 identical concurrent deliveries and verify one fresh commit and retained owned bytes. |
| Streams and presentation policy | The HTTP IO test covers authorized history, durable cursor catch-up, unknown-format metadata, live text deltas, reconnect snapshots and sequence continuity. `drafts_are_sequenced_bounded_and_terminal_fenced` covers bounded drafts/reset and terminal fencing. Desktop tests check chronological delivery with causal roots, project routing, reload deduplication and lost upload/input acknowledgements. |
| Explicit upgrade/downgrade fence | `session_io/fence.rs` and five focused tests: no implicit installation; explicit target/acknowledgement; current and replacement connection capability; old prepared/live connections rejected; pre-cutover transactions finish before installation; partial DDL rolls back; marker mutation fails; drift is not repaired silently. SQLite and PostgreSQL evidence is separate. |
| Actual old binaries and rolling cutover | Three tests in `tests/session_io_fence_legacy.rs`, using pre-IO v0.1.2 (`6e45724285e4276406ac0d4b7f8e4f3001c77dfb`, the local `v0.1.2` tag). Actual old commands write before installation and fail afterward; every ordinary authority table is compared before/after the failed operation. SQLite backup and PostgreSQL dump/restore permit the same old write afterward. Actual old HTTP servers also remain alive across cutover: Session creation succeeds before, fails after with no Session persisted, reads succeed, and compatible connections write. |
| Working under the fence | `explicit_fenced_sqlite_runs_attachment_io_and_reopens_with_original_binding` and the PostgreSQL IO test with `MORPHZ_SESSION_IO_TEST_INSTALL_FENCE=1` exercise typed operations after installation. The complete real Electron fixture also runs after explicit installation in its newly created SQLite database. |
| Client regression and usable receipts | Dashboard generic inspector unit checks preserve numeric lexemes and inert text; 233 tests, lint and build pass. Desktop has 102 passing Node tests, typecheck and build. Its real Electron test confirms partial text/tool arguments before model completion, actual document/task receipts, human correction and Schedule execution, separate project Sessions, image-byte fidelity and authorized resource download. Streaming screenshots were inspected. |
| Isolation and delivery limits | Runtime and Desktop changes remain in separate development workspaces. No merge, push, release, daily-instance replacement or migration of an existing user database. Test models are deterministic local fixtures, not paid-provider calls or evidence of a model's reasoning quality. |

## Final executed suites

| Suite | Result |
| --- | --- |
| Runtime library, experimental feature enabled | 1,301 passed; 9 default-ignored; 0 failed |
| Runtime CLI binary tests | 31 passed; 0 failed |
| IO integration, including PostgreSQL with explicit fence | 12 passed; 0 failed |
| Focused SQLite/PostgreSQL fence suite, including opt-in case | 5 passed; 0 failed |
| Real old-binary integration | 3 passed across the targeted runs; 0 remaining failures |
| Additional PostgreSQL concurrent resource delivery | 1 passed |
| Dashboard | 233 passed; lint and build passed |
| Desktop | 102 Node tests passed; typecheck/build passed; complete real Electron tool-chain passed with `--storage-fence` |
| Compilation/lint | Default check, no-default-features check and experimental library Clippy with `-D warnings` passed |

Ignored library cases are not counted as passing. The two new opt-in PostgreSQL library cases were exercised separately. The no-default-features build retains existing ContextDB-disabled/migration warnings (33 library and 3 binary warnings in the final check); no unrelated warning cleanup is claimed. Dashboard/Desktop builds retain large-chunk warnings.

The first attempted old PostgreSQL command was a no-op and correctly succeeded: the fence prevents writes, not reads or no-op commands. The corrected probe deliberately changes cognitive-store authority and verifies rejection without changing table data. The subsequent live-server probe independently demonstrates refusal of an actual Session-creation request after cutover.

## Reproduction

These are current rerun commands for Runtime 0.1.3. The experimental flags used
by the historical implementation have been removed; the dated results above
are unchanged.

Use a compiled pre-IO binary and fresh local test databases. Never run the opt-in migration tests against a personal or production database. The tests reject unrelated database names and the fence-specific tests reject a nonempty initial schema. PostgreSQL restore creates another dedicated database with an `_restore` suffix; tests do not drop existing databases.

```sh
cargo test -p morphz --lib
cargo test -p morphz --bin morphz
cargo test -p morphz --test session_io -- --include-ignored
cargo test -p morphz --lib session_io::fence -- --include-ignored
cargo test -p morphz --test session_io_fence_legacy -- --include-ignored
cargo clippy -p morphz --lib -- -D warnings
cargo check -p morphz
cargo check -p morphz --no-default-features
```

Set the following test-only environment variables explicitly before the relevant command:

- `MORPHZ_SESSION_IO_TEST_POSTGRES_URL`: fresh database named `morphz_io_test_*` for typed IO; set `MORPHZ_SESSION_IO_TEST_INSTALL_FENCE=1` to exercise it with a fence.
- `MORPHZ_SESSION_IO_FENCE_TEST_POSTGRES_URL`: separate fresh `morphz_io_test_fence_*` database for the focused fence test.
- `MORPHZ_SESSION_IO_LEGACY_BINARY`: verified pre-IO executable path.
- `MORPHZ_SESSION_IO_LEGACY_TEST_POSTGRES_URL`: separate fresh `morphz_io_test_fence_*` database for old-binary backup/downgrade.
- `MORPHZ_SESSION_IO_LIVE_LEGACY_POSTGRES_URL`: another fresh `morphz_io_test_fence_*` database for the live-server cutover.
- `MORPHZ_SESSION_IO_POSTGRES_BIN_DIR`: PostgreSQL directory containing `pg_dump` and `pg_restore`.

The separate PostgreSQL resource-concurrency test uses `MORPHZ_SESSION_IO_TEST_POSTGRES_URL` and its full test name `session_io::output::concurrent_tests::postgres_concurrent_resource_delivery_retries_preserve_committed_bytes` with `--ignored`.

Dashboard: `npm test`, `npm run lint`, `npm run build` in `dashboard/`. Application tests now live in this repository's `application/`: run `npm test`, `npm run typecheck`, `npm run build`, then `npm run test:runtime-tools -- --stream-ui --storage-fence`. Integration scripts default to this repository's `target/debug/morphz`; use `MORPHZ_APP_RUNTIME_BINARY=/absolute/current/morphz` only to select another explicit test binary. The script creates a fresh center and database and explicitly fences only that fixture. It never loads a personal center or project `.env`. These are current rerun instructions; the historical acceptance results above are unchanged.

## What this does not claim

This implementation does not make the draft an accepted standard, authorize publication, provide a production backup, guarantee zero downtime for incompatible clients, or protect against privileged database owners disabling guards. An unguarded database is not protected merely because IO is enabled. Operators must review the [explicit fence procedure and limits](./session_io_implementation_v0_1.md#explicit-storage-fence) before a real rollout. Unsupported first-phase capabilities remain explicitly advertised as unsupported; no fallback turns them into prompt text.
