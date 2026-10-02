import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { RuntimeProfileClient } from "../packages/application/src/runtime-profile-client.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { Application } from "../packages/application/src/application.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import {
  defaultAgentProfile,
  defaultHumanProfile,
  compileProfileRom,
  profileContract,
  profileRom,
  profileSnapshotSchema,
  compileProfileAuthoringState,
} from "../packages/core/src/profile.js";
import { localAccess } from "../packages/core/src/model.js";

/** A controlled Runtime protocol endpoint; this tests Host payload/auth/retry,
 * not real Runtime persistence or infer's frozen ROM assembly. */
async function fixture(team = false, supported = true) {
  const agentId = "kernel-agent-" + randomUUID(),
    principalId = "kernel-principal-" + randomUUID();
  const namespace = randomUUID(),
    token = randomUUID(),
    gatewayToken = randomUUID();
  const records = new Map<string, Record<string, unknown>>();
  const receipts = new Map<
    string,
    { body: string; hash: string; result: unknown }
  >();
  const calls: Array<{
    path: string;
    method: string;
    principal: unknown;
    body: string;
  }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString(),
      url = new URL(req.url!, "http://fixture");
    calls.push({
      path: req.url!,
      method: req.method!,
      principal: req.headers["x-morphz-principal"],
      body,
    });
    res.setHeader("Content-Type", "application/json");
    const credential =
      team && url.pathname === "/api/principal/self" ? gatewayToken : token;
    if (req.headers.authorization !== `Bearer ${credential}`) {
      res.writeHead(401);
      res.end("{}");
      return;
    }
    if (url.pathname === "/api/status") {
      res.end(JSON.stringify({ agent_id: agentId, principal_id: principalId }));
      return;
    }
    if (url.pathname === "/api/principal/self") {
      assert.equal(req.method, "POST");
      assert.equal(body, "");
      res.end(
        JSON.stringify({ principal_id: req.headers["x-morphz-principal"] }),
      );
      return;
    }
    const base = `/api/agents/${agentId}/rom`;
    if (!supported || !url.pathname.startsWith(base)) {
      res.writeHead(404);
      res.end("{}");
      return;
    }
    const scope = url.searchParams.get("principal_scope") ?? undefined;
    if (url.pathname === base) {
      res.end(
        JSON.stringify({
          entries: [...records.values()].filter(
            (record) =>
              (record.key as { principal_scope?: string }).principal_scope ===
              scope,
          ),
        }),
      );
      return;
    }
    const schemaNamespace = url.pathname.slice(base.length + 1),
      key = JSON.stringify([schemaNamespace, scope]);
    if (req.method === "GET") {
      const record = records.get(key);
      res.writeHead(record ? 200 : 404);
      res.end(JSON.stringify(record ?? {}));
      return;
    }
    assert.equal(req.method, "PUT");
    const command = JSON.parse(body);
    assert.equal(command.key.agent_id, agentId);
    assert.equal(command.key.namespace, schemaNamespace);
    assert.equal(command.key.principal_scope, scope);
    // Controlled protocol fixture, not Rust's hash conformance: include every
    // command byte, especially authoring text omitted from the effective BODY.
    const requestHash = createHash("sha256").update(body).digest("hex");
    const prior = receipts.get(command.command_id);
    if (prior) {
      if (prior.hash !== requestHash || prior.body !== body) {
        res.writeHead(409);
        res.end(JSON.stringify({ status: "conflict" }));
      } else
        res.end(
          JSON.stringify({ ...(prior.result as object), duplicate: true }),
        );
      return;
    }
    const previous = records.get(key),
      revision = Number(previous?.revision ?? 0);
    if (command.expected_revision !== revision) {
      res.writeHead(409);
      res.end(
        JSON.stringify({ status: "conflict", current: previous ?? null }),
      );
      return;
    }
    const record = {
      entry_id: "rom-" + key,
      key: command.key,
      revision: revision + 1,
      schema_tag: command.schema_tag,
      canonical_sexpr: command.body_sexpr,
      canonical_authoring_state: command.authoring_state_sexpr ?? null,
      canonical_format_version: 1,
      content_hash: createHash("sha256")
        .update(command.body_sexpr)
        .digest("hex"),
      enabled: command.enabled,
      created_by: "operator",
      created_at: "2026-10-02T00:00:00Z",
    };
    const result = {
      status: "committed",
      record,
      receipt: {
        command_id: command.command_id,
        actor_authority_id: "operator",
        request_hash: requestHash,
        entry_id: record.entry_id,
        expected_revision: revision,
        committed_revision: revision + 1,
        committed_at: "2026-10-02T00:00:00Z",
      },
      duplicate: false,
    };
    records.set(key, record);
    receipts.set(command.command_id, { body, hash: requestHash, result });
    res.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    token: team ? gatewayToken : token,
    namespace,
    ...(team
      ? { identityMode: "trusted_gateway" as const, operatorToken: token }
      : {}),
  };
  return {
    client: new RuntimeProfileClient(() => config),
    calls,
    records,
    receipts,
    config,
    agentId,
    principalId,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("ROM Host Client 使用实际kernel Agent/Principal，保存、冲突和同command回执不复制到Host", async () => {
  const f = await fixture();
  try {
    const before = await f.client.read(localAccess);
    assert.equal(before.identity.agentId, f.agentId);
    assert.equal(before.identity.principalId, f.principalId);
    assert.equal(before.agent.revision, 0);
    assert.equal(before.agent.enabled, false);
    assert.deepEqual(before.agent.data, defaultAgentProfile);
    assert.deepEqual(before.human.data, defaultHumanProfile);
    assert.equal(f.records.size, 0);
    const request = {
      subject: "agent",
      commandId: randomUUID(),
      expectedRevision: 0,
      data: { ...defaultAgentProfile, name: "阿芷" },
    };
    const saved = await f.client.update(localAccess, request);
    assert.equal(saved.revision, 1);
    assert.equal(saved.data.name, "阿芷");
    assert.deepEqual(await f.client.update(localAccess, request), saved);
    assert.equal((await f.client.read(localAccess)).agent.data.name, "阿芷");
    await assert.rejects(
      f.client.update(localAccess, { ...request, commandId: randomUUID() }),
      /Profile 已更新/,
    );
    const human = await f.client.update(localAccess, {
      subject: "human",
      commandId: randomUUID(),
      expectedRevision: 0,
      data: { name: "小谢", preferredAddress: "谢先生" },
    });
    assert.equal(human.data.name, "小谢");
    const record = [...f.records.values()].find(
      (row) => row.schema_tag === profileRom.human.schemaTag,
    )!;
    assert.equal(
      (record.key as { principal_scope: string }).principal_scope,
      f.principalId,
    );
    assert.equal(
      f.calls.some((call) => call.principal !== undefined),
      false,
    ); // Operator ROM auth, never model actor header.
    await assert.rejects(
      f.client.update(localAccess, { ...request, namespace: "morphz.admin" }),
    );
  } finally {
    await f.close();
  }
});

test("Team Human私有ROM登记真实gateway Principal而不建Session，Team Agent不可写", async () => {
  const f = await fixture(true),
    access = { principalId: "alice", actantId: "alice-human" };
  try {
    const absentControl = new RuntimeProfileClient(() => ({
      ...f.config,
      operatorToken: undefined,
    }));
    await assert.rejects(absentControl.read(access), /管理员尚未配置/);
    assert.equal(f.calls.length, 0);
    const expected =
      "mw-" +
      createHash("sha256")
        .update(f.config.namespace + ":alice")
        .digest("hex");
    const snapshot = await f.client.read(access);
    assert.equal(snapshot.identity.principalId, expected);
    assert.equal(snapshot.identity.agentEditable, false);
    await assert.rejects(
      f.client.update(access, {
        subject: "agent",
        commandId: randomUUID(),
        expectedRevision: 0,
        data: defaultAgentProfile,
      }),
      /团队智能体资料只读/,
    );
    assert.equal(
      f.calls.some((call) => call.method === "PUT"),
      false,
    );
    await f.client.update(access, {
      subject: "human",
      commandId: randomUUID(),
      expectedRevision: 0,
      data: { name: "Alice", preferredAddress: "阿丽" },
    });
    assert.equal(
      f.calls.some((call) => call.path.includes("/sessions")),
      false,
    );
    assert.equal(
      f.calls
        .filter((call) => call.path === "/api/principal/self")
        .every((call) => call.principal === expected && call.body === ""),
      true,
    );
    assert.equal(
      (await f.client.read({ principalId: "bob", actantId: "bob-human" })).human
        .revision,
      0,
    );
  } finally {
    await f.close();
  }
});

test("旧Runtime ROM路由404不冒充默认资料已启用，身份撤销挡住迟到响应", async () => {
  const unsupported = await fixture(false, false);
  try {
    await assert.rejects(
      unsupported.client.read(localAccess),
      /尚不支持 Profile ROM/,
    );
  } finally {
    await unsupported.close();
  }
  const f = await fixture();
  try {
    let active = true;
    const request = f.client.read(localAccess, () => {
      if (!active) throw new Error("identity revoked");
    });
    active = false;
    await assert.rejects(request, /identity revoked/);
    assert.equal(
      f.calls.some((call) => call.method === "PUT"),
      false,
    );
  } finally {
    await f.close();
  }
});

test("Host Profile连接错误和非法Header不会把管理凭据放进错误或日志", async () => {
  const sentinel = "PRIVATE_PROFILE_SENTINEL_DO_NOT_LOG";
  let requests = 0;
  const configuration = {
    url: "http://127.0.0.1:9",
    token: sentinel + "\ninvalid",
    namespace: randomUUID(),
  };
  const request: typeof fetch = async () => {
    requests++;
    throw new TypeError("Invalid header value: Bearer " + sentinel);
  };
  const client = new RuntimeProfileClient(() => configuration, request);
  await assert.rejects(client.read(localAccess), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /格式无效/);
    assert.equal(String(error.stack).includes(sentinel), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(requests, 0);
  configuration.token = sentinel;
  await assert.rejects(client.read(localAccess), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /连接失败/);
    assert.equal(String(error.stack).includes(sentinel), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(requests, 1);
});

test("Agent空资料显式on/off精确读回，省略enabled保留按有效字段默认且仅查看零写入", async () => {
  const f = await fixture();
  try {
    await f.client.read(localAccess);
    await f.client.read(localAccess);
    assert.equal(f.records.size, 0);
    assert.equal(f.calls.filter((call) => call.method === "PUT").length, 0);
    const named = { ...defaultAgentProfile, name: "Echo" };
    const cases = [
      { data: defaultAgentProfile, expected: false },
      { data: defaultAgentProfile, enabled: true, expected: true },
      { data: defaultAgentProfile, enabled: false, expected: false },
      { data: defaultAgentProfile, enabled: true, expected: true },
      { data: named, expected: true },
      { data: named, enabled: false, expected: false },
    ];
    for (const [index, item] of cases.entries()) {
      const command = {
        subject: "agent",
        commandId: randomUUID(),
        expectedRevision: index,
        data: item.data,
        ...("enabled" in item ? { enabled: item.enabled } : {}),
      };
      const saved = await f.client.update(localAccess, command);
      assert.equal(saved.revision, index + 1);
      assert.equal(saved.enabled, item.expected);
      assert.deepEqual(saved.data, item.data);
      const reopened = new RuntimeProfileClient(() => f.config);
      assert.deepEqual((await reopened.read(localAccess)).agent, {
        revision: index + 1,
        enabled: item.expected,
        data: item.data,
      });
      const record = [...f.records.values()][0]!;
      assert.equal(record.enabled, item.expected);
      assert.equal(
        record.canonical_sexpr,
        compileProfileRom("agent", item.data),
      );
      assert.equal(
        record.canonical_authoring_state,
        compileProfileAuthoringState(item.data),
      );
      assert.deepEqual(await f.client.update(localAccess, command), saved);
    }
    assert.equal(f.records.size, 1);
    assert.equal(f.receipts.size, cases.length);
  } finally {
    await f.close();
  }
});

test("停用保留字段，Agent显式空启用真实持久且保留CAS/丢回执重试；Human空值仍停用", async () => {
  const f = await fixture();
  try {
    const data = {
      ...defaultAgentProfile,
      name: "阿芷",
      traits: { ...defaultAgentProfile.traits, humor: 0 },
    };
    const saved = await f.client.update(localAccess, {
      subject: "agent",
      commandId: randomUUID(),
      expectedRevision: 0,
      enabled: true,
      data,
    });
    assert.equal(saved.enabled, true);
    const offRequest = {
      subject: "agent",
      commandId: randomUUID(),
      expectedRevision: 1,
      enabled: false,
      data,
    };
    const off = await f.client.update(localAccess, offRequest);
    assert.equal(off.enabled, false);
    assert.deepEqual((await f.client.read(localAccess)).agent, {
      revision: 2,
      enabled: false,
      data,
    });
    assert.deepEqual(await f.client.update(localAccess, offRequest), off);
    const emptyRequest = {
      subject: "agent",
      commandId: randomUUID(),
      expectedRevision: 2,
      enabled: true,
      data: defaultAgentProfile,
    };
    let lost = false;
    const lossy = new RuntimeProfileClient(
      () => f.config,
      async (...args) => {
        const response = await fetch(...args);
        if (args[1]?.method === "PUT" && !lost) {
          lost = true;
          await response.text();
          throw new Error("synthetic response lost after durable write");
        }
        return response;
      },
    );
    await assert.rejects(lossy.update(localAccess, emptyRequest), /连接失败/);
    const empty = await lossy.update(localAccess, emptyRequest);
    assert.equal(empty.revision, 3);
    assert.equal(empty.enabled, true);
    assert.deepEqual(empty.data, defaultAgentProfile);
    assert.deepEqual((await f.client.read(localAccess)).agent, {
      revision: 3,
      enabled: true,
      data: defaultAgentProfile,
    });
    assert.equal(
      [...f.records.values()][0]?.canonical_sexpr,
      "(agent-profile (version 2))",
    );
    const puts = f.calls.filter(
      (call) =>
        call.method === "PUT" &&
        JSON.parse(call.body).command_id === emptyRequest.commandId,
    );
    assert.equal(puts.length, 2);
    assert.equal(puts[0]?.body, puts[1]?.body);
    assert.equal(JSON.parse(puts[0]!.body).enabled, true);
    await assert.rejects(
      f.client.update(localAccess, { ...emptyRequest, enabled: false }),
      /Profile 已更新/,
    );
    await assert.rejects(
      f.client.update(localAccess, {
        ...emptyRequest,
        enabled: false,
        data,
        commandId: randomUUID(),
      }),
      /Profile 已更新/,
    );
    const enabledAgain = await f.client.update(localAccess, {
      ...offRequest,
      commandId: randomUUID(),
      expectedRevision: 3,
      enabled: true,
    });
    assert.equal(enabledAgain.enabled, true);
    assert.ok("traits" in enabledAgain.data);
    assert.equal(enabledAgain.data.traits.humor, 0);
    const emptyCustom = await f.client.update(localAccess, {
      subject: "agent",
      commandId: randomUUID(),
      expectedRevision: 4,
      enabled: true,
      data: { ...defaultAgentProfile, customStyle: "   " },
    });
    assert.equal(emptyCustom.enabled, true);
    assert.deepEqual(emptyCustom.data, defaultAgentProfile);
    const emptyAddress = await f.client.update(localAccess, {
      subject: "human",
      commandId: randomUUID(),
      expectedRevision: 0,
      enabled: true,
      data: { ...defaultHumanProfile, preferredAddress: "   " },
    });
    assert.equal(emptyAddress.enabled, false);
    assert.deepEqual(emptyAddress.data, defaultHumanProfile);
  } finally {
    await f.close();
  }
});

test("字段off作者态保留原文、有效BODY零marker；重新on恢复且同command换off文字拒绝", async () => {
  const f = await fixture();
  try {
    const marker = "HOST_OFF_AUTHORING_MARKER_NEVER_IN_BODY";
    const data = {
      ...defaultAgentProfile,
      name: "Echo",
      traits: { ...defaultAgentProfile.traits, rigor: 0 },
      customStyle: marker,
      customStyleEnabled: false,
    };
    const command = {
      subject: "agent",
      commandId: randomUUID(),
      expectedRevision: 0,
      enabled: true,
      data,
    };
    const saved = await f.client.update(localAccess, command);
    assert.deepEqual(saved.data, data);
    assert.equal(saved.enabled, true);
    const record = [...f.records.values()][0]!;
    assert.equal(String(record.canonical_sexpr).includes(marker), false);
    assert.equal(
      record.canonical_authoring_state,
      compileProfileAuthoringState(data),
    );
    assert.deepEqual((await f.client.read(localAccess)).agent.data, data);
    assert.deepEqual(await f.client.update(localAccess, command), saved);
    const receipt = f.receipts.get(command.commandId)!;
    assert.equal(
      receipt.hash,
      createHash("sha256").update(receipt.body).digest("hex"),
    );
    const changedData = { ...data, customStyle: marker + "_CHANGED" };
    assert.equal(
      compileProfileRom("agent", changedData),
      record.canonical_sexpr,
    );
    await assert.rejects(
      f.client.update(localAccess, { ...command, data: changedData }),
      /Profile 已更新/,
    );
    assert.equal([...f.records.values()][0]!.revision, 1);
    const on = await f.client.update(localAccess, {
      ...command,
      commandId: randomUUID(),
      expectedRevision: 1,
      data: { ...data, customStyleEnabled: true },
    });
    assert.equal(on.revision, 2);
    assert.ok("customStyle" in on.data);
    assert.equal(on.data.customStyle, marker);
    assert.equal(
      String([...f.records.values()][0]!.canonical_sexpr).includes(marker),
      true,
    );
    const onlyOff = await f.client.update(localAccess, {
      ...command,
      commandId: randomUUID(),
      expectedRevision: 2,
      data: {
        ...defaultAgentProfile,
        customStyle: marker,
        customStyleEnabled: false,
      },
    });
    assert.equal(onlyOff.enabled, true);
    assert.equal(
      [...f.records.values()][0]!.canonical_sexpr,
      "(agent-profile (version 2))",
    );
    const reread = (await f.client.read(localAccess)).agent.data;
    assert.ok("customStyle" in reread);
    assert.equal(reread.customStyle, marker);
  } finally {
    await f.close();
  }
});

test("Host作者态与有效BODY严格交叉校验，丢作者态回执不冒充已保存", async () => {
  const f = await fixture();
  try {
    const data = {
      ...defaultAgentProfile,
      name: "Echo",
      customStyle: "PRIVATE_OFF_MARKER",
      customStyleEnabled: false,
    };
    await f.client.update(localAccess, {
      subject: "agent",
      commandId: randomUUID(),
      expectedRevision: 0,
      data,
    });
    const record = [...f.records.values()][0]!;
    const authoring = record.canonical_authoring_state;
    record.canonical_authoring_state = compileProfileAuthoringState({
      ...data,
      customStyleEnabled: true,
    });
    await assert.rejects(
      f.client.read(localAccess),
      /作者状态与有效配置不匹配/,
    );
    record.canonical_authoring_state = "(profile-authoring (version 999))";
    await assert.rejects(f.client.read(localAccess), /Profile ROM|作者状态/);
    record.canonical_authoring_state = authoring;
    assert.deepEqual((await f.client.read(localAccess)).agent.data, data);
    const body = record.canonical_sexpr;
    record.canonical_sexpr = String(body).replace(
      "(version 2)",
      '(version 2) (speech (custom ""))',
    );
    await assert.rejects(
      f.client.read(localAccess),
      /作者状态与有效配置不匹配/,
    );
    record.canonical_sexpr = body;
    const missingState = new RuntimeProfileClient(
      () => f.config,
      async (...args) => {
        const response = await fetch(...args);
        if (args[1]?.method !== "PUT") return response;
        const value = await response.json();
        delete value.record.canonical_authoring_state;
        return new Response(JSON.stringify(value), { status: response.status });
      },
    );
    await assert.rejects(
      missingState.update(localAccess, {
        subject: "agent",
        commandId: randomUUID(),
        expectedRevision: 1,
        data,
      }),
      /未确认作者状态/,
    );
  } finally {
    await f.close();
  }
});

test("读取v1沿用显式值和disabled head且不写回，下一次显式保存迁移v2", async () => {
  const f = await fixture();
  try {
    const legacy = {
      name: "旧名字",
      traits: { humor: 2, rigor: 3, warmth: 3, verbosity: 2 },
      speechStyle: "natural" as const,
      customStyle: null,
    };
    const key = JSON.stringify([profileRom.agent.namespace, undefined]);
    f.records.set(key, {
      entry_id: "legacy-entry",
      key: { agent_id: f.agentId, namespace: profileRom.agent.namespace },
      revision: 7,
      schema_tag: profileRom.agent.legacySchemaTag,
      canonical_sexpr: `(agent-profile (identity (name 旧名字)) (personality (humor 2) (rigor 3) (warmth 3) (verbosity 2)) (speech (style natural) (custom "")) (contract ${JSON.stringify(profileContract)}))`,
      enabled: false,
      canonical_format_version: 1,
      content_hash: "a".repeat(64),
      created_by: "operator",
      created_at: "2026-10-02T00:00:00Z",
    });
    assert.deepEqual((await f.client.read(localAccess)).agent, {
      revision: 7,
      enabled: false,
      data: legacy,
    });
    assert.equal(
      f.calls.some((call) => call.method === "PUT"),
      false,
    );
    const saved = await f.client.update(localAccess, {
      subject: "agent",
      commandId: randomUUID(),
      expectedRevision: 7,
      data: legacy,
      enabled: false,
    });
    assert.equal(saved.enabled, false);
    assert.deepEqual(saved.data, legacy);
    assert.equal(f.records.get(key)?.schema_tag, profileRom.agent.schemaTag);
    assert.equal(
      f.records.get(key)?.canonical_sexpr,
      compileProfileRom("agent", legacy),
    );
    // Older v2 entries have no authoring state. Read keeps their present custom
    // style enabled without a migration write or a manufactured new revision.
    const legacyV2 = {
      ...legacy,
      customStyle: "LEGACY_V2_CUSTOM_WITHOUT_AUTHORING",
    };
    f.records.set(key, {
      ...f.records.get(key)!,
      canonical_authoring_state: null,
      canonical_sexpr: compileProfileRom("agent", legacyV2),
      enabled: true,
    });
    const writesBeforeRead = f.calls.filter(
      (call) => call.method === "PUT",
    ).length;
    assert.deepEqual((await f.client.read(localAccess)).agent, {
      revision: 8,
      enabled: true,
      data: legacyV2,
    });
    assert.equal(
      f.calls.filter((call) => call.method === "PUT").length,
      writesBeforeRead,
    );
  } finally {
    await f.close();
  }
});

test("真实embedded Host的disabled/全未设置Profile仍可读编辑和显示独立Agent头像", async () => {
  // Real Host authorization/Platform/byte Store; Runtime protocol uses the
  // controlled endpoint above. Full Rust/model validation has a separate smoke.
  const f = await fixture(),
    root = mkdtempSync(join(tmpdir(), "morphz-profile-unset-host-"));
  const workspace = new WorkspaceStore(join(root, "workspace.sqlite"), {
    mode: "transport",
  });
  const bridge = new RuntimeBridge(workspace, f.config);
  let domains:
    Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  let connection: LocalApplicationConnection | undefined;
  try {
    domains = await openApplicationDomainsHost(root, workspace);
    domains.bindRuntime(bridge);
    connection = new LocalApplicationConnection(
      new Application(workspace, { profiles: domains.profiles }),
    );
    const boot = (await connection.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const options = { identityGeneration: boot.csrfToken };
    const read = async () =>
      profileSnapshotSchema.parse(
        await connection!.call("profile.read", {}, options),
      );
    const before = await read();
    assert.equal(before.agent.available, true);
    assert.equal(before.agent.enabled, false);
    assert.deepEqual(before.agent.data, defaultAgentProfile);
    assert.deepEqual(before.human.data, defaultHumanProfile);
    assert.equal(f.records.size, 0);
    const png = await sharp({
      create: { width: 64, height: 64, channels: 4, background: "#31b4bb" },
    })
      .png()
      .toBuffer();
    const avatar = await connection.call(
      "profile.avatar.set",
      {
        subject: "agent",
        commandId: randomUUID(),
        expectedRevision: 0,
        data: png,
      },
      options,
    );
    const data = { ...defaultAgentProfile, name: "仅显示的名字" };
    await connection.call(
      "profile.update",
      {
        subject: "agent",
        commandId: randomUUID(),
        expectedRevision: 0,
        enabled: false,
        data,
      },
      options,
    );
    const disabled = await read();
    assert.equal(disabled.agent.available, true);
    assert.equal(disabled.agent.editable, true);
    assert.equal(disabled.agent.enabled, false);
    assert.deepEqual(disabled.agent.data, data);
    assert.deepEqual(disabled.agent.avatar, avatar);
    await connection.call(
      "profile.update",
      {
        subject: "agent",
        commandId: randomUUID(),
        expectedRevision: 1,
        enabled: true,
        data: defaultAgentProfile,
      },
      options,
    );
    const empty = await read();
    assert.equal(empty.agent.available, true);
    assert.equal(empty.agent.enabled, true);
    assert.deepEqual(empty.agent.data, defaultAgentProfile);
    assert.deepEqual(empty.agent.avatar, avatar);
    const retained = {
      ...defaultAgentProfile,
      name: "Echo",
      customStyle: "AGENT_TOOL_OFF_AUTHORING_MARKER",
      customStyleEnabled: false,
    };
    await connection.call(
      "profile.update",
      {
        subject: "agent",
        commandId: randomUUID(),
        expectedRevision: 2,
        enabled: true,
        data: retained,
      },
      options,
    );
    assert.deepEqual((await read()).agent.data, retained);
    const toolRead = profileSnapshotSchema.parse(
      await domains.profiles.authority.withSession(
        localAccess,
        () => {},
        (actor) =>
          domains!.profiles.service.agentOperation(actor, { action: "read" }),
      ),
    );
    assert.equal(toolRead.agent.data.customStyle, null);
    assert.equal(toolRead.agent.data.name, "Echo");
    assert.equal(
      JSON.stringify(toolRead).includes(retained.customStyle),
      false,
    );
    assert.deepEqual((await read()).agent.data, retained);
    await connection.call(
      "profile.update",
      {
        subject: "agent",
        commandId: randomUUID(),
        expectedRevision: 3,
        enabled: false,
        data: { ...retained, customStyleEnabled: true },
      },
      options,
    );
    const globallyOffToolRead = profileSnapshotSchema.parse(
      await domains.profiles.authority.withSession(
        localAccess,
        () => {},
        (actor) =>
          domains!.profiles.service.agentOperation(actor, { action: "read" }),
      ),
    );
    assert.equal(globallyOffToolRead.agent.enabled, false);
    assert.equal(globallyOffToolRead.agent.data.customStyle, null);
    assert.equal(
      JSON.stringify(globallyOffToolRead).includes(retained.customStyle),
      false,
    );
    assert.equal((await read()).agent.data.customStyle, retained.customStyle);
    assert.equal(
      f.calls.some((call) => call.path.includes("/sessions")),
      false,
    );
  } finally {
    connection?.close();
    await bridge.stop();
    await domains?.close();
    workspace.close();
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});
