import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Application } from "../packages/application/src/application.js";
import { ReaderOcr } from "../packages/application/src/reader-ocr.js";
import type { PlatformActor } from "../packages/platform/src/store.js";
import { localAccess } from "../packages/core/src/model.js";
import {
  readingReference,
  type ReadingSection,
} from "../packages/core/src/reader.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { platformMessageFixture } from "./platform-message-fixture.js";
import {
  orderOcr,
  ocrResultSchema,
  ocrEngine,
  readingOcrScale,
  type OcrResult,
} from "../packages/core/src/reader-ocr.js";
import type { WorkspaceChange } from "../packages/core/src/workspace-changes.js";

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
  const host = await platformMessageFixture([], {
    browser: true,
    model: "isolated-ocr-model",
  });
  const ocr = new ReaderOcr(join(host.directory, "models"));
  let agent: Awaited<ReturnType<typeof agentDomainFixture>> | undefined;
  const human = () =>
    new Application(host.transport, {
      ...host.applicationOptions,
      readerOcr: ocr,
    }).session(localAccess);
  const pdf = readFileSync(new URL("./fixtures/reader.pdf", import.meta.url));
  try {
    const imported = await human().importReading({
      commandId: randomUUID(),
      projectId: "first-project",
      relativePath: "synthetic.pdf",
      data: pdf,
    });
    const artifactId = imported.entityId;
    agent = await agentDomainFixture({
      existingCenter: { directory: host.directory, projectId: "first-project" },
      readerOcr: ocr,
    });
    const withHuman = <T>(operation: (actor: PlatformActor) => Promise<T>) =>
      agent!.withHuman(operation);
    const reader = () => agent!.domains.reader.service;
    const sectionId = await withHuman((actor) =>
      reader().saveOcr(actor, artifactId, 1, 1, {
        ...sample,
        engine: ocrEngine,
        layout: "horizontal",
      }),
    );
    const original = (await human().readPlatformReaderSection({
      artifactId,
      revision: 1,
      sectionId,
    })) as ReadingSection;
    const location = {
      sourceId: original.sourceId,
      sectionId,
      start: 0,
      end: 5,
    };
    const reading = readingReference(original, location);
    assert.equal(reading.book.format, "pdf-ocr");
    await human().commandPlatformReader({
      commandId: randomUUID(),
      artifactId,
      revision: 1,
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
    const inputId = randomUUID();
    const spaces = await human().ensurePlatformSpaces();
    await human().platformMessage({
      commandId: inputId,
      operation: {
        type: "record-input",
        projectId: "first-project",
        conversationId: spaces.dialogueId,
        artifactId,
        artifactRevision: 1,
        selection: reading.quote,
        body: "只解释这一句",
        targetActantId: "morphz-agent",
        reading,
      },
    });
    const route = agent.input(
      "first-project",
      "只解释这一句",
      reading.quote,
      reading,
      { inputId },
    );
    const corrected = await human().readingOcr({
      operation: "correct",
      artifactId,
      revision: 1,
      page: 1,
      sectionId,
      line: 0,
      text: "校对后的文字",
    });
    assert.notEqual(corrected.sectionId, sectionId);
    assert.equal(
      (
        await human().readPlatformReaderSection({
          artifactId,
          revision: 1,
          sectionId,
        })
      ).text,
      original.text,
    );
    const correctedSection = (await human().readPlatformReaderSection({
      artifactId,
      revision: 1,
      sectionId: corrected.sectionId!,
    })) as ReadingSection;
    assert.equal(correctedSection.ocr!.items[0]!.text, "先王慎德。");
    assert.equal(
      (
        await human().readPlatformReaderBook({
          artifactId,
          revision: 1,
        })
      ).revision,
      1,
    );
    type Slice = {
      text: string;
      location: { sourceId: string; sectionId: string };
      ocr: {
        lineIndexBase: number;
        linesTruncated: boolean;
        lines: {
          line: number;
          text: string;
          start: number;
          end: number;
          polygon: number[][];
          partial: boolean;
          corrected: boolean;
        }[];
      };
    };
    const read = async (section: string, offset = 0, limit = 8000) =>
      agent!.call<Slice>(
        {
          action: "reader",
          reader: {
            action: "read",
            artifactId,
            revision: 1,
            sectionId: section,
            offset,
            limit,
          },
        },
        route,
      );
    const bound = await read(sectionId, 0, 5);
    assert.equal(bound.text, reading.quote);
    assert.equal(bound.ocr.lineIndexBase, 0);
    assert.deepEqual(bound.ocr.lines, [
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
    const partial = await read(sectionId, 2, 2);
    assert.equal(partial.ocr.lines[0]!.text, reading.quote.slice(2, 4));
    assert.equal(partial.ocr.lines[0]!.partial, true);
    // An explicit read may compare the new correction; it must identify that
    // distinct immutable source, never silently substitute it for the quote.
    const revised = await read(corrected.sectionId!);
    assert.equal(revised.location.sectionId, corrected.sectionId);
    assert.equal(revised.ocr.lines[0]!.corrected, true);
    assert.match(revised.text, /^校对后的文字/);
    assert.equal((await read(sectionId)).text, original.text);
    assert.equal((await read("page-2")).location.sectionId, "page-2");
    for (const page of [1, 2]) {
      const status: { state: string } = await agent.call<{ state: string }>(
        {
          action: "reader",
          reader: {
            action: "ocr",
            request: { operation: "status", artifactId, revision: 1, page },
          },
        },
        route,
      );
      assert.equal(status.state, "idle");
    }
    await assert.rejects(
      new Application(host.transport, {
        ...host.applicationOptions,
        readerOcr: ocr,
      })
        .session({ principalId: "other", actantId: "other" })
        .readingOcr({
          operation: "status",
          artifactId,
          revision: 1,
          page: 1,
        }),
    );
    await agent.close();
    agent = undefined;
    await host.reopen();
    assert.equal(
      (
        await human().readPlatformReaderSection({
          artifactId,
          revision: 1,
          sectionId,
        })
      ).text,
      original.text,
    );
    const state = await human().readPlatformReaderMarks({
      artifactId,
      revision: 1,
      deleted: false,
      offset: 0,
      limit: 50,
    });
    assert.equal(state.hasMore, false);
    assert.equal(state.marks[0]!.location.sectionId, sectionId);
    assert.deepEqual(host.input(inputId).reading, reading);
    const bytes = await human().readPlatformReaderOriginalRange({
      artifactId,
      revision: 1,
      start: 0,
      endExclusive: pdf.length,
    });
    assert.deepEqual(Buffer.from(bytes), pdf);
    host.assertNoLegacyData();
  } finally {
    ocr.close();
    await agent?.close();
    await host.close();
  }
});
test("OCR 不自动下载、不上传文档；Agent 不得确认安装，取消阻止写入", async () => {
  const host = await platformMessageFixture([], { browser: true });
  let agent: Awaited<ReturnType<typeof agentDomainFixture>> | undefined;
  let fetched = 0;
  let called = 0;
  const service = new ReaderOcr(
    join(host.directory, "models"),
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
  const human = () =>
    new Application(host.transport, {
      ...host.applicationOptions,
      readerOcr: service,
    }).session(localAccess);
  try {
    const imported = await human().importReading({
      commandId: randomUUID(),
      projectId: "first-project",
      relativePath: "synthetic.pdf",
      data: readFileSync(new URL("./fixtures/reader.pdf", import.meta.url)),
    });
    const artifactId = imported.entityId;
    const bound = { artifactId, revision: 1, page: 1 };
    const request = {
      operation: "start",
      ...bound,
      jobId: randomUUID(),
      layout: "horizontal",
      download: false,
    };
    await assert.rejects(human().readingOcr(request), /确认下载/);
    assert.equal(fetched, 0);
    agent = await agentDomainFixture({
      existingCenter: { directory: host.directory, projectId: "first-project" },
      readerOcr: service,
    });
    const route = agent.input("first-project", "识别文件");
    await assert.rejects(
      agent.call(
        {
          action: "reader",
          reader: { action: "ocr", request: { ...request, download: true } },
        },
        route,
      ),
      /不能代替确认/,
    );
    const start = await human().readingOcr({ ...request, download: true });
    assert.equal(start.state, "loading");
    await human().readingOcr({
      operation: "cancel",
      ...bound,
      jobId: request.jobId,
    });
    await new Promise((ok) => setTimeout(ok, 20));
    const status = await human().readingOcr({
      operation: "status",
      ...bound,
      jobId: request.jobId,
    });
    assert.equal(status.state, "cancelled");
    assert.equal(called, 0);
    assert.equal(
      await agent.withHuman((actor) =>
        agent!.domains.reader.service.latestOcr(actor, artifactId, 1, 1),
      ),
      null,
    );
    host.assertNoLegacyData();
  } finally {
    service.close();
    await agent?.close();
    await host.close();
  }
});

test("OCR Host 进度和结果通过已授权 workspace 通知唤醒，闲置不发 frame", async () => {
  const host = await platformMessageFixture([], { browser: true });
  let release!: (result: OcrResult) => void;
  let entered = false;
  const engineResult = new Promise<OcrResult>((resolve) => {
    release = resolve;
  });
  const service = new ReaderOcr(
    join(host.directory, "models"),
    async () => {
      entered = true;
      return engineResult;
    },
    async () => {
      throw new Error("Synthetic installed model must not download");
    },
    async () => [new Uint8Array([1])],
  );
  let agent: Awaited<ReturnType<typeof agentDomainFixture>> | undefined;
  let dispose: (() => void) | undefined;
  const frames: WorkspaceChange[] = [];
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 4000;
    while (!check()) {
      assert.ok(
        Date.now() < deadline,
        "Expected real OCR Host change notification",
      );
      await new Promise((done) => setTimeout(done, 5));
    }
  };
  try {
    const imported = await new Application(host.transport, {
      ...host.applicationOptions,
      readerOcr: service,
    })
      .session(localAccess)
      .importReading({
        commandId: randomUUID(),
        projectId: "first-project",
        relativePath: "event-ocr.pdf",
        data: readFileSync(new URL("./fixtures/reader.pdf", import.meta.url)),
      });
    agent = await agentDomainFixture({
      existingCenter: { directory: host.directory, projectId: "first-project" },
      readerOcr: service,
    });
    const session = new Application(host.transport, {
      ...host.applicationOptions,
      runtime: undefined,
      workspaceChanges: agent.domains.workspaceChanges,
      readerOcr: service,
    }).session(localAccess, () => {});
    dispose = await session.observeWorkspaceChanges(
      (frame) => frames.push(frame),
      () => {},
    );
    await until(() => frames.length === 1);
    const foreign = service.workspaceChangeVersion("foreign:principal");
    const owner = `${agent.domains.reader.authority.tenantId}:${localAccess.principalId}`;
    const own = service.workspaceChangeVersion(owner);
    const request = {
      artifactId: imported.entityId,
      revision: 1,
      page: 1,
      jobId: randomUUID(),
    };
    await session.readingOcr({
      ...request,
      operation: "start",
      layout: "horizontal",
      download: false,
    });
    await until(() => entered && frames.length > 1);
    assert.equal(
      (await session.readingOcr({ ...request, operation: "status" })).state,
      "recognizing",
    );
    assert.notEqual(service.workspaceChangeVersion(owner), own);
    assert.equal(service.workspaceChangeVersion("foreign:principal"), foreign);
    const progressFrames = frames.length;
    await new Promise((done) => setTimeout(done, 150));
    assert.equal(
      frames.length,
      progressFrames,
      "healthy OCR work must not poll or keep emitting",
    );
    release(sample);
    await until(() => frames.length > progressFrames);
    // A commit wake may precede the final job-state wake; read only in response
    // to each actual notification instead of using the old status interval.
    let result = await session.readingOcr({ ...request, operation: "status" });
    if (result.state !== "complete") {
      const pending = frames.length;
      await until(() => frames.length > pending);
      result = await session.readingOcr({ ...request, operation: "status" });
    }
    assert.equal(result.state, "complete");
    assert.ok(result.sectionId);
    assert.deepEqual(
      frames.map((frame) => frame.sequence),
      frames.map((_, i) => i + 1),
    );
    for (const frame of frames)
      assert.deepEqual(Object.keys(frame).sort(), [
        "accessChanged",
        "kind",
        "reason",
        "sequence",
      ]);
    const finalFrames = frames.length;
    await new Promise((done) => setTimeout(done, 150));
    assert.equal(frames.length, finalFrames);
    dispose();
    dispose = undefined;
    const retained = await session.readPlatformReaderSection({
      artifactId: imported.entityId,
      revision: 1,
      sectionId: result.sectionId!,
    });
    assert.match(retained.text, /先王慎德/);
    host.assertNoLegacyData();
  } finally {
    release?.(sample);
    dispose?.();
    service.close();
    await agent?.close();
    await host.close();
  }
});
