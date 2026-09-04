---
title: Sessions and concurrent work
description: Understand how one Agent maintains several Sessions over shared cognition while independent workstreams advance.
section: concepts
order: 120
status: current
---

One Cognitive Context owns one shared Mind and multiple Sessions. Each Session records its own input, output, message order, delivery destination, and attention state, while all Sessions use the same Agent cognition.

## Shared cognition and Session boundaries

Every Event records its source Session, while ordinary output is delivered only to the active Session of the current Evaluation. Once admitted to the Context, an Event can become shared evidence that other Sessions reason over or Recall.

Consequently:

- a cognitive Frame formed in Session A can be used from Session B;
- a new message in Session B does not take ownership of a tool result awaited by Session A;
- a visible message to another Session requires explicit routing, and an internal coordination signal also names its destination.

## The bounded Session Working Set

Each model request projects a bounded set of Sessions. The current Session always has priority. The Runtime may also select up to 50 Sessions with recorded activity in the previous 24 hours, then narrow that set to the current Context budget.

Each Session has one of three projection outcomes for an Evaluation:

- **full projection**: the current Session has priority, and other recent Sessions may include their complete working information;
- **metadata-only projection**: identity, state, and active work remain visible without expanding conversation content;
- **excluded from this Encoding**: archived, retired, isolated, out-of-window, over-count, or over-budget Sessions are omitted.

Exclusion from one Encoding is not deletion. The Session, Events, and work state remain durable.

## Retiring and restoring Session attention

`retire-session` moves a Session out of the current attention window while preserving its identity, Event history, and work state.

A new directed Event deterministically restores the destination Session so it can reenter the Working Set. The Agent may also call `restore-session` explicitly. Session attention and cognitive Frame changes can commit in the same Context transaction.

## Threads isolate causal work

A Session is an interaction boundary; a Thread is the causal path of one unit of work. One Session may contain several Threads at once:

```text
Session
├─ Thread A: waiting for a remote command
├─ Thread B: answering a new user question
└─ Thread C: waiting for approval
```

Tool results, timer wakes, and approval decisions resume only the Thread with matching causal identity. Physical Event sequence records persistence order; Thread identity determines which workstream an Event belongs to.

## Concurrent writes to shared cognition

Several Sessions and Threads may evaluate the same Context concurrently. The Runtime serializes Mind commits per Context and performs version checks at fine semantic boundaries. Independent changes can be safely rebased; genuine conflicts are rejected and must be reread.

## Session operations

```bash
morphz session list --context=context-default --format=json
morphz session show <session-id> --format=json
morphz session create --context=context-default
morphz session resume <session-id>
```

When work stops advancing, inspect both its Session state and the durable dependencies described in [Threads, Activations, and Objectives](/en/docs/execution-lifecycle).
