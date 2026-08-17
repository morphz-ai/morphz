# DEMO-001 Normal Smoke Report — frozen-v2.1

> Executed: 2026-08-17 (Asia/Shanghai)
>
> Purpose: `roadshow_demo`; excluded from paper statistics
>
> Pair cell: `42001`; one run per Arm

## Gate result

All three Arms completed and passed the hidden final-action scorer:

| Arm | Correct unique action | Stale state | Input tokens | Final active context | Calls | Wall time |
|---|---:|---:|---:|---:|---:|---:|
| Persistent messages | yes | no | 14,768 | 5,187 | 3 | 27.371 s |
| Summary JSON memory | yes | no | 8,526 | 1,225 | 5 | 51.488 s |
| Morphz structured Context | yes | no | 8,663 | 1,245 | 5 | 71.071 s |

Every Arm also passed cross-Session continuity, Principal attribution, concurrent
Thread routing and equivalent Worker replacement without duplicate external
action.

## Binding evidence

Every run manifest records:

```text
profile          roadshow-demo-001
provider         custom
logical model    gpt-5.6-sol
physical model   gpt-5.6-sol
reasoning        max
fallback         false
protocol         frozen-v2.1
code commit      8af537e09222e98c5d03d4d0b08aff8bd32b8029
demo tag         demo-001-frozen-v2.1-20260817
```

The Profile file hash is
`90c1de7eda105d7a1e35d3c0c9d7089a5ed4ef4b6eafc2ec8af234dc81268f7e`.
The earlier `codex-subscription` 429 probe is invalid and excluded.

## Interpretation boundary

This n=1 Normal smoke establishes that the corrected Morphz Profile,
CLIProxyAPI-compatible transport, three Arm adapters, hidden scorer and artifact
pipeline close end to end. It does not establish architecture superiority.

All Arms succeeded under Normal load. Persistent messages used more input but
completed faster in this cell; Summary and Morphz used similar input, while
Morphz was slower. Provider-reported input usage was not exposed by this route,
so the table uses the frozen local uncached-equivalent tokenizer accounting.
No monetary cost is attributed.

The smoke runner deliberately leaves `full_batch_permitted=false`. Proceeding
to the paired Normal/Pressure batch requires review of this Gate; the Pressure
level is expected to supply the discriminating context-cost condition without
artificially degrading the Message baseline.

## Artifact root

```text
/private/tmp/morphz-roadshow-smoke-cliproxy-20260817/DEMO-001/frozen-v2.1/runs/DEMO-001-normal-smoke-20260817T114307.740Z-9369
```
