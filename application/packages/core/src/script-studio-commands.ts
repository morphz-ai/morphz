import {
  checkProject,
  DomainError,
  getArtifact,
  quotedText,
  type AccessContext,
  type Workspace,
} from "./model.js";
import { assertProjectWritable } from "./projects.js";
import {
  currentScriptDraft,
  defaultScriptExportTemplate,
  emptyScriptBrief,
  emptyScriptDraft,
  scriptCandidateStale,
  scriptImpact,
  scriptIssues,
  type ScriptCommand,
  type ScriptDraft,
  type ScriptGeneration,
  type ScriptItem,
  type ScriptProduction,
} from "./script-studio.js";

export function getScriptProduction(
  state: Workspace,
  productionId: string,
  access: AccessContext,
) {
  const production = state.scriptProductions.find((p) => p.id === productionId);
  if (!production) throw new DomainError("not_found", "剧本项目不存在。");
  checkProject(state, production.projectId, access);
  return production;
}
export function getScriptItem(production: ScriptProduction, itemId: string) {
  const item = production.items.find((i) => i.id === itemId);
  if (!item) throw new DomainError("not_found", "剧本条目不存在。");
  return item;
}
function requireVersion(actual: number, expected: number) {
  if (actual !== expected)
    throw new DomainError("conflict", "内容已有新版本，请保留草稿并重新核对。");
}
function requireEditable(item: ScriptItem) {
  if (item.status === "locked")
    throw new DomainError(
      "forbidden",
      "已锁稿；必须由审阅人说明原因并解锁，不能直接覆盖。",
    );
}
function requireHuman(state: Workspace, access: AccessContext) {
  if (
    !state.actants.some(
      (a) =>
        a.id === access.actantId &&
        a.principalId === access.principalId &&
        a.kind === "human",
    )
  )
    throw new DomainError("forbidden", "此操作必须由人工决定。");
}
function requireReviewer(
  state: Workspace,
  production: ScriptProduction,
  access: AccessContext,
) {
  requireHuman(state, access);
  if (!production.reviewerPrincipalIds.includes(access.principalId))
    throw new DomainError("forbidden", "只有指定审阅人可以批准、锁稿或解锁。");
}
function assertUnique(ids: string[], label: string) {
  if (new Set(ids).size !== ids.length)
    throw new DomainError("invalid", `${label}不能重复。`);
}

export function validateScriptDraft(
  state: Workspace,
  production: ScriptProduction,
  kind: ScriptItem["kind"],
  draft: ScriptDraft,
  itemId?: string,
) {
  assertUnique(
    draft.dependencies.map((r) => r.itemId),
    "依赖",
  );
  assertUnique(draft.characters, "出场角色");
  if (kind === "scene") {
    if (
      !draft.parentId ||
      getScriptItem(production, draft.parentId).kind !== "episode"
    )
      throw new DomainError("invalid", "分场必须属于本剧的一集。");
  } else if (draft.parentId !== null)
    throw new DomainError("invalid", "只有分场可以设置所属集。");
  for (const ref of draft.sources) {
    const source = getArtifact(state, ref.artifactId);
    const version = source.versions.find((v) => v.revision === ref.revision);
    if (
      source.projectId !== production.projectId ||
      (version?.projectId && version.projectId !== production.projectId) ||
      !version ||
      (ref.quote && !quotedText(version.content).includes(ref.quote))
    )
      throw new DomainError(
        "invalid",
        "原作引用必须指向本项目中可验证的原文版本。",
      );
  }
  for (const ref of draft.dependencies) {
    const dependency = getScriptItem(production, ref.itemId);
    if (
      dependency.id === itemId ||
      !dependency.versions.some((v) => v.revision === ref.revision)
    )
      throw new DomainError(
        "invalid",
        "剧本依赖必须是有效版本，不能引用自身。",
      );
    if (itemId && scriptImpact(production, [itemId]).includes(ref.itemId))
      throw new DomainError("invalid", "剧本依赖不能形成循环。");
  }
  for (const characterId of draft.characters) {
    if (getScriptItem(production, characterId).kind !== "character")
      throw new DomainError("invalid", "出场人物必须引用角色条目。");
  }
  for (const required of [
    ...draft.characters,
    ...(draft.parentId ? [draft.parentId] : []),
  ]) {
    if (!draft.dependencies.some((r) => r.itemId === required))
      throw new DomainError("invalid", "角色和所属集必须同时绑定依赖版本。");
  }
}

export function validateScriptGeneration(
  state: Workspace,
  generation: ScriptGeneration,
  projectId: string,
  access: AccessContext,
) {
  const production = getScriptProduction(
    state,
    generation.productionId,
    access,
  );
  assertProjectWritable(checkProject(state, projectId, access));
  if (production.projectId !== projectId)
    throw new DomainError("forbidden", "不能跨项目生成剧本。");
  requireHuman(state, access);
  if (!production.brief.modelProcessingAllowed)
    throw new DomainError("forbidden", "尚未确认这些资料可交给模型处理。");
  requireVersion(production.revision, generation.contextRevision);
  const target = getScriptItem(production, generation.targetId);
  requireVersion(target.revision, generation.baseRevision);
  assertUnique(
    generation.references.map((r) => r.itemId),
    "生成引用",
  );
  for (const ref of generation.references)
    requireVersion(
      getScriptItem(production, ref.itemId).revision,
      ref.revision,
    );
  const pinned = new Map(
    generation.references.map((r) => [r.itemId, r.revision]),
  );
  const visited = new Set<string>();
  const verifyDependencies = (item: ScriptItem) => {
    if (visited.has(item.id)) return;
    visited.add(item.id);
    for (const ref of currentScriptDraft(item).dependencies) {
      if (
        pinned.get(ref.itemId) !== ref.revision ||
        getScriptItem(production, ref.itemId).revision !== ref.revision
      )
        throw new DomainError(
          "conflict",
          "生成材料必须包含全部依赖的当前版本；请先处理上游变更。",
        );
      verifyDependencies(getScriptItem(production, ref.itemId));
    }
  };
  verifyDependencies(target);
  for (const ref of generation.references)
    verifyDependencies(getScriptItem(production, ref.itemId));
  if (["draft", "rewrite"].includes(generation.purpose))
    requireEditable(target);
  const materials = [
    currentScriptDraft(target),
    ...generation.references.map((r) =>
      currentScriptDraft(getScriptItem(production, r.itemId)),
    ),
  ];
  if (JSON.stringify({ brief: production.brief, materials }).length > 120_000)
    throw new DomainError(
      "invalid",
      "本次剧本材料超过 120000 字符，请缩小生成范围。",
    );
  for (const draft of materials)
    validateScriptDraftSources(state, production, draft);
}

function validateScriptDraftSources(
  state: Workspace,
  production: ScriptProduction,
  draft: ScriptDraft,
) {
  for (const ref of draft.sources) {
    const source = getArtifact(state, ref.artifactId);
    const version = source.versions.find((v) => v.revision === ref.revision);
    if (
      source.projectId !== production.projectId ||
      (version?.projectId && version.projectId !== production.projectId) ||
      !version ||
      (ref.quote && !quotedText(version.content).includes(ref.quote))
    )
      throw new DomainError(
        "forbidden",
        "引用的原作版本已不可用或不属于当前项目。",
      );
  }
}

/** Recheck live actor and initiating Human memberships, including durable receipt replay. */
export function assertScriptAccess(
  state: Workspace,
  command: ScriptCommand,
  access: AccessContext,
  originInputId?: string,
) {
  const actor = state.actants.find(
    (a) => a.id === access.actantId && a.principalId === access.principalId,
  );
  if (!actor) throw new DomainError("forbidden", "参与者与主体不匹配。");
  const input = originInputId
    ? state.inputs.find(
        (i) => i.id === originInputId && i.targetActantId === actor.id,
      )
    : undefined;
  const projectId =
    command.action === "create-production"
      ? command.projectId
      : getScriptProduction(state, command.productionId, access).projectId;
  checkProject(state, projectId, access);
  if (actor.kind === "agent") {
    if (!input || input.projectId !== projectId)
      throw new DomainError("forbidden", "剧本操作必须绑定真实输入的项目。");
    checkProject(state, projectId, input.author);
    requireHuman(state, input.author);
  }
  return { actor, input, projectId };
}

function appendEvent(
  item: ScriptItem,
  action: ScriptItem["events"][number]["action"],
  access: AccessContext,
  now: string,
  note = "",
) {
  item.workflowRevision++;
  item.events.push({
    action,
    revision: item.revision,
    author: { ...access },
    createdAt: now,
    note,
  });
}
function invalidate(
  production: ScriptProduction,
  ids: string[],
  access: AccessContext,
  now: string,
  note: string,
) {
  for (const item of production.items.filter((i) => ids.includes(i.id))) {
    // Locked text is immutable. Invalidating its approval requires an explicit unlock/re-review.
    if (item.status !== "locked") item.status = "draft";
    item.approval = null;
    appendEvent(item, "invalidate", access, now, note);
  }
}
function reviseItem(
  production: ScriptProduction,
  item: ScriptItem,
  draft: ScriptDraft,
  access: AccessContext,
  now: string,
  candidateId: string | null,
) {
  requireEditable(item);
  item.revision++;
  item.versions.push({
    revision: item.revision,
    draft: structuredClone(draft),
    author: { ...access },
    createdAt: now,
    candidateId,
  });
  item.approval = null;
  item.status = "draft";
  appendEvent(item, "revise", access, now);
  invalidate(
    production,
    scriptImpact(production, [item.id]),
    access,
    now,
    `上游 ${item.id} 更新至 v${item.revision}`,
  );
}
function assertApprovable(production: ScriptProduction, item: ScriptItem) {
  if (!currentScriptDraft(item).text.trim())
    throw new DomainError("invalid", "正文为空，不能批准或锁稿。");
  const issues = scriptIssues(production).filter((i) => i.itemId === item.id);
  if (issues.length)
    throw new DomainError("conflict", issues.map((i) => i.message).join("；"));
  for (const ref of currentScriptDraft(item).dependencies) {
    const upstream = getScriptItem(production, ref.itemId);
    if (
      !upstream.approval ||
      upstream.approval.revision !== ref.revision ||
      upstream.approval.contextRevision !== production.revision
    )
      throw new DomainError("conflict", "依赖的上游尚未批准或需要重新审阅。");
  }
}

/** Called inside the same WorkspaceStore transaction as the durable command receipt. */
export function applyScriptCommand(
  state: Workspace,
  command: ScriptCommand,
  access: AccessContext,
  commandId: string,
  now: string,
  originInputId?: string,
): string {
  const { actor, input, projectId } = assertScriptAccess(
    state,
    command,
    access,
    originInputId,
  );
  const project = checkProject(state, projectId, access);
  assertProjectWritable(project);
  if (actor.kind === "agent") {
    if (!input || input.projectId !== projectId)
      throw new DomainError("forbidden", "剧本操作必须绑定真实输入的项目。");
    checkProject(state, projectId, input.author);
    if (
      input.scriptGeneration &&
      !["submit-candidate", "add-review"].includes(command.action)
    )
      throw new DomainError(
        "forbidden",
        "本次生成只允许提交候选稿或审查意见，不能改写正式稿。",
      );
    if (
      ![
        "create-production",
        "create-item",
        "submit-candidate",
        "add-review",
      ].includes(command.action)
    )
      throw new DomainError(
        "forbidden",
        "Agent 只能提出候选和意见，采纳、改稿及审阅决定由人工操作。",
      );
  }
  if (command.action === "create-production") {
    const owner = actor.kind === "human" ? access : input!.author;
    requireHuman(state, owner);
    const production: ScriptProduction = {
      id: commandId,
      projectId,
      title: command.title,
      revision: 1,
      brief: structuredClone(emptyScriptBrief),
      reviewerPrincipalIds: [owner.principalId],
      createdBy: { ...access },
      createdAt: now,
      updatedAt: now,
      items: [],
      candidates: [],
      reviews: [],
      exports: [],
      template: structuredClone(defaultScriptExportTemplate),
      metadataHistory: [],
    };
    production.metadataHistory.push({
      revision: 1,
      title: production.title,
      brief: structuredClone(production.brief),
      reviewerPrincipalIds: [...production.reviewerPrincipalIds],
      template: structuredClone(production.template),
      author: { ...access },
      createdAt: now,
    });
    state.scriptProductions.push(production);
    return production.id;
  }
  const production = getScriptProduction(state, command.productionId, access);
  let entityId = production.id;
  if (command.action === "update-production") {
    requireReviewer(state, production, access);
    requireVersion(production.revision, command.expectedRevision);
    assertUnique(command.reviewerPrincipalIds, "审阅人");
    if (
      command.reviewerPrincipalIds.some(
        (id) =>
          !project.members.includes(id) ||
          !state.actants.some(
            (a) => a.principalId === id && a.kind === "human",
          ),
      )
    )
      throw new DomainError("invalid", "审阅人必须是本项目的人工成员。");
    production.revision++;
    production.title = command.title;
    production.brief = structuredClone(command.brief);
    production.reviewerPrincipalIds = [...command.reviewerPrincipalIds];
    production.template = structuredClone(command.template);
    production.metadataHistory.push({
      revision: production.revision,
      title: production.title,
      brief: structuredClone(production.brief),
      reviewerPrincipalIds: [...production.reviewerPrincipalIds],
      template: structuredClone(production.template),
      author: { ...access },
      createdAt: now,
    });
    invalidate(
      production,
      production.items.map((i) => i.id),
      access,
      now,
      "创作要求或制作配置已更新",
    );
  } else if (command.action === "create-item") {
    if (production.items.length >= 5000)
      throw new DomainError("invalid", "本剧条目已达上限。");
    if (actor.kind === "agent") {
      // Processing consent is not permission to author a formal version. An
      // ordinary request may scaffold an empty item, never bypass candidate
      // adoption by putting story facts in text or another authored field.
      const empty = emptyScriptDraft(command.draft.title, command.draft.order);
      if (command.kind === "scene" && command.draft.parentId) {
        const parent = getScriptItem(production, command.draft.parentId);
        empty.parentId = parent.id;
        empty.dependencies = [{ itemId: parent.id, revision: parent.revision }];
      }
      if (
        (Object.keys(empty) as (keyof ScriptDraft)[]).some(
          (key) =>
            JSON.stringify(command.draft[key]) !== JSON.stringify(empty[key]),
        )
      )
        throw new DomainError(
          "forbidden",
          "Agent 只能建立空条目；正文与创作字段必须通过固定版本候选及人工采纳。",
        );
    }
    validateScriptDraft(state, production, command.kind, command.draft);
    production.items.push({
      id: commandId,
      kind: command.kind,
      revision: 1,
      workflowRevision: 1,
      status: "draft",
      approval: null,
      events: [],
      versions: [
        {
          revision: 1,
          draft: structuredClone(command.draft),
          author: { ...access },
          createdAt: now,
          candidateId: null,
        },
      ],
    });
    entityId = commandId;
  } else if (command.action === "submit-candidate") {
    const generation = input?.scriptGeneration;
    if (
      actor.kind !== "agent" ||
      !input ||
      !generation ||
      generation.productionId !== production.id
    )
      throw new DomainError(
        "forbidden",
        "候选稿必须来自已绑定版本的真实生成输入。",
      );
    if (!["draft", "rewrite"].includes(generation.purpose))
      throw new DomainError("forbidden", "审查任务不能提交正文候选。");
    if (!production.brief.modelProcessingAllowed)
      throw new DomainError("forbidden", "模型处理许可已撤销。");
    const duplicate = production.candidates.find(
      (c) =>
        c.inputId === input.id &&
        JSON.stringify(c.draft) === JSON.stringify(command.draft),
    );
    if (duplicate) return duplicate.id;
    if (
      production.candidates.filter((c) => c.inputId === input.id).length >=
      generation.maxCandidates
    )
      throw new DomainError("invalid", "本次候选数量已达预算上限。");
    if (JSON.stringify(command.draft).length > generation.maxOutputCharacters)
      throw new DomainError("invalid", "候选内容超过本次输出预算。");
    const target = getScriptItem(production, generation.targetId);
    validateScriptDraft(
      state,
      production,
      target.kind,
      command.draft,
      target.id,
    );
    const allowed = new Map(
      generation.references.map((r) => [r.itemId, r.revision]),
    );
    for (const ref of command.draft.dependencies)
      if (allowed.get(ref.itemId) !== ref.revision)
        throw new DomainError(
          "forbidden",
          "候选稿不能引用本次生成范围外的条目版本。",
        );
    const pinnedDrafts = [
      { itemId: generation.targetId, revision: generation.baseRevision },
      ...generation.references,
    ].map(
      (r) =>
        getScriptItem(production, r.itemId).versions.find(
          (v) => v.revision === r.revision,
        )!.draft,
    );
    for (const source of command.draft.sources)
      if (
        !pinnedDrafts.some((d) =>
          d.sources.some(
            (s) =>
              s.artifactId === source.artifactId &&
              s.revision === source.revision &&
              s.quote.includes(source.quote),
          ),
        )
      )
        throw new DomainError(
          "forbidden",
          "候选的原作引用不能超出本次固定材料。",
        );
    production.candidates.push({
      id: commandId,
      inputId: input.id,
      targetId: generation.targetId,
      baseRevision: generation.baseRevision,
      contextRevision: generation.contextRevision,
      references: structuredClone(generation.references),
      draft: structuredClone(command.draft),
      explanation: command.explanation,
      createdBy: { ...access },
      createdAt: now,
      revision: 1,
      status: "pending",
      decisionBy: null,
      decidedAt: null,
    });
    entityId = commandId;
  } else if (command.action === "decide-candidate") {
    requireHuman(state, access);
    const candidate = production.candidates.find(
      (c) => c.id === command.candidateId,
    );
    if (!candidate) throw new DomainError("not_found", "候选稿不存在。");
    requireVersion(candidate.revision, command.expectedRevision);
    if (candidate.status !== "pending")
      throw new DomainError("conflict", "候选稿已有决定。");
    if (command.decision === "accept") {
      if (scriptCandidateStale(production, candidate))
        throw new DomainError(
          "conflict",
          "候选稿已过期；请对照新版本重新生成，不能覆盖。",
        );
      const item = getScriptItem(production, candidate.targetId);
      validateScriptDraft(
        state,
        production,
        item.kind,
        candidate.draft,
        item.id,
      );
      reviseItem(production, item, candidate.draft, access, now, candidate.id);
    }
    candidate.revision++;
    candidate.status = command.decision === "accept" ? "accepted" : "rejected";
    candidate.decisionBy = { ...access };
    candidate.decidedAt = now;
    entityId = candidate.id;
  } else if (command.action === "add-review") {
    const item = getScriptItem(production, command.itemId);
    const version = item.versions.find(
      (v) => v.revision === command.itemRevision,
    );
    if (
      !version ||
      (command.quote && !version.draft.text.includes(command.quote))
    )
      throw new DomainError("invalid", "意见必须锚定有效正文版本及原文。");
    if (actor.kind === "agent") {
      const generation = input?.scriptGeneration;
      if (
        !generation ||
        generation.productionId !== production.id ||
        ![
          { itemId: generation.targetId, revision: generation.baseRevision },
          ...generation.references,
        ].some(
          (r) =>
            r.itemId === command.itemId && r.revision === command.itemRevision,
        )
      )
        throw new DomainError(
          "forbidden",
          "审查意见必须属于本次输入绑定的版本。",
        );
      if (!production.brief.modelProcessingAllowed)
        throw new DomainError("forbidden", "模型处理许可已撤销。");
      if (
        production.reviews.filter((r) => r.inputId === input!.id).length >= 100
      )
        throw new DomainError("invalid", "本次审查意见已达上限。");
    }
    const duplicateReview = production.reviews.find(
      (r) =>
        r.inputId === input?.id &&
        r.itemId === command.itemId &&
        r.itemRevision === command.itemRevision &&
        r.quote === command.quote &&
        r.body === command.body &&
        r.severity === command.severity,
    );
    if (actor.kind === "agent" && duplicateReview) return duplicateReview.id;
    const generation =
      actor.kind === "agent" ? input?.scriptGeneration : undefined;
    const historicalOnly =
      item.revision !== command.itemRevision ||
      !!(
        generation &&
        (production.revision !== generation.contextRevision ||
          [
            { itemId: generation.targetId, revision: generation.baseRevision },
            ...generation.references,
          ].some(
            (ref) =>
              getScriptItem(production, ref.itemId).revision !== ref.revision,
          ))
      );
    production.reviews.push({
      id: commandId,
      itemId: item.id,
      itemRevision: command.itemRevision,
      quote: command.quote,
      body: command.body,
      severity: command.severity,
      author: { ...access },
      createdAt: now,
      inputId: input?.id ?? null,
      contextRevision: generation?.contextRevision ?? production.revision,
      historicalOnly,
      revision: 1,
      resolvedBy: null,
      resolvedAt: null,
      resolution: "",
    });
    if (command.severity === "blocking" && !historicalOnly)
      invalidate(
        production,
        [item.id, ...scriptImpact(production, [item.id])],
        access,
        now,
        "新增阻断审阅意见",
      );
    entityId = commandId;
  } else if (command.action === "resolve-review") {
    requireHuman(state, access);
    const review = production.reviews.find((r) => r.id === command.reviewId);
    if (!review) throw new DomainError("not_found", "审阅意见不存在。");
    requireVersion(review.revision, command.expectedRevision);
    if (review.resolvedAt) throw new DomainError("conflict", "意见已经处理。");
    review.revision++;
    review.resolvedBy = { ...access };
    review.resolvedAt = now;
    review.resolution = command.resolution;
    entityId = review.id;
  } else if (command.action === "record-export") {
    requireHuman(state, access);
    requireVersion(production.revision, command.expectedRevision);
    assertUnique(
      command.items.map((r) => r.itemId),
      "导出条目",
    );
    if (
      JSON.stringify(command.template) !== JSON.stringify(production.template)
    )
      throw new DomainError(
        "conflict",
        "导出必须使用当前制作配置的确切模板；请先保存模板。",
      );
    const exported = new Set(command.items.map((r) => r.itemId));
    for (const ref of command.items) {
      const item = getScriptItem(production, ref.itemId);
      if (!["episode", "scene"].includes(item.kind))
        throw new DomainError("invalid", "正式剧本只导出分集与分场。");
      if (
        item.kind === "scene" &&
        !exported.has(currentScriptDraft(item).parentId!)
      )
        throw new DomainError("invalid", "导出分场时必须包含其所属集。");
    }
    for (const ref of command.items) {
      const item = getScriptItem(production, ref.itemId);
      requireVersion(item.revision, ref.revision);
      if (
        item.status !== "locked" ||
        !item.approval ||
        item.approval.contextRevision !== production.revision
      )
        throw new DomainError("conflict", "正式交付只能导出审阅有效的锁定稿。");
      assertApprovable(production, item);
    }
    production.exports.push({
      id: commandId,
      createdBy: { ...access },
      createdAt: now,
      contextRevision: production.revision,
      items: structuredClone(command.items),
      template: structuredClone(command.template),
      format: "docx",
    });
    entityId = commandId;
  } else {
    const item = getScriptItem(production, command.itemId);
    requireVersion(item.revision, command.expectedRevision);
    if ("expectedWorkflowRevision" in command)
      requireVersion(item.workflowRevision, command.expectedWorkflowRevision);
    entityId = item.id;
    if (command.action === "revise-item" || command.action === "restore-item") {
      requireHuman(state, access);
      const draft =
        command.action === "revise-item"
          ? command.draft
          : item.versions.find((v) => v.revision === command.restoreRevision)
              ?.draft;
      if (!draft) throw new DomainError("not_found", "历史版本不存在。");
      validateScriptDraft(state, production, item.kind, draft, item.id);
      reviseItem(production, item, draft, access, now, null);
    } else if (command.action === "submit-review") {
      requireHuman(state, access);
      requireEditable(item);
      if (item.status !== "draft")
        throw new DomainError("conflict", "只有草稿可以提交审阅。");
      if (!currentScriptDraft(item).text.trim())
        throw new DomainError("invalid", "请先填写正文。");
      item.status = "in-review";
      appendEvent(item, "submit", access, now);
    } else if (command.action === "review-decision") {
      requireReviewer(state, production, access);
      if (item.status !== "in-review")
        throw new DomainError("conflict", "文稿当前不在审阅中。");
      if (command.decision === "approve") {
        assertApprovable(production, item);
        item.status = "approved";
        item.approval = {
          revision: item.revision,
          author: { ...access },
          createdAt: now,
          note: command.note,
          contextRevision: production.revision,
        };
      } else {
        item.status = "draft";
        item.approval = null;
      }
      appendEvent(item, command.decision, access, now, command.note);
    } else if (command.action === "lock-item") {
      requireReviewer(state, production, access);
      if (
        item.status !== "approved" ||
        item.approval?.revision !== item.revision ||
        item.approval.contextRevision !== production.revision
      )
        throw new DomainError("conflict", "只能锁定已批准的当前版本。");
      assertApprovable(production, item);
      item.status = "locked";
      appendEvent(item, "lock", access, now);
    } else if (command.action === "unlock-item") {
      requireReviewer(state, production, access);
      if (item.status !== "locked")
        throw new DomainError("conflict", "文稿尚未锁定。");
      item.status = "draft";
      item.approval = null;
      appendEvent(item, "unlock", access, now, command.reason);
      invalidate(
        production,
        scriptImpact(production, [item.id]),
        access,
        now,
        `上游 ${item.id} 已解锁`,
      );
    }
  }
  production.updatedAt = now;
  return entityId;
}
