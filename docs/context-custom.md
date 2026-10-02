# Context Custom: caller-defined structured content

The canonical name is **Custom**, scoped by Context: Rust `morphz::context::Custom`
and the model-facing `(custom ...)` node. A caller defines the namespace, schema
and nested body. Runtime owns validation, version persistence and mounting, not
the application-specific meaning of fields. Custom is data, not executable code,
a plugin, a Runtime built-in settings schema, or Mind memory. Profile is one
application-owned schema using this mechanism.

## Ownership and authority

- The key remains `(agent_id, namespace, principal_scope?)`. A public entry is
  available to that Agent; a private entry is selected only for a Thread's exact
  persisted initiating Principal. This isolates selection, not the whole shared
  Mind or Session history.
- The executing Agent cannot update Custom through `context_tx` memory
  operations. A trusted Host/operator can publish another version. Do not expose
  generic management credentials or a Custom editor as an ordinary model tool.
- HTTP uses existing operator authorization. A gateway credential alone does not
  authorize Custom. Existing default local deployments without an operator token
  retain their no-token mode; configuring an operator token enforces it. Embedded
  SDK adapters remain responsible for authenticating their caller.
- Body content cannot override Runtime identity, authentication, permissions,
  protocol or safety. There is no automatic hierarchy inheritance or precedence
  engine hidden in the name Custom.

## Versioned data and execution binding

Every write supplies a command ID, expected revision, key, schema tag, one
balanced S-expression body, enabled state and optional authoring state. Runtime
canonicalizes the data and atomically commits the immutable version, current
head and authority-bound retry receipt. A stale revision conflicts; replaying an
identical command returns its original receipt, even after the head advances.
Changing the payload or authority under an existing command ID is rejected.

The existing SQLite/PostgreSQL data model, relationships and indexes are
unchanged. The legacy physical tables `agent_rom_heads`, `agent_rom_versions`,
`agent_rom_command_receipts`, `thread_rom_mounts` and `thread_rom_bindings` remain
in place. No duplicate Custom store, data copy, live-table rename or new schema
migration is required. Existing entry IDs, body hashes and receipt hashes retain
their original domain strings. These are compatibility identities, not current
product terminology.

At its first Context compilation, a root Thread binds the current enabled public
and initiating-Human entries. Rebuilds, continuations and recovery read that
immutable binding, not mutable heads. New settings affect new work; they do not
rebind existing work or rewrite historical input. Disabling creates another
version without deleting settings or old bindings. There is no hard-delete API.

The optional `authoring_state_sexpr` retains editor-only data, such as a disabled
custom style. It is committed in the same version/transaction and stripped both
when loading execution bindings and when mounting Context. Omitting it is a
complete write of `None`, not an implicit merge. It never enters model messages.

Limits remain 8 KiB per body and independently per authoring value, depth 32,
4096 nodes, 32 stored entry heads per Agent and 32 KiB of selected effective
body content. The head limit spans public and private scopes, including disabled
entries; it is not a multitenant scaling guarantee.

## Context encoding and cache compatibility

New nonempty bindings use the new Custom compiler and render deterministically
between protocol and evaluation profile:

```lisp
(context
  (protocol ...)
  (custom
    (entry
      (namespace example.profile)
      (scope agent)
      (revision 2)
      (schema example-profile/v1)
      (body (profile (name Nora)))))
  (evaluation-profile ...)
  ...)
```

The compiler identity includes the rendering contract and model-facing rule.
Manifest verification uses the exact persisted compiler identity. New cache
contracts use `custom_manifest`, `custom_compiler` and `custom_versions`;
durable model-attempt binding metadata uses `custom`.

Previously bound legacy Threads retain their original compiler, `(agent-rom ...)`
node, system rule, manifest hash, `rom_*` cache-contract fields and `agent_rom`
attempt metadata. The rename neither recompiles them using the new compiler nor
invalidates their existing transport seed. Unknown compiler hashes are rejected.
Legacy empty mounts and migration IDs remain unchanged.

Absent/empty effective content still adds no Context node, system rule, attempt
metadata or extra cache-contract dimension. The exact empty built-in Agent
Profile v2 body remains excluded from new bindings. Schema tags, profile body
bytes, numerical preferences and authoring-state semantics are not renamed.
These guarantees concern deterministic bytes and transport fences, not measured
upstream provider cache-hit rates or guaranteed model adherence.

## Canonical APIs and compatibility

- Rust types: `context::Custom`, `CustomKey`, `PutCustomCommand`,
  `CustomCommandReceipt`, `CustomMutation`, `ThreadCustomManifest`.
- Rust SDK: `get_custom_as_operator`, `list_custom_as_operator`,
  `put_custom_as_operator`, `get_thread_custom_as_operator`.
- TypeScript: `context.Custom` and related types;
  `listCustomAsOperator`, `getCustomAsOperator`, `putCustomAsOperator`,
  `threadCustomAsOperator`.
- HTTP: `GET /api/agents/:id/custom`, `GET/PUT /api/agents/:id/custom/:namespace`,
  and `GET /api/threads/:id/custom`. The optional principal-scope query and
  route/key consistency validation are unchanged.

Old `/rom` routes share the same handlers, authorization, revisions and receipt
store. Legacy SDK/type names remain compatibility aliases or forwarding
methods. Legacy TypeScript methods explicitly request `/rom` for old Runtime
interoperability; canonical methods request `/custom` and never retry a failed
write on another route. The application Profile client uses `/custom` only.

The internal storage trait is now `CustomStore`; old method calls forward to the
canonical methods. External implementations of the implementation-surface Store
trait must update their required method names. This is separate from the
supported embedded SDK aliases and JSON wire compatibility.

The original [Agent ROM document](agent-rom.md) describes the retained legacy
wire/storage surface. Ordinary development should use Custom terminology and
the canonical APIs above.
