---
title: From Chat Completion to Structured Context Evaluation
description: As agents work across sessions, tasks, and concurrent objectives, a linear message history is no longer enough to carry their cognition. Morphz proposes a different computational model in which structured context itself becomes the object of evaluation.
published: 2026-08-26
author: Morphz Project
category: Technical Note
---

Large language model agents can now work for hours, continue across sessions, and pursue several objectives concurrently. Yet in most agent systems, every model request must still reconstruct the agent's current state as a chat transcript.

This article examines the mismatch between that foundational computational model and the requirements of durable agents. It explains why Morphz defines structured Context itself as the object evaluated by a language model.

Chat completion made large language models usable as a general interface. It is simple, natural, and remarkably open-ended. A person says something; a model produces what comes next. A tool call is merely a special kind of response within that exchange. There is nothing wrong with this computational model. The problem is that we gradually asked it to carry responsibilities far beyond conversation.

Agents now have tools, memory, workflows, subagents, schedules, permissions, and durable state. Their runtimes are no longer chat windows. Yet what the model usually sees remains a linear sequence of messages that must be extended, compressed, and rewritten over time.

The agent has moved beyond chat. Its computational model has not.

## A transcript is not cognitive state

In a linear agent, one evaluation can be approximated as:

```text
next_message = model(instructions, message_history, tool_results)
```

Instructions define the rules. Message history carries the past. Tool results bring reality back to the model. A runtime may surround this sequence with summarization, retrieval, and state machines, but the model's fundamental object remains a record of what was previously said.

That works extremely well for short tasks. As work grows longer, the same history must represent facts, objectives, progress, causality, preferences, tool state, and the agent's understanding of itself. Information with different owners and lifecycles is pushed into one container and distinguished mostly by natural-language position and model attention.

Compression becomes a risk of forgetting. Concurrency becomes interleaved messages. Recovery becomes another retelling of the past. Memory often means finding old text and placing it back into new text.

Morphz aims to change more than the way a prompt is written. It changes the object presented for computation.

## Context is not a prompt

In Morphz, a Context is not the string about to be sent to a model. It is an identity-bearing, versioned cognitive state owned by an agent. A prompt is only the view compiled by the Runtime for one bounded Evaluation.

A conceptual Morphz Context looks like this:

```lisp
(context
  (kernel ...)
  (mind ...)
  (inbox ...)
  (evaluate ...))
```

The `kernel` contains Runtime-owned facts such as identity, authority, versions, budgets, and execution state. The `mind` contains cognitive Frames formed and maintained by the agent. The `inbox` carries Observations that still require interpretation. The `evaluate` expression identifies the current responsibility, causal scope, and available capabilities.

These regions do not have equal ownership. The model can interpret Runtime facts but cannot forge them. It owns cognitive meaning, but it modifies cognitive state through versioned transactions. The Runtime does not decide domain truth for the model; it preserves provenance, ordering, authority, and commit boundaries.

Context therefore stops being an input assembled for one request. It becomes a first-class object that persists, projects, changes, and recovers.

## Structure is not a serialization format

Wrapping messages in JSON, or placing XML tags around text, does not automatically create structured cognition.

Structured data becomes structured Context only when its parts have stable identity, ownership, lifecycle, relations, and transition semantics. The model cannot merely read it as background information. It must understand which part it is evaluating and which state transitions it is allowed to propose.

The important shift is not:

```text
text message -> structured message
```

It is:

```text
generate the next message -> evaluate the current context
```

Under this model, an agent step is closer to:

```text
context[t+1] = evaluate(context[t], event, capabilities)
```

`evaluate` is not a deterministic function in the conventional sense. The language model remains a nondeterministic semantic processor. It interprets new observations, decides what deserves a place in durable cognition, chooses an action, and proposes a structured transition. The same input may produce more than one reasonable result.

Determinism belongs on the other side of the boundary. The Runtime validates structure, versions, causal scope, authority, and resource limits, then commits or rejects the proposed transition. Nondeterministic cognition and deterministic facts can coexist without pretending to be the same thing.

## Persistence and concurrency stop being peripheral features

Once cognitive state is independent of message history, several capabilities that look unrelated begin to follow from the same abstraction.

A Session is a communication connection between an agent and a person or system, not a memory container. Several Sessions can share one Context without creating several mutually forgetful copies of the agent.

A Thread is a causal path of work, not the conversation as a whole. While an older task waits for a tool, a new dialogue can continue. The result returns only to the path that requested it instead of leaking into another Evaluation.

An Objective is a durable control structure spanning Evaluations, waits, and execution Threads. It does not need to survive as one more reminder hidden somewhere in the transcript.

Concurrency no longer means only running several copies of a conversation. Different Evaluations can work against one shared cognitive Context and modify independent Frames through versioned transactions. The Runtime can safely rebase independent changes and reject genuine conflicts.

All of this still requires substantial engineering. The difference is that these capabilities no longer depend on unrelated patches. They share one state model.

## Why S-expressions

Parentheses are not magic. Morphz does not use S-expressions because JSON cannot represent a tree, or because the system needs to look like a programming language.

Their value is that data, protocol, and executable programs can share one minimal representation. Nesting is explicit. Composition does not require a new message envelope at every layer. The same tree can represent cognitive state, the current Evaluation entry point, and a Yao program.

More importantly, S-expressions keep the underlying idea visible: the model is not reading a formatted document. It is operating as the semantic processor of a cognitive machine, presented with that machine's current state and an expression to evaluate.

Structured Context Evaluation does not depend on one parenthesized syntax. It depends on stable semantics. Another encoding that preserves the same identity, ownership, transaction, and evaluation contracts could implement the same paradigm. Morphz chooses S-expressions because they give those semantics a language foundation that can continue to grow.

## This may change what models learn

Agent post-training today is still largely organized around answers, reasoning traces, and tool calls. Even as runtimes improve, training helps them indirectly: the model becomes better at conversation and tool use, and an external system assembles those abilities into an agent.

If structured Context becomes the native object of evaluation, the training objective can change as well. A model could directly learn:

- how to revise cognition in response to evidence instead of merely appending text;
- how to distinguish transient Observations, durable knowledge, and Runtime facts;
- how to maintain shared cognition across concurrent work;
- how to propose verifiable, reversible, provenance-bearing state transitions;
- how to organize its own Context under a finite budget.

Morphz does not have a specially trained native model today, and this is not a near-term promise. It is simply the training direction implied by the computational model: from teaching a model to complete a conversation toward teaching it to evaluate a structured world.

## This is not a finished answer

Structured Context has costs. A changing cognitive state can reduce prefix-cache reuse. Today's models are trained primarily for natural-language conversation. Correct protocols, transactions, and scheduling require far more engineering than a prompt. Yao has not yet become the complete language we intend it to be.

More fundamentally, a new abstraction does not win because it appears elegant from the inside. It must show, under the same model, task, and comparable budget, that long-running work forgets less, concurrent work interferes less, cognition genuinely transfers across Sessions, and the cost of maintaining those properties is acceptable.

Morphz remains under active development. We publish behavior that can be verified today and keep the unanswered questions visible. Structured Context is not a slogan to believe. It is a hypothesis to implement, measure, and criticize.

## Conclusion

This article does not argue for eliminating chat. Conversation remains one of the most natural interfaces between people and agents. What must change is the assumption that a transcript should continue to serve as the ontology of an agent's entire cognition.

If agents are to become durable actors, they need cognitive state they can continuously own. If they are to face many people and objectives at once, they need causality and concurrency semantics stronger than message order. If they are to learn, they need to revise, relate, protect, and retire knowledge instead of accumulating everything ever said.

In this computational model, chat is input and output. Cognition is not a by-product of conversation; it is a structure that can be held, evaluated, committed, and continued. Morphz is a reference implementation of this model and remains subject to continued engineering and empirical validation.

[Read the core concepts](/en/docs/core-concepts), or inspect the implementation on [GitHub](https://github.com/morphz-ai/morphz).
