import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  applyCommand,
  commandSchema,
  initialWorkspace,
  localAccess,
  stateSchema,
  type AccessContext,
  type Operation,
} from "../packages/core/src/model.js";
import {
  currentScriptDraft,
  emptyScriptDraft,
  scriptCandidateStale,
  scriptGenerationSchema,
  scriptImpact,
  scriptIssues,
  type ScriptCommand,
  type ScriptDraft,
  type ScriptGeneration,
} from "../packages/core/src/script-studio.js";
import { workspaceFor } from "../packages/application/src/identity.js";
import { buildScriptDocx } from "../packages/core/src/script-studio-docx.js";

const agent = { principalId: "morphz-service", actantId: "morphz-agent" };

test("创作文稿导出不需要自我审批，不修改状态；正式交付仍检查锁稿与版本", () => {
  const f = fixture();
  const episode = f.create("episode", { text: "TEST 已保存的创作正文" });
  const before = structuredClone(f.item(episode));
  const request = {
    action: "record-export" as const,
    productionId: f.productionId,
    expectedRevision: f.production().revision,
    items: [{ itemId: episode, revision: 1 }],
    template: f.production().template,
  };
  assert.throws(() => f.run(request), /锁定稿/);
  const exportId = f.run({ ...request, workingCopy: true });
  assert.deepEqual(f.item(episode), before);
  assert.equal(f.production().exports.at(-1)!.workingCopy, true);
  const bytes = buildScriptDocx(f.production(), exportId);
  const xml = Buffer.from(bytes).toString("utf8");
  assert.match(xml, /TEST 已保存的创作正文/);
  assert.match(xml, /创作副本，不代表已审阅/);
  assert.doesNotMatch(xml, /本次交付/);
  f.revise(episode, { text: "后来的正文不得改变已导出的副本" });
  assert.deepEqual(buildScriptDocx(f.production(), exportId), bytes);
  assert.throws(() => f.run({ ...request, workingCopy: true }), /新版本/);
  const empty = f.create("episode");
  assert.throws(
    () =>
      f.run({
        ...request,
        items: [{ itemId: empty, revision: 1 }],
        workingCopy: true,
      }),
    /先保存/,
  );
  assert.equal(f.production().exports.length, 1);
});

function fixture() {
  let state = initialWorkspace();
  const execute = (
    operation: Operation,
    access = localAccess,
    originInputId?: string,
    commandId = randomUUID(),
  ) => {
    const result = applyCommand(
      state,
      commandSchema.parse({ commandId, operation }),
      access,
      "2026-09-18T10:00:00Z",
      originInputId,
    );
    state = result.state;
    return result.receipt.entityId;
  };
  const run = (
    command: ScriptCommand,
    access = localAccess,
    originInputId?: string,
  ) => execute({ type: "script-command", command }, access, originInputId);
  const productionId = run({
    action: "create-production",
    projectId: "first-project",
    title: "合成剧本领域测试",
  });
  const production = () =>
    state.scriptProductions.find((p) => p.id === productionId)!;
  const item = (id: string) => production().items.find((i) => i.id === id)!;
  const metadata = (
    changes: Partial<ReturnType<typeof production>["brief"]> = {},
  ) => {
    const p = production();
    run({
      action: "update-production",
      productionId,
      expectedRevision: p.revision,
      title: p.title,
      brief: { ...p.brief, ...changes },
      reviewerPrincipalIds: p.reviewerPrincipalIds,
      template: p.template,
    });
  };
  const create = (
    kind: ReturnType<typeof item>["kind"],
    draft: Partial<ScriptDraft> = {},
  ) =>
    run({
      action: "create-item",
      productionId,
      kind,
      draft: { ...emptyScriptDraft(kind), ...draft },
    });
  const revise = (id: string, changes: Partial<ScriptDraft>) =>
    run({
      action: "revise-item",
      productionId,
      itemId: id,
      expectedRevision: item(id).revision,
      draft: { ...currentScriptDraft(item(id)), ...changes },
    });
  const approve = (id: string, lock = false) => {
    run({
      action: "submit-review",
      productionId,
      itemId: id,
      expectedRevision: item(id).revision,
      expectedWorkflowRevision: item(id).workflowRevision,
    });
    run({
      action: "review-decision",
      productionId,
      itemId: id,
      expectedRevision: item(id).revision,
      expectedWorkflowRevision: item(id).workflowRevision,
      decision: "approve",
      note: "合成测试批准",
    });
    if (lock)
      run({
        action: "lock-item",
        productionId,
        itemId: id,
        expectedRevision: item(id).revision,
        expectedWorkflowRevision: item(id).workflowRevision,
      });
  };
  const generation = (
    targetId: string,
    references: ScriptGeneration["references"] = [],
    changes: Partial<ScriptGeneration> = {},
  ): ScriptGeneration => ({
    productionId,
    targetId,
    baseRevision: item(targetId).revision,
    contextRevision: production().revision,
    purpose: "rewrite",
    references,
    maxCandidates: 2,
    maxOutputCharacters: 5000,
    maxReviewPasses: 1,
    ...changes,
  });
  const input = (request?: ScriptGeneration) =>
    execute({
      type: "record-input",
      projectId: "first-project",
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "合成测试，不调用模型",
      targetActantId: agent.actantId,
      ...(request ? { scriptGeneration: request } : {}),
    });
  const candidate = (inputId: string, draft: ScriptDraft) =>
    run(
      {
        action: "submit-candidate",
        productionId,
        draft,
        explanation: "合成候选，非模型创作",
      },
      agent,
      inputId,
    );
  return {
    get state() {
      return state;
    },
    execute,
    run,
    productionId,
    production,
    item,
    metadata,
    create,
    revise,
    approve,
    generation,
    input,
    candidate,
  };
}

test("无变更保存不改版本；改名排版保留批准、候选和历史导出，创作变更不可反悔复活旧候选", () => {
  const f = fixture();
  f.metadata({ modelProcessingAllowed: true });
  const done = f.create("episode", { text: "已经审阅的第一集" });
  const pending = f.create("episode", { text: "待改写的第二集" });
  const generation = f.generation(pending);
  const inputId = f.input(generation);
  const candidateId = f.candidate(inputId, {
    ...currentScriptDraft(f.item(pending)),
    text: "第二集候选",
  });
  f.approve(done, true);
  const exported = () =>
    f.run({
      action: "record-export",
      productionId: f.productionId,
      expectedRevision: f.production().revision,
      items: [{ itemId: done, revision: f.item(done).revision }],
      template: f.production().template,
    });
  const exportId = exported();
  const originalBytes = buildScriptDocx(f.production(), exportId);
  const original = structuredClone(f.production());
  f.metadata();
  assert.deepEqual(
    f.production(),
    original,
    "same settings are a domain no-op",
  );
  f.run({
    action: "update-production",
    productionId: f.productionId,
    expectedRevision: f.production().revision,
    title: "改名",
    brief: f.production().brief,
    reviewerPrincipalIds: f.production().reviewerPrincipalIds,
    template: { ...f.production().template, fontSize: 14 },
  });
  assert.deepEqual(
    f.item(done).approval,
    original.items.find((i) => i.id === done)!.approval,
  );
  assert.equal(f.item(done).status, "locked");
  assert.equal(
    scriptCandidateStale(
      f.production(),
      f.production().candidates.find((c) => c.id === candidateId)!,
    ),
    false,
  );
  assert.doesNotThrow(
    () => f.input(generation),
    "prepared generation survives presentation-only changes",
  );
  exported();
  assert.deepEqual(buildScriptDocx(f.production(), exportId), originalBytes);
  f.metadata({ style: "新风格" });
  assert.equal(f.item(done).approval, null);
  assert.throws(exported, /审阅有效/);
  f.metadata({ style: original.brief.style });
  assert.equal(
    scriptCandidateStale(
      f.production(),
      f.production().candidates.find((c) => c.id === candidateId)!,
    ),
    true,
  );
  assert.throws(() => f.input(generation), /创作要求已有新版本/);
});

test("整份原作正文计入生成材料预算，引文授权只计入实际引文", () => {
  const f = fixture();
  f.metadata({ modelProcessingAllowed: true });
  const artifactId = f.execute({
    type: "create-artifact",
    projectId: "first-project",
    title: "合成长原作",
    content: { kind: "document", markdown: "合成原作".repeat(31_000) },
  });
  const target = f.create("episode", {
    sources: [{ artifactId, revision: 1, quote: "" }],
  });
  assert.throws(() => f.input(f.generation(target)), /120000/);
  f.revise(target, {
    sources: [{ artifactId, revision: 1, quote: "合成原作" }],
  });
  assert.doesNotThrow(() => f.input(f.generation(target)));
});

test("剧本领域默认空并兼容旧 Workspace；入口是可恢复的 builtin，不创建 demo", () => {
  const initial = initialWorkspace();
  assert.deepEqual(initial.scriptProductions, []);
  const { scriptProductions: _omitted, ...old } = initial;
  assert.deepEqual(stateSchema.parse(old).scriptProductions, []);
  const f = fixture();
  const instanceId = f.execute({
    type: "launch-application",
    workspaceId: "first-project",
    applicationId: "morphz.script-studio",
    applicationVersion: "1.0.0",
  });
  assert.equal(
    f.execute({
      type: "launch-application",
      workspaceId: "first-project",
      applicationId: "morphz.script-studio",
      applicationVersion: "1.0.0",
    }),
    instanceId,
  );
  assert.equal(f.state.scriptProductions.length, 1);
  assert.equal(f.production().items.length, 0);
  assert.throws(
    () =>
      applyCommand(
        f.state,
        commandSchema.parse({
          commandId: randomUUID(),
          applicationInstanceId: instanceId,
          operation: {
            type: "script-command",
            command: {
              action: "create-production",
              projectId: "first-project",
              title: "沙箱不得扩大权限",
            },
          },
        }),
        localAccess,
      ),
    /应用没有执行/,
  );
});

test("正文 CAS、历史恢复创建新版本，旧草稿不能覆盖新稿", () => {
  const f = fixture();
  const id = f.create("episode", { text: "人工原稿" });
  f.revise(id, { text: "人工新稿" });
  assert.equal(currentScriptDraft(f.item(id)).text, "人工新稿");
  assert.equal(f.item(id).versions[0]!.draft.text, "人工原稿");
  assert.throws(
    () =>
      f.run({
        action: "revise-item",
        productionId: f.productionId,
        itemId: id,
        expectedRevision: 1,
        draft: emptyScriptDraft("迟到覆盖"),
      }),
    /已有新版本/,
  );
  f.run({
    action: "restore-item",
    productionId: f.productionId,
    itemId: id,
    expectedRevision: 2,
    restoreRevision: 1,
  });
  assert.equal(f.item(id).revision, 3);
  assert.equal(f.item(id).versions.length, 3);
  assert.equal(currentScriptDraft(f.item(id)).text, "人工原稿");
});

test("角色、分场父集与依赖闭包必须有效，拒绝自身和循环依赖", () => {
  const f = fixture();
  const character = f.create("character", { text: "角色设定" });
  const episode = f.create("episode", {
    text: "分集",
    dependencies: [{ itemId: character, revision: 1 }],
  });
  assert.throws(() => f.create("scene", { text: "孤立分场" }), /分场必须/);
  assert.throws(() => f.create("scene", { parentId: episode }), /同时绑定依赖/);
  assert.throws(() => f.create("episode", { parentId: episode }), /只有分场/);
  assert.throws(
    () =>
      f.create("episode", {
        characters: [episode],
        dependencies: [{ itemId: episode, revision: 1 }],
      }),
    /角色条目/,
  );
  assert.throws(
    () =>
      f.revise(character, { dependencies: [{ itemId: episode, revision: 1 }] }),
    /循环/,
  );
  assert.throws(
    () =>
      f.revise(episode, { dependencies: [{ itemId: episode, revision: 1 }] }),
    /自身/,
  );
  const scene = f.create("scene", {
    parentId: episode,
    text: "场景",
    characters: [character],
    dependencies: [
      { itemId: episode, revision: 1 },
      { itemId: character, revision: 1 },
    ],
  });
  f.metadata({ modelProcessingAllowed: true, rightsStatement: "合成资料" });
  assert.throws(
    () => f.input(f.generation(scene, [{ itemId: episode, revision: 1 }])),
    /全部依赖/,
  );
  assert.throws(
    () =>
      f.input(
        f.generation(scene, [
          { itemId: episode, revision: 1 },
          { itemId: character, revision: 1 },
          { itemId: character, revision: 1 },
        ]),
      ),
    /不能重复/,
  );
  assert.ok(
    f.input(
      f.generation(scene, [
        { itemId: episode, revision: 1 },
        { itemId: character, revision: 1 },
      ]),
    ),
  );
});

test("原作引用核对确切历史和原文；整理保留引用，伪造引文与跨权限边界被拒绝", () => {
  const f = fixture();
  const artifactId = f.execute({
    type: "create-artifact",
    projectId: "first-project",
    title: "合成原作",
    content: { kind: "document", markdown: "可核验的原句" },
  });
  const sources = [{ artifactId, revision: 1, quote: "可核验的原句" }];
  const id = f.create("source", { text: "摘录", basis: "source", sources });
  assert.throws(
    () =>
      f.create("source", { sources: [{ ...sources[0]!, quote: "伪造文字" }] }),
    /原作引用/,
  );
  assert.throws(
    () => f.create("source", { sources: [{ ...sources[0]!, revision: 999 }] }),
    /原作引用/,
  );
  const other = f.execute({ type: "create-project", title: "合成另一项目" });
  f.execute({
    type: "organize-content",
    target: { kind: "artifact", id: artifactId },
    expectedRevision: 1,
    changes: { projectId: other },
  });
  f.metadata({ modelProcessingAllowed: true });
  assert.doesNotThrow(() => f.input(f.generation(id)));
  f.state.projects.find((p) => p.id === other)!.members = [
    localAccess.principalId,
  ];
  assert.throws(() => f.input(f.generation(id)), /原作版本已不可用/);
});

test("只有 Human 可确认权利，未许可不得提交生成；锁稿不得改写但可审查", () => {
  const f = fixture();
  const id = f.create("episode", { text: "正文" });
  assert.throws(() => f.input(f.generation(id)), /尚未确认/);
  const inputId = f.input();
  const p = f.production();
  assert.throws(
    () =>
      f.run(
        {
          action: "update-production",
          productionId: p.id,
          expectedRevision: p.revision,
          title: p.title,
          brief: { ...p.brief, modelProcessingAllowed: true },
          reviewerPrincipalIds: p.reviewerPrincipalIds,
          template: p.template,
        },
        agent,
        inputId,
      ),
    /人工/,
  );
  f.metadata({ modelProcessingAllowed: true });
  f.approve(id, true);
  assert.throws(() => f.input(f.generation(id)), /已锁稿/);
  assert.ok(f.input(f.generation(id, [], { purpose: "continuity" })));
  assert.throws(() => f.revise(id, { text: "覆盖锁稿" }), /已锁稿/);
});

test("普通 Agent 新建仅限空条目，模型许可不能绕过候选采纳", () => {
  for (const modelProcessingAllowed of [false, true]) {
    const f = fixture();
    f.metadata({ modelProcessingAllowed });
    const parentId = f.create("episode", { text: "人工分集" });
    const characterId = f.create("character", { text: "人工角色" });
    const inputId = f.input();
    const create = (kind: "episode" | "scene", draft: ScriptDraft) =>
      f.run(
        { action: "create-item", productionId: f.productionId, kind, draft },
        agent,
        inputId,
      );
    const empty = emptyScriptDraft("TEST 空条目", 3);
    const id = create("episode", empty);
    assert.deepEqual(currentScriptDraft(f.item(id)), empty);
    const scene = {
      ...emptyScriptDraft("TEST 空分场"),
      parentId,
      dependencies: [{ itemId: parentId, revision: f.item(parentId).revision }],
    };
    assert.deepEqual(currentScriptDraft(f.item(create("scene", scene))), scene);
    const attempts: Partial<ScriptDraft>[] = [
      { text: "不能直接进入正式稿" },
      { basis: "adaptation" },
      {
        sources: [
          { artifactId: "unapproved-source", revision: 1, quote: "原文" },
        ],
      },
      { dependencies: [{ itemId: characterId, revision: 1 }] },
      { location: "天台" },
      { storyTime: "天亮前" },
      { characters: [characterId] },
      { audienceKnowledge: "观众提前知道真相" },
      { characterKnowledge: "角色掌握秘密" },
      { setupPayoff: "伏笔" },
      { productionNotes: "制作要求" },
    ];
    for (const changes of attempts) {
      const before = structuredClone(f.state);
      assert.throws(
        () => create("episode", { ...empty, ...changes }),
        /只能建立空条目/,
      );
      assert.deepEqual(f.state, before);
    }
    assert.throws(
      () =>
        create("scene", {
          ...scene,
          dependencies: [
            ...scene.dependencies,
            { itemId: characterId, revision: 1 },
          ],
        }),
      /只能建立空条目/,
    );
    f.revise(parentId, { text: "人工新版本" });
    assert.throws(() => create("scene", scene), /只能建立空条目/);
  }
});

test("AI候选必须绑定真实输入；跨tool-call相同候选去重，只有人工采纳才形成正文", () => {
  const f = fixture();
  const id = f.create("episode", { text: "人工原稿" });
  f.metadata({ modelProcessingAllowed: true });
  const inputId = f.input(f.generation(id));
  const draft = { ...currentScriptDraft(f.item(id)), text: "合成候选" };
  assert.throws(() => f.candidate(f.input(), draft), /真实生成输入/);
  assert.throws(
    () =>
      f.run({
        action: "submit-candidate",
        productionId: f.productionId,
        draft,
        explanation: "冒充",
      }),
    /真实生成输入/,
  );
  const candidateId = f.candidate(inputId, draft);
  assert.equal(f.candidate(inputId, draft), candidateId);
  assert.equal(f.production().candidates.length, 1);
  assert.equal(currentScriptDraft(f.item(id)).text, "人工原稿");
  assert.throws(
    () =>
      f.run(
        {
          action: "decide-candidate",
          productionId: f.productionId,
          candidateId,
          expectedRevision: 1,
          decision: "accept",
        },
        agent,
        inputId,
      ),
    /不能改写正式稿/,
  );
  f.run({
    action: "decide-candidate",
    productionId: f.productionId,
    candidateId,
    expectedRevision: 1,
    decision: "accept",
  });
  assert.equal(currentScriptDraft(f.item(id)).text, "合成候选");
  assert.equal(f.item(id).versions[1]!.candidateId, candidateId);
  assert.equal(f.item(id).status, "draft");
  assert.equal(f.production().candidates[0]!.status, "accepted");
  assert.throws(
    () =>
      f.run({
        action: "decide-candidate",
        productionId: f.productionId,
        candidateId,
        expectedRevision: 1,
        decision: "reject",
      }),
    /已有新版本/,
  );
});

test("生成期间人工改稿、设定改版与上下文变化使候选过期，不覆盖新版本", () => {
  for (const change of ["manual", "upstream", "metadata"] as const) {
    const f = fixture();
    const upstream = f.create("setting", { text: "设定v1" });
    const id = f.create("episode", {
      text: "人工原稿",
      dependencies: [{ itemId: upstream, revision: 1 }],
    });
    f.metadata({ modelProcessingAllowed: true });
    const inputId = f.input(
      f.generation(id, [{ itemId: upstream, revision: 1 }]),
    );
    const draft = { ...currentScriptDraft(f.item(id)), text: "旧基础候选" };
    if (change === "manual") f.revise(id, { text: "生成期间人工新稿" });
    if (change === "upstream") f.revise(upstream, { text: "设定v2" });
    if (change === "metadata") f.metadata({ style: "新制作要求" });
    const candidateId = f.candidate(inputId, draft);
    assert.equal(
      scriptCandidateStale(f.production(), f.production().candidates[0]!),
      true,
    );
    assert.throws(
      () =>
        f.run({
          action: "decide-candidate",
          productionId: f.productionId,
          candidateId,
          expectedRevision: 1,
          decision: "accept",
        }),
      /过期/,
    );
    assert.notEqual(currentScriptDraft(f.item(id)).text, "旧基础候选");
    f.run({
      action: "decide-candidate",
      productionId: f.productionId,
      candidateId,
      expectedRevision: 1,
      decision: "reject",
    });
    assert.equal(f.production().candidates[0]!.status, "rejected");
  }
});

test("可执行字数/候选/材料预算与目的边界，不把自审轮次当费用上限", () => {
  const f = fixture();
  const id = f.create("episode", { text: "基础稿" });
  f.metadata({ modelProcessingAllowed: true });
  const request = f.generation(id, [], {
    maxCandidates: 1,
    maxOutputCharacters: 800,
  });
  const inputId = f.input(request);
  assert.throws(
    () =>
      f.candidate(inputId, {
        ...currentScriptDraft(f.item(id)),
        text: "x".repeat(801),
      }),
    /输出预算/,
  );
  f.candidate(inputId, { ...currentScriptDraft(f.item(id)), text: "候选A" });
  assert.throws(
    () =>
      f.candidate(inputId, {
        ...currentScriptDraft(f.item(id)),
        text: "候选B",
      }),
    /候选数量/,
  );
  const reviewInput = f.input(f.generation(id, [], { purpose: "impact" }));
  assert.throws(
    () => f.candidate(reviewInput, currentScriptDraft(f.item(id))),
    /审查任务不能/,
  );
  assert.throws(() =>
    scriptGenerationSchema.parse({ ...request, maxCandidates: 4 }),
  );
  assert.throws(() =>
    scriptGenerationSchema.parse({ ...request, maxReviewPasses: 3 }),
  );
  const large = f.create("source", { text: "x".repeat(70_000) });
  const second = f.create("source", { text: "y".repeat(70_000) });
  assert.throws(
    () =>
      f.input(
        f.generation(id, [
          { itemId: large, revision: 1 },
          { itemId: second, revision: 1 },
        ]),
      ),
    /120000/,
  );
});

test("候选不能扩大固定材料、角色、原作引用范围", () => {
  const f = fixture();
  const id = f.create("episode", { text: "正文" });
  const unrelated = f.create("setting", { text: "未授权给本次生成" });
  f.metadata({ modelProcessingAllowed: true });
  const inputId = f.input(f.generation(id));
  assert.throws(
    () =>
      f.candidate(inputId, {
        ...currentScriptDraft(f.item(id)),
        dependencies: [{ itemId: unrelated, revision: 1 }],
      }),
    /范围外/,
  );
  const artifactId = f.execute({
    type: "create-artifact",
    projectId: "first-project",
    title: "未固定原作",
    content: { kind: "document", markdown: "这不是本次的材料" },
  });
  assert.throws(
    () =>
      f.candidate(inputId, {
        ...currentScriptDraft(f.item(id)),
        sources: [{ artifactId, revision: 1, quote: "这不是本次的材料" }],
      }),
    /不能超出/,
  );
});

test("跨集依赖修改传播清除审阅有效性，不改锁定正文；刷新依赖重审才能导出", () => {
  const f = fixture();
  const setting = f.create("setting", { text: "角色只能白天行动" });
  const episode1 = f.create("episode", {
    text: "第一集",
    order: 1,
    dependencies: [{ itemId: setting, revision: 1 }],
  });
  const episode2 = f.create("episode", {
    text: "第二集延续",
    order: 2,
    dependencies: [{ itemId: episode1, revision: 1 }],
  });
  const scene = f.create("scene", {
    text: "第二集第一场",
    parentId: episode2,
    dependencies: [{ itemId: episode2, revision: 1 }],
  });
  f.approve(setting);
  f.approve(episode1, true);
  f.approve(episode2, true);
  f.approve(scene, true);
  const exportItems = [episode1, episode2, scene].map((itemId) => ({
    itemId,
    revision: 1,
  }));
  const exportId = f.run({
    action: "record-export",
    productionId: f.productionId,
    expectedRevision: f.production().revision,
    items: exportItems,
    template: f.production().template,
  });
  assert.equal(f.production().exports[0]!.id, exportId);
  f.revise(setting, { text: "改为夜间行动" });
  assert.deepEqual(
    new Set(scriptImpact(f.production(), [setting])),
    new Set([episode1, episode2, scene]),
  );
  for (const id of [episode1, episode2, scene]) {
    assert.equal(f.item(id).status, "locked");
    assert.equal(f.item(id).approval, null);
    assert.equal(f.item(id).revision, 1);
  }
  assert.equal(currentScriptDraft(f.item(scene)).text, "第二集第一场");
  assert.ok(
    scriptIssues(f.production()).some(
      (i) => i.itemId === episode1 && i.code === "stale-dependency",
    ),
  );
  assert.throws(
    () =>
      f.run({
        action: "record-export",
        productionId: f.productionId,
        expectedRevision: f.production().revision,
        items: exportItems,
        template: f.production().template,
      }),
    /有效的锁定稿/,
  );
  assert.equal(f.production().exports.length, 1);
  f.approve(setting);
  for (const [id, dependency] of [
    [episode1, setting],
    [episode2, episode1],
    [scene, episode2],
  ]) {
    f.run({
      action: "unlock-item",
      productionId: f.productionId,
      itemId: id!,
      expectedRevision: f.item(id!).revision,
      expectedWorkflowRevision: f.item(id!).workflowRevision,
      reason: "上游变更返工",
    });
    f.revise(id!, {
      dependencies: [
        { itemId: dependency!, revision: f.item(dependency!).revision },
      ],
    });
    f.approve(id!, true);
  }
  assert.deepEqual(scriptIssues(f.production()), []);
  f.run({
    action: "record-export",
    productionId: f.productionId,
    expectedRevision: f.production().revision,
    items: [episode1, episode2, scene].map((itemId) => ({
      itemId,
      revision: f.item(itemId).revision,
    })),
    template: f.production().template,
  });
  assert.equal(f.production().exports.length, 2);
  assert.deepEqual(f.production().exports[0]!.items, exportItems);
});

test("旧稿迟到审阅只保留历史意见，不撤销新稿或下游的批准锁稿", () => {
  const f = fixture();
  f.metadata({ modelProcessingAllowed: true, rightsStatement: "合成授权" });
  const id = f.create("episode", { text: "旧稿中的问题" });
  const inputId = f.input(f.generation(id, [], { purpose: "continuity" }));
  f.revise(id, { text: "人工已经修正的新稿" });
  f.approve(id, true);
  const scene = f.create("scene", {
    text: "依赖新稿的分场",
    parentId: id,
    dependencies: [{ itemId: id, revision: 2 }],
  });
  f.approve(scene, true);
  const before = structuredClone(f.production().items);
  f.run(
    {
      action: "add-review",
      productionId: f.productionId,
      itemId: id,
      itemRevision: 1,
      quote: "旧稿中的问题",
      body: "来自旧稿的迟到意见",
      severity: "blocking",
    },
    agent,
    inputId,
  );
  assert.equal(f.production().reviews.length, 1);
  assert.equal(f.production().reviews[0]!.itemRevision, 1);
  assert.deepEqual(f.production().items, before);
  assert.deepEqual(scriptIssues(f.production()), []);
  f.run({
    action: "record-export",
    productionId: f.productionId,
    expectedRevision: f.production().revision,
    items: [
      { itemId: id, revision: 2 },
      { itemId: scene, revision: 1 },
    ],
    template: f.production().template,
  });
});

test("上下文或其他固定材料已变化的审阅不能撤销当前批准", () => {
  for (const change of ["context", "target"] as const) {
    const f = fixture();
    f.metadata({ modelProcessingAllowed: true, rightsStatement: "合成授权" });
    const ref = f.create("setting", { text: "保持同版的设定正文" });
    const target = f.create("episode", {
      text: "检查时的分集",
      dependencies: [{ itemId: ref, revision: 1 }],
    });
    const inputId = f.input(
      f.generation(target, [{ itemId: ref, revision: 1 }], {
        purpose: "continuity",
      }),
    );
    if (change === "context") f.metadata({ style: "人工重新确定的制作要求" });
    else f.revise(target, { text: "人工修订后的分集" });
    f.approve(ref, true);
    f.approve(target, true);
    const before = structuredClone(f.production().items);
    f.run(
      {
        action: "add-review",
        productionId: f.productionId,
        itemId: ref,
        itemRevision: 1,
        quote: "设定正文",
        body: "针对旧制作上下文的意见",
        severity: "blocking",
      },
      agent,
      inputId,
    );
    assert.equal(f.production().reviews[0]!.historicalOnly, true);
    assert.equal(f.production().reviews[0]!.contextRevision, 2);
    assert.deepEqual(f.production().items, before);
    assert.deepEqual(scriptIssues(f.production()), []);
  }
});

test("已经生效的阻断意见不能靠另存一版绕过，仍须人工解决", () => {
  const f = fixture();
  const id = f.create("episode", { text: "待解决的质量问题" });
  const reviewId = f.run({
    action: "add-review",
    productionId: f.productionId,
    itemId: id,
    itemRevision: 1,
    quote: "质量问题",
    body: "必须人工确认处理",
    severity: "blocking",
  });
  assert.equal(f.production().reviews[0]!.historicalOnly, false);
  f.revise(id, { text: "仅另存新稿并不代表解决" });
  assert.equal(
    scriptIssues(f.production()).filter((i) => i.code === "unresolved-review")
      .length,
    1,
  );
  assert.throws(() => f.approve(id), /阻断意见/);
  // The submit succeeded before the approval was rejected. Resolution keeps
  // this review open; retry the decision rather than submitting it twice.
  assert.equal(f.item(id).status, "in-review");
  assert.equal(f.item(id).approval, null);
  f.run({
    action: "resolve-review",
    productionId: f.productionId,
    reviewId,
    expectedRevision: 1,
    resolution: "人工核对修订后确认解决",
  });
  f.run({
    action: "review-decision",
    productionId: f.productionId,
    itemId: id,
    expectedRevision: f.item(id).revision,
    expectedWorkflowRevision: f.item(id).workflowRevision,
    decision: "approve",
    note: "阻断意见解决后继续本轮审阅",
  });
  f.run({
    action: "lock-item",
    productionId: f.productionId,
    itemId: id,
    expectedRevision: f.item(id).revision,
    expectedWorkflowRevision: f.item(id).workflowRevision,
  });
  assert.equal(f.item(id).status, "locked");
});

test("审阅锚定版本和原文、阻断意见与独立workflow CAS，Agent不得代批准", () => {
  const f = fixture();
  const id = f.create("episode", { text: "可锚定的正文" });
  const snapshot = f.item(id);
  f.run({
    action: "submit-review",
    productionId: f.productionId,
    itemId: id,
    expectedRevision: 1,
    expectedWorkflowRevision: snapshot.workflowRevision,
  });
  assert.throws(
    () =>
      f.run({
        action: "review-decision",
        productionId: f.productionId,
        itemId: id,
        expectedRevision: 1,
        expectedWorkflowRevision: snapshot.workflowRevision,
        decision: "approve",
        note: "迟到批准",
      }),
    /已有新版本/,
  );
  assert.throws(
    () =>
      f.run({
        action: "add-review",
        productionId: f.productionId,
        itemId: id,
        itemRevision: 1,
        quote: "不存在的原文",
        body: "意见",
        severity: "blocking",
      }),
    /原文/,
  );
  const reviewId = f.run({
    action: "add-review",
    productionId: f.productionId,
    itemId: id,
    itemRevision: 1,
    quote: "可锚定",
    body: "需要人工处理",
    severity: "blocking",
  });
  assert.equal(f.item(id).status, "draft");
  assert.throws(() => f.approve(id), /阻断意见/);
  f.run({
    action: "resolve-review",
    productionId: f.productionId,
    reviewId,
    expectedRevision: 1,
    resolution: "核对并记录处理",
  });
  f.run({
    action: "review-decision",
    productionId: f.productionId,
    itemId: id,
    expectedRevision: 1,
    expectedWorkflowRevision: f.item(id).workflowRevision,
    decision: "approve",
    note: "已解决",
  });
  const ordinaryInput = f.input();
  assert.throws(
    () =>
      f.run(
        {
          action: "lock-item",
          productionId: f.productionId,
          itemId: id,
          expectedRevision: 1,
          expectedWorkflowRevision: f.item(id).workflowRevision,
        },
        agent,
        ordinaryInput,
      ),
    /人工/,
  );
});

test("项目隔离、实时成员撤销与指定审阅人保护，非审阅成员不能批准", () => {
  const f = fixture();
  const id = f.create("episode", { text: "私有剧本" });
  const outsider: AccessContext = {
    principalId: "outsider",
    actantId: "outsider-human",
  };
  assert.deepEqual(workspaceFor(f.state, outsider).scriptProductions, []);
  assert.throws(
    () =>
      f.run(
        {
          action: "create-item",
          productionId: f.productionId,
          kind: "episode",
          draft: emptyScriptDraft("越权"),
        },
        outsider,
      ),
    /主体不匹配/,
  );
  const state = structuredClone(f.state);
  state.principals.push({ id: outsider.principalId, name: "合成编剧" });
  state.actants.push({
    id: outsider.actantId,
    principalId: outsider.principalId,
    kind: "human",
    name: "合成编剧",
  });
  state.projects
    .find((p) => p.id === "first-project")!
    .members.push(outsider.principalId);
  const inReview = applyCommand(
    state,
    commandSchema.parse({
      commandId: randomUUID(),
      operation: {
        type: "script-command",
        command: {
          action: "submit-review",
          productionId: f.productionId,
          itemId: id,
          expectedRevision: 1,
          expectedWorkflowRevision: 1,
        },
      },
    }),
    outsider,
  ).state;
  assert.throws(
    () =>
      applyCommand(
        inReview,
        commandSchema.parse({
          commandId: randomUUID(),
          operation: {
            type: "script-command",
            command: {
              action: "review-decision",
              productionId: f.productionId,
              itemId: id,
              expectedRevision: 1,
              expectedWorkflowRevision: 2,
              decision: "approve",
              note: "不能自授审批权",
            },
          },
        }),
        outsider,
      ),
    /指定审阅人/,
  );
  const other = f.execute({ type: "create-project", title: "合成其他项目" });
  f.metadata({ modelProcessingAllowed: true });
  assert.throws(
    () =>
      f.execute({
        type: "record-input",
        projectId: other,
        artifactId: null,
        artifactRevision: null,
        selection: "",
        body: "跨项目生成",
        targetActantId: agent.actantId,
        scriptGeneration: f.generation(id),
      }),
    /跨项目/,
  );
});

test("导出只接受当前有效锁稿与确切模板，分场不能脱离父集", () => {
  const f = fixture();
  const episode = f.create("episode", { text: "分集正文" });
  const scene = f.create("scene", {
    text: "分场正文",
    parentId: episode,
    dependencies: [{ itemId: episode, revision: 1 }],
  });
  const exportCommand = {
    action: "record-export" as const,
    productionId: f.productionId,
    expectedRevision: f.production().revision,
    items: [{ itemId: episode, revision: 1 }],
    template: f.production().template,
  };
  assert.throws(() => f.run(exportCommand), /锁定稿/);
  f.approve(episode, true);
  f.approve(scene, true);
  assert.throws(
    () => f.run({ ...exportCommand, items: [{ itemId: scene, revision: 1 }] }),
    /所属集/,
  );
  assert.throws(
    () =>
      f.run({
        ...exportCommand,
        items: [
          { itemId: episode, revision: 1 },
          { itemId: episode, revision: 1 },
        ],
      }),
    /不能重复/,
  );
  assert.throws(
    () =>
      f.run({
        ...exportCommand,
        template: { ...exportCommand.template, fontSize: 18 },
      }),
    /确切模板/,
  );
  assert.throws(
    () =>
      f.run({ ...exportCommand, items: [{ itemId: episode, revision: 999 }] }),
    /已有新版本/,
  );
  f.run(exportCommand);
  assert.equal(f.production().exports.length, 1);
});
