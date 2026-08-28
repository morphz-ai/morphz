# ME-08 current-Runtime failure audit

## Scope

- Protocol: `me08-terminal-bench-current-runtime-all89-morphz-v6`
- Runtime: `d6e6d80053d95577811971e6048033374e4d6901`
- Official raw reward: **72/89**
- Evidence: all 17 zero-reward `result.json` files, official verifier CTRF/output, Morphz trajectories, and Runtime logs from the preserved server run root.
- Task identity check: both runs contain 89/89 common task IDs and **0 task-checksum differences**; the paired comparison is against byte-identical task packages.
- The official raw score is not adjusted by this diagnostic audit.

## Aggregate attribution

| Primary cause | Count | Tasks |
|---|---:|---|
| Provider safety refusal | 3 | `break-filter-js-from-html`, `model-extraction-relu-logits`, `vulnerable-secret` |
| Harbor hard Agent deadline | 2 | `extract-moves-from-video`, `make-doom-for-mips` |
| Completed implementation/answer failed verifier | 12 | all remaining failures |

No failure contains a lease-expiry, lost-ownership, database-lock, provider-timeout, quota, or unbounded-`no_reply` signal. Neither hard-timeout trajectory called `no_reply`. Managed background jobs produced completion notifications and execution resumed. The two hard timeouts therefore do not reproduce the previously fixed permanent-wait defect.

## Per-task findings

| Task | Original ME-08 | Primary finding |
|---|---:|---|
| `break-filter-js-from-html` | fail | Provider returned `cyber_policy` on the initial request and both bounded recovery attempts. No `out.html` was created. |
| `chess-best-move` | fail | The image-derived FEN was wrong or incomplete. `python-chess` consequently classified only `e2e4` as mate; the model wrote only that line. The verifier required both `e2e4` and `g2g4`. The original run made the complementary error and wrote only `g2g4`. |
| `dna-assembly` | fail | Primer validation used the intended annealing arms, not the verifier's effective annealing tract including matching overhang suffixes. The EGFP pair's actual Tm delta was `5.888799°C`, exceeding the `5°C` limit. |
| `dna-insert` | fail | The model's custom reconstruction/Tm oracle did not match the required `rc(reverse) + forward` interpretation and first insert occurrence. It reported a `0.074115°C` delta; the actual interpreted arms had `66.274364°C` and `59.742459°C`, a `6.531905°C` delta. |
| `extract-moves-from-video` | fail | Harbor ended the Agent at exactly `1800s`. The model spent 44 steps building repeated 1/2/5-fps OCR pipelines and move-counter reconciliation, but never wrote `/app/solution.txt`. Background completions did wake the Runtime; this was an overlong strategy, not a silent wait. |
| `filter-js-from-html` | fail | The sanitizer passed its hand-written 17-vector self-test and preserved clean HTML, but an official browser batch containing advanced encoding/parser vectors still triggered an alert. This is incomplete sanitizer coverage, not a Runtime failure. |
| `gcode-to-text` | pass | Exact transcription/case error: wrote `flag{gc0d3_iz_ch4llenGiNg}` instead of `flag{gc0d3_iz_ch4LLenGiNg}`. |
| `install-windows-3.11` | pass | QEMU 5.2, networking, core Windows files, VNC, monitor socket, and durable background service all passed. Only interactive readiness failed: none of F1, Alt-Tab, F10, Alt-F4, or Ctrl-Esc changed at least 10% of the framebuffer. This is guest/UI state or input-path behavior, not loss of the background process. |
| `kv-store-grpc` | pass | The service stayed alive and was a real gRPC server. The model defined request field `val`; the instruction and verifier required `value`. Its self-test reused the same wrong schema, so it falsely validated the implementation. |
| `make-doom-for-mips` | fail | Harbor ended the Agent at exactly `900s`. After 30 steps the model was still reconstructing a compatible MIPS-I soft-float `libgcc` helper runtime; `vm.js` never produced `/tmp/frame.bmp`. No permanent wait or lease failure occurred. |
| `model-extraction-relu-logits` | pass | Provider returned `cyber_policy` on the initial request and both bounded recovery attempts. No `stolen_A1.npy` was created. This is a stochastic Provider regression relative to the original run. |
| `mteb-leaderboard` | fail | The calculation was internally consistent only over a manually restricted four-model candidate set. That set omitted the actual eligible winner `GritLM/GritLM-7B`, so it wrote `intfloat/multilingual-e5-base`. |
| `pytorch-model-recovery` | fail | The recovered TorchScript exported `forward(src)` and treated `tgt_sequences` only as labels. The actual model contract is `forward(src, tgt)`, so the verifier failed before comparing loss: two tensors were passed to a one-input method. The chosen `nhead=8` was also not established by state-dict shapes alone. |
| `raman-fitting` | pass | Three of four 2D-peak values were within tolerance; only the constant offset missed: `1443.672958` versus `1239.09`, about `16.5%` high with a `10%` tolerance. This is a fitting-window/baseline-model error. |
| `sam-cell-seg` | pass | The model could not exercise the real MobileSAM path and validated with a fake ellipse predictor. Under the official data, one output remained rectangle-equivalent and mask alignment had IoU `0.0`. The mocked self-test did not test the central dependency or real geometry. |
| `video-processing` | fail | The detector was tuned and validated only on the supplied example (`54/62`). On the official second video it predicted takeoff frame `236`; the accepted range was `219–223`. This is sample overfitting/generalization failure. |
| `vulnerable-secret` | fail | Provider returned `cyber_policy` on the initial request and both bounded recovery attempts. No `results.txt` was created. |

## Paired comparison with the frozen original ME-08

The total score is unchanged, but the task composition is not:

- both pass: **66**
- both fail: **11**
- current pass / original fail: **6** — `build-pov-ray`, `cancel-async-tasks`, `configure-git-webserver`, `feal-differential-cryptanalysis`, `torch-pipeline-parallelism`, `train-fasttext`
- current fail / original pass: **6** — `gcode-to-text`, `install-windows-3.11`, `kv-store-grpc`, `model-extraction-relu-logits`, `raman-fitting`, `sam-cell-seg`

The six-for-six exchange shows substantial one-attempt task variance even at the same aggregate 72/89. Among the six regressions, one is a Provider safety refusal and five are concrete answer/implementation differences; none is confirmed as a Runtime delivery failure.

## Runtime conclusion

The failure set does not support a new systemic Runtime-timeout regression. The bounded-wait change was not implicated in either hard timeout, and background execution delivered wake/completion events. The only Runtime-side warnings in the relevant logs were isolated slow SQLite statements and two successful action-group result recoveries during `install-windows-3.11`; execution continued and the corresponding service lifecycle checks passed.

The main remaining reliability problems exposed by this run are model-side validation-oracle quality, hidden-case generalization, strategy budgeting on long multimedia/build tasks, and Provider safety variance.
