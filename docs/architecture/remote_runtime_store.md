# Fenced remote RuntimeStore

The `remote-store` build feature supplies a complete implementation of the
`RuntimeStore` trait graph. It is an embedding API, not a switch that silently
moves an existing CLI database into a cloud account. SQLite and PostgreSQL
remain unchanged defaults for their existing deployments.

## Authority and computation

The remote service is the only durable authority. Rust executes the existing
SQLite transaction implementation in a **disposable, in-memory computation
replica**, captures its final row delta, and submits that delta as one atomic
operation. No Runtime operation is acknowledged before the remote authority
confirms its commit. There is no local durable file, file snapshot upload,
dual-write, offline success mode, or alternate-backend fallback.

This deliberately reuses the native Rust Context AST, commitment checks,
state transitions, composite transactions and SQL constraints. A TypeScript
service must not independently reimplement those business rules. The remote
adapter stores typed records and enforces revision, ownership, idempotency and
atomicity. SQL text is never sent over the protocol.

The trust boundary is the authenticated compute process, like a database
credential in existing deployments. Models cannot provide the endpoint,
credential, schema, owner fence, record delta or tenant selector. An embedding
host authenticates the compute process and binds it to exactly one Agent.

## Complete interface coverage

`remote_store_codegen.rs` parses the actual Rust trait graph using `syn`. All
asynchronous storage methods forward through the same commit boundary, including
trait defaults and compound methods. A newly added unsupported signature fails
the build. The two notification waits remain non-authoritative timeout hints and
do not hold the store mutex. A marker trait uses its existing blanket impl.

TEMP SQLite triggers capture canonical tables, row identities, dynamically typed
values and cascading changes. A rollback rolls back its journal too. Multiple
updates coalesce to the final row. No-op updates do not create remote writes.
FTS shadow tables/statistics are derived; the canonical Recall documents and
stable FTS identities are preserved and native triggers reconstruct the index.
New unsupported virtual tables, generated columns or row-identity layouts fail
startup instead of being silently omitted.

## Protocol `morphz-runtime-store/1`

Every request is scoped by an authenticated service endpoint and an
`{ownerId, epoch}` fence. No tenant ID is accepted from a model/tool request.

- `head`: live-fenced schema hash, revision, current owner's sequence.
- `page`: deterministic records after an opaque cursor at an exact revision;
  a changed revision rejects the page instead of constructing a torn snapshot.
- `commit`: schema hash, base revision, strictly next owner sequence, and an
  ordered final record delta. The adapter checks the fence inside the same
  durable transaction as all writes and the receipt.
- `claim` / `renew`: optional managed compute lease. A process uses a fresh random
  owner nonce. The authority supplies remaining TTL; Rust uses a monotonic clock
  started before the RPC, so clock skew does not extend its ownership.
- `recovered`: explicit acknowledgement **after complete Runtime recovery**, not
  after a storage download and not immediately after claim.

SQLite integers (including nanoseconds and row IDs) use decimal strings. Text,
real values, blobs and null have explicit tagged encodings; JavaScript numbers
never carry an i64 database value. Schema identity is a SHA-256 commitment to the
native DDL and ordered data-migration identities. Schema mismatch requires an explicit migration; initialization cannot
reset an existing remote store or import a second local authority.

A serialized owner needs only its last commit digest/receipt. Submission of the
next sequence proves receipt of the preceding one and is the retention watermark.
Replaying the last sequence with identical content returns the existing receipt;
changed content conflicts; older sequences never execute. An ownership change
resets the sequence namespace, not the data revision. Old fences are rejected
even when retrying a previously successful commit.

Reads do not advance revision or write a receipt. They validate the same fenced
head after reading their computation snapshot. A native operation returning an
error may have deliberately persisted bookkeeping; that delta is committed before
returning the original error, just as for a successful result.

## Cancellation and recovery

An operation takes its replica out of the shared slot. Only a confirmed operation
puts it back. Cancellation, transport failure, failed capacity validation, a
conflicting head or ambiguous commit therefore leaves no reusable speculative
state. The next operation reconstructs from the remote authority. The client
retries retryable HTTP failures with the **same serialized request**, never by
rerunning the business operation. It never replays physical tool effects.

`connect_owned` renews independently of the transaction mutex, output delivery,
tool execution or replica restoration. A failed/expired renewal permanently fences
that client instance. It cannot silently reacquire under the same identity.
Dropping the Store stops renewal; it does not mark unfinished work idle. Lease
expiry remains a recovery signal for the hosting service. Embedders should monitor
`ownership_lost()` and terminate the obsolete compute process; storage fences also
reject its stale outcomes regardless of that monitor's timing.

## Embedding

Build with `--features remote-store`. Construct an `HttpRemoteStoreTransport`
using an operator-supplied HTTPS URL and credential, then call
`RemoteRuntimeStore::connect_owned`. Inject the resulting `Arc` using the existing
`MorphzRuntime::builder(...).store("remote:...", store.clone())` API. Call
`store.complete_recovery()` only after `runtime.start().await` succeeds.

The Cloud implementation exposes a **private gateway primitive**, not a public
unauthenticated Worker route. Its hosted compute adapter resolves the Cell from
verified platform Container identity before calling that primitive. The test
HTTP bridge and its fixed credential are test fixtures only.

## Opt-in hosted executable and uploaded files

`morphz-runtime-host`, built only with `remote-store`, is an explicit embedding
entrypoint. It requires `MORPHZ_REMOTE_STORE_URL`, `MORPHZ_HOST_FILES_URL`,
`MORPHZ_HOST_CREDENTIALS_URL`, `MORPHZ_HOST_CONFIGURATION_URL`,
`MORPHZ_REMOTE_STORE_TOKEN`, a dedicated empty `MORPHZ_HOME`, `MORPHZ_BIND`,
separate API/Dashboard tokens, an identity provider ID, and the control plane's
`MORPHZ_AGENT_ID`, `MORPHZ_CONTEXT_ID`, and `MORPHZ_SESSION_ID`. Only an operator may
set `MORPHZ_HOST_PRIVATE_GATEWAY=1` for platform-intercepted private HTTP;
ordinary remote endpoints still require HTTPS (except loopback tests).

It claims a fresh fence, restores Store and file pointers, starts Runtime
recovery, acknowledges recovery and only then opens HTTP. It exits on ownership
loss. It provisions exactly that Agent and primary Session; the verified gateway
binds the user's Principal, rather than a bootstrap-local operator claiming the
Session. Cloud local execution is disabled; uploaded files remain available for
transfer to a selected Edge target through the existing tool/API contract.

The `host_files` materialization service has no directory upload/scanning API.
Callers supply immutable uploaded bytes at specific generated file paths.
Stage content and offset/manifest publish atomically before HTTP acknowledgement;
Event files, workspace attachment copies and pending marker publish before
message admission. Cancellation removes manifest pointers. Plain text and native
attachment parsing behavior are unchanged: no PDF/DOCX parser was introduced.
The Cloud implementation encrypts immutable blobs in R2 and commits pointers in
the same fenced Cell; responses are bounded and digest/length verified.

Synchronous file callers yield their Tokio scheduler worker while awaiting the
dedicated bounded I/O worker, so slow object storage cannot starve the independent
compute lease. A failed local materialization after a remote acknowledgement
invalidates ownership and stops the hosted process; it cannot keep using stale
cache contents.

Only this executable installs the optional file backend. Desktop, TUI and
ordinary CLI startup neither uploads nor migrates existing files. The hosted
executable restores exactly two primary configuration documents (`morphz` and
`models`) from the fenced Cell database. TOML files in its private HOME are only
disposable parser caches. Configuration writes acknowledge the database CAS
before replacing that cache; ambiguous publication stops the owner. Cloud stores
encrypted configuration bytes, including any inline sensitive values, rather
than interpreting TOML or publishing configuration files into R2.

`SecretStore::managed` registers one metadata-owning value backend. The Cell
atomically stores encrypted values with the native managed-credential catalog;
scope is authenticated with the ciphertext. Resolution checks the current fence,
revision and usage scope and persists audit before returning plaintext. The host
has no credential catalog/audit file or `.env` fallback and never receives a root
encryption key. Missing aliases do not resolve from the host process environment.
The existing local SecretStore constructors retain their local backend behavior.

The private configuration and credential endpoints use the same live compute
fence as RuntimeStore and files. Their keys are domain-separated. Root HOME
configuration and credential filenames are rejected by the R2 file interface,
including on restore, so it cannot become an alternate source of authority.
Synchronous authority I/O yields the Tokio worker; a single-worker regression
checks that credential waits do not starve lease tasks.

The cross-repository native host gate creates a synthetic Provider via the real
Runtime API, resolves its managed credential against a local HTTP fixture, kills
the host, removes only its test cache, and repeats the Provider call after recovery.
It checks both configuration/catalog restoration and durable usage audit, with
no `.env` or credential files in the restored HOME. This is not a real Provider
OAuth refresh/rotation test or a Cloud deployment. Refresh version propagation,
audit retention, key recovery and real platform gates remain required.

Keep the materialization root's absolute location stable across replacements:
existing Runtime attachment metadata contains absolute paths. The Cloud image
uses `/run/morphz-home` and clears only its own disposable cache. The constructor
refuses nonempty directories, rather than deleting an existing user HOME.
The opt-in host now parks after `MORPHZ_HOST_IDLE_SECONDS` (default 60, positive)
without HTTP activity, but inactivity alone never authorizes exit. An admission
gate accounts for entire request/response bodies and WebSocket lifetimes. It
exclusively closes ingress before checking process-local execution queues and
native durable owners under the replica transaction mutex. Busy checks reopen
ingress and retry no more often than every five seconds. Health probes do not
reset the activity clock. Requests during a park attempt receive an explicit
retryable `runtime_parking` 503 before reaching business handlers.

The native check rejects active Activations, Jobs, Plans, Signals, deliveries,
runnable Objectives, assignments/delegations, claimed/due timers, projection
work and live Provider refresh leases. It exports the earliest future native
timer to Cell `park`, which atomically verifies the exact RuntimeStore revision,
due ingress and ownership, saves the deadline, then fences the old process.
Only a positive park receipt permits exit 0. Ambiguous authority failures exit
nonzero and recover; they never reopen admission with a potentially stale fence.

Local workerd/native-process gates cover drain, orderly idle exit, cache-free
replacement, and a real `schedule_tx` durable Objective/Thread whose native
deadline fires a DO alarm and starts replacement compute without another user
request. This is not a deployed Linux Container gate. Open WebSockets and active
approval waits currently retain compute; frontend/Edge hibernation, approval-wait
parking, and transparent request-versus-park recovery remain required before
claiming the complete scale-to-zero product experience.

Hosted file limits are explicit: at most 24 MiB per object, 34 MiB per upload
transaction, 100 pointers. This executable caps ingress at 8 MiB per attachment,
12 MiB per import and 32 attachments so both Event/workspace copies fit atomically.
Other Runtime builds retain their existing limits. Over-capacity fails, never
truncates or silently acknowledges local-only data.

## Explicit capacity and rollout boundaries

Current protocol limits are 1 MiB per encoded record, 8 MiB per atomic commit and
50,000 distinct changed records. Snapshot pages are bounded by both rows and UTF-8
bytes. Over-capacity operations fail atomically before acknowledgement; nothing
is silently truncated, split into separately visible commits or written locally.
These are physical backend admission limits, not changed Context semantics.

The current replica reconstructs the complete Agent store at cold start. A hosting
deployment must budget memory for that state. Large-state paging/partial replicas,
explicit schema migration/export, capacity/load canaries, authenticated Container
provisioning, R2 objects and production rollout belong to the subsequent deployment
stage. This backend alone is not authorization to switch production storage.

## Local gates

The Cloud repository's `test/runtime-store-server.mjs` starts a temporary real
workerd SQLite service and prints `MORPHZ_TEST_REMOTE_STORE_URL`. No cloud account,
Provider credential, Docker daemon or production instance is used.

With that variable set, run:

```sh
cargo test -p morphz --features remote-store --test runtime_store_conformance -- --include-ignored
cargo test -p morphz --features remote-store --test remote_store_recovery -- --ignored
cargo test -p morphz --features remote-store --lib
cargo clippy -p morphz --features remote-store --all-targets -- -D warnings
cargo fmt --all --check
git diff --check
```

The upstream conformance suite includes native Context/Event/Session projection
atomicity plus the existing Session, ingress, scheduler, Thread, Objective, Job,
Edge, approval/lease and Provider cases. Fault gates cover cancellation before and
after commit, response loss, fresh Rust processes with no local database, actual
Runtime startup/response delivery, and a blocked operation exceeding the real
30-second Cell lease while independent renewal continues. Cloud tests independently
cover ownership migration, stale retry rejection, rollback, workerd restart,
precision, bounded pagination and capacity errors.

### Verified on 2026-09-07

- Morphz lib with `remote-store`: **1,277 passed, 7 existing ignored**.
- Unified conformance: **8 reported passed**; the six local/remote cases executed,
  while the two conditional PostgreSQL cases returned without an external URL.
  This run does not claim a fresh PostgreSQL deployment test.
- Real remote recovery suite: **4 passed**, including fresh Rust processes,
  commit-response loss/cancellation, actual Runtime delivery, and a 32-second
  blocked operation with independent renewal of the real 30-second Cell lease.
- Cloud suite: **69 passed**, including **29** Agent Cell tests against workerd.
- Clippy `--all-targets -D warnings`, formatting and diff checks passed. Cloud
  type checking, isolated Agent Cell dry-run and existing control-plane dry-run
  (`--containers-rollout=none`) passed. No Docker image build or deployment ran.

### Verified on 2026-09-08 (hosted configuration/credentials)

- Rebuilt native `morphz-runtime-host` with `remote-store`.
- Full Rust library: **1,283 passed, 7 existing ignored**.
- Clippy `--all-targets -D warnings`, fmt and diff checks passed.
- Cloud full suite: **114 passed / 19 files**, with the latest native host supplied;
  its cross-repository test executed rather than being skipped. It includes local
  D1/workerd and isolated PostgreSQL, credential scope/audit, encrypted configuration,
  Provider setup/probe, SIGKILL/empty-cache recovery and stale-owner rejection.
- TypeScript and hosted Worker dry-run passed. Provider HTTP calls used only a
  synthetic loopback service. No real model spend, cloud deployment, Linux image
  build, existing Agent migration or production data access occurred.

### Verified on 2026-09-08 (native idle parking and timer wake)

- Full Rust library with `remote-store`: **1,286 passed, 7 existing ignored**;
  Clippy all targets with `-D warnings`, fmt and diff checks passed.
- Cloud full suite: **119 passed / 19 files**, including all three native-process
  gates, local D1/workerd and an isolated temporary PostgreSQL cluster. The
  durable Schedule gate was run again after strengthening its repeated-alarm
  assertion: the child still has exactly one Activation after replacement.
- TypeScript and hosted dry-run passed; no Linux image or real cloud deployment.
- The first restricted test run could not bind loopback ports or run nested
  Seatbelt. The full suite passed in the local test environment allowing both;
  no production access or real Provider credentials were involved.

Builds use a separate temporary target with incremental/debug artifacts disabled;
the current verification cache is about 5.3 GiB, not a full-size debug target.
