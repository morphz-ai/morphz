# ARC-AGI-3 public-game diagnostic

This adapter runs an actual Morphz Runtime against the official ARC-AGI-3
offline environment. It is an exploratory public-game sample, **not a formal
competition submission or an official leaderboard score**.

## Fixed first-sample protocol

- Public games, selected before observing results: `ls20`, `ft09`, `vc33`.
- One attempt per game, seed `0`, at most 600 seconds and 200 submitted actions
  per attempt. Resets count as actions. Model loading is timed separately.
  The automatic initial reset performed by `arc.make` is setup, not a
  Morphz-submitted action.
- Fresh Runtime database/Context per game; continuous memory within a game.
- Morphz `v0.1.3`, release commit
  `7e8f7d81f8b00fd45544d94d5b9a321214633df1`.
- Qwen3.8-Flash-Next W4A16 AutoRound, SGLang Pennyroyal v2.5.3,
  262,144-token configured context, medium reasoning effort, 8,192-token output
  cap, one free Kaggle RTX PRO 6000, internet disabled.
- Engine `levels_completed` and `WIN` are separate outcomes. Budget exhaustion,
  process return and infrastructure errors must not be relabelled as a win.
- Partial progress uses the greatest observed `levels_completed`; a later reset
  can reduce the current counter. Total actions and resets remain cumulative.

## Responsibilities

`arc_bridge.py` imports the official toolkit, renders the most recent returned
grid using the official palette and forwards only validated actions. It contains
no game-specific strategy, search heuristic or solution. It saves every returned
frame, authoritative state and action. A batch contains at most 10 actions and
stops on `WIN`, `GAME_OVER` or the budget boundary.

`arc_cli.py` exposes `status`, `action` and `batch` to Morphz's ordinary shell tool.
It does not import the game engine. The model can use Morphz's native image-read
tool on `frame.png`, or analyse the exact `frame.json`/hexadecimal `grid.txt`.
The bridge itself does not call a model. Morphz owns inference, tool execution,
Context maintenance and task progression.

`arc_runner.py` creates the isolated Runtime configuration, binds the local
anonymous provider through the supported Operator API, starts the game, times
the Runtime process and records provider requests, image counts, tool-job
receipts and GPU samples. It depends on globals established by the bootstrap;
it is not a standalone local launcher.

## Kaggle execution

Use a **private** Notebook with the official ARC-AGI-3 competition input, the
approved `dfranzen/pennyroyal-v253` offline package bundle, the
`dfranzen/intel-qwen3.8-flash-next-w4a16-autoround` model V1 and the separately
verified Python/Morphz offline-preparation artifact. The bootstrap verifies that
artifact's manifest before extracting executables.

1. Select the free RTX PRO 6000 accelerator and confirm the setting has actually
   changed. Turn internet off. Do not run while the editor still says `None`.
2. Execute `flash_next_bootstrap_arc.py`. Wait for `DIRECT_MODEL_SMOKE_PASS` and
   `READY_FOR_MORPHZ_RUNTIME_TEST`. These only prove infrastructure readiness.
3. Write `arc_bridge.py` and `arc_cli.py` to
   `WORK / 'arc-public-baseline' / 'bridge-source'`, then execute `arc_runner.py`
   in the same kernel. It creates a separate official-toolkit Python environment
   from the competition wheelhouse without changing the SGLang environment.
4. Inspect each game's `result.json`, actual `trajectory.jsonl`, images,
   `tool-jobs.json` and Runtime/provider logs. Save the Notebook and its output,
   then stop the GPU session. Do not submit predictions from this diagnostic.

`arc_report.py` renders the result table from saved engine trajectories and
checks the live server's configured context. The official environment uses
`MPLBACKEND=Agg` so it does not inherit a Notebook-only inline plotting backend.

Outputs live below `/kaggle/working/morphz-arc3-public-baseline/`. The model itself,
temporary Python environments and weight caches are outside that output tree.

## Evidence and limitations

The initial shell profile matches the previously verified Kaggle integration:
`full-access` inside a fresh, offline, test-only container. The prompt forbids
reading game implementations, hidden state and other solvers; configured
protected paths also identify engine/source directories. **This is not a sealed
anti-cheating sandbox.** Audit actual tool commands before interpreting results;
do not claim OS-level source isolation. The controller does not read game
implementations for strategy.

Provider-wire logs omit image base64 payloads, retaining hashes instead. An
`images_in_request` count proves the transport sent an image, not that vision
reasoning was correct. A Runtime tool receipt proves an action was executed,
not that a level was solved; only engine feedback establishes progress.

The 256K allocation is not a 256K-long game test. Public games can have appeared
in training data. Small-sample outcomes are not estimates of private-set scores.
FP8 KV cache and the custom inference backend need separate numerical validation.

## Adapter-only tests

```sh
python -m unittest discover -s benchmarks/arc_agi3 -p 'test_*.py'
```

These tests use explicit fake engine fixtures and synthetic geometry. They cover
rendering, validation, accounting, actual local HTTP/CLI transport, repeat/delta
observations and deployment packaging. They are **not** model/game performance
results. The deployment fixture uses a deliberately fake ELF header, not a
working Linux binary.

## Observation-driven Harness experiment — 2026-10-23

`arc-discovery.hns` is a versioned Harness installed through the real Morphz
registry and selected with `--harness arc-discovery@0.1.0`. It reuses Runtime
inference, structured Context, tools, persistence and output continuation; it
does not introduce a second agent runtime or train a model.

The domain discipline is: observe, distinguish alternative mechanics with a
small experiment, revise evidence-backed rules, plan a short verified path, and
re-observe after an unexpected result. Component roles, goals and success are
never inferred by bridge code. No game ID, known move sequence, coordinate or
color encodes an answer.

`arc_observation.py` derives exact visible-grid facts: lossless hexadecimal rows,
four-connected color components (explicitly bounded), changed-pixel regions,
state revisits, repeated actions and no-change streaks. Geometric components are
not semantic objects. Identical pixels need not imply identical hidden states.
`python3 arc_cli.py observe` reads the current observation without an environment
action; `step ACTIONn [x y]` returns fresh state and observations in one receipt.
Legacy `status`, `action` and `batch` remain available. A frameless receipt marks
the current observation unavailable rather than returning stale geometry.

The first targeted A/B configuration selects `ft09`, seed 0, one baseline and one
discovery attempt, each capped at 600 seconds and 200 actions. Both arms must use
the **same verified Runtime binary**, Flash-Next model, 256K context, 8192 output
cap and medium effort. Fresh DB/Context/workspace per arm. This tests the Harness
**plus** advertised observation aids, not an isolated prompt effect. The
10/21 historical run used an older Runtime and is not the clean A/B control.

```sh
python benchmarks/arc_agi3/build_harness_experiment.py \
  --runtime /absolute/path/to/verified-linux-x86_64/morphz \
  --runtime-commit FULL_COMMIT_USED_FOR_BUILD \
  --output /absolute/path/to/private-deployment
```

The generator creates a small importable Notebook plus a deployment ZIP with an
explicit source allowlist and hashes; it never uploads or submits. User configs,
keys and databases are not packaged. Attach this ZIP as a **private** Kaggle
input, alongside the same four approved inputs from the baseline. The Notebook
checks ZIP/file/binary hashes before loading the model, installs the Harness in
the candidate's isolated DB, and saves the actual Evaluation binding/hash and
engine/provider/tool evidence. Missing binding or no model requests makes an
attempt invalid, not a zero-score demonstration. The model server is terminated
after the bounded experiment; also stop the Kaggle session after archival.

The Linux experiment binary must include the output-limit continuation fix
(`cda82d12` or a verified descendant). The new visible-grid bridge can be tested
locally without a model, but improved solving ability is **unverified until an
actual engine/model run is saved and audited**. Never relabel generated deployment
files or passing interface tests as a completed competition result.

## Measured run — 2026-10-21

The first actual Kaggle sample completed with no level wins:

| Public game | Best level progress | Submitted actions | Resets | Wall time |
|---|---:|---:|---:|---:|
| `ls20-9607627b` | 0 / 7 | 84 | 1 | 600.490 s |
| `ft09-0d8bbf25` | 0 / 6 | 90 | 0 | 600.484 s |
| `vc33-5430563c` | 0 / 7 | 51 | 1 | 600.489 s |

All three stopped at the time budget; `-15` is the runner's deliberate SIGTERM,
not proof of a Runtime crash. The controller recorded 78 provider requests,
five image-bearing requests with HTTP 200, and no reported CUDA out-of-memory
error. Peak allocated GPU memory was 96,487 / 97,887 MiB. Maximum actual model
input was 69,749 tokens, below the configured 262,144-token limit.

There were three output-length-limit failures (one in `ls20`, two in `vc33`).
`ft09` had none and still made no progress; 54 of its 90 actions left the
returned observation unchanged. Thus output truncation is a confirmed execution
issue, not a demonstrated explanation of every failure. This is a first capped
baseline, **not** evidence of the system's best possible ability. The custom
backend also logged KV-scaling and kernel-data-race warnings.

See [structured results](results-2026-10-21.json) and the
[private Kaggle run, saved version 360692393](https://www.kaggle.com/code/shafreecksea/morphz-arc-agi-3-public-games-baseline?scriptVersionId=360692393).
Saved Kaggle output contains the full trajectories, frames, SQLite files and
wire/log evidence; the repository keeps only the compact evidence summary.
The free GPU session was stopped after successful archival. Nothing was
submitted to the competition leaderboard.

## Primary interface references

- [Official ARC toolkit](https://github.com/arcprize/ARC-AGI)
- [Official actions documentation](https://github.com/arcprize/docs/blob/main/actions.mdx)
- [Official Kaggle starter](https://github.com/arcprize/ARC-AGI-3-Kaggle-Starter)
- [Official frame palette](https://github.com/arcprize/ARC-AGI/blob/main/arc_agi/rendering.py)
