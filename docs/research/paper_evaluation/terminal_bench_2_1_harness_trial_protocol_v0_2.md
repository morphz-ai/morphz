# Terminal-Bench 2.1 Harness Trial Protocol v0.2

> Status: candidate; no model run permitted until all no-model gates pass
>
> Date: 2026-08-24
>
> Purpose: test whether three general evidence gates correct failures observed under `terminal-task@0.1.0`

## 1. Change under test

`terminal-task@0.2.0` preserves the task-contract, evidence-led execution and domain-neutral design
of v0.1. It adds three general requirements rather than task-specific instructions:

1. an explicit acceptance ledger whose critical conditions must end as verified, failed or
   unverified;
2. independent evidence for consequential assumptions, with executable behavior requiring
   executable or equivalent caller-side evidence;
3. candidate-universe completeness before a global ranking or exhaustive research claim.

The package contains no Terminal-Bench task names, answers, verifier information or known failure
details. Benchmark integrity remains a separate immutable instruction overlay.

## 2. First diagnostic task

Only `torch-pipeline-parallelism` is permitted in the first v0.2 model run:

- attempts: 1;
- concurrency: 1;
- expected trials: 1;
- model: the frozen `gpt-5.6-sol` route;
- reasoning effort: `max`;
- permission mode: `full_access`;
- Runtime and dataset: unchanged from the frozen cloud baseline.

The task is selected because it had the lowest input-token cost among the three remaining failures
and its v0.1 trajectory declared completion without executing the required forward/backward
behavior. The test is whether v0.2 changes that evidence boundary and implementation path, not
whether a task-specific hint can recover the answer.

Do not run `dna-assembly`, `mteb-leaderboard`, the other two recovered tasks, an 89-task pass or a
full 445-trial pass under this decision gate.

## 3. Required no-model gate

Before the one-task run:

- parse the `.hns` package and verify model ownership;
- freeze source SHA-256 and normalized artifact hash;
- update the adapter, lock, ATIF identity and public gate to the exact `terminal-task@0.2.0` package;
- verify in-container install and authoritative Evaluation Binding;
- verify the `harness-torch` cloud mode expands to exactly one task, one attempt, concurrency one
  and one expected trial;
- run targeted Rust and Python tests, shell syntax validation and cloud preflight;
- bind the run to a committed clean tracked baseline without including unrelated user files.

## 4. Evidence and decision

After the run, compare reward and trajectory with v0.1:

- whether critical acceptance conditions became explicit;
- whether lack of a Python runtime remained an accepted excuse, or the Agent obtained meaningful
  executable/caller-side evidence;
- whether the implementation was smaller or more testable;
- whether the Agent refused to overstate completion when runtime behavior remained unverified;
- input/output tokens, model calls, duration, provider errors, integrity and credential gates.

If the task passes with a materially better evidence path, keep v0.2 frozen and decide whether to
run `dna-assembly` next. If it fails but the trajectory exposes a new general deficiency, close the
round before editing the Harness. Do not silently mutate v0.2 and splice results together.
