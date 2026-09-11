import { test, expect, type Locator } from "@playwright/test";

test("项目与会话整行呈现悬停背景，子按钮不叠色，键盘焦点保留", async ({
  page,
}) => {
  await page.goto("/");
  const project = page.getByRole("group", {
    name: "我的项目的会话",
    exact: true,
  });
  const heading = project.locator(".sidebar-project-heading");
  const create = project.getByLabel("新建项目对话：我的项目", { exact: true });
  const away = page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true });
  // The restored canvas may contain an iframe. Use a known host control as
  // the off-row target, rather than a coordinate inside an unrelated app.
  await away.hover();
  await expect(create).toHaveCSS("opacity", "0");
  await heading.hover();
  await expect(create).toHaveCSS("opacity", "1");
  await create.click();
  await page.getByLabel("AI 输入内容").fill("侧栏选中态验收");
  await page.getByLabel("AI 输入内容").press("Enter");
  const conversation = project.locator(
    '.project-conversation-row[data-selected="true"]',
  );
  await expect(conversation).toHaveCount(1);
  const transparent = async (button: Locator) => {
    await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  };
  const tokenColor = (token: string) =>
    page.locator(".app").evaluate((app, token) => {
      const probe = document.createElement("span");
      probe.hidden = true;
      probe.style.backgroundColor = `var(${token})`;
      app.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    }, token);
  for (const appearance of ["亮色", "暗色"]) {
    for (const theme of ["电光青", "鸢尾紫", "暖珊瑚", "纯单色"]) {
      await page.getByRole("button", { name: "外观设置", exact: true }).click();
      await page.getByRole("button", { name: appearance, exact: true }).click();
      await page.getByRole("button", { name: theme, exact: true }).click();
      await away.hover();
      await expect(create).toHaveCSS("opacity", "0");
      // A named Session, not its project parent, owns the selected state.
      await expect(heading).toHaveAttribute("data-active", "false");
      await expect(heading).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      for (const [row, token] of [
        [heading, "--nav-hover"],
        [conversation, "--nav-selected"],
      ] as const) {
        await row.hover();
        // Compare settled theme colors, not a frame midway through the switch.
        await expect(row).toHaveCSS(
          "background-color",
          await tokenColor(token),
        );
        const selected = await row.evaluate(
          (el) => getComputedStyle(el).backgroundColor,
        );
        expect(selected).not.toBe("rgba(0, 0, 0, 0)");
        for (const button of await row.locator(":scope > button").all()) {
          await button.hover();
          await transparent(button);
          await expect(row).toHaveCSS("background-color", selected);
        }
      }
      await heading.locator(".project-link").hover();
      await expect(create).toHaveCSS("opacity", "1");
      await project.screenshot({
        path: `test-results/sidebar-hover-${appearance}-${theme}.png`,
      });
    }
  }
  // A non-selected row also highlights as one surface, not just its text button.
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await expect(heading).toHaveAttribute("data-active", "false");
  await heading.locator(".project-link").hover();
  await expect(heading).toHaveCSS(
    "background-color",
    await tokenColor("--nav-hover"),
  );
  const hover = await heading.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  expect(hover).not.toBe("rgba(0, 0, 0, 0)");
  await transparent(heading.locator(".project-link"));
  await heading.locator(".project-new-conversation").hover();
  await transparent(heading.locator(".project-new-conversation"));
  await expect(heading).toHaveCSS("background-color", hover);
  await away.hover();
  await expect(heading).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(create).toHaveCSS("opacity", "0");
  await heading.locator(".project-link").focus();
  await page.keyboard.press("Tab");
  await expect(heading.locator(".project-disclosure")).toBeFocused();
  await expect(heading.locator(".project-disclosure")).toHaveCSS(
    "outline-style",
    "solid",
  );
  await expect(heading.locator(".project-disclosure")).toHaveCSS(
    "outline-width",
    "2px",
  );
  await expect(create).toHaveCSS("opacity", "1");
  await page.keyboard.press("Tab");
  await expect(create).toBeFocused();
  await expect(create).toHaveCSS("opacity", "1");
});

test.describe("没有鼠标悬停的设备", () => {
  test.use({ hasTouch: true });
  test("新建会话保持可见", async ({ page }) => {
    await page.goto("/");
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(
      true,
    );
    await expect(
      page.getByLabel("新建项目对话：我的项目", { exact: true }),
    ).toHaveCSS("opacity", "1");
  });
});
