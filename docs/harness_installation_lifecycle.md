# Harness installation and history lifecycle

## Authority and identity

Runtime owns installation, exact work bindings and executable-package retention.
An immutable `runtime/harness_package_registered` Event archives the normalized
source and artifact hash under `(harness_id, harness_version)`. This is history,
not proof that the package remains installed. No Platform or renderer database,
replacement workspace snapshot, execution alias or second package store is added.

The existing semantic-version selection defines the newest stable release for
new work (newest prerelease if the family has no stable release). Opaque versions
and equal-precedence build identities remain explicit: Runtime must not invent an
ordering for them. Exact admission never resolves a floating `latest` reference.

## Retention and collection

The executable registry contains the current release and older releases required
by unfinished work. One SQL snapshot in SQLite/PostgreSQL derives exact references
from nonterminal Plans, Objective defaults/current Evaluations, ordinary Evaluation
roots, live child supervision, queued/running Activations and nonterminal scheduled
work. Paused, blocked and waiting work is unfinished. A dangling binding whose
owner cannot be proven terminal is retained (fail closed), not deleted on a guess.

Collection unloads unused old executable packages; it never removes package
archive Events, bindings, Plans, Threads, results, receipts or hashes. Completed
work is not rebound, replayed or executed through a retired tool name. Startup,
installation and bounded background maintenance apply the same collection rule.
No historical row migration or destructive SQL is necessary.

Registry admission and collection are revision-fenced. A snapshot captures both
the registry revision and packages leased by in-process callers before reading
durable owners. An intervening lookup/install invalidates collection; packages
leased at either boundary cannot be removed. Callers retain the exact package
lease until their work reference commits. Collection errors leave executables
intact and report a warning; they do not prevent startup or falsely report that
an already-committed installation failed. Explicit collection still reports errors.
All new-work admission paths reject retained-only releases; already-bound work
continues with its original version and hash. Shared-store recovery rechecks
durable references before mounting work.

## Queries and transport

Use indexed Event topics, exact Thread root/Activation/Objectives identities,
Plan status and Schedule owner identities; return distinct small exact references,
not full history/source bodies to the UI. Reuse the existing Event-topic,
Thread-root/supervision, Activation-root and Plan-status indexes; reverse
Objective/child/Schedule checks remain within the same read snapshot. Skip
maintenance reads altogether when no older executable remains installed.
Package installation remains an operator/SDK capability, not a new model tool or
permission grant. UI reads authoritative current and retained descriptors from
Runtime; it must not calculate versions or silently pretend cleanup occurred.

## Acceptance

Exercise the production registry and shared store contract against temporary
SQLite and dedicated PostgreSQL: upgrade ordering, live/waiting/paused references,
terminal cleanup, dangling-owner safety, restart, immutable history and concurrent
admission/collection. Verify SDK/HTTP/Agent new-work admission and continuation.
Application tests cover current/retained transport, one normal entry per family,
fold/focus persistence, narrow layouts, themes and absence of writes. Finally
compare the original App's package/binding history and unfinished identities before
and after deployment, and inspect that same App's installed list.
