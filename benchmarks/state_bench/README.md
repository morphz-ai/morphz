# Morphz × STATE-Bench Agent Learning

> **Current plan:** ME-07 v2 compares the public Agent systems Morphz, Letta,
> and a Mem0-backed frozen reference agent. See
> `protocol_lock_v2_candidate.json` and
> `docs/research/paper_evaluation/me_07_state_bench_protocol_v2.md`.
>
> The A-MEM integration below belongs to superseded v1. It remains in the
> repository only for historical reproducibility and MUST NOT be used as a v2
> arm or described as a completed Letta Gate.

The existing v1 integration layer had three **strong-memory** arms:

1. production Morphz Structured Context / Mind Frames;
2. the A-MEM-compatible implementation pinned from MemGym;
3. Mem0 OSS.

V2 retains the deliberate exclusion of a no-memory arm. Such a control only establishes that
past experience is useful and does not distinguish Morphz from ordinary memory
systems. Public STATE-Bench no-memory rows may be cited as background, but no
project budget is spent reproducing them.

The official STATE-Bench checkout remains unmodified. The files under
`overlay/` are discovered through STATE-Bench's public `BaseAgent` and
`BaseLLMClient` extension points. `protocol_lock.json` is the machine-readable
source of truth for upstream revisions, model bindings, data boundaries and
formal run settings.

Before any model call, run:

```bash
PYTHONPATH=<state-bench-root>:benchmarks/state_bench/overlay \
python3 benchmarks/state_bench/no_model_gate.py \
  --state-bench-root <state-bench-root> \
  --output <artifact-dir>/no_model_gate.json
```

The Gate fails closed when the official upstream commit, train split, class
discovery, fixed `top_k=3`, read-only retrieval contract, or secret scan does
not match the frozen protocol.

## Frozen learning artifacts

`build_learning_artifact.py` builds exactly one arm/domain artifact from all
100 official training trajectories. It stages the build under a hidden
`.domain.building` directory, preserves failures, hashes every payload, rejects
held-out input, and only atomically publishes the domain directory after the
manifest verifies.

The builders use each method's real learning path:

- Morphz: production `context_tx`, Context audit, WAL checkpoint and Recall
  index rebuild;
- A-MEM: MemGym's serializable A-MEM-compatible implementation with metadata
  generation and memory evolution;
- Mem0: OSS procedural-memory extraction and an on-disk Qdrant namespace.

`artifact_reload_no_model_gate.py`, `morphz_artifact_real_smoke.py`, and
`strong_memory_artifact_real_smoke.py` separately verify persistence/reload
and one-trajectory native learning. A one-trajectory smoke is a build Gate,
never an effectiveness score.

When the Python OpenAI SDK reaches CLIProxyAPI through an mDNS `.local` name,
freeze the resolved LAN IPv4 as `MORPHZ_STATE_BENCH_AGENT_BASE_URL`; on the
2026-08-26 test host, Python selected a public IPv6 route while curl and Morphz
selected the local route. The failed request is preserved in the Gate artifact
and was not silently retried or scored.
