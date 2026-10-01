import { scriptDocxManifest } from "./script-docx-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import {
  createScriptProduction,
  updateScriptProduction,
  createScriptItem,
  reviseScriptItem,
  transitionScriptWorkflow,
  changeScriptReview,
  decideScriptCandidate,
  recordScriptExport,
  submitScriptCandidate,
  platformScriptStudioAuthority,
} from "../packages/application/src/script-production-service.js";
import {
  ScriptStudioStore,
  type LiveScriptDraft,
} from "../packages/script-studio/src/store.js";
import {
  currentScriptDraft,
  emptyScriptDraft,
  scriptImpact,
  scriptIssues,
  type ScriptCommand,
  type ScriptDraft,
  type ScriptGeneration,
  type ScriptItem,
  type ScriptProduction,
} from "../packages/core/src/script-studio.js";
import { buildScriptDocx } from "../packages/core/src/script-studio-docx.js";

// Actual Platform and Script private databases; only accepted Runtime input
// evidence and generated text are synthetic. No model-quality claim.
test("持久三集/分场：候选采纳、上游返工、历史导出、在线备份恢复与回执重试", async () => {
  const host = await agentDomainFixture();
  const backupFile = join(host.directory, "script-backup.sqlite");
  let restored: ScriptStudioStore | undefined;
  const productionId = "production_" + randomUUID().replaceAll("-", "");
  const shared = () => ({
    platform: host.domains.content.platform,
    studio: host.domains.content.studio!,
    instanceId: host.domains.content.instanceIds.scriptStudio,
    productionId,
  });
  let current!: ScriptProduction;
  const refresh = async () => {
    current = await host.withHuman((actor) =>
      shared().studio.readProduction({
        credential: actor.credential,
        productionId,
      }),
    );
  };
  const live = (draft: ScriptDraft): LiveScriptDraft => ({
    ...draft,
    sources: [],
  });
  const production = () => current;
  const item = (id: string) => production().items.find((i) => i.id === id)!;
  const draft = (id: string) => currentScriptDraft(item(id));
  const ref = (id: string) => ({ itemId: id, revision: item(id).revision });
  // This adapter dispatches existing domain services; it owns no data/SQL or
  // workflow rules. Every assertion reads the committed Script original.
  const run = async (command: ScriptCommand): Promise<string> => {
    const commandId = randomUUID();
    const base = { ...shared(), commandId };
    const id = await host.withHuman(async (actor) => {
      switch (command.action) {
        case "update-production":
          return (await updateScriptProduction({ ...base, ...command, actor }))
            .original.productionId;
        case "create-item": {
          const itemId = "item_" + randomUUID().replaceAll("-", "");
          return (
            await createScriptItem({
              ...base,
              actor,
              itemId,
              expectedActivityRevision: current.activityRevision!,
              kind: command.kind,
              draft: live(command.draft),
            })
          ).original.itemId;
        }
        case "revise-item":
          return (
            await reviseScriptItem({
              ...base,
              ...command,
              actor,
              draft: live(command.draft),
            })
          ).original.itemId;
        case "submit-review":
        case "review-decision":
        case "lock-item":
        case "unlock-item":
          return (
            await transitionScriptWorkflow({
              ...base,
              ...command,
              actor,
              ...(command.action === "unlock-item"
                ? { note: command.reason }
                : {}),
            })
          ).original.itemId;
        case "add-review":
        case "resolve-review":
          return (await changeScriptReview({ ...base, ...command, actor }))
            .original.reviewId;
        case "decide-candidate":
          return (await decideScriptCandidate({ ...base, ...command, actor }))
            .original.candidateId;
        case "record-export":
          return (
            await recordScriptExport({
              ...base,
              ...command,
              actor,
            })
          ).original.exportId;
        default:
          throw new Error(
            "Unexpected workflow fixture command: " + command.action,
          );
      }
    });
    await refresh();
    return id;
  };
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
  const approve = async (id: string, lock = false) => {
    await run({ action: "submit-review", ...workflow(id) });
    await run({
      action: "review-decision",
      ...workflow(id),
      decision: "approve",
      note: "合成人工审批测试，不是合作方验收",
    });
    if (lock) await run({ action: "lock-item", ...workflow(id) });
  };
  try {
    await host.withHuman((actor) =>
      createScriptProduction({
        ...shared(),
        actor,
        commandId: randomUUID(),
        projectId: host.projectId,
        title: "TEST 持久三集返工（合成）",
      }),
    );
    await refresh();
    const p = production();
    await run({
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
    const setting = await create("setting", "时间规则", {
      text: "列车只在白天运行。",
    });
    const character = await create("character", "林", {
      text: "林追查失踪列车。",
    });
    const outline = await create("outline", "全剧大纲", {
      text: "三集依次发现车票、追查信号、解开谜团。",
      dependencies: [ref(setting), ref(character)],
    });
    await approve(setting);
    await approve(character);
    await approve(outline);
    const episodes: string[] = [];
    const scenes: string[] = [];
    const receipts: {
      invocation: ReturnType<typeof host.input>;
      request: Omit<
        Parameters<typeof submitScriptCandidate>[0],
        "actor" | "studio" | "platform" | "instanceId"
      >;
      receipt: Awaited<ReturnType<typeof submitScriptCandidate>>;
    }[] = [];
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
      const episode = await create("episode", `第${n}集`, {
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
      const invocation = host.input(
        host.projectId,
        `TEST 合成第${n}集固定版本请求`,
      );
      const inputId = (await host.readAcceptedInput(invocation)).input_id;
      await host.withAgent(
        (actor) =>
          shared().studio.prepareGeneration({
            credential: actor.credential,
            commandId: randomUUID(),
            productionId,
            inputId,
            generation,
          }),
        invocation,
      );
      const request = {
        commandId: randomUUID(),
        productionId,
        inputId,
        draft: live({
          ...draft(episode),
          text: `第${n}集合成候选：白天，林在站台追查第${n}张车票。`,
        }),
        explanation: "固定合成候选，不是模型质量证据",
      };
      const receipt = await host.withAgent(
        (actor) => submitScriptCandidate({ ...shared(), ...request, actor }),
        invocation,
      );
      receipts.push({ invocation, request, receipt });
      await refresh();
      assert.equal(item(episode).revision, 1, "提交候选不能改正式稿");
      assert.equal(draft(episode).text, `第${n}集人工基稿。`);
      const candidate = production().candidates.find(
        (c) => c.id === receipt.original.candidateId,
      )!;
      assert.equal(candidate.inputId, inputId);
      assert.deepEqual(
        [...candidate.references].sort((a, b) =>
          a.itemId.localeCompare(b.itemId),
        ),
        [...generation.references].sort((a, b) =>
          a.itemId.localeCompare(b.itemId),
        ),
      );
      await run({
        action: "decide-candidate",
        productionId,
        candidateId: candidate.id,
        expectedRevision: candidate.revision,
        decision: "accept",
      });
      assert.equal(item(episode).revision, 2);
      assert.equal(item(episode).versions[1]!.candidateId, candidate.id);
      await approve(episode, true);
      const scene = await create("scene", `第${n}集第一场`, {
        text: `白天，林拿起第${n}张车票。`,
        order: 1,
        parentId: episode,
        characters: [character],
        dependencies: [ref(episode), ref(character)],
      });
      // Explicit asynchronous review must be resolved by a Human before approval.
      const reviewId = await run({
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
      await run({
        action: "resolve-review",
        productionId,
        reviewId,
        expectedRevision: review.revision,
        resolution: "合成夹具已人工核对",
      });
      await approve(scene, true);
      episodes.push(episode);
      scenes.push(scene);
    }
    const exportItems = episodes.flatMap((id, i) => [ref(id), ref(scenes[i]!)]);
    assert.deepEqual(scriptIssues(production()), []);
    const exportId = await run({
      action: "record-export",
      productionId,
      expectedRevision: production().revision,
      items: exportItems,
      template: production().template,
    });
    const originalDocx = buildScriptDocx(
      scriptDocxManifest(production(), exportId),
    );
    assert.ok(originalDocx.length > 1000);
    assert.equal(
      new DataView(originalDocx.buffer, originalDocx.byteOffset).getUint32(
        0,
        true,
      ),
      0x04034b50,
    );
    const preRework = structuredClone(production());
    const identity = host.transport.identity();
    // SQLite online backup includes committed WAL pages; never copy an open DB file.
    const reader = new DatabaseSync(
      join(host.directory, "script-studio.sqlite"),
      { readOnly: true },
    );
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

    await run({
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
    await assert.rejects(
      async () =>
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
    assert.deepEqual(
      buildScriptDocx(scriptDocxManifest(production(), exportId)),
      originalDocx,
    );
    await approve(setting);
    await run({
      action: "revise-item",
      productionId,
      itemId: outline,
      expectedRevision: item(outline).revision,
      draft: {
        ...draft(outline),
        dependencies: draft(outline).dependencies.map((r) => ref(r.itemId)),
      },
    });
    await approve(outline);
    for (let n = 0; n < 3; n++) {
      for (const id of [episodes[n]!, scenes[n]!]) {
        await run({
          action: "unlock-item",
          ...workflow(id),
          reason: "时间设定变更：逐集返工，不自动改锁稿",
        });
        const base = item(id).revision;
        await run({
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
        await approve(id, true);
      }
    }
    assert.deepEqual(scriptIssues(production()), []);
    const newExportId = await run({
      action: "record-export",
      productionId,
      expectedRevision: production().revision,
      items: episodes.flatMap((id, n) => [ref(id), ref(scenes[n]!)]),
      template: production().template,
    });
    const newDocx = buildScriptDocx(
      scriptDocxManifest(production(), newExportId),
    );
    assert.notDeepEqual(newDocx, originalDocx);
    assert.deepEqual(
      buildScriptDocx(scriptDocxManifest(production(), exportId)),
      originalDocx,
      "历史导出必须保持同一字节",
    );
    const afterRework = structuredClone(production());
    for (const receipt of receipts)
      host.setInputExecution("completed", false, receipt.invocation);
    await host.reopen();
    assert.equal(host.transport.identity(), identity);
    await refresh();
    assert.deepEqual(production(), afterRework);
    for (const r of receipts)
      assert.deepEqual(
        await host.withAgent(
          (actor) =>
            submitScriptCandidate({ ...shared(), ...r.request, actor }),
          r.invocation,
        ),
        r.receipt,
        "终态后可核对原成功回执，但不得重复生成",
      );
    await refresh();
    assert.deepEqual(production(), afterRework);
    assert.deepEqual(
      buildScriptDocx(scriptDocxManifest(production(), newExportId)),
      newDocx,
    );
    const domain = shared();
    restored = await ScriptStudioStore.sqlite(
      backupFile,
      platformScriptStudioAuthority(
        domain.platform,
        domain.instanceId,
        () => ({
          routeKind: "service",
          routeRef: `embedded:${domain.instanceId}`,
        }),
        {
          objects: host.domains.content.objects,
          instanceId: host.domains.content.instanceIds.objects,
        },
      ),
    );
    const restoredProduction = await host.withHuman((actor) =>
      restored!.readProduction({ credential: actor.credential, productionId }),
    );
    assert.deepEqual(
      restoredProduction,
      preRework,
      "独立私库恢复精确回到备份版本，不修改原库",
    );
    assert.deepEqual(
      buildScriptDocx(scriptDocxManifest(restoredProduction, exportId)),
      originalDocx,
    );
    for (const r of receipts)
      assert.deepEqual(
        await host.withAgent(
          (actor) =>
            restored!.submitCandidate({
              ...r.request,
              credential: actor.credential,
            }),
          r.invocation,
        ),
        r.receipt.original,
      );
    assert.equal(restoredProduction.candidates.length, 3);
    assert.equal(
      production().exports.length,
      2,
      "恢复副本不能覆盖仍在用的原库",
    );
    host.assertNoLegacyData();
  } finally {
    await restored?.close();
    await host.close();
  }
});
