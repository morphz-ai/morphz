# Desktop control parity after Runtime v0.1.4

Status: implemented and locally verified in the original Desktop. The formal
Runtime v0.1.4 release is published. The Desktop development commit still needs
its complete remote CI acceptance before the combined goal is complete.

## Scope

1. Pause/resume an exact execution Thread alongside its existing stop action.
2. Pause/resume, reschedule and cancel a native Runtime Schedule. Existing
   task-bound arrangement controls retain their own source-watch semantics.
3. Explicitly revise and continue a Thread through Runtime supersede, distinct
   from supplementing its current work or resuming a paused Thread.
4. Cancel a real delegated sub-agent through its durable delegation edge.
5. Explicit Human approval of the offered capability boundary within its
   Objective or Session, alongside the existing allow-once/deny decisions.
6. Make the existing Objective pause/resume reachable from its compact row.

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
a large text wall. Full current-source Node inventory and two complete CI rounds
on the final immutable Desktop commit remain the closeout gate; old release
CI cannot satisfy that gate.

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
