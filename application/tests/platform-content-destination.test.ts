import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { Application } from "../packages/application/src/application.js";
import {
  openApplicationDomainsHost,
  type PostgresApplicationDomains,
} from "../packages/application/src/application-domains-host.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { localAccess } from "../packages/core/src/model.js";
import type { PlatformActor } from "../packages/platform/src/store.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";

const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;

async function fixture(backend: "sqlite" | "postgres") {
  const directory = mkdtempSync(join(tmpdir(), "morphz-content-boundary-"));
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const schemas = {
    platform: `p_${suffix}`,
    objects: `o_${suffix}`,
    scriptStudio: `s_${suffix}`,
    reader: `r_${suffix}`,
    browser: `b_${suffix}`,
  };
  const admin =
    backend === "postgres"
      ? new Pool({ connectionString: postgresUrl })
      : undefined;
  const transport = new WorkspaceStore(join(directory, "transport.sqlite"), {
    mode: "transport",
  });
  const applications: PostgresApplicationDomains = {
    connectionStrings: {
      objects: postgresUrl!,
      scriptStudio: postgresUrl!,
      reader: postgresUrl!,
      browser: postgresUrl!,
    },
    deploymentId: `boundary_${suffix}`,
    schemas: {
      objects: schemas.objects,
      scriptStudio: schemas.scriptStudio,
      reader: schemas.reader,
      browser: schemas.browser,
    },
  };
  if (admin)
    for (const schema of Object.values(schemas))
      await admin.query(`CREATE SCHEMA "${schema}"`);
  const domains = await openApplicationDomainsHost(
    directory,
    transport,
    undefined,
    admin
      ? {
          platform: {
            kind: "postgres",
            connectionString: postgresUrl!,
            schema: schemas.platform,
          },
          applications,
        }
      : {},
  ).catch(async (error: unknown) => {
    transport.close();
    if (admin) {
      for (const schema of Object.values(schemas))
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
    rmSync(directory, { recursive: true, force: true });
    throw error;
  });
  const session = new Application(transport, {
    platformWork: domains.work,
    platformDocuments: domains.content,
    platformScripts: domains.content,
    platformReader: domains.reader,
    bookmarkDomain: domains.browser,
  }).session(localAccess);
  const projectId = "source-project",
    targetProjectId = "target-project";
  for (const id of [projectId, targetProjectId])
    await session.createPlatformProject({
      commandId: randomUUID(),
      projectId: id,
      title: id,
    });
  const human = <T>(work: (actor: PlatformActor) => Promise<T>) =>
    domains.work.authority.withSession(localAccess, () => {}, work);
  const spaces = await human((actor) =>
    domains.work.service.ensurePersonalSpaces(actor),
  );
  const doc = (project = projectId) =>
    session.createPlatformDocument({
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId: project,
      title: "真实原件",
      markdown: "不可重复保存的正文",
    });
  const query = async (
    kind: keyof typeof schemas,
    sql: string,
    values: (string | number)[] = [],
  ) => {
    if (admin)
      return (
        await admin.query(
          sql.replaceAll("$schema", `"${schemas[kind]}"`),
          values,
        )
      ).rows;
    const filename = kind === "scriptStudio" ? "script-studio" : kind;
    const db = new DatabaseSync(join(directory, `${filename}.sqlite`), {
      readOnly: true,
    });
    try {
      return db
        .prepare(sql.replaceAll("$schema.", "").replace(/\$\d+/g, "?"))
        .all(...values);
    } finally {
      db.close();
    }
  };
  return {
    directory,
    schemas,
    admin,
    transport,
    domains,
    session,
    projectId,
    targetProjectId,
    spaces,
    human,
    doc,
    query,
    async close() {
      await domains.close();
      transport.close();
      if (admin) {
        for (const schema of Object.values(schemas))
          await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: Human 正式新建文档/剧本/读物拒绝沟通与事项空间，无孤儿 App 原件；通用应用权限仍有效`,
    { skip: backend === "postgres" && !postgresUrl },
    async () => {
      const f = await fixture(backend);
      try {
        const before = await Promise.all([
          f.query("objects", "SELECT count(*) AS n FROM $schema.objects"),
          f.query(
            "scriptStudio",
            "SELECT count(*) AS n FROM $schema.script_productions",
          ),
          f.query("reader", "SELECT count(*) AS n FROM $schema.books"),
        ]);
        for (const projectId of [f.spaces.dialogueId, f.spaces.inboxId]) {
          await assert.rejects(f.doc(projectId), /内容只能/);
          await assert.rejects(
            f.session.createPlatformScript({
              commandId: randomUUID(),
              productionId: randomUUID(),
              projectId,
              title: "禁止原件",
            }),
            /内容只能/,
          );
          await assert.rejects(
            f.session.importReading({
              commandId: randomUUID(),
              projectId,
              relativePath: "禁止.md",
              data: Buffer.from("# 原文\n不能留下导入字节"),
            }),
            /内容只能/,
          );
          const grant = await f.human((actor) =>
            f.domains.content.platform.authorizeApplicationProject(
              actor,
              f.domains.content.instanceIds.objects,
              "morphz.objects",
              projectId,
              f.domains.content.provider(),
            ),
          );
          assert.equal(
            grant.principalId,
            localAccess.principalId,
            "Session/app access is not content creation",
          );
          await assert.rejects(
            f.human((actor) =>
              f.domains.content.platform.recordContent(
                actor,
                {
                  instanceId: f.domains.content.instanceIds.objects,
                  proof: "not-a-creation-receipt",
                },
                {
                  commandId: randomUUID(),
                  appReceiptId: randomUUID(),
                  contentId: randomUUID(),
                  objectId: randomUUID(),
                  projectId,
                  kind: "document",
                  title: "禁止目录",
                  observedVersionRef: "1",
                },
              ),
            ),
            /内容只能/,
          );
        }
        assert.deepEqual(
          await Promise.all([
            f.query("objects", "SELECT count(*) AS n FROM $schema.objects"),
            f.query(
              "scriptStudio",
              "SELECT count(*) AS n FROM $schema.script_productions",
            ),
            f.query("reader", "SELECT count(*) AS n FROM $schema.books"),
          ]),
          before,
        );
        const originalBytes = new DatabaseSync(
          join(f.directory, "reader-originals", "manifest.sqlite"),
          { readOnly: true },
        );
        try {
          assert.equal(
            (
              originalBytes
                .prepare("SELECT count(*) AS n FROM artifacts")
                .get() as { n: number }
            ).n,
            0,
          );
        } finally {
          originalBytes.close();
        }
        assert.equal(
          (await f.human((actor) => f.domains.work.service.listContent(actor)))
            .length,
          0,
        );
        const original = await f.doc(f.spaces.deskId);
        assert.equal(original.projectId, f.spaces.deskId);
        assert.equal(
          f.transport.runtimeState(),
          null,
          "content operations are not Human messages",
        );
      } finally {
        await f.close();
      }
    },
  );

  test(
    `${backend}: 有效工作关系不能跨项目悬挂；原项目整理、已解除或已删除端点不误阻止`,
    { skip: backend === "postgres" && !postgresUrl },
    async () => {
      const f = await fixture(backend);
      try {
        const a = await f.doc(),
          b = await f.doc();
        const relationId = await f.human((actor) =>
          f.domains.work.service.linkWork(actor, {
            commandId: randomUUID(),
            fromId: a.contentId,
            toId: b.contentId,
            kind: "references",
          }),
        );
        const baseline = await f.human((actor) =>
          f.domains.content.platform.content(actor, a.contentId),
        );
        await assert.rejects(
          f.human((actor) =>
            f.domains.work.service.moveContent(actor, {
              commandId: randomUUID(),
              contentId: a.contentId,
              expectedRevision: 1,
              targetProjectId: f.targetProjectId,
            }),
          ),
          /关联/,
        );
        await assert.rejects(
          f.human((actor) =>
            f.domains.work.service.createProjectForContent(actor, {
              commandId: randomUUID(),
              projectId: "must-not-exist",
              title: "不该创建",
              contentId: a.contentId,
              expectedRevision: 1,
            }),
          ),
          /关联/,
        );
        await assert.rejects(
          f.human((actor) =>
            f.domains.work.service.getProject(actor, {
              projectId: "must-not-exist",
            }),
          ),
          /无权|不存在/,
        );
        assert.deepEqual(
          await f.human((actor) =>
            f.domains.content.platform.content(actor, a.contentId),
          ),
          baseline,
        );
        const sameProject = {
          commandId: randomUUID(),
          contentId: a.contentId,
          expectedRevision: 1,
          targetProjectId: f.projectId,
        };
        assert.equal(
          await f.human((actor) =>
            f.domains.work.service.moveContent(actor, sameProject),
          ),
          a.contentId,
        );
        assert.equal(
          await f.human((actor) =>
            f.domains.work.service.moveContent(actor, sameProject),
          ),
          a.contentId,
        );
        // Exercise current relational-storage absence, not an invented unlink UI.
        if (f.admin)
          await f.admin.query(
            `DELETE FROM "${f.schemas.platform}".work_relations WHERE relation_id=$1`,
            [relationId],
          );
        else {
          const db = new DatabaseSync(join(f.directory, "platform.sqlite"));
          try {
            db.prepare("DELETE FROM work_relations WHERE relation_id=?").run(
              relationId,
            );
          } finally {
            db.close();
          }
        }
        const move = {
          commandId: randomUUID(),
          contentId: a.contentId,
          expectedRevision: 2,
          targetProjectId: f.targetProjectId,
        };
        await f.human((actor) =>
          f.domains.work.service.moveContent(actor, move),
        );
        assert.equal(
          (
            await f.human((actor) =>
              f.domains.content.platform.content(actor, a.contentId),
            )
          ).project_id,
          f.targetProjectId,
        );
        const c = await f.doc();
        await f.human((actor) =>
          f.domains.work.service.linkWork(actor, {
            commandId: randomUUID(),
            fromId: b.contentId,
            toId: c.contentId,
            kind: "references",
          }),
        );
        if (f.admin)
          await f.admin.query(
            `UPDATE "${f.schemas.platform}".content_entries SET deleted_at=$1 WHERE content_id=$2`,
            [new Date().toISOString(), c.contentId],
          );
        else {
          const db = new DatabaseSync(join(f.directory, "platform.sqlite"));
          try {
            db.prepare(
              "UPDATE content_entries SET deleted_at=? WHERE content_id=?",
            ).run(new Date().toISOString(), c.contentId);
          } finally {
            db.close();
          }
        }
        await f.human((actor) =>
          f.domains.work.service.moveContent(actor, {
            commandId: randomUUID(),
            contentId: b.contentId,
            expectedRevision: 1,
            targetProjectId: f.targetProjectId,
          }),
        );
        const body = await f.human((actor) =>
          f.domains.content.objects.readDocument({
            credential: actor.credential,
            objectId: a.objectId,
            revision: 1,
          }),
        );
        assert.equal(body.content.markdown, "不可重复保存的正文");
        assert.equal(body.revision, 1);
      } finally {
        await f.close();
      }
    },
  );
}

test("Agent 正式工具不能在沟通或事项空间落原件，不留下私库孤儿", async () => {
  const f = await agentDomainFixture();
  try {
    const spaces = await f.withHuman((actor) =>
      f.domains.work.service.ensurePersonalSpaces(actor),
    );
    for (const projectId of [spaces.dialogueId, spaces.inboxId]) {
      const route = f.input(projectId);
      await assert.rejects(
        f.call(
          {
            action: "create-document",
            title: "禁止 Agent 原件",
            markdown: "原文",
          },
          route,
        ),
        /内容只能/,
      );
      await assert.rejects(
        f.call(
          {
            action: "script",
            script: {
              action: "command",
              command: {
                action: "create-production",
                projectId,
                title: "禁止 Agent 剧本",
              },
            },
          },
          route,
        ),
        /内容只能/,
      );
    }
    assert.equal(
      (await f.withHuman((actor) => f.domains.work.service.listContent(actor)))
        .length,
      0,
    );
    for (const [filename, table] of [
      ["objects.sqlite", "objects"],
      ["script-studio.sqlite", "script_productions"],
    ]) {
      const db = new DatabaseSync(join(f.directory, filename!), {
        readOnly: true,
      });
      try {
        assert.equal(
          (
            db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
              n: number;
            }
          ).n,
          0,
        );
      } finally {
        db.close();
      }
    }
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test(
  "PostgreSQL: move 已锁项目时，排队 link 在取锁后复读真实端点，拒绝跨项目旧观察",
  { skip: !postgresUrl },
  async () => {
    const f = await fixture("postgres");
    const barrier = await f.admin!.connect();
    let moving: Promise<unknown> | undefined,
      linking: Promise<unknown> | undefined;
    try {
      const a = await f.doc(),
        b = await f.doc();
      await barrier.query("BEGIN");
      await barrier.query(
        `SELECT project_id FROM "${f.schemas.platform}".projects WHERE project_id=$1 FOR UPDATE`,
        [f.projectId],
      );
      const waitForLock = async (pattern: string) => {
        const until = Date.now() + 5000;
        while (Date.now() < until) {
          const waiting = await f.admin!.query(
            `SELECT a.pid FROM pg_stat_activity a
          WHERE a.datname=current_database() AND a.query LIKE $1
            AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.relation=$2::regclass)
            AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted)`,
            [pattern, `"${f.schemas.platform}".projects`],
          );
          if (waiting.rowCount) return;
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        throw new Error(`没有观察到真实 PostgreSQL 等锁：${pattern}`);
      };
      moving = f.human((actor) =>
        f.domains.work.service.moveContent(actor, {
          commandId: randomUUID(),
          contentId: a.contentId,
          expectedRevision: 1,
          targetProjectId: f.targetProjectId,
        }),
      );
      await waitForLock("SELECT project_id FROM projects%FOR UPDATE%");
      linking = f.human((actor) =>
        f.domains.work.service.linkWork(actor, {
          commandId: randomUUID(),
          fromId: a.contentId,
          toId: b.contentId,
          kind: "references",
        }),
      );
      const rejected = assert.rejects(linking, /同一项目/);
      await waitForLock(
        "SELECT 1 AS allowed FROM project_members%FOR SHARE OF m,p%",
      );
      await barrier.query("COMMIT");
      await moving;
      await rejected;
      assert.equal(
        (
          await f.query(
            "platform",
            "SELECT count(*) AS n FROM $schema.work_relations",
          )
        )[0]!.n,
        "0",
      );
    } finally {
      await barrier.query("ROLLBACK");
      barrier.release();
      await Promise.allSettled(
        [moving, linking].filter((value): value is Promise<unknown> => !!value),
      );
      await f.close();
    }
  },
);
