# Native Session IO live probe acceptance

This is test-only evidence, not an application deployment and not a multi-model
reliability claim. The configured real provider, routing, account authority,
authentication, token measurement, immutable binding, request options and opaque
continuation are forwarded by `live_native_probe_client.rs`.

Do not run Cargo concurrently with the coordinated build. When the build slot
is available, first run the example's two offline injector tests:

```sh
./scripts/cargo-dev.sh test -p morphz --example session_io_runtime_probe
./scripts/cargo-dev.sh build -p morphz --example session_io_runtime_probe
```

Then run the built example in separate processes with the approved config path
and actual DeepSeek alias, without modifying that config or opening a user's
database:

```text
session_io_runtime_probe CONFIG_PATH MODEL_ALIAS CASE [on|off]
```

Each process creates disposable synthetic files and a fresh Runtime SQLite
database and Secret Store metadata/audit path. The configured credential alias
is supplied only to the child environment; no user's credential catalog is
loaded or changed. No user conversation, file, task ID or failed business arguments are
sent. The example preserves the advertised native tool directory; it rejects an
unexpected tool name at the test adapter boundary before Runtime dispatch.
Provider `max_retries` is zero only in the disposable config. Physical requests
are bounded to the case's declared count. An adapter
precondition failure is terminal, not a request for another model attempt.

| Case | Mode | Physical requests | Required evidence |
| --- | --- | ---: | --- |
| `plain` | on, then off | 1 each | Correct ordinary reply, no tool call, incremental body equals final reply |
| `review` | on, then off | 2 each | One actual read, file-only nonce in answer, stable directory, body has no JSON output shell |
| `annotated-review` | on | 2 | Same-call title/intent, no annotation-specific call or final result-generation request |
| `progress` | on | 2 | One actual progress read, correct location and nonce, title/intent |
| `discuss-script` | on | 2 | Original 2.3.0 Harness; deterministic read-workflow once, native list once, nonce in direct final body, no extra rewrite inference |
| `injected-invalid-arguments` | on | 3 | Fault-injection sequence below |

Additional existing `memory`, `infer` and `infer-record` cases retain real
Context-commit and exact typed-value checks. Caller-declared JSON is still
validated as its original business schema; ordinary Chat is not forced into it.
Compare directory hashes for `review on` vs `review off` as well as within each
work continuation. Annotation quality and successful business delivery are
different gates: ordinary on-mode work cases require title/intent; the injected
fault also destroys the first call's optional metadata and must still recover.

## Explicit fault injection, not a natural DeepSeek failure

1. The first real DeepSeek request must return exactly one originally valid
   `session_io_probe_read` call for `review.txt`.
2. Before Runtime receives it, the test adapter holds that one response, proves
   streamed argument bytes equal the completed arguments, then replaces them
   once with `{"path":"review.txt",{"intent":"TEST injected malformed argument"}}`.
   This deliberately introduces an unnamed object after a field. Its native
   call ID, body, usage, continuation and all non-argument stream events remain
   unchanged. No model response is fabricated.
3. Runtime must emit one durable `INVALID_TOOL_ARGUMENTS` receipt with
   `executed:false`, specific JSON syntax detail and the original call ID.
   It must not create a Job or enter the tool body for that rejected call.
4. The second **real** model request must contain the specific rejection,
   original call ID and correction instruction. Real DeepSeek must submit a
   corrected native read. Only this read may create a Job or enter the body.
5. The third **real** request receives that actual file result and finishes an
   ordinary body containing the unknown file nonce. Its public stream must
   exactly equal the delivered body. Thread must be terminal `completed`.
6. Exactly three real requests, one successful read/Job, unchanged native tool
   directory, no health-probe/repair/relay request, no separate annotation call.

The JSON report labels this case
`real_provider_with_explicit_once_only_argument_fault_injection`, records
`natural_model_failure:false`, the unchanged call ID, original argument hash
and injected argument bytes. It must never be presented as a spontaneously
reproduced DeepSeek bug. Passing this probe does not replace original-app
verification or prove reliability for deferred Qwen/Kimi/GLM routes.

## 2026-10-20 live evidence and fixture correction

The first matrix is preserved at
`/tmp/morphz-full-app-regressions-20261020.OxfoEB/native-v3-live-recovery-1`.
Seven of eight cases passed, including the three-real-request injected-error
recovery. `discuss-script` attempted a third request and hit the unchanged
two-request limit. Its initial error report did not preserve intermediate
responses, so the exact first-run tool sequence cannot be reconstructed.

After adding failure captures only, the explicitly authorized second diagnostic
run is preserved at `native-v3-discuss-diagnostic-2` in the same directory.
It establishes the actual sequence: native `list` succeeded; the second real
response requested `host_morphz` action `read` for the outline body; the synthetic
Host rejected it because it only implements `read-workflow` and `list`; the
normal error continuation would have made the third request. This was not an
extra summarization inference or a JSON parse failure.

The new fixture introduced the inconsistency: adding the unknown nonce changed
the input from discussing the directory summary to “read the story in the
directory,” while leaving the Host's supported actions and two-request
expectation unchanged. The original Harness explicitly says the directory is
not the body and permits reading more material when needed.

The approved fixture correction restores the intended bounded case: list once,
answer only from its summary and unknown nonce, do not read the body. The real
Harness, native tools, production prompts and two-request acceptance limit are
unchanged. A third diagnostic run is allowed only after this concrete correction,
not as a retry-until-pass loop. This summary-only fixture does not cover reading
the actual document body; that remains an original-application acceptance path.

The corrected third diagnostic ran once and passed:
`native-v3-discuss-corrected-3/discuss-script-on.json`. It finished in 55,762 ms
with exactly two real `deepseek-flash` requests, no blocked third request, no
health probe and no unobserved completion entrypoint. The actual Host calls were
exactly `read-workflow`, then `list`; no document body was read. The one native
list carried a title and intent, and both requests retained the same tool
directory hash. The second response was the original Harness's `ScriptIntent`
business record (`execute:false`, `task:""`), not an annotation wrapper.
Runtime delivered its reply directly: 164 public chunks assembled to the exact
final body, including the unknown summary nonce. No final-result annotation or
extra rewrite inference was generated.

The corrected example's two offline injector tests passed before that run.
The tested executable SHA-256 was
`ec3e2cf715c52faad601657de9be9af57086a767aaee5fc2e30952b01721b257`.
This closes the diagnosed fixture failure; it does not rewrite the first
matrix as an uninterrupted eight-of-eight run. The first matrix remains seven
passes and one failure, the second diagnostic remains a failure, and this
post-correction diagnostic is a separate pass. No original application was
restarted or updated by this probe.
