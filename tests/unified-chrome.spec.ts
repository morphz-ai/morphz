import { test, expect } from "@playwright/test";
import { openLibrary } from "./application-helpers.js";

test("页面标题与操作共用顶栏，内容无第二层标题区；窄窗口保持可操作", async ({
  page,
}) => {
  await page.goto("/");
  const bar = page.locator(".topbar");
  const nav = page.getByRole("navigation", { name: "主导航" });
  const connected = async () => {
    const bounds = (await bar.boundingBox())!;
    const main = (await page
      .getByRole("main", { name: "主工作区" })
      .boundingBox())!;
    expect(bounds.height).toBe(48);
    expect(main.y).toBe(bounds.y + bounds.height);
    await expect(bar).toHaveCSS("border-bottom-width", "0px");
    expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
    expect(
      await bar.evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe(
      await page
        .locator(".workspace")
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    );
    await expect(
      page.locator(
        "main .collection-title, main .launcher-heading, main .intro",
      ),
    ).toHaveCount(0);
  };
  for (const width of [1440, 1000, 760]) {
    await page.setViewportSize({ width, height: 800 });
    await nav.getByRole("button", { name: /^事项/ }).click();
    await expect(
      bar.getByRole("heading", { name: "事项", exact: true }),
    ).toHaveCSS("font-size", "22px");
    await expect(
      bar.getByRole("button", { name: "新建事项", exact: true }),
    ).toBeVisible();
    if (width === 1440) {
      await bar.getByRole("button", { name: "全部", exact: true }).click();
      await expect(
        bar.getByRole("button", { name: "全部", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
    } else if (width === 760) {
      await bar.getByRole("button", { name: /^筛选事项：/ }).click();
      const filter = page.getByRole("group", { name: "筛选事项", exact: true });
      await filter.getByLabel("事项负责人筛选").selectOption("mine");
      await filter.getByLabel("事项状态筛选").selectOption("open");
      await expect(filter.getByLabel("事项负责人筛选")).toHaveValue("mine");
      await expect(filter.getByLabel("事项状态筛选")).toHaveValue("open");
      await page.keyboard.press("Escape");
    }
    await connected();
    await page.screenshot({
      path: `test-results/unified-matters-${width}.png`,
    });
    await bar.getByRole("button", { name: "新建事项", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByLabel("AI 输入内容")).toBeFocused();
    await expect(page.locator(".composer-intent")).toContainText("安排事项");
    await page.keyboard.press("Escape");
    await expect(
      bar.getByRole("button", { name: "新建事项", exact: true }),
    ).toBeFocused();

    await nav.getByRole("button", { name: "项目", exact: true }).click();
    await expect(
      bar.getByRole("heading", { name: "项目", exact: true }),
    ).toBeVisible();
    await bar
      .getByLabel("搜索项目", { exact: true })
      .fill("不存在的项目-单层界面");
    await expect(
      page.getByRole("heading", { name: "没有找到这个项目" }),
    ).toBeVisible();
    await connected();
    await bar.getByLabel("搜索项目", { exact: true }).clear();
    await page.screenshot({
      path: `test-results/unified-projects-${width}.png`,
    });

    await nav.getByRole("button", { name: "工作台", exact: true }).click();
    await bar.getByRole("button", { name: "应用启动台", exact: true }).click();
    await expect(
      bar.getByRole("heading", { name: "工作台", exact: true }),
    ).toBeVisible();
    await expect(
      bar.getByRole("button", { name: "安装应用", exact: true }),
    ).toBeVisible();
    await connected();
    // Continue-work and folder controls are content, not another title strip.
    const grid = (await page.locator(".application-launcher").boundingBox())!;
    const bounds = (await bar.boundingBox())!;
    expect(grid.y - bounds.y - bounds.height).toBeLessThanOrEqual(8);
    await page.screenshot({
      path: `test-results/unified-launcher-${width}.png`,
    });
  }
  await openLibrary(page);
  await page.getByRole("button", { name: "手动写文档", exact: true }).click();
  await expect(
    bar.getByRole("heading", { name: "新建文档", exact: true }),
  ).toBeVisible();
  await expect(page.locator("main .document-draft header")).toHaveCount(0);
  await page.getByLabel("新对象标题", { exact: true }).fill("标题栏整合验证");
  await page
    .getByLabel("新文档正文")
    .fill("保留文档自己的内容标题，宿主不再重复展示标题与工具栏。");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.locator(".object-paper > h1")).toHaveText("标题栏整合验证");
  await expect(
    bar.getByRole("button", { name: "编辑", exact: true }),
  ).toBeVisible();
  await expect(page.locator("main .object-toolbar")).toHaveCount(0);
  await connected();
});
