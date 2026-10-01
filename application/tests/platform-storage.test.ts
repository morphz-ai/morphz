import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import {
  PlatformStore,
  PlatformStorageError,
  type PlatformActor,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import { PlatformWorkService } from "../packages/application/src/platform-work-service.js";
import { platformSchemaSql } from "../packages/platform/src/schema.js";
import { schemaHash } from "../packages/storage/src/sql.js";

function countOnly(
  rows: Array<{ projectId: string; count: number; latestActivityAt: string }>,
) {
  return rows.map(({ projectId, count }) => ({ projectId, count }));
}

test("Platform 生产 schema 与评审 SQL 相同", () => {
  const reviewed = readFileSync(
    new URL("../docs/storage-model-v1/platform.sql", import.meta.url),
    "utf8",
  );
  assert.equal(platformSchemaSql.trim(), reviewed.trim());
});

const priorNavigationProjectionsSql = platformSchemaSql.replace(
  /^  (?:projects|conversations|tasks|access)_revision BIGINT NOT NULL DEFAULT 0 CHECK \([^\n]+\),\n/gm,
  "",
);
const priorUnderstandingSql = priorNavigationProjectionsSql.replace(
  /-- Published, project-visible projection of a committed Runtime public Context[\s\S]*?CREATE TABLE project_understanding_versions \([\s\S]*?\n\);\n\n/,
  "",
);
const priorAppViewSql = priorUnderstandingSql.replace(
  /-- A personal, project-scoped UI window is not an App service instance\.[\s\S]*?CREATE INDEX app_view_instances_by_owner\n  ON app_view_instances\([^;]+;\n\n/,
  "",
);
const priorUnderstandingHash =
  "8f534910c59705175b876c85902d5d60e277d7f0c5a7cc88ac5f0eedd021bb02";
test("Platform SQLite 从 v7 增加当前理解视图并保留项目", async () => {
  assert.equal(schemaHash(priorUnderstandingSql), priorUnderstandingHash);
  const directory = mkdtempSync(join(tmpdir(), "morphz-platform-v7-"));
  const filename = join(directory, "platform.sqlite");
  try {
    const db = new DatabaseSync(filename);
    try {
      db.exec(priorUnderstandingSql);
      db.exec(
        "CREATE TABLE platform_schema_version (version BIGINT PRIMARY KEY CHECK(version > 0),schema_sha256 TEXT NOT NULL)",
      );
      db.prepare("INSERT INTO platform_schema_version VALUES(7,?)").run(
        priorUnderstandingHash,
      );
      const now = "2026-09-29T00:00:00.000Z";
      db.prepare("INSERT INTO tenants VALUES('tenant-a',?)").run(now);
      db.prepare(
        "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES('tenant-a','old-project','project','alice','已有项目',1,?,?)",
      ).run(now, now);
      db.prepare(
        "INSERT INTO project_members VALUES('tenant-a','old-project','alice',NULL)",
      ).run();
    } finally {
      db.close();
    }
    const store = await PlatformStore.sqlite(filename, testCapabilities);
    try {
      assert.equal(
        (
          await store.getProject(
            { credential: "human:tenant-a:alice" },
            "old-project",
          )
        ).title,
        "已有项目",
      );
      assert.equal(
        await store.getProjectUnderstanding(
          { credential: "human:tenant-a:alice" },
          "old-project",
        ),
        null,
      );
    } finally {
      await store.close();
    }
    const migrated = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.equal(
        (
          migrated
            .prepare("SELECT version FROM platform_schema_version")
            .get() as {
            version: number;
          }
        ).version,
        9,
      );
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test(
  "Platform PostgreSQL 从 v7 增加当前理解视图并保留项目",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    assert.equal(schemaHash(priorUnderstandingSql), priorUnderstandingHash);
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const client = await admin.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL search_path TO "${schema}", pg_catalog`);
        await client.query(priorUnderstandingSql);
        await client.query(
          "CREATE TABLE platform_schema_version (version BIGINT PRIMARY KEY CHECK(version > 0),schema_sha256 TEXT NOT NULL)",
        );
        await client.query("INSERT INTO platform_schema_version VALUES(7,$1)", [
          priorUnderstandingHash,
        ]);
        const now = "2026-09-29T00:00:00.000Z";
        await client.query("INSERT INTO tenants VALUES('tenant-a',$1)", [now]);
        await client.query(
          "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES('tenant-a','old-project','project','alice','已有项目',1,$1,$1)",
          [now],
        );
        await client.query(
          "INSERT INTO project_members(tenant_id,project_id,principal_id) VALUES('tenant-a','old-project','alice')",
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      const store = await PlatformStore.postgres(
        { connectionString, schema },
        testCapabilities,
      );
      try {
        assert.equal(
          (
            await store.getProject(
              { credential: "human:tenant-a:alice" },
              "old-project",
            )
          ).title,
          "已有项目",
        );
        assert.equal(
          await store.getProjectUnderstanding(
            { credential: "human:tenant-a:alice" },
            "old-project",
          ),
          null,
        );
      } finally {
        await store.close();
      }
      const result = await admin.query<{ version: string }>(
        `SELECT version FROM "${schema}".platform_schema_version`,
      );
      assert.equal(Number(result.rows[0]?.version), 9);
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
const priorAppViewHash =
  "fd1904013e8eeee7c3226d46b51d82dca409a19b2aea845f1268b72949ac16b4";
test("Platform SQLite 从 v6 增加应用窗口关系并保留项目", async () => {
  assert.equal(schemaHash(priorAppViewSql), priorAppViewHash);
  const directory = mkdtempSync(join(tmpdir(), "morphz-platform-v6-"));
  const filename = join(directory, "platform.sqlite");
  try {
    const db = new DatabaseSync(filename);
    try {
      db.exec(priorAppViewSql);
      db.exec(
        "CREATE TABLE platform_schema_version (version BIGINT PRIMARY KEY CHECK(version > 0),schema_sha256 TEXT NOT NULL)",
      );
      db.prepare("INSERT INTO platform_schema_version VALUES(6,?)").run(
        priorAppViewHash,
      );
      const now = "2026-09-28T00:00:00.000Z";
      db.prepare("INSERT INTO tenants VALUES('tenant-a',?)").run(now);
      db.prepare(
        "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES('tenant-a','old-project','project','alice','旧项目',1,?,?)",
      ).run(now, now);
      db.prepare(
        "INSERT INTO project_members VALUES('tenant-a','old-project','alice',NULL)",
      ).run();
    } finally {
      db.close();
    }
    const store = await PlatformStore.sqlite(filename, testCapabilities);
    try {
      assert.equal(
        (
          await store.getProject(
            { credential: "human:tenant-a:alice" },
            "old-project",
          )
        ).title,
        "旧项目",
      );
      assert.deepEqual(
        await store.listAppViews({ credential: "human:tenant-a:alice" }),
        [],
      );
    } finally {
      await store.close();
    }
    const migrated = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.equal(
        (
          migrated
            .prepare("SELECT version FROM platform_schema_version")
            .get() as { version: number }
        ).version,
        9,
      );
      assert.equal(
        (
          migrated
            .prepare(
              "SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='app_view_instances'",
            )
            .get() as { count: number }
        ).count,
        1,
      );
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function exerciseAppViews(first: PlatformStore, second: PlatformStore) {
  const alice = { credential: "human:tenant-a:alice" };
  const bob = { credential: "human:tenant-a:bob" };
  await first.provisionTenant("tenant-a");
  await first.ensurePersonalSpaces(alice);
  await first.createProject(alice, {
    commandId: "app-view-project-create",
    projectId: "app-view-project",
    title: "窗口归属项目",
  });
  const beforeNavigation = (await first.conversationNavigation(alice))
    .catalogVersion;
  const launch = {
    commandId: "app-view-launch",
    projectId: "app-view-project",
    appId: "morphz.reader",
    packageVersion: "1.0.0",
    state: { artifactId: "book-one" },
  };
  const opened = await first.launchAppView(alice, launch);
  assert.equal(opened.id, launch.commandId);
  assert.equal(opened.revision, 1);
  assert.deepEqual(
    (await second.listAppViews(alice)).map((view) => view.id),
    [opened.id],
  );
  assert.equal(
    (await first.conversationNavigation(alice)).catalogVersion,
    beforeNavigation,
    "窗口状态不使业务目录失效",
  );
  assert.deepEqual(await second.listAppViews(bob), []);
  assert.deepEqual(
    await second.launchAppView(alice, launch),
    opened,
    "重试不重复创建窗口",
  );
  await assert.rejects(
    () =>
      second.launchAppView(alice, {
        ...launch,
        state: { artifactId: "other" },
      }),
    /操作标识已经用于另一项请求/,
  );
  await assert.rejects(
    () =>
      second.launchAppView(alice, {
        ...launch,
        commandId: "wrong-version",
        packageVersion: "9.0.0",
      }),
    /应用版本未在这个项目安装/,
  );
  await assert.rejects(
    () => second.launchAppView(bob, { ...launch, commandId: "bob-window" }),
    /无权访问/,
  );
  await assert.rejects(
    () =>
      second.launchAppView(
        { credential: "agent:input-one" },
        { ...launch, commandId: "agent-window" },
      ),
    /只有本人/,
  );
  await assert.rejects(
    () =>
      second.changeAppView(alice, {
        commandId: "app-view-private-body",
        viewId: opened.id,
        expectedRevision: 1,
        state: { note: "不应进入 Platform 的应用正文" },
      }),
    /只能保存导航位置/,
  );
  assert.equal((await first.listAppViews(alice))[0]?.revision, 1);
  const saved = await second.changeAppView(alice, {
    commandId: "app-view-save",
    viewId: opened.id,
    expectedRevision: 1,
    state: { artifactId: "book-two" },
  });
  assert.equal(saved.revision, 2);
  assert.equal(
    (await first.listAppViews(alice))[0]?.state.artifactId,
    "book-two",
  );
  assert.deepEqual(
    await first.changeAppView(alice, {
      commandId: "app-view-save",
      viewId: opened.id,
      expectedRevision: 1,
      state: { artifactId: "book-two" },
    }),
    saved,
  );
  await assert.rejects(
    () =>
      first.changeAppView(alice, {
        commandId: "app-view-stale",
        viewId: opened.id,
        expectedRevision: 1,
        state: { artifactId: "stale" },
      }),
    /已变化/,
  );
  await assert.rejects(
    () =>
      first.changeAppView(bob, {
        commandId: "bob-save",
        viewId: opened.id,
        expectedRevision: 2,
        state: {},
      }),
    /不存在或无权访问/,
  );
  const closed = await second.changeAppView(alice, {
    commandId: "app-view-close",
    viewId: opened.id,
    expectedRevision: 2,
    close: true,
  });
  assert.equal(closed.status, "closed");
  assert.deepEqual(await first.listAppViews(alice), []);
  const reopened = await second.launchAppView(alice, {
    ...launch,
    commandId: "app-view-reopen",
    state: {},
  });
  assert.equal(reopened.id, opened.id);
  assert.equal(reopened.state.artifactId, "book-two");
  assert.equal(reopened.revision, 4);
}

test("Platform SQLite 应用窗口跨连接恢复、隔离、CAS 和幂等", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-app-views-"));
  const filename = join(directory, "platform.sqlite");
  const first = await PlatformStore.sqlite(filename, testCapabilities);
  const second = await PlatformStore.sqlite(filename, testCapabilities);
  try {
    await exerciseAppViews(first, second);
  } finally {
    await first.close();
    await second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "Platform PostgreSQL 应用窗口与 SQLite 语义一致",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const first = await PlatformStore.postgres(
        { connectionString, schema },
        testCapabilities,
      );
      const second = await PlatformStore.postgres(
        { connectionString, schema },
        testCapabilities,
      );
      try {
        await exerciseAppViews(first, second);
      } finally {
        await first.close();
        await second.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

const priorTeamSql = priorAppViewSql.replace(
  /-- Team authentication belongs to the Platform authority[\s\S]*?CREATE INDEX team_login_sessions_by_expiry\n  ON team_login_sessions\([^;]+;\n\n/,
  "",
);
const priorTeamHash =
  "72a2a96f229c98978a8b0c212be9fe7770cc0508e09649432ddf0699d2195b20";
test("Platform SQLite 从 v5 增加团队会话关系，不改已有项目", async () => {
  assert.equal(schemaHash(priorTeamSql), priorTeamHash);
  const directory = mkdtempSync(join(tmpdir(), "morphz-platform-v5-"));
  const filename = join(directory, "platform.sqlite");
  try {
    const db = new DatabaseSync(filename);
    try {
      db.exec(priorTeamSql);
      db.exec(
        "CREATE TABLE platform_schema_version (version BIGINT PRIMARY KEY CHECK(version > 0),schema_sha256 TEXT NOT NULL)",
      );
      db.prepare("INSERT INTO platform_schema_version VALUES(5,?)").run(
        priorTeamHash,
      );
      const now = "2026-09-28T00:00:00.000Z";
      db.prepare("INSERT INTO tenants VALUES('tenant-a',?)").run(now);
      db.prepare(
        "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES('tenant-a','old-project','project','alice','旧项目',1,?,?)",
      ).run(now, now);
    } finally {
      db.close();
    }
    const store = await PlatformStore.sqlite(filename, testCapabilities);
    try {
      assert.equal(await store.teamIdentityConfigured("tenant-a"), false);
      await store.bindTeamIdentityConfig("tenant-a", "a".repeat(64));
    } finally {
      await store.close();
    }
    const migrated = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.equal(
        (
          migrated
            .prepare("SELECT version FROM platform_schema_version")
            .get() as { version: number }
        ).version,
        9,
      );
      assert.equal(
        (
          migrated
            .prepare(
              "SELECT title FROM projects WHERE project_id='old-project'",
            )
            .get() as { title: string }
        ).title,
        "旧项目",
      );
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Platform SQLite 团队会话按租户与配置读取，跨 Store 撤销立即生效", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-platform-team-"));
  const filename = join(directory, "platform.sqlite");
  const first = await PlatformStore.sqlite(filename, testCapabilities);
  const second = await PlatformStore.sqlite(filename, testCapabilities);
  const config = "a".repeat(64),
    next = "b".repeat(64);
  const session = {
    sessionHash: "c".repeat(64),
    csrf: "d".repeat(64),
    principalId: "alice",
    actantId: "alice-human",
    credentialHash: "e".repeat(64),
    expiresAt: 2000,
  };
  try {
    await first.provisionTenant("tenant-a");
    await second.provisionTenant("tenant-b");
    await first.bindTeamIdentityConfig("tenant-a", config);
    await second.bindTeamIdentityConfig("tenant-a", config);
    await second.bindTeamIdentityConfig("tenant-b", config);
    await first.issueTeamLoginSession("tenant-a", config, session, 1000);
    await second.issueTeamLoginSession("tenant-a", config, session, 1000);
    await assert.rejects(
      () =>
        second.issueTeamLoginSession(
          "tenant-a",
          config,
          { ...session, csrf: "f".repeat(64) },
          1000,
        ),
      /已被占用/,
    );
    assert.deepEqual(
      await second.teamLoginSession(
        "tenant-a",
        config,
        session.sessionHash,
        1000,
      ),
      session,
    );
    assert.equal(
      await second.teamLoginSession(
        "tenant-b",
        config,
        session.sessionHash,
        1000,
      ),
      null,
    );
    assert.equal(
      await second.teamLoginSession(
        "tenant-a",
        next,
        session.sessionHash,
        1000,
      ),
      null,
    );
    await assert.rejects(
      () => second.bindTeamIdentityConfig("tenant-a", next),
      /不一致/,
    );
    await second.revokeTeamLoginSession("tenant-a", session.sessionHash);
    assert.equal(
      await first.teamLoginSession(
        "tenant-a",
        config,
        session.sessionHash,
        1000,
      ),
      null,
    );
    await first.issueTeamLoginSession("tenant-a", config, session, 1000);
    await second.replaceTeamIdentityConfig("tenant-a", config, next, [
      {
        principalId: "other",
        actantId: "other-human",
        credentialHash: session.credentialHash,
      },
    ]);
    assert.equal(
      await first.teamLoginSession("tenant-a", next, session.sessionHash, 1000),
      null,
    );
    await assert.rejects(
      () => first.issueTeamLoginSession("tenant-a", config, session, 1000),
      /已变化/,
    );
    assert.equal(await first.teamIdentityConfigMatches("tenant-a", next), true);
    await second.replaceTeamIdentityConfig("tenant-a", next, config, [
      {
        principalId: session.principalId,
        actantId: session.actantId,
        credentialHash: session.credentialHash,
      },
    ]);
    assert.equal(
      await first.teamLoginSession(
        "tenant-a",
        config,
        session.sessionHash,
        1000,
      ),
      null,
      "凭据重新绑定又恢复时，不可复活旧会话",
    );
  } finally {
    await first.close();
    await second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "Platform PostgreSQL 团队会话可跨 Host 读取、撤销并拒绝配置分叉",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const first = await PlatformStore.postgres(
      { connectionString, schema },
      testCapabilities,
    );
    const second = await PlatformStore.postgres(
      { connectionString, schema },
      testCapabilities,
    );
    const config = "a".repeat(64),
      next = "b".repeat(64);
    const session = {
      sessionHash: "c".repeat(64),
      csrf: "d".repeat(64),
      principalId: "alice",
      actantId: "alice-human",
      credentialHash: "e".repeat(64),
      expiresAt: 2000,
    };
    try {
      await first.provisionTenant("tenant-a");
      await first.bindTeamIdentityConfig("tenant-a", config);
      await first.issueTeamLoginSession("tenant-a", config, session, 1000);
      await second.issueTeamLoginSession("tenant-a", config, session, 1000);
      await assert.rejects(
        () =>
          second.issueTeamLoginSession(
            "tenant-a",
            config,
            { ...session, csrf: "f".repeat(64) },
            1000,
          ),
        /已被占用/,
      );
      assert.deepEqual(
        await second.teamLoginSession(
          "tenant-a",
          config,
          session.sessionHash,
          1000,
        ),
        session,
      );
      await second.revokeTeamLoginSession("tenant-a", session.sessionHash);
      assert.equal(
        await first.teamLoginSession(
          "tenant-a",
          config,
          session.sessionHash,
          1000,
        ),
        null,
      );
      await first.issueTeamLoginSession("tenant-a", config, session, 1000);
      await second.replaceTeamIdentityConfig("tenant-a", config, next, [
        {
          principalId: "other",
          actantId: "other-human",
          credentialHash: session.credentialHash,
        },
      ]);
      await assert.rejects(
        () => first.bindTeamIdentityConfig("tenant-a", config),
        /不一致/,
      );
      assert.equal(
        await first.teamIdentityConfigMatches("tenant-a", next),
        true,
      );
      await second.replaceTeamIdentityConfig("tenant-a", next, config, [
        {
          principalId: session.principalId,
          actantId: session.actantId,
          credentialHash: session.credentialHash,
        },
      ]);
      assert.equal(
        await first.teamLoginSession(
          "tenant-a",
          config,
          session.sessionHash,
          1000,
        ),
        null,
      );
    } finally {
      await first.close();
      await second.close();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
const priorUiPackageSql = priorTeamSql.replace(
  /-- Installation of executable UI code[\s\S]*?CREATE INDEX app_ui_packages_by_installer\n  ON app_ui_packages\([^;]+;\n\n/,
  "",
);
const priorUiPackageHash =
  "3032316482d0ef73300ee1446cf9d8024914259152d11d95e13202cfd61be355";

test("Platform SQLite 从 v4 原位增加安装包索引，保留既有应用安装", async () => {
  assert.equal(schemaHash(priorUiPackageSql), priorUiPackageHash);
  const directory = mkdtempSync(join(tmpdir(), "morphz-platform-v4-"));
  const filename = join(directory, "platform.sqlite");
  try {
    const db = new DatabaseSync(filename);
    try {
      db.exec(priorUiPackageSql);
      db.exec(
        "CREATE TABLE platform_schema_version (version BIGINT PRIMARY KEY CHECK(version > 0),schema_sha256 TEXT NOT NULL)",
      );
      db.prepare("INSERT INTO platform_schema_version VALUES(4,?)").run(
        priorUiPackageHash,
      );
      db.prepare("INSERT INTO tenants VALUES('tenant-a',?)").run(
        "2026-09-25T00:00:00.000Z",
      );
      db.prepare(
        "INSERT INTO app_installations VALUES('tenant-a','morphz.reader','reader-one','active','2026-09-25T00:00:00.000Z')",
      ).run();
    } finally {
      db.close();
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const store = await PlatformStore.sqlite(filename, testCapabilities);
      await store.close();
    }
    const upgraded = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.equal(
        (
          upgraded
            .prepare("SELECT version FROM platform_schema_version")
            .get() as {
            version: number;
          }
        ).version,
        9,
      );
      assert.equal(
        (
          upgraded
            .prepare(
              "SELECT installation_id FROM app_installations WHERE tenant_id='tenant-a'",
            )
            .get() as { installation_id: string }
        ).installation_id,
        "reader-one",
      );
      assert.equal(
        (
          upgraded
            .prepare("SELECT count(*) AS count FROM app_ui_packages")
            .get() as {
            count: number;
          }
        ).count,
        0,
      );
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const priorContentIndexSql = priorUiPackageSql.replace(
  "CREATE INDEX content_by_app_object ON content_entries(tenant_id, app_id, app_object_id, deleted_at, content_id);\n",
  "",
);
const priorContentIndexHash =
  "c327f57f68bfa092ef74995cf6a7040342b192380e20d61d6a94412ff94579a8";

test("Platform SQLite 从 v3 增加对象定位索引并保留目录数据", async () => {
  assert.equal(schemaHash(priorContentIndexSql), priorContentIndexHash);
  const directory = mkdtempSync(join(tmpdir(), "morphz-platform-v3-"));
  const filename = join(directory, "platform.sqlite");
  try {
    const db = new DatabaseSync(filename);
    try {
      db.exec(priorContentIndexSql);
      db.exec(
        "CREATE TABLE platform_schema_version (version BIGINT PRIMARY KEY CHECK(version > 0),schema_sha256 TEXT NOT NULL)",
      );
      db.prepare("INSERT INTO platform_schema_version VALUES(3,?)").run(
        priorContentIndexHash,
      );
      const now = "2026-09-25T00:00:00.000Z";
      db.prepare("INSERT INTO tenants VALUES('tenant-a',?)").run(now);
      db.prepare(
        "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES('tenant-a','v3-project','project','alice','原有项目',1,?,?)",
      ).run(now, now);
      db.prepare(
        "INSERT INTO project_members(tenant_id,project_id,principal_id) VALUES('tenant-a','v3-project','alice')",
      ).run();
    } finally {
      db.close();
    }
    const store = await PlatformStore.sqlite(filename, testCapabilities);
    try {
      assert.equal(
        (
          await store.getProject(
            { credential: "human:tenant-a:alice" },
            "v3-project",
          )
        ).title,
        "原有项目",
      );
    } finally {
      await store.close();
    }
    const upgraded = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.equal(
        (
          upgraded
            .prepare("SELECT version FROM platform_schema_version")
            .get() as { version: number }
        ).version,
        9,
      );
      assert.equal(
        (
          upgraded
            .prepare(
              "SELECT count(*) AS count FROM sqlite_master WHERE type='index' AND name='content_by_app_object'",
            )
            .get() as { count: number }
        ).count,
        1,
      );
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "Platform PostgreSQL 从 v3 增加对象定位索引并保留目录数据",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    assert.equal(schemaHash(priorContentIndexSql), priorContentIndexHash);
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const client = await admin.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL search_path TO "${schema}", pg_catalog`);
        await client.query(priorContentIndexSql);
        await client.query(
          "CREATE TABLE platform_schema_version (version BIGINT PRIMARY KEY CHECK(version > 0),schema_sha256 TEXT NOT NULL)",
        );
        await client.query("INSERT INTO platform_schema_version VALUES(3,$1)", [
          priorContentIndexHash,
        ]);
        const now = "2026-09-25T00:00:00.000Z";
        await client.query("INSERT INTO tenants VALUES('tenant-a',$1)", [now]);
        await client.query(
          "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES('tenant-a','v3-project','project','alice','原有项目',1,$1,$1)",
          [now],
        );
        await client.query(
          "INSERT INTO project_members(tenant_id,project_id,principal_id) VALUES('tenant-a','v3-project','alice')",
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      const store = await PlatformStore.postgres(
        { connectionString, schema },
        testCapabilities,
      );
      try {
        assert.equal(
          (
            await store.getProject(
              { credential: "human:tenant-a:alice" },
              "v3-project",
            )
          ).title,
          "原有项目",
        );
      } finally {
        await store.close();
      }
      const version = await admin.query(
        `SELECT version FROM "${schema}".platform_schema_version`,
      );
      assert.equal(Number(version.rows[0].version), 9);
      const index = await admin.query(
        "SELECT count(*)::integer AS count FROM pg_indexes WHERE schemaname=$1 AND indexname='content_by_app_object'",
        [schema],
      );
      assert.equal(index.rows[0].count, 1);
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

test("Platform SQLite 从已存在的 v1 库原位迁移栅栏表且保留项目", async () => {
  const withoutNavigation = priorContentIndexSql.replace(
    /-- One transactionally advanced invalidation token[\s\S]*?CREATE TABLE navigation_heads \([\s\S]*?\);\n\n/,
    "",
  );
  const previous = withoutNavigation.replace(
    /-- A durable admission fence[\s\S]*?CREATE TABLE project_retirements \([\s\S]*?\);\n\n/,
    "",
  );
  const previousHash =
    "f30dd70e0e46c6c61921657b96d896649161ce0fe441f0fb0d704100c23cd414";
  assert.notEqual(previous, platformSchemaSql);
  assert.equal(schemaHash(previous), previousHash);
  const directory = mkdtempSync(join(tmpdir(), "morphz-platform-v1-"));
  const filename = join(directory, "platform.sqlite");
  try {
    const db = new DatabaseSync(filename);
    try {
      db.exec(previous);
      db.exec(
        "CREATE TABLE platform_schema_version (version BIGINT PRIMARY KEY CHECK(version > 0),schema_sha256 TEXT NOT NULL)",
      );
      db.prepare("INSERT INTO platform_schema_version VALUES(1,?)").run(
        previousHash,
      );
      db.prepare("INSERT INTO tenants VALUES('tenant-a',?)").run(
        new Date().toISOString(),
      );
      const timestamp = new Date().toISOString();
      db.prepare(
        "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES('tenant-a','v1-project','project','alice','原有项目',1,?,?)",
      ).run(timestamp, timestamp);
      db.prepare(
        "INSERT INTO project_members(tenant_id,project_id,principal_id) VALUES('tenant-a','v1-project','alice')",
      ).run();
    } finally {
      db.close();
    }
    const store = await PlatformStore.sqlite(filename, testCapabilities);
    try {
      assert.equal(
        (
          await store.getProject(
            { credential: "human:tenant-a:alice" },
            "v1-project",
          )
        ).title,
        "原有项目",
      );
    } finally {
      await store.close();
    }
    const migrated = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.equal(
        (
          migrated
            .prepare("SELECT version FROM platform_schema_version")
            .get() as { version: number }
        ).version,
        9,
      );
      assert.equal(
        (
          migrated
            .prepare("SELECT count(*) AS count FROM project_retirements")
            .get() as { count: number }
        ).count,
        0,
      );
      assert.equal(
        (
          migrated
            .prepare(
              "SELECT revision FROM navigation_heads WHERE tenant_id='tenant-a'",
            )
            .get() as { revision: number }
        ).revision,
        0,
      );
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const priorPlatformSql = priorContentIndexSql.replace(
  /-- One transactionally advanced invalidation token[\s\S]*?CREATE TABLE navigation_heads \([\s\S]*?\);\n\n/,
  "",
);
const priorPlatformHash =
  "8cf6082fe757e99cef6f09989e38e03751ac4f70ae950ecb4d8c1158a6c79f58";

test("Platform SQLite 将已有目录迁入事务修订号", async () => {
  assert.equal(schemaHash(priorPlatformSql), priorPlatformHash);
  const directory = mkdtempSync(join(tmpdir(), "morphz-platform-v2-"));
  const filename = join(directory, "platform.sqlite");
  try {
    const db = new DatabaseSync(filename);
    try {
      db.exec(priorPlatformSql);
      db.exec(
        "CREATE TABLE platform_schema_version (version BIGINT PRIMARY KEY CHECK(version > 0),schema_sha256 TEXT NOT NULL)",
      );
      db.prepare("INSERT INTO platform_schema_version VALUES(2,?)").run(
        priorPlatformHash,
      );
      db.prepare("INSERT INTO tenants VALUES('tenant-a',?)").run(
        new Date().toISOString(),
      );
    } finally {
      db.close();
    }
    const store = await PlatformStore.sqlite(filename, testCapabilities);
    try {
      assert.equal(
        (
          await store.conversationNavigation({
            credential: "human:tenant-a:alice",
          })
        ).catalogVersion,
        0,
      );
    } finally {
      await store.close();
    }
    const upgraded = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.equal(
        (
          upgraded
            .prepare("SELECT version FROM platform_schema_version")
            .get() as { version: number }
        ).version,
        9,
      );
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "Platform PostgreSQL 将已有目录迁入事务修订号",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const client = await admin.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL search_path TO "${schema}", pg_catalog`);
        await client.query(priorPlatformSql);
        await client.query(
          "CREATE TABLE platform_schema_version (version BIGINT PRIMARY KEY CHECK(version > 0),schema_sha256 TEXT NOT NULL)",
        );
        await client.query("INSERT INTO platform_schema_version VALUES(2,$1)", [
          priorPlatformHash,
        ]);
        await client.query("INSERT INTO tenants VALUES('tenant-a',$1)", [
          new Date().toISOString(),
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      const store = await PlatformStore.postgres(
        { connectionString, schema },
        testCapabilities,
      );
      try {
        assert.equal(
          (
            await store.conversationNavigation({
              credential: "human:tenant-a:alice",
            })
          ).catalogVersion,
          0,
        );
      } finally {
        await store.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

async function exerciseNavigationVersion(store: PlatformStore) {
  await store.provisionTenant("tenant-a");
  await store.provisionTenant("tenant-b");
  const alice = { credential: "human:tenant-a:alice" };
  const version = () => store.conversationNavigation(alice);
  assert.deepEqual(await version(), {
    projectIds: [],
    catalogVersion: 0,
    revisions: { projects: 0, conversations: 0, tasks: 0, access: 0 },
  });
  const personal = await store.ensurePersonalSpaces(alice);
  const afterOnboarding = await version();
  assert.equal(afterOnboarding.catalogVersion, 1);
  assert.deepEqual(
    new Set(afterOnboarding.projectIds),
    new Set(Object.values(personal)),
  );
  await store.ensurePersonalSpaces(alice);
  assert.equal((await version()).catalogVersion, 1);
  const create = {
    commandId: "navigation-create",
    projectId: "navigation-project",
    title: "目录修订测试",
  };
  await store.createProject(alice, create);
  assert.equal((await version()).catalogVersion, 2);
  await store.createProject(alice, create);
  assert.equal((await version()).catalogVersion, 2, "幂等重试不推进目录修订");
  await store.renameProject(alice, {
    commandId: "navigation-rename",
    projectId: create.projectId,
    expectedRevision: 1,
    title: "改名后目录",
  });
  assert.equal((await version()).catalogVersion, 3);
  assert.deepEqual(
    await store.conversationNavigation({ credential: "human:tenant-b:alice" }),
    {
      projectIds: [],
      catalogVersion: 0,
      revisions: { projects: 0, conversations: 0, tasks: 0, access: 0 },
    },
  );
}

test("Platform SQLite 目录修订与项目写入同事务且幂等", async () => {
  const store = await PlatformStore.sqlite(":memory:", testCapabilities);
  try {
    await exerciseNavigationVersion(store);
  } finally {
    await store.close();
  }
});

async function exerciseOperatorMembers(store: PlatformStore) {
  await store.provisionTenant("tenant-a");
  const alice = { credential: "human:tenant-a:alice" };
  const bob = { credential: "human:tenant-a:bob" };
  const spaces = await store.ensurePersonalSpaces(alice);
  await store.createProject(alice, {
    commandId: "operator-project-command",
    projectId: "operator-project",
    title: "团队项目",
  });
  const before = await store.conversationNavigation(alice);
  const members = [
    {
      principalId: "alice",
      actantId: "alice",
      projectIds: [],
      enabled: true,
    },
    {
      principalId: "bob",
      actantId: "bob",
      projectIds: ["operator-project"],
      enabled: true,
    },
  ];
  await store.reconcileOperatorMembers("tenant-a", members);
  assert.equal(
    (await store.conversationNavigation(alice)).catalogVersion,
    before.catalogVersion + 1,
  );
  assert.deepEqual((await store.conversationNavigation(bob)).projectIds, [
    "operator-project",
  ]);
  assert.ok(
    (await store.conversationNavigation(alice)).projectIds.includes(
      spaces.deskId,
    ),
  );
  assert.ok(
    (await store.conversationNavigation(alice)).projectIds.includes(
      "operator-project",
    ),
    "重载旧配置不能撤掉新建项目的创建者",
  );
  await store.reconcileOperatorMembers("tenant-a", members);
  assert.equal(
    (await store.conversationNavigation(alice)).catalogVersion,
    before.catalogVersion + 1,
    "重复加载配置不制造修订",
  );
  await assert.rejects(
    store.reconcileOperatorMembers("tenant-a", [
      { ...members[1]!, projectIds: ["operator-project", "absent-project"] },
    ]),
    /不存在的项目/,
  );
  assert.deepEqual(
    (await store.conversationNavigation(bob)).projectIds,
    ["operator-project"],
    "无效配置不部分撤权",
  );
  await store.reconcileOperatorMembers("tenant-a", [
    members[0]!,
    { ...members[1]!, enabled: false },
  ]);
  assert.deepEqual((await store.conversationNavigation(bob)).projectIds, []);
  assert.ok(
    !(await store.listProjects(bob)).some(
      (project) => project.project_id === "operator-project",
    ),
  );
}

async function exerciseAtomicTeamReload(
  first: PlatformStore,
  second: PlatformStore,
) {
  const alice = { credential: "human:tenant-a:alice" };
  const bob = { credential: "human:tenant-a:bob" };
  const original = "a".repeat(64);
  const withBob = "b".repeat(64);
  const withoutBob = "c".repeat(64);
  const restored = "d".repeat(64);
  const aliceCredential = "e".repeat(64);
  const bobCredential = "f".repeat(64);
  const aliceBinding = {
    principalId: "alice",
    actantId: "alice",
    credentialHash: aliceCredential,
  };
  const bobBinding = {
    principalId: "bob",
    actantId: "bob",
    credentialHash: bobCredential,
  };
  const aliceMember = {
    principalId: "alice",
    actantId: "alice",
    projectIds: [] as string[],
    enabled: true,
  };
  const bobMember = {
    principalId: "bob",
    actantId: "bob",
    projectIds: ["operator-project"],
    enabled: true,
  };
  await first.provisionTenant("tenant-a");
  await first.bindTeamIdentityConfig("tenant-a", original);
  await second.bindTeamIdentityConfig("tenant-a", original);
  await first.ensurePersonalSpaces(alice);
  await first.createProject(alice, {
    commandId: "team-reload-project-command",
    projectId: "operator-project",
    title: "团队项目",
  });
  await first.reconcileOperatorMembers("tenant-a", [aliceMember], {
    expectedSha256: original,
  });
  await first.reconcileOperatorMembers("tenant-a", [aliceMember, bobMember], {
    expectedSha256: original,
    replacement: {
      sha256: withBob,
      activeBindings: [aliceBinding, bobBinding],
      retiredPrincipalIds: [],
    },
  });
  assert.ok(
    (await second.listProjects(bob)).some(
      (project) => project.project_id === "operator-project",
    ),
  );
  const bobSession = {
    sessionHash: "1".repeat(64),
    csrf: "2".repeat(64),
    principalId: "bob",
    actantId: "bob",
    credentialHash: bobCredential,
    expiresAt: 2000,
  };
  await second.issueTeamLoginSession("tenant-a", withBob, bobSession, 1000);
  await second.reconcileOperatorMembers("tenant-a", [aliceMember], {
    expectedSha256: withBob,
    replacement: {
      sha256: withoutBob,
      activeBindings: [aliceBinding],
      retiredPrincipalIds: ["bob"],
    },
  });
  assert.equal(
    (await first.listProjects(bob)).some(
      (project) => project.project_id === "operator-project",
    ),
    false,
  );
  assert.equal(
    await first.teamLoginSession(
      "tenant-a",
      withoutBob,
      bobSession.sessionHash,
      1000,
    ),
    null,
  );
  await assert.rejects(
    () =>
      first.reconcileOperatorMembers("tenant-a", [aliceMember, bobMember], {
        expectedSha256: withBob,
      }),
    /其他 Host 更新/,
  );
  await assert.rejects(
    () =>
      first.reconcileOperatorMembers(
        "tenant-a",
        [aliceMember, { ...bobMember, projectIds: ["absent-project"] }],
        {
          expectedSha256: withoutBob,
          replacement: {
            sha256: restored,
            activeBindings: [aliceBinding, bobBinding],
            retiredPrincipalIds: [],
          },
        },
      ),
    /不存在的项目/,
  );
  assert.equal(
    await second.teamIdentityConfigMatches("tenant-a", withoutBob),
    true,
  );
  await first.reconcileOperatorMembers(
    "tenant-a",
    [aliceMember, { ...bobMember, projectIds: [] }],
    {
      expectedSha256: withoutBob,
      replacement: {
        sha256: restored,
        activeBindings: [aliceBinding, bobBinding],
        retiredPrincipalIds: [],
      },
    },
  );
  assert.equal(
    await second.teamIdentityConfigMatches("tenant-a", restored),
    true,
  );
  assert.equal(
    (await first.listProjects(bob)).some(
      (project) => project.project_id === "operator-project",
    ),
    false,
  );
  assert.equal(
    await second.teamLoginSession(
      "tenant-a",
      restored,
      bobSession.sessionHash,
      1000,
    ),
    null,
    "重新加入成员不恢复其已撤销的旧会话",
  );
}

test("Platform SQLite：身份、成员和会话在跨 Host 重载时一并生效", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-team-reload-"));
  const filename = join(directory, "platform.sqlite");
  const first = await PlatformStore.sqlite(filename, testCapabilities);
  const second = await PlatformStore.sqlite(filename, testCapabilities);
  try {
    await exerciseAtomicTeamReload(first, second);
  } finally {
    await first.close();
    await second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "Platform PostgreSQL：身份、成员和会话与 SQLite 同事务语义",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const first = await PlatformStore.postgres(
      { connectionString, schema },
      testCapabilities,
    );
    const second = await PlatformStore.postgres(
      { connectionString, schema },
      testCapabilities,
    );
    try {
      await exerciseAtomicTeamReload(first, second);
    } finally {
      await first.close();
      await second.close();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

test("Platform SQLite：团队成员配置只改 Platform 权限", async () => {
  const store = await PlatformStore.sqlite(":memory:", testCapabilities);
  try {
    await exerciseOperatorMembers(store);
  } finally {
    await store.close();
  }
});

test(
  "Platform PostgreSQL：团队成员配置与 SQLite 同义",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const store = await PlatformStore.postgres(
        { connectionString, schema },
        testCapabilities,
      );
      try {
        await exerciseOperatorMembers(store);
      } finally {
        await store.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

test(
  "Platform PostgreSQL 目录修订与 SQLite 同义",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const store = await PlatformStore.postgres(
        { connectionString, schema },
        testCapabilities,
      );
      try {
        await exerciseNavigationVersion(store);
      } finally {
        await store.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

const testCapabilities: PlatformAuthorityVerifier = {
  async resolveActor({ credential }) {
    if (credential === "human:tenant-a:alice")
      return {
        tenantId: "tenant-a",
        principalId: "alice",
        actantId: "alice",
        kind: "human",
        runtimeInputId: null,
      };
    if (credential === "human:tenant-a:bob")
      return {
        tenantId: "tenant-a",
        principalId: "bob",
        actantId: "bob",
        kind: "human",
        runtimeInputId: null,
      };
    if (credential === "human:tenant-b:alice")
      return {
        tenantId: "tenant-b",
        principalId: "alice",
        actantId: "alice",
        kind: "human",
        runtimeInputId: null,
      };
    if (credential === "human:tenant-local:local-owner")
      return {
        tenantId: "tenant-local",
        principalId: "local-owner",
        actantId: "local-human",
        kind: "human",
        runtimeInputId: null,
      };
    if (credential === "agent:input-one")
      return {
        tenantId: "tenant-a",
        principalId: "alice",
        actantId: "agent-one",
        kind: "agent",
        runtimeInputId: "input-one",
        initiatingHumanActantId: "alice",
        scopeProjectId: "p1",
      };
    if (credential === "agent:missing-input")
      return {
        tenantId: "tenant-a",
        principalId: "alice",
        actantId: "agent-one",
        kind: "agent",
        runtimeInputId: null,
        scopeProjectId: "p1",
      };
    return null;
  },
  async resolveActant(request) {
    if (request.actantId === "alice")
      return { principalId: "alice", kind: "human" };
    if (request.actantId === "bob")
      return { principalId: "bob", kind: "human" };
    if (request.actantId === "local-human")
      return { principalId: "local-owner", kind: "human" };
    if (request.actantId === "agent-one")
      return { principalId: "morphz-service", kind: "agent" };
    return null;
  },
  async resolveProjectAgent() {
    return { principalId: "morphz-service", actantId: "agent-one" };
  },
  async verifyApplicationObject(request) {
    return (
      request.proof ===
      `committed:${request.tenantId}:${request.instanceId}:${request.objectId}:${request.versionRef}:${request.receiptId}:${request.title}`
    );
  },
};

async function exerciseProjectUnderstanding(
  first: PlatformStore,
  second: PlatformStore,
) {
  const alice = { credential: "human:tenant-a:alice" };
  const bob = { credential: "human:tenant-a:bob" };
  const agent = { credential: "agent:input-one" };
  await first.provisionTenant("tenant-a");
  await first.createProject(alice, {
    commandId: "understanding-project-create",
    projectId: "p1",
    title: "共同工作",
  });
  assert.equal(await second.getProjectUnderstanding(alice, "p1"), null);
  const firstPublish = {
    commandId: "understanding-publish-one",
    projectId: "p1",
    expectedRevision: 0,
    frameId: "mw-public-p1",
    frameRevision: 1,
    mindVersion: 1,
    body: "先确定目标，再检查事实。",
    sources: [],
    now: "2026-09-29T01:00:00.000Z",
  };
  const published = await first.publishProjectUnderstanding(
    agent,
    firstPublish,
  );
  assert.equal(published.revision, 1);
  assert.equal(published.publishedByActantId, "agent-one");
  assert.deepEqual(
    await second.getProjectUnderstanding(alice, "p1"),
    published,
  );
  assert.deepEqual(
    await second.publishProjectUnderstanding(agent, firstPublish),
    published,
    "同一命令跨连接重试不创建第二个版本",
  );
  assert.deepEqual(
    await first.listContent(alice, { projectId: "p1" }),
    [],
    "当前理解不进入应用内容目录",
  );
  await assert.rejects(second.getProjectUnderstanding(bob, "p1"), /无权访问/);
  await assert.rejects(
    second.publishProjectUnderstanding(alice, {
      ...firstPublish,
      commandId: "human-publish",
    }),
    /只有绑定到已保存输入的 Agent/,
  );
  await assert.rejects(
    second.publishProjectUnderstanding(agent, {
      ...firstPublish,
      commandId: "bad-source",
      expectedRevision: 1,
      frameRevision: 2,
      sources: [{ contentId: "missing-content", versionRef: "1" }],
    }),
    /不可用的内容/,
  );
  const revised = await second.publishProjectUnderstanding(agent, {
    ...firstPublish,
    commandId: "understanding-publish-two",
    expectedRevision: 1,
    frameRevision: 2,
    mindVersion: 2,
    body: "目标明确；仍需验证来源。",
  });
  assert.equal(revised.revision, 2);
  assert.deepEqual(
    await first.getProjectUnderstanding(alice, "p1", 1),
    published,
  );
  assert.deepEqual(await first.getProjectUnderstanding(alice, "p1"), revised);
  assert.deepEqual(
    await first.replayProjectUnderstanding(agent, {
      commandId: firstPublish.commandId,
      projectId: "p1",
      expectedRevision: 0,
      frameRevision: 1,
      sources: [],
    }),
    published,
    "Runtime 帧已前进时仍可按原命令恢复第一次发布回执",
  );
  await assert.rejects(
    first.replayProjectUnderstanding(agent, {
      commandId: firstPublish.commandId,
      projectId: "p1",
      expectedRevision: 0,
      frameRevision: 2,
      sources: [],
    }),
    /另一项请求/,
  );
  await assert.rejects(
    first.publishProjectUnderstanding(agent, {
      ...firstPublish,
      commandId: "stale-publish",
    }),
    /已更新/,
  );
  await assert.rejects(
    first.publishProjectUnderstanding(agent, {
      ...firstPublish,
      commandId: "stale-frame",
      expectedRevision: 2,
    }),
    /已更新/,
  );
}

test("Platform SQLite 当前理解是授权、版本化且不入目录的项目视图", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-understanding-"));
  const filename = join(directory, "platform.sqlite");
  const first = await PlatformStore.sqlite(filename, testCapabilities);
  const second = await PlatformStore.sqlite(filename, testCapabilities);
  try {
    await exerciseProjectUnderstanding(first, second);
  } finally {
    await first.close();
    await second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "Platform PostgreSQL 当前理解与 SQLite 的授权、修订和回执语义一致",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const first = await PlatformStore.postgres(
        { connectionString, schema },
        testCapabilities,
      );
      const second = await PlatformStore.postgres(
        { connectionString, schema },
        testCapabilities,
      );
      try {
        await exerciseProjectUnderstanding(first, second);
      } finally {
        await first.close();
        await second.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

async function exerciseContentDeliveries(store: PlatformStore) {
  const alice = { credential: "human:tenant-a:alice" };
  const agent = { credential: "agent:input-one" };
  await store.provisionTenant("tenant-a");
  await store.createProject(alice, {
    commandId: "deliveries-project-create",
    projectId: "p1",
    title: "交付项目",
  });
  await store.registerApplication("tenant-a", {
    appId: "morphz.objects",
    installationId: "deliveries-install",
    instanceId: "deliveries-instance",
    routeRef: "domain-api:objects",
    routeKind: "service",
  });
  const create = {
    commandId: "deliveries-create",
    appReceiptId: "deliveries-app-create",
    contentId: "delivery-content",
    objectId: "delivery-document",
    projectId: "p1",
    kind: "document",
    title: "第一版",
    observedVersionRef: "1",
    now: "2026-09-25T01:00:00.000Z",
  };
  const createApp = {
    instanceId: "deliveries-instance",
    proof:
      "committed:tenant-a:deliveries-instance:delivery-document:1:deliveries-app-create:第一版",
  };
  await store.recordContent(agent, createApp, create);
  await store.recordContent(agent, createApp, create);
  assert.deepEqual(
    await store.contentDeliveries(alice, { inputIds: ["other"] }),
    [],
  );
  assert.deepEqual(
    await store.contentDeliveries(
      { credential: "human:tenant-a:bob" },
      {
        inputIds: ["input-one"],
      },
    ),
    [],
  );
  const created = await store.contentDeliveries(alice, {
    inputIds: ["input-one"],
  });
  assert.equal(created.length, 1);
  assert.deepEqual(
    [
      created[0]!.runtime_input_id,
      created[0]!.version_ref,
      created[0]!.content_id,
    ],
    ["input-one", "1", "delivery-content"],
  );
  const refresh = {
    commandId: "deliveries-refresh",
    appReceiptId: "deliveries-app-refresh",
    contentId: "delivery-content",
    expectedCatalogRevision: 1,
    title: "第二版",
    observedVersionRef: "2",
    now: "2026-09-25T02:00:00.000Z",
  };
  const refreshApp = {
    instanceId: "deliveries-instance",
    proof:
      "committed:tenant-a:deliveries-instance:delivery-document:2:deliveries-app-refresh:第二版",
  };
  await store.refreshContent(agent, refreshApp, refresh);
  const delivered = await store.contentDeliveries(alice, {
    inputIds: ["input-one"],
  });
  assert.deepEqual(
    delivered.map((row) => [row.command_id, row.version_ref]),
    [
      ["deliveries-create", "1"],
      ["deliveries-refresh", "2"],
    ],
    "后来修订不能把第一条交付重写为当前版本",
  );
  assert.deepEqual(
    (
      await store.contentDeliveries(alice, {
        inputIds: ["input-one"],
        limit: 1,
        after: {
          committedAt: delivered[0]!.committed_at,
          commandId: delivered[0]!.command_id,
        },
      })
    ).map((row) => row.command_id),
    ["deliveries-refresh"],
  );
  await assert.rejects(
    store.contentDeliveries(alice, { inputIds: ["input-one", "input-one"] }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "invalid",
  );
}

test("Platform SQLite 的交付引用来自持久回执并保持精确版本", async () => {
  const store = await PlatformStore.sqlite(":memory:", testCapabilities);
  try {
    await exerciseContentDeliveries(store);
  } finally {
    await store.close();
  }
});

test(
  "Platform PostgreSQL 的交付引用与 SQLite 同义",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const store = await PlatformStore.postgres(
        { connectionString, schema },
        testCapabilities,
      );
      try {
        await exerciseContentDeliveries(store);
      } finally {
        await store.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

async function exerciseConversationLifecycle(store: PlatformStore) {
  await store.provisionTenant("tenant-local");
  const permitted = { credential: "human:tenant-local:local-owner" };
  for (const [projectId, title] of [
    ["first-project", "项目一"],
    ["retired-project", "已归档项目"],
    ["deleted-project", "已删除项目"],
  ]) {
    await store.createProject(permitted, {
      commandId: "create-" + projectId,
      projectId: projectId!,
      title: title!,
      now: "2026-09-25T00:00:00.000Z",
    });
  }
  const spaces = await store.ensurePersonalSpaces(permitted);
  assert.deepEqual(await store.ensurePersonalSpaces(permitted), spaces);
  await store.createTask(permitted, {
    commandId: "create-task-one",
    taskId: "task-one",
    projectId: "first-project",
    title: "事项一",
    assigneeId: "local-human",
  });
  await store.createTask(permitted, {
    commandId: "create-task-two",
    taskId: "task-two",
    projectId: spaces.deskId,
    title: "事项二",
    assigneeId: "local-human",
  });
  await store.reorderTask(permitted, {
    commandId: "order-across-projects",
    taskId: "task-two",
    beforeTaskId: "task-one",
    expectedOrderRevision: await store.taskOrderRevision(permitted),
  });
  assert.deepEqual(
    (await store.listAccessibleTasks(permitted)).map(({ task_id }) => task_id),
    ["task-two", "task-one"],
  );
  await store.startConversation(permitted, {
    commandId: "start-named-one",
    conversationId: "named-one",
    projectId: "first-project",
    title: "讨论草稿",
    inputFingerprint: "a".repeat(64),
    now: "2026-09-25T00:01:00.000Z",
  });
  await store.updateConversation(permitted, {
    commandId: "revise-named-one",
    conversationId: "named-one",
    expectedRevision: 1,
    title: "设计讨论",
    now: "2026-09-25T00:02:00.000Z",
  });
  await store.startConversation(permitted, {
    commandId: "start-named-archived",
    conversationId: "named-archived",
    projectId: "first-project",
    title: "讨论",
    inputFingerprint: "b".repeat(64),
    now: "2026-09-25T00:03:00.000Z",
  });
  await store.updateConversation(permitted, {
    commandId: "revise-named-archived",
    conversationId: "named-archived",
    expectedRevision: 1,
    title: "已归档讨论",
    now: "2026-09-25T00:03:30.000Z",
  });
  await store.updateConversation(permitted, {
    commandId: "archive-named",
    conversationId: "named-archived",
    expectedRevision: 2,
    archived: true,
    now: "2026-09-25T00:04:00.000Z",
  });
  for (const [projectId, state] of [
    ["retired-project", "archived"],
    ["deleted-project", "deleted"],
  ] as const) {
    const request = {
      commandId: "retire-" + projectId,
      projectId,
      expectedRevision: 1,
      state,
      now: "2026-09-25T00:07:00.000Z",
    };
    await store.beginProjectRetirement(permitted, request);
    assert.deepEqual(
      await store.projectRetirementRuns(
        permitted,
        projectId,
        request.commandId,
      ),
      [],
    );
    await store.completeProjectRetirement(permitted, request);
  }
  assert.equal((await store.listProjects(permitted)).length, 4);
  assert.deepEqual(
    (await store.listProjects(permitted, { status: "archived" })).map(
      (project) => project.project_id,
    ),
    ["retired-project"],
  );
  assert.deepEqual(
    (await store.listProjects(permitted, { status: "deleted" })).map(
      (project) => project.project_id,
    ),
    ["deleted-project"],
  );
  assert.equal(
    (await store.getProject(permitted, "deleted-project")).revision,
    2,
  );
  await assert.rejects(
    store.renameProject(permitted, {
      commandId: "rename-deleted",
      projectId: "deleted-project",
      expectedRevision: 2,
      title: "不能直接编辑已删除项目",
    }),
    /先恢复项目/,
  );
  const active = await store.listConversations(permitted, "first-project");
  assert.deepEqual(
    active.map((conversation) => conversation.conversation_id),
    ["named-one", "first-project"],
  );
  assert.deepEqual(
    (
      await store.listConversations(permitted, "first-project", {
        archived: true,
      })
    ).map((conversation) => conversation.conversation_id),
    ["named-archived"],
  );
  assert.deepEqual(
    (
      await store.listConversations(permitted, "first-project", { limit: 1 })
    ).map((conversation) => conversation.conversation_id),
    ["named-one"],
  );
  assert.deepEqual(
    (
      await store.listConversations(permitted, "first-project", {
        after: {
          updatedAt: active[0]!.updated_at,
          conversationId: active[0]!.conversation_id,
        },
      })
    ).map((conversation) => conversation.conversation_id),
    ["first-project"],
  );
  // A different tenant credential cannot see imported navigation records.
  await assert.rejects(
    store.listConversations(
      { credential: "human:tenant-a:alice" },
      "first-project",
    ),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "forbidden",
  );
  const update = {
    commandId: "rename-and-archive-named",
    conversationId: "named-one",
    expectedRevision: 2,
    title: "修订后的讨论",
    archived: true,
    now: "2026-09-25T00:05:00.000Z",
  };
  assert.equal(await store.updateConversation(permitted, update), "named-one");
  assert.equal(await store.updateConversation(permitted, update), "named-one");
  assert.deepEqual(
    (await store.listConversations(permitted, "first-project")).map(
      (conversation) => conversation.conversation_id,
    ),
    ["first-project"],
  );
  const archived = await store.listConversations(permitted, "first-project", {
    archived: true,
  });
  assert.deepEqual(
    archived.map((conversation) => conversation.conversation_id),
    ["named-one", "named-archived"],
  );
  assert.equal(archived[0]!.title, "修订后的讨论");
  assert.equal(archived[0]!.revision, 3);
  await assert.rejects(
    store.updateConversation(permitted, {
      ...update,
      commandId: "stale-named-update",
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict",
  );
  await assert.rejects(
    store.updateConversation(permitted, {
      commandId: "archive-default",
      conversationId: "first-project",
      expectedRevision: 1,
      archived: true,
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "forbidden",
  );
  await assert.rejects(
    store.updateConversation(permitted, {
      commandId: "invalid-archive-flag",
      conversationId: "first-project",
      expectedRevision: 1,
      archived: "yes" as unknown as boolean,
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "invalid",
  );
  await assert.rejects(
    store.listConversations(permitted, "first-project", {
      archived: "yes" as unknown as boolean,
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "invalid",
  );
  await assert.rejects(
    store.updateConversation(
      { credential: "human:tenant-a:alice" },
      { ...update, commandId: "cross-tenant-conversation" },
    ),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "not_found",
  );
  assert.equal(
    await store.updateConversation(permitted, {
      commandId: "restore-named",
      conversationId: "named-one",
      expectedRevision: 3,
      archived: false,
      now: "2026-09-25T00:06:00.000Z",
    }),
    "named-one",
  );
  assert.deepEqual(
    (await store.listConversations(permitted, "first-project")).map(
      (conversation) => conversation.conversation_id,
    ),
    ["named-one", "first-project"],
  );
  await store.changeProjectState(permitted, {
    commandId: "restore-imported-archive",
    projectId: "retired-project",
    expectedRevision: 2,
    state: "active",
  });
  assert.equal(
    (await store.getProject(permitted, "retired-project")).archived_at,
    null,
  );
  await store.changeProjectState(permitted, {
    commandId: "restore-imported-deletion",
    projectId: "deleted-project",
    expectedRevision: 2,
    state: "active",
  });
  assert.equal(
    (await store.getProject(permitted, "deleted-project")).deleted_at,
    null,
  );
}

test("Platform SQLite 正式项目和命名对话的分页、权限、CAS 与归档恢复", async () => {
  const store = await PlatformStore.sqlite(":memory:", testCapabilities);
  try {
    await exerciseConversationLifecycle(store);
  } finally {
    await store.close();
  }
});

test(
  "Platform PostgreSQL 正式项目和命名对话与 SQLite 同义",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const store = await PlatformStore.postgres(
        { connectionString, schema },
        testCapabilities,
      );
      try {
        await exerciseConversationLifecycle(store);
      } finally {
        await store.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

test("跨 Host 投递尚无法全局核验时，项目退役不建立栅栏也不改状态", async () => {
  const store = await PlatformStore.sqlite(":memory:", testCapabilities);
  const actor = { credential: "human:tenant-a:alice" };
  const request = {
    commandId: "cross-host-retirement",
    projectId: "cross-host-project",
    expectedRevision: 1,
    state: "archived" as const,
  };
  try {
    await store.provisionTenant("tenant-a");
    await store.createProject(actor, {
      commandId: "create-cross-host-project",
      projectId: request.projectId,
      title: "跨 Host 项目",
    });
    const work = new PlatformWorkService(store, "cross-host-unverified");
    await assert.rejects(
      work.changeProjectState(actor, request),
      /跨 Host 的在途消息尚无法核验/,
    );
    const project = await store.getProject(actor, request.projectId);
    assert.equal(project.revision, 1);
    assert.equal(project.archived_at, null);
    assert.equal(
      await store.beginProjectRetirement(actor, request),
      "fenced",
      "拒绝前不能留下阻止后续写入的退役栅栏",
    );
    await store.abortProjectRetirement(actor, request);
  } finally {
    await store.close();
  }
});

async function exerciseProjectRetirementGuard(store: PlatformStore) {
  await store.provisionTenant("tenant-a");
  const alice = { credential: "human:tenant-a:alice" };
  await store.createProject(alice, {
    commandId: "create-retirement-project",
    projectId: "retirement-project",
    title: "尚未退役",
  });
  for (const state of ["archived", "deleted"] as const)
    await assert.rejects(
      store.changeProjectState(alice, {
        commandId: `retire-${state}`,
        projectId: "retirement-project",
        expectedRevision: 1,
        state,
      }),
      /尚未完成运行中工作校验/,
    );
  assert.equal(
    (await store.getProject(alice, "retirement-project")).revision,
    1,
  );
}

async function exerciseProjectRetirementFence(store: PlatformStore) {
  await store.provisionTenant("tenant-a");
  const alice = { credential: "human:tenant-a:alice" };
  const request = {
    commandId: "retire-fenced-project",
    projectId: "fenced-project",
    expectedRevision: 1,
    state: "archived" as const,
  };
  await store.createProject(alice, {
    commandId: "create-fenced-project",
    projectId: request.projectId,
    title: "待核验项目",
  });
  const navigationBefore = await store.conversationNavigation(alice);
  assert.equal(await store.beginProjectRetirement(alice, request), "fenced");
  assert.equal(await store.beginProjectRetirement(alice, request), "fenced");
  assert.deepEqual(
    await store.conversationNavigation(alice),
    navigationBefore,
    "未改变可见状态的退役栅栏不使业务投影失效",
  );
  assert.deepEqual(
    await store.projectRetirementRuns(
      alice,
      request.projectId,
      request.commandId,
    ),
    [],
  );
  assert.equal((await store.getProject(alice, request.projectId)).revision, 1);
  await assert.rejects(
    store.authorizeMessageRoute(alice, {
      projectId: request.projectId,
      conversationId: request.projectId,
      targetActantId: "alice",
    }),
    /正在归档或删除/,
  );
  await assert.rejects(
    store.createTask(alice, {
      commandId: "task-during-retirement",
      taskId: "blocked-task",
      projectId: request.projectId,
      title: "不能新建",
      assigneeId: "alice",
    }),
    /正在归档或删除/,
  );
  await assert.rejects(
    store.renameProject(alice, {
      commandId: "rename-during-retirement",
      projectId: request.projectId,
      expectedRevision: 1,
      title: "不能改名",
    }),
    /正在归档或删除/,
  );
  await assert.rejects(
    store.beginProjectRetirement(alice, {
      ...request,
      commandId: "different-retirement",
    }),
    /另一次归档或删除/,
  );
  await assert.rejects(
    store.abortProjectRetirement(alice, {
      ...request,
      commandId: "different-retirement",
    }),
    /退役请求已变化/,
  );
  await store.abortProjectRetirement(alice, request);
  await store.abortProjectRetirement(alice, request);
  await assert.rejects(
    store.projectRetirementRuns(alice, request.projectId, request.commandId),
    /栅栏不存在/,
  );
  await store.authorizeMessageRoute(alice, {
    projectId: request.projectId,
    conversationId: request.projectId,
    targetActantId: "alice",
  });
  assert.equal((await store.getProject(alice, request.projectId)).revision, 1);
  assert.equal(await store.beginProjectRetirement(alice, request), "fenced");
  assert.equal(
    await store.completeProjectRetirement(alice, request),
    request.projectId,
  );
  assert.equal(await store.beginProjectRetirement(alice, request), "completed");
  assert.equal((await store.getProject(alice, request.projectId)).revision, 2);
  assert.ok((await store.getProject(alice, request.projectId)).archived_at);
  const archivedNavigation = await store.conversationNavigation(alice);
  for (const key of ["projects", "conversations", "tasks", "access"] as const)
    assert.equal(
      archivedNavigation.revisions[key],
      navigationBefore.revisions[key] + 1,
    );
  await store.changeProjectState(alice, {
    commandId: "restore-fenced-project",
    projectId: request.projectId,
    expectedRevision: 2,
    state: "active",
  });
  assert.equal(
    (await store.getProject(alice, request.projectId)).archived_at,
    null,
  );
  const restoredNavigation = await store.conversationNavigation(alice);
  for (const key of ["projects", "conversations", "tasks", "access"] as const)
    assert.equal(
      restoredNavigation.revisions[key],
      archivedNavigation.revisions[key] + 1,
    );
}

test("Platform SQLite 未接 Runtime 栅栏时拒绝项目退役", async () => {
  const store = await PlatformStore.sqlite(":memory:", testCapabilities);
  try {
    await exerciseProjectRetirementGuard(store);
  } finally {
    await store.close();
  }
});

test("Platform SQLite 退役准入栅栏可持久重试、撤销和完成", async () => {
  const store = await PlatformStore.sqlite(":memory:", testCapabilities);
  try {
    await exerciseProjectRetirementFence(store);
  } finally {
    await store.close();
  }
});

test(
  "Platform PostgreSQL 退役准入栅栏与 SQLite 同义",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const store = await PlatformStore.postgres(
        { connectionString, schema },
        testCapabilities,
      );
      try {
        await exerciseProjectRetirementFence(store);
      } finally {
        await store.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

test(
  "Platform PostgreSQL 未接 Runtime 栅栏时拒绝项目退役",
  {
    skip: !process.env.MORPHZ_TEST_POSTGRES_URL,
  },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const store = await PlatformStore.postgres(
        { connectionString, schema },
        testCapabilities,
      );
      try {
        await exerciseProjectRetirementGuard(store);
      } finally {
        await store.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
async function exerciseMessageRoute(store: PlatformStore) {
  await store.provisionTenant("tenant-a");
  const alice = { credential: "human:tenant-a:alice" };
  const spaces = await store.ensurePersonalSpaces(alice);
  await store.createProject(alice, {
    commandId: "create-route-project",
    projectId: "route-project",
    title: "消息路由项目",
  });
  assert.deepEqual(
    await store.authorizeMessageRoute(alice, {
      projectId: "route-project",
      conversationId: "route-project",
      targetActantId: "agent-one",
    }),
    { sharedDefault: false },
  );
  assert.deepEqual(
    await store.authorizeMessageRoute(alice, {
      projectId: "route-project",
      conversationId: spaces.dialogueId,
      targetActantId: "agent-one",
    }),
    { sharedDefault: true },
  );
  await store.authorizeConversationRead(alice, {
    projectId: "route-project",
    conversationId: "route-project",
  });
  await store.authorizeConversationRead(alice, {
    projectId: "route-project",
    conversationId: spaces.dialogueId,
  });
  await assert.rejects(
    store.authorizeConversationRead(
      { credential: "human:tenant-a:bob" },
      {
        projectId: "route-project",
        conversationId: "route-project",
      },
    ),
    /无权访问这个项目/,
  );
  await assert.rejects(
    store.authorizeConversationRead(
      { credential: "human:tenant-b:alice" },
      { projectId: "route-project", conversationId: "route-project" },
    ),
    /无权访问这个项目/,
  );
  await assert.rejects(
    store.authorizeConversationRead(alice, {
      projectId: "route-project",
      conversationId: spaces.inboxId,
    }),
    /对话不属于这个项目/,
  );
  await assert.rejects(
    store.authorizeMessageRoute(
      { credential: "human:tenant-a:bob" },
      {
        projectId: "route-project",
        conversationId: "route-project",
        targetActantId: "agent-one",
      },
    ),
    /无权访问这个项目/,
  );
  await assert.rejects(
    store.authorizeMessageRoute(alice, {
      projectId: "route-project",
      conversationId: spaces.inboxId,
      targetActantId: "agent-one",
    }),
    /对话不属于这个项目/,
  );
}

test("Platform SQLite：消息路由使用当前项目和对话权限", async () => {
  const store = await PlatformStore.sqlite(":memory:", testCapabilities);
  try {
    await exerciseMessageRoute(store);
  } finally {
    await store.close();
  }
});

test(
  "Platform PostgreSQL：消息路由与 SQLite 权限同义",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const store = await PlatformStore.postgres(
        { connectionString, schema },
        testCapabilities,
      );
      try {
        await exerciseMessageRoute(store);
      } finally {
        await store.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

async function exerciseRetiredProjectRead(store: PlatformStore) {
  await store.provisionTenant("tenant-local");
  const access = { credential: "human:tenant-local:local-owner" };
  await store.createProject(access, {
    commandId: "create-retired-project",
    projectId: "first-project",
    title: "归档项目",
  });
  const taskId = await store.createTask(access, {
    commandId: "create-retired-task",
    taskId: "retired-task",
    projectId: "first-project",
    title: "归档前的事项",
    description: "需要保留历史",
    assigneeId: "local-human",
  });
  const orderBefore = await store.taskOrderRevision(access, "first-project");
  const retirement = {
    commandId: "archive-task-project",
    projectId: "first-project",
    expectedRevision: 1,
    state: "archived" as const,
  };
  await store.beginProjectRetirement(access, retirement);
  assert.deepEqual(
    await store.projectRetirementRuns(
      access,
      "first-project",
      retirement.commandId,
    ),
    [],
  );
  await store.completeProjectRetirement(access, retirement);
  assert.deepEqual(
    (await store.listConversations(access, "first-project")).map(
      ({ conversation_id }) => conversation_id,
    ),
    ["first-project"],
  );
  assert.deepEqual(
    (await store.listTasks(access, "first-project")).map(
      ({ task_id }) => task_id,
    ),
    [taskId],
  );
  assert.equal((await store.taskVersion(access, taskId)).title, "归档前的事项");
  assert.deepEqual(await store.listTaskRunLinks(access, taskId), []);
  assert.deepEqual(await store.listTaskResponses(access, taskId), []);
  assert.equal(
    await store.taskOrderRevision(access, "first-project"),
    orderBefore,
  );
  assert.deepEqual(await store.listAccessibleTasks(access), []);
  await assert.rejects(
    store.reviseTask(access, {
      commandId: "edit-retired-task",
      taskId: taskId,
      expectedRevision: 1,
      title: "不允许修改",
    }),
    /无权访问这个项目/,
  );
  await assert.rejects(
    store.updateConversation(access, {
      commandId: "edit-retired-conversation",
      conversationId: "first-project",
      expectedRevision: 1,
      title: "不允许修改",
    }),
    /无权访问这个项目/,
  );
}

test("Platform SQLite：归档项目可读历史，不能改写，日常事项不显示", async () => {
  const store = await PlatformStore.sqlite(":memory:", testCapabilities);
  try {
    await exerciseRetiredProjectRead(store);
  } finally {
    await store.close();
  }
});

test(
  "Platform PostgreSQL：归档项目读取与 SQLite 同义",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const store = await PlatformStore.postgres(
        { connectionString, schema },
        testCapabilities,
      );
      try {
        await exerciseRetiredProjectRead(store);
      } finally {
        await store.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

test(
  "Platform PostgreSQL：项目写入锁定当前项目与成员直到提交",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    let releaseAuthorization!: () => void;
    const authorizationReleased = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    let reachedAuthorization!: () => void;
    const authorizationReached = new Promise<void>((resolve) => {
      reachedAuthorization = resolve;
    });
    let agentResolutionCount = 0;
    const capabilities: PlatformAuthorityVerifier = {
      ...testCapabilities,
      async resolveActant(request) {
        const actant = await testCapabilities.resolveActant(request);
        if (request.actantId === "agent-one" && ++agentResolutionCount === 2) {
          reachedAuthorization();
          await authorizationReleased;
        }
        return actant;
      },
    };
    let store: PlatformStore | undefined;
    try {
      store = await PlatformStore.postgres(
        { connectionString, schema },
        capabilities,
      );
      await store.provisionTenant("tenant-a");
      await store.createProject(
        { credential: "human:tenant-a:alice" },
        {
          commandId: "create-p1-for-lock-test",
          projectId: "p1",
          title: "并发写入项目",
        },
      );
      const pending = store.createTask(
        { credential: "agent:input-one" },
        {
          commandId: "create-task-with-project-lock",
          taskId: "locked-task",
          projectId: "p1",
          title: "并发写入事项",
          assigneeId: "agent-one",
        },
      );
      try {
        await Promise.race([
          authorizationReached,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("未进入项目写入授权阶段。")),
              5000,
            ),
          ),
        ]);
        await assert.rejects(
          admin.query(
            `SELECT project_id FROM "${schema}".projects WHERE tenant_id='tenant-a' AND project_id='p1' FOR UPDATE NOWAIT`,
          ),
          (error: unknown) =>
            error instanceof Error && "code" in error && error.code === "55P03",
        );
        await assert.rejects(
          admin.query(
            `SELECT principal_id FROM "${schema}".project_members WHERE tenant_id='tenant-a' AND project_id='p1' AND principal_id='alice' FOR UPDATE NOWAIT`,
          ),
          (error: unknown) =>
            error instanceof Error && "code" in error && error.code === "55P03",
        );
      } finally {
        releaseAuthorization();
      }
      assert.equal(await pending, "locked-task");
    } finally {
      await store?.close();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

async function exerciseTaskRunAdmission(store: PlatformStore) {
  const alice = { credential: "human:tenant-a:alice" };
  await store.provisionTenant("tenant-a");
  await store.createProject(alice, {
    commandId: "create-run-project",
    projectId: "p1",
    title: "执行项目",
  });
  await store.createTask(alice, {
    commandId: "create-run-task",
    taskId: "run-task",
    projectId: "p1",
    title: "编排执行",
    assigneeId: "agent-one",
  });
  const request = {
    commandId: "start-run-task",
    taskId: "run-task",
    expectedRevision: 1,
    sessionId: "session-one",
    intent: "整理本轮工作",
    notBefore: "2026-09-26T00:00:00.000Z",
    now: "2026-09-26T00:00:00.000Z",
  };
  const admission = await store.requestTaskRun(alice, request);
  assert.equal(admission.taskRevision, 2);
  assert.equal(admission.runNumber, 1);
  assert.equal(admission.humanActantId, "alice");
  assert.equal(admission.sourceInputId, null);
  assert.equal(admission.request.intent, request.intent);
  assert.deepEqual(admission.request.dependency_thread_ids, []);
  assert.equal(
    (await store.taskVersion(alice, "run-task")).execution,
    "waiting",
  );
  assert.deepEqual(await store.pendingTaskRuns("tenant-a"), [admission]);
  await assert.rejects(
    store.reviseTask(alice, {
      commandId: "change-active-model",
      taskId: "run-task",
      expectedRevision: 2,
      modelId: "other-model",
    }),
    /先停止执行再修改安排/,
  );
  assert.equal(admission.eventId, `task_run_${admission.request.id.slice(5)}`);
  assert.deepEqual(
    await store.taskRunAdmissionForRuntime(
      "tenant-a",
      admission.sessionId,
      admission.request.id,
    ),
    admission,
  );
  for (const [tenantId, sessionId, scheduleId] of [
    ["other-tenant", admission.sessionId, admission.request.id],
    ["tenant-a", "wrong-session", admission.request.id],
    ["tenant-a", admission.sessionId, "task_" + "0".repeat(40)],
  ])
    await assert.rejects(
      store.taskRunAdmissionForRuntime(tenantId!, sessionId!, scheduleId!),
      (error: unknown) =>
        error instanceof PlatformStorageError && error.code === "not_found",
    );
  assert.deepEqual(await store.requestTaskRun(alice, request), admission);
  await assert.rejects(
    store.requestTaskRun(alice, { ...request, intent: "不同请求" }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict",
  );
  const receipt = {
    schedule: {
      id: admission.request.id,
      thread_id: "thread-run-one",
      revision: 1,
      status: "queued" as const,
      not_before: admission.request.not_before,
      interval_seconds: null,
    },
    thread: {
      thread_id: "thread-run-one",
      session_id: admission.sessionId,
      root_turn_id: `client-schedule-${admission.request.id}`,
      lifecycle: "open" as const,
    },
  };
  await assert.rejects(
    store.confirmTaskRun("tenant-a", admission.eventId, {
      ...receipt,
      thread: { ...receipt.thread, session_id: "wrong-session" },
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict",
  );
  assert.deepEqual(await store.pendingTaskRuns("tenant-a"), [admission]);
  assert.deepEqual(
    await store.confirmTaskRun("tenant-a", admission.eventId, receipt),
    {
      taskId: "run-task",
      runNumber: 1,
    },
  );
  assert.deepEqual(
    await store.confirmTaskRun("tenant-a", admission.eventId, receipt),
    {
      taskId: "run-task",
      runNumber: 1,
    },
  );
  assert.deepEqual(await store.pendingTaskRuns("tenant-a"), []);
  assert.deepEqual(
    await store.taskRunAdmissionForRuntime(
      "tenant-a",
      admission.sessionId,
      admission.request.id,
    ),
    admission,
  );
  const links = await store.listTaskRunLinks(alice, "run-task");
  assert.equal(links.length, 1);
  assert.equal(links[0]!.runtime.scheduleId, admission.request.id);
  assert.equal(links[0]!.runtime.threadId, "thread-run-one");
  const secondRequest = {
    ...request,
    commandId: "second-run-after-reconciliation",
    expectedRevision: 2,
  };
  const terminal = {
    source: "runtime" as const,
    runtime: links[0]!.runtime,
    schedule: { status: "completed" },
    thread: { lifecycle: "completed" },
  };
  await assert.rejects(store.requestTaskRun(alice, secondRequest));
  await assert.rejects(
    store.requestTaskRun(alice, secondRequest, {
      ...terminal,
      runtime: { ...terminal.runtime, threadId: "wrong-thread" },
    }),
  );
  await assert.rejects(
    store.requestTaskRun(alice, secondRequest, {
      ...terminal,
      schedule: { status: "dispatched" },
    }),
  );
  const next = await store.requestTaskRun(alice, secondRequest, terminal);
  assert.equal(next.runNumber, 2);
  assert.deepEqual(await store.requestTaskRun(alice, secondRequest), next);
  assert.deepEqual(await store.pendingTaskRuns("tenant-a"), [next]);

  await store.createTask(alice, {
    commandId: "create-agent-requested-task",
    taskId: "agent-requested-task",
    projectId: "p1",
    title: "由 Agent 发起执行",
    assigneeId: "agent-one",
  });
  const agentRequest = await store.requestTaskRun(
    { credential: "agent:input-one" },
    {
      commandId: "agent-requested-run",
      taskId: "agent-requested-task",
      expectedRevision: 1,
      sessionId: "session-agent-request",
      intent: "读取事项后处理",
      notBefore: "2026-09-26T00:00:00.000Z",
    },
  );
  assert.equal(agentRequest.principalId, "alice");
  assert.equal(agentRequest.humanActantId, "alice");
  assert.equal(agentRequest.sourceInputId, "input-one");
}

test("Platform SQLite：事项执行准入、幂等回执与持久关联", async () => {
  const store = await PlatformStore.sqlite(":memory:", testCapabilities);
  try {
    await exerciseTaskRunAdmission(store);
  } finally {
    await store.close();
  }
});

test("Platform SQLite：未确认的执行请求在 Host 重启后保留原请求", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-platform-admission-"));
  const file = join(directory, "platform.sqlite");
  const alice = { credential: "human:tenant-a:alice" };
  let store: PlatformStore | undefined;
  try {
    store = await PlatformStore.sqlite(file, testCapabilities);
    await store.provisionTenant("tenant-a");
    await store.createProject(alice, {
      commandId: "create-restart-project",
      projectId: "p1",
      title: "重启验证",
    });
    await store.createTask(alice, {
      commandId: "create-restart-task",
      taskId: "restart-task",
      projectId: "p1",
      title: "重启后执行",
      assigneeId: "agent-one",
    });
    const request = {
      commandId: "start-restart-task",
      taskId: "restart-task",
      expectedRevision: 1,
      sessionId: "session-restart",
      intent: "重启后重试同一个安排",
      notBefore: "2026-09-26T00:00:00.000Z",
    };
    const admission = await store.requestTaskRun(alice, request);
    await store.close();
    store = await PlatformStore.sqlite(file, testCapabilities);
    assert.deepEqual(await store.pendingTaskRuns("tenant-a"), [admission]);
    assert.deepEqual(
      await store.taskRunAdmissionForRuntime(
        "tenant-a",
        admission.sessionId,
        admission.request.id,
      ),
      admission,
    );
    assert.deepEqual(await store.requestTaskRun(alice, request), admission);
    await store.confirmTaskRun("tenant-a", admission.eventId, {
      schedule: {
        id: admission.request.id,
        thread_id: "thread-restart",
        revision: 1,
        status: "queued",
        not_before: admission.request.not_before,
        interval_seconds: null,
      },
      thread: {
        thread_id: "thread-restart",
        session_id: admission.sessionId,
        root_turn_id: `client-schedule-${admission.request.id}`,
        lifecycle: "open",
      },
    });
    await store.close();
    store = await PlatformStore.sqlite(file, testCapabilities);
    assert.deepEqual(await store.pendingTaskRuns("tenant-a"), []);
    assert.equal(
      (await store.listTaskRunLinks(alice, "restart-task")).length,
      1,
    );
  } finally {
    await store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "Platform PostgreSQL：事项执行准入与 SQLite 同义",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const store = await PlatformStore.postgres(
        { connectionString, schema },
        testCapabilities,
      );
      try {
        await exerciseTaskRunAdmission(store);
      } finally {
        await store.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

test(
  "Platform PostgreSQL：并发重复执行请求只产生一个 Schedule 准入",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    let first: PlatformStore | undefined;
    let second: PlatformStore | undefined;
    try {
      [first, second] = await Promise.all([
        PlatformStore.postgres({ connectionString, schema }, testCapabilities),
        PlatformStore.postgres({ connectionString, schema }, testCapabilities),
      ]);
      const alice = { credential: "human:tenant-a:alice" };
      await first.provisionTenant("tenant-a");
      await first.createProject(alice, {
        commandId: "create-concurrent-run-project",
        projectId: "p1",
        title: "并发执行",
      });
      await first.createTask(alice, {
        commandId: "create-concurrent-run-task",
        taskId: "run-task",
        projectId: "p1",
        title: "一次执行",
        assigneeId: "agent-one",
      });
      const request = {
        commandId: "same-concurrent-run-command",
        taskId: "run-task",
        expectedRevision: 1,
        sessionId: "session-one",
        intent: "只运行一次",
        notBefore: "2026-09-26T00:00:00.000Z",
      };
      const [left, right] = await Promise.all([
        first.requestTaskRun(alice, request),
        second.requestTaskRun(alice, request),
      ]);
      assert.deepEqual(left, right);
      assert.deepEqual(await first.pendingTaskRuns("tenant-a"), [left]);
      assert.equal((await first.taskVersion(alice, "run-task")).revision, 2);
    } finally {
      await first?.close();
      await second?.close();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

async function exerciseHumanTaskDependency(store: PlatformStore) {
  await store.provisionTenant("tenant-local");
  const access = { credential: "human:tenant-local:local-owner" };
  await store.createProject(access, {
    commandId: "create-dependency-project",
    projectId: "first-project",
    title: "人工交付项目",
  });
  const firstId = await store.createTask(access, {
    commandId: "create-dependency-source",
    taskId: "source-task",
    projectId: "first-project",
    title: "前置事项",
    description: "人工交付",
    assigneeId: "local-human",
  });
  const dependentId = await store.createTask(access, {
    commandId: "create-dependent-task",
    taskId: "dependent-task",
    projectId: "first-project",
    title: "后续事项",
    description: "人工交付",
    assigneeId: "local-human",
    dependsOnIds: [firstId],
  });
  await assert.rejects(
    store.setTaskCompleted(access, {
      commandId: "premature-completion",
      taskId: firstId,
      expectedRevision: 1,
      completed: true,
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "invalid",
  );
  assert.equal((await store.taskVersion(access, firstId)).revision, 1);
  await store.setTaskCompleted(access, {
    commandId: "finish-dependent",
    taskId: dependentId,
    expectedRevision: 1,
    completed: true,
  });
  await store.setTaskCompleted(access, {
    commandId: "finish-source",
    taskId: firstId,
    expectedRevision: 1,
    completed: true,
  });
  assert.equal(
    (await store.taskVersion(access, firstId)).execution,
    "completed",
  );
}

test("Platform SQLite：人工完成受当前依赖和版本约束", async () => {
  const store = await PlatformStore.sqlite(":memory:", testCapabilities);
  try {
    await exerciseHumanTaskDependency(store);
  } finally {
    await store.close();
  }
});

test(
  "Platform PostgreSQL：人工完成与 SQLite 语义相同",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const store = await PlatformStore.postgres(
        { connectionString, schema },
        testCapabilities,
      );
      try {
        await exerciseHumanTaskDependency(store);
      } finally {
        await store.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

const scopedCapabilities: PlatformAuthorityVerifier = {
  ...testCapabilities,
  async resolveActor(access) {
    if (access.credential === "agent:scoped-project")
      return {
        tenantId: "tenant-a",
        principalId: "alice",
        actantId: "agent-one",
        kind: "agent",
        runtimeInputId: "input-one",
        scopeProjectId: "project-one",
      };
    if (access.credential === "agent:unscoped")
      return {
        tenantId: "tenant-a",
        principalId: "alice",
        actantId: "agent-one",
        kind: "agent",
        runtimeInputId: "input-one",
      };
    if (access.credential === "agent:missing-origin")
      return {
        tenantId: "tenant-a",
        principalId: "alice",
        actantId: "agent-one",
        kind: "agent",
        runtimeInputId: "input-one",
        scopeProjectId: "missing-project",
      };
    return testCapabilities.resolveActor(access);
  },
};

async function exerciseAgentProjectScope(store: PlatformStore) {
  await store.provisionTenant("tenant-a");
  for (const projectId of ["project-one", "project-two"])
    await store.createProject(
      { credential: "human:tenant-a:alice" },
      {
        commandId: `create-${projectId}`,
        projectId,
        title: projectId,
      },
    );
  await store.registerApplication("tenant-a", {
    appId: "morphz.script-studio",
    installationId: "install-one",
    instanceId: "studio-one",
    routeKind: "service",
    routeRef: "test:studio-one",
  });
  const agent = { credential: "agent:scoped-project" };
  await assert.rejects(
    store.createProject(
      { credential: "agent:unscoped" },
      {
        commandId: "unscoped-create",
        projectId: "unscoped-project",
        title: "不应创建",
      },
    ),
    /缺少原始输入的项目范围/,
  );
  await assert.rejects(
    store.listAccessibleTasks({ credential: "agent:unscoped" }),
    /缺少原始输入的项目范围/,
  );
  await assert.rejects(
    store.listAccessibleTasks({ credential: "agent:missing-origin" }),
    /无权访问这个项目/,
  );
  await assert.rejects(
    store.createProject(
      { credential: "agent:missing-origin" },
      {
        commandId: "missing-origin-create",
        projectId: "missing-origin-output",
        title: "不应创建",
      },
    ),
    /无权访问这个项目/,
  );
  assert.equal(
    await store.createProject(agent, {
      commandId: "agent-create-project",
      projectId: "agent-created",
      title: "Agent 从真实输入创建",
    }),
    "agent-created",
  );
  assert.equal(
    (
      await store.getProject(
        { credential: "human:tenant-a:alice" },
        "agent-created",
      )
    ).owner_principal_id,
    "alice",
  );
  assert.deepEqual(
    (
      await store.listConversations(
        { credential: "human:tenant-a:alice" },
        "agent-created",
      )
    ).map((conversation) => conversation.conversation_id),
    ["agent-created"],
  );
  await assert.rejects(
    store.createTask(agent, {
      commandId: "unscoped-followup",
      taskId: "bad-followup",
      projectId: "agent-created",
      title: "不能用旧输入写新项目",
      assigneeId: "agent-one",
    }),
    /超出原始输入/,
  );
  assert.deepEqual(
    (await store.listProjects(agent)).map((project) => project.project_id),
    ["project-one"],
  );
  assert.deepEqual(
    (await store.getProject(agent, "project-one")).member_principal_ids,
    ["alice", "morphz-service"],
  );
  await assert.rejects(store.getProject(agent, "project-two"), /超出原始输入/);
  await assert.rejects(
    store.renameProject(agent, {
      commandId: "rename-other-project",
      projectId: "project-two",
      expectedRevision: 1,
      title: "越权修改",
    }),
    /超出原始输入/,
  );
  assert.equal(
    (
      await store.authorizeApplicationProject(
        agent,
        "studio-one",
        "morphz.script-studio",
        "project-one",
      )
    ).runtimeInputId,
    "input-one",
  );
  await assert.rejects(
    store.authorizeApplicationProject(
      agent,
      "studio-one",
      "morphz.script-studio",
      "project-two",
    ),
    /超出原始输入/,
  );
}

test("Platform SQLite：Agent 有两个项目成员身份也不能越过输入项目", async () => {
  const store = await PlatformStore.sqlite(":memory:", scopedCapabilities);
  try {
    await exerciseAgentProjectScope(store);
  } finally {
    await store.close();
  }
});

test(
  "Platform PostgreSQL：Agent 输入项目边界与 SQLite 一致",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const store = await PlatformStore.postgres(
        { connectionString, schema },
        scopedCapabilities,
      );
      try {
        await exerciseAgentProjectScope(store);
      } finally {
        await store.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

async function exercisePersonalConversationProjectReach(
  store: PlatformStore,
  setPersonalScope: (id: string) => void,
) {
  const human = { credential: "human:tenant-a:alice" };
  const agent = { credential: "agent:personal-conversation" };
  await store.provisionTenant("tenant-a");
  const spaces = await store.ensurePersonalSpaces(human);
  setPersonalScope(spaces.deskId);
  for (const id of ["personal-project-one", "personal-project-two"])
    await store.createProject(human, {
      commandId: `create-${id}`,
      projectId: id,
      title: id,
    });
  const firstPage = await store.listProjects(agent, {
    query: "personal-project",
    limit: 1,
  });
  const secondPage = await store.listProjects(agent, {
    query: "personal-project",
    limit: 1,
    offset: 1,
  });
  assert.deepEqual(
    [...firstPage, ...secondPage].map((project) => project.project_id).sort(),
    ["personal-project-one", "personal-project-two"],
  );
  assert.deepEqual(
    await store.listProjects(agent, { query: "%", limit: 10 }),
    [],
    "项目搜索必须把 SQL 通配符当普通文字",
  );
  assert.equal(
    (await store.getProject(agent, "personal-project-two")).title,
    "personal-project-two",
  );
  assert.equal(
    await store.createTask(agent, {
      commandId: "personal-task-command",
      taskId: "personal-task",
      projectId: "personal-project-two",
      title: "普通对话跨项目事项",
      assigneeId: "alice",
    }),
    "personal-task",
  );
  assert.equal(
    (await store.taskVersion(agent, "personal-task")).project_id,
    "personal-project-two",
  );
  await store.reconcileOperatorMembers("tenant-a", [
    {
      principalId: "alice",
      actantId: "alice",
      projectIds: ["personal-project-one", "personal-project-two"],
      enabled: true,
    },
    {
      principalId: "bob",
      actantId: "bob",
      projectIds: ["personal-project-two"],
      enabled: true,
    },
  ]);
  assert.deepEqual(
    (await store.listProjects(agent, { query: "personal-project" })).map(
      (project) => project.project_id,
    ),
    ["personal-project-one"],
    "新增项目成员后，普通对话不能继续发现更大受众的项目",
  );
  await assert.rejects(
    store.createTask(agent, {
      commandId: "personal-task-cross-audience",
      taskId: "forbidden-task",
      projectId: "personal-project-two",
      title: "不应创建",
      assigneeId: "alice",
    }),
    /超出原始输入/,
  );
  await assert.rejects(
    store.taskVersion(agent, "personal-task"),
    /超出原始输入/,
  );
  assert.equal(
    (await store.taskVersion(human, "personal-task")).title,
    "普通对话跨项目事项",
    "撤权不删除既有事项原件",
  );
}

function personalConversationCapabilities(scope: () => string) {
  return {
    ...scopedCapabilities,
    async resolveActor(access: PlatformActor) {
      if (access.credential === "agent:personal-conversation")
        return {
          tenantId: "tenant-a",
          principalId: "alice",
          actantId: "agent-one",
          kind: "agent" as const,
          runtimeInputId: "personal-input",
          initiatingHumanActantId: "alice",
          scopeProjectId: scope(),
        };
      return scopedCapabilities.resolveActor(access);
    },
  } satisfies PlatformAuthorityVerifier;
}

test("Platform SQLite：个人对话可操作同受众项目，成员变化立即撤权", async () => {
  let scope = "uninitialized";
  const store = await PlatformStore.sqlite(
    ":memory:",
    personalConversationCapabilities(() => scope),
  );
  try {
    await exercisePersonalConversationProjectReach(store, (id) => {
      scope = id;
    });
  } finally {
    await store.close();
  }
});

test(
  "Platform PostgreSQL：个人对话跨项目范围与 SQLite 一致",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    let scope = "uninitialized";
    try {
      const store = await PlatformStore.postgres(
        { connectionString, schema },
        personalConversationCapabilities(() => scope),
      );
      try {
        await exercisePersonalConversationProjectReach(store, (id) => {
          scope = id;
        });
      } finally {
        await store.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

async function exerciseAgentCatalogBoundary(
  store: PlatformStore,
  revokeExecutor: () => void,
) {
  const human = { credential: "human:tenant-a:alice" };
  const agent = { credential: "agent:scoped-project" };
  await store.provisionTenant("tenant-a");
  for (const projectId of ["project-one", "project-two"])
    await store.createProject(human, {
      commandId: `create-${projectId}`,
      projectId,
      title: projectId,
    });
  await store.registerApplication("tenant-a", {
    appId: "morphz.script-studio",
    installationId: "install-one",
    instanceId: "studio-one",
    routeKind: "service",
    routeRef: "test:studio-one",
  });
  for (const [projectId, objectId] of [
    ["project-one", "script-one"],
    ["project-two", "script-two"],
  ] as const) {
    const title = objectId;
    const receiptId = `receipt-${objectId}`;
    await store.recordContent(
      human,
      {
        instanceId: "studio-one",
        proof: `committed:tenant-a:studio-one:${objectId}:v1:${receiptId}:${title}`,
      },
      {
        commandId: `record-${objectId}`,
        appReceiptId: receiptId,
        contentId: `content-${objectId}`,
        objectId,
        projectId,
        kind: "script",
        title,
        observedVersionRef: "v1",
      },
    );
  }
  assert.deepEqual(
    (await store.listContent(agent)).map((row) => row.content_id),
    ["content-script-one"],
  );
  await assert.rejects(
    store.listContent(agent, { projectId: "project-two" }),
    /超出原始输入/,
  );
  await assert.rejects(
    store.content(agent, "content-script-two"),
    /超出原始输入/,
  );
  assert.equal(
    (
      await store.authorizeApplicationObject(
        agent,
        "studio-one",
        "morphz.script-studio",
        "script-one",
        "read",
      )
    ).projectId,
    "project-one",
  );

  revokeExecutor();
  for (const read of [
    () => store.listProjects(agent),
    () => store.getProject(agent, "project-one"),
    () => store.listAccessibleTasks(agent),
    () => store.listContent(agent),
    () => store.content(agent, "content-script-one"),
    () =>
      store.authorizeApplicationObject(
        agent,
        "studio-one",
        "morphz.script-studio",
        "script-one",
        "read",
      ),
    () =>
      store.authorizeApplicationObject(
        agent,
        "studio-one",
        "morphz.script-studio",
        "script-one",
        "write",
      ),
  ])
    await assert.rejects(read(), /Agent 已不在原始输入所属项目中/);
  assert.equal((await store.listContent(human)).length, 2);
}

function revocableAgentCapabilities() {
  let executorPrincipal = "morphz-service";
  const capabilities: PlatformAuthorityVerifier = {
    ...scopedCapabilities,
    async resolveActant(request) {
      if (request.actantId === "agent-one")
        return { principalId: executorPrincipal, kind: "agent" };
      return testCapabilities.resolveActant(request);
    },
  };
  return {
    capabilities,
    revokeExecutor: () => {
      executorPrincipal = "revoked-agent";
    },
  };
}

test("Platform SQLite：目录受输入项目和实时 Agent 成员资格约束", async () => {
  const { capabilities, revokeExecutor } = revocableAgentCapabilities();
  const store = await PlatformStore.sqlite(":memory:", capabilities);
  try {
    await exerciseAgentCatalogBoundary(store, revokeExecutor);
  } finally {
    await store.close();
  }
});

test(
  "Platform PostgreSQL：目录与 SQLite 使用相同的实时 Agent 边界",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const { capabilities, revokeExecutor } = revocableAgentCapabilities();
      const store = await PlatformStore.postgres(
        { connectionString, schema },
        capabilities,
      );
      try {
        await exerciseAgentCatalogBoundary(store, revokeExecutor);
      } finally {
        await store.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

async function exercise(store: PlatformStore) {
  const alice = { credential: "human:tenant-a:alice" };
  const bob = { credential: "human:tenant-a:bob" };
  const other = { credential: "human:tenant-b:alice" };
  await store.provisionTenant("tenant-a");
  await store.provisionTenant("tenant-b");

  const first = {
    commandId: "create-p1",
    projectId: "p1",
    title: "项目一",
    now: "2026-09-25T00:00:00.000Z",
  };
  await assert.rejects(
    store.createProject({ credential: "unknown" }, first),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "forbidden",
  );
  await assert.rejects(
    store.createProject({ credential: "agent:missing-input" }, first),
    /已持久化的发起来源/,
  );
  assert.equal(await store.createProject(alice, first), "p1");
  assert.equal(await store.createProject(alice, first), "p1");
  assert.deepEqual(
    (await store.listConversations(alice, "p1")).map((conversation) => [
      conversation.conversation_id,
      conversation.kind,
      conversation.revision,
    ]),
    [["p1", "default", 1]],
  );
  await assert.rejects(
    store.createProject({ credential: "unknown" }, first),
    /操作身份已失效/,
  );
  assert.deepEqual(
    await Promise.all([
      store.createProject(alice, {
        commandId: "concurrent",
        projectId: "concurrent-project",
        title: "并发项目",
      }),
      store.createProject(alice, {
        commandId: "concurrent",
        projectId: "concurrent-project",
        title: "并发项目",
      }),
    ]),
    ["concurrent-project", "concurrent-project"],
  );
  assert.equal(
    (await store.listConversations(alice, "concurrent-project")).length,
    1,
  );
  await assert.rejects(
    store.createProject(alice, { ...first, title: "不同项目" }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict",
  );
  await assert.rejects(
    store.createProject(alice, {
      commandId: "forge-internal-space",
      projectId: "forged-desk",
      title: "伪造默认空间",
      kind: "desk",
    } as Parameters<PlatformStore["createProject"]>[1]),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "invalid",
  );
  await store.createProject(alice, {
    commandId: "create-p2",
    projectId: "p2",
    title: "项目二",
  });
  await store.createProject(other, first);
  const projects = await store.listProjects(alice);
  assert.deepEqual(
    new Set(projects.map((project) => project.project_id)),
    new Set(["p1", "p2", "concurrent-project"]),
  );
  assert.deepEqual(
    projects.find((project) => project.project_id === "p1")
      ?.member_principal_ids,
    ["alice", "morphz-service"],
  );
  assert.deepEqual(
    (await store.listProjects(other)).map((project) => project.project_id),
    ["p1"],
  );
  assert.deepEqual(await store.listProjects(bob), []);
  const project = await store.getProject(alice, "p1");
  assert.equal(project.revision, 1);
  assert.deepEqual(project.member_principal_ids, ["alice", "morphz-service"]);
  await assert.rejects(
    store.getProject(bob, "p1"),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "forbidden",
  );
  const firstProjectPage = await store.listProjects(alice, { limit: 1 });
  const secondProjectPage = await store.listProjects(alice, {
    limit: 1,
    after: {
      updatedAt: firstProjectPage[0]!.updated_at,
      projectId: firstProjectPage[0]!.project_id,
    },
  });
  assert.notEqual(
    firstProjectPage[0]!.project_id,
    secondProjectPage[0]!.project_id,
  );
  const rename = {
    commandId: "rename-p1",
    projectId: "p1",
    expectedRevision: 1,
    title: "修订后的项目",
    now: "2026-09-25T00:01:00.000Z",
  };
  assert.equal(await store.renameProject(alice, rename), "p1");
  assert.equal(await store.renameProject(alice, rename), "p1");
  assert.equal((await store.getProject(alice, "p1")).title, rename.title);
  assert.equal((await store.getProject(alice, "p1")).revision, 2);
  await assert.rejects(
    store.renameProject(alice, { ...rename, commandId: "stale-rename" }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict",
  );
  await assert.rejects(
    store.renameProject(bob, { ...rename, commandId: "bob-rename" }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "forbidden",
  );
  await assert.rejects(
    store.renameProject(alice, { ...rename, title: "另一标题" }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict",
  );
  await assert.rejects(
    store.renameProject(alice, {
      ...rename,
      commandId: "invalid-rename-title",
      title: ["绕过类型"] as unknown as string,
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "invalid",
  );
  await assert.rejects(
    store.listProjects(alice, {
      after: { updatedAt: "bad", projectId: "p1" },
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "invalid",
  );
  const task = {
    commandId: "create-task-1",
    taskId: "task-1",
    projectId: "p1",
    title: "落实剧本大纲",
    description: "只存事项，不存剧本正文",
    assigneeId: "alice",
  };
  await assert.rejects(
    store.createTask(alice, {
      ...task,
      commandId: "unknown-assignee",
      assigneeId: "unknown",
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "forbidden",
  );
  await assert.rejects(store.createTask(bob, task));
  assert.equal(await store.createTask(alice, task), "task-1");
  assert.equal(await store.createTask(alice, task), "task-1");
  const originalTask = await store.taskVersion(alice, "task-1");
  assert.equal(originalTask.revision, 1);
  assert.equal(originalTask.title, "落实剧本大纲");
  assert.equal(originalTask.description, "只存事项，不存剧本正文");
  assert.equal(originalTask.assignment, "proposed");
  assert.equal(originalTask.run_requested, 0);
  assert.deepEqual(originalTask.result_ids, []);
  await assert.rejects(store.taskVersion(bob, "task-1"));
  await store.createTask(alice, {
    ...task,
    commandId: "create-task-other-project",
    taskId: "task-other-project",
    projectId: "p2",
    title: "另一个项目的事项",
  });
  const otherProjectRank = (await store.listTasks(alice, "p2"))[0]!.order_rank;
  await store.createTask(alice, {
    ...task,
    commandId: "create-task-2",
    taskId: "task-2",
    title: "复核",
  });
  await store.createTask(other, {
    commandId: "tenant-b-task",
    taskId: "tenant-b-task",
    projectId: "p1",
    title: "另一个租户的事项",
    assigneeId: "alice",
  });
  assert.deepEqual(
    (await store.listAccessibleTasks(other)).map(({ task_id }) => task_id),
    ["tenant-b-task"],
  );
  const aliceTaskCounts = await store.taskCounts(alice);
  assert.deepEqual(
    aliceTaskCounts.map(({ latestActivityAt: _, ...count }) => count),
    [
      { projectId: "p1", total: 2, pending: 2, mineOpen: 2 },
      { projectId: "p2", total: 1, pending: 1, mineOpen: 1 },
    ],
  );
  assert.equal(
    aliceTaskCounts[0]?.latestActivityAt,
    (await store.listTasks(alice, "p1"))
      .map((row) => row.updated_at)
      .sort()
      .at(-1),
  );
  assert.deepEqual(await store.taskCounts(bob), []);
  assert.deepEqual(
    (await store.taskCounts(other)).map(
      ({ latestActivityAt: _, ...count }) => count,
    ),
    [{ projectId: "p1", total: 1, pending: 1, mineOpen: 1 }],
  );
  assert.deepEqual(
    (await store.taskCounts({ credential: "agent:input-one" })).map(
      ({ latestActivityAt: _, ...count }) => count,
    ),
    [{ projectId: "p1", total: 2, pending: 2, mineOpen: 0 }],
  );
  assert.equal(
    (await store.taskHead(alice, "task-1")).head_version.revision,
    1,
  );
  await assert.rejects(store.taskHead(bob, "task-1"));
  await assert.rejects(
    store.taskHead({ credential: "agent:input-one" }, "task-other-project"),
  );
  const overview = await store.listAccessibleTasks(alice);
  assert.equal(overview[0]!.head_version.revision, 1);
  assert.equal(overview[0]!.head_version.description, originalTask.description);
  assert.equal(overview[0]!.created_by_principal_id, "alice");
  assert.deepEqual(
    overview.map(({ task_id, project_id }) => [task_id, project_id]),
    [
      ["task-1", "p1"],
      ["task-other-project", "p2"],
      ["task-2", "p1"],
    ],
  );
  assert.deepEqual(
    (
      await store.listAccessibleTasks(alice, {
        owner: "mine",
        query: "落实 修订后",
      })
    ).map(({ task_id }) => task_id),
    ["task-1"],
  );
  assert.deepEqual(
    (await store.listAccessibleTasks(alice, { query: "项目二" })).map(
      ({ task_id }) => task_id,
    ),
    ["task-other-project"],
  );
  assert.deepEqual(await store.listAccessibleTasks(alice, { query: "%" }), []);
  assert.deepEqual(await store.listAccessibleTasks(alice, { query: "_" }), []);
  assert.deepEqual(
    await store.listAccessibleTasks(alice, { owner: "agent" }),
    [],
  );
  assert.deepEqual(
    (await store.listTasks(alice, "p1", { query: "复核" })).map(
      ({ task_id }) => task_id,
    ),
    ["task-2"],
  );
  assert.deepEqual(
    (
      await store.listAccessibleTasks(
        { credential: "agent:input-one" },
        {
          query: "项目二",
        },
      )
    ).map(({ task_id }) => task_id),
    [],
  );
  assert.deepEqual(
    (
      await store.listAccessibleTasks(
        { credential: "agent:input-one" },
        {
          query: "落实",
        },
      )
    ).map(({ task_id }) => task_id),
    ["task-1"],
  );
  await assert.rejects(
    store.listAccessibleTasks(alice, { query: "x".repeat(201) }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "invalid",
  );
  const overviewFirstPage = await store.listAccessibleTasks(alice, {
    limit: 1,
  });
  assert.deepEqual(
    (
      await store.listAccessibleTasks(alice, {
        after: {
          orderRank: overviewFirstPage[0]!.order_rank,
          taskId: overviewFirstPage[0]!.task_id,
        },
      })
    ).map(({ task_id }) => task_id),
    ["task-other-project", "task-2"],
  );
  assert.deepEqual(await store.listAccessibleTasks(bob), []);
  assert.deepEqual(
    (await store.listAccessibleTasks({ credential: "agent:input-one" })).map(
      ({ task_id }) => task_id,
    ),
    ["task-1", "task-2"],
  );
  await assert.rejects(
    store.listAccessibleTasks(alice, {
      after: { orderRank: Number.NaN, taskId: "task-1" },
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "invalid",
  );
  assert.equal((await store.listTasks(alice, "p1", { limit: 1 })).length, 1);
  const firstTask = (await store.listTasks(alice, "p1", { limit: 1 }))[0]!;
  assert.equal(
    (
      await store.listTasks(alice, "p1", {
        after: {
          orderRank: Number(firstTask.order_rank),
          taskId: firstTask.task_id,
        },
      })
    ).length,
    1,
  );
  assert.equal((await store.listTasks(bob, "p1").catch(() => [])).length, 0);
  await store.reviseTask(alice, {
    commandId: "revise-task-1",
    taskId: "task-1",
    expectedRevision: 1,
    title: "完成剧本大纲",
  });
  await store.reviseTask(alice, {
    commandId: "revise-task-1",
    taskId: "task-1",
    expectedRevision: 1,
    title: "完成剧本大纲",
  });
  await assert.rejects(
    store.reviseTask(alice, {
      commandId: "revise-task-stale",
      taskId: "task-1",
      expectedRevision: 1,
      title: "旧修改",
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict",
  );
  assert.equal((await store.listTasks(alice, "p1"))[0]!.title, "完成剧本大纲");
  assert.equal(
    (await store.taskVersion(alice, "task-1", 1)).title,
    "落实剧本大纲",
  );
  const revisedTask = await store.taskVersion(alice, "task-1");
  assert.equal(revisedTask.revision, 2);
  assert.equal(revisedTask.title, "完成剧本大纲");
  assert.equal(revisedTask.description, originalTask.description);
  assert.equal(revisedTask.execution, "planned");
  const beforeOrderTasks = await store.listTasks(alice, "p1");
  assert.equal(beforeOrderTasks[0]!.head_version.revision, 2);
  assert.equal(beforeOrderTasks[0]!.head_version.title, "完成剧本大纲");
  const orderRevision = await store.taskOrderRevision(alice, "p1");
  assert.equal(await store.taskOrderRevision(alice, "p2"), orderRevision);
  assert.equal(beforeOrderTasks[0]!.order_rank < otherProjectRank, true);
  assert.equal(otherProjectRank < beforeOrderTasks[1]!.order_rank, true);
  const moveBefore = {
    commandId: "prioritize-task-2",
    projectId: "p1",
    taskId: "task-2",
    beforeTaskId: "task-1",
    expectedOrderRevision: orderRevision,
  };
  assert.equal(await store.reorderTask(alice, moveBefore), "task-2");
  assert.equal(await store.reorderTask(alice, moveBefore), "task-2");
  assert.deepEqual(
    (await store.listTasks(alice, "p1")).map(({ task_id }) => task_id),
    ["task-2", "task-1"],
  );
  assert.deepEqual(
    (await store.listAccessibleTasks(alice)).map(({ task_id }) => task_id),
    ["task-2", "task-other-project", "task-1"],
  );
  assert.equal(
    (await store.listTasks(alice, "p2"))[0]!.order_rank,
    otherProjectRank,
  );
  assert.equal(await store.taskOrderRevision(alice, "p2"), orderRevision + 1);
  assert.equal((await store.listTasks(alice, "p1"))[0]!.execution, "planned");
  await assert.rejects(
    store.reorderTask(alice, { ...moveBefore, commandId: "stale-order" }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict",
  );
  await assert.rejects(
    store.reorderTask(alice, {
      ...moveBefore,
      commandId: "self-order",
      taskId: "task-1",
      beforeTaskId: "task-1",
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "invalid",
  );
  await store.reorderTask(alice, {
    ...moveBefore,
    commandId: "restore-task-2",
    beforeTaskId: null,
    expectedOrderRevision: await store.taskOrderRevision(alice, "p1"),
  });
  assert.deepEqual(
    (await store.listTasks(alice, "p1")).map(({ task_id }) => task_id),
    ["task-1", "task-2"],
  );
  assert.deepEqual(
    (await store.listTasks(alice, "p1")).map(({ revision }) => revision),
    [2, 1],
  );
  assert.equal((await store.taskVersion(alice, "task-1")).revision, 2);
  assert.deepEqual(
    (await store.listTasks(alice, "p1")).map(({ updated_at }) => updated_at),
    beforeOrderTasks.map(({ updated_at }) => updated_at),
  );
  const filteredSelection = {
    commandId: "selection-reorder",
    taskIds: ["task-2", "task-1"],
    expectedOrderRevision: await store.taskOrderRevision(alice),
  };
  assert.equal(
    await store.reorderTaskSelection(alice, filteredSelection),
    "task-2",
  );
  assert.equal(
    await store.reorderTaskSelection(alice, filteredSelection),
    "task-2",
  );
  assert.deepEqual(
    (await store.listAccessibleTasks(alice)).map(({ task_id }) => task_id),
    ["task-2", "task-other-project", "task-1"],
  );
  assert.equal(
    (await store.listTasks(alice, "p2"))[0]!.order_rank,
    otherProjectRank,
  );
  await assert.rejects(
    store.reorderTaskSelection(alice, {
      ...filteredSelection,
      commandId: "selection-stale",
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict",
  );
  await assert.rejects(
    store.reorderTaskSelection(alice, {
      ...filteredSelection,
      commandId: "selection-duplicate",
      taskIds: ["task-1", "task-1"],
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "invalid",
  );
  await store.reorderTaskSelection(alice, {
    commandId: "selection-restore",
    taskIds: ["task-1", "task-2"],
    expectedOrderRevision: await store.taskOrderRevision(alice),
  });
  const globalOrderRevision = await store.taskOrderRevision(alice);
  assert.equal(globalOrderRevision, await store.taskOrderRevision(alice, "p2"));
  await assert.rejects(
    store.taskOrderRevision(bob),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "forbidden",
  );
  await assert.rejects(
    store.taskOrderRevision({ credential: "agent:input-one" }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "forbidden",
  );
  const moveAcrossProjects = {
    commandId: "global-prioritize-other-project",
    taskId: "task-other-project",
    beforeTaskId: "task-1",
    expectedOrderRevision: globalOrderRevision,
  };
  await assert.rejects(
    store.reorderTask({ credential: "agent:input-one" }, moveAcrossProjects),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "forbidden",
  );
  assert.equal(
    await store.reorderTask(alice, moveAcrossProjects),
    "task-other-project",
  );
  assert.equal(
    await store.reorderTask(alice, moveAcrossProjects),
    "task-other-project",
  );
  assert.deepEqual(
    (await store.listAccessibleTasks(alice)).map(({ task_id }) => task_id),
    ["task-other-project", "task-1", "task-2"],
  );
  assert.deepEqual(
    (await store.listAccessibleTasks(other)).map(({ task_id }) => task_id),
    ["tenant-b-task"],
  );
  await assert.rejects(
    store.reorderTask(alice, {
      ...moveAcrossProjects,
      commandId: "global-stale-order",
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict",
  );
  await store.reorderTask(alice, {
    ...moveAcrossProjects,
    commandId: "global-restore-other-project",
    beforeTaskId: "task-2",
    expectedOrderRevision: await store.taskOrderRevision(alice),
  });
  assert.deepEqual(
    (await store.listAccessibleTasks(alice)).map(({ task_id }) => task_id),
    ["task-1", "task-other-project", "task-2"],
  );
  await store.reviseTask(alice, {
    commandId: "edit-after-reorder",
    taskId: "task-2",
    expectedRevision: 1,
    title: "复核排序后的事项",
  });
  await store.createTask(
    { credential: "agent:input-one" },
    {
      ...task,
      commandId: "agent-task-command",
      taskId: "agent-task",
      title: "Agent 记录的事项",
    },
  );
  const agentTask = await store.taskVersion(alice, "agent-task");
  assert.equal(agentTask.author_principal_id, "alice");
  assert.equal(agentTask.author_actant_id, "agent-one");
  await store.registerApplication("tenant-a", {
    appId: "morphz.script-studio",
    installationId: "install-script",
    instanceId: "script-cloud",
    routeRef: "domain-api:cloud",
    routeKind: "service",
  });
  await store.registerApplication("tenant-a", {
    appId: "morphz.script-studio",
    installationId: "install-script",
    instanceId: "script-cloud",
    routeRef: "domain-api:cloud",
    routeKind: "service",
  });
  const routeChange = {
    commandId: "route-reconnect-1",
    appId: "morphz.script-studio",
    instanceId: "script-cloud",
    expectedRevision: 1,
    routeRef: "domain-api:cloud-2",
    routeKind: "service" as const,
  };
  assert.equal(await store.updateApplicationRoute("tenant-a", routeChange), 2);
  assert.equal(await store.updateApplicationRoute("tenant-a", routeChange), 2);
  await assert.rejects(
    store.updateApplicationRoute("tenant-a", {
      ...routeChange,
      commandId: "stale-route",
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict",
  );
  await assert.rejects(
    store.registerApplication("tenant-a", {
      appId: "morphz.script-studio",
      installationId: "install-script",
      instanceId: "script-cloud",
      routeRef: "domain-api:wrong-data-authority",
      routeKind: "service",
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict",
  );
  await store.registerApplication("tenant-a", {
    appId: "morphz.script-studio",
    installationId: "install-script",
    instanceId: "script-node",
    routeRef: "domain-api:node-1",
    routeKind: "node",
    nodeId: "node-1",
  });
  await store.registerApplication("tenant-b", {
    appId: "morphz.script-studio",
    installationId: "install-script",
    instanceId: "script-cloud",
    routeRef: "domain-api:other",
    routeKind: "service",
  });

  const content = {
    commandId: "record-script",
    appReceiptId: "app-receipt-1",
    contentId: "catalog-1",
    objectId: "script-1",
    projectId: "p1",
    kind: "script",
    title: "一部剧本",
    observedVersionRef: "v1",
    now: "2026-09-25T00:00:01.000Z",
  };
  const cloudApp = {
    instanceId: "script-cloud",
    proof: "committed:tenant-a:script-cloud:script-1:v1:app-receipt-1:一部剧本",
  };
  await assert.rejects(
    store.recordContent(alice, { ...cloudApp, proof: "forged" }, content),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "forbidden",
  );
  await assert.rejects(
    store.recordContent(bob, cloudApp, content),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "forbidden",
  );
  assert.equal((await store.listContent(bob)).length, 0);
  assert.equal(
    await store.recordContent(alice, cloudApp, content),
    "catalog-1",
  );
  assert.equal(
    await store.recordContent(
      alice,
      { ...cloudApp, proof: "expired-proof" },
      content,
    ),
    "catalog-1",
  );
  await assert.rejects(
    store.recordContent(alice, cloudApp, { ...content, title: "被改写" }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict",
  );
  await assert.rejects(
    store.recordContent(alice, cloudApp, {
      ...content,
      commandId: "same-source-again",
      contentId: "catalog-copy",
    }),
  );

  // Object IDs are scoped by tenant and instance, not by the app type alone.
  await store.recordContent(
    alice,
    {
      instanceId: "script-node",
      proof:
        "committed:tenant-a:script-node:script-1:v1:app-receipt-1:一部剧本",
    },
    {
      ...content,
      commandId: "record-node",
      contentId: "catalog-2",
    },
  );
  await store.recordContent(
    other,
    {
      instanceId: "script-cloud",
      proof:
        "committed:tenant-b:script-cloud:script-1:v1:app-receipt-1:一部剧本",
    },
    content,
  );
  assert.equal((await store.listContent(alice, { limit: 1 })).length, 1);
  const titleSearch = await store.searchContentTitles(alice, {
    query: "一部 剧本",
    appId: "morphz.script-studio",
    limit: 1,
    offset: 0,
  });
  assert.equal(titleSearch.total, 2);
  assert.equal(titleSearch.rows.length, 1);
  assert.equal(titleSearch.rows[0]!.project_title, "修订后的项目");
  assert.deepEqual(
    (
      await store.searchContentTitles(alice, {
        query: "一部 剧本",
        appId: "morphz.script-studio",
        limit: 1,
        offset: 1,
      })
    ).rows.map((row) => row.content_id),
    ["catalog-1"],
  );
  assert.equal(
    (
      await store.searchContentTitles(bob, {
        query: "一部 剧本",
        limit: 20,
        offset: 0,
      })
    ).total,
    0,
  );
  await assert.rejects(
    store.searchContentTitles(bob, {
      query: "一部 剧本",
      projectId: "p1",
      limit: 20,
      offset: 0,
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "forbidden",
  );
  assert.equal(
    (
      await store.searchContentTitles(alice, {
        query: "%",
        limit: 20,
        offset: 0,
      })
    ).total,
    0,
  );
  assert.deepEqual(
    (
      await store.listContent(alice, {
        contentIds: ["catalog-1", "catalog-2"],
      })
    ).map((entry) => entry.content_id),
    ["catalog-2", "catalog-1"],
  );
  assert.deepEqual(
    (
      await store.listContent(alice, {
        contentIds: ["catalog-1", "missing-content"],
      })
    ).map((entry) => entry.content_id),
    ["catalog-1"],
  );
  assert.deepEqual(
    await store.listContent(bob, { contentIds: ["catalog-1"] }),
    [],
  );
  assert.deepEqual(
    countOnly(
      await store.contentCounts(alice, {
        contentIds: ["catalog-1", "catalog-2"],
      }),
    ),
    [{ projectId: "p1", count: 2 }],
  );
  assert.equal(
    (await store.contentCounts(alice))[0]?.latestActivityAt,
    (await store.listContent(alice, { projectId: "p1" }))
      .map((entry) => entry.updated_at)
      .sort()
      .at(-1),
  );
  assert.deepEqual(
    (
      await store.listContent(alice, {
        appId: "morphz.script-studio",
        appObjectIds: ["script-1"],
      })
    ).map((entry) => entry.content_id),
    ["catalog-2", "catalog-1"],
  );
  await assert.rejects(
    store.listContent(alice, { appObjectIds: ["script-1"] }),
    /应用对象标识筛选无效/,
  );
  await assert.rejects(
    store.listContent(alice, { contentIds: ["catalog-1", "catalog-1"] }),
    /内容标识筛选无效/,
  );
  assert.deepEqual(
    (
      await store.listContent(alice, {
        appId: "morphz.script-studio",
        kind: "script",
        query: "一部 剧本",
      })
    ).map((entry) => entry.content_id),
    ["catalog-2", "catalog-1"],
  );
  assert.deepEqual(
    (await store.listContent(alice, { query: "%" })).map(
      (entry) => entry.content_id,
    ),
    [],
  );
  assert.deepEqual(
    (
      await store.listContent(alice, {
        appIds: ["morphz.objects", "morphz.script-studio"],
        kind: "script",
      })
    ).map((entry) => entry.content_id),
    ["catalog-2", "catalog-1"],
  );
  // Exercise the same multi-application filter used by the content UI through
  // its shared service boundary. Counts and pages must use every query term.
  const work = new PlatformWorkService(store, "single-host");
  for (const query of ["一部 剧本", "一部 不存在"]) {
    const filter = {
      projectId: "p1",
      appIds: ["morphz.objects", "morphz.script-studio"],
      kinds: ["script", "document"],
      query,
    };
    const expected = query === "一部 剧本" ? 2 : 0;
    assert.equal((await work.listContent(alice, filter)).length, expected);
    assert.equal(
      (await work.contentCounts(alice, filter)).reduce(
        (total, row) => total + row.count,
        0,
      ),
      expected,
    );
  }
  assert.deepEqual(
    countOnly(await store.contentCounts(alice, { appIds: ["morphz.objects"] })),
    [],
  );
  assert.deepEqual(
    countOnly(
      await store.contentCounts(alice, {
        appIds: ["morphz.script-studio"],
        kind: "script",
        availability: "available",
      }),
    ),
    [{ projectId: "p1", count: 2 }],
  );
  assert.deepEqual(
    countOnly(
      await store.contentCounts(alice, {
        appIds: ["morphz.script-studio"],
        kinds: ["document", "pdf", "publication"],
      }),
    ),
    [],
  );
  await assert.rejects(
    store.listContent(alice, { kind: "script", kinds: ["script"] }),
    /内容类型筛选无效/,
  );
  await assert.rejects(
    store.listContent(alice, {
      appId: "morphz.objects",
      appIds: ["morphz.script-studio"],
    }),
    /应用筛选无效/,
  );
  assert.deepEqual(
    countOnly(
      await store.contentCounts(alice, {
        appId: "morphz.script-studio",
        kind: "script",
        query: "一部 剧本",
      }),
    ),
    [{ projectId: "p1", count: 2 }],
  );
  assert.deepEqual(await store.contentCounts(bob), []);
  assert.deepEqual(countOnly(await store.contentCounts(other)), [
    { projectId: "p1", count: 1 },
  ]);
  assert.deepEqual(
    countOnly(await store.contentCounts({ credential: "agent:input-one" })),
    [{ projectId: "p1", count: 2 }],
  );
  const filteredFirst = await store.listContent(alice, {
    kind: "script",
    query: "一部 剧本",
    limit: 1,
  });
  const filteredSecond = await store.listContent(alice, {
    kind: "script",
    query: "一部 剧本",
    limit: 1,
    before: {
      key: filteredFirst[0]!.updated_at,
      contentId: filteredFirst[0]!.content_id,
    },
  });
  assert.deepEqual(
    [filteredFirst[0]?.content_id, filteredSecond[0]?.content_id],
    ["catalog-2", "catalog-1"],
  );
  const titleFirst = await store.listContent(alice, {
    sort: "title",
    limit: 1,
  });
  const titleSecond = await store.listContent(alice, {
    sort: "title",
    limit: 1,
    before: {
      key: titleFirst[0]!.title,
      contentId: titleFirst[0]!.content_id,
    },
  });
  assert.deepEqual(
    [titleFirst[0]?.content_id, titleSecond[0]?.content_id],
    ["catalog-1", "catalog-2"],
  );
  const createdFirst = await store.listContent(alice, {
    sort: "created",
    limit: 1,
  });
  const createdSecond = await store.listContent(alice, {
    sort: "created",
    limit: 1,
    before: {
      key: createdFirst[0]!.created_at,
      contentId: createdFirst[0]!.content_id,
    },
  });
  assert.deepEqual(
    [createdFirst[0]?.content_id, createdSecond[0]?.content_id],
    ["catalog-2", "catalog-1"],
  );
  const firstPage = await store.listContent(alice, { limit: 1 });
  const secondPage = await store.listContent(alice, {
    limit: 1,
    before: {
      key: firstPage[0]!.updated_at,
      contentId: firstPage[0]!.content_id,
    },
  });
  assert.equal(secondPage.length, 1);
  assert.notEqual(firstPage[0]!.content_id, secondPage[0]!.content_id);
  assert.equal((await store.listContent(other)).length, 1);
  await assert.rejects(store.content(bob, "catalog-1"));
  const row = await store.content(alice, "catalog-1");
  assert.equal(row.app_id, "morphz.script-studio");
  assert.equal(row.instance_id, "script-cloud");
  assert.equal(row.app_object_id, "script-1");
  assert.equal("body" in row, false);
  assert.equal(
    (
      await store.contentByAppObject(alice, {
        appId: "morphz.script-studio",
        appObjectId: "script-1",
        instanceId: "script-cloud",
      })
    ).content_id,
    "catalog-1",
  );
  assert.equal(
    (
      await store.contentByAppObject(
        { credential: "agent:input-one" },
        {
          appId: "morphz.script-studio",
          appObjectId: "script-1",
          instanceId: "script-cloud",
        },
      )
    ).content_id,
    "catalog-1",
  );
  assert.equal(
    (
      await store.contentByAppObject(other, {
        appId: "morphz.script-studio",
        appObjectId: "script-1",
      })
    ).content_id,
    "catalog-1",
  );
  await assert.rejects(
    store.contentByAppObject(alice, {
      appId: "morphz.script-studio",
      appObjectId: "script-1",
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict",
  );
  await assert.rejects(
    store.contentByAppObject(bob, {
      appId: "morphz.script-studio",
      appObjectId: "script-1",
      instanceId: "script-cloud",
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "not_found",
  );

  const refreshedVersion = {
    commandId: "refresh-script-node",
    appReceiptId: "app-receipt-2",
    contentId: "catalog-2",
    expectedCatalogRevision: 1,
    title: "第二版剧本",
    observedVersionRef: "v2",
  };
  const refreshedApp = {
    instanceId: "script-node",
    proof:
      "committed:tenant-a:script-node:script-1:v2:app-receipt-2:第二版剧本",
  };
  await assert.rejects(
    store.refreshContent(
      alice,
      { ...refreshedApp, proof: "forged" },
      refreshedVersion,
    ),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "forbidden",
  );
  await assert.rejects(
    store.refreshContent(alice, refreshedApp, {
      ...refreshedVersion,
      title: "伪造标题",
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "forbidden",
  );
  await assert.rejects(
    store.refreshContent(bob, refreshedApp, refreshedVersion),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "forbidden",
  );
  assert.equal(
    await store.refreshContent(alice, refreshedApp, refreshedVersion),
    "catalog-2",
  );
  assert.equal((await store.content(alice, "catalog-2")).title, "第二版剧本");
  assert.equal(
    (await store.content(alice, "catalog-2")).observed_version_ref,
    "v2",
  );
  assert.equal((await store.content(alice, "catalog-2")).revision, 2);
  assert.equal(
    await store.refreshContent(
      alice,
      { ...refreshedApp, proof: "expired-proof" },
      refreshedVersion,
    ),
    "catalog-2",
  );
  await assert.rejects(
    store.refreshContent(alice, refreshedApp, {
      ...refreshedVersion,
      title: "同命令不同内容",
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict",
  );
  await assert.rejects(
    store.refreshContent(alice, refreshedApp, {
      ...refreshedVersion,
      commandId: "stale-refresh",
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict",
  );

  const move = {
    commandId: "move-script",
    contentId: "catalog-1",
    targetProjectId: "p2",
    expectedRevision: 1,
  };
  await store.moveContent(alice, move);
  await store.moveContent(alice, move);
  assert.equal((await store.content(alice, "catalog-1")).project_id, "p2");
  assert.equal(Number((await store.content(alice, "catalog-1")).revision), 2);
  assert.deepEqual(
    countOnly(await store.contentCounts({ credential: "agent:input-one" })),
    [{ projectId: "p1", count: 1 }],
  );
  await assert.rejects(
    store.contentByAppObject(
      { credential: "agent:input-one" },
      {
        appId: "morphz.script-studio",
        appObjectId: "script-1",
        instanceId: "script-cloud",
      },
    ),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "not_found",
  );
  await assert.rejects(
    store.refreshContent({ credential: "agent:input-one" }, cloudApp, {
      ...refreshedVersion,
      commandId: "agent-stale-source",
      contentId: "catalog-1",
      expectedCatalogRevision: 2,
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "forbidden",
  );
  await assert.rejects(
    store.moveContent(alice, { ...move, commandId: "stale-move" }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict",
  );
  assert.equal((await store.listContent(alice, { projectId: "p1" })).length, 1);

  const agent = { credential: "agent:input-one" };
  await store.moveContent(agent, {
    commandId: "agent-move-selected-content",
    contentId: "catalog-2",
    targetProjectId: "p2",
    expectedRevision: 2,
  });
  assert.equal((await store.content(alice, "catalog-2")).project_id, "p2");
  await assert.rejects(
    store.moveContent(agent, {
      commandId: "agent-cannot-move-outside-input",
      contentId: "catalog-2",
      targetProjectId: "p1",
      expectedRevision: 3,
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "forbidden",
  );
  await store.moveContent(alice, {
    commandId: "return-agent-moved-content",
    contentId: "catalog-2",
    targetProjectId: "p1",
    expectedRevision: 3,
  });
  const createForContent = {
    commandId: "create-project-for-one-content",
    projectId: "one-content-project",
    title: "只归入一件内容",
    contentId: "catalog-2",
    expectedRevision: 4,
  };
  await assert.rejects(
    store.createProjectForContent(agent, {
      ...createForContent,
      commandId: "stale-create-and-move",
      projectId: "stale-project",
      expectedRevision: 1,
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict",
  );
  await assert.rejects(store.getProject(alice, "stale-project"));
  assert.equal(
    await store.createProjectForContent(agent, createForContent),
    createForContent.projectId,
  );
  assert.equal(
    await store.createProjectForContent(agent, createForContent),
    createForContent.projectId,
  );
  const createdForContent = await store.getProject(
    alice,
    createForContent.projectId,
  );
  assert.equal(createdForContent.owner_principal_id, "alice");
  assert.deepEqual(createdForContent.member_principal_ids.sort(), [
    "alice",
    "morphz-service",
  ]);
  assert.equal(
    (await store.content(alice, "catalog-2")).project_id,
    createForContent.projectId,
  );
  assert.equal(Number((await store.content(alice, "catalog-2")).revision), 5);
  assert.equal((await store.content(alice, "catalog-1")).project_id, "p2");
  await assert.rejects(
    store.createProjectForContent(agent, {
      ...createForContent,
      title: "不同标题",
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict",
  );
  await store.moveContent(alice, {
    commandId: "return-new-project-content",
    contentId: "catalog-2",
    targetProjectId: "p1",
    expectedRevision: 5,
  });

  await store.createProject(alice, {
    commandId: "create-agent-work",
    projectId: "agent-work",
    title: "可指派给 Morphz 的项目",
  });
  assert.equal(
    await store.createTask(alice, {
      commandId: "assign-agent-work",
      taskId: "agent-work-task",
      projectId: "agent-work",
      title: "让 Morphz 继续工作",
      assigneeId: "agent-one",
    }),
    "agent-work-task",
  );
  assert.equal(
    (await store.taskVersion(alice, "agent-work-task")).assignee_id,
    "agent-one",
  );
  const [firstSpaces, retriedSpaces] = await Promise.all([
    store.ensurePersonalSpaces(alice),
    store.ensurePersonalSpaces(alice),
  ]);
  assert.deepEqual(firstSpaces, retriedSpaces);
  assert.equal(new Set(Object.values(firstSpaces)).size, 3);
  await assert.rejects(
    store.moveContent(alice, {
      commandId: "invalid-content-inbox",
      contentId: "catalog-1",
      targetProjectId: firstSpaces.inboxId,
      expectedRevision: 2,
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "invalid",
  );
  assert.equal((await store.content(alice, "catalog-1")).project_id, "p2");
  for (const [kind, projectId] of [
    ["desk", firstSpaces.deskId],
    ["inbox", firstSpaces.inboxId],
    ["dialogue", firstSpaces.dialogueId],
  ] as const) {
    assert.equal((await store.getProject(alice, projectId)).kind, kind);
    assert.deepEqual(
      (await store.listConversations(alice, projectId)).map(
        (conversation) => conversation.conversation_id,
      ),
      [projectId],
    );
    await assert.rejects(
      store.getProject(bob, projectId),
      (error: unknown) =>
        error instanceof PlatformStorageError && error.code === "forbidden",
    );
  }
  await assert.rejects(
    store.ensurePersonalSpaces({ credential: "agent:input-one" }),
    /只有已认证用户/,
  );
  const bobSpaces = await store.ensurePersonalSpaces(bob);
  assert.notEqual(bobSpaces.dialogueId, firstSpaces.dialogueId);
  assert.deepEqual(
    (await store.listProjects(bob)).map((project) => project.project_id).sort(),
    Object.values(bobSpaces).sort(),
  );
  await store.createTask(bob, {
    commandId: "bob-private-task-command",
    taskId: "bob-private-task",
    projectId: bobSpaces.inboxId,
    title: "Bob 的私有事项",
    assigneeId: "bob",
  });
  const bobPrivateRank = (await store.listTasks(bob, bobSpaces.inboxId))[0]!
    .order_rank;
  const accessibleOrder = await store.taskOrderRevision(alice);
  await assert.rejects(
    store.reorderTask(alice, {
      commandId: "move-before-bob-private-task",
      taskId: "task-other-project",
      beforeTaskId: "bob-private-task",
      expectedOrderRevision: accessibleOrder,
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "not_found",
  );
  assert.equal(await store.taskOrderRevision(alice), accessibleOrder);
  await store.reorderTask(alice, {
    commandId: "reorder-with-private-slots",
    taskId: "task-other-project",
    beforeTaskId: "task-1",
    expectedOrderRevision: accessibleOrder,
  });
  assert.equal(
    (await store.listTasks(bob, bobSpaces.inboxId))[0]!.order_rank,
    bobPrivateRank,
  );
  assert.ok(
    !(await store.listAccessibleTasks(alice)).some(
      ({ task_id }) => task_id === "bob-private-task",
    ),
  );
  await store.reorderTask(alice, {
    commandId: "restore-with-private-slots",
    taskId: "task-other-project",
    beforeTaskId: "task-2",
    expectedOrderRevision: await store.taskOrderRevision(alice),
  });

  const response = {
    commandId: "respond-task-1",
    taskId: "task-1",
    expectedRevision: 2,
    body: "  已完成大纲，请按正文继续。  ",
    now: "2026-09-25T00:10:00.000Z",
  };
  await assert.rejects(
    store.respondTask(bob, response),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "forbidden",
  );
  await assert.rejects(
    store.respondTask({ credential: "agent:input-one" }, response),
    /只有当前负责人/,
  );
  await assert.rejects(
    store.respondTask(alice, {
      ...response,
      commandId: "respond-stale",
      expectedRevision: 1,
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict",
  );
  await assert.rejects(
    store.respondTask(alice, {
      ...response,
      commandId: "respond-agent-task",
      taskId: "agent-work-task",
      expectedRevision: 1,
    }),
    /只有当前负责人/,
  );
  assert.equal(await store.respondTask(alice, response), "task-1");
  assert.equal(await store.respondTask(alice, response), "task-1");
  assert.equal((await store.taskVersion(alice, "task-1")).revision, 3);
  assert.equal(
    (await store.taskVersion(alice, "task-1")).execution,
    "completed",
  );
  assert.equal(
    (await store.taskVersion(alice, "task-1", 2)).execution,
    "planned",
  );
  assert.deepEqual(await store.listTaskResponses(alice, "task-1"), [
    {
      response_id: response.commandId,
      task_id: "task-1",
      task_revision: 2,
      body: "已完成大纲，请按正文继续。",
      author_principal_id: "alice",
      author_actant_id: "alice",
      created_at: response.now,
    },
  ]);
  assert.deepEqual(
    await store.listTaskResponses(alice, "task-1", {
      after: { createdAt: response.now, responseId: response.commandId },
    }),
    [],
  );
  await assert.rejects(store.listTaskResponses(bob, "task-1"));
  await assert.rejects(store.listTaskResponses(other, "task-1"));
  await assert.rejects(
    store.respondTask(alice, { ...response, body: "另一条回应" }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict",
  );
  await assert.rejects(
    store.respondTask(alice, { ...response, commandId: "respond-again" }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict",
  );

  const reopen = {
    commandId: "reopen-task-1",
    taskId: "task-1",
    expectedRevision: 3,
    completed: false,
    now: "2026-09-25T00:11:00.000Z",
  };
  await assert.rejects(
    store.setTaskCompleted({ credential: "agent:input-one" }, reopen),
    /只有当前负责人/,
  );
  assert.equal(await store.setTaskCompleted(alice, reopen), "task-1");
  assert.equal(await store.setTaskCompleted(alice, reopen), "task-1");
  assert.equal(
    (await store.taskVersion(alice, "task-1", 3)).execution,
    "completed",
  );
  assert.equal((await store.taskVersion(alice, "task-1")).execution, "planned");
  assert.equal((await store.taskVersion(alice, "task-1")).revision, 4);
  assert.equal((await store.listTaskResponses(alice, "task-1")).length, 1);
  await assert.rejects(
    store.setTaskCompleted(alice, { ...reopen, commandId: "reopen-again" }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict",
  );
  await assert.rejects(
    store.setTaskCompleted(alice, {
      ...reopen,
      commandId: "reopen-agent-task",
      taskId: "agent-work-task",
      expectedRevision: 1,
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "forbidden",
  );
  const complete = {
    commandId: "complete-task-1",
    taskId: "task-1",
    expectedRevision: 4,
    completed: true,
  };
  assert.equal(await store.setTaskCompleted(alice, complete), "task-1");
  assert.equal(await store.setTaskCompleted(alice, complete), "task-1");
  assert.equal(
    (await store.taskVersion(alice, "task-1")).execution,
    "completed",
  );
  assert.equal((await store.listTaskResponses(alice, "task-1")).length, 1);
  const taskTwoBeforeMove = await store.taskVersion(alice, "task-2");
  const dragBefore = (await store.listAccessibleTasks(alice)).map(
    (item) => item.task_id,
  );
  const dragSelection = {
    commandId: "board-drag-task-2",
    taskIds: [...dragBefore.filter((id) => id !== "task-2"), "task-2"],
    expectedOrderRevision: await store.taskOrderRevision(alice),
    move: {
      taskId: "task-2",
      expectedRevision: taskTwoBeforeMove.revision,
      execution: "active" as const,
    },
  };
  assert.equal(
    await store.reorderTaskSelection(alice, dragSelection),
    "task-2",
  );
  assert.equal(
    await store.reorderTaskSelection(alice, dragSelection),
    "task-2",
  );
  assert.equal((await store.taskVersion(alice, "task-2")).execution, "active");
  assert.equal(
    (await store.taskVersion(alice, "task-2")).revision,
    taskTwoBeforeMove.revision + 1,
  );
  assert.equal(
    (await store.taskVersion(alice, "task-2", taskTwoBeforeMove.revision))
      .execution,
    "planned",
  );
  assert.deepEqual(
    (await store.listAccessibleTasks(alice)).map((item) => item.task_id),
    dragSelection.taskIds,
  );
  const committedOrderRevision = await store.taskOrderRevision(alice);
  await assert.rejects(
    store.reorderTaskSelection(alice, {
      ...dragSelection,
      commandId: "board-drag-stale-order",
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict",
  );
  await assert.rejects(
    store.reorderTaskSelection(alice, {
      ...dragSelection,
      commandId: "board-drag-stale-task",
      expectedOrderRevision: committedOrderRevision,
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict",
  );
  await assert.rejects(
    store.reorderTaskSelection(
      { credential: "agent:input-one" },
      {
        ...dragSelection,
        commandId: "board-drag-agent-forbidden",
        expectedOrderRevision: committedOrderRevision,
        projectId: "p1",
        taskIds: ["task-1", "task-2"],
        move: {
          taskId: "task-2",
          expectedRevision: taskTwoBeforeMove.revision + 1,
          execution: "waiting",
        },
      },
    ),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "forbidden",
  );
  assert.equal(await store.taskOrderRevision(alice), committedOrderRevision);
}

test("Platform 关系存储：SQLite 的授权、实例定位、幂等、CAS 与分页", async () => {
  const store = await PlatformStore.sqlite(":memory:", testCapabilities);
  try {
    await exercise(store);
  } finally {
    await store.close();
  }
});

async function exerciseTaskArrangement(store: PlatformStore) {
  const alice = { credential: "human:tenant-a:alice" };
  await store.provisionTenant("tenant-a");
  await store.createProject(alice, {
    commandId: "create-arrange-p1",
    projectId: "arrange-p1",
    title: "一",
  });
  await store.createProject(alice, {
    commandId: "create-arrange-p2",
    projectId: "arrange-p2",
    title: "二",
  });
  await store.createProject(alice, {
    commandId: "create-arrange-p3",
    projectId: "arrange-p3",
    title: "创建安排验收",
  });
  const initialAgentArrangement = {
    commandId: "create-arranged-agent-task",
    taskId: "arranged-agent-task",
    projectId: "arrange-p3",
    title: "创建时确定的安排",
    assigneeId: "agent-one",
    modelId: "selected-model",
    reasoningEffort: "high" as const,
    notBefore: "2026-10-02T12:00:00.000Z",
    everySeconds: 3600,
  };
  assert.equal(
    await store.createTask(alice, initialAgentArrangement),
    "arranged-agent-task",
  );
  assert.equal(
    await store.createTask(alice, initialAgentArrangement),
    "arranged-agent-task",
  );
  const createdAgent = await store.taskVersion(alice, "arranged-agent-task");
  assert.deepEqual(
    [
      createdAgent.revision,
      createdAgent.model_id,
      createdAgent.reasoning_effort,
      createdAgent.not_before,
      createdAgent.every_seconds,
    ],
    [1, "selected-model", "high", initialAgentArrangement.notBefore, 3600],
  );
  await assert.rejects(
    store.createTask(alice, {
      ...initialAgentArrangement,
      commandId: "invalid-human-schedule",
      taskId: "invalid-human-schedule",
      assigneeId: "alice",
    }),
    /人工事项不能设置 Agent 执行模型或时间/,
  );
  await assert.rejects(
    store.createTask(alice, {
      ...initialAgentArrangement,
      commandId: "invalid-agent-interval",
      taskId: "invalid-agent-interval",
      everySeconds: 20,
    }),
    /事项描述或日期无效/,
  );
  await store.createTask(alice, {
    commandId: "create-proposed-task",
    taskId: "proposed-task",
    projectId: "arrange-p1",
    title: "待接受事项",
    assigneeId: "alice",
  });
  await store.reviseTask(alice, {
    commandId: "revise-proposed-description",
    taskId: "proposed-task",
    expectedRevision: 1,
    description: "只修改说明",
    execution: "planned",
  });
  assert.equal(
    (await store.taskVersion(alice, "proposed-task")).assignment,
    "proposed",
  );
  const decline = {
    commandId: "decline-proposed-task",
    taskId: "proposed-task",
    expectedRevision: 2,
    assignment: "declined" as const,
  };
  await store.reviseTask(alice, decline);
  await store.reviseTask(alice, decline);
  assert.equal(
    (await store.taskVersion(alice, "proposed-task")).assignment,
    "declined",
  );
  await assert.rejects(
    store.reviseTask(alice, {
      ...decline,
      commandId: "decline-stale-task",
    }),
    /事项已变化/,
  );
  await store.createTask(alice, {
    commandId: "create-arrange-task",
    taskId: "arrange-task",
    projectId: "arrange-p1",
    title: "安排事项",
    assigneeId: "alice",
  });
  const arrange = {
    commandId: "arrange-task-once",
    taskId: "arrange-task",
    expectedRevision: 1,
    projectId: "arrange-p2",
    dueDate: "2026-10-01",
  };
  assert.equal(await store.reviseTask(alice, arrange), "arrange-task");
  assert.equal(await store.reviseTask(alice, arrange), "arrange-task");
  assert.deepEqual(
    (await store.listTasks(alice, "arrange-p1")).map((task) => task.task_id),
    ["proposed-task"],
  );
  assert.equal((await store.listTasks(alice, "arrange-p2")).length, 1);
  const moved = await store.taskVersion(alice, "arrange-task");
  assert.deepEqual(
    {
      revision: moved.revision,
      projectId: moved.project_id,
      dueDate: moved.due_date,
    },
    {
      revision: 2,
      projectId: "arrange-p2",
      dueDate: "2026-10-01",
    },
  );
  assert.equal(
    (await store.taskVersion(alice, "arrange-task", 1)).project_id,
    "arrange-p1",
  );
  await assert.rejects(
    store.reviseTask(alice, { ...arrange, commandId: "arrange-stale" }),
    /事项已变化/,
  );
  await assert.rejects(
    store.reviseTask(alice, {
      commandId: "arrange-unknown-assignee",
      taskId: "arrange-task",
      expectedRevision: 2,
      assigneeId: "unknown",
    }),
    /负责人身份未获确认/,
  );
  await assert.rejects(
    store.reviseTask(alice, {
      commandId: "arrange-agent-status",
      taskId: "arrange-task",
      expectedRevision: 2,
      assigneeId: "agent-one",
      execution: "active",
    }),
    /只能直接移动自己的事项/,
  );
  const assign = {
    commandId: "arrange-agent-assignee",
    taskId: "arrange-task",
    expectedRevision: 2,
    assigneeId: "agent-one",
  };
  await store.reviseTask(alice, assign);
  const assigned = await store.taskVersion(alice, "arrange-task");
  assert.deepEqual(
    {
      assignee: assigned.assignee_id,
      execution: assigned.execution,
      assignment: assigned.assignment,
      runRequested: assigned.run_requested,
    },
    {
      assignee: "agent-one",
      execution: "planned",
      assignment: "accepted",
      runRequested: 0,
    },
  );
  assert.equal(
    (await store.taskVersion(alice, "arrange-task", 2)).assignee_id,
    "alice",
  );
  const schedule = {
    commandId: "arrange-agent-schedule",
    taskId: "arrange-task",
    expectedRevision: 3,
    modelId: "selected-model",
    reasoningEffort: "high" as const,
    notBefore: "2026-10-02T12:00:00.000Z",
    everySeconds: 3600,
  };
  await store.reviseTask(alice, schedule);
  await store.reviseTask(alice, schedule);
  const configured = await store.taskVersion(alice, "arrange-task");
  assert.deepEqual(
    [
      configured.revision,
      configured.model_id,
      configured.reasoning_effort,
      configured.not_before,
      configured.every_seconds,
    ],
    [4, "selected-model", "high", schedule.notBefore, 3600],
  );
  await assert.rejects(
    store.reviseTask(alice, {
      commandId: "arrange-invalid-interval",
      taskId: "arrange-task",
      expectedRevision: 4,
      everySeconds: 20,
    }),
    /事项描述或日期无效/,
  );
  await assert.rejects(
    store.reviseTask(alice, {
      commandId: "arrange-invalid-date",
      taskId: "arrange-task",
      expectedRevision: 4,
      notBefore: "invalid-date",
    }),
    /事项描述或日期无效/,
  );
  assert.equal((await store.taskVersion(alice, "arrange-task")).revision, 4);
  await store.reviseTask(alice, {
    commandId: "arrange-human-assignee",
    taskId: "arrange-task",
    expectedRevision: 4,
    assigneeId: "alice",
    modelId: null,
    reasoningEffort: null,
    notBefore: null,
    everySeconds: null,
  });
  const humanTask = await store.taskVersion(alice, "arrange-task");
  assert.deepEqual(
    [
      humanTask.model_id,
      humanTask.reasoning_effort,
      humanTask.not_before,
      humanTask.every_seconds,
    ],
    [null, null, null, null],
  );
  await store.createTask(alice, {
    commandId: "create-active-task",
    taskId: "active-task",
    projectId: "arrange-p1",
    title: "进行中的事项",
    assigneeId: "alice",
  });
  await store.reviseTask(alice, {
    commandId: "activate-task",
    taskId: "active-task",
    expectedRevision: 1,
    execution: "active",
  });
  await assert.rejects(
    store.reviseTask(alice, {
      commandId: "reassign-active-task",
      taskId: "active-task",
      expectedRevision: 2,
      assigneeId: "agent-one",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "conflict" &&
      /执行尚未确认结束/.test(error.message),
  );
  assert.equal(
    (await store.taskVersion(alice, "active-task")).assignee_id,
    "alice",
  );
}

test("Platform SQLite：事项安排原子移动、负责人、CAS 与幂等", async () => {
  const store = await PlatformStore.sqlite(":memory:", testCapabilities);
  try {
    await exerciseTaskArrangement(store);
  } finally {
    await store.close();
  }
});

test(
  "Platform PostgreSQL：事项安排与 SQLite 语义相同",
  {
    skip: !process.env.MORPHZ_TEST_POSTGRES_URL,
  },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const store = await PlatformStore.postgres(
        { connectionString, schema },
        testCapabilities,
      );
      try {
        await exerciseTaskArrangement(store);
      } finally {
        await store.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

async function exerciseTaskReferences(store: PlatformStore) {
  const alice = { credential: "human:tenant-a:alice" };
  await store.provisionTenant("tenant-a");
  await store.createProject(alice, {
    commandId: "refs-project-create",
    projectId: "refs-project",
    title: "事项关联",
  });
  await store.createProject(alice, {
    commandId: "refs-other-create",
    projectId: "refs-other",
    title: "其他项目",
  });
  for (const [taskId, projectId] of [
    ["refs-a", "refs-project"],
    ["refs-c", "refs-project"],
    ["refs-other", "refs-other"],
  ] as const)
    await store.createTask(alice, {
      commandId: `create-${taskId}`,
      taskId,
      projectId,
      title: taskId,
      assigneeId: "alice",
    });
  const initial = {
    commandId: "create-refs-b",
    taskId: "refs-b",
    projectId: "refs-project",
    title: "关联事项 B",
    assigneeId: "alice",
    dependsOnIds: ["refs-c"],
    watchSourceIds: ["refs-a"],
    resultIds: ["refs-a"],
  };
  assert.equal(await store.createTask(alice, initial), "refs-b");
  assert.equal(await store.createTask(alice, initial), "refs-b");
  const created = await store.taskVersion(alice, "refs-b");
  assert.deepEqual(
    [created.depends_on_ids, created.watch_source_ids, created.result_ids],
    [["refs-c"], ["refs-a"], ["refs-a"]],
  );
  await store.reviseTask(alice, {
    commandId: "reassign-refs-b",
    taskId: "refs-b",
    expectedRevision: 1,
    assigneeId: "agent-one",
    assignment: "proposed",
  });
  const reassigned = await store.taskVersion(alice, "refs-b");
  assert.equal(reassigned.assignment, "proposed");
  assert.equal(reassigned.assignee_id, "agent-one");
  assert.deepEqual(
    [
      reassigned.depends_on_ids,
      reassigned.watch_source_ids,
      reassigned.result_ids,
    ],
    [["refs-c"], ["refs-a"], ["refs-a"]],
  );
  const listed = (await store.listTasks(alice, "refs-project")).find(
    (task) => task.task_id === "refs-b",
  );
  assert.equal(listed?.head_version.revision, 2);
  assert.deepEqual(
    [
      listed?.head_version.depends_on_ids,
      listed?.head_version.watch_source_ids,
      listed?.head_version.result_ids,
    ],
    [["refs-c"], ["refs-a"], ["refs-a"]],
  );
  await store.reviseTask(alice, {
    commandId: "revise-refs-a",
    taskId: "refs-a",
    expectedRevision: 1,
    dependsOnIds: ["refs-b"],
  });
  await assert.rejects(
    store.reviseTask(alice, {
      commandId: "cycle-refs-c",
      taskId: "refs-c",
      expectedRevision: 1,
      dependsOnIds: ["refs-a"],
    }),
    /依赖不能形成循环/,
  );
  await assert.rejects(
    store.reviseTask(alice, {
      commandId: "cross-project-refs-c",
      taskId: "refs-c",
      expectedRevision: 1,
      watchSourceIds: ["refs-other"],
    }),
    /当前项目/,
  );
  await assert.rejects(
    store.reviseTask(alice, {
      commandId: "duplicate-refs-c",
      taskId: "refs-c",
      expectedRevision: 1,
      resultIds: ["refs-a", "refs-a"],
    }),
    /重复/,
  );
  assert.equal((await store.taskVersion(alice, "refs-c")).revision, 1);
  const clear = {
    commandId: "clear-refs-b",
    taskId: "refs-b",
    expectedRevision: 2,
    dependsOnIds: [],
    watchSourceIds: [],
    resultIds: [],
  };
  await store.reviseTask(alice, clear);
  await store.reviseTask(alice, clear);
  const revised = await store.taskVersion(alice, "refs-b");
  assert.deepEqual(
    [revised.depends_on_ids, revised.watch_source_ids, revised.result_ids],
    [[], [], []],
  );
  assert.deepEqual(
    (await store.taskVersion(alice, "refs-b", 1)).depends_on_ids,
    ["refs-c"],
  );
  for (const taskId of ["refs-concurrent-x", "refs-concurrent-y"])
    await store.createTask(alice, {
      commandId: `create-${taskId}`,
      taskId,
      projectId: "refs-project",
      title: taskId,
      assigneeId: "alice",
    });
  const parallel = await Promise.allSettled([
    store.reviseTask(alice, {
      commandId: "refs-concurrent-x-to-y",
      taskId: "refs-concurrent-x",
      expectedRevision: 1,
      dependsOnIds: ["refs-concurrent-y"],
    }),
    store.reviseTask(alice, {
      commandId: "refs-concurrent-y-to-x",
      taskId: "refs-concurrent-y",
      expectedRevision: 1,
      dependsOnIds: ["refs-concurrent-x"],
    }),
  ]);
  assert.equal(
    parallel.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.match(
    String(parallel.find((result) => result.status === "rejected")?.reason),
    /依赖不能形成循环/,
  );
}

test("Platform SQLite：事项关联版本、权限、环和幂等", async () => {
  const store = await PlatformStore.sqlite(":memory:", testCapabilities);
  try {
    await exerciseTaskReferences(store);
  } finally {
    await store.close();
  }
});

test(
  "Platform PostgreSQL：事项关联与 SQLite 语义相同",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const store = await PlatformStore.postgres(
        { connectionString, schema },
        testCapabilities,
      );
      try {
        await exerciseTaskReferences(store);
      } finally {
        await store.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

test(
  "Platform 关系存储：PostgreSQL 与 SQLite 行为一致",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const [store, second] = await Promise.all([
        PlatformStore.postgres({ connectionString, schema }, testCapabilities),
        PlatformStore.postgres({ connectionString, schema }, testCapabilities),
      ]);
      try {
        await exercise(store);
        assert.equal(
          (
            await second.listContent({
              credential: "human:tenant-a:alice",
            })
          ).length,
          2,
        );
      } finally {
        await store.close();
        await second.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

test(
  "Platform 拒绝与 PostgreSQL schema 中已有业务表混用",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      await admin.query(
        `CREATE TABLE "${schema}".foreign_data(id TEXT PRIMARY KEY)`,
      );
      await assert.rejects(
        PlatformStore.postgres({ connectionString, schema }, testCapabilities),
        (error: unknown) =>
          error instanceof PlatformStorageError && error.code === "conflict",
      );
      const result = await admin.query<{ name: string }>(
        "SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname=$1 ORDER BY tablename",
        [schema],
      );
      assert.deepEqual(result.rows, [{ name: "foreign_data" }]);
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

async function exerciseWorkRelations(store: PlatformStore) {
  await store.provisionTenant("tenant-a");
  const alice = { credential: "human:tenant-a:alice" };
  const bob = { credential: "human:tenant-a:bob" };
  for (const projectId of ["relations-p1", "relations-p2"])
    await store.createProject(alice, {
      commandId: `create-${projectId}`,
      projectId,
      title: projectId,
    });
  for (const [taskId, projectId] of [
    ["relations-a", "relations-p1"],
    ["relations-b", "relations-p1"],
    ["relations-c", "relations-p1"],
    ["relations-other", "relations-p2"],
  ] as const)
    await store.createTask(alice, {
      commandId: `create-${taskId}`,
      taskId,
      projectId,
      title: taskId,
      assigneeId: "alice",
    });
  const first = {
    commandId: "relations-link-first",
    fromId: "relations-a",
    toId: "relations-b",
    kind: "references" as const,
    expectedProjectId: "relations-p1",
  };
  assert.equal(await store.linkWork(alice, first), first.commandId);
  assert.equal(await store.linkWork(alice, first), first.commandId);
  assert.equal(
    await store.linkWork(alice, {
      ...first,
      commandId: "relations-link-duplicate",
    }),
    first.commandId,
  );
  await store.linkWork(alice, {
    ...first,
    commandId: "relations-link-second",
    toId: "relations-c",
  });
  assert.deepEqual(
    (await store.listWorkRelations(alice, "relations-a", { limit: 1 })).map(
      (row) => row.id,
    ),
    [first.commandId],
  );
  assert.deepEqual(
    (
      await store.listWorkRelations(alice, "relations-a", {
        limit: 1,
        after: first.commandId,
      })
    ).map((row) => row.id),
    ["relations-link-second"],
  );
  await assert.rejects(
    store.linkWork(alice, {
      ...first,
      commandId: "relations-cross-project",
      toId: "relations-other",
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "invalid",
  );
  await assert.rejects(
    store.listWorkRelations(alice, "relations-other", {
      expectedProjectId: "relations-p1",
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "forbidden",
  );
  await assert.rejects(
    store.linkWork(alice, {
      ...first,
      commandId: "relations-wrong-input-project",
      expectedProjectId: "relations-p2",
    }),
    (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "forbidden",
  );
  await assert.rejects(store.listWorkRelations(bob, "relations-a"));
}

test("Platform SQLite 关联对象：授权、幂等、分页和项目边界", async () => {
  const store = await PlatformStore.sqlite(":memory:", testCapabilities);
  try {
    await exerciseWorkRelations(store);
  } finally {
    await store.close();
  }
});

test(
  "Platform PostgreSQL 关联对象与 SQLite 同义",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const store = await PlatformStore.postgres(
        { connectionString, schema },
        testCapabilities,
      );
      try {
        await exerciseWorkRelations(store);
      } finally {
        await store.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
