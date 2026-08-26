# Morphz × STATE-Bench Agent Learning

This directory contains the frozen ME-07 integration layer. The formal
comparison has three **strong-memory** arms:

1. production Morphz Structured Context / Mind Frames;
2. the A-MEM-compatible implementation pinned from MemGym;
3. Mem0 OSS.

There is deliberately no no-memory arm. Such a control only establishes that
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
