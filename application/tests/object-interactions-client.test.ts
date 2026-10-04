import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import {
  applicationCall,
  RequestError,
} from "../apps/web/src/application-transport.js";
import type { Operation } from "../packages/core/src/model.js";
import {
  withObjectHttp,
  objectHuman,
  otherObjectHuman,
  type ObjectHttpRead,
} from "./fixtures/object-interactions-http.js";
type Context = Parameters<Parameters<typeof withObjectHttp>[1]>[0];
type ObjectOperation = Extract<
  Operation,
  { type: "annotate" | "link-artifacts" }
>;
const writes = (reads: ObjectHttpRead[], path: string) =>
  reads.filter((value) => value.path === path && value.method === "POST");
const notePath = "/api/platform/objects/annotate",
  relationPath = "/api/platform/work/relations";
const saved = (context: Context, operation: ObjectOperation) => {
  const found = [...context.rows].flatMap(([key, value]) => {
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
  const project = await context.client.execute({
    type: "create-project",
    title: "TEST 私有对象",
  });
  const objectId = randomUUID();
  const receipt = await context.client.execute(
    {
      type: "create-artifact",
      projectId: project.entityId,
      title,
      content: { kind: "document", markdown: "第一版确切原文。" },
    },
    false,
    undefined,
    objectId,
  );
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
        source = await PlatformClient.connect({ call: applicationCall });
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
      await context.client.refresh();
      assert.equal(
        context.client
          .getSnapshot()!
          .workspace.artifacts.some((value) => value.id === original.contentId),
        false,
        "target absent from current limited publication, never a cache authority",
      );
      const first = await context.client.execute(
        annotation(original.contentId),
      );
      for (let n = 1; n <= 100; n++)
        await source.annotateObject({
          commandId: randomUUID(),
          contentId: original.contentId,
          revision: 1,
          quote: "第一版确切原文",
          body: "真实分页批注 " + n,
        });
      context.reads.length = 0;
      const notes = await context.client.listObjectAnnotations(
        original.contentId,
      );
      assert.equal(notes.length, 101);
      assert.equal(notes[0]!.id, first.entityId);
      assert.equal(notes[0]!.artifactId, original.objectId);
      assert.notEqual(notes[0]!.artifactId, original.contentId);
      assert.ok(notes.every((note) => note.artifactRevision === 1));
      const pages = context.reads.filter((value) =>
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
      const pdfArtifact = await context.client.resolveArtifact(pdf.contentId);
      assert(pdfArtifact && pdfArtifact.content.kind === "pdf");
      const quote = pdfArtifact.content.pages[0]!;
      assert.equal(quote, pdf.quote);
      const pdfReceipt = await context.client.execute({
        type: "annotate",
        artifactId: pdf.contentId,
        artifactRevision: 1,
        quote,
        page: 1,
        body: "精确PDF页",
      });
      const pdfNotes = await context.client.listObjectAnnotations(
        pdf.contentId,
      );
      assert.equal(pdfNotes[0]!.id, pdfReceipt.entityId);
      assert.equal(pdfNotes[0]!.page, 1);
      assert.equal(pdfNotes[0]!.quote, quote);
      await assert.rejects(
        context.client.execute({
          type: "annotate",
          artifactId: pdf.contentId,
          artifactRevision: 1,
          quote,
          page: 999,
          body: "错误页禁止",
        }),
        (error) =>
          error instanceof RequestError &&
          error.status === 500 &&
          error.message === "保存失败。内容尚未确认写入，请保留草稿后重试。",
      );
      assert.equal(
        context.sql().notes.length,
        102,
        "invalid page adds no note",
      );
      const linked = await context.client.execute({
        type: "link-artifacts",
        fromId: original.contentId,
        toId: pdf.contentId,
        relation: "references",
      });
      const relations = await context.client.workRelationsFor(
        original.contentId,
      );
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
        source = await PlatformClient.connect({ call: applicationCall }),
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
        context.loseNext(path);
        await assert.rejects(
          context.client.execute(operation),
          /TEST lost authorized object receipt/,
        );
        const initial = writes(context.reads, path).at(-1)!;
        assert.equal(initial.status, 200);
        const pending = saved(context, operation);
        assert.deepEqual(pending.command.operation, operation);
        assert.equal(
          pending.command.commandId,
          (initial.body as { commandId: string }).commandId,
        );
        const boot = context.client.getSnapshot()!;
        assert.ok(
          pending.key.startsWith(
            `morphz:${boot.centerId}:${boot.principalId}:`,
          ),
        );
        await context.remount();
        assert.equal(saved(context, operation).key, pending.key);
        assert.deepEqual(saved(context, operation).command, pending.command);
        const receipt = await context.client.execute(operation);
        assert.equal(receipt.commandId, pending.command.commandId);
        const retry = writes(context.reads, path).at(-1)!;
        assert.deepEqual(
          retry.body,
          initial.body,
          "exact original request is replayed, not a regenerated payload",
        );
        assert.equal(context.rows.get(pending.key), "null");
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
      await context.client.execute(annotation(original.contentId));
      await context.login(true);
      assert.equal(
        context.client.getSnapshot()!.principalId,
        otherObjectHuman.principalId,
      );
      await assert.rejects(
        context.client.listObjectAnnotations(original.contentId),
        (error) =>
          error instanceof RequestError &&
          error.status === 404 &&
          error.message === "内容不存在或无权访问。",
      );
      await assert.rejects(
        context.client.workRelationsFor(original.contentId),
        (error) =>
          error instanceof RequestError &&
          error.status === 403 &&
          error.message === "无权访问这个项目。",
      );
      await assert.rejects(
        context.client.execute(annotation(original.contentId)),
        (error) =>
          error instanceof RequestError &&
          error.status === 404 &&
          error.message === "内容不存在或无权访问。",
      );
      await context.login();
      assert.equal(
        context.client.getSnapshot()!.principalId,
        objectHuman.principalId,
      );
      const oldToken = context.client.getSnapshot()!.csrfToken;
      await context.revoke();
      assert.equal(context.client.getSnapshot()!.csrfToken, oldToken);
      await assert.rejects(
        context.client.listObjectAnnotations(original.contentId),
        (error) => error instanceof RequestError && error.status === 401,
      );
      await assert.rejects(
        context.client.execute(annotation(original.contentId)),
        (error) => error instanceof RequestError && error.status === 401,
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
      const holdRead = context.holdNext(readPath),
        pendingRead = context.client.listObjectAnnotations(original.contentId);
      const rejectedRead = assert.rejects(
        pendingRead,
        (error) =>
          error instanceof RequestError &&
          error.status === 408 &&
          error.message === "身份已切换，旧响应已丢弃。",
      );
      try {
        await holdRead.reached;
        await context.login(true);
        const switched = context.client.getSnapshot();
        holdRead.release();
        await rejectedRead;
        assert.equal(context.client.getSnapshot(), switched);
      } finally {
        holdRead.release();
        await rejectedRead;
      }
      await context.login();
      const operation = annotation(original.contentId),
        holdWrite = context.holdNext(notePath),
        pendingWrite = context.client.execute(operation);
      const rejectedWrite = assert.rejects(
        pendingWrite,
        (error) =>
          error instanceof RequestError &&
          error.status === 408 &&
          error.message === "身份已切换，旧响应已丢弃。",
      );
      try {
        await holdWrite.reached;
        assert.equal(context.sql().notes.length, 1);
        const command = saved(context, operation);
        await context.login(true);
        holdWrite.release();
        await rejectedWrite;
        assert.equal(
          context.client.getSnapshot()!.principalId,
          otherObjectHuman.principalId,
        );
        assert.notEqual(context.rows.get(command.key), "null");
        await context.login();
        const receipt = await context.client.execute(operation);
        assert.equal(receipt.commandId, command.command.commandId);
        assert.equal(context.rows.get(command.key), "null");
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
        holdWrite.release();
        await rejectedWrite;
      }
    });
  },
);
