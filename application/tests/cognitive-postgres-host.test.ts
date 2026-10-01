import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import {
  openApplicationDomainsHost,
  postgresApplicationInstanceIds,
  type PostgresApplicationDomains,
} from "../packages/application/src/application-domains-host.js";
import {
  backupCloudApplicationStorage,
  verifyCloudContentReferences,
} from "../packages/application/src/cloud-deployment-backup.js";
import {
  createDocument,
  readDocument,
} from "../packages/application/src/document-service.js";
import { createScriptProduction } from "../packages/application/src/script-production-service.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { localAccess } from "../packages/core/src/model.js";

const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL;

test(
  "PostgreSQL 认知应用私库跨 Host 读同一原件，错误实例与旧本机库均拒绝静默切换",
  {
    skip: !connectionString,
  },
  async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
    const platformSchema = `p_${suffix}`;
    const applications: PostgresApplicationDomains = {
      connectionStrings: {
        objects: connectionString!,
        scriptStudio: connectionString!,
        reader: connectionString!,
        browser: connectionString!,
      },
      deploymentId: `cognitive_${suffix}`,
      schemas: {
        objects: `o_${suffix}`,
        scriptStudio: `s_${suffix}`,
        reader: `r_${suffix}`,
        browser: `b_${suffix}`,
      },
    };
    const directoryA = mkdtempSync(join(tmpdir(), "morphz-app-postgres-a-"));
    const directoryB = mkdtempSync(join(tmpdir(), "morphz-app-postgres-b-"));
    const directoryC = mkdtempSync(join(tmpdir(), "morphz-app-postgres-c-"));
    const directoryD = mkdtempSync(join(tmpdir(), "morphz-app-postgres-d-"));
    const wrongSchemas: PostgresApplicationDomains["schemas"] = {
      objects: `ow_${suffix}`,
      scriptStudio: `sw_${suffix}`,
      reader: `rw_${suffix}`,
      browser: `bw_${suffix}`,
    };
    const databaseA = join(directoryA, "workspace.sqlite");
    const databaseB = join(directoryB, "workspace.sqlite");
    const pool = new Pool({ connectionString });
    let workspaceA: WorkspaceStore | undefined;
    let workspaceB: WorkspaceStore | undefined;
    let hostA:
      Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
    let hostB:
      Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
    const options = {
      platform: {
        kind: "postgres" as const,
        connectionString: connectionString!,
        schema: platformSchema,
      },
      applications,
    };
    try {
      for (const schema of [
        platformSchema,
        ...Object.values(applications.schemas),
        ...Object.values(wrongSchemas),
      ])
        await pool.query(`CREATE SCHEMA "${schema}"`);
      workspaceA = new WorkspaceStore(databaseA);
      const tenantId = workspaceA.identity();
      hostA = await openApplicationDomainsHost(
        directoryA,
        workspaceA,
        undefined,
        options,
      );
      const original = await hostA.content.authority.withSession(
        localAccess,
        () => {},
        async (actor) => {
          await hostA!.content.platform.createProject(actor, {
            commandId: `create_${suffix}`,
            projectId: `project_${suffix}`,
            title: "PostgreSQL 原件验收",
          });
          return createDocument({
            platform: hostA!.content.platform,
            objects: hostA!.content.objects,
            actor,
            instanceId: hostA!.content.instanceIds.objects,
            commandId: `document_${suffix}`,
            objectId: `object_${suffix}`,
            projectId: `project_${suffix}`,
            title: "跨宿主正文",
            markdown: "# 同一份原件\n不是另一份本机副本。",
          });
        },
      );
      assert.equal(original.original.versionRef, "1");
      workspaceA.saveServiceState("host-private-check", { host: "A" });
      assert.equal(existsSync(join(directoryA, "objects.sqlite")), false);
      assert.equal(existsSync(join(directoryA, "script-studio.sqlite")), false);
      assert.equal(existsSync(join(directoryA, "reader.sqlite")), false);
      assert.equal(existsSync(join(directoryA, "browser.sqlite")), false);
      assert.equal(
        existsSync(join(directoryA, "application-instances.json")),
        false,
      );
      await hostA.close();
      hostA = undefined;
      workspaceA.close();
      workspaceA = undefined;

      workspaceB = new WorkspaceStore(databaseB, { tenantId });
      assert.equal(workspaceB.identity(), tenantId);
      assert.equal(workspaceB.serviceState("host-private-check"), null);
      assert.equal(
        workspaceB.runtimeState(),
        null,
        "新 Host 不复制 A 的消息投递",
      );
      hostB = await openApplicationDomainsHost(
        directoryB,
        workspaceB,
        undefined,
        options,
      );
      assert.deepEqual(
        hostB.content.instanceIds,
        postgresApplicationInstanceIds(tenantId, applications),
      );
      await hostB.content.authority.withSession(
        localAccess,
        () => {},
        async (actor) => {
          const catalog = await hostB!.content.platform.content(
            actor,
            original.contentId,
          );
          assert.equal(catalog.instance_id, hostB!.content.instanceIds.objects);
          const read = await readDocument({
            objects: hostB!.content.objects,
            actor,
            objectId: `object_${suffix}`,
          });
          assert.equal(
            read.content.markdown,
            "# 同一份原件\n不是另一份本机副本。",
          );
        },
      );
      await hostB.reader.authority.withSession(
        localAccess,
        () => {},
        (actor) =>
          hostB!.reader.service.import(actor, {
            commandId: `book_${suffix}`,
            projectId: `project_${suffix}`,
            name: "原文.md",
            bytes: Buffer.from("# 第一章\n\n原文。", "utf8"),
          }),
      );
      await hostB.content.authority.withSession(
        localAccess,
        () => {},
        async (actor) => {
          const hosted = [
            {
              appId: "morphz.objects",
              instanceId: hostB!.content.instanceIds.objects,
              attempt: () =>
                readDocument({
                  objects: hostB!.content.objects,
                  actor,
                  objectId: `object_${suffix}`,
                }),
            },
            {
              appId: "morphz.script-studio",
              instanceId: hostB!.content.instanceIds.scriptStudio,
              attempt: () =>
                createScriptProduction({
                  platform: hostB!.content.platform,
                  studio: hostB!.content.studio,
                  actor,
                  instanceId: hostB!.content.instanceIds.scriptStudio,
                  commandId: `stale_script_${suffix}`,
                  productionId: `stale_script_${suffix}`,
                  projectId: `project_${suffix}`,
                  title: "不应由旧 Host 创建",
                }),
            },
            {
              appId: "morphz.reader",
              instanceId: hostB!.content.instanceIds.reader,
              attempt: () =>
                hostB!.reader.service.import(actor, {
                  commandId: `stale_book_${suffix}`,
                  projectId: `project_${suffix}`,
                  name: "不应导入.md",
                  bytes: Buffer.from("# 未提交", "utf8"),
                }),
            },
            {
              appId: "morphz.browser",
              instanceId: hostB!.content.instanceIds.browser,
              attempt: () => hostB!.browser.service.list(actor),
            },
          ];
          for (const [index, app] of hosted.entries()) {
            const result = await pool.query<{ route_ref: string }>(
              `SELECT route_ref FROM "${platformSchema}".app_instances WHERE tenant_id=$1 AND instance_id=$2`,
              [tenantId, app.instanceId],
            );
            const originalRoute = result.rows[0]?.route_ref;
            assert.ok(originalRoute);
            await hostB!.content.platform.updateApplicationRoute(tenantId, {
              commandId: `detach_${index}_${suffix}`,
              appId: app.appId,
              instanceId: app.instanceId,
              expectedRevision: 1,
              routeKind: "service",
              routeRef: `detached:${index}:${suffix}`,
            });
            try {
              await assert.rejects(app.attempt(), /不由当前保存方提供/);
              if (app.appId === "morphz.objects")
                await assert.rejects(
                  hostB!.images.service.upload(
                    actor,
                    Buffer.from("89504e470d0a1a0a", "hex"),
                  ),
                  /不由当前保存方提供/,
                );
            } finally {
              await hostB!.content.platform.updateApplicationRoute(tenantId, {
                commandId: `reattach_${index}_${suffix}`,
                appId: app.appId,
                instanceId: app.instanceId,
                expectedRevision: 2,
                routeKind: "service",
                routeRef: originalRoute,
              });
            }
          }
          const preserved = await readDocument({
            objects: hostB!.content.objects,
            actor,
            objectId: `object_${suffix}`,
          });
          assert.equal(
            preserved.content.markdown,
            "# 同一份原件\n不是另一份本机副本。",
          );
        },
      );
      await hostB.content.platform.registerApplication(tenantId, {
        appId: "morphz.objects",
        installationId: "install_morphz_objects",
        instanceId: `objects_external_${suffix}`,
        routeKind: "service",
        routeRef: `external:${suffix}`,
      });
      await hostB.close();
      hostB = undefined;

      await assert.rejects(
        openApplicationDomainsHost(directoryB, workspaceB, undefined, {
          ...options,
          applications: {
            ...applications,
            schemas: {
              ...applications.schemas,
              browser: wrongSchemas.browser,
            },
          },
        }),
        /应用实例身份或路由与既有记录冲突/,
      );

      const workspaceD = new WorkspaceStore(
        join(directoryD, "workspace.sqlite"),
        { tenantId },
      );
      try {
        await assert.rejects(
          openApplicationDomainsHost(directoryD, workspaceD, undefined, {
            ...options,
            applications: { ...applications, schemas: wrongSchemas },
          }),
          /应用实例身份或路由与既有记录冲突/,
        );
      } finally {
        workspaceD.close();
      }

      const workspaceC = new WorkspaceStore(
        join(directoryC, "workspace.sqlite"),
        { tenantId },
      );
      try {
        await assert.rejects(
          openApplicationDomainsHost(
            directoryC,
            workspaceC,
            undefined,
            options,
          ),
          /缺少原件 Store/,
        );
      } finally {
        workspaceC.close();
      }

      await assert.rejects(
        openApplicationDomainsHost(directoryB, workspaceB, undefined, {
          ...options,
          applications: { ...applications, deploymentId: `other_${suffix}` },
        }),
        /另一认知应用实例的原件/,
      );
      const localDirectory = mkdtempSync(
        join(tmpdir(), "morphz-app-postgres-local-"),
      );
      const localWorkspace = new WorkspaceStore(
        join(localDirectory, "workspace.sqlite"),
      );
      try {
        const localHost = await openApplicationDomainsHost(
          localDirectory,
          localWorkspace,
        );
        await localHost.close();
        await assert.rejects(
          openApplicationDomainsHost(
            localDirectory,
            localWorkspace,
            undefined,
            options,
          ),
          /拒绝直接切到 PostgreSQL 隐藏原件/,
        );
      } finally {
        localWorkspace.close();
        rmSync(localDirectory, { recursive: true, force: true });
      }

      workspaceB.close();
      workspaceB = undefined;
      const cloudBackupRoot = mkdtempSync(
        join(tmpdir(), "morphz-catalog-backup-check-"),
      );
      try {
        const now = new Date().toISOString();
        await pool.query(
          `INSERT INTO "${platformSchema}".content_entries
            (tenant_id,content_id,app_id,instance_id,app_object_id,project_id,kind,title,
             observed_version_ref,observed_at,availability,revision,created_at,updated_at,deleted_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,$13,NULL)`,
          [
            tenantId,
            `external_${suffix}`,
            "morphz.objects",
            `objects_external_${suffix}`,
            `external_original_${suffix}`,
            `project_${suffix}`,
            "document",
            "外部应用实例的内容",
            "1",
            now,
            "available",
            now,
            now,
          ],
        );
        const cloudRelations = {
          tenantId,
          platform: {
            connectionString: connectionString!,
            schema: platformSchema,
          },
          applications,
        };
        await verifyCloudContentReferences(cloudRelations);
        await pool.query(
          `UPDATE "${platformSchema}".content_entries SET app_object_id=$1 WHERE content_id=$2`,
          [`missing_${suffix}`, original.contentId],
        );
        await assert.rejects(
          verifyCloudContentReferences(cloudRelations),
          /morphz\.objects 原件缺失或已删除/,
        );
        await assert.rejects(
          backupCloudApplicationStorage({
            location: {
              ...cloudRelations,
              stores: {
                connectionString: connectionString!,
                schemas: {
                  ui: `ui_${suffix}`,
                  reader: `rb_${suffix}`,
                  images: `im_${suffix}`,
                },
                bytes: {
                  bucket: `unopened-${suffix}`,
                  prefix: `unused-${suffix}`,
                  region: "us-east-1",
                },
              },
            },
            backupRoot: cloudBackupRoot,
            stagingRoot: cloudBackupRoot,
            writersStopped: true,
          }),
          /morphz\.objects 原件缺失或已删除/,
        );
      } finally {
        rmSync(cloudBackupRoot, { recursive: true, force: true });
      }
    } finally {
      await hostB?.close();
      await hostA?.close();
      workspaceB?.close();
      workspaceA?.close();
      for (const schema of [
        platformSchema,
        ...Object.values(applications.schemas),
        ...Object.values(wrongSchemas),
      ])
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
      rmSync(directoryA, { recursive: true, force: true });
      rmSync(directoryB, { recursive: true, force: true });
      rmSync(directoryC, { recursive: true, force: true });
      rmSync(directoryD, { recursive: true, force: true });
    }
  },
);

test(
  "四个内置认知应用可各用独立 PostgreSQL 数据库，Platform 仍能验证原件",
  { skip: !connectionString },
  async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
    const tenantDirectory = mkdtempSync(join(tmpdir(), "morphz-app-isolated-"));
    const platformSchema = `p_${suffix}`;
    const kinds = ["objects", "scriptStudio", "reader", "browser"] as const;
    const schemas = {
      objects: `app_${suffix}`,
      scriptStudio: `app_${suffix}`,
      reader: `app_${suffix}`,
      browser: `app_${suffix}`,
    };
    const databaseNames = {
      objects: `morphz_objects_${suffix}`,
      scriptStudio: `morphz_script_${suffix}`,
      reader: `morphz_reader_${suffix}`,
      browser: `morphz_browser_${suffix}`,
    };
    const connectionStrings = Object.fromEntries(
      kinds.map((kind) => {
        const url = new URL(connectionString!);
        url.pathname = `/${databaseNames[kind]}`;
        return [kind, url.toString()];
      }),
    ) as PostgresApplicationDomains["connectionStrings"];
    const admin = new Pool({ connectionString });
    const created: Array<(typeof kinds)[number]> = [];
    let workspace: WorkspaceStore | undefined;
    let host:
      Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
    try {
      await admin.query(`CREATE SCHEMA "${platformSchema}"`);
      for (const kind of kinds) {
        await admin.query(`CREATE DATABASE "${databaseNames[kind]}"`);
        created.push(kind);
        const database = new Pool({
          connectionString: connectionStrings[kind],
        });
        try {
          await database.query(`CREATE SCHEMA "${schemas[kind]}"`);
        } finally {
          await database.end();
        }
      }
      workspace = new WorkspaceStore(join(tenantDirectory, "workspace.sqlite"));
      const tenantId = workspace.identity();
      const applications: PostgresApplicationDomains = {
        connectionStrings,
        deploymentId: `isolated_${suffix}`,
        schemas,
      };
      host = await openApplicationDomainsHost(
        tenantDirectory,
        workspace,
        undefined,
        {
          platform: {
            kind: "postgres",
            connectionString: connectionString!,
            schema: platformSchema,
          },
          applications,
        },
      );
      await host.content.authority.withSession(
        localAccess,
        () => {},
        async (actor) => {
          await host!.content.platform.createProject(actor, {
            commandId: `project_${suffix}`,
            projectId: `project_${suffix}`,
            title: "独立私库",
          });
          await createDocument({
            platform: host!.content.platform,
            objects: host!.content.objects,
            actor,
            instanceId: host!.content.instanceIds.objects,
            commandId: `document_${suffix}`,
            objectId: `object_${suffix}`,
            projectId: `project_${suffix}`,
            title: "文档",
            markdown: "# 独立数据库",
          });
          await createScriptProduction({
            platform: host!.content.platform,
            studio: host!.content.studio,
            actor,
            instanceId: host!.content.instanceIds.scriptStudio,
            commandId: `script_${suffix}`,
            productionId: `script_${suffix}`,
            projectId: `project_${suffix}`,
            title: "剧本",
          });
          await host!.browser.service.list(actor);
        },
      );
      await host.reader.authority.withSession(
        localAccess,
        () => {},
        (actor) =>
          host!.reader.service.import(actor, {
            commandId: `book_${suffix}`,
            projectId: `project_${suffix}`,
            name: "书.md",
            bytes: Buffer.from("# 第一章\n\n正文。", "utf8"),
          }),
      );
      await verifyCloudContentReferences({
        tenantId,
        platform: {
          connectionString: connectionString!,
          schema: platformSchema,
        },
        applications,
      });
      for (const kind of kinds) {
        const database = new Pool({
          connectionString: connectionStrings[kind],
        });
        try {
          const binding = await database.query<{ app_id: string }>(
            `SELECT app_id FROM "${schemas[kind]}".morphz_app_binding WHERE tenant_id=$1`,
            [tenantId],
          );
          assert.equal(binding.rowCount, 1);
        } finally {
          await database.end();
        }
      }
      const source = await admin.query<{ relation: string | null }>(
        "SELECT to_regclass($1) AS relation",
        [`${schemas.objects}.objects`],
      );
      assert.equal(source.rows[0]?.relation, null);
    } finally {
      await host?.close();
      workspace?.close();
      for (const kind of created.toReversed())
        await admin.query(`DROP DATABASE "${databaseNames[kind]}"`);
      await admin.query(`DROP SCHEMA IF EXISTS "${platformSchema}" CASCADE`);
      await admin.end();
      rmSync(tenantDirectory, { recursive: true, force: true });
    }
  },
);

test("PostgreSQL 应用配置必须有稳定部署 ID 和不冲突的数据库命名空间", () => {
  const base: PostgresApplicationDomains = {
    connectionStrings: {
      objects: "postgresql:///test",
      scriptStudio: "postgresql:///test",
      reader: "postgresql:///test",
      browser: "postgresql:///test",
    },
    deploymentId: "cloud-production",
    schemas: {
      objects: "objects",
      scriptStudio: "script_studio",
      reader: "reader",
      browser: "browser",
    },
  };
  const tenant = randomUUID();
  assert.deepEqual(
    postgresApplicationInstanceIds(tenant, base),
    postgresApplicationInstanceIds(tenant, base),
  );
  assert.notDeepEqual(
    postgresApplicationInstanceIds(tenant, base),
    postgresApplicationInstanceIds(tenant, { ...base, deploymentId: "other" }),
  );
  assert.deepEqual(
    postgresApplicationInstanceIds(tenant, base),
    postgresApplicationInstanceIds(tenant, {
      ...base,
      connectionStrings: {
        ...base.connectionStrings,
        reader: "postgresql:///moved-reader",
      },
    }),
    "数据库位置变化不应重铸应用实例身份",
  );
  assert.throws(
    () =>
      postgresApplicationInstanceIds(tenant, {
        ...base,
        connectionStrings: { ...base.connectionStrings, reader: "" },
      }),
    /四个认知应用的 PostgreSQL 连接/,
  );
  assert.throws(
    () =>
      postgresApplicationInstanceIds(tenant, {
        ...base,
        schemas: { ...base.schemas, browser: "objects" },
      }),
    /同一 PostgreSQL 数据库内不能复用/,
  );
});
