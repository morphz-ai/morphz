---
title: Threads, Activations, and Objectives
description: Understand how work receives execution, waits, resumes, produces an Outcome, and completes delivery.
section: concepts
order: 130
status: current
---

Morphz does not equate a model request with a task. A Thread owns continuity, an Activation provides one execution opportunity, model Attempts are replaceable, and an Objective supervises work that must converge over time.

## A Thread is a stable causal path

Every Thread records its root request, Agent, Context, Session, Execution Target, supervision route, and delivery state. There are three Thread kinds:

- a **Dialogue Thread** handles one user turn;
- an **Execution Thread** carries tool work, delegation, or Objective progress;
- a **Delivery Thread** returns a completed result to a selected Session.

The authoritative Thread lifecycle is only open, completed, failed, or cancelled. Runnable, running, waiting, and idle are scheduler phases derived from dependencies and Activations, not another independently mutable business state. Pause is an orthogonal operator control: a paused Thread remains open and keeps its durable mailbox.

## Activations and model Attempts

An Activation is a time-bounded scheduler lease for a Thread. It fixes causal boundaries such as the root Event, trigger Event, Session, Principal, Objective, and Execution Target for one Evaluation.

One Activation may contain several model Attempts. A network retry, Context recovery, or rejected model output may replace an Attempt without changing the owning Thread or root request. Tool Actions also carry Activation and call identities, allowing recovery to replay a result without repeating the physical effect.

When an Activation ends, its Thread may be terminal or waiting on another durable dependency.

## Thread supervision and lifetime

A Thread declares who consumes its terminal Outcome when it is created:

- an `attached` Thread belongs to a parent Thread and is suitable for parallel decomposition within one workstream;
- a `durable` Thread is supervised by an Objective or the Runtime and may continue across Evaluations and restarts;
- a `disposable` Thread belongs only to its originating Evaluation and cannot join a required long-lived Thread Group.

A child attaches to a parent Thread, not to a short-lived Activation. A durable Execution Thread without valid Objective or Runtime supervision is a lifecycle invariant violation; it cannot remain permanently “runnable” without an owner.

Independent child Threads may join a Thread Group. The Group is a durable supervision barrier: a waiting Thread or Objective wakes only after the member Outcomes satisfy the Group condition.

## An Objective is durable control state

An Objective stores its stated goal, revision, lifecycle, budget, coordinator Session, delivery Session, and current Evaluation lease. Its public lifecycle is active, paused, blocked, completed, cancelled, or failed.

Durable dependencies determine whether an active Objective can run. Current dependency kinds include Thread, Thread Group, tool task, delegation, timer, permission, user input, external Event, and resource availability. When a dependency is satisfied, scheduling continues within the same Objective generation. Explicitly resuming a paused or blocked Objective enters a new executable generation so stale wakes cannot release current work.

## Completion includes delivery

When the model concludes that an Objective is complete, the Runtime first records a completion intent and evidence references without terminalizing the Objective. The owning Activation must atomically commit the final reply, Thread Outcomes, and scheduler changes before the Objective becomes completed.

This boundary prevents an Objective from appearing complete while its final report was never delivered. Outcome formation and user-visible delivery remain separately recorded so an operator can locate the failed stage.

## Waiting is not failure

Waiting must correspond to an observable dependency that can be satisfied or cancelled, for example:

- model service backoff awaiting resource recovery;
- a tool task without a result yet;
- a pending approval;
- a timer that has not fired;
- user input or an external Event that has not arrived.

A UI that shows only “waiting” without dependency identity has an observability defect. Blocked means the current conditions cannot progress through an existing dependency and require a new decision or revision.

## Inspect and control

```bash
morphz scheduler show --context=context-default --include-terminal --limit=50
morphz scheduler thread show <thread-id> --context=context-default
morphz scheduler thread pause <thread-id> --reason='Waiting for review'
morphz scheduler thread resume <thread-id>
morphz scheduler thread supersede <thread-id> 'Use the corrected requirement'

morphz objective list --context=context-default --format=json
morphz objective show <objective-id> --format=json
```

Thread controls are revision-checked. Superseding a Thread terminates the current generation and creates successor work from the corrected intent instead of silently rewriting the root request in place.
