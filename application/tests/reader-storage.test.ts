import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import type { ReadingOcr } from "../packages/core/src/reader-ocr.js";
import {
  ReaderStore,
  type ReaderAuthorityVerifier,
  type ReaderSourceImport,
} from "../packages/reader/src/store.js";
import { readerSchemaSql } from "../packages/reader/src/schema.js";

const at = "2026-09-25T00:00:00.000Z";
const text = "你好世界，继续阅读。";
const loc = "same-text-locator";
function verifier() {
  let revoked = false;
  const authority: ReaderAuthorityVerifier = {
    async resolveActor({ credential }) {
      const [tenantId, principalId, ...remainder] = credential.split(":");
      return remainder.length || !tenantId || !principalId
        ? null
        : { tenantId, principalId, kind: "human", inputId: null };
    },
    async verifyOriginal(original) {
      if (original.tenantId !== "tenant-a")
        throw new Error("原件不属于该租户。");
    },
    async verifyBookBytes({ bytes }) {
      if (bytes.sha256 !== "a".repeat(64))
        throw new Error("原件字节未获核验。");
    },
    async verifyBookCreate(commit) {
      if (
        commit.credential !== "tenant-a:alice" ||
        commit.tenantId !== "tenant-a" ||
        commit.principalId !== "alice" ||
        commit.projectId !== "project-one"
      )
        throw new Error("书籍创建未获授权。");
    },
    async verifyAccess({ credential, original, principalId }) {
      if (
        revoked ||
        credential !== `${original.tenantId}:${principalId}` ||
        original.tenantId !== "tenant-a" ||
        principalId !== "alice"
      )
        throw new Error("无权读取该原件。");
    },
  };
  return {
    authority,
    revoke: () => {
      revoked = true;
    },
  };
}
const external = (id: string, objectId: string): ReaderSourceImport => ({
  tenantId: "tenant-a",
  readingSourceId: id,
  original: {
    tenantId: "tenant-a",
    appId: "morphz.objects",
    instanceId: "objects-a",
    objectId,
    versionRef: "1",
  },
  sourceLocatorId: loc,
  title: objectId,
  author: "",
  edition: "",
  format: "markdown",
  language: "zh",
  createdAt: at,
  sections: [
    { id: "section-1", title: "第一节", text, html: `<p>${text}</p>` },
  ],
});
const book = (revision: number): ReaderSourceImport => ({
  ...external(`reader-source-${revision}`, "book-one"),
  original: {
    tenantId: "tenant-a",
    appId: "morphz.reader",
    instanceId: "reader-a",
    objectId: "book-one",
    versionRef: String(revision),
  },
  sourceLocatorId: "a".repeat(64),
  format: "epub",
  title: "原书",
  author: "作者",
  book: {
    bookId: "book-one",
    ownerPrincipalId: "alice",
    revision,
    storageKind: "app_private",
    providerId: "reader-a",
    objectRef: `asset-a-${revision}`,
    sha256: "a".repeat(64),
    byteLength: 3,
    parserVersion: "parser-v1",
  },
  bookCommit: {
    credential: "tenant-a:alice",
    commandId: `book-command-${revision}`,
    projectId: "project-one",
    tenantId: "tenant-a",
    principalId: "alice",
    actantId: "alice-actant",
    runtimeInputId: null,
    runtimeTaskRunEventId: null,
  },
});

test("Reader 生产 schema 与评审 SQL 相同", () => {
  assert.equal(
    readerSchemaSql.trim(),
    readFileSync(
      new URL("../docs/storage-model-v1/reader.sql", import.meta.url),
      "utf8",
    ).trim(),
  );
});

async function exercise(store: ReaderStore, revoke: () => void) {
  await store.importSource(external("source-one", "document-one"));
  await store.importSource(external("source-two", "document-two"));
  assert.equal(
    await store.readPosition({
      credential: "tenant-a:alice",
      tenantId: "tenant-a",
      readingSourceId: "source-one",
      principalId: "alice",
    }),
    null,
  );
  assert.deepEqual(
    await store.readSection({
      credential: "tenant-a:alice",
      tenantId: "tenant-a",
      readingSourceId: "source-one",
      sectionId: "section-1",
      principalId: "alice",
      offset: 0,
      limit: 2,
    }),
    {
      sourceLocatorId: loc,
      title: "第一节",
      text: "你好",
      totalCharacters: text.length,
    },
  );
  const longText = "甲".repeat(4000) + "乙".repeat(4000) + "丙";
  await store.importSource({
    ...external("long-source", "long-document"),
    sections: [{ id: "section-1", title: "长节", text: longText, html: "" }],
  });
  assert.deepEqual(
    await store.readSection({
      credential: "tenant-a:alice",
      tenantId: "tenant-a",
      readingSourceId: "long-source",
      sectionId: "section-1",
      principalId: "alice",
      offset: 3998,
      limit: 5,
    }),
    {
      sourceLocatorId: loc,
      title: "长节",
      text: "甲甲乙乙乙",
      totalCharacters: longText.length,
    },
  );
  await assert.rejects(
    store.readSection({
      credential: "tenant-a:bob",
      tenantId: "tenant-a",
      readingSourceId: "source-one",
      sectionId: "section-1",
      principalId: "bob",
      offset: 0,
      limit: 2,
    }),
    /无权/,
  );
  await assert.rejects(
    store.readSection({
      credential: "tenant-a:alice",
      tenantId: "tenant-a",
      readingSourceId: "source-one",
      sectionId: "section-1",
      principalId: "bob",
      offset: 0,
      limit: 2,
    }),
    /身份与已认证的发起者不符/,
  );
  await assert.rejects(
    store.readSection({
      credential: "tenant-b:alice",
      tenantId: "tenant-b",
      readingSourceId: "source-one",
      sectionId: "section-1",
      principalId: "alice",
      offset: 0,
      limit: 2,
    }),
    /不存在/,
  );

  const add = {
    action: "mark-add" as const,
    readingSourceId: "source-one",
    location: { sourceId: loc, sectionId: "section-1", start: 2, end: 4 },
    quote: "世界",
    kind: "highlight" as const,
    color: "blue" as const,
    note: "",
  };
  const command = {
    credential: "tenant-a:alice",
    tenantId: "tenant-a",
    principalId: "alice",
    commandId: "reader-create-1",
    action: add,
  };
  const created = await store.command(command);
  assert.equal(created.revision, 1);
  assert.deepEqual(await store.command(command), created);
  const [racedA, racedB] = await Promise.all([
    store.command({
      ...command,
      commandId: "reader-concurrent-a",
      action: {
        ...add,
        location: { ...add.location, start: 4, end: 5 },
        quote: "，",
      },
    }),
    store.command({
      ...command,
      commandId: "reader-concurrent-b",
      action: {
        ...add,
        location: { ...add.location, start: 4, end: 5 },
        quote: "，",
      },
    }),
  ]);
  assert.equal(racedA.id, racedB.id);
  await assert.rejects(
    store.command({ ...command, action: { ...add, quote: "错字" } }),
    /不同请求/,
  );
  await assert.rejects(
    store.command({
      ...command,
      commandId: "reader-create-invalid",
      action: {
        ...add,
        location: { ...add.location, sourceId: "another-version" },
      },
    }),
    /定位/,
  );
  await assert.rejects(
    store.command({
      ...command,
      credential: "tenant-a:bob",
      principalId: "bob",
      commandId: "reader-bob",
    }),
    /无权/,
  );
  const changed = await store.command({
    ...command,
    commandId: "reader-update-1",
    action: {
      action: "mark-update",
      markId: created.id,
      expectedRevision: 1,
      note: "重要",
      color: "green",
    },
  });
  assert.equal(changed.revision, 2);
  await assert.rejects(
    store.command({
      ...command,
      commandId: "reader-stale",
      action: {
        action: "mark-update",
        markId: created.id,
        expectedRevision: 1,
        note: "旧窗口",
        color: "green",
      },
    }),
    /更新/,
  );
  const removed = await store.command({
    ...command,
    commandId: "reader-remove-1",
    action: { action: "mark-remove", markId: created.id, expectedRevision: 2 },
  });
  assert.equal(removed.revision, 3);
  assert.equal(
    (
      await store.listMarks({
        credential: "tenant-a:alice",
        tenantId: "tenant-a",
        readingSourceId: "source-one",
        principalId: "alice",
        limit: 50,
      })
    ).marks.some((m) => m.id === created.id),
    false,
  );
  assert.equal(
    (
      await store.listMarks({
        credential: "tenant-a:alice",
        tenantId: "tenant-a",
        readingSourceId: "source-one",
        principalId: "alice",
        deleted: true,
        limit: 50,
      })
    ).marks.some((m) => m.id === created.id),
    true,
  );
  const restored = await store.command({
    ...command,
    commandId: "reader-restore-1",
    action: { action: "mark-restore", markId: created.id, expectedRevision: 3 },
  });
  assert.equal(restored.revision, 4);
  const firstPage = await store.listMarks({
    credential: "tenant-a:alice",
    tenantId: "tenant-a",
    readingSourceId: "source-one",
    principalId: "alice",
    limit: 1,
  });
  const nextPage = await store.listMarks({
    credential: "tenant-a:alice",
    tenantId: "tenant-a",
    readingSourceId: "source-one",
    principalId: "alice",
    limit: 1,
    after: firstPage.nextCursor!,
  });
  assert.equal(firstPage.marks.length, 1);
  assert.equal(nextPage.marks.length, 1);
  assert.notEqual(firstPage.marks[0]!.id, nextPage.marks[0]!.id);
  const position = {
    action: "save-position" as const,
    readingSourceId: "source-one",
    location: { sourceId: loc, sectionId: "section-1", start: 4, end: 4 },
    preferences: {
      fontSize: 22,
      font: "sans" as const,
      theme: "night" as const,
    },
    expectedRevision: 0,
  };
  assert.equal(
    (
      await store.command({
        ...command,
        commandId: "reader-position-1",
        action: position,
      })
    ).revision,
    1,
  );
  const restoredPosition = await store.readPosition({
    credential: "tenant-a:alice",
    tenantId: "tenant-a",
    readingSourceId: "source-one",
    principalId: "alice",
  });
  assert.deepEqual(
    { ...restoredPosition, updatedAt: null },
    {
      readingSourceId: "source-one",
      location: position.location,
      preferences: position.preferences,
      revision: 1,
      updatedAt: null,
    },
  );
  assert.ok(Number.isFinite(Date.parse(restoredPosition!.updatedAt)));
  assert.equal(
    await store.readPosition({
      credential: "tenant-a:alice",
      tenantId: "tenant-a",
      readingSourceId: "source-two",
      principalId: "alice",
    }),
    null,
  );
  await assert.rejects(
    store.readPosition({
      credential: "tenant-a:bob",
      tenantId: "tenant-a",
      readingSourceId: "source-one",
      principalId: "alice",
    }),
    /身份与已认证的发起者不符/,
  );
  await assert.rejects(
    store.command({
      ...command,
      commandId: "reader-position-stale",
      action: position,
    }),
    /其他操作更新/,
  );

  await assert.rejects(
    store.importSource({
      ...book(1),
      book: { ...book(1).book!, sha256: "b".repeat(64) },
    }),
    /未获核验/,
  );
  await store.importSource(book(1));
  await store.importSource(book(2));
  const ocr: ReadingOcr = {
    image: { width: 100, height: 100 },
    items: [
      {
        poly: [
          [0, 0],
          [20, 0],
          [20, 20],
          [0, 20],
        ],
        text: "识别",
        score: 0.9,
      },
    ],
    engine: "test-ocr",
    layout: "horizontal" as const,
  };
  const ocrSection = `page-1-ocr-${createHash("sha256").update(JSON.stringify(ocr)).digest("hex")}`;
  await store.importSource({
    ...book(3),
    sections: [
      {
        id: "page-1",
        title: "第 1 页",
        text: "原文",
        html: "<pre>原文</pre>",
        pageNumber: 1,
      },
      {
        id: ocrSection,
        title: "第 1 页 · OCR",
        text: "识别",
        html: "<pre>识别</pre>",
        pageNumber: 1,
        ocr,
      },
    ],
  });
  assert.equal(
    (
      await store.readSection({
        credential: "tenant-a:alice",
        tenantId: "tenant-a",
        readingSourceId: "reader-source-3",
        sectionId: ocrSection,
        principalId: "alice",
        offset: 0,
        limit: 10,
      })
    ).text,
    "识别",
  );
  assert.deepEqual(
    await store.listSections({
      credential: "tenant-a:alice",
      tenantId: "tenant-a",
      readingSourceId: "reader-source-3",
      principalId: "alice",
      limit: 10,
    }),
    [{ sectionId: "page-1", title: "第 1 页", characters: 2, ordinal: 0 }],
  );
  assert.deepEqual(
    await store.readOcrVersion({
      credential: "tenant-a:alice",
      tenantId: "tenant-a",
      readingSourceId: "reader-source-3",
      sectionId: ocrSection,
      principalId: "alice",
    }),
    ocr,
  );
  const pdfSource: ReaderSourceImport = {
    ...book(1),
    readingSourceId: "reader-pdf-source",
    original: { ...book(1).original, objectId: "pdf-book" },
    book: { ...book(1).book!, bookId: "pdf-book" },
    bookCommit: { ...book(1).bookCommit!, commandId: "pdf-book-command" },
    format: "pdf",
    sections: [
      {
        id: "page-1",
        title: "第 1 页",
        text: "",
        html: "<pre></pre>",
        pageNumber: 1,
      },
    ],
  };
  await store.importSource(pdfSource);
  const ocrRequest = {
    credential: "tenant-a:alice",
    tenantId: "tenant-a",
    readingSourceId: "reader-pdf-source",
    principalId: "alice",
    page: 1,
  };
  assert.equal(await store.latestOcrVersion(ocrRequest), null);
  const savedOcr = await store.saveOcrVersion({ ...ocrRequest, result: ocr });
  assert.equal(
    await store.saveOcrVersion({ ...ocrRequest, result: ocr }),
    savedOcr,
  );
  assert.equal(await store.latestOcrVersion(ocrRequest), savedOcr);
  assert.deepEqual(
    (await store.readDisplaySection({ ...ocrRequest, sectionId: savedOcr }))
      .ocr,
    ocr,
  );
  assert.equal(
    (await store.readDisplaySection({ ...ocrRequest, sectionId: savedOcr }))
      .text,
    "识别",
  );
  const correction: ReadingOcr = {
    ...ocr,
    parent: savedOcr,
    items: [{ ...ocr.items[0]!, correction: "改正" }],
  };
  const corrected = await store.saveOcrVersion({
    ...ocrRequest,
    result: correction,
  });
  assert.notEqual(corrected, savedOcr);
  assert.equal(await store.latestOcrVersion(ocrRequest), corrected);
  assert.equal(
    (await store.readDisplaySection({ ...ocrRequest, sectionId: corrected }))
      .text,
    "改正",
  );
  assert.equal(
    (await store.readDisplaySection({ ...ocrRequest, sectionId: savedOcr }))
      .text,
    "识别",
  );
  await store.verifyImportedSource(pdfSource);
  await assert.rejects(
    store.saveOcrVersion({
      ...ocrRequest,
      page: 2,
      result: ocr,
    }),
    /请选择存在的 PDF 页面/,
  );
  await assert.rejects(
    store.saveOcrVersion({
      ...ocrRequest,
      result: { ...ocr, parent: `page-1-ocr-${"0".repeat(64)}` },
    }),
    /来源版本已失效/,
  );
  await assert.rejects(store.importSource(book(2)), /已存在/);
  await assert.rejects(
    store.importSource({
      ...external("source-bad", "document-bad"),
      sections: [
        {
          id: "section-1",
          title: "错误",
          text: "x".repeat(1_000_001),
          html: "",
        },
      ],
    }),
    /超出/,
  );
  revoke();
  await assert.rejects(store.command(command), /无权/);
}

test("Reader SQLite：外部原件不复制、标注/进度精确往返与权限隔离", async () => {
  const { authority, revoke } = verifier();
  const store = await ReaderStore.sqlite(":memory:", authority);
  try {
    await exercise(store, revoke);
  } finally {
    await store.close();
  }
});

test("Reader SQLite：重开后恢复同一原件的个人进度与命令回执", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-reader-reopen-"));
  const filename = join(directory, "reader.sqlite");
  const { authority } = verifier();
  const request = {
    credential: "tenant-a:alice",
    tenantId: "tenant-a",
    principalId: "alice",
    commandId: "reader-resume-1",
    action: {
      action: "save-position" as const,
      readingSourceId: "source-one",
      location: { sourceId: loc, sectionId: "section-1", start: 4, end: 4 },
      preferences: {
        fontSize: 20,
        font: "serif" as const,
        theme: "paper" as const,
      },
      expectedRevision: 0,
    },
  };
  try {
    const first = await ReaderStore.sqlite(filename, authority);
    let receipt;
    try {
      await first.importSource(external("source-one", "document-one"));
      await first.importSource(external("source-two", "document-two"));
      receipt = await first.command(request);
    } finally {
      await first.close();
    }
    const reopened = await ReaderStore.sqlite(filename, authority);
    try {
      assert.deepEqual(await reopened.command(request), receipt);
      const position = await reopened.readPosition({
        credential: request.credential,
        tenantId: request.tenantId,
        readingSourceId: "source-one",
        principalId: request.principalId,
      });
      assert.deepEqual(position?.location, request.action.location);
      assert.deepEqual(position?.preferences, request.action.preferences);
      assert.equal(position?.revision, 1);
      assert.equal(
        await reopened.readPosition({
          credential: request.credential,
          tenantId: request.tenantId,
          readingSourceId: "source-two",
          principalId: request.principalId,
        }),
        null,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("Reader：外部授权等待不占据 SQLite 写锁", async () => {
  let entered!: () => void;
  let release!: () => void;
  const checking = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const base = verifier().authority;
  const authority: ReaderAuthorityVerifier = {
    ...base,
    async verifyAccess(request) {
      await base.verifyAccess(request);
      if (request.original.objectId === "slow-document") {
        entered();
        await wait;
      }
    },
  };
  const store = await ReaderStore.sqlite(":memory:", authority);
  let pending: Promise<unknown> | undefined;
  try {
    await store.importSource(external("slow-source", "slow-document"));
    await store.importSource(external("fast-source", "fast-document"));
    pending = store.readSection({
      credential: "tenant-a:alice",
      tenantId: "tenant-a",
      readingSourceId: "slow-source",
      sectionId: "section-1",
      principalId: "alice",
      offset: 0,
      limit: 2,
    });
    await checking;
    const fastWrite = store.command({
      credential: "tenant-a:alice",
      tenantId: "tenant-a",
      principalId: "alice",
      commandId: "fast-command",
      action: {
        action: "mark-add",
        readingSourceId: "fast-source",
        location: { sourceId: loc, sectionId: "section-1", start: 0, end: 2 },
        quote: "你好",
        kind: "highlight",
        color: "blue",
        note: "",
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      fastWrite,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("授权检查占用了数据库写锁。")),
          1000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(result.revision, 1);
  } finally {
    release();
    await pending;
    await store.close();
  }
});

test(
  "Reader PostgreSQL：与 SQLite 相同的阅读域归属、回滚与权限语义",
  {
    skip: !process.env.MORPHZ_TEST_POSTGRES_URL,
  },
  async () => {
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({
      connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
    });
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      const { authority, revoke } = verifier();
      const store = await ReaderStore.postgres(
        { connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!, schema },
        authority,
      );
      try {
        await exercise(store, revoke);
      } finally {
        await store.close();
      }
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
      await pool.end();
    }
  },
);
