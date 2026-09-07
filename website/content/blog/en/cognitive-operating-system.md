---
title: Morphz: Implementing a Cognitive Operating System
description: Managing finite context, scheduling concurrent threads, and handling input and output across sessions. A software release illustrates how context transactions, thread scheduling, and Session I/O support an agent's ongoing work in Morphz.
published: 2026-09-07
author: Morphz Project
category: System architecture
---

An agent is preparing a software release. Regression tests are still running, a compatibility check has found a problem, and the release notes need more work. Then the user sends another message: “Hold the Windows release. Continue with the other platforms.”

The agent needs to understand the request and change what is happening: update the release scope, stop the branches that are no longer needed, and keep the others moving. When tests finish, their results must reach the thread waiting for them. When the user asks for progress, a reply should come back. Meanwhile, logs the agent has already processed need not remain in its context, but conclusions that still matter must stay available.

Operating systems manage finite physical memory, schedule threads, and handle input and output across connections. Morphz faces similar organizational problems: which cognitive content enters the current context, which threads keep running, and how messages reach the right sessions.

<figure class="article-figure">
  <a href="/images/articles/cognitive-operating-system-en-v1.svg" target="_blank" rel="noopener noreferrer" aria-label="Open the full-size mechanism comparison in a new tab">
    <img src="/images/articles/cognitive-operating-system-en-v1.svg" width="1800" height="2200" loading="lazy" decoding="async" alt="Operating-system and Morphz mechanisms side by side: page residency alongside Frame retirement, restore, and Session Working Set selection; thread scheduling alongside Runnable, Running, Waiting, and dependency wakeups; multiplexed I/O alongside independent Session inputs, evaluations, and reply routes on a shared Mind." />
  </a>
  <figcaption>Morphz through working sets, thread states, and input/output paths. <span class="article-figure__hint">Click the image to view it at full size.</span></figcaption>
</figure>

## Working sets: keeping the right content in context

Linux does not need to keep everything a program has used in physical memory. Under memory pressure, the kernel can reclaim clean file-cache pages whose contents are available in a file. With swap enabled, it can also swap out anonymous pages that are not currently needed and bring them back when accessed again. Releasing memory does not mean losing those contents. See the [Linux kernel's memory-management overview](https://docs.kernel.org/admin-guide/mm/concepts.html).

A working set concerns the pages a program actually uses over a period of time. Linux's Multi-Gen LRU tracks how recently pages have been accessed to help decide which pages to reclaim first and which to retain. See the [Multi-Gen LRU documentation](https://docs.kernel.org/admin-guide/mm/multigen_lru.html).

An agent also needs to distinguish between retaining information and using it now. Configurations, logs, and user messages from a release can remain in history without being sent to the model every time. Each request has a finite token budget, so the agent must decide which observations and cognitive frames stay in context and which can be set aside and restored when needed.

The agent actively changes these objects through context transactions, submitted with `context_tx`. The runtime checks versions, protection rules, and permitted operations before committing the changes. Observations, cognitive frames, and session working sets provide different granularities of control.

### Observations: setting aside a log after reading it

An observation is an input record, such as a user message, tool result, or external event. It has its own identifier, and its original content is preserved in event history. The model can reference that record and decide whether it still needs to remain in the current context.

Suppose the regression tests pass and the tool returns a long log identified as `@e42`. After reading it, the agent mainly needs the test result and a reference to the original report for the packaging step. It can retain that conclusion and retire the log observation in a single context transaction. Assuming the context version it read was 17, the transaction could be:

```lisp
(context-tx
  (base-version 17)
  (reason "retain the regression result and release the consumed log")
  (derive release/regression-result
    (from @e42)
    (fact (suite regression) (status passed)))
  (retire @e42))
```

When the transaction commits, the test conclusion and its source relation remain, while `@e42` immediately leaves the active context and releases the input space it occupied. The original log is still available. The agent can use `restore` to bring the observation back, or recall relevant content by reference.

Some inputs are simply completed process records that add no new conclusion. Those can be retired directly; each does not need to become another cognitive frame. Ongoing maintenance lets subsequent requests use the updated context without carrying every raw input forward.

### Frames: moving between current and historical cognition

A cognitive frame holds a conclusion, constraint, piece of knowledge, or plan the agent has formed. “This release includes only macOS and Linux” might be one frame; “this dependency does not support the target platform” might be another. Each has a stable identifier and can be revised, linked, protected, retired, or restored independently.

Frames have a different lifecycle from raw input. Retiring an observation releases its input space immediately. An ordinary frame first enters an organizing window governed by the cognitive clock. During that window, it remains visible and continues to consume capacity, leaving an opportunity to revise it, arrange a replacement, or restore it. When the window closes, the frame leaves active encoding while its history remains. A frame can also retire immediately if the same transaction establishes a safe successor with the required source and replacement relations.

After the release, cognition specific to that work can leave the active context. If an issue with the release comes up later, `restore` can bring the relevant frames back. Important constraints that must remain in force can be protected against direct retirement with `protect`.

This is residency management for cognition. Content outside the current model input retains its identity, history, and recovery path, while the finite context holds an evolving working understanding.

### Session Working Set: choosing which sessions need attention

One cognitive context can serve multiple sessions. One might be preparing the release, another might contain yesterday's troubleshooting, and a third might be waiting for more information from the user. They do not all need to be expanded on every model call.

The Session Working Set selects session projections for an evaluation: full content for some, metadata only for others, and omission from the input for the rest. The runtime considers the current session, activity, isolation scope, and capacity budget.

The agent can also use `retire-session` to remove a session from the automatic working set. `restore-session` makes it a candidate again, and a new directed event also restores attention to it. A current or actively working session cannot be removed this way. Leaving the working set does not delete its historical events or the shared Mind.

Individual observations, cognitive frames, and whole sessions therefore have distinct residency boundaries. The agent can set aside a processed log or an entire conversation while preserving the ability to use it again.

## Scheduling: other threads keep moving while work waits

When an operating-system thread waits for I/O, it can enter a blocked state. The scheduler gives execution resources to other ready threads and resumes the waiting thread when the I/O is ready.

In Morphz, testing, compatibility checks, and release notes can each have their own Thread. A Thread carries an ongoing logical execution flow across model calls, tool executions, and waits. It retains its identity, progress, and dependencies, while threads within the same agent share cognition.

The agent submits arrangements through `schedule_tx`: creating parallel branches, specifying dependencies, or setting a later wakeup. `SchedulerKernel` validates and persists those arrangements. The runtime uses them to manage execution phases:

| Phase | Runtime meaning | Release example |
| --- | --- | --- |
| Runnable | Pending signals or queued execution, awaiting admission | The compatibility check is queued |
| Running | An execution activation or tool job is running | The model is analyzing dependencies, or the test tool is running |
| Waiting | Continuation depends on a dependency, approval, or scheduling condition | The release review is waiting for check results |

Admission control decides which work gets execution capacity; leases govern current execution rights. Separate threads can obtain resources and overlap their model calls and tool execution. Dialogue and result delivery can have reserved capacity, so background work does not occupy every available slot.

Suppose the release review needs to wait for regression tests. The runtime retains that dependency and wakes the matching work when the result arrives. Compatibility checks and documentation can continue in the meantime. The whole agent need not stop, and waiting does not require repeated model calls asking whether the test has finished.

A ThreadGroup can join multiple results. Its `all` policy waits for all members to finish; `any` allows continuation when any member meets the completion condition. Finishing a thread does not establish task success: a test can finish with a failure, which the resumed agent must inspect before deciding whether to repair or release.

When the user withdraws the Windows release requirement, the agent can revise the release scope and cancel the relevant thread through `thread_control`. Updating cognition and controlling execution have explicit interfaces, so unrelated branches can keep moving. [One Agent, Multiple Threads](/en/blog/one-agent-multiple-threads) covers scheduling in more detail.

## Session I/O: shared cognition, separate connections

An operating system uses file descriptors to distinguish I/O objects. A program can handle multiple connections, identify which one has data ready, and write its result to the right destination.

A Morphz Session supplies an agent's I/O connection and interaction-progress boundary. Sessions under the same Context share a Mind, but each evaluation has a specific `active-session`. Inputs carry their source, and ordinary replies return through the active session. Shared cognition does not merge message destinations.

For example, Session A can be preparing the release while Session B asks about platform compatibility. B can use compatibility findings already committed to shared cognition, while its reply still goes back to B. A's release work continues on its own threads. A session can also contain several work threads; connections and execution flows are not bound one-to-one.

Ordinary dialogue retains its order within each session, while independently scheduled work can continue. A test result belongs to the thread that initiated the test; a new user message does not take over the old thread's result.

Cross-session interaction distinguishes two operations:

- `send_message` delivers a user-visible message to another Session without starting a new evaluation there.
- `session_signal` sends internal coordination to a target Session and triggers evaluation there, without changing the current evaluation's `active-session`.

Suppose B discovers a new compatibility issue. To inform the user in A, it can deliver a message. To get A to reconsider its release arrangements immediately, it can send a coordination signal. Shared cognition preserves the common understanding, I/O routing delivers messages, and wakeup mechanisms continue the relevant work.

The [sessions and concurrency documentation](/en/docs/sessions-and-concurrency) describes these boundaries further.

## Maintaining cognition across concurrent work

Working sets, scheduling, and I/O cooperate around shared cognitive state. The compatibility thread discovers a constraint, the documentation thread needs to update the release notes, and the dialogue thread needs to give the user a consistent answer.

`context_tx` provides their common commit boundary. Each transaction carries a base version, and the runtime checks conflicts at the level of frames, relations, and other affected state. Independent changes can be retained. If relevant state has changed, the conflicting transaction is rejected and the agent reads again before deciding what to submit. Commits within a Context are serialized; inference across its threads can still run concurrently.

Return to the release task. The test thread reads a log, commits its result to cognition, and retires the consumed observation. The review thread resumes when its dependencies are satisfied. The user receives a reply through the current session. After the release, frames and sessions that no longer need to remain resident can leave the working set, while their records are retained.

A model call is thus one execution segment within ongoing work. Cognition, threads, waiting conditions, and I/O connections all have lifecycles that extend beyond that call.

## The role of a cognitive operating system

An operating system puts computing capacity to work across many ongoing programs. Morphz organizes model reasoning so that one agent can maintain its current understanding, advance multiple threads, and keep operating through waits, interactions, and resumptions.

The model judges what information matters, how work should be divided, and what results mean. The runtime supplies objects on which those judgments can act: identified observations and frames, threads with dependencies and execution rights, and sessions that route messages and activate work. Those objects and their lifecycles give a cognitive operating system its concrete responsibilities.

This is a cognitive runtime above the model. The host operating system still manages actual processes, file access, and devices; permissions and sandbox rules still govern external actions.

For the computational model, start with [From Chat Completion to Structured Context Evaluation](/en/blog/from-chat-completion-to-structured-context-evaluation). For context transactions, capacity maintenance, and recall, see [How Morphz Maintains a Finite Context Without Compaction](/en/blog/maintaining-context-without-compaction). The [context operations](https://github.com/morphz-ai/morphz/blob/v0.1.2/morphz/src/orchestrator/context.rs), [scheduling kernel](https://github.com/morphz-ai/morphz/blob/v0.1.2/morphz/src/scheduler/kernel.rs), and [cross-session tools](https://github.com/morphz-ai/morphz/blob/v0.1.2/morphz/src/tool.rs) discussed here are available in the source.
