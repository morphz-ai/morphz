---
title: How Morphz Manages Context and Memory
description: How Morphz uses structured context, atomic memory transactions, staged retirement, and graph recall to update knowledge, preserve evidence, and reuse experience across long-running work.
published: 2026-10-01
author: Morphz Project
category: Product Mechanisms
---

When we hand a job to an agent and return hours—or even days—later, we expect it to pick up where it left off. It should remember our requirements, know which problems have been resolved, and be able to explain the evidence behind a decision. As the work continues, new messages, reports, and tool results arrive. Its memory needs to change with them.

Morphz organizes this memory as structured context. While working, the agent forms new knowledge from incoming information, revises earlier judgments, records their relationships, and removes processed material from its active context. The runtime preserves the original records, validates and commits the proposed changes, and supplies the updated context on the next model call.

## What structured context contains

Morphz organizes context by the role each piece of information serves. Incoming user messages and tool results are observations. Judgments, preferences, and working methods are stored in cognitive frames, or Frames. Frames can have explicit relationships: for example, “tests passed” supports “prepare the release.” Session and task status are presented separately in the context.

Each Frame has a stable identifier and a revision number. The model organizes its body around the subject: a release plan may contain a goal and stage, while a build procedure may contain commands, artifact locations, and conditions for use. A Frame can record its sources and connect to other Frames through named relationships. Together, these nodes and connections form a cognitive graph. The model forms and revises the knowledge; the runtime manages node identities, versions, and lifecycles.

Consider a software release. The regression test report has come back with a passing result, so the agent can proceed to packaging. It needs to change the release status from “awaiting tests” to “ready to package,” while retaining the test report as evidence. The diagram shows how one model response can propose the next action and update the memory used to guide it.

<figure class="article-figure">
  <a href="/images/articles/morphz-context-memory-en-v2.jpeg" target="_blank" rel="noopener noreferrer" aria-label="Open the full mechanism diagram in a new window">
    <img src="/images/articles/morphz-context-memory-en-v2.jpeg" width="1448" height="1086" loading="lazy" decoding="async" alt="Morphz context and memory: one model response proposes a tool call and a context transaction that derives a test result, revises release progress, records a supporting relationship, and retires the processed log" />
  </a>
  <figcaption>After the test log arrives, one model response proposes packaging and updates the test conclusion and release progress. The packaging result becomes input to a later model call. <span class="article-figure__hint">Click to enlarge.</span></figcaption>
</figure>

## How a test log changes the agent’s memory

The test report first enters context as an observation. It has a stable event identity; `@e42` in the diagram is a short reference supplied by the runtime for the model to use. The original report remains in event history. The agent can read it now and retrieve it by reference later.

The current release plan is stored in a Frame named `release`: the goal is to ship the new version, and its stage is awaiting tests. The test log records what the tool actually returned. The `release` Frame expresses the agent’s current understanding of the work.

After reading `@e42`, the model can propose both a packaging command and a context transaction in the same response. The main operations in that transaction look like this:

```lisp
(context-tx
  (base-version 12)
  (reason "Incorporate the test result and prepare the release")
  (derive test-result (from @e42) (tests passed))
  (revise release (goal ship-v1) (stage packaging))
  (relate test-result supports release)
  (retire @e42))
```

`derive` creates a new Frame, `test-result`, from the report and records its source. To check where “tests passed” came from, the agent can follow that source back to `@e42`. `revise` updates `release` to the packaging stage while retaining the release goal. The `goal` must be written again here: a revision replaces the entire Frame body rather than patching an individual field.

Next, `relate` records that the test result supports the current release plan. This is an explicit relationship proposed by the model, not a business conclusion inferred by the runtime. Finally, `retire` removes the processed log from active context. Its original content remains in event history.

The transaction carries the context version on which it was based. The runtime validates its references, operations, and version, then commits the changes together. If an operation is invalid, none of the changes are written. The packaging command follows a separate execution path; it does not share a database transaction with the memory update. At this point, the memory says “tests passed; prepare to package,” not “packaging succeeded.” When the packaging tool returns, its result becomes a new observation, and the agent can decide how to update the progress.

## Why observations and Frames retire differently

A test log may contain thousands of lines, while the current job needs only its conclusion. Once `test-result` records that this regression run passed and retains the report’s source, the model can work from that conclusion and retrieve details when needed. The two records serve different purposes: an observation preserves incoming material, while a Frame holds the understanding the model formed from it.

Morphz separates durable storage from the input to a particular model call. Event history preserves original messages, tool outputs, and committed cognitive changes. Cognitive state retains Frames, sources, and relationships. The runtime compiles active context from these records for each call. Retirement changes whether content continues to appear in that input; the original records and cognitive connections remain stored.

A processed observation can retire immediately. Once `(retire @e42)` commits, that test log leaves the next active input, while the source in `test-result` still points to it. The originating user request of work that has not yet been delivered is causally protected by the runtime. It must remain available until the reply or work delivery completes, so the agent retains the basis of its current task.

A Frame already contains a judgment, method, or constraint that took reasoning to form. Removing it as soon as input space runs short could discard that work before the agent has organized it. Ordinary Frame retirement therefore has two stages: a request moves it from `active` to `retiring`, with its body still in context alongside the retirement reason and remaining window. It becomes `retired` when that window ends.

| Retirement target and condition | State after commit | Next model input |
| --- | --- | --- |
| A processed observation | Retired immediately | The observation is removed |
| An ordinary Frame without an explicit successor | In its consolidation window | The body remains; that space is not yet released |
| A Frame marked for retirement, with a successor that records its source and replacement relationship | Retirement completes immediately | The old body is removed; the successor remains |

The window is measured in cognitive activity. Each cognitive context has a persistent logical counter, `cognitive_tick`. When the runtime claims a new input batch and creates an evaluation activation, the counter advances once if that batch contains a user message, tool result, or other external fact. A batch counts once even if it contains several inputs. Internal model continuations, request retries, and context-transaction receipts do not advance it.

The current default window is eight ticks and is configurable. A Frame marked for retirement at tick 100 becomes due at tick 108. Three days offline—or three days online but idle—leave the counter unchanged. The window measures how many new batches of information the agent has encountered, leaving opportunities for further consolidation. Active Frames remain active; only an explicit retirement request starts the window.

During the window, `revise` can turn the Frame into more compact knowledge and cancel its retirement request. `restore` cancels the request directly; `protect` cancels it and protects the Frame, requiring explicit removal of that protection before retirement. Repeating `retire` keeps the original deadline. At finalization, the runtime checks the request generation and Frame revision. If another thread has revised, restored, or protected the Frame, the old finalization is no longer valid and cannot remove the updated knowledge from input.

## Consolidating specific experiences into a reusable method

The window gives the agent time to consolidate. After a release, the model can store the commands actually used, artifact locations, and outcomes in a case Frame, with sources pointing to that run’s execution records. Suppose it has accumulated two frontend release cases:

| Case detail | `release-case-a` | `release-case-b` |
| --- | --- | --- |
| Project layout | Single-package project | The web package in a workspace |
| Test command | `npm test` | `pnpm --filter web test` |
| Build command | `npm run build` | `pnpm --filter web build` |
| Artifact location | `dist/` | `apps/web/dist/` |
| Run outcome | Tests, build, and artifact verification passed | Tests, build, and artifact verification passed |

Both runs followed the same sequence: test, build, verify the artifacts, then package. Their commands and paths differed with the project layout. The model can record the shared order once and preserve those differences as conditional branches, allowing the next job to choose based on its current project. Full logs for individual runs remain among the cases’ sources. A consolidation transaction can express this as follows:

```lisp
(context-tx
  (base-version 42)
  (reason "Consolidate two release experiences into a reusable procedure")
  (derive release-procedure
    (from release-case-a release-case-b)
    (steps "After tests pass, build, verify this run's artifacts, then package.")
    (single-package
      (test "npm test")
      (build "npm run build")
      (artifact "dist/"))
    (workspace
      (test "pnpm --filter web test")
      (build "pnpm --filter web build")
      (artifact "apps/web/dist/"))
    (applicability "Check the current project layout and scripts before choosing a branch."))
  (relate release-procedure supersedes release-case-a)
  (relate release-procedure supersedes release-case-b)
  (retire release-case-a release-case-b))
```

For an old Frame marked for retirement in this or a previous transaction, the runtime checks the transaction’s final state: the successor must not be retired, its `sources` must include the old Frame, and a relationship must state that the successor `supersedes` it. When these structural conditions hold, the old Frame can retire immediately, bypassing the remaining window. If it is already `retiring`, a later transaction that establishes a qualifying successor completes its pending retirement without another `retire` request.

`sources` records which experiences produced the method; `supersedes` expresses the model’s decision to let the new method replace the individual cases. The model still has to judge whether the method is correct and retains the necessary preconditions. The runtime makes the replacement explicit, checks its structure, and commits the changes together. The model writes the method’s body rather than relying on the runtime to produce an automatic summary.

Active context can now retain `release-procedure` while the old case bodies leave input. Their content, sources, and replacement relationships remain stored. With more experience, the model can revise the procedure or derive further knowledge from several methods. These retained connections let later recall work back from a compact procedure to specific experiences and original evidence.

## Recalling knowledge and evidence through the cognitive graph

On the next release, the agent can start from `release-procedure`, choosing commands and artifact paths based on the project layout. If the user asks whether the workspace branch has actually built successfully and where its artifacts were produced, the agent needs `release-case-b` and the original tool results.

The Frame mode of `recall` traverses this graph. In the example, `release-procedure` has the two case Frames as sources, and those cases point to execution records. One hop from the method reaches the cases; a second can reach the original events. Retirement leaves these nodes accessible. A `recall` request can specify:

```json
{
  "frame_id": "release-procedure",
  "depth": 2,
  "direction": "ancestors",
  "include_bodies": true,
  "include_events": false,
  "max_nodes": 8
}
```

The result contains nodes and edges. Frame nodes include their bodies, revisions, sources, and `active`, `retiring`, or `retired` lifecycles. Event leaves include a reference for further retrieval and a preview. With `include_events: false`, original reports appear as previews; the agent can use their returned references to retrieve the text in chunks. Setting it to `true` expands original event text in the graph result. Following `release-case-b` to its execution records lets the agent check that run’s command results and artifact locations rather than merely repeat the procedure’s fields.

Source references distinguish identity from revision. `sources` stores stable IDs without pinning a source Frame to an earlier revision. Graph recall returns Frame bodies and revisions from the current cognitive state; an event source instead identifies its immutable original record. If a case is later restored and revised, the current graph will return the revised case. To check what the case said when the method was formed, the agent can separately recall the cognitive transactions committed for the method and cases at that time, inspect the bodies written by `derive` or `revise` and their actual committed `base-version`, and compare the transaction versions. Reading the current graph and examining historical writes are separate paths.

Traversal follows both sources and Frame relationships, with an explicit direction. `ancestors` follows `sources` back to their origins and relationship edges from subject to object. `descendants` finds Frames that cite the current Frame as a source and follows relationships in reverse. `both` combines the directions. For example, the earlier relationship is `test-result supports release`. Starting from `release` and looking for its supporting `test-result` therefore requires reverse or bidirectional traversal. The model assigns meaning to the relationship labels; the runtime follows the stored edges.

The traversal is breadth-first: nearby nodes appear before more distant ones, and visited nodes are not expanded twice, so cycles can be handled. The current maximum depth is four. `max_nodes` limits the number of nodes returned per page, up to 128, rather than the number visited across the full depth range. Results are also paged by node size, with a `next_cursor` for continuation. Pages split between whole nodes rather than slicing a large node, so large logs are best retrieved as previews followed by event chunks.

Graph recall stays within the current cognitive context. The cursor binds query parameters and the cognitive-state version. If the graph changes between pages, recall must restart from the new version. Model-facing graph recall also checks the version of the context view used for that request, preventing concurrent updates from being mixed into an older view.

Without a known starting Frame, the agent can search by keywords or time range. Lexical search indexes both Frames and historical events, including retired content. Indexing and querying share Unicode normalization and ICU4X word segmentation before database retrieval. Search locates potentially relevant records; graph recall expands their sources and connections. A high-level concept can thus lead back to the material supporting it.

The lexical index is a rebuildable projection. A fact commit also persists the intent to update the index, which a background worker then applies. Search can briefly lag behind newly committed knowledge. Retrieval by Frame ID, graph traversal, and original-event lookup instead use durable cognitive state and event history. The index can therefore be rebuilt independently, without rewriting the stored knowledge or its connections.

## What recall, restoration, and revision each change

Graph recall retrieves material. Its results enter observation input as tool output, leaving the Frame’s activity state unchanged. The agent can read a retired build method to answer a question about an old project without keeping that method in active context. If it needs to continue using the method, `restore` makes it active again.

If the evidence reveals an incorrect judgment, the knowledge must change. Suppose a failed test was overlooked in the report. The model should revise `test-result`, remove its supporting relationship, and reconsider `release`, committing those changes through `context_tx`. A fully retired Frame must first be restored before it can be revised; both operations can appear in that order in one transaction. `recall` provides the evidence, `restore` determines what returns to active context, and `revise` and relationship operations update the current judgment. Retirement itself changes activity; whether a judgment still holds is expressed in its body and relationships.

Together, these operations support ongoing work: current input holds the knowledge in use, detailed experiences remain in durable records, graph traversal brings back relevant material, and new judgments update memory. As input approaches capacity, the runtime reports pressure. When maintenance becomes mandatory, further external actions are deferred while the model processes observations, compacts Frames, or establishes successors. An ordinary Frame retirement request does not yet release its body’s space, so transaction receipts distinguish immediate capacity relief from relief that may follow the consolidation window.

## When two tasks update memory at once

Multiple execution threads belonging to the same agent can share knowledge. A testing thread reads `@e42` and prepares to update `release` to the packaging stage. Another thread receives a user instruction: “Pause the release for now.” If both update the same `release` based on an older version, simply letting the later write overwrite the earlier one could lose an important change.

Morphz checks which parts of context each transaction touches. When two transactions change independent Frames or relationships, the runtime checks whether their explicitly referenced content has changed. An older transaction can be applied to the newer context when those checks pass. When both modify `release`, the conflicting transaction needs to be reconsidered against the current state, so the agent can account for both “tests passed” and “release paused.”

These checks use explicit references: operation targets, `from` sources, relationship endpoints, and similar dependencies. If a release plan depends on a user constraint stored in another Frame, the model should include that dependency among the transaction’s sources so the runtime can check its version. The model is responsible for recognizing business dependencies implicit in free text. The runtime checks whether the referenced records have changed; the model decides how the old and new requirements affect the release plan.

## Results from a cross-task memory evaluation

We also examined how this mechanism was used across tasks and how the complete system performed. An evaluation based on STATE-Bench v0.8.1 compared Morphz with Letta and a Mem0-backed vector-reference agent. The tasks covered shopping assistance, travel, and customer support. In each domain, every system read the same 100 completed task trajectories to build experience, then attempted the same 50 held-out tasks: 150 test tasks per system. Experience was stored in each system’s memory; the underlying model remained unchanged.

The agents, user simulator, and evaluators all used GPT-5.6 Sol at maximum reasoning, with one attempt per test task. A task passed only when it met both the final-state requirements in the tool environment and the conversational and procedural requirements, such as user confirmation, disclosure, and business policies. Execution failures remained in the denominator.

| System | Tasks completed | Completion rate |
| --- | ---: | ---: |
| Morphz | 122/150 | 81.33% |
| Letta 0.16.8 | 93/150 | 62.00% |
| Mem0 2.0.19 vector-reference agent | 96/150 | 64.00% |

A separate read-only trace audit confirmed that all 150 Morphz test tasks began from their domain’s learned revision-100 structured context. The Frames and relationships formed during training participated in subsequent model evaluation. The experiment therefore preserved both task outcomes and execution evidence of memory being used in later work.

These are local results under an updated STATE-Bench-derived evaluator. Conversational and procedural requirements were model-scored; independent human calibration is still pending. The comparison is between complete agent systems, including their prompts, memory maintenance, tool loops, and scheduling. Morphz used more tokens during held-out evaluation; the [full experiment report](https://github.com/morphz-ai/morphz/blob/77f05e1eb16c49c758c0d7f595b8cda16c689a58/docs/research/paper_evaluation/artifacts/me07_public_agent_systems_formal_one_run_20260827/README.md) lists completion rates, usage, and configurations for all three systems.
