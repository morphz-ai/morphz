import type { Locator } from "@playwright/test";
import { test, expect } from "./project-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";

async function centerHit(control: Locator) {
  return control.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    return {
      inside: Boolean(hit && element.contains(hit)),
      target: hit?.tagName ?? null,
      className: hit?.getAttribute("class") ?? null,
    };
  });
}

for (const appearance of ["light", "dark"] as const) {
  for (const viewport of [
    { width: 760, height: 540 },
    { width: 1440, height: 960 },
  ]) {
    test(`图标侧栏底部更多与身份独立占位和命中：${appearance} ${viewport.width}×${viewport.height}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.goto("/");
      await page
        .getByRole("navigation", { name: "主导航", exact: true })
        .getByRole("button", { name: "对话", exact: true })
        .click();
      const input = await openInput(page);
      const draft = `TEST 底部控件不重叠 ${appearance} ${viewport.width}`;
      await input.fill(draft);
      const handle = page.getByRole("separator", {
        name: "调整左侧栏宽度",
        exact: true,
      });
      await handle.focus();
      await handle.press("Home");
      const sidebar = page.getByRole("complementary", {
        name: "工作空间导航",
        exact: true,
      });
      await expect(page.locator(".app")).toHaveClass(/sidebar-compact/);
      await expect
        .poll(async () => Math.round((await sidebar.boundingBox())!.width))
        .toBe(80);
      await page.evaluate((appearance) => {
        document.documentElement.dataset.appearance = appearance;
        document.querySelector<HTMLElement>(".app")!.dataset.appearance =
          appearance;
      }, appearance);

      const more = sidebar.getByRole("button", { name: "更多", exact: true });
      const controls = sidebar.locator(".compact-sidebar-controls");
      const account = sidebar.locator(".sidebar-bottom .profile-trigger");
      await expect(more).toBeVisible();
      await expect(more).toBeInViewport();
      await expect(account).toBeVisible();
      await expect(account).toBeInViewport();
      const moreBox = (await more.boundingBox())!;
      const accountBox = (await account.boundingBox())!;
      const moreIconBox = (await more.locator("svg").boundingBox())!;
      const accountIconBox = (await account
        .locator(".avatar svg")
        .boundingBox())!;
      const navCenters = await sidebar
        .locator("nav > button")
        .evaluateAll((buttons) =>
          buttons.map((button) => {
            const bounds = button.getBoundingClientRect();
            return bounds.top + bounds.height / 2;
          }),
        );
      await testInfo.attach("footer-geometry", {
        contentType: "application/json",
        body: JSON.stringify(
          {
            appearance,
            viewport,
            moreTarget: moreBox,
            accountTarget: accountBox,
            targetGap: accountBox.y - moreBox.y - moreBox.height,
            centerGap:
              accountBox.y +
              accountBox.height / 2 -
              moreBox.y -
              moreBox.height / 2,
            svgBoxGap: accountIconBox.y - moreIconBox.y - moreIconBox.height,
            navCenterSteps: navCenters
              .slice(1)
              .map((center, index) => center - navCenters[index]!),
          },
          null,
          2,
        ),
      });
      // Assert whole hit areas first. Icon centers alone can look separated
      // while a flex:0 container lets More overflow onto the account control.
      expect(moreBox.y + moreBox.height).toBeLessThanOrEqual(accountBox.y - 8);
      const container = await controls.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          top: bounds.top,
          bottom: bounds.bottom,
          height: bounds.height,
          padding:
            parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
        };
      });
      expect(container.height).toBeGreaterThanOrEqual(
        moreBox.height + container.padding,
      );
      expect(moreBox.y).toBeGreaterThanOrEqual(container.top);
      expect(moreBox.y + moreBox.height).toBeLessThanOrEqual(container.bottom);
      const moreIcon = (await more.locator("svg").boundingBox())!;
      const accountIcon = (await account.locator(".avatar svg").boundingBox())!;
      expect(moreIcon.y + moreIcon.height).toBeLessThanOrEqual(accountIcon.y);
      expect((await centerHit(more)).inside).toBe(true);
      expect((await centerHit(account)).inside).toBe(true);

      // Use coordinate mouse clicks after checking the actual hit-test map.
      await page.mouse.click(
        moreBox.x + moreBox.width / 2,
        moreBox.y + moreBox.height / 2,
      );
      const moreMenu = page.locator(
        `[id="${await more.getAttribute("aria-controls")}"]`,
      );
      await expect(moreMenu).toBeVisible();
      await expect(moreMenu).toHaveAttribute("aria-label", "侧栏选项");
      await page.keyboard.press("Escape");
      await expect(moreMenu).toBeHidden();
      await expect(more).toBeFocused();

      // A deployment without logout has an informational identity group, not
      // a fictional account button. Check whichever the real Host exposes.
      const accountTag = await account.evaluate((element) => element.tagName);
      if (accountTag === "BUTTON") {
        await expect(account).toHaveAccessibleName("用户菜单");
        await page.mouse.click(
          accountBox.x + accountBox.width / 2,
          accountBox.y + accountBox.height / 2,
        );
        const accountMenu = page.locator(
          `[id="${await account.getAttribute("aria-controls")}"]`,
        );
        await expect(accountMenu).toBeVisible();
        await expect(accountMenu).toHaveAttribute("aria-label", "用户菜单");
        await expect(
          accountMenu.getByRole("button", {
            name: "退出当前身份",
            exact: true,
          }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(accountMenu).toBeHidden();
        await expect(account).toBeFocused();
      } else {
        expect(accountTag).toBe("DIV");
        await expect(account).toHaveAttribute("role", "group");
        await expect(account).toHaveAccessibleName("当前身份");
        await expect(account).toHaveAttribute("title", /\S/);
        await expect(account).toHaveAttribute("aria-description", /\S/);
        await expect(account).not.toHaveAttribute("aria-controls");
      }
      await expect(input).toHaveValue(draft);
      await expect(page.locator(".human-message")).toHaveCount(0);
    });
  }
}
