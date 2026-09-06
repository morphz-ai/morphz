---
title: One Agent, Multiple Threads: Concurrent Work in Morphz
description: While tests are running, dependency checks and release notes can already move forward. Morphz lets one agent work across multiple threads, share cognition, and wait, resume, and join work through explicit dependencies.
published: 2026-09-06
author: Morphz Project
category: Engineering
---

Preparing a release involves several kinds of work: running regression tests, checking dependency compatibility, and writing release notes. While the tests run, the other two can already begin. A user may also ask for an update or change the release scope along the way.

These activities are related, but they do not all need to form one long queue. Morphz gives a single agent multiple execution threads. Each advances its own work while sharing the same cognition, waiting, coordinating, and joining results where necessary. The model decides how to organize the work; the runtime records those decisions and starts the corresponding work when its conditions are met.

<figure class="article-figure">
  <a href="/images/articles/concurrent-threads-en-v1.svg" target="_blank" rel="noopener noreferrer" aria-label="Open full-size diagram (new tab)">
    <img src="/images/articles/concurrent-threads-en-v1.svg" width="1200" height="725" loading="lazy" decoding="async" alt="One agent runs tests, compatibility checks and release notes concurrently. Waiting for tests does not block other threads. Required results join before review, and threads share committed cognition. Durations are illustrative." />
  </a>
  <figcaption>Waiting for tests pauses only the relevant thread. Compatibility checks and documentation can continue, with dependencies coordinating the eventual join. <span class="article-figure__hint">Click the image to view it full-size.</span></figcaption>
</figure>

## Concurrency across work threads

In Morphz, a thread is a logical execution flow with its own identity. It can span multiple model calls, tool executions, and waits while retaining where the work began, what has happened, and what it needs next. It is not an operating-system thread and does not require a model request to remain open throughout its lifetime.

The release preparation can have three execution threads. While they are at different stages, a dialogue thread can handle a new progress question:

```text
One Agent · Shared cognitive context
├─ Test thread: waiting for regression tests
├─ Compatibility thread: checking platform requirements
├─ Documentation thread: drafting release notes
└─ Dialogue thread: answering a progress question
```

Each thread can call the model, interpret its results, and choose its next actions. The test thread might read logs, diagnose a failure, and run another check while the documentation thread continues reviewing changes. Model requests and tool executions from different threads can overlap when resources permit.

This adds continuity beyond making several tool calls in one model response. Parallel tool calls handle that set of actions; a thread carries the work through subsequent steps until it produces a result or explicitly ends. Morphz also supports delegation to subagents. The concurrency described here happens within one agent, with shared cognition, without requiring a separate agent for every branch.

## The model plans; the runtime schedules

The agent uses `schedule_tx` to submit scheduling decisions: create execution threads, specify when they should begin, and declare the results they need to wait for. Independent checks can start together. Packaging that requires successful tests retains that dependency. The model still judges how to divide the task and assign the work.

These decisions become thread, schedule, and dependency records maintained by the runtime. The scheduler kernel validates the requested changes and commits the corresponding state transitions. Execution then follows those records, without repeatedly searching the conversation for an instruction to package the release after testing.

The runtime grants execution ownership through a lease: a time-limited right to advance the thread, which must be renewed to continue. Two running instances cannot arbitrarily advance the same thread twice. Different threads can receive separate execution opportunities. The scheduler limits total concurrency and can reserve capacity for dialogue and result delivery so background work cannot occupy every slot. Time spent waiting also affects scheduling: older queued work gradually gains priority.

The model can therefore put independent work into motion while preserving order where dependencies require it.

## Waiting pauses the work that needs to wait

Regression tests may take minutes; approval may take longer. The agent does not need to keep asking a model whether either has finished. Morphz can register a specific dependency and resume the relevant work when a result arrives, approval is decided, or a timer expires.

The dependency belongs to a particular thread. Test results return to the test thread; an approval decision returns to the thread waiting for that approval. A new conversation turn has its own identity and does not take over an older task's tool result. One waiting branch does not require the others to stop.

Waiting work still exists. Its dependencies, progress, and available results remain in the runtime. Pausing further inference does not mark the task as finished. When execution resumes, the model receives inputs associated with that work and continues along the original causal path.

## Sharing cognition across threads

Concurrent work also needs a common understanding. Suppose a compatibility check finds that a dependency does not support one of the target platforms. That affects both the build and the release notes. Separate, disconnected notes in each thread would make it easy for their conclusions to diverge.

Morphz threads share a cognitive context. Cognitive frames are units of knowledge with identities, contents, and sources; they can hold judgments, constraints, and plans. The agent modifies them through context transactions, using `context_tx`. The compatibility thread can update platform requirements while the documentation thread adds release details. After those changes commit, other threads can use them when they read the relevant cognition in subsequent model calls.

Reasoning concurrently does not permit unconditional overwrites. The runtime serializes transaction commits within one context without serializing all model reasoning. If two transactions affect independent frames and relations, both can be retained even when they started from the same older version. If relevant state has changed, the runtime rejects the conflicting transaction so the agent can reread it and adjust the update.

A model request already in progress does not acquire new input in the middle of generation. Sharing therefore does not make a newly committed judgment instantly available to every ongoing inference. It provides common state that the different work threads can continue reading and revising.

Shared cognition and concurrent access to external files also have separate boundaries. Threads editing the same file still need to coordinate ownership, check file versions, and reread when necessary. Context transactions protect cognitive state; they do not replace concurrency control in filesystems or external services.

[How Morphz Maintains a Finite Context Without Compaction](/en/blog/maintaining-context-without-compaction) explains how these transactions maintain a bounded model input. In concurrent work, the same mechanism lets multiple threads maintain the agent's understanding together.

## Bringing parallel results together

Starting three threads is only the beginning. Release preparation still needs a clear conclusion: checks must pass, failures must be addressed, and the notes must match the actual changes.

A thread group expresses a shared waiting condition across a set of threads. For example, the test, compatibility, and documentation threads can belong to a group that waits for every member. As each thread ends, the runtime records its outcome and updates the group. Once the waiting condition is met, the work responsible for combining the results can continue.

Failure produces an outcome too. A failed test cannot count as a successful release simply because its branch has ended. The agent must examine the result and decide whether to repair the problem, schedule another check, or report a blocker. The runtime records whether a thread has ended; the model judges whether its results satisfy the task.

Work that needs sustained progress across multiple evaluations can be supervised by an objective. An objective records what should be achieved, its current state, and its dependencies. One objective can organize several threads. The agent can also advance multiple objectives concurrently, each retaining its own execution progress while sharing relevant cognition.

Threads, objectives, and dependencies have persistent identities. After a process restart, the runtime uses them to recover work that remains valid. A late result from an older execution cannot cross a cancellation or replacement boundary and advance new work. The supervision and recovery boundaries are described in [Threads, Activations, and Objectives](/en/docs/execution-lifecycle).

## Keep talking while work continues

Background work and user interaction do not have to exclude each other. While the release is still being prepared, the user can ask about progress or introduce a new requirement. A session records where messages originate and where replies belong. Threads distinguish which work owns each message or tool result. One session can contain multiple threads, and one cognitive context can serve multiple sessions.

This does not require treating adjacent user messages in a session as independent concurrent requests. Ordinary dialogue retains its ordering, while execution work that has been scheduled independently can continue. The user can talk to the agent without first terminating its earlier task.

If the user removes a platform from the release, the agent needs to revise the release scope and control the work that is no longer needed. `thread_control` can pause, resume, or cancel a specified thread through the same runtime control path used by the Dashboard. Cancelling a scheduled wake-up alone does not cancel the thread. Recording a decision to stop in cognition does not, by itself, stop physical execution either.

Shared cognition lets the agent understand the change; explicit control operations apply it to execution. Unaffected work can continue. Further session boundaries are covered in [Sessions and Concurrent Work](/en/docs/sessions-and-concurrency).

## Costs and limits

The value of concurrency depends on how much of a task can advance independently. More threads add model calls, context input, and coordination overhead. Branches repeatedly changing the same material can spend enough time resolving conflicts to erase the time saved. Task quality, elapsed time, and usage need to be measured together; thread count is not a speedup factor.

Shared context also requires bounded input. The runtime selects a bounded session working set for each request, and the agent continues maintaining cognition through transactions rather than accumulating every thread's entire history in every input. Prefix-cache reuse still depends on input changes and the model endpoint. The mechanisms and experiments are covered in the [previous article's prefix-caching section](/en/blog/maintaining-context-without-compaction#prefix-caching).

Concurrent scheduling does not expand tool permissions, and cancellation cannot undo external actions that have already happened. During recovery, an operation whose outcome is unknown requires checking the real state, not simply executing it again from the beginning.

Morphz provides a way to organize model capabilities: let independent work advance together, let related work share cognition, and give waiting and completion explicit places in the execution model. The model's analysis, planning, and tool-use capabilities can then serve multiple continuing threads of work, beyond the immediate reply.

The [scheduler kernel](https://github.com/morphz-ai/morphz/blob/v0.1.2/morphz/src/scheduler/kernel.rs), [concurrency admission controller](https://github.com/morphz-ai/morphz/blob/v0.1.2/morphz/src/activation_admission.rs), and [cancellation and interruption contract](https://github.com/morphz-ai/morphz/blob/v0.1.2/docs/morphz_scheduler_cancellation_and_interrupts.md) discussed here are available in the project source.
