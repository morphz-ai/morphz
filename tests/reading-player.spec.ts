import { openSettings } from "./settings-helpers.js";
import { test, expect } from "@playwright/test";
import { seedLibraryArtifact } from "./artifact-fixtures.js";
import { openLibrary } from "./application-helpers.js";
import { wavFromPCM } from "../packages/core/src/audio.js";

test("紧凑朗读控件不重复标题，短句显示真实音频进度，展开才显示详情", async ({
  page,
}) => {
  // Synthetic tone checks UI/decoding only; live service acceptance is separate.
  const samples = new Int16Array(16000 * 8);
  for (let i = 0; i < samples.length; i++)
    samples[i] = Math.round(Math.sin((i * 2 * Math.PI * 220) / 16000) * 3000);
  let requests = 0;
  await page.route("**/api/speech/synthesize", (route) => {
    requests++;
    return route.fulfill({
      contentType: "audio/wav",
      body: Buffer.from(wavFromPCM(new Uint8Array(samples.buffer))),
    });
  });
  await page.goto("/");
  await openLibrary(page);
  await seedLibraryArtifact(page, "紧凑朗读验收", {
    kind: "document",
    markdown: "这是一句简短的朗读内容。",
  });
  await page.getByRole("button", { name: "朗读对象", exact: true }).click();
  const reader = page.getByRole("region", { name: "朗读对象", exact: true });
  await expect(reader).not.toContainText("紧凑朗读验收");
  await expect(reader.locator("textarea")).toHaveCount(0);
  await expect(reader.getByLabel("朗读文字")).toHaveCount(0);
  await expect(reader.getByLabel("朗读进度")).toBeDisabled();
  expect(requests).toBe(0);
  for (const width of [1440, 1024, 760]) {
    await page.setViewportSize({ width, height: 700 });
    const bounds = (await reader.boundingBox())!;
    expect(bounds.height).toBeLessThanOrEqual(64);
    expect(await reader.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
      true,
    );
    await reader.screenshot({
      path: `test-results/reading-player-${width}.png`,
    });
  }
  await reader.getByRole("button", { name: "朗读", exact: true }).click();
  await expect(reader.getByLabel("朗读进度")).toBeEnabled();
  await expect
    .poll(async () => Number(await reader.getByLabel("朗读进度").inputValue()))
    .toBeGreaterThan(0);
  await expect(reader.getByLabel("朗读进度")).toHaveAttribute("max", "8");
  await reader.getByRole("button", { name: "暂停朗读" }).click();
  await reader.getByLabel("朗读进度").fill("4");
  await expect(reader.locator(".reading-time")).toHaveText("0:04 / 0:08");
  await reader.getByRole("button", { name: "朗读内容与章节" }).click();
  await expect(reader.getByLabel("朗读文字")).toHaveText(
    "这是一句简短的朗读内容。",
  );
  await reader.getByRole("button", { name: "朗读内容与章节" }).click();
  await openSettings(page, "外观");
  await page.getByRole("button", { name: "暗色", exact: true }).click();
  await page.keyboard.press("Escape");
  await reader.screenshot({ path: "test-results/reading-player-dark.png" });
  await reader.getByRole("button", { name: "继续朗读" }).click();
  await expect
    .poll(async () => Number(await reader.getByLabel("朗读进度").inputValue()))
    .toBeGreaterThan(4);
  expect(requests).toBe(1);
  await reader.getByRole("button", { name: "关闭朗读" }).click();
  await expect(reader).toHaveCount(0);
  await page.getByRole("button", { name: "朗读对象", exact: true }).click();
  await expect(reader.getByRole("button", { name: "继续朗读" })).toBeEnabled();
  // Saved seconds are not a known duration. Do not draw a full progress bar.
  await expect(reader.getByLabel("朗读进度")).toHaveValue("0");
  await expect(reader.getByLabel("朗读进度")).toBeDisabled();
  expect(requests).toBe(1);
});
