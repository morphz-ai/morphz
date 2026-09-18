import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:net";
import { RemoteApplicationConnection } from "../apps/desktop/remote-host.js";
import { embeddedResources } from "../apps/desktop/application-host.js";
import { createAppServer } from "../apps/service/src/http.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { IdentityCenter } from "../packages/application/src/identity.js";
import { localAccess } from "../packages/core/src/model.js";
import { ApplicationRequestError } from "../packages/core/src/application-api.js";

const status = (expected: number) => (error: unknown) =>
  error instanceof ApplicationRequestError && error.status === expected;

test("远端桥实际 HTTP：私有身份、幂等回执、二进制资源、订阅与撤销", async () => {
  const store = new WorkspaceStore(":memory:");
  const other = { principalId: "remote-other", actantId: "remote-human" };
  store.provisionMembers([
    { ...other, name: "远端成员", projectIds: [], enabled: true },
  ]);
  const tokens = ["c".repeat(64), "d".repeat(64)];
  const configuration = {
    version: 1,
    members: [localAccess, other].map((access, i) => ({
      ...access,
      enabled: true,
      loginTokenHash: createHash("sha256").update(tokens[i]!).digest("hex"),
    })),
  };
  const identity = new IdentityCenter(store, configuration);
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const server = createAppServer(store, {
    port,
    identity,
    webRoot: "/nonexistent",
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${port}`;
  // This cookie jar models the native host's private session, never the renderer.
  let cookie = "";
  const request: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    if (cookie) headers.set("Cookie", cookie);
    const response = await fetch(input, { ...init, headers });
    const saved = response.headers.get("set-cookie");
    if (saved) cookie = saved.split(";")[0]!;
    return response;
  };
  const remote = new RemoteApplicationConnection(origin, request);
  try {
    await assert.rejects(remote.call("workspace"), status(401));
    await remote.call("login", { token: tokens[0] });
    const boot = (await remote.call("workspace")) as any;
    const options = { identityGeneration: boot.csrfToken };
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const asset = (await remote.call("asset.add", bytes, options)) as any;
    const command = {
      commandId: randomUUID(),
      operation: {
        type: "create-artifact",
        projectId: "first-project",
        title: "远端权限验收",
        content: { kind: "image", assetId: asset.assetId, alt: "权限验收" },
      },
    };
    const receipt = (await remote.call("command", command, options)) as any;
    assert.deepEqual(await remote.call("command", command, options), receipt);
    assert.equal(boot.centerId, store.identity());
    assert.deepEqual(
      (await remote.resource("assets", asset.assetId)).bytes,
      bytes,
    );
    let first!: () => void;
    const observed = new Promise<void>((r) => {
      first = r;
    });
    await remote.observe(
      randomUUID(),
      { projectId: "first-project", conversationId: "first-project" },
      boot.csrfToken,
      (value) => {
        assert.deepEqual(value.messages, []);
        first();
      },
      () => {},
    );
    await Promise.race([
      observed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("stream timeout")), 2000).unref(),
      ),
    ]);
    await remote.call("login", { token: tokens[1] });
    const next = (await remote.call("workspace")) as any;
    assert.equal(next.principalId, other.principalId);
    assert.notEqual(next.csrfToken, boot.csrfToken);
    await assert.rejects(remote.call("command", command, options), status(403));
    await assert.rejects(
      remote.call(
        "artifact.read",
        { id: receipt.entityId },
        { identityGeneration: next.csrfToken },
      ),
      status(403),
    );
    const forbidden = await embeddedResources(
      "/nonexistent",
      remote,
    )(new Request(`morphz://app/api/assets/${asset.assetId}`));
    assert.ok([403, 404].includes(forbidden.status));
    identity.replaceConfiguration({
      ...configuration,
      members: configuration.members.map((m) => ({
        ...m,
        enabled: m.principalId !== other.principalId,
      })),
    });
    await assert.rejects(remote.call("workspace"), status(401));
    remote.close();
    await assert.rejects(remote.call("workspace"), status(408));
    await assert.rejects(remote.resource("assets", asset.assetId), status(408));
  } finally {
    remote.close();
    server.closeStreams();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});

test("远端资源流有界，超限停止读取，身份变化不返回迟到字节", async () => {
  let pulls = 0,
    cancelled = false;
  const remote = new RemoteApplicationConnection(
    "https://fixture.invalid",
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulls++;
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await assert.rejects(remote.resource("assets", "fixture"), status(413));
  assert.ok(pulls <= 27, `unbounded read: ${pulls}`);
  assert.ok(cancelled);
  remote.close();
  let resolve!: (response: Response) => void;
  const late = new RemoteApplicationConnection(
    "https://fixture.invalid",
    async () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = late.resource("assets", "fixture");
  late.invalidate();
  resolve(new Response(new Uint8Array([1, 2, 3])));
  await assert.rejects(pending, status(403));
  late.close();
});

test("远端身份切换期间禁止新操作，取消旧请求并隔离迟到响应", async () => {
  let workspaceCalls = 0,
    writes = 0;
  let finishOld!: (response: Response) => void,
    finishLogin!: (response: Response) => void;
  const remote = new RemoteApplicationConnection(
    "https://fixture.invalid",
    async (input) => {
      if (String(input).endsWith("/api/workspace")) {
        workspaceCalls++;
        if (workspaceCalls === 2)
          return new Promise((r) => {
            finishOld = r;
          });
        return Response.json({
          csrfToken: workspaceCalls === 1 ? "old" : "new",
        });
      }
      if (String(input).endsWith("/api/identity/login"))
        return new Promise((r) => {
          finishLogin = r;
        });
      writes++;
      return Response.json({});
    },
  );
  await remote.call("workspace");
  const old = remote.call("workspace");
  const oldFailure = assert.rejects(old, status(408));
  const login = remote.call("login", { token: "fixture" });
  await assert.rejects(
    remote.call("command", {}, { identityGeneration: "old" }),
    status(409),
  );
  finishLogin(Response.json({ authenticated: true }));
  await login;
  await remote.call("workspace");
  finishOld(Response.json({ csrfToken: "old" }));
  await oldFailure;
  await remote.call("command", {}, { identityGeneration: "new" });
  assert.equal(writes, 1);
  remote.close();
});
