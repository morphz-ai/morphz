---
title: Core concepts
description: A stable mental model for Agents, Contexts, Sessions, cognitive frames, and execution.
section: concepts
order: 100
status: current
---

Morphz separates model evaluation from runtime state. Models propose cognition and action; the runtime validates structure, permissions, causality, and persistence.

## Agent

An Agent combines identity, cognitive policy, tool boundaries, and defaults. It is not a model account or a single model request.

## Context

A Context is the long-lived cognitive scope owned by an Agent. It holds current cognition, cognitive frames, observations, relations, and a recallable ledger. Multiple Sessions may share one Context, so starting a new Session does not imply amnesia.

## Session

A Session is an ordered communication stream between a user, an Agent, or an external channel. It provides message order and a delivery destination, but it does not own the Context. Archiving a Session does not delete cognition already formed in the Context.

## Cognitive frame

A cognitive frame is an addressable, versioned unit of cognition. It can represent a fact, constraint, plan, or developing understanding and carries provenance and lifecycle state. Retirement removes a frame from the active working set without erasing it from the ledger.

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
  → Context encoding
  → Thread Activation
  → Model Attempt
  → Runtime validation of text or tools
  → Event and cognition commit
  → Delivery to the target Session
```

Model success, tool success, and final delivery are therefore distinct states.
