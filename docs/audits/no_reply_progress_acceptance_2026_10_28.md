# Progress text may accompany a lifecycle control

The user explicitly confirmed that a friendly explanation while waiting is
valid output. Ordinary text alongside `no_reply` must not fail delivery merely
because text is present. Format, authorization and execution-consistency
validation remain separate from whether a model chooses to explain its work.

## Repair

The 16:10 failure was a successful Kimi response rejected by Runtime with
`no_reply must be sole call with no ordinary content`. Its source contained the
explanation “读取任务转入后台执行，等待其完成事件。” and one finite wait control.

Commit `d6e6bc37d93a2dbb9c26b061733cf0da08b22a9e` removes the text prohibition
from the normalizer, terminal classifier and historical explicit carrier, and
updates the corresponding model-facing instructions. It preserves the exact
ordinary text through the existing `chat/progress` publication before applying
the control's independent waiting/silence outcome. Text is not fabricated,
discarded, executed or treated as Objective completion. This does not add a
model correction request for a progress explanation.

Conflicting work/control calls, malformed arguments, unauthorized effects and
waits without a live Runtime event are still checked for their actual format
or state inconsistency. The prior negative fixtures now use genuinely
conflicting controls; they still prove that no work executes on rejection.

## Validation

- Release-mode focused tests: 9 library tests, 3 attempt-loop tests and 2
  conflicting-control tests passed. No test was disabled or ignored.
- The full background wait/progress/completion regression additionally passed
  three consecutive runs. A test-controlled completion gate avoids using
  timing luck to ensure the Job is still running at the wait boundary.
- Native controls with metadata were tested with annotations enabled and
  disabled; the body remains intact and the wait arguments retain their value.
- `cargo fmt --all -- --check` and the staged whitespace check passed.

The release binary SHA-256 is
`399fc7327a2e6efd6b3f9ecaab675f6d940c3bd529519ee06ce70406b16ec257`.
The original development Runtime reported code commit `d6e6bc37d93a` after
normal replacement. The 20:48 local-time switch interrupted zero active
Evaluations and zero running Jobs. A fixed-read SQLite snapshot was backed up
before switching, and the original sessions and Provider/account/model
configuration were compared and preserved.

## Original Desktop acceptance

One clearly labelled TEST was sent in the original main conversation with its
existing Context and `kimi-k3-256k · max` selection. It requested one finite
`sleep 60; printf MORPHZ_WAIT_DONE` background command, a natural-language
explanation alongside `no_reply(mode=wait)`, and a final `MORPHZ_WAIT_OK`.

The 21:04:46 response containing both the explanation and wait was accepted.
The explanation was visible in the original Desktop, the Thread waited, and
the actual background Job succeeded with exit code 0. The durable record has
one `exec` admission and one corresponding `exec/background` Job; the command
was not executed again. The same Thread continued and delivered
`MORPHZ_WAIT_OK` at 21:06:47.

After the physical Job had already finished, Kimi separately proposed another
wait. The existing state-consistency correction rejected that stale wait and
the model then returned the final text. That was one model-authored repeated
progress explanation, not a duplicate command or a rejection of accompanying
text. This live case is not claimed to have zero total correction requests.
The deterministic background regression separately verifies the zero-retry
valid wait path.

No full CI or GitHub push was part of this local Runtime repair. The acceptance
covers this progress/control combination, not every provider or output shape.
