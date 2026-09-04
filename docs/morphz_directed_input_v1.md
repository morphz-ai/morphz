# Directed human input v1

The ordinary composer remains a Dialogue entry point. Natural-language routing
is a model decision: `steer` forwards the immutable original user message to
existing work, then the Dialogue acknowledges routing rather than doing that
work again. It cannot fabricate a human instruction or forward another steering
message. In this version forwarding is bounded to the same authenticated
Principal, Context and Session.

## Explicit delivery

Dashboard's **干预线程 / Steer thread**, **补充目标 / Supplement objective**,
**回答此问题 / Answer this question**, or `@` work selection sets a structured
destination on the same composer. Session mentions remain references, not
delivery instructions. The chip is saved with the draft; only successful send
clears it. Card navigation uses the destination's actual Session.

`POST /api/sessions/:session_id/messages`, Rust `SendMessageCommand` and the
TypeScript SDK accept the optional field:

```json
{
  "text": "Use UTF-8 and preserve the existing interface.",
  "client_message_id": "caller-owned-id",
  "input_destination": {
    "kind": "thread",
    "thread_id": "thread_FULL_ID",
    "generation": 1
  }
}
```

For an Objective use `kind: "objective"`, `objective_id`, and its **Objective**
generation. To answer a pending `user_input` wait also send its exact
`reply_to_request_id`. New waits get a Runtime-issued request ID. Old waits use
`legacy:<objective-id>:<generation>:<revision>` until answered or replaced.
The model cannot grant itself authority by inventing these identifiers.

Explicit delivery appends one `chat/steering` user Event and a direct Thread
Signal atomically; it creates no second Dialogue. Retrying the same client ID
and content is idempotent; changing its destination conflicts. The receipt means
**queued**, not executed. The existing Signal status exposes subsequent claim
and acknowledgement. Authenticated ownership, route, active lifecycle and
generation are checked inside SQLite/PostgreSQL admission transactions.

## Safe boundary and exact waits

- Ordinary Session messages never clear an Objective's `user_input` wait.
- A reply consumes only the selected question; two concurrent distinct replies
  cannot both reserve it. Supplemental steering preserves existing waits.
- A running model reaches its next response boundary before steering takes
  over. Its uncommitted response is discarded. Physical commands already
  admitted are not cancelled or replayed; their normal results remain durable.
- The terminal-outcome transaction also checks for queued steering. Input that
  wins that boundary cannot be dropped by a competing successful completion.
- Paused or terminal work is not implicitly resumed/recreated. Stale generation
  and question conflicts return HTTP 409; foreign routes return 403.
- No model/reasoning/Target/Harness override is allowed on a directed message.
  Work retains its existing execution and permission boundaries.
- Direct intervention is for Runtime `self` work Threads, not Delivery or
  opaque/custom executors such as a suspended Plan interpreter. Address their
  supervising Objective instead. Primary Objective Threads are addressed by
  Objective identity to preserve Evaluation ownership.

## Thread presentation

Scheduler snapshots and the Runtime overview expose `intent`: original task
input, Schedule intent, or the primary Objective's statement. Missing intent
is labelled unavailable, never guessed from the most recent tool. Dashboard
shows this assignment separately from live activity. All short Thread IDs use
`thread_…` plus the final 12 characters; full IDs remain available in details,
tooltips and copy controls. Short IDs are display-only, never API identities.

## Verification

`steering::tests` exercises durable ingress, idempotency, stale/foreign/paused
rejection, concurrent question replies and terminal-commit fencing. Its ignored
PostgreSQL case runs against `MORPHZ_TEST_POSTGRES_URL` in a fresh schema.
Runtime regression `steering_supersedes_uncommitted_response_without_a_second_dialogue`
uses explicit synchronization rather than timing guesses. Objective tests cover
ordinary input versus exact replies and preserved waits. Dashboard tests cover
typed requests, stable IDs, assignment priority and draft restoration.

For isolated browser checks, Vite serves
`/tests/fixtures/steering-preview.html`; it uses synthetic data and never sends
messages to a real Runtime. It is not part of the production bundle.
