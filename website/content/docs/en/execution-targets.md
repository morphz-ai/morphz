---
title: Workspaces and execution targets
description: Control where an Agent executes and which capabilities are available.
section: guides
order: 230
status: current
---

Models propose actions; the runtime decides whether they may occur on a specific Execution Target. Target, permissions, and workspace form the boundary for real-world side effects.

## Local workspace

The default workspace is the directory from which Morphz starts. `--cwd` changes the directory before project configuration is loaded. The runtime protects its own configuration, database, executable, `.git`, `.ssh`, and other control-plane paths from Agent tools and shell commands.

## Sandbox and approval

The Sandbox defines physical access; approval policy defines required authorization. They are different boundaries. Access to a directory does not approve every command, and approving one capability does not widen the Sandbox.

## Managed SSH

Morphz can resolve remote targets through the host’s existing OpenSSH configuration. The Agent submits a host alias and required capabilities; the runtime uses the host SSH client, strict host-key validation, and batch mode without exposing private-key material to the model.

```json
{
  "kind": "managed_ssh",
  "host": "production",
  "capabilities": ["exec"]
}
```

Direct IP or DNS targets may include a user and port. Existing `IdentityFile`, `ProxyJump`, and SSH Agent settings remain the responsibility of host OpenSSH.

## Edge Execution Node

An Edge Node pairs with a Morphz Gateway through an outbound connection. It fits networks the runtime cannot access directly. Pairing codes are short-lived; durable device credentials and capability leases remain local to the node and can be revoked.

## Capability leases

An approval may produce a lease limited to a Principal, Agent, Thread, Target, and capability set. Reuse is valid only inside the exact same boundary. Similar commands do not imply broader permission.
