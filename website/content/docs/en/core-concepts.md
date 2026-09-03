---
title: Core concepts
description: A stable mental model for the S-Expression Cognitive Machine, Agents, Contexts, Sessions, cognitive frames, and execution.
section: concepts
order: 100
status: current
---

Morphz is an **S-Expression Cognitive Machine**. S-expressions carry its executable cognitive state, programs, constraints, and evaluation entry points. A replaceable language model acts as the nondeterministic semantic processor that proposes cognition and action; the Runtime acts as the deterministic transactional kernel that validates structure, permissions, causality, versions, and persistence.

## Agent

An Agent is an instance of the machine with a loaded identity, cognitive policy, tool boundaries, and defaults. It is not Morphz's base machine definition, a model account, or a single model request.

## Context

A Context is first-class state owned by an Agent: persistent, versioned, and directly evaluable. A model call receives a **Context Encoding** compiled by the Runtime. Its fixed structure includes protocol, Inbox, Observation State, Mind, Session Directory, Kernel, Evaluation Environment, and the sole `evaluate` entry. Event History remains distinct from current cognition and provides recallable evidence through stable references.

## Session

A Session is a first-class interaction and execution object inside Context. It records message order, delivery destination, current work, and causal origin, and appears in Context Encoding through the Session Directory.

Each Evaluation compiles a bounded Session Working Set. The current Session always receives a full projection. Other Sessions may be fully projected, represented as metadata only, or swapped out of that Encoding according to the activity window, count limit, and Token Budget. Swapping out changes only what the model sees in that Evaluation; it does not delete the Session or Event History. The Agent can Recall its evidence, and a new directed event can bring it back into the working set.

## Context capacity and self-maintenance

Morphz does not let the Runtime silently rewrite the entire Context into an automatically generated lossy summary. The Runtime measures Token pressure, preserves physical facts, and enforces resource boundaries. The Agent decides semantic value and uses an explicit Context Transaction to `derive`, `revise`, `retire`, `restore`, or `protect` cognition. Capacity control, cognitive evolution, and audit therefore use the same state-transition mechanism.

## Cognitive frame

A cognitive frame is an addressable, versioned unit of cognition. It can represent a fact, constraint, plan, or developing understanding and carries provenance and lifecycle state. Retirement removes a frame from the active working set without erasing it from the event history.

## Thread and Activation

A Thread is a continuing line of work. An Activation is one concrete opportunity for the runtime to execute that Thread. An Activation may end while its Thread waits for a later event. Child work belongs to a parent Thread or an independent durable goal—not to the short-lived Activation that happened to create it.

## Objective

An Objective represents work that must converge across multiple turns. It owns goal state and completion conditions and can be rescheduled after restarts or transient model failures. Final delivery remains part of the Objective lifecycle.

## Provider and model route

A Provider defines where and how requests are sent; an auth account defines the identity; a physical model is the exact name accepted by the service; a model route provides a stable user-facing selection and candidate policy.

## Request boundary

```text
User message
  → Session ingress
  → Session Working Set and Context Encoding compilation
  → Thread Activation
  → Model Attempt
  → Runtime validation of text or tools
  → Event and cognition commit
  → Delivery to the target Session
```

Model success, tool success, and final delivery are therefore distinct states.
