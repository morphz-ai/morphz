import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import {
  AgentTools,
  type HostInvocation,
  type ToolScope,
} from "../packages/application/src/agent-tools.js";
import { PlatformAgentTools } from "../packages/application/src/platform-agent-tools.js";
import type { RuntimeBridge } from "../packages/application/src/runtime.js";
import { localAccess, morphzAgentAccess } from "../packages/core/src/model.js";
import {
  browserApplication,
  scriptStudioApplication,
  type ApplicationInstance,
} from "../packages/core/src/applications.js";

const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;
const other = { principalId: "other-human", actantId: "other-human-actant" };
type Listed = {
  applications: Array<{
    id: string;
    version: string;
    title: string;
    harness: unknown;
  }>;
  instances: Array<{ id: string; applicationId: string }>;
  total: number;
  hasMore: boolean;
};
type Launched = {
  instance: ApplicationInstance;
  receipt: { commandId: string; entityId: string };
};

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: 真实聊天 Agent 查找和打开已安装应用，保留 Human 窗口权限与幂等`,
    { skip: backend === "postgres" && !postgresUrl },
    async () => {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
      const schemas = {
        platform: `ap_${suffix}`,
        objects: `ao_${suffix}`,
        scriptStudio: `as_${suffix}`,
        reader: `ar_${suffix}`,
        browser: `ab_${suffix}`,
        ui: `au_${suffix}`,
      };
      const uiRoot = mkdtempSync(join(tmpdir(), "morphz-app-navigation-ui-"));
      const admin =
        backend === "postgres"
          ? new Pool({ connectionString: postgresUrl })
          : null;
      let f: Awaited<ReturnType<typeof agentDomainFixture>> | undefined;
      try {
        if (admin)
          for (const schema of Object.values(schemas))
            await admin.query(`CREATE SCHEMA "${schema}"`);
        f = await agentDomainFixture({
          additionalHumans: [other],
          ...(admin
            ? {
                storage: {
                  platform: {
                    kind: "postgres" as const,
                    connectionString: postgresUrl!,
                    schema: schemas.platform,
                  },
                  applications: {
                    connectionStrings: {
                      objects: postgresUrl!,
                      scriptStudio: postgresUrl!,
                      reader: postgresUrl!,
                      browser: postgresUrl!,
                    },
                    deploymentId: `app_navigation_${suffix}`,
                    schemas: {
                      objects: schemas.objects,
                      scriptStudio: schemas.scriptStudio,
                      reader: schemas.reader,
                      browser: schemas.browser,
                    },
                  },
                  uiPackages: {
                    root: uiRoot,
                    postgres: {
                      connectionString: postgresUrl!,
                      schema: schemas.ui,
                    },
                  },
                },
              }
            : {}),
        });
        const host = f;
        const projectId = host.projectId;
        const work = () => host.domains.work.service;
        const platform = () => host.domains.content.platform;
        const discovery = await host.call<{
          operations: Array<{ id: string }>;
        }>({
          action: "operations",
          operations: { action: "list", domain: "applications" },
        });
        assert.deepEqual(
          discovery.operations.map((op) => op.id),
          ["applications.list", "applications.launch"],
        );
        const headerList = await host.call<Listed>({
          action: "applications",
          applications: { action: "list" },
        });
        assert.equal(headerList.total, 4);
        assert.ok(
          headerList.applications.some(
            (app) =>
              app.id === scriptStudioApplication.id &&
              app.version === scriptStudioApplication.version,
          ),
        );
        const manifest = {
          format: "morphz-app/v1",
          id: "example.navigator",
          version: "1.0.0",
          title: "测试界面",
          description: "独立测试界面",
          icon: "code",
          permissions: [],
          harness: null,
          ui: {
            type: "sandbox",
            html: "<!doctype html><html><body>test</body></html>",
          },
        };
        await host.withHuman((actor) =>
          host.domains.uiPackages!.service.install(
            actor,
            randomUUID(),
            manifest,
          ),
        );
        const installed = await host.call<Listed>({
          action: "operations",
          operations: {
            action: "invoke",
            operationId: "applications.list",
            parameters: { offset: 4, limit: 1 },
          },
        });
        assert.equal(installed.total, 5);
        assert.equal(installed.applications[0]!.id, manifest.id);
        assert.equal(installed.hasMore, false);
        assert.doesNotMatch(
          JSON.stringify(installed),
          /<!doctype|store_ui_|sha256|artifactRevision/,
        );
        const accepted = host.envelope({
          action: "operations",
          operations: {
            action: "invoke",
            operationId: "applications.launch",
            parameters: {
              appId: browserApplication.id,
              packageVersion: browserApplication.version,
              state: { view: "library" },
            },
          },
        });
        const opened = (await host.tools.call(accepted)) as Launched;
        assert.equal(opened.instance.workspaceId, projectId);
        assert.equal(opened.instance.applicationId, browserApplication.id);
        assert.equal(opened.instance.revision, 1);
        const humanViews = await host.withHuman((actor) =>
          work().listAppViews(actor),
        );
        assert.equal(
          humanViews.find((view) => view.id === opened.instance.id)?.status,
          "open",
        );
        const same = await host.withHuman((actor) =>
          work().launchAppView(actor, {
            commandId: randomUUID(),
            projectId,
            appId: browserApplication.id,
            packageVersion: browserApplication.version,
            state: { view: "editor" },
          }),
        );
        assert.equal(
          same.id,
          opened.instance.id,
          "Human and Agent use the same one-owner/project/app/version view",
        );
        assert.equal(same.revision, 2);
        const replay = (await host.tools.call(accepted)) as Launched;
        assert.equal(
          replay.instance.revision,
          2,
          "An Agent retry does not undo later Human navigation",
        );
        assert.equal(replay.instance.state.view, "editor");
        await assert.rejects(
          async () =>
            host.tools.call({
              ...accepted,
              arguments: {
                action: "applications",
                applications: {
                  action: "launch",
                  appId: browserApplication.id,
                  packageVersion: browserApplication.version,
                  state: { view: "editor" },
                },
              },
            }),
          /幂等|重复|命令|请求/,
        );
        await host.withHuman((actor) =>
          work().closeAppView(actor, {
            commandId: randomUUID(),
            viewId: same.id,
            expectedRevision: same.revision,
          }),
        );
        const reopened = await host.call<Launched>({
          action: "applications",
          applications: {
            action: "launch",
            appId: browserApplication.id,
            packageVersion: browserApplication.version,
            state: {},
          },
        });
        assert.equal(reopened.instance.id, same.id);
        assert.equal(reopened.instance.status, "open");
        const packageView = await host.call<Launched>({
          action: "applications",
          applications: {
            action: "launch",
            appId: manifest.id,
            packageVersion: manifest.version,
            state: {},
          },
        });
        assert.equal(packageView.instance.applicationId, manifest.id);
        await assert.rejects(
          host.call({
            action: "applications",
            applications: {
              action: "launch",
              appId: manifest.id,
              packageVersion: "9.0.0",
              state: {},
            },
          }),
          /版本|安装/,
        );
        await assert.rejects(
          host.call({
            action: "applications",
            applications: {
              action: "launch",
              appId: "not.installed",
              packageVersion: "1.0.0",
              state: {},
            },
          }),
          /版本|安装/,
        );
        await assert.rejects(
          host.call({
            action: "applications",
            applications: {
              action: "launch",
              appId: browserApplication.id,
              packageVersion: browserApplication.version,
              state: {},
              projectId: "other-project",
            },
          }),
        );
        await assert.rejects(
          host.call({
            action: "applications",
            applications: { action: "list", principalId: other.principalId },
          }),
        );
        await assert.rejects(
          host.call(
            { action: "applications", applications: { action: "list" } },
            { ...host.route, principal_id: "forged-principal" },
          ),
          /原始应用输入/,
        );
        await host.withAgent(async (actor) => {
          await assert.rejects(
            host.domains.uiPackages!.service.install(
              actor,
              randomUUID(),
              manifest,
            ),
            /用户|安装/,
          );
          await assert.rejects(
            host.domains.uiPackages!.service.read(
              actor,
              manifest.id,
              manifest.version,
            ),
            /用户|安装/,
          );
          await assert.rejects(
            work().launchAppView(actor, {
              commandId: randomUUID(),
              projectId: "another-project",
              appId: browserApplication.id,
              packageVersion: browserApplication.version,
              state: {},
            }),
            /本人|项目/,
          );
        });
        const otherProject = "other-project";
        await host.domains.work.authority.withSession(
          other,
          () => {},
          async (actor) => {
            await work().createProject(actor, {
              commandId: randomUUID(),
              projectId: otherProject,
              title: "另一用户项目",
            });
            await work().launchAppView(actor, {
              commandId: randomUUID(),
              projectId: otherProject,
              appId: browserApplication.id,
              packageVersion: browserApplication.version,
              state: {
                view: "editor",
                url: "https://example.test/other-secret",
              },
            });
          },
        );
        const currentViews = await host.call<Listed>({
          action: "applications",
          applications: { action: "list" },
        });
        assert.equal(currentViews.instances.length, 2);
        assert.doesNotMatch(
          JSON.stringify(currentViews),
          /other-secret|other-project/,
        );
        await host.reopen();
        const restored = (await host.tools.call(accepted)) as Launched;
        assert.equal(restored.instance.id, reopened.instance.id);
        assert.equal(restored.instance.revision, reopened.instance.revision);
        const restoredList = await host.call<Listed>({
          action: "applications",
          applications: { action: "list" },
        });
        assert.equal(restoredList.total, 5);
        assert.equal(restoredList.instances.length, 2);

        // This is a genuine Platform task admission and a controlled Runtime
        // Schedule/Thread response, not a fabricated Human chat or a new protocol.
        const admission = await host.withHuman(async (actor) => {
          await platform().createTask(actor, {
            commandId: randomUUID(),
            taskId: "background-task",
            projectId,
            title: "后台运行",
            assigneeId: morphzAgentAccess.actantId,
          });
          return platform().requestTaskRun(actor, {
            commandId: randomUUID(),
            taskId: "background-task",
            expectedRevision: 1,
            sessionId: "background-session",
            intent: "后台工作",
            notBefore: "2026-09-30T00:00:00.000Z",
          });
        });
        const route: HostInvocation = {
          ...host.route,
          session_id: admission.sessionId,
          thread_id: "background-thread",
          context_id: "background-context",
        };
        const rootId = `client-schedule-${admission.request.id}`;
        let resolveScope:
          ((route: HostInvocation) => Promise<ToolScope>) | undefined;
        const runtime = {
          teamIdentity: false,
          bindPlatformInputAuthority() {},
          bindPlatformReadAuthority() {},
          bindMessageAttachments() {},
          bindPlatformAgentScope(resolve: typeof resolveScope) {
            resolveScope = resolve;
          },
          inputEvidenceReader: () => ({
            readThread: async () => ({
              snapshot: {
                thread: {
                  id: route.thread_id,
                  session_id: route.session_id,
                  context_id: route.context_id,
                  root_turn_id: rootId,
                  initiating_principal_id: route.principal_id,
                  agent_id: route.agent_id,
                  executor_kind: "self",
                  executor_id: null,
                },
              },
            }),
            readSessionEvent: async () => {
              throw new Error("A task run must not invent a Human input");
            },
            readSessionSchedule: async () => ({
              id: admission.request.id,
              thread_id: route.thread_id,
              source_turn_id: rootId,
            }),
          }),
        } as unknown as RuntimeBridge;
        const background = host.domains.bindRuntime(runtime);
        try {
          const scope = await resolveScope!(route);
          assert.equal(scope.platformSource, "task-run");
          const tools = new AgentTools({
            token: "background-test-token",
            resolveScope: resolveScope!,
            platformAgent: new PlatformAgentTools({
              authority: background.authority,
              work: work(),
              content: host.domains.content,
            }),
          });
          for (const applications of [
            { action: "list" },
            {
              action: "launch",
              appId: browserApplication.id,
              packageVersion: browserApplication.version,
              state: {},
            },
          ])
            await assert.rejects(
              async () =>
                tools.call({
                  ...host.envelope(
                    { action: "applications", applications },
                    route,
                  ),
                  invocation: route,
                }),
              /后台事项/,
            );
          await background.authority.withInvocation(route, async (actor) => {
            await assert.rejects(work().listAppViews(actor), /本人/);
            await assert.rejects(
              work().launchAppView(actor, {
                commandId: randomUUID(),
                projectId,
                appId: browserApplication.id,
                packageVersion: browserApplication.version,
                state: {},
              }),
              /本人/,
            );
          });
        } finally {
          await host.domains.unbindRuntime(background.authority);
        }
        await host.identity!.replaceConfiguration(
          {
            version: 1,
            members: [localAccess, other].map((human) => ({
              ...human,
              enabled: human.principalId !== localAccess.principalId,
              loginTokenHash: createHash("sha256")
                .update(`synthetic-login-${human.principalId}`)
                .digest("hex"),
            })),
          },
          [
            { ...localAccess, enabled: false, projectIds: [] },
            { ...other, enabled: true, projectIds: [otherProject] },
          ],
        );
        await assert.rejects(
          host.call({
            action: "applications",
            applications: { action: "list" },
          }),
          /身份|失效|权限/,
        );
        await assert.rejects(
          async () => host.tools.call(accepted),
          /身份|失效|权限/,
        );
        await assert.rejects(
          host.withHuman((actor) => work().listAppViews(actor)),
          /身份|失效|权限/,
        );
        host.assertNoLegacyData();
      } finally {
        await f?.close();
        if (admin) {
          for (const schema of Object.values(schemas))
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          await admin.end();
        }
        rmSync(uiRoot, { recursive: true, force: true });
      }
    },
  );
}
