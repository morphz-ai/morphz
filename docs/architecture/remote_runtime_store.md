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
unauthenticated Worker route. A future production compute adapter must resolve its
Cell from verified deployment authority before calling that primitive. The test
HTTP bridge and its fixed credential are test fixtures only.

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

Builds used a separate temporary target with incremental/debug artifacts disabled;
the verification cache was about 1.8 GiB, not another full-size development target.
