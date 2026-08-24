# Terminal-Bench 2.1 Harness Trial Protocol v0.4

> Status: frozen before model run; one post-hoc convergence regression permitted
>
> Date: 2026-08-24
>
> Purpose: test whether an explicit best-checkpoint and proof-to-final closure protocol helps GPT-5.6 Sol terminate after sufficient evidence

## 1. Context and evidence boundary

`terminal-task@0.3.0` added a domain-neutral convergence contract. In the later fixed registry
tasks 21–40 development batch, five of twenty trials reached the Harbor deadline. One was a
Provider policy rejection, one was a model stream hang, and three continued task work; one of those
three (`train-fasttext`) nevertheless left a verifier-passing artifact. The observed trajectories
therefore support a narrower hypothesis: GPT-5.6 Sol may recognize evidence and still continue
optional exploration or optimization instead of preserving the best valid result and closing.

This v0.4 run is designed after observing those trajectories. It is a post-hoc product regression,
not an unseen benchmark sample, leaderboard score, confirmatory paper experiment, or result that may
be merged into the 20-task batch.

## 2. Single Harness change

v0.4 retains the task contract, acceptance ledger, epistemic discipline, independent verification,
domain guards and honest terminal states from v0.3. It adds a domain-neutral closure protocol:

1. preserve the first real deliverable that satisfies the currently verified critical acceptance
   conditions as the best valid checkpoint;
2. after that checkpoint exists, continue only for a named failed or unverified critical condition;
3. do not let optional optimization, broader exploration, presentation or stronger-than-required
   evidence delay delivery;
4. if a later candidate is worse or inconclusive, retain or restore the best valid checkpoint;
5. when no blocking critical condition remains, perform final readiness and return immediately.

The package contains no Terminal-Bench task name, Raman-specific term, fitting method, expected
answer, verifier detail, time limit, tool count, read count or fixed domain procedure.

## 3. Fixed diagnostic

Only one attempt of `raman-fitting` is permitted:

- selection reason: its v0.3 trajectory contained ordinary model/tool execution but repeatedly
  explored alternative fits and reached the deadline without a terminal artifact; it was not
  confounded by `cyber_policy` or a stuck Provider stream;
- attempts: 1;
- concurrency: 1;
- expected trials: 1;
- Harbor retries: 0;
- model: exact `gpt-5.6-sol`;
- reasoning effort: `max`;
- permission mode: `full_access`;
- Runtime: unchanged `paper-eval-runtime-v4` /
  `5e4b0ffcd89245f19d84ec3569605ae27a44e02b`;
- dataset, task checksum, scorer, Provider route and task environment: unchanged;
- Harness: `terminal-task@0.4.0`, source SHA-256
  `1c150f5ec72ee1e66d722b17ad418aaf87e7ece4514d98497d6fddf982da88a6`, artifact
  `sha256:b6063a4a970362888f6194fdfa498421b417bb032f4b58bf96e0bf5a0571aae2`.

## 4. Required Gate

Before the model call:

- parse the package and pass its Rust identity/contract test;
- pass the Harbor adapter, exact selection and binding tests;
- verify source/artifact hashes in the lock and package;
- verify `harness-raman-v04` expands to one task, one attempt, concurrency one;
- run cloud preflight and one-task install-only with no model call;
- commit the frozen Harness, protocol and binding changes on a clean tracked cloud worktree.

## 5. Decision criteria

Record reward, exception, final response, artifact evidence, ATIF steps, tool calls, model attempts,
input/cache/output tokens and wall time. Compare descriptively with the earlier v0.3 trajectory,
but do not claim causal significance from one stochastic rerun.

Success for this regression means the Agent writes a real requested deliverable and returns an
honest terminal response before Harbor's deadline, without replacing adequate work with optional
open-ended exploration. Official verifier reward remains the strongest product outcome, but a
failure is retained and analyzed without another v0.4 retry.

No second task, retry, larger batch or v0.4 mutation is authorized by this protocol.
