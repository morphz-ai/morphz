# Morphz on Harbor / Terminal-Bench 2.1

This integration runs the real Morphz Runtime inside each isolated Harbor task
container. Harbor grades the product outcome; Morphz's SQLite event store is the
authoritative execution record and is projected after the run into Harbor's
ATIF-v1.7 `agent/trajectory.json`.

## Frozen toolchain

Exact versions, commits, dataset archive checksum, Runtime commit and model
binding live in [`toolchain.lock.json`](toolchain.lock.json):

- Harbor `0.21.0` (`v0.21.0`);
- Terminal-Bench `2.1`, 89 tasks, pinned to the official repository commit;
- reportable runs use the exact Harbor registry dataset digest required by the
  leaderboard CI, rather than the local Git checkout used during development;
- Morphz `paper-eval-runtime-v4`;
- Rust `1.97.1` on the pinned Bullseye builder image, with OpenSSL linked
  statically so the binary also runs on the dataset's oldest glibc base;
- China-region builds use RSProxy for Rustup components and Cargo's sparse
  index. Rustup and Cargo still verify the pinned toolchain and Cargo.lock
  checksums; only the transfer path changes;
- Linux/AMD64 task containers and Runtime, using Docker Desktop emulation on
  Apple Silicon rather than changing the benchmark architecture to ARM64;
- physical model `gpt-5.6-sol`, reasoning effort `max`, no fallback;
- CLIProxyAPI `7.2.140` on the same isolated cloud node, bound only to the
  Docker host bridge.

The launcher resolves and pins the provider's IPv4 address for each job. Both
the logical provider host and the effective IPv4 address are recorded by
preflight.

On an isolated cloud experiment node, CLIProxyAPI may instead run on that same
node. Export `MORPHZ_PROVIDER_BASE_URL`, `MORPHZ_PROVIDER_PROTOCOL` and
`MORPHZ_PROVIDER_API_KEY` before invoking the launcher; no host Morphz config is
then required. The base URL must use an address reachable from Harbor task
containers (normally the node's private IPv4 address), not `127.0.0.1`, because
loopback inside a task container refers to that container. Keep port 8317 closed
in the public security group and authenticate the proxy with a non-example API
key.

The current Terminal-Bench 2.1 repository states that community leaderboard
submissions are closed. These runs are still reproducible benchmark results and
can be uploaded to Harbor Hub, but they must not be described as an accepted
official leaderboard submission unless the maintainers run or accept them.

## Isolation and permissions

`full_access` is a Morphz experiment control, not a Terminal-Bench requirement.
It removes approval/reviewer behavior as a confounder. The scope remains the
disposable Harbor task container:

- one fresh container, Morphz Context, Session and SQLite database per trial;
- shell environment policy `remove_sensitive`;
- Morphz `full_access` makes its internal network permission effective;
- all 89 frozen official TB2.1 tasks specify `allow_internet=true`, so Harbor
  retains their public-network policy instead of modifying benchmark inputs;
- the host credential is resolved at launch and passed only in process
  environment, never written to a profile, command line or job manifest.

## Build the pinned Linux Runtime

Docker Desktop must be running. BuildKit exports the binary outside an image:

```bash
docker build \
  --platform linux/amd64 \
  --file benchmarks/harbor/runtime.Dockerfile \
  --target export \
  --output type=local,dest=.codex-work/harbor-runtime \
  .
```

The Dockerfile defaults `RUSTUP_DIST_SERVER` and `RUSTUP_UPDATE_ROOT` to
RSProxy and installs the checked-in sparse-index Cargo configuration. Override
the two build arguments only when the build node has a better path to the
official Rust distribution servers.

Confirm its checksum matches `toolchain.lock.json`:

```bash
shasum -a 256 .codex-work/harbor-runtime/morphz
```

## Gates and runs

The launcher reuses the existing host Morphz `custom` provider and credential
binding. The benchmark-only profile in
`morphz-evals/profiles/benchmark-gpt-5-6-sol.toml` documents the frozen overlay;
secrets are not copied into it. When the credential environment variable is not
exported, the launcher reads the configured CLIProxyAPI key over the existing
SSH connection to `mini-m4.local`; the value remains in process memory only.
For a cloud-local proxy, export the endpoint and credential explicitly instead;
the launcher passes the credential only through the Harbor process environment.

Run the non-inference gates first:

```bash
python3 benchmarks/harbor/run_benchmark.py preflight
python3 benchmarks/harbor/run_benchmark.py install-only
```

`preflight` checks Docker, Harbor, the Linux binary, provider protocol and the
exact advertised physical model. `install-only` builds one task environment and
installs Morphz but skips both agent execution and verification.

By default, `install-only`, `smoke` and `full` use the frozen official Harbor
registry dataset. `--dataset-path` is an explicit development-only escape hatch;
jobs produced from it are not leaderboard-submittable.

Then run one real-model trial and inspect its `result.json`, SQLite event store,
logs and ATIF trajectory before starting the full batch:

```bash
python3 benchmarks/harbor/run_benchmark.py smoke
python3 benchmarks/harbor/run_benchmark.py full
```

The full command defaults to all 89 tasks, exactly five attempts per task (445
trials), zero Harbor retries and one trial at a time. It explicitly records
`reasoning_effort=max` in Harbor's agent kwargs because leaderboard CI groups
and validates that field. Upload is deliberately opt-in (`--upload`, optionally
`--public`).

## ATIF support

`MorphzAgent.SUPPORTS_ATIF = True` is backed by
[`morphz_atif.py`](morphz_atif.py), not merely a capability flag. The projector
maps structured user, assistant, tool-result, model-usage, reasoning and Context
transaction Events into ATIF-v1.7, records the physical model and Runtime
identity, and preserves Morphz event IDs for audit. Tests validate the emitted
file with both Harbor's Pydantic model and official `TrajectoryValidator`.
