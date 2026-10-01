import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Application } from "../packages/application/src/application.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { ReaderOcr } from "../packages/application/src/reader-ocr.js";
import { localAccess } from "../packages/core/src/model.js";

function assertNoLegacyWorkspace(filename: string) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.equal(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='workspace'",
        )
        .get(),
      undefined,
    );
  } finally {
    db.close();
  }
}

test("正式阅读入口从 Objects 精确原件派生 Markdown，标注和进度只在 Reader 私库", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-reader-host-"));
  const workspaceFile = join(directory, "workspace.sqlite");
  const workspace = new WorkspaceStore(workspaceFile, { mode: "transport" });
  let domains:
    Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  let connection: LocalApplicationConnection | undefined;
  try {
    domains = await openApplicationDomainsHost(directory, workspace);
    await domains.content.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        domains!.content.platform.createProject(actor, {
          commandId: randomUUID(),
          projectId: "reader-project",
          title: "阅读项目",
        }),
    );
    const connect = async () => {
      connection = new LocalApplicationConnection(
        new Application(workspace, {
          platformWork: domains!.work,
          platformDocuments: domains!.content,
          platformReader: domains!.reader,
        }),
      );
      const boot = (await connection.call("platform.bootstrap")) as {
        csrfToken: string;
      };
      return (
        method: Parameters<LocalApplicationConnection["call"]>[0],
        input: unknown,
      ) =>
        connection!.call(method, input, { identityGeneration: boot.csrfToken });
    };
    let call = await connect();
    const document = (await call("documents.create", {
      commandId: randomUUID(),
      objectId: "reader-document",
      projectId: "reader-project",
      title: "读书笔记",
      markdown: "# 第一章\n\n你好世界，继续阅读。",
    })) as { contentId: string };
    const artifactId = document.contentId;
    const contents = (await call("reader.contents", {
      artifactId,
      revision: 1,
    })) as Array<{ id: string }>;
    assert.ok(contents.length > 0);
    const section = (await call("reader.read", {
      artifactId,
      revision: 1,
      sectionId: contents[0]!.id,
    })) as { id: string; sourceId: string; text: string; html: string };
    assert.match(section.text, /你好世界/);
    assert.match(section.html, /你好世界/);
    const agentSlice = await domains.reader.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        domains!.reader.service.readSlice(
          actor,
          artifactId,
          1,
          section.id,
          section.text.indexOf("你好"),
          2,
        ),
    );
    assert.equal(agentSlice.text, "你好");
    assert.equal(agentSlice.sourceLocatorId, section.sourceId);
    const start = section.text.indexOf("你好");
    const location = {
      sourceId: section.sourceId,
      sectionId: section.id,
      start,
      end: start + 2,
    };
    const add = {
      commandId: randomUUID(),
      artifactId,
      revision: 1,
      command: {
        action: "mark-add",
        artifactId,
        artifactRevision: 1,
        location,
        quote: "你好",
        kind: "highlight",
        color: "yellow",
        note: "",
      },
    };
    const mark = (await call("reader.command", add)) as {
      id: string;
      revision: number;
    };
    assert.deepEqual(await call("reader.command", add), mark);
    assert.equal(mark.revision, 1);
    const state = (await call("reader.state", { artifactId, revision: 1 })) as {
      position: null | { revision: number };
    };
    assert.equal(state.position, null);
    assert.equal("marks" in state, false);
    type Marks = {
      marks: Array<{ id: string; deletedAt: string | null; revision: number }>;
    };
    const marks = (await call("reader.marks", {
      artifactId,
      revision: 1,
    })) as Marks;
    assert.equal(marks.marks.length, 1);
    assert.equal(marks.marks[0]!.id, mark.id);
    const agentMarks = await domains.reader.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        domains!.reader.service.marks(actor, artifactId, 1, false, 0, 20),
    );
    assert.equal(agentMarks.marks[0]!.id, mark.id);
    const save = (await call("reader.command", {
      commandId: randomUUID(),
      artifactId,
      revision: 1,
      command: {
        action: "save-position",
        artifactId,
        artifactRevision: 1,
        location: { ...location, end: start },
        preferences: { fontSize: 20, font: "serif", theme: "system" },
        expectedRevision: 0,
      },
    })) as { revision: number };
    assert.equal(save.revision, 1);
    const removed = (await call("reader.command", {
      commandId: randomUUID(),
      artifactId,
      revision: 1,
      command: { action: "mark-remove", markId: mark.id, expectedRevision: 1 },
    })) as { revision: number };
    assert.equal(removed.revision, 2);
    assert.ok(
      (
        (await call("reader.marks", {
          artifactId,
          revision: 1,
          deleted: true,
        })) as Marks
      ).marks[0]!.deletedAt,
    );
    await assert.rejects(
      call("reader.command", {
        commandId: randomUUID(),
        artifactId,
        revision: 1,
        command: {
          action: "mark-remove",
          markId: mark.id,
          expectedRevision: 1,
        },
      }),
      /已在其他位置更新/,
    );
    await call("reader.command", {
      commandId: randomUUID(),
      artifactId,
      revision: 1,
      command: { action: "mark-restore", markId: mark.id, expectedRevision: 2 },
    });
    assert.equal(
      (
        (await call("reader.marks", {
          artifactId,
          revision: 1,
        })) as Marks
      ).marks[0]!.deletedAt,
      null,
    );
    assertNoLegacyWorkspace(workspaceFile);

    await call("documents.revise", {
      commandId: randomUUID(),
      contentId: artifactId,
      expectedRevision: 1,
      title: "读书笔记",
      markdown: "# 第一章\n\n另一版原文。",
    });
    assert.equal(
      (
        (await call("reader.marks", {
          artifactId,
          revision: 2,
        })) as Marks
      ).marks.length,
      0,
    );
    assert.equal(
      (
        (await call("reader.marks", {
          artifactId,
          revision: 1,
        })) as Marks
      ).marks.length,
      1,
    );

    connection?.close();
    connection = undefined;
    await domains.close();
    domains = await openApplicationDomainsHost(directory, workspace);
    call = await connect();
    const restored = (await call("reader.state", {
      artifactId,
      revision: 1,
    })) as typeof state;
    assert.equal(restored.position?.revision, 1);
    const restoredMarks = (await call("reader.marks", {
      artifactId,
      revision: 1,
    })) as Marks;
    assert.equal(restoredMarks.marks.length, 1);
    assert.equal(restoredMarks.marks[0]!.deletedAt, null);
    assert.match(
      (
        (await call("reader.read", {
          artifactId,
          revision: 2,
          sectionId: (
            (await call("reader.contents", {
              artifactId,
              revision: 2,
            })) as Array<{ id: string }>
          )[0]!.id,
        })) as { text: string }
      ).text,
      /另一版原文/,
    );
  } finally {
    connection?.close();
    await domains?.close();
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("正式阅读导入保存私有原件，目录可恢复，PDF 范围读取不经过旧 workspace", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-reader-import-"));
  const workspaceFile = join(directory, "workspace.sqlite");
  const workspace = new WorkspaceStore(workspaceFile, { mode: "transport" });
  let domains:
    Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  let connection: LocalApplicationConnection | undefined;
  try {
    domains = await openApplicationDomainsHost(directory, workspace);
    const application = () =>
      new Application(workspace, {
        platformReader: domains!.reader,
        platformWork: domains!.work,
        platformDocuments: domains!.content,
      });
    const connect = async () => {
      connection = new LocalApplicationConnection(application());
      const boot = (await connection.call("platform.bootstrap")) as {
        csrfToken: string;
      };
      return (
        method: Parameters<LocalApplicationConnection["call"]>[0],
        input: unknown,
      ) =>
        connection!.call(method, input, { identityGeneration: boot.csrfToken });
    };
    let call = await connect();
    await domains.content.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        domains!.content.platform.createProject(actor, {
          commandId: randomUUID(),
          projectId: "reader-import-project",
          title: "书房",
        }),
    );
    const commandId = randomUUID();
    const markdown = Buffer.from("# 第一章\n\n可核对的原文。", "utf8");
    const importRequest = {
      commandId,
      projectId: "reader-import-project",
      relativePath: "原文.md",
      data: markdown,
    };
    const imported = (await call("reader.import", importRequest)) as {
      entityId: string;
      bookId: string;
      revision: number;
      receiptId: string;
    };
    assert.deepEqual(await call("reader.import", importRequest), imported);
    assertNoLegacyWorkspace(workspaceFile);
    const book = (await call("reader.book", {
      artifactId: imported.entityId,
      revision: 1,
    })) as {
      bookId: string;
      title: string;
      sectionCount: number;
      sections: Array<{ id: string }>;
    };
    assert.equal(book.bookId, imported.bookId);
    assert.equal(book.sectionCount, 1);
    assert.match(
      (
        (await call("reader.read", {
          artifactId: imported.entityId,
          revision: 1,
          sectionId: book.sections[0]!.id,
        })) as { text: string }
      ).text,
      /可核对的原文/,
    );
    const pdf = readFileSync(new URL("./fixtures/reader.pdf", import.meta.url));
    const importedPdf = (await call("reader.import", {
      commandId: randomUUID(),
      projectId: "reader-import-project",
      relativePath: "原页.pdf",
      data: pdf,
    })) as { entityId: string; revision: number };
    const original = await domains.reader.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        domains!.reader.service.originalRange(
          actor,
          importedPdf.entityId,
          1,
          0,
          Math.min(128, pdf.length),
        ),
    );
    assert.deepEqual(Buffer.from(original), pdf.subarray(0, 128));
    assertNoLegacyWorkspace(workspaceFile);
    connection?.close();
    connection = undefined;
    await domains.close();
    const readerDb = new DatabaseSync(join(directory, "reader.sqlite"));
    try {
      readerDb.exec("UPDATE reader_book_events SET projected_at=NULL");
    } finally {
      readerDb.close();
    }
    domains = await openApplicationDomainsHost(directory, workspace);
    call = await connect();
    assert.equal(
      (
        (await call("reader.book", {
          artifactId: imported.entityId,
          revision: 1,
        })) as { bookId: string }
      ).bookId,
      imported.bookId,
    );
  } finally {
    connection?.close();
    await domains?.close();
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("正式 PDF OCR 识别、校对和重启读取只使用 Reader 私库与原件 Store", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-reader-ocr-domain-"));
  const workspaceFile = join(directory, "workspace.sqlite");
  const workspace = new WorkspaceStore(workspaceFile, { mode: "transport" });
  let domains:
    Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  let connection: LocalApplicationConnection | undefined;
  let engineCalls = 0;
  const pdf = readFileSync(new URL("./fixtures/reader.pdf", import.meta.url));
  const ocr = new ReaderOcr(
    join(directory, "models"),
    async ({ pdf: input, page }) => {
      engineCalls++;
      assert.deepEqual(Buffer.from(input), pdf);
      assert.equal(page, 1);
      return {
        image: { width: 100, height: 100 },
        items: [
          {
            poly: [
              [0, 0],
              [40, 0],
              [40, 20],
              [0, 20],
            ],
            text: "原页识别",
            score: 0.9,
          },
        ],
      };
    },
    fetch,
    async () => [new Uint8Array([1])],
  );
  try {
    domains = await openApplicationDomainsHost(directory, workspace);
    const connect = async () => {
      connection = new LocalApplicationConnection(
        new Application(workspace, {
          platformWork: domains!.work,
          platformDocuments: domains!.content,
          platformReader: domains!.reader,
          readerOcr: ocr,
        }),
      );
      const boot = (await connection.call("platform.bootstrap")) as {
        csrfToken: string;
      };
      return (
        method: Parameters<LocalApplicationConnection["call"]>[0],
        input: unknown,
      ) =>
        connection!.call(method, input, { identityGeneration: boot.csrfToken });
    };
    let call = await connect();
    await domains.content.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        domains!.content.platform.createProject(actor, {
          commandId: randomUUID(),
          projectId: "ocr-project",
          title: "扫描书房",
        }),
    );
    const imported = (await call("reader.import", {
      commandId: randomUUID(),
      projectId: "ocr-project",
      relativePath: "扫描.pdf",
      data: pdf,
    })) as { entityId: string };
    const binding = { artifactId: imported.entityId, revision: 1, page: 1 };
    const verifiedPdf = await domains.reader.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        domains!.reader.service.ocrPdfBytes(actor, imported.entityId, 1, 1),
    );
    assert.deepEqual(verifiedPdf, pdf);
    const seeded = await domains.reader.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        domains!.reader.service.saveOcr(actor, imported.entityId, 1, 1, {
          image: { width: 100, height: 100 },
          items: [
            {
              poly: [
                [0, 0],
                [40, 0],
                [40, 20],
                [0, 20],
              ],
              text: "先前识别",
              score: 0.9,
            },
          ],
          engine: "prior-test-engine",
          layout: "horizontal",
        }),
    );
    assert.match(seeded, /^page-1-ocr-[a-f0-9]{64}$/);
    const status = (await call("reader.ocr", {
      operation: "status",
      ...binding,
    })) as { installed: boolean; state: string };
    assert.equal(status.installed, true);
    assert.equal(status.state, "idle");
    const jobId = randomUUID();
    await call("reader.ocr", {
      operation: "start",
      ...binding,
      jobId,
      layout: "horizontal",
      download: false,
      force: true,
    });
    let completed: { state: string; sectionId?: string } | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      completed = (await call("reader.ocr", {
        operation: "status",
        ...binding,
        jobId,
      })) as typeof completed;
      if (completed?.state === "complete" || completed?.state === "failed")
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      completed?.state,
      "complete",
      JSON.stringify({ completed, engineCalls }),
    );
    assert.equal(engineCalls, 1);
    const first = completed!.sectionId!;
    assert.match(first, /^page-1-ocr-[a-f0-9]{64}$/);
    assert.equal(
      (
        (await call("reader.read", {
          artifactId: imported.entityId,
          revision: 1,
          sectionId: first,
        })) as { text: string }
      ).text,
      "原页识别",
    );
    const corrected = (await call("reader.ocr", {
      operation: "correct",
      ...binding,
      sectionId: first,
      line: 0,
      text: "校对文本",
    })) as { sectionId: string };
    assert.notEqual(corrected.sectionId, first);
    assert.equal(
      (
        (await call("reader.read", {
          artifactId: imported.entityId,
          revision: 1,
          sectionId: first,
        })) as { text: string }
      ).text,
      "原页识别",
    );
    assert.equal(
      (
        (await call("reader.read", {
          artifactId: imported.entityId,
          revision: 1,
          sectionId: corrected.sectionId,
        })) as { text: string }
      ).text,
      "校对文本",
    );
    assertNoLegacyWorkspace(workspaceFile);
    connection?.close();
    connection = undefined;
    await domains.close();
    domains = await openApplicationDomainsHost(directory, workspace);
    call = await connect();
    assert.equal(
      (
        (await call("reader.read", {
          artifactId: imported.entityId,
          revision: 1,
          sectionId: corrected.sectionId,
        })) as { text: string }
      ).text,
      "校对文本",
    );
    assertNoLegacyWorkspace(workspaceFile);
  } finally {
    ocr.close();
    connection?.close();
    await domains?.close();
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
