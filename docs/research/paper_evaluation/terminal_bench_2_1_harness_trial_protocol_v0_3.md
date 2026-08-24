# Terminal-Bench 2.1 Harness Trial Protocol v0.3

> Status: closed after the single precommitted model run; reward 0.0 / `AgentTimeoutError`; no further v0.3 run permitted
>
> Date: 2026-08-24
>
> Purpose: test a domain-neutral convergence contract after `terminal-task@0.2.0` improved evidence discipline but exhausted the Agent deadline without returning

## 1. Hypothesis

`terminal-task@0.3.0` tests whether a general semantic exit contract can preserve honest evidence
reporting while avoiding open-ended investigation. It does not add a deadline, task-specific tool
sequence, dependency name, framework version, expected implementation, verifier detail, or answer.

The single change under test is that an Agent may converge to one of four honest terminal states:

1. `completed` when the requested outcome and proportionate verification are satisfied;
2. `completed-with-limitations` when the outcome is delivered but a material check is unavailable
   after a proportionate attempt;
3. `blocked` when no authorized action can advance the task;
4. `needs-decision` when a missing user choice would materially change the result.

Every substantial action must be expected to change the deliverable, conclusion, terminal state,
or a material risk. Repeated reading, searching, retrying or broadening without an updated
hypothesis is not progress. Runtime time, token and trajectory data remain observations; Runtime
does not force a stage transition or terminate exploration on the Agent's behalf.

## 2. Why this is not task fitting

The Harness source contains no Terminal-Bench task name, benchmark answer, known failure,
dependency, time limit, number of allowed reads, verifier path, or task-family-specific algorithm.
The same contract applies to implementation, repair, research, service, configuration and recovery
tasks. It defines semantic completion and evidence proportionality rather than a prescribed route.

The v0.2 independent-evidence and executable-behavior preferences remain. The corrected boundary
is that unavailable ideal evidence no longer creates an unreachable completion predicate. The
Agent must preserve the strongest feasible artifact and evidence, state the limitation precisely,
and stop when another action is not reasonably expected to change a material decision.

## 3. Precommitted diagnostic

Only `torch-pipeline-parallelism` is permitted in the first v0.3 model run:

- attempts: 1;
- concurrency: 1;
- expected trials: 1;
- model: frozen `gpt-5.6-sol` route;
- reasoning effort: `max`;
- permission mode: `full_access`;
- Runtime, dataset, scorer and task environment: unchanged from the v0.2 run.

The task is selected because the immediately preceding v0.2 trajectory is available for direct
comparison and ended in a repeated evidence-expansion path. This run tests whether the Agent
returns an artifact and final response under the revised general contract. It is not a reportable
benchmark score and must not be combined with v0.1 or v0.2 results.

Do not run another failed task, an 89-task pass, a multi-attempt pass or the 445-trial matrix under
this decision Gate.

## 4. Required no-model Gate

Before the one model run:

- parse the package and verify model ownership;
- freeze source SHA-256 and normalized artifact hash;
- bind the adapter, lock, ATIF identity and public Gate to exact `terminal-task@0.3.0` identity;
- verify in-container install and authoritative Evaluation Binding;
- verify `harness-torch` expands to one task, one attempt, concurrency one and one expected trial;
- run targeted Rust and Python tests, shell syntax validation and cloud preflight;
- commit only the v0.3 Harness, protocol and binding changes on top of the existing clean tracked
  benchmark baseline.

## 5. Decision criteria

After the one run, compare v0.3 with the frozen v0.2 trajectory:

- reward and final Agent status;
- whether an artifact and final reply are produced before Harbor's Agent deadline;
- whether executable or caller-side evidence improves, remains equal, or regresses;
- whether the Agent explicitly distinguishes verified behavior from remaining limitation;
- whether repeated low-information reading or cross-version expansion recurs;
- input, cached and output tokens, model calls, tool jobs and wall-clock duration;
- Provider, Harness binding, Runtime lifecycle, integrity and credential audit results.

A pass with a materially shorter and honest path supports retaining v0.3 for later representative
evaluation. A zero reward or evidence regression closes this round for trajectory review; it does
not authorize silent Harness mutation or another model run.

## 6. Recorded outcome

The single permitted run completed on 2026-08-24 with raw and strict reward `0.0` and public
exception `AgentTimeoutError`. The trajectory obtained exact caller-side world-size 1 and 2
forward, backward and parameter-gradient equivalence evidence, but no final Agent reply followed
the last successful test before the Agent deadline. Provider, integrity, binding and isolation
Gates passed. See
[`terminal_bench_2_1_harness_v0_3_torch_result_2026_08_24.md`](./terminal_bench_2_1_harness_v0_3_torch_result_2026_08_24.md).

No other task, retry or larger matrix is permitted under `terminal-task@0.3.0`.
