import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";
import type { LiveScriptDraft } from "../packages/script-studio/src/store.js";
import {
  createScriptProduction,
  createScriptItem,
  updateScriptProduction,
  reviseScriptItem,
} from "../packages/application/src/script-production-service.js";
import { createDocument } from "../packages/application/src/document-service.js";
import { localAccess } from "../packages/core/src/model.js";

type BatchReceipt = {
  ok: boolean;
  kind: string;
  savedCount: number;
  note: string;
  results: Array<{
    targetId: string;
    status: string;
    saved: boolean | null;
    candidateId?: string;
    receipt?: { commandId: string; entityId: string };
    error?: string;
  }>;
};
const draft = (title: string, text = ""): LiveScriptDraft => ({
  ...emptyScriptDraft(title),
  sources: [],
  text,
});
const checks = [
  {
    performed: true,
    revise: false,
    blocked: false,
    notes: "核对两个人物和五场大纲。",
  },
  { performed: false, revise: false, blocked: false, notes: "无需第二轮。" },
];

const sourceHuman = {
  principalId: "source-human",
  actantId: "source-human-actant",
};
async function fixture(withSource = false) {
  const host = await agentDomainFixture(
    withSource ? { additionalHumans: [sourceHuman] } : {},
  );
  const route = host.input(host.projectId, "好的，你直接做。", "", undefined, {
    inputId: `input_${randomUUID().replaceAll("-", "")}`,
  });
  const productionId = `script_${randomUUID().replaceAll("-", "")}`;
  const targetIds = ["character-one", "character-two", "outline-one"].map(
    (name) => `${name}_${randomUUID().replaceAll("-", "")}`,
  );
  const shared = () => ({
    platform: host.domains.content.platform,
    studio: host.domains.content.studio!,
    instanceId: host.domains.content.instanceIds.scriptStudio,
    productionId,
  });
  const overview = () =>
    host.withHuman((actor) =>
      shared().studio.readProductionOverview({
        credential: actor.credential,
        productionId,
      }),
    );
  const metadata = async (
    modelProcessingAllowed: boolean,
    changes: Partial<Awaited<ReturnType<typeof overview>>["brief"]> = {},
  ) => {
    const current = await overview();
    return host.withHuman((actor) =>
      updateScriptProduction({
        ...shared(),
        actor,
        commandId: randomUUID(),
        expectedRevision: current.metadataRevision,
        title: current.title,
        brief: {
          ...current.brief,
          ...changes,
          modelProcessingAllowed,
          rightsStatement: "合成验收素材",
        },
        reviewerPrincipalIds: current.reviewerPrincipalIds,
        template: current.template,
      }),
    );
  };
  await host.withHuman((actor) =>
    createScriptProduction({
      ...shared(),
      actor,
      commandId: randomUUID(),
      projectId: host.projectId,
      title: "TEST Host 多目标领证前夜",
    }),
  );
  await metadata(true);
  const source = withSource
    ? await host.withHuman((actor) => {
        const content = host.domains.content;
        const objectId = `source_${randomUUID().replaceAll("-", "")}`;
        return createDocument({
          platform: content.platform,
          objects: content.objects,
          actor,
          instanceId: content.instanceIds.objects,
          commandId: randomUUID(),
          objectId,
          projectId: host.projectId,
          title: "合成固定原作",
          markdown: "固定原句，可供本次三项交付参照。",
        }).then((saved) => ({
          ...saved,
          reference: {
            appId: "morphz.objects",
            instanceId: content.instanceIds.objects,
            objectId,
            versionRef: "1",
            quote: "",
          },
        }));
      })
    : null;
  for (const [index, itemId] of targetIds.entries()) {
    const current = await overview();
    await host.withHuman((actor) =>
      createScriptItem({
        ...shared(),
        actor,
        commandId: randomUUID(),
        itemId,
        expectedActivityRevision: current.activityRevision,
        kind: index === 2 ? "outline" : "character",
        draft: {
          ...draft(index === 2 ? "五场戏大纲" : `主角${index + 1}`),
          ...(source && index === 2
            ? { sources: [source.reference], basis: "source" as const }
            : {}),
        },
      }),
    );
  }
  const contextRevision = (await overview()).metadataRevision;
  const task =
    "用户明确确认当前唯一提案：为《领证前夜》分别交付两位主角设定和五场戏大纲。";
  const generation = {
    productionId,
    targetId: targetIds[0]!,
    baseRevision: 1,
    contextRevision,
    purpose: "draft",
    references: [],
    maxCandidates: 1,
    maxOutputCharacters: 24000,
    maxReviewPasses: 1,
  };
  const targets = targetIds.map((targetId) => ({
    targetId,
    baseRevision: 1,
    references: [],
  }));
  const call = <T>(script: unknown) =>
    host.call<T>({ action: "script", script }, route);
  const prepare = (maxOutputCharacters = 24000) =>
    call<{ prepared: boolean; task: string; generations: unknown[] }>({
      action: "prepare-workflow",
      ...generation,
      targets,
      task,
      maxOutputCharacters,
    });
  const deliveries = targetIds.map((targetId, index) => ({
    targetId,
    payload: draft(
      index === 2 ? "五场戏大纲" : `主角${index + 1}`,
      index === 2
        ? "1. 相遇\n2. 分歧\n3. 试探\n4. 共同选择\n5. 领证"
        : `人物${index + 1}主动承担选择的代价。`,
    ),
    explanation: `实际交付${index + 1}`,
  }));
  const submitArgs = (payload: unknown = deliveries) => ({
    action: "script",
    script: {
      action: "submit-workflow",
      payload,
      explanation: "分别兑现已确认的三项交付。",
      checks,
    },
  });
  const production = () =>
    host.withHuman((actor) =>
      shared().studio.readProduction({
        credential: actor.credential,
        productionId,
      }),
    );
  return {
    source,
    host,
    route,
    productionId,
    targetIds,
    task,
    generation,
    targets,
    deliveries,
    shared,
    overview,
    metadata,
    call,
    prepare,
    submitArgs,
    production,
    close: () => host.close(),
  };
}

test("真实 Host Agent三目标准备与交付：原始确认不改写、材料按目标、独立候选回执冷恢复", async () => {
  const f = await fixture();
  try {
    const prepared = await f.prepare();
    assert.equal(prepared.prepared, true);
    assert.equal(prepared.task, f.task);
    assert.equal(prepared.generations.length, 3);
    const packet = await f.call<{
      body: string;
      task: string;
      generating: boolean;
      targets: Array<{
        generation: { targetId: string };
        target: { itemId: string; draft: LiveScriptDraft };
        materials: Array<{ itemId: string }>;
      }>;
      outputSchema: {
        type: string;
        items: { properties: Record<string, unknown> };
      };
    }>({ action: "read-workflow" });
    assert.equal(packet.body, "好的，你直接做。");
    assert.equal((await f.host.readAcceptedInput(f.route)).text, packet.body);
    assert.equal(packet.task, f.task);
    assert.equal(packet.generating, true);
    assert.equal(packet.outputSchema.type, "array");
    assert.ok(packet.outputSchema.items.properties.targetId);
    assert.ok(packet.outputSchema.items.properties.payload);
    assert.deepEqual(
      packet.targets.map((target) => target.generation.targetId),
      f.targetIds,
    );
    for (const target of packet.targets) {
      assert.equal(target.target.itemId, target.generation.targetId);
      assert.equal(target.target.draft.text, "");
      assert.deepEqual(
        target.materials.map((material) => material.itemId),
        [target.generation.targetId],
      );
    }
    const envelope = f.host.envelope(f.submitArgs(), f.route);
    const saved = (await f.host.tools.call(envelope)) as BatchReceipt;
    assert.equal(saved.ok, true);
    assert.equal(saved.kind, "candidates");
    assert.equal(saved.savedCount, 3);
    assert.deepEqual(
      saved.results.map((result) => result.status),
      ["saved", "saved", "saved"],
    );
    assert.equal(
      new Set(saved.results.map((result) => result.candidateId)).size,
      3,
    );
    assert.ok(
      saved.results.every(
        (result) => result.receipt?.entityId === result.candidateId,
      ),
    );
    const state = await f.production();
    assert.equal(state.candidates.length, 3);
    assert.ok(
      state.candidates.every((candidate) => candidate.status === "pending"),
    );
    assert.deepEqual(
      state.candidates.map((candidate) => candidate.targetId).sort(),
      [...f.targetIds].sort(),
    );
    assert.ok(
      state.items.every(
        (item) => item.revision === 1 && item.versions[0]!.draft.text === "",
      ),
    );
    const results = await f.call<{
      total: number;
      results: Array<{ id?: string; resultId?: string }>;
    }>({ action: "read-results" });
    assert.equal(results.total, 3);
    for (const savedResult of saved.results) {
      const result = await f.call<{ kind: string; resultJson: string }>({
        action: "read-result",
        resultId: savedResult.candidateId,
      });
      assert.equal(result.kind, "candidate");
      assert.equal(
        JSON.parse(result.resultJson).targetId,
        savedResult.targetId,
      );
    }
    await f.host.reopen();
    assert.deepEqual(await f.host.tools.call(envelope), saved);
    assert.equal((await f.production()).candidates.length, 3);
    f.host.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("Host 首项保存后原作真实迁出并撤权，后续删掉来源引用也不能继续提交", async () => {
  const f = await fixture(true);
  try {
    assert.ok(f.source);
    await f.prepare();
    await f.call({ action: "read-workflow" });
    assert.ok(
      f.deliveries.every((delivery) => delivery.payload.sources.length === 0),
    );
    const platform = f.shared().platform;
    const original = platform.refreshContent.bind(platform);
    let projections = 0;
    platform.refreshContent = async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      if (++projections === 1) {
        const targetProjectId = `source_private_${randomUUID().replaceAll("-", "")}`;
        await f.host.withHuman(async (actor) => {
          await f.host.domains.work.service.createProject(actor, {
            commandId: randomUUID(),
            projectId: targetProjectId,
            title: "合成不同受众来源",
          });
          const entry = await f.host.domains.work.service.content(
            actor,
            f.source!.contentId,
          );
          await platform.moveContent(actor, {
            commandId: randomUUID(),
            contentId: f.source!.contentId,
            targetProjectId,
            expectedRevision: entry.revision,
          });
        });
        await platform.reconcileOperatorMembers(f.host.transport.identity(), [
          { ...localAccess, enabled: true, projectIds: [] },
          { ...sourceHuman, enabled: true, projectIds: [targetProjectId] },
        ]);
      }
      return result;
    };
    const envelope = f.host.envelope(f.submitArgs(), f.route);
    const result = (await f.host.tools.call(envelope)) as BatchReceipt;
    assert.equal(result.ok, false);
    assert.equal(result.savedCount, 1);
    assert.deepEqual(
      result.results.map((entry) => entry.status),
      ["saved", "failed", "not-run"],
    );
    assert.match(result.results[1]!.error!, /原件|原作|授权|范围|权限/);
    assert.equal(
      result.results[1]!.saved,
      false,
      "实际不存在的第二结果可核对为未保存",
    );
    const state = await f.production();
    assert.equal(state.candidates.length, 1);
    assert.equal(state.candidates[0]!.id, result.results[0]!.candidateId);
    assert.equal(state.candidates[0]!.targetId, f.targetIds[0]);
    assert.ok(state.items.every((item) => item.revision === 1));
    await f.host.reopen();
    const retried = (await f.host.tools.call(envelope)) as BatchReceipt;
    assert.equal(retried.ok, false);
    assert.equal(retried.savedCount, 1);
    assert.deepEqual(
      retried.results.map((entry) => entry.status),
      ["saved", "failed", "not-run"],
    );
    assert.equal(
      (await f.production()).candidates.length,
      1,
      "原回执恢复不撤回首项，不重新写入或扩大交付",
    );
  } finally {
    await f.close();
  }
});

test("Host 部分交付：第二目标被人工修改，第一份保持真实保存、第三份不运行", async () => {
  const f = await fixture();
  try {
    await f.prepare();
    await f.host.withHuman((actor) =>
      reviseScriptItem({
        ...f.shared(),
        actor,
        commandId: randomUUID(),
        itemId: f.targetIds[1]!,
        expectedRevision: 1,
        draft: draft("人工主角2", "人工修改必须保留。"),
      }),
    );
    const result = await f.host.call<BatchReceipt>(f.submitArgs(), f.route);
    assert.equal(result.ok, false);
    assert.equal(result.savedCount, 1);
    assert.deepEqual(
      result.results.map((entry) => entry.status),
      ["saved", "failed", "not-run"],
    );
    assert.match(result.results[1]!.error!, /过期|变化/);
    assert.match(result.note, /未全部完成/);
    const state = await f.production();
    assert.equal(state.candidates.length, 1);
    assert.equal(state.candidates[0]!.targetId, f.targetIds[0]);
    assert.equal(
      state.items.find((item) => item.id === f.targetIds[1])!.versions.at(-1)!
        .draft.text,
      "人工修改必须保留。",
    );
  } finally {
    await f.close();
  }
});

test("Host 目录失败不冒充回滚：第二候选已提交，冷重开同命令只恢复投影并继续第三项", async () => {
  const f = await fixture();
  try {
    await f.prepare();
    const platform = f.shared().platform;
    const original = platform.refreshContent.bind(platform);
    let projected = 0;
    platform.refreshContent = async (...args: Parameters<typeof original>) => {
      projected++;
      if (projected === 2) throw new Error("合成第二候选目录投影失败");
      return original(...args);
    };
    const envelope = f.host.envelope(f.submitArgs(), f.route);
    const partial = (await f.host.tools.call(envelope)) as BatchReceipt;
    assert.equal(partial.ok, false);
    assert.equal(partial.savedCount, 2);
    assert.deepEqual(
      partial.results.map((entry) => entry.status),
      ["saved", "saved-projection-pending", "not-run"],
    );
    assert.equal((await f.production()).candidates.length, 2);
    platform.refreshContent = original;
    await f.host.reopen();
    const recovered = (await f.host.tools.call(envelope)) as BatchReceipt;
    assert.equal(recovered.ok, true);
    assert.equal(recovered.savedCount, 3);
    assert.equal(
      recovered.results[0]!.candidateId,
      partial.results[0]!.candidateId,
    );
    assert.equal(
      recovered.results[1]!.candidateId,
      partial.results[1]!.candidateId,
    );
    assert.equal((await f.production()).candidates.length, 3);
  } finally {
    await f.close();
  }
});

test("Host 批次提交完整集合与总预算预检失败零写入，不默默减少交付", async () => {
  const f = await fixture();
  try {
    await f.prepare(2400);
    await assert.rejects(
      f.host.call(f.submitArgs(f.deliveries.slice(0, 2)), f.route),
      /全部目标/,
    );
    await assert.rejects(
      f.host.call(
        f.submitArgs([f.deliveries[0], f.deliveries[0], f.deliveries[2]]),
        f.route,
      ),
      /全部目标/,
    );
    await assert.rejects(
      f.host.call(
        f.submitArgs(
          f.deliveries.map((delivery, index) =>
            index === 1 ? { ...delivery, targetId: "outside" } : delivery,
          ),
        ),
        f.route,
      ),
      /全部目标/,
    );
    await assert.rejects(
      f.host.call(
        f.submitArgs(
          f.deliveries.map((delivery) => ({
            ...delivery,
            payload: { ...delivery.payload, text: "x".repeat(1200) },
          })),
        ),
        f.route,
      ),
      /总输出上限/,
    );
    assert.equal((await f.production()).candidates.length, 0);
  } finally {
    await f.close();
  }
});

test("Host 提交后回执暂不可核验：返回unknown而不是未保存，重开同命令不重复写入", async () => {
  const f = await fixture();
  try {
    await f.prepare();
    const platform = f.shared().platform;
    const studio = f.shared().studio;
    const refresh = platform.refreshContent.bind(platform);
    const read = studio.readInputResult.bind(studio);
    let projected = 0;
    platform.refreshContent = async (...args: Parameters<typeof refresh>) => {
      if (++projected === 2) throw new Error("合成候选提交后目录不可用");
      return refresh(...args);
    };
    studio.readInputResult = async () => {
      throw new Error("合成回执读取暂时不可用");
    };
    const envelope = f.host.envelope(f.submitArgs(), f.route);
    const uncertain = (await f.host.tools.call(envelope)) as BatchReceipt;
    assert.equal(uncertain.ok, false);
    assert.equal(
      uncertain.savedCount,
      1,
      "Only independently confirmed saved receipts are counted",
    );
    assert.deepEqual(
      uncertain.results.map((entry) => entry.status),
      ["saved", "unknown", "not-run"],
    );
    assert.equal(
      uncertain.results[1]!.saved,
      null,
      "Cannot turn receipt unavailability into proof of rollback",
    );
    assert.equal(uncertain.results[1]!.candidateId, undefined);
    assert.equal(
      (await f.production()).candidates.length,
      2,
      "The unknown outcome did commit in the domain",
    );
    platform.refreshContent = refresh;
    studio.readInputResult = read;
    await f.host.reopen();
    const recovered = (await f.host.tools.call(envelope)) as BatchReceipt;
    assert.equal(recovered.ok, true);
    assert.equal(recovered.savedCount, 3);
    assert.equal(
      recovered.results[0]!.candidateId,
      uncertain.results[0]!.candidateId,
    );
    assert.equal((await f.production()).candidates.length, 3);
  } finally {
    await f.close();
  }
});

test("Host 串行批次阶段间取消：保留已保存第一项，后续写入停止", async () => {
  const f = await fixture();
  try {
    await f.prepare();
    const platform = f.shared().platform;
    const original = platform.refreshContent.bind(platform);
    let projected = 0;
    platform.refreshContent = async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      if (++projected === 1) f.host.setInputExecution("running", true, f.route);
      return result;
    };
    const result = await f.host.call<BatchReceipt>(f.submitArgs(), f.route);
    assert.equal(result.ok, false);
    assert.equal(result.savedCount, 1);
    assert.deepEqual(
      result.results.map((entry) => entry.status),
      ["saved", "unknown", "not-run"],
    );
    assert.equal(result.results[1]!.saved, null);
    assert.match(result.results[1]!.error!, /未获准|停止|取消/);
    assert.equal((await f.production()).candidates.length, 1);
  } finally {
    await f.close();
  }
});

test("Host 三目标 legacy false 可准备、读取与提交；仅旧开关往返保留固定范围及冷恢复幂等", async () => {
  const f = await fixture();
  try {
    await f.metadata(false);
    const prepared = await f.prepare();
    assert.equal(prepared.prepared, true);
    assert.equal(prepared.generations.length, 3);
    const fixed = await f.call<{
      generating: boolean;
      targets: Array<{
        generation: { targetId: string; baseRevision: number };
        target: { itemId: string; draft: LiveScriptDraft };
      }>;
    }>({ action: "read-workflow" });
    assert.equal(fixed.generating, true);
    assert.deepEqual(
      fixed.targets.map((target) => target.generation.targetId),
      f.targetIds,
    );
    assert.ok(
      fixed.targets.every(
        (target) =>
          target.generation.baseRevision === 1 &&
          target.target.draft.text === "",
      ),
    );
    await f.metadata(true);
    await f.metadata(false);
    assert.equal((await f.overview()).brief.modelProcessingAllowed, false);
    assert.deepEqual(await f.call({ action: "read-workflow" }), fixed);
    const envelope = f.host.envelope(f.submitArgs(), f.route);
    const saved = (await f.host.tools.call(envelope)) as BatchReceipt;
    assert.equal(saved.ok, true);
    assert.equal(saved.kind, "candidates");
    assert.equal(saved.savedCount, 3);
    assert.deepEqual(
      saved.results.map((result) => result.status),
      ["saved", "saved", "saved"],
    );
    assert.equal(
      new Set(saved.results.map((result) => result.candidateId)).size,
      3,
    );
    assert.ok(
      saved.results.every(
        (result) => result.receipt?.entityId === result.candidateId,
      ),
    );
    await f.host.reopen();
    assert.deepEqual(await f.host.tools.call(envelope), saved);
    assert.equal(
      (await f.call<{ total: number }>({ action: "read-results" })).total,
      3,
    );
    const state = await f.production();
    assert.equal(state.brief.modelProcessingAllowed, false);
    assert.equal(state.candidates.length, 3);
    assert.ok(
      state.items.every(
        (item) => item.revision === 1 && item.versions[0]!.draft.text === "",
      ),
    );
  } finally {
    await f.close();
  }
});

for (const kind of ["cancel", "creative-context"] as const) {
  test(`Host 三目标提交前${kind === "cancel" ? "取消执行" : "变更实际创作风格"}，不得写候选`, async () => {
    const f = await fixture();
    try {
      await f.prepare();
      if (kind === "cancel") f.host.setInputExecution("running", true, f.route);
      else await f.metadata(true, { style: "实际变更后的创作风格" });
      const rejected = await f.host.call<BatchReceipt>(f.submitArgs(), f.route);
      assert.equal(rejected.ok, false);
      assert.equal(rejected.savedCount, 0);
      assert.deepEqual(
        rejected.results.map((entry) => entry.status),
        [kind === "cancel" ? "unknown" : "failed", "not-run", "not-run"],
      );
      assert.equal(
        rejected.results[0]!.saved,
        kind === "cancel" ? null : false,
      );
      assert.match(
        rejected.results[0]!.error!,
        kind === "cancel"
          ? /未获准|停止|取消/
          : /剧本创作要求已变化，请重新准备/,
      );
      assert.equal((await f.production()).candidates.length, 0);
    } finally {
      await f.close();
    }
  });
}

test("Host 原单目标请求与单draft结果结构仍保持，不强制多目标或额外授权", async () => {
  const f = await fixture();
  try {
    await f.call({ action: "prepare-workflow", ...f.generation });
    const packet = await f.call<{
      outputSchema: { type: string };
      targets?: unknown;
      target: { itemId: string };
    }>({ action: "read-workflow" });
    assert.equal(packet.outputSchema.type, "object");
    assert.equal(packet.targets, undefined);
    assert.equal(packet.target.itemId, f.targetIds[0]);
    const result = await f.host.call<{
      ok: boolean;
      kind: string;
      candidateId: string;
      receipt: { entityId: string };
    }>(
      {
        action: "script",
        script: {
          action: "submit-workflow",
          payload: f.deliveries[0]!.payload,
          explanation: "原单目标",
          checks,
        },
      },
      f.route,
    );
    assert.equal(result.ok, true);
    assert.equal(result.kind, "candidate");
    assert.equal(result.receipt.entityId, result.candidateId);
    assert.equal((await f.production()).candidates.length, 1);
  } finally {
    await f.close();
  }
});
