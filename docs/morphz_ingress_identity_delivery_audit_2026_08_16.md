# Morphz Message Ingress, Identity, Session, and Delivery Audit

Date: 2026-08-16
Status: completed; confirmed findings fixed and regression-tested

## Scope

This audit follows one directed user message from an authenticated ingress through Principal and Session authorization, durable message claiming, dialogue interruption, Thread scheduling, reply persistence, delivery aggregation, WebSocket replay, and restart recovery. It covers SQLite and PostgreSQL, concurrent Runtime workers, Trusted Gateway mode, and the built-in operator Dashboard.

## Required invariants

1. **MID-I01 — Authenticated identity precedes routing.** An external Principal is established before selecting or mutating a Session. Request content cannot override the authenticated Principal.
2. **MID-I02 — Session ownership requires authority.** Creating, reviving, or migrating a Principal/Session binding requires an explicit authority or ownership proof. Knowing a Session ID is never sufficient to claim its history.
3. **MID-I03 — Idempotency binds immutable intent.** `(session_id, client_message_id)` identifies exactly one immutable request: Principal, normalized message text, attachment identities, and exact Harness binding. An exact replay returns the original Event; a mismatched replay is a conflict.
4. **MID-I04 — Ingress is one durable commit.** Accepting a message atomically commits the persisted Event, its exact Dialogue Thread Signal, Session activity/attention changes, and any dialogue interruption. Notification is only an optimization after commit.
5. **MID-I05 — Authorization is checked at commit.** The Session must still be active and bound to the asserted Principal in the same transaction that claims the message; preflight checks alone are insufficient.
6. **MID-I06 — Interruption has a physical boundary.** A consecutive message may supersede model-only work, but cannot silently cancel work after physical execution has begun. FIFO and replacement lineage remain durable and explainable.
7. **MID-I07 — Logical replies are exactly once.** A logical assistant reply is appended once and atomically covers its completed Threads. A retry after persistence must deliver the existing reply rather than re-evaluate it.
8. **MID-I08 — Transport replay is stable.** Transport delivery may be at-least-once, but it uses stable Event identity/cursors so clients can deduplicate and resume without gaps.
9. **MID-I09 — Delivery timers are fenced.** Merge-window and max-wait timers are generation-fenced; every eligible completion is covered once despite racing flushes, retries, and restarts.
10. **MID-I10 — Reconnect is projection-based.** A Dashboard reconnect reconstructs durable dialogue and current model-attempt state, then consumes a gap-free incremental suffix. Ephemeral WebSocket state is never the sole source of truth.
11. **MID-I11 — Attachment lifecycle is bounded.** Durable Events never reference missing bytes, and rejected, duplicate, or failed ingress cannot create unbounded unreferenced blobs.
12. **MID-I12 — Backends and workers are equivalent.** SQLite and PostgreSQL preserve the same authorization, idempotency, ordering, fencing, and recovery semantics with one or multiple Runtime workers.

## Verification matrix

| Boundary | SQLite | PostgreSQL | Multi-worker / reconnect |
| --- | --- | --- | --- |
| Exact idempotent replay | required | required | concurrent replay |
| Mismatched idempotency replay | required | required | concurrent conflict |
| Principal binding at commit | required | required | binding/status race |
| Legacy Session migration authority | HTTP test | HTTP test | opaque proof reuse |
| Consecutive-message interruption | required | required | competing claimers |
| Reply persistence and Thread coverage | required | required | competing flushers |
| Merge/max-wait Timer fencing | required | required | restart after claim |
| WebSocket snapshot + suffix | n/a | n/a | reconnect/lag recovery |
| Attachment durability / orphan cleanup | filesystem + DB | filesystem + DB | concurrent same digest |

## Findings

### MID-F01 — Idempotency key did not bind request content (fixed, critical)

Both stores currently make `(session_id, client_message_id)` unique but persist only `event_id`. A replay with another Principal, text, attachment set, or Harness returns `Existing` and is reported as a successful duplicate. The transport identifier therefore does not identify immutable intent and can hide caller bugs or cross-request substitution.

Correction: both stores now persist a versioned immutable-intent fingerprint. It binds Principal, normalized text, ordered attachment identity, and exact Harness while excluding generated Event IDs, timestamps, and physical storage paths. Exact replay returns the original Event; a mismatch returns a typed conflict. Legacy rows derive and backfill the fingerprint from their immutable Event. SQLite and PostgreSQL conformance covers exact, mismatched, and concurrent competing claims.

### MID-A02 — Trusted Gateway owns legacy Session migration authority (audited, accepted)

`POST /api/sessions/:session_id/principal` is deliberately authorized by the Gateway's service credential, not by an end-user credential. The documented trust contract requires the Gateway to read its authoritative `users.id → morphz_session_id` mapping before calling the endpoint; public browsers never receive the service token. Under that boundary, an additional Morphz-issued ownership proof would duplicate the trusted ingress authority rather than strengthen it.

No code correction is required. The service token must remain distinct from the Dashboard token, must never reach a browser, and the endpoint must continue to reject default-mode calls. A future partially trusted or browser-facing ingress would require a one-time claim grant instead of reusing this API.

### MID-F03 — Session status and Principal binding were preflight-only (fixed, high)

`SessionHandle::send_as_principal...` reads Session status and verifies the binding before calling `claim_message`. SQLite additionally reads the Session outside its claim transaction; PostgreSQL locks the Session but does not check `status` or the binding in that transaction. A concurrent archive or future unbind can therefore accept a durable message after authority has changed. The orchestrator may reject it later, leaving an accepted user message that cannot run.

Correction: `claim_message` now locks/checks the authoritative active Session and Principal binding in the same transaction as the request claim, Event, interruption, and Thread Signal. Retry-in-place applies the same commit-time checks. Preflight remains only as a fast error path. Session creation likewise revalidates Context, Principal, parent Session, and parent binding inside its creation transaction.

### MID-F04 — Attachment writes preceded final ingress claim without ownership (fixed, high)

Attachment bytes are persisted before exact Harness validation and before the durable idempotency claim. An invalid Harness, a mismatched duplicate, or a database error can leave unreferenced content-addressed blobs. Writing first protects accepted Events from missing bytes, but the rejected path has no transactional lifecycle or garbage collection.

Correction: exact Harness and transport-neutral request fields are validated before attachment persistence. Message attachments now use a shared content blob, an Event-owned hard link, and a durable pending manifest. Accepted Events remove only the manifest; duplicate, conflict, forbidden, inactive, and store-error paths remove only their candidate Event reference. Startup and periodic recovery wait a configurable multi-worker grace period, check the immutable Event by exact ID, finalize committed manifests, and remove orphaned references/blobs. The periodic task holds only a weak Runtime reference and closes the immediate-restart defer window without keeping a stopped Runtime alive. Recovery work scans pending imports only, not retained attachment history. Tests cover identical concurrent content isolation, normal discard, live-worker grace, orphan recovery, committed recovery, and HTTP idempotent replay with attachments.

### MID-F05 — Transport-neutral message IDs were not validated (fixed, medium)

The HTTP adapter validates `client_message_id`, but the public Rust SDK and Runtime Session handle accept an empty or arbitrarily large identifier. The database key is therefore exposed to ambiguous empty identities and unbounded index growth whenever a non-HTTP adapter submits messages.

Correction: Runtime and SDK now enforce one shared 1..=128-byte ASCII identifier contract with the stable `A-Z a-z 0-9 - _ . :` alphabet. Invalid IDs remain typed as invalid arguments across transports.

### MID-F06 — Gateway authentication reached unscoped operator endpoints (fixed, critical)

`is_authorized` accepts either the Dashboard/Operator token or the Trusted Gateway service token. That is correct only for Principal-scoped data-plane endpoints. A large set of handlers then performs no Principal authorization at all, including global Recall maintenance, inference configuration, approval decisions, Context scheduler and Event History inspection, Thread control, schedule mutation, and Delegation control. A trusted identity Gateway can therefore become a Runtime operator even though the configuration and public contract explicitly separate those credentials.

Correction: unscoped Runtime, Recall, inference, approval, scheduler, Event History, Thread, schedule, Delegation, credential, and provider-control endpoints now require operator authorization. Principal data-plane endpoints retain asserted-Principal resource fencing; device routes retain their device-token protocol. Context creation and explicit legacy Session migration remain intentional Gateway authorities. Objective mutation now authorizes through its coordinator Session for Gateway callers. HTTP tests prove the Gateway cannot cross into operator APIs or mutate another Principal's Session/Objective.

### MID-F07 — Delivery recovery and batch snapshots were unbounded (fixed, high)

Startup recovery reads every Session with pending delivery. A Session flush then reads every pending/deferred Thread and embeds all Thread and result Event IDs in one persistent Timer payload. The deterministic renderer's small-batch limits only choose whether another model is used; they do not bound the Delivery Composer input, Timer row, allocation, or query. One long-offline or adversarial Session can therefore create an arbitrarily large Timer and model request, while a large database can make startup recovery unbounded.

Correction: delivery snapshots have a configurable item cap, prioritize pending before deferred results, and keep exact `covers` identities. Startup recovery is paged and excludes Sessions that already have an armed or claimed delivery timer. Both the model-composed and deterministic fast paths re-arm the next generation until the backlog drains. Tests cover capped snapshots, continuation, merge/max-wait fencing, restart, and competing flush semantics.

### MID-F08 — Session creation validated its parent route outside the commit (fixed, high)

Both backends check Principal existence, Context/Agent compatibility, parent Session route, and the caller's parent binding before the Session creation transaction. The transaction itself only inserts the Session, mount, and initial binding. A concurrent Context/parent archive or future binding revocation can therefore race a successful child creation. The code also permits a new active Session under an already archived Context or parent Session.

Correction: SQLite and PostgreSQL now lock/revalidate the active Context, Agent route, Principal, optional active parent Session, and parent binding in the same transaction that creates the Session and its initial binding. SQLite obtains the writer slot before authority reads, preventing a deferred read-to-write upgrade race.

### MID-F09 — PostgreSQL message retry inverted the ingress lock order (fixed, high)

Normal message claim locked Session before Thread/Activation, while retry-in-place locked Thread before Session. Two concurrent operations against one Session could therefore deadlock despite each transaction being individually fenced.

Correction: retry-in-place now takes the Session lock first and then the Thread lock, matching normal ingress. Existing-Event idempotency remains checked before lifecycle rejection so exact committed retries are still replayable. The real PostgreSQL conformance suite exercises the corrected route with two Runtime workers.

### MID-A03 — Consecutive-message interruption respects the physical boundary (audited, accepted)

The interruption transaction only cancels a running Dialogue Activation while `dialogue_lane_released_at IS NULL`. Selecting non-maintenance tools durably sets that field before physical execution and wakes the next dialogue lane. The replacement Thread, cancellation, claimed-Signal reassignment, new Event, and new Signal share one transaction in both backends. This matches the intended rule: model-only work may be superseded; physical work continues concurrently.

### MID-A04 — Principal namespace takeover is fenced (audited, accepted)

Principal IDs are opaque provider subjects rather than Session-style resource identifiers. `ensure_principal` preserves the first provider binding and rejects a different provider attempting to reuse the same global Principal ID. Trusted Gateway requests cannot choose their provider namespace; it is fixed by host configuration. This is consistent with the current single configured identity-provider model.

### MID-A05 — WebSocket reconnect has a durable suffix path (audited, accepted)

The server subscribes to the live broadcast before producing the current model-attempt snapshot. Session-scoped Gateway connections authorize the Principal/Session binding before upgrade. Broadcast lag closes the socket instead of silently skipping Events; Dashboard and SDK reconnect paths discard transient drafts, reload persisted Session Events by Event sequence, and then resume live consumption. The global stream remains an explicitly trusted host-to-host operational surface and is not a browser credential.

### MID-A06 — Morphz owns logical delivery, not channel acknowledgement (audited, accepted boundary)

Morphz atomically persists one reply Event and exact Thread coverage. HTTP/WebSocket delivery is intentionally replayable and at-least-once with stable Event IDs and Event sequence cursors. A WeChat or other channel adapter owns its provider-specific send receipt, retry, and acknowledgement event history; treating a socket write as a provider ACK would be incorrect. The connector contract must deduplicate by Morphz Event ID and resume from its durable cursor.

## Final verification

- `cargo fmt --all -- --check`
- `git diff --check`
- `cargo check -p morphz --all-targets`
- `cargo clippy -p morphz --all-targets -- -D warnings`
- `cargo test -p morphz`: 792 library tests passed, 6 explicitly ignored live/manual tests; all binary, integration, handoff, store-conformance, and doc tests passed.
- Real PostgreSQL 15 conformance with `MORPHZ_TEST_POSTGRES_URL`: passed, including the two-Runtime-worker cases.
- SQLite store conformance: passed, including cross-process CAS, exact/mismatched/concurrent message claims, Session lifecycle fencing, interruption, delivery, and recovery.
- Targeted HTTP tests: Trusted Gateway/operator separation, cross-Principal Session/Objective fencing, attachment-bearing exact replay, mismatched replay conflict, and reply routing passed.

## Performance and operational result

- Message claim adds one indexed Principal-binding read and one fixed-size fingerprint; it does not scan Event history.
- Legacy idempotency rows perform one exact indexed Event read once, then persist the fingerprint.
- Delivery recovery pages through eligible Sessions and snapshots a configurable bounded number of Threads per Timer generation.
- Attachment recovery scans only interrupted pending manifests. Accepted attachment history is never walked at startup.
- Shared attachment bytes remain content-addressed and hard-linked into Event-owned references, preserving physical deduplication on the supported Unix deployment filesystems.
- The pending-import grace defaults to one hour because the protected interval is only local persistence plus database claim; it is configurable for unusually slow/shared storage and prevents a restarting worker from reclaiming another worker's live import.

No confirmed finding remains open in this audit scope.
