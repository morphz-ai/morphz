import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractPdf } from "../apps/service/src/pdf.js";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { localAccess } from "../packages/core/src/model.js";
import { pdfImportIssue, maxPdfBytes } from "../packages/core/src/pdf.js";
import { searchArtifacts } from "../packages/core/src/retrieval.js";
import { createAppServer } from "../apps/service/src/http.js";
import { Application } from "../packages/application/src/application.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { maxReadingFileBytes } from "../packages/core/src/reader.js";

const fixture = readFileSync(new URL("./fixtures/reader.pdf", import.meta.url));
function paddedPdf(size: number) {
  // Keep the original xref offsets valid and repeat its trailer after legal
  // whitespace. No external sample or user document enters the regression suite.
  const bytes = Buffer.alloc(size, 32);
  fixture.copy(bytes);
  const trailer = fixture.subarray(fixture.lastIndexOf("startxref"));
  trailer.copy(bytes, size - trailer.length);
  return bytes;
}

test("PDF 阅读和内容导入接受完整 32 MB，超限失败不产生对象", async () => {
  const store = new WorkspaceStore(":memory:");
  const host = new LocalApplicationConnection(new Application(store));
  try {
    const boot = (await host.call("workspace")) as { csrfToken: string };
    const options = { identityGeneration: boot.csrfToken };
    const source = paddedPdf(maxReadingFileBytes);
    const request = {
      commandId: randomUUID(),
      projectId: "first-project",
      relativePath: "TEST-large.pdf",
      data: source,
    };
    const first = (await host.call("reader.import", request, options)) as {
      entityId: string;
    };
    assert.deepEqual(await host.call("pdf.import", request, options), first);
    const book = store
      .snapshot()
      .artifacts.find((a) => a.id === first.entityId)!;
    assert.equal(book.content.kind, "pdf");
    if (book.content.kind !== "pdf") throw new Error("Expected PDF");
    assert.match(book.content.pages[0]!, /DESIGN NOTES/);
    assert.equal(
      store.asset(book.content.assetId)!.bytes.byteLength,
      maxReadingFileBytes,
    );
    assert.equal(store.snapshot().artifacts.length, 1);
    for (const method of ["reader.import", "pdf.import"] as const) {
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
    }
    assert.equal(store.snapshot().artifacts.length, 1);
  } finally {
    host.close();
    store.close();
  }
});

test("PDF 原文提取、按页引用、可信内容与重启保存", async () => {
  const pages = await extractPdf(fixture);
  assert.equal(pages.length, 2);
  assert.match(pages[0]!, /DESIGN NOTES/);
  assert.match(pages[1]!, /durable butterfly/);
  assert.match(pages[1]!, /合成测试资料/);
  const dir = mkdtempSync(join(tmpdir(), "morphz-application-pdf-")),
    file = join(dir, "db");
  const store = new WorkspaceStore(file);
  try {
    const content = store.addPdf(fixture, pages);
    const command = {
      commandId: randomUUID(),
      operation: {
        type: "import-pdf",
        projectId: "first-project",
        relativePath: "notes/reader.pdf",
        content,
      },
    };
    const receipt = store.execute(command, localAccess);
    assert.deepEqual(store.execute(command, localAccess), receipt);
    assert.throws(
      () =>
        store.execute(
          {
            ...command,
            commandId: randomUUID(),
            operation: {
              ...command.operation,
              content: { ...content, pages: ["forged"] },
            },
          },
          localAccess,
        ),
      /不匹配/,
    );
    const results = searchArtifacts(
      store.snapshot(),
      { query: "durable butterfly" },
      localAccess,
    );
    assert.equal(results.total, 0, "导入 PDF 不进入 Agent 成果索引");
    assert.ok(content.pages[1]!.includes("durable butterfly"));
    const annotation = {
      type: "annotate",
      artifactId: receipt.entityId,
      artifactRevision: 1,
      quote: "durable butterfly",
      body: "复查此项",
      page: 2,
    };
    store.execute(
      { commandId: randomUUID(), operation: annotation },
      localAccess,
    );
    assert.throws(
      () =>
        store.execute(
          { commandId: randomUUID(), operation: { ...annotation, page: 1 } },
          localAccess,
        ),
      /原文或版本无效/,
    );
    store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "record-input",
          projectId: "first-project",
          artifactId: receipt.entityId,
          artifactRevision: 1,
          selection: "durable butterfly",
          body: "解释这一页",
          targetActantId: "morphz-agent",
        },
      },
      localAccess,
    );
    store.close();
    const reopened = new WorkspaceStore(file);
    assert.equal(reopened.snapshot().annotations[0]!.page, 2);
    assert.equal(reopened.snapshot().artifacts[0]!.source?.name, "reader.pdf");
    assert.deepEqual(
      Buffer.from(reopened.asset(content.assetId)!.bytes),
      fixture,
    );
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test("PDF 拒绝无效输入、越界来源及未解析伪造资料", async () => {
  await assert.rejects(extractPdf(Buffer.from("not pdf")), /有效 PDF/);
  await assert.rejects(extractPdf(Buffer.alloc(maxPdfBytes + 1)), /32 MB/);
  await assert.rejects(
    extractPdf(Buffer.from("%PDF-1.7\ninvalid")),
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
  const store = new WorkspaceStore(":memory:");
  try {
    assert.throws(
      () =>
        store.execute(
          {
            commandId: randomUUID(),
            operation: {
              type: "import-pdf",
              projectId: "first-project",
              relativePath: "paper.pdf",
              content: {
                kind: "pdf",
                assetId: "a".repeat(64),
                pages: ["untrusted"],
              },
            },
          },
          localAccess,
        ),
      /无权使用/,
    );
  } finally {
    store.close();
  }
});
test("PDF HTTP 导入经过请求验证、权限检查与幂等写入", async () => {
  const store = new WorkspaceStore(":memory:");
  // Reserve a port first; app Host checking must use the actual chosen port.
  const { createServer } = await import("node:net");
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const server = createAppServer(store, { port, webRoot: "/nonexistent" });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${port}`;
  try {
    const boot = (await fetch(origin + "/api/workspace").then((r) =>
      r.json(),
    )) as { csrfToken: string };
    const headers = {
      Origin: origin,
      "X-Morphz-Token": boot.csrfToken,
      "X-Command-Id": randomUUID(),
      "X-Project-Id": "first-project",
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
    assert.equal((await post({ "X-Project-Id": "unknown" })).status, 404);
    const first = await post();
    assert.equal(first.status, 201);
    const receipt = await first.json();
    assert.deepEqual(await (await post()).json(), receipt);
    assert.equal(store.snapshot().artifacts.length, 1);
    const large = paddedPdf(maxReadingFileBytes);
    const largeHeaders = {
      ...headers,
      "X-Command-Id": randomUUID(),
      "X-Source-Path": "TEST-large.pdf",
    };
    let largeReceipt;
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
    assert.equal(store.snapshot().artifacts.length, 2);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});
