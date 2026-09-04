---
title: Workspaces and Execution Targets
description: Select where physical work occurs and constrain effects through Target authorization, sandboxing, approval, and Capability Leases.
section: guides
order: 230
status: current
---

The model may propose an Action, but only the Runtime can turn it into a physical effect. An Execution Target answers “where,” Target authorization answers “which work may use it,” and sandbox plus Capability Lease boundaries answer “what exactly is allowed.”

## Execution Target model

An Execution Target gives a physical work destination a stable identity. Temporary worker processes and network connections belong to that identity. The current Runtime can represent:

- the machine running the current process;
- an Edge device connected through an outbound channel;
- an SSH destination managed through the host's OpenSSH installation;
- a managed cloud worker supplied by a deployment.

A Target records owner, provider Node, platform, workspace root, capabilities, policy digest, and availability. Credential values are forbidden from Target metadata.

```bash
morphz target list --format=json
morphz target show <target-id> --format=json
```

## Local workspace

A local deployment enables the current machine as an Execution Target by default. Its workspace is the current directory when Morphz starts. `--cwd` changes that directory before project configuration is loaded.

The Runtime protects its own configuration, database, executable, `.git`, `.ssh`, and other control-plane paths so the Agent cannot bypass policy through file tools or a shell. A consumer cloud deployment should disable the local Target so user work cannot fall through to the service host; see [Configuration](/en/docs/configuration).

## Sandbox and approval

The sandbox defines physical access. Approval policy decides whether an Action needs one-time or reusable authorization. Neither substitutes for the other: a reachable directory does not make every command approved, and approval does not expand the sandbox root.

A Session's selected Target applies only to work created afterwards. A running Thread does not migrate to another machine. Dialogue may continue without a selected Target; the first physical tool request then returns an explicit Target-required state.

## Scoped Target authorization

Target ownership determines who can discover and administer a Target. The owner may further restrict it to an Agent, Context, or Thread:

```bash
morphz target authorize <target-id> \
  --scope=context --scope-id=<context-id>

morphz target authorizations <target-id> --format=json
```

A Target with no authorization history remains available to its owner. After the first scoped authorization exists, only matching active scopes may use the Target. Revoking the last authorization does not reopen owner-wide access. Revocation requires an exact revision and an auditable reason.

## Managed SSH

Morphz resolves remote destinations through the host's OpenSSH configuration. The Agent submits a host alias and capability requirements. The Runtime invokes the host SSH client with strict host-key checking and never gives credential values to the model.

```json
{
  "kind": "managed_ssh",
  "host": "production",
  "capabilities": ["exec"]
}
```

An explicit user and port may accompany an IP address or DNS name. Without a bound key secret, existing `IdentityFile`, `ProxyJump`, and SSH-agent configuration remain under host OpenSSH control.

A private key may instead live in the Secret Store while the Target contains only aliases:

```json
{
  "kind": "managed_ssh",
  "host": "login.example.com",
  "user": "researcher",
  "auth_mode": "key_only",
  "private_key_secret": "RESEARCH_SSH_KEY",
  "private_key_passphrase_secret": "RESEARCH_SSH_KEY_PASSPHRASE"
}
```

The Runtime resolves Target-owned bindings within the current Context, Session, Objective, and Target scope. It writes the key to a private `0600` temporary identity file, forces OpenSSH to use only that identity, and removes the file after connection handoff. Credential values never enter Target metadata, tool parameters, Event History, or the ordinary command environment.

## Edge Execution Nodes

An Edge Node connects outbound to a Morphz Gateway, allowing a personal or private-network machine to execute work even when the Gateway cannot reach it directly. The main binary creates pairing codes and administers Nodes on the Gateway side:

```bash
morphz edge pairing-code --ttl=300
morphz edge nodes --format=json
```

The remote device installs and runs `morphz-edge` separately. It is execution-only, cannot evaluate models, and is not installed or updated with the main binary:

```bash
morphz-edge bootstrap \
  --server-url=https://agent.example.com \
  --pairing-code=pair_xxx \
  --workspace=/path/to/workspace
```

The pairing code is a short-lived, one-time credential. After bootstrap, the device authenticates outbound with its own durable identity key and may run as a user-level background service. Its device key can be rotated and the Gateway can revoke the Node.

## Capability Leases

One approval may issue a reusable Capability Lease scoped to exactly one Thread, Objective, or Session. A later Action must still match:

- Principal and Agent;
- causal scope and stable scope identity;
- Execution Target;
- physical capability and requested-parameter subset;
- current host and Target policy digest;
- expiry and non-revoked status.

A similar command, directory, or device does not widen a Lease. A policy change prevents an older Lease from covering a new request.

```bash
morphz lease list --target-id=<target-id> --format=json
morphz lease revoke <lease-id> --revision=<revision> --reason='Access no longer needed'

morphz-edge local-leases --json
morphz-edge revoke-local-lease <lease-id>
```

Gateway and provider-local Leases are independently revocable. A device does not remain permanently open merely because the Gateway approved one earlier Action.

## Inspect physical Jobs

```bash
morphz execution list --target-id=<target-id> --include-terminal
morphz execution show <job-id> --format=json
morphz execution output <job-id> --after=0 --limit=100
```

Physical Jobs, output chunks, and cancellation state are durable records. Cancellation requires an exact Job revision so a stale client cannot cancel work whose state has already changed.
