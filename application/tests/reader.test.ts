import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { crc32 } from "node:zlib";
import { join } from "node:path";
import {
  parsePublication,
  parsePublicationRaw,
  safeReadingSection,
} from "../packages/application/src/reader-import.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
import { localAccess, type RecordedInput } from "../packages/core/src/model.js";
import {
  readingReference,
  readingPosition,
  readingInputSchema,
  readingPreferencesSchema,
  type ReaderCommand,
  type ReadingInput,
} from "../packages/core/src/reader.js";
import { workToolDefinitions } from "../packages/application/src/agent-tools.js";
import {
  workInputData,
  workInputRequest,
  readingInputFormat,
  readingPositionInputFormat,
} from "../packages/application/src/session-io.js";
import { migrateReadingLocalState } from "../apps/web/src/legacy-storage.js";
import { readerOffsets } from "../apps/web/src/reader-dom.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";

/** Synthetic fixtures only. Stored entries make size/path attacks deterministic. */
function zip(files: Record<string, string>) {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = Buffer.from(path),
      bytes = Buffer.from(text),
      crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(bytes.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    locals.push(header, name, bytes);
    central.push(directory, name);
    offset += header.length + name.length + bytes.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(
    central.reduce((n, b) => n + b.length, 0),
    12,
  );
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}
const epubFiles = {
  mimetype: "application/epub+zip",
  "META-INF/container.xml":
    '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  "OEBPS/content.opf":
    '<package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>合成通鉴</dc:title><dc:creator>测试作者</dc:creator><dc:language>zh</dc:language></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="a"/><itemref idref="b"/></spine></package>',
  "OEBPS/toc.ncx":
    '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint><navLabel><text>周纪一</text></navLabel><content src="a.xhtml"/></navPoint><navPoint><navLabel><text>周纪二</text></navLabel><content src="b.xhtml"/></navPoint></navMap></ncx>',
  "OEBPS/a.xhtml":
    '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>资治通鉴。</p><p>先王慎德。先王慎德。</p><a href="b.xhtml#note">后章注释</a><script>danger()</script><img src="https://tracker.invalid/a.png" alt="外链"/></body></html>',
  "OEBPS/b.xhtml":
    '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="note">后章</h1><p>这是后文。</p></body></html>',
};

test("阅读设置不附加剧情限制；原书、位置、标注和已提交请求重启后保持", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    const imported = await f.session().importReading({
      commandId: randomUUID(),
      projectId: f.projectId,
      relativePath: "test.epub",
      data: zip(epubFiles),
    });
    const artifactId = imported.entityId;
    const section = await f.session().readPlatformReaderSection({
      artifactId,
      revision: 1,
      sectionId: "section-1",
    });
    const location = {
      sourceId: section.sourceId,
      sectionId: section.id,
      start: 0,
      end: 5,
    };
    const preferences = {
      font: "serif",
      fontSize: 24,
      theme: "paper",
    } as const;
    const command = (command: ReaderCommand) =>
      f.session().commandPlatformReader({
        commandId: randomUUID(),
        artifactId,
        revision: 1,
        command,
      });
    await command({
      action: "save-position",
      artifactId,
      artifactRevision: 1,
      location,
      preferences,
      expectedRevision: 0,
    });
    await command({
      action: "mark-add",
      artifactId,
      artifactRevision: 1,
      location,
      kind: "highlight",
      color: "green",
      note: "保留我的批注",
      quote: section.text.slice(0, 5),
    });
    const request = {
      commandId: randomUUID(),
      operation: {
        type: "record-input" as const,
        projectId: f.projectId,
        artifactId,
        artifactRevision: 1,
        selection: "",
        body: "原消息不改",
        targetActantId: "morphz-agent",
        reading: readingPosition(section, location),
      },
    };
    const receipt = await f.session().platformMessage(request);
    const expected = await f.session().readPlatformReaderState({
      artifactId,
      revision: 1,
    });
    const outbox = structuredClone(f.store.runtimeState());
    assert.equal(
      readingPreferencesSchema.safeParse({ ...preferences, spoilers: false })
        .success,
      false,
    );
    assert.equal(
      readingPreferencesSchema.safeParse({
        ...preferences,
        personalContext: false,
      }).success,
      false,
    );
    await f.reopen();
    assert.deepEqual(
      await f.session().readPlatformReaderState({ artifactId, revision: 1 }),
      expected,
    );
    assert.deepEqual(f.store.runtimeState(), outbox);
    assert.deepEqual(await f.session().platformMessage(request), receipt);
    assert.deepEqual(
      await f.session().readPlatformReaderSection({
        artifactId,
        revision: 1,
        sectionId: "section-1",
      }),
      section,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("草稿升级只移除废弃选项，保留选文、正文、附件、待确认命令和其他身份", () => {
  const prefix = "morphz:center:person:",
    key = prefix + "draft:window:inputs";
  const draft = {
    body: "未发送的原文",
    selection: "先王慎德。",
    revision: 1,
    attachments: [{ assetId: "saved" }],
    reading: {
      book: { title: "原书" },
      chapter: "一",
      location: { start: 0, end: 5 },
      quote: "先王慎德。",
      before: "",
      after: "",
      spoilers: false,
      personalContext: false,
    },
    pendingSupplement: {
      commandId: "do-not-replay",
      reading: { spoilers: false },
    },
  };
  const entries = new Map<string, string>([
    [key, JSON.stringify({ draft })],
    [
      prefix + "draft:window:discarded-conversations",
      JSON.stringify({
        id: { conversation: { id: "saved" }, drafts: { draft } },
      }),
    ],
    ["morphz:center:other:draft:window:inputs", JSON.stringify({ draft })],
  ]);
  const storage = {
    get length() {
      return entries.size;
    },
    key: (i: number) => [...entries.keys()][i] ?? null,
    getItem: (k: string) => entries.get(k) ?? null,
    setItem: (k: string, v: string) => {
      entries.set(k, v);
    },
  };
  migrateReadingLocalState(storage, "center", "person");
  const expected = structuredClone(draft) as any;
  delete expected.reading.spoilers;
  delete expected.reading.personalContext;
  assert.deepEqual(JSON.parse(entries.get(key)!), { draft: expected });
  assert.deepEqual(
    JSON.parse(entries.get(prefix + "draft:window:discarded-conversations")!).id
      .drafts,
    { draft: expected },
  );
  assert.equal(
    entries.get("morphz:center:other:draft:window:inputs"),
    JSON.stringify({ draft }),
  );
  const cleaned = [...entries];
  migrateReadingLocalState(storage, "center", "person");
  assert.deepEqual([...entries], cleaned);
});

test("阅读消息没有额外阅读策略，既有 Context 和前后文读取遵循用户问题", () => {
  for (const tool of workToolDefinitions) {
    assert.doesNotMatch(
      tool.description,
      /no[- ]spoiler|spoiler limits|forbids later|ask before expanding/i,
    );
  }
  for (const format of [readingInputFormat, readingPositionInputFormat]) {
    assert.doesNotMatch(
      JSON.stringify(format),
      /spoilers|personalContext|forbids later|ask before expanding|up to end-start/i,
    );
    assert.match(format.contract, /earlier or later passages/);
    assert.match(format.contract, /existing authorized context and memory/);
    assert.match(format.contract, /untrusted external data/);
  }
  assert.match(
    readingPositionInputFormat.contract,
    /ordinary conversation unrelated to the book.*without reading it/,
  );
  assert.deepEqual(Object.keys(readingPreferencesSchema.parse({})).sort(), [
    "font",
    "fontSize",
    "theme",
  ]);
});

test("阅读能力的 Host 描述不超过 Runtime 的 UTF-8 字节预算", () => {
  for (const tool of workToolDefinitions)
    assert.ok(
      Buffer.byteLength(tool.description) <= 16000,
      `${tool.name} exceeds the real Runtime manifest limit`,
    );
});

for (const selected of [true, false])
  test(`Runtime 未加载阅读格式 v${selected ? 8 : 9} 时保留问题和引用；重试不降级或复制输入`, async () => {
    const requests: unknown[] = [];
    const sessions = new Map<string, unknown>();
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const body = bytes.length ? JSON.parse(bytes.toString()) : null;
      const path = new URL(request.url!, "http://localhost").pathname;
      const send = (status: number, data: unknown) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(data));
      };
      if (path === "/api/status") return send(200, { model: "fixture" });
      if (path === "/api/session-io/capabilities")
        return send(200, { enabled: true, client_metadata: true, formats: [] });
      if (path === "/api/sessions" && request.method === "POST") {
        const session = { id: body.id, context_id: body.mount.context_id };
        sessions.set(session.id, session);
        return send(201, session);
      }
      if (path.endsWith("/io/messages")) {
        requests.push(body);
        return requests.length === 1
          ? send(422, { error: { code: "unsupported_format" } })
          : send(200, { accepted: true, event_id: "reading-root" });
      }
      if (path.endsWith("/events")) return send(200, { events: [] });
      const session = sessions.get(path.split("/")[3]!);
      if (path.endsWith("/principal"))
        return send(200, {
          principal_id: "fixture-user",
          session_id: (session as { id: string }).id,
          context_id: (session as { context_id: string }).context_id,
        });
      return send(session ? 200 : 404, session ?? {});
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const f = await platformRuntimeHostFixture({
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      token: "test-only",
      namespace: randomUUID(),
    });
    try {
      const book = await f.session().importReading({
        commandId: randomUUID(),
        projectId: f.projectId,
        relativePath: "test.epub",
        data: zip(epubFiles),
      });
      const section = await f.session().readPlatformReaderSection({
        artifactId: book.entityId,
        revision: 1,
        sectionId: "section-1",
      });
      const reading = (selected ? readingReference : readingPosition)(section, {
        sourceId: section.sourceId,
        sectionId: section.id,
        start: 0,
        end: 5,
      });
      const input = await f.session().platformMessage({
        commandId: randomUUID(),
        operation: {
          type: "record-input",
          projectId: f.projectId,
          artifactId: book.entityId,
          artifactRevision: 1,
          selection: "quote" in reading ? reading.quote : "",
          reading,
          body: "只解释这句",
          targetActantId: "morphz-agent",
        },
      });
      await f.enableDispatch();
      const ledger = () =>
        f.store.runtimeState() as {
          deliveries: {
            state: string;
            error: string | null;
            platformSource: { reading: ReadingInput };
          }[];
        };
      await f.runtime.tick();
      const failed = ledger().deliveries[0]!;
      assert.equal(failed.state, "failed");
      assert.match(
        failed.error!,
        new RegExp(`阅读消息格式（v${selected ? 8 : 9}）`),
      );
      assert.match(failed.error!, /重试发送/);
      await f.runtime.retryPlatformInput(input.entityId);
      await f.runtime.tick();
      assert.equal(ledger().deliveries[0]!.state, "running");
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[0], requests[1]);
      assert.equal(ledger().deliveries.length, 1);
      assert.deepEqual(ledger().deliveries[0]!.platformSource.reading, reading);
      f.assertNoLegacyData();
    } finally {
      await f.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

test("EPUB Worker 实际导入：目录、原文段落、内部链接、外部内容隔离", async () => {
  const book = await parsePublication("古书.epub", zip(epubFiles));
  assert.equal(book.title, "合成通鉴");
  assert.equal(book.content.author, "测试作者");
  assert.deepEqual(
    book.content.sections.map((s) => s.title),
    ["周纪一", "周纪二"],
  );
  assert.match(book.sections[0]!.text, /资治通鉴。\n先王慎德。/);
  assert.match(book.sections[0]!.html, /#reader:section-2:note/);
  assert.doesNotMatch(book.sections[0]!.html, /script|tracker|danger/);
  assert.equal(
    book.content.sections[0]!.characters,
    book.sections[0]!.text.length,
  );
  assert.ok(
    !JSON.stringify(book.content).includes("先王慎德"),
    "目录刷新不携带原文",
  );
});

test("PDF 文本层空白对齐不通过重复句子搜索猜位置，无法对齐时拒绝引用", () => {
  const text = "甲乙。\n甲乙。\n丙",
    dom = "甲乙。甲乙。丙",
    mapped = readerOffsets(dom, text)!;
  assert.equal(mapped.domToSource[3], 4);
  assert.equal(mapped.domToSource[6], 8);
  assert.equal(readerOffsets("另一页文字", text), null);
});

test("完整 HTML 只显示正文，不把 head 标题、空白或脚本拆成空章节", async () => {
  const book = await parsePublicationRaw(
    "full.html",
    Buffer.from(
      '<!doctype html><html><head><title>这是元数据，不是正文</title><style>body{color:red}</style></head><body>\n<!--前导空白--><script>notBody()</script>\n<h1>第一节</h1><p>实际原文。</p><a href="#two">下一节</a><h2 id="two">第二节</h2><p>后文。</p></body></html>',
    ),
  );
  assert.equal(book.sections.length, 2);
  assert.equal(book.sections[0]!.id, "section-1");
  assert.equal(book.sections[0]!.title, "第一节");
  assert.match(book.sections[0]!.text, /实际原文/);
  assert.match(book.sections[0]!.html, /#reader:section-2:two/);
  assert.doesNotMatch(
    book.sections.map((s) => s.text).join(""),
    /元数据|notBody|color/,
  );
});

test("HTML 内嵌图片与跨章锚点、Markdown 脚注保留；外部资源仍隔离", async () => {
  const book = await parsePublicationRaw(
    "sample.html",
    Buffer.from(
      '<h1>第一章</h1><p><a href="#%E6%B3%A8">去注释</a></p><img src="data:image/png;base64,iVBORw0KGgo=" alt="内嵌"/><h2 id="注">注释</h2><p>说明。</p><img src="https://tracker.invalid/a.png"/><script>danger()</script>',
    ),
  );
  assert.match(book.sections[0]!.html, /#reader:section-2:%E6%B3%A8/);
  assert.match(book.sections[0]!.html, /data:image\/png;base64/);
  assert.match(book.sections[1]!.html, /id="注"/);
  assert.doesNotMatch(
    book.sections.map((s) => s.html).join(""),
    /tracker|danger|script/,
  );
  const markdown = await parsePublicationRaw(
    "notes.md",
    Buffer.from(
      "# 第一章\n\n原文[^note]。\n\n# 第二章\n\n另一章。\n\n[^note]: 注释正文。\n",
    ),
  );
  assert.match(
    markdown.sections[0]!.html,
    /#reader:section-\d+:user-content-fn-note/,
  );
  assert.match(markdown.sections.map((s) => s.text).join(""), /注释正文/);
});

test("阅读沿用 Session 输入及同一 Host：真实 Reader 前后文、私人标注和聊天操作", async () => {
  const f = await agentDomainFixture();
  try {
    const bytes = zip(epubFiles);
    const imported = await f.withHuman((actor) =>
      f.domains.reader.service.import(actor, {
        commandId: randomUUID(),
        projectId: f.projectId,
        name: "test.epub",
        bytes,
      }),
    );
    const id = imported.entityId;
    const section = await f.withHuman((actor) =>
      f.domains.reader.service.read(actor, id, 1, "section-1"),
    );
    const start = section.text.indexOf("先王慎德。");
    const reading = readingReference(section, {
      sourceId: section.sourceId,
      sectionId: section.id,
      start,
      end: start + 5,
    });
    const validate = (reference: ReadingInput, selection: string) =>
      f.withHuman((actor) =>
        f.domains.reader.service.validateInputReference(
          actor,
          id,
          1,
          reference,
          selection,
        ),
      );
    await validate(reading, reading.quote);
    const selectedRoute = f.input(
      f.projectId,
      "解释这句，标注我的理解",
      reading.quote,
      reading,
    );
    // Immutable Session serialization is checked against the actual Reader
    // original; only accepted Runtime event reads are controlled by the fixture.
    const record = (
      route: typeof selectedRoute,
      reference: ReadingInput,
      body: string,
      selection: string,
    ): RecordedInput => ({
      id: route.thread_id.slice("thread_".length),
      projectId: f.projectId,
      artifactId: id,
      artifactRevision: 1,
      selection,
      reading: reference,
      body,
      author: localAccess,
      targetActantId: "morphz-agent",
      status: "recorded",
      createdAt: new Date().toISOString(),
    });
    const input = record(
      selectedRoute,
      reading,
      "解释这句，标注我的理解",
      reading.quote,
    );
    assert.deepEqual(workInputData(input).reading, reading);
    assert.equal(workInputRequest(input).message.format.version, "8");
    assert.equal(workInputData(input).reading?.book.title, "合成通鉴");
    const position = readingPosition(section, reading.location);
    await validate(position, "");
    const viewportRoute = f.input(
      f.projectId,
      "你好，今天心情不错。",
      "",
      position,
    );
    const viewportRecord = record(
      viewportRoute,
      position,
      "你好，今天心情不错。",
      "",
    );
    assert.equal(viewportRecord.selection, "");
    assert.deepEqual(workInputData(viewportRecord).reading, position);
    assert.equal(workInputRequest(viewportRecord).message.format.version, "9");
    const wire = JSON.stringify(workInputRequest(viewportRecord));
    for (const text of ["quote", "before", "after", "先王慎德"])
      assert.ok(
        !wire.includes(text),
        `position-only wire must not contain ${text}`,
      );
    assert.equal(
      readingInputSchema.safeParse({ ...position, before: "偷带正文" }).success,
      false,
    );
    await assert.rejects(
      validate({ ...position, chapter: "伪造当前页" }, ""),
      /阅读位置与原件版本不匹配/,
    );
    await assert.rejects(validate(reading, ""), /阅读选文与原件位置不匹配/);
    await assert.rejects(
      validate(reading, "伪造选文"),
      /阅读选文与原件位置不匹配/,
    );
    const definitions = await f.call({
      action: "operations",
      operations: { action: "list", domain: "reader" },
    });
    assert.match(JSON.stringify(definitions), /reader\.mark-add/);
    const catalog = await f.call<{ books: { artifactId: string }[] }>({
      action: "reader",
      reader: { action: "catalog" },
    });
    assert.equal(catalog.books[0]!.artifactId, id);
    type Slice = {
      text: string;
      totalCharacters: number;
      location: { sectionId: string };
    };
    const read = await f.call<Slice>(
      {
        action: "reader",
        reader: {
          action: "read",
          artifactId: id,
          revision: 1,
          sectionId: "section-1",
          offset: 0,
          limit: 8000,
        },
      },
      viewportRoute,
    );
    assert.equal(read.text, section.text);
    assert.equal(read.totalCharacters, section.text.length);
    const later = await f.call<Slice>(
      {
        action: "reader",
        reader: {
          action: "read",
          artifactId: id,
          revision: 1,
          sectionId: "section-2",
        },
      },
      viewportRoute,
    );
    assert.match(later.text, /这是后文/);
    assert.equal(later.location.sectionId, "section-2");
    const continuation = await f.call<Slice>(
      {
        action: "reader",
        reader: {
          action: "read",
          artifactId: id,
          revision: 1,
          sectionId: "section-1",
          offset: reading.location.end,
          limit: 3,
        },
      },
      viewportRoute,
    );
    assert.equal(
      continuation.text,
      section.text.slice(reading.location.end, reading.location.end + 3),
    );
    const resolved = await f.call<{ input: { reading: ReadingInput } }>(
      { action: "read-input" },
      viewportRoute,
    );
    assert.deepEqual(resolved.input.reading, position);
    // Generic Objects reads cannot take ownership of a Reader original.
    await assert.rejects(
      f.call({ action: "read", artifactId: id, revision: 1 }),
      /内容不属于当前内容应用范围/,
    );
    const contents = await f.call<{
      sections: { id: string }[];
      text?: string;
    }>({
      action: "reader",
      reader: { action: "contents", artifactId: id, revision: 1 },
    });
    assert.equal(contents.text, undefined);
    assert.equal(contents.sections.length, 2);
    const args = {
      action: "reader",
      reader: {
        action: "mark-add",
        artifactId: id,
        artifactRevision: 1,
        location: reading.location,
        quote: reading.quote,
        kind: "note",
        note: "这是用户的理解",
      },
    };
    const command = f.envelope(args, selectedRoute);
    const saved = (await f.tools.call(command)) as {
      receipt: { entityId: string };
      revision: number;
    };
    assert.deepEqual(await f.tools.call(command), saved);
    const marks = await f.call<{
      marks: { id: string }[];
    }>(
      {
        action: "reader",
        reader: { action: "marks", artifactId: id },
      },
      selectedRoute,
    );
    assert.equal(marks.marks.length, 1);
    const readerDb = new DatabaseSync(join(f.directory, "reader.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        readerDb
          .prepare("SELECT principal_id FROM reading_marks WHERE mark_id=?")
          .get(saved.receipt.entityId)?.principal_id,
        localAccess.principalId,
      );
    } finally {
      readerDb.close();
    }
    assert.equal(marks.marks[0]!.id, saved.receipt.entityId);
    assert.throws(
      () =>
        f.tools.call(
          f.envelope(
            {
              action: "reader",
              reader: { ...args.reader, ownerPrincipalId: "other" },
            },
            selectedRoute,
          ),
        ),
      /Unrecognized/,
    );
    await f.reopen();
    assert.deepEqual(await f.tools.call(command), saved);
    await f.call(
      {
        action: "reader",
        reader: {
          action: "mark-remove",
          artifactId: id,
          artifactRevision: 1,
          markId: saved.receipt.entityId,
          expectedRevision: 1,
        },
      },
      selectedRoute,
    );
    assert.equal(
      (
        await f.call<typeof marks>(
          {
            action: "reader",
            reader: { action: "marks", artifactId: id },
          },
          selectedRoute,
        )
      ).marks.length,
      0,
    );
    assert.equal(
      (
        await f.call<typeof marks>(
          {
            action: "reader",
            reader: { action: "marks", artifactId: id, deleted: true },
          },
          selectedRoute,
        )
      ).marks.length,
      1,
    );
    f.forgetInput(selectedRoute);
    await assert.rejects(Promise.resolve().then(() => f.tools.call(command)));
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("Markdown、TXT、DOCX 可读；宏、脚本、原始 HTML 和远程资源不会执行", async () => {
  for (const [name, body] of [
    ["test.md", "# 一\n\n关键 **文字**。\n\n## 二\n\n后文"],
    ["test.txt", "第一段\n\n第二段"],
  ]) {
    const result = await parsePublication(name!, Buffer.from(body!));
    assert.ok(
      result.sections[0]!.text.includes(
        name!.endsWith("txt") ? "第一段" : "关键 文字",
      ),
    );
  }
  const docx = zip({
    "[Content_Types].xml":
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml":
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第一段中文</w:t></w:r></w:p><w:p><w:r><w:t>第二段中文</w:t></w:r></w:p></w:body></w:document>',
  });
  const word = await parsePublication("word.docx", docx);
  assert.match(word.sections[0]!.text, /第一段中文\n第二段中文/);
  const safe = safeReadingSection(
    "a",
    "正文",
    '<p onclick="evil()">甲</p><iframe src="file:///secret">秘密</iframe><a href="javascript:evil()">乙</a><img src="https://example.com/a"><style>body{display:none}</style>',
  );
  assert.doesNotMatch(
    safe.html,
    /onclick|file:|javascript:|https:|iframe|display|秘密/,
  );
  await assert.rejects(
    parsePublication("test.doc", Buffer.from("legacy")),
    /格式不符|另存为/,
  );
});

test(
  "macOS 旧版 DOC / RTF 在有界 Worker 内只转换文字，不改写原文件",
  { skip: process.platform !== "darwin" },
  async () => {
    const text = "合成 Word 验收：兼听则明。\n\n第二段保留。";
    for (const extension of ["doc", "rtf"] as const) {
      const bytes = execFileSync(
        "/usr/bin/textutil",
        [
          "-stdin",
          "-stdout",
          "-format",
          "txt",
          "-inputencoding",
          "UTF-8",
          "-convert",
          extension,
        ],
        { input: text, timeout: 10000 },
      );
      const original = Buffer.from(bytes);
      const result = await parsePublication(`test.${extension}`, bytes);
      assert.equal(result.content.format, extension);
      assert.match(
        result.sections.map((s) => s.text).join("\n"),
        /合成 Word 验收：兼听则明。/,
      );
      assert.match(result.sections.map((s) => s.text).join("\n"), /第二段保留/);
      assert.deepEqual(bytes, original);
    }
  },
);

test("损坏 EPUB、路径穿越、XML 实体、正文加密及超限不会进入存储", async () => {
  await assert.rejects(
    parsePublication("bad.epub", Buffer.from("bad")),
    /安全解析/,
  );
  await assert.rejects(
    parsePublicationRaw(
      "bad.epub",
      zip({ ...epubFiles, "../escaped": "secret" }),
    ),
    /invalid relative path/,
  );
  await assert.rejects(
    parsePublication(
      "bad.epub",
      zip({
        ...epubFiles,
        "OEBPS/a.xhtml":
          '<!DOCTYPE html [<!ENTITY secret SYSTEM "file:///private">]><html><body>&secret;</body></html>',
      }),
    ),
    /不安全的 XML/,
  );
  await assert.rejects(
    parsePublication(
      "bad.epub",
      zip({
        ...epubFiles,
        "META-INF/encryption.xml":
          '<encryption><CipherReference URI="OEBPS/a.xhtml"/></encryption>',
      }),
    ),
    /已加密/,
  );
  await assert.rejects(
    parsePublication("bad.txt", Buffer.alloc(32 * 1024 * 1024 + 1)),
    /32 MB/,
  );
});

test("读物、进度和私人标注持久化；重复选文精确定位，不能伪造引用或改写原书", async () => {
  const other = { principalId: "reader-other", actantId: "reader-other-human" };
  const f = await agentDomainFixture({ additionalHumans: [other] });
  try {
    await f.domains.content.platform.reconcileOperatorMembers(
      f.transport.identity(),
      [localAccess, other].map((access) => ({
        ...access,
        projectIds: [f.projectId],
        enabled: true,
      })),
    );
    const artifactId = (
      await f.withHuman((actor) =>
        f.domains.reader.service.import(actor, {
          commandId: randomUUID(),
          projectId: f.projectId,
          name: "sample.epub",
          bytes: zip(epubFiles),
        }),
      )
    ).entityId;
    const section = await f.withHuman((actor) =>
      f.domains.reader.service.read(actor, artifactId, 1, "section-1"),
    );
    const start = section.text.lastIndexOf("先王慎德。");
    const location = {
      sourceId: section.sourceId,
      sectionId: section.id,
      start,
      end: start + 5,
    };
    const preferences = readingPreferencesSchema.parse({});
    const reading = readingReference(section, location);
    assert.equal(
      reading.after,
      section.text.slice(location.end, location.end + 300),
    );
    assert.equal(reading.quote, "先王慎德。");
    const command = (command: ReaderCommand, commandId = randomUUID()) =>
      f.withHuman((actor) =>
        f.domains.reader.service.command(actor, {
          commandId,
          contentId: artifactId,
          revision: 1,
          command,
        }),
      );
    const mark: ReaderCommand = {
      action: "mark-add",
      artifactId,
      artifactRevision: 1,
      location,
      quote: reading.quote,
      kind: "note",
      color: "yellow",
      note: "用户自己的理解",
    };
    const commandId = randomUUID();
    const marked = await command(mark, commandId);
    assert.deepEqual(await command(mark, commandId), marked);
    assert.equal((await command(mark)).id, marked.id);
    assert.ok(marked.id, "真实 Reader 必须返回持久标注 ID");
    await assert.rejects(
      command({ ...mark, quote: "伪造原文" }),
      /标注选文与原文不符/,
    );
    await command({
      action: "save-position",
      artifactId,
      artifactRevision: 1,
      location,
      preferences,
      expectedRevision: 0,
    });
    await assert.rejects(
      command({
        action: "save-position",
        artifactId,
        artifactRevision: 1,
        location,
        preferences,
        expectedRevision: 0,
      }),
      /阅读进度已被其他操作更新/,
    );
    await f.withHuman((actor) =>
      f.domains.reader.service.validateInputReference(
        actor,
        artifactId,
        1,
        reading,
        reading.quote,
      ),
    );
    await assert.rejects(
      f.withHuman((actor) =>
        f.domains.reader.service.validateInputReference(
          actor,
          artifactId,
          1,
          { ...reading, before: "伪造背景" },
          reading.quote,
        ),
      ),
      /阅读选文前文已变化/,
    );
    await assert.rejects(
      f.withHuman((actor) =>
        f.domains.content.objects.reviseDocument({
          credential: actor.credential,
          commandId: randomUUID(),
          objectId: artifactId,
          expectedRevision: 1,
          title: "改写",
          markdown: "伪造",
        }),
      ),
    );
    const withOther = <T>(
      work: Parameters<typeof f.domains.work.authority.withSession<T>>[2],
    ) => f.domains.work.authority.withSession(other, () => {}, work);
    // Shared-project permission allows reading the book, not another person's marks.
    assert.deepEqual(
      await withOther((actor) =>
        f.domains.reader.service.read(actor, artifactId, 1, "section-1"),
      ),
      section,
    );
    const otherState = await withOther((actor) =>
      f.domains.reader.service.state(actor, artifactId, 1),
    );
    assert.equal(otherState.position, null);
    assert.deepEqual(
      (
        await withOther((actor) =>
          f.domains.reader.service.marks(actor, artifactId, 1, false, 0, 50),
        )
      ).marks,
      [],
    );
    await assert.rejects(
      withOther((actor) =>
        f.domains.reader.service.command(actor, {
          commandId: randomUUID(),
          contentId: artifactId,
          revision: 1,
          command: {
            action: "mark-remove",
            markId: marked.id,
            expectedRevision: 1,
          },
        }),
      ),
      { code: "not_found" },
    );
    await command({
      action: "mark-remove",
      markId: marked.id,
      expectedRevision: 1,
    });
    await command({
      action: "mark-restore",
      markId: marked.id,
      expectedRevision: 2,
    });
    await f.reopen();
    const state = await f.withHuman((actor) =>
      f.domains.reader.service.state(actor, artifactId, 1),
    );
    const marks = await f.withHuman((actor) =>
      f.domains.reader.service.marks(actor, artifactId, 1, false, 0, 50),
    );
    assert.equal(marks.marks[0]!.location.start, start);
    assert.equal(marks.marks[0]!.deletedAt, null);
    assert.deepEqual(state.position!.preferences, preferences);
    assert.deepEqual(
      await f.withHuman((actor) =>
        f.domains.reader.service.read(actor, artifactId, 1, "section-1"),
      ),
      section,
    );
    const reopenedOther = await withOther((actor) =>
      f.domains.reader.service.state(actor, artifactId, 1),
    );
    assert.deepEqual(
      (
        await withOther((actor) =>
          f.domains.reader.service.marks(actor, artifactId, 1, false, 0, 50),
        )
      ).marks,
      [],
    );
    assert.equal(reopenedOther.position, null);
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});
