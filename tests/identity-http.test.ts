import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { IdentityCenter } from "../apps/service/src/identity.js";
import { createAppServer } from "../apps/service/src/http.js";
import { localAccess } from "../packages/core/src/model.js";

test("两个真实 HTTP 身份：登录、文件和对象隔离、共享项目、伪造拒绝及撤销", async () => {
  const store = new WorkspaceStore(":memory:"),
    other = { principalId: "other", actantId: "other-human" };
  store.provisionMembers([
    { ...other, name: "另一位成员", projectIds: [], enabled: true },
  ]);
  const projectId = store.execute(
    {
      commandId: randomUUID(),
      operation: { type: "create-project", title: "另一位成员的项目" },
    },
    other,
  ).entityId;
  const privateId = store.execute(
    {
      commandId: randomUUID(),
      operation: {
        type: "create-artifact",
        projectId: "first-project",
        title: "不能共享的资料",
        content: { kind: "document", markdown: "保密内容" },
      },
    },
    localAccess,
  ).entityId;
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    asset = store.addAsset(png, localAccess);
  const tokens = ["a".repeat(64), "b".repeat(64)],
    config = {
      version: 1,
      members: [localAccess, other].map((access, i) => ({
        ...access,
        loginTokenHash: createHash("sha256").update(tokens[i]!).digest("hex"),
        enabled: true,
      })),
    };
  const identity = new IdentityCenter(store, config),
    probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const server = createAppServer(store, {
      port,
      webRoot: "/nonexistent",
      identity,
    }),
    origin = `http://127.0.0.1:${port}`;
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  try {
    assert.equal((await fetch(origin + "/api/workspace")).status, 401);
    assert.equal((await fetch(origin + "/api/notifications")).status, 401);
    assert.equal((await fetch(origin + "/api/speech/status")).status, 401);
    const login = async (token: string) => {
      const r = await fetch(origin + "/api/identity/login", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      assert.equal(r.status, 200);
      const header = r.headers.get("set-cookie")!;
      assert.ok(
        header.includes("HttpOnly") && header.includes("SameSite=Strict"),
      );
      return header.split(";")[0]!;
    };
    const cookieA = await login(tokens[0]!),
      cookieB = await login(tokens[1]!);
    const boot = async (cookie: string) =>
      (
        await fetch(origin + "/api/workspace", { headers: { Cookie: cookie } })
      ).json();
    const a = await boot(cookieA),
      b = await boot(cookieB);
    assert.equal(a.principalId, localAccess.principalId);
    assert.equal(b.principalId, other.principalId);
    assert.ok(!JSON.stringify(b).includes("保密内容"));
    assert.ok(!JSON.stringify(a).includes("另一位成员的项目"));
    const get = (path: string) =>
      fetch(origin + path, { headers: { Cookie: cookieB } });
    assert.deepEqual(
      (await (await get("/api/notifications")).json()).items,
      [],
    );
    assert.equal((await get("/api/artifacts/" + privateId)).status, 403);
    assert.equal((await get("/api/assets/" + asset.assetId)).status, 404);
    assert.equal(
      (await get("/api/tasks/" + privateId + "/runtime")).status,
      403,
    );
    const search = await (
      await get("/api/search?q=" + encodeURIComponent("保密"))
    ).json();
    assert.equal(search.total, 0);
    const post = (operation: unknown, token = b.csrfToken) =>
      fetch(origin + "/api/commands", {
        method: "POST",
        headers: {
          Cookie: cookieB,
          Origin: origin,
          "Content-Type": "application/json",
          "X-MorphzWork-Token": token,
        },
        body: JSON.stringify({ commandId: randomUUID(), operation }),
      });
    const image = {
      type: "create-artifact",
      projectId,
      title: "试图引用其他人的上传",
      content: { kind: "image", assetId: asset.assetId, alt: "" },
    };
    assert.equal((await post(image)).status, 403);
    assert.equal((await post(image, a.csrfToken)).status, 403);
    assert.equal(
      (
        await post({
          type: "create-artifact",
          projectId: "first-project",
          title: "越权",
          content: { kind: "document", markdown: "" },
        })
      ).status,
      403,
    );
    // After explicit operator provisioning, both people see the same authorized project.
    store.provisionMembers([
      {
        ...other,
        name: "另一位成员",
        projectIds: [projectId, "first-project"],
        enabled: true,
      },
    ]);
    assert.ok(JSON.stringify(await boot(cookieB)).includes("保密内容"));
    const shared = await post({
      type: "create-artifact",
      projectId: "first-project",
      title: "真实成员创作",
      content: { kind: "document", markdown: "共同工作" },
    });
    assert.equal(shared.status, 200);
    const receipt = await shared.json();
    assert.equal(
      store.snapshot().artifacts.find((a) => a.id === receipt.entityId)!
        .createdBy.principalId,
      other.principalId,
    );
    identity.replaceConfiguration({
      ...config,
      members: config.members.map((m) => ({
        ...m,
        enabled: m.principalId !== other.principalId,
      })),
    });
    assert.equal((await get("/api/workspace")).status, 401);
    assert.equal((await post(image)).status, 401);
    assert.equal(
      (await fetch(origin + "/api/workspace", { headers: { Cookie: cookieA } }))
        .status,
      200,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});
