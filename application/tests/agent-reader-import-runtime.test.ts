import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { zip, epubFiles } from "./fixtures/reader-publication.js";
import { profileActualTransportFixture } from "./profile-actual-transport-fixture.js";

for (const [sourceKind, annotations] of [
  ["attachment", "on"],
  ["workspace", "on"],
  ["workspace", "off"],
] as const)
  test(
    sourceKind === "attachment"
      ? "actual Runtime: accepted attachment imports through Agent and retains stable tools"
      : `actual Runtime: ${sourceKind} imports with annotations ${annotations} through Agent and retains stable tools`,
    {
      skip: process.env.MORPHZ_READER_IMPORT_RUNTIME_E2E !== "1",
      timeout: 120_000,
    },
    async () => {
      let assetId = "",
        step = 0;
      const f = await profileActualTransportFixture({
        responseAnnotations: annotations,
        ...(sourceKind === "workspace"
          ? { workspaceFiles: { "TEST-默认工作目录.epub": zip(epubFiles) } }
          : {}),
        deterministicTool: () => {
          step++;
          if (step === 1)
            return { name: "host_morphz", arguments: { action: "read-input" } };
          if (step > 2) return undefined;
          return {
            name: "host_morphz",
            arguments: {
              action: "operations",
              operations: {
                action: "invoke",
                operationId: "reader.import",
                parameters: {
                  source:
                    sourceKind === "attachment"
                      ? { kind: "attachment", assetId }
                      : { kind: "workspace", path: "TEST-默认工作目录.epub" },
                },
              },
            },
          };
        },
      });
      try {
        const projectId = "reader_" + randomUUID().replaceAll("-", "");
        await f.client.call(
          "projects.create",
          { commandId: randomUUID(), projectId, title: "TEST Agent 导入链路" },
          f.options,
        );
        const attachment = (await f.client.call(
          "attachment.add",
          {
            name: "TEST-agent-import.md",
            data: Buffer.from(
              "# TEST Agent 导入验收\n这是由实际 Runtime 附件读取后导入的合成书籍。\n\n# 第二章\n精确定位。",
            ),
          },
          f.options,
        )) as { assetId: string; mime: string };
        assetId = attachment.assetId;
        await f.client.call(
          "platform.message",
          {
            commandId: randomUUID(),
            operation: {
              type: "record-input",
              projectId,
              artifactId: null,
              artifactRevision: null,
              selection: "",
              body: "TEST_READER_IMPORT_ACTUAL：导入本次附件。",
              targetActantId: "morphz-agent",
              ...(sourceKind === "attachment"
                ? {
                    attachments: [
                      { ...attachment, name: "TEST-agent-import.md" },
                    ],
                  }
                : {}),
            },
          },
          f.options,
        );
        let thread: { id: string; status: string } | undefined;
        for (let i = 0; i < 500; i++) {
          thread = f.sql<{ id: string; status: string }>(
            "SELECT id,status FROM threads ORDER BY rowid DESC LIMIT 1",
          )[0];
          if (
            thread &&
            ["completed", "failed", "cancelled"].includes(thread.status)
          )
            break;
          await new Promise((done) => setTimeout(done, 100));
        }
        assert.ok(thread, "Expected the actual admitted Thread");
        const outputs = f
          .sql<{ payload: string }>(
            "SELECT payload FROM events WHERE topic='chat/tool_output' AND thread_id=?",
            thread.id,
          )
          .map((row) => JSON.parse(row.payload));
        assert.equal(thread?.status, "completed", JSON.stringify(outputs));
        const jobs = f.sql<{ status: string }>(
          "SELECT status FROM execution_jobs WHERE thread_id=?",
          thread!.id,
        );
        assert.equal(jobs.length, 2);
        assert.ok(
          jobs.every((job) => job.status === "succeeded"),
          JSON.stringify(outputs),
        );
        const results = outputs.map((output) => JSON.parse(output.text));
        assert.ok(
          results.every((result) => result.ok !== false),
          JSON.stringify(results),
        );
        const imported = results.find(
          (result) => result.entityId && result.bookId,
        );
        assert.ok(imported, JSON.stringify(results));
        if (sourceKind === "attachment")
          assert.ok(
            JSON.stringify(results[0]).includes(assetId),
            "read-input exposes the accepted Client attachment reference",
          );
        else {
          assert.ok(
            !JSON.stringify(results[0]).includes("grantId"),
            "No extra directory authorization",
          );
          assert.ok(
            !JSON.stringify(results).includes("data_base64"),
            "File bytes never enter model observations",
          );
          const job = f.sql<{ id: string; tool_call_id: string }>(
            "SELECT id,tool_call_id FROM execution_jobs WHERE thread_id=? ORDER BY rowid DESC LIMIT 1",
            thread.id,
          )[0]!;
          assert.equal(
            (
              await f.workspaceFile(job.id, {
                tool_call_id: job.tool_call_id,
                path: "TEST-默认工作目录.epub",
              })
            ).status,
            403,
            "A finished Job cannot read more bytes",
          );
          assert.equal(
            (
              await f.workspaceFile("missing", {
                tool_call_id: job.tool_call_id,
                path: "TEST-默认工作目录.epub",
              })
            ).status,
            404,
          );
        }
        const catalog = (await f.client.call(
          "content.list",
          {
            projectId,
            appIds: ["morphz.reader"],
            kinds: ["publication"],
            availability: "available",
            limit: 20,
          },
          f.options,
        )) as unknown;
        // Read the real Client directory via the canonical navigation projection.
        assert.ok(
          JSON.stringify(catalog).includes(imported.entityId),
          JSON.stringify({ catalog, outputs }),
        );
        assert.equal(f.requests.length, 3);
        assert.deepEqual(f.requests[0]!.tools, f.requests[1]!.tools);
        assert.deepEqual(f.requests[1]!.tools, f.requests[2]!.tools);
        for (const request of f.requests) {
          const textFormat = (request.text as { format?: unknown } | undefined)
            ?.format;
          assert.deepEqual(
            textFormat ?? request.response_format,
            annotations === "on" ? { type: "json_object" } : undefined,
            "Every actual outbound request preserves the frozen native output mode, including work continuations",
          );
          if (annotations === "on")
            assert.equal(
              request.tool_choice,
              "none",
              "Effects use the admitted IO value, not mixed native calls",
            );
        }
        assert.equal(f.realCalls, 0);
        assert.equal(
          f.sql<{ n: number }>(
            "SELECT count(*) AS n FROM events WHERE topic='runtime/response_protocol_error'",
          )[0]!.n,
          0,
        );
      } finally {
        await f.close();
      }
    },
  );
