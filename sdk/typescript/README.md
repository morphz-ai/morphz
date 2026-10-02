# Morphz TypeScript SDK

Custom is a structured, read-only component of the model's Context. The canonical
types live in the exported `context` type namespace, matching Rust's
`morphz::context` module. The same names are also available as top-level type
aliases for convenient imports.

```ts
import { MorphzClient } from "@morphz/sdk";
import type { context } from "@morphz/sdk";

const client = new MorphzClient({ baseUrl, serviceToken: operatorToken });
const command: context.PutCustomCommand = {
  command_id: "save-profile-1",
  expected_revision: 0,
  key: { agent_id: "agent-one", namespace: "example.profile" },
  schema_tag: "example.profile/v1",
  body_sexpr: '(profile (name "Echo"))',
  enabled: true,
};
await client.putCustomAsOperator(command);
const installed: context.Custom = await client.getCustomAsOperator(command.key);
```

The canonical client methods are `listCustomAsOperator`, `getCustomAsOperator`,
`putCustomAsOperator`, and `threadCustomAsOperator`. They request `/custom`
endpoints. `CustomKey`, `PutCustomCommand`, `CustomCommandReceipt`,
`CustomMutation`, and `ThreadCustomManifest` are all part of `context`.

These are trusted operator APIs, not model or participant write authority.
`principal_scope` selects one exact private scope; it does not authenticate the
caller. Optional `authoring_state_sexpr` is control-plane editor state and is
never included in a Thread's model-visible manifest.

Writes use an exact `expected_revision` and a stable `command_id`. A conflict
raises a 409 `MorphzHttpError`. If a response is lost, retry the identical command
and ID rather than creating a new command. The SDK never changes endpoints or
automatically retries a write after a 404.

For older Runtime versions, the deprecated `listAgentRomAsOperator`,
`getAgentRomAsOperator`, `putAgentRomAsOperator`, and `threadRomAsOperator`
methods explicitly continue to request `/rom`. Legacy `AgentRom*`,
`PutAgentRomCommand`, and `ThreadRomManifest` type names remain aliases of the
canonical types. Updated Runtimes accept both paths through the same handlers,
authorization, CAS and command-receipt boundary. Persisted keys and command wire
fields are unchanged; selecting a legacy method is explicit compatibility, not
automatic fallback.

`sessionThreadFamily(principal, sessionId, threadId, limit = 64)` performs one
read-only Session-scoped GET using the same service token and trusted Principal
headers as other Session methods. Its `ThreadFamily` response contains the
selected Thread followed by its real same-Session/Context descendants in
breadth-first order, without ancestors, siblings, Thread bodies or Job data.
The limit is an integer from 1 to 64, including the selected Thread. Check
`has_more` before treating the result as complete; unrelated Context history
does not affect this flag. Each member keeps its own `root_turn_id`, parent,
revision and generation. This read does not grant execution control, poll,
retry, or fall back to recent Context history when the Runtime lacks the API.

Run the SDK tests with `npm test` from this directory (Node.js with native
TypeScript type stripping).
