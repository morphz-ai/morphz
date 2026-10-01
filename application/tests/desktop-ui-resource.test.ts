import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { RemoteApplicationConnection } from "../apps/desktop/remote-host.js";
import { embeddedResources } from "../apps/desktop/application-host.js";
import { createAppServer } from "../apps/service/src/http.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { ApplicationRequestError } from "../packages/core/src/application-api.js";
import { applicationManifestFormat } from "../packages/core/src/application-names.js";

test("Desktop remote and embedded resource paths read the exact installed app@version through the actual HTTP domain", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-desktop-ui-resource-"));
  const transport = new WorkspaceStore(join(directory, "host.sqlite"), {
    mode: "transport",
  });
  let domains:
    Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  let server: ReturnType<typeof createAppServer> | undefined;
  let remote: RemoteApplicationConnection | undefined;
  try {
    domains = await openApplicationDomainsHost(directory, transport);
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    server = createAppServer(transport, {
      port,
      webRoot: "/nonexistent",
      uiPackages: domains.uiPackages,
    });
    await new Promise<void>((resolve) =>
      server!.listen(port, "127.0.0.1", resolve),
    );
    const origin = `http://127.0.0.1:${port}`;
    let requests = 0;
    remote = new RemoteApplicationConnection(origin, async (...args) => {
      requests++;
      return fetch(...args);
    });
    const bootstrap = (await remote.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const manifest = {
      format: applicationManifestFormat,
      id: "example.desktop-notes",
      version: "1.2.0",
      title: "桌面便笺",
      description: "实际安装字节读取回归",
      icon: "document",
      permissions: ["artifacts.read"],
      harness: null,
      ui: {
        type: "sandbox",
        html: "<!doctype html><meta charset='utf-8'><title>真实应用包</title><p>实际存储的认知应用界面</p>",
      },
    };
    const id = `${manifest.id}@${manifest.version}`;
    await assert.rejects(
      remote.resource("application-view", id),
      (error: unknown) =>
        error instanceof ApplicationRequestError && error.status === 404,
    );
    assert.equal(
      await remote.call(
        "apps.install",
        { commandId: randomUUID(), manifest },
        { identityGeneration: bootstrap.csrfToken },
      ),
      id,
    );
    const direct = await remote.resource("application-view", id);
    assert.equal(direct.mime, "text/html; charset=utf-8");
    assert.equal(Buffer.from(direct.bytes).toString(), manifest.ui.html);
    const resources = embeddedResources("/nonexistent", remote);
    for (const resourceId of [id, encodeURIComponent(id)]) {
      const response = await resources(
        new Request(`morphz://app/api/application-view/${resourceId}`),
      );
      assert.equal(response.status, 200);
      assert.equal(await response.text(), manifest.ui.html);
      assert.match(
        response.headers.get("content-security-policy") ?? "",
        /sandbox allow-scripts/,
      );
      assert.match(
        response.headers.get("content-security-policy") ?? "",
        /connect-src 'none'/,
      );
      assert.match(
        response.headers.get("permissions-policy") ?? "",
        /microphone=\(\)/,
      );
    }
    const prior = requests;
    for (const invalid of [
      "example.desktop-notes",
      "example.desktop-notes@latest",
      "example.desktop-notes@1.2.0/extra",
      "../example.desktop-notes@1.2.0",
      "example.desktop-notes%401.2.0",
    ])
      await assert.rejects(
        remote.resource("application-view", invalid),
        (error: unknown) =>
          error instanceof ApplicationRequestError && error.status === 400,
      );
    assert.equal(
      requests,
      prior,
      "malformed App IDs never reach the HTTP authority",
    );
    assert.equal(
      (
        await resources(
          new Request("morphz://other/api/application-view/" + id),
        )
      ).status,
      403,
    );
    remote.close();
    assert.equal(
      (await resources(new Request("morphz://app/api/application-view/" + id)))
        .status,
      408,
    );
  } finally {
    remote?.close();
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    await domains?.close();
    transport.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
