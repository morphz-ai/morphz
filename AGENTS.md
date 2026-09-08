# Morphz application work

Before changing desktop UI or interaction, read `docs/16-ui-design-standard.md` and the current implementation notes in `docs/13-implementation-status.md`. For application hosting and workspace/Session routing, also read `docs/15-cognitive-application-host.md`.

- Public UI uses **Morphz**. MorphzWork remains the engineering name; do not rename storage directories, IPC, headers or protocols as a branding edit.
- Work and objects organize the product. The first sidebar navigation item is one fixed global 对话 space; do not add global new-chat actions or a conversation sidebar. Projects have a default conversation and may create, switch, rename, archive and restore additional conversations in the project toolbar. Conversation management is optional, never a prerequisite for working.
- Conversations separate histories and drafts, not Agent cognition or execution threads. Preserve existing default Session routes, authorized Context boundaries and in-flight requests. Archiving never stops work or deletes artifacts.
- Preserve the current application while exchanging messages. Hiding input, opening history and switching applications do not stop background work or discard drafts.
- Human and Agent are equal participants. Keep identity, authorization, object revisions and actual execution receipts visible where relevant; never simulate success.
- Agent-first: creation shortcuts must use the shared intent input, not a required form. The Agent persists artifacts through real tools. Keep direct result editing and explicit authorization; never interpret a shortcut click as permission to send or execute.
- Use the shared interaction model, modal focus hook and UI tokens. Keep the four Dashboard accent palettes; use accessible foreground shades rather than inventing new brand colors.
- A page has one integrated title/action bar, continuous with the content background. Never stack a small shell title above a large page heading or use large decorative header spacing. Dialog titles and controls share a compact row; preserve necessary permissions and error information.
- Validate changed behavior with automated tests and real Electron inspection. Existing fixtures must follow current navigation, but do not remove assertions to hide product regressions. Keep test data and services separate from personal centers.
- The UI standard includes future targets. Check implementation status before claiming a feature exists. Professional application interfaces and the experimental UI package must not be described as a stable Runtime standard.

User direction takes precedence over these product defaults. Numerical layout baselines are adjustable design decisions, not mandatory Apple dimensions.
