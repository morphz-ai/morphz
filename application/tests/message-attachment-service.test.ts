import test from "node:test";
import { assertNoLegacyBusinessTables } from "./host-transport-invariant.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { Application } from "../packages/application/src/application.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { createAppServer } from "../apps/service/src/http.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { HumanPlatformAuthority } from "../packages/application/src/human-platform-authority.js";
import { MessageAttachmentService } from "../packages/application/src/message-attachment-service.js";

test("message attachments keep bytes outside the database and enforce owner identity across restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "morphz-message-store-"));
  const tenantId = randomUUID();
  const active = new Set(["alice", "bob"]);
  const human = new HumanPlatformAuthority(tenantId, (access) =>
    active.has(access.principalId),
  );
  const verifier = human.verifier({
    resolveActor: async () => null,
    resolveActant: async () => null,
    resolveProjectAgent: async () => null,
    verifyApplicationObject: async () => false,
  });
  let service = await MessageAttachmentService.open({
    root,
    tenantId,
    verifier,
    human,
  });
  const alice = { principalId: "alice", actantId: "alice-human" };
  const bob = { principalId: "bob", actantId: "bob-human" };
  const bytes = Buffer.from("One persisted message attachment.");
  try {
    const uploaded = await human.withSession(
      alice,
      () => {},
      (actor) => service.upload(actor, "note.txt", bytes),
    );
    assert.equal(uploaded.mime, "text/plain");
    const retry = await human.withSession(
      alice,
      () => {},
      (actor) => service.upload(actor, "note.txt", bytes),
    );
    assert.deepEqual(retry, uploaded, "same immutable upload is idempotent");
    await assert.rejects(
      human.withSession(
        bob,
        () => {},
        (actor) => service.readOwned(actor, uploaded.assetId),
      ),
      /附件不存在或无权访问/,
    );
    const ownCopy = await human.withSession(
      bob,
      () => {},
      (actor) => service.upload(actor, "note.txt", bytes),
    );
    assert.deepEqual(
      ownCopy,
      uploaded,
      "public digest alone conveys no ownership",
    );
    const manifest = new DatabaseSync(join(root, "manifest.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        (
          manifest
            .prepare("SELECT count(*) AS count FROM artifact_versions")
            .get() as { count: number }
        ).count,
        2,
      );
      assert.equal(
        (
          manifest.prepare("SELECT count(*) AS count FROM blobs").get() as {
            count: number;
          }
        ).count,
        1,
      );
    } finally {
      manifest.close();
    }
    await service.close();
    service = await MessageAttachmentService.open({
      root,
      tenantId,
      verifier,
      human,
    });
    const reopened = await human.withSession(
      alice,
      () => {},
      (actor) => service.readOwned(actor, uploaded.assetId),
    );
    assert.deepEqual(Buffer.from(reopened.bytes), bytes);
    await assert.rejects(
      service.readForDispatch(alice, {
        assetId: uploaded.assetId,
        name: "note.txt",
        mime: "text/markdown",
      }),
      /附件类型与保存的原件不一致/,
    );
    active.delete("bob");
    await assert.rejects(
      human.withSession(
        bob,
        () => {},
        (actor) => service.readOwned(actor, uploaded.assetId),
      ),
      /当前用户身份已失效/,
    );
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Desktop bridge and Web HTTP upload and preview the same attachment without legacy BLOB writes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-message-transport-"));
  const workspace = new WorkspaceStore(join(directory, "workspace.sqlite"));
  const domains = await openApplicationDomainsHost(directory, workspace);
  const options = {
    messageAttachments: domains.messageAttachments,
    platformWork: domains.work,
  };
  const local = new LocalApplicationConnection(
    new Application(workspace, options),
  );
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = createAppServer(workspace, {
    ...options,
    port,
    webRoot: "/nonexistent",
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  try {
    const bytes = Buffer.from("same transport bytes");
    const desktopBoot = (await local.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const uploaded = (await local.call(
      "attachment.add",
      { name: "sample.txt", data: bytes },
      { identityGeneration: desktopBoot.csrfToken },
    )) as { assetId: string; mime: string };
    const preview = await local.resource("attachments", uploaded.assetId);
    assert.deepEqual(Buffer.from(preview.bytes), bytes);
    const web = new HttpApplicationClient(`http://127.0.0.1:${port}`);
    const webBoot = (await web.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    assert.deepEqual(
      await web.call(
        "attachment.add",
        { name: "sample.txt", data: bytes },
        { identityGeneration: webBoot.csrfToken },
      ),
      uploaded,
    );
    const fetched = await fetch(
      `http://127.0.0.1:${port}/api/attachments/${uploaded.assetId}`,
    );
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers.get("content-type"), "text/plain");
    assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), bytes);
    assertNoLegacyBusinessTables(join(directory, "workspace.sqlite"));
  } finally {
    local.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await domains.close();
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
