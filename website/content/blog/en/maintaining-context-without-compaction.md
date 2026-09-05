---
title: How Morphz Maintains a Finite Context Without Compaction
description: As a task progresses, an agent receives new information and updates its understanding. Morphz lets it make those changes through context transactions and keep working within a finite context window.
published: 2026-09-05
author: Morphz Project
category: Engineering
---

Long-running agents keep revising their understanding. A configuration may be out of date, a failure may have been resolved, or a user may have added a new constraint. The context needs to keep up with the work.

In Morphz, the agent modifies its own context through context transactions. It decides what to retain, revise, or retire as new information arrives, submits those changes to the runtime, and continues from the updated state once they commit.

## Editing context

A context contains incoming observations, the agent's existing cognition, and session and runtime state. Here, an observation is an input record: a user message, a tool result, or an external event brought into context. Each has an identity, so the agent can refer to the record, use it as a source for a judgment, and retire it once processed.

Judgments, knowledge, and constraints are organized into cognitive frames, each with its own identity. The agent can refer to an existing frame, change its contents, and link it to its sources.

It submits these changes through `context_tx`. One transaction can create a new frame, identify the older frame it supersedes, and retire an observation that has been processed. The runtime checks the version and whether the operations are valid, then commits the whole group or rejects the transaction.

The protocol defines what the agent can change. It can update cognitive frames, choose which observations stay active, and adjust which sessions need attention. Original tool results stay intact; the runtime retains control over permissions and scheduling.

## Updating a deployment decision

Suppose an agent is preparing a deployment. It has recorded Hangzhou as the deployment region in `deployment/target-v1`. On reading the latest production configuration, it discovers that the region should be Shanghai. The configuration check enters its context as observation `@e42`.

The agent can submit this transaction to update the deployment decision and retire the processed configuration observation from active context:

```lisp
(context-tx
  (base-version 17)
  (reason "current production configuration confirms cn-shanghai")
  (derive deployment/target-v2
    (from @e42 deployment/target-v1)
    (fact (region cn-shanghai)))
  (relate deployment/target-v2 supersedes deployment/target-v1)
  (retire deployment/target-v1)
  (retire @e42))
```

`derive` creates the new frame, citing both the configuration result and the old frame as sources. `relate` declares that the new frame supersedes the old one. The two `retire` operations retire the old frame and the processed observation. The resulting changes are:

| Context object | Before commit | After commit |
| --- | --- | --- |
| Old frame | Deployment region: Hangzhou | Retired; its history remains available |
| New frame | Does not exist | Deployment region: Shanghai; linked to the old frame and latest configuration result |
| Configuration observation `@e42` | Present in active context | Retired; still retrievable by reference |
| Other cognition | Existing contents | Unchanged by this transaction |

The changes take effect together. The next time the agent reads its context, the deployment region is Shanghai. It can still retrieve the original configuration result through `@e42` when needed.

To update the same frame directly, the agent can use `revise` instead. This replaces the complete frame body, so the new body must include all the content that should remain.

## Making room for further work

The deployment will keep producing build logs, health checks, and new errors. Model input capacity is finite, and any particular step will use only part of that history. The agent must keep deciding what to leave in view and what it can put aside.

A common approach is compaction: condense earlier conversation history into a summary and use it in place of the longer history in subsequent requests. In Morphz, the agent uses transactions to maintain context as it works. After processing a build log, it can derive a diagnosis, update a blocker, and retire the log observation. Those changes keep the diagnosis in context while releasing the space occupied by the log.

Information is still distilled, but each cognitive item can be updated individually. A resolved failure calls for a revised judgment. An important constraint can be kept active with `protect`. If the agent needs to revisit retired cognition, it can bring it back with `restore`.

Retired content remains in history. Retiring an observation releases input space immediately. An ordinary frame first enters an organizing window: it remains visible and occupies capacity while the agent has time to revise or restore it. The deployment example can retire its old frame immediately because the successor both cites it as a source and declares a `supersedes` relation. Protected content must be unprotected before it can be retired.

## Approaching the capacity limit

The runtime estimates the tokens needed for the complete model request and reports capacity pressure to the agent. Near the critical threshold, or after a provider reports an oversized input, Morphz pauses new external tool actions and enters a maintenance phase. `context_tx` and necessary recall remain available.

The agent examines the accumulated observations and uses context transactions to retain useful conclusions, revise existing frames, and retire material it no longer needs expanded. After each commit, the runtime measures capacity again. Work resumes when there is enough room; otherwise, maintenance continues.

If the full request already exceeds the window, the runtime supplies a smaller batch of observations for the agent to process. It preserves the current request and its causal dependencies, then selects older, unprotected observations using deterministic rules. The agent submits transactions in batches to reorganize its context. Observations left out of a batch retain their existing state.

Maintenance itself needs input space. If even the minimum maintenance request will not fit, the runtime reports a failure.

## Concurrent changes and provenance

Multiple execution threads can share one context. Suppose one thread is updating the deployment region while another records the cause of a build failure. If the frames and relations involved are independent, the runtime can retain both changes. Each transaction carries a base version so the runtime can check whether the state it relied on has changed.

Conflicts are checked at boundaries such as individual frames and relations. An older transaction whose dependencies are unchanged can be safely rebased onto the latest version. If another thread has changed something relevant, the commit is rejected and the agent must reread the state and resolve the conflict.

The records also make it possible to trace a judgment's history. If someone asks why the deployment region changed from Hangzhou to Shanghai, the agent can follow the new frame's sources to the old frame and `@e42`, then read the configuration result again. Retrieved records enter context as new observations. If they change the agent's current judgment, the agent submits another update.

Morphz also supports searches by keyword and time range, along with reads by identity. The interfaces are described in the [context and recall documentation](/en/docs/contexts-and-recall).

## Presenting context to the model

After a transaction commits, the runtime stores the resulting state and the change record. The next request presents an encoding of the currently visible context to the model. Frames retain their identities and relations, so the agent can continue referring to and modifying them.

How much the model sees depends on active state, the session working set, and the input budget. A long tool result can appear as a preview with a reference to the original. Other sessions may be shown in full, represented by metadata, or left out of that request. Original events remain available for later retrieval.

## Reusing experience across tasks

We evaluated agents' reuse of past experience on new tasks. The experiment used STATE-Bench tasks, scoring rules, and evaluation prompts, with GPT-5.6 Sol at maximum reasoning for the agents, user simulator, and evaluators. In each of three domains, every system learned from the same 100 historical task trajectories, then attempted the same 50 held-out tasks: 150 tasks per system, one attempt per task.

Completion required passing both final-state checks and task-requirement scoring. Terminal failures counted as unsuccessful tasks:

| System | Tasks completed | Completion rate |
| --- | ---: | ---: |
| Morphz | 122/150 | **81.33%** |
| Letta 0.16.8 | 93/150 | 62.00% |
| Mem0 2.0.19-backed vector reference agent | 96/150 | 64.00% |

A trace audit confirmed that the cognitive frames Morphz formed through context transactions during training were present in all 150 held-out tasks. Cognition developed from past tasks was carried into subsequent work.

The experiment compares complete agent systems, including the effects of their prompts, memory, tool loops, and scheduling. Morphz used more tokens during held-out evaluation, so this was not an equal-cost comparison. The [full experiment report](https://github.com/morphz-ai/morphz/blob/77f05e1eb16c49c758c0d7f595b8cda16c689a58/docs/research/paper_evaluation/artifacts/me07_public_agent_systems_formal_one_run_20260827/README.md) includes usage figures for all three systems. Further mechanism experiments are described in the [research paper](/en/paper).

## Prefix caching

Morphz's context encoding preserves a stable region for prefix caching: the protocol and ordered, append-mostly observations precede the more frequently changing cognition and runtime state. Updating cognition leaves the earlier observation prefix intact. Compared with an append-only message history, retiring older records gives up some cache reuse, while the unaffected prefix remains available.

Actual reuse also depends on the model endpoint. We [ran the same task with nine models](https://github.com/morphz-ai/morphz/blob/77f05e1eb16c49c758c0d7f595b8cda16c689a58/docs/research/paper_evaluation/prompt_cache_nine_model_real_task_no_delta_20260830.md) and compared their cache hit rates. Without ContextDelta, Kimi K3 and GLM 5.3 achieved **85.67%** and **86.46%**, respectively. All rates here are the aggregate provider-reported cached share of input tokens, excluding each run's first request.

The GPT-5.6 Sol endpoint we tested did not reliably reuse the long prefix within a single message. To improve reuse with this request format, Morphz's ContextDelta encoding appends structured increments between successive tool calls, preserving a reusable prefix. In the [same-task comparison](https://github.com/morphz-ai/morphz/blob/77f05e1eb16c49c758c0d7f595b8cda16c689a58/docs/research/paper_evaluation/prompt_cache_nine_model_real_task_delta_ab_20260830.md), GPT-5.6 Sol's cache hit rate rose from **54.18%** to **93.37%**. This experimental feature is disabled by default and requires the corresponding build feature and per-model configuration.

## Costs and limits

Context maintenance still takes calls, tokens, and time. Original records need storage, and recall consumes input space. Maintenance quality depends on the model's judgment about the task and its information. Transactions check that updates follow the rules; versions, provenance, and checkpoints support inspection and recovery.

## Conclusion

A long-running task accumulates a substantial history, and new information can overturn earlier judgments. Morphz lets the agent keep up through context transactions: updating the cognition it needs, retiring observations it has processed, and keeping the original records available for later examination.

[From Chat Completion to Structured Context Evaluation](/en/blog/from-chat-completion-to-structured-context-evaluation) introduces the broader computational model. The transaction, capacity-maintenance, and recall implementations discussed here are available in the [project source](https://github.com/morphz-ai/morphz).
