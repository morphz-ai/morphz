# Morphz TUI Interaction Contract v1

Status: implementation contract
Scope: the full-screen terminal client in `morphz/src/tui.rs`

## Product boundary

The TUI is a keyboard-first terminal client, not a reduced Dashboard and not a
mouse-driven Web interface. It must make the most common Runtime operations
complete without reproducing every administrative screen.

The minimum complete product consists of:

1. a readable and scrollable Conversation view;
2. a selectable Tasks view;
3. a selectable Mind Frame view;
4. a visible Session directory and safe Session switching;
5. a reliable theme action;
6. a usable composer, including Morphz message dispatch modes;
7. native terminal text selection and copy;
8. one discoverable, localized Control Plane and shortcut reference.

Service/account management, Context creation, archived Session administration
and other configuration workflows remain Dashboard/CLI responsibilities. The
TUI may select already enabled model routes, but does not configure providers.

## Audited capability inventory

| Capability | TUI contract |
|---|---|
| Conversation | Durable history plus transient streaming drafts; keyboard scrolling and jump-to-start/end |
| Composer | Unicode/multiline editing, paste, default/parallel/follow-up dispatch, draft retained per Session |
| Runtime activity | Semantic tool summaries, optional raw details, reasoning summaries, progress and terminal replies |
| Approval/cancel | Approval is the highest-priority modal; active evaluation cancellation requires visible confirmation |
| Tasks | Active Objective selection and detail, execution/delegation summaries, optional diagnostics |
| Mind | Mind Frame selection, formatted S-expression body, provenance sources, relations and Context pressure |
| Sessions | Principal-authorized active Session directory, stable-ID switching, local activity time |
| Control | `Ctrl+P` opens a searchable, state-aware action surface; actions never become dialogue messages |
| Shell | Persistent embedded PTY opened from Control; `Ctrl+]` returns to Morphz while `Ctrl+P` keeps its Shell meaning |
| Appearance | English/Chinese product copy, terminal light/dark adaptation, four live-switchable palettes |
| Discoverability | Localized `?` reference and concise context-sensitive hints in the bottom status line |
| Text access | Native terminal selection/copy; no default mouse capture |

The audit deliberately rejects controls that only look interactive. A visible
selection marker must have a keyboard navigation path and must drive the
corresponding detail surface.

## Interaction model

### Views

- Conversation: transcript and composer.
- Tasks: objective hierarchy and selected objective details.
- Mind: Mind Frame list and selected Frame details.

Conversation is the home view. `Ctrl+T` toggles Tasks, `Ctrl+K` toggles Mind,
and `Esc` returns to Conversation.

### Focus

Conversation focuses the composer. Tasks and Mind enter with content focus.

- `Tab` toggles content/composer focus in Tasks and Mind.
- Typing a printable character while content is focused transfers focus to the
  composer and preserves the character.
- `Esc` while the composer is focused in a secondary view returns focus to the
  content without destroying the draft.
- `Esc` while content is focused returns to Conversation.

This keeps navigation keys unambiguous while retaining the ability to continue
the dialogue from every view.

### Selection

Tasks and Mind are real master-detail views, not static illustrations.

- `Up`/`Down`: previous/next item.
- `Home`/`End`: first/last item.
- `PageUp`/`PageDown`: move by a page.
- selection is preserved by stable ID across Runtime refreshes;
- the detail pane always follows the selected ID.

Task selection covers active Objectives in v1. Execution and delegation
sections remain status summaries until they have a distinct detail contract.

### Overlays

- `Ctrl+P`: searchable Control Plane.
- `?` (with an empty composer): shortcuts.
- `Ctrl+G`: visible Session directory (go to Session).
- `Ctrl+O`: Objective lifecycle overlay.
- approval prompts remain modal and take precedence over every other input.

Only one non-approval overlay is active at a time. `Esc` closes it. Session
directory navigation uses the same selection keys; `Enter` switches Session.

## Reliable global shortcuts

Morphz does not assign application actions to function keys. Function-key
delivery varies across terminals and frequently requires a hardware `Fn`
modifier on laptop keyboards. Primary actions use ordinary terminal control or
meta bindings and remain discoverable through Control.

| Key | Action |
|---|---|
| `Ctrl+P` | Control Plane |
| `?` | shortcuts |
| `Alt+T` | cycle theme |
| `Ctrl+G` | Sessions |
| `Ctrl+T` | Tasks |
| `Ctrl+K` | Mind |
| `Ctrl+O` | Objectives |
| `Ctrl+R` | reasoning summary details |

The bottom status line always exposes `Ctrl+P`, including on narrow terminals.
Other bindings remain discoverable through Control and `?`.

### Cognitive input and Control Plane

The Composer has one semantic role: create user dialogue input. Morphz never
interprets a leading `/` as an application command. This prevents local
control intent from being persisted, recalled or sent to the model as if it
were cognition.

`Ctrl+P` opens a separate Control Plane backed by typed actions. It preserves
the Composer draft, supports localized label and stable command-key search,
shows unavailable actions as disabled with a reason, and executes the same
actions used by direct shortcuts. Initial actions cover views, Sessions,
Objectives, Context inspection, actual Runtime tool inventory, Execution Jobs, delegations,
presentation controls, theme, model, reasoning effort, cancellation, Shell
and application lifecycle.

The embedded Shell is entered through Control. Once the PTY owns input,
`Ctrl+P` is forwarded unchanged for normal Shell history navigation; `Ctrl+]`
is the explicit escape back to Morphz.

## Composer and dispatch

- `Enter`: Runtime/configured default dispatch behavior.
- `Shift+Enter` or `Ctrl+J`: newline.
- `Option/Alt+Enter`: `parallel` dispatch.
- `Ctrl/Command+Enter`: `follow_up` dispatch.

The status line reports the explicit dispatch mode when a modified Enter is
used. The default remains unspecified in the request so Runtime configuration
continues to own it.

## Text selection and mouse policy

Morphz does not capture the mouse by default. Native terminal drag selection
and the terminal's normal copy shortcut must work without a special modifier.

Consequences accepted by v1:

- application-level mouse scrolling/click selection is not available by
  default;
- transcript and master-detail navigation are fully covered by keyboard;
- a future opt-in mouse mode may be added, but it must never silently disable
  native text selection.

## Session switching

The Session directory lists active Sessions visible to the current Principal,
sorted by `last_activity_at` descending. Each row shows title, stable short ID,
Context and local last-activity time. The current Session is marked explicitly.

Switching Session:

1. authorizes and resolves the selected Session through the SDK;
2. does not cancel work in the previous Session;
3. stores the previous composer draft and restores the target Session draft;
4. reloads durable history, Context view and status for the target Session;
5. updates Agent/Context/Session location in the bottom status line;
6. rejects archived or inaccessible Sessions.

The TUI does not create or archive Sessions in this contract.

## Responsive and localization rules

- No fixed top Header.
- Persistent state belongs to the one-line bottom status bar.
- Secondary views carry their own content labels, not global chrome.
- Narrow terminals collapse detail before they hide primary content.
- All product text is localized through the existing English/Chinese locale.
- Stable IDs, S-expression operators and protocol values remain unchanged.

## Audit disposition

### Required in v1

- Mind Frame selection;
- Objective selection;
- focus model;
- Session directory and switching;
- searchable, state-aware Control Plane;
- reliable `Alt+T` theme shortcut;
- native text selection;
- dispatch-mode shortcuts;
- updated help/status localization and behavioral tests.

### Deliberately deferred

- transcript full-text search;
- arbitrary action arguments beyond the typed v1 controls;
- mouse navigation mode;
- Session creation/archive/rename;
- model/provider/account management;
- selecting execution jobs and delegations for dedicated detail panes;
- persistent TUI theme mutation of `morphz.toml` (runtime session switching is
  immediate; durable configuration remains an explicit setup/config action).
