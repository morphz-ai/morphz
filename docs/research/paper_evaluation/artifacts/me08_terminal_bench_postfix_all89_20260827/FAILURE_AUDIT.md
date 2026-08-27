# ME-08 post-fix all-89 failure audit

Audit date: 2026-08-27  
Audited run: `me08-terminal-bench-finalfix-all89-morphz-v3`  
Runtime: `4bbc3d63f4bda09947dc79dc5656edc71f8c02fa`  
Official result: **72/89 = 80.90%**

## Verdict

The audit found **one confirmed Morphz-owned benchmark-adapter defect**, but no
confirmed recurrence of the previously repaired core Runtime defects.

The confirmed defect is a deadline-boundary error in the Harbor adapter. In
`train-fasttext`, Morphz durably committed `chat/reply` at
`22:53:28.521573Z` and `runtime/thread_terminal` at `22:53:28.525011Z`. The
adapter's watcher nevertheless requires 20 additional seconds of unchanged
state before returning. Its earliest possible return was therefore about
`22:53:48.525Z`, while Harbor's 3600-second agent deadline was
`22:53:47.542Z`. Harbor consequently recorded `AgentTimeoutError` even though
Morphz had already completed the turn.

This adapter defect **does not change the official score for this run**. The
official verifier still evaluated the produced FastText model and measured
accuracy `0.207`, below the required `0.62`. The task therefore remains a
legitimate zero after correcting only the timeout classification.

## Core Runtime regression checks

Across all 17 official failures:

- no `database is locked` or nested-transaction symptom was present;
- no lost/cancelled execution job was present;
- every non-timeout turn produced exactly one durable `chat/reply` and one
  `runtime/thread_terminal` event;
- the only live job after a normal reply was the explicitly declared
  `keep_running=true` Git web service required during verification;
- all three `cyber_policy` refusals terminated without provider-recovery loops;
- neither visual timeout showed a context-maintenance transaction or the old
  Base64-as-text critical-maintenance loop;
- no duplicate reply was observed.

The evaluated commit contains the equivalent integrated fixes for durable
root-turn reply waiting, terminal-delivery handoff, SQLite cancellation,
permanent safety-refusal classification, visual-input accounting, and completed
exec-monitor handling (`76affb1`, `5f51668`, `9a64f4e`, and `392404e` in the
integrated branch history).

## Classification of the 17 failures

| Task | Audit classification | Evidence and conclusion |
|---|---|---|
| `break-filter-js-from-html` | External provider refusal | Provider returned `cyber_policy`; Runtime terminated it without a recovery loop. |
| `feal-differential-cryptanalysis` | External provider refusal | Same bounded permanent-refusal path. |
| `vulnerable-secret` | External provider refusal | Same bounded permanent-refusal path. |
| `make-doom-for-mips` | Genuine deadline non-completion | No reply was committed. At the 900-second deadline a model Activation was still running after extensive build/VM work; no stuck execution job or storage error was found. |
| `extract-moves-from-video` | Genuine deadline non-completion | Runtime was correctly waiting on a live background job. The model launched full-video 4-fps extraction plus parallel OCR; its heartbeat advanced until cancellation, but it did not produce `/app/solution.txt` within 1800 seconds. |
| `train-fasttext` | Adapter false-timeout **and** semantic failure | Morphz replied before the deadline but the 20-second watcher grace crossed Harbor's deadline. Independently, the submitted model scored `0.207`, so the official zero remains valid. |
| `dna-assembly` | Agent solution error | The model's private validator omitted the verifier's overhang-overlap annealing semantics; official Tm difference was `5.446548 > 5`. |
| `dna-insert` | Agent solution error | Same validator/interpretation class; official Tm difference was `8.1916 > 5`. |
| `mteb-leaderboard` | Agent answer error | Selected `intfloat/multilingual-e5-base`; the frozen verifier expected `GritLM/GritLM-7B`. |
| `pytorch-model-recovery` | Agent implementation error | Recovered model interface accepted one tensor while the verifier required the original two-input forward contract. |
| `torch-pipeline-parallelism` | Agent implementation error | Official gradient comparison failed. |
| `build-pov-ray` | Agent completion/validation error | Agent claimed completion, but the required `/app/povray-2.2/file_id.diz` was absent. |
| `configure-git-webserver` | Agent setup/validation error | Persistent service was preserved as designed, but the verifier received HTTP 404 and repository errors. |
| `filter-js-from-html` | Agent implementation error | Sanitizer changed clean HTML through entity normalization and still failed the security contract. |
| `cancel-async-tasks` | Agent implementation error | Required cleanup behavior did not occur; verifier observed zero `Cleaned up.` messages. |
| `chess-best-move` | Agent answer error | Produced `g2g4`, outside the verifier's accepted answer set. |
| `video-processing` | Agent algorithm error | Detected takeoff at frame 117; the accepted interval was frames 219--223. |

## What the three timeout labels actually mean

- `make-doom-for-mips`: model/task execution had not converged before the
  official deadline.
- `extract-moves-from-video`: a model-chosen expensive OCR command was still
  genuinely active at the official deadline.
- `train-fasttext`: Morphz had converged, but the adapter's fixed post-reply
  idle grace produced a false timeout label.

Only the third is a confirmed Morphz-owned defect. The first two may motivate
general convergence or execution-budget improvements, but this evidence does
not establish a Runtime correctness bug.

## Reporting consequence

The immutable official result remains **72/89**. Diagnostic reporting should
say that the run contains three Harbor `AgentTimeoutError` records, of which
one is an adapter classification defect that is score-neutral in this trial.
It would be incorrect either to raise the official score or to describe all
three timeouts as Runtime failures.
