# ME-08 post-fix Morphz-only Terminal-Bench 2.1 result

## Result

- Protocol: `me08-terminal-bench-finalfix-all89-morphz-v3`
- Runtime commit: `4bbc3d63f4bda09947dc79dc5656edc71f8c02fa`
- Runtime binary SHA-256: `31f6cdd3de8ddf4a76e190eb4c0863ff9de7c9159c7acbf7ac2765b474ec0575`
- Model: `gpt-5.6-sol`, reasoning `max`, fallback disabled
- Tasks: all 89 Terminal-Bench 2.1 tasks, one attempt per task, zero retries
- Concurrency: 8
- Official verifier raw reward: **72/89 = 80.90%**
- Wilson 95% interval: **[71.52%, 87.72%]**
- Strict artifact audit: **passed**, 89/89 task rows present

The Harbor job reports three `AgentTimeoutError` trials: `make-doom-for-mips`,
`train-fasttext`, and `extract-moves-from-video`. They and all other official
failures remain zero. Harbor consequently returned code 3, while the enclosing
launcher successfully produced a complete 89-task official-reward summary and
the strict integrity Gate passed. No failed task was retried or replaced.

## Measurement profile

- Provider-reported input tokens: 57,541,202
- Provider-reported output tokens: 1,246,760
- Logical input plus output: **58,787,962**
- Cached-input subset: 9,389,568
- API cost: unavailable on the subscription/OAuth route
- Batch wall interval: approximately 1 h 35 min
- Host: 16 logical CPUs, 61.52 GiB memory
- Mean / p95 / maximum used memory: 4.75 / 6.17 / 7.52 GiB
- Mean / p95 / maximum 1-minute load: 2.26 / 6.33 / 11.42
- Maximum simultaneously observed Docker containers: 10

Cached tokens are a transport/billing decomposition, not an architecture
efficiency score. This Morphz-only refresh has no contemporaneous Codex arm, so
its Token and wall profile must not be converted into a new Agent-to-Agent
efficiency comparison.

## Relation to earlier ME-08 runs

This is the first complete all-89 result in the current artifact set using the
`4bbc3d6` Runtime identity that incorporates the independently audited delivery,
SQLite cancellation, safety-refusal, visual-input-accounting, and convergence
fixes. It supersedes neither of the following frozen observations:

- the historical same-environment pair, Morphz 70/89 versus Codex 73/89;
- the noncontemporaneous `ad60e` Morphz-only engineering refresh, 73/89.

Against the earlier 73/89 Morphz-only run, the current single attempt improved
four tasks and regressed five; 68 remained passes and 12 remained failures.
Against the historical 70/89 Morphz arm, it improved nine tasks and regressed
seven. These changes show why a one-attempt refresh should be treated as a
current engineering measurement rather than a monotonic estimate of a small
Runtime patch's causal effect.

The current score is therefore reported as **72/89 current post-fix Morphz
performance**. The only strict Morphz-versus-Codex inference remains the frozen
paired run and its paired uncertainty analysis.

## Provenance

The full immutable cloud run remains at:

`/opt/morphz-benchmark/repeat-runs/me08-4bbc3d6-r1-20260827`

This directory contains the complete per-task trajectories and environments.
The repository artifact retains the launcher identity, official per-task
rewards, strict Gate, resource series, and toolchain lock without credentials.
