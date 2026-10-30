# Provider wait: retained incident and public caller contract

Date: 2026-10-31, Asia/Shanghai. Investigation baseline: local `main`
`fda507d3efac936e9172cee61fc3c1054eee7cc0`.

## Findings

The retained space-data-quality incident confirms an application integration
gap: its old waiter waited only for a terminal logical Thread and did not
consume durable `provider_wait`. Sixteen application workers consequently
remained occupied. All sixteen Native Activations had already completed and
released their execution leases; this is not evidence of sixteen leaked Native
worker slots. The project's reported bounded cancellation fallback is separate
from normal Provider recovery.

The failed package was Runtime `0.1.0`, commit
`78518676e4dec79870b57f6e3aebb7286b1d12bd`. Both that source and the local main
baseline already contain independent Provider health monitoring. Keeping a
logical Thread open with a pending resource dependency is intentional. A
physical Model Attempt reporting `failed`, `terminal=true` and
`continuation_pending=false` does not close that separate logical Thread.

There are no retained `runtime/resource_available` or
`runtime/provider_recovered` events. This alone does not prove a recovery bug:
the record does not establish that the upstream route recovered. The retained
wire ledger contains 50 requests: 38 have business/initialization attribution;
12 lack those IDs and are health-probe candidates. All twelve fail with
`Network is unreachable`. There are 18 such network failures in total. These
candidate records support unsuccessful probing, but are not treated as a
complete time-stamped history of every health request. Native stdout/stderr
logs are empty, so the historical probe schedule cannot be reconstructed fully.

The original report and exported evidence were read without modifying the
original SQLite database, WAL or failure records. The evidence export SHA-256
is `aa73e1f53195bf3f9d79107cc8dde1620af3201027b21ca67c716ff08e895403`.
The report SHA-256 at investigation time is
`58233668d519f3e6f62434cd6c358a249df6afb9f6b96e133bebb5bfcaeec9c5`.

## Recovery ownership

`Orchestrator::record_provider_failure` starts a small independent monitor;
it does not require another ordinary application request. One monitor is owned
per circuit resource. It probes the failed physical binding when available,
retains waiting Contexts, and backs off after independent probe failures.
Current backoff may reach 300 seconds, in addition to probe latency. A waiting
caller's deadline must not be extended by that schedule.

A successful probe publishes `runtime/resource_available`. The Thread handler
matches persisted resource dependencies and validates the owning Thread's
Context, lifecycle and generation. The Kernel/store satisfies the exact
dependency and commits the `runtime/provider_recovered` wake atomically; normal
dispatch resumes the same logical Thread. The wait outcome also re-arms
monitoring after its dependency commit, covering an early-probe race.

Resource keys are opaque Runtime identities. Dependency generation, Thread
generation and the monitor's circuit generation are different namespaces;
callers must not compare them as one counter or invent resource-available
events themselves. Operator cancellation advances the owning Thread's fence;
subsequent health evidence cannot authorize a cancelled generation to execute.

Relevant production sources: `morphz/src/orchestrator/orchestrator.rs`
(`record_provider_failure`, `publish_provider_wait`,
`handle_thread_resource_available`), `morphz/src/scheduler/snapshot.rs`
(`thread_phase_with_dependencies`) and `morphz/src/web.rs`
(`handle_get_thread_detail`, `handle_control_thread`).

## Application adaptation

1. Preserve the accepted input's Session, Context, root Event and actual Thread
   identities. Consume both `chat/progress` and `runtime/provider_wait` when
   `payload.disposition == "provider_wait"`; repeated suppressed notices use
   the latter topic. Correlate by the original root/Thread, not the latest
   Session message. A physical failure alone is not a logical terminal result.
2. Subscribe to the authenticated `/ws?session_id=...` stream. Reconnect using
   bounded persisted catch-up through
   `GET /api/sessions/{id}/events?after_sequence=...&root_turn_id=...&limit=200`.
   Advance that cursor only for durable sequenced Events. Do not scan a whole
   database or repeatedly fetch all history to discover waiting work.
3. Inspect one exact aggregate with
   `GET /api/contexts/{context_id}/threads/{thread_id}`. The public shape is
   `snapshot.thread.lifecycle` and `snapshot.phase`; it is not the SQLite
   column name `threads.status`. An open lifecycle plus phase `waiting` is not
   a terminal failure. Use the provider-wait Event to distinguish this resource
   wait from legitimate tool, child, approval or `no_reply` waits.
4. Choose an explicit business policy. An asynchronously retained waiting task
   need not occupy a business compute-worker permit. Keep its identity and
   event observer; do not resend it as a new task on each notice. If the
   business policy declines to wait, or the original absolute deadline expires,
   cancel the exact Thread rather than pretending the logical task failed or
   leaving it eligible to resume later.
5. Cancellation uses
   `POST /api/contexts/{context_id}/threads/{thread_id}` with
   `{"action":"cancel","expected_revision":N,"reason":"original deadline"}`.
   Verify `updated=true`, the matching Thread ID and lifecycle `cancelled`.
   Re-read that same aggregate on a revision conflict. Release the application
   worker after the acknowledged transition; preserve partial output as
   incomplete/unknown, without adopting it as a domain judgment. Keep the
   original deadline across recovery and reconnects.

The retained `RequiredJsonTransport` also rewrites every tool-free request,
including health-probe candidates, to a JSON carrier and overrides configured
reasoning settings. That can defeat the intended small independent probe, but
is not established as the cause of this network outage. A narrow project-side
adaptation is to apply business schema/reasoning rules only to explicitly
registered business-schema bindings (`reply_schema_token`), preserving control
requests rather than inferring business intent from the absence of tools.
Validate that adaptation against the actual proxy and upstream before claiming
real-service recovery. Do not alter Runtime error classification merely to
hide the proxy boundary.

## Controlled verification

`scripts/verify-provider-wait.py` uses only Python's standard library, an
ephemeral loopback Provider and a separate synthetic Runtime home/database. It
retains failures and receipts and stops only its own child process. The bounded
API polling in this script is test synchronization, not the production caller
design above. No real model, shared Runtime, Docker or space-data-quality pack
was restarted or executed.

The actual tested executable is `morphz 0.1.3 (git d92261f921e2)`, SHA-256
`1ee2a0b8638b4a444218cb9171cfd3c89c0b99a5cb0e0be365bf798bfcc818f4`.
`git diff d92261f9..fda507d3 -- morphz/src Cargo.lock morphz/Cargo.toml
morphz/build.rs` is empty: its Runtime production sources match the local main
baseline. This explicitly records the build stamp rather than relabelling the
binary as a new build.

| Scenario | Waiting / released Native leases | Recovered original Threads | Acknowledged cancellations | Follow-up |
| --- | --- | --- | --- | --- |
| HTTP 502, then healthy upstream | 16 / 16 | 16 | 0 | Passed |
| Partial SSE then disconnect; cancel four before recovery | 16 / 16 | 12 | 4 | Passed |
| Unavailable route; cancel all before restoring upstream | 16 / 16 | 0 | 16 | Passed |

Recovery happens before sending any further user input. Every surviving Thread
keeps its generation and emits exactly one complete synthetic reply. Partial
SSE text never becomes a reply. Cancelled owners are checked again after
recovery and the follow-up request to catch late resurrection. Each case keeps
one fixed 120-second outer deadline. The final script, including cancellation
receipts and late-state checks, passed all three cases; an earlier successful
three-case run is also retained. The initial harness run failed on its mistaken
API `status` field assertion; it is retained and is not labelled a Runtime bug.

Seven existing release regressions also passed: four Chat output-limit cases,
opaque tool continuation, partial reasoning before Provider failure, and the
background-job `no_reply` progress/wait/resume case. No production terminal,
continuation, tool or no-reply rule was changed for this investigation.

Reproduce with an existing native release executable:

```sh
python3 scripts/verify-provider-wait.py \
  --binary /absolute/path/to/morphz \
  --output /absolute/path/to/a-new-isolated-audit-directory
```

The original Linux package, actual SSH route/proxy, original upstream model,
all crash windows and the space project's complete business pack were not
rerun. Thus this is a verified caller contract and current-source recovery
check, not end-to-end business acceptance or proof about every failure mode.
No Runtime production patch or deployment is claimed. This local change adds
the reusable regression and investigation record; it is not a release or push.
