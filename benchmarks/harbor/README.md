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
- exact model-owned Harness `terminal-task@0.4.0`, installed from the checked-in
  `.hns` package and bound to the first real Evaluation of every trial;
- Rust `1.97.1` on the pinned Bullseye builder image, with OpenSSL linked
  statically so the binary also runs on the dataset's oldest glibc base;
- the frozen overseas artifact uses the official Rustup distribution endpoint
  and the checked-in RSProxy Cargo sparse-index configuration. Rustup and Cargo
  still verify the pinned toolchain and Cargo.lock checksums; only transfer
  paths differ;
- Linux/AMD64 task containers and Runtime, using Docker Desktop emulation on
  Apple Silicon rather than changing the benchmark architecture to ARM64;
- the watcher is linked against the pinned Bullseye static SQLite archive;
  the superseded dynamically linked watcher is retained by hash for audit but
  is forbidden because minimal task images may not provide `libsqlite3.so.0`;
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

Internet access does not permit access to benchmark answers. The adapter
appends a frozen integrity notice to every task instruction: ordinary public
technical documentation is allowed, while exact task-name searches, benchmark
task repositories, solutions, private tests, hidden references, verifier and
reward files are prohibited. After execution, `benchmark_integrity.py` audits
agent-authored tool calls and writes two immutable views:

- Harbor's original `result.json` remains the raw verifier result;
- each trial receives `benchmark_integrity.json`, and the job receives
  `strict_result.json` with disqualified rewards set to zero.

A positive raw reward without an auditable trajectory fails the integrity Gate.
Any high-confidence integrity violation also makes the launcher exit non-zero;
the raw artifacts are retained for investigation and are never rewritten.

Before a Pilot or public job is accepted, run `benchmark_gate.py` with the exact
expected trial count and the provider credential present only in the process
environment. It additionally verifies official ATIF validity, exact model and
reasoning binding, full-access metadata, unique Context/Session/SQLite identity,
background observation causality, Provider error counts, and absence of
persisted credentials. Provider errors are reported but do not by themselves
disqualify an otherwise complete trial. The launcher writes
`public_run_gate.json` without writing the credential.

## Build the pinned Linux Runtime

Docker Desktop must be running. BuildKit exports the binary outside an image:

```bash
docker build \
  --platform linux/amd64 \
  --file benchmarks/harbor/runtime.Dockerfile \
  --build-arg MORPHZ_BUILD_GIT_COMMIT=5e4b0ffcd89245f19d84ec3569605ae27a44e02b \
  --build-arg RUSTUP_DIST_SERVER=https://static.rust-lang.org \
  --build-arg RUSTUP_UPDATE_ROOT=https://static.rust-lang.org/rustup \
  --target export \
  --output type=local,dest=.codex-work/harbor-runtime \
  .
```

The commit argument is mandatory because `.git` is intentionally excluded from
the Docker build context. Omitting it would make the Runtime report `git
unknown`; allowing a warm Cargo target cache to supply stale build-script output
would make the artifact identity non-reproducible.

The superseded pre-migration artifact hash is retained in the lock file for
audit only. It was generated before the mandatory commit argument existed and
must not be used for new runs. The replacement artifact reports the full v4
commit at runtime and was exported twice with identical bytes.

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
python3 benchmarks/harbor/run_benchmark.py smoke --expect-trials 1
python3 benchmarks/harbor/run_benchmark.py full --attempts 1 --expect-trials 89
```

On the isolated Linux benchmark node, install the checked-in systemd template
so a long run survives an SSH disconnect:

```bash
install -m 0755 benchmarks/harbor/run_cloud_job.sh \
  /opt/morphz-benchmark/source/benchmarks/harbor/run_cloud_job.sh
install -m 0644 benchmarks/harbor/morphz-benchmark@.service \
  /etc/systemd/system/morphz-benchmark@.service
systemctl daemon-reload
systemctl start morphz-benchmark@preflight.service
journalctl -fu morphz-benchmark@preflight.service
```

The wrapper accepts only the four frozen launcher modes, reads the root-only
provider environment through systemd, and holds a node-wide file lock. It does
not print the provider credential and refuses to start a second benchmark job
while one is active. Starting `smoke` or `full` still requires the explicit
experiment decision described above; installing the template does not run a
model.

The dedicated `failed-five` instance is a guarded development-only regression
run. It expands to exactly the five previously observed failures, one attempt
each, at concurrency five; it cannot resolve to the full dataset:

```bash
systemctl start morphz-benchmark@failed-five.service
journalctl -fu morphz-benchmark@failed-five.service
```

The full command now defaults to all 89 tasks and exactly one attempt per task
(89 diagnostic trials), with zero Harbor retries and one trial at a time. This
is the mandatory trajectory-analysis pass before optimization. A later official
89×5 run is deliberately blocked unless the command contains both
`--attempts 5` and `--confirm-89x5-formal`; filtered tasks, limits, smoke runs,
and other attempt counts cannot use that acknowledgement. It explicitly records
`reasoning_effort=max` in Harbor's agent kwargs because leaderboard CI groups
and validates that field. Inline upload is deliberately rejected: first finish
the run, inspect `strict_result.json` and the trajectories, then perform any
Harbor Hub upload as a separate, explicit post-audit action. This prevents an
unreviewed raw verifier result from being published accidentally.

Every model-running `smoke` or `full` invocation must also supply
`--expect-trials N`. The launcher resolves the frozen dataset, filters, limit,
and attempts, then refuses to call Harbor unless the result is exactly `N`.
For example, the fixed-order first-20 diagnostic pass is:

```bash
python3 benchmarks/harbor/run_benchmark.py full \
  --limit 20 --attempts 1 --concurrency 5 --expect-trials 20
```

## ATIF support

`MorphzAgent.SUPPORTS_ATIF = True` is backed by
[`morphz_atif.py`](morphz_atif.py), not merely a capability flag. The projector
maps structured user, assistant, tool-result, model-usage, reasoning and Context
transaction Events into ATIF-v1.7, records the physical model and Runtime
identity, and preserves Morphz event IDs for audit. Tests validate the emitted
file with both Harbor's Pydantic model and official `TrajectoryValidator`.

The projection also records every authoritative
`runtime/evaluation_harness_binding` Event. The public Gate requires at least
one binding, exactly one package identity per trial, and an exact match with the
Harness ID, version and normalized artifact hash in the frozen run identity.
The adapter separately checks the raw `.hns` source digest before uploading it,
so source drift fails before any model call.

`terminal-task@0.2.0` is a closed development candidate, not part of any
reportable Terminal-Bench result. Its only precommitted diagnostic was one
attempt of `torch-pipeline-parallelism`, as defined by
[`terminal_bench_2_1_harness_trial_protocol_v0_2.md`](../../docs/research/paper_evaluation/terminal_bench_2_1_harness_trial_protocol_v0_2.md).
It improved evidence acquisition but timed out with reward zero; no larger v0.2
run is permitted.

`terminal-task@0.3.0` adds a domain-neutral convergence contract. It keeps the
evidence ledger but permits honest `completed-with-limitations`, `blocked`, and
`needs-decision` terminal states when further work has no decision-relevant
expected value. Its first and only precommitted diagnostic is one attempt of
`torch-pipeline-parallelism`, as defined by
[`terminal_bench_2_1_harness_trial_protocol_v0_3.md`](../../docs/research/paper_evaluation/terminal_bench_2_1_harness_trial_protocol_v0_3.md).
That run obtained stronger executable evidence but still ended in
`AgentTimeoutError` with reward zero after the final successful test produced no
Agent reply. v0.3 is closed; no larger v0.3 run is permitted. The recorded
result is in
[`terminal_bench_2_1_harness_v0_3_torch_result_2026_08_24.md`](../../docs/research/paper_evaluation/terminal_bench_2_1_harness_v0_3_torch_result_2026_08_24.md).

After reviewing that closed diagnostic, the user made a separate, explicit
product-validation decision to keep v0.3 unchanged and run registry tasks 21–40
once each. That later authorization is recorded independently rather than
retroactively changing the original diagnostic. The batch completed 20/20 with
11/20 raw and strict passes and five `AgentTimeoutError` cases. It also exposed
a Provider `cyber_policy` rejection that the Runtime misclassified as temporary
unavailability and that the then-current public Gate failed to count. No further
v0.3 expansion is permitted. Protocol and result:

- [`terminal_bench_2_1_harness_v0_3_unseen_20_protocol_2026_08_24.md`](../../docs/research/paper_evaluation/terminal_bench_2_1_harness_v0_3_unseen_20_protocol_2026_08_24.md)
- [`terminal_bench_2_1_harness_v0_3_unseen_20_result_2026_08_24.md`](../../docs/research/paper_evaluation/terminal_bench_2_1_harness_v0_3_unseen_20_result_2026_08_24.md)

`terminal-task@0.4.0` is a post-hoc convergence candidate. It adds only a
domain-neutral best-valid-checkpoint and proof-to-final closure protocol after
v0.3 showed that GPT-5.6 Sol could continue optional exploration after a viable
artifact or sufficient evidence existed. Its only permitted first regression
is one attempt of `raman-fitting`; it is not an unseen or reportable benchmark
sample. The frozen protocol is
[`terminal_bench_2_1_harness_trial_protocol_v0_4.md`](../../docs/research/paper_evaluation/terminal_bench_2_1_harness_trial_protocol_v0_4.md).
