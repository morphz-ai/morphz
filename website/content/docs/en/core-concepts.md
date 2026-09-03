---
title: Core concepts
description: Understand how Morphz lets one agent own cognition, advance concurrent work, and act within controlled boundaries.
section: concepts
order: 100
status: current
---

Morphz is an open-source agent for durable, concurrent work. Its execution core is an **S-Expression Cognitive Machine**: the language model supplies nondeterministic interpretation, judgment, and action proposals, while the Runtime owns deterministic identity, versions, causality, authority, scheduling, and persistence.

These parts form one agent. They are not separate products.

## Agent and Context

An Agent is the durable subject of work. It has a stable identity and a root Cognitive Context that carries shared cognition and Runtime state. A model account, a Session, or an individual model request is not the Agent itself.

A Context is first-class, durable, versioned, evaluable state. Before every Evaluation, the Runtime compiles Events, current cognition, the Session directory, scheduler state, capability boundaries, and one Evaluation entry point into a structured expression. The model therefore computes over the Agent's current state rather than an ever-growing transcript.

## Events, Observations, and cognitive Frames

Morphz carries long-term memory through authoritative Event History, Agent-maintained cognitive state, and a Context Encoding compiled for each Evaluation. History preserves what happened, cognitive Frames express the Agent's current understanding, and Context Encoding selects what the current Evaluation can see.

An Event records a fact that occurred, such as user input, a tool result, an approval decision, or a state commit. Event History is authoritative. Physical append order is not automatically business causality; Threads, Activations, and direct-source fields carry causal structure.

An Observation is the visible projection of an Event in the current Context. Large values may appear as previews with stable references that Recall can resolve later.

A cognitive Frame is a unit of Agent-maintained cognition. It can represent a fact, constraint, plan, or developing understanding. A Frame has identity, revision, sources, relations, protection, and lifecycle. The model can create or change Frames only through explicit versioned transactions; the Runtime validates the transaction and preserves its commit boundary.

This evidence-driven maintenance is Morphz's form of self-evolving cognition: the Agent can revise, retire, restore, and reorganize long-term cognition while preserving the provenance and version of every change.

## Principal identity

A Principal is the stable identity and authority source entering the Runtime. It may represent a person, organization, service, or delegated identity. One Principal can interact with the same Agent across multiple Sessions; messages, Objectives, approvals, and Capability Leases preserve their originating Principal along the causal path.

Principal, Agent, and Session carry distinct semantics: Principal identifies who interacts or grants authority, Agent identifies who owns cognition and works, and Session identifies the connection through which an interaction occurs.

## Sessions, Threads, and Activations

A Session is an input/output connection and progress boundary. One Agent may own multiple Sessions in the same Context. They share cognition while retaining their own message order, delivery destination, and attention state. A Session is neither a separate Mind nor a copy of the Agent.

A Thread is the stable causal path of one unit of work. A new message can create a new Thread while an older Thread waits for a tool, approval, or timer.

An Activation is one leased execution opportunity for a Thread. It may include several model attempts and tool actions until the work completes, waits, or reaches another durable boundary. An Activation ending does not necessarily end its Thread.

## Objectives and durable scheduling

An Objective represents an intention that must continue across Evaluations, waits, or process restarts. It owns status, revision, budget, dependencies, an Evaluation lease, and a final delivery destination. The scheduler derives whether it is runnable, waiting, leased, paused, blocked, or terminal from durable dependencies rather than inferring that state from conversation text.

Ordinary dialogue does not require an Objective. Use one when work genuinely needs durable supervision and a convergence condition.

## Cognitive Applications, Harnesses, and Yao

A Cognitive Application gives an existing Agent a reusable domain practice. The current implementation distributes a minimal Cognitive Application as a `.hns` package. Its Harness defines the practice contract, entry program, capability requirements, and optional default cognition for one Evaluation.

Yao is the typed S-expression program language used by these packages. A Harness may organize reasoning, tool calls, evidence, and Outcomes, but it cannot create a private scheduler, expand authority, or commit physical effects outside the Runtime.

## Execution Targets and capability boundaries

An Execution Target is the stable destination of physical tool work. It may be the current machine, a managed SSH host, or an Edge device connected through `morphz-edge`. Selecting a Target does not grant authority. Principal identity, Target authorization, sandboxing, approval policy, and Capability Leases must still permit each action.

## Agent Trajectory

An Agent Trajectory projects authoritative Events and state transitions into a portable causal graph for inspection, evaluation, or permission-checked training Episode derivation. It is neither a transcript nor a new source of truth. Export and verification never rewrite Event History.

## How one request moves

```text
user or external Event
  → Session admission and causal Thread
  → Context compilation
  → leased Activation
  → model Evaluation and proposed cognitive or physical change
  → version, authority, and physical-boundary validation
  → Event and state commit
  → delivery to the owning Session
```

A model completion, a successful tool action, a state commit, and final delivery are separate boundaries. Morphz records them separately so the correct workstream can continue after concurrency, failure, or restart.

Continue with [Contexts, cognitive Frames, and Recall](/en/docs/contexts-and-recall), [Sessions and concurrent work](/en/docs/sessions-and-concurrency), and [Threads, Activations, and Objectives](/en/docs/execution-lifecycle).
