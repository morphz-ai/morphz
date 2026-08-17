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

Morphz can resolve remote targets through the host’s existing OpenSSH configuration. The Agent submits a host alias and required capabilities; the runtime uses the host SSH client and strict host-key validation without exposing credential values to the model.

```json
{
  "kind": "managed_ssh",
  "host": "production",
  "capabilities": ["exec"]
}
```

Direct IP or DNS targets may include a user and port. When no key Secret is bound, existing `IdentityFile`, `ProxyJump`, and SSH Agent settings remain available through host OpenSSH.

To avoid manually configuring `ssh-agent`, store the private-key contents in the Secret Store and bind only its alias to the Target:

```json
{
  "kind": "managed_ssh",
  "host": "login.scnet.example",
  "user": "researcher",
  "auth_mode": "key_only",
  "private_key_secret": "SCNET_SSH_KEY",
  "private_key_passphrase_secret": "SCNET_SSH_KEY_PASSPHRASE"
}
```

The passphrase alias is optional and valid only with a private-key alias. The Runtime resolves these Target-owned aliases in the current Context, Session, Objective, and Target scope. It writes the key to a Runtime-private `0600` temporary identity file, forces OpenSSH to use only that identity, and deletes it after the connection handoff. Values never enter Target metadata, tool arguments, Event History, or an ordinary Shell environment. `resolve_target` deliberately does not accept an arbitrary private-key path.

## Edge Execution Node

An Edge Node pairs with a Morphz Gateway through an outbound connection. It fits networks the runtime cannot access directly. Pairing codes are short-lived; durable device credentials and capability leases remain local to the node and can be revoked.

## Capability leases

An approval may produce a lease limited to a Principal, Agent, Thread, Target, and capability set. Reuse is valid only inside the exact same boundary. Similar commands do not imply broader permission.
