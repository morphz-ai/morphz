# ME-07 formal confirmatory result

Protocol: `ME-07-STATE-Bench-public-agent-systems-v2`

| Arm | pass@1 | all runs pass | state | task req. | UX | terminal failures |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| morphz | 0.813 | 0.813 | 0.927 | 0.853 | 4.410 | 1 |
| letta | 0.620 | 0.620 | 0.793 | 0.680 | 3.625 | 7 |
| mem0 | 0.640 | 0.640 | 0.827 | 0.700 | 3.833 | 4 |

| Paired contrast | Difference | 95% clustered bootstrap CI | raw p | Holm p |
| --- | ---: | ---: | ---: | ---: |
| morphz_minus_letta | +0.193 | [+0.107, +0.280] | 4e-05 | 6e-05 |
| morphz_minus_mem0 | +0.173 | [+0.100, +0.247] | 3e-05 | 6e-05 |

| Arm | Held-out Agent tokens | Raw token counter | Accounting scope |
| --- | ---: | ---: | --- |
| morphz | 138,942,200 | 3,555,918,978 | heldout_evaluation_after_cloned_training_baseline_subtraction |
| letta | 40,143,631 | 40,143,631 | heldout_evaluation_provider_reported |
| mem0 | 7,364,662 | 7,364,662 | heldout_evaluation_provider_reported |

All terminal harness/provider failures are retained and scored as zero. This updated-evaluator result is not an official STATE-Bench leaderboard score.
Morphz raw token counters include the cumulative 100-episode training history embedded in every cloned domain database. The held-out Morphz total deterministically subtracts that frozen domain baseline once per scored clone; the raw value is retained for audit. Training cost is excluded from all three arms.
