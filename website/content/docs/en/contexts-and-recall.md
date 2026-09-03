---
title: Contexts, cognitive frames, and Recall
description: Understand the active working set, retired cognition, and authoritative history.
section: concepts
order: 110
status: current
---

Context does not mean sending every historical byte to the model on every call. The Runtime compiles a bounded Context Encoding for the current Evaluation while preserving complete events in a distinct Event History. The Agent can Recall authoritative evidence when it becomes relevant.

## What the model sees

Each model request receives a Context Encoding compiled for that moment. It may include:

- Messages from the current Session;
- The Session Directory, plus full or metadata-only projections of other Sessions in the Session Working Set;
- Active cognitive frames;
- Current observations and previews of tool results;
- Objective, Thread, and permission metadata;
- Stable references to recallable source text.

Swapping out a Session, removing an Observation from the current projection, or retiring a cognitive frame does not mean physical deletion. Content absent from this Encoding may still exist in immutable Event History or recallable cognitive state.

## Recall modes

Recall currently supports four primary access paths:

1. Read event text by stable short reference or full Event ID, with pagination;
2. Traverse a cognitive frame by Frame ID;
3. Search the current Context event history with Unicode keywords;
4. Search an explicit time range, alone or combined with keywords.

Time-range example:

```bash
morphz context recall search \
  --since=2026-08-04T09:00:00+08:00 \
  --until=2026-08-04T18:00:00+08:00 \
  --format=json
```

`since` is inclusive and `until` is exclusive. Include an explicit UTC offset so local time is never guessed.

## Paging large events

The active Context may retain only a preview of a large tool result or file. When Recall returns `next_offset` or `next_cursor`, pass it back unchanged. Pagination reads the same authoritative source; it does not repeat the original tool action.

## Recall does not rewrite cognition

Recall results enter the Agent inbox. Updating a cognitive frame still requires an explicit Context Transaction. This preserves the difference between “historical evidence was read” and “this is now current cognition.”
