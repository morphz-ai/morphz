import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import {
  AgentTools,
  type HostInvocation,
  type ToolScope,
} from "../packages/application/src/agent-tools.js";
import { PlatformAgentTools } from "../packages/application/src/platform-agent-tools.js";
import type { RuntimeBridge } from "../packages/application/src/runtime.js";
import {
  createScriptProduction,
  createScriptItem,
  updateScriptProduction,
} from "../packages/application/src/script-production-service.js";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";
import { morphzAgentAccess } from "../packages/core/src/model.js";

// Actual Platform admissions and Script Studio preparation; accepted Runtime
// Thread/Schedule reads are controlled evidence, not an executed model/Runtime.
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: task-run with sourceInputId retains its verified kind and cannot impersonate a fixed chat workflow`,
    {
      skip: backend === "postgres" && !process.env.MORPHZ_TEST_POSTGRES_URL,
    },
    async (t) => {
      const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL;
      const schema = `source_kind_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const admin =
        backend === "postgres" ? new Pool({ connectionString }) : undefined;
      let host: Awaited<ReturnType<typeof agentDomainFixture>> | undefined;
      try {
        if (admin) await admin.query(`CREATE SCHEMA "${schema}"`);
        host = await agentDomainFixture({
          ...(admin
            ? {
                storage: {
                  platform: {
                    kind: "postgres",
                    connectionString: connectionString!,
                    schema,
                  },
                },
              }
            : {}),
        });
        const f = host;
        const platform = f.domains.content.platform;
        const studio = f.domains.content.studio!;
        const productionId = "fixed-source-production",
          targetId = "fixed-source-item";
        const source = await f.readAcceptedInput(f.route);
        const shared = {
          platform,
          studio,
          instanceId: f.domains.content.instanceIds.scriptStudio!,
          productionId,
        };
        await f.withHuman((actor) =>
          createScriptProduction({
            ...shared,
            actor,
            commandId: randomUUID(),
            projectId: f.projectId,
            title: "Fixed source fixture",
          }),
        );
        let overview = await f.withHuman((actor) =>
          studio.readProductionOverview({
            credential: actor.credential,
            productionId,
          }),
        );
        await f.withHuman((actor) =>
          updateScriptProduction({
            ...shared,
            actor,
            commandId: randomUUID(),
            expectedRevision: overview.metadataRevision,
            title: overview.title,
            brief: {
              ...overview.brief,
              modelProcessingAllowed: true,
              rightsStatement: "Only synthetic fixture material",
            },
            reviewerPrincipalIds: overview.reviewerPrincipalIds,
            template: overview.template,
          }),
        );
        overview = await f.withHuman((actor) =>
          studio.readProductionOverview({
            credential: actor.credential,
            productionId,
          }),
        );
        await f.withHuman((actor) =>
          createScriptItem({
            ...shared,
            actor,
            commandId: randomUUID(),
            itemId: targetId,
            expectedActivityRevision: overview.activityRevision,
            kind: "episode",
            draft: { ...emptyScriptDraft("Fixture episode"), sources: [] },
          }),
        );
        overview = await f.withHuman((actor) =>
          studio.readProductionOverview({
            credential: actor.credential,
            productionId,
          }),
        );
        await f.withAgent((actor) =>
          studio.prepareGenerations({
            credential: actor.credential,
            commandId: randomUUID(),
            productionId,
            inputId: source.input_id,
            generations: [
              {
                productionId,
                targetId,
                baseRevision: 1,
                contextRevision: overview.metadataRevision,
                purpose: "draft",
                references: [],
                maxCandidates: 1,
                maxOutputCharacters: 1000,
                maxReviewPasses: 1,
              },
            ],
          }),
        );
        await assert.rejects(f.call({ action: "list" }), /固定剧本生成/);
        await f.withHuman((actor) =>
          platform.createTask(actor, {
            commandId: randomUUID(),
            taskId: "source-kind-task",
            projectId: f.projectId,
            title: "Scheduled fixture",
            assigneeId: morphzAgentAccess.actantId,
          }),
        );
        const admission = await f.withAgent((actor) =>
          platform.requestTaskRun(actor, {
            commandId: randomUUID(),
            taskId: "source-kind-task",
            expectedRevision: 1,
            sessionId: "source-kind-scheduled-session",
            intent: "A distinct scheduled task",
            notBefore: "2026-10-05T00:00:00.000Z",
          }),
        );
        assert.equal(admission.sourceInputId, source.input_id);
        const route: HostInvocation = {
          ...f.route,
          session_id: admission.sessionId,
          thread_id: "source-kind-scheduled-thread",
          context_id: "source-kind-scheduled-context",
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
              throw new Error(
                "A scheduled task cannot invent a Human chat root",
              );
            },
            readSessionSchedule: async () => ({
              id: admission.request.id,
              thread_id: route.thread_id,
              source_turn_id: rootId,
            }),
          }),
        } as unknown as RuntimeBridge;
        const binding = f.domains.bindRuntime(runtime);
        try {
          await t.test(
            "callback and scope preserve task-run despite nonnull input",
            async () => {
              const scope = await resolveScope!(route);
              assert.equal(scope.platformSource, "task-run");
              assert.equal(scope.inputId, source.input_id);
              await binding.authority.withInvocation(
                route,
                async (_actor, scope) => {
                  assert.equal(scope.kind, "task-run");
                  assert.equal(scope.inputId, source.input_id);
                },
              );
            },
          );
          await t.test(
            "fixed chat guard is retained but unrelated task-run is not mistaken for that chat",
            async () => {
              const tools = new AgentTools({
                token: "isolated-source-kind",
                resolveScope: resolveScope!,
                platformAgent: new PlatformAgentTools({
                  authority: binding.authority,
                  work: f.domains.work.service,
                  content: f.domains.content,
                }),
              });
              const result = (await tools.call({
                protocol: 1,
                tool: "host_morphz",
                invocation: route,
                arguments: { action: "list" },
              })) as { ok: boolean };
              assert.equal(result.ok, true);
              await assert.rejects(
                async () =>
                  tools.call({
                    protocol: 1,
                    tool: "host_morphz",
                    invocation: route,
                    arguments: {
                      action: "applications",
                      applications: { action: "list" },
                    },
                  }),
                /后台事项/,
              );
            },
          );
        } finally {
          await f.domains.unbindRuntime(binding.authority);
        }
      } finally {
        await host?.close();
        if (admin) {
          await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
          await admin.end();
        }
      }
    },
  );
}
