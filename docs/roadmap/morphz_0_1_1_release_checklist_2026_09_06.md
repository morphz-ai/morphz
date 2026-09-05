# Morphz v0.1.1 release checklist

Status: autonomous publication reauthorized, pending completed fixes and gates.
The user's latest instruction is: "我先去睡了，你确定相关问题都修复后，就发布下一个版本。
自主完成。" This supersedes the earlier request not to rush a tag. Obtain a fresh
development handoff and pass candidate review, regression tests and exact-SHA
CI before autonomously publishing v0.1.1; no further publication confirmation is
needed. This is not permission to skip unresolved defects or modify production
data. No tag, Release, push, or deployment has yet been made by the release task
during this preparation. The prepared release body is
`docs/releases/v0.1.1.md`. The tag workflow
will use it instead of generated notes, so the upgrade boundary is present at
publication, not added afterward.

## Ownership and scope

- Authorization provenance: the newest user message is `item-1` in release
  task turn `01a0730b-9516-7132-8bd3-580edb2a4822`, started at Unix timestamp
  `1788636534`. `read_thread` verified its explicit instruction to publish
  autonomously after fixing the issues. An initial coordination message was
  rejected because the permission reviewer treated the older hold as current;
  after verifying the latest user message, the corrected coordination and
  heartbeat update succeeded. Do not infer that the earlier hold still blocks
  publication after the required gates.
- The user delegated the development follow-up, pair review, and release to the
  `开源` task (`01a0200f-af5f-7a52-a9a1-435f9bfc5a15`).
- The `开发` task (`019fc54e-24ff-7b13-b358-c0f0cac3e746`) handed off its completed
  scheduler fix as `245cab7bda503ede0d0edd552e3b00aa397831e1`. A subsequent
  steering-continuation issue is under diagnosis; that earlier handoff does not
  establish current release readiness. Production instance/data recovery still
  requires separate authorization.
- The release task owns version preparation, candidate review, CI, the tag,
  public artifacts, and post-publication verification. Preserve v0.1.0 and
  include both Morphz and morphz-edge in the normal release bundles.
- An active ten-minute follow-up (`morphz-v0-1-1`) is attached to the release
  task. Its prompt has been updated to the latest authorization: review and
  validate first, then autonomously commit/push/tag/publish and verify public
  downloads. Pause it after delivery; do not create a duplicate release run.

## Latest development handoff

Development completed and committed the unified scheduler fixes as
`0e0aefd38a414b02a9e32df47ca571559d9b8532` (parent `245cab7b`). It has released
shared-checkout build ownership to the release task. No known scheduler blocker
remains in its handoff; candidate-wide checks and CI are still required.

Verified handoff logs are in `/private/tmp/morphz-scheduler-final.UJQ6XY`:

- `lib-verified.log`: 1273 passed, 0 failed, 7 ignored.
- `integration-verified.log`: attempt-loop 76, Objective Group handoff 1, Store
  conformance 6 passed. Development explicitly supplied an isolated PostgreSQL
  URL; PostgreSQL was exercised, not treated as a skipped success.
- `pg-steering-verified.log`: the ignored PostgreSQL directed-input/question
  race was run explicitly and passed (1 test).
- `receipt-boundaries.log`: 2 real continuation chains passed, including
  receipt liveness over three heartbeats and ContextLimit/tool-denial closure.
- Development reports exit 0 for strict lib/tests Clippy, formatting, diff
  checks, Dashboard 218 tests/build and browser open/idle control checks.

`receipt-before.log` preserves the deterministic pre-fix receipt timeout.
`lib-final.log` is the rejected-environment run (48 listener/nested Seatbelt
permission failures); `lib-verified.log` is the complete run with the required
test permissions. Neither such permission failures nor the old partial gates
are represented as candidate success.

Candidate-wide local verification is now running with native-test permission.
Logs: `/private/tmp/morphz-0.1.1-candidate.z4Y5MQ`; the full workspace test run
uses the existing cache and serial test execution, matching the CI test order.
Website lint/build/typecheck/66 tests and source/protocol/diagnostic, installer
and locked-license checks have passed on this working tree. Generated assets
remain unchanged. No new tag or workflow has been triggered yet.

## Investigation history (resolved in latest handoff)

Development reports from a read-only inspection of mini-m4:8809:

- Correction: the API reports `29c835a9ba75`, but this alone is not the source
  identity of a build made from uncommitted changes. Development verified that
  the local and remote binaries are both 68,746,864 bytes with SHA-256
  `585d9b5e71f33b3f4a1226b69fa80c3cc7b51b624f30e51d7aa45fea7da962b5`.
  The remote PID 34018 loads inode 467266226, matching the copied binary. The
  binary includes the new Objective owner/generation, promotion-generation and
  stale-event guards. The running process therefore contains the previous fix;
  the earlier inference that it had not been deployed is withdrawn. This was
  verified by development, not a deployment performed by the release task.
- The Agent cancelled four Schedules, but the corresponding Threads remain
  open, the old Group remains open at 0/4, and the Objective wait remains pending.
  Cancelling only a Schedule is not evidence of complete work cancellation.
  Development also traced the Dashboard's absence of these Threads to its idle
  filtering: no Signal, Activation, or queued Schedule remains, even though the
  durable Thread is still open.
- Steering initially carries the pending-dependency permission, but the tool
  continuation route drops `pending_dependency_id`. At the 30-second heartbeat,
  ordinary renewal rejects the still-pending wait, cancelling the Activation
  while the durable Objective remains active with the same evaluation ID.
- The rejection audit reportedly says the Objective was paused/cancelled; that
  explanation must be checked against the actual rejection predicate.

This is not covered by `245cab7b`. Deterministic regression coverage and a fresh
handoff are pending; do not advertise it as fixed or modify production data.

Development has now received explicit user authorization to implement the
cancellation closure, exact pending-dependency continuation and open/idle
visibility fixes. It owns Runtime/Store/Dashboard edits and shared-checkout
builds for this round. The release task must not run competing builds or edit
those source files until the new handoff. Tag and Release remain gated on that
handoff and candidate checks; production deployment/data recovery remains
outside this publication authorization.

Independent source review corroborates the route loss:
`append_objective_activation_route` omits the pending dependency and
`bind_embedded_objective_route` sets it to `None`. Both SQLite and PostgreSQL
ordinary renewal require no durable wait; interrupt renewal instead validates
the exact required pending dependency and rejects a competing dependency.
Future regression coverage must exercise both the periodic heartbeat and the
below-half-lease admission renewal, plus stale/competing dependency rejection.

Cancellation review boundary: the documented `schedule_tx` control contract
changes one Schedule, and the store implements precisely that. Complete work
cancellation needs an explicit control path and truthful visible state; do not
silently turn the low-level Schedule operation into a Thread cascade without
settling that contract. `dashboard/src/scheduler/model.ts` filters idle Threads
from the active view, so that view is not proof of terminal cancellation.

Source-history check: `07b8dd8249c0854c72489b53a4db8edcdd1ad66e` introduced
`pending_dependency_id: None` in embedded route binding. That omission predates
the current patch; blame alone does not prove when this complete failing user
flow first became reachable.

In-progress pair review (not a final handoff): the initial new `thread_control`
registration occurred after Orchestrator construction, but construction freezes
the model-visible tool definitions. Reported this ordering problem to development
with a required real RuntimeBuilder/model-request regression, not only a direct
registry-call test. Registration must be visible to both the model schema and
execution admission before this control path can be accepted. No competing build
was run by the release task.

Follow-up source review confirms registration now precedes assembly with a
one-time Weak binding afterward, and a real model-schema/call test was added.
Results are still owned by development. Two coverage boundaries were reported:
the continuation unit fixture stamps events directly rather than exercising the
production tool-output route; the four-child cancellation fixture reopens the
Store, not the Runtime scheduler. Require a real steering/tool-successor chain
and distinguish persisted-state reopen checks from actual recovery dispatch.

Development reports a new real Runtime scripted-model regression is compiling:
waiting Objective -> directed input -> four `thread_control` calls -> replacement
`schedule_tx`, inspecting actual `chat/tool_output` dependency routes and checking
the replacement Group and absence of a duplicate DialogueTurn. Do not mark it
passed until results arrive. Shared-file ownership: the added test-only Tokio
`test-util` dependency in `morphz/Cargo.toml` belongs to development; the package
version 0.1.1 change belongs to release preparation. Stage these hunks separately.

Development's first real directed-input run reached a model call but observed a
tool output without the exact dependency field. It is investigating whether the
script was consumed by startup recovery or the intended continuation lost its
route; no completion handoff is accepted. Classify using durable root, Activation
and trigger identities, not the scripted tool-call ID alone. Development reports
the two helper/heartbeat tests, actual replacement dispatch after scheduler
reconstruction, and Dashboard tests/build/isolated preview passed; these do not
substitute for the still-unresolved real directed-input chain.

Failure classification is now confirmed by development: the first output had
the target Objective evaluation, primary root and steering ingress trigger, so
this was not startup-script contamination. The spawned execution closure copied
only the old three route fields. Physical-fence receipts and Action Group
settlement/recovery had equivalent handwritten copies. Development is routing
these through the shared stamp helper and recovering the complete binding from
the persisted selection event. The failing real-chain test remains a required
gate; do not filter out the receipt or report the issue resolved prematurely.

Development now reports all three Runtime lifecycle regressions pass, including
the actual directed-input chain after fixing the four handwritten route paths.
It also checks the first real output's trigger against the steering ingress and
adds Action Group recovery exact-dependency/stale-route coverage. Full lib,
SQLite/PostgreSQL conformance, attempt-loop and Clippy gates remain in progress;
no final handoff or release readiness is inferred from the targeted pass.

Latest reported gates for the in-progress fix: lib 1270 passed / 0 failed /
7 ignored; attempt-loop 76 passed; Objective group handoff 1 passed; Store
conformance 6 passed with an explicit URL and real PostgreSQL execution.
Development is strengthening the nested Yao infer variant of the real chain:
a passing outer cancellation script is insufficient without a successful typed
infer result, a real `plan_infer` child and its terminal outcome. No infer storage
change is justified by the route-field suspicion alone. A read-only proposal for
recovering a binding from the existing durable parent graph/selection event was
provided if the stricter regression proves the gap. Final handoff is still pending.

Further in-progress review: readiness projection prioritizes a live lease for
display and therefore cannot authorize crossing a pending dependency. Development
is separating that predicate and resolving infer authority from the existing
durable parent graph. Review flagged a legitimate adoption order to retain:
`objective_create` plus sibling `eval` records selection before adopting the new
Objective. Such a selection lacks binding; the exact persisted creation receipt
has it. Requiring every pre-adoption selection to contain binding would introduce
a new regression. A real creation-plus-infer test and narrow authority validation
are required, without deriving permission from the current mutable Objective.

Development confirmed the short infer initially did produce typed `42` and a
completed child. It passed because `activation_fence_is_current(None)` reused a
display projection that returned Leased before considering pending waits. Once
that authority check was corrected, the real infer regression failed with child
Evaluation cancellation, proving the missing-inheritance path. The new read-only
parent-graph resolver is under validation. Earlier broad-suite passes predate
these latest corrections and must not be treated as final candidate evidence.

The resolver now distinguishes ordinary graph-proven authority from the separate
pending-dependency exception. Missing selection binding does not invent an
exception; strict admission rejects any remaining required wait. Conflicting
bindings must still reject, not downgrade. Development reports five real Runtime
chain tests passed (including typed infer result, completed child and successful
Plan, plus same-response creation/adoption). A subsequent lib pass was 1271 / 0 /
7 ignored. After adding the final absent-binding negative case and prelude test,
it started final serial gates under `/private/tmp/morphz-scheduler-final.UJQ6XY`
(`clippy.log`, `lib.log`, `integration.log`, `fmt.log`, `diff-check.log`). Await
those results. The original failing runs remain in development's tool history,
not local log files; do not fabricate or imply archived raw logs for them.

Release-side read-only verification of the final-gate directory found
`lib.log`: 1272 passed / 0 failed / 7 ignored, 74.91 seconds. Integration was
still running when inspected; empty quiet-mode Clippy output alone is not exit
status evidence. Development's staged manifest contains only the test-util hunk,
with release version preparation left unstaged as agreed. Wait for the complete
exit-status handoff and commit before treating this staged snapshot as final.

## Verified starting point

- Local main at review start: `29c835a9`.
- Remote main checked through GitHub: `77f05e1eb16c49c758c0d7f595b8cda16c689a58`.
- Latest public release remains v0.1.0, published 2026-09-04 23:27:52 UTC,
  with 22 assets. No v0.1.1 candidate has been tagged.
- Remote CI run `33956949215` passed for remote main. It is **not** evidence
  that the pending scheduler fix passed CI.

## Patch contents

1. Fix Objective revision/generation confusion in durable child creation and
   promotion. The regression exists in the v0.1.0 source: a child can be queued
   with the Objective's CAS revision instead of its executable generation,
   then correctly rejected by the dispatch fence and never started.
2. Include `c816533c`, which publishes the validated model-route snapshot to
   the live catalog on account save, including routes already present on disk.
3. Preserve the already committed website, documentation, and cyan Dashboard
   brand changes. The model-configuration cleanup boundary document is not an
   implemented configuration migration and must not be advertised as one.

## Independent review

- [x] Confirmed the bad producer and generation fence in the actual v0.1.0 tag.
- [x] Located all production `ThreadSupervision::objective` constructors,
  including SQLite/PostgreSQL infer hand-offs inheriting the parent generation.
- [x] Reviewed promotion's source membership and Thread revision checks: a
  transfer must adopt the target Objective generation, not invent a new one.
- [x] Verify old Evaluation events cannot acquire a new Objective lifetime
  when materializing a previously absent Thread; check residual records as
  well as refusal to execute the model.
- [x] Resolve or disprove the PostgreSQL shared-row-lock upgrade race in
  `commit_schedule_transaction` before accepting the candidate.
- [x] Review the final diff and record the development handoff commit.

Review follow-up: development replaced the shared owner lock with stable,
sorted `FOR UPDATE` locking before child writes. It also moved rejection of
stale new-Thread routes before Thread creation. The revised integration contract
checks durable rejection and no new Thread/Signal/Activation. A separate fixture
retries across audit-commit and outbox-resolution boundaries, keeping one audit
and a discarded outbox record. This supersedes the older expectation of creating
a cancelled Activation for a root that should never have been materialized.

## Post-scheduling receipt closure review

Pair review confirmed another boundary after the previously passing tests:
an interrupt can cancel the old children and commit a replacement Group, but
the subsequent `schedule_tx` receipt still carries the old dependency route.
Strict admission correctly rejects ordinary work across the new wait. However,
that rejection currently finishes only the physical Activation and removes its
local binding; it does not deliver the promised arrangement explanation or run
the normal Objective Evaluation terminal-outcome release.

Source evidence: the Context schedule contract explicitly requires another
model response after the durable receipt; the admission rejection path calls
`finish_thread_activation(Cancelled)` and returns; normal reply/no-reply closure
instead invokes `finalize_objective_outcome` and
`ObjectiveSupervisor::terminal_outcome`, which finishes the Evaluation, cancels
its lease timer, unbinds it and reconciles the remaining wait. Persisting the
replacement Group alone does not prove this closure. Lease/reconciliation
fallback is not a substitute for the promised explanation.

Development accepted this finding and is implementing a narrowly authorized
receipt-only closure before its final handoff. Do not add `schedule_tx` to a
name-only admission exception or transfer the old dependency into fresh work
authority. Receipt-only handling must verify durable causality and current
Objective/Evaluation ownership; restrict both the model contract and Runtime
admission to terminal text/no-reply; preserve cancellation, replacement and
lease boundaries; release the Evaluation without clearing the new Group wait.
The existing final-reply helper also permits Objective control, so it is not
automatically sufficient for this narrower mode. A response taking longer than
the normal heartbeat interval must not accidentally renew ordinary execution
authority or be cancelled solely because it retains the old dependency.

Extend the real Runtime chain beyond replacement creation to final reply and
Evaluation release; assert the new wait remains, prohibited tool attempts do
not execute, and duplicate/stale/mismatched receipts cannot gain authority.
The earlier 1272-test lib pass predates this correction and is not the final
candidate gate. The release task only reviewed sources and communicated the
finding; it did not edit development-owned sources or start a competing build.

Review of the first receipt-only implementation confirmed that ordinary model
responses are validated before tool execution, and that the new dependency is
kept separate from the original work binding. Two additional integration paths
still needed correction and were sent to development: Provider ContextLimit
recovery unconditionally changed the phase to `critical-maintenance` and rebuilt
the admitted tools, losing the receipt-only restriction; Runtime Harness entry
eligibility did not exclude `schedule-receipt`. Require overflow recovery to
preserve the narrow contract and prohibit Harness entry in that phase. These
are source-level findings, not a claim that the new regression tests passed.

Development subsequently reported the targeted chain passing with a real model
request held across three heartbeat intervals, forged/stale/already-delivered
receipt rejection, final Evaluation release retaining the new wait, and an
infer branch exercising Provider ContextLimit followed by a rejected
`thread_control` attempt and final explanation. Release-side source review
confirmed both fixes: Harness eligibility now excludes receipt/finalization
phases, while ContextLimit recovery preserves `schedule-receipt` and admits
only `no_reply` in both the Provider schema and Runtime tool-name set. Receipt
queries now use exact Event and Objective filters. No additional evidenced
blocker was found in this scoped review; final full gates, commit and handoff
are still pending, not inferred from these targeted results.

## Acceptance gates

- [x] Existing and current Objective bindings dispatch all four children after
  revision differs from generation, with distinct durable roots and signals.
- [x] Promotion into a new or edited existing Objective actually dispatches.
- [x] Paused/cancelled/stale-generation work remains rejected; no safety
  predicate is removed to make the happy path pass.
- [x] Malformed child transactions roll back atomically in SQLite and
  PostgreSQL; parallel owner updates do not introduce lock-upgrade failures.
- [x] Restart does not duplicate dispatched work, and queued valid work recovers.
- [x] Deterministic create -> wait -> steer -> tool continuation -> cancel ->
  continue/restart coverage verifies Thread, Schedule, Group, dependency and
  Objective state together, including both heartbeat and admission renewals.
- [x] A replacement schedule's receipt reaches its permitted terminal
  explanation/no-reply and releases the old Evaluation without granting
  ordinary tool execution across the newly committed wait.
- [ ] Full Rust suite, clippy, formatting, installer/source/protocol/license
  checks, Dashboard tests/build, and website tests/build pass on the candidate.
- [x] Embedded Dashboard assets and generated documentation match their sources.
- [ ] CI passes on the exact frozen main commit, including native sandbox gates.

Preparation checks completed on the current working tree (not yet a frozen
release candidate): Dashboard lint, 218 tests and production build; website
lint, type checking, 66 tests and production build; main and Edge installer
contract tests; source-language, core-protocol-language and diagnostic-log
checks. Dashboard artifacts and generated website data remained unchanged;
both website installers match their source scripts. Final source changes still
require the candidate gates above.

Development handoff gates: 1265 lib tests passed, 7 ignored; 76 attempt-loop
tests passed; Objective group handoff 1/1; Store conformance 6/6 including a real
isolated PostgreSQL run. Clippy for lib/tests, formatting and diff checks passed.

One intermediate attempt-loop run timed out waiting for two serialized replies;
the targeted rerun and full default-concurrency rerun passed. The shared wait
helper discards partial results on timeout, so the reported empty array does not
prove that zero replies were persisted. Root cause remains unconfirmed. The
release task adds failure-only diagnostics (actual replies, model call counts,
Thread/Activation/Signal records and dispatch errors), without changing Runtime
behavior, deadlines or passing assertions. Candidate CI must still pass.

The release task's first full-workspace test attempt compiled the prepared
0.1.1 binary, but ran under a sandbox that denies local TCP listeners. A targeted
fixture reproduced `Operation not permitted` at its local listener setup. The
run was stopped; it is neither a passing candidate gate nor evidence that those
fixture failures are product regressions. Reuse the compiled cache and obtain
appropriate loopback/native-sandbox test permissions for the next valid run.

## Existing affected data

The four reported mini-m4 jobs require a separate, explicitly authorized
recovery. Development has asked for permission to update/restart mini-m4:8809
and back up its database before recovery; no production data has been changed
by this release task. Do not infer permission from authorization to publish.

- [x] Obtain an evidenced, conservative recovery procedure for users with
  pre-existing affected work. Test it against an isolated affected fixture.
- [x] Clearly distinguish prevention for newly created work from recovery of
  records already written by v0.1.0. Do not silently rewrite generations on boot.
- [x] Record any separately authorized production recovery outcome or leave it
  explicitly pending, without claiming that publishing a binary repairs data.

Development's recovery audit is
`docs/roadmap/objective_child_generation_fix_2026_09_06.md`. It explicitly
requires cancelling each malformed child, not relying solely on the Objective's
same-generation cascade. The isolated cancellation/restart test passed in the
development handoff; production recovery is explicitly still pending. The service
and database remain untouched by this release task.

## Publish and verify

Read-only GitHub access preflight after renewed authorization succeeded:
`morphz-ai/morphz` is public, the authenticated user has `ADMIN`, and the only
published release is still v0.1.0. Latest listed CI `33956949215` succeeded for
`77f05e1eb16c49c758c0d7f595b8cda16c689a58`; it does not cover the candidate.
No new workflow or publication was triggered by that check.

- [ ] Record all outgoing commits, bump the product version and lockfile as
  needed, and prepare accurate patch notes and upgrade guidance.
- [ ] Freeze the candidate; record SHA and successful CI run.
- [ ] Push v0.1.1 once. The tag Release workflow builds and publishes; do not
  also trigger a redundant workflow-dispatch build.
- [ ] Verify all five platform bundles for Morphz and morphz-edge, their
  checksums, bundled helpers/legal notices, and native smoke checks.
- [ ] Verify the public Release, anonymous download URLs, installer selection,
  version and build SHA. Record what was tested natively versus by CI.
- [ ] Deliver release URL, fix summary, verification results, and known upgrade
  boundaries, then pause the follow-up automation.

## Final candidate and delivery

Pending. No release success is implied by this preparation checklist.
