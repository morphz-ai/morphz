# Morphz Harbor integration

This directory contains the first reproducible Harbor task and a custom Morphz
agent adapter. It deliberately keeps two evaluations separate:

- Harbor grades the product outcome in an isolated container.
- Morphz's native concurrent-objective runner records Objective, Evaluation,
  Activation, Model Attempt, tool and restart causality.

## Requirements

Build a Linux binary for the target Harbor environment and expose it to the
adapter:

```bash
export MORPHZ_HARBOR_BINARY=/absolute/path/to/linux/morphz
export MORPHZ_PROVIDER_PROTOCOL=openai-responses
export MORPHZ_PROVIDER_BASE_URL=https://provider.example/v1
export MORPHZ_PROVIDER_MODEL=qwen3.8-max-preview
export MORPHZ_PROVIDER_API_KEY=...
```

Run the task from a Harbor checkout or installation, adding this repository to
`PYTHONPATH`:

```bash
PYTHONPATH="$PWD" harbor trials start \
  -p benchmarks/harbor/forgedepot-concurrent \
  --agent benchmarks.harbor.morphz_agent:MorphzAgent \
  -m custom/qwen3.8-max-preview \
  --ae MORPHZ_PROVIDER_API_KEY="$MORPHZ_PROVIDER_API_KEY" \
  --ae MORPHZ_PROVIDER_PROTOCOL="$MORPHZ_PROVIDER_PROTOCOL" \
  --ae MORPHZ_PROVIDER_BASE_URL="$MORPHZ_PROVIDER_BASE_URL" \
  --ae MORPHZ_PROVIDER_MODEL="$MORPHZ_PROVIDER_MODEL"
```

The adapter uploads only the compiled Morphz binary and a non-secret Provider
configuration. It never embeds the credential in an image, task, trajectory or
configuration file.
