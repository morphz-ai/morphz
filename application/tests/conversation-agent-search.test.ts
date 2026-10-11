import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { localAccess, morphzAgentAccess } from "../packages/core/src/model.js";
import type { ConversationSearchPage } from "../packages/core/src/conversation-search.js";

const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: 正式 Agent 对话查找的类型发现、原始输入、双身份及不可伪造范围`,
    { skip: backend === "postgres" && !postgresUrl },
    async () => {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
      const schemas = {
        platform: `sp_${suffix}`,
        objects: `so_${suffix}`,
        scriptStudio: `ss_${suffix}`,
        reader: `sr_${suffix}`,
        browser: `sb_${suffix}`,
      };
      const admin =
        backend === "postgres"
          ? new Pool({ connectionString: postgresUrl })
          : null;
      let f: Awaited<ReturnType<typeof agentDomainFixture>> | undefined;
      const observed: unknown[] = [];
      try {
        if (admin)
          for (const schema of Object.values(schemas))
            await admin.query(`CREATE SCHEMA "${schema}"`);
        f = await agentDomainFixture({
          searchConversation: async (request, sourceAuthor, authorize) => {
            const grant = await authorize();
            observed.push({ request, sourceAuthor, grant });
            await authorize();
            return { hits: [], nextCursor: null, scanned: 0 };
          },
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
                    deploymentId: `search_${suffix}`,
                    schemas: {
                      objects: schemas.objects,
                      scriptStudio: schemas.scriptStudio,
                      reader: schemas.reader,
                      browser: schemas.browser,
                    },
                  },
                },
              }
            : {}),
        });
        const host = f;
        const discover = await host.call<{
          operations: Array<{ id: string; effect: string }>;
        }>({
          action: "operations",
          operations: { action: "list", domain: "conversations" },
        });
        assert.equal(
          discover.operations.find((op) => op.id === "conversations.search")
            ?.effect,
          "read",
        );
        const description = await host.call<{
          operation: { parameters: { properties: Record<string, unknown> } };
        }>({
          action: "operations",
          operations: {
            action: "describe",
            operationId: "conversations.search",
          },
        });
        assert.deepEqual(
          Object.keys(description.operation.parameters.properties).sort(),
          ["before", "query"],
        );
        const invoke = (parameters: unknown) =>
          host.call<ConversationSearchPage>({
            action: "operations",
            operations: {
              action: "invoke",
              operationId: "conversations.search",
              parameters,
            },
          });
        const before = {
          createdAt: "2026-10-10T00:00:00Z",
          id: "exact-message",
        };
        assert.deepEqual(await invoke({ query: "批注 [.*]", before }), {
          hits: [],
          nextCursor: null,
          scanned: 0,
        });
        assert.deepEqual(observed, [
          {
            request: {
              projectId: host.projectId,
              conversationId: host.projectId,
              query: "批注 [.*]",
              before,
            },
            sourceAuthor: localAccess,
            grant: { personalDefault: false, projectIds: [host.projectId] },
          },
        ]);
        for (const injection of [
          { projectId: "another" },
          { conversationId: "another" },
          { principalId: "other-human" },
          { sessionId: "other-session" },
        ])
          await assert.rejects(
            async () => invoke({ query: "文字", ...injection }),
            /Unrecognized|unrecognized/,
          );
        await assert.rejects(
          host.withHuman((actor) =>
            host.domains.content.platform.authorizeAgentConversationRead(
              actor,
              { projectId: host.projectId, conversationId: host.projectId },
            ),
          ),
          /Agent 身份/,
        );
        const otherProject = "other-search-project";
        await host.withHuman((actor) =>
          host.domains.work.service.createProject(actor, {
            commandId: randomUUID(),
            projectId: otherProject,
            title: "另一个项目",
          }),
        );
        await assert.rejects(
          host.withAgent((actor) =>
            host.domains.content.platform.authorizeAgentConversationRead(
              actor,
              { projectId: otherProject, conversationId: otherProject },
            ),
          ),
          /原始输入/,
        );
        host.forgetInput(host.route);
        await assert.rejects(
          invoke({ query: "文字" }),
          /Unknown fixture|原始|验证/,
        );
        const stillKnown = host.input();
        if (admin)
          await admin.query(
            `DELETE FROM "${schemas.platform}".project_members WHERE project_id=$1 AND principal_id=$2`,
            [host.projectId, morphzAgentAccess.principalId],
          );
        else {
          const db = new DatabaseSync(join(host.directory, "platform.sqlite"));
          try {
            db.prepare(
              "DELETE FROM project_members WHERE project_id=? AND principal_id=?",
            ).run(host.projectId, morphzAgentAccess.principalId);
          } finally {
            db.close();
          }
        }
        await assert.rejects(
          host.call(
            {
              action: "operations",
              operations: {
                action: "invoke",
                operationId: "conversations.search",
                parameters: { query: "文字" },
              },
            },
            stillKnown,
          ),
          /身份|Agent|无权/,
        );
        assert.deepEqual(
          await host.withHuman((actor) =>
            host.domains.content.platform.authorizeConversationRead(actor, {
              projectId: host.projectId,
              conversationId: host.projectId,
            }),
          ),
          { personalDefault: false, projectIds: [host.projectId] },
          "Human 仍可读取，不能以 Human 凭证绕过已撤销的 Agent 成员资格",
        );
        assert.equal(observed.length, 1);
        host.assertNoLegacyData();
      } finally {
        await f?.close();
        if (admin) {
          for (const schema of Object.values(schemas))
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          await admin.end();
        }
      }
    },
  );
}
