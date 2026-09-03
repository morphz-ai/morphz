---
title: Cognitive Applications, Harnesses, and Yao
description: Replace the default Evaluation Loop with a versioned domain program while retaining Runtime scheduling, authority, and transaction boundaries.
section: concepts
order: 140
status: current
---

A Cognitive Application gives reusable domain practice to an Agent that already exists. It does not create another Agent identity or turn domain logic into a separate Runtime that bypasses Morphz.

## Three distinct layers

- a **Cognitive Application** is the user- and ecosystem-facing program unit that can organize domain methods, tools, resources, and integrations;
- a **Harness** is its executable semantic core, defining how one Evaluation reasons, collects evidence, invokes tools, and forms an Outcome;
- an **HNS package** is the current minimal installable distribution form: one `.hns` file or directory carrying one primary Harness.

The current implementation supports atomic HNS Cognitive Applications. Composite application packages with multiple primary Harnesses, interfaces, marketplace assets, and complex dependencies are not current Runtime capabilities.

## Package contents

The Loader normalizes either physical `.hns` form into the same logical contents:

- `manifest`: identity, version, title, entry, and capability declarations;
- `contract`: stable model-visible domain objects and practice constraints;
- optional `mind`: read-only default cognition that is not automatically written into the Agent's persistent Mind;
- optional `fn` forms: package-local functions, of which only explicitly exported interfaces are model-visible;
- one `eval` or `infer` form: the sole Evaluation entry program.

File and directory packages differ only in physical layout. The Runtime hashes normalized logical content, so equivalent packages have the same content identity.

## Installation is not activation or authority

```bash
morphz harness install ./coding.hns
morphz harness list --format=json
morphz harness show coding@1.0.0 --format=json
```

Installation validates the package and admits an exact version to the local catalog. Reusing the same identity and version for different content is rejected, and the Runtime does not resolve floating versions such as `latest`.

Installation does not activate a Harness or grant its declared tool requirements. An Objective may select a default binding:

```bash
morphz objective create \
  --harness=coding@1.0.0 \
  repair the workspace and verify the result
```

When that Objective starts an Evaluation, the Runtime fixes the exact Harness identity, version, and artifact hash in the Evaluation binding. Successor Activations continue to read that binding rather than silently switching package versions.

## `eval` and `infer`

Yao is the typed S-expression program language used by the current HNS profile. The entry form selects ownership of the Evaluation Loop:

- `eval` is Runtime-owned. The Runtime lowers the entry to a durable Typed Plan and may delegate bounded reasoning steps to the model.
- `infer` is model-owned. The model reasons within the current domain contract and requests its next action through an explicit function call.

Neither form bypasses the Runtime. Tool execution, Context transactions, scheduling, waiting, recovery, and physical effects remain validated, persisted, and executed by the Runtime.

## Functions and capabilities

A package may declare types and functions. The Runtime puts only an exported function's name, types, description, and effect interface into model-visible Context. Private functions and exported function bodies remain hidden. At execution time, functions are statically linked to the exact Evaluation binding rather than installed in a process-global language environment.

Declared capabilities are requirements, not grants. An actual tool call must still pass:

1. current Principal and causal Thread checks;
2. Objective and Execution Target authorization;
3. sandbox and host policy;
4. one-time approval or a still-valid Capability Lease.

Domain validation may narrow behavior further but cannot expand those Runtime boundaries.

## A minimal package

```lisp
(manifest
  (id research)
  (version "1.0.0")
  (title "Evidence-led research"))

(contract
  (identity "research")
  (outcome "a conclusion with explicit evidence boundaries"))

(infer
  (requires (tools))
  "Collect evidence, preserve disagreements, and state the conclusion.")
```

`.hns` names a package profile, not the language. Cognitive Application is the user-facing program, Harness is the executable semantics, and Yao is the source language used by the current package profile.

See the [CLI reference](/en/docs/cli-reference) for complete command options.
