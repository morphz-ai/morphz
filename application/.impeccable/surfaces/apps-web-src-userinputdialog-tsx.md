---
version: 1
slug: "apps-web-src-userinputdialog-tsx"
primary_target: "apps/web/src/UserInputDialog.tsx"
related_targets: ["apps/web/src/user-input-dialog.css"]
---

# User input request interaction

## Current direction, superseding the archived contract below

Mode: Operate refinement; seed none. Reuse the existing Supplement action and the current
composer. No extra answer button, inline activity question, backdrop or modal. The user selected
the neutral-base soft halo: fixed white/black center and neutral icon, with only the accent
edge breathing; reduced motion retains a static edge. No dot, rotating light or filled accent.
Ordinary
drafts/references/attachments remain mounted and unchanged. Show the exact original task,
full questions, choices, free text and Send inside the input frame. Complete single-choice
batches submit on selection; multi-choice/free-text batches keep explicit submission. Escape exits
without answering and returns to the ordinary input. Keep original request/auth/command identity.
Use incumbent system type, neutral themes and focus tokens; body bounds 48dvh/420px, narrow
wrapping, no focus trap. No global DESIGN.md rewrite or raster assets.

Current contract and evidence: [composer direction](../../docs/design/2026-10-25-user-input-composer-direction.md).
Previous modal TEST A/B receipts and dimensions do not validate this new interaction.

## Archived earlier direction and evidence

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

Current review 2026-10-25: ship-with-notes from a fresh reviewer of the compact Desktop
original-app capture and 16 current component fixtures. Earlier user-rejected ship verdicts
are void. Mounted regression: 1/1 pass, 0 skip. Subsequent original-app TEST A submission and
same-command unknown-receipt check completed once, leaving independent TEST B pending.
Dashboard B subsequently completed once on its own original Thread after restart retention
and human Keychain authorization. Native tool calls, results and original Thread identities
were audited. Other exception-state pictures remain mounted evidence; no user aesthetic or
business approval is claimed. Focused local delivery only; unpublished and not pushed. See
[evidence and limits](../../docs/design/2026-10-25-user-input-dialog-review.md).
Existing DESIGN.md and sidecar scope are preserved; seed none, no new raster asset ships.
