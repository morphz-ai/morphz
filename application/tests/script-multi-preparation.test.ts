import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import {
  defaultScriptExportTemplate,
  emptyScriptBrief,
  emptyScriptDraft,
} from "../packages/core/src/script-studio.js";
import {
  ScriptStudioStore,
  type ScriptStudioAuthority,
} from "../packages/script-studio/src/store.js";

const scope = { productionId: "production-one", inputId: "input-one" };
const targets = ["character-one", "character-two", "outline-one"];
const draft = (title: string, text = "") => ({
  ...emptyScriptDraft(title),
  sources: [],
  text,
});

async function fixture(backend: "sqlite" | "postgres", withSource = false) {
  const directory = mkdtempSync(join(tmpdir(), "morphz-script-multi-"));
  const filename = join(directory, "script.sqlite");
  const schema = `script_multi_${randomUUID().replaceAll("-", "")}`;
  const admin =
    backend === "postgres"
      ? new Pool({ connectionString: process.env.MORPHZ_TEST_POSTGRES_URL })
      : null;
  if (admin) await admin.query(`CREATE SCHEMA "${schema}"`);
  const state = {
    inputId: scope.inputId,
    active: true,
    allowed: true,
    sourceAllowed: true,
    revokeAfterNextSourceCheck: false,
  };
  const authorize = async (credential: string, projectId: string) => {
    if (!state.allowed || projectId !== "project-one") return null;
    if (
      credential !== "human" &&
      credential !== "agent" &&
      credential !== "other-agent"
    )
      return null;
    return {
      tenantId: "tenant-one",
      principalId: "human-one",
      actantId: credential === "human" ? "human-one" : "agent-one",
      kind: credential === "human" ? ("human" as const) : ("agent" as const),
      runtimeInputId:
        credential === "human"
          ? null
          : credential === "agent"
            ? state.inputId
            : "input-other",
    };
  };
  const authority: ScriptStudioAuthority = {
    async verifyReviewers({ projectId, principalIds }) {
      return (
        projectId === "project-one" &&
        principalIds.every((id) => id === "human-one")
      );
    },
    async verifySourceVersion() {
      const allowed = state.sourceAllowed;
      if (state.revokeAfterNextSourceCheck) {
        state.revokeAfterNextSourceCheck = false;
        state.sourceAllowed = false;
      }
      return allowed;
    },
    async authorizeCreate({ credential, projectId }) {
      return authorize(credential, projectId);
    },
    async authorizeProjectRead({ credential, projectId }) {
      return authorize(credential, projectId);
    },
    async authorizeObject({ credential, productionId }) {
      const actor = await authorize(credential, "project-one");
      return productionId === scope.productionId && actor
        ? { ...actor, projectId: "project-one", objectKind: "script" }
        : null;
    },
    async assertInputActive() {
      if (!state.active) throw new Error("本次输入已取消。");
    },
  };
  const open = () =>
    backend === "sqlite"
      ? ScriptStudioStore.sqlite(filename, authority)
      : ScriptStudioStore.postgres({
          connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
          schema,
          authority,
        });
  let store = await open();
  let closed = false;
  const production = await store.createProduction({
    credential: "human",
    commandId: "create-production",
    productionId: scope.productionId,
    requestedProjectId: "project-one",
    title: "TEST 多目标领证前夜",
  });
  await store.markDirectoryProjected(production.tenantId, production.eventId);
  const metadata = await store.updateProduction({
    credential: "human",
    commandId: "set-metadata",
    productionId: scope.productionId,
    expectedRevision: 1,
    title: "TEST 多目标领证前夜",
    brief: { ...emptyScriptBrief, modelProcessingAllowed: true },
    reviewerPrincipalIds: ["human-one"],
    template: defaultScriptExportTemplate,
  });
  await store.markDirectoryProjected(metadata.tenantId, metadata.eventId!);
  let activity = metadata.activityRevision;
  for (const [index, targetId] of targets.entries()) {
    const itemDraft = draft(targetId);
    const created = await store.createItem({
      credential: "human",
      commandId: `create-${targetId}`,
      productionId: scope.productionId,
      itemId: targetId,
      expectedActivityRevision: activity,
      kind: index === 2 ? "outline" : "character",
      draft: {
        ...itemDraft,
        sources:
          withSource && index === 2
            ? [
                {
                  appId: "morphz.objects",
                  instanceId: "objects-one",
                  objectId: "source-one",
                  versionRef: "1",
                  quote: "固定引文",
                },
              ]
            : [],
      },
    });
    activity = created.activityRevision;
    await store.markDirectoryProjected(created.tenantId, created.eventId);
  }
  const generations = targets.map((targetId) => ({
    productionId: scope.productionId,
    targetId,
    baseRevision: 1,
    contextRevision: metadata.metadataRevision,
    purpose: "draft" as const,
    references: [],
    maxCandidates: 1,
    maxOutputCharacters: 24000,
    maxReviewPasses: 1,
  }));
  return {
    state,
    generations,
    filename,
    schema,
    get store() {
      return store;
    },
    async closeStore() {
      if (!closed) {
        await store.close();
        closed = true;
      }
    },
    async reopen() {
      if (!closed) await store.close();
      store = await open();
      closed = false;
    },
    async close() {
      if (!closed) await store.close();
      if (admin) {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend} 完整三目标原子准备、独立同文候选及冷恢复，不采纳正式稿`,
    { skip: backend === "postgres" && !process.env.MORPHZ_TEST_POSTGRES_URL },
    async () => {
      const f = await fixture(backend);
      try {
        const command = {
          credential: "agent",
          commandId: "prepare-three",
          ...scope,
          generations: f.generations,
          task: "执行当前已确认提案：两位主角设定与五场戏大纲。",
        };
        await assert.rejects(
          f.store.prepareGenerations({
            ...command,
            generations: [f.generations[0]!, f.generations[0]!],
          }),
          /重复目标/,
        );
        await assert.rejects(
          f.store.prepareGenerations({
            ...command,
            generations: [
              f.generations[0]!,
              { ...f.generations[1]!, baseRevision: 99 },
            ],
          }),
          /过期/,
        );
        assert.equal(
          await f.store.findPreparation({
            credential: "agent",
            projectId: "project-one",
            inputId: scope.inputId,
          }),
          null,
        );
        const prepared = await f.store.prepareGenerations(command);
        assert.equal(prepared.preparationId, scope.inputId);
        assert.deepEqual(prepared.generations, f.generations);
        assert.deepEqual(prepared.generation, f.generations[0]);
        assert.equal(prepared.task, command.task);
        assert.deepEqual(await f.store.prepareGenerations(command), prepared);
        assert.deepEqual(
          await f.store.prepareGenerations({
            ...command,
            commandId: "retry-new-command",
          }),
          prepared,
        );
        await assert.rejects(
          f.store.prepareGenerations({
            ...command,
            commandId: "append",
            generations: f.generations.slice(0, 2),
          }),
          /另一份/,
        );
        await assert.rejects(
          f.store.prepareGenerations({
            ...command,
            commandId: "change-task",
            task: "伪造另一个任务",
          }),
          /另一份/,
        );
        await assert.rejects(
          f.store.prepareGenerations({
            ...command,
            commandId: "reorder",
            generations: [...f.generations].reverse(),
          }),
          /另一份/,
        );
        await assert.rejects(
          f.store.readPreparation({
            credential: "other-agent",
            productionId: scope.productionId,
            inputId: scope.inputId,
          }),
          /另一条输入/,
        );
        await f.reopen();
        assert.deepEqual(
          (await f.store.readPreparation({ credential: "agent", ...scope }))
            ?.generations,
          f.generations,
        );
        assert.equal(
          (
            await f.store.findPreparation({
              credential: "agent",
              projectId: "project-one",
              inputId: scope.inputId,
            })
          )?.task,
          command.task,
        );

        const common = {
          credential: "agent",
          ...scope,
          draft: draft("共同模板", "两位主角选择共同承担代价。"),
          explanation: "保持当前提案约束。",
        };
        await assert.rejects(
          f.store.submitCandidate({ ...common, commandId: "missing-target" }),
          /必须明确指定/,
        );
        await assert.rejects(
          f.store.submitCandidate({
            ...common,
            commandId: "outside-target",
            targetId: "outside",
          }),
          /不属于/,
        );
        const first = await f.store.submitCandidate({
          ...common,
          commandId: "submit-character-one",
          targetId: targets[0],
        });
        // Simulate app commit succeeded but its directory projection/receipt was lost.
        await f.reopen();
        assert.deepEqual(
          await f.store.submitCandidate({
            ...common,
            commandId: "submit-character-one",
            targetId: targets[0],
          }),
          first,
        );
        await assert.rejects(
          f.store.submitCandidate({
            ...common,
            commandId: "submit-character-two",
            targetId: targets[1],
          }),
          /恢复投影/,
        );
        await f.store.markDirectoryProjected(first.tenantId, first.eventId);
        const second = await f.store.submitCandidate({
          ...common,
          commandId: "submit-character-two",
          targetId: targets[1],
        });
        assert.notEqual(first.candidateId, second.candidateId);
        await f.store.markDirectoryProjected(second.tenantId, second.eventId);
        const retry = await f.store.submitCandidate({
          ...common,
          commandId: "new-command-same-content",
          targetId: targets[1],
        });
        assert.deepEqual(retry, second);
        await assert.rejects(
          f.store.submitCandidate({
            ...common,
            commandId: "over-quota",
            targetId: targets[1],
            draft: draft("不同稿", "不同正文。"),
          }),
          /数量已达/,
        );
        f.state.active = false;
        await assert.rejects(
          f.store.submitCandidate({
            ...common,
            commandId: "submit-outline",
            targetId: targets[2],
          }),
          /已取消/,
        );
        f.state.active = true;
        f.state.allowed = false;
        await assert.rejects(
          f.store.submitCandidate({
            ...common,
            commandId: "submit-outline",
            targetId: targets[2],
          }),
          /授权/,
        );
        f.state.allowed = true;
        const third = await f.store.submitCandidate({
          ...common,
          commandId: "submit-outline",
          targetId: targets[2],
          draft: draft(
            "五场戏大纲",
            "1. 相遇\n2. 分歧\n3. 试探\n4. 选择\n5. 领证",
          ),
        });
        await f.store.markDirectoryProjected(third.tenantId, third.eventId);
        const results = await f.store.listInputResults({
          credential: "agent",
          ...scope,
          offset: 0,
          limit: 10,
        });
        assert.equal(results.total, 3);
        const productionState = await f.store.readProduction({
          credential: "human",
          productionId: scope.productionId,
        });
        assert.deepEqual(
          productionState.candidates
            .map((candidate) => candidate.targetId)
            .sort(),
          [...targets].sort(),
        );
        assert.ok(
          productionState.candidates.every(
            (candidate) => candidate.status === "pending",
          ),
        );
        assert.ok(
          productionState.items.every(
            (item) =>
              item.revision === 1 && item.versions[0]!.draft.text === "",
          ),
        );
        assert.equal(
          new Set(productionState.candidates.map((candidate) => candidate.id))
            .size,
          3,
        );
        await f.reopen();
        assert.equal(
          (
            await f.store.listInputResults({
              credential: "agent",
              ...scope,
              offset: 0,
              limit: 10,
            })
          ).total,
          3,
        );
      } finally {
        await f.close();
      }
    },
  );

  test(
    `${backend} 多目标准备预算、目标版本、取消与权限边界不会留下部分准备`,
    { skip: backend === "postgres" && !process.env.MORPHZ_TEST_POSTGRES_URL },
    async () => {
      const f = await fixture(backend);
      try {
        const command = {
          credential: "agent",
          commandId: "prepare-three",
          ...scope,
          generations: f.generations,
        };
        await assert.rejects(
          f.store.prepareGenerations({
            ...command,
            generations: Array.from({ length: 13 }, (_, i) => ({
              ...f.generations[0]!,
              targetId: `target-${i}`,
            })),
          }),
        );
        await assert.rejects(
          f.store.prepareGenerations({ ...command, task: "x".repeat(12001) }),
        );
        await assert.rejects(
          f.store.prepareGenerations({
            ...command,
            generations: [
              f.generations[0]!,
              { ...f.generations[1]!, contextRevision: 99 },
            ],
          }),
          /同一创作要求/,
        );
        f.state.active = false;
        await assert.rejects(f.store.prepareGenerations(command), /取消/);
        f.state.active = true;
        assert.equal(
          await f.store.readPreparation({ credential: "agent", ...scope }),
          null,
        );
        await f.store.prepareGenerations(command);
        const edited = await f.store.reviseItem({
          credential: "human",
          commandId: "human-edit",
          productionId: scope.productionId,
          itemId: targets[2]!,
          expectedRevision: 1,
          draft: draft("人工大纲", "保留人工正文。"),
        });
        await f.store.markDirectoryProjected(edited.tenantId, edited.eventId);
        await assert.rejects(
          f.store.submitCandidate({
            credential: "agent",
            commandId: "late-outline",
            ...scope,
            targetId: targets[2],
            draft: draft("迟到大纲", "不应该覆盖。"),
            explanation: "迟到结果",
          }),
          /过期/,
        );
        const current = await f.store.readItemVersion({
          credential: "human",
          productionId: scope.productionId,
          itemId: targets[2]!,
        });
        assert.equal(current.draft.text, "保留人工正文。");
        assert.equal(
          (
            await f.store.listInputResults({
              credential: "agent",
              ...scope,
              offset: 0,
              limit: 10,
            })
          ).total,
          0,
        );
      } finally {
        await f.close();
      }
    },
  );

  test(
    `${backend} 全批次读取复核非首目标的原作权限，撤权不泄漏材料`,
    { skip: backend === "postgres" && !process.env.MORPHZ_TEST_POSTGRES_URL },
    async () => {
      const f = await fixture(backend, true);
      try {
        await f.store.prepareGenerations({
          credential: "agent",
          commandId: "prepare-three",
          ...scope,
          generations: f.generations,
        });
        await f.store.assertPreparedInputReadable({
          credential: "agent",
          ...scope,
        });
        f.state.sourceAllowed = false;
        await assert.rejects(
          f.store.assertPreparedInputReadable({
            credential: "agent",
            ...scope,
          }),
          /来源|权限|原件|原作/,
        );
        assert.equal(
          (
            await f.store.listInputResults({
              credential: "human",
              ...scope,
              offset: 0,
              limit: 10,
            })
          ).total,
          0,
        );
      } finally {
        await f.close();
      }
    },
  );

  for (const when of ["before-submit", "during-submit"] as const) {
    test(
      `${backend} ${when} 来源撤权不能通过产物删掉引用绕过，整个固定批次提交前后复核`,
      { skip: backend === "postgres" && !process.env.MORPHZ_TEST_POSTGRES_URL },
      async () => {
        const f = await fixture(backend, true);
        try {
          await f.store.prepareGenerations({
            credential: "agent",
            commandId: "prepare-three",
            ...scope,
            generations: f.generations,
          });
          await f.store.assertPreparedInputReadable({
            credential: "agent",
            ...scope,
          });
          if (when === "before-submit") f.state.sourceAllowed = false;
          else f.state.revokeAfterNextSourceCheck = true;
          // The first target has no source itself. The shared inference has
          // nevertheless read the third target's pinned source, so dropping
          // all output citations must not bypass that grant or a mid-call loss.
          await assert.rejects(
            f.store.submitCandidate({
              credential: "agent",
              commandId: "uncited-result",
              ...scope,
              targetId: targets[0],
              draft: draft("删掉引用的产物", "来源已不可读，不能继续交付。"),
              explanation: "不自报来源。",
            }),
            /原件|权限|原作/,
          );
          assert.equal(
            (
              await f.store.listInputResults({
                credential: "human",
                ...scope,
                offset: 0,
                limit: 10,
              })
            ).total,
            0,
          );
        } finally {
          await f.close();
        }
      },
    );
  }

  test(
    `${backend} 首项保存后来源撤权保留真回执，但后续无引用产物不得提交`,
    { skip: backend === "postgres" && !process.env.MORPHZ_TEST_POSTGRES_URL },
    async () => {
      const f = await fixture(backend, true);
      try {
        await f.store.prepareGenerations({
          credential: "agent",
          commandId: "prepare-three",
          ...scope,
          generations: f.generations,
        });
        const firstRequest = {
          credential: "agent",
          commandId: "saved-first",
          ...scope,
          targetId: targets[0],
          draft: draft("真实首项", "这份在授权仍有效时已保存。"),
          explanation: "首项没有来源引用。",
        };
        const saved = await f.store.submitCandidate(firstRequest);
        await f.store.markDirectoryProjected(saved.tenantId, saved.eventId);
        f.state.sourceAllowed = false;
        assert.deepEqual(
          await f.store.submitCandidate(firstRequest),
          saved,
          "撤权不虚构已保存回执回滚，也不重放正文",
        );
        for (const [index, targetId] of targets.slice(1).entries())
          await assert.rejects(
            f.store.submitCandidate({
              credential: "agent",
              commandId: `late-${index}`,
              ...scope,
              targetId,
              draft: draft("迟到项", "不能通过省略来源继续。"),
              explanation: "无引用输出。",
            }),
            /原件|权限|原作/,
          );
        const results = await f.store.listInputResults({
          credential: "human",
          ...scope,
          offset: 0,
          limit: 10,
        });
        assert.equal(results.total, 1);
        assert.equal(results.results[0]!.id, saved.candidateId);
      } finally {
        await f.close();
      }
    },
  );
}

test("SQLite 实际 v6 已准备输入升级保留单目标 ID、原回执哈希和版本，不重放", async () => {
  const f = await fixture("sqlite");
  try {
    const command = {
      credential: "agent",
      commandId: "legacy-prepare",
      ...scope,
      generation: f.generations[0]!,
    };
    const before = await f.store.prepareGeneration(command);
    // Turn this isolated fixture into the exact installed v6 physical schema.
    await f.closeStore();
    const db = new DatabaseSync(f.filename);
    db.exec(
      "DROP INDEX script_preparations_by_input_target; DROP INDEX script_preparations_by_input_order; ALTER TABLE script_preparations DROP COLUMN task_request; ALTER TABLE script_preparations DROP COLUMN submission_mode;",
    );
    db.prepare(
      "UPDATE script_schema_version SET version=6,schema_sha256=?",
    ).run("c8eaf0cd6c5f75c86a49793b94bdba4039e3578f04083cbff2ce65839987dca7");
    const beforeHash = db
      .prepare(
        "SELECT request_hash FROM script_command_receipts WHERE command_id=?",
      )
      .get(command.commandId)?.request_hash;
    db.close();
    await f.reopen();
    assert.deepEqual(await f.store.prepareGeneration(command), before);
    const read = await f.store.readPreparation({
      credential: "agent",
      ...scope,
    });
    assert.equal(read?.preparationId, scope.inputId);
    assert.deepEqual(read?.generations, [f.generations[0]]);
    assert.equal(read?.task, "");
    await f.closeStore();
    const check = new DatabaseSync(f.filename, { readOnly: true });
    assert.equal(
      check.prepare("SELECT version FROM script_schema_version").get()?.version,
      8,
    );
    assert.equal(
      check
        .prepare(
          "SELECT request_hash FROM script_command_receipts WHERE command_id=?",
        )
        .get(command.commandId)?.request_hash,
      beforeHash,
    );
    assert.deepEqual(check.prepare("PRAGMA foreign_key_check").all(), []);
    const expectedHash = createHash("sha256")
      .update(
        JSON.stringify({
          tenantId: "tenant-one",
          principalId: "human-one",
          actantId: "agent-one",
          kind: "agent",
          runtimeInputId: scope.inputId,
          projectId: "project-one",
          productionId: scope.productionId,
          inputId: scope.inputId,
          submitted: f.generations[0],
        }),
      )
      .digest("hex");
    assert.equal(beforeHash, expectedHash);
    check.close();
  } finally {
    await f.close();
  }
});

test(
  "PostgreSQL 实际 populated v6 准备行升级保持旧哈希、固定引用、冷恢复与版本权限守门",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const f = await fixture("postgres");
    const admin = new Pool({
      connectionString: process.env.MORPHZ_TEST_POSTGRES_URL,
    });
    try {
      assert.match(f.schema, /^script_multi_[a-f0-9]{32}$/);
      const generation = {
        ...f.generations[0]!,
        references: [{ itemId: targets[1]!, revision: 1 }],
      };
      const command = {
        credential: "agent",
        commandId: "legacy-prepare",
        ...scope,
        generation,
      };
      const before = await f.store.prepareGeneration(command);
      const formalBefore = await f.store.readProduction({
        credential: "human",
        productionId: scope.productionId,
      });
      await f.closeStore();

      // Only this random schema in an explicitly supplied TEST database is
      // reconstructed as v6. Production migration code is never bypassed.
      await admin.query(
        `DROP INDEX "${f.schema}".script_preparations_by_input_target`,
      );
      await admin.query(
        `DROP INDEX "${f.schema}".script_preparations_by_input_order`,
      );
      await admin.query(
        `ALTER TABLE "${f.schema}".script_preparations DROP COLUMN task_request`,
      );
      await admin.query(
        `ALTER TABLE "${f.schema}".script_preparations DROP COLUMN submission_mode`,
      );
      await admin.query(
        `UPDATE "${f.schema}".script_schema_version SET version=6,schema_sha256=$1`,
        ["c8eaf0cd6c5f75c86a49793b94bdba4039e3578f04083cbff2ce65839987dca7"],
      );
      const legacy = async () => ({
        preparations: (
          await admin.query(
            `SELECT * FROM "${f.schema}".script_preparations ORDER BY collection_ordinal,preparation_id`,
          )
        ).rows,
        references: (
          await admin.query(
            `SELECT * FROM "${f.schema}".script_preparation_references ORDER BY preparation_id,ordinal`,
          )
        ).rows,
        receipts: (
          await admin.query(
            `SELECT * FROM "${f.schema}".script_command_receipts ORDER BY command_id`,
          )
        ).rows,
      });
      const legacyRows = await legacy();
      assert.equal(legacyRows.preparations.length, 1);
      assert.equal(legacyRows.preparations[0]!.preparation_id, scope.inputId);
      assert.equal("task_request" in legacyRows.preparations[0]!, false);
      assert.equal(legacyRows.references.length, 1);
      const beforeHash = legacyRows.receipts.find(
        (receipt) => receipt.command_id === command.commandId,
      )?.request_hash;
      const expectedHash = createHash("sha256")
        .update(
          JSON.stringify({
            tenantId: "tenant-one",
            principalId: "human-one",
            actantId: "agent-one",
            kind: "agent",
            runtimeInputId: scope.inputId,
            projectId: "project-one",
            productionId: scope.productionId,
            inputId: scope.inputId,
            submitted: generation,
          }),
        )
        .digest("hex");
      assert.equal(
        beforeHash,
        expectedHash,
        "Use the exact old single-target hash, not a new batch hash",
      );
      assert.equal(
        Number(
          (
            await admin.query(
              `SELECT version FROM "${f.schema}".script_schema_version`,
            )
          ).rows[0]!.version,
        ),
        6,
      );

      for (let reopen = 0; reopen < 2; reopen++) {
        // Initialize the actual new Store over populated v6, then cold reopen
        // v8; both paths must return the original receipt and frozen versions.
        await f.reopen();
        assert.deepEqual(await f.store.prepareGeneration(command), before);
        assert.deepEqual(
          await f.store.prepareGeneration({
            ...command,
            commandId: "recover-same-input",
          }),
          before,
        );
        const read = await f.store.readPreparation({
          credential: "agent",
          ...scope,
        });
        assert.equal(read?.preparationId, scope.inputId);
        assert.equal(read?.task, "");
        assert.deepEqual(read?.generations, [generation]);
        assert.deepEqual(
          await f.store.readProduction({
            credential: "human",
            productionId: scope.productionId,
          }),
          formalBefore,
        );
        const migrated = await legacy();
        assert.deepEqual(migrated.references, legacyRows.references);
        assert.deepEqual(migrated.receipts, legacyRows.receipts);
        assert.deepEqual(
          migrated.preparations.map(
            ({ task_request: task, submission_mode: mode, ...row }) => {
              assert.equal(task, "");
              assert.equal(mode, "candidate");
              return row;
            },
          ),
          legacyRows.preparations,
        );
        assert.equal(
          Number(
            (
              await admin.query(
                `SELECT version FROM "${f.schema}".script_schema_version`,
              )
            ).rows[0]!.version,
          ),
          8,
        );
        assert.equal(
          (
            await admin.query(
              `SELECT request_hash FROM "${f.schema}".script_command_receipts WHERE command_id=$1`,
              [command.commandId],
            )
          ).rows[0]!.request_hash,
          beforeHash,
        );
        assert.equal(
          (
            await admin.query(
              "SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND indexname IN ('script_preparations_by_input_target','script_preparations_by_input_order')",
              [f.schema],
            )
          ).rows.length,
          2,
        );
        assert.equal(
          (
            await admin.query(
              "SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND c.contype='f' AND NOT c.convalidated",
              [f.schema],
            )
          ).rows.length,
          0,
        );
      }

      await assert.rejects(
        f.store.prepareGenerations({
          credential: "agent",
          commandId: "append-after-migration",
          ...scope,
          generations: [generation, f.generations[1]!],
        }),
        /已经绑定/,
      );
      await assert.rejects(
        f.store.prepareGenerations({
          credential: "agent",
          commandId: "replace-task-after-migration",
          ...scope,
          generations: [generation],
          task: "不能改写旧输入的既定任务。",
        }),
        /已经绑定/,
      );
      await assert.rejects(
        f.store.prepareGeneration({ ...command, credential: "other-agent" }),
        /当前持久输入/,
      );
      f.state.allowed = false;
      await assert.rejects(f.store.prepareGeneration(command), /权限/);
      await assert.rejects(
        f.store.readPreparation({ credential: "agent", ...scope }),
        /权限|读取/,
      );
      f.state.allowed = true;

      const candidateCommand = {
        credential: "agent",
        commandId: "post-migration-candidate",
        ...scope,
        draft: draft("升级后候选", "保留迁移后的独立候选。"),
        explanation: "沿用原固定范围。",
      };
      const saved = await f.store.submitCandidate(candidateCommand);
      await f.store.markDirectoryProjected(saved.tenantId, saved.eventId);
      await f.reopen();
      assert.deepEqual(await f.store.submitCandidate(candidateCommand), saved);
      assert.deepEqual(
        await f.store.submitCandidate({
          ...candidateCommand,
          commandId: "recover-same-candidate",
        }),
        saved,
      );
      assert.equal(
        (
          await f.store.listInputResults({
            credential: "agent",
            ...scope,
            offset: 0,
            limit: 10,
          })
        ).total,
        1,
      );
      await assert.rejects(
        f.store.submitCandidate({
          ...candidateCommand,
          draft: draft("改绑", "不得用同命令改写正文。"),
        }),
        /相同命令/,
      );

      const edited = await f.store.reviseItem({
        credential: "human",
        commandId: "human-cas-after-migration",
        productionId: scope.productionId,
        itemId: generation.targetId,
        expectedRevision: 1,
        draft: draft("人工正文", "人工新稿不能被旧准备覆盖。"),
      });
      await f.store.markDirectoryProjected(edited.tenantId, edited.eventId);
      await assert.rejects(
        f.store.reviseItem({
          credential: "human",
          commandId: "stale-human-cas",
          productionId: scope.productionId,
          itemId: generation.targetId,
          expectedRevision: 1,
          draft: draft("过期改稿"),
        }),
        /版本|变化|过期/,
      );
      assert.deepEqual(
        await f.store.submitCandidate({
          ...candidateCommand,
          commandId: "recover-saved-after-human-cas",
        }),
        saved,
        "A saved request remains recoverable without overwriting the newer formal version",
      );
      await assert.rejects(
        f.store.submitCandidate({
          ...candidateCommand,
          commandId: "late-after-human-cas",
          draft: draft("新过期候选", "不能以旧准备新增不同正文。"),
        }),
        /过期/,
      );
      const current = await f.store.readItemVersion({
        credential: "human",
        productionId: scope.productionId,
        itemId: generation.targetId,
      });
      assert.equal(current.revision, 2);
      assert.equal(current.draft.text, "人工新稿不能被旧准备覆盖。");
      assert.equal(
        (
          await f.store.listInputResults({
            credential: "agent",
            ...scope,
            offset: 0,
            limit: 10,
          })
        ).total,
        1,
      );
      assert.equal(
        (
          await admin.query(
            `SELECT request_hash FROM "${f.schema}".script_command_receipts WHERE command_id=$1`,
            [command.commandId],
          )
        ).rows[0]!.request_hash,
        beforeHash,
      );
    } finally {
      await admin.end();
      await f.close();
    }
  },
);
