# DEMO-001 Roadshow Protocol — frozen-v2

> Frozen: 2026-08-17 (Asia/Shanghai)
>
> Purpose: `roadshow_demo`
>
> Paper statistics: excluded

## 1. Question and arms

DEMO-001 tests whether an operating Agent can execute the only correct ORBIT-42 production release after concurrent updates, cross-Session continuation, Worker replacement, and late conflicting evidence.

The three arms use the same model, evidence semantics, business tools and task requests:

1. `persistent_messages`: durable append-only event history; active prompt uses the frozen continuous-suffix selector.
2. `summary_json_memory`: the same model maintains one bounded JSON memory from prior valid memory plus complete new events.
3. `morphz_structured_context`: evidence becomes durable Observation records; the same model proposes Context transactions; the Harness validates schema, permissions, source references and supersession before atomic commit; business calls receive an authorized task projection.

The correct final action is hidden from every model call and is checked only after `commit_release`.

## 2. Frozen provider and operational budgets

- Logical route and physical model: exact `gpt-5.6-sol`.
- Provider route: configured `codex-subscription`, OpenAI Responses, one candidate, no fallback.
- Reasoning: request `max`; record the requested value and whether the call succeeds. Do not claim Provider echo when unavailable.
- Sampling seed: unsupported/not sent; `42001..42005` are paired cell identifiers only.
- Active-input cost tier: 8,192 `o200k_base` tokens, including system, tools, current request, selected state/history and prior tool transcript reserve.
- Business output acceptance cap: 512 tokens. Maintenance output acceptance cap: 1,024 tokens.
- The Codex subscription adapter strips server-side `max_output_tokens`; these are uniform Harness acceptance limits and the manifest records `provider_max_output_tokens=stripped_unavailable`.
- Wall-clock limit: 180 seconds per model call; 900 seconds per run.
- Business calls: exactly 3 per completed run. Maintenance calls: Message 0; Summary/Morphz 2 in Normal and 4 in Pressure on the normal path. One counted repair is permitted per failed maintenance result.
- Cost attribution: `subscription_not_monetarily_attributed`, never zero-cost.

No Gemini model may be called. Model or route mismatch is a pre-run failure; no silent fallback is permitted.

## 3. Frozen evidence and load levels

Canonical fixtures are generated deterministically by `roadshow_demo_001_protocol_planner.py`:

- Normal: 43 events, 32 fixed business-history records. All 37/41/42 prior events fit at Stages 2/4/5.
- Pressure: 139 events, 128 fixed business-history records. The selector retains 79/77/74 events and omits 54/60/64 complete early events.

Stage 1 compliance updates retention and timezone but does not repeat the still-active `NEVER-LOG-SECRETS` rule. Arrival order never establishes authority. `superseded` and `archived-untrusted` records are historical and cannot restore state.

The frozen canonical hashes are recorded in `token_selector_report.json`; file-byte hashes are recorded by the tagged commit and each run manifest.

## 4. Selector and state maintenance

Message selector:

1. reserve system, full common tool schemas, current request, Provider wrapper and earlier report transcripts;
2. scan prior complete events newest to oldest;
3. stop at the first event that does not fit;
4. reverse selected events to chronological order;
5. never summarize, keyword-skip, retrieve from another arm or move the boundary after observing results.

Summary and Morphz use the same 4,096-new-evidence-token maintenance Gate, 2,048-token durable active-state limit and one counted repair. Maintenance inputs, outputs, time and usage are included in the Arm total.

Morphz projects only the Context objects allowed for the requesting Principal/Session/task and restricts writable objects. A shared authoritative cognitive domain is not unrestricted data sharing.

## 5. Common tools and scoring

`report_current_state` uses the same seven-field schema in all Arms and is allowed exactly once at Stage 2 and once at Stage 4. It records a receipt only and gives no correctness feedback.

`commit_release` is allowed at most once, only after the final action request, and gives no correctness feedback. The hidden scorer requires exactly:

```json
{
  "project": "ORBIT-42",
  "version": "v3",
  "port": 9443,
  "endpoint": "/v3/events",
  "retention_days": 45,
  "timezone": "Asia/Shanghai",
  "security_rule": "NEVER-LOG-SECRETS"
}
```

Primary metric: exactly one correct final action. Secondary metrics: stale-state error, cross-Session state, concurrent Thread terminal counts, equivalent Worker replacement without duplicate external action, provider-reported usage, uncached-equivalent local input tokens, call counts and wall-clock time.

## 6. Usage, failures and artifacts

Every call stores Provider raw usage when exposed. The primary token comparison reports both:

- `provider_reported_total_input_tokens`;
- `uncached_equivalent_input_tokens`, recomputed from the complete actual Harness request with `tiktoken 0.12.0 / o200k_base`.

Cached reads/writes, output and reasoning tokens are separate. Missing Provider fields are `unavailable`, never guessed.

Failures are classified as `service_failure`, `model_outcome`, `budget_failure`, `system_failure`, `harness_failure`, or `live_presentation_failure`. Only service failures may be appended to the paired queue, at most twice. Model outcomes, missing/wrong commits and budget failures remain results.

Artifacts use `purpose=roadshow_demo`, `demo_id=DEMO-001`, `protocol_version=frozen-v2`, and never enter `ME-*` directories. A valid run records fixture, prompt/state-contract hashes, model binding, requested/accepted parameters, raw usage, local token counts, trace, ObservedRun, score, code commit and demo tag.

## 7. Execution gate

Runtime source baseline is `paper-eval-runtime-v2` at `03a32f864a3c38026672b4076855137e0bbb5627` (`feat: add durable session coordination`). Historical rewritten v1 equivalent: `cbfc540cedcdba8fba2dcbfbe6f37f1cc37d6df5`. This identifies the Runtime starting point only; it does not claim to contain the uncommitted Demo assets.

The frozen tag must point to a selective clean commit containing this protocol, both fixtures, prompt/state contracts, runner/collector/scorer and queue. The pre-existing dirty worktree is recorded separately and is not represented as part of the tag.

After tagging, execute only Normal `pair_cell_id=42001`, one run per Arm. Review the three smoke artifacts before authorizing the full 30-run batch.
