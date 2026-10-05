# Response annotations mechanism experiment

This directory is an isolated proposal validation, not a production Runtime
feature. It does not open the Runtime database, change Profiles, execute shell
tools, or create activities. The work receipts are synthetic constants.

The design and acceptance gate are in
`docs/morphz_response_annotations_proposal_v1.md`.

## Deterministic checks

```sh
node --test experiments/response-annotations/protocol.test.mjs
node --test experiments/response-annotations/dependency-boundary.test.mjs
CARGO_TARGET_DIR=target cargo test --offline --manifest-path experiments/response-annotations/Cargo.toml --lib
CARGO_TARGET_DIR=target cargo test --offline --manifest-path experiments/response-annotations/Cargo.toml --bin response-annotations-probe
```

The JavaScript prototype checks schema opt-in, raw/business argument separation,
exact observation references, projection ordering and incremental terminal-body
decoding. The Rust prototype uses the real `morphz::llm` data types and checks
Unicode, stream event preservation and controlled terminal normalization.

This experiment is a separate Cargo workspace, so it does not inherit the
repository root's dependency patches. Its manifest deliberately resolves the
same audited local Codex adapters as production. In particular, Morphz uses
only the serialized network-policy types, not Codex's proxy or DNS service;
the protocol-only adapter keeps those types while excluding the unused
Hickory 0.25.2 implementation affected by GHSA-q2qq-hmj6-3wpp and
GHSA-3v94-mw7p-v465. The dependency-boundary check prevents either patch drift
or a stale lockfile from restoring that dependency chain. This does not remove
annotation tests, tools, provider transports, or the experiment itself.

Intentional prototype differences: Rust accepts the existing full `u64`
`no_reply.wait_secs` range, requires valid Unicode scalar values, and limits
reply arguments in UTF-8 bytes. JavaScript uses safe integers and a UTF-16 unit
budget. These JavaScript conveniences are not a proposed production contract.

## Live gate

Running the following command sends up to 16 model requests using the existing
configured Provider route. It can consume account quota. It never receives or
logs credentials in JavaScript, and it never includes original user history.
The bridge checks configured route and credential-source constraints before
accepting requests, keeps native continuation in memory, and redacts error
details to fixed categories.

```sh
CARGO_TARGET_DIR=target cargo build --offline --manifest-path experiments/response-annotations/Cargo.toml --bin response-annotations-probe
node experiments/response-annotations/live-probe.mjs --model gpt-6.1-sol
```

`--init-only` on the native binary checks read-only route initialization without
a completion. It does not by itself prove authentication or model availability.

The live driver compares off/v1 serial two-read tasks and a synthetic retry
case. A final reply must arrive in the original final model response, its public
body must have multiple native increments before completion, and the reconstructed
body must exactly equal the final content. Raw Provider arguments are replayed
unchanged, while only stripped business arguments reach the synthetic tool.

The native bridge must use the same bound-stream-with-options entry as the
Orchestrator. RoutedClient's default measured-stream entry is an atomic
compatibility fallback, not evidence of native streaming. The initial live run
fell into that fallback; its apparent gate pass was explicitly invalidated and
preserved in `live-evidence-atomic-fallback.json`. Native continuation must be
retained and replayed exactly when the Provider supplies it; absence is legal
and must not fabricate state or add a request. The title covers the
entire execution; the first valid title remains stable rather than following
each current step.

Evidence distinguishes driver requests, native Client calls and observable
stream-start events. HTTP retries inside the Provider/proxy are not exposed by
this boundary and are reported as unknown, not counted as zero. A passing gate
on one route cannot establish support for all models, strict-schema channels or
production persistence/recovery.

The corrected `live-evidence.json` gate passed on the configured
`gpt-6.1-sol` OpenAI Responses route: serial off/v1 each used three requests,
and retry off/v1 each used four. The enabled final responses emitted 41 and 36
public body increments before completion. Six completed native serial samples
were reassessed from `live-evidence-native-serial.json` after removing an
incorrect requirement that optional opaque state must exist; eight new retry
requests completed the fourteen-request comparison. This route supplied no
opaque continuation state. Retention of supplied state is fixture-tested, not
claimed as an observed live signed-state result.

`live-evidence.json` records only the synthetic inputs, outputs, route metadata,
usage, timings and gate results. An unsuccessful run is evidence of a specific
failure, not permission to change production Runtime before revising the
Proposal and retesting.
