import { test, expect } from "@playwright/test";

test("PDF 附件调宽后文字不叠加，分页与草稿保持，不创建内容", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "对话", exact: true }).click();
  const before = await (await page.request.get("/api/workspace")).json();
  const input = page.getByLabel("AI 输入内容");
  await input.fill("PDF 附件回归，不发送");
  await page
    .getByLabel("消息附件文件")
    .setInputFiles("tests/fixtures/reader.pdf");
  await page
    .getByRole("button", { name: "预览附件 reader.pdf", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "附件预览：reader.pdf" });
  const layer = dialog.locator(".pdf-text-layer");
  await expect(layer).toContainText("DESIGN NOTES");
  await expect(dialog.getByText("正在渲染第 1 页…")).toHaveCount(0);
  const originalText = await layer.textContent();
  const originalCount = await layer.locator("span").count();
  const widths: number[] = [];
  for (const width of [1440, 760, 390, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    await expect(layer).toContainText("DESIGN NOTES");
    await expect
      .poll(async () =>
        dialog.locator(".pdf-page").evaluate((element) => {
          const canvas = element.querySelector("canvas")!;
          const text = element.querySelector(".pdf-text-layer")!;
          return Math.abs(
            canvas.getBoundingClientRect().width -
              text.getBoundingClientRect().width,
          );
        }),
      )
      .toBeLessThan(2);
    await expect(layer).toHaveText(originalText!);
    await expect(layer.locator("span")).toHaveCount(originalCount);
    widths.push(
      (await dialog.locator(".pdf-page canvas").boundingBox())!.width,
    );
  }
  expect(Math.max(...widths) - Math.min(...widths)).toBeGreaterThan(100);
  await dialog.getByRole("button", { name: "附件下一页" }).click();
  await expect(layer).toContainText("durable butterfly");
  await dialog.getByRole("button", { name: "附件上一页" }).click();
  await expect(layer).toHaveText(originalText!);
  await expect(layer.locator("span")).toHaveCount(originalCount);
  await dialog.getByRole("button", { name: "关闭附件预览" }).click();
  await expect(input).toHaveValue("PDF 附件回归，不发送");
  await expect(
    page.getByRole("button", { name: "移除附件 reader.pdf" }),
  ).toBeVisible();
  const after = await (await page.request.get("/api/workspace")).json();
  expect(after.workspace.artifacts).toEqual(before.workspace.artifacts);
  expect(after.workspace.inputs).toEqual(before.workspace.inputs);
  expect(errors).toEqual([]);
});
