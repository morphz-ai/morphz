---
title: Principals and authority
description: Understand who interacts with an Agent, who may grant authority, and how identity persists along a causal path of work.
section: concepts
order: 105
status: current
---

A Principal is the stable identity and source of authority entering the Morphz Runtime. It may represent a person, organization, service, or delegated identity.

A Principal answers two questions: who is interacting with the Agent, and where authority for this action comes from. One Principal may return through multiple Sessions to the same Agent. One Agent may also work with multiple Principals while preserving their distinct messages, approvals, and authority.

## Principal, Agent, and Session

Principal, Agent, and Session answer three different questions:

- **Principal**: who is interacting, requesting work, or granting authority;
- **Agent**: who owns cognition and continues the work;
- **Session**: which connection carries the interaction and where results should be delivered.

A model account identifies a model resource, a model request identifies one Evaluation, a Session identifies an interaction connection, and a Principal identifies the participant and source of authority. One person may return through several Sessions, and several Principals may collaborate with the same Agent through their own Sessions.

## Identity persists along the causal path

When a message enters the Runtime, it is bound to a Principal. Threads, Objectives, Activations, approvals, and Capability Leases derived from that message preserve the same origin. A new message arriving while a tool is pending cannot change the Principal of the earlier work, and a late tool result cannot borrow authority from another Session.

This causal binding lets Morphz answer who initiated the work, who approved an Action, which authority the Action used, and where its result belongs.

## Local and multi-user entry points

A local Runtime uses one default Principal, which fits single-user work on a personal device. A multi-user entry point must authenticate an end user independently before asserting that Principal to the Runtime.

A Runtime administration token grants management access to that instance. A multi-user entry point still authenticates the end user independently and supplies the corresponding Principal identity.

## Authority only narrows

A Principal may own an Execution Target and further restrict its use to an Agent, Context, or Thread. A one-time approval covers only the displayed Action. A reusable Capability Lease remains bound to its Principal, scope, Target, operation set, and expiry.

Selecting a Target, owning a Target, approving one Action, and holding a durable capability are four independently recorded authority facts. The Runtime validates each and applies the narrowest effective boundary.

See [Security and permission boundaries](/en/docs/security) for Secret Store, approval, sandbox, and network-exposure rules.
