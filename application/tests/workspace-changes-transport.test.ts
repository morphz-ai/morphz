import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createAppServer } from "../apps/service/src/http.js";
import { RemoteApplicationConnection } from "../apps/desktop/remote-host.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { Application } from "../packages/application/src/application.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import type { WorkspaceChange } from "../packages/core/src/workspace-changes.js";
import { localAccess } from "../packages/core/src/model.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("stream未到达");
    await pause(10);
  }
}
async function availablePort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

test("SSE 初始授权proof失败立即结束请求，不挂住且不输出存储错误", async () => {
  const transport = new WorkspaceStore(":memory:", { mode: "transport" });
  const port = await availablePort();
  const server = createAppServer(transport, {
    port,
    webRoot: "/nonexistent",
    workspaceChanges: {
      sources: [],
      async readVersion() {
        throw new Error("/private/database credentials secret");
      },
    },
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/platform/workspace/stream`,
      { signal: AbortSignal.timeout(1500) },
    );
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.match(body, /unavailable/);
    assert.doesNotMatch(body, /private|database|credentials|secret/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    transport.close();
  }
});

test("真实HTTP SSE与remote Desktop复用Host proof：初始/提交/取消后静默/重连resync，拒绝跨Origin及额外scope", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-workspace-sse-"));
  const transport = new WorkspaceStore(join(directory, "workspace.sqlite"), {
    mode: "transport",
  });
  const domains = await openApplicationDomainsHost(directory, transport);
  const options = {
    platformWork: domains.work,
    platformDocuments: domains.content,
    workspaceChanges: domains.workspaceChanges,
  };
  const local = new LocalApplicationConnection(
    new Application(transport, options),
  );
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const server = createAppServer(transport, {
    port,
    webRoot: "/nonexistent",
    ...options,
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  const remote = new RemoteApplicationConnection(origin, fetch);
  try {
    const boot = (await remote.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const localBoot = (await local.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const spaces = (await local.call("spaces.ensure", undefined, {
      identityGeneration: localBoot.csrfToken,
    })) as { deskId: string };
    assert.equal(
      (
        await fetch(origin + "/api/platform/workspace/stream", {
          headers: { Origin: "https://hostile.invalid" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(origin + "/api/platform/workspace/stream?projectId=private"))
        .status,
      400,
    );
    await assert.rejects(
      remote.observe(
        randomUUID(),
        { kind: "workspace", projectId: "private" },
        boot.csrfToken,
        () => {},
        () => {},
      ),
    );
    await assert.rejects(
      remote.observe(
        randomUUID(),
        { kind: "workspace" },
        "old-generation",
        () => {},
        () => {},
      ),
    );
    const frames: WorkspaceChange[] = [],
      id = randomUUID();
    await remote.observe(
      id,
      { kind: "workspace" },
      boot.csrfToken,
      (frame) => {
        assert.ok("kind" in frame);
        frames.push(frame);
      },
      () => {},
    );
    await until(() => frames.length === 1);
    assert.equal(frames[0]!.reason, "resync");
    const task = {
      commandId: randomUUID(),
      taskId: "sse-task",
      projectId: spaces.deskId,
      title: "内容不发送给stream",
      assigneeId: localAccess.actantId,
    };
    await local.call("tasks.create", task, {
      identityGeneration: localBoot.csrfToken,
    });
    await until(() => frames.length === 2);
    assert.equal(frames[1]!.reason, "changed");
    remote.unobserve(id);
    await local.call(
      "tasks.create",
      { ...task, commandId: randomUUID(), taskId: "after-unsubscribe" },
      { identityGeneration: localBoot.csrfToken },
    );
    await pause(60);
    assert.equal(frames.length, 2);
    const reconnected: WorkspaceChange[] = [];
    await remote.observe(
      randomUUID(),
      { kind: "workspace" },
      boot.csrfToken,
      (frame) => {
        assert.ok("kind" in frame);
        reconnected.push(frame);
      },
      () => {},
    );
    await until(() => reconnected.length === 1);
    assert.deepEqual(reconnected[0], {
      kind: "workspace",
      sequence: 1,
      reason: "resync",
      accessChanged: false,
    });
    for (const frame of frames)
      assert.deepEqual(Object.keys(frame).sort(), [
        "accessChanged",
        "kind",
        "reason",
        "sequence",
      ]);
  } finally {
    remote.close();
    local.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pause(10);
    await domains.close();
    transport.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const invalid of [
  "extra-field",
  "non-monotonic",
  "conversation-frame",
] as const)
  test(`remote workspace丢弃${invalid}并关闭，不输出原JSON或旧代消息`, async () => {
    const frames: unknown[] = [],
      valid = {
        kind: "workspace",
        sequence: 1,
        reason: "resync",
        accessChanged: false,
      };
    const bad =
      invalid === "extra-field"
        ? { ...valid, database: "/private/credentials" }
        : invalid === "conversation-frame"
          ? { connected: true, messages: [], removed: [], reset: true }
          : valid;
    let closed = 0;
    const remote = new RemoteApplicationConnection(
      "https://fixture.invalid",
      async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/platform/bootstrap")
          return Response.json({
            csrfToken: "generation-one",
            principalId: "local-owner",
            actantId: "local-human",
          });
        assert.equal(url.pathname, "/api/platform/workspace/stream");
        return new Response(
          `data: ${JSON.stringify(valid)}\n\ndata: ${JSON.stringify(bad)}\n\ndata: ${JSON.stringify({ ...valid, sequence: 2, reason: "changed" })}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    );
    try {
      const boot = (await remote.call("platform.bootstrap")) as {
        csrfToken: string;
      };
      await remote.observe(
        randomUUID(),
        { kind: "workspace" },
        boot.csrfToken,
        (frame) => frames.push(frame),
        () => closed++,
      );
      await until(() => closed === 1);
      assert.deepEqual(frames, [valid]);
      assert.doesNotMatch(
        JSON.stringify(frames),
        /database|credentials|messages/,
      );
    } finally {
      remote.close();
    }
  });
