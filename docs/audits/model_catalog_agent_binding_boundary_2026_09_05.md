# Model catalog and Agent authority: cleanup boundary

## Decision

Keep one model catalog and one durable Agent-account authority relation. They
represent different facts, not two generations of the same configuration.
Preserve stable IDs and use explicit, versioned data migration when a stored
schema actually changes. Do not use perpetual legacy-format readers or
request-time fallback to repair missing authority.

This document records an implementation audit and the agreed cleanup boundary;
it does not claim the legacy configuration paths have already been removed.

## Current implementation

| Fact | Authority | Code boundary |
| --- | --- | --- |
| Service endpoint, protocol, account pool and model capabilities | `models.toml`: `services` | `ProviderInstanceConfig` |
| Reusable account identity and credential reference | `models.toml`: `accounts` | `AuthAccountConfig` |
| Logical model route and physical candidates | `models.toml`: `models` | `ModelRouteConfig` |
| Which accounts an Agent may use | Runtime database | `agent_provider_binding_scopes`, `agent_provider_bindings` |
| Which Agent owns a Context | Runtime database | `cognitive_contexts.agent_id` |
| Session-selected model | Runtime database | Session model alias |
| Secret values | Secret/OAuth storage boundary | Not the Agent binding table |

The routing path resolves `Context -> Agent -> allowed account IDs` and
intersects that authority with the selected route's candidate accounts and
availability. A missing durable Context or an intentionally empty account
policy cannot silently use the Runtime's other accounts. Execution Target IDs
do not participate in this model-account authority relation.

Thus "models are bound to Agent ID" is accurate for **account-use authority**,
but does not mean each Agent owns a duplicate model catalog. The existing code
does not implement a separate per-Agent model-catalog file.

## Read-only findings on the reported instance

- The active host model file uses `services/accounts/models`. Its `llm` keys
  are `model` and `allowed_evaluation_models`, not the old provider selector.
- Three configured accounts and sixteen model routes have no missing
  service/account references in that file.
- The active Agent has six durable account bindings. Three IDs are absent
  from the active model file. Their originating deletion/removal operation
  has not been established by this audit.
- A historical `managed.toml` remains in the old host directory. The current
  primary file exists, so the inspected loader does not select that legacy
  configuration layer. Its contents must not be merged into the active
  catalog merely because they still exist on disk.
- No production file, binding, account, secret or database was modified by
  this inspection.

The model-enable hot-publication defect is independently reproduced with only
the current schema. Converting this already-current file would not fix that
defect. See `provider_model_hot_reload_2026_09_05.md`.

## What should be retained

1. One supported file schema and normal typed decoding into the Runtime
   catalog. File formatting and API DTO presentation are boundaries, not a
   reason to keep obsolete input schemas.
2. Stable service, account and route IDs. Changing labels or file syntax must
   not generate new account IDs, recreate logins or grant new Agent access.
3. Versioned database migrations, applied once before the affected runtime
   functionality starts. Keep transactionality, idempotency and migration
   history; the steady-state reader should consume only the current schema.
4. Explicit referential checks. An account removed outside the control plane
   must be reported as an unavailable reference, not recreated or substituted.
   A missing account cannot authorize a different account.
5. Explicit account association and removal. The existing SDK refuses account
   deletion while another Agent binding still refers to it; preserve that
   guard. Cross-file/database operations are not magically one transaction:
   order them safely, record failure and reconcile without guessing intent.

## What should be removed or relocated

- Legacy `[providers]` normalization, implicit routes from `llm.provider` /
  `llm.models`, obsolete input spellings and old-file fallback belong outside
  the normal configuration loader after a one-time conversion has been
  completed where necessary.
- Current Runtime startup initializes every Agent lacking a policy row with
  all configured accounts (`MorphzRuntime::start`). Already initialized empty
  policies remain empty, but a missing policy row alone is not proof of a
  historical Agent's intended authority. Separate deliberate first-install
  bootstrap from versioned upgrade migration and do not infer new grants from
  absence on every startup.
- A format cleanup must not automatically delete orphan bindings or restore
  obsolete accounts from ignored files. Determine provenance, snapshot the
  affected records, then perform an explicit one-time data cleanup. Preserve
  unrelated account state and secrets.

## Acceptance criteria for the cleanup

- Fresh setup, CLI and Dashboard write only the canonical schema; old inputs
  are rejected clearly rather than silently converted or partially ignored.
- A migrated catalog preserves IDs and is semantically equivalent for routes,
  credentials, Agent grants and intentionally empty policies.
- Model enablement changes routes, not Agent grants. Both an authorized Agent
  and an unconfigured sibling retain their policy revisions and exact bindings
  through repeated saves and Runtime reconstruction.
- An authorized Agent can bind a newly enabled model to its existing account;
  an unconfigured Agent still cannot bind a model request.
- Missing references are diagnosable; restarts never restore revoked grants,
  manufacture accounts or grant every account to an unconfigured Agent.
- A failed file write, failed publication or interrupted migration cannot be
  reported as a complete success. Test recovery at each supported boundary.

The hot-publication regression covers the model-enable and binding-preservation
criteria. The broader configuration-loader and startup-migration cleanup is a
separate change, not silently included in that bug fix.
