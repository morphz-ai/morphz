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
OAuth service test or a Cloud deployment. Audit retention, key recovery and real
platform gates remain required.

OAuth refresh now captures a SecretStore value/version snapshot after claiming
its refresh lease. The Cloud backend publishes with that captured generation,
not a head fetched just before the write. Authenticated generation is preserved
only across key rewrapping; writes, metadata changes and login advance it, and
deletion leaves a tombstone. The Worker can retry physical CAS across rotation,
but never across a changed logical value. Expected generation conflicts preserve
the newer credential without marking compute ownership lost. Account status is
published through its own revision CAS and checked again before authorization;
late refresh responses cannot undo operator disable/logout or invalidate a new
login. Refresh lease ownership is revalidated before publication.

Local backends use the same SecretStore lock, retaining explicit backend selection
and environment-bootstrap first publication, with an in-process catalog revision
preventing bootstrap ABA. This is not a cross-process local credential CAS. Cloud
never falls back to the process environment and requires authoritative versions.
The private Agent Cell envelope is unreleased and has no legacy dual-read path;
ordinary local configuration/catalog formats are unchanged.

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

The hosted gateway closes the readiness/park race with a private admission
reservation. `POST /_morphz/host/admission` requires Operator authentication;
it returns a random 256-bit process-local reservation, valid for 30 seconds.
At most 64 reservations can be outstanding. They pin idle compute, are consumed
once through `x-morphz-host-reservation`, and expire without creating durable
work. They are not message receipts or permission grants: the business request
still needs its original Principal/Node authority. The route exists only on the
opt-in hosted server. An expired/reused reservation returns 409 before dispatch.

Only the payload-free handshake is retried. The gateway never buffers, clones
or replays a business body, never accepts a caller-selected container port, and
does not use the container SDK's implicit restart with missing per-Agent env.
A lost business response has an unknown outcome; recovery uses the native
idempotency receipt instead of an automatic transport replay.

The native check rejects active Activations, Jobs, Plans, Signals, deliveries,
runnable Objectives, assignments/delegations, claimed/due timers, projection
work and live Provider refresh leases. It exports the earliest future native
timer to Cell `park`, which atomically verifies the exact RuntimeStore revision,
due ingress and ownership, saves the deadline, then fences the old process.
Only a positive park receipt permits exit 0. Ambiguous authority failures exit
nonzero and recover; they never reopen admission with a potentially stale fence.
This is also enforced at the Store boundary: once the park RPC starts, its RAII
decision guard fences the client on error, cancellation or success. Only an
explicit `parked: false` receipt leaves the old owner usable. Failure before
submitting park does not invalidate otherwise valid ownership.

### Observer delivery boundary (transport not yet connected)

`host_observers` supplies a pure local delivery queue and a one-time installable
park barrier, bound to that Store's exact compute owner and epoch; it has no URL,
credential, socket or transport implementation.
The opt-in hosted executable does **not yet** install a publisher or replace its
existing WebSocket admission guard. This is a tested prerequisite, not a claim
that the complete Cloud observation path or scale-to-zero UI has shipped.

Each cycle retains exact batches until their matching epoch/sequence receipts.
Failed, mismatched or ambiguous acknowledgements cannot consume a batch or reuse
its sequence with changed content. A cycle certifies the durable append frontier
only after its last batch is acknowledged. Startup requires an acknowledged reset;
non-Session facts require an empty checkpoint; oversized events require a reset
for durable API resynchronization rather than truncation. Opt-in model request
diagnostics never enter observer batches. Bounds are 64 events and 128 KiB per
batch, with at most 64 durable facts and 64 drafts per staged cycle.

While holding the native replica mutex, `try_park` freezes the shared queue and
checks the actual Event Store append sequence, not producer timestamps or an
empty-channel heuristic. Queue staging uses that same freeze lock. No new cycle,
publication or native write may cross the park decision. Busy/preflight rejection
releases the freeze; a successful or ambiguous park permanently closes it.
Process-local activity is rechecked after the frontier read. New Event Store
facts, pending resets and even ephemeral-only unacknowledged batches defer park.

Socket-free regressions exercise the real Store, native SQLite replica/journal,
and restore path against a fault-injected fenced authority. They cover late and
backdated commits, a write blocked across park, explicit busy, lost park receipts,
cancellation on both sides of commit, and a newer owner's recovery without lost
or duplicate facts. They do not substitute for real Cloud delivery, Session
authorization, host-exit/socket survival or three-platform product gates.

Local workerd/native-process gates cover drain, orderly idle exit, cache-free
replacement, and a real `schedule_tx` durable Objective/Thread whose native
deadline fires a DO alarm and starts replacement compute without another user
request. A further native-process gate holds a real park commit, observes native
503 admission, restores a replacement host from an empty cache, reserves across
the idle timeout, and sends the original business message once. Duplicate message
IDs return the same receipt; reservations cannot be reused or bypass business
authorization. This is not a deployed Linux Container gate. Open WebSockets and
active approval waits currently retain compute; frontend/Edge hibernation and
approval-wait parking remain required before
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

### Verified on 2026-09-08 (conditional OAuth publication)

- Final Rust library: **1,291 passed, 7 existing ignored**, including held refresh
  races against login, logout, disable, failed old refresh and replacement lease
  owner; local scope/delete/reauthorization and environment-bootstrap ABA tests.
- Real Rust→workerd recovery: **5 passed**, including an external credential
  mutation bypassing the host catalog, authenticated generation CAS, harmless key
  rotation, and expected conflicts that do not report compute ownership loss.
- Rebuilt native host; Cloud full suite **137 passed / 20 files**, with all four
  native-process gates executed. Credential cases cover commit-time races, same
  plaintext reauthorization, replay and forged generation.
- Clippy all targets with `-D warnings`, ordinary non-cloud `cargo check`, fmt,
  TypeScript and hosted dry-run passed. Synthetic credentials and loopback only;
  no real Provider spend, cloud deployment or production migration.

### Verified on 2026-09-08 (local observer frontier and park decision)

- Full Rust library with `remote-store`: **1,303 passed, 7 existing ignored**.
  The 12 added tests cover exact retry batches, final-cycle acknowledgement,
  explicit reset/capacity, owner/epoch binding, late/backdated native commits,
  the final process-activity check, a write blocked across park, cancellation
  before/after authority commit, lost receipts and cache-free owner recovery.
- Rebuilt `morphz-runtime-host`; Clippy all targets with `-D warnings` passed.
- Ordinary non-cloud `cargo check`, formatting and diff checks passed.
- Cloud full suite with that rebuilt binary: **149 passed / 21 files**, including
  all four actual native-process gates. This verifies that the park-decision
  guard preserves existing drain, wake, recovery and business-ingress behavior.
- The new observer queue/barrier remains unconnected to an outbound transport.
  Its tests use a socket-free authority with real native SQLite; the existing
  cross-repository host gates use local workerd and a synthetic Provider, not
  production credentials or paid model calls. Full product observer/Edge/approval
  integration and actual Linux/cloud deployment remain unverified.

### Offline recovery validation (2026-09-08)

`morphz-runtime-host --recovery-schema` prints the current native schema identity.
`morphz-runtime-host --verify-recovery` reads bounded NDJSON from stdin and validates
a staged backup in a fresh in-memory `Replica`. Both modes branch before HOME,
configuration, credentials, HTTP clients, lease acquisition and Runtime startup.
They neither replace an existing database nor execute imported work.

The `morphz-native-recovery/1` input is exactly one `header`, nonempty `page`
frames, one `end`, then EOF. A frame including its newline is at most 4 MiB;
each page has at most 500 records, the complete import at most 250,000 records
and 64 MiB of encoded record tuples. Tagged i64/blob values remain strings.
The header carries the schema, backup fingerprint, record count and SHA-256
chain. The initial digest is UTF-8 JSON `[protocol,schema,fingerprint]`; each
record extends it with `[previous,[table,key,values]]`. Object key order does
not participate in this contract.

Validation uses the existing native schema/migration identity, typed parameter
bindings and foreign-key checks. A partial page failure invalidates the verifier;
bad schema, migration set, digest, count, types, duplicates or trailing input
cannot produce a successful report. Diagnostics are fixed codes, not SQL or
imported data. Success is one JSON report on stdout (exit 0); failure has no
success report and exits 2. An initialized native schema is required; a Cell
that never ran a Runtime is not silently bootstrapped from an empty backup.

The report includes native quiescence observations (`capturedWork`,
`nextWakeAtMs`), always `executionAuthority: "none"` and
`requiresReconciliation: true`. Due timers are reported, never fired. These
observations are made at validation time; they are neither proof of effects after
the recovery point nor an authorization token. Safe publication must separately
reconcile later input/cancellation/revocation/effects, fence obsolete owners,
validate credentials/files and rebuild derived indexes. This is not yet an
operator command for restoring a running Agent or replaying old Jobs.

The matching Cloud private maintenance RPC emits these frames from a fully
staged recovery, without resolving plaintext credentials or contacting compute.
The cross-repository gate exercises the actual compiled CLI with no HOME,
endpoint or token, a native-generated Store, independent encrypted backup and
workerd staging; it verifies matching digests, rejection of tampering, no source
Cell change and no Provider requests. This is local synthetic evidence, not
live Cloud deployment or disaster-recovery completion.

Verification: **6 native recovery tests passed**; full library **1,313 passed,
8 existing ignored**. Cloud **176 passed / 24 files**, including all **5** real
native host gates. Clippy all targets (`-D warnings`), TypeScript, formatting/diff checks and hosted Worker dry-run
passed. No production database, cloud resource or real Provider was used.

Builds use a separate temporary target with incremental/debug artifacts disabled;
the verification cache is approximately 6 GiB, not a full-size debug target.
