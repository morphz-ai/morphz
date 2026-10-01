import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import {
  createDocument,
  readDocument,
} from "../packages/application/src/document-service.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { localAccess } from "../packages/core/src/model.js";
import {
  PlatformStore,
  PlatformStorageError,
  type ApplicationProviderRoute,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";

const verifier: PlatformAuthorityVerifier = {
  async resolveActor({ credential }) {
    if (credential !== "alice") return null;
    return {
      tenantId: "tenant-a",
      principalId: "alice",
      actantId: "alice",
      kind: "human",
      runtimeInputId: null,
    };
  },
  async resolveActant({ actantId }) {
    if (actantId === "alice") return { principalId: "alice", kind: "human" };
    if (actantId === "morphz-agent")
      return { principalId: "morphz-service", kind: "agent" };
    return null;
  },
  async resolveProjectAgent() {
    return { principalId: "morphz-service", actantId: "morphz-agent" };
  },
  async verifyApplicationObject(request) {
    return request.proof === `committed:${request.objectId}`;
  },
};

async function exerciseRouteBinding(store: PlatformStore) {
  const actor = { credential: "alice" };
  const oldProvider: ApplicationProviderRoute = {
    routeKind: "service",
    routeRef: "service:original",
  };
  const newProvider: ApplicationProviderRoute = {
    routeKind: "service",
    routeRef: "service:moved",
  };
  await store.provisionTenant("tenant-a");
  await store.createProject(actor, {
    commandId: "project-create",
    projectId: "project-one",
    title: "项目",
  });
  await store.registerApplication("tenant-a", {
    appId: "morphz.objects",
    installationId: "install-objects",
    instanceId: "objects-one",
    ...oldProvider,
  });
  await store.registerApplication("tenant-a", {
    appId: "morphz.browser",
    installationId: "install-browser",
    instanceId: "browser-one",
    ...oldProvider,
  });
  await store.recordContent(
    actor,
    { instanceId: "objects-one", proof: "committed:document-one" },
    {
      commandId: "catalog-document",
      appReceiptId: "receipt-document",
      contentId: "content-document",
      objectId: "document-one",
      projectId: "project-one",
      kind: "document",
      title: "文档",
      observedVersionRef: "1",
    },
  );
  assert.equal(
    (await store.content(actor, "content-document")).provider_revision,
    1,
  );
  const project = (provider: ApplicationProviderRoute) =>
    store.authorizeApplicationProject(
      actor,
      "objects-one",
      "morphz.objects",
      "project-one",
      provider,
    );
  const object = (provider: ApplicationProviderRoute) =>
    store.authorizeApplicationObject(
      actor,
      "objects-one",
      "morphz.objects",
      "document-one",
      "read",
      provider,
    );
  const bookmark = (provider: ApplicationProviderRoute) =>
    store.authorizePersonalApplicationAtRoute(
      actor,
      "browser-one",
      "morphz.browser",
      provider,
    );
  await project(oldProvider);
  await object(oldProvider);
  await bookmark(oldProvider);
  assert.equal(
    await store.updateApplicationRoute("tenant-a", {
      commandId: "objects-route-move",
      appId: "morphz.objects",
      instanceId: "objects-one",
      expectedRevision: 1,
      ...newProvider,
    }),
    2,
  );
  assert.equal(
    (await store.content(actor, "content-document")).provider_revision,
    2,
  );
  assert.equal(
    (await store.listContent(actor, { limit: 10 })).find(
      (entry) => entry.content_id === "content-document",
    )?.provider_revision,
    2,
  );
  assert.equal(
    await store.updateApplicationRoute("tenant-a", {
      commandId: "browser-route-move",
      appId: "morphz.browser",
      instanceId: "browser-one",
      expectedRevision: 1,
      ...newProvider,
    }),
    2,
  );
  for (const request of [
    () => project(oldProvider),
    () => object(oldProvider),
    () => bookmark(oldProvider),
  ])
    await assert.rejects(
      request(),
      (error: unknown) =>
        error instanceof PlatformStorageError && error.code === "conflict",
    );
  await project(newProvider);
  await object(newProvider);
  await bookmark(newProvider);
  const nodeProvider: ApplicationProviderRoute = {
    routeKind: "node",
    routeRef: "edge:node-one",
    nodeId: "node-one",
  };
  await store.updateApplicationRoute("tenant-a", {
    commandId: "objects-route-node",
    appId: "morphz.objects",
    instanceId: "objects-one",
    expectedRevision: 2,
    ...nodeProvider,
  });
  await assert.rejects(project(newProvider), /不由当前保存方提供/);
  await assert.rejects(object(newProvider), /不由当前保存方提供/);
  await project(nodeProvider);
  await object(nodeProvider);
  await assert.rejects(
    object({ ...nodeProvider, nodeId: "node-two" }),
    /不由当前保存方提供/,
  );
}

test("SQLite：应用实例重路由后旧服务不能授权原件", async () => {
  const store = await PlatformStore.sqlite(":memory:", verifier);
  try {
    await exerciseRouteBinding(store);
  } finally {
    await store.close();
  }
});

test("SQLite 正式 Host：原件路由变化后旧私库不能继续读写", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-stale-app-route-"));
  const workspace = new WorkspaceStore(join(directory, "workspace.sqlite"));
  let host: Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  try {
    host = await openApplicationDomainsHost(directory, workspace);
    await host.content.authority.withSession(
      localAccess,
      () => {},
      async (actor) => {
        await host!.content.platform.createProject(actor, {
          commandId: "create-project",
          projectId: "project-one",
          title: "项目",
        });
        await createDocument({
          platform: host!.content.platform,
          objects: host!.content.objects,
          actor,
          instanceId: host!.content.instanceIds.objects,
          commandId: "create-document",
          objectId: "document-one",
          projectId: "project-one",
          title: "原件",
          markdown: "# 原件",
        });
        const instanceId = host!.content.instanceIds.objects;
        await host!.content.platform.updateApplicationRoute(
          workspace.identity(),
          {
            commandId: "detach-objects",
            appId: "morphz.objects",
            instanceId,
            expectedRevision: 1,
            routeKind: "service",
            routeRef: "detached:objects",
          },
        );
        await assert.rejects(
          readDocument({
            objects: host!.content.objects,
            actor,
            objectId: "document-one",
          }),
          /不由当前保存方提供/,
        );
        await assert.rejects(
          createDocument({
            platform: host!.content.platform,
            objects: host!.content.objects,
            actor,
            instanceId,
            commandId: "stale-create",
            objectId: "document-two",
            projectId: "project-one",
            title: "不应创建",
            markdown: "# 不应保存",
          }),
          /不由当前保存方提供/,
        );
        await host!.content.platform.updateApplicationRoute(
          workspace.identity(),
          {
            commandId: "reattach-objects",
            appId: "morphz.objects",
            instanceId,
            expectedRevision: 2,
            routeKind: "service",
            routeRef: `embedded:${instanceId}`,
          },
        );
        const original = await readDocument({
          objects: host!.content.objects,
          actor,
          objectId: "document-one",
        });
        assert.equal(original.content.markdown, "# 原件");
        await assert.rejects(
          readDocument({
            objects: host!.content.objects,
            actor,
            objectId: "document-two",
          }),
          /不存在|不可用/,
        );
      },
    );
  } finally {
    await host?.close();
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "PostgreSQL：应用实例重路由后旧服务不能授权原件",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `route_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const store = await PlatformStore.postgres(
        { connectionString, schema },
        verifier,
      );
      try {
        await exerciseRouteBinding(store);
      } finally {
        await store.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
