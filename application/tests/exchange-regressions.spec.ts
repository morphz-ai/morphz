import { test, expect } from "@playwright/test";
import { openInput, composerAction } from "./interaction-helpers.js";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
});

test("消息显隐、展开与固定不挪动输入工具和面板控制的命中位置", async ({
  page,
}) => {
  const input = await openInput(page);
  await input.fill("TEST 操作位置保持稳定，不发送");
  const buttons = page.locator(
    ".composer-media-tools > button, .exchange-view-tools button",
  );
  const positions = () =>
    buttons.evaluateAll((elements) =>
      elements.map((el) => {
        const { x, y, width, height } = el.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
  const initial = await positions();
  expect(initial.length).toBeGreaterThanOrEqual(7);
  for (const name of [
    "收起交流记录",
    "查看交流记录",
    "展开完整记录",
    "返回工作内容",
    "固定输入框",
    "取消固定输入框",
  ]) {
    await composerAction(page, name);
    await expect(async () => {
      const current = await positions();
      expect(current).toHaveLength(initial.length);
      current.forEach((box, index) => {
        expect(
          Math.abs(box.x - initial[index]!.x),
          `${name}: x`,
        ).toBeLessThanOrEqual(2);
        expect(
          Math.abs(box.y - initial[index]!.y),
          `${name}: y`,
        ).toBeLessThanOrEqual(2);
        expect(box.width).toBe(initial[index]!.width);
        expect(box.height).toBe(initial[index]!.height);
      });
    }).toPass({ timeout: 1500 });
    await expect(input).toHaveValue("TEST 操作位置保持稳定，不发送");
  }
});

test("从输入框连续 Tab 能到达全部常用按钮，不必先跳到消息顶部", async ({
  page,
}) => {
  const input = await openInput(page);
  await input.fill("TEST 连续键盘路径，不发送");
  const visited: string[] = [];
  for (let index = 0; index < 14; index++) {
    await page.keyboard.press("Tab");
    const active = await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    );
    if (active) visited.push(active);
    if (!(await input.isVisible())) break;
    if (visited.includes("收起 AI 输入框")) break;
  }
  for (const name of [
    "附加文件",
    "截图输入",
    "语音输入",
    "收起交流记录",
    "展开完整记录",
    "固定输入框",
    "收起 AI 输入框",
  ])
    expect(visited, name).toContain(name);
  await expect(input).toHaveValue("TEST 连续键盘路径，不发送");
});

test("系统附件选择取消后恢复原按钮焦点，保留草稿且不触发发送", async ({
  page,
}) => {
  const input = await openInput(page);
  await input.fill("TEST 取消附件后继续输入，不发送");
  const before = await page.request.get("/api/workspace").then((r) => r.json());
  const attach = page.getByRole("button", { name: "附加文件", exact: true });
  const picker = page.waitForEvent("filechooser");
  await attach.click();
  await picker;
  await page.evaluate(() => {
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => false,
    });
    window.dispatchEvent(new Event("blur"));
  });
  await expect(input).toBeVisible();
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "hasFocus");
    window.dispatchEvent(new Event("focus"));
  });
  await page.getByLabel("消息附件文件").dispatchEvent("cancel");
  await expect(attach).toBeEnabled();
  await expect(attach).toBeFocused();
  await expect(input).toHaveValue("TEST 取消附件后继续输入，不发送");
  const after = await page.request.get("/api/workspace").then((r) => r.json());
  expect(after.workspace.inputs).toEqual(before.workspace.inputs);
  expect(after.workspace.artifacts).toEqual(before.workspace.artifacts);
});

test("未固定时鼠标和键盘移除附件，输入仍可继续且不影响其他附件", async ({
  page,
}) => {
  const input = await openInput(page);
  await input.fill("TEST 移除附件不收起输入，不发送");
  const picker = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "附加文件", exact: true }).click();
  await (
    await picker
  ).setFiles(
    ["first.txt", "second.txt"].map((name) => ({
      name,
      mimeType: "text/plain",
      buffer: Buffer.from("TEST 可移除的合成附件"),
    })),
  );
  for (const [name, action] of [
    ["first.txt", "mouse"],
    ["second.txt", "Enter"],
  ] as const) {
    const remove = page.getByRole("button", {
      name: `移除附件 ${name}`,
      exact: true,
    });
    await expect(remove).toBeEnabled();
    if (action === "mouse") await remove.click();
    else {
      await remove.focus();
      await page.keyboard.press(action);
    }
    await expect(remove).toHaveCount(0);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("TEST 移除附件不收起输入，不发送");
  }
  await expect(page.getByLabel("消息附件", { exact: true })).toHaveCount(0);
});

test("收起记录只剩输入本体，悬浮 Dock 不留下顶部空行或底部工具行", async ({
  page,
}) => {
  const input = await openInput(page);
  await input.fill("TEST 悬浮 Dock 原始方案，不发送");
  // This measures layout, not blur-to-collapse: removing the focused tool
  // group below would otherwise legitimately close an unpinned composer.
  await composerAction(page, "固定输入框");
  await composerAction(page, "收起交流记录");
  await expect(page.locator(".conversation")).toHaveCount(0);
  const panel = page.locator(".exchange-panel");
  const composer = page.locator(".composer");
  const dock = page.locator(".composer-floating-tools");
  await expect(dock).toHaveCSS("position", "absolute");
  await expect(page.locator(".exchange-panel-header")).toBeHidden();
  const p = (await panel.boundingBox())!;
  const c = (await composer.boundingBox())!;
  const d = (await dock.boundingBox())!;
  expect(c.y - p.y).toBeLessThanOrEqual(1);
  expect(p.height - c.height).toBeLessThanOrEqual(2);
  expect(d.y + d.height).toBeLessThan(c.y);
  expect(c.y - d.y - d.height).toBeLessThanOrEqual(8);
  // Removing only the tool paint must not resize the input/frame.
  await dock.evaluate((el) => ((el as HTMLElement).style.display = "none"));
  expect((await composer.boundingBox())!.height).toBe(c.height);
  expect((await panel.boundingBox())!.height).toBe(p.height);
  await dock.evaluate((el) =>
    (el as HTMLElement).style.removeProperty("display"),
  );
  await dock.getByRole("button", { name: "查看交流记录", exact: true }).focus();
  await expect(dock).toBeVisible();
  await expect(dock).toHaveCSS("opacity", "1");
  await expect(input).toHaveValue("TEST 悬浮 Dock 原始方案，不发送");
  await page.screenshot({ path: "test-results/floating-dock-collapsed.png" });
});

test("读写衔接只减弱底色差与分隔线，文字可读且增强对比度仍保留清晰边界", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const input = await openInput(page);
  await input.fill("TEST 只调整读写衔接颜色，不发送");
  const composer = page.locator(".composer");
  for (const appearance of ["light", "dark"]) {
    await page.locator(".app").evaluate((el, mode) => {
      el.setAttribute("data-appearance", mode);
    }, appearance);
    const colors = await composer.evaluate((el) => {
      const style = getComputedStyle(el);
      const canvas = document.createElement("canvas").getContext("2d")!;
      const rgb = (value: string) => {
        canvas.clearRect(0, 0, 1, 1);
        canvas.fillStyle = value;
        canvas.fillRect(0, 0, 1, 1);
        return [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      const probe = document.createElement("span");
      probe.style.display = "none";
      el.append(probe);
      const token = (name: string) => {
        probe.style.backgroundColor = `var(${name})`;
        return rgb(getComputedStyle(probe).backgroundColor);
      };
      const result = {
        background: rgb(style.backgroundColor),
        paper: token("--paper"),
        previousBackground: token("--surface-raised"),
        divider: rgb(getComputedStyle(el, "::before").backgroundColor),
        previousDivider: token("--line"),
        text: rgb(getComputedStyle(el.querySelector("textarea")!).color),
        placeholder: rgb(
          getComputedStyle(el.querySelector("textarea")!, "::placeholder")
            .color,
        ),
      };
      probe.remove();
      return result;
    });
    const distance = (a: number[], b: number[]) =>
      Math.max(...a.map((channel, i) => Math.abs(channel - b[i]!)));
    expect(distance(colors.background, colors.paper)).toBeLessThan(
      distance(colors.previousBackground, colors.paper),
    );
    expect(distance(colors.divider, colors.paper)).toBeLessThan(
      distance(colors.previousDivider, colors.paper),
    );
    const luminance = (rgb: number[]) => {
      const linear = rgb.map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
    };
    for (const ink of [colors.text, colors.placeholder]) {
      const a = luminance(ink),
        b = luminance(colors.background);
      expect(
        (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
  for (const mode of ["media", "native"]) {
    if (mode === "media") await page.emulateMedia({ contrast: "more" });
    else {
      await page.emulateMedia({ contrast: "no-preference" });
      await page.locator("html").evaluate((el) => {
        el.setAttribute("data-native-contrast", "more");
      });
    }
    const divider = await composer.evaluate(
      (el) => getComputedStyle(el, "::before").backgroundColor,
    );
    expect(divider).toBe(
      mode === "media" ? "rgb(142, 142, 152)" : "rgb(152, 152, 152)",
    );
    await expect(input).toHaveValue("TEST 只调整读写衔接颜色，不发送");
  }
});

test("真实组件的明暗视觉样例保留消息、表格、输入和全部操作", async ({
  page,
}) => {
  // Only this isolated test supplies synthetic messages. Never write a mock
  // reply into the real center or report this image as original-app acceptance.
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
    });
    const boot = await response.json();
    const projectId = boot.workspace.projects.find(
      (p: { kind: string }) => p.kind === "desk",
    ).id;
    boot.workspace.inputs = [
      {
        id: "visual-review-input",
        projectId,
        conversationId: "local-dialogue",
        artifactId: null,
        artifactRevision: null,
        author: { actantId: "local-human", principalId: "local-owner" },
        selection: "",
        body: "TEST 视觉验收：比较两家供应商的报价，并列出下一步。",
        status: "recorded",
        targetActantId: "morphz-agent",
        createdAt: "2026-09-14T08:00:00Z",
      },
    ];
    boot.runtime = {
      ...boot.runtime,
      configured: true,
      connected: true,
      model: "gpt-6-astra",
      deliveries: [
        {
          inputId: "visual-review-input",
          state: "completed",
          error: null,
          retryable: false,
          cancellable: false,
        },
      ],
      messages: [
        {
          id: "visual-review-reply",
          projectId,
          conversationId: "local-dialogue",
          inputId: "visual-review-input",
          artifactId: null,
          kind: "reply",
          createdAt: "2026-09-14T08:00:01Z",
          text: "甲的报价更低，相比乙节省 **30 元**。\n\n| 供应商 | 报价 | 确认状态 |\n| --- | --- | --- |\n| 甲 | 120 元 | 已确认 |\n| 乙 | 150 元 | 待确认 |\n\n下一步：确认交付时间，再决定采用哪家报价。",
        },
      ],
    };
    await route.fulfill({ response, json: boot });
  });
  await page.route("**/api/models", (route) =>
    route.fulfill({
      json: {
        current: "gpt-6-astra",
        options: [{ id: "gpt-6-astra", label: "gpt-6-astra · development" }],
      },
    }),
  );
  await page.reload();
  const input = await openInput(page);
  await expect(page.locator(".conversation")).toContainText("确认交付时间");
  await input.fill("再帮我整理需要向供应商确认的问题。");
  await composerAction(page, "固定输入框");
  for (const appearance of ["light", "dark"]) {
    await page
      .locator(".app")
      .evaluate(
        (el, mode) => el.setAttribute("data-appearance", mode),
        appearance,
      );
    for (const width of [1440, 760]) {
      await page.setViewportSize({ width, height: width === 1440 ? 960 : 540 });
      await input.focus();
      const panel = page.locator(".exchange-panel");
      await expect(panel).toBeInViewport();
      expect(
        await panel.evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(2);
      await expect(page.locator(".send")).toBeInViewport();
      await expect(
        page.getByRole("button", { name: "收起 AI 输入框", exact: true }),
      ).toBeInViewport();
      await page.locator(".conversation").evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      const lastMessage = page.locator(".conversation-message").last();
      await expect
        .poll(async () => {
          const message = (await lastMessage.boundingBox())!;
          const dock = (await page
            .locator(".composer-floating-tools")
            .boundingBox())!;
          return message.y + message.height - dock.y;
        })
        .toBeLessThanOrEqual(0);
      await panel.screenshot({
        path: `test-results/exchange-review-${appearance}-${width}.png`,
      });
    }
  }
});
