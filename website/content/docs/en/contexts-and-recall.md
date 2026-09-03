---
title: Contexts, cognitive Frames, and Recall
description: Understand how authoritative Events, current cognition, explicit transactions, and bounded Context projections work together.
section: concepts
order: 110
status: current
---

A Cognitive Context is not a prompt, and it does not require sending all historical text to the model on every request. It is durable state owned by the Agent. Context Encoding is the bounded view compiled by the Runtime for one Evaluation.

## Three state layers

Morphz separates durable state into three layers:

1. **Event History** preserves inputs, tool results, approvals, and state commits that actually occurred. It is the authoritative fact source.
2. **Mind state** contains cognitive Frames, relations, order, and checkpoints maintained through explicit transactions.
3. **Context Encoding** projects the Events, cognition, Sessions, and Runtime state needed by the current Evaluation.

ContextDB is the current default cognitive store. It keeps immutable Events and authoritative cognitive and scheduler projections within one transactional boundary. The lexical Recall index is derived and rebuildable; it does not replace Event History or Mind state.

## Context Encoding

The current physical encoding order is:

```text
protocol
→ evaluation-profile
→ inbox
→ observation-state
→ mind
→ session-directory
→ kernel
→ optional cognitive-capabilities
→ evaluation-environment
→ evaluate
```

This is an evaluable structure with explicit ownership, not a document assembled from arbitrary fields:

- `inbox` projects immutable Observation content in Event-sequence order;
- `observation-state` contains mutable projection attributes such as protection, residency, freshness, and usage;
- `mind` contains cognitive Frames, relations, and checkpoints;
- `session-directory` represents Sessions and their projection levels;
- `kernel` contains Runtime facts such as scheduling, Objectives, authority, Context pressure, and the current Activation;
- `evaluation-profile` contains a stable Harness definition when one is bound, or `none` otherwise;
- `evaluation-environment` contains the current model, local time, and dynamic bindings;
- the final `evaluate` is the only execution entry point.

A large Observation may be represented by a preview. Its stable short reference, such as `@e42`, still resolves to the same authoritative Event for Recall and Context transactions.

## Cognitive Frame transactions

Frames change only through atomic transactions with an explicit base version:

```lisp
(context-tx
  (base-version 42)
  (reason "replace an outdated assumption with verified evidence")
  (derive deployment/current
    (from @e42)
    (fact (region cn-hangzhou)))
  (relate deployment/current supersedes deployment/old)
  (retire deployment/old))
```

The current operations are:

- `create`, `derive`, and `revise` create a Frame, derive it from evidence, or replace its complete body;
- `retire` and `restore` move an Observation or Frame out of the active Encoding or bring it back;
- `protect` and `unprotect` control content that must remain active;
- `relate` and `unrelate` maintain explicit Frame relations;
- `place` changes Frame projection order;
- `checkpoint`, `rollback`, and `drop-checkpoint` manage Mind snapshots around high-risk restructuring;
- `retire-session` and `restore-session` change Session attention and may commit atomically with Mind changes.

`revise` replaces the entire body. Fields that must survive have to be restated in the replacement.

## Concurrent changes and version conflicts

The Mind version is a global physical commit sequence, but conflict detection tracks finer semantic boundaries: Frame content, lifecycle target, an exact relation edge, Frame order, and checkpoint identity.

When concurrent transactions touch independent boundaries, the Runtime can safely rebase the older transaction onto the latest version. If an exact boundary it read or wrote has changed, the commit is rejected and the Agent must reread and perform a semantic merge. Checkpoint rollback and Session-attention operations always require an exact version and are never rebased.

## Retirement is not invalidation or deletion

Retirement means moving content out of the active Encoding. It does not assert that a fact is false, that cognition is invalid, or that data should be deleted.

- retiring an Observation releases its active Encoding immediately;
- retiring an ordinary Frame first enters a cognitive-clock organizing window, during which it remains visible and releases no immediate capacity;
- a Frame with a safe successor and an explicit replacement relation may leave the active state in the same transaction;
- protected content must be explicitly unprotected first;
- the undelivered root request of the current Activation is causally protected from early retirement.

The organizing window gives the Agent time to revise, restore, or add missing relations. After the window becomes effective, the content remains in history and Recall.

## Recall

Recall provides three principal access paths:

1. lexical and time-range search across Events and cognitive Frames;
2. paged full-content reads by short Event reference or complete identity;
3. traversal from a cognitive Frame through source and relation edges in either direction.

```bash
morphz context recall search sandbox permission --limit=20 --format=json

morphz context recall search \
  --since=2026-08-04T09:00:00+08:00 \
  --until=2026-08-04T18:00:00+08:00 \
  --format=json

morphz context recall frame memory/sandbox \
  --depth=2 --direction=ancestors --include-events --format=json
```

`since` is inclusive and `until` is exclusive. Time values require an explicit offset. When a continuation cursor is returned, pass it back unchanged. Paging reads the same authoritative evidence; it does not rerun the original tool.

Recall results first arrive as new Observations in the Inbox. Promoting them into current cognition still requires an explicit transaction, so reading historical evidence and asserting current cognition remain separate operations.

## Audit and rebuild

```bash
morphz context status context-default
morphz context audit context-default
morphz context recall-index inspect context-default --format=json
morphz context recall-index rebuild context-default --format=json
```

`context audit` replays Events to verify the current Mind projection. Rebuilding the Recall index changes only derived search data, not authoritative Events or Frames.
