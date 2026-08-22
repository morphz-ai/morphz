# Morphz Principal Execution Policy Proposal v1

Status: design proposal; not yet a security contract.

## 1. Problem

Morphz already authenticates a stable Principal and binds it to a Session. That answers **who is acting**, but it does not yet express a complete per-Principal execution policy such as:

- which execution Targets the Principal may inspect, read, write, execute on, or transfer files to;
- which logical and physical tools may be invoked;
- which filesystem roots, Secrets, network destinations, or approval modes may be used;
- whether the policy applies to one Agent, Context, Session, Objective, or Thread.

The existing `execution_target_authorizations` relation is narrower. It constrains an owned Target to Agent, Context, or Thread scopes. It does not encode operation-level rights and must not be presented as a complete per-Principal tool policy.

## 2. Security invariant

The effective authority of an operation is the intersection of all applicable ceilings:

```text
Runtime hard ceiling
  ∩ authenticated Principal policy
  ∩ Target authorization and Target capability
  ∩ current causal scope (Agent / Context / Session / Objective / Thread)
  ∩ explicit approval, when required
```

No lower layer may expand authority granted by an upper layer. Missing policy does not silently grant a broader capability when per-Principal policy enforcement is enabled.

## 3. Why this is not a small Dashboard-only feature

A trustworthy implementation must enforce policy twice:

1. **Model exposure:** omit or accurately describe tools the current Principal cannot use.
2. **Execution boundary:** authorize the concrete operation again immediately before its side effect.

Filtering only the prompt is advisory and can be bypassed by replay, a stale Evaluation, an SDK caller, or a forged tool invocation. Checking only the execution boundary is safe but gives the model a misleading tool catalog. Both are required.

It also requires a durable, revisioned policy model, SQLite/PostgreSQL parity, SDK and HTTP contracts, Dashboard management, audit events, revocation behavior, restart recovery, and race tests. Therefore v1 should not be approximated with an in-memory map or UI-only allowlist.

## 4. Minimal durable model

Prefer one policy plus normalized grants rather than embedding an unversioned JSON blob in a Principal record.

### PrincipalExecutionPolicy

- `id`
- `principal_id`
- `revision` (CAS fence)
- `status`: `active | disabled`
- `default_effect`: normally `deny` once policy enforcement is enabled
- timestamps and the Operator Principal that changed it

### PrincipalExecutionGrant

- `policy_id`
- `effect`: `allow | deny` (`deny` wins)
- `resource_kind`: `tool | target | filesystem | network | secret`
- `resource_id` or stable matcher
- `operations`: a closed set for that resource kind
- optional causal scope: Agent, Context, Session, Objective, or Thread
- optional expiry

For Targets, the first useful operation vocabulary is:

```text
inspect, read, write, execute, transfer_in, transfer_out
```

For tools, grants should use stable tool identifiers or stable capability categories, not translated display labels.

## 5. Evaluation and execution semantics

- Snapshot the effective policy revision into each model attempt for auditability.
- Re-evaluate authority at the side-effect boundary using the latest policy revision.
- Revocation prevents new side effects immediately; it does not pretend an already completed external effect was undone.
- A running attempt whose required authority was revoked receives a typed authorization failure, not a Provider failure.
- Approval may narrow or authorize an operation only within the Runtime hard ceiling; it cannot override a hard deny.
- Secret visibility is separate from tool visibility. Permission to invoke a tool does not imply permission to read or inject every Secret.

## 6. Product surface

The Principal page should show an Operator-editable **Execution policy** section:

- a readable summary of effective access;
- Target grants with explicit operations;
- tool/capability grants;
- filesystem, network, and Secret restrictions;
- inherited Runtime ceiling and differences from it;
- revision, last editor, and audit history.

Presets may accelerate configuration (`observe only`, `workspace contributor`, `trusted operator`) but must expand into visible grants. They must not be hidden behavior.

## 7. Relationship to Session context isolation

Session context isolation is intentionally a different mechanism:

- it prevents a non-current Session's conversation history from entering another Session's **automatic working set**;
- the isolated Session still sees its own history when it is current;
- shared Mind remains shared;
- explicit Recall is not blocked by this switch;
- it is a privacy and attention-control policy, not an authorization boundary.

An Operator may change this Session policy even when observing another Principal's Session. A participant cannot change the policy unless separately authorized.

## 8. Required tests before release

- SQLite/PostgreSQL conformance for create, CAS update, revoke, and restart persistence;
- concurrent revoke versus tool execution;
- model tool catalog and execution-boundary decisions agree;
- Target operations are independent (for example, read does not imply execute);
- cross-Principal and cross-Context denial;
- stale Evaluation cannot use a revoked grant;
- approval cannot exceed the Runtime ceiling;
- audit projection shows the exact policy revision used by every physical model attempt and side effect.

## 9. Recommendation

Do not add a partial per-Principal tool toggle in the current Dashboard patch. Implement Session context isolation now because its semantics are bounded and testable. Schedule Principal execution policy as one security-focused objective covering schema, enforcement, API, UI, and conformance together.
