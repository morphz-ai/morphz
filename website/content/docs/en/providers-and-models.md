---
title: Model services, accounts, and routes
description: Configure a model request path and understand every name in the selector.
section: guides
order: 200
status: current
---

Morphz models access through wire protocols, service adapters, provider instances, auth accounts, and model routes. Keeping them separate prevents the runtime from becoming coupled to one vendor.

## Five separate objects

| Object | Question it answers |
|---|---|
| Protocol | What are the HTTP and stream semantics? |
| Provider Adapter | Which endpoints, headers, and dialect does the service require? |
| Provider Instance | Where does this deployment connect? |
| Auth Account | Which login identity or API key is used? |
| Model Route | How does a user selection resolve to a physical model and account? |

## Supported protocols

The current wire protocols are OpenAI Responses, OpenAI Chat Completions, Anthropic Messages, and Gemini generateContent. Compatible gateways, self-hosted services, and API-key endpoints reuse these protocols instead of introducing a domain model for every brand.

## Physical names and aliases

A physical model name comes from the service catalog or explicit operator input. Morphz does not guess model names from a brand and does not create plausible-looking defaults.

A route may define `display_alias`. The selector displays that alias when present; otherwise it displays an explainable physical name. A generated route ID remains an internal stable reference unless the operator explicitly records it as an alias.

## Direct route target

```toml
[models.my-coding-model]
display_alias = "Coding"
service = "codex-subscription"
physical_model = "gpt-example-coding"
account = "account-example"
```

The physical name above is a structural example and must be replaced with a model the service currently accepts.

## Multiple candidates

A route can contain multiple ordered candidates when several services provide the same user-facing choice. The runtime selects one eligible, enabled, healthy candidate. Account cooldown or network failure may move selection to another candidate; one request does not use multiple accounts simultaneously.

## Model capacity

- **Context window**: combined input and generated output limit;
- **Maximum input**: prompt-only limit;
- **Maximum output**: generation allowance.

Morphz stores fields returned by the service and leaves absent fields unknown. Operators may override a confirmed limit, but the runtime must not invent capacity values.
