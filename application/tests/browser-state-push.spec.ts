import { expect, test } from "@playwright/test";

test("浏览器状态由push更新，空闲零IPC读取，旧guest/乱序和迟到恢复不能覆盖当前页面", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let current: any = null,
      sequence = 0,
      reads = 0,
      opens = 0,
      hold = false;
    let resolveRead: ((value: any) => void) | undefined;
    const listeners = new Set<(frame: any) => void>();
    (window as any).__browserEvidence = () => ({
      reads,
      opens,
      listeners: listeners.size,
      held: !!resolveRead,
    });
    (window as any).__browserChange = (url: string, options: any = {}) => {
      current = { ...current, url, title: "真实事件标题", loading: false };
      if (options.silent) return;
      const frame = {
        generation: options.generation ?? 1,
        sequence: options.sequence ?? ++sequence,
        pageId: options.pageId ?? current.pageId,
        value: current,
      };
      for (const receive of listeners) receive(frame);
    };
    (window as any).__browserHold = () => {
      hold = true;
    };
    (window as any).__browserHostClose = () => {
      const pageId = current.pageId;
      current = null;
      const frame = { generation: 2, sequence: 1, pageId, value: null };
      for (const receive of listeners) receive(frame);
    };
    (window as any).__browserRelease = () => {
      resolveRead?.({ ...current, url: "https://example.test/stale" });
      resolveRead = undefined;
      hold = false;
    };
    (window as any).morphzDesktop = {
      browser: {
        open: async (target: any) => {
          opens++;
          return (current = {
            ...target,
            pageId: "11111111-1111-4111-8111-111111111111",
            epoch: "epoch",
            artifactId: null,
            surface: { partition: "fixture", src: target.url },
            title: "网页",
            loading: true,
            error: "",
            pending: null,
            granted: false,
            visible: true,
          });
        },
        state: async () => {
          reads++;
          return hold
            ? new Promise((resolve) => {
                resolveRead = resolve;
              })
            : current;
        },
        onState: (receive: (frame: any) => void) => {
          listeners.add(receive);
          return () => listeners.delete(receive);
        },
        visibility: async () => {},
        control: async () => current,
        close: async () => {
          current = null;
        },
      },
    };
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page.getByRole("button", { name: "浏览器 1.0.0", exact: true }).click();
  const address = page.getByRole("textbox", { name: "网站地址" });
  await address.fill("https://example.test/first");
  await address.press("Enter");
  await expect(page.locator(".browser-slot")).toBeVisible();
  const idle = await page.evaluate(() => (window as any).__browserEvidence());
  await page.waitForTimeout(1600);
  expect(
    await page.evaluate(() => (window as any).__browserEvidence()),
  ).toEqual(idle);
  await page.evaluate(() =>
    (window as any).__browserChange("https://example.test/second", {
      sequence: 10,
    }),
  );
  await expect(address).toHaveValue("https://example.test/second");
  await expect(page.getByRole("status", { name: "正在加载网页" })).toHaveCount(
    0,
  );
  for (const options of [
    { sequence: 9 },
    { generation: 0, sequence: 999 },
    { pageId: "foreign-guest", sequence: 999 },
  ]) {
    await page.evaluate(
      (options) =>
        (window as any).__browserChange("https://example.test/wrong", options),
      options,
    );
    await expect(address).toHaveValue("https://example.test/second");
  }
  await page.evaluate(() => {
    (window as any).__browserHold();
    window.dispatchEvent(new Event("focus"));
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).__browserEvidence().held))
    .toBe(true);
  await page.evaluate(() =>
    (window as any).__browserChange("https://example.test/latest", {
      sequence: 20,
    }),
  );
  await page.evaluate(() => (window as any).__browserRelease());
  await expect(address).toHaveValue("https://example.test/latest");
  await page.evaluate(() => {
    (window as any).__browserChange("https://example.test/recovered", {
      silent: true,
    });
    window.dispatchEvent(new Event("focus"));
  });
  await expect(address).toHaveValue("https://example.test/recovered");
  const beforeHostClose = await page.evaluate(() =>
    (window as any).__browserEvidence(),
  );
  await page.evaluate(() => (window as any).__browserHostClose());
  await expect(page.locator(".browser-slot")).toHaveCount(0);
  await page.waitForTimeout(850);
  expect(
    await page.evaluate(() => (window as any).__browserEvidence().opens),
  ).toBe(beforeHostClose.opens);
  // The saved address remains editable; closing the guest does not prohibit
  // another explicit open and does not reopen it behind the user's back.
  await expect(address).toHaveValue("https://example.test/recovered");
  await address.press("Enter");
  await expect(page.locator(".browser-slot")).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).__browserEvidence().opens),
  ).toBe(beforeHostClose.opens + 1);
  await page.getByRole("button", { name: "返回工作空间", exact: true }).click();
  await page
    .getByRole("button", { name: "关闭应用 浏览器", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__browserEvidence().listeners),
    )
    .toBe(0);
  const ended = await page.evaluate(() => (window as any).__browserEvidence());
  await page.waitForTimeout(750);
  expect(
    await page.evaluate(() => (window as any).__browserEvidence()),
  ).toEqual(ended);
});
