# DEMO-001 Normal Smoke Report — frozen-v2.1 selective

> Executed: 2026-08-17 (Asia/Shanghai)
>
> Purpose: `roadshow_demo`; excluded from paper statistics
>
> Pair cell: `42001`; one run per Arm

## Gate result

All three Arms completed and passed the hidden final-action scorer on the
selective Runtime baseline:

| Arm | Correct unique action | Stale state | Input tokens | Final active context | Calls | Wall time |
|---|---:|---:|---:|---:|---:|---:|
| Persistent messages | yes | no | 14,768 | 5,187 | 3 | 28.365 s |
| Summary JSON memory | yes | no | 8,502 | 1,206 | 5 | 59.475 s |
| Morphz structured Context | yes | no | 8,375 | 1,175 | 5 | 80.453 s |

Every Arm also passed cross-Session continuity, Principal attribution,
concurrent Thread routing and equivalent Worker replacement without duplicate
external action.

## Binding and code identity

Every run manifest records:

```text
profile          roadshow-demo-001
provider         custom
logical model    gpt-5.6-sol
physical model   gpt-5.6-sol
reasoning        max
fallback         false
protocol         frozen-v2.1
code commit      0ac1a2d003b3fd302d4d91106e52741ad3dc8268
demo tag         demo-001-frozen-v2.1-selective-20260817
```

The Profile file hash is
`90c1de7eda105d7a1e35d3c0c9d7089a5ed4ef4b6eafc2ec8af234dc81268f7e`.
Commit `8a06824` is not an ancestor of the executable selective tag.

The earlier deployed-account 429 probe and the intermediate main-branch smoke
are engineering probes only. Neither is part of this Gate.

## Interpretation boundary

This n=1 Normal smoke proves the corrected Morphz Profile,
CLIProxyAPI-compatible transport, three Arm adapters, hidden scorer and artifact
pipeline close end to end on the intended Runtime baseline. It does not prove
architecture superiority.

All Arms succeeded under Normal load. Persistent messages used more input but
completed faster in this cell. Summary and Morphz used similar input; Morphz
used slightly fewer locally counted input tokens but took longer. Provider input
usage was not exposed, so all Token numbers use the frozen local
uncached-equivalent tokenizer accounting. No monetary cost is attributed.

The smoke runner deliberately leaves `full_batch_permitted=false`. Proceeding
to the paired Normal/Pressure batch requires coordinator review.

## Artifact root

```text
/private/tmp/morphz-roadshow-smoke-cliproxy-selective-20260817/DEMO-001/frozen-v2.1/runs/DEMO-001-normal-smoke-20260817T115355.245Z-10822
```
