# Terminal-Bench 2.1 Harness Trial Protocol v0.1

> Status: superseded after the five-task development run; see the v0.2 protocol and the 2026-08-24 result report
>
> Date: 2026-08-24
>
> Purpose: determine whether a reusable Morphz Harness improves heterogeneous terminal-task execution without task-specific prompting

## 1. Claim under test

The candidate claim is not that the underlying model has learned new facts. It is that an exact,
versioned Morphz Harness can supply a reusable cognitive procedure that changes the execution
behavior of the same model and Runtime across heterogeneous terminal tasks.

The candidate Harness is
[`terminal-task.hns`](../../../morphz-evals/harnesses/terminal-task.hns), identified as
`terminal-task@0.1.0`. It is model-owned: the model retains step-selection freedom while the
Runtime continues to authorize and record every physical effect.

## 2. What is frozen inside the Harness

The Contract requires a task contract, explicit fact/hypothesis/uncertainty separation, a minimum
complete outcome before optional work, evidence-driven recovery, independent validation,
time-budget convergence, domain guards for research/services/recovery/software, and a final
readiness gate.

The package contains no Terminal-Bench task names, task-specific answers, hidden verifier
information, known failure paths, or benchmark repository material. The benchmark integrity
policy remains a separate immutable instruction overlay.

## 3. Development set

The first diagnostic run reuses the five failures already observed in the fixed first-20 pass:

1. `dna-assembly`;
2. `mteb-leaderboard`;
3. `pypi-server`;
4. `pytorch-model-recovery`;
5. `torch-pipeline-parallelism`.

These tasks are a development and regression set. Because their prior outcomes and trajectories
were inspected while designing the Harness and adapter fixes, their post-change rewards cannot be
presented as an unbiased benchmark estimate.

Run shape: one attempt per task, one exact Harness package for all five tasks, the same physical
model and reasoning setting as the stored baseline, and no per-task prompt or Harness variation.
The stored baseline trajectories are the initial comparison to avoid an unnecessary second model
arm. This is diagnostic rather than statistically conclusive.

## 4. Unseen validation set

Before inspecting any further task trajectories, precommit five official tasks not used to design
the Harness. Run each task exactly once with the frozen candidate. Do not modify the package,
adapter, Runtime, model route, task instruction policy, or scoring after observing the first unseen
result.

If the unseen set exposes a defect that requires modification, close that validation round,
version the package again, and select a new unseen set. Do not splice results across versions.

## 5. Required no-model Gate

No model run is permitted until all of the following pass:

- `.hns` structural parsing and model-owned entry validation;
- source SHA-256 match before task-container upload;
- in-container package installation before Runtime evaluation;
- explicit `--harness=terminal-task@0.1.0` selection for the first real Evaluation;
- authoritative Evaluation Binding Event projection into ATIF;
- exact ID, version, normalized artifact hash and single-package-identity checks in the public Gate;
- unchanged full-access, model, integrity, isolation and credential checks;
- targeted Python tests, Rust package test and shell syntax validation.

## 6. Evidence to inspect

For every development trial, inspect reward and trajectory together:

- whether the task contract and acceptance boundary became explicit;
- whether exploration converged on a minimum complete outcome;
- whether claims were separated from observations;
- whether validation occurred after the last relevant change and from a consumer perspective;
- whether a required service remained reachable after Agent return;
- whether the final answer was supported by actual state;
- model calls, input/output tokens, wall-clock duration and failure classification;
- exact Harness Binding identity recorded by Runtime.

Do not score mere mentions of Contract terms. Only observable behavior and task outcomes count.

## 7. Decision rule

Proceed to a larger frozen diagnostic batch only if:

1. the adapter lifecycle regression is closed;
2. the cognitive failures show meaningful trajectory improvement or task success without a new
   recurring failure mode;
3. the unseen validation set shows no material correctness regression;
4. the cost and duration increase, if any, are acceptable relative to outcome improvement; and
5. one clean commit/tag can bind Runtime, adapter, Harness, dataset, model, and scorer identity.

Five development tasks and five unseen tasks are a product decision Gate, not a paper-grade or
leaderboard-grade statistical claim. A later reportable run must use one frozen Agent/Harness
identity uniformly across the declared dataset and must not combine prior baseline trials with new
Harness trials as if they were one submission.
