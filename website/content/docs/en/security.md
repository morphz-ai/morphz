---
title: Security and permission boundaries
description: Understand how untrusted model output, Principal identity, secrets, Execution Targets, approval, and audit remain separate.
section: operations
order: 310
status: current
---

Morphz treats model output, tool results, imported artifacts, and remote data as untrusted candidates. A real-world effect must pass joint Runtime validation of structure, identity, causality, version, Execution Target, and capability boundaries.

## Principal identity

Local default mode attributes requests to the Runtime's default Principal. Trusted Gateway mode allows an independently authenticated Gateway to assert the end-user Principal, but it requires a separate service identity and token.

`MORPHZ_DASHBOARD_TOKEN` proves only that a caller may administer the current Runtime. It is not an end-user identity and must not be reused as the Trusted Gateway service token.

## Secret Store

OAuth tokens, API keys, SSH private keys, and refresh credentials belong only in the Secret Store or controlled environment variables. Ordinary configuration stores aliases or environment-variable names, never credential values.

Credential values must not enter:

- model input or Cognitive Context;
- Sessions or cognitive Frames;
- Event History or Agent Trajectory Bundles;
- tool arguments, Execution Target metadata, or ordinary logs.

The model may request a declared secret alias but cannot list or read its value.

## Project configuration cannot control the host

A project directory may be untrusted. `.morphz/morphz.toml` can express project preferences within the allowed scope but cannot redirect model credentials, Secret Store, management binding, physical storage, security policy, or managed SSH destinations. A workspace `.env` file is not loaded implicitly.

## Target ownership and scoped authorization

An Execution Target is first owned by a Principal. Its owner may narrow use to an Agent, Context, or Thread. Once a Target has scoped authorization history, only matching active authorizations may use it; revoking the final authorization does not restore general owner-wide access.

Target discovery, Target selection, scoped Target authorization, and tool capability approval are different actions. None substitutes for the others.

## Approval and Capability Leases

Approval evidence is frozen at the causal root that produced the request. Later concurrent messages do not flow backward into an existing review, and a broad instruction from another Thread cannot authorize the current Action.

A one-time approval covers only the displayed Action. The Runtime creates a Capability Lease only when it explicitly offers a reusable boundary and that option is approved. The Lease is scoped to a Thread, Objective, or Session and remains bound to Principal, Agent, Execution Target, capability, requested-parameter subset, policy digest, and expiry.

The Runtime does not infer wider authority from a “similar command,” “same repository,” or prior approval.

## Sandbox and physical effects

Sandbox policy checks the resolved path and operation, not only the text submitted by the model. Shell commands, file access, managed SSH, and Edge execution must occur within the workspace and policy of the selected Execution Target.

Harnesses, Yao Plans, and tool adapters may request Actions or narrow policy further. They cannot expand Runtime authority, forge execution results, or bypass durable effect recording.

## Untrusted imports

A `.hns` package receives structural, type, entry, and content-identity validation before installation; installation grants no capabilities. Agent Trajectory verification does not execute payloads, dereference external resources, restore capabilities, or write to the Runtime. An integrity digest can detect content tampering but is not proof of publisher identity or factual truth.

## Network exposure

Non-loopback binding exposes the management plane and requires a strong Dashboard token plus deployment-provided TLS, access control, and network isolation. Edge Nodes connect outbound with device identity keys. A short-lived pairing code establishes only initial trust; device identity can be rotated and revoked.

## Audit

Approval decisions, Capability Leases, tool Actions, Target authorizations, model paths, Context transactions, and lifecycle transitions retain stable identity and causal metadata. Deleting a UI record does not undo an external effect and must not destroy authoritative Event History.
