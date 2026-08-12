---
title: CLI reference
description: Top-level commands, diagnostic entry points, and help discovery.
section: reference
order: 400
status: current
---

The CLI schema is defined in code with Clap. The current binary’s `--help` output is the final authority for flags and subcommands.

## Direct conversation

Text without a subcommand is sent to the Agent:

```bash
morphz inspect this project
morphz -- treat setup as ordinary prompt text
```

`--` forces the remaining text to be a Prompt and avoids collisions with command names.

## Top-level commands

| Command | Purpose |
|---|---|
| `exec` | Run one explicit Agent request |
| `resume` | Resume an existing Session |
| `serve` | Start HTTP, WebSocket, and Dashboard |
| `dashboard` | Start the Dashboard and open a browser |
| `setup` | Open guided model configuration |
| `provider` | Manage service instances and auth accounts |
| `model` | Manage and test model routes |
| `context` | Manage Context, cognition, and Recall |
| `session` | Create, list, resume, and archive Sessions |
| `objective` | Manage durable goals |
| `scheduler` | Inspect and control scheduling |
| `job` | Inspect background work |
| `edge` / `target` / `execution` | Manage execution nodes and targets |
| `config` | Inspect effective configuration and sources |
| `doctor` | Run system diagnostics |
| `completion` | Generate shell completion definitions |

## Discover exact help

```bash
morphz --help
morphz help provider
morphz provider account --help
morphz context recall search --help
```

Interface language is controlled by `[ui].language`, `--language`, or `MORPHZ_LANGUAGE` and accepts `auto`, `en`, or `zh-CN`.

## Script output

Management commands generally support `--format=json`. Automation should consume stable IDs and JSON fields, not human tables or translated text.
