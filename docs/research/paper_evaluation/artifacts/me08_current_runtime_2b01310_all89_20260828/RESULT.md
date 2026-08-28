# ME-08 current-Runtime all-89 supplemental result

## Official result

- Protocol: `me08-terminal-bench-current-runtime-all89-morphz-v5`
- Infrastructure commit: `77432951b77c25e812af28de76ff849b5b4ff739`
- Runtime commit: `2b01310107f3d7819eedd5e07d2605ce46803ea8`
- Runtime binary SHA-256: `e4a500e4ba7f2fae3284728bcdd338f4504884349da975886a8b78fc56ade77d`
- Harbor watcher SHA-256: `70b33e20d661574543a478cd2bf9781355be8b2031c6e2124c8aa509d444c97d`
- Model: exact `gpt-5.6-sol`, reasoning `max`, `full_access`, fallback disabled
- Tasks: all 89 Terminal-Bench 2.1 tasks, one attempt each, zero retries
- Isolation: one independent database, Context, and Session per task
- Concurrency: 8
- Harness: `none`; 0 `runtime/evaluation_harness_binding` events across all 89 databases
- Official verifier result: **69/89 = 77.53%**
- Wilson 95% interval: **[67.82%, 84.96%]**
- Strict result: raw reward equals strict reward; **89/89** rows present and integrity-complete

The launcher finished normally with exit code 0 and
`complete_official_results=true`. One trial, `headless-terminal`, produced no
verifier result because both its Agent and verifier reached their respective
900-second deadlines. The strict result preserves that trial and assigns its
missing reward zero, yielding 69/89 rather than silently dropping it.

## Integrity and identity audit

The independent database audit found:

- 89 task databases, 89 trajectories, and 89 integrity receipts;
- 89 unique Context identities and 89 unique Session identities;
- exactly one Session and one Context in each database, with valid links;
- 89 unique task/trial identities and one attempt per task;
- 89/89 SQLite `quick_check` results equal to `ok`;
- 0 Harness-binding events and no Harness-like runtime event;
- 0 disqualified integrity receipts and no credential persistence finding.

The public run gate passed every required check: strict integrity, trial count,
all trial gates, isolation, credential scan completion, and absence of persisted
credentials. Its frozen run identity matches the launcher manifest and the
deployed Runtime binary.

## What the Runtime fixes did verify

The refresh supplies positive engineering evidence for the defects that
motivated it:

- `qemu-alpine-ssh` passed, and no trial emitted the old heredoc/shell-`&`
  false-positive error;
- `pypi-server` and `kv-store-grpc` both passed with their required services
  alive for verification;
- no trial logged `lease expired`, `database is locked`, or the old background
  operator rejection;
- `extract-elf` still failed, but the verifier found 0% reference coverage from
  the submitted extraction algorithm; it did not fail through the repaired
  heredoc parser or an Edge lease loss.

These are regression results, not a claim that every Runtime boundary is now
closed. The timeout audit found a distinct runner phase-boundary defect,
described below.

## Failure profile

The 20 official zero-reward trials divide into:

- 7 Harbor `AgentTimeoutError` labels;
- 4 explicit Provider `cyber_policy` safety refusals;
- 9 ordinary implementation or answer failures.

The seven timeout trials were `make-doom-for-mips`, `password-recovery`,
`query-optimize`, `train-fasttext`, `extract-moves-from-video`,
`feal-linear-cryptanalysis`, and `headless-terminal`. The first six lacked a
valid completed deliverable by their deadline. `train-fasttext` independently
scored only 0.528 against the required 0.62, so removing its timeout label would
not change its official zero.

### Newly confirmed timeout phase-boundary defect

Harbor's outer Agent deadline cancelled its `docker compose exec` wait but did
not always stop the in-container Morphz process. New tool jobs were recorded
after Harbor's Agent deadline in four trials:

- `query-optimize`: 9 post-deadline jobs;
- `train-fasttext`: 4 post-deadline jobs;
- `extract-moves-from-video`: 1 post-deadline job;
- `headless-terminal`: 4 post-deadline jobs.

The clearest case is `headless-terminal`. Harbor ended the Agent phase at
11:55:36Z; the still-running Runtime revised the file, passed two bounded
self-tests, and committed `chat/reply` plus `runtime/thread_terminal` at
11:57:49Z, while the verifier was already running. The verifier had loaded the
earlier hanging implementation, passed one of seven tests, then itself timed
out without a result.

This is not the previously repaired Edge lease bug: the Runtime remained alive
and kept making progress. It is a cancellation/phase-isolation bug between the
Harbor runner and the in-container Agent. The cancellation hook preserves the
Runtime for `keep_running` service ownership but does not first durably cancel
the active Thread/Activation. All seven timed-out trials remained official
zeros, so the audit found no positive score inflation. Nevertheless, the
defect means this current-Runtime refresh must remain supplemental engineering
evidence rather than replace the frozen paper result.

### Safety-refusal delta

The apparent increase from three frozen-run final refusal failures to four is
not a newly introduced task category. The frozen
`model-extraction-relu-logits` trajectory already encountered intermittent
`cyber_policy` responses but recovered and passed. In this refresh, the
byte-identical task and agent configuration were refused before the first tool
call and remained refused through the bounded recovery path. The physical
model route was the same. A possible server-side policy change cannot be
excluded, but the retained API responses expose no policy version, so the
evidence only supports refusal timing/persistence variability rather than a
confirmed interface update.

## Usage and host profile

- Provider input tokens: 49,756,789
- Provider cached-input subset: 8,739,328 (17.56% of input)
- Provider output tokens: 1,190,371
- Logical input plus output: 50,947,160
- Wall interval: 1 h 54 min 24 s
- Resource samples: 229
- Host: 16 logical CPUs, 61.52 GiB memory
- Mean / p95 / maximum used memory: 4.01 / 6.11 / 7.30 GiB
- Mean / p95 / maximum 1-minute load: 2.43 / 8.24 / 14.14
- Mean / maximum running Docker containers: 8.71 / 10

The frozen 72/89 Morphz run used 57,541,202 input and 1,246,760 output
tokens. This refresh therefore did **not** show isolated-Context token
amplification; it used 13.5% fewer input tokens. That difference is descriptive
only because task trajectories, model sampling, Runtime behavior, and timeout
mix changed.

## Relation to the frozen ME-08 result

Against the frozen Morphz-only 72/89 run:

- both passed: 63 tasks;
- both failed: 11 tasks;
- current-only pass: 6 tasks;
- reference-only pass: 9 tasks;
- score difference: −3.37 percentage points;
- two-sided exact McNemar `p=0.607239`.

The six current-only passes were `build-pov-ray`, `cancel-async-tasks`,
`chess-best-move`, `dna-assembly`, `mteb-leaderboard`, and
`video-processing`. The nine reference-only passes were `extract-elf`,
`feal-linear-cryptanalysis`, `headless-terminal`, `make-mips-interpreter`,
`model-extraction-relu-logits`, `password-recovery`, `pytorch-model-cli`,
`query-optimize`, and `sanitize-git-repo`.

This is not a pure Runtime causal estimate: the Runtime and Harbor lifecycle
changed substantially, model sampling is nondeterministic, and this refresh has
no contemporaneous Codex arm. It therefore does not supersede the paper's
frozen paired result, Morphz 72/89 versus Codex 74/89. No paper text is changed
by this supplemental run.

## Provenance

The immutable full run remains on the benchmark host at:

`/opt/morphz-benchmark/repeat-runs/me08-current-runtime-2b01310-r1-20260828`

This repository directory contains only non-secret, size-bounded identity,
official-score, integrity, resource, and diagnostic summaries. Complete
databases, trajectories, verifier logs, and background-job archives remain in
the immutable server run root.
