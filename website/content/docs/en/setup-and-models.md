---
title: Setup and model selection
description: Understand what the wizard persists and when a model becomes selectable.
section: start
order: 20
status: current
---

Setup creates a complete request path. It does more than store an API key: a usable configuration needs a provider instance, an auth account, and a model route.

## Two Setup interfaces

| Command | Use case |
|---|---|
| `morphz setup` | Local systems or environments that can reach the Dashboard |
| `morphz setup --tui` | SSH, headless, or terminal-only systems |
| `morphz setup --no-open` | Start Dashboard Setup without opening a browser |

The Dashboard and TUI write the same configuration model.

## What Setup persists

1. **Provider instance**: endpoint, protocol, and service dialect;
2. **Auth account**: an OAuth identity or API key reference;
3. **Model route**: how a selectable name resolves to a physical model and account;
4. **Model capacity**: only when returned by the service or explicitly overridden.

OAuth tokens and API keys do not belong in ordinary TOML. The configuration stores references to the Secret Store.

## Why login may produce no selectable model

Authentication proves that Morphz has authorization material. The selector also requires an enabled model route. When a service exposes a model catalog, the Dashboard shows the names returned by that service. When it does not, the operator must enter a physical model name the service really accepts.

Morphz must not invent model names or display a generated route ID as though it were a user-defined alias.

## Default model

`[llm].model` selects the default route. The selector displays the route `display_alias` when set; otherwise it displays an explainable physical model name.

Inspect the merged value and its source with:

```bash
morphz config explain --format=json
```

This is more reliable than reading one TOML layer because Morphz merges user configuration, project preferences, and command-line overrides.
