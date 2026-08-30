# Codex OTEL compatibility stub

Morphz reuses the pinned `codex-windows-sandbox` subsystem, whose Windows
setup helper optionally emits Codex-internal setup metrics. Morphz does not
adopt that telemetry pipeline. This crate implements only the public types and
methods referenced by the sandbox package and deliberately returns no active
provider or global Statsig configuration.

The compatible upstream API is pinned to OpenAI Codex revision
`94cbbddafc1776d5e377bca1b05932c697e82238`. Codex is distributed under the
Apache-2.0 license; this local crate contains no copied implementation and is
only a deliberately inert compatibility boundary.

It is not a general replacement for `codex-otel`.
