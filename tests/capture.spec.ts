import { openLibrary } from "./application-helpers.js";
import { test, expect } from "@playwright/test";
test("截图先预览，确认才上传，并保留当前对象关联", async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.set(window, "morphzDesktop", { capture: {
      select: async () => ({ mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKp8AAAAASUVORK5CYII=" }),
      cancel: async () => {},
    } });
  });
  let uploads = 0; page.on("request", (request) => { if (request.url().endsWith("/api/assets") && request.method() === "POST") uploads++; });
  await page.goto("/");
  await openLibrary(page);
  await page.getByRole("button", { name: "新建文档", exact: true }).click();
  await page.getByLabel("新对象标题").fill("截图关联来源");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("button", { name: "截图输入", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "截图输入", exact: true });
  await dialog.getByRole("button", { name: "选择窗口或区域", exact: true }).click();
  await expect(dialog.getByAltText("待确认的截图")).toBeVisible();
  expect(uploads).toBe(0);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  expect(uploads).toBe(0);
  await page.getByRole("button", { name: "截图输入", exact: true }).click();
  await dialog.getByRole("button", { name: "选择窗口或区域", exact: true }).click();
  await dialog.getByLabel("截图标题").fill("手动选择的测试图");
  await dialog.getByRole("button", { name: "保存为对象", exact: true }).click();
  await expect(page.getByRole("heading", { name: "手动选择的测试图", exact: true })).toBeVisible();
  expect(uploads).toBe(1);
  await expect(page.locator(".artifact-image")).toBeVisible();
  const boot = await (await page.request.get("/api/workspace")).json();
  const artifact = boot.workspace.artifacts.find((a: { title: string }) => a.title === "手动选择的测试图");
  expect(artifact.content.alt).toContain("v1");
  expect(boot.workspace.relations.some((r: { fromId: string; type: string }) => r.fromId === artifact.id && r.type === "references")).toBe(true);
});
