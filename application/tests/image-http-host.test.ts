import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppServer } from "../apps/service/src/http.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { localAccess } from "../packages/core/src/model.js";

test("正式 HTTP 图片上传、创建与预览走同一 Objects 原件", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-image-http-"));
  const workspace = new WorkspaceStore(join(directory, "workspace.sqlite"));
  let domains: Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  let server: ReturnType<typeof createAppServer> | undefined;
  try {
    domains = await openApplicationDomainsHost(directory, workspace);
    await domains.content.authority.withSession(localAccess, () => {},
      (actor) => domains!.content.platform.createProject(actor, {
        commandId: randomUUID(), projectId: "image-http-project", title: "HTTP 图片",
      }));
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    server = createAppServer(workspace, {
      port,
      webRoot: "/nonexistent",
      platformWork: domains.work,
      platformDocuments: domains.content,
      images: domains.images,
    });
    await new Promise<void>((resolve) => server!.listen(port, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${port}`;
    const client = new HttpApplicationClient(origin);
    const boot = await client.call("platform.bootstrap") as { csrfToken: string };
    const options = { identityGeneration: boot.csrfToken };
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLytQAAAABJRU5ErkJggg==",
      "base64",
    );
    const assetId = createHash("sha256").update(png).digest("hex");
    const uploaded = await client.call("asset.add", png, options) as {
      assetId: string; mime: string;
    };
    assert.deepEqual(uploaded, { assetId, mime: "image/png" });
    assert.equal((await fetch(`${origin}/api/assets/${assetId}`)).status, 404);
    const created = await client.call("images.create", {
      commandId: randomUUID(), objectId: "http-image", projectId: "image-http-project",
      title: "一张图片", assetId, alt: "HTTP 预览",
    }, options) as { contentId: string };
    assert.ok(created.contentId);
    const response = await fetch(`${origin}/api/assets/${assetId}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    const document = await client.call("documents.create", {
      commandId: randomUUID(), objectId: "http-document", projectId: "image-http-project",
      title: "HTTP 文档", markdown: "可以批注的原文",
    }, options) as { contentId: string };
    const note = {
      commandId: randomUUID(), contentId: document.contentId, revision: 1,
      quote: "原文", body: "HTTP 批注",
    };
    const saved = await client.call("objects.annotate", note, options) as { id: string };
    assert.equal(saved.id, note.commandId);
    assert.deepEqual(await client.call("objects.annotate", note, options), saved);
    const annotations = await client.call("objects.annotations", {
      contentId: document.contentId, limit: 100,
    }, options) as Array<{ annotation: { id: string } }>;
    assert.deepEqual(annotations.map((entry) => entry.annotation.id), [saved.id]);
  } finally {
    const running = server;
    if (running) await new Promise<void>((resolve) => running.close(() => resolve()));
    await domains?.close();
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
