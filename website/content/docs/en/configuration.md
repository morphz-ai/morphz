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

## HTTP proxy routing

Provider, OAuth, and Cognitive Coordination traffic follows the system proxy by default. Standard `NO_PROXY` exclusions remain authoritative, so a machine that proxies Internet traffic but reaches a local Mesh directly can use:

```bash
NO_PROXY=.local,localhost,127.0.0.1,::1 morphz serve ...
```

`MORPHZ_HTTP_PROXY_MODE=system|direct` sets the global policy. `MORPHZ_PROVIDER_PROXY_MODE`, `MORPHZ_OAUTH_PROXY_MODE`, and `MORPHZ_COORDINATION_PROXY_MODE` override one traffic class. OAuth inherits the Provider override when its own override is absent. Morphz never silently changes Provider routing because a Mesh probe failed.

## Default execution device

Local, self-hosted, and CLI deployments use the machine running Morphz as the default Execution Target, so no selection is required. A consumer cloud service must not run user work on the service host and can disable that fallback in trusted host configuration:

```toml
[execution_targets]
local_enabled = false
```

`MORPHZ_EXECUTION_TARGETS_LOCAL_ENABLED=false` is the equivalent environment override. A Session without a selected device can still converse; its first physical tool request returns `EXECUTION_TARGET_REQUIRED`. Clients can call `GET /api/sessions/:session_id/execution-targets` and use its `reason` to distinguish “install and pair `morphz-edge`” from “select one of the existing devices.” A Session selection affects only subsequently-created work and never migrates active work.

## Capacity overrides

Provider capacity fields are optional:

```toml
[services.example.models."physical-model"]
context_window_tokens = 262144
max_input_tokens = 229376
max_output_tokens = 32768
```

Set them only when returned by the service or confirmed by the operator. An absent field means unknown, not zero, and must not trigger a guessed value.

Model inputs likewise separate host safety policy from physical-model capability. Host policy belongs to user configuration and cannot be relaxed by a project file:

```toml
[model_input]
max_artifacts_per_import = 128
max_artifact_bytes = 134217728
max_import_bytes = 268435456
max_artifacts_per_request = 128
max_request_bytes = 268435456
```

The first three fields bound one user upload or tool-result import; the last two bound the final physical model request. Dashboard reads this same policy from Runtime instead of carrying another set of constants. The defaults support a typical 43-screenshot visual review, while remaining configurable host memory, disk, and transport safeguards—not claims about a model.

Declare stricter physical-model limits only when the service returns them explicitly or the operator has confirmed them:

```toml
[services.example.models."physical-model"]
max_input_attachments = 64
max_input_attachment_bytes = 67108864
max_input_attachment_total_bytes = 201326592
```

Each request takes the stricter value from host policy and the physical-model declaration for every dimension. Missing model fields remain unknown; Morphz does not infer them from a model name. Model Attempt state records the actual attachment count and bytes, the effective limits, and their source.
