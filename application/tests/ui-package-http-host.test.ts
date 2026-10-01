import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAppServer } from "../apps/service/src/http.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { applicationManifestFormat } from "../packages/core/src/application-names.js";

test("正式 HTTP 安装经 Platform 与 Store；工作台只读声明，打开时按版本取字节", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-ui-http-"));
  const workspace = new WorkspaceStore(join(directory, "workspace.sqlite"));
  let domains:
    Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  let server: ReturnType<typeof createAppServer> | undefined;
  try {
    domains = await openApplicationDomainsHost(directory, workspace);
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    server = createAppServer(workspace, {
      port,
      webRoot: "/nonexistent",
      uiPackages: domains.uiPackages,
    });
    await new Promise<void>((resolve) =>
      server!.listen(port, "127.0.0.1", resolve),
    );
    const origin = `http://127.0.0.1:${port}`;
    const client = new HttpApplicationClient(origin);
    const boot = (await client.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const options = { identityGeneration: boot.csrfToken };
    const manifest = {
      format: applicationManifestFormat,
      id: "example.notes",
      version: "1.0.0",
      title: "便笺",
      description: "记录想法",
      icon: "document",
      permissions: ["artifacts.read"],
      harness: null,
      ui: {
        type: "sandbox",
        html: "<!doctype html><title>实际安装字节</title>",
      },
    };
    assert.equal(
      (await fetch(`${origin}/api/application-view/example.notes@1.0.0`))
        .status,
      404,
    );
    const commandId = randomUUID();
    assert.equal(
      await client.call("apps.install", { commandId, manifest }, options),
      "example.notes@1.0.0",
    );
    assert.equal(
      await client.call("apps.install", { commandId, manifest }, options),
      "example.notes@1.0.0",
    );
    const listing = (await client.call(
      "apps.list",
      undefined,
      options,
    )) as unknown[];
    assert.equal(listing.length, 1);
    assert.equal(JSON.stringify(listing).includes("实际安装字节"), false);
    const response = await fetch(
      `${origin}/api/application-view/example.notes@1.0.0`,
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "text/html; charset=utf-8",
    );
    assert.match(
      response.headers.get("content-security-policy") ?? "",
      /default-src/,
    );
    assert.equal(await response.text(), manifest.ui.html);
    const encodedResponse = await fetch(
      `${origin}/api/application-view/example.notes%401.0.0`,
    );
    assert.equal(encodedResponse.status, 200);
    assert.equal(await encodedResponse.text(), manifest.ui.html);
    const platform = new DatabaseSync(join(directory, "platform.sqlite"), {
      readOnly: true,
    });
    try {
      const row = platform
        .prepare(
          "SELECT manifest_header,store_id,artifact_id FROM app_ui_packages",
        )
        .get() as {
        manifest_header: string;
        store_id: string;
        artifact_id: string;
      };
      assert.equal(row.manifest_header.includes(manifest.ui.html), false);
      assert.match(row.store_id, /^store_ui_/);
      assert.match(row.artifact_id, /^ui_/);
    } finally {
      platform.close();
    }
  } finally {
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    await domains?.close();
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
