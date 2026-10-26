# Codex protocol HTTP types

Morphz's pinned Windows protocol at
`94cbbddafc1776d5e377bca1b05932c697e82238` imports only `HttpError` and
`HttpResponse`. Upstream defines both as direct reqwest aliases in
[`http-client/src/client.rs`](https://github.com/openai/codex/blob/94cbbddafc1776d5e377bca1b05932c697e82238/codex-rs/http-client/src/client.rs#L17).
This adapter preserves those exact type identities and the upstream reqwest
feature request; it does not implement an HTTP transport.

Pulling in the full client also pulled in zstd, zstd-safe and zstd-sys, whose
newly assigned advisories RUSTSEC-2026-0391, 0398, 0403 and 0410 blocked the
2026-10-26 audit. Morphz does not use that client's compression entry points.
The root and isolated response-annotation workspace both select this same
boundary, removing the unused implementation and affected dependencies rather
than adding an advisory exception. A future protocol revision requiring any
other client API must fail compilation until that new surface is reviewed.

Validation uses the unchanged full dependency audit and the real Windows
sandbox/runtime CI consumers. The published v0.1.4 tag is not rewritten.
