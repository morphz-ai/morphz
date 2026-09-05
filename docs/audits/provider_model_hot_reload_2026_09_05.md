# Account model enablement: disk/live route divergence

## Scope and cause

The account-model PUT operation merges the managed file into its working
snapshot, applies the requested selection, and computes routes changed relative
to that merged snapshot. Before this fix, it reused that **disk write delta** to
update the running catalog. A route already on disk but absent from the live
catalog produces no disk delta, so a successful save could leave it unselectable.
An already-persisted alias edit could likewise leave the old label active.

This is a hot-publication defect, not a configuration-format compatibility
requirement. It does not depend on any particular model, provider protocol, or
OAuth flow. The regression fixtures use only the current service/account/route
schema, an empty Runtime, a real RoutedClient, and synthetic discovery records;
they make no provider/model requests and contain no production data.

| Situation | Before the fix |
| --- | --- |
| Fresh installation; onboard and enable a newly discovered model through the Dashboard | Works when disk and Runtime are in sync |
| Repeat that successful selection without external edits | Works |
| A route was added to the managed file while the Runtime still has the previous catalog | Saving the same selection can return success without publishing the route |
| An alias was changed on disk while the Runtime still has the old label | Saving the same alias can leave the old label active |
| Load the complete valid file on a fresh Runtime start | Loads the persisted route; restart alone does not repair the save implementation |

A new installation is therefore not universally immune: the relevant condition
is disk/live divergence, not installation age. Such divergence can follow an
out-of-process configuration edit or an interrupted/failed update. This audit
does not establish which operation first introduced divergence on the reported
instance.

## Fix boundary

Keep the disk delta for minimal managed-file persistence. Publish the complete
resulting route table to the Runtime rather than treating the disk delta as a
live delta. The account's model capability table continues to be updated through
the same operation. Do not add model-name exceptions, automatic restarts, new
configuration formats, migration readers, or compatibility fallbacks.

The shared SDK operation is used by the Dashboard and account-model HTTP API.
Reopening the model manager reads its live route projection; the conversation
selector reads `/api/status`; the actual request router must agree with both.
The regressions check these projections, real model selection, repeat saves and
fresh-Runtime loading of the persisted configuration.

The same tests use durable Agent-account bindings: the authorized Agent can
bind a newly enabled model to its existing account, an unconfigured sibling
is still rejected, and both policies (including revisions) remain unchanged
through repeated saves and Runtime reconstruction against the same database.

The other catalog mutation methods were inspected: provider-instance, account,
individual-route and setup writes explicitly insert their edited objects into
the live config; they do not reuse this route delta. This is not a blanket audit
or cleanup of all historical configuration parsing, nor proof of atomicity across
concurrent external writers, filesystem persistence and live publication.

## Regression gates

- `web::tests::account_model_hot_reload_fresh_install_and_repeat_save`
- `web::tests::account_model_hot_reload_applies_routes_already_on_disk`
- `web::tests::account_model_hot_reload_applies_alias_already_on_disk`
- Existing model enablement, provider setup, routing and invalid-capacity tests.

Validation on 2026-09-05:

- Before the fix: fresh-install/repeat-save regression passed; disk-ahead
  route and alias regressions failed deterministically (1 passed, 2 failed).
- After the fix, including Agent binding assertions: all 3 regressions passed.
- `cargo test -j 2 -p morphz --lib`: 1260 passed, 0 failed, 7 ignored.
- `cargo clippy -j 2 -p morphz --lib --tests -- -D warnings`: passed.
- `cargo fmt --all -- --check` and `git diff --check`: passed.

Tests used disabled incremental compilation and debug info to reuse the local
target without producing a second large build directory. No deployed Runtime,
user configuration, credentials or production database was changed by the
regression suite.
