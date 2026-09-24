import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { ReaderOcr } from "../packages/application/src/reader-ocr.js";
import { localAccess, type Operation } from "../packages/core/src/model.js";
import { readingReference } from "../packages/core/src/reader.js";
import { readerTool } from "../packages/application/src/reader-tools.js";
import {
  orderOcr,
  ocrResultSchema,
  ocrEngine,
  readingOcrScale,
  type OcrResult,
} from "../packages/core/src/reader-ocr.js";

const line = (x: number, y: number, text: string) => ({
  poly: [
    [x, y],
    [x + 100, y],
    [x + 100, y + 30],
    [x, y + 30],
  ] as [number, number][],
  text,
  score: 0.95,
});
const sample: OcrResult = {
  image: { width: 500, height: 800 },
  items: [
    line(40, 20, "先王慎德。"),
    line(300, 20, "兼聽則明。"),
    line(40, 150, "此句尚需核对。"),
  ],
};
const exec = (store: WorkspaceStore, operation: Operation) =>
  store.execute({ commandId: randomUUID(), operation }, localAccess);
function book(store: WorkspaceStore) {
  const bytes = readFileSync(new URL("./fixtures/reader.pdf", import.meta.url));
  const content = store.addPdf(bytes, ["", ""], localAccess);
  return exec(store, {
    type: "import-pdf",
    projectId: "first-project",
    relativePath: "synthetic.pdf",
    content,
  }).entityId;
}
test("OCR 坐标校验和显式版式顺序；不把模型分数当正确率", () => {
  assert.equal(orderOcr(sample, "vertical").items[0]!.text, "兼聽則明。");
  assert.deepEqual(
    orderOcr(sample, "columns").items.map((i) => i.text),
    ["先王慎德。", "此句尚需核对。", "兼聽則明。"],
  );
  assert.equal(orderOcr(sample, "horizontal").items[1]!.text, "兼聽則明。");
  assert.equal(
    ocrResultSchema.safeParse({ ...sample, image: { width: 20, height: 800 } })
      .success,
    false,
  );
});
test("横排同行字框的上下微差不能颠倒表格单元格；双栏仍先左栏", () => {
  const input: OcrResult = {
    image: { width: 800, height: 500 },
    items: [
      line(20, 20, "日期"),
      line(300, 17, "页码"),
      line(560, 21, "内容"),
      line(20, 96, "2026-09-24"),
      line(300, 92, "12"),
      line(560, 94, "古籍校对"),
      line(20, 170, "2026-09-25"),
      line(300, 169, "36"),
      line(560, 166, "论文阅读"),
    ],
  };
  const original = structuredClone(input);
  assert.deepEqual(
    orderOcr(input, "horizontal").items.map((i) => i.text),
    [
      "日期",
      "页码",
      "内容",
      "2026-09-24",
      "12",
      "古籍校对",
      "2026-09-25",
      "36",
      "论文阅读",
    ],
  );
  assert.deepEqual(
    orderOcr(input, "columns").items.map((i) => i.text),
    [
      "日期",
      "页码",
      "2026-09-24",
      "12",
      "2026-09-25",
      "36",
      "内容",
      "古籍校对",
      "论文阅读",
    ],
  );
  assert.deepEqual(
    input,
    original,
    "Ordering must not rewrite recognized text or source polygons",
  );
});
test("同行大小字并排；相邻行不因逐步偏移被串成一行", () => {
  const taller = line(20, 90, "大字");
  taller.poly[2]![1] = taller.poly[3]![1] = 140;
  const input = {
    image: { width: 800, height: 500 },
    items: [
      line(20, 128, "下一行"),
      line(500, 100, "小字"),
      taller,
      line(20, 228, "第三行"),
      line(200, 214, "第一行右"),
      line(400, 200, "第一行左"),
    ],
  };
  assert.deepEqual(
    orderOcr(input, "horizontal").items.map((i) => i.text),
    ["大字", "小字", "下一行", "第一行右", "第一行左", "第三行"],
  );
  assert.deepEqual(orderOcr({ ...input, items: [] }, "horizontal").items, []);
});
test("OCR 栅格按像素预算渲染，不受扫描 PDF 纸张单位大小影响", () => {
  for (const [width, height] of [
    [460.8, 379.6],
    [595, 842],
    [842, 595],
    [3200, 1600],
  ]) {
    const scale = readingOcrScale(width!, height!);
    assert.equal(Math.round(Math.max(width!, height!) * scale), 2000);
  }
  assert.ok(readingOcrScale(460.8, 379.6) > 2.5);
  for (const size of [0, -1, NaN, Infinity, Number.MIN_VALUE])
    assert.throws(() => readingOcrScale(size, size));
});
test("OCR 校对新增不可变来源；旧标注、选文引用和原 PDF 保留，重开可读", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-reader-ocr-test-")),
    file = join(directory, "state.sqlite");
  let store = new WorkspaceStore(file);
  try {
    const artifactId = book(store),
      sectionId = store.saveReadingOcr(
        artifactId,
        1,
        1,
        { ...sample, engine: ocrEngine, layout: "horizontal" },
        localAccess,
      );
    const original = store.readerSection(artifactId, 1, sectionId, localAccess),
      location = { sourceId: original.sourceId, sectionId, start: 0, end: 5 };
    const reading = readingReference(original, location);
    assert.equal(reading.book.format, "pdf-ocr");
    exec(store, {
      type: "reader-command",
      command: {
        action: "mark-add",
        artifactId,
        artifactRevision: 1,
        location,
        kind: "highlight",
        quote: reading.quote,
        color: "yellow",
        note: "",
      },
    });
    const inputId = exec(store, {
      type: "record-input",
      projectId: "first-project",
      artifactId,
      artifactRevision: 1,
      selection: reading.quote,
      body: "只解释这一句",
      targetActantId: "morphz-agent",
      reading,
    }).entityId;
    const ocr = new ReaderOcr(store, join(directory, "models"));
    const corrected = await ocr.call(
      {
        operation: "correct",
        artifactId,
        revision: 1,
        page: 1,
        sectionId,
        line: 0,
        text: "校对后的文字",
      },
      localAccess,
    );
    assert.notEqual(corrected.sectionId, sectionId);
    assert.equal(
      store.readerSection(artifactId, 1, sectionId, localAccess).text,
      original.text,
    );
    assert.equal(
      store.readerSection(artifactId, 1, corrected.sectionId!, localAccess).ocr!
        .items[0]!.text,
      "先王慎德。",
    );
    assert.equal(
      store.snapshot().artifacts.find((a) => a.id === artifactId)!.revision,
      1,
    );
    const scope = {
      projectId: "first-project",
      inputId,
      access: { principalId: "morphz-service", actantId: "morphz-agent" },
    };
    const read = readerTool(store, scope, "reader-bound", {
      action: "read",
      artifactId,
      revision: 1,
      sectionId,
      limit: 5,
    }) as {
      text: string;
      ocr: {
        lineIndexBase: number;
        lines: {
          line: number;
          text: string;
          start: number;
          end: number;
          polygon: number[][];
          partial: boolean;
        }[];
      };
    };
    assert.equal(read.text, reading.quote);
    assert.equal(read.ocr.lineIndexBase, 0);
    assert.deepEqual(read.ocr.lines, [
      {
        line: 0,
        text: reading.quote,
        start: 0,
        end: 5,
        polygon: sample.items[0]!.poly,
        partial: false,
        corrected: false,
      },
    ]);
    const partial = readerTool(store, scope, "reader-partial", {
      action: "read",
      artifactId,
      revision: 1,
      sectionId,
      offset: 2,
      limit: 2,
    }) as typeof read;
    assert.equal(partial.ocr.lines[0]!.text, reading.quote.slice(2, 4));
    assert.equal(partial.ocr.lines[0]!.partial, true);
    assert.throws(
      () =>
        readerTool(store, scope, "reader-bypass", {
          action: "read",
          artifactId,
          revision: 1,
          sectionId: corrected.sectionId!,
          limit: 8000,
        }),
      /绑定的识别文本版本/,
    );
    const later = readerTool(store, scope, "reader-later", {
      action: "read",
      artifactId,
      revision: 1,
      sectionId: "page-2",
      limit: 8000,
    }) as { text: string; location: { sectionId: string } };
    assert.equal(later.location.sectionId, "page-2");
    const full = readerTool(store, scope, "reader-full", {
      action: "read",
      artifactId,
      revision: 1,
      sectionId,
      limit: 8000,
    }) as { text: string };
    assert.equal(full.text, original.text);
    for (const page of [1, 2]) {
      const status = await readerTool(
        store,
        scope,
        `ocr-status-${page}`,
        {
          action: "ocr",
          request: { operation: "status", artifactId, revision: 1, page },
        },
        ocr,
      );
      assert.ok(status);
    }
    await assert.rejects(
      ocr.call(
        { operation: "status", artifactId, revision: 1, page: 1 },
        { principalId: "other", actantId: "other" },
      ),
    );
    store.close();
    store = new WorkspaceStore(file);
    assert.equal(
      store.readerSection(artifactId, 1, sectionId, localAccess).text,
      original.text,
    );
    assert.equal(
      store.snapshot().readingMarks[0]!.location.sectionId,
      sectionId,
    );
    assert.deepEqual(
      store.snapshot().inputs.find((i) => i.id === inputId)!.reading,
      reading,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("OCR 不自动下载、不上传文档；Agent 不得确认安装，取消阻止写入", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-reader-ocr-test-")),
    store = new WorkspaceStore(":memory:");
  try {
    const artifactId = book(store),
      bound = { artifactId, revision: 1, page: 1 };
    let fetched = 0,
      called = 0;
    const service = new ReaderOcr(
      store,
      directory,
      async () => {
        called++;
        return sample;
      },
      async (url, init) => {
        fetched++;
        assert.match(
          String(url),
          /^https:\/\/paddle-model-ecology\.bj\.bcebos\.com\//,
        );
        assert.equal(init?.method, undefined);
        assert.equal(init?.body, undefined);
        assert.equal(init?.credentials, "omit");
        return await new Promise<Response>((_ok, no) => {
          init?.signal?.addEventListener(
            "abort",
            () => no(new Error("cancelled")),
            { once: true },
          );
        });
      },
    );
    const request = {
      operation: "start",
      ...bound,
      jobId: randomUUID(),
      layout: "horizontal",
      download: false,
    };
    await assert.rejects(service.call(request, localAccess), /确认下载/);
    assert.equal(fetched, 0);
    const inputId = exec(store, {
      type: "record-input",
      projectId: "first-project",
      artifactId,
      artifactRevision: 1,
      selection: "",
      body: "识别文件",
      targetActantId: "morphz-agent",
    }).entityId;
    await assert.rejects(
      service.call(
        { ...request, download: true },
        { principalId: "morphz-service", actantId: "morphz-agent" },
        inputId,
      ),
      /不能代替确认/,
    );
    const start = await service.call(
      { ...request, download: true },
      localAccess,
    );
    assert.equal(start.state, "loading");
    await service.call(
      { operation: "cancel", ...bound, jobId: request.jobId },
      localAccess,
    );
    await new Promise((ok) => setTimeout(ok, 20));
    const status = await service.call(
      { operation: "status", ...bound, jobId: request.jobId },
      localAccess,
    );
    assert.equal(status.state, "cancelled");
    assert.equal(called, 0);
    assert.equal(
      store.latestReadingOcr(artifactId, 1, 1, localAccess),
      undefined,
    );
    service.close();
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
