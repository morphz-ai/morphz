import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";
import {
  ScriptStudioStore,
  type ScriptResultRequest,
} from "../packages/script-studio/src/store.js";
import { scriptStudioSchemaSql } from "../packages/script-studio/src/schema.js";
import { schemaHash } from "../packages/storage/src/sql.js";

const report = {
  explanation: "完成本次创作。",
  checks: [
    { performed: true, revise: false, blocked: false, notes: "核对请求。" },
    { performed: false, revise: false, blocked: false, notes: "未执行。" },
  ],
};

async function fixture(backend: "sqlite" | "postgres") {
  const directory = mkdtempSync(join(tmpdir(), "morphz-result-first-"));
  const filename = join(directory, "studio.sqlite");
  const schema = `result_first_${randomUUID().replaceAll("-", "")}`;
  const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL;
  if (backend === "postgres")
    assert.ok(connectionString, "Use npm test to prepare dedicated PostgreSQL");
  const admin = backend === "postgres" ? new Pool({ connectionString }) : null;
  const state = {
    revoked: false,
    active: true,
    checks: 0,
    cancelAt: Infinity,
    inputId: "input-one",
    sourceChecks: 0,
    revokeSourceAt: Infinity,
  };
  const authority = {
    async assertInputActive() {
      state.checks++;
      if (!state.active || state.checks >= state.cancelAt)
        throw new Error("输入已取消。");
    },
    async authorizeCreate({
      credential,
      projectId,
    }: {
      credential: string;
      projectId: string;
    }) {
      if (
        state.revoked ||
        projectId !== "project-one" ||
        !["human", "agent"].includes(credential)
      )
        return null;
      return {
        tenantId: "tenant-one",
        principalId: "alice",
        actantId: credential === "human" ? "alice" : "morphz",
        kind: credential === "human" ? ("human" as const) : ("agent" as const),
        runtimeInputId: credential === "human" ? null : state.inputId,
      };
    },
    async authorizeObject({
      credential,
      productionId,
    }: {
      credential: string;
      productionId: string;
    }) {
      const actor = await this.authorizeCreate({
        credential,
        projectId: "project-one",
      });
      return actor && productionId === "production-one"
        ? { ...actor, projectId: "project-one", objectKind: "script" }
        : null;
    },
    async verifyReviewers() {
      return true;
    },
    async verifySourceVersion() {
      state.sourceChecks++;
      return state.sourceChecks < state.revokeSourceAt;
    },
  };
  if (admin) await admin.query(`CREATE SCHEMA "${schema}"`);
  const open = () =>
    backend === "sqlite"
      ? ScriptStudioStore.sqlite(filename, authority)
      : ScriptStudioStore.postgres({
          connectionString: connectionString!,
          schema,
          authority,
        });
  let store = await open();
  const production = await store.createProduction({
    credential: "human",
    commandId: "create-production",
    productionId: "production-one",
    requestedProjectId: "project-one",
    title: "结果优先测试",
  });
  await store.markDirectoryProjected(production.tenantId, production.eventId);
  const mark = async (receipt: { tenantId: string; eventId: string }) =>
    store.markDirectoryProjected(receipt.tenantId, receipt.eventId);
  const add = async (
    itemId: string,
    kind: "character" | "outline" | "episode" = "character",
    text = "原稿",
    sources: ScriptResultRequest["results"][number]["draft"]["sources"] = [],
  ) => {
    const head = await store.readProductionOverview({
      credential: "human",
      productionId: "production-one",
    });
    const item = await store.createItem({
      credential: "human",
      commandId: `create-${itemId}`,
      productionId: "production-one",
      itemId,
      expectedActivityRevision: head.activityRevision,
      kind,
      draft: { ...emptyScriptDraft(itemId), text, sources },
    });
    await mark(item);
    return item;
  };
  const prepare = async (
    targets: string[],
    submissionMode: "current" | "candidate" = "current",
    references: Array<{ itemId: string; revision: number }> = [],
  ) =>
    store.prepareGenerations({
      credential: "agent",
      commandId: `prepare-${state.inputId}`,
      productionId: "production-one",
      inputId: state.inputId,
      submissionMode,
      generations: targets.map((targetId) => ({
        productionId: "production-one",
        targetId,
        baseRevision: 1,
        contextRevision: 1,
        purpose: "draft" as const,
        references,
        maxCandidates: 1,
        maxOutputCharacters: 12000,
        maxReviewPasses: 1,
      })),
    });
  const result = (
    targetId: string,
    text = "创作后的实际正文",
  ): ScriptResultRequest["results"][number] => ({
    targetId,
    draft: { ...emptyScriptDraft(targetId), text, sources: [] },
    workflowReport: report,
  });
  const submit = (
    results: ScriptResultRequest["results"],
    commandId = "submit-one",
  ) =>
    store.submitResults({
      credential: "agent",
      commandId,
      productionId: "production-one",
      inputId: state.inputId,
      results,
    });
  return {
    state,
    get store() {
      return store;
    },
    add,
    prepare,
    result,
    submit,
    mark,
    async version(itemId: string, revision: number) {
      return store.readItemVersion({
        credential: "human",
        productionId: "production-one",
        itemId,
        revision,
      });
    },
    async reopen() {
      await store.close();
      store = await open();
    },
    async migrateFromV7() {
      await store.close();
      const oldSql = scriptStudioSchemaSql.replace(
        "  submission_mode TEXT NOT NULL DEFAULT 'candidate' CHECK (submission_mode IN ('candidate','current')),\n",
        "",
      );
      assert.equal(
        schemaHash(oldSql),
        "d0ae8d4ba27aaaca746bbf96a3ee18c2e184f95c330579f4cd63b28567951fef",
      );
      if (admin) {
        await admin.query(
          `ALTER TABLE "${schema}".script_preparations DROP COLUMN submission_mode`,
        );
        await admin.query(
          `UPDATE "${schema}".script_schema_version SET version=7,schema_sha256=$1`,
          [schemaHash(oldSql)],
        );
      } else {
        const db = new DatabaseSync(filename);
        try {
          db.exec(
            "ALTER TABLE script_preparations DROP COLUMN submission_mode",
          );
          db.prepare(
            "UPDATE script_schema_version SET version=7,schema_sha256=?",
          ).run(schemaHash(oldSql));
        } finally {
          db.close();
        }
      }
      store = await open();
    },
    async close() {
      await store.close();
      if (admin) {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(`${backend} Agent 直接创建及修订正文，真实作者与历史保留`, async () => {
    const f = await fixture(backend);
    try {
      const created = await f.store.createItem({
        credential: "agent",
        commandId: "agent-create",
        productionId: "production-one",
        itemId: "agent-item",
        expectedActivityRevision: 1,
        kind: "character",
        draft: {
          ...emptyScriptDraft("主角"),
          text: "直接创建的角色",
          sources: [],
        },
      });
      await f.mark(created);
      assert.equal(
        (await f.version("agent-item", 1)).draft.text,
        "直接创建的角色",
      );
      assert.deepEqual((await f.version("agent-item", 1)).author, {
        principalId: "alice",
        actantId: "morphz",
      });
      const request = {
        credential: "agent",
        commandId: "agent-revise",
        productionId: "production-one",
        itemId: "agent-item",
        expectedRevision: 1,
        draft: {
          ...emptyScriptDraft("主角"),
          text: "指导修改后的正文",
          sources: [],
        },
      };
      const revised = await f.store.reviseItem(request);
      assert.equal(
        (await f.version("agent-item", 2)).draft.text,
        request.draft.text,
      );
      f.state.active = false;
      assert.deepEqual(await f.store.reviseItem(request), revised);
      await assert.rejects(
        f.store.reviseItem({
          ...request,
          commandId: "new-after-cancel",
          expectedRevision: 2,
        }),
        /取消|目录/,
      );
      await f.mark(revised);
      assert.equal(
        (await f.version("agent-item", 1)).draft.text,
        "直接创建的角色",
      );
      f.state.active = true;
      const original = await f.version("agent-item", 1);
      const restored = await f.store.reviseItem({
        ...request,
        commandId: "agent-restore",
        expectedRevision: 2,
        restoreRevision: 1,
        draft: original.draft,
      });
      assert.equal(restored.itemRevision, 3);
      assert.equal(
        (await f.version("agent-item", 3)).draft.text,
        original.draft.text,
      );
      assert.equal(
        (await f.version("agent-item", 2)).draft.text,
        "指导修改后的正文",
      );
    } finally {
      await f.close();
    }
  });

  test(`${backend} 整批保存当前正文并绑定本批新角色版本，重开与换调用 ID 不重复`, async () => {
    const f = await fixture(backend);
    try {
      await f.add("character-one");
      await f.add("outline-one", "outline");
      assert.equal(
        (await f.prepare(["outline-one", "character-one"])).submissionMode,
        "current",
      );
      const character = f.result("character-one");
      const outline = f.result("outline-one", "以新角色为依据的大纲");
      outline.draft.dependencies = [{ itemId: "character-one", revision: 2 }];
      outline.draft.characters = ["character-one"];
      const before = await f.submit([outline, character]);
      assert.deepEqual(
        before.items.map((item) => [item.itemId, item.itemRevision]),
        [
          ["character-one", 2],
          ["outline-one", 2],
        ],
      );
      const version = await f.version("outline-one", 2);
      assert.deepEqual(version.draft.dependencies, [
        { itemId: "character-one", revision: 2 },
      ]);
      assert.equal(version.candidateId, null);
      assert.deepEqual(version.author, {
        principalId: "alice",
        actantId: "morphz",
      });
      assert.equal((await f.version("outline-one", 1)).draft.text, "原稿");
      const page = await f.store.listInputResults({
        credential: "agent",
        productionId: "production-one",
        inputId: "input-one",
        offset: 0,
        limit: 1,
      });
      assert.equal(page.total, 2);
      assert.equal(page.hasMore, true);
      assert.equal(page.results[0]!.kind, "item");
      const itemResult = await f.store.readInputResult({
        credential: "agent",
        productionId: "production-one",
        inputId: "input-one",
        resultId: before.items[1]!.receiptId,
      });
      const body = JSON.parse(itemResult.resultJson);
      assert.equal(itemResult.kind, "item");
      assert.equal(body.revision, 2);
      assert.equal(body.draft.text, outline.draft.text);
      assert.deepEqual(body.workflowReport.checks, report.checks);
      const deliveries = await f.store.listInputDeliveries({
        credential: "human",
        inputIds: ["input-one"],
        productionIds: ["production-one"],
      });
      assert.equal(deliveries.length, 2);
      assert.ok(
        deliveries.every(
          (delivery) =>
            delivery.kind === "item" &&
            delivery.revision === 2 &&
            delivery.isEmpty === false,
        ),
      );
      await f.reopen();
      f.state.active = false;
      assert.deepEqual(
        await f.submit([character, outline], "another-tool-call"),
        before,
      );
      assert.deepEqual(
        await f.store.readSubmittedResults({
          credential: "agent",
          productionId: "production-one",
          inputId: "input-one",
        }),
        before,
      );
      assert.equal((await f.version("outline-one", 2)).headRevision, 2);
      const changed = {
        ...outline,
        draft: { ...outline.draft, text: "另一个内容" },
      };
      await assert.rejects(
        f.submit([character, changed], "other-command"),
        /另一份创作结果/,
      );
      for (const item of before.items) await f.mark(item);
    } finally {
      await f.close();
    }
  });

  test(`${backend} 第二项无效时整批回滚，不留下半份正文或成功回执`, async () => {
    const f = await fixture(backend);
    try {
      await f.add("a-one");
      await f.add("b-one");
      await f.prepare(["a-one", "b-one"]);
      const invalid = f.result("b-one");
      invalid.draft.parentId = "a-one";
      await assert.rejects(f.submit([f.result("a-one"), invalid]), /所属集/);
      assert.equal((await f.version("a-one", 1)).headRevision, 1);
      assert.equal((await f.version("b-one", 1)).headRevision, 1);
      await assert.rejects(f.version("a-one", 2), /不存在|缺失/);
      const repaired = await f.submit([f.result("a-one"), f.result("b-one")]);
      assert.equal(repaired.items.length, 2);
    } finally {
      await f.close();
    }
  });

  test(`${backend} 人工并发修改后整批拒绝，保留人工结果和其他旧稿`, async () => {
    const f = await fixture(backend);
    try {
      await f.add("a-one");
      await f.add("b-one");
      await f.prepare(["a-one", "b-one"]);
      const revised = await f.store.reviseItem({
        credential: "human",
        commandId: "human-edit",
        productionId: "production-one",
        itemId: "b-one",
        expectedRevision: 1,
        draft: {
          ...emptyScriptDraft("b-one"),
          text: "不能覆盖的人工编辑",
          sources: [],
        },
      });
      await f.mark(revised);
      await assert.rejects(
        f.submit([f.result("a-one"), f.result("b-one")]),
        /过期|变化|版本/,
      );
      assert.equal((await f.version("a-one", 1)).headRevision, 1);
      assert.equal(
        (await f.version("b-one", 2)).draft.text,
        "不能覆盖的人工编辑",
      );
    } finally {
      await f.close();
    }
  });

  test(`${backend} 批内循环、越界版本、遗漏及空结果不能写入`, async () => {
    const f = await fixture(backend);
    try {
      await f.add("a-one");
      await f.add("b-one");
      await f.prepare(["a-one", "b-one"]);
      await assert.rejects(f.submit([f.result("a-one")]), /全部目标/);
      await assert.rejects(
        f.submit([f.result("a-one", " "), f.result("b-one")]),
        /实际正文/,
      );
      const a = f.result("a-one"),
        b = f.result("b-one");
      a.draft.dependencies = [{ itemId: "b-one", revision: 2 }];
      b.draft.dependencies = [{ itemId: "a-one", revision: 2 }];
      await assert.rejects(f.submit([a, b]), /循环/);
      a.draft.dependencies = [{ itemId: "b-one", revision: 3 }];
      b.draft.dependencies = [];
      await assert.rejects(f.submit([a, b]), /超出/);
      assert.equal((await f.version("a-one", 1)).headRevision, 1);
    } finally {
      await f.close();
    }
  });

  test(`${backend} 中途取消整批回滚，撤权不能恢复旧写入权限`, async () => {
    const f = await fixture(backend);
    try {
      await f.add("a-one");
      await f.add("b-one");
      await f.prepare(["a-one", "b-one"]);
      f.state.cancelAt = f.state.checks + 5;
      await assert.rejects(
        f.submit([f.result("a-one"), f.result("b-one")]),
        /取消/,
      );
      assert.equal((await f.version("a-one", 1)).headRevision, 1);
      f.state.cancelAt = Infinity;
      const committed = await f.submit([f.result("a-one"), f.result("b-one")]);
      f.state.revoked = true;
      await assert.rejects(
        f.submit([f.result("a-one"), f.result("b-one")]),
        /授权/,
      );
      f.state.revoked = false;
      assert.deepEqual(
        await f.submit([f.result("a-one"), f.result("b-one")]),
        committed,
      );
    } finally {
      await f.close();
    }
  });

  test(`${backend} v7 升级保留旧准备与候选，旧输入不自动变为当前结果`, async () => {
    const f = await fixture(backend);
    try {
      await f.add("a-one");
      await f.prepare(["a-one"], "candidate");
      const request = {
        credential: "agent",
        commandId: "old-candidate",
        productionId: "production-one",
        inputId: "input-one",
        draft: f.result("a-one").draft,
        explanation: report.explanation,
        workflowReport: report,
      };
      const candidate = await f.store.submitCandidate(request);
      await f.mark(candidate);
      const before = await f.store.readInputResult({
        credential: "agent",
        productionId: "production-one",
        inputId: "input-one",
        resultId: "old-candidate",
      });
      await f.migrateFromV7();
      assert.deepEqual(
        await f.store.readInputResult({
          credential: "agent",
          productionId: "production-one",
          inputId: "input-one",
          resultId: "old-candidate",
        }),
        before,
      );
      assert.equal(
        (await f.store.readPreparation({
          credential: "agent",
          productionId: "production-one",
          inputId: "input-one",
        }))!.submissionMode,
        "candidate",
      );
      await assert.rejects(f.submit([f.result("a-one")]), /未固定/);
      assert.equal((await f.version("a-one", 1)).headRevision, 1);
      assert.deepEqual(await f.store.submitCandidate(request), candidate);
    } finally {
      await f.close();
    }
  });

  for (const moment of ["before", "during"] as const)
    test(`${backend} ${moment} 来源撤权，删掉输出引用也不能绕过，整批回滚`, async () => {
      const f = await fixture(backend);
      try {
        const source = {
          appId: "morphz.objects",
          instanceId: "objects-one",
          objectId: "source-one",
          versionRef: "1",
          quote: "仅这一段授权引文",
        };
        await f.add("source-item", "character", "资料事实", [source]);
        await f.add("a-one");
        await f.add("b-one");
        await f.prepare(["a-one", "b-one"], "current", [
          { itemId: "source-item", revision: 1 },
        ]);
        f.state.revokeSourceAt =
          f.state.sourceChecks + (moment === "before" ? 1 : 2);
        await assert.rejects(
          f.submit([f.result("a-one"), f.result("b-one")]),
          /原件已不可读/,
        );
        f.state.revokeSourceAt = Infinity;
        assert.equal((await f.version("a-one", 1)).headRevision, 1);
        assert.equal(
          (await f.store.pendingItemDirectoryEvents("tenant-one")).length,
          0,
        );
        assert.equal(
          (
            await f.store.listInputResults({
              credential: "human",
              productionId: "production-one",
              inputId: "input-one",
              offset: 0,
              limit: 20,
            })
          ).total,
          0,
        );
        const expanded = f.result("a-one");
        expanded.draft.sources = [{ ...source, quote: "" }];
        await assert.rejects(
          f.submit([expanded, f.result("b-one")]),
          /来源超出/,
        );
        assert.equal((await f.version("a-one", 1)).headRevision, 1);
      } finally {
        await f.close();
      }
    });
}
