# User input request interaction

Scope: an Operate extension of the existing activity and native-modal surfaces. The user
confirmed explicit questions, optional numbered choices, always-available free text, deliberate
submission, and dismissing without answering. No new visual identity or global system rewrite.

## Direction contract

THESIS: the original activity card exposes one visible “回答问题” action. It never embeds or
indents the question. Clicking opens the exact request in a compact dialog; replying never
retargets the main composer or turns task status into a second chat interface.

OWN-WORLD: inherit the current system font, shared 14px detail text, neutral dialog surface,
four accent palettes and system light/dark modes. Use existing focus, modal and button tokens.
Accent means the selected choice or Send, not decoration; no new card or shadow system.

STORY: find “回答问题” on the original work card, open the dialog, read the question, select
an answer and/or write a custom one, then deliberately send. Closing retains the unanswered
request. Each task keeps its own form; the original conversation and main draft remain untouched.

FIRST VIEWPORT: compact title/close row followed immediately by the full question, native
radio/checkbox choices and free-text input. The 11px source disclosure sits below the input,
initially collapsed; inspecting it reveals the complete originating work title. The current
panel uses a 512px width, 40px pointer choice rows, 20px number markers and a 48px minimum
textarea. Reset inherited header/footer whitespace locally. Short-question regression bounds
are width <=512px and height <=360px; long batches scroll rather than inheriting that height
as a universal cap. Coarse-pointer choice and reply targets retain 44px. A quiet footer holds
Send and necessary feedback. Selecting a choice changes the form and never auto-sends.

FORM: local extension of the incumbent Operate surface; no direction roll or generated comp.
seed: none (local extension). The signature interaction is an exact task-scoped answer panel
that leaves both other pending questions and the main composer unchanged.

FINISH: document the current artifact and its evidence limits while preserving incumbent
DESIGN.md and any sidecar. No shipping raster assets. The 10:47 button-only-card direction
and 10:57 rejection of the 640px proportions supersede earlier concepts and ship verdicts.

Required states: choices plus custom text; no choices; multiple questions; closed/reopened;
busy; failed; unknown receipt; stale/cancelled request; permission loss; independent concurrent
requests. Screenshot review must cover the complete activity-plus-dialog surface and not
count isolated fixtures as original-app acceptance. No raster assets are planned.

Current review: ship-with-notes from a fresh reviewer of the compact Desktop original-app
capture and 16 current component fixtures; no residual visual blocker in that evidence set.
Subsequent original Desktop A and Dashboard B submissions completed on their original
Threads, including restart retention, exact native tool correlation, and one answer each.
This is synthetic acceptance, not user aesthetic approval or business completion. See
[current evidence and limits](2026-10-25-user-input-dialog-review.md).
