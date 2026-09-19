# Yao authoring ergonomics: implementation and acceptance

Status: implementation, real-model fixtures and original Desktop acceptance verified
(2026-09-20). No release or commit is implied.

## Scope and decisions

The Script Studio case exposed repeated boundary adapters, not a need to replace Yao's
dual evaluator or introduce an application-side workflow engine.

- Preserve ordinary `infer (returns T) BODY`: BODY remains assignable to T.
- Add explicit `infer (produces T) BODY` for a model-owned semantic result described by
  the complete BODY. Unlike `returns`, this declaration gives the desired result type,
  not an assertion about BODY's deterministic value. BODY is still fully analyzed for
  names, captures, effects, capabilities and budgets. The model returns ordinary JSON;
  Runtime strictly constructs T from that JSON before resuming the parent.
- Add pure `from-json T EXPR`, `to-json EXPR`, and heterogeneous `json-object`.
  These are explicit data adapters, not permission to cast arbitrary JSON into Ref,
  Program or Runtime authority-bearing values. Existing `decode` and nominal wire
  encodings stay unchanged. Extra/missing fields and wrong types are errors.
- Add triple-quoted block strings with exact contents (no implicit interpolation or
  dedentation). Formatting must preserve string values, comments and canonical identity.
- Add local-only `morphz harness check` and `morphz harness format` commands that do not
  initialize storage, install a package, contact a provider or execute a tool.
- Improve boundary diagnostics with field paths and module/function context. Existing
  source spans and machine-readable diagnostic categories remain available.
- Publish the migrated Script Studio as a new immutable version. Preserve legacy
  packages byte-for-byte and keep workflow decisions in Yao.

No unbounded loops, recursion, implicit capture, weaker authorization, general retry
engine, new UI or automatic adoption of generated drafts is included. Bounded iteration
remains a candidate for a second demonstrated use case.

## JSON boundary representation

Primitive values, lists and maps use their ordinary JSON forms. Named records use an
object of their declared fields, without internal `$yao` tags. Named unions use
`{"case":"Variant","fields":{...}}`; Option uses `{"case":"none"}` or
`{"case":"some","value":...}`; Result uses `{"case":"ok|err","value":...}`.
These tagged data encodings avoid ambiguous null/optional or union cases. A Json field
is opaque: converters must never interpret embedded `$yao` objects as authority.

## Acceptance checklist

- [x] Core parsing, typing and canonical identity, including legacy compatibility.
- [x] Strict nested JSON conversion, field-path diagnostics and authority rejection.
- [x] Structured infer full-body/capture/effect checks and durable resume/failure tests.
- [x] Block strings and comment-preserving idempotent formatter tests.
- [x] Read-only offline Harness check/format, with useful module diagnostics.
- [x] Script Studio migration, ordinary discussion, draft/review/revision and negative cases.
- [x] Original Desktop/Runtime verification preserving profile, credentials and existing data.
- [x] Documentation, language card and reproducible verification results.

Evidence is recorded below as tests are actually run; a checked box is not a substitute
for live model or application evidence.

## Implementation and compatibility

The official example now binds `morphz.script-studio@1.3.0`. Intent, product and review
results use `produces` and declared records; submission objects use `json-object`.
The manual model-JSON-to-record decoder and repeated schema prose are removed. Discussion,
authorization, conditional review/revision, human adoption and two-pass limits stay the same.
The former 1.2.1 file is retained at `application/harnesses/legacy/script-studio-1.2.1.hns`,
byte SHA-256 `31118476c3dedef7c95a18d2b1545b9c8ed749f7fca113e1258fe8c941246aaa`.
Older inputs and retries retain their pinned package; no stored input is rewritten.

Real package installation exposed an older metadata serialization defect: raw newlines
were persisted inside ordinary quoted strings, which the typed parser correctly rejected
on reload. Package persistence now uses a loadable escaped representation, while the
historical logical canonicalization used for artifact identity is unchanged. The initial
failure remains in `morphz-script-runtime-HCK06b`; it was not relabeled as a passing run.

1.3.0 logical artifact hash:
`sha256:a118d6bcd5fc57c4ce1e92f7afb03d8396af6b1f31f25c34f9874bc67543611c`.
Program hash:
`sha256:3d5e0b9dec69041a11eeead8522061de1017fde5a07a6664b5b2359790527ed1`.
Formatting and storage reload preserve these identities.

## Executed checks

- `cargo test -p yao-lang`: 56 unit tests and 10 authoring integration tests passed.
- `cargo clippy -p yao-lang --all-targets -- -D warnings`: passed. Adding function
  diagnostics initially crossed Clippy's error-size threshold; boxing the optional name
  preserves the wire representation and avoids enlarging every error result.
- Final `cargo test -p morphz --features experimental-session-io --lib -- --test-threads=4`:
  1389 passed, 10 ignored, in 86.30 seconds. Ignored tests are not acceptance evidence.
  The binary test suite passed 31.
- The preceding default-parallel repeat passed 1388 but hit the existing five-second
  deadline in `llm_can_create_one_idempotent_objective_and_current_evaluation_is_adopted`,
  alongside SQLite slow-query warnings. That test passed alone in 0.56 seconds and in the
  complete four-worker repeat above. Its timeout and assertions were not weakened; both logs
  are retained as `runtime-tests-final` and `runtime-tests-bounded` under the log prefix below.
- After the diagnostic representation fix, the offline authoring suite passed 5/5,
  including a directory package's innermost function path and original source line.
- `cargo check --workspace --all-targets`: passed, including CLI docs, evals, extensions
  and experimental crates that consume the language API.
- Application `npm test`: 336 passed. `npm run build` passed, including type checking;
  Vite still reports its existing large-chunk warning.
- Offline `harness check` with the supplied Host schema reports valid, verified static
  tool contracts and no unresolved schemas; `harness format --check` exits successfully.
- Final synthetic workflow run: `morphz-script-runtime-A77IvF/result.json`, 12 scenarios,
  55 model fixture calls. Installs all legacy packages plus 1.3.0, reopens actual SQLite,
  uses the real Runtime and Unix Host, checks no-write discussion/deferred intent,
  0/1/2 reviews, both revisions, four blocked stages and malformed typed output.
- Crash matrix: `morphz-script-recovery-VkHVAc/summary.json` and final repeat
  `morphz-script-recovery-NtJDdW/summary.json`, both 16/16. These terminate only fresh
  test Runtime children at model/Host boundaries. Same input and original Plan resume;
  completed stages do not replay and lost submission receipts do not duplicate candidates.
- Canonical source/protocol language checks and `git diff --check` pass. The repository's
  diagnostic-log policy check still fails at the two pre-existing calls in
  `morphz/src/memory/remote/timing.rs:178,216`, verified against HEAD; this unrelated file
  was not changed and the overall gate is not reported as passing.

Evidence directories named above are under the system temporary directory printed by
each script. Runtime and application test logs are `/tmp/morphz-yao-authoring-*-20260920.log`.
The Application CI workflow now includes offline checks, the synthetic workflow and the
crash matrix. This is local verification, not a claim that GitHub CI has run.

## Real-provider evidence

`morphz-script-quality-YVhJt9` ran the current 1.3.0 package with the existing
`gpt-6-astra` provider on six synthetic, authorized fixtures. All mechanical checks passed;
the isolated Host and Runtime were closed normally. No production input was retried.
The full candidate/review texts, source materials, stage sequence and receipts were then
inspected, rather than treating model self-review as acceptance:

- Scene: `intent → create → review → revise → delivery`; review found unclear tool/drawer
  continuity and an unnecessary smoke effect. Revision repaired those details and retained
  the two characters, one location, reciprocal concessions and unresolved trust.
- Dialogue rewrite: only four dialogue lines changed, with all non-dialogue text preserved.
- Adaptation: the actual source was read, the inscription and two sounds retained, and the
  box left closed. Newly invented action/dialogue was identified; source injection caused
  no unrelated artifact or approval.
- Outline: three distinct causal installments rather than three repeated secret reveals;
  no hidden malfunction or additional character was introduced.
- Continuity: three supported findings (password knowledge, injured hand, lost key), with
  actual quotes; the intentionally unresolved envelope was not reported as a defect.
- Impact: only the powered opening at 19:00 was treated as inconsistent. Pressing the
  button and approaching the door were retained. Both saved review and delivery disclosed
  one unselected downstream item and did not reveal its protected text or guess old rules.

These are bounded results on one configured model, not independent professional editorial
certification, guaranteed duration, provider-wide compatibility or original Desktop evidence.

## Original Desktop acceptance

After unlock, the original Morphz.app was closed through its normal menu. The idle original
Runtime was stopped gracefully, and the verified binary was started at the same 18089 endpoint
with the same databases, configuration, credentials, Host scope and profile. The launcher and
environment files were not rewritten. The previous binary remains available. Both database
backups, configuration hashes, installation/loading receipts and before/after checks are in
`/tmp/morphz-yao-authoring-deploy.AgYSnf`; the files do not publish credentials.

The loaded binary is `morphz-yao-authoring-20260920`, PID 61839 at acceptance, SHA-256
`2f0827aa59b897c17fb67223a3a2a6c688ea7f4b8b407a1a59fa2d0f952023c5`.
All six immutable Script Studio versions are available. `verified.json` first confirmed that
the restart itself changed no original workspace objects, inputs, deliveries, Sessions or
execution history. The visible tests then used the existing production
`TEST 专业编剧 Harness 验收 0919`, scene `场1：两个人的操作台` v1 and parent episode v2:

- Discussion input `27644ca9-5256-41cb-ab40-ac259496d675` ran only `discussion`, answered
  the creative question, and left all three original candidates and formal material unchanged.
- The generation dialog's prepare action created only an editable draft with fixed references;
  it did not send. One explicit send created input `c2b7296e-6e81-4c68-9c5b-db677b5ccb10`.
  Its actual stages were `intent → create → review → delivery`; review found no substantive
  defect, so no unnecessary revision was run. Intent/product/review persisted the strict JSON
  decoder contract, and all model children had no physical tools.
- Candidate `e3d909a5-d51d-5d22-99b4-3e31ce201866` was saved exactly once, still `pending`,
  based on scene v1 and parent v2. Its full text and review were inspected; the visible screen
  was left on `候选 4` with this new candidate first. No adoption, approval or locking occurred.

`manual-acceptance.json` records both succeeded parent Plans, the exact 1.3.0 artifact hash,
stages and full new candidate. The original 56 inputs, old deliveries and Session events,
formal draft versions, approvals, three old candidates, unrelated project/content objects and
old threads/activations/jobs/Plans remain unchanged. Only the two named test inputs, their
execution records and the one pending candidate were added. This verifies the original visible
Desktop flow; the 16-point crash tests remain isolated-process evidence, not crashes injected
into the user's Runtime.
