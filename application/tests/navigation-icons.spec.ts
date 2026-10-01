import { type Locator } from "@playwright/test";
import {
  test,
  expect,
  conversationClient,
} from "./project-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";
import { openSettings } from "./settings-helpers.js";

const entries = [
  { kind: "dialogue", name: "对话", toolbar: "对话工具栏" },
  { kind: "inbox", name: /^事项 \d+$/, toolbar: "事项工具栏" },
  { kind: "content", name: "内容库", toolbar: "内容库工具栏" },
  { kind: "desk", name: "工作台", toolbar: "工作台工具栏" },
  { kind: "projects", name: "项目", toolbar: "项目工具栏" },
] as const;

async function expectInheritedColor(icon: Locator, token: "accent" | "muted") {
  await expect
    .poll(() =>
      icon.evaluate((element, token) => {
        const probe = document.createElement("span");
        probe.hidden = true;
        probe.style.color = `var(--${token})`;
        element.closest(".app")!.append(probe);
        const expected = getComputedStyle(probe).color;
        probe.remove();
        const actual = getComputedStyle(element);
        return {
          matchesTheme: actual.color === expected,
          inheritsStroke: actual.stroke === actual.color,
        };
      }, token),
    )
    .toEqual({ matchesTheme: true, inheritsStroke: true });
}

test("五个原导航使用独立图形，工作台三卡和项目文件夹在亮暗及展开图标栏保持操作语义", async ({
  page,
}) => {
  await page.goto("/");
  const source = await conversationClient(page);
  const { deskId } = await source.ensurePersonalSpaces();
  const deskTitle = (await source.project(deskId)).title;
  const nav = page.getByRole("navigation", { name: "主导航", exact: true });
  await nav.getByRole("button", { name: "对话", exact: true }).click();
  const input = await openInput(page);
  const draft = "TEST 导航图标替换不改草稿或消息";
  await input.fill(draft);
  const handle = page.getByRole("separator", {
    name: "调整左侧栏宽度",
    exact: true,
  });

  for (const [label, appearance] of [
    ["亮色", "light"],
    ["暗色", "dark"],
  ] as const) {
    await handle.focus();
    await page.keyboard.press("End");
    await expect(page.locator(".app")).not.toHaveClass(/sidebar-compact/);
    const settings = await openSettings(page, "外观");
    await settings.getByRole("button", { name: label, exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".app")).toHaveAttribute(
      "data-appearance",
      appearance,
    );

    for (const compact of [false, true]) {
      await handle.focus();
      await page.keyboard.press(compact ? "Home" : "End");
      if (compact)
        await expect(page.locator(".app")).toHaveClass(/sidebar-compact/);
      else
        await expect(page.locator(".app")).not.toHaveClass(/sidebar-compact/);
      await expect(nav.getByRole("button")).toHaveCount(5);
      const glyphs = nav.locator("svg.navigation-icon");
      await expect(glyphs).toHaveCount(5);
      expect(
        await glyphs.evaluateAll((icons) =>
          icons.map((icon) => icon.getAttribute("data-navigation-icon")),
        ),
      ).toEqual(entries.map(({ kind }) => kind));
      const signatures = await glyphs.evaluateAll((icons) =>
        icons.map((icon) => icon.innerHTML),
      );
      expect(new Set(signatures).size).toBe(5);
      await expect(nav.getByRole("img")).toHaveCount(0);

      // B is one tall left card plus two independent right cards, not a grid.
      const desk = nav.locator('svg[data-navigation-icon="desk"]');
      await expect(desk.locator("rect")).toHaveCount(3);
      await expect(desk.locator("path, circle")).toHaveCount(0);
      expect(
        await desk
          .locator("rect")
          .evaluateAll((cards) =>
            cards.map((card) =>
              ["x", "y", "width", "height"].map((key) =>
                Number(card.getAttribute(key)),
              ),
            ),
          ),
      ).toEqual([
        [3, 3, 7, 18],
        [14, 3, 7, 7],
        [14, 14, 7, 7],
      ]);
      // A retains a single folder body and tab; no stacked-project motif.
      const projects = nav.locator('svg[data-navigation-icon="projects"]');
      await expect(projects.locator("path")).toHaveCount(1);
      await expect(projects.locator("rect, circle")).toHaveCount(0);
      await expect(projects.locator("path")).toHaveAttribute(
        "d",
        "M3 7a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.4.6L13 8h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
      );

      for (const { kind, name, toolbar } of entries) {
        const button = nav.getByRole("button", { name, exact: true });
        await expect(button).toBeInViewport();
        await expect(button).toHaveAccessibleName(name);
        const icon = button.locator(`svg[data-navigation-icon="${kind}"]`);
        await expect(icon).toHaveAttribute("aria-hidden", "true");
        await expect(icon).toHaveAttribute("focusable", "false");
        await expect(icon).toHaveAttribute("fill", "none");
        await expect(icon).toHaveAttribute("stroke", "currentColor");
        await expect(icon).toHaveCSS("stroke-width", "2px");
        const size = compact ? 24 : 17;
        await expect(icon).toHaveCSS("width", `${size}px`);
        await expect(icon).toHaveCSS("height", `${size}px`);
        const bounds = (await icon.boundingBox())!;
        expect(bounds.width).toBe(size);
        expect(bounds.height).toBe(size);
        if (compact)
          expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(
            44,
          );

        await button.click();
        await expect(button).toHaveAttribute("aria-current", "page");
        await expect(nav.locator('button[aria-current="page"]')).toHaveCount(1);
        await expect(page.locator(".topbar")).toHaveAttribute(
          "aria-label",
          kind === "desk" ? `${deskTitle}工具栏` : toolbar,
        );
        await expectInheritedColor(icon, "accent");
        const unselected = nav.locator(
          'button:not([aria-current="page"]) svg.navigation-icon',
        );
        await expect(unselected).toHaveCount(4);
        for (const other of await unselected.all())
          await expectInheritedColor(other, "muted");
      }

      const more = page
        .getByRole("complementary", { name: "工作空间导航", exact: true })
        .getByRole("button", { name: "更多", exact: true });
      if (compact) {
        await expect(more).toBeInViewport();
        await expect(more.locator("svg")).toHaveCSS("width", "20px");
        await expect(more.locator("svg")).toHaveCSS("height", "20px");
        await expect(more.locator(".navigation-icon")).toHaveCount(0);
      } else await expect(more).toBeHidden();
    }
  }
  await nav.getByRole("button", { name: "对话", exact: true }).click();
  await expect(await openInput(page)).toHaveValue(draft);
  await expect(page.locator(".human-message")).toHaveCount(0);
});
