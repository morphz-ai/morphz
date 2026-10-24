import { randomUUID } from "node:crypto";
import { applicationStoragePrefix } from "../packages/core/src/application-names.js";
import type { LocalSavedInput } from "../apps/web/src/local-saved-inputs.js";
import {
  test,
  expect,
  conversationClient,
} from "./project-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";

for (const success of [true, false])
  test(`切换会话不闪出旧队列，等待历史时新消息${success ? "发送成功" : "发送失败"}也保留同一气泡`, async ({
    page,
    messageHost,
  }) => {
    await page.goto("/");
    const source = await conversationClient(page);
    const spaces = await source.ensurePersonalSpaces();
    const projectId = `initial_history_${randomUUID().replaceAll("-", "")}`;
    const conversationId = `initial_conversation_${randomUUID().replaceAll("-", "")}`;
    const projectTitle = "TEST 历史首屏来源";
    const conversationTitle = "TEST 独立会话";
    await source.createProject(projectTitle, randomUUID(), projectId);
    await source.sendMessage({
      commandId: randomUUID(),
      projectId,
      conversationId,
      newConversation: { title: conversationTitle },
      body: "TEST 已有独立会话消息",
    });
    const latestId = randomUUID();
    const latestBody = "TEST 最新历史页消息";
    await page.reload();
    const project = page.getByRole("group", {
      name: `${projectTitle}的会话`,
      exact: true,
    });
    const expand = project.getByRole("button", {
      name: `展开项目会话：${projectTitle}`,
      exact: true,
    });
    await expect(project).toBeVisible();
    if (await expand.isVisible()) await expand.click();
    await project
      .getByRole("button", {
        name: `打开对话：${conversationTitle}`,
        exact: true,
      })
      .click();
    await expect(
      project.getByRole("button", {
        name: `打开对话：${conversationTitle}`,
        exact: true,
      }),
    ).toHaveAttribute("aria-current", "true");
    await expect(await openInput(page)).toBeVisible();

    const oldInputs = [0, 1].map((index): LocalSavedInput => ({
      commandId: randomUUID(),
      createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
      operation: {
        type: "record-input",
        projectId: spaces.dialogueId,
        conversationId: spaces.dialogueId,
        artifactId: null,
        artifactRevision: null,
        selection: "",
        targetActantId: "morphz-agent",
        dispatchMode: "interrupt",
        body: `TEST 原样保留的旧失败消息 ${index}`,
      },
      submission: { state: "failed", error: "TEST 原发送失败" },
    }));
    const savedPrefix = `${applicationStoragePrefix}${source.boot.centerId}:${source.boot.principalId}:${source.boot.actantId}:saved-input:`;
    await page.evaluate(
      ({ savedPrefix, oldInputs }) => {
        for (const input of oldInputs)
          localStorage.setItem(
            savedPrefix + input.commandId,
            JSON.stringify(input),
          );
      },
      { savedPrefix, oldInputs },
    );
    // Reopen the real named scope so the old local entries are already restored
    // before the explicit switch to the global conversation, as in the app.
    await page.reload();
    await expect(await openInput(page)).toBeVisible();
    let releaseHead!: () => void;
    let requestedHead!: () => void;
    const headGate = new Promise<void>((resolve) => (releaseHead = resolve));
    const headRequested = new Promise<void>(
      (resolve) => (requestedHead = resolve),
    );
    const sends: string[] = [];
    if (!success)
      await page.route("**/api/platform/messages", (route) =>
        route.fulfill({
          status: 400,
          json: {
            message: "TEST 新消息发送失败，原气泡保留",
            code: "test_send_failed",
          },
        }),
      );
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/platform/messages"
      )
        sends.push(request.postDataJSON().commandId);
    });
    await page.route(
      /\/api\/platform\/projects\/[^/]+\/conversations\/[^/]+\/history(?:\?.*)?$/,
      async (route) => {
        const url = new URL(route.request().url());
        if (
          url.pathname.endsWith(`/conversations/${spaces.dialogueId}/history`)
        ) {
          requestedHead();
          await headGate;
          const response = await route.fetch();
          const body = await response.json();
          // Synthetic timeline evidence, not an executed model result from this
          // deliberately stopped Runtime. Keep the real Host's new queued input.
          await route.fulfill({
            response,
            json: {
              ...body,
              inputs: [
                {
                  id: latestId,
                  projectId: spaces.dialogueId,
                  conversationId: spaces.dialogueId,
                  author: {
                    principalId: source.boot.principalId,
                    actantId: source.boot.actantId,
                  },
                  targetActantId: "morphz-agent",
                  body: latestBody,
                  createdAt: "2026-10-23T00:00:00.000Z",
                },
                ...body.inputs,
              ],
            },
          });
          return;
        }
        await route.continue();
      },
    );
    try {
      await page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name: "对话", exact: true })
        .click();
      await headRequested;
      const conversation = page.getByRole("region", { name: "当前对话" });
      for (const old of oldInputs)
        await expect(conversation.getByText(old.operation.body)).toHaveCount(0);
      await expect(conversation.getByRole("status")).toHaveText(
        "正在读取对话…",
      );
      expect(sends).toEqual([]);

      const freshBody = "TEST 历史仍在读取时即时显示的新消息";
      const editor = await openInput(page);
      await editor.fill(freshBody);
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      const fresh = page
        .locator(".human-message")
        .filter({ hasText: freshBody });
      await expect(fresh).toBeVisible();
      const freshElement = await fresh.elementHandle();
      const freshId = await fresh.getAttribute("data-input-id");
      await expect.poll(() => sends).toEqual([freshId]);
      if (!success)
        await expect(fresh).toHaveAttribute("data-submission-state", "failed");
      await editor.fill("TEST 后续未发送草稿");
      for (const old of oldInputs)
        await expect(conversation.getByText(old.operation.body)).toHaveCount(0);
      releaseHead();
      await expect(page.getByText(latestBody, { exact: true })).toBeVisible();
      await expect(fresh).toBeVisible();
      await expect(fresh).toHaveCount(1);
      await expect(fresh).toHaveAttribute("data-input-id", freshId!);
      if (!success)
        await expect(
          fresh.getByRole("button", { name: "重新发送消息" }),
        ).toHaveAttribute("title", "发送失败：TEST 新消息发送失败，原气泡保留");
      expect(
        await fresh.evaluate(
          (element, original) => element === original,
          freshElement,
        ),
      ).toBe(true);
      await expect(editor).toHaveValue("TEST 后续未发送草稿");
      for (const old of oldInputs) {
        const bubble = page.locator(
          `.human-message[data-input-id="${old.commandId}"]`,
        );
        await expect(bubble).toHaveAttribute("data-submission-state", "failed");
        await expect(
          bubble.getByRole("button", { name: "重新发送消息" }),
        ).toHaveAttribute("title", "发送失败：TEST 原发送失败");
        expect(
          await page.evaluate(
            (key) => JSON.parse(localStorage.getItem(key)!),
            savedPrefix + old.commandId,
          ),
        ).toEqual(old);
      }
      expect(sends).toEqual([freshId]);
      expect(
        messageHost
          .deliveries()
          .some((delivery) =>
            oldInputs.some((old) => old.commandId === delivery.inputId),
          ),
      ).toBe(false);
    } finally {
      releaseHead();
      await page.unrouteAll({ behavior: "wait" });
    }
  });
