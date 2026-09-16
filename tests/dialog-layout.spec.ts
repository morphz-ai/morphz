import { test, expect, type Locator, type Page } from "@playwright/test";
import { openInput, openTranscription } from "./interaction-helpers.js";

async function syntheticImage(page: Page, width: number, height: number) {
  return page.evaluate(
    ({ width, height }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#f0f2f3";
      context.fillRect(0, 0, width, height);
      context.fillStyle = "#182124";
      context.font = "32px sans-serif";
      context.fillText("Morphz / Screenshot layout test", 24, 54);
      context.fillStyle = "#38b7c6";
      for (let y = 88; y < height; y += 72)
        context.fillRect(24, y, width - 48, 2);
      return canvas.toDataURL("image/png").split(",")[1]!;
    },
    { width, height },
  );
}

async function assertContained(dialog: Locator) {
  await expect
    .poll(() =>
      dialog.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const outside = [
          ...element.querySelectorAll("button,input,textarea,img"),
        ]
          .filter((child) => child.getClientRects().length)
          .filter((child) => {
            const rect = child.getBoundingClientRect();
            return (
              rect.left < box.left - 1 ||
              rect.right > box.right + 1 ||
              rect.top < box.top - 1 ||
              rect.bottom > box.bottom + 1
            );
          })
          .map(
            (child) =>
              child.getAttribute("aria-label") ||
              child.textContent ||
              child.tagName,
          );
        return {
          outside,
          horizontalOverflow: element.scrollWidth - element.clientWidth,
          onScreen:
            box.left >= 0 &&
            box.right <= innerWidth + 1 &&
            box.top >= 0 &&
            box.bottom <= innerHeight + 1,
        };
      }),
    )
    .toEqual({
      outside: [],
      horizontalOverflow: 0,
      onScreen: true,
    });
}

async function assertConfirmationRow(dialog: Locator) {
  const buttons = await dialog
    .locator("footer button")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return box.y + box.height / 2;
      }),
    );
  expect(Math.max(...buttons) - Math.min(...buttons)).toBeLessThan(1);
}

test("截图弹窗按图片比例利用空间，标题动作同行，窄窗确认操作整体换行", async ({
  page,
}) => {
  test.setTimeout(45000);
  await page.addInitScript(() => {
    Reflect.set(window, "captureCalls", 0);
    Reflect.set(window, "morphzDesktop", {
      capture: {
        select: async () => {
          Reflect.set(
            window,
            "captureCalls",
            Reflect.get(window, "captureCalls") + 1,
          );
          if (Reflect.get(window, "captureError"))
            throw new Error(Reflect.get(window, "captureError"));
          return {
            mime: "image/png",
            data: Reflect.get(window, "captureImage"),
          };
        },
        cancel: async () => {},
      },
    });
  });
  let uploads = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/assets"))
      uploads++;
  });
  await page.goto("/");
  const input = await openInput(page);
  await input.fill("布局验证保留的草稿，不发送");
  const trigger = page.getByRole("button", { name: "截图输入", exact: true });
  const dialog = page.getByRole("dialog", { name: "截图输入", exact: true });
  for (const [label, width, height] of [
    ["landscape", 1600, 1000],
    ["portrait", 600, 1800],
    ["panorama", 1800, 320],
    ["small", 240, 160],
  ] as const) {
    const png = await syntheticImage(page, width, height);
    await page.evaluate(
      (data) => Reflect.set(window, "captureImage", data),
      png,
    );
    await page.setViewportSize({ width: 1440, height: 960 });
    await openInput(page);
    await trigger.click();
    const preview = dialog.getByAltText("待确认的截图");
    await expect(preview).toBeVisible();
    await expect
      .poll(() => preview.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBe(width);
    await expect(
      dialog.getByRole("button", { name: "重新划区" }),
    ).toBeFocused();
    const layout = await dialog.evaluate((el) => {
      const header = el.querySelector("header")!.getBoundingClientRect();
      const retry = el.querySelector(".capture-start")!.getBoundingClientRect();
      const image = el
        .querySelector(".capture-preview")!
        .getBoundingClientRect();
      const imageStyle = getComputedStyle(
        el.querySelector(".capture-preview")!,
      );
      const footer = el.querySelector("footer")!.getBoundingClientRect();
      const title = el.querySelector("input")!.getBoundingClientRect();
      return {
        width: el.getBoundingClientRect().width,
        chrome: el.getBoundingClientRect().height - image.height,
        imageWidth: image.width,
        imageContentWidth:
          image.width -
          parseFloat(imageStyle.borderLeftWidth) -
          parseFloat(imageStyle.borderRightWidth),
        imageHeight: image.height,
        imageRatio:
          (image.width -
            parseFloat(imageStyle.borderLeftWidth) -
            parseFloat(imageStyle.borderRightWidth)) /
          (image.height -
            parseFloat(imageStyle.borderTopWidth) -
            parseFloat(imageStyle.borderBottomWidth)),
        header,
        retry,
        footer,
        title,
      };
    });
    expect(layout.retry.y).toBeGreaterThanOrEqual(layout.header.y);
    expect(layout.retry.bottom).toBeLessThanOrEqual(layout.header.bottom);
    expect(layout.title.y).toBeGreaterThanOrEqual(layout.footer.y);
    expect(layout.title.bottom).toBeLessThanOrEqual(layout.footer.bottom);
    expect(layout.imageRatio).toBeCloseTo(width / height, 1);
    if (label === "landscape") {
      expect(layout.imageWidth).toBeGreaterThan(850);
      expect(layout.chrome).toBeLessThan(125);
    }
    if (label === "portrait") {
      expect(layout.width).toBeLessThan(420);
      expect(layout.imageHeight).toBeGreaterThan(700);
    }
    if (label === "panorama")
      expect(layout.imageHeight + layout.chrome).toBeLessThan(320);
    if (label === "small")
      expect(layout.imageContentWidth).toBeLessThanOrEqual(width);
    await assertContained(dialog);
    await assertConfirmationRow(dialog);
    await dialog.screenshot({
      path: `test-results/capture-layout-${label}.png`,
    });
    for (const viewport of [
      { width: 1024, height: 768 },
      { width: 760, height: 540 },
      { width: 320, height: 640 },
    ]) {
      await page.setViewportSize(viewport);
      await assertContained(dialog);
      await assertConfirmationRow(dialog);
      const ratio = await preview.evaluate((el) => {
        const box = el.getBoundingClientRect(),
          style = getComputedStyle(el);
        return (
          (box.width -
            parseFloat(style.borderLeftWidth) -
            parseFloat(style.borderRightWidth)) /
          (box.height -
            parseFloat(style.borderTopWidth) -
            parseFloat(style.borderBottomWidth))
        );
      });
      expect(ratio).toBeCloseTo(width / height, 1);
    }
    if (label === "portrait") {
      await page.setViewportSize({ width: 760, height: 540 });
      await dialog.getByLabel("截图标题").fill("保留这张长图的标题".repeat(15));
      await page.evaluate(() =>
        Reflect.set(
          window,
          "captureError",
          "截图测试失败：权限暂时不可用，原预览和名称必须保留。".repeat(10),
        ),
      );
      await dialog
        .getByRole("button", { name: "重新划区", exact: true })
        .click();
      await expect(dialog.getByRole("alert")).toContainText("截图测试失败");
      await expect(preview).toBeVisible();
      await assertContained(dialog);
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("Tab");
        expect(
          await dialog.evaluate((el) => el.contains(document.activeElement)),
        ).toBe(true);
      }
      await page.evaluate(() => Reflect.set(window, "captureError", ""));
    }
    await dialog.getByRole("button", { name: "关闭截图输入" }).click();
    await expect(input).toHaveValue("布局验证保留的草稿，不发送");
  }
  expect(uploads).toBe(0);
  expect(await page.evaluate(() => Reflect.get(window, "captureCalls"))).toBe(
    5,
  );
});

test("公共弹窗按用途定宽，短确认不膨胀，转写与连接不堆空白操作行", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建项目", exact: true });
  await expect(create).toBeVisible();
  expect((await create.boundingBox())!.width).toBeLessThanOrEqual(480);
  await expect(create.locator("footer")).toHaveCount(0);
  const nameRow = create.locator(".project-name-row");
  await expect(nameRow.getByLabel("项目名称", { exact: true })).toBeVisible();
  await expect(
    nameRow.getByRole("button", { name: "创建", exact: true }),
  ).toBeVisible();
  expect((await create.boundingBox())!.height).toBeLessThan(190);
  await assertContained(create);
  await page.keyboard.press("Escape");

  await page.locator(".connection-summary").click();
  const connection = page.getByRole("dialog", {
    name: "连接详情",
    exact: true,
  });
  await expect(
    connection.locator("header").getByRole("button", { name: "检查连接" }),
  ).toBeVisible();
  await assertContained(connection);
  await page.keyboard.press("Escape");

  await openTranscription(page);
  const speech = page.getByRole("dialog", { name: "录音转文字", exact: true });
  await expect(speech).toBeVisible();
  expect((await speech.boundingBox())!.width).toBeGreaterThanOrEqual(600);
  expect(
    (await speech.locator(".voice-recorder").boundingBox())!.height,
  ).toBeLessThan(52);
  await assertContained(speech);
  await page.setViewportSize({ width: 760, height: 540 });
  await assertContained(speech);
  await speech.getByRole("button", { name: "关闭录音转文字" }).click();

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "工作空间选项", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "资料导入与来源", exact: true }),
  ).toHaveCount(0);
  await assertContained(
    page.getByRole("group", { name: "工作空间操作", exact: true }),
  );
});
