# DEMO-001 GPT-5.6 Sol route readiness

Date: 2026-08-17 (Asia/Shanghai)

Result: `ready_for_frozen_v2=true`; `real_completion_called=false` at the time of this receipt.

Runtime starting point: `paper-eval-runtime-v2` / `03a32f864a3c38026672b4076855137e0bbb5627`. The later selective Demo commit/tag is a separate identity and must contain the runner, scorer and frozen fixtures explicitly.

Read-only checks established:

- logical route: `gpt-5.6-sol`;
- physical model: `gpt-5.6-sol`;
- Provider instance: `codex-subscription`;
- protocol: `openai-responses`;
- adapter: `openai-codex`, version `1`;
- route fallback: `false`; candidate count: `1`;
- persisted catalog source: `remote_provider`;
- persisted catalog observation: `2026-08-05T11:57:53.070544Z`;
- account state: ready/authenticated at audit time;
- requested reasoning: `max`;
- Morphz request path retains `reasoning.effort=max` for this adapter;
- host capability catalog lists `gpt-5.6-sol` with `max` support.

The audit deliberately did not invoke `model route test` or `refresh`: those paths also send a real `MORPHZ_OK` completion. End-to-end acceptance of `reasoning=max` is therefore recorded by the first frozen smoke, not inferred as a Provider response.

The subscription adapter strips server-side `max_output_tokens`; the frozen protocol records uniform Harness acceptance caps and `provider_max_output_tokens=stripped_unavailable`.

No Gemini call occurred. Any runtime binding that differs from exact `gpt-5.6-sol` is a hard pre-request stop.
