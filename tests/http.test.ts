import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { createAppServer } from "../apps/service/src/http.js";
import { WorkspaceStore } from "../apps/service/src/store.js";
async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
test("本机 API 的请求校验、幂等和 HTTP 修订冲突", async () => {
  const port = await freePort(),
    store = new WorkspaceStore(":memory:"),
    server = createAppServer(store, { port, webRoot: "/nonexistent" }),
    origin = `http://127.0.0.1:${port}`;
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  try {
    const bootResponse = await fetch(origin + "/api/workspace"),
      boot = (await bootResponse.json()) as { csrfToken: string };
    const headers = {
      Origin: origin,
      "Content-Type": "application/json",
      "X-MorphzWork-Token": boot.csrfToken,
    };
    const request = {
      commandId: randomUUID(),
      operation: {
        type: "create-artifact",
        projectId: "first-project",
        title: "API 对象",
        content: { kind: "document", markdown: "正文" },
      },
    };
    const post = (value: unknown, overrides = {}) =>
      fetch(origin + "/api/commands", {
        method: "POST",
        headers: { ...headers, ...overrides },
        body: JSON.stringify(value),
      });
    assert.equal(
      (await post(request, { Origin: "https://evil.example" })).status,
      403,
    );
    assert.equal(
      (await post(request, { "X-MorphzWork-Token": "" })).status,
      403,
    );
    const badHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        origin + "/api/workspace",
        { headers: { Host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(badHost, 403);
    assert.equal(
      (
        await fetch(origin + "/api/workspace", {
          headers: { Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    const response = await post(request),
      receipt = (await response.json()) as { entityId: string };
    assert.equal(response.status, 200);
    assert.deepEqual(await (await post(request)).json(), receipt);
    const revision = {
      commandId: randomUUID(),
      operation: {
        type: "revise-artifact",
        artifactId: receipt.entityId,
        expectedRevision: 1,
        title: "新的",
        content: { kind: "document", markdown: "新正文" },
      },
    };
    assert.equal((await post(revision)).status, 200);
    assert.equal(
      (await post({ ...revision, commandId: randomUUID() })).status,
      409,
    );
    assert.equal(
      (
        await post({
          ...request,
          commandId: randomUUID(),
          principalId: "admin",
        })
      ).status,
      400,
    );
    const snapshot = await fetch(origin + "/api/workspace"),
      etag = snapshot.headers.get("etag")!;
    assert.equal(
      (
        await fetch(origin + "/api/workspace", {
          headers: { "If-None-Match": etag },
        })
      ).status,
      304,
    );
    assert.match(
      snapshot.headers.get("content-security-policy")!,
      /object-src 'none'/,
    );
    assert.equal((await fetch(origin + "/%2e%2e%2fpackage.json")).status, 403);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});
