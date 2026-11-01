# Product read audit — 2026-11-01

> Latest authorization (2026-11-01): finish first-page, detail and collection
> demand boundaries, update and inspect the existing application while preserving
> live work, then commit and push. This supersedes the earlier no-push scope.
> Earlier failed runs and unfinished checkpoints below are retained as history;
> current acceptance is recorded in the final follow-up section.


Status: **in progress, candidate not deployed**. Validated local read-model
commits are `0c710e2b`, `66756062` and `96962e2a`. Startup recovery pagination
has also passed the focused validation recorded below. Remaining read owners
and original-app acceptance are still open.
This document is not whole-product acceptance. The root `AGENTS.md` is the
read contract for Runtime, Dashboard and Desktop.

## Failure being corrected

A control operation used to await general list reconstruction. A 50-Thread
parent limit did not bound its lifetime dependencies or other children; the
retained user trace measured approximately 13000 dependency rows and 2.5–12 s
reads. A list refresh was also reused across unrelated visible surfaces.
A row LIMIT after a lifetime sort is not an indexed page. An incomplete child
array is not evidence of completion, absence or a broken approval route.

## Candidate inventory

| Owner | Candidate contract | Verification / remaining boundary |
| --- | --- | --- |
| Dashboard page owner | Relevant socket invalidations; no healthy network interval; old Event pages remain reader owned | 297 tests, build and lint passed; original browser request counts and late-scope/control races remain to verify |
| Navigation / credential scope | Agent/Context/Session metadata pages, default 50/max 200; exact selected points; explicit continuation | Candidate 7 SQLite and owned PostgreSQL fixtures passed; Agent-filtered large-foreign-history coverage remains to broaden |
| Context/Session heads | Transactional Context recency and Session priority keys; independently capped ordered heads | Original clocks/permissions remain authoritative; candidate 7 physical budgets and retained migrations passed |
| Operator resources | Targets/nodes/leases/Objective-label pages, scope before LIMIT; exact known-resource controls | Selected SQL/lifecycle coverage exists; finish full current candidate validation |
| Scheduler dependencies | Required/pending current generation; exact aggregates/EXISTS for phase and invariant proofs | Never infer absence from a child cap; full current-work continuation and body-demand contracts still require review |
| Thread inspection | Separate Activation/Job/Signal/Schedule/model-history pages; exact Thread scope; question revalidation reads metadata | Child continuation response scope is checked; large Job request bodies are still a separate open issue |
| ThreadGroup inspection | Exact counters on collapsed parents; explicit 64-member pages and selected outcomes | Counters retain corrupt-tail diagnostics and mixed-revision pages fail |
| Pending approvals | Separate capped status ranges; raw timestamp key; exact known approval; native principal/binding checks | Operator paging is wired to explicit UI demand. Context/principal ordering indexes, native ownership checks and principal continuation passed candidate 7 SQLite/PostgreSQL fixtures |
| Desktop activity/history | Background current-only invalidations do not open retained history; visible Activity owns history | A scoped invalidation no longer opens unrelated Contexts, even after the 16-entry raw cache evicts them; preserved projections retain per-owner fences. Initial/explicit visible-history Context fanout and per-reader current-work continuation remain open |
| Desktop controls | Exact validated receipt publishes before coalesced reconciliation, including Schedule/Delegation | Preserve command identity/CAS, drafts, unknown outcomes and source proof; original-app verification pending |
| Platform task dispatcher | Subscribe before startup recovery; commit wakes; busy wakes retained; bounded 50-row worker rounds; failed-item backoff only | 15 selected tests passed, including former-interval idle silence and no starvation behind failed head items |
| Terminal view | Demand-owned metadata stream; selected output wakes screen only; hidden/idle view performs no periodic reads | 32-test selected Application run passed; new 14-test wire subset also passed (counts overlap). Native catalog source/equal-clock ranges now have indexed cursors. Host demand reads one physical source page (32 roots maximum and an encoded byte bound); the UI follows only on explicit More. SQLite and owned PostgreSQL pressure cases passed; original-app acceptance remains open |
| TUI | Native durable-change subscription replaces healthy 500 ms tail polling; Session directory loaded only when opened, explicit tail continuation | Release all-target check passed; behavior still needs current binary tests |
| Model identity / CLI directory | Principal/Agent predicates before directory LIMIT; CLI scoped `--last` uses a one-row seek; list has explicit cursor | Release all-target check passed; remaining legacy bulk APIs and other CLI/TUI collections still need inventory |
| Transcript search | Bounded Recall candidates; exact Event metadata and <=50 authorized Session points before bodies | Does not hydrate a whole Session directory to authorize a search |
| Startup recovery | Stable-ID 200-key policy/route/Context batches, live transfer/Activation locators, pending mailbox heads and orphan ownership EXISTS | SQLite and owned PostgreSQL recovery pressure fixtures passed; remaining per-Context invariant materialization must bound complete checks |

## Validation receipts

- Dashboard current source: 297 tests, zero skips; build and lint passed.
- Selected Application current/earlier stages: 49 activity/attention/observer
  tests and 15 dispatcher/hint tests passed; selected counts overlap. Terminal,
  mounted UI, workspace Host/transport and observer run: 32 passed/zero skips.
  A subsequent 14-test subset covers terminal metadata wire delivery and scope
  filtering, including idle silence; it is not an additional 14 unique tests.
- Rust candidate 5 library: **1758 passed, 2 failed, 18 ignored**. The failures
  were old hand-written query-plan expectations (a particular index name and
  an obsolete Context approval query). Tests now inspect the production
  builders and bounded physical work instead of accepting a lifetime sort.
- Release all-target check 9 passed. Candidate 6 exposed a real retained-Schedule
  hash join/sort over 10055 rows before LIMIT in PostgreSQL. Candidate 7 makes
  the ordered Schedule range drive the native scope point, without planner
  flags or post-LIMIT authorization.
- Candidate 7 source fingerprint:
  `98d89a168efd1e4ebc935d0640aa36352e86f9786de6d9411b4badfb286c1262`.
  Release build of the test executable passed; the focused SQLite and owned
  PostgreSQL cases passed, including physical budgets, scoped Approval pages,
  retained Schedule history and rollback. Full library: **1762 passed, zero
  failures, 18 ignored** (388.51 s). Native terminal metadata/wire tests passed.
- The widened Application run passed 67/71; four tests still expected a socket
  and historical catchup per Session. They now require one metadata socket,
  zero observer-owned Event-history HTTP, per-Session accepted cursors on a
  shared reconnect, and the original permission/identity-retirement proofs.
  All four corrected behavioral tests passed. The fresh combined run 21 passed all
  71 selected tests with zero skips. These source tests did not relax
  idle, grant, backpressure or late-response requirements.
- Dashboard source now has 297 passing tests; build/lint passed. Application
  build passed before the last observer payload-schema correction; a fresh
  production build subsequently passed (build 21). The UI detector scanned the seven changed
  surfaces with zero findings. This is not rendered original-app acceptance.
- All SQL tests use isolated fixtures; PostgreSQL is owned ephemeral storage.
  These are not original-app acceptance. A read-only original-window check
  confirmed the retained conversation and waiting ping. The four open terminal
  records all have expired leases from earlier Runtime owners; none has a live
  lease. No audit candidate was installed, pushed or released, and no user work
  was cancelled for this audit.

## Historical remaining work before the final follow-up

1. Finish per-reader Activity/current-work paging without querying every
   historically registered Context or hiding older live work. An arbitrary
   Context slice, a sticky `hasWork` flag, or a shared global UI cursor is not
   sufficient. Reconnect recovery and visible-page demand are distinct owners.
2. Enforce body/byte demand for Job requests and other large child payloads.
   Preserve annotation provenance and actual domain records; do not substitute
   fake empty requests to make a read look small. Inspect current dependency,
   Schedule and shared participant collections separately from history.
3. Finish original-app Terminal catalog acceptance. The candidate now has
   native creation-key seeks, a continuation bound to the exact Host/source
   page, and an explicit reader action. Native lease/security checkpoints are
   resource ownership work, not page refresh timers.
4. Review provider/account, delegation, content/Reader/script and remaining
   public/CLI collection paths against actual budgets and owners. Configuration
   and a single explicit full object are not licenses for directory bodies.
5. Bound the remaining startup/recovery/integrity materialization. Complete
   canonical checks must use indexed aggregates or bounded recovery batches,
   not silent truncation. Retire unused all-then-filter defaults.
6. Verify commit-notification delivery for in-memory Kernel transactions and
   PostgreSQL late commits below an already observed insertion sequence; do not
   mistake a notification or HTTP 200 for complete accepted Event delivery.
7. Finish adversarial physical-plan/row/byte tests, real request-count and
   reconnect/permission races, the UI detector and original-app inspection.
   Preserve the existing profile, staged attachment, model choices, original
   records and live work. Commit the focused validated result locally; no
   GitHub push or release is part of this request.

## Earlier follow-up validation / not deployed at that checkpoint

The fresh Application run 30 passed **88/88**, zero skips, including mounted
terminal continuation, URL-byte budgets, 1200-source bounded demand, 23-Context
invalidation isolation despite cache eviction, late control receipt fencing,
retired-Session freshness and unexpected per-owner projection failure. An
intermediate run exposed a real regression where removing a failed scope made
an empty array look complete; the production fence was corrected and the
original assertions retained. Terminal SQLite and owned PostgreSQL case 8
passed against 10000 foreign retained terminals with raw equal-clock cursors;
the PG sort input stayed bounded. The full case-8 library passed: 1762 passed, zero failures, 18 ignored (476.72 s).

A collapsed scheduler `include_job_details=false` mode passed its current validation.
It uses existing Job monitor metadata, exact route proofs and native activity
flags; it never fabricates an empty physical Job request. Existing focused Job
inspection still opens the original record. A 2 MiB healthy request fixture
checks unchanged counts/phase, explicit omitted-child bounds and intact original
bytes. This removes overview-owned Job bodies, not every remaining large-child
payload issue. Do not call all body/byte demand closed yet.

Case 9 source fingerprint is
`68ce5e8cb8b3c9a4ea9545452c1f5cf1dacff32bc50d2133563a439bdc2c900b`.
Its unchanged frozen native source passed the focused 2 MiB request case,
SQLite and owned PostgreSQL directory/continuation pressure cases, and the full
library: **1762 passed, zero failures, 18 ignored** (454.41 s). The test
executable SHA-256 is
`6d58bcecb4fd76af7f408e2ce47c685fffba0f09a77503913706af7ab22dc2de`.
Dashboard 297 tests/build/lint passed. The widened Application run 36 passed
**89/89**, zero skips, including selected-terminal metadata outside the loaded
catalog page and a healthy Objective control despite an unrelated unavailable
Context. The command does not wait for the reconciliation's JavaScript turn.
A follow-up original-profile read-only guard observed one live Activation, zero
live Jobs and zero nonterminal Objectives; Runtime was not switched or stopped.

## Startup recovery and concurrent-demand follow-up

Case 10 frozen native source fingerprint is
`94293306625a0fe7118d34a3e79b586c6dd59c2930d29df4bef64c802cf79788`
(219 files). Release test-executable construction and release all-target check
44 passed. The SQLite native pressure case passed in 2.13 s; the same owned
ephemeral PostgreSQL case passed in 18.47 s. These cases add 220 live Threads,
Activations and pending mailbox heads plus 10000 pending Signals for one Thread.
Seven-row locator pages advance without draining that mailbox; native ownership,
foreign scope, retained-index backfill, transaction rollback and physical plans
are checked. Exact source Events are opened only for the selected recovery
locator, not for every live Activation in a Context.

The Activity coalescer also keeps the exact requested Context coverage. A
concurrent history/current request for another Context cannot be absorbed by
the older in-flight read. After waiting, it retains its original scoped demand
rather than expanding to all registered Contexts. Application run 43 passed
**92/92**, zero skips; production build 44 passed. The complete case-10
frozen-native library run passed **1762 tests**, zero failures, 18 explicit
ignores (470.63 s). These ignores are not reported as passes.

Case 11 changes only the recovery-index backfill's post-update verification:
it checks the exact <=200 selected IDs rather than one arbitrary unresolved
global row. A missing parent in the selected page now fails that batch even
when another unresolved row lies outside it. Its native fingerprint is
`aed405b9fd78d91014d362d14ad4b29e4a2adfe0232e10fa47afa006f1613c15`
(SHA-256 of compact JSON containing the ordered 219 path/hash entries).
The frozen source passed release test-executable construction and release
all-target check 45, the SQLite
pressure case (2.15 s), the owned PostgreSQL pressure case (18.80 s), and the
65 selected recovery tests with zero failures/ignores (37.20 s). This is not a
claim of another complete case-11 library run.

An additional owned ephemeral PostgreSQL diagnostic exercised this exact
post-update query shape on 100000 Signal metadata rows, including 9800
unresolved rows outside its 200 selected IDs. The real plan used the missing-ID
index, with zero filtered lifetime rows and 403 buffer touches; it did not scan
the retained Signal table. This is a physical-query diagnostic, not original
Runtime latency or end-to-end acceptance.

No original Runtime, profile, draft, model or task was changed, and no GitHub
run is claimed.


## Final follow-up: implemented boundaries

- Each Activity reader owns immutable scope-bound coordinates. The visible head
  reads one authorized Context at a time; explicit More reads one selected
  Thread, Goal, Schedule or retained-history page. Sibling cursors, accepted
  summaries and newer control receipts survive partial pages. Native
  continuations omit Context-wide directory heads and mark that omission.
- Directory text is a preview. Goal statements, Thread contracts/results, input
  text, Job requests, dependencies and Group members do not expand merely
  because a parent row was selected. Exact requested bodies remain native
  records. Job headers omit arguments; opening technical detail authorizes one
  exact scoped request. No synthetic `{}` is used as a physical Job request.
- Current waits use revision/generation-fenced scalar heads with complete native
  EXISTS checks and explicit resource bounds. Detail dependency pages have an
  independent cursor. Missing coverage never means runnable, absent or complete.
- Jobs, approvals and terminals have independent raw-clock/native continuations
  within one authorized physical source/root window. Approval commands use an
  exact current approval point and its original fingerprint, independent of
  whether that row happens to be on a page. Native Delegation pages seek bounded
  status/role index ranges; directory payloads are explicitly previews.
- Session participants use exact counts and bounded samples. CLI Agent/Goal
  inventories expose continuations. Integrity/recovery page scalar witnesses and
  use indexed counters/EXISTS for complete checks, instead of materializing a
  whole Context graph. Unsupported Store fallbacks fail explicitly.
- UI reads wake from relevant commits, reconnect gaps, reader demand and explicit
  retry. In-memory Kernel commits wake the native subscription after acceptance.
  PostgreSQL tails remember exact invisible transaction identities so a late
  commit below an observed insertion sequence is not lost. A mirror claim is
  confirmed only after acceptance; a failed/in-flight mirror cannot consume a
  durable cursor. No healthy-period database or HTTP scanner was introduced.
- Existing CAS, command identities, grant/source rechecks, durable receipts,
  annotation argument matching and the scheduler's independent background
  ownership remain in force. Control receipts do not await list reconciliation.

### Validation checkpoint, 2026-11-01

At the implementation checkpoint, Dashboard build/lint and all 298 tests
passed. The Application production build and focused page, request, approval,
inspection and permission regressions passed. This checkpoint is not final
application acceptance; later commits require their own matching validation.

Actual integration subsequently exposed a SQLite tail query using PostgreSQL's
`sequence` column. SQLite now seeks its native `rowid`; a file-backed regression
covers an empty checkpoint, 10000 retained rows, nonlexical append order, large
bodies, exact page advancement and reopening from the accepted cursor. The
in-memory commit test uses cancellation, which actually persists a terminal
Event; pause changes a native row and must not fabricate an Event locator.

PostgreSQL concurrent ingress also exposed a Session/binding lock inversion.
Materialized Session-lock stages now precede binding checks in both fast
admission paths and the referenced/fallback path. The mandatory dedicated-PG
regression observes the real Session lock wait, then proves that the claimant
does not already hold the principal binding. The independent experiment's lock
is synchronized without changing dependency-audit exceptions.

Job headers retain the scalar identities needed for annotation provenance.
Only a matching visible intent requests an exact scoped argument proof: at
most 256 KiB for one Job and 1 MiB across a page, with each Job read once.
An oversized prefix is never a valid request and never passes argument
matching. The response carries no physical request; separate step-proof
incompleteness does not suppress an independently verified task title.
Terminal annotation fences read only the exact outcome sequence. Original
body assertions use an explicit authorized Thread read rather than restoring
full bodies to Activity lists.

Approval pages retain exact native authorization as correlated point lookups
with `LIMIT 1 OFFSET 0`. PostgreSQL cannot flatten that proof into a Job-led
join that sorts the authorized inventory before the page limit. The plan
fixture explicitly analyzes the completed native ownership relations instead
of depending on autovacuum timing; its row and sort bounds are unchanged.
The concurrent Approval checkpoint contract also forces a held-owner collision
and verifies the typed contention result, exact ownership rollback and one
explicit revalidation after the competing decision commits.

The final operator report and CI runs must identify their exact source commits
and distinguish complete inventories, explicit optional omissions, pressure
repeats and original-profile acceptance. No original task has been cancelled,
paused, re-sent or answered by this audit.
