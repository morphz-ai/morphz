import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { extractPdf } from "../apps/service/src/pdf.js";
import { pdfImportIssue, maxPdfBytes } from "../packages/core/src/pdf.js";
import { createAppServer } from "../apps/service/src/http.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { maxReadingFileBytes } from "../packages/core/src/reader.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";

const fixture = readFileSync(new URL("./fixtures/reader.pdf", import.meta.url));
function paddedPdf(size: number) {
  const bytes = Buffer.alloc(size, 32);
  fixture.copy(bytes);
  const trailer = fixture.subarray(fixture.lastIndexOf("startxref"));
  trailer.copy(bytes, size - trailer.length);
  return bytes;
}

test("PDF 阅读和内容导入接受完整 32 MB，超限失败不产生对象", async () => {
  const f = await platformRuntimeHostFixture();
  const host = new LocalApplicationConnection(f.application);
  try {
    const boot = (await host.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const options = { identityGeneration: boot.csrfToken };
    const request = {
      commandId: randomUUID(),
      projectId: f.projectId,
      relativePath: "TEST-large.pdf",
      data: paddedPdf(maxReadingFileBytes),
    };
    const first = (await host.call("reader.import", request, options)) as {
      entityId: string;
    };
    assert.deepEqual(await host.call("pdf.import", request, options), first);
    const book = (await host.call(
      "reader.book",
      { artifactId: first.entityId, revision: 1 },
      options,
    )) as { format: string; byteLength: number };
    assert.equal(book.format, "pdf");
    assert.equal(book.byteLength, maxReadingFileBytes);
    const saved = await f.session().listPlatformContent({});
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.appId, "morphz.reader");
    for (const method of ["reader.import", "pdf.import"] as const)
      await assert.rejects(
        host.call(
          method,
          {
            ...request,
            commandId: randomUUID(),
            data: Buffer.alloc(maxReadingFileBytes + 1),
          },
          options,
        ),
        /大小限制/,
      );
    assert.deepEqual(await f.session().listPlatformContent({}), saved);
    f.assertNoLegacyData();
  } finally {
    host.close();
    await f.close();
  }
});

test("PDF 原文提取、精确按页引用、原件字节与重启保存", async () => {
  const pages = await extractPdf(fixture);
  assert.equal(pages.length, 2);
  assert.match(pages[0]!, /DESIGN NOTES/);
  assert.match(pages[1]!, /durable butterfly/);
  assert.match(pages[1]!, /合成测试资料/);
  const f = await platformRuntimeHostFixture();
  try {
    const command = {
      commandId: randomUUID(),
      projectId: f.projectId,
      relativePath: "notes/reader.pdf",
      data: fixture,
    };
    const receipt = await f.session().importPdf(command);
    assert.deepEqual(await f.session().importPdf(command), receipt);
    await assert.rejects(
      f.session().importPdf({ ...command, pages: ["forged"] }),
    );
    const entries = await f.session().listPlatformContent({});
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.appId, "morphz.reader");
    assert.equal(
      (
        await f.domains.work.authority.withSession(
          { principalId: "local-owner", actantId: "local-human" },
          () => {},
          (actor) =>
            f.domains.work.service.searchContentTitles(actor, {
              query: "durable butterfly",
            }),
        )
      ).total,
      0,
      "导入 PDF 正文不进入 Agent 成果索引",
    );
    const artifactId = receipt.entityId;
    const contents = await f
      .session()
      .readPlatformReaderContents({ artifactId, revision: 1 });
    assert.equal(contents.length, 2);
    const page = await f.session().readPlatformReaderSection({
      artifactId,
      revision: 1,
      sectionId: contents[1]!.id,
    });
    const start = page.text.indexOf("durable butterfly");
    assert.ok(start >= 0);
    const location = {
      sourceId: page.sourceId,
      sectionId: page.id,
      start,
      end: start + "durable butterfly".length,
    };
    const markCommand = {
      commandId: randomUUID(),
      artifactId,
      revision: 1,
      command: {
        action: "mark-add",
        artifactId,
        artifactRevision: 1,
        location,
        quote: "durable butterfly",
        kind: "note",
        color: "yellow",
        note: "复查此项",
      },
    };
    const mark = await f.session().commandPlatformReader(markCommand);
    assert.deepEqual(
      await f.session().commandPlatformReader(markCommand),
      mark,
    );
    await assert.rejects(
      f.session().commandPlatformReader({
        ...markCommand,
        commandId: randomUUID(),
        command: {
          ...markCommand.command,
          location: { ...location, sectionId: contents[0]!.id },
        },
      }),
      /原文|选文|位置|不匹配/,
    );
    const original = () =>
      f.domains.reader.authority.withSession(
        { principalId: "local-owner", actantId: "local-human" },
        () => {},
        (actor) =>
          f.domains.reader.service.originalRange(
            actor,
            artifactId,
            1,
            0,
            fixture.length,
          ),
      );
    assert.deepEqual(Buffer.from(await original()), fixture);
    await f.reopen();
    const state = await f.session().readPlatformReaderMarks({
      artifactId,
      revision: 1,
      deleted: false,
      offset: 0,
      limit: 50,
    });
    assert.equal(state.hasMore, false);
    assert.equal(state.marks.length, 1);
    assert.equal(state.marks[0]!.location.sectionId, contents[1]!.id);
    assert.equal(state.marks[0]!.note, "复查此项");
    assert.deepEqual(Buffer.from(await original()), fixture);
    assert.match(
      (
        await f.session().readPlatformReaderSection({
          artifactId,
          revision: 1,
          sectionId: contents[1]!.id,
        })
      ).text,
      /durable butterfly/,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("PDF 拒绝无效输入、越界来源及客户端伪造解析资料", async () => {
  await assert.rejects(extractPdf(Buffer.from("not pdf")), /有效 PDF/);
  await assert.rejects(extractPdf(Buffer.alloc(maxPdfBytes + 1)), /32 MB/);
  await assert.rejects(
    extractPdf(Buffer.from("%PDF-1.7\\ninvalid")),
    /无法解析/,
  );
  for (const path of [
    "../a.pdf",
    "/a.pdf",
    "keys/.env.pdf",
    "node_modules/a.pdf",
    "id_rsa.pdf",
  ])
    assert.ok(pdfImportIssue(path), path);
  assert.equal(pdfImportIssue("notes/paper.pdf"), null);
  const f = await platformRuntimeHostFixture();
  try {
    await assert.rejects(
      f.session().importPdf({
        commandId: randomUUID(),
        projectId: f.projectId,
        relativePath: "paper.pdf",
        content: {
          kind: "pdf",
          assetId: "a".repeat(64),
          pages: ["untrusted"],
        },
      }),
    );
    for (const relativePath of ["../a.pdf", "/a.pdf", "keys/.env.pdf"])
      await assert.rejects(
        f.session().importPdf({
          commandId: randomUUID(),
          projectId: f.projectId,
          relativePath,
          data: fixture,
        }),
      );
    assert.deepEqual(await f.session().listPlatformContent({}), []);
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("PDF HTTP 导入经过请求验证、权限检查与幂等写入", async () => {
  const f = await platformRuntimeHostFixture();
  const { createServer } = await import("node:net");
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = createAppServer(f.store, {
    port,
    webRoot: "/nonexistent",
    platformWork: f.domains.work,
    platformReader: f.domains.reader,
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  const origin = `http://127.0.0.1:${port}`;
  try {
    const boot = (await fetch(origin + "/api/platform/bootstrap").then(
      (response) => response.json(),
    )) as { csrfToken: string };
    const headers = {
      Origin: origin,
      "X-Morphz-Token": boot.csrfToken,
      "X-Command-Id": randomUUID(),
      "X-Project-Id": f.projectId,
      "X-Source-Path": "reader.pdf",
    };
    const post = (overrides = {}) =>
      fetch(origin + "/api/import/pdf", {
        method: "POST",
        headers: { ...headers, ...overrides },
        body: fixture,
      });
    assert.equal(
      (await post({ Origin: "https://external.invalid" })).status,
      403,
    );
    assert.equal((await post({ "X-Project-Id": "unknown" })).status, 403);
    const first = await post();
    assert.equal(first.status, 201);
    const receipt = await first.json();
    assert.deepEqual(await (await post()).json(), receipt);
    const book = await fetch(
      origin + `/api/reader/book?artifactId=${receipt.entityId}&revision=1`,
    );
    assert.equal(book.status, 200);
    assert.equal((await book.json()).format, "pdf");
    assert.equal((await f.session().listPlatformContent({})).length, 1);
    const large = paddedPdf(maxReadingFileBytes);
    const largeHeaders = {
      ...headers,
      "X-Command-Id": randomUUID(),
      "X-Source-Path": "TEST-large.pdf",
    };
    let largeReceipt: unknown;
    for (const route of ["/api/import/reading", "/api/import/pdf"]) {
      const result = await fetch(origin + route, {
        method: "POST",
        headers: largeHeaders,
        body: large,
      });
      assert.equal(result.status, 201);
      const saved = await result.json();
      if (largeReceipt) assert.deepEqual(saved, largeReceipt);
      largeReceipt = saved;
    }
    assert.equal((await f.session().listPlatformContent({})).length, 2);
    f.assertNoLegacyData();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});
