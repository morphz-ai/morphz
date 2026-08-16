---
title: Security and permission boundaries
description: Understand secrets, management identity, workspace protection, and capability approval.
section: operations
order: 310
status: current
---

Morphz treats model output as an untrusted proposal. Every real-world side effect must pass runtime validation for structure, permission, causality, and target boundaries.

## Secret Store

OAuth tokens, API keys, and refresh credentials belong only in the Secret Store. Ordinary configuration contains references, not token values. Credentials must never enter Prompt, Context, Session, Event History, or ordinary logs.

## Dashboard management credential

`MORPHZ_DASHBOARD_TOKEN` is an operator control-plane credential. It proves that the caller can manage the runtime; it is not an end-user Principal. A trusted Gateway uses a separate service credential, and the two must not be reused.

## Non-loopback binding

Binding to `0.0.0.0` or another non-loopback address exposes the management surface. Use a strong Dashboard token and provide TLS, access control, and network boundaries in the deployment environment.

## Project configuration is not the host control plane

A project directory may be untrusted. Project `.morphz/morphz.toml` cannot redirect provider credentials, the Secret Store, management binding, or host security policy. Working-directory `.env` files are not loaded implicitly.

## Tools and targets

Tool permission is the intersection of Sandbox, approval, Principal, Thread, and Execution Target. The runtime validates the actual path and capability for every call instead of trusting a model declaration.

## Audit

Denials, approvals, tool calls, model paths, and state transitions remain traceable events. Hiding a UI record does not undo an external side effect and must not erase audit history.
