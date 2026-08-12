---
title: Operations and troubleshooting
description: Diagnose model paths, scheduler state, logs, and storage boundaries.
section: operations
order: 300
status: current
---

Troubleshooting should follow the real request path. Repeatedly creating Sessions or logging in again usually hides the original failure.

## Start with Doctor

```bash
morphz doctor
```

Doctor checks storage, workspace, permissions, and provider configuration. It identifies structural problems but does not replace a real model request.

## Authenticated but no response

Confirm, in order:

1. The selected model route;
2. The provider instance, physical model, and account it resolves to;
3. Whether the account is enabled, expired, or cooling down;
4. Whether the service catalog contains the physical model or the operator configured it explicitly;
5. Whether the test failed on authentication, model name, protocol, or network.

```bash
morphz provider account test <account-id> --route=<model-alias>
morphz model route test <model-alias> --account=<account-id>
```

## Transient network failure

Provider connection setup and stream reading have retry and timeout boundaries. `attempt` in a log line is the local attempt number. A single connect or first-byte wait can consume time in addition to backoff. After bounded failure, the runtime may wait for resource recovery, but the UI must name the wake-up condition.

## Thread remains waiting or paused

Inspect the reason, not only the status badge:

- Waiting for model service recovery;
- Waiting for a tool or background result;
- Waiting for approval or user input;
- Explicit user pause;
- A terminal owner that violates lifecycle invariants.

The final case is a runtime or historical-data problem. Repeatedly pressing Resume is not a repair.

## Dashboard is unreachable

`morphz serve` listens on `127.0.0.1:8080` by default. A non-loopback bind requires `MORPHZ_DASHBOARD_TOKEN`. Remote access also requires the firewall, reverse proxy, and WebSocket forwarding to be correct.

## Time

Persistence and APIs may use absolute timestamps. User-facing logs and UI should display local time or an explicit offset. Include the complete RFC 3339 timestamp in incident reports.
