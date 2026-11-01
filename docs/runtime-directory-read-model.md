# Runtime navigation directory read model

2026-11-01. Corrective read work, not a new task/permission authority.

## Ownership and ordering

Agent, Context and Session records remain authoritative. Principal participation
remains the current `session_principal_bindings` row; a projection never grants
access. Directory pages contain metadata only, not seed, Mind or Event bodies.
Agent/Context navigation retains `updated_at DESC, id ASC`; Session navigation
retains `last_activity_at DESC, id ASC`. A page must not change this ordering to
an arbitrary ID prefix just to make its query appear bounded.

A Principal-specific Session page must seek that Principal's ordered range,
not scan global Session activity or sort the Principal's lifetime registry.
Add derived directory Context/activity/status columns to the existing binding
row. Database triggers copy the authoritative Session metadata in the same
transaction when a binding is created/rebound or Session activity/status changes.
The derived fields are not public write parameters, permissions or task state.
SQLite mount liveness is still checked against the actual mount; PostgreSQL
uses its native Session row. Unbinding removes read eligibility through the
authoritative `unbound_at` predicate. Deletion retains existing FK semantics.

## Query and continuation contract

Pages default to 50 and enforce a maximum of 200 rows plus one sentinel.
Explicit metadata point batches accept at most 50 IDs and return only the
requested authorized rows; an empty explicit selection does not scan a head.
Context directories can be scoped to their actual Agent, and Session directories
to the actual Context/Principal. No continuation is followed automatically.

The opaque cursor stores the exact raw database sort key and ID. Parsing a
timestamp into a normalized string must not change its comparison against old
persisted timestamp spellings. Scope/authorization are checked independently on
every page; the cursor is not authority. Metadata may change between pages:
committed invalidations refresh the relevant head/identity, and loaded rows
merge by identity without moving the reader to a different selection.

## Persistence, migration and validation

The new fields are a Runtime-owned read index within the existing binding
transaction domain, not another store or a renderer snapshot. Install trigger
maintenance and backfill retained rows in indexed, bounded keyset batches. Do not
rewrite original binding/Session IDs, permissions, times or business bodies.
Create covering indexes for global, Context and Principal activity ranges in
both databases. Preserve rollback and existing mutation/CAS semantics.

Tests must exercise fresh and retained schema paths; first/next/last pages;
equal/raw timestamp keys; metadata points outside the head; large foreign and
archived histories; bind/rebind/unbind, Session touches and transaction rollback;
actual SQLite/PostgreSQL plans without forced planner settings; and untouched
full object bodies. Browser tests must cover selected-identity retention,
explicit loading more, stale-scope responses and no healthy-period reads.

Implementation/acceptance status belongs in `bounded-page-read-audit.md`.

## Context activity, operator inventories and grouped children

The Context overview activity order previously computed a correlated latest
Session clock for every Context before sorting. `directory_activity_at` now
records that same maximum in the source transaction, maintained for Context
and Session inserts, updates, moves and deletes. It has its own bounded
backfill and global/status recency indexes. Original Context timestamps and
bodies remain unchanged.

Navigation continuation splits the equal-time tail and strictly older range
into separately indexed, separately limited branches. Only these bounded
candidates are merged; a deep equal-time cursor must not walk its earlier
prefix. Target visibility likewise selects owned and shared ranges before a
bounded merge, rather than filtering a foreign global prefix in memory.
Node, lease and credential-scope inventories have independent page contracts.

Collapsed ThreadGroup parents read exact indexed member counters for invariant
checking, without reading all member/outcome bodies. Expanding one Group owns
its 64-row `(ordinal, thread_id)` page and the outcomes for those selected
members. A changed Group revision rejects a mixed page. Corrupt counters and a
pending required tail still produce the original integrity violations; partial
member arrays are never treated as complete.

## Durable invalidation ownership

The server's cross-process Dashboard Event tail used a healthy 500 ms database
poll. Replace that timer with a retained Store change subscription installed
before the initial head read. SQLite uses the mature notify native watcher on
the database parent (database/WAL content, creation and rotation; exclude SHM
and access-only events). PostgreSQL uses commit-visible LISTEN/NOTIFY through
the existing schema-scoped listener and exposes reconnect gaps with try_recv.
Neither hint contains task authority. Each real change/gap owns a 256-row
sequence continuation; failure alone owns retry backoff. Local EventBus remains
the low-latency path. Task routing continues without any UI subscriber.

Pending approvals have their own ascending `(created_at,id)` metadata-key
continuation and a status-leading pending index. Each pending status seeks
its own capped range before a bounded merge; an IN predicate must not rank the
whole live inventory before LIMIT. The operator list returns at most 50 by
default, 200 maximum plus one sentinel; retained raw timestamp keys are preserved.
A known approval is an exact ID read, including reusable-allow validation.
The Application retains an opaque next cursor internally and reads one more
page only on the authorization panel's explicit demand. It never silently
claims an incomplete inventory is an empty authorization inbox.

Startup policy initialization and Session route/permission restoration consume
stable-ID metadata batches (200 rows plus a sentinel) through the same native
read boundary. They are explicit startup recovery work, not a screen painting
an entire directory. Activity updates cannot move an unread ID behind a recovery
cursor. The picker HTTP conversion keeps its original activity order.

Artifact Transfer startup recovery now seeks live transfer Thread IDs and live
Activation IDs in separate 200-row metadata batches. The latter joins the exact
root Thread before returning a locator. It no longer loads every Context seed,
every open Thread body and every live Activation body just to find transfers.
Each selected Job/result still passes the original exact validation and durable
finalization; missing identities remain errors, and duplicate repair is idempotent.

## Further read boundaries in the current candidate

Agent-filtered participant pages also maintain `directory_agent_id` on the
binding. All caller filters still check the original Session; filtering a
Principal's whole ordered range after fetching it is prohibited. CLI `--last`
now seeks one already scoped Session, and the model's `principal.list_sessions`
returns an explicit metadata cursor instead of reading then filtering a registry.

Session priority is a disposable ordering key for current-work heads. Source
transactions update it when real Goal/Activation/Job/Thread/dependency state
changes; it does not mutate original activity clocks, control state or model
selection. Context/Session heads merge only independently limited ranges.

Context/principal Approval keys point into the corresponding native pending
range. Native Job ownership, active Session membership, current binding,
Thread lifecycle and Activation status are still checked before LIMIT. These
keys do not authorize a decision. Participant pending requests have their own
explicit cursor rather than requiring a decision on the first 100 requests
before the rest can be discovered.

An exact Thread inspector exposes independent child continuations. Exact native
activity flags retain the current phase even when a Job is outside the loaded
page. A pending approval missing from that page requires a bounded native route
proof before reporting it as orphaned. Question revalidation does not own the
Thread's historical children. Large request-body demand is still open; a child
row limit alone does not settle that contract.

Terminal output uses a bounded native metadata bus, with an explicit resync on
lag. Output bytes stay in the PTY screen/checkpoint and do not enter Event
history or workspace navigation invalidations. A selected terminal observation
uses existing Host, project and native resource authority, the common
Local/HTTP/remote Desktop stream transport, and coalesced change frames. Only
the active visible reader opens a screen; another terminal's output does not
refresh it. Resource lease/security checkpoints remain independent of UI demand.
Terminal catalog continuation and legacy source fanout are separately open.
