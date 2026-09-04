---
title: Agent Trajectories
description: Export portable causal state transitions from authoritative Events and verify them without executing untrusted content.
section: concepts
order: 150
status: current
---

An Agent Trajectory is a bounded projection of authoritative Events and state. It organizes inputs, decisions, Actions, admission, state transitions, and Outcomes into a portable causal graph for inspection, evaluation, or permission-checked training Episode derivation.

Runtime Event History remains authoritative. A Trajectory projects only the causal state transitions relevant to its selected scope. Export, verification, and Episode derivation are read-only operations.

## Bundle contents

An Agent Trajectory Bundle contains:

- stable Trajectory identity, specification version, and Profile claims;
- export source and Context, Objective, or Activation scope;
- State references, Trajectory Nodes, and typed causal Edges;
- Outcomes, Verifier Results, and Reward Records;
- integrity digest, transforms, disclosure, and rights declarations.

The Exporter uses indexed queries to select bounded Events and preserves parents outside the scope as external references. The selected Context, Objective, or Activation always determines the export boundary.

## Three Profiles

- `AT-Core` represents core causal state transitions;
- `AT-Evaluation` adds the available environment and model-binding projection needed for evaluation;
- `AT-Training` supports training Episode derivation and still requires explicit training rights.

By default, export omits user-message content and grants no training use. `--include-user-content` explicitly includes that content. `--allow-training` is accepted only with `AT-Training`.

## Export and verification

```bash
morphz trajectory export \
  --context-id=context-default \
  --objective-id=<objective-id> \
  --trajectory-profile=AT-Core \
  --output=trajectory.json

morphz trajectory verify trajectory.json
```

Verification treats the input as untrusted data. It does not execute payloads, dereference external resources, restore capabilities, or write to the Runtime. It checks identity uniqueness, cross-references, State references, causal acyclicity, scope consistency, and the integrity digest.

The current integrity mechanism uses a deterministic SHA-256 digest to detect content tampering. Publisher identity and the external truth of a represented Outcome require independent evidence.

## Derive a training Episode

Episode derivation requires both the `AT-Training` Profile and explicit training permission:

```bash
morphz trajectory export \
  --context-id=context-default \
  --trajectory-profile=AT-Training \
  --allow-training \
  --output=training-trajectory.json

morphz trajectory episode training-trajectory.json \
  --output=episode.json
```

The derived form separates model input, supervised target, environment output, and loss-mask roles. The Runtime rejects derivation when the training Profile, rights declaration, or valid integrity record is missing.

## Current boundaries

- export may preserve external parents without fetching their complete causal closure;
- State is primarily represented through exact version references and optional deltas rather than automatically disclosed full Context snapshots;
- environment and model bindings are best-effort projections of known Runtime facts and must not be invented when unavailable;
- Dataset sharding, consent revocation, trainer adapters, normative signatures, and independent interoperability suites are not current implementation features.
