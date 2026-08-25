# Morphz Cognitive Coordination Experiment

This crate is an explicitly experimental implementation of coordinated cognitive evaluation above
the stable Morphz SDK. It validates one local, multi-Agent embodiment of the following boundary:

```text
CognitiveEvaluationRequest
  -> sparse participant selection
  -> independent bounded Evaluations
  -> ContributionGraph
  -> Semantic Settlement
  -> quorum-certified Union Context commit
```

The crate is not part of the default workspace build, does not define a stable application API, and
does not claim open-network discovery, Byzantine fault tolerance, or permissionless consensus.
The feature-gated Morphz integration adds a Coordination Mesh and authenticated HTTP transport
outside the stable Runtime. Protocol and algorithms remain independent from Morphz itself. The SDK
and network adapters live under `morphz::experimental`, allowing the existing `morphz` binary to
link the experiment without a package dependency cycle.

Experimental concepts must not become Runtime invariants. When the experiment needs a missing
Runtime capability, only a generally useful SDK operation may be added to `morphz`.

Run the deterministic local acceptance suite with:

```shell
cargo test -p morphz-cognitive-coordination
```

The suite uses three independent test participants and no external model service. The feature test
suite additionally starts three temporary HTTP nodes and verifies pairwise authentication,
handshake capability discovery, model negotiation, independent Evaluation, and result aggregation.

Build and inspect the same Morphz binary—no second executable is introduced:

```shell
cargo build -p morphz --features experimental-cognitive-coordination
./target/debug/morphz experiment list
./target/debug/morphz experiment check cognitive-coordination \
  --enable-experimental cognitive-coordination
```

## Coordination Mesh startup

For a three-node deployment, copy the same command-line source to every node. Each member URL is an
address every member, including that node itself, can reach; `0.0.0.0` remains a listen address and
must not appear in the Mesh. This self-reachability lets a node identify its own advertised endpoint
without a separate self parameter.

```shell
./target/debug/morphz serve --bind=0.0.0.0:8080 \
  --coordination-mesh=static:http://10.0.0.11:8080,http://10.0.0.12:8080,http://10.0.0.13:8080
```

`--coordination-mesh` automatically enables the runtime experiment. It does not require an
Authority argument or a shared cluster token. Every installation creates an Ed25519 node identity,
stores its private key through Morphz Secret Store, and derives its Authority from the public key.
The operator-declared Mesh is the candidate trust boundary; the first valid signed response from a
declared endpoint is pinned locally. Use HTTPS or a private authenticated network because plain HTTP
does not protect the first contact from an on-path attacker.

Startup never waits for all members. An offline or not-yet-started node appears unhealthy only in
Coordination status; the local Agent and ordinary dialogue remain available. A background heartbeat
detects later joins, loss, and recovery without restarting the other nodes.

The same source can be stored in a file:

```toml
version = 1
members = [
  "http://10.0.0.11:8080",
  "http://10.0.0.12:8080",
  "http://10.0.0.13:8080",
]
```

```shell
./target/debug/morphz serve --bind=0.0.0.0:8080 \
  --coordination-mesh=file:/etc/morphz/mesh.toml
```

The file is resolved again on every heartbeat, so adding or removing candidates does not require a
Runtime restart. Static, file, and future service-backed sources all implement one internal
`CoordinationDiscoveryProvider`; `Discovery` is deliberately not a second CLI concept.

For a durable operator opt-in, use the normal Morphz configuration:

```toml
[experimental]
enabled = ["cognitive-coordination"]

[experimental.cognitive_coordination]
mesh = "file:/etc/morphz/mesh.toml"
request_timeout_secs = 180
handshake_timeout_secs = 10
handshake_ttl_secs = 60
heartbeat_interval_secs = 10
max_clock_skew_secs = 60

[experimental.cognitive_coordination.participant]
agent_id = "default-agent"
context_id = "context-default"
session_id = "session-default"
capabilities = ["general-reasoning", "code-review"]
max_token_budget = 32768
priority = 10
allowed_model_routes = ["deep-analysis"]
```

The previous explicit `participant.authority_id` plus `[[peers]]` pairwise-HMAC topology remains a
compatibility mode when `mesh` is absent. New deployments should use the Mesh identity flow above.
Private keys and legacy secret values never enter TOML, Events, logs, handshake advertisements, or
model Context.

Compilation, configuration, and use are separate boundaries. The SDK adapter requires the scoped
permit returned by `morphz::experimental::require_enabled`, so compiled experimental code cannot be
entered accidentally.

After the process gate is available, an operator may bind Cognitive Coordination to an individual
Cognitive Context from the Dashboard. A bound Context receives both:

- one compact `cognitive-capabilities` contract in Context Encoding; and
- one model-facing `coordinate` tool whose first operation is `evaluate`.

Unbound Contexts receive neither. The tool rechecks the durable Context binding at execution time,
so the model cannot bypass the control-plane decision. Ordinary dialogue remains local unless the
model explicitly invokes `coordinate` for a task which benefits from independent participant
cognition.

The `coordinate` name is intentionally broader than the first `evaluate` operation. Future
experimental operations can share the same admission and capability boundary without proliferating
top-level model tools.

`coordinate.evaluate` is a terminal operation of its own: it returns the immutable plan,
Contribution Graph, Semantic Settlement, partial failures, and live peer status, while
`committed=false`. It never mutates Union Mind. A future explicit Union commit operation may consume
that result under its own Authority and quorum policy.

The initiating Agent is the coordinator for the request it emits. It sends the same semantic task
to selected peers, while every peer evaluates from its own projected Context in an isolated,
ephemeral Session. Handshake advertisements expose capabilities, logical model routes, physical
model labels, supported reasoning efforts, limits, and a short lease. The coordinator may request a
common logical model route or an Authority-specific override. That choice is validated against the
advertisement and frozen into each Assignment.

Timeouts trigger best-effort cancellation. A failed participant remains visible in `failures`; the
Evaluation succeeds only when the number of valid proposals still satisfies `min_participants`.
The Dashboard status panel reads heartbeat-backed authenticated health and shows latency and
effective default model routes. Opening the panel does not determine whether the Agent can start.

Coordination Mesh is a testable foundation for later service discovery; it is not yet an open Agent
network. Ed25519 signatures authenticate identities and protect message integrity, but do not
encrypt payloads. Use HTTPS or a private authenticated network outside a trusted host.

See [PROTOCOL.md](PROTOCOL.md) for the experimental wire and lifecycle contract.
