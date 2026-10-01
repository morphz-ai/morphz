import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool, type QueryResult } from "pg";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { scriptDocxManifest } from "./script-docx-fixture.js";
import { localAccess } from "../packages/core/src/model.js";
import {
  currentScriptDraft,
  emptyScriptDraft,
  scriptCandidateStale,
  scriptGenerationSchema,
  scriptIssues,
  type ScriptGeneration,
  type ScriptItem,
  type ScriptProduction,
} from "../packages/core/src/script-studio.js";
import { buildScriptDocx } from "../packages/core/src/script-studio-docx.js";
import type { HostInvocation } from "../packages/application/src/agent-tools.js";
import type { LiveScriptDraft } from "../packages/script-studio/src/store.js";
import {
  createScriptProduction,
  createScriptItem,
  reviseScriptItem,
  updateScriptProduction,
  decideScriptCandidate,
  submitScriptCandidate,
  submitScriptReviewBatch,
  transitionScriptWorkflow,
  changeScriptReview,
  recordScriptExport,
} from "../packages/application/src/script-production-service.js";

const otherHuman = {
  principalId: "other-script-human",
  actantId: "other-script-actant",
};
const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;
type Backend = "sqlite" | "postgres";
type Preparation = {
  route: HostInvocation;
  inputId: string;
  generation: ScriptGeneration;
};

// Real Platform/Objects/Script databases and authority. Only accepted Runtime
// evidence and generated prose are controlled; no model runs. This adapter
// dispatches production services, never a parallel Workspace reducer.
async function fixture(backend: Backend) {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const schemas = {
    platform: `si_p_${suffix}`,
    objects: `si_o_${suffix}`,
    scriptStudio: `si_s_${suffix}`,
    reader: `si_r_${suffix}`,
    browser: `si_b_${suffix}`,
  };
  const admin =
    backend === "postgres" ? new Pool({ connectionString: postgresUrl }) : null;
  const ownedSchemaOids = new Map<string, number>();
  let host: Awaited<ReturnType<typeof agentDomainFixture>> | undefined;
  const close = async () => {
    try {
      await host?.close();
    } finally {
      if (admin) {
        try {
          for (const [schema, expectedOid] of ownedSchemaOids) {
            assert.ok(/^si_[posrb]_[a-f0-9]{16}$/.test(schema));
            assert.ok(Object.values(schemas).includes(schema));
            const current: QueryResult<{ oid: number }> = await admin.query<{
              oid: number;
            }>("SELECT oid FROM pg_namespace WHERE nspname=$1", [schema]);
            assert.equal(
              current.rows[0]?.oid,
              expectedOid,
              "cleanup refuses an absent or replaced namespace; only this fixture's fixed owned OID may be dropped",
            );
            await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
          }
        } finally {
          await admin.end();
        }
      }
    }
  };
  try {
    if (admin)
      for (const schema of Object.values(schemas)) {
        await admin.query(`CREATE SCHEMA "${schema}"`);
        const created: QueryResult<{ oid: number }> = await admin.query<{
          oid: number;
        }>("SELECT oid FROM pg_namespace WHERE nspname=$1", [schema]);
        assert.equal(created.rows.length, 1);
        assert.ok(Number.isSafeInteger(created.rows[0]!.oid));
        ownedSchemaOids.set(schema, created.rows[0]!.oid);
      }
    host = await agentDomainFixture({
      additionalHumans: [otherHuman],
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
                deploymentId: `script_invariants_${suffix}`,
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
    const h = host;
    const productionId = `script_${randomUUID().replaceAll("-", "")}`;
    const shared = () => ({
      platform: h.domains.content.platform,
      studio: h.domains.content.studio!,
      instanceId: h.domains.content.instanceIds.scriptStudio,
      productionId,
    });
    const read = () =>
      h.withHuman((actor) =>
        shared().studio.readProduction({
          credential: actor.credential,
          productionId,
        }),
      );
    const item = async (id: string) =>
      (await read()).items.find((i) => i.id === id)!;
    const draft = (id: string) =>
      h.withHuman(
        async (actor) =>
          (
            await shared().studio.readItemVersion({
              credential: actor.credential,
              productionId,
              itemId: id,
            })
          ).draft,
      );
    const empty = (
      title: string,
      changes: Partial<LiveScriptDraft> = {},
    ): LiveScriptDraft => ({
      ...emptyScriptDraft(title),
      sources: [],
      ...changes,
    });
    const create = async (
      kind: ScriptItem["kind"],
      changes: Partial<LiveScriptDraft> = {},
      route?: HostInvocation,
    ) => {
      const itemId = `item_${randomUUID().replaceAll("-", "")}`;
      const current = await read();
      const work = (actor: Parameters<typeof createScriptItem>[0]["actor"]) =>
        createScriptItem({
          ...shared(),
          actor,
          commandId: randomUUID(),
          itemId,
          kind,
          expectedActivityRevision: current.activityRevision!,
          draft: empty(kind, changes),
        });
      await (route ? h.withAgent(work, route) : h.withHuman(work));
      return itemId;
    };
    const revise = async (id: string, changes: Partial<LiveScriptDraft>) =>
      h.withHuman(async (actor) =>
        reviseScriptItem({
          ...shared(),
          actor,
          commandId: randomUUID(),
          itemId: id,
          expectedRevision: (await item(id)).revision,
          draft: { ...(await draft(id)), ...changes },
        }),
      );
    const settings = async (
      changes: Partial<
        Pick<
          ScriptProduction,
          "title" | "brief" | "template" | "reviewerPrincipalIds"
        >
      > = {},
    ) => {
      const p = await read();
      return h.withHuman((actor) =>
        updateScriptProduction({
          ...shared(),
          actor,
          commandId: randomUUID(),
          expectedRevision: p.revision,
          title: p.title,
          brief: p.brief,
          template: p.template,
          reviewerPrincipalIds: p.reviewerPrincipalIds,
          ...changes,
        }),
      );
    };
    const allow = async () =>
      settings({
        brief: {
          ...(await read()).brief,
          modelProcessingAllowed: true,
          rightsStatement: "只使用合成测试资料",
        },
      });
    const workflow = async (id: string) => {
      const i = await item(id);
      return {
        itemId: id,
        expectedRevision: i.revision,
        expectedWorkflowRevision: i.workflowRevision,
      };
    };
    const flow = async (
      id: string,
      action: "submit-review" | "review-decision" | "lock-item",
      patch: Partial<Awaited<ReturnType<typeof workflow>>> = {},
    ) =>
      h.withHuman(async (actor) =>
        transitionScriptWorkflow({
          ...shared(),
          actor,
          commandId: randomUUID(),
          ...(await workflow(id)),
          action,
          ...(action === "review-decision"
            ? { decision: "approve" as const, note: "合成人工审阅" }
            : {}),
          ...patch,
        }),
      );
    const approve = async (id: string, lock = false) => {
      await flow(id, "submit-review");
      await flow(id, "review-decision");
      if (lock) await flow(id, "lock-item");
    };
    const generation = async (
      id: string,
      references: ScriptGeneration["references"] = [],
      changes: Partial<ScriptGeneration> = {},
    ): Promise<ScriptGeneration> => ({
      productionId,
      targetId: id,
      baseRevision: (await item(id)).revision,
      contextRevision: (await read()).revision,
      purpose: "rewrite",
      references,
      maxCandidates: 2,
      maxOutputCharacters: 8000,
      maxReviewPasses: 0,
      ...changes,
    });
    const prepare = async (request: ScriptGeneration): Promise<Preparation> => {
      const route = h.input(h.projectId, "合成固定生成请求");
      const inputId = (await h.readAcceptedInput(route)).input_id;
      const prepared = await h.withAgent(
        (actor) =>
          shared().studio.prepareGeneration({
            credential: actor.credential,
            commandId: randomUUID(),
            productionId,
            inputId,
            generation: request,
          }),
        route,
      );
      return { route, inputId, generation: prepared.generation };
    };
    const candidate = async (
      p: Preparation,
      changes: Partial<LiveScriptDraft> = {},
    ) =>
      h.withAgent(
        async (actor) =>
          submitScriptCandidate({
            ...shared(),
            actor,
            commandId: randomUUID(),
            inputId: p.inputId,
            draft: {
              ...(await draft(p.generation.targetId)),
              text: "合成候选",
              ...changes,
            },
            explanation: "不是模型质量验收",
          }),
        p.route,
      );
    const decide = async (
      candidateId: string,
      decision: "accept" | "reject",
      expectedRevision = 1,
    ) =>
      h.withHuman((actor) =>
        decideScriptCandidate({
          ...shared(),
          actor,
          commandId: randomUUID(),
          candidateId,
          expectedRevision,
          decision,
        }),
      );
    const exporting = async (
      items: { itemId: string; revision: number }[],
      workingCopy = false,
      template?: ScriptProduction["template"],
    ) => {
      const current = await read();
      return h.withHuman((actor) =>
        recordScriptExport({
          ...shared(),
          actor,
          commandId: randomUUID(),
          expectedRevision: current.revision,
          items,
          template: template ?? current.template,
          ...(workingCopy ? { workingCopy: true } : {}),
        }),
      );
    };
    const unchanged = async (work: () => Promise<unknown>, pattern: RegExp) => {
      const before = await read();
      await assert.rejects(work, pattern);
      assert.deepEqual(
        await read(),
        before,
        "拒绝不得留下正文、版本、候选、意见或导出变化",
      );
    };
    const batch = async (
      p: Preparation,
      itemId: string,
      itemRevision: number,
      quote: string,
    ) =>
      h.withAgent(
        (actor) =>
          submitScriptReviewBatch({
            ...shared(),
            actor,
            commandId: randomUUID(),
            inputId: p.inputId,
            reviews: [
              {
                itemId,
                itemRevision,
                quote,
                body: "合成迟到阻断意见",
                severity: "blocking",
              },
            ],
          }),
        p.route,
      );
    await h.withHuman((actor) =>
      createScriptProduction({
        ...shared(),
        actor,
        commandId: randomUUID(),
        projectId: h.projectId,
        title: "TEST 真实剧本边界",
      }),
    );
    return {
      host: h,
      shared,
      productionId,
      read,
      item,
      draft,
      empty,
      create,
      revise,
      settings,
      allow,
      workflow,
      flow,
      approve,
      generation,
      prepare,
      candidate,
      decide,
      exporting,
      unchanged,
      batch,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function domainTest(title: string, work: (f: Fixture) => Promise<void>) {
  for (const backend of ["sqlite", "postgres"] as const)
    test(
      `${backend}: ${title}`,
      { skip: backend === "postgres" && !postgresUrl },
      async () => {
        const f = await fixture(backend);
        try {
          await work(f);
          f.host.assertNoLegacyData();
        } finally {
          await f.close();
        }
      },
    );
}

domainTest(
  "设置无变更不写新版本，呈现改动保留批准和候选，创作要求回退不复活旧输入",
  async (f) => {
    await f.allow();
    const done = await f.create("episode", { text: "已经人工审阅的正文" });
    const target = await f.create("episode", { text: "待改写正文" });
    const generation = await f.generation(target);
    const pending = await f.candidate(await f.prepare(generation));
    await f.approve(done, true);
    const first = await f.exporting([{ itemId: done, revision: 1 }]);
    const original = await f.read();
    const bytes = buildScriptDocx(
      scriptDocxManifest(original, first.original.exportId),
    );
    const noop = await f.settings();
    assert.equal(noop.original.eventId, null);
    assert.deepEqual(await f.read(), original);
    await f.settings({
      title: "只改名和排版",
      template: { ...original.template, fontSize: 14 },
    });
    const presented = await f.read();
    assert.deepEqual(
      (await f.item(done)).approval,
      original.items.find((i) => i.id === done)!.approval,
    );
    assert.equal((await f.item(done)).status, "locked");
    assert.equal(
      scriptCandidateStale(
        presented,
        presented.candidates.find(
          (c) => c.id === pending.original.candidateId,
        )!,
      ),
      false,
    );
    await f.prepare(generation);
    await f.exporting([{ itemId: done, revision: 1 }]);
    assert.deepEqual(
      buildScriptDocx(
        scriptDocxManifest(await f.read(), first.original.exportId),
      ),
      bytes,
    );
    await f.settings({ brief: { ...presented.brief, style: "新创作要求" } });
    assert.equal((await f.item(done)).approval, null);
    await f.unchanged(
      () => f.exporting([{ itemId: done, revision: 1 }]),
      /审阅有效/,
    );
    await f.settings({ brief: original.brief });
    const reverted = await f.read();
    assert.equal(
      scriptCandidateStale(
        reverted,
        reverted.candidates.find((c) => c.id === pending.original.candidateId)!,
      ),
      true,
    );
    await f.unchanged(() => f.prepare(generation), /变化|版本/);
    await f.unchanged(
      () => f.decide(pending.original.candidateId, "accept"),
      /过期/,
    );
    assert.deepEqual(
      buildScriptDocx(
        scriptDocxManifest(await f.read(), first.original.exportId),
      ),
      bytes,
    );
  },
);

domainTest(
  "真实条目结构拒绝无效父集、角色、自身和循环，固定生成自动闭包并去重",
  async (f) => {
    const character = await f.create("character", { text: "角色设定" });
    const episode = await f.create("episode", {
      text: "分集",
      dependencies: [{ itemId: character, revision: 1 }],
    });
    await f.unchanged(
      () => f.create("scene", { text: "孤立分场" }),
      /只有分场|所属集/,
    );
    await f.unchanged(() => f.create("scene", { parentId: episode }), /依赖/);
    await f.unchanged(
      () => f.create("episode", { parentId: episode }),
      /只有分场/,
    );
    await f.unchanged(
      () =>
        f.create("episode", {
          characters: [episode],
          dependencies: [{ itemId: episode, revision: 1 }],
        }),
      /角色/,
    );
    await f.unchanged(
      () =>
        f.revise(character, {
          dependencies: [{ itemId: episode, revision: 1 }],
        }),
      /循环/,
    );
    await f.unchanged(
      () =>
        f.revise(episode, { dependencies: [{ itemId: episode, revision: 1 }] }),
      /自身|循环/,
    );
    const scene = await f.create("scene", {
      parentId: episode,
      text: "有效分场",
      characters: [character],
      dependencies: [
        { itemId: episode, revision: 1 },
        { itemId: character, revision: 1 },
      ],
    });
    await f.allow();
    const expected = [
      { itemId: episode, revision: 1 },
      { itemId: character, revision: 1 },
    ].sort((a, b) => a.itemId.localeCompare(b.itemId));
    assert.deepEqual(
      (
        await f.prepare(
          await f.generation(scene, [{ itemId: episode, revision: 1 }]),
        )
      ).generation.references,
      expected,
    );
    assert.deepEqual(
      (await f.prepare(await f.generation(scene, [...expected, expected[0]!])))
        .generation.references,
      expected,
    );
  },
);

domainTest(
  "创作副本不变更稿件，正式导出拒绝未锁稿、孤立分场、重复版本和变化模板",
  async (f) => {
    const episode = await f.create("episode", { text: "已保存创作正文" });
    const selected = [{ itemId: episode, revision: 1 }];
    await f.unchanged(() => f.exporting(selected), /锁定稿/);
    const before = await f.item(episode);
    const copy = await f.exporting(selected, true);
    assert.deepEqual(await f.item(episode), before);
    const bytes = buildScriptDocx(
      scriptDocxManifest(await f.read(), copy.original.exportId),
    );
    assert.match(Buffer.from(bytes).toString("utf8"), /已保存创作正文/);
    assert.match(Buffer.from(bytes).toString("utf8"), /创作副本，不代表已审阅/);
    assert.doesNotMatch(Buffer.from(bytes).toString("utf8"), /本次交付/);
    const empty = await f.create("episode");
    await f.unchanged(
      () => f.exporting([{ itemId: empty, revision: 1 }], true),
      /先保存/,
    );
    await f.revise(episode, { text: "后来的版本" });
    await f.unchanged(() => f.exporting(selected, true), /版本已变化/);
    assert.deepEqual(
      buildScriptDocx(
        scriptDocxManifest(await f.read(), copy.original.exportId),
      ),
      bytes,
    );
    const scene = await f.create("scene", {
      text: "分场正文",
      parentId: episode,
      dependencies: [{ itemId: episode, revision: 2 }],
    });
    await f.approve(episode, true);
    await f.approve(scene, true);
    const exact = [
      { itemId: episode, revision: 2 },
      { itemId: scene, revision: 1 },
    ];
    await f.unchanged(
      () => f.exporting([{ itemId: scene, revision: 1 }]),
      /所属集/,
    );
    await f.unchanged(() => f.exporting([exact[0]!, exact[0]!]), /重复/);
    await f.unchanged(
      async () =>
        f.exporting(exact, false, {
          ...(await f.read()).template,
          fontSize: 18,
        }),
      /模板/,
    );
    await f.unchanged(
      () => f.exporting([{ itemId: episode, revision: 999 }]),
      /版本已变化/,
    );
    await f.exporting(exact);
    assert.equal((await f.read()).exports.length, 2);
  },
);

domainTest(
  "普通 Agent 空条目白名单不受模型许可影响，Human许可与锁稿正式写边界保持",
  async (f) => {
    const parent = await f.create("episode", { text: "父集正文" });
    const character = await f.create("character", { text: "角色" });
    const route = f.host.input();
    const initial = await f.read();
    await f.unchanged(
      () =>
        f.host.withAgent(
          (actor) =>
            updateScriptProduction({
              ...f.shared(),
              actor,
              commandId: randomUUID(),
              expectedRevision: initial.revision,
              title: initial.title,
              brief: { ...initial.brief, modelProcessingAllowed: true },
              reviewerPrincipalIds: initial.reviewerPrincipalIds,
              template: initial.template,
            }),
          route,
        ),
      /人工/,
    );
    await f.unchanged(
      async () => f.prepare(await f.generation(parent)),
      /尚未获准/,
    );
    for (const allowed of [false, true]) {
      if (allowed) await f.allow();
      const empty = await f.create(
        "episode",
        { title: "空条目", order: 3 },
        route,
      );
      assert.deepEqual(await f.draft(empty), f.empty("空条目", { order: 3 }));
      const scene = {
        title: "空分场",
        parentId: parent,
        dependencies: [
          { itemId: parent, revision: (await f.item(parent)).revision },
        ],
      };
      const emptyScene = await f.create("scene", scene, route);
      assert.deepEqual(await f.draft(emptyScene), f.empty("空分场", scene));
      const attempts: Partial<LiveScriptDraft>[] = [
        { text: "不能直接进入正式稿" },
        { basis: "adaptation" },
        {
          sources: [
            {
              appId: "morphz.objects",
              instanceId: f.host.domains.content.instanceIds.objects,
              objectId: "not-a-fixed-source",
              versionRef: "1",
              quote: "原文",
            },
          ],
        },
        { dependencies: [{ itemId: character, revision: 1 }] },
        { location: "天台" },
        { storyTime: "天亮前" },
        { characters: [character] },
        { audienceKnowledge: "观众知道" },
        { characterKnowledge: "角色知道" },
        { setupPayoff: "伏笔" },
        { productionNotes: "制作要求" },
      ];
      for (const changes of attempts)
        await f.unchanged(
          () => f.create("episode", changes, route),
          /只能建立空条目/,
        );
      await f.unchanged(
        () =>
          f.create(
            "scene",
            {
              ...scene,
              dependencies: [
                ...scene.dependencies,
                { itemId: character, revision: 1 },
              ],
            },
            route,
          ),
        /空分场|空条目/,
      );
      await f.revise(parent, { text: `父集人工新版 ${allowed}` });
      await f.unchanged(
        () => f.create("scene", scene, route),
        /当前版本|依赖.*版本/,
      );
    }
    const current = await f.read();
    await f.unchanged(
      () =>
        f.host.withAgent(
          (actor) =>
            updateScriptProduction({
              ...f.shared(),
              actor,
              commandId: randomUUID(),
              expectedRevision: current.revision,
              title: current.title,
              brief: { ...current.brief, modelProcessingAllowed: true },
              reviewerPrincipalIds: current.reviewerPrincipalIds,
              template: current.template,
            }),
          route,
        ),
      /人工/,
    );
    const target = await f.create("episode", {
      text: "准备后被人工锁定的稿件",
    });
    const unprepared = {
      route,
      inputId: (await f.host.readAcceptedInput(route)).input_id,
      generation: await f.generation(target),
    };
    await f.unchanged(() => f.candidate(unprepared), /固定.*候选范围/);
    const pending = await f.prepare(await f.generation(target));
    await f.approve(target, true);
    await f.unchanged(() => f.candidate(pending), /锁稿/);
    await f.unchanged(() => f.revise(target, { text: "不能覆盖" }), /锁稿/);
    // Preparing is not a write: retain current formal submission/revision gates,
    // not the old reducer's ban on preparing a locked rewrite.
    await f.prepare(await f.generation(target));
    const review = await f.prepare(
      await f.generation(target, [], { purpose: "continuity" }),
    );
    await f.batch(review, target, 1, "人工锁定");
    assert.equal((await f.item(target)).status, "locked");
  },
);

domainTest(
  "候选三种独立过期原因拒绝采纳而允许拒绝，迟到提交不写入候选",
  async (f) => {
    await f.allow();
    for (const change of ["manual", "upstream", "context"] as const) {
      const setting = await f.create("setting", { text: "固定设定" });
      const target = await f.create("episode", {
        text: "原人工正文",
        dependencies: [{ itemId: setting, revision: 1 }],
      });
      const prepared = await f.prepare(
        await f.generation(target, [{ itemId: setting, revision: 1 }]),
      );
      const pending = await f.candidate(prepared);
      if (change === "manual") await f.revise(target, { text: "人工新正文" });
      else if (change === "upstream")
        await f.revise(setting, { text: "新设定" });
      else
        await f.settings({
          brief: {
            ...(await f.read()).brief,
            style: `创作要求 ${randomUUID()}`,
          },
        });
      const current = await f.read();
      assert.equal(
        scriptCandidateStale(
          current,
          current.candidates.find(
            (c) => c.id === pending.original.candidateId,
          )!,
        ),
        true,
      );
      await f.unchanged(
        () => f.decide(pending.original.candidateId, "accept"),
        change === "upstream" ? /固定的上游版本已变化/ : /候选稿已过期/,
      );
      await f.unchanged(
        () => f.candidate(prepared, { text: "迟到候选不能留下新提案" }),
        change === "context"
          ? /剧本创作要求或模型许可已变化/
          : /目标或上游引用已过期/,
      );
      assert.equal(
        currentScriptDraft(await f.item(target)).text,
        change === "manual" ? "人工新正文" : "原人工正文",
      );
      await f.decide(pending.original.candidateId, "reject");
      assert.equal(
        (await f.read()).candidates.find(
          (c) => c.id === pending.original.candidateId,
        )!.status,
        "rejected",
      );
    }
  },
);

domainTest(
  "候选预算按实际JSON、数量和目的执行，材料整包超120k拒绝，未固定角色和依赖不能加入",
  async (f) => {
    await f.allow();
    const target = await f.create("episode", { text: "基础稿" });
    const exactDraft = { ...(await f.draft(target)), text: "精确输出预算候选" };
    const size = JSON.stringify(exactDraft).length;
    const prepared = await f.prepare(
      await f.generation(target, [], {
        maxCandidates: 1,
        maxOutputCharacters: size,
      }),
    );
    await f.unchanged(
      () =>
        f.candidate(prepared, { ...exactDraft, text: exactDraft.text + "多" }),
      /输出上限/,
    );
    await f.candidate(prepared, exactDraft);
    await f.unchanged(
      () => f.candidate(prepared, { ...exactDraft, text: "另一候选" }),
      /数量.*上限/,
    );
    const review = await f.prepare(
      await f.generation(target, [], { purpose: "impact" }),
    );
    await f.unchanged(() => f.candidate(review), /候选范围/);
    const large = await f.create("source", { text: "x".repeat(70_000) });
    const second = await f.create("source", { text: "y".repeat(70_000) });
    const largeRequest = await f.prepare(
      await f.generation(target, [
        { itemId: large, revision: 1 },
        { itemId: second, revision: 1 },
      ]),
    );
    await f.unchanged(
      () =>
        f.host.call(
          { action: "script", script: { action: "read-workflow" } },
          largeRequest.route,
        ),
      /120000/,
    );
    // Packet bytes and separately paged Objects read-source have distinct bounds.
    // No retired cumulative full-source preparation limit is reintroduced.
    const setting = await f.create("setting", { text: "未固定设定" });
    const character = await f.create("character", { text: "未固定角色" });
    const scope = await f.prepare(await f.generation(target));
    await f.unchanged(
      () =>
        f.candidate(scope, {
          dependencies: [{ itemId: setting, revision: 1 }],
        }),
      /超出本次固定资料/,
    );
    await f.unchanged(
      () => f.candidate(scope, { characters: [character] }),
      /绑定对应依赖版本/,
    );
    await f.unchanged(
      () =>
        f.candidate(scope, {
          characters: [character],
          dependencies: [{ itemId: character, revision: 1 }],
        }),
      /超出本次固定资料/,
    );
  },
);

domainTest(
  "迟到固定审阅保留原版本来源，不撤销当前稿和下游批准锁稿",
  async (f) => {
    await f.allow();
    for (const change of [
      "old-item",
      "context",
      "target",
      "reference",
    ] as const) {
      const setting = await f.create("setting", { text: "保持同版的设定正文" });
      const target = await f.create("episode", {
        text: "旧稿中的问题",
        dependencies: [{ itemId: setting, revision: 1 }],
      });
      const prepared = await f.prepare(
        await f.generation(target, [{ itemId: setting, revision: 1 }], {
          purpose: "continuity",
        }),
      );
      if (change === "context")
        await f.settings({
          brief: {
            ...(await f.read()).brief,
            style: `新的上下文 ${randomUUID()}`,
          },
        });
      else if (change === "reference") {
        await f.revise(setting, { text: "设定的新版本" });
        await f.revise(target, {
          dependencies: [{ itemId: setting, revision: 2 }],
        });
      } else await f.revise(target, { text: "人工已修正的新稿" });
      await f.approve(setting, true);
      await f.approve(target, true);
      const scene = await f.create("scene", {
        text: "依赖当前稿的分场",
        parentId: target,
        dependencies: [
          { itemId: target, revision: (await f.item(target)).revision },
        ],
      });
      await f.approve(scene, true);
      const before = (await f.read()).items;
      const reviewItem = change === "old-item" ? target : setting;
      const receipt = await f.batch(
        prepared,
        reviewItem,
        1,
        change === "old-item" ? "旧稿中的问题" : "设定正文",
      );
      const current = await f.read();
      const review = current.reviews.find(
        (r) => r.id === receipt.original.reviewIds[0],
      )!;
      assert.equal(review.itemRevision, 1);
      assert.equal(review.contextRevision, prepared.generation.contextRevision);
      assert.equal(review.inputId, prepared.inputId);
      assert.equal(review.historicalOnly, true);
      assert.deepEqual(current.items, before);
      // Other iterations' current locks may become invalid after a global
      // creative change; the newly reviewed branch itself has no blockers.
      assert.equal(
        scriptIssues(current).some((i) =>
          [setting, target, scene].includes(i.itemId),
        ),
        false,
      );
      await f.exporting([
        { itemId: target, revision: (await f.item(target)).revision },
        { itemId: scene, revision: 1 },
      ]);
    }
    await f.host.reopen();
    const restored = await f.read();
    assert.equal(restored.reviews.length, 4);
    assert.ok(restored.reviews.every((r) => r.historicalOnly && r.inputId));
    assert.equal(restored.exports.length, 4);
  },
);

domainTest(
  "生效阻断意见不能另存绕过；独立workflow CAS和指定Human审阅权在真实域执行",
  async (f) => {
    const target = await f.create("episode", { text: "待解决的质量问题" });
    const snapshot = await f.workflow(target);
    await f.flow(target, "submit-review");
    await f.unchanged(
      () => f.flow(target, "review-decision", snapshot),
      /审阅状态已变化/,
    );
    await f.unchanged(
      () =>
        f.host.withHuman((actor) =>
          changeScriptReview({
            ...f.shared(),
            actor,
            commandId: randomUUID(),
            action: "add-review",
            itemId: target,
            itemRevision: 1,
            quote: "不存在的原文",
            body: "不允许伪造",
            severity: "blocking",
          }),
        ),
      /有效正文版本及原文/,
    );
    const active = await f.host.withHuman((actor) =>
      changeScriptReview({
        ...f.shared(),
        actor,
        commandId: randomUUID(),
        action: "add-review",
        itemId: target,
        itemRevision: 1,
        quote: "质量问题",
        body: "必须人工确认处理",
        severity: "blocking",
      }),
    );
    assert.equal((await f.item(target)).status, "draft");
    assert.equal((await f.read()).reviews[0]!.historicalOnly, false);
    await f.revise(target, { text: "另存新稿不代表已经解决" });
    assert.equal(
      scriptIssues(await f.read()).filter((i) => i.code === "unresolved-review")
        .length,
      1,
    );
    await f.flow(target, "submit-review");
    await f.unchanged(() => f.flow(target, "review-decision"), /阻断|待处理/);
    assert.equal((await f.item(target)).status, "in-review");
    assert.equal((await f.item(target)).approval, null);
    await f.host.withHuman((actor) =>
      changeScriptReview({
        ...f.shared(),
        actor,
        commandId: randomUUID(),
        action: "resolve-review",
        reviewId: active.original.reviewId,
        expectedRevision: 1,
        resolution: "合成人工已核对",
      }),
    );
    await f.flow(target, "review-decision");
    const route = f.host.input();
    await f.unchanged(
      () =>
        f.host.withAgent(
          async (actor) =>
            transitionScriptWorkflow({
              ...f.shared(),
              actor,
              commandId: randomUUID(),
              ...(await f.workflow(target)),
              action: "lock-item",
            }),
          route,
        ),
      /本人|人工/,
    );
    await f.flow(target, "lock-item");
    assert.equal((await f.item(target)).status, "locked");
    await f.host.domains.content.platform.reconcileOperatorMembers(
      f.host.transport.identity(),
      [
        { ...localAccess, enabled: true, projectIds: [f.host.projectId] },
        { ...otherHuman, enabled: true, projectIds: [f.host.projectId] },
      ],
    );
    const otherTarget = await f.create("episode", {
      text: "其他成员可以提交，但不得自行批准",
    });
    const withOther = <T>(
      work: (
        actor: Parameters<typeof transitionScriptWorkflow>[0]["actor"],
      ) => Promise<T>,
    ) => f.host.domains.work.authority.withSession(otherHuman, () => {}, work);
    await withOther(async (actor) =>
      transitionScriptWorkflow({
        ...f.shared(),
        actor,
        commandId: randomUUID(),
        ...(await f.workflow(otherTarget)),
        action: "submit-review",
      }),
    );
    await f.unchanged(
      () =>
        withOther(async (actor) =>
          transitionScriptWorkflow({
            ...f.shared(),
            actor,
            commandId: randomUUID(),
            ...(await f.workflow(otherTarget)),
            action: "review-decision",
            decision: "approve",
            note: "不能自授审阅权",
          }),
        ),
      /指定审阅人/,
    );
    assert.equal((await f.item(otherTarget)).status, "in-review");
    assert.equal((await f.item(otherTarget)).approval, null);
  },
);

test("纯生成schema保留预算整数与目的约束，不借旧Workspace reducer验证", () => {
  const request = {
    productionId: "production",
    targetId: "episode",
    baseRevision: 1,
    contextRevision: 1,
    purpose: "rewrite",
    references: [],
    maxCandidates: 1,
    maxOutputCharacters: 800,
    maxReviewPasses: 0,
  };
  assert.doesNotThrow(() => scriptGenerationSchema.parse(request));
  for (const patch of [
    { maxCandidates: 4 },
    { maxReviewPasses: 3 },
    { maxOutputCharacters: 99 },
    { purpose: "invented" },
  ])
    assert.throws(() => scriptGenerationSchema.parse({ ...request, ...patch }));
});
