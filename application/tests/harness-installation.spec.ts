import { expect, type Page } from "@playwright/test";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";
import { openSettings } from "./settings-helpers.js";

const current = [
  { id: "TEST.script-studio", version: "2.0.0", title: "剧本创作" },
];
const old = [{ id: "TEST.script-studio", version: "1.4.4", title: "剧本创作" }];

async function openHarnesses(page: Page) {
  const panel = page.getByRole("complementary", {
    name: "Morphz 信息",
    exact: true,
  });
  if (!(await panel.isVisible()))
    await page.getByRole("button", { name: "显示右侧栏", exact: true }).click();
  await panel.getByRole("tab", { name: "设定", exact: true }).click();
  const capabilities = panel.locator("details.subject-settings-system");
  if (!(await capabilities.evaluate((e) => (e as HTMLDetailsElement).open)))
    await capabilities.locator(":scope > summary").click();
  const harnesses = panel.locator("details.subject-harnesses");
  if (!(await harnesses.evaluate((e) => (e as HTMLDetailsElement).open)))
    await harnesses.locator(":scope > summary").click();
  return { panel, harnesses };
}

test("安装入口只显示当前版，旧执行包独立标注；八种主题、窄栏和放大布局一致", async ({
  page,
}, info) => {
  await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      harnesses: current,
      retainedHarnesses: old,
    },
  }));
  await page.goto("/");
  const { panel, harnesses } = await openHarnesses(page);
  await expect(harnesses.locator(":scope > p")).toHaveCount(1);
  await expect(harnesses.locator(":scope > p")).toHaveText("剧本创作2.0.0");
  await expect(harnesses.locator(".subject-harness-retained")).toContainText(
    "未完成工作仍在使用",
  );
  await expect(harnesses.locator(".subject-harness-retained p")).toHaveText(
    "剧本创作1.4.4",
  );
  await expect(harnesses.locator("button")).toHaveCount(0);
  for (const appearance of ["亮色", "暗色"]) {
    for (const color of ["电光青", "鸢尾紫", "暖珊瑚", "纯单色"]) {
      await openSettings(page, "外观");
      await page.getByRole("button", { name: appearance, exact: true }).click();
      await page.getByRole("button", { name: color, exact: true }).click();
      await page.keyboard.press("Escape");
      for (const layout of ["normal", "narrow", "zoom"] as const) {
        await page.setViewportSize(
          layout === "narrow"
            ? { width: 900, height: 760 }
            : { width: 1440, height: 960 },
        );
        await page.evaluate(
          (zoom) => {
            document.documentElement.style.zoom = String(zoom);
          },
          layout === "zoom" ? 2 : 1,
        );
        const { harnesses } = await openHarnesses(page);
        await expect(harnesses.locator(":scope > p small")).toHaveText("2.0.0");
        const geometry = await harnesses.evaluate((e) => {
          const rows = [...e.querySelectorAll("p")];
          const versions = rows.map((p) =>
            p.querySelector("small")!.getBoundingClientRect(),
          );
          return {
            overflow: e.scrollWidth > e.clientWidth + 1,
            alignment: Math.abs(versions[0]!.right - versions[1]!.right),
            rowsOverflow: rows.some((p) => p.scrollWidth > p.clientWidth + 1),
          };
        });
        expect(geometry).toEqual({
          overflow: false,
          alignment: 0,
          rowsOverflow: false,
        });
      }
      await page.evaluate(() => {
        document.documentElement.style.zoom = "1";
      });
      await page.setViewportSize({ width: 1440, height: 960 });
      await panel.screenshot({
        path: info.outputPath(`installed-harnesses-${appearance}-${color}.png`),
      });
    }
  }
});

test("任务完成后旧版条目消失，安装折叠和输入草稿保留；查看列表不发送或改授权", async ({
  page,
}) => {
  let retained = old;
  const fixture = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      harnesses: current,
      retainedHarnesses: retained,
    },
  }));
  await page.goto("/");
  const draft = "TEST 未发送的草稿";
  await (await openInput(page)).fill(draft);
  const writes: string[] = [];
  page.on("request", (r) => {
    if (
      r.method() === "POST" &&
      /\/(?:messages|conversations\/start|connection\/save|model-settings\/save)(?:\?|$)/.test(
        r.url(),
      )
    )
      writes.push(r.url());
  });
  const { panel, harnesses } = await openHarnesses(page);
  await expect(harnesses.locator(".subject-harness-retained")).toBeVisible();
  retained = [];
  await fixture.refresh();
  await expect(harnesses.locator(".subject-harness-retained")).toHaveCount(0);
  await expect(harnesses).toHaveAttribute("open", "");
  await expect(harnesses.locator(":scope > p small")).toHaveText("2.0.0");
  await expect(await openInput(page)).toHaveValue(draft);
  await harnesses.locator(":scope > summary").focus();
  await page.keyboard.press("Space");
  await expect(harnesses).not.toHaveAttribute("open", "");
  await panel.getByRole("tab", { name: "活动", exact: true }).click();
  await panel.getByRole("tab", { name: "设定", exact: true }).click();
  await expect(panel.locator("details.subject-harnesses")).not.toHaveAttribute(
    "open",
    "",
  );
  expect(writes).toEqual([]);
});
