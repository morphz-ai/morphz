# Execution visibility and provenance

Status: implemented and verified, 2026-10-17. This supersedes any rule that
requires an input association merely to list an otherwise readable execution.

## Independent authorities

1. Runtime Thread, Activation, Job and immutable receipts own execution facts.
   Silence, missing annotations or an unresolved source do not erase them.
2. Current authenticated access owns read permission. Known Platform work still
   requires current project/input access. Unassociated work is readable in the
   global inventory only by its exact initiating Principal, in an existing Host
   Session with matching Context. Another participant, a shared Session, an ID
   supplied by the renderer or a missing Principal does not grant this access.
3. Runtime resolves provenance; Platform resolves project/object associations.
   An authenticated input, a parent Thread, an infer admission, an Objective
   creation and a committed Schedule trigger are causal evidence, not ACLs.

An unresolved association is represented by null project/conversation/input
fields, not a made-up project or a replacement activity. Such executions can be
inspected through an explicit read-only Runtime reference. The Host rechecks
the selected Thread's immutable identity and initiating Principal at each read,
and after asynchronous reads. This reference cannot steer, cancel, approve,
create terminals or read project objects. Existing exact project control
contracts are unchanged.

## Source audit

| Admission                                       | Authoritative causal path                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| Ordinary / parallel / interrupted input         | admitted input Event and immutable Thread root                                    |
| Directed supplement / merged input              | original Thread root; additional input remains its own durable Signal             |
| Spawned child / Thread Group                    | stored parent Thread, same Context/Session/Agent/Principal                        |
| Yao infer, including nested infer               | exact infer Event, Plan executor and parent Thread                                |
| Objective primary / adopted work                | exact generation and creation Event / creating Evaluation                         |
| One-shot / adopted Schedule                     | stored Schedule source and owning Thread                                          |
| Periodic occurrence and its descendants         | committed due Event, occurrence identity, Schedule owner and source               |
| Operator/system execution without a Human input | execution ownership and actual Schedule origin; input association may remain null |
| Human-created terminal                          | existing terminal resource ownership/scope, not a fabricated Agent Thread         |

The Runtime resolver is shared by Scheduler, exact source reads and bounded
execution inspection. It checks scope, identity, cycles and a bounded ancestry
depth. It never parses a prefix to guess a parent, uses a nearby timestamp or
changes the live execution graph to repair historical display.

## Storage and lifecycle

No new business tables, copied execution ledger, database migration or replay.
Existing Runtime stores and their indexed causal Event/Thread reads are the
authority on SQLite and PostgreSQL. Host activity remains a replaceable read
cache; source-null entries retain the real Thread ID and timestamps. Existing
bounded history, query limits and current permission fences remain in effect.
No tool-list changes or additional model calls are introduced.

Verification must cover source-null open/completed/failed work, read-only command
and result inspection, identity changes/revocation, cross-Principal/Context/
Session rejection, known inaccessible projects, all causal paths above,
history bounds and preservation of running work. Real-app acceptance reads
existing executions without replaying user messages or changing schedules.
