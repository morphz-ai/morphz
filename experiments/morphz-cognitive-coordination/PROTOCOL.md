# Morphz Cognitive Coordination Protocol v0.1 (Experimental)

Status: experimental, no compatibility promise.

## 1. Scope

The protocol coordinates one bounded cognitive Evaluation across independently operated Morphz
participants. It defines Coordination Mesh candidate resolution, capability handshake, projection binding, immutable
Evaluation Assignment, cancellation, partial-failure reporting, and result aggregation.

It does not define open-network discovery, economic incentives, Byzantine consensus, or automatic
Union Mind mutation.

## 2. Identities and trust

`authority_id` is the globally unique protocol identity. In Mesh mode, every node owns an Ed25519
key pair kept in Morphz Secret Store and derives its Authority from the public key. Agent, Context,
and Session identifiers are local to that Authority and may legitimately have the same values on
different Runtime nodes.

A Mesh source yields operator-authorized candidate endpoints, not authenticated identities. The
first valid self-signed handshake response from each declared endpoint pins its public key and
Authority locally. A sender endpoint is accepted for mutual pinning only when it also occurs in the
receiver's Mesh source and a reverse identity probe proves that the signed caller controls the same
public identity at that endpoint. Endpoint or public-key changes fail closed. The legacy explicit-peer mode
uses one HMAC-SHA256 secret per Authority pair when no Mesh source is configured.

An authenticated envelope binds:

- authentication version;
- sender Authority;
- sender public key in Mesh mode;
- issue time;
- unique nonce;
- complete typed payload.

Receivers reject untrusted Authorities outside handshake, invalid signatures, stale timestamps, and
replayed nonces. Signatures do not provide confidentiality. Plain HTTP also leaves trust-on-first-
contact exposed to an on-path attacker, so deployments must add TLS or a private authenticated
network.

## 3. Mesh resolution and health

One Mesh source may be a static URL list or a versioned file. The same source can be used unchanged
by every member; each node discovers its own reachable endpoint by matching a signed handshake to
its local public-key identity. No self Authority argument is required.

Candidate resolution and heartbeat are best effort. Remote unavailability never prevents the local
Runtime or ordinary Agent activity from starting. The background heartbeat records healthy,
unhealthy, joined, and recovered members. File sources are re-resolved on every heartbeat. Future
service-backed providers may implement the same internal discovery interface without adding a new
model or CLI concept.

## 4. Handshake advertisement

A successful handshake is a short-lived capability lease containing:

- protocol version and supported operations;
- participant Authority, Agent, Context, and anchor Session;
- semantic capabilities and token capacity;
- logical model routes and descriptive physical model labels;
- supported reasoning-effort vocabulary and output limits;
- the participant's effective default model route and reasoning effort;
- issue and expiry times.

Only operator-allowed model routes may be advertised. Credentials and provider account identities are
never advertised.

The unauthenticated identity-probe endpoint returns only a fresh self-signed public identity and
protocol version. Capability advertisements are returned only by the signed handshake after the
sender names an endpoint present in the receiver's Mesh source.

## 5. Evaluation lifecycle

1. The Agent that invokes `coordinate.evaluate` becomes coordinator for that request.
2. The coordinator performs live handshakes and routes only among eligible leased participants.
3. The coordinator requests a Context projection digest from every selected participant.
4. It creates an immutable Assignment containing the common task, token budget, projection binding,
   peer identities, and resolved logical model route/reasoning effort.
5. Every participant evaluates independently from its own Context in an isolated ephemeral Session.
6. Drafts are validated and converted to provenance-bound proposals.
7. Valid proposals form a Contribution Graph and a Semantic Settlement record.
8. Participant errors are returned separately. The operation succeeds only if valid proposals still
   meet `min_participants`.
9. The terminal response explicitly reports `committed=false`.

Ordinary dialogue never enters this lifecycle unless the enabled model deliberately invokes the
`coordinate` tool. Enabling the experiment or pairing nodes does not broadcast all conversation.

The coordinating Agent is not automatically scheduled as another independent participant: its
post-tool reasoning integrates the returned proposals. A deployment that explicitly needs a second,
independent local proposal may configure a loopback peer under the local Authority, but this is not
required for a three-node topology where one node coordinates two remote evaluators.

## 6. Model negotiation

The caller may omit a model requirement, request one common logical route and reasoning effort, or
provide Authority-specific overrides. The router rejects unsupported combinations before remote
Evaluation. If only reasoning effort is requested, the participant's default route is preferred when
compatible; otherwise another advertised compatible route is selected deterministically.

The resolved choice is copied into the Assignment. Nodes must not silently replace it because local
defaults change while the request is in flight.

## 7. Timeout and cancellation

Every remote call has an operator-defined timeout. When Evaluation transport fails or times out, the
coordinator sends a best-effort cancellation request. The participant maps an active Assignment to
its ephemeral Session and durably cancels that Session without affecting ordinary local Sessions.

Cancellation is idempotent: an unknown or already-finished Assignment returns `cancelled=false`.

## 8. Endpoints

- `GET /api/experimental/cognitive-coordination/identity`
- `POST /api/experimental/cognitive-coordination/handshake`
- `POST /api/experimental/cognitive-coordination/projection`
- `POST /api/experimental/cognitive-coordination/evaluate`
- `POST /api/experimental/cognitive-coordination/cancel`
- `GET /api/experimental/cognitive-coordination/status` (operator-authenticated Dashboard surface)

Identity probing returns a self-signed public envelope. The four stateful protocol endpoints use
authenticated envelopes. The status endpoint uses normal
Morphz operator authorization and never returns secrets.

## 9. Union commit boundary

Coordinated Evaluation and Union commit are separate operations. Evaluation may preserve disagreement
and produces no write authority. A later commit mechanism must name its Union Authority, base Context
version, settlement policy, certificate/quorum proof, and idempotent transaction identity explicitly.

No participant, peer response, or model output may implicitly write Active Mind or Union Mind.
