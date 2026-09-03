---
title: Sessions and concurrent work
description: Understand how one Agent maintains several Sessions over shared cognition while independent workstreams advance.
section: concepts
order: 120
status: current
---

One Cognitive Context owns one shared Mind and multiple Sessions. Sessions provide distinct input, output, and progress boundaries without copying the Agent's cognition.

## A Session is not a cognition container

Every Event records its source Session, and ordinary output is delivered only to the active Session of the current Evaluation. Once admitted to the Context, however, an Event can become shared evidence that other Sessions reason over or Recall.

Consequently:

- a cognitive Frame formed in Session A can be used from Session B;
- a new message in Session B does not take ownership of a tool result awaited by Session A;
- a visible message to another Session requires explicit routing, and an internal coordination signal also names its destination.

## The bounded Session Working Set

The Runtime does not place every Session's complete history in every model request. By default, it considers up to 50 Sessions with cognitively meaningful activity in the previous 24 hours, subject to the current Context budget.

Each Session has one of three projection outcomes for an Evaluation:

- **full projection**: the current Session has priority, and other recent Sessions may include their complete working information;
- **metadata-only projection**: identity, state, and active work remain visible without expanding conversation content;
- **excluded from this Encoding**: archived, retired, isolated, out-of-window, over-count, or over-budget Sessions are omitted.

Exclusion from one Encoding is not deletion. The Session, Events, and work state remain durable.

## Retiring and restoring Session attention

`retire-session` only moves a Session out of the current attention window. It does not make the Session invalid, expire its facts, or fail its work.

A new directed Event deterministically restores the destination Session so it can reenter the Working Set. The Agent may also call `restore-session` explicitly. Session attention and cognitive Frame changes can commit in the same Context transaction.

## Threads isolate causal work

A Session is an interaction boundary; a Thread is the causal path of one unit of work. One Session may contain several Threads at once:

```text
Session
├─ Thread A: waiting for a remote command
├─ Thread B: answering a new user question
└─ Thread C: waiting for approval
```

Tool results, timer wakes, and approval decisions resume only the Thread with matching causal identity. A later Event sequence does not mean the Event belongs to the current workstream and does not justify merging messages across Threads.

## Concurrent writes to shared cognition

Several Sessions and Threads may evaluate the same Context concurrently. The Runtime serializes Mind commits per Context and performs version checks at fine semantic boundaries. Independent changes can be safely rebased; genuine conflicts are rejected and must be reread.

Concurrency therefore does not require cloning the Agent or interleaving unrelated tasks in one transcript.

## Session operations

```bash
morphz session list --context=context-default --format=json
morphz session show <session-id> --format=json
morphz session create --context=context-default
morphz session resume <session-id>
```

To understand why a unit of work has not advanced, inspect [Threads, Activations, and Objectives](/en/docs/execution-lifecycle) rather than checking only whether its Session exists.
