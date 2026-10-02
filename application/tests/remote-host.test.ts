import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteApplicationConnection } from "../apps/desktop/remote-host.js";
import { embeddedResources } from "../apps/desktop/application-host.js";
import { createAppServer } from "../apps/service/src/http.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { IdentityCenter } from "../packages/application/src/identity.js";
import { localAccess } from "../packages/core/src/model.js";
import { ApplicationRequestError } from "../packages/core/src/application-api.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { emptyPlatformStream } from "./platform-stream-fixture.js";

const status = (expected: number) => (error: unknown) =>
  error instanceof ApplicationRequestError && error.status === expected;

test("远端消息附件预览携带确切输入来源，不改变其他资源路由", async () => {
  let requested = "";
  const remote = new RemoteApplicationConnection(
    "https://fixture.invalid",
    async (input) => {
      requested = String(input);
      return new Response("accepted bytes", {
        headers: { "Content-Type": "text/plain" },
      });
    },
  );
  try {
    const source = {
      projectId: "project-one",
      conversationId: "conversation-one",
      inputId: "input-one",
    };
    const value = await remote.resource("attachments", "a".repeat(64), source);
    assert.equal(Buffer.from(value.bytes).toString(), "accepted bytes");
    const url = new URL(requested);
    assert.equal(url.pathname, `/api/attachments/${"a".repeat(64)}`);
    assert.deepEqual(Object.fromEntries(url.searchParams), source);
    await assert.rejects(
      remote.resource("assets", "a".repeat(64), source),
      status(400),
    );
  } finally {
    remote.close();
  }
});

test("远端 Desktop PDF 原件通过认证连接按 Range 读取并拒绝伪造响应", async () => {
  const bytes = new Uint8Array(300);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const ranges: string[] = [];
  let malformed = false;
  let changedDigest = false;
  const remote = new RemoteApplicationConnection(
    "https://fixture.invalid",
    async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/api/reader/original");
      assert.equal(url.searchParams.get("artifactId"), "reader-fixture");
      assert.equal(url.searchParams.get("revision"), "2");
      assert.equal(init?.credentials, "include");
      const range = new Headers(init?.headers).get("range")!;
      ranges.push(range);
      const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      const start = Number(match[1]);
      const end = Number(match[2]);
      return new Response(bytes.subarray(start, end + 1), {
        status: 206,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": String(end - start + 1),
          "Content-Range": malformed
            ? "bytes 0-0/300"
            : `bytes ${start}-${end}/${bytes.length}`,
          ETag: `"${changedDigest && start > 0 ? "f".repeat(64) : sha256}"`,
        },
      });
    },
  );
  try {
    const resources = embeddedResources("/nonexistent", remote);
    const url =
      "morphz://app/api/reader/original?artifactId=reader-fixture&revision=2";
    const response = await resources(
      new Request(url, { headers: { Range: "bytes=7-127" } }),
    );
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 7-127/300");
    assert.deepEqual(
      new Uint8Array(await response.arrayBuffer()),
      bytes.subarray(7, 128),
    );
    assert.deepEqual(ranges, ["bytes=0-0", "bytes=7-127"]);
    malformed = true;
    const bad = await resources(
      new Request(url, { headers: { Range: "bytes=7-127" } }),
    );
    assert.equal(bad.status, 206);
    await assert.rejects(bad.arrayBuffer(), /远端 PDF 原件响应无效/);
    malformed = false;
    changedDigest = true;
    const changed = await resources(
      new Request(url, { headers: { Range: "bytes=7-127" } }),
    );
    await assert.rejects(changed.arrayBuffer(), /PDF 原件版本已变化/);
    remote.close();
    assert.equal((await resources(new Request(url))).status, 408);
  } finally {
    remote.close();
  }
});

test("远端 Desktop PDF 原件分块读取，不将整份大文件缓冲到单次请求", async () => {
  const bytes = new Uint8Array(2 * 1024 * 1024 + 17);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const ranges: string[] = [];
  const remote = new RemoteApplicationConnection(
    "https://fixture.invalid",
    async (_input, init) => {
      const range = new Headers(init?.headers).get("range")!;
      ranges.push(range);
      const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      const start = Number(match[1]);
      const end = Number(match[2]);
      return new Response(bytes.subarray(start, end + 1), {
        status: 206,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
          ETag: `"${sha256}"`,
        },
      });
    },
  );
  try {
    const resources = embeddedResources("/nonexistent", remote);
    const response = await resources(
      new Request(
        "morphz://app/api/reader/original?artifactId=large-fixture&revision=1",
      ),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    assert.deepEqual(ranges, [
      "bytes=0-0",
      "bytes=0-1048575",
      "bytes=1048576-2097151",
      `bytes=2097152-${bytes.length - 1}`,
    ]);
  } finally {
    remote.close();
  }
});

test("远端桥接受 Platform 启动握手并用其身份代际保护后续请求", async () => {
  const paths: string[] = [];
  const remote = new RemoteApplicationConnection(
    "https://fixture.invalid",
    async (input) => {
      paths.push(String(input));
      if (String(input).endsWith("/api/platform/bootstrap"))
        return Response.json({ csrfToken: "platform-generation" });
      return Response.json({ ok: true });
    },
  );
  try {
    const boot = (await remote.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    assert.equal(boot.csrfToken, "platform-generation");
    await remote.call("spaces.ensure", undefined, {
      identityGeneration: boot.csrfToken,
    });
    await assert.rejects(
      remote.call("spaces.ensure", undefined, {
        identityGeneration: "stale-generation",
      }),
      status(403),
    );
    assert.equal(paths.length, 2);
  } finally {
    remote.close();
  }
});

test("远端桥实际 HTTP：私有身份、幂等回执、二进制资源、订阅与撤销", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-remote-platform-"));
  const store = new WorkspaceStore(join(directory, "workspace.sqlite"), {
    mode: "transport",
  });
  const other = { principalId: "remote-other", actantId: "remote-human" };
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
  const domains = await openApplicationDomainsHost(directory, store, identity);
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const server = createAppServer(store, {
    port,
    identity,
    webRoot: "/nonexistent",
    platformWork: domains.work,
    platformDocuments: domains.content,
    images: domains.images,
    runtime: emptyPlatformStream(domains),
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
    await assert.rejects(remote.call("platform.bootstrap"), status(401));
    await remote.call("login", { token: tokens[0] });
    const boot = (await remote.call("platform.bootstrap")) as any;
    const options = { identityGeneration: boot.csrfToken };
    const spaces = (await remote.call("spaces.ensure", undefined, options)) as {
      deskId: string;
      dialogueId: string;
    };
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const asset = (await remote.call("asset.add", bytes, options)) as any;
    const command = {
      commandId: randomUUID(),
      objectId: `image_${randomUUID().replaceAll("-", "")}`,
      projectId: spaces.deskId,
      title: "远端权限验收",
      assetId: asset.assetId,
      alt: "权限验收",
    };
    const receipt = (await remote.call(
      "images.create",
      command,
      options,
    )) as any;
    assert.deepEqual(
      await remote.call("images.create", command, options),
      receipt,
    );
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
      {
        kind: "platform",
        projectId: spaces.dialogueId,
        conversationId: spaces.dialogueId,
      },
      boot.csrfToken,
      (value) => {
        assert.ok("messages" in value);
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
    const next = (await remote.call("platform.bootstrap")) as any;
    assert.equal(next.principalId, other.principalId);
    assert.notEqual(next.csrfToken, boot.csrfToken);
    await assert.rejects(
      remote.call("images.create", command, options),
      status(403),
    );
    await assert.rejects(
      remote.call(
        "content.get",
        { contentId: receipt.contentId },
        { identityGeneration: next.csrfToken },
      ),
      status(404),
    );
    const forbidden = await embeddedResources(
      "/nonexistent",
      remote,
    )(new Request(`morphz://app/api/assets/${asset.assetId}`));
    assert.ok([403, 404].includes(forbidden.status));
    await identity.replaceConfiguration({
      ...configuration,
      members: configuration.members.map((m) => ({
        ...m,
        enabled: m.principalId !== other.principalId,
      })),
    });
    await assert.rejects(remote.call("platform.bootstrap"), status(401));
    remote.close();
    await assert.rejects(remote.call("platform.bootstrap"), status(408));
    await assert.rejects(remote.resource("assets", asset.assetId), status(408));
  } finally {
    remote.close();
    server.closeStreams();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await domains.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
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
      if (String(input).endsWith("/api/platform/bootstrap")) {
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
  await remote.call("platform.bootstrap");
  const old = remote.call("platform.bootstrap");
  const oldFailure = assert.rejects(old, status(408));
  const login = remote.call("login", { token: "fixture" });
  await assert.rejects(
    remote.call("projects.create", {}, { identityGeneration: "old" }),
    status(409),
  );
  finishLogin(Response.json({ authenticated: true }));
  await login;
  await remote.call("platform.bootstrap");
  finishOld(Response.json({ csrfToken: "old" }));
  await oldFailure;
  await remote.call("projects.create", {}, { identityGeneration: "new" });
  assert.equal(writes, 1);
  remote.close();
});
