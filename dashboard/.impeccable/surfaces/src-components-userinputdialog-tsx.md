# Runtime question replies

Mode: Operate. Extend the incumbent Dashboard activity and modal UI, not its identity.

THESIS: the original activity card shows a visible “回答问题” button, with no embedded or
indented question. Clicking opens the saved question; reply only to its asking Thread.
OWN-WORLD: existing Dashboard system type, neutral surfaces, four accent palettes, light/dark
themes, compact header and existing icon weights. No new assets, decorative motion or cards.
STORY: click the work card's reply button without navigation, select choices and/or free text, then
explicitly Send. Closing retains independent drafts and never consumes a question.
FIRST VIEWPORT: title/close row, complete question, whole-row native choices, free input, then
an initially collapsed 11px source disclosure. The current panel is 512px wide, with 40px
pointer choice rows, 20px numbers and a 48px minimum textarea. Short-question regression:
width <=512px, height <=360px; long batches scroll inside the modal. Keep header/footer
spacing compact and coarse-pointer choice/reply targets at 44px. Explicit Send never follows
selection automatically. The 10:47/10:57 human corrections supersede the earlier layout.
FORM: local extension; seed none. Do not replace the main composer or its draft.
FINISH: inspect complete activity and dialog surfaces, dark/light and narrow, and test keyboard,
unknown receipt, cancellation, authorization and multiple independent requests. No raster assets.

Current review 2026-10-25: ship-with-notes from a fresh reviewer of the compact Desktop
original-app capture and 16 current TEST fixtures; no residual visual blocker in that set.
Earlier user-rejected ship verdicts are void. Mounted regression: 1/1 pass, 0 skip.
Subsequent original Dashboard TEST B verified the button-only card and 512×343.75px modal,
retained selection/text across Runtime restarts and reload, an unchanged main draft, and one
explicit submission to the original Thread. Human Keychain authorization released Provider
backoff; the original Thread returned the full answer without another submission. Desktop A
and Dashboard B each have one Human answer and one correlated native ToolResult/reply.
Other exception-state pictures remain mounted evidence. User aesthetic and business approval
are not claimed. Focused local delivery only; unpublished and not pushed.
See [evidence and limits](../../../application/docs/design/2026-10-25-user-input-dialog-review.md).
The pre-existing absence of Dashboard DESIGN.md is recorded, not repaired; seed remains none.
