---
title: Operations and troubleshooting
description: Diagnose model, cognition, scheduling, execution, and storage boundaries, then update or recover the Runtime safely.
section: operations
order: 300
status: current
---

Troubleshoot along the boundaries a request actually crossed. Repeatedly creating Sessions, logging in again, or rerunning a tool can hide the original causal path and create additional state.

## Establish version, configuration, and overall health

```bash
morphz version
morphz config check
morphz config explain --format=json
morphz doctor
```

`config check` validates every configuration layer. `config explain` shows whether each effective value came from user configuration, project preference, environment, or command line. `doctor` checks storage, workspace, authority, and model-service configuration. Passing these diagnostics establishes the static boundaries; real model requests and remote tools still need live tests at their respective boundaries.

## Authenticated but no model response

Authentication proves only that credentials exist. Check in order:

1. the selected model Route;
2. the Provider Instance, physical model, and account resolved by that Route;
3. whether the account is enabled, expired, or cooling down;
4. whether the service catalog contains the physical model or an operator explicitly configured it;
5. whether the measured failure is authentication, model identity, protocol, capacity, or network related.

```bash
morphz provider account test <account-id> --route=<model-route>
morphz model route test <model-route> --account=<account-id>
```

Connection establishment, first-byte wait, and stream reads have independent timeouts. A transient Provider failure may place a Thread into backoff while it waits for resource recovery. The model Attempt count records replaceable model calls within the same Thread.

## Mind projection or Recall mismatch

```bash
morphz context status <context-id>
morphz context audit <context-id>
morphz context recall-index inspect <context-id> --format=json
```

`context audit` verifies the current Mind projection by replaying authoritative Events. If Events and Mind are correct but lexical search is incomplete, rebuild only the derived Recall index:

```bash
morphz context recall-index rebuild <context-id> --format=json
```

Do not repair cognitive Frames by editing database rows, and do not mistake search-index reconstruction for recovery of authoritative state.

## A Thread, Objective, or delivery does not continue

```bash
morphz scheduler show --context=<context-id> --include-terminal --limit=100
morphz scheduler thread show <thread-id> --context=<context-id>
morphz objective show <objective-id> --format=json
```

Inspect the exact dependency and owner:

- waiting for model-service recovery;
- waiting for a tool task, Thread Group, or delegation Outcome;
- waiting for approval, user input, a timer, an external Event, or a resource;
- explicitly paused Thread control;
- a blocked Objective that needs a revised goal or new condition;
- an Outcome exists but delivery remains pending or deferred;
- the owner is already terminal and a lifecycle invariant failed.

The last case should not be handled by repeatedly pressing “resume.” Preserve Thread, Activation, root Event, and trigger Event identities to locate the causal break.

## Physical tools and Execution Targets

```bash
morphz target show <target-id> --format=json
morphz execution show <job-id> --format=json
morphz execution output <job-id> --after=0 --limit=100
morphz lease list --target-id=<target-id> --format=json
```

Distinguish an offline or disabled Target, mismatched scoped authorization, sandbox denial, pending approval, expired Capability Lease, and failure inside the tool itself. An ordinary command error is not automatically an authority error.

For an Edge device, also inspect:

```bash
morphz-edge status
morphz-edge local-leases --json
```

Edge Nodes use outbound connections. A Gateway that cannot initiate a connection to the device is expected. Revoked device credentials, an identity-key mismatch, or stale heartbeat will still make the Node unavailable.

## Storage and multiple Runtime instances

SQLite is the default physical store. The presence of a PostgreSQL URL environment variable never switches the Runtime automatically. Before changing physical backends, ensure every instance uses the same configuration and migration version.

ContextDB is the default cognitive authority. The explicit migration command synchronizes cognitive state into the selected authority and returns an auditable result:

```bash
morphz storage migrate-cognitive-store --to context_db --format=json
```

Runtime startup never migrates cognitive state implicitly. Do not allow instances using different cognitive authorities to write the same logical deployment concurrently.

## Dashboard and network

`morphz serve` listens on `127.0.0.1:8080` by default. Non-loopback binding requires `MORPHZ_DASHBOARD_TOKEN`; the deployment environment must also provide TLS, access control, firewalling, and correct long-lived connection forwarding.

When model, authorization, or Cognitive Coordination traffic crosses a proxy, use `config explain` to verify the effective proxy policy and `NO_PROXY`. Do not change model routing merely because one coordination path is unavailable.

## Update and rollback

```bash
morphz update status
morphz update
morphz version
```

The updater reads versions and platform assets from the configured GitHub Release repository, validates release metadata and SHA-256, atomically replaces the main binary, and retains the previous binary. To withdraw an installed release:

```bash
morphz update rollback
```

Rollback restores only the main binary. It does not roll back database state or external effects. If the new executable cannot run at all, invoke the retained previous binary directly or rerun the installer instead of relying on that executable to roll itself back. The standalone `morphz-edge` binary is not updated with the main program.

## Time and issue reports

Include the version, complete error, relevant stable identities, and RFC 3339 timestamps with explicit offsets in a report. Physical Event sequence records persistence order, not business causality. Do not infer causal origin solely from which log line appeared later.
