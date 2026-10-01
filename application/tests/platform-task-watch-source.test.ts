import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { Application } from "../packages/application/src/application.js";
import {
  openApplicationDomainsHost,
  type PostgresApplicationDomains,
} from "../packages/application/src/application-domains-host.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { createDocument } from "../packages/application/src/document-service.js";
import { createScriptProduction } from "../packages/application/src/script-production-service.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import type { RuntimeBridge } from "../packages/application/src/runtime.js";
import { localAccess } from "../packages/core/src/model.js";
import type { ApplicationMethod } from "../packages/core/src/application-api.js";
import type {
  PlatformActor,
  TaskWatchSource,
} from "../packages/platform/src/store.js";
import type { TaskRunAdmission } from "../packages/platform/src/task-run-admission.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";

const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;
const baseline = (run: TaskRunAdmission) =>
  JSON.parse(run.sourceSignature) as Array<
    TaskWatchSource & { versionRef: string }
  >;

/** Real Host authority, Platform and app stores; only Runtime Session
 * preparation is controlled. These tests neither execute a model nor fake
 * source data, directory receipts or app version authorization. */
async function fixture(backend: "sqlite" | "postgres") {
  const directory = mkdtempSync(join(tmpdir(), "morphz-source-admission-"));
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const schemas = {
    objects: `o_${suffix}`,
    scriptStudio: `s_${suffix}`,
    reader: `r_${suffix}`,
    browser: `b_${suffix}`,
  };
  const platformSchema = `p_${suffix}`;
  const applications: PostgresApplicationDomains = {
    connectionStrings: {
      objects: postgresUrl!,
      scriptStudio: postgresUrl!,
      reader: postgresUrl!,
      browser: postgresUrl!,
    },
    deploymentId: `source_${suffix}`,
    schemas,
  };
  const admin =
    backend === "postgres" ? new Pool({ connectionString: postgresUrl }) : null;
  const options =
    backend === "postgres"
      ? {
          platform: {
            kind: "postgres" as const,
            connectionString: postgresUrl!,
            schema: platformSchema,
          },
          applications,
        }
      : {};
  if (admin)
    for (const schema of [platformSchema, ...Object.values(schemas)])
      await admin.query(`CREATE SCHEMA "${schema}"`);
  const transport = new WorkspaceStore(join(directory, "workspace.sqlite"), {
    mode: "transport",
  });
  let domains = await openApplicationDomainsHost(
    directory,
    transport,
    undefined,
    options,
  );
  const projectId = "source-project";
  const runtime = {
    isConnected: true,
    as: <T>(_access: unknown, action: () => T) => action(),
    preparePlatformTaskSession: async () => "host-source-session",
    validateInference: async () => {},
  } as unknown as RuntimeBridge;
  const makeLocal = () =>
    new LocalApplicationConnection(
      new Application(transport, {
        runtime,
        platformWork: domains.work,
        platformDocuments: domains.content,
        platformScripts: domains.content,
        platformReader: domains.reader,
        platformTaskRuns: {
          authority: domains.work.authority,
          store: domains.content.platform,
        },
      }),
    );
  let local = makeLocal();
  let csrf = ((await local.call("platform.bootstrap")) as { csrfToken: string })
    .csrfToken;
  const human = <T>(
    work: (actor: PlatformActor) => Promise<T>,
    active: () => void = () => {},
  ) => domains.work.authority.withSession(localAccess, active, work);
  await human((actor) =>
    domains.work.service.createProject(actor, {
      commandId: randomUUID(),
      projectId,
      title: "真实来源版本",
    }),
  );
  const document = async () =>
    human((actor) =>
      createDocument({
        platform: domains.content.platform,
        objects: domains.content.objects,
        actor,
        instanceId: domains.content.instanceIds.objects,
        commandId: randomUUID(),
        objectId: randomUUID(),
        projectId,
        title: "关注原件",
        markdown: "第一版真实正文",
      }),
    );
  const task = async (watchSourceIds: string[]) => {
    const taskId = randomUUID();
    await human((actor) =>
      domains.work.service.createTask(actor, {
        commandId: randomUUID(),
        taskId,
        projectId,
        title: "关注来源事项",
        assigneeId: "morphz-agent",
        watchSourceIds,
      }),
    );
    return taskId;
  };
  return {
    projectId,
    human,
    document,
    task,
    get domains() {
      return domains;
    },
    call: <T>(method: ApplicationMethod, args: unknown) =>
      local.call(method, args, { identityGeneration: csrf }) as Promise<T>,
    async pending() {
      return domains.content.platform.pendingTaskRuns(transport.identity());
    },
    async reopen() {
      await domains.close();
      domains = await openApplicationDomainsHost(
        directory,
        transport,
        undefined,
        options,
      );
      local = makeLocal();
      csrf = ((await local.call("platform.bootstrap")) as { csrfToken: string })
        .csrfToken;
    },
    async close() {
      await domains.close();
      transport.close();
      if (admin) {
        for (const schema of [platformSchema, ...Object.values(schemas)])
          await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

for (const backend of ["sqlite", "postgres"] as const) {
  const settings = { skip: backend === "postgres" && !postgresUrl };
  test(
    `${backend}: Desktop 关注事项首轮读取 App 真正版本，不读取正文；重试和重启保持原基线`,
    settings,
    async () => {
      const f = await fixture(backend);
      try {
        const doc = await f.document();
        await f.human((actor) =>
          f.domains.content.objects.reviseDocument({
            credential: actor.credential,
            commandId: randomUUID(),
            objectId: doc.original.objectId,
            expectedRevision: 1,
            title: "关注原件",
            markdown: "App 已提交第二版，目录还未投影",
          }),
        );
        const observed = await f.human((actor) =>
          f.domains.content.platform.content(actor, doc.contentId),
        );
        assert.equal(observed.observed_version_ref, "1");
        // Admission must use the small authoritative head, not copy a body or
        // confuse the stale Platform observation with the app's current head.
        f.domains.content.objects.readObject = async () => {
          throw new Error("Admission must not read full text");
        };
        f.domains.content.objects.readDocument = async () => {
          throw new Error("Admission must not read full text");
        };
        const taskId = await f.task([doc.contentId]);
        const command = {
          commandId: randomUUID(),
          taskId,
          expectedRevision: 1,
        };
        const first = await f.call("tasks.run-request", command);
        const [admission] = await f.pending();
        assert.ok(admission);
        assert.deepEqual(baseline(admission), [
          {
            kind: "content",
            sourceId: doc.contentId,
            projectId: f.projectId,
            appId: "morphz.objects",
            instanceId: f.domains.content.instanceIds.objects,
            objectId: doc.original.objectId,
            catalogRevision: 1,
            providerRevision: 1,
            observedVersionRef: "1",
            versionRef: "2",
          },
        ]);
        assert.deepEqual(await f.call("tasks.run-request", command), first);
        await assert.rejects(
          f.call("tasks.run-request", {
            ...command,
            commandId: randomUUID(),
            sourceSignature: "forged-current-version",
          }),
          /请求格式无效/,
        );
        await f.reopen();
        assert.equal(
          (
            await f.human((actor) =>
              f.domains.content.platform.content(actor, doc.contentId),
            )
          ).observed_version_ref,
          "2",
        );
        assert.deepEqual(await f.call("tasks.run-request", command), first);
        assert.deepEqual((await f.pending())[0], admission);
      } finally {
        await f.close();
      }
    },
  );

  test(
    `${backend}: 精确读期间来源移动或 Human 撤权，不写事项执行与 outbox`,
    settings,
    async () => {
      const f = await fixture(backend);
      try {
        const doc = await f.document();
        const taskId = await f.task([doc.contentId]);
        const readHead = f.domains.content.objects.readObjectHead.bind(
          f.domains.content.objects,
        );
        await f.human((actor) =>
          f.domains.work.service.createProject(actor, {
            commandId: randomUUID(),
            projectId: "moved-source-project",
            title: "来源移动目的地",
          }),
        );
        f.domains.content.objects.readObjectHead = async (request) => {
          const result = await readHead(request);
          await f.human((actor) =>
            f.domains.content.platform.moveContent(actor, {
              commandId: randomUUID(),
              contentId: doc.contentId,
              targetProjectId: "moved-source-project",
              expectedRevision: 1,
            }),
          );
          return result;
        };
        await assert.rejects(
          f.call("tasks.run-request", {
            commandId: randomUUID(),
            taskId,
            expectedRevision: 1,
          }),
          /关注来源|同一项目/,
        );
        assert.deepEqual(await f.pending(), []);
        assert.equal(
          (
            await f.human((actor) =>
              f.domains.work.service.taskVersion(actor, { taskId }),
            )
          ).runRequested,
          0,
        );
        f.domains.content.objects.readObjectHead = readHead;
        const doc2 = await f.document();
        const secondTask = await f.task([doc2.contentId]);
        let active = true;
        f.domains.content.objects.readObjectHead = async (request) => {
          const result = await readHead(request);
          active = false;
          return result;
        };
        await assert.rejects(
          f.human(
            (actor) =>
              f.domains.work.service.requestTaskRun(actor, {
                commandId: randomUUID(),
                taskId: secondTask,
                expectedRevision: 1,
                sessionId: "host-source-session",
                intent: "关注来源事项",
                notBefore: "2026-09-30T00:00:00.000Z",
              }),
            () => {
              if (!active) throw new Error("Human access revoked during read");
            },
          ),
          /revoked/,
        );
        assert.deepEqual(await f.pending(), []);
        f.domains.content.objects.readObjectHead = readHead;
        assert.equal(
          (
            await f.human((actor) =>
              f.domains.work.service.taskVersion(actor, { taskId: secondTask }),
            )
          ).runRequested,
          0,
        );
      } finally {
        await f.close();
      }
    },
  );

  test(
    `${backend}: 来源事项用 Platform 修订；剧本和读物用各自 App 版本`,
    settings,
    async () => {
      const f = await fixture(backend);
      try {
        const sourceTask = await f.task([]);
        await f.human((actor) =>
          f.domains.work.service.reviseTask(actor, {
            commandId: randomUUID(),
            taskId: sourceTask,
            expectedRevision: 1,
            title: "来源事项已修订",
          }),
        );
        const script = await f.human((actor) =>
          createScriptProduction({
            platform: f.domains.content.platform,
            studio: f.domains.content.studio,
            actor,
            instanceId: f.domains.content.instanceIds.scriptStudio,
            commandId: randomUUID(),
            productionId: randomUUID(),
            projectId: f.projectId,
            title: "关注的剧本",
          }),
        );
        const book = await f.human((actor) =>
          f.domains.reader.service.import(actor, {
            commandId: randomUUID(),
            projectId: f.projectId,
            name: "阅读.md",
            bytes: Buffer.from("# 章一\n来源原文"),
          }),
        );
        const taskId = await f.task([
          sourceTask,
          script.contentId,
          book.entityId,
        ]);
        await f.call("tasks.run-request", {
          commandId: randomUUID(),
          taskId,
          expectedRevision: 1,
        });
        const [admission] = await f.pending();
        assert.ok(admission);
        const versions = baseline(admission);
        assert.deepEqual(versions[0], {
          kind: "task",
          sourceId: sourceTask,
          projectId: f.projectId,
          revision: 2,
          versionRef: "2",
        });
        assert.deepEqual(
          versions.slice(1).map((source) => ({
            app: source.kind === "content" ? source.appId : "unexpected-task",
            versionRef: source.versionRef,
          })),
          [
            { app: "morphz.script-studio", versionRef: "1" },
            { app: "morphz.reader", versionRef: "1" },
          ],
        );
      } finally {
        await f.close();
      }
    },
  );
}

test("Agent 正式工具无需自造来源签名即可请求关注事项首轮", async () => {
  const f = await agentDomainFixture({
    prepareTaskSession: async () => "agent-watched-task-session",
  });
  try {
    const source = await f.withHuman((actor) =>
      createDocument({
        platform: f.domains.content.platform,
        objects: f.domains.content.objects,
        actor,
        instanceId: f.domains.content.instanceIds.objects,
        commandId: randomUUID(),
        objectId: randomUUID(),
        projectId: f.projectId,
        title: "Agent 关注资料",
        markdown: "真正的来源原件",
      }),
    );
    const taskId = randomUUID();
    await f.withHuman((actor) =>
      f.domains.work.service.createTask(actor, {
        commandId: randomUUID(),
        taskId,
        projectId: f.projectId,
        title: "Agent 请求首轮",
        assigneeId: "morphz-agent",
        watchSourceIds: [source.contentId],
      }),
    );
    const result = await f.call<{ taskId: string; runNumber: number }>({
      action: "work-task",
      workTask: { action: "start", taskId, revision: 1 },
    });
    assert.equal(result.taskId, taskId);
    assert.equal(result.runNumber, 1);
    const [admission] = await f.domains.content.platform.pendingTaskRuns(
      f.transport.identity(),
    );
    assert.ok(admission);
    assert.equal(admission.sessionId, "agent-watched-task-session");
    assert.equal(baseline(admission)[0]!.versionRef, "1");
    assert.equal(
      admission.sourceInputId,
      f.route.thread_id.slice("thread_".length),
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});
