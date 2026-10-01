import { test, expect } from "@playwright/test";

test("没有本机目录桥的 Web 页面不显示授权入口，也不阻止普通输入", async ({
  page,
}) => {
  let bootstrapOverrides = 0;
  await page.route("**/api/platform/bootstrap", async (route) => {
    const { "if-none-match": _etag, ...headers } = route.request().headers();
    const response = await route.fetch({ headers });
    if (response.status() !== 200) {
      await route.fulfill({ response });
      return;
    }
    const boot = await response.json();
    bootstrapOverrides += 1;
    await route.fulfill({
      response,
      json: {
        ...boot,
        capabilities: { ...boot.capabilities, localFiles: true },
      },
    });
  });
  await page.goto("/");
  await expect.poll(() => bootstrapOverrides).toBeGreaterThan(0);
  await page.getByRole("button", { name: "对话", exact: true }).click();
  const input = page.getByLabel("AI 输入内容");
  await input.fill("TEST 无本机目录桥仍可发送普通输入");
  await expect(
    page.getByRole("button", { name: "授权 Agent 读写目录", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(
    page.getByText("TEST 无本机目录桥仍可发送普通输入", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/目录授权尚未确认/)).toHaveCount(0);
});
