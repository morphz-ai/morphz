# Product read audit — 2026-11-01

Status: **in progress, candidate not deployed**. The first validated read-model commit is `0c710e2b`; additional scoped Activity and Terminal catalog changes are still under validation.
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
| Startup recovery | Stable-ID 200-key policy/route batches and live transfer locators | Remaining orchestrator startup/integrity paths must bound materialization without truncating complete checks |

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

## Remaining work before closing this audit

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

## Follow-up validation / still not deployed

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
