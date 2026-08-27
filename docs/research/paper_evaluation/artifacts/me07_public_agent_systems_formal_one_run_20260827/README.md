# ME-07 public Agent systems: formal one-run result

This directory contains the reportable artifacts for
`ME-07-STATE-Bench-public-agent-systems-v2`.

## Question and protocol

ME-07 tests whether experience learned from the same domain trajectories transfers
to held-out stateful tool tasks in three public Agent systems:

- production Morphz with Structured Context, Mind Frames, Relations, and Context
  transactions;
- Letta 0.16.8 as a complete open-source Agent Runtime using its native memory;
- a Mem0 2.0.19-backed reference Agent using add-time learning and vector search.

For each of three domains, every arm received the same 100 canonical training
trajectories and the same 50 held-out tasks. Each held-out task was attempted once
from an isolated clone of the corresponding frozen trained state. The formal batch
therefore contains 150 paired cells and 450 terminal trials. All arms used
GPT-5.6 Sol with maximum reasoning through the same CLIProxyAPI route. Terminal
failures were preserved and scored as zero.

The primary metric is `task_completion_pass@1`. It passes only when both the
deterministic final-state requirements and the judged conversational/procedural
requirements pass. This is an updated-evaluator STATE-Bench-derived comparison,
not an official historical STATE-Bench leaderboard score.

## Result

| System | Completion | State requirements | Task requirements | Mean UX | Terminal failures |
| --- | ---: | ---: | ---: | ---: | ---: |
| Morphz | 122/150 (81.33%) | 92.67% | 85.33% | 4.410 | 1 |
| Letta | 93/150 (62.00%) | 79.33% | 68.00% | 3.625 | 7 |
| Mem0-backed reference | 96/150 (64.00%) | 82.67% | 70.00% | 3.833 | 4 |

- Morphz minus Letta: +19.33 percentage points; task-clustered bootstrap
  95% CI [+10.67, +28.00]; Holm-adjusted paired sign-flip
  `p=0.0000599994`.
- Morphz minus Mem0: +17.33 percentage points; task-clustered bootstrap
  95% CI [+10.00, +24.67]; Holm-adjusted paired sign-flip
  `p=0.0000599994`.

This is a system-level comparison. It demonstrates a favorable learned-experience
transfer result for the complete Morphz Agent under this protocol, but does not
attribute the entire difference exclusively to Mind Frames: internal prompts,
scheduling, memory representation, and tool-loop behavior are part of each system
under test.

## Mind Frame transfer trace

A separate read-only audit made no model calls and did not rescore tasks. It
verified that:

- all three Morphz training Contexts reached revision 100 through 100 Context
  transactions;
- the frozen projections contained 144 active Mind Frames, 395 active Relations,
  and 795 retired objects in total;
- all 150 held-out tasks began from the exact frozen revision-100 Context for their
  domain;
- all subsequent snapshot versions and Context-transaction hash/version chains
  were valid;
- three held-out tasks performed six additional Context transactions, showing that
  active cognitive learning remained enabled within an isolated held-out task.

This establishes that trained structured cognitive state actually participated in
held-out evaluation. It does not, by itself, isolate the causal contribution of
Mind Frames from the rest of the Morphz Runtime.

## Token accounting correction

The original Morphz raw counter (`3,555,918,978`) was not a held-out usage total.
Each evaluation database cloned a 100-episode trained database, and the first turn
reported its cumulative historical usage again. The formal summarizer now
subtracts the immutable domain training baseline once per scored Morphz clone and
retains the raw value for audit. Correct held-out Agent totals are:

| System | Held-out Agent tokens | Scope |
| --- | ---: | --- |
| Morphz | 138,942,200 | cumulative clone baseline subtracted |
| Letta | 40,143,631 | provider-reported held-out usage |
| Mem0-backed reference | 7,364,662 | provider-reported held-out usage |

Training cost is excluded from all three arms. These totals are a descriptive
end-to-end engineering profile, not the primary mechanism score and not evidence
that any one state representation intrinsically requires the observed volume.

## Files

- `formal_summary.json`: formal scores, paired statistics, integrity Gate, and
  corrected Token accounting.
- `RESULT.md`: compact machine-generated result.
- `mind_frame_transfer_audit.json`: 150-task read-only trace audit.
- `MIND_FRAME_TRANSFER_AUDIT.md`: compact trace summary.
- `formal_run_complete.json`: terminal/scored job accounting.
- `run_manifest.public.json`: non-secret frozen run identity.
- `SHA256SUMS`: artifact checksums.
