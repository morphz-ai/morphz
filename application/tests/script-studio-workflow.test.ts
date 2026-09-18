import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { localAccess, type Operation } from "../packages/core/src/model.js";
import {
  currentScriptDraft,
  emptyScriptDraft,
  scriptImpact,
  scriptIssues,
  type ScriptCommand,
  type ScriptDraft,
  type ScriptGeneration,
  type ScriptItem,
} from "../packages/core/src/script-studio.js";
import { buildScriptDocx } from "../packages/core/src/script-studio-docx.js";

// Persistent domain workflow only. Candidates and running deliveries are explicit
// synthetic fixtures; no Provider, Runtime execution or customer materials are used.
test("持久三集/分场：候选采纳、上游返工、历史导出、在线备份恢复与回执重试", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-script-workflow-"));
  const filename = join(directory, "workspace.sqlite");
  const backupFile = join(directory, "backup.sqlite");
  let store = new WorkspaceStore(filename);
  let restored: WorkspaceStore | undefined;
  const agent = { principalId: "morphz-service", actantId: "morphz-agent" };
  try {
    const execute = (operation: Operation) =>
      store.execute({ commandId: randomUUID(), operation }, localAccess)
        .entityId;
    const run = (command: ScriptCommand) =>
      execute({ type: "script-command", command });
    const productionId = run({
      action: "create-production",
      projectId: "first-project",
      title: "TEST 持久三集返工（合成）",
    });
    const production = () =>
      store.snapshot().scriptProductions.find((p) => p.id === productionId)!;
    const item = (id: string) => production().items.find((i) => i.id === id)!;
    const draft = (id: string) => currentScriptDraft(item(id));
    const ref = (id: string) => ({ itemId: id, revision: item(id).revision });
    const create = (
      kind: ScriptItem["kind"],
      title: string,
      changes: Partial<ScriptDraft> = {},
    ) =>
      run({
        action: "create-item",
        productionId,
        kind,
        draft: { ...emptyScriptDraft(title), ...changes },
      });
    const workflow = (id: string) => ({
      productionId,
      itemId: id,
      expectedRevision: item(id).revision,
      expectedWorkflowRevision: item(id).workflowRevision,
    });
    const approve = (id: string, lock = false) => {
      run({ action: "submit-review", ...workflow(id) });
      run({
        action: "review-decision",
        ...workflow(id),
        decision: "approve",
        note: "合成人工审批测试，不是合作方验收",
      });
      if (lock) run({ action: "lock-item", ...workflow(id) });
    };
    const p = production();
    run({
      action: "update-production",
      productionId,
      expectedRevision: p.revision,
      title: p.title,
      brief: {
        ...p.brief,
        episodeCount: 3,
        modelProcessingAllowed: true,
        rightsStatement: "只用本测试合成内容",
      },
      reviewerPrincipalIds: p.reviewerPrincipalIds,
      template: p.template,
    });
    const setting = create("setting", "时间规则", {
      text: "列车只在白天运行。",
    });
    const character = create("character", "林", { text: "林追查失踪列车。" });
    const outline = create("outline", "全剧大纲", {
      text: "三集依次发现车票、追查信号、解开谜团。",
      dependencies: [ref(setting), ref(character)],
    });
    approve(setting);
    approve(character);
    approve(outline);
    const episodes: string[] = [];
    const scenes: string[] = [];
    const receipts: {
      command: { commandId: string; operation: Operation };
      inputId: string;
      receipt: ReturnType<WorkspaceStore["execute"]>;
    }[] = [];
    const inputIds: string[] = [];
    const dependencies = (target: string) => {
      const refs = new Map<string, { itemId: string; revision: number }>();
      const walk = (id: string) => {
        for (const r of draft(id).dependencies) {
          if (!refs.has(r.itemId)) {
            refs.set(r.itemId, r);
            walk(r.itemId);
          }
        }
      };
      walk(target);
      return [...refs.values()];
    };
    for (let n = 1; n <= 3; n++) {
      const previous = episodes.at(-1);
      const episode = create("episode", `第${n}集`, {
        text: `第${n}集人工基稿。`,
        order: n,
        characters: [character],
        dependencies: [
          ref(setting),
          ref(character),
          ref(outline),
          ...(previous ? [ref(previous)] : []),
        ],
      });
      const generation: ScriptGeneration = {
        productionId,
        targetId: episode,
        baseRevision: 1,
        contextRevision: production().revision,
        purpose: "rewrite",
        references: dependencies(episode),
        maxCandidates: 1,
        maxOutputCharacters: 5000,
        maxReviewPasses: 0,
      };
      const inputId = execute({
        type: "record-input",
        projectId: "first-project",
        artifactId: null,
        artifactRevision: null,
        selection: "",
        body: `TEST 合成第${n}集固定版本请求`,
        targetActantId: agent.actantId,
        scriptGeneration: generation,
      });
      inputIds.push(inputId);
      store.saveRuntimeState({
        deliveries: inputIds.map((id) => ({
          inputId: id,
          state: "running",
          cancelRequested: false,
        })),
      });
      const candidateCommand = {
        commandId: randomUUID(),
        operation: {
          type: "script-command",
          command: {
            action: "submit-candidate",
            productionId,
            draft: {
              ...draft(episode),
              text: `第${n}集合成候选：白天，林在站台追查第${n}张车票。`,
            },
            explanation: "固定合成候选，不是模型质量证据",
          },
        } as Operation,
      };
      const receipt = store.execute(candidateCommand, agent, inputId);
      receipts.push({ command: candidateCommand, inputId, receipt });
      assert.equal(item(episode).revision, 1, "提交候选不能改正式稿");
      assert.equal(draft(episode).text, `第${n}集人工基稿。`);
      const candidate = production().candidates.find(
        (c) => c.id === receipt.entityId,
      )!;
      assert.equal(candidate.inputId, inputId);
      assert.deepEqual(candidate.references, generation.references);
      run({
        action: "decide-candidate",
        productionId,
        candidateId: candidate.id,
        expectedRevision: candidate.revision,
        decision: "accept",
      });
      assert.equal(item(episode).revision, 2);
      assert.equal(item(episode).versions[1]!.candidateId, candidate.id);
      approve(episode, true);
      const scene = create("scene", `第${n}集第一场`, {
        text: `白天，林拿起第${n}张车票。`,
        order: 1,
        parentId: episode,
        characters: [character],
        dependencies: [ref(episode), ref(character)],
      });
      // Explicit asynchronous review must be resolved by a Human before approval.
      const reviewId = run({
        action: "add-review",
        productionId,
        itemId: scene,
        itemRevision: 1,
        quote: `第${n}张车票`,
        body: "核对本集线索顺序",
        severity: "blocking",
      });
      assert.ok(
        scriptIssues(production()).some(
          (i) => i.itemId === scene && i.code === "unresolved-review",
        ),
      );
      const review = production().reviews.find((r) => r.id === reviewId)!;
      run({
        action: "resolve-review",
        productionId,
        reviewId,
        expectedRevision: review.revision,
        resolution: "合成夹具已人工核对",
      });
      approve(scene, true);
      episodes.push(episode);
      scenes.push(scene);
    }
    const exportItems = episodes.flatMap((id, i) => [ref(id), ref(scenes[i]!)]);
    assert.deepEqual(scriptIssues(production()), []);
    const exportId = run({
      action: "record-export",
      productionId,
      expectedRevision: production().revision,
      items: exportItems,
      template: production().template,
    });
    const originalDocx = buildScriptDocx(production(), exportId);
    assert.ok(originalDocx.length > 1000);
    assert.equal(
      new DataView(originalDocx.buffer, originalDocx.byteOffset).getUint32(
        0,
        true,
      ),
      0x04034b50,
    );
    const preRework = structuredClone(production());
    const identity = store.identity();
    // SQLite online backup includes committed WAL pages; never copy an open DB file.
    const reader = new DatabaseSync(filename, { readOnly: true });
    try {
      await backup(reader, backupFile);
    } finally {
      reader.close();
    }
    const check = new DatabaseSync(backupFile, { readOnly: true });
    try {
      assert.equal(
        Object.values(check.prepare("PRAGMA integrity_check").get()!)[0],
        "ok",
      );
    } finally {
      check.close();
    }

    run({
      action: "revise-item",
      productionId,
      itemId: setting,
      expectedRevision: 1,
      draft: { ...draft(setting), text: "列车改为夜间运行。" },
    });
    assert.deepEqual(
      new Set(scriptImpact(production(), [setting])),
      new Set([outline, ...episodes, ...scenes]),
    );
    for (const id of [...episodes, ...scenes]) {
      const before = preRework.items.find((i) => i.id === id)!;
      assert.equal(item(id).status, "locked");
      assert.equal(item(id).approval, null);
      assert.equal(item(id).revision, before.revision);
      assert.deepEqual(
        item(id).versions,
        before.versions,
        "上游变化不能偷偷改锁稿正文或版本",
      );
    }
    assert.throws(
      () =>
        run({
          action: "record-export",
          productionId,
          expectedRevision: production().revision,
          items: exportItems,
          template: production().template,
        }),
      /有效的锁定稿/,
    );
    assert.equal(production().exports.length, 1);
    assert.deepEqual(buildScriptDocx(production(), exportId), originalDocx);
    approve(setting);
    run({
      action: "revise-item",
      productionId,
      itemId: outline,
      expectedRevision: item(outline).revision,
      draft: {
        ...draft(outline),
        dependencies: draft(outline).dependencies.map((r) => ref(r.itemId)),
      },
    });
    approve(outline);
    for (let n = 0; n < 3; n++) {
      for (const id of [episodes[n]!, scenes[n]!]) {
        run({
          action: "unlock-item",
          ...workflow(id),
          reason: "时间设定变更：逐集返工，不自动改锁稿",
        });
        const base = item(id).revision;
        run({
          action: "revise-item",
          productionId,
          itemId: id,
          expectedRevision: base,
          draft: {
            ...draft(id),
            text: draft(id).text.replaceAll("白天", "夜间"),
            dependencies: draft(id).dependencies.map((r) => ref(r.itemId)),
          },
        });
        assert.equal(item(id).revision, base + 1);
        approve(id, true);
      }
    }
    assert.deepEqual(scriptIssues(production()), []);
    const newExportId = run({
      action: "record-export",
      productionId,
      expectedRevision: production().revision,
      items: episodes.flatMap((id, n) => [ref(id), ref(scenes[n]!)]),
      template: production().template,
    });
    const newDocx = buildScriptDocx(production(), newExportId);
    assert.notDeepEqual(newDocx, originalDocx);
    assert.deepEqual(
      buildScriptDocx(production(), exportId),
      originalDocx,
      "历史导出必须保持同一字节",
    );
    const afterRework = structuredClone(production());
    store.saveRuntimeState({
      deliveries: inputIds.map((inputId) => ({
        inputId,
        state: "completed",
        cancelRequested: false,
      })),
    });
    store.close();
    store = new WorkspaceStore(filename);
    assert.equal(store.identity(), identity);
    assert.deepEqual(production(), afterRework);
    for (const r of receipts)
      assert.deepEqual(
        store.execute(r.command, agent, r.inputId),
        r.receipt,
        "终态后可核对原成功回执，但不得重复生成",
      );
    assert.deepEqual(production(), afterRework);
    assert.deepEqual(buildScriptDocx(production(), newExportId), newDocx);
    restored = new WorkspaceStore(backupFile);
    assert.equal(restored.identity(), identity);
    const restoredProduction = restored
      .snapshot()
      .scriptProductions.find((p) => p.id === productionId)!;
    assert.deepEqual(
      restoredProduction,
      preRework,
      "独立恢复应精确回到备份时版本，不修改原库",
    );
    assert.deepEqual(
      buildScriptDocx(restoredProduction, exportId),
      originalDocx,
    );
    for (const r of receipts)
      assert.deepEqual(
        restored.execute(r.command, agent, r.inputId),
        r.receipt,
      );
    assert.equal(
      restored.snapshot().scriptProductions[0]!.candidates.length,
      3,
    );
    assert.equal(
      production().exports.length,
      2,
      "恢复副本不能覆盖仍在用的原库",
    );
  } finally {
    restored?.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
