---
title: Threads, Activations, and Objectives
description: Understand why work runs, waits, resumes, or completes.
section: concepts
order: 120
status: current
---

Morphz does not equate one model call with one task. A Thread carries continuity, an Activation grants an execution opportunity, and an Objective expresses durable convergence.

## A Thread is a line of work

A Thread can be runnable, running, waiting, paused, or terminal. Waiting must name a resumable condition such as provider recovery, a tool result, approval, or user input.

## An Activation is an execution opportunity

An Activation is a leased scheduling unit for a Thread. It may contain several Model Attempts and tool calls before reaching a durable boundary. Ending an Activation must not orphan valid child Threads.

## An Objective owns a convergence condition

Objectives suit work that spans turns, process restarts, or background progress. They do not act as a generic parent folder and do not retroactively adopt unrelated Threads.

When an Agent marks an Objective complete, the runtime must still finish final delivery. The public Objective remains active until that delivery boundary is committed, preventing a final-report Activation from being cancelled because its Objective became inactive too early.

## Attached and durable work

- `attached` work belongs to a parent Thread and is appropriate for parallel decomposition inside that work;
- `durable` work has an independent persistent lifetime;
- child work attaches to a parent Thread, not to a short-lived Activation.

A wrong lifetime can create work without an active owner. The runtime should reject or terminate that state explicitly, not keep an item that is runnable forever but can never be scheduled.

## Waiting is not failure

Waiting must correspond to a registered wake-up condition. Transient provider failures can wait for resource recovery, user pauses wait for explicit resume, and approvals wait for a decision. A UI that says only “waiting” without the reason has an observability defect.
