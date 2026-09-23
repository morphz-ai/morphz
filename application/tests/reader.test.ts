import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { crc32 } from "node:zlib";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parsePublication,
  parsePublicationRaw,
  safeReadingSection,
} from "../packages/application/src/reader-import.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import {
  localAccess,
  applyCommand,
  type Operation,
} from "../packages/core/src/model.js";
import { workspaceFor } from "../packages/application/src/identity.js";
import {
  readingReference,
  readingPreferencesSchema,
  type ReaderCommand,
} from "../packages/core/src/reader.js";
import {
  AgentTools,
  workToolDefinitions,
} from "../packages/application/src/agent-tools.js";
import {
  workInputData,
  workInputRequest,
} from "../packages/application/src/session-io.js";
import { readerOffsets } from "../apps/web/src/reader-dom.js";

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

test("阅读能力的 Host 描述不超过 Runtime 的 UTF-8 字节预算", () => {
  for (const tool of workToolDefinitions)
    assert.ok(
      Buffer.byteLength(tool.description) <= 16000,
      `${tool.name} exceeds the real Runtime manifest limit`,
    );
});

test("Runtime 未加载阅读格式时保留问题和引用；加载后重试同一请求，不降级或复制输入", async () => {
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
      return send(200, { enabled: true, formats: [] });
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const store = new WorkspaceStore(":memory:");
  const bridge = new RuntimeBridge(store, {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    token: "test-only",
    namespace: randomUUID(),
  });
  try {
    const bytes = zip(epubFiles),
      parsed = await parsePublication("test.epub", bytes),
      content = store.addPublication(bytes, parsed, localAccess);
    const book = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "import-publication",
          projectId: "first-project",
          relativePath: "test.epub",
          title: parsed.title,
          content,
        },
      },
      localAccess,
    );
    const section = store.readerSection(
      book.entityId,
      1,
      "section-1",
      localAccess,
    );
    const reading = readingReference(
      section,
      {
        sourceId: content.assetId,
        sectionId: section.id,
        start: 0,
        end: 5,
      },
      { personalContext: true, spoilers: false },
    );
    const input = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "record-input",
          projectId: "first-project",
          artifactId: book.entityId,
          artifactRevision: 1,
          selection: reading.quote,
          reading,
          body: "只解释这句",
          targetActantId: "morphz-agent",
        },
      },
      localAccess,
    );
    bridge.enqueue(input.entityId);
    await bridge.tick();
    const failed = bridge.snapshot().deliveries[0]!;
    assert.equal(failed.state, "failed");
    assert.match(failed.error!, /阅读消息格式（v6）/);
    assert.match(failed.error!, /重试发送/);
    bridge.enqueue(input.entityId);
    await bridge.tick();
    assert.equal(bridge.snapshot().deliveries[0]!.state, "running");
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], requests[1]);
    assert.equal(store.snapshot().inputs.length, 1);
    assert.deepEqual(store.snapshot().inputs[0]!.reading, reading);
  } finally {
    await bridge.stop();
    store.close();
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

test("阅读沿用 Session 输入及同一 Host：有界读取、防剧透、私人标注与聊天可发现操作", async () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const bytes = zip(epubFiles),
      parsed = await parsePublication("test.epub", bytes),
      content = store.addPublication(bytes, parsed, localAccess);
    const id = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "import-publication",
          projectId: "first-project",
          relativePath: "test.epub",
          title: parsed.title,
          content,
        },
      },
      localAccess,
    ).entityId;
    const section = store.readerSection(id, 1, "section-1", localAccess),
      start = section.text.indexOf("先王慎德。");
    const reading = readingReference(
      section,
      {
        sourceId: content.assetId,
        sectionId: section.id,
        start,
        end: start + 5,
      },
      { personalContext: false, spoilers: false },
    );
    const inputId = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "record-input",
          projectId: "first-project",
          artifactId: id,
          artifactRevision: 1,
          selection: reading.quote,
          reading,
          body: "解释这句，标注我的理解",
          targetActantId: "morphz-agent",
        },
      },
      localAccess,
    ).entityId;
    const input = store.snapshot().inputs.find((i) => i.id === inputId)!;
    assert.deepEqual(workInputData(input).reading, reading);
    assert.equal(workInputRequest(input).message.format.version, "6");
    assert.equal(workInputData(input).reading?.book.title, "合成通鉴");
    const scope = {
      projectId: "first-project",
      inputId,
      access: { principalId: "morphz-service", actantId: "morphz-agent" },
    };
    const tools = new AgentTools(store, "token", () => scope);
    const call = (args: unknown, callId: string = randomUUID()) =>
      tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation: {
          job_id: "reader-job",
          tool_call_id: callId,
          session_id: "s",
          context_id: "c",
          principal_id: "forged",
          agent_id: "a",
          target_id: "local",
          thread_id: "t",
        },
        arguments: args,
      }) as any;
    const definitions = call({
      action: "operations",
      operations: { action: "list", domain: "reader" },
    });
    assert.match(JSON.stringify(definitions), /reader\.mark-add/);
    assert.equal(
      call({ action: "reader", reader: { action: "catalog" } }).books[0]
        .artifactId,
      id,
    );
    const read = call({
      action: "reader",
      reader: {
        action: "read",
        artifactId: id,
        revision: 1,
        sectionId: "section-1",
        offset: 0,
        limit: 8000,
      },
    });
    assert.equal(read.text, section.text.slice(0, reading.location.end));
    assert.equal(read.spoilerBoundary, true);
    assert.throws(
      () =>
        call({
          action: "reader",
          reader: {
            action: "read",
            artifactId: id,
            revision: 1,
            sectionId: "section-2",
          },
        }),
      /不允许读取后文/,
    );
    const generic = call({ action: "read", artifactId: id, revision: 1 });
    assert.equal(generic.text, undefined);
    assert.ok(generic.sections);
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
    const saved = call(args, "stable-mark");
    assert.equal(saved.mark.ownerPrincipalId, localAccess.principalId);
    assert.deepEqual(call(args, "stable-mark"), saved);
    assert.throws(
      () =>
        call({
          action: "reader",
          reader: { ...args.reader, ownerPrincipalId: "other" },
        }),
      /Unrecognized/,
    );
    assert.equal(
      call({ action: "reader", reader: { action: "marks", artifactId: id } })
        .total,
      1,
    );
    scope.inputId = "missing";
    assert.throws(() => call(args, "stable-mark"), /实际输入/);
  } finally {
    store.close();
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
  const dir = mkdtempSync(join(tmpdir(), "morphz-reader-test-")),
    file = join(dir, "workspace.sqlite");
  let store = new WorkspaceStore(file);
  try {
    const bytes = zip(epubFiles),
      parsed = await parsePublication("sample.epub", bytes);
    const content = store.addPublication(bytes, parsed, localAccess);
    const exec = (operation: Operation) =>
      store.execute({ commandId: randomUUID(), operation }, localAccess);
    const artifactId = exec({
      type: "import-publication",
      projectId: "first-project",
      title: parsed.title,
      relativePath: "sample.epub",
      content,
    }).entityId;
    const section = store.readerSection(
      artifactId,
      1,
      "section-1",
      localAccess,
    );
    const start = section.text.lastIndexOf("先王慎德。");
    const location = {
      sourceId: content.assetId,
      sectionId: section.id,
      start,
      end: start + 5,
    };
    const preferences = readingPreferencesSchema.parse({});
    const reading = readingReference(section, location, preferences);
    assert.equal(reading.after, "");
    assert.equal(reading.quote, "先王慎德。");
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
    const marked = exec({ type: "reader-command", command: mark });
    assert.equal(
      exec({ type: "reader-command", command: mark }).entityId,
      marked.entityId,
    );
    assert.throws(
      () =>
        exec({
          type: "reader-command",
          command: { ...mark, quote: "伪造原文" },
        }),
      /不匹配/,
    );
    exec({
      type: "reader-command",
      command: {
        action: "save-position",
        artifactId,
        artifactRevision: 1,
        location,
        preferences,
        expectedRevision: 0,
      },
    });
    assert.throws(
      () =>
        exec({
          type: "reader-command",
          command: {
            action: "save-position",
            artifactId,
            artifactRevision: 1,
            location,
            preferences,
            expectedRevision: 0,
          },
        }),
      /另一个窗口/,
    );
    const request = {
      type: "record-input" as const,
      projectId: "first-project",
      artifactId,
      artifactRevision: 1,
      selection: reading.quote,
      body: "只解释原文",
      targetActantId: "morphz-agent",
      reading,
    };
    exec(request);
    assert.throws(
      () => exec({ ...request, reading: { ...reading, before: "伪造背景" } }),
      /不匹配/,
    );
    assert.throws(
      () =>
        exec({
          type: "revise-artifact",
          artifactId,
          expectedRevision: 1,
          title: "改写",
          content: { kind: "document", markdown: "伪造" },
        }),
      /原文/,
    );
    const other = {
      principalId: "reader-other",
      actantId: "reader-other-human",
    };
    const state = store.snapshot();
    state.principals.push({ id: other.principalId, name: "其他人" });
    state.actants.push({
      id: other.actantId,
      principalId: other.principalId,
      kind: "human",
      name: "其他人",
    });
    state.projects[0]!.members.push(other.principalId);
    assert.equal(workspaceFor(state, other).readingMarks.length, 0);
    assert.equal(workspaceFor(state, other).readingStates.length, 0);
    assert.throws(
      () =>
        applyCommand(
          state,
          {
            commandId: randomUUID(),
            operation: {
              type: "reader-command",
              command: {
                action: "mark-remove",
                markId: marked.entityId,
                expectedRevision: 1,
              },
            },
          },
          other,
        ),
      /不属于当前身份/,
    );
    exec({
      type: "reader-command",
      command: {
        action: "mark-remove",
        markId: marked.entityId,
        expectedRevision: 1,
      },
    });
    exec({
      type: "reader-command",
      command: {
        action: "mark-restore",
        markId: marked.entityId,
        expectedRevision: 2,
      },
    });
    store.close();
    store = new WorkspaceStore(file);
    assert.equal(store.snapshot().readingMarks[0]!.location.start, start);
    assert.equal(store.snapshot().readingMarks[0]!.deletedAt, null);
    assert.deepEqual(
      store.snapshot().readingStates[0]!.preferences,
      preferences,
    );
    assert.deepEqual(store.snapshot().inputs.at(-1)!.reading, reading);
    assert.deepEqual(
      store.readerSection(artifactId, 1, "section-1", localAccess),
      section,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
