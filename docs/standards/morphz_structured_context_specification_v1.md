# Morphz Structured Context Specification v1

> Status: Draft specification candidate
>
> Steward: Newvar
>
> Reference implementation: Morphz
>
> Source baseline: Morphz Context Protocol v32 and the 2026-08-15 Runtime status index
>
> Date: 2026-08-21
>
> Chinese translation: [zh-CN](zh-CN/morphz_structured_context_specification_v1.md)

## 1. Scope

This specification defines the normative data model, authority boundaries, transaction behavior,
provenance, attention lifecycle, and recovery properties of Morphz Structured Context.

It deliberately separates the public standard from the current serialization and code structure.
Protocol v32 is the implementation source used to prepare this candidate; the public specification
will receive its own semantic version and MUST NOT inherit every internal field merely because the
reference implementation currently contains it.

## 2. Normative vocabulary

The words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY are normative requirements.

- **MUST / MUST NOT**: required for the stated conformance profile.
- **SHOULD / SHOULD NOT**: expected unless an implementation documents a valid reason.
- **MAY**: optional behavior that cannot be required by a portable consumer.

Examples and implementation notes are non-normative unless explicitly identified otherwise.

## 3. Core entities

### 3.1 Agent

An Agent is a stable logical cognitive actor. It is not identical to a model process, Provider
request, Session, or operating-system process.

An Agent MUST have a stable identifier. Replacing its model or restarting its Runtime MUST NOT
implicitly replace its identity.

### 3.2 Context

A Context is a first-class, versioned cognitive state owned or used by an Agent. It contains or
addresses:

- an immutable Event History;
- a Runtime-owned Kernel projection;
- an Agent-owned Mind projection;
- delivered Inbox or Observation state;
- Session and attention projections;
- a monotonically ordered sequence of committed Context transactions.

A Context MUST expose a stable identifier and current revision.

### 3.3 Session

A Session is a stable interaction connection mounted to a Context. It MUST have its own identity and
MUST NOT be used as a synonym for Context or Agent.

Multiple Sessions MAY share a Context. Requests for different Sessions MAY execute concurrently,
subject to the causal visibility and transaction rules in this specification.

### 3.4 Event

An Event is an immutable record of an occurrence. It MUST have:

- a stable identifier;
- an authoritative sequence or equivalent ordering coordinate;
- a topic or type;
- an actor or authoritative source;
- enough routing identity to determine its Context and, when applicable, Session;
- direct causal references when the Runtime knows them.

An implementation MUST NOT edit a committed Event in place. Corrections and superseding facts are
new Events.

### 3.5 Observation and Inbox

An Observation is the Agent-visible representation of an Event or Runtime fact. Inbox is the
delivery area for Observations that remain available for cognitive processing.

An Observation MUST retain a stable path back to its source Event. Rendering an Observation as a
preview, metadata-only entry, or recalled chunk MUST NOT change the original Event.

### 3.6 Kernel

Kernel is the Runtime-owned projection of authoritative operating facts, including identity,
permissions, active execution, budgets, pressure, versions, and control state. It is read-only to
the Agent except through explicit Runtime commands.

### 3.7 Mind

Mind is the Agent-owned cognitive projection. It consists of Frames and Relations and MAY contain
arbitrary domain structure inside Frame bodies.

The Runtime MUST understand only the structural metadata needed to validate, version, order,
protect, relate, project, and recover Frames. It MUST NOT require a universal business ontology for
Frame bodies.

### 3.8 Frame

A Frame is a stable cognitive unit with at least:

- an identifier unique within its Context;
- a revision;
- an Agent-authored body;
- lifecycle state;
- optional protection state;
- optional source references.

Revising a Frame preserves its identity and increments its revision. Historical Frame bodies remain
recoverable from committed transaction facts even when the active projection contains only the
latest body.

### 3.9 Relation

A Relation is an explicit edge between stable identifiers. Relation names are open by default.
Implementations MUST NOT infer standard business meaning from a relation unless this specification
or an extension profile defines it.

### 3.10 Projection

A Projection is a derived current-state view over authoritative history. Event History answers what
happened; a Projection answers what the current state is.

Projection corruption MUST be recoverable from authoritative records or MUST fail visibly. A
Runtime MUST NOT silently invent missing history to repair a Projection.

## 4. Authority matrix

| State or decision | Agent authority | Runtime authority |
| --- | --- | --- |
| Frame body and cognitive meaning | create and interpret | persist and validate structure |
| Semantic importance and abstraction | decide | MUST NOT assign silently |
| Evidence interpretation | decide | preserve declared source references |
| Event identity, order, and direct cause | interpret | generate and enforce |
| Permissions and resource limits | observe and obey | define and enforce |
| Context transaction intent | submit | validate, commit, reject, and audit |
| Active attention | request changes | apply transactionally and project |
| Physical tool result | interpret | record faithfully |
| Current Projection | read and modify through allowed operations | derive from authoritative facts |

## 5. Context transaction model

### 5.1 Transaction envelope

A Context transaction MUST declare a base Context revision or an equivalent concurrency token. It
MAY include an audit reason and MUST include one when retiring protected or active information, or
removing protection.

The Runtime MUST:

1. parse the complete transaction before mutation;
2. resolve stable references against the authorized Context;
3. validate identity, lifecycle, permission, source, and concurrency constraints;
4. compute changes against an isolated candidate state;
5. commit all authoritative Events and affected Projections atomically;
6. return the committed revision and structured result, or a structured rejection;
7. leave the previous state intact when the transaction is rejected.

### 5.2 Core operations

The v1 candidate defines the following semantic operations:

| Operation | Required semantic effect |
| --- | --- |
| `create` | create a new Frame with a stable identifier |
| `derive` | create a Frame with explicit declared sources |
| `revise` | replace the active body of an existing Frame while preserving identity |
| `retire` | remove a Frame or Observation from active semantic attention without deleting history |
| `restore` | return a retired Frame or Observation to active semantic attention |
| `protect` / `unprotect` | enable or remove Runtime-enforced retirement protection |
| `place` | change attention order without changing Frame meaning |
| `relate` / `unrelate` | add or remove an explicit Relation |
| `checkpoint` | name a recoverable Context state |
| `rollback` | create a new committed state derived from a checkpoint; history remains append-only |
| `drop-checkpoint` | remove checkpoint availability without rewriting historical Events |
| `retire-session` / `restore-session` | change Session attention membership without deleting Session history |

The concrete wire syntax may use the Morphz `context_tx` S-expression DSL. Independent
implementations MAY expose another API if it produces equivalent observable behavior and passes the
conformance profile.

### 5.3 Concurrency

An implementation MUST reject a stale transaction when it cannot prove the change is independent
of intervening commits.

An implementation MAY safely rebase changes to independent Frames after validating read and write
sets. It MUST reject at least:

- concurrent incompatible changes to the same Frame revision;
- creation of the same stable Frame identifier with different content;
- a derivation whose declared source changed in a way that invalidates the submitted read set;
- global lifecycle operations that cannot be safely reduced to independent objects.

Conflict handling MUST be observable. Silent last-writer-wins behavior is non-conformant.

## 6. Provenance and reality contract

The Runtime MUST distinguish physical facts from Agent conclusions.

- Presence in Inbox does not make an Observation true.
- Recency and usage do not establish semantic authority.
- A newer physical version does not automatically prove a broader semantic conclusion.
- The Runtime MUST NOT make future evidence visible before it is physically available and
  authorized for the active causal scope.
- `derive` and source-bearing `revise` operations MUST preserve the declared evidence lineage.
- The Agent MAY hold hypotheses or incorrect beliefs; the Runtime MUST still preserve the actual
  source and transaction history.

## 7. Attention, residency, and recovery

Implementations MAY use full, preview, metadata-only, recalled, resident, swapped-out, or equivalent
rendering states. Each state MUST be distinguishable to the consumer when the distinction affects
available content.

An implementation MUST NOT:

- represent a preview as the complete original;
- equate exclusion from one model request with semantic retirement;
- equate semantic retirement with physical deletion;
- discard the stable source needed for explicit recall when it claims the item is recoverable.

Resource pressure MAY trigger a Runtime signal or a mechanical projection decision. It MUST NOT
silently author an Agent conclusion or opaque semantic summary.

## 8. Session and causal visibility

Each model Evaluation MUST identify its active Session and causal activation scope. Context-wide
committed Mind state MAY be visible across authorized Sessions, while local Session evidence MUST
respect its causal boundary.

A late tool result MUST resume or signal the causal work that created it. It MUST NOT be delivered
as if it belonged to an unrelated Session merely because that Session is currently active.

Cross-Session messages or signals MUST identify source and destination explicitly. Referencing a
Session MUST NOT implicitly import its transcript, activate it, or copy its private evidence.

## 9. Durability and recovery

For a durable conformance profile:

- committed Context transactions MUST survive a clean restart;
- a crash before commit MUST leave no partial authoritative mutation;
- a crash after commit MUST allow the same current state to be reconstructed;
- rebuilding Projections MUST reproduce the same observable Context revision and active state;
- retries MUST be idempotent where the protocol exposes a stable request or transaction identity.

## 10. Canonical representation

The first public version will define a canonical S-expression representation for protocol fixtures,
hashing, debugging, and reproducible conformance reports. The representation MUST specify ordering,
escaping, stable identifiers, optional fields, and version negotiation.

The current Morphz renderer is an implementation source, not yet the frozen public wire standard.
Fields that exist only for current scheduling or Provider optimization SHOULD remain implementation
extensions unless portable consumers require them.

## 11. Conformance profiles

The v1 candidate reserves these profiles:

- **SC-Core**: object model, authority boundaries, transaction semantics, provenance, and attention;
- **SC-Durable**: SC-Core plus restart, replay, and Projection recovery;
- **SC-Concurrent**: SC-Durable plus conflict detection, causal routing, and concurrent Session work;
- **SC-Distributed**: SC-Concurrent plus multi-Runtime fencing, leases, and cross-process recovery.

The exact required cases are defined by the matching Conformance Suite release. Morphz does not
claim public certification for these profiles until the standalone suite is extracted and a signed
report is published.

## 12. Versioning and extensions

The public specification uses semantic versions independently of internal Context Protocol numbers.

- Patch releases clarify text or add tests without changing conformant behavior.
- Minor releases add backwards-compatible optional behavior or profiles.
- Major releases may change required observable behavior and MUST provide a migration statement.

An extension MUST use a namespaced identifier, declare its required base version, and fail visibly
when required semantics are unavailable. An extension MUST NOT redefine a core term while claiming
compatibility with the unchanged core version.

## 13. Open decisions before Candidate status

The following decisions remain intentionally open:

1. canonical wire representation and negotiation fields;
2. the minimal portable Event and Projection schemas;
3. whether checkpoint operations belong to SC-Core or SC-Durable;
4. the precise boundary between retirement and future residency/swap semantics;
5. compatibility rules for Frame-level rebase across independent implementations;
6. normative privacy and Principal visibility profiles;
7. the canonical English terminology and translation policy.

Each decision requires an MEP or an explicitly recorded specification review before v1 Candidate.
