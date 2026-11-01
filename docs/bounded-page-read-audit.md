# Product read audit — 2026-11-01

Status: in progress. This inventory is not a claim that every path has passed.
The rules in the root `AGENTS.md` cover every page and its downstream reads.
An addressed object, a bounded metadata page, an indexed aggregate and an
explicit content chunk are different read contracts; a parent-page LIMIT does
not by itself bound dependent history.

| Surface / owner | Contract already present | Findings / work still to verify |
| --- | --- | --- |
| Dashboard Dialogue | newest conversation page and sequence delta; upward continuation | healthy 15 s Session refresh; hidden-page Session fanout; scheduler history re-fetches an expanding prefix |
| Dashboard Scheduler / expanded Thread | bounded parent snapshot, exact selected Thread | 3/5 s detail polling; nested Objective/group/Activation dependency budgets require inspection |
| Dashboard Overview / Runtime | bounded Context and Session candidates | 10/15 s overview polling; `list_recent_contexts` sorts computed lifetime activity before LIMIT; global event invalidation must own the visible page |
| Dashboard Events | sequence cursor, filtered 200-row page | periodic refresh of both latest and old pages; old pages must remain stable until reader action |
| Dashboard Cognition | selected Session/Context; exact Mind/encoding inspection | periodic 30 s projection and 15 s transaction history refresh; event-triggered projection must be visible |
| Dashboard navigation directory | exact selected identities exist | Agent/Context/Session endpoints are unpaged; Context directory includes seed bodies; ancillary job/node/lease/delegation reads occur on unrelated page entry |
| Dashboard Credentials | explicit credential operations | scope picker loads all Contexts/Sessions and loops Context Objectives; requires bounded scope pages |
| Dashboard Providers | explicit configuration/account operations | inspect account-catalog and OAuth lifetimes separately; configuration reads must not trigger implicit model probes |
| Application conversation | newest selected page, explicit older/source reads, event cursor | preserve existing indexed/page/permission regression contracts; inspect cross-surface invalidation ownership |
| Application content / Reader / scripts | independent page/chunk and late-read boundary tests | verify actual page budgets and demand triggers rather than infer coverage from filenames |
| Application activity / delegations | bounded current inventory; retained history and scoped errors | all registered historical Session metadata supplies Context selection; delegation history/child snapshots re-read on current-only reconciliation |
| Application controls | Objective/Thread receipt-driven reconciliation | Schedule and Delegation controls still await general activity refresh; remove unrelated serial waits without weakening receipts |
| Runtime scheduler dependency projection | Thread current-generation indexed selection repaired | Objective dependency reads still include old generations; child collections and generic all-then-truncate defaults require audit |

## Work in progress

- Dashboard periodic network readers are being removed. Visible-page semantic
  invalidations use the existing sockets; failed transport reconnect timers and
  local presentation clocks remain distinct from healthy polling.
- Agent/Context/Session directory APIs are being moved to one typed metadata
  keyset-page operation in both production stores. Pages preserve exact scopes
  and omit Context seed bodies; full single-Context reads remain explicit.
- No changes from this audit have yet been deployed to the user's Runtime.

Verification must update this record with behavioral results, query plans,
remaining gaps and original-app inspection. No source-only or synthetic result
may be represented as whole-product acceptance.
