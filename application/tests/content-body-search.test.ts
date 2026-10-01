import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer as createPortServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { Pool } from "pg";
import { createAppServer } from "../apps/service/src/http.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { localAccess } from "../packages/core/src/model.js";
import { createImage } from "../packages/application/src/document-service.js";
import { searchDomainFixture } from "./search-domain-fixture.js";

const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;
const other = { principalId: "other-reader", actantId: "other-human" };

async function fixture(backend: "sqlite" | "postgres") {
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
  try {
    if (admin)
      for (const schema of Object.values(schemas))
        await admin.query(`CREATE SCHEMA "${schema}"`);
    const f = await searchDomainFixture({
      additionalHumans: [other],
      ...(admin
        ? {
            storage: {
              platform: {
                kind: "postgres" as const,
                connectionString: postgresUrl!,
                schema: schemas.platform,
              },
              applications: {
                connectionStrings: {
                  objects: postgresUrl!,
                  scriptStudio: postgresUrl!,
                  reader: postgresUrl!,
                  browser: postgresUrl!,
                },
                deploymentId: `search_${suffix}`,
                schemas: {
                  objects: schemas.objects,
                  scriptStudio: schemas.scriptStudio,
                  reader: schemas.reader,
                  browser: schemas.browser,
                },
              },
            },
          }
        : {}),
    });
    return {
      ...f,
      async tieCatalogTimes(ids: string[]) {
        // Deliberately make current directory ordering differ from the App's
        // original/index dates, and exercise stable ID ties in both backends.
        const time = "2026-09-30T00:00:00.000Z";
        if (admin) {
          await admin.query(
            `UPDATE "${schemas.platform}".content_entries SET created_at=$1,updated_at=$1 WHERE content_id=ANY($2::text[])`,
            [time, ids],
          );
        } else {
          const db = new DatabaseSync(
            join(f.host.directory, "platform.sqlite"),
          );
          try {
            for (const id of ids)
              db.prepare(
                "UPDATE content_entries SET created_at=?,updated_at=? WHERE content_id=?",
              ).run(time, time, id);
          } finally {
            db.close();
          }
        }
        return time;
      },
      async close() {
        try {
          await f.close();
        } finally {
          if (admin) {
            for (const schema of Object.values(schemas))
              await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
            await admin.end();
          }
        }
      },
    };
  } catch (error) {
    if (admin) {
      for (const schema of Object.values(schemas))
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    throw error;
  }
}

async function http(f: Awaited<ReturnType<typeof fixture>>) {
  const portServer = createPortServer();
  await new Promise<void>((resolve) =>
    portServer.listen(0, "127.0.0.1", resolve),
  );
  const port = (portServer.address() as { port: number }).port;
  await new Promise<void>((resolve) => portServer.close(() => resolve()));
  const server = createAppServer(f.host.transport, {
    port,
    webRoot: "/nonexistent",
    identity: f.host.identity,
    platformWork: f.host.domains.work,
    platformDocuments: f.host.domains.content,
    platformReader: f.host.domains.reader,
    images: f.host.domains.images,
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  const origin = `http://127.0.0.1:${port}`;
  try {
    const loginToken = createHash("sha256")
      .update("isolated-body-search-login")
      .digest("hex");
    await f.host.identity!.replaceConfiguration(
      {
        version: 1,
        members: [localAccess, other].map((human) => ({
          ...human,
          enabled: true,
          loginTokenHash: createHash("sha256")
            .update(
              human.principalId === localAccess.principalId
                ? loginToken
                : "f".repeat(64),
            )
            .digest("hex"),
        })),
      },
      [
        { ...localAccess, enabled: true, projectIds: [f.projectId] },
        { ...other, enabled: true, projectIds: [] },
      ],
    );
    const login = await fetch(`${origin}/api/identity/login`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        token: loginToken,
      }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie()[0]!.split(";")[0]!;
    return {
      origin,
      cookie,
      client: new HttpApplicationClient(origin, (url, init) =>
        fetch(url, { ...init, headers: { ...init?.headers, Cookie: cookie } }),
      ),
      async close() {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
}

for (const backend of ["sqlite", "postgres"] as const) {
  const settings = { skip: backend === "postgres" && !postgresUrl };
  test(
    `${backend}: 正文独占 feed 跨候选页去重，按当前目录 Unicode/日期和 ID 稳定分页，Human/HTTP/Agent 使用同一搜索`,
    settings,
    async () => {
      const f = await fixture(backend);
      try {
        const originals: Array<{ contentId: string; title: string }> = [];
        for (const title of [
          "zebra",
          "A",
          "é",
          "中",
          "\uE000",
          "🙂",
          "\uFFFD",
          "B",
          "A",
        ])
          originals.push({
            ...(await f.createAgent(title, `needle 原创正文 ${title}`)),
            title,
          });
        // More than one App search page, all of which belong to the independent
        // title feed, must not consume a body offset or inflate its total.
        for (let i = 0; i < 51; i++)
          await f.createAgent(
            `needle 完整标题 ${i}`,
            "needle 标题与正文都命中",
          );
        const mixed = await f.createAgent("needle 前缀", "extra 原创正文");
        await f.createHuman("人工原件", "needle 不进入全文索引");
        await f.import("needle 外部原件", "外部.md");
        const time = await f.tieCatalogTimes(
          originals.map((row) => row.contentId),
        );
        const titleOrder = [
          "A",
          "B",
          "zebra",
          "é",
          "中",
          "\uE000",
          "\uFFFD",
          "🙂",
        ];
        const expected = titleOrder.flatMap((title) =>
          originals
            .filter((row) => row.title === title)
            .map((row) => row.contentId)
            .sort(),
        );
        const defaults = await f.search({ query: "needle", limit: 50 });
        assert.equal(defaults.total, 61, "原有快速搜索仍同时包含标题和正文");
        const all = [];
        for (const offset of [0, 3, 6]) {
          const page = await f.search({
            query: "needle",
            includeTitles: false,
            kind: "document",
            appIds: ["morphz.objects"],
            sort: "title",
            limit: 3,
            offset,
          });
          assert.equal(page.total, 9);
          assert.equal(page.hasMore, offset < 6);
          assert.ok(
            page.hits.every(
              (hit) =>
                hit.createdAt === time &&
                hit.updatedAt === time &&
                hit.revision === 1 &&
                hit.matchedIn === "content",
            ),
          );
          all.push(...page.hits.map((hit) => hit.artifactId));
        }
        assert.deepEqual(all, expected);
        const byIdDescending = originals
          .map((row) => row.contentId)
          .sort()
          .reverse();
        for (const sort of ["created", "updated"] as const)
          assert.deepEqual(
            (
              await f.search({ query: "needle", includeTitles: false, sort })
            ).hits.map((hit) => hit.artifactId),
            byIdDescending,
          );
        const partial = await f.search({
          query: "needle extra",
          includeTitles: false,
        });
        assert.equal(partial.total, 1);
        assert.equal(partial.hits[0]?.artifactId, mixed.contentId);
        assert.match(partial.hits[0]!.quote, /extra/);
        assert.equal(
          (await f.search({ query: "needle", includeTitles: false, offset: 9 }))
            .hasMore,
          false,
        );

        const agent = await f.host.call<{
          hits: { artifactId: string }[];
          total: number;
        }>({
          action: "operations",
          operations: {
            action: "invoke",
            operationId: "content.search",
            parameters: {
              query: "needle",
              includeTitles: false,
              kinds: ["document"],
              appIds: ["morphz.objects"],
              sort: "title",
              limit: 3,
            },
          },
        });
        assert.equal(agent.total, 9);
        assert.deepEqual(
          agent.hits.map((hit) => hit.artifactId),
          expected.slice(0, 3),
        );
        const web = await http(f);
        try {
          const value = (await web.client.call("search", {
            query: "needle",
            includeTitles: false,
            kinds: ["document"],
            appIds: ["morphz.objects"],
            sort: "title",
            limit: 3,
            offset: 3,
          })) as typeof agent;
          assert.equal(value.total, 9);
          assert.deepEqual(
            value.hits.map((hit) => hit.artifactId),
            expected.slice(3, 6),
          );
          const invalid = await fetch(
            `${web.origin}/api/search?q=needle&includeTitles=no`,
            { headers: { Cookie: web.cookie } },
          );
          assert.equal(invalid.status, 400);
          await assert.rejects(
            web.client.call("search", {
              query: "needle",
              kind: "document",
              kinds: ["image"],
            }),
            { status: 400 },
          );
        } finally {
          await web.close();
        }
        f.assertNoLegacyData();
      } finally {
        await f.close();
      }
    },
  );

  test(
    `${backend}: 类型/应用范围先于正文计数；索引来源、精确 App 版本与真实身份撤权保持`,
    settings,
    async () => {
      const f = await fixture(backend);
      try {
        const doc = await f.createAgent("文档原件", "needle 第一版");
        await f.createHuman("人工原件", "needle 人工正文");
        await f.import("needle 导入正文", "外部.md");
        await f.session().importReading({
          commandId: randomUUID(),
          projectId: f.projectId,
          relativePath: "阅读.md",
          data: Buffer.from("# 阅读原文\nneedle 读物正文"),
        });
        const png = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGmQAAAAASUVORK5CYII=",
          "base64",
        );
        const upload = await f.host.withHuman((actor) =>
          f.host.domains.images.service.upload(actor, png),
        );
        const reference = await f.host.withHuman((actor) =>
          f.host.domains.images.service.uploadedReference(
            actor,
            upload.assetId,
          ),
        );
        const image = await f.host.withAgent(async (actor) =>
          createImage({
            platform: f.host.domains.content.platform,
            objects: f.host.domains.content.objects,
            actor,
            instanceId: f.host.domains.content.instanceIds.objects,
            commandId: randomUUID(),
            objectId: randomUUID(),
            projectId: f.projectId,
            title: "图片原件",
            assetId: upload.assetId,
            alt: "needle 图片说明",
            reference,
          }),
        );
        assert.equal(
          (await f.search({ query: "needle", includeTitles: false })).total,
          2,
        );
        assert.deepEqual(
          (
            await f.search({
              query: "needle",
              includeTitles: false,
              kind: "document",
              offset: 0,
              limit: 1,
            })
          ).hits.map((hit) => hit.artifactId),
          [doc.contentId],
        );
        assert.deepEqual(
          (
            await f.search({
              query: "needle",
              includeTitles: false,
              kinds: ["image"],
            })
          ).hits.map((hit) => hit.artifactId),
          [image.contentId],
        );
        assert.equal(
          (
            await f.search({
              query: "needle",
              includeTitles: false,
              kind: "document",
              offset: 1,
            })
          ).total,
          1,
        );
        assert.equal(
          (
            await f.search({
              query: "needle",
              includeTitles: false,
              kind: "document",
              offset: 1,
            })
          ).hits.length,
          0,
        );
        for (const request of [
          { kind: "script" },
          { kinds: ["script"] },
          { appIds: ["morphz.reader"] },
          { appIds: ["morphz.script-studio"] },
          { appIds: ["third.party"] },
        ]) {
          const page = await f.search({
            query: "needle",
            includeTitles: false,
            ...request,
          });
          assert.deepEqual(page.hits, []);
          assert.equal(page.total, 0);
        }
        await assert.rejects(
          f.search({
            query: "needle",
            includeTitles: false,
            appIds: ["morphz.script-studio"],
            projectId: "unavailable-project",
          }),
          /不存在|权限|无权/,
        );
        assert.equal(
          (await f.search({ query: "needle", includeTitles: false }, other))
            .total,
          0,
        );
        await assert.rejects(
          f.search(
            { query: "needle", includeTitles: false, projectId: f.projectId },
            other,
          ),
          /权限|无权/,
        );

        // Change the genuine app version without projecting its committed outbox
        // yet. A stale observed directory version must never quote that new body.
        await f.host.withHuman((actor) =>
          f.host.domains.content.objects.reviseDocument({
            credential: actor.credential,
            commandId: randomUUID(),
            objectId: doc.objectId,
            expectedRevision: 1,
            title: "文档原件",
            markdown: "needle 第二版",
          }),
        );
        assert.equal(
          (
            await f.search({
              query: "needle",
              includeTitles: false,
              kind: "document",
            })
          ).total,
          0,
        );
        await f.reopen();
        const current = await f.search({
          query: "needle",
          includeTitles: false,
          kind: "document",
        });
        assert.equal(current.hits[0]?.revision, 2);
        assert.match(current.hits[0]!.quote, /第二版/);

        const configuration = {
          version: 1,
          members: [localAccess, other].map((human) => ({
            ...human,
            enabled: true,
            loginTokenHash: createHash("sha256")
              .update(`synthetic-login-${human.principalId}`)
              .digest("hex"),
          })),
        };
        await f.host.identity!.replaceConfiguration(configuration, [
          { ...localAccess, enabled: true, projectIds: [f.projectId] },
          { ...other, enabled: true, projectIds: [f.projectId] },
        ]);
        assert.equal(
          (await f.search({ query: "needle", includeTitles: false }, other))
            .total,
          2,
        );
        await f.host.identity!.replaceConfiguration(configuration, [
          { ...localAccess, enabled: true, projectIds: [f.projectId] },
          { ...other, enabled: true, projectIds: [] },
        ]);
        assert.equal(
          (await f.search({ query: "needle", includeTitles: false }, other))
            .total,
          0,
        );
        await assert.rejects(
          f.search(
            { query: "needle", includeTitles: false, projectId: f.projectId },
            other,
          ),
          /权限|无权/,
        );
        f.assertNoLegacyData();
      } finally {
        await f.close();
      }
    },
  );
}
