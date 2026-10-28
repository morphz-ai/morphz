# Composer context capacity

Desktop's input bar uses a ring meter, measured percentage and capacity ceiling.
Its compact popover shows used input / available input, measurement time, a
progress bar and an editable maximum. The range and K-value field edit a local
draft; Apply commits it, and Auto removes the explicit ceiling. K means 1024
tokens. Usage estimates are marked with ≈ and are not billing or account quota.
Absent measurements stay unknown rather than becoming zero. The count describes
the latest full-request input measurement for the selected Session and model,
not a continuously recalculated count of an unsent draft.

The existing Runtime owns the shared Context budget and revision. Desktop uses
the same token-budget compare-and-swap operation as Dashboard. It respects the
selected model's physical input ceiling after output reservation. A change takes
effect on a later request and does not interrupt an in-flight evaluation. Other
conversations sharing this Context also share its ceiling; this is stated in the
editor. This does not create another per-Session budget or renderer persistence.

`session-context-budget.read` reuses authorized Session/Context/principal binding.
A missing Session stays missing. `session-context-budget.update` follows the
existing local-Human-only model-settings policy, checks directory authorization,
identity generation, model and revision, then validates the Runtime receipt.
HTTP readers remain read-only even with valid CSRF. Conflicts and unknown write
receipts require a fresh read; neither the backend nor the UI replays the write
or overwrites a later revision. Late responses from another scope are discarded.

Initial usage is one indexed, latest-first read of at most 32 model-attempt
metadata events for the exact Session and topic. The verified SQLite plan uses
`idx_events_session_topic`, with no history sort or table scan. Later measurements
travel over the existing authorized conversation event stream, with no additional
requests. Only numeric full-work-prompt measurements cross the UI boundary;
private prompts and event details do not. Counts are scoped by Context, Session
and model, remain available across transient disconnects, and cannot roll back
on out-of-order events. Reads occur on scope/model changes or an explicit open
or retry; no healthy-period timer, Context construction or full-history fetch is
introduced. Capacity reads and edits never gate typing or send a chat message.

Validation covers CAS conflicts and lost receipts, authorization and native
generation fencing, not-started behavior, bounded reads, live WS counters without
new fetches, model/scope isolation, out-of-order delivery, draft preservation,
Enter ownership, capacity editing and Auto, and narrow light/dark rendering.
Automated fixture images are separate from original Morphz app inspection.

Original-window review on 2026-10-28 verified the actual Kimi Session's measured
227.3K input, 224K available ceiling, 256K total window and 32K output reservation.
Its last measurement predates the corrected budget, so the truthful estimate is
101% until a new request is measured; it is not clamped to a fabricated 100%.
Editing to 192K enabled Apply and moving out without applying discarded that local
draft; reopening retained the original 224K policy. The compact panel, aligned
number/range controls, single focus border and restrained meter were inspected in
the complete original Desktop window. Fixture review also covered settled light
and dark palettes, narrow layout and 200% zoom. The checks did not send a real chat
message or apply a test ceiling to the user's shared business Context.
