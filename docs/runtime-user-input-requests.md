# Durable user input requests

Status: implemented, original-application acceptance pending, 2026-10-25. The user approved
the question / choices / free-text interaction and requested Runtime, Desktop and Dashboard
coverage. The checkpoint below separates executable evidence from remaining delivery gates;
it does not change the Structured Context specification or introduce a second scheduler.

## Problem and scope

Before this change, the `objective_update` user-input wait had a durable request identity,
and directed Objective replies already fenced that identity, but it did not carry a question
or choices. Desktop dropped even the reply identity from its activity projection and provided
only a supplement action. Dashboard distinguished Reply from Supplement but still used
ordinary input without a structured question. That generic waiting label was not actionable.

Add a native `request_user_input` control for the current interactive execution. It supplies
one to three explicit questions, optional choices and always-available free text. It ends
the current cognitive slice, not the logical work. It must not create a new Objective or
Session just to ask a question, perform another model request for display, or use
`deliver_message` as a second output path. Permission approvals, credentials and OS prompts
remain their existing human-only flows; an answer grants none of those capabilities.

## Production ownership and identity

Runtime owns the request. Its immutable Event contains the questions and the exact
Agent / Context / Session / initiating Principal / Thread / generation / Activation route.
Runtime, not model arguments or the visible page, assigns the request ID from that accepted
Activation. Question and option IDs are bounded, unique within their parent and validated.
The existing `scheduler_dependencies` row owns whether the request is pending, satisfied or
cancelled. It references the immutable request Event; it is not a second question-body store.
Existing `evaluation_outcomes` provides the Activation's exactly-once boundary.

No Platform entity, renderer database, whole-workspace snapshot, object blob or new SQL table
is needed. Questions and answers are small JSON values in the existing Runtime Event store.
The existing dependency owner / generation / kind indexes serve pending-request queries;
reads join only the bounded, authorized Thread family to its exact request Events. There is
no full-history scan, per-question polling loop or filesystem notification mechanism.

## Request transaction

The request boundary atomically appends its Event, acknowledges the current Signal batch,
finishes the physical Activation, records its outcome and creates the pending UserInput
dependency for the still-open Thread. The current Principal binding, route, generation and
control state are checked inside that transaction. A concurrent cancel, newer generation or
directed input cannot publish a stale question or discard already accepted input.

For the Objective's actual owning Evaluation, register the same request as an Objective
dependency and maintain its existing UserInput display projection in that transaction.
Release only that Evaluation's lease; do not borrow a sibling child's binding or wait state.
An ordinary child owns its own Thread dependency. Attached-work barriers continue to own
the parent's wait without duplicating or moving the question. Use the established lock order
and the same semantics in SQLite and PostgreSQL.

The Event and dependency are the crash boundary. Repeating the same accepted Activation
returns the same request, never another question. Startup must expose the pending request
without re-running the tool, calling a model or resending the original user input. Waiting
for a person installs no finite retry timer and consumes no model budget while unanswered.

A question from a live DialogueTurn is promoted at this same boundary to an Execution
Thread, preserving its root, Principal and context. Otherwise an unrelated normal chat
interrupt could cancel a pending question. This is an execution-kind transition, not creation
of a new Thread, independent Agent, Session or Objective.

The new control is added once to the route's stable model-side tool contract, not when the
UI opens, closes or refreshes a question. Finalization, pure infer and noninteractive routes
retain their admission restrictions. The first new contract can invalidate Provider schema
caches; no cache-hit or token-saving claim is made without measurement. Native parameters
must actually reach the Provider, including question and option schemas.

The request also retains the real native call ID and frozen Provider continuation evidence.
An accepted Human answer produces one deterministic, source-linked tool-result receipt for
that actual call in the same transaction as the Human input and wake Signal. Resumption must
either provide that exact result to the retained continuation or construct a valid new
Context request; it must not leave an unanswered native function call, fabricate a tool result
from prose, replay physical work, or use an extra model call to turn an answer into metadata.

## Answer transaction and authorization

Extend the existing authenticated message ingress with an explicit question destination:
request ID, exact Thread ID and generation, and structured answers. The original message
command ID remains the durable retry identity. A reply validates the current pending
dependency, immutable request route, Principal / Session membership, nonterminal and active
Thread, question IDs, selected option IDs and bounded text. Free text is always allowed;
an unselected default or an empty form is not an answer.

The same transaction appends the Human input and its exact Thread Signal and marks only this
request's Thread dependency satisfied. When the current question also holds an Objective
barrier, that barrier reserves the accepted answer Event ID until this same Thread's next
Activation claims the Objective Evaluation. Only then does the established exact-reply path
release the Objective dependency and remove its wait projection. Clearing the Objective wait
first would expose a runnable gap: automatic continuation could claim a different Evaluation
and suppress the Human's answer. The read projection distinguishes this accepted-input handoff
from an unanswered question; it must not continue asking the user to reply during delivery.

Answer admission verifies the durable accepted answer / question / owner association, including
the original asking Thread when it is a creation-prelude owner rather than the usual Objective
primary. It never creates an unrelated conversation, broadcasts to all waiters in the Session,
changes models or permissions, or stops already-running physical work. Runtime validates the
answer against saved question / option labels and actual submitted free text, without changing
the original authenticated Human input to a model-authored paraphrase.

An identical command retry returns its original receipt. A different command answering an
already-consumed request conflicts. A stale / cancelled / replaced request cannot be silently
redirected to the latest question. Unknown transport outcomes retain the answers and the
original command ID until the existing receipt path confirms the result. Agent tools cannot
fabricate a Human choice; ordinary steering keeps its original-source validation and cannot
use the structured Human-answer destination to mint an answer.

## Lifecycle, read projection and old records

Pending requests are read only for authorized, still-open owner generations. Terminalization,
explicit cancellation or replacement invalidates the pending edge without deleting audit
Events. Pausing preserves the question but disables reply until an authorized resume. No new
request-deletion endpoint or retention policy is introduced; existing Runtime store / Context
lifecycle rules continue to apply.

Scheduler and focused execution snapshots expose the same typed pending-request projection.
Desktop and Dashboard consume it; neither infers questions or options from prose. Old
Objective UserInput waits keep their original identity and readable status reason. The UI
explicitly identifies an old wait with no saved question rather than inventing one, and its
existing exact Objective reply remains usable. No immutable history, old successful receipt,
in-flight business request or retired execution alias is rewritten.

## Interaction contract

Use the existing visual systems and modal-focus behavior. The user's later 10:47 direction
supersedes the initial inline preview: activity preserves its original work card and shows
only a visible answer button, never an embedded or indented question. The button opens a compact question panel with
numbered selectable answers, free-text input and one explicit Send action. Closing preserves
the pending request and does not consume it, cancel work or modify the main composer's draft.
Different requests retain independent form / submission state. The dialog handles multiple
questions, long Chinese text, no choices, keyboard operation, narrow windows, stale state,
permission loss, failure, unknown outcome and confirmed submission. Selection alone never
sends, and no default is submitted automatically. Do not add a new message-state design or
change the user's selected circle-check variant.

## Review and evaluation gates

Before implementation the design review checked: one authoritative body and lifecycle;
request / answer atomicity; SQLite writer serialization and PostgreSQL row locking; Objective
versus child ownership; cancel / reply / new-generation races; crash before live dispatch;
bounded queries; no permission escalation; no fabricated Human response; no polling; stable
model-side schema during an Evaluation; and preserved unrelated inputs / drafts / tasks.
Code review and executable verification of those claims are still required.

Required coverage includes malformed / duplicate identifiers, empty or oversized questions,
choices and free text, real model-visible native arguments, request exclusivity, atomic
SQLite and PostgreSQL request / answer paths, same-command idempotency, competing answers,
cross-Principal / cross-Session / cross-Thread rejection, cancellation, generation changes,
restart recovery, Objective primary / prelude / child behavior and ordinary steering parity.
Both real UI consumers need mounted interaction tests, complete-surface captures and original
Morphz-window acceptance with clearly marked synthetic work, not private task mutations.

## Rollout and rollback

Build and test in the clean release worktree, preferring release Rust artifacts. Deploy the
matching Runtime and UI assets only after their contracts pass; use the same original app,
profile and data. Normal restart must preserve and recover existing tasks. No RC tag or
formal release is authorized. Do not delete pending question Events to roll back: an older
client may not provide the new answer UI, but the new Runtime's typed API remains the recovery
path until compatible clients are restored. Any discovered incompatibility is a rollout
blocker, not grounds to discard user answers or silently resume work.

Rejected alternatives: parsing an Agent's latest prose as a question; treating every new
Session input as an answer; a Desktop-only questionnaire ledger; using approval as a generic
question; creating an Objective for each clarification; periodic model wakeups; and a separate
`deliver_message` body / question companion.

## Implementation checkpoint (not delivery evidence)

- Native question classification, stable tool advertisement, the request outcome, exact
  Human destination, source-linked native answer receipt and bounded question read
  projection are connected in Runtime source. No new question table was introduced.
- SQLite and PostgreSQL now have request / answer transactions. Objective answers reserve
  the matching Goal barrier until the actual asking Thread claims its Evaluation;
  unanswered question edges hold later mailbox Signals without a model wake timer.
  The final release integration run passed all seven cases: six SQLite cases and the
  isolated PostgreSQL lifecycle contract, with --include-ignored and zero ignored cases.
  Its creation-prelude admission case retains the exact Human root, claims the original
  Goal and presents one actual native call / correlated result before model resumption.
  An earlier fixture lacked the real Runtime's attempt_id and failed that retained-call
  assertion; the fixture now supplies the actual Activation batch identity, with the
  original strict assertions unchanged.
- The first SQLite run exposed a real new write error: Rust uses Succeeded while the SQL
  enum uses completed. Both backend writes were corrected to the existing persisted value;
  the subsequent executed SQLite and PostgreSQL transaction cases passed. This initial
  failed run is not green evidence.
- The real Runtime cold-restart test passed: one saved native question survives a new
  executor / store / Runtime, waiting and restart make no extra model call, and one explicit
  answer resumes the original Thread with one correlated tool result. The model is scripted;
  this is real Runtime execution, not live-Provider or original-application acceptance.
- The release regression binaries passed background_owner_recovery (6),
  objective_group_handoff (1), response_annotations_steer (3), session_io (14),
  session_io_evaluation_runtime (8), and thread_group_wait_runtime (2). They ran against an
  owned temporary PostgreSQL cluster, including session_io's distinct test database, with
  --include-ignored and zero ignored cases. The default approval_runtime_resume target
  selected zero tests because its feature is disabled; it is not counted as a passing test.
- The optimized library test binary passed seven user_input unit cases and four targeted
  Objective / native-control phase / concurrent-steering cases, with no ignored tests.
  These eleven selected cases are not a claim that all 1,740 library tests were executed.
- Application has a new immutable input format 15 for explicit replies. Format 4 and old
  queued supplement fingerprints remain unchanged. A typed, authorized user-input.read
  resolves the exact question and original artifact / receiver from the Host source ledger
  without hydrating, moving or scanning the visible conversation history.
- Desktop and Dashboard now include question actions, native answer dialogs and independent
  scoped drafts. Choices never auto-submit; unknown outcomes preserve the immutable original
  command and require an explicit receipt check. Old waits show honestly that no question was
  saved and use the existing exact Objective reply route. Two clients' actual mounted forms
  cover closing, keyboard/focus, independent questions, duplicate clicks, lost receipts,
  expiry, permission loss and an unchanged main composer.
- The earlier canonical application npm test completed: 4,671 passed, 0 failed, 27 optional external
  Runtime integrations not enabled, and unexpectedSkips=[]. Required PostgreSQL coverage
  ran. This checkpoint predates the final UI/history changes; the final canonical run is
  being repeated. The 27 optional cases are not passes. Application no-emit TypeScript checking and
  git diff --check also passed. The strict pre-existing status boundary snapshots remain
  unchanged; the explicit new question-preview seams have their own negative AST cases.
- Dashboard tests (266), lint and production build passed; the TypeScript SDK tests (16)
  and PostgreSQL CI-inventory Python tests (12) passed. Dashboard generated assets are built
  into the successfully built final release Runtime binary. Its SHA-256 is
  820a5fbe3fec7d54a8f6b2da16f0275cb4d7f31789afa5ac5f1307cbb42c70bb.
- The user rejected the earlier inline question and later 640px dialog proportions; those
  previous ship verdicts are void. The final 512px compact dialog, original Desktop short-question
  capture and sixteen mounted state captures received a fresh bounded ship-with-notes verdict.
  The question precedes the choices and input, with its original source disclosed below them.
  The focused two-client mounted regression passes, including the compact geometry, independent
  forms, unchanged composer, explicit submission, exact retry and permission/expiry boundaries.
  The single detector run returned []. None of these proves original-app submission or user
  aesthetic approval. See application/docs/design/2026-10-25-user-input-dialog-review.md.
- The original Desktop was normally quit, updated and reopened with every existing bootstrap
  setting preserved except its tested source root. Its Host advertises immutable input format
  15. The independent original Runtime was normally restarted using its verified original
  arguments / environment and the frozen release artifact above; the old binary is retained.
  At this cutover the same two active Goal IDs, 39 Sessions, four open Threads and two waits
  were present before and after. No task cancellation / replay API or database deletion ran.
  Cargo subsequently rebuilt an integration-test CLI at the mutable shared target path; that
  is not the frozen production artifact deployed here.
- One clearly labelled TEST A input was submitted once in a new conversation under the
  existing TEST project. The earlier macos_keychain read exceeded 120,000 ms before Provider
  input; that was a real initial barrier, not a native question. It recovered at approximately
  10:30 without resending the input. Its original Thread
  thread_5feb5e34d1d826750b624295 now owns the real native question
  user_input_work_c52b310b6f96c4c3cedb7ee4, with the same first generation. The old credential
  blocker is no longer the current state. Desktop opened the actual question, selected a
  synthetic option and entered synthetic text; Escape/reopen preserved both without submitting.
  The final compact panel was separately opened and closed in the original app after refresh.
- TEST B was sent once through the existing Dashboard in the same isolated TEST Session,
  mw-eb708435-e4469b686023d69b898a8876. It created a distinct real Thread
  thread_281f4825bfefd0e09e721347 and native question
  user_input_work_281f4825bfefd0e09e721347, while A remained unanswered. Dashboard switching
  between A and B preserved B's selected synthetic option/text without copying them into A.
  Closing the forms left a dedicated TEST main-composer marker untouched. Neither answer has
  yet been submitted; final matching assets/restart and exact-correlated submissions remain.

Remaining delivery gates:

1. Finish the optimized Runtime build containing the matching final Dashboard assets and
   byte-versioned asset URLs; normally update the same original Runtime with its existing
   arguments, environment, credentials and data. Keep both TEST question identities pending
   across restart, then submit each once from its respective real client and verify the
   exact original Thread/native tool-result correlation. Complete final canonical validation
   and record the actual keyboard/zoom scope without presenting fixtures as original hardware.
2. Record original-window evidence and make a focused local commit only after the
   required acceptance gates. No version publication or new push is authorized by this goal.
