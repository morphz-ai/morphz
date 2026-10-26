# Desktop control parity after Runtime v0.1.4

Status: implemented and locally verified in the original Desktop. The formal
Runtime v0.1.4 release is published. The Desktop development commit still needs
its complete remote CI acceptance before the combined goal is complete.

## Scope

1. Pause/resume an exact execution Thread alongside its existing stop action.
2. Pause/resume, reschedule and cancel a native Runtime Schedule. Existing
   task-bound arrangement controls retain their own source-watch semantics.
3. Runtime supersede remains a typed control contract. The dedicated Desktop
   "纠正并继续" entry and its single-item More menu were withdrawn on 2026-10-27:
   users express revised requirements through the existing directed supplement
   flow. A supplement remains a directed input, not an automatic supersede call.
4. Cancel a real delegated sub-agent through its durable delegation edge.
5. Explicit Human approval of the offered capability boundary within its
   Objective or Session, alongside the existing allow-once/deny decisions.

The 2026-10-27 supplement correction carries only immutable routing metadata
with an already authorized Thread's continuation projection. Runtime remains
the owner of that source; it is removed with continuation for other principals.
The composer may retain those fields with its existing local draft, without
hydrating old messages, adding a data table, scanning history or polling. The
existing submission boundary rechecks owner, generation, original delivery and
grants; projection fields are not new authority. A rejected control's complete
message belongs below the header and cannot displace any control's hit target. 6. Make the existing Objective pause/resume reachable from its compact row.

No new execution engine, application database, history inventory, model call,
background polling, permissions preset or independent control ledger is added.
The v0.1.4 release and its tag remain unchanged. Development continues on
`codex/desktop-control-parity` from that exact published source.

## Authoritative data and writes

Runtime owns Thread identity, lifecycle, generation, control state and revision;
Schedule identity, original input/root provenance, timing and revision;
delegation identity and its original parent/child request edge; and approval
requests, capability offers and resulting leases. SQLite/PostgreSQL retain their
existing Runtime models, transactions, indexes and recovery rules. No schema
migration, renderer-owned state or Host dual-write is required.

The application retains its existing authoritative Human/project/conversation
membership and input provenance. Both embedded IPC and HTTP invoke the same
typed application operations. Agents continue to use the corresponding native
Runtime operations; UI controls do not create another model-facing tool set.
Human-only approval remains Human-only.

Pending approvals must remain discoverable outside the execution inspector.
The authorization inventory follows the verified original input binding for
scheduled/descendant roots. An approval missing from the bounded activity page
uses one exact metadata-only Runtime source proof, not a history scan. An
unverifiable source cannot become an actionable scope or a confirmed empty
inbox. Message-page membership is not approval membership. The existing Shield
tab shows its pending count; only the exact causal branch and its ancestors
show Human approval attention, separately from unchanged scheduler phase.
The activity overview does not duplicate approval cards or decision buttons;
the authorization tab is the overview's approval handling destination.

### Threads

Extend `execution.control` with explicit pause/resume/supersede actions. A
Platform-associated action must select the exact Thread, original input/root,
canonical Session and Context and carry the displayed revision. Fresh physical
reads and the existing parent-chain proof precede a write; authorization is
checked again after awaited reads. A selected descendant never authorizes its
siblings. Runtime performs the atomic revision check.

Current lifecycle/control/generation comes from the existing exact-Thread
`execution-records` metadata-only read, with no Job payloads or history. The
Session Thread point read is provenance-only and cannot supply those fields.
Native supersede returns a ThreadMutation (identity, revision and generation),
not an echo of the new mailbox intent. The real Runtime smoke protects both
wire contracts. IPC and HTTP share the 64k intent limit; the HTTP UTF-8 carrier
is bounded separately at 256 KiB.

An unassociated Runtime read reference is not itself mutation authority. An
explicit Thread action must separately verify its current immutable Human
owner, registered Session, actual Context and any known Platform association.
Delegated read references cannot become ordinary Thread write scopes.

Pause controls admission of later work; it does not freeze already launched
external effects. Resume preserves the generation. Supersede is a separate,
explicit intent change: Runtime fences the old generation and continues the
same Thread with the revised intent. Existing completed effects remain real.

### Native Runtime Schedules

Use `schedule.control` with exact original project/conversation/input/Thread,
Schedule ID and displayed revision. Resolve canonical Session/Context and the
persisted source, then point-read `/api/sessions/:session/schedules/:schedule`.
Check identity, immutable source and revision before the same scoped POST.
The existing Runtime CAS owns mutation; the renderer never supplies authority
through a Session or guessed association.

Rescheduling edits the existing Schedule rather than creating a replacement.
The Runtime defines queued/paused/dispatched/terminal transitions and interval
semantics. Task-bound schedules continue through existing task controls so a
source watch is not silently detached or mistaken for a native timer.

### Delegations

Cancel only the exact durable delegation using its ID, original request Event
and verified parent Session/Context/Thread. Re-read the delegation and request,
verify the actual initiating Human and current original-work authorization,
and require the selected child to belong to that immutable edge. Use Runtime's
delegation cancellation endpoint; do not cancel a guessed child Session or its
unrelated Threads. Read-only linkage does not grant approval or supplementing.

### Scoped approvals

Keep the exact pending approval, original work and refreshed fingerprint checks.
Include the actual Runtime capability offer in the fingerprint and presentation.
No offer means no reusable grant action. Objective scope must be causally
supervised by an actual Objective; Runtime validates its frozen job binding.
Session scope applies only to the displayed capability boundary and Runtime
expiry, not to all tools or a permission preset. The Human reviews and explicitly
confirms that scope before submission. The UI cannot approve on behalf of the
Human merely by opening a menu or choosing a work item.

Pending offers carry a finite `duration_secs`, beginning at the durable approval
decision rather than request creation. A two-day Human wait must not erase the
available scopes. Runtime stores the selected duration with the approval decision
and derives the issued lease expiry from its persisted decision time; a restart,
replay or later TTL configuration change never renews that grant. Previously
issued grants retain their original expiry. Offer reads remain stable for the
existing confirmation fingerprint, and exact Job-proven Objective identity is
included in the offer so the authorization page needs no historical scan to show
the available Objective scope. Once-only decisions still issue no reusable lease.

## Receipts, errors and lifecycle

Thread/Schedule commands retain the displayed revision and exact payload.
Conflicts or unknown responses require reading current facts and a fresh Human
decision; do not silently replace the revision, retry a different command or
optimistically claim completion. Delegation IDs and approval IDs retain their
native idempotent/terminal behavior. Closing an editor or switching surfaces
does not execute a command, lose the original draft or retarget another input.

Operation-scoped invalidation and the existing committed-change subscription
refresh current facts. There is no new healthy-period timer or history scan.
Source revocation, identity retirement and stale generations continue to fail
closed. The original Runtime, business jobs, data and unrelated work remain.

## UI direction and verification

Preserve the current three-column shell, system type, light/dark themes, four
accent palettes and shared control metrics. Frequent pause/resume lives beside
the existing execution/goal actions. Advanced revision, reschedule, cancel and
scoped approval use existing compact menus/editors/confirmation recipes. No
expanded question card, duplicate reply button or new question modal is added.

Verification must cover actual typed Client/Host calls, authorization before
and after awaited reads, exact descendant versus sibling targeting, stale
revisions, malformed receipts, unknown results, native Schedule identity,
delegation edge substitution and approval-offer changes. Rendered checks cover
complete affected surfaces, light/dark, narrow/zoomed windows, keyboard and
coarse-pointer geometry, with no healthy idle reads. Original-app inspection
uses the same profile/center and clearly named synthetic test work; business
tasks are never paused, cancelled, answered or replayed for acceptance.

Only after implementation, original-app verification, focused commits/push and
complete CI on the final source may this scope be called complete.

## Local acceptance and release boundary

The stable Runtime tag `v0.1.4` points to
`5dd481716c7ca6f509829f80fddae5b1de08ead9`. Its source CI/Application matrix
passed all 25 mandatory jobs, and the release workflow passed 14 jobs, each on
its first attempt. The 23 public assets, ten archive checksums, fresh default
stable installation, native Runtime/Edge versions and v0.1.3-to-v0.1.4 default
upgrade were verified. This later Desktop work neither moves that tag nor
publishes a Desktop installer.

Local focused acceptance covers 31 typed Host/HTTP/authority and inspection
cases, 26 mounted/AST/material ownership cases, and 34 browser cases. The four
new UI cases also passed twice consecutively, including 44px coarse controls,
four accents in light/dark, a 200% sidebar, compact long-intent Schedule editor,
keyboard access, and no extra healthy idle execution reads. A native Runtime
with an isolated synthetic provider passed five consecutive real Thread and
Objective control/recovery rounds. These synthetic checks are engineering
receipts, not changes to or acceptance of business work.

The same original Morphz app/profile/center was normally reopened for the new
Host, then its renderer refreshed for the final compact editor. Original Rust
Runtime PID 41561 remained alive throughout. The actual window showed goal
shortcuts, Thread pause/more/stop, the empty correction editor and the compact
native Schedule time editor. Editors were closed without saving, no business
control or approval was submitted, and the activity overview was restored.
Visual review found compact action grouping, consistent system type and red
stop, readable single-line status, and a two-line expandable intent rather than
a large text wall. Full current-source Node inventory, one complete final-source
CI/Application matrix and all required five-round critical gates remain the
closeout gate; old release CI cannot satisfy that gate.

The first full local Node run exposed stale stop wording, a fixed glyph-consumer
contract that did not recognize the reviewed shared action seam, and a popup
counterfactual that missed `../../ComposerOptions.js`. The mounted test now
covers the expanded actions explicitly. The glyph check verifies the complete
new source/freshness/refresh seam before restoring only moved state for its
unchanged historical hashes; its negative mutations remain required. The popup
counterfactual now detaches all relative depths. No assertion, deadline,
performance target, ownership check or current inventory was removed.

The completed first full local inventory also found that the added Schedule
container had moved `data-schedule-id` away from its original clickable record.
The production row now keeps that original identity/anchor, while the sibling
menu stays outside the record button. Its unchanged complete mounted controller
passed 8/8. The Thread collection fixture now implements the actual Client
`refreshView` port and asserts exactly one explicit refresh after control; its
12 existing cases passed without dropping the accepted stop-lock assertion.
After these corrections, all 14 cases across the new controls and original
Schedule/subject-sidebar browser files passed five consecutive rounds (70/70).
The original app was refreshed once, its Schedule row inspected, then restored
to Activity with the same empty draft and connected Runtime. The initial full
run's failures remain recorded; final full-inventory CI must use the corrected
commit, not that earlier source or a selected successful retry.

## First remote matrix correction: Objective action geometry

The first remote matrix on `8ac9da71` found one deterministic product regression:
the new pause shortcut between expansion and View widened their center gap to
45px against the original 26px maximum. Both the dedicated regression job and
the complete second browser shard found the same error; their failed receipts
are retained and do not count as acceptance. The complete first shard passed;
this source's complete local Node inventory selected all 560 files and passed
4704 cases, with 27 declared optional integrations unexecuted and no unexpected
skips or failures. Those receipts do not cover a later source revision.

View again directly follows expansion. Its existing actions now share a compact
container: at widths below 180px they stack vertically without removing an
action. This also fixes actual compression during the 200% viewport case. A
wait-only diagnostic still failed, so that hypothesis and the added wait were
removed; all original immediate measurements and 26px/24px/72px bounds remain.
The test additionally checks quick-control adjacency without overlap, keyboard
order, numeric geometry receipts, and a synthetic DOM counterfactual that
recreates the rejected order and must still exceed 26px. One stale-build
attempt is separately excluded. Verification now uses the build-then-E2E entry.

After rebuilding, the focused geometry diagnostic passed five times, and the
complete Objective and Desktop-control files passed all 130 cases across five
consecutive rounds without retries. Original Morphz was refreshed for this
renderer-only correction; the separate Rust Runtime does not need a restart
for these existing native APIs. Final remote acceptance requires the complete
CI/Application matrix and unchanged critical repeat gates on the new immutable
source.

## Dependency audit correction after the release

The next matrix on `4fd8b693` passed the corrected Objective browser regression
and Linux timing/performance lane, but its unchanged lockfile failed the
dependency audit. RustSec published 23 additional advisories at
2026-10-26 13:45:01 UTC, after the formal release and the previous audit:
[`a78282a1`](https://github.com/RustSec/advisory-db/commit/a78282a1414d6c28cc228c4eae3570451affb0dc).
The advisory inventory grew from 1355 to 1378. This is a changed external audit
dataset, not a successful retry of the failed source.

Four new advisories (RUSTSEC-2026-0391, 0398, 0403 and 0410) reached the lock
through the pinned Windows `codex-protocol` HTTP dependency and its zstd stack.
The protocol consumes only the upstream `HttpError` and `HttpResponse` aliases;
Morphz does not invoke that client's compression APIs. The local
`third_party/codex-http-client-types` adapter preserves those exact reqwest type
identities and the pinned upstream reqwest feature request. It supplies no HTTP
transport, compressor, proxy or telemetry implementation. Both the root and
isolated response-annotation workspace patch this same boundary. Future
upstream imports of any other client API will fail compilation until reviewed.

The regenerated locks remove the unused implementation, all three affected
zstd crates and their now-unneeded transitive dependencies, without changing
registry package versions or adding an advisory exception. The unchanged audit
script passed all five tracked locks against the current 1378-entry database.
The generated Rust license bundle follows that exact dependency graph. Actual
Windows sandbox/runtime compilation and execution remain part of the complete
final-source CI gate. The already published v0.1.4 tag and assets stay immutable;
this development dependency correction is not silently substituted into them.

## Hosted runner allocation correction

The first matrix on `e8278870` passed the full dependency audit and repeated
Linux/macOS regression lanes. Its full Embedded Desktop job was cancelled
before acquiring any runner, with no executed steps. GitHub's check annotations
report that the hosted runner was not acquired after multiple attempts and that
macOS arm64 capacity was constrained:
[job 121628987967](https://github.com/morphz-ai/morphz/actions/runs/40339218428/job/121628987967).
That incomplete matrix is excluded from acceptance.

The complete application inventory now selects `macos-26-intel`, an official
standard runner with the same macOS major version. The long native Rust job on
the next matrix also failed allocation before any test step (job 121641670890),
so both long inventories now select that standard Intel fleet. The two mandatory
Reader/GUI jobs explicitly select `macos-26` and retain actual Apple Silicon
execution. Every original native Rust case and command remains required on
macOS 26; this changes the execution architecture, not the test selection.
All Node files, explicit native
focus requirements, embedded Host/restart/OCR flows, macOS-only browser files,
test assertions, single-worker scheduling and deadlines remain unchanged.
Architecture selection only chooses the matching browser binary; the catalog
has no architecture-based test omission. The coverage test's negative mutation
now replaces any selected macOS label with Linux rather than matching the old
floating label, so the original non-macOS rejection remains effective. This
does not add a failed-job retry or a success exemption for missing runners.

## Final cold-restart checkpoint and ARM allocation corrections

The matrix on `b30df1cd` found a real intermittent test failure in the repeated
native question cold-restart file: its selected snapshot had a `Waiting` phase
and pending question, but an earlier `DialogueTurn` Thread record. SQLite and
PostgreSQL atomically promote the Thread to `Execution` in the same transaction
that parks the question. The aggregate scheduler view reads Thread inventory
before later activations, dependencies and question attachments, so its fields
can span that commit. A phase-only test checkpoint accepted this mixed sample.

The checkpoint must require both the original `Execution` kind and `Waiting`
phase before dropping the executor. A fixed interleaving regression reproduces
the old mixed sample and requires rejection before accepting the new execution
revision. The actual cold-restart case also point-reads the persisted original
Thread and verifies its ID, generation and kind. Its original kind assertion,
20-second deadlines, model-call counts, correlated receipt, idempotent ingress
and single original Thread checks remain. No Runtime production code changes
or restart of the original business Runtime are needed for this test correction.

The deterministic regression first failed against the old phase-only guard.
After correction, all three cases passed ten consecutive complete-file rounds
(30 passes, no failures or ignored cases) in an isolated release build. This
includes ten actual executor cold restarts with scripted model values, not live
provider or business-task acceptance. The 42 CI coverage/setup contract cases
also passed, including the new allocation-order and retained-ARM counterfactuals.

The short ARM GUI job also failed hosted allocation before executing any step.
Reader acquisition now precedes that GUI job within the same CI run. This keeps
only one short ARM allocation eligible while the two long Intel inventories
run, without another product change, test filter, optional mandatory job or
deadline extension. The existing coverage contract rejects removing that
ordering or silently moving the remaining ARM checks to Intel.

## PostgreSQL steady-state budget checkpoint

The later full CI kept one real failure: the PostgreSQL Context budget counted
81 statements instead of 80. A controlled cold-connection counterfactual
reproduced exactly 81: twenty of each of the four Context statements plus one
`SELECT set_config($1, $2, false)` connection writer-fence initialization. This
is test setup mixing cold connection creation with its explicitly steady-state
window; the production connection fence is unchanged.

The fixture now awaits full pool initialization and idle return before measuring
hot paths. It also deliberately forces a cold connection and requires all five
physical statements, including the fence, to stay observable. No query is
filtered out. The original one/four-statement budgets, twenty-sample total of
80 statements and 80 pool acquires, and 500ms p95 smoke budget remain unchanged.
Ten complete release-file rounds passed against an owned temporary PostgreSQL,
including ten forced cold-connection checks and 200 steady Context samples;
observed per-round p95 was 4.314–6.996ms. This is engineering measurement on the
local test server, not a production latency claim. Required CI repeats the
complete file five times on its own PostgreSQL service; fourteen source/owner
guard cases reject omission, filtering, optional success and budget overrides.
