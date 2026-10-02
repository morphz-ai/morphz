import { test, expect } from "@playwright/test";
import { openLibrary } from "./application-helpers.js";
import { humanTask, seedLibraryArtifact } from "./artifact-fixtures.js";

const url = "https://example.test/" + "long-path-without-spaces-".repeat(40);
const prose =
  "事项正文必须完整呈现，保留中文、EnglishHarnessContext、标点与真实Markdown结构。".repeat(
    24,
  );
const token = "HarnessExecutionContextWithoutAnySpace".repeat(40);
const lastLine = "TEST_END_OF_TASK_DESCRIPTION 完整正文末尾，可以滚动到达。";
const description = [
  "## TEST 事项正文",
  prose,
  "- **保持粗体语义**\n- 保持列表结构",
  `长地址：[${url}](${url})`,
  token,
  "TEST 原始换行\n问题：保留第一行\n复现：保留第二行\n建议：保留第三行\n验收：保留第四行",
  "```text\nTEST 原样代码缩进\n    " + token + "\n```",
  ...Array.from(
    { length: 18 },
    (_, n) => `第 ${n + 1} 段检查：${prose.slice(0, 180)}`,
  ),
  lastLine,
].join("\n\n");

for (const configuration of [
  { name: "wide-sidebar", width: 1440, zoom: 1, sidebar: true },
  { name: "narrow", width: 760, zoom: 1, sidebar: false },
  { name: "small", width: 390, zoom: 1, sidebar: false },
  { name: "css-200-percent", width: 1440, zoom: 2, sidebar: false },
])
  test(`事项完整正文换行与滚动：${configuration.name}`, async ({
    page,
  }, info) => {
    await page.goto("/");
    await openLibrary(page);
    await seedLibraryArtifact(
      page,
      "TEST 完整事项正文 " + configuration.name,
      humanTask(description),
    );
    await page.setViewportSize({ width: configuration.width, height: 960 });
    const show = page.getByRole("button", { name: "显示右侧栏", exact: true });
    const hide = page.getByRole("button", { name: "隐藏右侧栏", exact: true });
    if (configuration.sidebar && (await show.isVisible())) await show.click();
    if (!configuration.sidebar && (await hide.isVisible())) await hide.click();
    if (configuration.sidebar)
      await expect(page.locator(".subject-sidebar")).toBeVisible();
    if (configuration.zoom === 2)
      await page.evaluate(() => {
        document.documentElement.style.zoom = "2";
      });
    const paper = page.locator(".task-paper");
    const body = paper.getByLabel("事项说明", { exact: true });
    await expect(body).toBeVisible();
    await page.screenshot({
      path: info.outputPath("task-description-top.png"),
    });
    const layout = await body.evaluate((element) => {
      const style = getComputedStyle(element);
      const paragraph = element.querySelector("p")!;
      const bounds = element.getBoundingClientRect();
      const main = element.closest("main")!.getBoundingClientRect();
      return {
        whiteSpace: style.whiteSpace,
        overflowX: style.overflowX,
        textOverflow: style.textOverflow,
        lines:
          paragraph.clientHeight /
          parseFloat(getComputedStyle(paragraph).lineHeight),
        bodyOverflow: element.scrollWidth > element.clientWidth + 1,
        paperOverflow:
          element.closest(".task-paper")!.scrollWidth >
          element.closest(".task-paper")!.clientWidth + 1,
        left: bounds.left,
        right: bounds.right,
        mainLeft: main.left,
        mainRight: main.right,
        viewportWidth: window.innerWidth,
      };
    });
    expect(layout.whiteSpace).toBe("normal");
    expect(layout.overflowX).toBe("visible");
    expect(layout.textOverflow).toBe("clip");
    expect(layout.lines).toBeGreaterThan(2);
    expect(layout.bodyOverflow).toBe(false);
    expect(layout.paperOverflow).toBe(false);
    expect(layout.left).toBeGreaterThanOrEqual(
      Math.max(0, layout.mainLeft) - 1,
    );
    expect(layout.right).toBeLessThanOrEqual(
      Math.min(layout.viewportWidth, layout.mainRight) + 1,
    );
    await expect(
      body.getByRole("heading", { name: "TEST 事项正文", exact: true }),
    ).toHaveCount(1);
    await expect(body.getByRole("listitem")).toHaveCount(2);
    await expect(body.locator("strong")).toHaveText("保持粗体语义");
    await expect(body).toContainText(url);
    await expect(body).toContainText(token);
    await expect(body.locator("pre code")).toHaveText(
      "TEST 原样代码缩进\n    " + token + "\n",
    );
    const softBreaks = body.locator("p").filter({ hasText: "TEST 原始换行" });
    const lineBreakLayout = await softBreaks.evaluate((element) => {
      const rects = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode;
        for (const label of ["问题：", "复现：", "建议：", "验收："]) {
          const start = text.textContent!.indexOf(label);
          if (start < 0) continue;
          const range = document.createRange();
          range.setStart(text, start);
          range.setEnd(text, start + label.length);
          rects.push(range.getBoundingClientRect().top);
        }
      }
      return { whiteSpace: getComputedStyle(element).whiteSpace, rects };
    });
    expect(lineBreakLayout.whiteSpace).toBe("normal");
    await expect(softBreaks.locator("br")).toHaveCount(4);
    expect(lineBreakLayout.rects).toHaveLength(4);
    expect(new Set(lineBreakLayout.rects).size).toBe(4);
    const end = body.getByText(lastLine, { exact: true });
    await end.scrollIntoViewIfNeeded();
    await expect(end).toBeInViewport({ ratio: 1 });
    await expect
      .poll(() =>
        page
          .locator(".primary-panel > main")
          .evaluate((element) => element.scrollTop),
      )
      .toBeGreaterThan(0);
    await page.screenshot({
      path: info.outputPath("task-description-end.png"),
    });
    // Confirm content was never rewritten by a display-only fix.
    const items = await (
      await page.request.get("/api/platform/tasks?owner=all&limit=100")
    ).json();
    expect(
      items.find(
        (item: { title: string }) =>
          item.title === "TEST 完整事项正文 " + configuration.name,
      ).description,
    ).toBe(description);
  });

test("事项当前正文自动接收外部新版本，显式历史阅读不被新版本抢走", async ({
  page,
}) => {
  await page.goto("/");
  await openLibrary(page);
  const title = "TEST 事项当前与历史阅读 " + crypto.randomUUID();
  await seedLibraryArtifact(page, title, humanTask("TEST 第一版原始正文"));
  const body = page.getByLabel("事项说明", { exact: true });
  await expect(body).toHaveText("TEST 第一版原始正文");
  const tasks = await (
    await page.request.get("/api/platform/tasks?owner=all&limit=100")
  ).json();
  const task = tasks.find((item: { title: string }) => item.title === title);
  expect(task.revision).toBe(1);
  const bootstrap = await (
    await page.request.get("/api/platform/bootstrap")
  ).json();
  const revise = async (revision: number, description: string) => {
    const response = await page.request.post("/api/platform/tasks/revise", {
      headers: {
        "X-Morphz-Token": bootstrap.csrfToken,
        Origin: new URL(page.url()).origin,
      },
      data: {
        commandId: crypto.randomUUID(),
        taskId: task.id,
        expectedRevision: revision,
        description,
      },
    });
    expect(response.ok()).toBe(true);
  };
  await revise(1, "TEST 第二版自动更新正文");
  // Background polling is 5 s; leave budget for the actual version read.
  // No reload/focus/manual refresh is used to make this assertion pass.
  await expect(body).toHaveText("TEST 第二版自动更新正文", { timeout: 10_000 });
  await page.getByRole("button", { name: "版本历史", exact: true }).click();
  const versions = page.getByLabel("查看版本", { exact: true });
  await expect(versions.locator("option")).toHaveCount(2);
  await versions.selectOption("1");
  await expect(body).toHaveText("TEST 第一版原始正文");
  await revise(2, "TEST 第三版最新正文");
  await expect(versions.locator("option")).toHaveCount(3, { timeout: 10_000 });
  await expect(versions).toHaveValue("1");
  await expect(body).toHaveText("TEST 第一版原始正文");
  await page.getByRole("button", { name: "回到当前版本", exact: true }).click();
  await expect(body).toHaveText("TEST 第三版最新正文");
  const persisted = await (
    await page.request.get(`/api/platform/tasks/${task.id}/version?revision=1`)
  ).json();
  expect(persisted.description).toBe("TEST 第一版原始正文");
});
