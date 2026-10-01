import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import {
  emptyScriptDraft,
  type ScriptGeneration,
} from "../packages/core/src/script-studio.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { updateScriptProduction } from "../packages/application/src/script-production-service.js";

test("真实剧本交付卡片不预读正文，点击精确候选并采纳后刷新状态，返回保留草稿", async ({
  page,
}) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const suffix = randomUUID().slice(0, 8);
  const projectId = randomUUID();
  await source.createProject(
    `TEST 轻量交付 ${suffix}`,
    randomUUID(),
    projectId,
  );
  const { directory } = JSON.parse(
    readFileSync("node_modules/.cache/morphz-e2e-center.json", "utf8"),
  ) as { directory: string };
  const seed = await agentDomainFixture({
    existingCenter: { directory, projectId },
  });
  try {
    const title = `TEST 同名交付剧本 ${suffix}`;
    const itemTitle = `TEST 原交付空白一集 ${suffix}`;
    const candidateTitle = `TEST 候选原稿 ${suffix}`;
    const text = `TEST 候选正文 ${suffix}，只在点击后读取。`;
    const inputId = (await seed.readAcceptedInput(seed.route)).input_id;
    const created = await seed.call<{
      productionId: string;
      contentId: string;
    }>({
      action: "script",
      script: {
        action: "command",
        command: { action: "create-production", projectId, title },
      },
    });
    const studio = seed.domains.content.studio!;
    const overview = () =>
      seed.withHuman((actor) =>
        studio.readProductionOverview({
          credential: actor.credential,
          productionId: created.productionId,
        }),
      );
    const item = await seed.call<{ itemId: string }>({
      action: "script",
      script: {
        action: "command",
        command: {
          action: "create-item",
          productionId: created.productionId,
          expectedActivityRevision: (await overview()).activityRevision,
          kind: "episode",
          draft: emptyScriptDraft(itemTitle),
        },
      },
    });
    const header = await overview();
    await seed.withHuman((actor) =>
      updateScriptProduction({
        platform: seed.domains.content.platform,
        studio,
        instanceId: seed.domains.content.instanceIds.scriptStudio,
        actor,
        commandId: randomUUID(),
        productionId: created.productionId,
        expectedRevision: header.metadataRevision,
        title,
        brief: { ...header.brief, modelProcessingAllowed: true },
        reviewerPrincipalIds: header.reviewerPrincipalIds,
        template: header.template,
      }),
    );
    const generation: ScriptGeneration = {
      productionId: created.productionId,
      targetId: item.itemId,
      baseRevision: 1,
      contextRevision: (await overview()).metadataRevision,
      purpose: "draft",
      references: [],
      maxCandidates: 1,
      maxOutputCharacters: 3000,
      maxReviewPasses: 1,
    };
    const candidateInputId = `input_${randomUUID().replaceAll("-", "")}`;
    const route = seed.input(projectId, "写一份候选", "", undefined, {
      inputId: candidateInputId,
      scriptGeneration: generation,
    });
    await seed.withHuman((actor) =>
      studio.prepareGeneration({
        credential: actor.credential,
        commandId: candidateInputId,
        productionId: created.productionId,
        inputId: candidateInputId,
        generation,
      }),
    );
    await seed.call(
      {
        action: "script",
        script: {
          action: "submit-workflow",
          payload: { ...emptyScriptDraft(candidateTitle), text },
          explanation: "TEST 可控模型输出；领域存储和交付回执是真实的。",
          checks: [0, 1].map(() => ({
            performed: false,
            revise: false,
            blocked: false,
            notes: "未执行",
          })),
        },
      },
      route,
    );
    const duplicate = (await source.createScript({
      commandId: randomUUID(),
      productionId: randomUUID(),
      projectId,
      title,
    })) as { contentId: string };
    await page.addInitScript(({ centerId, principalId }) => {
      localStorage.setItem(
        `morphz:${centerId}:${principalId}:preferences`,
        JSON.stringify({
          view: "dialogue",
          artifactId: null,
          scriptLocation: null,
        }),
      );
    }, source.boot);
    // Only Runtime publication is controlled here. Every card payload is read
    // from actual app receipts, including after the Human's real UI decision.
    await page.route(
      /\/api\/platform\/runtime-navigation(?:\?.*)?$/,
      async (r) => {
        const response = await r.fetch();
        const navigation = await response.json();
        await r.fulfill({
          response,
          json: {
            ...navigation,
            runtime: { ...navigation.runtime, configured: true },
          },
        });
      },
    );
    await page.route(
      /\/api\/platform\/projects\/[^/]+\/conversations\/[^/]+\/history(?:\?.*)?$/,
      async (r) => {
        const match = new URL(r.request().url()).pathname.match(
          /\/projects\/([^/]+)\/conversations\/([^/]+)\/history$/,
        )!;
        const scriptOutputs = await seed.withHuman((actor) =>
          studio.listInputDeliveries({
            credential: actor.credential,
            inputIds: [inputId, candidateInputId],
            productionIds: [created.productionId],
          }),
        );
        await r.fulfill({
          json: {
            inputs: [inputId, candidateInputId].map((id, i) => ({
              id,
              projectId: match[1],
              conversationId: match[2],
              author: {
                principalId: source.boot.principalId,
                actantId: source.boot.actantId,
              },
              targetActantId: "morphz-agent",
              body: i ? "TEST 写候选" : "TEST 建立一集",
              createdAt: new Date(Date.UTC(2026, 8, 30, 0, 0, i)).toISOString(),
            })),
            scriptOutputs,
            nextCursor: null,
            runtime: { ...disconnectedRuntime, configured: true },
          },
        });
      },
    );
    const snapshots: string[] = [];
    page.on("request", (request) => {
      const match = new URL(request.url()).pathname.match(
        /^\/api\/platform\/scripts\/([^/]+)\/snapshot$/,
      );
      if (match && [created.contentId, duplicate.contentId].includes(match[1]!))
        snapshots.push(match[1]!);
    });
    await page.goto("/");
    const candidate = page.getByRole("button", {
      name: `打开剧本结果：${candidateTitle}`,
      exact: true,
    });
    const itemCard = page.getByRole("button", {
      name: `打开剧本结果：${itemTitle}`,
      exact: true,
    });
    await expect(candidate).toBeEnabled();
    await expect(candidate).toContainText("候选稿 · 待决定");
    await expect(itemCard).toContainText("分集 · 空白条目");
    await expect(candidate).toContainText(title);
    expect(snapshots).toEqual([]);
    await page
      .getByLabel("AI 输入内容", { exact: true })
      .fill("TEST 返回后保留引用问题");
    await candidate.click();
    await expect(page.getByLabel("候选稿", { exact: true })).toContainText(
      text,
    );
    expect(snapshots).toEqual([]);
    await page
      .getByRole("button", { name: "采纳为新版本", exact: true })
      .click();
    await expect(page.locator(".script-candidate-heading")).toContainText(
      "已采纳",
    );
    await page
      .getByRole("button", { name: "返回上一位置", exact: true })
      .click();
    await expect(page.getByLabel("AI 输入内容", { exact: true })).toHaveValue(
      "TEST 返回后保留引用问题",
    );
    await expect(candidate).toContainText("候选稿 · 已采纳");
    await expect(itemCard).toContainText("空白条目");
    await page.reload();
    await expect(candidate).toContainText("候选稿 · 已采纳");
    await itemCard.click();
    await expect(page.getByRole("combobox", { name: "查看版本" })).toHaveValue(
      "1",
    );
    await expect(page.locator(".script-history pre")).toHaveText("");
    expect(snapshots).toEqual([]);
  } finally {
    await seed.close();
  }
});
