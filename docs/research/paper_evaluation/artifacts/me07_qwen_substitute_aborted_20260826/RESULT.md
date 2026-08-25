# ME-07 Qwen substitute run — aborted audit record

- Status: **aborted; invalid for paper effect claims**
- Terminated: 2026-08-26 07:12 Asia/Shanghai
- Raw root preserved at: `/private/tmp/me07-full-v1-20260826`
- Requested reader/judge: `qwen3.8-max-preview`
- Physical reader/judge: `qwen3.8-max`
- Provider: CLIProxyAPI / Alibaba Token Plan

## Reason

The run promoted a model that had only been authorized for the ME-05 nine-model
probe into the ME-07 reader/judge role. That substitution was not authorized.
Route availability and a failed GPT-5.6 Sol Chat Completions preflight did not
justify silently replacing the main experiment model. The active processes were
terminated without deleting or rewriting existing artifacts.

## Partial state retained for audit only

- `no_retrieval/web` completed 240 questions, but its score is withdrawn from
  paper evidence.
- `morphz_structured_projection/web` completed Context construction and prompt
  materialization but did not produce a complete official result file.
- Enterprise cells were not started.

Selected SHA-256 identities:

- no-retrieval manifest: `24f0fa9bbd3254dc21ff69e9117faaba0d84617bfe54f85e6ca7675af2e7e1d3`
- no-retrieval metrics: `ca061ac56664ff43f8633536056231db1bc22715a75817ee440952d54f0ef231`
- no-retrieval per-question records: `1204171928635db6813abd8ebeaca652ef918b2bfd202e1bfaac9a33e576c925`
- structured manifest: `c509e5594f2fa3654e24e4b371097262b783e2c48926071d45b9b4120a37fcba`
- structured prompt-build summary: `5fd185797a3d536f01fcbc69fcf1ddf1466c069258e2b6896fa90fa4ebd6d7e9`

No partial output from this run may be mixed with a corrected protocol.
