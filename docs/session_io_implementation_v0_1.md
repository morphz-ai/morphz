# Session IO v1 — Runtime implementation

Status: promoted to a supported Runtime capability for 0.1.3. The existing wire
`io_version: "1"` and persisted format definitions are unchanged. This is an
implementation support decision, not acceptance of a separate public MEP.
The [original acceptance record](./session_io_acceptance_v0_1.md) remains dated
historical evidence; the [0.1.3 record](./session_io_stable_0_1_3.md) tracks the
current release gate. No production data migration or automatic client rollout
is implied.

Main integration (2026-09-12): the experimental implementation is integrated into `main`, retaining both the opt-in Cargo feature and the process/configuration gate. Integration preserves the existing scheduler and steering-draft fixes, including parallel-input metadata in typed Context observations. This does not enable the experiment on an existing instance or install a storage fence. The isolated acceptance and no-rollout statements below describe the original 2026-09-10 verification.

## Implemented boundary

Session remains a Context-owned IO route. A request's format does not create a separate Mind, switch Session ownership, or authorize an operation. The implementation uses the existing Event, ingress transaction, Signal, Thread, execution and recall machinery rather than a second message database.

| Layer | Implementation |
| --- | --- |
| Data | Strict UTF-8 JSON parser, typed data tree and lossless numeric lexemes; duplicate keys, invalid Unicode and unsupported encodings fail closed. |
| Acceptance | Authenticated Session ingress, durable request ID/fingerprint, frozen format definitions, output contract and execution binding. Retry lookup precedes current registry/default resolution. |
| Context | Typed observations and definition references share the Full/Delta renderer. Replay and full-event recall retain typed content. Definitions are separate from the Kernel; input strings are inert data leaves. |
| Output | `deliver_message` validates complete outputs against the accepted root contract. Ordinary final Chat replies use the same output validation. Required outputs are checked at terminal delivery. |
| Transport | Capability discovery, JSON submission/history and versioned SSE with durable cursors, draft sequence numbers, replaceable snapshots and explicit reset. |
| Resources | Staged uploads, attachment-only Chat and committed references use the authenticated import pipeline. Typed outputs own their attachment copies. |
| Clients | Dashboard has a generic read-only inspector. The application uses the versioned `morphz.application.input` family for new inputs; image bytes use resumable staging. Historical format definitions and queued requests remain unchanged. |
| Upgrade | Explicit SQLite/PostgreSQL writer fence; compatible connection markers, old-writer rejection, immutable version/coverage manifest and backup-only downgrade. |

The input's `text` display hint is not the authoritative Context representation. Neither a rules prefix nor serialized domain JSON is inserted into the user's text. Stable Work behavior belongs to the host tool/format contract; dynamic scope is data. Actual object creation still requires the authenticated host tool and its durable receipt.

## Default availability and configuration

Build with:

```sh
cargo build --locked -p morphz --bin morphz
```

Default builds and release binaries include and enable Session IO. The normal
host-owned configuration is:

```toml
[session_io]
enabled = true
# formats = [...]  # trusted Descriptor definitions
```

Explicit `enabled = false` disables new IO and refuses a database containing
typed history. Project-local configuration cannot set this policy or install
trusted formats. Embedders may supply `MorphzRuntimeBuilder::session_io_registry`.

The old `experimental-session-io` Cargo feature and
`--enable-experimental session-io` / `MORPHZ_EXPERIMENTAL_FEATURES=session-io`
are accepted as retired compatibility inputs, not requirements or overrides.
Legacy `experimental.session_io_formats` definitions are read alongside normal
`session_io.formats`; an ID/version conflict fails rather than picking a winner.
New launches and documentation use only the stable configuration.

Default availability does **not** install a database fence. A new binary refuses typed history when IO is disabled, but that check alone cannot protect against older binaries. Before using a shared/existing database, initialize its current schema, stop/drain its writers, take and verify a recoverable pre-IO backup, then explicitly install the fence below. Existing user instances are not migrated by this change.

## Explicit storage fence

The command requires an explicit database target; it never infers a personal profile's database. Without `--install` it is read-only. SQLite paths honor `--cwd`; absolute paths are recommended. PostgreSQL URLs come from a named environment variable, not command arguments.

```sh
# Inspect only; an absent path is an error, not a request to create a database.
morphz storage session-io-fence --sqlite /absolute/test/runtime.sqlite
morphz storage session-io-fence --postgres-url-env TEST_DATABASE_URL

# Explicitly approved migration after initialization and a verified backup.
morphz storage session-io-fence --sqlite /absolute/test/runtime.sqlite --install --acknowledge-write-block
morphz storage session-io-fence --postgres-url-env TEST_DATABASE_URL --install --acknowledge-write-block
```

Installation works in the ordinary Runtime build. Start compatible writers with Session IO enabled. Embedders injecting a store must use `SqliteStore::new_for_runtime` or `PostgresStore::new_for_runtime` with the selected cognitive backend and `session_io=true`; legacy constructors intentionally register an incompatible writer. The Runtime builder does this for its own stores. All replacement pool connections receive the same capability. Enabling IO in the registry alone does not upgrade an injected legacy connection pool.

SQLite installs `BEFORE INSERT/UPDATE/DELETE` guards on ordinary authority tables. A connection-local SQLite function identifies compatible writers; pre-IO binaries do not define it, so writes fail. Virtual FTS tables, their shadow tables and SQLite internals are derived/engine-owned data, not guard targets. PostgreSQL installs `ENABLE ALWAYS` statement guards for `INSERT/UPDATE/DELETE/TRUNCATE`, checking a connection-local writer version. The immutable `morphz_session_io_guard` table records version 1 and the exact protected table set. Startup verifies the version, coverage and trigger/function definitions before store migrations. Unknown versions or drift fail closed; installation does not silently repair drift.

Installation is transactional: SQLite uses `BEGIN IMMEDIATE`; PostgreSQL takes the existing schema-migration advisory lock and exclusive table locks. Both have a five-second lock wait limit. Transactions already holding write locks finish before the cutover; after commit incompatible connections cannot write, even if they were open or had prepared statements before installation. Failure leaves no partial fence. Repeating a valid installation only verifies it.

The fence is a compatibility mechanism, **not protection against a database owner**. A privileged operator can change schemas, disable/drop guards or forge the PostgreSQL connection setting. Do not run competing DDL migrations or unreviewed future schema versions against a fenced database. Coverage drift requires a separately reviewed migration; it is not automatically expanded. Read-only operations by older software may still succeed. This is verified old-writer exclusion during a rolling cutover, not a promise of uninterrupted old-client writes or universal future-version compatibility.

There is deliberately no removal flag. Downgrade by stopping current writers and restoring the pre-IO backup into a separate database, verifying it, then routing old software to that restored database. Never delete guards and point old software at typed history. New data created after the backup is not magically backported. The existing cognitive-store migration command uses legacy connections and does not bypass an installed IO fence.

## HTTP and SDK

| Endpoint | Meaning |
| --- | --- |
| `GET /api/session-io/capabilities` | Enabled IO/stream versions, formats and exact hashes, schema subset, limits and unsupported capabilities. |
| `POST /api/sessions/:id/io/messages` | Validate and durably accept one message without a prior negotiation round trip. |
| `GET /api/sessions/:id/io/events` | Read authorized durable messages/control events in insertion order. |
| `GET /api/sessions/:id/io/stream` | Durable catch-up followed by live drafts/execution events. |
| `GET /api/sessions/:id/io/resources/:resource_id` | Authorized immutable attachment download. |
| `GET /api/sessions/:id/io/messages/:event_id/content` | Typed page selected by `json_pointer`, `offset` and `limit`. |

These endpoints accept credentials only in headers, not query strings. They reuse the configured authentication mode and existing Principal-to-Session authorization. A body field named `principal_id`, `context_id` or a forged route is not authority. Trusted gateway assertions remain host-controlled.

Example standard Chat input:

```json
{
  "io_version": "1",
  "client_message_id": "chat-example-1",
  "message": {
    "format": { "id": "morphz.chat", "version": "1" },
    "content": { "encoding": "json", "value": { "text": "Hello" } }
  }
}
```

Example generic, unregistered domain input:

```json
{
  "io_version": "1",
  "client_message_id": "domain-example-1",
  "message": {
    "format": { "id": "example.measurement", "version": "1" },
    "validation": "generic",
    "content": {
      "encoding": "json",
      "value": { "count": 9007199254740993123456789, "scale": 1.0 }
    }
  },
  "activation": { "mode": "evaluate", "dispatch_mode": "parallel" }
}
```

`generic` is an explicit syntax-only policy for unregistered, non-`morphz.*` JSON. It cannot bypass a registered schema. The registry defaults to allowing it; embedding hosts may disable it. New typed requests default to parallel dispatch; legacy requests retain their existing default.

The receipt contains `io_version`, `status: accepted`, `accepted`, `message_id`, `event_id`, `session_id`, `cursor` and the accepted `binding`. Acceptance is not completion. An unavailable response may follow a committed input whose acknowledgement/dispatch failed: retry the same ID, never infer rejection or create a new ID. Repeating an ID with the same authenticated request returns the original event/binding; different content conflicts. Object key order is normalized, but number lexemes such as `1` and `1.0` intentionally produce different request fingerprints. Authorization is rechecked even for a retry.

The Rust API is `MorphzSdk::send_io_message` or `SessionHandle::send_io_as_principal`. Construct `session_io::Request` with `Request::parse(bytes, limits)` or typed `Data`. For raw domain JSON do not parse through floating-point `serde_json::Value`. Use `request.wire_data().json()` / `message.wire_data().json()` for external JSON. Derived Serde serialization is the **tagged persistence representation**, deliberately distinct from the wire representation so PostgreSQL JSONB cannot round domain numbers.

Old `text + attachments` SDK/HTTP requests remain supported with unchanged fingerprints and durable history. They share the existing ingress/scheduler pipeline and are exposed as standard Chat by the new history adapter. With IO enabled, Context uses the same typed read adapter; stored events and fingerprints are **not rewritten**. Disabling IO keeps the legacy Context renderer. Attachment references retain a valid Chat shape, with trusted file metadata separate from the message body.

## Attachments and immutable resources

Upload bytes through the existing authenticated `POST /api/sessions/:id/attachment-stages` and `PUT /api/sessions/:id/attachment-stages/:stage_id/content` endpoints. A stage is bound to the Principal, Session and `client_message_id`; resume from its confirmed offset. Then submit:

```json
{
  "io_version": "1",
  "client_message_id": "attachment-input-1",
  "message": {
    "format": { "id": "morphz.chat", "version": "1" },
    "content": { "encoding": "json", "value": {
      "text": "",
      "attachments": [{ "stage_id": "attachment-stage-1" }]
    } }
  }
}
```

Create that stage with the same client message ID. The receipt's `binding.resources` contains committed resource IDs, filenames, media types, sizes and digests, not storage paths. Each attachment names exactly one `stage_id` or `resource_id`. Session references use `{ "kind": "session", "session_id": "…" }` and retain existing authorization.

Reuse a committed attachment with `{ "resource_id": "io-resource:…" }`, or send `content: { "encoding": "resource", "resource_id": "io-resource:…" }` using `morphz.data@1` or a registered resource-capable format. Custom JSON formats may declare `resource_paths` (JSON pointers) selecting attachment references or arrays. Arbitrary strings, paths and URLs never cause a resource read. First-version reuse is restricted to the same authorized Session; a shared Context alone does not authorize cross-Session copying.

Ingress and typed delivery copy verified bytes into the new Event's ownership. Output history's `resources` and input `binding.resources` map original IDs to new owned IDs using `original_resource_id`. Use the returned owned ID for durable downloading. Downloads recheck current authorization and integrity, expose no storage paths, and use `attachment`, `application/octet-stream`, `nosniff` and `no-store` headers. Resource support does not imply arbitrary binary decoding: native types and byte limits follow existing model-input/import policy.

An accepted retry returns its original binding before inspecting consumed stages or changed registry settings. An unknown acknowledgement is not permission to invent another message ID. Pending attachment manifests retain existing crash-recovery rules. A committed resource output remains a delivery fact, not proof that all physical work completed.

Typed output preparation and its retry lookup are serialized by an OS file lock through durable commit and pending-manifest cleanup. Recovery uses the same lock before checking Event ownership. This prevents concurrent identical deliveries from colliding on deterministic temporary paths or cleaning each other's files. Writers need a writable artifact root; cooperating processes must share that root and filesystem lock semantics. The bounded 256 lock stripes remain as empty files (unlinking a live lock file would split its ownership); closing a handle releases the lock. This is attachment-file coordination, not a database-version fence or distributed rolling-upgrade guarantee.

## Large messages and typed reads

The Context budget covers definitions, visible content and resource metadata. A large message keeps its immutable original; the bounded view includes `complete: false`, Event reference, format, size, hash, omission reason and an explicit `recall` entry point. Sliced JSON is never presented as a complete object. Descriptors may declare `required_visible_paths`; if essential fields plus definitions/resources cannot fit, acceptance fails rather than hiding them.

Use `recall` with `event_id`, `json_pointer`, `offset` and `limit`, or `MorphzSdk::read_io_message_page` / the HTTP content endpoint. An empty pointer selects the content root. Limits count object/array entries or Unicode scalar values in strings. Pages include type, total, offset, `next_offset`, completeness and original hash; oversized children return explicit paths to follow. Numbers, including large integers and `1.0`, never round through floating-point JSON. The entire page envelope counts against its byte budget, and every successful nonterminal string page advances. Recall retains the active Context visibility snapshot; HTTP/SDK recheck Session access before returning data.

## Installing a format

A trusted embedding host calls `Registry::register(Descriptor)`. The CLI also accepts definitions from `session_io.formats` or the existing private host-tools manifest's optional top-level `formats` array. Message senders and project configuration cannot install schemas or code. The previous `experimental.session_io_formats` key is an upgrade compatibility input only.

```json
{
  "id": "example.result",
  "version": "1",
  "encodings": ["json"],
  "schema": {
    "type": "object",
    "properties": { "count": { "type": "integer" } },
    "required": ["count"],
    "additionalProperties": false
  },
  "contract": "A count, not proof that an external operation succeeded.",
  "publisher": "example host"
}
```

An exact ID/version cannot be replaced with a different definition. Schema and contract hashes are persisted with the accepted input; a process registry is not the only copy. Optional expected hashes on messages/output requirements fail on mismatch. Format descriptors are data, not downloaded URLs, arbitrary Context compilers or private mutable Context regions.

The advertised schema subset is `type`, `properties`, `required`, `additionalProperties` (boolean), `items`, `enum`, `const` and `description`. Unsupported keywords, references and remote fetching are rejected at installation. Descriptor numeric constants inside `const`/`enum` must be int64/uint64, including nested constants; floating-point constants are rejected to prevent install-time rounding. This does not narrow numbers in message bodies, which retain their original lexemes.

## Delivery and recovery

`delivery.accept_formats` limits permitted outputs. If omitted, the resolved set contains standard Chat plus explicitly required formats. If explicitly supplied, every required format must be included. `required_formats` adds completion obligations; merely accepting a format does not require it. `require_schema` rejects contracts whose accepted outputs cannot all be schema-validated.

The model can call:

```json
{
  "delivery_id": "result-1",
  "message": {
    "format": { "id": "example.result", "version": "1" },
    "content": { "encoding": "json", "value": { "count": 3 } }
  }
}
```

The tool gets Session, Principal, root, Thread and Activation from the actual execution context, never model arguments. It validates against the root's frozen definitions and limits. A transactional commit checks the active generation, terminal state and current authorization. The same root/delivery ID can retry the identical result; changing its content conflicts. An already committed output remains a fact even if later work fails or is cancelled. Missing required output creates `session/io_state` failure and does not retry physical work to manufacture a successful response.

SSE `after` or `Last-Event-ID` resumes from a Session-scoped durable cursor. `receive_formats` (JSON array in the query) and `receive_unknown=inspect|reject` affect presentation only. Unknown JSON is inspected read-only or represented by metadata without its body. These preferences cannot rewrite an accepted output obligation.

Durable `input.accepted`, `output.committed`, `execution.event` and `run.state` carry physical sequence/cursor and causal metadata. Draft `output.started`, `output.delta` (`text.append`), `output.aborted` and `stream.reset` are process-local. A snapshot replaces a draft through `delta_seq`, never appends the prefix twice. Committed content is authoritative. A root terminal event ends remaining drafts for that root, including earlier model attempts. Clients must discard uncommitted drafts on reconnect when no snapshot exists. JSON outputs are not exposed as incomplete structured values. Hidden reasoning and provider continuation data are not streamed.

Draft storage is bounded to 64 attempts and 256 KiB per draft; the connection also has bounded history and backpressure. Gaps/reset require snapshot replacement or durable replay, not resubmission of the user request. Large Context values use explicit resource projection and typed paging, never an apparently complete truncated object.

## Desktop migration

The application now lives in this repository's `application/`. Its host manifest registers `morphz.application.input` (v1 ordinary input, v2 legacy local-file reference support, v3 directory grants, v4 directed continuation) alongside immutable legacy `morphzwork.input` definitions for existing work. New requests select the version for their actual fields; this does not rewrite queued requests or require Runtime to implement application business rules. A new text input contains the original text, input/workspace/Actant IDs, optional intent/selection and an exact object revision reference. The host independently resolves the root input and permissions; none of these data fields grants authority.

Rules previously prepended to every user message now live in the stable host tool contract. Large object bodies are read with the existing versioned object tool. `read-input` returns the actual invocation's immutable scope when handling standard Chat/attachments. It cannot select an arbitrary input ID.

Already queued requests are not rewritten. New requests fail visibly when typed IO, resource support or the Work format is unavailable; there is no silent prompt-prefix fallback. New images use stable attachment stages plus the typed Work envelope. Original bytes remain in the private durable outbox, never a public UI snapshot. Lost upload acknowledgements resume from the server's confirmed state; lost input acknowledgements retry the identical accepted request. Replies, tool streaming, receipts and project/Session routing reuse the existing UI. The Runtime format imposes no GUI requirement.

## Validation and delivery boundary

Verified with deterministic local model fixtures, not a paid provider or personal center:

Recorded final run (2026-09-10): Runtime library regression passed 1,301 tests (9 ignored by default, including the PostgreSQL resource-concurrency and fence cases, both passed separately); all 31 CLI binary tests passed. All 12 IO integration tests passed with the isolated PostgreSQL case enabled and its fence installed. Five focused fence tests and three old-binary integration tests passed separately. Paired-client validation passed 233 Dashboard tests and 102 Desktop Node tests, Dashboard lint/build and Desktop typecheck/build. The real Electron tool-chain run also passed with an explicitly installed fence in its fresh Runtime database. Bundle-size warnings remain; no new bundle-size reduction is claimed.

Default-feature compilation and experimental-feature Clippy (warnings denied) pass. Compilation without default features also passes, with warnings in the feature-disabled ContextDB/migration paths; no warning cleanup outside this protocol change is claimed.

- Runtime library regressions, including the previously permission-dependent macOS sandbox/tool tests; separate typed IO integration tests cover actual Context, real typed tool delivery, missing-output failure, concurrent retry, reopening, authorization rejection, cancellation, HTTP history and cursor/SSE behavior.
- PostgreSQL 15 live test on an isolated database: concurrent retry, lossless JSONB storage, real typed delivery, output conflict/terminal fences, typed Context history, registry-policy changes, cancellation and unauthorized input. Added staged files, cross-pool resource download, resource reuse, typed paging and retry after reopening. The opt-in test is `postgres_typed_ingress_delivery_reopen_and_cancellation`; it requires `MORPHZ_SESSION_IO_TEST_POSTGRES_URL` pointing to a fresh database named `morphz_io_test_*` and is otherwise ignored. It never clears an existing database.
- SQLite and PostgreSQL resource-delivery stress cases submit 16 identical tool invocations against a real active root: all succeed with one output identity and exactly one fresh commit. Removing the synthetic source afterward does not break a committed retry or the output-owned download. Before the fix, concurrent preparation returned `AlreadyExists`; recovery now also waits for an active writer before deciding ownership. The additional PostgreSQL library test is `postgres_concurrent_resource_delivery_retries_preserve_committed_bytes`, with the same isolated-database opt-in rule.
- The first full regression exposed an intermittent existing Objective exact-reply/scheduler race. Exact reply admission, wait-projection cleanup and background scheduling now share the per-Objective scheduling mutex through Evaluation ownership. Regression checks hold that critical section and explicitly inspect the dependency-satisfied/lease-not-yet-claimed interval. All 32 Objective tests and the final full library run passed. This repairs in-process coordination without changing Thread Targets, routing generations or durable compare-and-swap checks; it is not an old-writer exclusion mechanism.
- Explicit Full/Delta renderer and serialized observation parity; full-event recall preserves the typed tree and format definition. Generic non-Work JSON exercises integers larger than JavaScript's safe range and inert instruction-like strings.
- Dashboard unit tests and build; browser inspection of the real inspector component shows exact numeric lexemes and literal script-like text with no editable/script children.
- Desktop Node tests, typecheck/build and isolated real Electron → center → Runtime → host tool tests. Actual files/tasks, versioned receipts, separate conversations, partial text/tool arguments, final deduplication and reload are checked. A real typed image upload delivers unchanged native image bytes to the model transport and downloads through an authenticated immutable resource ID. Two independently lost acknowledgements (upload and input) are covered by a separate outbox retry test. The model transport is synthetic; these are not claims about a specific model's reasoning reliability.

The old-binary probe uses v0.1.2 at release commit `6e45724285e4276406ac0d4b7f8e4f3001c77dfb`. Its writes succeed before installation, fail afterward without changing any ordinary authority table, and succeed against restored pre-IO backups. Separate tests keep its actual HTTP servers running across the cutover on both backends: pre-cutover Session creation works, post-cutover creation fails, reads remain available, and compatible connections still write. Tests also cover prepared/live connections, transaction boundaries, pool replacement, reopening, partial-install rollback, immutable markers and coverage drift.

Implementation acceptance is not a release approval. No merge, push, publication, personal-instance replacement or activation on an existing user database was performed. MEP acceptance, production backup/cutover planning and release approval remain separate decisions, not missing code in this scoped implementation.

Typed `observe` and external S-Expr remain explicitly unsupported first-phase capabilities; they are not silently converted. Resource inputs and typed large-object paging are implemented and advertised.

Directed typed input (2026-09-18) is now accepted through `activation.input_destination` and advertised as `directed_input` when Session IO is enabled. It uses the existing atomic Principal/Session/Context/Thread or Objective generation fence and immutable client-message idempotency; it does not create another dialogue root. Model, reasoning, Target and Harness overrides are rejected before admission because the destination retains its route. Delivery is queued acknowledgement, not proof that the new requirement has been applied. An accepted request can recover the same receipt after the target has completed; an unaccepted request to a closed target must be an explicit new follow-up instead. Registry, typed-ingress and steering tests plus an isolated real Runtime/embedded-application test cover this path; PostgreSQL-specific cases were not rerun for this change.

Default input limits are 1 MiB JSON, depth 32, 32,768 nodes, 512 KiB per string, 1,024 bytes per numeric lexeme, and 64 KiB for the complete Context content/definition projection. A descriptor is bounded to 32 KiB of schema and 8 KiB of contract. These are disclosed parser/projection safety budgets, not document-length or audiobook limits. Large artifacts remain separate objects. Changing a process's registry or limits does not rebind a previously accepted message's semantics.
