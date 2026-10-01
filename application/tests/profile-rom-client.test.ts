import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { RuntimeProfileClient } from "../packages/application/src/runtime-profile-client.js";
import { defaultAgentProfile } from "../packages/core/src/profile.js";
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
  const receipts = new Map<string, { body: string; result: unknown }>();
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
    const prior = receipts.get(command.command_id);
    if (prior) {
      if (prior.body !== body) {
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
      canonical_format_version: 1,
      content_hash: "a".repeat(64),
      enabled: true,
      created_by: "operator",
      created_at: "2026-10-02T00:00:00Z",
    };
    const result = {
      status: "committed",
      record,
      receipt: {
        command_id: command.command_id,
        actor_authority_id: "operator",
        request_hash: "b".repeat(64),
        entry_id: record.entry_id,
        expected_revision: revision,
        committed_revision: revision + 1,
        committed_at: "2026-10-02T00:00:00Z",
      },
      duplicate: false,
    };
    records.set(key, record);
    receipts.set(command.command_id, { body, result });
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
      (row) => row.schema_tag === "morphz-human-profile/v1",
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
