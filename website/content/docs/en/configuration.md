---
title: Configuration
description: Understand user configuration, project preferences, environment overrides, and effective values.
section: guides
order: 220
status: current
---

Morphz separates host control-plane configuration from project preferences. An untrusted project must not redirect host credentials or weaken management security.

## Configuration locations

| Layer | Default path | Purpose |
|---|---|---|
| User configuration | `~/.morphz/morphz.toml` | Providers, account references, model routes, storage, and server settings |
| Project preferences | `<workspace>/.morphz/morphz.toml` | Project behavior within the trusted project scope |
| Explicit file | `--config-file <FILE>` | An operator-selected trusted configuration |

`MORPHZ_HOME` changes the Morphz user directory. Earlier platform configuration directories are migration sources, not part of the current public path contract.

## Default model

```toml
[llm]
model = "my-route"
```

This value selects a resolvable model route. The route then names the provider, physical model, and account. These identifiers are not interchangeable.

## Configuration merge

Effective configuration can come from the user layer, project layer, environment, and command line. Inspect both the merged value and its source:

```bash
morphz config explain --format=json
```

Use this when the Dashboard default differs from the TOML file you are reading.

## Credentials

API keys and OAuth tokens should not be written into `morphz.toml`. Configuration stores Credential or Secret Store references. Morphz does not implicitly load a working-directory `.env`; only user-controlled environment sources are considered.

## Capacity overrides

Provider capacity fields are optional:

```toml
[services.example.models."physical-model"]
context_window_tokens = 262144
max_input_tokens = 229376
max_output_tokens = 32768
```

Set them only when returned by the service or confirmed by the operator. An absent field means unknown, not zero, and must not trigger a guessed value.
