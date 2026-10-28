# Composer context capacity

Desktop's input bar uses only a segmented ring, without visible numbers or text.
Clicking it reveals used input / total capacity, percentage, measurement time,
reserved answer space, remaining input space and an editable total maximum.
The ring and bar distinguish used, reserved and remaining space. The range and K-value field edit a local
draft; Apply commits it, and Auto removes the explicit ceiling. K means 1024
tokens. Usage estimates are marked with ≈ and are not billing or account quota.
Absent measurements stay unknown rather than becoming zero. The count describes
the latest full-request input measurement for the selected Session and model,
not a continuously recalculated count of an unsent draft.

The existing Runtime owns the shared Context budget and revision. Desktop uses
the same token-budget compare-and-swap operation as Dashboard. It respects the
selected model's physical input ceiling after output reservation. Presentation
adds the declared output reservation to the effective input ceiling: 224K input
plus 32K reserved output is shown as a 256K total maximum. An edited 128K total
with 32K reserved output writes a 96K input budget through the unchanged Runtime
API. The reservation is never written into input capacity or counted twice.
Used percentage divides measured input by total capacity; the reserved segment
keeps its own share. Overflow cannot erase that segment or fabricate free space.
Unknown usage remains unknown, and an undeclared reservation is not inferred.
A change takes
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

The previous input-only percentage (227.3K / 224K, 101%) is superseded by the
user-confirmed total-capacity presentation (227.3K / 256K, approximately 89%,
with 32K reserved). Its underlying input ceiling remains 224K. This is a display
and editing-unit correction, without a Runtime schema or policy migration.

Original Desktop review on 2026-10-28 confirmed an icon-only entry and a compact
popover showing the actual 214.7K / 256K estimate (84%), a separate 32K answer
reservation, 9.3K remaining, and an editable 256K total maximum. The full original
window and final dark/narrow/zoom fixtures were inspected for ring legibility,
segment separation, Chinese type, control alignment and density. Repeated total
and reservation rows were removed. Runtime PID and budget were unchanged by
this frontend refresh; no real message was sent or business ceiling edited.
