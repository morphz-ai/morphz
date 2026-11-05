# Comment discussions

Status: implementation contract, not acceptance evidence.

## Product

The selection menu offers **加入对话** and **讨论**. The former retains the
existing local quote draft and shared composer. The latter opens a compact
discussion beside that passage. Sending starts independent parallel work;
switching passages, closing the panel, or navigating does not stop it. A user
can return to the same passage and continue its discussion after a reply.
Saved discussions leave a persistent source highlight and a small discussion
marker. Clicking either reopens the accepted discussion without selecting the
text again. Closing via the cross, Escape, or an outside click only folds the
panel; it preserves accepted messages and the independent draft. Additional
discussions for one source are created from the explicitly named directory
action, rather than an unexplained plus in the header.
There is no extra Session, Agent, or copy of the source document.

Discussion is a presentation scope, distinct from a finite execution Thread.
Several turns/Threads can belong to one discussion. Session/Context, model,
permissions, execution receipts and task ownership retain their native meaning.
The first submission freezes whether its messages also appear in the main
conversation. The default is discussion only; both views refer to the same
accepted messages when main publication is selected.

## Authoritative model

Runtime owns accepted Session IO inputs and public output Events. An optional,
bounded native Session IO `discussion` route names the discussion and source
snapshot. Client metadata remains display-only. The discussion route is never
authority to read a document, select a Context, or control another Thread.
The first message's stable client command ID is also the discussion ID;
continuations refer to that accepted first input in the same Session and
Principal. They cannot replace its source or publication choice. Nothing is
persisted by selecting text or opening an empty editor.

The source has a stable locator key, version/anchor, selected-text snapshot,
and a short title/preview. Runtime validates shape and byte budgets. Platform
additionally validates the actual message/object source grant using its
existing quote boundary; a supplied locator is never proof of permission.
Dashboard message sources are checked against their native Session Events. The accepted
snapshot and stream are subsequently read under their real Session/Principal
scope. Continuing a discussion reuses that exact accepted snapshot; it does not
prefetch the original document again or grant access to its current version.
Opening or editing the current original remains a separate authorized operation.
Changed or inaccessible source text retains its snapshot and an honest locate
failure, rather than selecting a similar passage.

Runtime-owned relational projections bind each accepted input root to its
discussion and the discussion to its first accepted Event. Timeline rows carry
that proven discussion scope and main-publication flag. Original Events remain
the facts; projections do not copy message bodies. Creation, membership checks,
root binding, independent dialogue-lane ownership, timeline update, message receipt and scheduler Signal commit in
the existing message transaction. Idempotent retries retain the original
envelope, command ID and receipt. A failed/unknown send retains its local draft.

## Reads and lifecycle

Both SQLite and PostgreSQL provide indexed keyset pages for the newest main
messages, a single discussion's messages, and discussion descriptors for one
requested source. Main-only and discussion pages seek their own indexes;
neither scans a lifetime timeline and filters it. Limits also cover response
bytes and related source data. Directory descriptors contain a short preview,
not full selected text or messages. Opening a discussion is an exact authorized
source read plus one newest message page; older messages require continuation.

Only visible source/page owners subscribe and read. Subscribe before closing
the initial/reconnect gap, retain accepted cursors, coalesce committed changes,
and preserve invalidations received during a read. Idle has no polling.
Source, Session, Principal and discussion scope fence every late result;
closing the panel retires presentation reads, not execution. Ordinary message
history remains available without silently deleting Events or business data.
Source markers use the existing indexed source directory: one first page of at
most ten descriptors per actually visible, loaded source, with at most two
requests in flight and 64 cached source pages. They never preload discussion
messages, read the original source again, or drain a directory. Continuation is
explicit in the opened directory. Known local acceptances survive a late page;
failed metadata reads retain known marks. Highlights use immutable offsets and
source identity; ambiguous historical excerpts retain a source marker rather
than highlighting a different occurrence. The DOM highlight is presentation,
not a new message body, source grant, or authority store.

There is no renderer database, workspace snapshot, or second accepted transcript.
Unsent text and any unknown request envelope are a bounded local draft, point-keyed
by identity/window, Session and the exact selected source, with independent
discussion IDs inside that source journal. No accepted transcript is cached there. Removing a local draft does not cancel accepted work. This phase
adds no destructive discussion-delete operation. Session retirement and source
permission revocation continue to apply to reads and new input.

Migrations add nullable discussion scope and constant-default main visibility
to the existing Runtime timeline, then create their indexes and small route
projections. Existing messages retain main visibility. No old business input is
rewritten or replayed. Any reconstruction uses bounded, indexed batches.

## Validation

Test actual SQLite/PostgreSQL seek plans with large unrelated histories;
parallel first submissions and continuing separate discussions; identity,
permission and source-version changes; command collisions and lost receipts;
stream/final identity; latest/older cursor advancement; no healthy-idle or
hidden-panel reads; reconnect and invalidation races; and unchanged main draft,
model, tasks and ordinary quote sending. Inspect the original applications
separately from isolated fixtures before claiming original-app acceptance.

## UI direction

Extend the incumbent Operate/Read surfaces. Keep their system type, semantic
tokens, compact controls and light/dark appearance. Two adjacent text actions
identify the selection choices. Discussion content uses the existing Markdown
renderer and message/error states in a bounded, anchored reading panel with a
small reply input. One active reading panel can switch between independently
running discussions. Narrow layouts keep the panel inside the content viewport.
No modal, nested decorative cards, duplicate source paragraphs, or new global
navigation. Running and failed states reflect native facts and preserve drafts.
Dashboard discussions use the main conversation's shared Markdown renderer,
message row/bubble recipes and composer/send states. Local discussion styles
only size and contain the anchored pane; they do not introduce a second chat
typography or message palette.

Selection actions, quote editors and discussion panels share Floating UI
placement against the actual selected-text rectangle. The visible content
canvas excludes navigation/inspector rails, the topbar, application dock and
main composer. Discussions prefer either side of the source, then available
space above or below; long replies scroll inside a capped panel. Resize,
scroll, source layout and CSS zoom update geometry without any product reads.
Coarse-pointer panel controls retain 44px hit areas. Both frontends render
public Session IO prefixes before final publication, without reloading history
for each delta; final native messages retain their original identities.
