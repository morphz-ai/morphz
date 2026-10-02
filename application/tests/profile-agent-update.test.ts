import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Pool } from "pg";
import { z } from "zod";
import {
  defaultAgentProfile,
  mergeAgentProfilePatch,
  normalizeAgentProfileData,
  profileCustom,
  profileSnapshotSchema,
} from "../packages/core/src/profile.js";
import { objectToolName } from "../packages/core/src/application-names.js";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import { ProfileService } from "../packages/application/src/profile-service.js";
import { RuntimeProfileClient } from "../packages/application/src/runtime-profile-client.js";
import type { RuntimeBridge } from "../packages/application/src/runtime.js";
import { RuntimePlatformAuthority } from "../packages/application/src/runtime-platform-authority.js";
import { PlatformWorkService } from "../packages/application/src/platform-work-service.js";
import {
  PlatformAgentTools,
  type PlatformAgentDomain,
} from "../packages/application/src/platform-agent-tools.js";
import {
  AgentTools,
  type HostInvocation,
  hostOperations,
  workToolDefinitions,
} from "../packages/application/src/agent-tools.js";
import { profileActualTransportFixture } from "./profile-actual-transport-fixture.js";

test("Agent Profile sparse patch: omission preserves authoring data, null clears, toggles retain text", () => {
  for (const tool of workToolDefinitions)
    assert.ok(
      Buffer.byteLength(tool.description, "utf8") <= 16_000,
      "Runtime host tool UTF-8 description bound",
    );
  const initial = {
    ...defaultAgentProfile,
    name: "Echo",
    traits: { humor: 0, rigor: 5, warmth: 2, verbosity: 3 },
    speechStyle: "thoughtful" as const,
    customStyle: "保留的风格",
    customStyleEnabled: false,
  };
  const patched = mergeAgentProfilePatch(initial, {
    traits: { humor: null, warmth: 0 },
    speechStyle: null,
  });
  assert.deepEqual(patched, {
    ...initial,
    traits: { humor: null, rigor: 5, warmth: 0, verbosity: 3 },
    speechStyle: null,
  });
  assert.equal(
    mergeAgentProfilePatch(patched, { customStyleEnabled: true }).customStyle,
    initial.customStyle,
  );
  assert.equal(
    mergeAgentProfilePatch(patched, { customStyle: null }).customStyle,
    null,
  );
  for (const forbidden of ["subject", "agentId", "principalId", "avatar"])
    assert.throws(() =>
      hostOperations.invoke("profile.update", {
        commandId: "x",
        expectedRevision: 0,
        data: { name: "Echo" },
        [forbidden]: "forged",
      }),
    );
  const schema = hostOperations.describe("profile.update").parameters;
  assert.ok(JSON.stringify(schema).includes("customStyleEnabled"));
  assert.ok(JSON.stringify(schema).includes("enabled"));
});

/** Controlled Custom transport tests the actual Host/router/Platform permission
 * and stable write bytes. The separate real Runtime test below proves durable
 * Custom revisions and model Context compilation rather than this fixture map. */
async function customTransport() {
  const agentId = "agent_" + randomUUID(),
    principalId = "principal_" + randomUUID(),
    token = randomUUID();
  const records = new Map<number, Record<string, unknown>>();
  const receipts = new Map<string, { hash: string; result: unknown }>();
  const writes: string[] = [];
  const reads: string[] = [];
  let head = 0;
  let identityAgentId = agentId;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      const url = new URL(request.url!, "http://fixture");
      response.setHeader("Content-Type", "application/json");
      if (url.pathname === "/api/status")
        return void response.end(
          JSON.stringify({
            agent_id: identityAgentId,
            principal_id: principalId,
          }),
        );
      const base = `/api/agents/${agentId}/custom`;
      if (url.pathname === base)
        return void response.end(
          JSON.stringify({ entries: [...records.values()].slice(-1) }),
        );
      if (url.pathname !== base + "/" + profileCustom.agent.namespace)
        return void response.writeHead(404).end("{}");
      if (request.method === "GET") {
        reads.push(url.search);
        const version = records.get(
          url.searchParams.has("revision")
            ? Number(url.searchParams.get("revision"))
            : head,
        );
        response
          .writeHead(version ? 200 : 404)
          .end(JSON.stringify(version ?? {}));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks).toString();
      writes.push(bytes);
      const command = JSON.parse(bytes);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const previous = receipts.get(command.command_id);
      if (previous) {
        if (hash !== previous.hash)
          return void response.writeHead(409).end("{}");
        return void response.end(
          JSON.stringify({ ...(previous.result as object), duplicate: true }),
        );
      }
      if (command.expected_revision !== head)
        return void response.writeHead(409).end("{}");
      head++;
      const record = {
        entry_id: "isolated-entry",
        key: command.key,
        revision: head,
        schema_tag: command.schema_tag,
        canonical_sexpr: command.body_sexpr,
        canonical_authoring_state: command.authoring_state_sexpr,
        enabled: command.enabled,
        content_hash: hash,
        canonical_format_version: 1,
        created_by: "isolated-operator",
        created_at: new Date().toISOString(),
      };
      records.set(head, record);
      const result = {
        status: "committed",
        record,
        duplicate: false,
        receipt: {
          command_id: command.command_id,
          actor_authority_id: "isolated-operator",
          request_hash: hash,
          entry_id: record.entry_id,
          expected_revision: command.expected_revision,
          committed_revision: head,
          committed_at: record.created_at,
        },
      };
      receipts.set(command.command_id, { hash, result });
      response.end(JSON.stringify(result));
    } catch {
      response.writeHead(500).end("{}");
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const client = new RuntimeProfileClient(() => ({
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    token,
    namespace: "isolated-profile",
  }));
  return {
    client,
    agentId,
    principalId,
    records,
    writes,
    reads,
    receipts,
    driftIdentity() {
      identityAgentId = "foreign-agent";
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

async function hostFixture(
  backend: "sqlite" | "postgres",
  connectionString?: string,
) {
  const remote = await customTransport();
  const tenantId = "tenant_" + randomUUID(),
    projectId = "project",
    schema = "profile_agent_" + randomUUID().replaceAll("-", "");
  let current = true,
    editable = true;
  const route: HostInvocation = {
    job_id: "job",
    tool_call_id: "call",
    session_id: "session",
    context_id: "context",
    principal_id: remote.principalId,
    agent_id: remote.agentId,
    thread_id: "thread",
    target_id: "target",
  };
  const authority = new RuntimePlatformAuthority(
    {
      async readThread() {
        return {
          snapshot: {
            thread: {
              id: route.thread_id,
              session_id: route.session_id,
              context_id: route.context_id,
              root_turn_id: "root",
              initiating_principal_id: remote.principalId,
              agent_id: remote.agentId,
              executor_kind: "agent",
              executor_id: null,
            },
          },
        };
      },
      async readSessionEvent() {
        return {
          id: "root",
          actor: "Session-Client",
          type: "session_message",
          topic: "chat/user_message",
          payload: {
            session_id: route.session_id,
            context_id: route.context_id,
            principal_id: remote.principalId,
            client_message_id: "input",
            session_io: {
              request: {
                io_version: "1",
                client_message_id: "input",
                message: {
                  format: { id: "morphz.application.input", version: "1" },
                  content: {
                    encoding: "json",
                    value: {
                      type: "object",
                      value: {
                        input_id: { type: "string", value: "input" },
                        workspace_id: { type: "string", value: projectId },
                        author_actant_id: {
                          type: "string",
                          value: "alice-human",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        };
      },
    },
    async (principal, agent) =>
      current && principal === remote.principalId && agent === remote.agentId
        ? {
            tenantId,
            principalId: "alice",
            humanActantId: "alice-human",
            agentActantId: "morphz-agent",
          }
        : null,
  );
  const remaining: Omit<PlatformAuthorityVerifier, "resolveActor"> = {
    async resolveActant({ actantId }) {
      return actantId === "alice-human"
        ? { principalId: "alice", kind: "human" }
        : { principalId: "morphz-service", kind: "agent" };
    },
    async resolveProjectAgent() {
      return { principalId: "morphz-service", actantId: "morphz-agent" };
    },
    async resolveProfileAgent() {
      return { agentId: remote.agentId, editable };
    },
    async verifyApplicationObject() {
      return false;
    },
  };
  const verifier = authority.verifier(remaining);
  const capabilities: PlatformAuthorityVerifier = {
    ...verifier,
    async resolveActor(actor) {
      return actor.credential === "setup"
        ? {
            tenantId,
            principalId: "alice",
            actantId: "alice-human",
            kind: "human",
            runtimeInputId: null,
          }
        : verifier.resolveActor(actor);
    },
  };
  const admin =
    backend === "postgres" ? new Pool({ connectionString }) : undefined;
  let platform: PlatformStore | undefined;
  try {
    if (admin) await admin.query(`CREATE SCHEMA "${schema}"`);
    platform =
      backend === "postgres"
        ? await PlatformStore.postgres(
            { connectionString: connectionString!, schema },
            capabilities,
          )
        : await PlatformStore.sqlite(":memory:", capabilities);
    await platform.provisionTenant(tenantId);
    await platform.createProject(
      { credential: "setup" },
      {
        commandId: "create-project",
        projectId,
        title: "Agent 自身 Profile 权限验收",
      },
    );
    const profile = new ProfileService(
      () => ({ profiles: remote.client }) as RuntimeBridge,
      platform,
    );
    const domain = {
      authority,
      profile,
      work: new PlatformWorkService(platform, "single-host"),
      content: { platform },
    } as PlatformAgentDomain;
    const tools = new AgentTools({
      token: "isolated-host-token",
      resolveScope: (invocation) =>
        authority.withInvocation(invocation, async (_actor, source) => ({
          projectId: source.projectId,
          inputId: source.inputId ?? undefined,
          platform: true,
          platformSource: "input",
          access: { principalId: "morphz-service", actantId: "morphz-agent" },
        })),
      platformAgent: new PlatformAgentTools(domain),
    });
    return {
      ...remote,
      authority,
      profile,
      platform,
      route,
      revoke() {
        current = false;
      },
      team() {
        editable = false;
      },
      async invoke(
        operationId: string,
        parameters: unknown,
        invocation = route,
      ) {
        return Promise.resolve(
          tools.call({
            protocol: 1,
            tool: objectToolName,
            invocation,
            arguments: {
              action: "operations",
              operations: { action: "invoke", operationId, parameters },
            },
          }),
        );
      },
      list: () =>
        Promise.resolve(
          tools.call({
            protocol: 1,
            tool: objectToolName,
            invocation: route,
            arguments: {
              action: "operations",
              operations: { action: "list", domain: "profile" },
            },
          }),
        ),
      async close() {
        await platform?.close();
        if (admin) {
          await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          await admin.end();
        }
        await remote.close();
      },
    };
  } catch (error) {
    await platform?.close();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    await remote.close();
    throw error;
  }
}

const savedAgent = z.object({
  subject: z.literal("agent"),
  revision: z.number(),
  commandId: z.string(),
  enabled: z.boolean(),
  data: z.unknown(),
});
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: actual Profile Host/router self updates all fields, CAS and replay after intervening writes`,
    { skip: backend === "postgres" && !process.env.MORPHZ_TEST_POSTGRES_URL },
    async () => {
      const f = await hostFixture(
        backend,
        process.env.MORPHZ_TEST_POSTGRES_URL,
      );
      try {
        assert.deepEqual(
          ((await f.list()) as { operations: { id: string }[] }).operations.map(
            (row) => row.id,
          ),
          ["profile.read", "profile.update", "profile.propose"],
        );
        const first = {
          commandId: "self-all",
          expectedRevision: 0,
          enabled: true,
          data: {
            name: "Echo",
            traits: { humor: 0, rigor: 5, warmth: 4, verbosity: 1 },
            speechStyle: "direct",
            customStyle: "KEEP_AUTHORING_TEXT",
            customStyleEnabled: true,
          },
        };
        const original = savedAgent.parse(
          await f.invoke("profile.update", first),
        );
        assert.equal(original.revision, 1);
        assert.deepEqual(
          original.data,
          normalizeAgentProfileData({
            ...defaultAgentProfile,
            ...first.data,
          }),
        );
        assert.deepEqual(
          f.reads,
          [],
          "revision 0 is deterministic, not a guessed historical read",
        );
        const disabled = savedAgent.parse(
          await f.invoke("profile.update", {
            commandId: "disable-style",
            expectedRevision: 1,
            data: {
              customStyleEnabled: false,
              traits: { humor: null, warmth: 0 },
            },
          }),
        );
        assert.equal(disabled.revision, 2);
        assert.ok(
          !JSON.stringify(disabled.data).includes("KEEP_AUTHORING_TEXT"),
          "inactive retained authoring text must not enter the model via tool return",
        );
        assert.ok(
          String(f.records.get(2)!.canonical_authoring_state).includes(
            "KEEP_AUTHORING_TEXT",
          ),
        );
        const patch = {
          commandId: "only-name",
          expectedRevision: 2,
          data: { name: "Eve" },
        };
        const patched = savedAgent.parse(
          await f.invoke("profile.update", patch),
        );
        assert.equal(patched.revision, 3);
        assert.ok(
          String(f.records.get(3)!.canonical_authoring_state).includes(
            "KEEP_AUTHORING_TEXT",
          ),
        );
        await f.invoke("profile.update", {
          commandId: "intervening",
          expectedRevision: 3,
          data: { traits: { rigor: 3 } },
        });
        const retried = savedAgent.parse(
          await f.invoke("profile.update", patch),
        );
        assert.deepEqual(retried, patched);
        const repeatedWrites = f.writes.filter(
          (bytes) => JSON.parse(bytes).command_id === patch.commandId,
        );
        assert.equal(repeatedWrites.length, 2);
        assert.equal(
          repeatedWrites[0],
          repeatedWrites[1],
          "same patch must become byte-identical full Custom command, even after new head",
        );
        assert.equal(f.records.size, 4);
        await assert.rejects(
          f.invoke("profile.update", {
            ...patch,
            commandId: "stale-new-command",
          }),
          /已更新/,
        );
        await assert.rejects(
          f.invoke("profile.update", {
            commandId: "future",
            expectedRevision: 999,
            data: { name: "bad" },
          }),
          /原始版本不存在/,
        );
        const restored = savedAgent.parse(
          await f.invoke("profile.update", {
            commandId: "reenable-style",
            expectedRevision: 4,
            data: { customStyleEnabled: true },
          }),
        );
        assert.equal(
          (restored.data as { customStyle: string }).customStyle,
          "KEEP_AUTHORING_TEXT",
        );
        const cleared = savedAgent.parse(
          await f.invoke("profile.update", {
            commandId: "clear-all",
            expectedRevision: 5,
            enabled: false,
            data: {
              name: null,
              traits: {
                humor: null,
                rigor: null,
                warmth: null,
                verbosity: null,
              },
              speechStyle: null,
              customStyle: null,
            },
          }),
        );
        assert.equal(cleared.enabled, false);
        assert.deepEqual(cleared.data, defaultAgentProfile);
        const beforeRace = f.records.size;
        const race = await Promise.allSettled(
          ["one", "two"].map((name) =>
            f.invoke("profile.update", {
              commandId: "race-" + name,
              expectedRevision: 6,
              data: { name },
            }),
          ),
        );
        assert.equal(
          race.filter((item) => item.status === "fulfilled").length,
          1,
        );
        assert.equal(f.records.size, beforeRace + 1);
        await assert.rejects(
          f.invoke("profile.update", {
            commandId: "empty",
            expectedRevision: 7,
            data: { traits: {} },
          }),
          /请指定/,
        );
        const writes = f.writes.length;
        await assert.rejects(
          f.profile.agentOperation(
            { credential: "setup" },
            {
              action: "update",
              commandId: "human-forged-agent",
              expectedRevision: 7,
              enabled: true,
            },
            f.agentId,
          ),
          /只能修改/,
        );
        await f.authority.withInvocation(f.route, async (actor) => {
          await assert.rejects(
            f.profile.update(actor, {
              subject: "human",
              commandId: "forbidden-human",
              expectedRevision: 0,
              data: { name: "forged", preferredAddress: null },
            }),
            /用户确认/,
          );
          for (const subject of ["agent", "human"] as const)
            await assert.rejects(
              f.platform.updateProfileAvatar(actor, {
                subject,
                commandId: "forbidden-avatar-" + subject,
                expectedRevision: 0,
                media: null,
              }),
              /用户确认/,
            );
        });
        await assert.rejects(
          f.invoke("profile.update", {
            commandId: "forged-subject",
            expectedRevision: 7,
            subject: "human",
            data: { name: "forged" },
          }),
        );
        await assert.rejects(
          f.invoke(
            "profile.update",
            { commandId: "forged-route", expectedRevision: 7, enabled: true },
            { ...f.route, agent_id: "foreign-agent" },
          ),
        );
        f.driftIdentity();
        await assert.rejects(
          f.invoke("profile.update", {
            commandId: "status-drift",
            expectedRevision: 7,
            enabled: true,
          }),
          /工具调用者不是/,
        );
        f.team();
        await assert.rejects(
          f.invoke("profile.update", {
            commandId: "team-write",
            expectedRevision: 7,
            enabled: true,
          }),
          /只能修改/,
        );
        f.revoke();
        await assert.rejects(f.invoke("profile.read", {}));
        assert.equal(
          f.writes.length,
          writes,
          "permission rejection must not write Custom",
        );
      } finally {
        await f.close();
      }
    },
  );
}

/** Extract one list while respecting escaped strings. The caller selects the
 * real serialized Context's top-level Custom, not a previous chat/tool result. */
function contextCustom(request: {
  messages: { role: string; content: unknown }[];
}) {
  const context = request.messages
    .map((message) =>
      typeof message.content === "string" ? message.content : "",
    )
    .find((text) => text.includes("(context (protocol "));
  assert.ok(context, "native model request must carry the real Context tree");
  const start = context.indexOf(
    "(custom",
    context.indexOf("(context (protocol "),
  );
  // The real Runtime omits Custom entirely when the frozen manifest is empty.
  // Active assertions below still require the exact profile content to exist.
  if (start < 0) return "";
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let index = start; index < context.length; index++) {
    const char = context[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0)
      return context.slice(start, index + 1);
  }
  assert.fail("Context Custom subtree incomplete");
}

test(
  "real Rust Runtime HTTP: actual Agent tool persists Profile and next Thread Context uses name/personality; historical retry stays idempotent",
  { skip: process.env.MORPHZ_PROFILE_RUNTIME_E2E !== "1", timeout: 120_000 },
  async () => {
    const f = await profileActualTransportFixture();
    const projectId = "profile_agent_" + randomUUID().replaceAll("-", "");
    const waitRevision = async (revision: number) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const snapshot = await f.read();
        if (snapshot.agent.revision === revision) return snapshot;
        await new Promise((done) => setTimeout(done, 50));
      }
      assert.fail("actual Profile update did not commit");
    };
    const send = async (marker: string) => {
      await f.client.call(
        "platform.message",
        {
          commandId: randomUUID(),
          operation: {
            type: "record-input",
            projectId,
            conversationId: "conversation_" + randomUUID().replaceAll("-", ""),
            artifactId: null,
            artifactRevision: null,
            selection: "",
            body: marker,
            targetActantId: "morphz-agent",
            newConversation: { title: marker },
          },
        },
        f.options,
      );
      return f.waitRequest(marker);
    };
    const updateViaAgent = async (
      marker: string,
      parameters: unknown,
      revision: number,
      savedRevision = revision,
    ) => {
      f.hold(marker);
      await send(marker);
      const afterTool = f.requests.length;
      f.releaseWithTool(marker, objectToolName, {
        action: "operations",
        operations: {
          action: "invoke",
          operationId: "profile.update",
          parameters,
        },
      });
      const resumed = await f.waitRequest(marker, afterTool);
      const commandId = (parameters as { commandId: string }).commandId;
      const toolReceipt = resumed.messages.find(
        (message) =>
          message.role === "tool" &&
          typeof message.content === "string" &&
          message.content.includes(commandId),
      );
      assert.ok(
        toolReceipt,
        "native continuation must contain the actual saved command receipt: " +
          JSON.stringify(
            resumed.messages.map((message) => ({
              role: message.role,
              text:
                typeof message.content === "string"
                  ? message.content.slice(0, 1000)
                  : typeof message.content,
            })),
          ),
      );
      assert.ok(
        String(toolReceipt.content)
          .replaceAll('\\"', '"')
          .includes(`"revision":${savedRevision}`),
      );
      return waitRevision(revision);
    };
    try {
      await f.client.call(
        "projects.create",
        {
          commandId: randomUUID(),
          projectId,
          title: "实际 Agent Profile 链验证",
        },
        f.options,
      );
      const all = {
        commandId: "actual-agent-all",
        expectedRevision: 0,
        enabled: true,
        data: {
          name: "EchoActual",
          traits: { humor: 0, rigor: 5, warmth: 4, verbosity: 1 },
          speechStyle: "direct",
          customStyle: "RETAIN_INACTIVE_AUTHORING",
          customStyleEnabled: true,
        },
      };
      const original = await updateViaAgent("ACTUAL_PROFILE_AGENT_ALL", all, 1);
      assert.deepEqual(original.agent.data.traits, all.data.traits);
      assert.equal(original.agent.data.name, all.data.name);
      const actualCustom = contextCustom(
        await send("ACTUAL_PROFILE_NEXT_THREAD"),
      );
      assert.ok(actualCustom.includes("EchoActual"));
      for (const [name, value] of Object.entries(all.data.traits))
        assert.ok(actualCustom.includes(`(${name} ${value})`));
      assert.ok(actualCustom.includes("RETAIN_INACTIVE_AUTHORING"));
      const off = await updateViaAgent(
        "ACTUAL_PROFILE_STYLE_OFF",
        {
          commandId: "actual-style-off",
          expectedRevision: 1,
          data: { customStyleEnabled: false },
        },
        2,
      );
      assert.equal(off.agent.data.customStyle, "RETAIN_INACTIVE_AUTHORING");
      assert.equal(off.agent.data.customStyleEnabled, false);
      const offCustom = contextCustom(await send("ACTUAL_PROFILE_OFF_NEXT"));
      assert.ok(!offCustom.includes("RETAIN_INACTIVE_AUTHORING"));
      const patch = {
        commandId: "actual-name-only",
        expectedRevision: 2,
        data: { name: "EveActual" },
      };
      await updateViaAgent("ACTUAL_PROFILE_PATCH", patch, 3);
      await updateViaAgent(
        "ACTUAL_PROFILE_INTERVENING",
        {
          commandId: "actual-intervening",
          expectedRevision: 3,
          data: { traits: { rigor: 3 } },
        },
        4,
      );
      await updateViaAgent("ACTUAL_PROFILE_REPLAY_OLD_PATCH", patch, 4, 3);
      const current = await f.read();
      assert.equal(current.agent.revision, 4);
      assert.equal(current.agent.data.traits.rigor, 3);
      assert.equal(current.agent.data.customStyle, "RETAIN_INACTIVE_AUTHORING");
      assert.equal(
        f.sql<{ count: number }>(
          "SELECT COUNT(*) AS count FROM agent_rom_versions",
        )[0]?.count,
        4,
      );
      const restored = await updateViaAgent(
        "ACTUAL_PROFILE_RESTORE",
        {
          commandId: "actual-restore",
          expectedRevision: 4,
          data: { customStyleEnabled: true },
        },
        5,
      );
      assert.equal(
        restored.agent.data.customStyle,
        "RETAIN_INACTIVE_AUTHORING",
      );
      assert.ok(
        contextCustom(await send("ACTUAL_PROFILE_RESTORED_NEXT")).includes(
          "RETAIN_INACTIVE_AUTHORING",
        ),
      );
      const offAll = await updateViaAgent(
        "ACTUAL_PROFILE_GLOBAL_OFF",
        { commandId: "actual-global-off", expectedRevision: 5, enabled: false },
        6,
      );
      assert.equal(offAll.agent.enabled, false);
      assert.deepEqual(offAll.agent.data, restored.agent.data);
      assert.ok(
        !contextCustom(await send("ACTUAL_PROFILE_GLOBAL_OFF_NEXT")).includes(
          profileCustom.agent.namespace,
        ),
      );
      const onAll = await updateViaAgent(
        "ACTUAL_PROFILE_GLOBAL_ON",
        { commandId: "actual-global-on", expectedRevision: 6, enabled: true },
        7,
      );
      assert.deepEqual(onAll.agent.data, restored.agent.data);
      assert.ok(
        contextCustom(await send("ACTUAL_PROFILE_GLOBAL_ON_NEXT")).includes(
          "EveActual",
        ),
      );
      profileSnapshotSchema.parse(restored);
      console.log(
        JSON.stringify({
          evidence: "isolated-profile-agent-update",
          model_requests: f.requests.length,
          upstream_model_requests: f.realCalls,
          custom_versions: f.sql<{ count: number }>(
            "SELECT COUNT(*) AS count FROM agent_rom_versions",
          )[0]?.count,
          current_revision: onAll.agent.revision,
          name: onAll.agent.data.name,
          traits: onAll.agent.data.traits,
          inactive_text_retained:
            offAll.agent.data.customStyle === restored.agent.data.customStyle,
          old_command_replay_revision: 3,
        }),
      );
    } finally {
      await f.close();
    }
  },
);
