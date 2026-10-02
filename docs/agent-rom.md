# Agent ROM: caller-owned read-only configuration

ROM is versioned factory configuration supplied by an authenticated operator or
trusted embedding Host. It is **not Mind memory**, not an Objective, not a Harness,
and not a new model-callable tool. Runtime does not hard-code personality fields.
Applications own their schemas and may nest public identity, role, style, or other
configuration inside one S-expression body.

## Authority and scope

An entry key is `(agent_id, namespace, principal_scope?)`. No principal scope means
Agent-wide public configuration. A private scope must reference a real Runtime
Principal. Runtime binds only the exact root Thread's `initiating_principal_id`:
it never substitutes a Session participant, tool-trigger sender, operator identity,
or inferred person. An unattributed Thread receives public ROM only.

This scoping isolates **ROM selection**, not the existing shared-Mind or Session
history access model. It does not turn provenance into access control or assert
that a model can never repeat private information it has learned elsewhere.

Only the control plane can update ROM. `context_tx` create/revise/retire/protect/
unprotect/place/checkpoint/rollback operations operate on Mind, never ROM. A
look-alike Mind Frame cannot overwrite the separate configuration authority.
Namespace/body contents cannot replace Runtime identity, authentication, approval,
kernel facts, or protocol. A public persona name is not an authentication ID.

Rust embedded SDK methods are explicitly named `*_as_operator`; adapters must
authenticate and authorize their real caller before using them. HTTP requires the
existing **operator credential** for ROM reads/writes. A trusted-gateway Human
assertion is not generic ROM management authority. A Host may expose a curated
Human-confirmed Profile operation after validating its own governance, then call
this trusted boundary; the model must not receive a generic ROM editor.

## Minimal durable model

SQLite and PostgreSQL implement the same five tables in the Runtime Store:

| Table | Role |
| --- | --- |
| `agent_rom_heads` | Immutable key, mutable current-revision pointer |
| `agent_rom_versions` | Immutable effective body, optional authoring state and exact revision/hash |
| `agent_rom_command_receipts` | Durable authority-bound idempotency receipt |
| `thread_rom_mounts` | One immutable manifest per Thread, including empty |
| `thread_rom_bindings` | Ordered exact version references |

The body is stored once per version, not as a workspace JSON snapshot. Writes
atomically commit version, head, and receipt. SQLite uses `BEGIN IMMEDIATE`;
PostgreSQL serializes Agent writes/mounts with the Agent row lock and uses a
command advisory lock to fence cross-Agent command reuse.

### Optional authoring state

Trusted callers may also send `authoring_state_sexpr` for editor configuration
that they need to retain without showing it to the model, such as the text of a
disabled style. Operator record and committed/conflict responses expose its
normalized value as `canonical_authoring_state`. It is application-owned data,
not another model-visible ROM body or a new Agent capability. Runtime does not
interpret application-specific switches or infer effective configuration from it.
The caller must submit the intended effective `body_sexpr` separately.

Both values commit in the **same immutable version, CAS and SQL transaction**
with the head and authority-bound receipt. This is a complete version write:
omitting authoring state produces `None`, not a merge with an older version.
Each authoring value must independently satisfy the existing balanced, one-list,
8 KiB, depth-32 and 4096-node canonicalization limits. It is not counted as
effective Context content against the selected-body 32 KiB budget.

Store binding and historical Thread reads strip authoring state from their
manifests; Context mounting strips it again for embedded hand-built manifests.
Thus neither ContextView serialization, ROM rendering, model request messages,
nor the ROM cache contract exposes it. Trusted entry get/list and receipt replay
retain it, including after restart and after a newer revision has committed.
Applications must likewise return only effective fields from model-facing tools.

Commands without this optional field retain the original wire shape and exact
`morphz.agent-rom.command.v1` request hash, so existing receipts remain replayable.
Existing JSON callers need no change. Rust callers using public struct literals
must add the new optional field as `None`; wire compatibility does not imply
unchanged Rust literal source. `prepare_command` keeps its original tuple API.
Commands that include it use `morphz.agent-rom.command.authoring.v1`, covering
both the original canonical request and canonical authoring value. Reusing a
command ID with changed editor text is rejected even if the effective body is
unchanged. Body content, compiler and manifest hashing rules remain unchanged.
An authoring edit still creates a new revision; a new Thread's revision/prefix
can therefore change. This does not promise byte-identical new-Thread Context
after an editor-only save or provider cache hits. Existing Threads stay frozen.

`expected_revision: 0` creates; existing entries require the exact current head
revision. Stale writes return a conflict without changing authority. Retrying the
same `command_id`, normalized body, key, expected revision and authenticated
authority returns the **original immutable committed version and receipt**, even
after a newer head exists. Reusing the command ID with different content or
authority fails. Invalid principal references, bodies or limits roll back the
entire write. Disabling is a new version with `enabled: false`; historical bound
versions are retained. This first implementation deliberately has no hard delete.

## Thread freeze and compatibility

A new Thread atomically binds latest enabled public entries plus its exact
Human-scoped entries before its first model Context compilation/measurement.
Subsequent Activations, tool continuations, maintenance/refusal rebuilds and
recovery use those immutable versions, not current heads. Saved changes apply to
**new Threads**, not already-started work. The manifest is not rebound when Mind
snapshot versions advance or an existing Thread is retried.

The Morphz Agent Profile consumer has one explicit empty-selection exception:
at a **new Thread's initial binding only**, namespace `morphz.profile.agent`,
schema `morphz-agent-profile/v2` and exact canonical body
`(agent-profile (version 2))` are omitted before hashing/saving bindings. This
allows its explicit enabled switch to remain durably true without installing
empty personality instructions. Format and body hash must still be valid;
authoring text does not make an empty effective Profile nonempty. Other
namespaces, schemas, nonempty bodies and Human Profile semantics are unchanged.
Historical mount reads and the generic ROM compiler never apply this exception,
so even a previously bound empty Profile retains its original Context/cache
bytes. Saving or reading the entry does not rewrite its enabled value.

Migration `20261002_01_agent_rom` gives pre-existing Threads an explicit empty
mount, preserving their previous semantics. Migration runs once: a later restart
must not mount post-migration new Threads empty. An empty mount emits no ROM slot,
no ROM system rule, no ROM Attempt metadata and no extra cache-contract dimension;
legacy Context and model request bytes are preserved.

Migration `20261002_02_agent_rom_authoring_state` adds a nullable
`agent_rom_versions.canonical_authoring_state` column in SQLite and PostgreSQL.
Existing version/receipt rows keep their original bodies, hashes and revision
bindings; old records read with no authoring state. The new migration is
idempotent and does **not** repeat the old empty-mount backfill. PostgreSQL uses
its own new outer migration version, because an installed v1 store skips the
original ROM migration entirely.

SQLite/PostgreSQL migrations are part of this change. The fenced remote Store
automatically forwards the new trait and captures its ordinary SQL tables, but
its existing exact-schema safety check remains in force. **An already populated
remote Agent Cell requires an explicit coordinated schema migration**; installing
a new binary alone is not a safe remote-data upgrade. Do not bypass the mismatch
guard or claim a hosted deployment was migrated from local tests.

## Canonical Context and cache

ROM appears after `protocol` and before `evaluation-profile`:

```lisp
(context
  (protocol ...)
  (agent-rom
    (entry
      (namespace example.agent)
      (scope agent)
      (revision 2)
      (schema example-profile/v1)
      (body (profile (public-name Nora) (role assistant)))))
  (evaluation-profile ...)
  ...)
```

Private entries are wrapped as `scope initiating-human`; public/private modules
are not silently merged or used to shadow privileged roots. Order is deterministic
by namespace, public-before-private scope, then entry ID. Bodies are parsed as
data, not admitted as executable Runtime operations.

The body must be exactly one balanced list. Depth is checked **before** recursive
parsing. The existing S-expression parser/Display normalize bytes; the canonical
body must round-trip exactly. Limits are 8 KiB per entry, depth 32, 4096 nodes,
32 configuration entries per Agent (including disabled entries), and 32 KiB of
enabled body bytes in any public-plus-one-Human selection. Public updates validate
every existing Human combination using aggregate SQL metadata, without loading
unrelated private bodies. These bounded limits reject writes rather than silently
truncating instructions.

The 32-head bound includes all private Human scopes, not 32 entries per Human.
It is an explicit first-stage safety limit, not a multi-tenant scaling promise;
a future team deployment needs a separate reviewed quota model before exceeding it.

Domain-separated SHA-256 hashes cover canonical bodies, commands, manifests and
the ROM compiler contract. Prefix segmentation already treats everything before
`evaluation-profile` as stable. ROM stays present during prompt measurement,
pressure rendering and refusal recovery; token attribution labels it separately
from Mind Frames. Structured ContextDelta transport includes manifest, exact
versions and compiler hash in its contract so a previous cached seed cannot
substitute stale factory configuration. Empty ROM keeps the old digest. These
tests establish Runtime bytes/fences, not a real provider's cache-hit behavior.

Durable `runtime/model_attempt_state` metadata records the bound Thread, manifest,
compiler and version references. Full exact request diagnostics remain ephemeral;
immutable ROM versions plus binding tables are the historical authority.

## API

Rust types live in `morphz::agent_rom` and are re-exported through `morphz::sdk`.
TypeScript `MorphzClient` exposes matching operator methods.

- `GET /api/agents/:agent_id/rom?principal_scope=...` returns `{entries:[...]}`
  for only that exact scope; omission means public only, not all private entries.
- `GET /api/agents/:agent_id/rom/:namespace?principal_scope=...` returns the
  record directly; absent entry is HTTP 404.
- `PUT /api/agents/:agent_id/rom/:namespace?principal_scope=...` takes the command
  below. Route, query and key must match. Successful response is
  `{status:"committed",record,receipt,duplicate}`; stale revision is HTTP 409 with
  `{status:"conflict",current}`; missing Agent is HTTP 404.
- `GET /api/threads/:thread_id/rom` is an operator-only historical manifest read;
  it does not create a binding.

```json
{
  "command_id": "host-save-unique-id",
  "expected_revision": 0,
  "key": { "agent_id": "default-agent", "namespace": "example.agent" },
  "schema_tag": "example-profile/v1",
  "body_sexpr": "(profile (public-name Nora) (role assistant))",
  "authoring_state_sexpr": "(editor (custom-style Retained-text) (custom-enabled false))",
  "enabled": true
}
```

`authoring_state_sexpr` is optional; legacy commands need not send it. The
example's retained text is control-plane data only, not an installed custom
style. Only fields present in the effective `body_sexpr` enter model Context.

Caller-supplied actor fields are rejected. HTTP derives `http-operator` authority
from the validated control-plane credential; embedded Hosts supply their trusted
adapter authority identity. `principal_scope` is a target, never proof of a caller.

Before any conversation exists, the local Host can read default Agent/Principal
IDs from authenticated `/api/status`. A trusted Human gateway can POST an
**empty body** to `/api/principal/self`; the existing authenticated ingress
assertion is persisted and `{principal_id}` returned, without creating a Session.
Untrusted headers, a missing gateway assertion, and body-supplied identities are
rejected. Textual Human preferences may live in private ROM; avatars/media can
remain Host-owned presentation data without a second authoritative nickname store.
