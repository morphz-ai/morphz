import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultScriptExportTemplate,
  emptyScriptBrief,
  emptyScriptDraft,
} from "../packages/core/src/script-studio.js";
import { ScriptStudioStore } from "../packages/script-studio/src/store.js";

const human = { principalId: "alice", actantId: "alice" };
const agent = { principalId: "alice", actantId: "agent-one" };

const authority = {
  async verifyReviewers({
    projectId,
    principalIds,
  }: {
    credential: string;
    projectId: string;
    principalIds: string[];
  }) {
    return (
      projectId === "project-one" && principalIds.every((id) => id === "alice")
    );
  },
  async authorizeCreate({
    credential,
    projectId,
  }: {
    credential: string;
    projectId: string;
  }) {
    if (projectId !== "project-one") return null;
    if (credential === "alice")
      return {
        tenantId: "tenant-one",
        ...human,
        kind: "human" as const,
        runtimeInputId: null,
      };
    if (credential === "agent")
      return {
        tenantId: "tenant-one",
        ...agent,
        kind: "agent" as const,
        runtimeInputId: "input-one",
      };
    return null;
  },
  async authorizeObject({
    credential,
    productionId,
  }: {
    credential: string;
    productionId: string;
    operation: "read" | "write";
  }) {
    const actor = await this.authorizeCreate({
      credential,
      projectId: "project-one",
    });
    return productionId === "production-one" && actor
      ? { ...actor, projectId: "project-one", objectKind: "script" }
      : null;
  },
  async authorizeProjectRead(request: {
    credential: string;
    projectId: string;
  }) {
    // This storage fixture has one project and the same eligible readers and
    // creators. Real Platform dialogue/project boundaries have Host tests.
    return this.authorizeCreate(request);
  },
};

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend} 零问题检查报告按领域提交，丢目录回执重开可恢复且不伪造审批`,
    { skip: backend === "postgres" && !process.env.MORPHZ_TEST_POSTGRES_URL },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "morphz-script-report-"));
      const filename = join(directory, "script.sqlite");
      const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL;
      const schema = `script_report_${randomUUID().replaceAll("-", "")}`;
      const admin =
        backend === "postgres" ? new Pool({ connectionString }) : null;
      const open = () =>
        backend === "sqlite"
          ? ScriptStudioStore.sqlite(filename, authority)
          : ScriptStudioStore.postgres({
              connectionString: connectionString!,
              schema,
              authority,
            });
      let store: ScriptStudioStore | undefined;
      try {
        if (admin) await admin.query(`CREATE SCHEMA "${schema}"`);
        store = await open();
        const created = await store.createProduction({
          credential: "alice",
          commandId: "create-one",
          productionId: "production-one",
          requestedProjectId: "project-one",
          title: "渡河",
        });
        await store.markDirectoryProjected(created.tenantId, created.eventId);
        const metadata = await store.updateProduction({
          credential: "alice",
          commandId: "metadata-one",
          productionId: "production-one",
          expectedRevision: 1,
          title: "渡河",
          brief: { ...emptyScriptBrief, modelProcessingAllowed: true },
          reviewerPrincipalIds: ["alice"],
          template: defaultScriptExportTemplate,
        });
        await store.markDirectoryProjected(
          metadata.tenantId,
          metadata.eventId!,
        );
        const item = await store.createItem({
          credential: "alice",
          commandId: "create-episode",
          productionId: "production-one",
          itemId: "episode-one",
          expectedActivityRevision: metadata.activityRevision,
          kind: "episode",
          draft: { ...emptyScriptDraft("第一集"), sources: [], text: "原稿。" },
        });
        await store.markDirectoryProjected(item.tenantId, item.eventId);
        await store.prepareGeneration({
          credential: "agent",
          commandId: "prepare-one",
          productionId: "production-one",
          inputId: "input-one",
          generation: {
            productionId: "production-one",
            targetId: "episode-one",
            baseRevision: 1,
            contextRevision: metadata.metadataRevision,
            purpose: "continuity",
            references: [],
            maxCandidates: 1,
            maxOutputCharacters: 2000,
            maxReviewPasses: 1,
          },
        });
        const command = {
          credential: "agent",
          commandId: "report-one",
          productionId: "production-one",
          inputId: "input-one",
          reviews: [],
          workflowReport: {
            explanation: "所读原文未发现冲突。",
            checks: [
              {
                performed: true,
                revise: false,
                blocked: false,
                notes: "核对了所读原文",
              },
              {
                performed: false,
                revise: false,
                blocked: false,
                notes: "不需要第二次检查",
              },
            ],
          },
        };
        await assert.rejects(
          store.submitReviewBatch({ ...command, workflowReport: undefined }),
          /最多提交|报告/,
        );
        const receipt = await store.submitReviewBatch(command);
        assert.deepEqual(receipt.reviewIds, []);
        const proof = {
          tenantId: receipt.tenantId,
          ...agent,
          runtimeInputId: "input-one",
          productionId: receipt.productionId,
          title: receipt.title,
          versionRef: receipt.versionRef,
          receiptId: receipt.receiptId,
        };
        assert.equal(await store.verifyCommittedReview(proof), true);
        for (const forged of [
          { principalId: "intruder" },
          { actantId: "intruder" },
          { runtimeInputId: "input-other" },
          { runtimeTaskRunEventId: "wrong-task-run" },
          { versionRef: "999" },
        ])
          assert.equal(
            await store.verifyCommittedReview({ ...proof, ...forged }),
            false,
          );
        // Simulate loss after app commit and before Platform projection.
        await store.close();
        store = await open();
        const pending = await store.pendingReviewDirectoryEvents(
          "tenant-one",
          1,
        );
        assert.equal(pending.length, 1);
        const event = pending[0]!;
        assert.equal(event.event_id, receipt.eventId);
        assert.equal(event.principal_id, agent.principalId);
        assert.equal(event.actant_id, agent.actantId);
        assert.equal(
          (
            await store.pendingReviewDirectoryEvents("tenant-one", 1, {
              createdAt: event.created_at,
              eventId: event.event_id,
            })
          ).length,
          0,
        );
        assert.deepEqual(await store.submitReviewBatch(command), receipt);
        const results = await store.listInputResults({
          credential: "agent",
          productionId: "production-one",
          inputId: "input-one",
          offset: 0,
          limit: 1,
        });
        assert.equal(results.total, 1);
        assert.equal(results.results[0]!.status, "complete");
        const result = await store.readInputResult({
          credential: "agent",
          productionId: "production-one",
          inputId: "input-one",
          resultId: receipt.reviewId,
        });
        assert.equal(
          JSON.parse(result.resultJson).explanation,
          command.workflowReport.explanation,
        );
        assert.deepEqual(
          JSON.parse(result.resultJson).checks,
          command.workflowReport.checks,
        );
        await assert.rejects(
          store.readInputResult({
            credential: "agent",
            productionId: "production-one",
            inputId: "input-other",
            resultId: receipt.reviewId,
          }),
          /另一条输入/,
        );
        await assert.rejects(
          store.submitReviewBatch({
            ...command,
            workflowReport: {
              ...command.workflowReport,
              explanation: "篡改已保存报告",
            },
          }),
          /相同命令 ID/,
        );
        await store.markDirectoryProjected(receipt.tenantId, receipt.eventId);
        assert.deepEqual(
          await store.pendingReviewDirectoryEvents("tenant-one"),
          [],
        );
        const manuscript = await store.readProduction({
          credential: "alice",
          productionId: "production-one",
        });
        const episode = manuscript.items[0]!;
        assert.equal(episode.revision, 1);
        assert.equal(episode.status, "draft");
        assert.equal(episode.approval, null);
        assert.equal(episode.versions[0]!.draft.text, "原稿。");
        assert.deepEqual(manuscript.reviews, []);
      } finally {
        await store?.close();
        if (admin) {
          await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          await admin.end();
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
}

async function exerciseFreshProduction(store: ScriptStudioStore) {
  const created = await store.createProduction({
    credential: "alice",
    commandId: "create-fresh",
    productionId: "production-one",
    requestedProjectId: "project-one",
    title: "渡河",
  });
  assert.equal(created.versionRef, "1");
  await store.markDirectoryProjected(created.tenantId, created.eventId);
  const settings = {
    credential: "alice",
    commandId: "settings-one",
    productionId: "production-one",
    expectedRevision: 1,
    title: "渡河",
    brief: {
      ...emptyScriptBrief,
      modelProcessingAllowed: true,
      style: "固定风格",
    },
    reviewerPrincipalIds: ["alice"],
    template: defaultScriptExportTemplate,
  };
  const updated = await store.updateProduction(settings);
  assert.equal(updated.metadataRevision, 2);
  assert.equal(updated.activityRevision, 2);
  const pinnedContext = await store.readCreativeContextVersion({
    credential: "agent",
    productionId: "production-one",
    revision: 1,
  });
  assert.equal(pinnedContext.revision, 1);
  assert.equal(pinnedContext.brief.modelProcessingAllowed, false);
  assert.equal(
    (
      await store.readCreativeContextVersion({
        credential: "agent",
        productionId: "production-one",
        revision: 2,
      })
    ).brief.modelProcessingAllowed,
    true,
  );
  await assert.rejects(
    store.readCreativeContextVersion({
      credential: "agent",
      productionId: "production-one",
      revision: 9999,
    }),
    /固定创作要求版本不存在/,
  );
  assert.equal(
    await store.creativeContextCurrent({
      credential: "alice",
      productionId: "production-one",
      revision: 1,
    }),
    false,
  );
  assert.equal(
    await store.creativeContextCurrent({
      credential: "alice",
      productionId: "production-one",
      revision: 2,
    }),
    true,
  );
  assert.deepEqual(await store.updateProduction(settings), updated);
  assert.equal(
    await store.verifyCommittedProductionUpdate({
      tenantId: updated.tenantId,
      principalId: "alice",
      actantId: "alice",
      runtimeInputId: null,
      productionId: updated.productionId,
      title: updated.title,
      versionRef: updated.versionRef,
      receiptId: updated.receiptId,
    }),
    true,
  );
  assert.equal(
    await store.verifyCommittedProductionUpdate({
      tenantId: updated.tenantId,
      principalId: "alice",
      actantId: "agent-one",
      runtimeInputId: null,
      productionId: updated.productionId,
      title: updated.title,
      versionRef: updated.versionRef,
      receiptId: updated.receiptId,
    }),
    false,
  );
  assert.equal(
    (await store.pendingProductionUpdates(updated.tenantId)).length,
    1,
  );
  await store.markDirectoryProjected(updated.tenantId, updated.eventId!);
  const noop = await store.updateProduction({
    ...settings,
    commandId: "settings-noop",
    expectedRevision: 2,
  });
  assert.equal(noop.eventId, null);
  assert.equal(noop.activityRevision, 2);
  assert.deepEqual(
    await store.updateProduction({
      ...settings,
      commandId: "settings-noop",
      expectedRevision: 2,
    }),
    noop,
  );
  await assert.rejects(
    store.updateProduction({
      ...settings,
      commandId: "settings-invalid-reviewer",
      expectedRevision: 2,
      reviewerPrincipalIds: ["intruder"],
    }),
    /审阅人/,
  );
  const { sources: _sources, ...empty } = emptyScriptDraft("第一集");
  const item = await store.createItem({
    credential: "alice",
    commandId: "item-one",
    productionId: "production-one",
    itemId: "episode-one",
    expectedActivityRevision: 2,
    kind: "episode",
    draft: { ...empty, sources: [], text: "原稿。" },
  });
  await store.markDirectoryProjected(item.tenantId, item.eventId);
  const generation = {
    productionId: "production-one",
    targetId: "episode-one",
    baseRevision: 1,
    contextRevision: 2,
    purpose: "rewrite" as const,
    references: [],
    maxCandidates: 1,
    maxOutputCharacters: 2000,
    maxReviewPasses: 1,
  };
  const prepareRequest = {
    credential: "alice",
    commandId: "input-one",
    productionId: "production-one",
    inputId: "input-one",
    generation,
  };
  const prepared = await store.prepareGeneration(prepareRequest);
  assert.deepEqual(await store.prepareGeneration(prepareRequest), prepared);
  assert.deepEqual(
    await store.prepareGeneration({
      ...prepareRequest,
      commandId: "another-tool-call",
    }),
    prepared,
    "The same immutable input recovers the original receipt across tool calls",
  );
  await assert.rejects(
    store.prepareGeneration({
      ...prepareRequest,
      commandId: "different-intent",
      generation: { ...generation, purpose: "draft" },
    }),
    /绑定另一份/,
  );
  await assert.rejects(
    store.prepareGeneration({
      ...prepareRequest,
      commandId: "another-actor",
      credential: "agent",
    }),
    /绑定另一份/,
  );
  const submitted = await store.submitCandidate({
    credential: "agent",
    commandId: "candidate-one",
    productionId: "production-one",
    inputId: "input-one",
    draft: { ...empty, sources: [], text: "新稿。" },
    explanation: "改写",
  });
  await store.markDirectoryProjected(submitted.tenantId, submitted.eventId);
  assert.deepEqual(
    await store.inputDeliveryProductions("tenant-one", ["input-one"]),
    ["production-one"],
  );
  const candidateOutputs = await store.listInputDeliveries({
    credential: "alice",
    inputIds: ["input-one"],
    productionIds: ["production-one"],
  });
  assert.deepEqual(
    candidateOutputs.map((output) => ({
      commandId: output.commandId,
      kind: output.kind,
      candidateId: output.candidateId,
      itemId: output.itemId,
      revision: output.revision,
      title: output.title,
    })),
    [
      {
        commandId: "candidate-one",
        kind: "candidate",
        candidateId: "candidate-one",
        itemId: "episode-one",
        revision: 1,
        title: "第一集",
      },
    ],
  );
  assert.deepEqual(
    await store.listInputDeliveries({
      credential: "alice",
      inputIds: ["other-input"],
      productionIds: ["production-one"],
    }),
    [],
  );
  const later = await store.updateProduction({
    ...settings,
    commandId: "settings-two",
    expectedRevision: 2,
    brief: {
      ...emptyScriptBrief,
      modelProcessingAllowed: false,
      style: "新的创作要求",
    },
  });
  assert.equal(later.activityRevision, 5);
  assert.equal(
    await store.creativeContextCurrent({
      credential: "alice",
      productionId: "production-one",
      revision: 2,
    }),
    false,
  );
  const snapshot = await store.readProduction({
    credential: "alice",
    productionId: "production-one",
  });
  assert.equal(snapshot.items[0]!.status, "draft");
  assert.equal(snapshot.items[0]!.events.at(-1)?.action, "invalidate");
  await store.markDirectoryProjected(later.tenantId, later.eventId!);
  const exportRequest = {
    credential: "alice",
    commandId: "export-one",
    productionId: "production-one",
    expectedRevision: 3,
    items: [{ itemId: "episode-one", revision: 1 }],
    template: defaultScriptExportTemplate,
    workingCopy: true as const,
  };
  const exportReceipt = await store.recordExport(exportRequest);
  assert.equal(exportReceipt.exportId, "export-one");
  assert.deepEqual(await store.recordExport(exportRequest), exportReceipt);
  const exported = await store.readProduction({
    credential: "alice",
    productionId: "production-one",
  });
  assert.equal(exported.exports[0]?.id, "export-one");
  assert.equal(exported.exports[0]?.workingCopy, true);
  await store.markDirectoryProjected("tenant-one", exportReceipt.eventId);
  await assert.rejects(
    store.recordExport({
      ...exportRequest,
      commandId: "export-formal",
      workingCopy: undefined,
    }),
    /锁定稿/,
  );
  await assert.rejects(
    store.recordExport({
      ...exportRequest,
      commandId: "export-stale",
      items: [{ itemId: "episode-one", revision: 2 }],
    }),
    /版本已变化/,
  );
  await assert.rejects(
    store.decideCandidate({
      credential: "alice",
      commandId: "decision-late",
      productionId: "production-one",
      candidateId: "candidate-one",
      expectedRevision: 1,
      decision: "accept",
    }),
    /过期/,
  );
}

async function exercise(store: ScriptStudioStore) {
  const created = await store.createProduction({
    credential: "alice",
    commandId: "create-generation-production",
    productionId: "production-one",
    requestedProjectId: "project-one",
    title: "渡河",
  });
  await store.markDirectoryProjected(created.tenantId, created.eventId);
  const settings = await store.updateProduction({
    credential: "alice",
    commandId: "generation-settings",
    productionId: "production-one",
    expectedRevision: 1,
    title: "渡河",
    brief: { ...emptyScriptBrief, modelProcessingAllowed: true },
    reviewerPrincipalIds: ["alice"],
    template: defaultScriptExportTemplate,
  });
  await store.markDirectoryProjected(settings.tenantId, settings.eventId!);
  const item = await store.createItem({
    credential: "alice",
    commandId: "generation-episode",
    productionId: "production-one",
    itemId: "episode-one",
    expectedActivityRevision: settings.activityRevision,
    kind: "episode",
    draft: { ...emptyScriptDraft("第一集"), sources: [], text: "原稿。" },
  });
  await store.markDirectoryProjected(item.tenantId, item.eventId);
  const generation = {
    productionId: "production-one",
    targetId: "episode-one",
    baseRevision: 1,
    contextRevision: settings.metadataRevision,
    purpose: "rewrite" as const,
    references: [],
    maxCandidates: 1,
    maxOutputCharacters: 2000,
    maxReviewPasses: 1,
  };
  const prepared = await store.prepareGeneration({
    credential: "alice",
    commandId: "input-one",
    productionId: "production-one",
    inputId: "input-one",
    generation,
  });
  assert.deepEqual(prepared.generation, generation);
  assert.deepEqual(
    await store.prepareGeneration({
      credential: "alice",
      commandId: "input-one",
      productionId: "production-one",
      inputId: "input-one",
      generation,
    }),
    prepared,
  );
  assert.deepEqual(
    await store.findPreparation({
      credential: "agent",
      projectId: "project-one",
      inputId: "input-one",
    }),
    prepared,
  );
  await assert.rejects(
    store.findPreparation({
      credential: "agent",
      projectId: "project-one",
      inputId: "input-other",
    }),
    /本次输入/,
  );
  const { sources: _replacedSources, ...base } = emptyScriptDraft("第一集");
  const draft = { ...base, sources: [], text: "改写的正文。" };
  const command = {
    credential: "agent",
    commandId: "candidate-one",
    productionId: "production-one",
    inputId: "input-one",
    draft,
    explanation: "改写",
  };
  const receipt = await store.submitCandidate(command);
  assert.equal(receipt.activityRevision, item.activityRevision + 1);
  assert.deepEqual(await store.submitCandidate(command), receipt);
  const quotedCandidate = await store.readCandidateQuoteSource({
    credential: "alice",
    productionId: "production-one",
    candidateId: "candidate-one",
  });
  assert.equal(quotedCandidate.targetItemId, "episode-one");
  assert.equal(quotedCandidate.baseRevision, 1);
  assert.equal(quotedCandidate.ordinal, 1);
  assert.equal(quotedCandidate.productionTitle, "渡河");
  assert.equal(quotedCandidate.draft.text, "改写的正文。");
  await assert.rejects(
    store.readCandidateQuoteSource({
      credential: "alice",
      productionId: "production-one",
      candidateId: "candidate-other",
    }),
    /候选稿不存在/,
  );
  await assert.rejects(
    store.readCandidateQuoteSource({
      credential: "intruder",
      productionId: "production-one",
      candidateId: "candidate-one",
    }),
    /权限|凭据|访问|认证|授权/,
  );
  const results = await store.listInputResults({
    credential: "agent",
    productionId: "production-one",
    inputId: "input-one",
    offset: 0,
    limit: 1,
  });
  assert.equal(results.total, 1);
  assert.equal(results.hasMore, false);
  assert.deepEqual(
    results.results.map(({ kind, id, status }) => ({ kind, id, status })),
    [{ kind: "candidate", id: "candidate-one", status: "pending" }],
  );
  const result = await store.readInputResult({
    credential: "agent",
    productionId: "production-one",
    inputId: "input-one",
    resultId: "candidate-one",
  });
  assert.equal(result.kind, "candidate");
  assert.equal(JSON.parse(result.resultJson).draft.text, "改写的正文。");
  await assert.rejects(
    store.readInputResult({
      credential: "agent",
      productionId: "production-one",
      inputId: "input-other",
      resultId: "candidate-one",
    }),
    /另一条输入/,
  );
  assert.equal(
    await store.verifyCommittedCandidateSubmission({
      tenantId: receipt.tenantId,
      principalId: agent.principalId,
      actantId: agent.actantId,
      runtimeInputId: "input-one",
      productionId: receipt.productionId,
      title: receipt.title,
      versionRef: receipt.versionRef,
      receiptId: receipt.receiptId,
    }),
    true,
  );
  assert.equal(
    await store.verifyCommittedCandidateSubmission({
      tenantId: receipt.tenantId,
      principalId: agent.principalId,
      actantId: agent.actantId,
      runtimeInputId: "input-other",
      productionId: receipt.productionId,
      title: receipt.title,
      versionRef: receipt.versionRef,
      receiptId: receipt.receiptId,
    }),
    false,
  );
  assert.deepEqual(
    (
      await store.readProduction({
        credential: "alice",
        productionId: "production-one",
      })
    ).candidates.map((candidate) => ({
      id: candidate.id,
      status: candidate.status,
      text: candidate.draft.text,
    })),
    [{ id: "candidate-one", status: "pending", text: "改写的正文。" }],
  );
  await store.markDirectoryProjected(receipt.tenantId, receipt.eventId);
  assert.deepEqual(
    await store.submitCandidate({ ...command, commandId: "candidate-retry" }),
    receipt,
    "同一输入的相同候选在新工具调用中仍恢复原回执，不占用第二份配额",
  );
  await assert.rejects(
    store.submitCandidate({
      ...command,
      commandId: "candidate-two",
      draft: { ...command.draft, text: "另一份候选正文。" },
    }),
    /候选数量已达上限/,
  );
  const accepted = await store.decideCandidate({
    credential: "alice",
    commandId: "decide-one",
    productionId: "production-one",
    candidateId: "candidate-one",
    expectedRevision: 1,
    decision: "accept",
  });
  assert.equal(accepted.adoptedItemRevision, 2);
  assert.deepEqual(
    await store.readCandidateQuoteSource({
      credential: "alice",
      productionId: "production-one",
      candidateId: "candidate-one",
    }),
    quotedCandidate,
    "采纳不会改写候选稿的引用来源",
  );
  assert.equal(
    (
      await store.readItemVersion({
        credential: "alice",
        productionId: "production-one",
        itemId: "episode-one",
      })
    ).draft.text,
    "改写的正文。",
  );
}

test("SQLite 剧本固定生成与候选：实际输入绑定、幂等、人工采纳", async () => {
  const store = await ScriptStudioStore.sqlite(":memory:", authority);
  try {
    await exercise(store);
  } finally {
    await store.close();
  }
});

test("SQLite 新建剧本设置：历史字段往返、真实创作变化、候选失效与幂等", async () => {
  const store = await ScriptStudioStore.sqlite(":memory:", authority);
  try {
    await exerciseFreshProduction(store);
  } finally {
    await store.close();
  }
});

test("SQLite 已建剧本保留legacy false；历史字段往返不使固定创作与候选失效", async () => {
  const store = await ScriptStudioStore.sqlite(":memory:", authority);
  try {
    const created = await store.createProduction({
      credential: "alice",
      commandId: "legacy-create",
      productionId: "production-one",
      requestedProjectId: "project-one",
      title: "TEST 既有原创",
    });
    await store.markDirectoryProjected(created.tenantId, created.eventId);
    const manuscript = {
      ...emptyScriptDraft("第一集"),
      sources: [],
      text: "原稿。",
    };
    const item = await store.createItem({
      credential: "alice",
      commandId: "legacy-item",
      productionId: "production-one",
      itemId: "episode-one",
      expectedActivityRevision: 1,
      kind: "episode",
      draft: manuscript,
    });
    await store.markDirectoryProjected(item.tenantId, item.eventId);
    const request = {
      credential: "agent",
      commandId: "legacy-prepare",
      productionId: "production-one",
      inputId: "input-one",
      generation: {
        productionId: "production-one",
        targetId: "episode-one",
        baseRevision: 1,
        contextRevision: 1,
        purpose: "rewrite" as const,
        references: [],
        maxCandidates: 1,
        maxOutputCharacters: 2000,
        maxReviewPasses: 0,
      },
    };
    const prepared = await store.prepareGeneration(request);
    for (const [expectedRevision, modelProcessingAllowed] of [
      [1, true],
      [2, false],
    ] as const) {
      const settings = await store.updateProduction({
        credential: "alice",
        commandId: `legacy-settings-${expectedRevision}`,
        productionId: "production-one",
        expectedRevision,
        title: "TEST 既有原创",
        brief: { ...emptyScriptBrief, modelProcessingAllowed },
        reviewerPrincipalIds: ["alice"],
        template: defaultScriptExportTemplate,
      });
      assert.equal(settings.metadataRevision, expectedRevision + 1);
      await store.markDirectoryProjected(settings.tenantId, settings.eventId!);
      assert.equal(
        await store.creativeContextCurrent({
          credential: "agent",
          productionId: "production-one",
          revision: 1,
        }),
        true,
      );
      assert.deepEqual(await store.prepareGeneration(request), prepared);
      assert.equal(
        (
          await store.readItemVersion({
            credential: "agent",
            productionId: "production-one",
            itemId: "episode-one",
            revision: 1,
          })
        ).draft.text,
        "原稿。",
      );
    }
    const submission = {
      credential: "agent",
      commandId: "legacy-candidate",
      productionId: "production-one",
      inputId: "input-one",
      draft: { ...manuscript, text: "TEST 正常候选。" },
      explanation: "合成回归，无模型请求。",
    };
    const candidate = await store.submitCandidate(submission);
    assert.deepEqual(await store.submitCandidate(submission), candidate);
    const snapshot = await store.readProduction({
      credential: "alice",
      productionId: "production-one",
    });
    assert.equal(snapshot.brief.modelProcessingAllowed, false);
    assert.equal(snapshot.brief.rightsStatement, "");
    assert.equal(snapshot.candidates[0]?.status, "pending");
    assert.equal(snapshot.items[0]?.versions[0]?.draft.text, "原稿。");
    assert.equal(
      (
        await store.readCandidate({
          credential: "agent",
          productionId: "production-one",
          candidateId: candidate.candidateId,
        })
      ).draft.text,
      "TEST 正常候选。",
    );
  } finally {
    await store.close();
  }
});

test(
  "PostgreSQL 剧本固定生成与候选：同一应用事务语义",
  {
    skip: !process.env.MORPHZ_TEST_POSTGRES_URL,
  },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_script_generation_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const store = await ScriptStudioStore.postgres({
        connectionString,
        schema,
        authority,
      });
      try {
        await exercise(store);
      } finally {
        await store.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

test(
  "PostgreSQL 新建剧本设置：与 SQLite 同等事务语义",
  {
    skip: !process.env.MORPHZ_TEST_POSTGRES_URL,
  },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_script_settings_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const store = await ScriptStudioStore.postgres({
        connectionString,
        schema,
        authority,
      });
      try {
        await exerciseFreshProduction(store);
      } finally {
        await store.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
