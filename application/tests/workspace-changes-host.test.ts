import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { Application } from "../packages/application/src/application.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import { sqliteChangeSource } from "../packages/storage/src/commit-notifications.js";
import { sqliteQuery, publishSqlCommit } from "../packages/storage/src/sql.js";
import {
  workspaceChangeSchema,
  workspaceChangeScopeSchema,
  type WorkspaceChange,
} from "../packages/core/src/workspace-changes.js";
import { localAccess } from "../packages/core/src/model.js";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("变化通知未到达");
    await pause(10);
  }
}

test("workspace 独立 strict frame 不接受数据、身份或scope泄漏", () => {
  assert.deepEqual(workspaceChangeScopeSchema.parse({ kind: "workspace" }), {
    kind: "workspace",
  });
  for (const scope of [
    { kind: "workspace", projectId: "secret" },
    { kind: "workspace", credential: "private" },
  ])
    assert.equal(workspaceChangeScopeSchema.safeParse(scope).success, false);
  const frame = {
    kind: "workspace",
    sequence: 1,
    reason: "resync",
    accessChanged: false,
  };
  assert.deepEqual(workspaceChangeSchema.parse(frame), frame);
  for (const bad of [
    { ...frame, sequence: 0 },
    { ...frame, database: "/private" },
    { ...frame, projectIds: ["secret"] },
    { ...frame, version: "privatehash" },
  ])
    assert.equal(workspaceChangeSchema.safeParse(bad).success, false);
});

test("Session订阅ready后resync，健康闲置不读，异步读取中提交不能丢失", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE items(id INTEGER PRIMARY KEY,value INTEGER)");
  const source = sqliteChangeSource(database);
  const transport = new WorkspaceStore(":memory:", { mode: "transport" });
  let reads = 0,
    revision = "1",
    gate: Promise<void> | undefined,
    release: (() => void) | undefined;
  const app = new Application(transport, {
    workspaceChanges: {
      sources: [source],
      async readVersion() {
        reads++;
        const value = revision;
        if (gate) {
          const wait = gate;
          gate = undefined;
          await wait;
        }
        return { version: value, accessVersion: "grant", projectIds: [] };
      },
    },
  });
  const frames: WorkspaceChange[] = [];
  const dispose = await app
    .session(localAccess, () => {})
    .observeWorkspaceChanges(
      (frame) => frames.push(frame),
      () => {},
    );
  const commit = async (id: number) => {
    database.exec("BEGIN");
    const q = sqliteQuery(database);
    await q.change("INSERT INTO items VALUES(?,?)", [id, id]);
    database.exec("COMMIT");
    publishSqlCommit(q, source);
  };
  try {
    await until(() => frames.length === 1);
    assert.deepEqual(frames[0], {
      kind: "workspace",
      sequence: 1,
      reason: "resync",
      accessChanged: false,
    });
    const baselineReads = reads;
    await pause(150);
    assert.equal(reads, baselineReads, "no healthy interval reads");
    await commit(1);
    await until(() => reads > baselineReads);
    await pause(30);
    assert.equal(frames.length, 1, "unchanged commit hint is not state");
    gate = new Promise((resolve) => {
      release = resolve;
    });
    revision = "2";
    const before = reads;
    await commit(2);
    await until(() => reads > before);
    revision = "3";
    await commit(3);
    await pause(10);
    release!();
    await until(() => frames.length === 3);
    assert.deepEqual(
      frames.map((f) => f.sequence),
      [1, 2, 3],
    );
    const count = reads;
    dispose();
    await commit(4);
    await pause(30);
    assert.equal(reads, count);
  } finally {
    dispose();
    await pause(0);
    database.close();
    transport.close();
  }
});

test("取消发生在授权读取期间：不发布旧连接frame", async () => {
  const transport = new WorkspaceStore(":memory:", { mode: "transport" });
  let release!: () => void,
    started = false,
    closed = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const app = new Application(transport, {
    workspaceChanges: {
      sources: [],
      async readVersion() {
        started = true;
        await gate;
        return { version: "private", accessVersion: "grant", projectIds: [] };
      },
    },
  });
  const connection = new LocalApplicationConnection(app);
  const boot = (await connection.call("platform.bootstrap")) as {
    csrfToken: string;
  };
  const frames: unknown[] = [],
    id = randomUUID();
  try {
    await connection.observe(
      id,
      { kind: "workspace" },
      boot.csrfToken,
      (frame) => frames.push(frame),
      () => closed++,
    );
    await until(() => started);
    connection.unobserve(id);
    release();
    await pause(20);
    assert.equal(frames.length, 0);
    assert.equal(closed, 1);
    await assert.rejects(
      connection.observe(
        randomUUID(),
        { kind: "workspace", projectId: "private" },
        boot.csrfToken,
        () => {},
        () => {},
      ),
    );
  } finally {
    release();
    connection.close();
    transport.close();
  }
});

for (const driver of ["sqlite", "postgres"] as const)
  test(
    `${driver} 真实Domain Host：五Store提交触发独立native通知，重放/冲突不伪造变更`,
    { skip: driver === "postgres" && !process.env.MORPHZ_TEST_POSTGRES_URL },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "morphz-workspace-host-"));
      const transport = new WorkspaceStore(
        join(directory, "workspace.sqlite"),
        {
          mode: "transport",
        },
      );
      const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
      const schemas = {
        platform: `wh_p_${suffix}`,
        objects: `wh_o_${suffix}`,
        scriptStudio: `wh_s_${suffix}`,
        reader: `wh_r_${suffix}`,
        browser: `wh_b_${suffix}`,
      };
      const url = process.env.MORPHZ_TEST_POSTGRES_URL!;
      const admin =
        driver === "postgres" ? new Pool({ connectionString: url }) : undefined;
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
                connectionString: url,
                schema: schemas.platform,
              },
              applications: {
                deploymentId: `workspace_${suffix}`,
                connectionStrings: {
                  objects: url,
                  scriptStudio: url,
                  reader: url,
                  browser: url,
                },
                schemas: {
                  objects: schemas.objects,
                  scriptStudio: schemas.scriptStudio,
                  reader: schemas.reader,
                  browser: schemas.browser,
                },
              },
            }
          : {},
      );
      let reads = 0,
        completedVersion: string | undefined,
        holdNextProof: Promise<void> | undefined,
        releaseProof: (() => void) | undefined,
        heldVersion: string | undefined;
      const frameVersions: (string | undefined)[] = [];
      const connection = new LocalApplicationConnection(
        new Application(transport, {
          platformWork: domains.work,
          platformDocuments: domains.content,
          platformScripts: domains.content,
          platformReader: domains.reader,
          bookmarkDomain: domains.browser,
          workspaceChanges: {
            ...domains.workspaceChanges,
            async readVersion(...args) {
              reads++;
              const value = await domains.workspaceChanges.readVersion(...args);
              if (holdNextProof && value.version !== frameVersions.at(-1)) {
                const gate = holdNextProof;
                holdNextProof = undefined;
                heldVersion = value.version;
                await gate;
              }
              completedVersion = value.version;
              return value;
            },
          },
        }),
      );
      const frames: WorkspaceChange[] = [];
      const observedCommit = async () => {
        // Cross-store operations can legitimately publish an intermediate
        // proof. Wait for the exact current committed metadata version, not
        // an arbitrary count increase from an earlier operation's late hint.
        const expected = await domains.workspaceChanges.readVersion(
          localAccess,
          () => {},
        );
        await until(() => frameVersions.at(-1) === expected.version);
        return frames.length;
      };
      try {
        const boot = (await connection.call("platform.bootstrap")) as {
          csrfToken: string;
        };
        const opts = { identityGeneration: boot.csrfToken };
        const spaces = (await connection.call(
          "spaces.ensure",
          undefined,
          opts,
        )) as { deskId: string };
        const id = randomUUID();
        await connection.observe(
          id,
          { kind: "workspace" },
          boot.csrfToken,
          (frame) => {
            assert.ok("kind" in frame);
            frames.push(frame);
            frameVersions.push(completedVersion);
          },
          () => {},
        );
        await until(() => frames.length === 1);
        assert.equal(domains.workspaceChanges.sources.length, 5);
        const baseline = reads;
        await pause(6100);
        assert.equal(reads, baseline);
        const task = {
          commandId: randomUUID(),
          taskId: "notify-task",
          projectId: spaces.deskId,
          title: "完整正文不得出frame",
          assigneeId: localAccess.actantId,
        };
        await connection.call("tasks.create", task, opts);
        await observedCommit();
        assert.equal(frames.length, 2);
        await connection.call("tasks.create", task, opts);
        await pause(60);
        assert.equal(frames.length, 2);
        const doc = (await connection.call(
          "documents.create",
          {
            commandId: randomUUID(),
            objectId: "notify-document",
            projectId: spaces.deskId,
            title: "文档",
            markdown: "exact quote",
          },
          opts,
        )) as { contentId: string };
        const before = await observedCommit();
        assert.ok(before >= 3);
        await connection.call(
          "objects.annotate",
          {
            commandId: randomUUID(),
            contentId: doc.contentId,
            revision: 1,
            quote: "exact quote",
            body: "私有批注不出frame",
          },
          opts,
        );
        const beforeBookmark = await observedCommit();
        assert.ok(beforeBookmark > before);
        await connection.call(
          "bookmarks.command",
          {
            commandId: randomUUID(),
            operation: {
              type: "bookmark-add",
              title: "私人收藏",
              url: "https://example.test/workspace",
            },
          },
          opts,
        );
        assert.ok((await observedCommit()) > beforeBookmark);
        const contents = (await connection.call(
          "reader.contents",
          { artifactId: doc.contentId, revision: 1 },
          opts,
        )) as { id: string }[];
        const section = (await connection.call(
          "reader.read",
          {
            artifactId: doc.contentId,
            revision: 1,
            sectionId: contents[0]!.id,
          },
          opts,
        )) as { id: string; sourceId: string; text: string };
        const beforeMark = await observedCommit();
        await connection.call(
          "reader.command",
          {
            commandId: randomUUID(),
            artifactId: doc.contentId,
            revision: 1,
            command: {
              action: "mark-add",
              artifactId: doc.contentId,
              artifactRevision: 1,
              location: {
                sourceId: section.sourceId,
                sectionId: section.id,
                start: 0,
                end: 5,
              },
              quote: section.text.slice(0, 5),
              kind: "note",
              color: "yellow",
              note: "本人阅读标注",
            },
          },
          opts,
        );
        assert.ok((await observedCommit()) > beforeMark);
        // Deterministically reproduce the original count race under a delayed
        // PG/SQLite proof: the create proof is captured, but has not yet reached
        // the renderer when the item's newer committed revision is written.
        const beforeScript = frames.length;
        holdNextProof = new Promise((resolve) => {
          releaseProof = resolve;
        });
        const script = (await connection.call(
          "scripts.create",
          {
            commandId: randomUUID(),
            productionId: "notify-script",
            projectId: spaces.deskId,
            title: "剧本原件",
          },
          opts,
        )) as { contentId: string };
        await until(() => heldVersion !== undefined);
        await connection.call(
          "scripts.item.create",
          {
            commandId: randomUUID(),
            contentId: script.contentId,
            itemId: "notify-item",
            expectedActivityRevision: 1,
            kind: "setting",
            draft: emptyScriptDraft("剧本项目"),
          },
          opts,
        );
        const committedScript = await domains.content.authority.withSession(
          localAccess,
          () => {},
          (actor) =>
            domains.content.studio.readProductionHead({
              credential: actor.credential,
              productionId: "notify-script",
            }),
        );
        assert.equal(committedScript.versionRef, "2");
        const finalScriptVersion = await domains.workspaceChanges.readVersion(
          localAccess,
          () => {},
        );
        assert.notEqual(heldVersion, finalScriptVersion.version);
        releaseProof!();
        await until(() => frames.length > beforeScript);
        assert.equal(frameVersions[beforeScript], heldVersion);
        assert.notEqual(
          frameVersions[beforeScript],
          finalScriptVersion.version,
          "第一帧只是上一提交的迟到proof，不能认定item通知已到",
        );
        const count = await observedCommit();
        assert.ok(count > beforeScript, "通知包含已提交的item活动修订2");
        await assert.rejects(
          connection.call(
            "documents.revise",
            {
              commandId: randomUUID(),
              contentId: doc.contentId,
              expectedRevision: 999,
              title: "错误",
              markdown: "不写入",
            },
            opts,
          ),
        );
        await pause(60);
        assert.equal(frames.length, count);
        for (const frame of frames)
          assert.deepEqual(Object.keys(frame).sort(), [
            "accessChanged",
            "kind",
            "reason",
            "sequence",
          ]);
        assert.doesNotMatch(
          JSON.stringify(frames),
          /正文|exact|quote|私有|notify-task|database|credential|revision|principal/,
        );
        connection.unobserve(id);
      } finally {
        releaseProof?.();
        connection.close();
        await pause(10);
        await domains.close();
        transport.close();
        if (admin) {
          for (const schema of Object.values(schemas))
            await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
          await admin.end();
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

const authority: PlatformAuthorityVerifier = {
  async resolveActor({ credential }) {
    const [tenantId, principalId] = credential.split(":");
    if (!tenantId || !principalId) return null;
    return {
      tenantId,
      principalId,
      actantId: principalId,
      kind: "human",
      runtimeInputId: null,
    };
  },
  async resolveActant({ actantId }) {
    return { principalId: actantId, kind: "human" };
  },
  async resolveProjectAgent() {
    return { principalId: "morphz-service", actantId: "morphz-agent" };
  },
  async verifyApplicationObject() {
    return false;
  },
};
for (const driver of ["sqlite", "postgres"] as const)
  test(
    `${driver} 授权proof：不同tenant/本人不可读项目提交不发frame，撤权accessChanged`,
    { skip: driver === "postgres" && !process.env.MORPHZ_TEST_POSTGRES_URL },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "morphz-workspace-grants-")),
        schema = `wc_${randomUUID().replaceAll("-", "")}`;
      const admin =
        driver === "postgres"
          ? new Pool({ connectionString: process.env.MORPHZ_TEST_POSTGRES_URL })
          : undefined;
      if (admin) await admin.query(`CREATE SCHEMA "${schema}"`);
      const platform = admin
        ? await PlatformStore.postgres(
            { connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!, schema },
            authority,
          )
        : await PlatformStore.sqlite(
            join(directory, "platform.sqlite"),
            authority,
          );
      const transport = new WorkspaceStore(":memory:", { mode: "transport" });
      const alice = { credential: "tenant-a:alice" },
        bob = { credential: "tenant-a:bob" },
        other = { credential: "tenant-b:alice" };
      let reads = 0;
      try {
        await platform.provisionTenant("tenant-a");
        await platform.provisionTenant("tenant-b");
        await platform.createProject(alice, {
          commandId: "visible-create",
          projectId: "visible",
          title: "visible",
        });
        await platform.createProject(bob, {
          commandId: "private-create",
          projectId: "private",
          title: "private",
        });
        await platform.createProject(other, {
          commandId: "other-create",
          projectId: "other",
          title: "other",
        });
        const frames: WorkspaceChange[] = [];
        const app = new Application(transport, {
          workspaceChanges: {
            sources: [platform.changeSource()],
            async readVersion() {
              reads++;
              return platform.workspaceChangeVersion(alice);
            },
          },
        });
        const dispose = await app
          .session(localAccess, () => {})
          .observeWorkspaceChanges(
            (frame) => frames.push(frame),
            () => {},
          );
        try {
          await until(() => frames.length === 1);
          const a = reads;
          await platform.createTask(bob, {
            commandId: "private-task",
            taskId: "private-task",
            projectId: "private",
            title: "private",
            assigneeId: "bob",
          });
          await until(() => reads > a);
          await pause(30);
          assert.equal(frames.length, 1);
          const b = reads;
          await platform.createTask(other, {
            commandId: "other-task",
            taskId: "other-task",
            projectId: "other",
            title: "other",
            assigneeId: "alice",
          });
          await until(() => reads > b);
          await pause(30);
          assert.equal(frames.length, 1);
          await platform.createTask(alice, {
            commandId: "visible-task",
            taskId: "visible-task",
            projectId: "visible",
            title: "visible",
            assigneeId: "alice",
          });
          await until(() => frames.length === 2);
          await platform.reconcileOperatorMembers("tenant-a", [
            {
              principalId: "alice",
              actantId: "alice",
              projectIds: [],
              enabled: false,
            },
          ]);
          await until(() => frames.length === 3);
          assert.equal(frames[2]!.accessChanged, true);
          assert.deepEqual(
            (await platform.workspaceChangeVersion(alice)).projectIds,
            [],
          );
        } finally {
          dispose();
          await pause(10);
        }
      } finally {
        await platform.close();
        transport.close();
        if (admin) {
          await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
          await admin.end();
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
