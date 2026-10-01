import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import {
  ObjectsStore,
  type ObjectsAuthority,
} from "../packages/objects/src/store.js";
import { objectsSchemaSql } from "../packages/objects/src/schema.js";
import { schemaHash, sqliteQuery } from "../packages/storage/src/sql.js";
import { seedExistingPdf } from "./objects-existing-pdf-fixture.js";

const objectsSchemaV3Sql = objectsSchemaSql.slice(
  0,
  objectsSchemaSql.indexOf("\n-- Search is an Objects-owned"),
);
const at = "2026-09-25T00:00:00.000Z";
const author = { principalId: "alice", actantId: "agent-one" };

test("Objects 生产 schema 与评审 SQL 相同", () => {
  assert.equal(
    objectsSchemaSql.trim(),
    readFileSync(
      new URL("../docs/storage-model-v1/objects.sql", import.meta.url),
      "utf8",
    ).trim(),
  );
});

test("导入文档的来源随 Objects 原件持久化，重开私库仍可精确读取", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-objects-import-"));
  const filename = join(directory, "objects.sqlite");
  const actor = {
    tenantId: "tenant-a",
    principalId: "alice",
    actantId: "agent-one",
    kind: "human" as const,
    runtimeInputId: null,
  };
  const authority: ObjectsAuthority = {
    authorizeCreate: async () => ({ ...actor, projectId: "project-one" }),
    authorizeDocumentRevision: async () => {
      throw new Error("未测试修订权限。");
    },
    authorizeObjectRead: async () => ({
      ...actor,
      projectId: "project-one",
      contentId: "content-one",
      objectKind: "document",
      observedVersionRef: "1",
      catalogRevision: 1,
    }),
    authorizeByteRead: async () => {
      throw new Error("未测试字节权限。");
    },
  };
  let store = await ObjectsStore.sqlite(filename, authority);
  try {
    await store.createDocument({
      credential: "authorized-test",
      commandId: "import-command",
      objectId: "imported-document",
      requestedProjectId: "project-one",
      title: "第二章",
      markdown: "原文内容",
      relativePath: "史料/第二章.md",
    });
    await store.close();
    store = await ObjectsStore.sqlite(filename, authority);
    const opened = await store.readObject({
      credential: "authorized-test",
      objectId: "imported-document",
      revision: 1,
    });
    assert.deepEqual(opened.content, {
      kind: "document",
      markdown: "原文内容",
    });
    assert.equal(opened.source?.mode, "copy");
    assert.equal(opened.source?.relativePath, "史料/第二章.md");
    assert.equal(opened.source?.importedRevision, 1);
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Objects v1 原子补图片摘要索引，不重写原件或版本", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-objects-index-"));
  const filename = join(directory, "objects.sqlite");
  const indexSql =
    "CREATE INDEX object_version_bytes_by_digest ON object_version_bytes(tenant_id, sha256, store_id, object_id, object_revision);\n";
  const annotationIndex =
    "CREATE INDEX object_annotations_by_object_order ON object_annotations(tenant_id, object_id, collection_ordinal);\n";
  const v1 = objectsSchemaV3Sql
    .replace(indexSql, "")
    .replace(annotationIndex, "");
  assert.notEqual(v1, objectsSchemaSql);
  try {
    const db = new DatabaseSync(filename);
    db.exec(v1);
    db.prepare(
      "INSERT INTO objects_schema_version(version,schema_sha256) VALUES(1,?)",
    ).run(schemaHash(v1));
    db.prepare(
      `INSERT INTO objects(
      tenant_id,object_id,kind,head_revision,created_by_principal_id,
      created_by_actant_id,created_at,updated_at,origin_project_id)
      VALUES('tenant-one','existing-document','document',1,'alice','alice',
      '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','project-one')`,
    ).run();
    db.close();
    const store = await ObjectsStore.sqlite(filename);
    await store.close();
    const checked = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.deepEqual(
        {
          ...checked
            .prepare("SELECT version,schema_sha256 FROM objects_schema_version")
            .get(),
        },
        { version: 5, schema_sha256: schemaHash(objectsSchemaSql) },
      );
      assert.equal(
        (
          checked.prepare("SELECT COUNT(*) AS count FROM objects").get() as {
            count: number;
          }
        ).count,
        1,
      );
      assert.equal(
        (
          checked
            .prepare(
              "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name='object_version_bytes_by_digest'",
            )
            .get() as { count: number }
        ).count,
        1,
      );
      assert.equal(
        (
          checked
            .prepare(
              "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name='object_annotations_by_object_order'",
            )
            .get() as { count: number }
        ).count,
        1,
      );
    } finally {
      checked.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Objects v2 原子补批注列表索引，保留已有批注", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "morphz-objects-annotation-index-"),
  );
  const filename = join(directory, "objects.sqlite");
  const indexSql =
    "CREATE INDEX object_annotations_by_object_order ON object_annotations(tenant_id, object_id, collection_ordinal);\n";
  const v2 = objectsSchemaV3Sql.replace(indexSql, "");
  try {
    const db = new DatabaseSync(filename);
    db.exec(v2);
    db.prepare(
      "INSERT INTO objects_schema_version(version,schema_sha256) VALUES(2,?)",
    ).run(schemaHash(v2));
    db.close();
    const store = await ObjectsStore.sqlite(filename);
    await store.close();
    const checked = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.deepEqual(
        {
          ...checked
            .prepare("SELECT version,schema_sha256 FROM objects_schema_version")
            .get(),
        },
        { version: 5, schema_sha256: schemaHash(objectsSchemaSql) },
      );
      assert.equal(
        (
          checked
            .prepare(
              "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name='object_annotations_by_object_order'",
            )
            .get() as { count: number }
        ).count,
        1,
      );
    } finally {
      checked.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Objects v3 升级时保留原件且不猜测旧对象的创建者类型", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "morphz-objects-search-upgrade-"),
  );
  const filename = join(directory, "objects.sqlite");
  try {
    const db = new DatabaseSync(filename);
    db.exec(objectsSchemaV3Sql);
    db.prepare(
      "INSERT INTO objects_schema_version(version,schema_sha256) VALUES(3,?)",
    ).run(schemaHash(objectsSchemaV3Sql));
    db.prepare(
      "INSERT INTO objects(tenant_id,object_id,kind,head_revision,created_by_principal_id,created_by_actant_id,created_at,updated_at,origin_project_id) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      "tenant-a",
      "older-document",
      "document",
      1,
      "alice",
      "agent-one",
      at,
      at,
      "project-one",
    );
    const body = JSON.stringify({
      kind: "document",
      markdown: "旧正文仍可读取",
    });
    db.prepare(
      "INSERT INTO object_versions(tenant_id,object_id,revision,title,kind,payload_body,payload_sha256,author_principal_id,author_actant_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "tenant-a",
      "older-document",
      1,
      "旧标题",
      "document",
      body,
      createHash("sha256").update(body).digest("hex"),
      "alice",
      "agent-one",
      at,
    );
    db.close();

    const store = await ObjectsStore.sqlite(filename, originalAuthority());
    try {
      assert.deepEqual(
        await store.searchCandidates({ tenantId: "tenant-a", query: "旧正文" }),
        [],
      );
      assert.equal(
        (
          await store.readObject({
            credential: "alice",
            objectId: "older-document",
            revision: 1,
          })
        ).content.kind,
        "document",
      );
    } finally {
      await store.close();
    }
    const checked = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.deepEqual(
        {
          ...checked
            .prepare("SELECT version,schema_sha256 FROM objects_schema_version")
            .get(),
        },
        { version: 5, schema_sha256: schemaHash(objectsSchemaSql) },
      );
    } finally {
      checked.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function searchAuthority(): ObjectsAuthority {
  return {
    authorizeCreate: async ({ credential }) => ({
      tenantId: "tenant-a",
      principalId: "alice",
      actantId: credential === "human" ? "alice" : "agent-one",
      kind: credential === "human" ? "human" : "agent",
      runtimeInputId: credential === "human" ? null : "input-one",
    }),
    authorizeDocumentRevision: async ({ credential }) => ({
      tenantId: "tenant-a",
      principalId: "alice",
      actantId: credential === "human" ? "alice" : "agent-one",
      kind: credential === "human" ? "human" : "agent",
      runtimeInputId: credential === "human" ? null : "input-one",
      projectId: "project-one",
      contentId: "content-one",
      objectKind: "document",
      observedVersionRef: "1",
      catalogRevision: 1,
    }),
    authorizeObjectRead: async () => {
      throw new Error("本专项不读取原件。");
    },
    authorizeByteRead: async () => {
      throw new Error("本专项不读取字节。");
    },
  };
}

async function exerciseSearchProjection(store: ObjectsStore) {
  await store.createDocument({
    credential: "agent",
    commandId: "search-agent-create",
    objectId: "search-agent-document",
    requestedProjectId: "project-one",
    title: "检索笔记",
    markdown: "准确原文含有这段检索内容。",
  });
  await store.createDocument({
    credential: "human",
    commandId: "search-human-create",
    objectId: "search-human-document",
    requestedProjectId: "project-one",
    title: "人工笔记",
    markdown: "准确原文含有这段检索内容。",
  });
  await store.createDocument({
    credential: "agent",
    commandId: "search-import-create",
    objectId: "search-import-document",
    requestedProjectId: "project-one",
    title: "导入笔记",
    markdown: "准确原文含有这段检索内容。",
    relativePath: "导入笔记.md",
  });
  const found = await store.searchCandidates({
    tenantId: "tenant-a",
    query: "准确原文 检索内容",
  });
  assert.deepEqual(
    found.map((row) => row.objectId),
    ["search-agent-document"],
  );
  assert.equal(found[0]?.revision, 1);
  assert.deepEqual(
    await store.searchCandidates({ tenantId: "tenant-b", query: "准确原文" }),
    [],
  );
  await store.reviseDocument({
    credential: "human",
    commandId: "search-human-revision",
    objectId: "search-agent-document",
    expectedRevision: 1,
    title: "检索笔记修订",
    markdown: "更新后的文字讨论事务一致性。",
  });
  assert.deepEqual(
    await store.searchCandidates({ tenantId: "tenant-a", query: "准确原文" }),
    [],
  );
  const updated = await store.searchCandidates({
    tenantId: "tenant-a",
    query: "事务一致性",
  });
  assert.deepEqual(
    updated.map((row) => row.objectId),
    ["search-agent-document"],
  );
  assert.equal(updated[0]?.revision, 2);
  assert.equal(updated[0]?.body, "更新后的文字讨论事务一致性。");
}

test("Objects SQLite 搜索投影只索引 Agent 原创，并随人工修订原子更新", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-objects-search-"));
  const filename = join(directory, "objects.sqlite");
  try {
    let store = await ObjectsStore.sqlite(filename, searchAuthority());
    try {
      await exerciseSearchProjection(store);
    } finally {
      await store.close();
    }
    store = await ObjectsStore.sqlite(filename, searchAuthority());
    try {
      assert.deepEqual(
        (
          await store.searchCandidates({
            tenantId: "tenant-a",
            query: "事务一致性",
          })
        ).map((row) => row.revision),
        [2],
      );
    } finally {
      await store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function originalAuthority(): ObjectsAuthority {
  const actor = {
    tenantId: "tenant-a",
    principalId: "alice",
    actantId: "agent-one",
    kind: "human" as const,
    runtimeInputId: null,
  };
  const authorize = async ({
    credential,
    objectId,
  }: {
    credential: string;
    objectId: string;
  }) => ({
    ...actor,
    tenantId: credential === "other-tenant" ? "tenant-b" : actor.tenantId,
    projectId: "project-one",
    contentId: `content_${objectId}`,
    objectKind: objectId.startsWith("image") ? "image" : "document",
    observedVersionRef: "1",
    catalogRevision: 1,
  });
  return {
    authorizeCreate: async () => actor,
    authorizeDocumentRevision: authorize,
    authorizeObjectRead: authorize,
    authorizeByteRead: authorize,
  };
}

async function exercise(store: ObjectsStore) {
  const create = {
    credential: "alice",
    commandId: "document-create",
    objectId: "document-one",
    requestedProjectId: "project-one",
    title: "第一版",
    markdown: "旧版正文",
  };
  const created = await store.createDocument(create);
  assert.equal(created.versionRef, "1");
  assert.deepEqual(await store.createDocument(create), created);
  await assert.rejects(
    store.createDocument({ ...create, markdown: "同一命令不能改写" }),
    /命令|不同|冲突/,
  );
  await assert.rejects(
    store.createDocument({ ...create, commandId: "same-object-new-command" }),
    /已存在/,
  );
  const revise = {
    credential: "alice",
    commandId: "document-revise",
    objectId: create.objectId,
    expectedRevision: 1,
    title: "第二版",
    markdown: "新版正文",
  };
  const revised = await store.reviseDocument(revise);
  assert.equal(revised.versionRef, "2");
  assert.deepEqual(await store.reviseDocument(revise), revised);
  await assert.rejects(
    store.reviseDocument({ ...revise, commandId: "stale-revision" }),
    /版本|修订|冲突/,
  );
  const annotationRequest = {
    credential: "alice",
    commandId: "annotation-one",
    objectId: create.objectId,
    revision: 1,
    quote: "旧版",
    body: "这个旧版本很重要",
  };
  await assert.rejects(
    store.annotateObject({
      ...annotationRequest,
      commandId: "annotation-bad",
      quote: "未出现的内容",
    }),
    /引文/,
  );
  assert.deepEqual(
    await store.listObjectAnnotations({
      credential: "alice",
      objectId: create.objectId,
    }),
    [],
  );
  const annotation = await store.annotateObject(annotationRequest);
  assert.equal(annotation.artifactRevision, 1);
  assert.equal(annotation.quote, "旧版");
  assert.equal(annotation.body, annotationRequest.body);
  assert.deepEqual(annotation.author, author);
  assert.deepEqual(await store.annotateObject(annotationRequest), annotation);
  assert.deepEqual(
    (
      await store.listObjectAnnotations({
        credential: "alice",
        objectId: create.objectId,
      })
    ).map((row) => row.annotation),
    [annotation],
  );
  const old = await store.readObject({
    credential: "alice",
    objectId: create.objectId,
    revision: 1,
  });
  const head = await store.readObject({
    credential: "alice",
    objectId: create.objectId,
  });
  assert.equal(old.title, create.title);
  assert.deepEqual(old.content, {
    kind: "document",
    markdown: create.markdown,
  });
  assert.equal(head.revision, 2);
  assert.equal(head.title, revise.title);
  assert.deepEqual(head.content, {
    kind: "document",
    markdown: revise.markdown,
  });
  await assert.rejects(
    store.readObject({ credential: "other-tenant", objectId: create.objectId }),
    /不存在/,
  );
  await assert.rejects(
    store.readObject({
      credential: "alice",
      objectId: create.objectId,
      revision: 99,
    }),
    /不存在/,
  );
  assert.deepEqual(
    (
      await store.listObjectVersions({
        credential: "alice",
        objectId: create.objectId,
      })
    ).versions.map(({ revision }) => revision),
    [2, 1],
  );

  const reference = {
    storeId: "store-one",
    artifactId: "image-bytes",
    revision: 3,
    sha256: "a".repeat(64),
    byteLength: 123,
    mime: "image/png",
  };
  const image = {
    credential: "alice",
    commandId: "image-create",
    objectId: "image-one",
    requestedProjectId: "project-one",
    title: "图片原件",
    assetId: reference.sha256,
    alt: "真实说明",
    reference,
  };
  const imageCreated = await store.createImage(image);
  assert.deepEqual(await store.createImage(image), imageCreated);
  assert.deepEqual(
    (
      await store.authorizeVersionBytes({
        credential: "alice",
        objectId: image.objectId,
        objectRevision: 1,
      })
    ).reference,
    reference,
  );
  await assert.rejects(
    store.createImage({
      ...image,
      commandId: "bad-image-reference",
      objectId: "image-bad",
      reference: { ...reference, sha256: "b".repeat(64) },
    }),
    /匹配/,
  );
  await assert.rejects(
    store.readObject({ credential: "alice", objectId: "image-bad" }),
    /不存在/,
  );
  await assert.rejects(
    store.authorizeVersionBytes({
      credential: "other-tenant",
      objectId: image.objectId,
      objectRevision: 1,
    }),
    /原件或版本不可用/,
  );
}
test("Objects SQLite：正式原件、不可变版本、批注和精确字节引用", async () => {
  const store = await ObjectsStore.sqlite(":memory:", originalAuthority());
  try {
    await exercise(store);
  } finally {
    await store.close();
  }
});

test("Objects 精确读取非文档原件仍核对目录身份与不可变版本", async () => {
  let revokeOnConfirmation = false;
  let readCount = 0;
  const actor = {
    tenantId: "tenant-a",
    principalId: "alice",
    actantId: "agent-one",
    kind: "human" as const,
    runtimeInputId: null,
  };
  const authority: ObjectsAuthority = {
    async authorizeCreate() {
      return actor;
    },
    async authorizeDocumentRevision() {
      throw new Error("未测试写入权限。");
    },
    async authorizeObjectRead({ objectId }) {
      readCount++;
      return {
        ...actor,
        projectId:
          revokeOnConfirmation && readCount % 2 === 0
            ? "another-project"
            : "project-one",
        contentId: objectId,
        objectKind: "pdf",
        observedVersionRef: "1",
        catalogRevision: 1,
      };
    },
    async authorizeByteRead() {
      throw new Error("未测试字节读取权限。");
    },
  };
  const directory = mkdtempSync(join(tmpdir(), "morphz-existing-pdf-read-"));
  const filename = join(directory, "objects.sqlite");
  const store = await ObjectsStore.sqlite(filename, authority);
  try {
    const pdf = {
      id: "pdf-readable",
      projectId: "project-one",
      content: {
        kind: "pdf" as const,
        assetId: "a".repeat(64),
        pages: ["第一页"],
      },
    };
    const db = new DatabaseSync(filename);
    try {
      await seedExistingPdf(sqliteQuery(db), {
        tenantId: "tenant-a",
        objectId: pdf.id,
        projectId: pdf.projectId,
        author,
        reference: {
          storeId: "store-one",
          artifactId: "pdf-readable-bytes",
          revision: 1,
          sha256: pdf.content.assetId,
          byteLength: 42,
          mime: "application/pdf",
        },
        versions: [{ title: "PDF 原件", pages: pdf.content.pages }],
      });
    } finally {
      db.close();
    }
    const result = await store.readObject({
      credential: "authorized-test",
      objectId: pdf.id,
      revision: 1,
    });
    assert.deepEqual(result.content, pdf.content);
    assert.equal(result.projectId, pdf.projectId);
    revokeOnConfirmation = true;
    await assert.rejects(
      store.readObject({ credential: "authorized-test", objectId: pdf.id }),
      /读取期间对象身份或授权发生变化|对象原件不存在或不可用/,
    );
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Objects PDF 改名只追加标题版本，保留确切字节引用", async () => {
  let observedVersionRef = "1";
  let catalogRevision = 1;
  const actor = {
    tenantId: "tenant-a",
    principalId: "alice",
    actantId: "agent-one",
    kind: "human" as const,
    runtimeInputId: null,
    projectId: "project-one",
    contentId: "pdf-content",
    objectKind: "pdf",
  };
  const authorize = async () => ({
    ...actor,
    observedVersionRef,
    catalogRevision,
  });
  const authority: ObjectsAuthority = {
    authorizeCreate: async () => actor,
    authorizeDocumentRevision: authorize,
    authorizeObjectRead: authorize,
    authorizeByteRead: authorize,
  };
  const directory = mkdtempSync(join(tmpdir(), "morphz-existing-pdf-rename-"));
  const filename = join(directory, "objects.sqlite");
  const store = await ObjectsStore.sqlite(filename, authority);
  try {
    const pdf = {
      id: "pdf-rename",
      projectId: "project-one",
      content: {
        kind: "pdf" as const,
        assetId: "a".repeat(64),
        pages: ["第一页"],
      },
    };
    const reference = {
      storeId: "store-one",
      artifactId: "pdf-bytes",
      revision: 1,
      sha256: "a".repeat(64),
      byteLength: 42,
      mime: "application/pdf",
    };
    const db = new DatabaseSync(filename);
    try {
      await seedExistingPdf(sqliteQuery(db), {
        tenantId: "tenant-a",
        objectId: pdf.id,
        projectId: pdf.projectId,
        author,
        reference,
        versions: [{ title: "PDF 旧标题", pages: pdf.content.pages }],
      });
    } finally {
      db.close();
    }
    const command = {
      credential: "alice",
      commandId: "rename-pdf-command",
      objectId: pdf.id,
      expectedCatalogRevision: 1,
      title: "PDF 新标题",
    };
    const renamed = await store.renameObject(command);
    assert.equal(renamed.versionRef, "2");
    assert.deepEqual(await store.renameObject(command), renamed);
    assert.equal(
      await store.verifyCommittedRename({
        tenantId: "tenant-a",
        principalId: "alice",
        actantId: "agent-one",
        runtimeInputId: null,
        objectId: pdf.id,
        projectId: "project-one",
        kind: "pdf",
        title: command.title,
        versionRef: "2",
        receiptId: command.commandId,
      }),
      true,
    );
    observedVersionRef = "2";
    catalogRevision = 2;
    const before = await store.readObject({
      credential: "alice",
      objectId: pdf.id,
      revision: 1,
    });
    const after = await store.readObject({
      credential: "alice",
      objectId: pdf.id,
    });
    assert.equal(before.title, "PDF 旧标题");
    assert.equal(after.title, command.title);
    assert.deepEqual(after.content, before.content);
    assert.deepEqual(
      (
        await store.authorizeVersionBytes({
          credential: "alice",
          objectId: pdf.id,
          objectRevision: 2,
        })
      ).reference,
      reference,
    );
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "Objects PostgreSQL：原件、租户和 Agent 原创搜索投影与 SQLite 一致",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({
      connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
    });
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      const store = await ObjectsStore.postgres({
        connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
        schema,
        authority: originalAuthority(),
      });
      try {
        await exercise(store);
      } finally {
        await store.close();
      }
      const indexed = await ObjectsStore.postgres({
        connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
        schema,
        authority: searchAuthority(),
      });
      try {
        await exerciseSearchProjection(indexed);
      } finally {
        await indexed.close();
      }
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
      await pool.end();
    }
  },
);

test(
  "Objects PostgreSQL：多个 Host 并发初始化独立 schema",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const schemas = Array.from(
      { length: 6 },
      () => `morphz_test_${randomUUID().replaceAll("-", "")}`,
    );
    const pool = new Pool({
      connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
    });
    try {
      for (const schema of schemas) {
        await pool.query(`CREATE SCHEMA "${schema}"`);
      }
      const results = await Promise.allSettled(
        schemas.map((schema) =>
          ObjectsStore.postgres({
            connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
            schema,
          }),
        ),
      );
      const stores = results
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value);
      try {
        assert.deepEqual(
          results.filter((result) => result.status === "rejected"),
          [],
        );
        for (const store of stores) {
          assert.deepEqual(
            await store.searchCandidates({
              tenantId: "tenant-a",
              query: "测试",
            }),
            [],
          );
        }
      } finally {
        await Promise.all(stores.map((store) => store.close()));
      }
    } finally {
      for (const schema of schemas) {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
      await pool.end();
    }
  },
);
