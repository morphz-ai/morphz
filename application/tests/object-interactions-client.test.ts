import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { PlatformClient } from "../apps/web/src/platform-client.js";
import type { Operation } from "../packages/core/src/model.js";
import {
  withObjectHttp,
  objectHuman,
  otherObjectHuman,
  type ObjectHttpRead,
} from "./fixtures/object-interactions-http.js";
import { authenticatedHttp } from "./fixtures/actual-mounted-client-test.js";
const isRequestError = (error: unknown): error is Error & { status: number } =>
  error instanceof Error && typeof Reflect.get(error, "status") === "number";
const platform = (
  context: Context,
): Pick<
  PlatformClient,
  "reviseDocument" | "createDocument" | "annotateObject"
> => ({
  reviseDocument: (value) =>
    context.client.control("platform", "reviseDocument", [value]),
  createDocument: (value) =>
    context.client.control("platform", "createDocument", [value]),
  annotateObject: (value) =>
    context.client.control("platform", "annotateObject", [value]),
});
type Context = Parameters<Parameters<typeof withObjectHttp>[1]>[0];
type ObjectOperation = Extract<
  Operation,
  { type: "annotate" | "link-artifacts" }
>;
const writes = (reads: ObjectHttpRead[], path: string) =>
  reads.filter((value) => value.path === path && value.method === "POST");
const notePath = "/api/platform/objects/annotate",
  relationPath = "/api/platform/work/relations";
const saved = async (context: Context, operation: ObjectOperation) => {
  const found = Object.entries(await context.rows()).flatMap(([key, value]) => {
    try {
      const command = JSON.parse(value) as {
        commandId?: string;
        operation?: Operation;
      } | null;
      return command?.operation &&
        JSON.stringify(command.operation) === JSON.stringify(operation)
        ? [{ key, command }]
        : [];
    } catch {
      return [];
    }
  });
  assert.equal(found.length, 1, "exact original whole pending operation");
  return found[0]!;
};
async function document(context: Context, title = "TEST 原件") {
  const project = await context.client.call("execute", [
    {
      type: "create-project",
      title: "TEST 私有对象",
    },
  ]);
  const objectId = randomUUID();
  const receipt = await context.client.call("execute", [
    {
      type: "create-artifact",
      projectId: project.entityId,
      title,
      content: { kind: "document", markdown: "第一版确切原文。" },
    },
    false,
    undefined,
    objectId,
  ]);
  return { projectId: project.entityId, contentId: receipt.entityId, objectId };
}
const annotation = (
  contentId: string,
): Extract<Operation, { type: "annotate" }> => ({
  type: "annotate",
  artifactId: contentId,
  artifactRevision: 1,
  quote: "第一版确切原文",
  body: "保留原版本批注",
});

test(
  "actual object Client resolves off-head catalog ID/exact historic version, pages100+ordinal and existing Objects PDF page; distinct relation read",
  { timeout: 90000 },
  async () => {
    await withObjectHttp("off-head-pages", async (context) => {
      const original = await document(context),
        source = platform(context);
      await source.reviseDocument({
        commandId: randomUUID(),
        contentId: original.contentId,
        expectedRevision: 1,
        title: "第二版",
        markdown: "第二版不同正文。",
      });
      for (let n = 0; n < 52; n++)
        await source.createDocument({
          commandId: randomUUID(),
          objectId: randomUUID(),
          projectId: original.projectId,
          title: "TEST 新目录 " + n,
          markdown: "后创建的原件",
        });
      await context.client.call("refresh", []);
      assert.equal(
        (await context.client.snapshot())!.workspace.artifacts.some(
          (value) => value.id === original.contentId,
        ),
        false,
        "target absent from current limited publication, never a cache authority",
      );
      const first = await context.client.call("execute", [
        annotation(original.contentId),
      ]);
      for (let n = 1; n <= 100; n++)
        await source.annotateObject({
          commandId: randomUUID(),
          contentId: original.contentId,
          revision: 1,
          quote: "第一版确切原文",
          body: "真实分页批注 " + n,
        });
      await context.client.control("clearReads");
      const notes = await context.client.call("listObjectAnnotations", [
        original.contentId,
      ]);
      assert.equal(notes.length, 101);
      assert.equal(notes[0]!.id, first.entityId);
      assert.equal(notes[0]!.artifactId, original.objectId);
      assert.notEqual(notes[0]!.artifactId, original.contentId);
      assert.ok(notes.every((note) => note.artifactRevision === 1));
      const pages = (await context.reads()).filter((value) =>
        value.path.endsWith("/annotations"),
      );
      assert.equal(pages.length, 2);
      assert.deepEqual(
        [...new URLSearchParams(pages[0]!.query)],
        [["limit", "100"]],
      );
      assert.deepEqual(
        [...new URLSearchParams(pages[1]!.query)],
        [
          ["limit", "100"],
          ["afterOrdinal", "99"],
        ],
      );
      const pdf = await context.existingPdf(original.projectId);
      const pdfArtifact = await context.client.call("resolveArtifact", [
        pdf.contentId,
      ]);
      assert(pdfArtifact && pdfArtifact.content.kind === "pdf");
      const quote = pdfArtifact.content.pages[0]!;
      assert.equal(quote, pdf.quote);
      const pdfReceipt = await context.client.call("execute", [
        {
          type: "annotate",
          artifactId: pdf.contentId,
          artifactRevision: 1,
          quote,
          page: 1,
          body: "精确PDF页",
        },
      ]);
      const pdfNotes = await context.client.call("listObjectAnnotations", [
        pdf.contentId,
      ]);
      assert.equal(pdfNotes[0]!.id, pdfReceipt.entityId);
      assert.equal(pdfNotes[0]!.page, 1);
      assert.equal(pdfNotes[0]!.quote, quote);
      await assert.rejects(
        context.client.call("execute", [
          {
            type: "annotate",
            artifactId: pdf.contentId,
            artifactRevision: 1,
            quote,
            page: 999,
            body: "错误页禁止",
          },
        ]),
        (error) =>
          isRequestError(error) &&
          error.status === 500 &&
          error.message === "保存失败。内容尚未确认写入，请保留草稿后重试。",
      );
      assert.equal(
        context.sql().notes.length,
        102,
        "invalid page adds no note",
      );
      const linked = await context.client.call("execute", [
        {
          type: "link-artifacts",
          fromId: original.contentId,
          toId: pdf.contentId,
          relation: "references",
        },
      ]);
      const relations = await context.client.call("workRelationsFor", [
        original.contentId,
      ]);
      assert.equal(relations.length, 1);
      assert.equal(relations[0]!.id, linked.entityId);
      assert.equal(relations[0]!.fromId, original.contentId);
      assert.equal(relations[0]!.toId, pdf.contentId);
      assert.equal(context.sql().notes.length, 102);
      assert.equal(context.sql().relations.length, 1);
    });
  },
);
test(
  "actual object Client committed note and relation reply losses retain whole scoped command through remount and one SQL receipt",
  { timeout: 30000 },
  async () => {
    await withObjectHttp("durable-retry", async (context) => {
      const original = await document(context),
        source = platform(context),
        other = (await source.createDocument({
          commandId: randomUUID(),
          objectId: randomUUID(),
          projectId: original.projectId,
          title: "TEST 关联目标",
          markdown: "真实目标",
        })) as { contentId: string };
      const operations: [ObjectOperation, string][] = [
        [annotation(original.contentId), notePath],
        [
          {
            type: "link-artifacts",
            fromId: original.contentId,
            toId: other.contentId,
            relation: "uses",
          },
          relationPath,
        ],
      ];
      for (const [operation, path] of operations) {
        await context.loseNext(path);
        await assert.rejects(
          context.client.call("execute", [operation]),
          /TEST lost authorized object receipt/,
        );
        const initial = writes(await context.reads(), path).at(-1)!;
        assert.equal(initial.status, 200);
        const pending = await saved(context, operation);
        assert.deepEqual(pending.command.operation, operation);
        assert.equal(
          pending.command.commandId,
          (initial.body as { commandId: string }).commandId,
        );
        const boot = (await context.client.snapshot())!;
        assert.ok(
          pending.key.startsWith(
            `morphz:${boot.centerId}:${boot.principalId}:`,
          ),
        );
        await context.remount();
        assert.equal((await saved(context, operation)).key, pending.key);
        assert.deepEqual(
          (await saved(context, operation)).command,
          pending.command,
        );
        const receipt = await context.client.call("execute", [operation]);
        assert.equal(receipt.commandId, pending.command.commandId);
        const retry = writes(await context.reads(), path).at(-1)!;
        assert.deepEqual(
          retry.body,
          initial.body,
          "exact original request is replayed, not a regenerated payload",
        );
        assert.equal((await context.rows())[pending.key], "null");
        const sql = context.sql(),
          receipts = path === notePath ? sql.objectReceipts : sql.workReceipts;
        assert.equal(
          receipts.filter((row) => row.command_id === pending.command.commandId)
            .length,
          1,
        );
      }
      assert.equal(context.sql().notes.length, 1);
      assert.equal(context.sql().relations.length, 1);
    });
  },
);
test(
  "actual object Client authoritative privacy and same-token live membership revocation reject queries/writes",
  { timeout: 30000 },
  async () => {
    await withObjectHttp("authority", async (context) => {
      const original = await document(context);
      await context.client.call("execute", [annotation(original.contentId)]);
      await context.login(true);
      assert.equal(
        (await context.client.snapshot())!.principalId,
        otherObjectHuman.principalId,
      );
      await assert.rejects(
        context.client.call("listObjectAnnotations", [original.contentId]),
        (error) =>
          isRequestError(error) &&
          error.status === 404 &&
          error.message === "内容不存在或无权访问。",
      );
      await assert.rejects(
        context.client.call("workRelationsFor", [original.contentId]),
        (error) =>
          isRequestError(error) &&
          error.status === 403 &&
          error.message === "无权访问这个项目。",
      );
      await assert.rejects(
        context.client.call("execute", [annotation(original.contentId)]),
        (error) =>
          isRequestError(error) &&
          error.status === 404 &&
          error.message === "内容不存在或无权访问。",
      );
      await context.login();
      assert.equal(
        (await context.client.snapshot())!.principalId,
        objectHuman.principalId,
      );
      const oldToken = (await context.client.snapshot())!.csrfToken;
      const remote = authenticatedHttp(context.client);
      await context.revoke();
      // The live subscription clears Client's protected identity on revocation.
      // Server ACL probes must not depend on retaining that revoked projection.
      await assert.rejects(
        remote.call(
          "objects.annotations",
          { contentId: original.contentId },
          { identityGeneration: oldToken },
        ),
        (error) => isRequestError(error) && error.status === 401,
      );
      await assert.rejects(
        remote.call(
          "objects.annotate",
          {
            commandId: randomUUID(),
            contentId: original.contentId,
            revision: 1,
            quote: "第一版确切原文",
            body: "撤销后禁止",
          },
          { identityGeneration: oldToken },
        ),
        (error) => isRequestError(error) && error.status === 401,
      );
      await context.client.page.waitForFunction(
        () =>
          Reflect.get(window, "actualMountedClient").report().snapshot === null,
        undefined,
        { timeout: 8000 },
      );
      const requestsBefore = (await context.reads()).length;
      await assert.rejects(
        context.client.call("listObjectAnnotations", [original.contentId]),
        { message: "身份已变化，批注未读取。" },
      );
      await assert.rejects(
        context.client.call("execute", [annotation(original.contentId)]),
        { message: "应用尚未就绪，请稍后重试。" },
      );
      assert.equal(
        (await context.reads()).length,
        requestsBefore,
        "cleared mounted Client must not dispatch reads or writes with revoked credentials",
      );
      assert.equal(context.sql().notes.length, 1);
      assert.equal(context.sql().objectReceipts.length, 1);
    });
  },
);
test(
  "actual object HTTP held successful read/committed write reject exact late epoch408; old scoped receipt can retry without duplicate",
  { timeout: 30000 },
  async () => {
    await withObjectHttp("late-epoch", async (context) => {
      const original = await document(context),
        readPath = `/api/platform/objects/${original.contentId}/annotations`;
      const holdRead = await context.holdNext(readPath),
        pendingRead = context.client.call("listObjectAnnotations", [
          original.contentId,
        ]);
      const rejectedRead = assert.rejects(
        pendingRead,
        (error) =>
          isRequestError(error) &&
          error.status === 408 &&
          error.message === "身份已切换，旧响应已丢弃。",
      );
      try {
        await holdRead.reached();
        await context.login(true);
        await context.client.snapshot("switched");
        await holdRead.release();
        await rejectedRead;
        assert.equal(
          await context.client.control("sameSnapshot", "switched"),
          true,
        );
      } finally {
        await holdRead.release();
        await rejectedRead;
      }
      await context.login();
      const operation = annotation(original.contentId),
        holdWrite = await context.holdNext(notePath),
        pendingWrite = context.client.call("execute", [operation]);
      const rejectedWrite = assert.rejects(
        pendingWrite,
        (error) =>
          isRequestError(error) &&
          error.status === 408 &&
          error.message === "身份已切换，旧响应已丢弃。",
      );
      try {
        await holdWrite.reached();
        assert.equal(context.sql().notes.length, 1);
        const command = await saved(context, operation);
        await context.login(true);
        await holdWrite.release();
        await rejectedWrite;
        assert.equal(
          (await context.client.snapshot())!.principalId,
          otherObjectHuman.principalId,
        );
        assert.notEqual((await context.rows())[command.key], "null");
        await context.login();
        const receipt = await context.client.call("execute", [operation]);
        assert.equal(receipt.commandId, command.command.commandId);
        assert.equal((await context.rows())[command.key], "null");
        assert.equal(context.sql().notes.length, 1);
        assert.equal(
          context
            .sql()
            .objectReceipts.filter(
              (row) => row.command_id === receipt.commandId,
            ).length,
          1,
        );
        assert.equal(
          context.sql().notes[0]!.author_principal_id,
          objectHuman.principalId,
        );
      } finally {
        await holdWrite.release();
        await rejectedWrite;
      }
    });
  },
);
