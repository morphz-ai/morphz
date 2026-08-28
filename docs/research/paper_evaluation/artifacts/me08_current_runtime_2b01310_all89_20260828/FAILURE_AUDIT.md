# ME-08 current-Runtime all-89 failure audit

Audit date: 2026-08-28
Run: `me08-current-runtime-2b01310-r1-20260828`
Runtime: `2b01310107f3d7819eedd5e07d2605ce46803ea8`
Official result: **69/89 = 77.53%**

## Verdict

The 20 official failures do not support a single regression explanation. They
comprise 7 deadline failures, 4 explicit Provider safety refusals, and 9 task
implementation or answer errors. The repaired shell-background and managed
service paths have positive passing evidence and no recurrence of their old
error signatures.

The audit did find one separate infrastructure defect: after Harbor declares
an Agent timeout, the in-container Morphz process can continue executing into
the verifier phase. This happened materially in at least four timeout trials.
It did not inflate the score because every timeout trial received zero, but it
violates the intended Agent/verifier phase boundary and must be fixed before a
future refresh can be treated as a clean replacement result.

## Classification of all 20 failures

| Task | Classification | Evidence and conclusion |
| --- | --- | --- |
| `model-extraction-relu-logits` | Provider safety refusal | Three bounded attempts ended with explicit `cyber_policy` before any tool call; no `stolen_A1.npy` was produced. The frozen run used byte-identical instruction and agent configuration, also encountered intermittent `cyber_policy` responses, recovered, and passed. The changed outcome is therefore refusal persistence/timing, not a newly sensitive task or deterministic Runtime failure. |
| `vulnerable-secret` | Provider safety refusal | Three bounded attempts ended with `cyber_policy`; `/app/results.txt` was absent. |
| `break-filter-js-from-html` | Provider safety refusal | Three bounded attempts ended with `cyber_policy`; `/app/out.html` was absent. |
| `feal-differential-cryptanalysis` | Provider safety refusal | Work began, but the subsequent evidence combination triggered three bounded `cyber_policy` refusals; the required `attack` module was absent. |
| `make-doom-for-mips` | Genuine deadline non-completion | Extensive compilation and VM work consumed the 900-second budget. No required `frame.bmp` existed at the deadline; no lease or storage failure was found. It also failed in the frozen run. |
| `password-recovery` | Genuine deadline non-completion | The model launched brute force over 31 non-empty keyfile subsets late in the turn. The managed job was still computing and no `recovered_passwords.txt` was produced. It passed in the frozen run. |
| `query-optimize` | Over-optimization plus phase leak | A byte-identical plan around 0.17 seconds had already been found, but the model continued exploring and never finalized. Nine jobs were admitted after Harbor's timeout; no terminal reply was committed. It passed in the frozen run. |
| `train-fasttext` | Genuine timeout and semantic failure | Repeated compilation, training, normalization, and autotuning consumed 3600 seconds. The submitted model passed the size check but scored 0.528, below 0.62. Four post-deadline jobs expose the runner phase leak, but the official zero is independently valid. |
| `extract-moves-from-video` | Over-expensive OCR and phase leak | The model extracted 760 frames at 4 fps but completed only 112 OCR files by cancellation and never wrote `solution.txt`. One diagnostic job was admitted after Harbor's deadline. It also failed in the frozen run. |
| `feal-linear-cryptanalysis` | Computationally ineffective attack | The generated attack completed a `2^20` K0 table and remained in K3 scanning until cancellation. `plaintexts.txt` was absent. The background job remained live and leased; this was not an Edge failure. It passed in the frozen run. |
| `headless-terminal` | Initial code hang plus runner phase leak | The first PTY cleanup implementation hung its self-test to the 900-second deadline. The Runtime continued afterward, fixed the code, passed two self-tests, and replied 132.8 seconds late while the verifier was active. The verifier passed 1/7 tests, then timed out and produced no reward. It passed in the frozen run. |
| `pytorch-model-recovery` | Agent implementation error | The recovered TorchScript model accepted one tensor, while the verifier invoked the original two-input forward contract. |
| `torch-pipeline-parallelism` | Agent implementation error | Official distributed comparison found a rank-1 backward-gradient mismatch of 0.0357. |
| `configure-git-webserver` | Agent setup error | The preserved web service responded, but with HTTP 404; verifier logs also showed the expected directory was not a Git repository. This is not a keep-running liveness failure. |
| `dna-insert` | Agent answer error | Primer melting temperatures differed by 6.532 °C, above the allowed 5 °C. |
| `extract-elf` | Agent algorithm error | The generated extractor returned no matching reference addresses: 0% coverage versus the required 75%. No heredoc `&` false positive or lease loss occurred. |
| `filter-js-from-html` | Agent implementation error | The filter still admitted an XSS corpus case and modified 5 of 12 clean HTML inputs. |
| `make-mips-interpreter` | Agent implementation/output error | The produced frame similarity was 0.8065 versus the required 0.95. |
| `pytorch-model-cli` | Agent implementation error | Predictions over the verifier's first 50 MNIST inputs did not match the expected classes. |
| `sanitize-git-repo` | Agent implementation error | Sanitized files differed from the required replacement output, including unintended textual changes. |

## Timeout phase-boundary evidence

The outer Harbor timeout timestamp was compared with every Runtime job and
event timestamp in the corresponding SQLite database. No timed-out turn had a
terminal reply before its official deadline. Four continued to admit new jobs
after that deadline, and `headless-terminal` eventually committed a terminal
reply after the verifier phase had begun.

This distinguishes three mechanisms:

1. **Agent non-convergence:** the model had not produced a valid terminal state
   by the deadline;
2. **managed background cancellation:** already-running child work was
   cancelled and durably closed around teardown;
3. **runner phase leak:** cancellation of Harbor's outer `docker compose exec`
   wait invoked the custom cancellation path, but that path preserved the
   Runtime without first cancelling its active Thread.

The source-level chain is now specific. Harbor 0.21.0 wraps `Agent.run` in
`asyncio.wait_for`. `MorphzAgent.run` catches cancellation and invokes
`run-morphz-harbor.sh --cancel`. That branch runs `--prepare-verifier`, marks
the Runtime as the live owner needed by `keep_running` services, and kills the
outer runner shell. It does not durably cancel the active Thread/Activation or
wait for its cancellation barrier. The existing unit test proves that the
second cleanup command is invoked; it does not prove that the active Thread
becomes terminal. In `headless-terminal`, the database confirms the Thread
instead reached `completed` and emitted `chat/reply` at 11:57:49Z, 132.8
seconds after Harbor's Agent deadline.

The required correction is a phase-transition protocol: durably cancel the
active Thread, wait until the Activation and its transient child jobs are
terminal, and only then perform the verifier handoff that preserves explicitly
declared durable services. Killing the whole Runtime would close the leak but
would regress the repaired `keep_running` ownership path.

Only mechanism 3 is the newly confirmed infrastructure bug. It is not an Edge
lease failure and is not evidence of Context interference, because every task
used an independent database, Context, and Session.

## Safety-refusal comparison

The four current trials whose **primary official failure** was Provider safety
refusal were `model-extraction-relu-logits`, `vulnerable-secret`,
`break-filter-js-from-html`, and `feal-differential-cryptanalysis`. Raw
`cyber_policy` events also appeared in `feal-linear-cryptanalysis`, whose
primary outcome remained computational timeout. In the frozen run, raw safety
events already appeared in the same four primary task families except
`feal-linear-cryptanalysis`; `model-extraction-relu-logits` recovered and
passed, leaving three final refusal failures.

For `model-extraction-relu-logits`, the two runs have the same instruction SHA-256
`bc3d44048f2b2a6675e0f75bea6cbacf7a08bb0c5a3bfb522711505c596e6eac`
and the same `morphz-harbor.toml` SHA-256
`8ce8a55b2091b33d737d2a9dcf545c767f0aa874349adec11960d447b87217f9`.
Both selected the same `gpt-5.6-sol` OpenAI Responses route. The frozen run
received tools, later encountered safety refusals, then recovered; the current
run was refused before its first tool and all bounded recovery attempts were
refused.

The Runtime system contract did change modestly between runs, adding explicit
Function-Call/Yao execution rules and fine-grained Context-transaction text;
the estimated initial prompt grew by 495 tokens. The diff adds no security,
model-extraction, or credential semantics. Accordingly, the evidence supports
Provider classifier nondeterminism or possible server-side policy drift, but
does not establish a service-interface update. No Provider policy-version
identifier is exposed in the retained responses, so that stronger claim is
not auditable from this run.

## Reporting consequence

The immutable official result remains **69/89**. No failed task is removed,
retried, or rescored. The run is useful supplemental engineering evidence for
the repaired Edge/background/service paths and for the newly found timeout
phase leak. It does not replace the frozen 72/89 Morphz result or the paper's
72/89 versus 74/89 contemporaneous pair.
