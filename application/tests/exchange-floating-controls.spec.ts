import { expect, test, type Page } from "@playwright/test";
import { openInput } from "./interaction-helpers.js";

const draft = "TEST 悬浮操作层：保留原草稿，不发送。\n第二行也不改变。";

async function workbench(page: Page) {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  const input = await openInput(page);
  await input.fill(draft);
  await input.evaluate(
    (element) => (element.dataset.floatingMount = "original"),
  );
  return input;
}

async function fixtureZoom(page: Page, zoom: number) {
  await page.locator(".app").evaluate((element, zoom) => {
    const app = element as HTMLElement;
    app.style.zoom = String(zoom);
    // CSS zoom enlarges controls but does not shrink the fixture's 100dvh shell
    // as native page zoom does. Keep its physical height within the viewport,
    // matching compact-sidebar-footer's fixture without changing production.
    app.style.height = zoom === 1 ? "" : `calc(100dvh / ${zoom})`;
  }, zoom);
}

async function savedInputDrafts(page: Page) {
  return page.evaluate(() =>
    Object.fromEntries(
      Object.keys(localStorage)
        .filter((key) => key.includes(":draft:") && key.endsWith(":inputs"))
        .sort()
        .map((key) => [key, JSON.parse(localStorage.getItem(key)!)]),
    ),
  );
}

async function outsideCanvasPoint(page: Page) {
  return page.evaluate(() => {
    const workspace = document.querySelector(".primary-panel")!;
    const canvas = workspace.querySelector(":scope > main")!;
    const composer = workspace.querySelector(".composer")!;
    const workBox = workspace.getBoundingClientRect();
    const box = composer.getBoundingClientRect();
    // The first candidate is the visual input gutter. At 200% it can overlay an
    // application's launch tile, so verify actual composed hit-testing before
    // using it; a tile click is a new work surface, not a draft hide/reopen.
    for (const x of [box.x - 6, workBox.x + 8]) {
      for (const y of [
        box.y + box.height / 2,
        box.y + box.height - 8,
        box.y + 8,
      ]) {
        const hit = document.elementFromPoint(x, y);
        if (
          hit &&
          canvas.contains(hit) &&
          !hit.closest(
            'button, a, [role="button"], input, textarea, select, label, [contenteditable="true"], .exchange-panel, [data-quote-ui]',
          )
        )
          return { x, y, canvasHit: true, tag: hit.tagName };
      }
    }
    throw new Error("No inert canvas gutter is available for an outside click");
  });
}

function exchangeControls(page: Page) {
  return page.getByRole("group", { name: "交流面板操作", exact: true });
}

async function exchangeAction(page: Page, name: string) {
  const group = exchangeControls(page);
  const direct = group.getByRole("button", { name, exact: true });
  if (await direct.isVisible()) {
    await direct.click();
    return;
  }
  await group
    .getByRole("button", { name: "更多交流选项", exact: true })
    .click();
  await page
    .getByRole("group", { name: "交流选项", exact: true })
    .getByRole("button", { name, exact: true })
    .click();
}

async function floatGeometry(page: Page) {
  return page.locator(".exchange-panel").evaluate((panel) => {
    const composer = panel.querySelector<HTMLElement>(".composer")!;
    const dock = panel.querySelector<HTMLElement>(".composer-dock")!;
    const reading = panel.querySelector<HTMLElement>(":scope > .conversation");
    const controls = panel.querySelector<HTMLElement>(".exchange-view-tools")!;
    const controlsSlot = panel.querySelector<HTMLElement>(
      ".exchange-controls-slot",
    )!;
    const zoom =
      (composer as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom ||
      1;
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect();
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        right: box.right,
        bottom: box.bottom,
      };
    };
    const buttons = Array.from(
      panel.querySelectorAll<HTMLButtonElement>(
        ".application-dock-buttons button, .exchange-view-tools > button",
      ),
    )
      .filter((button) => {
        const box = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return (
          box.width > 0 && box.height > 0 && style.visibility === "visible"
        );
      })
      .map((button) => {
        const box = rect(button);
        const hit = document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2,
        );
        const upperEdgePoint = {
          x: box.x + box.width / 2,
          y: box.y + 2 * zoom,
        };
        const upperEdgeHit = document.elementFromPoint(
          upperEdgePoint.x,
          upperEdgePoint.y,
        );
        return {
          ...box,
          group: button.closest(".exchange-view-tools") ? "exchange" : "dock",
          icon: button.querySelector("svg")
            ? rect(button.querySelector("svg")!)
            : null,
          label: button.getAttribute("aria-label"),
          hit: !!hit && button.contains(hit),
          upperEdgePoint,
          upperEdgeHit: !!upperEdgeHit && button.contains(upperEdgeHit),
          upperEdgeHitElement: upperEdgeHit
            ? {
                tag: upperEdgeHit.tagName,
                class: upperEdgeHit.getAttribute("class"),
                label: upperEdgeHit.getAttribute("aria-label"),
                rect: rect(upperEdgeHit),
              }
            : null,
          pointerEvents: getComputedStyle(button).pointerEvents,
          hitElement: hit
            ? {
                tag: hit.tagName,
                class: hit.getAttribute("class"),
                label: hit.getAttribute("aria-label"),
                rect: rect(hit),
                pointerEvents: getComputedStyle(hit).pointerEvents,
              }
            : null,
          hitAncestors: hit
            ? Array.from(
                (function* () {
                  let element: Element | null = hit;
                  while (element) {
                    yield {
                      tag: element.tagName,
                      class: element.getAttribute("class"),
                      label: element.getAttribute("aria-label"),
                      pointerEvents: getComputedStyle(element).pointerEvents,
                    };
                    element = element.parentElement;
                  }
                })(),
              )
            : [],
        };
      });
    return {
      panel: rect(panel),
      panelClientWidth: panel.clientWidth,
      composer: rect(composer),
      dock: rect(dock),
      reading: reading ? rect(reading) : null,
      controls: rect(controls),
      controlsRootChild: controlsSlot.parentElement === panel,
      coarse: matchMedia("(pointer: coarse)").matches,
      zoom,
      viewport: { width: innerWidth, height: innerHeight },
      buttons,
    };
  });
}

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  await info.attach("exchange-floating-hit-geometry", {
    body: JSON.stringify(await floatGeometry(page), null, 2),
    contentType: "application/json",
  });
  await info.attach("exchange-floating-hit-screenshot", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

async function expectFloats(page: Page) {
  // Wait for the actual ResizeObserver decision and paint rather than accepting
  // a stale wide rail immediately after a narrow/zoom transition.
  await expect(async () => {
    const geometry = await floatGeometry(page);
    const compact = exchangeControls(page).getByRole("button", {
      name: "更多交流选项",
      exact: true,
    });
    expect(await compact.isVisible()).toBe(geometry.panelClientWidth <= 620);
    expect(geometry.buttons.length).toBeGreaterThanOrEqual(4);
    const dockButtons = geometry.buttons.filter(
      (button) => button.group === "dock",
    );
    const controlButtons = geometry.buttons.filter(
      (button) => button.group === "exchange",
    );
    expect(dockButtons.length).toBeGreaterThanOrEqual(1);
    expect(controlButtons.length).toBeGreaterThanOrEqual(3);
    expect(geometry.controlsRootChild).toBe(true);
    for (const button of geometry.buttons) {
      expect(
        button.hit,
        `${button.label} must receive composed hit-testing`,
      ).toBe(true);
      expect(button.x).toBeGreaterThanOrEqual(-1);
      expect(button.right).toBeLessThanOrEqual(geometry.viewport.width + 1);
      expect(button.y).toBeGreaterThanOrEqual(-1);
      expect(button.bottom).toBeLessThanOrEqual(geometry.viewport.height + 1);
    }
    for (const button of dockButtons) {
      expect(button.bottom).toBeCloseTo(dockButtons[0]!.bottom, 0);
      expect(geometry.composer.y - button.bottom).toBeCloseTo(
        8 * geometry.zoom,
        0,
      );
    }
    for (const button of controlButtons) {
      expect(button.y).toBeCloseTo(geometry.controls.y, 0);
      expect(button.width).toBeCloseTo(
        (geometry.coarse ? 44 : 32) * geometry.zoom,
        0,
      );
      expect(button.height).toBeCloseTo(
        (geometry.coarse ? 44 : 32) * geometry.zoom,
        0,
      );
      expect(button.icon?.width).toBeCloseTo(14 * geometry.zoom, 0);
      expect(button.icon?.height).toBeCloseTo(14 * geometry.zoom, 0);
      if (geometry.reading) {
        // The resizer's hit surface reaches below the panel top. A successful
        // centre click must not mask it intercepting the button's upper edge.
        expect(
          button.upperEdgeHit,
          `${button.label} upper edge must hit its button, not ${button.upperEdgeHitElement?.class ?? "empty space"}`,
        ).toBe(true);
      }
      if (!geometry.reading) {
        expect(button.bottom).toBeCloseTo(dockButtons[0]!.bottom, 0);
        expect(geometry.composer.y - button.bottom).toBeCloseTo(
          8 * geometry.zoom,
          0,
        );
      }
    }
    if (geometry.reading) {
      expect(geometry.controls.y - geometry.panel.y).toBeCloseTo(
        8 * geometry.zoom,
        0,
      );
      expect(geometry.panel.right - geometry.controls.right).toBeCloseTo(
        12 * geometry.zoom,
        0,
      );
      expect(geometry.controls.bottom).toBeLessThanOrEqual(
        geometry.reading.bottom,
      );
    }
    for (let index = 0; index < geometry.buttons.length; index++) {
      for (const other of geometry.buttons.slice(index + 1)) {
        const button = geometry.buttons[index]!;
        const horizontal =
          Math.min(button.right, other.right) - Math.max(button.x, other.x);
        const vertical =
          Math.min(button.bottom, other.bottom) - Math.max(button.y, other.y);
        expect(
          horizontal > 0.5 && vertical > 0.5,
          `${button.label} must not overlap ${other.label}`,
        ).toBe(false);
      }
    }
    expect(
      await page.locator(".exchange-controls-slot").evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          position: style.position,
          background: style.backgroundColor,
          shadow: style.boxShadow,
        };
      }),
    ).toEqual({
      position: "absolute",
      background: "rgba(0, 0, 0, 0)",
      shadow: "none",
    });
  }).toPass();
  return floatGeometry(page);
}

test("输入卡片零占位，交流控制随阅读置顶并以同一节点返回输入上方", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/platform\/(?:messages|projects\/[^/]+\/conversations)(?:\?|$)/.test(
        request.url(),
      )
    )
      writes.push(request.url());
  });
  const input = await workbench(page);
  const controls = exchangeControls(page);
  const controlsSlot = page.locator(
    ".exchange-panel > .exchange-controls-slot",
  );
  await expect(controlsSlot).toHaveCount(1);
  await controlsSlot.evaluate(
    (element) => (element.dataset.floatingControlsMount = "original"),
  );
  await controls.evaluate(
    (element) => (element.dataset.floatingControlsMount = "original"),
  );
  const expectOriginalControls = async () => {
    await expect(controlsSlot).toHaveCount(1);
    await expect(controlsSlot).toHaveAttribute(
      "data-floating-controls-mount",
      "original",
    );
    await expect(controls).toHaveCount(1);
    await expect(controls).toHaveAttribute(
      "data-floating-controls-mount",
      "original",
    );
  };
  await exchangeAction(page, "固定输入框");
  const canvas = page.locator(".primary-panel > main");
  await canvas.evaluate(
    (element) => (element.dataset.floatingCanvas = "original"),
  );
  const canvasBounds = await canvas.boundingBox();
  await exchangeAction(page, "收起交流记录");
  await expect(page.locator(".primary-panel")).toHaveAttribute(
    "data-interaction",
    "input",
  );
  await expect(page.locator(".exchange-panel-header")).toHaveCount(0);
  await expect(page.locator(".exchange-resizer")).toHaveCount(0);
  await expect(page.locator(".exchange-panel > .conversation")).toHaveCount(0);
  await expectOriginalControls();
  const collapsed = await expectFloats(page);
  expect(collapsed.panel.height).toBeCloseTo(collapsed.dock.height, 0);
  expect(collapsed.dock.y).toBeCloseTo(collapsed.panel.y, 0);
  expect(collapsed.composer.y).toBeCloseTo(collapsed.panel.y, 0);
  for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"])
    await expect(page.locator(".composer")).toHaveCSS(
      `border-${corner}-radius`,
      "16px",
    );
  await exchangeAction(page, "查看交流记录");
  await expect(page.locator(".exchange-resizer")).toBeVisible();
  const recent = await expectFloats(page);
  await expectOriginalControls();
  expect(recent.composer.y).toBeCloseTo(collapsed.composer.y, 0);
  expect(await canvas.boundingBox()).toEqual(canvasBounds);
  await exchangeAction(page, "展开完整记录");
  await expect(page.locator(".primary-panel")).toHaveAttribute(
    "data-interaction",
    "history",
  );
  await expect(page.locator(".exchange-resizer")).toBeVisible();
  const history = await expectFloats(page);
  await expectOriginalControls();
  expect(history.composer.y).toBeCloseTo(collapsed.composer.y, 0);
  await exchangeAction(page, "返回工作内容");
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute("data-floating-canvas", "original");
  expect(await canvas.boundingBox()).toEqual(canvasBounds);
  await expectFloats(page);
  await expectOriginalControls();
  // The visible reading-top History action returns this same control group to
  // the zero-flow position above the input; it is not a replacement toolbar.
  await exchangeAction(page, "收起交流记录");
  await expect(page.locator(".primary-panel")).toHaveAttribute(
    "data-interaction",
    "input",
  );
  await expect(page.locator(".exchange-panel-header")).toHaveCount(0);
  await expect(page.locator(".exchange-resizer")).toHaveCount(0);
  await expectOriginalControls();
  const returned = await expectFloats(page);
  expect(returned.panel.height).toBeCloseTo(collapsed.panel.height, 0);
  expect(returned.composer.y).toBeCloseTo(collapsed.composer.y, 0);
  expect(await canvas.boundingBox()).toEqual(canvasBounds);
  await expect(input).toHaveAttribute("data-floating-mount", "original");
  await expect(input).toHaveValue(draft);
  expect(writes).toEqual([]);
});

test("窄宽与 CSS 200% 下悬浮两组不碰撞，更多菜单和 Launcher 持续可操作", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/platform\/(?:messages|projects\/[^/]+\/conversations|app-views\/launch)(?:\?|$)/.test(
        request.url(),
      )
    )
      writes.push(request.url());
  });
  const input = await workbench(page);
  const controls = exchangeControls(page);
  const controlsSlot = page.locator(
    ".exchange-panel > .exchange-controls-slot",
  );
  await controlsSlot.evaluate(
    (element) => (element.dataset.floatingControlsMount = "matrix-original"),
  );
  await controls.evaluate(
    (element) => (element.dataset.floatingControlsMount = "matrix-original"),
  );
  const savedDrafts = await savedInputDrafts(page);
  expect(Object.keys(savedDrafts).length).toBeGreaterThan(0);
  for (const [width, zoom] of [
    [1440, 1],
    [760, 1],
    [390, 1],
    [320, 1],
    [1440, 2],
  ] as const) {
    await page.setViewportSize({ width, height: 960 });
    await fixtureZoom(page, zoom);
    // Explicit history collapse must not be undone by opening a float menu.
    const collapse = exchangeControls(page).getByRole("button", {
      name: "收起交流记录",
      exact: true,
    });
    if (await collapse.isVisible()) await collapse.click();
    const geometry = await expectFloats(page);
    if (geometry.panelClientWidth <= 440) {
      const dockButtons = geometry.buttons.filter(
        (button) =>
          button.label?.startsWith("打开") || button.label === "全部应用",
      );
      expect(dockButtons.map((button) => button.label)).toEqual(["全部应用"]);
    }
    const more = exchangeControls(page).getByRole("button", {
      name: "更多交流选项",
      exact: true,
    });
    if (await more.isVisible()) {
      await more.focus();
      await more.press("Enter");
      const menu = page.getByRole("group", { name: "交流选项", exact: true });
      await expect(menu).toBeVisible();
      await expect(
        menu.getByRole("button", { name: "展开完整记录", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("End");
      await expect(
        menu.getByRole("button", { name: "固定输入框", exact: true }),
      ).toBeFocused();
      await page.getByRole("heading", { name: "应用", exact: true }).hover();
      await expect(menu).toBeVisible();
      await expect(input).toHaveAttribute("data-floating-mount", "original");
      await expect(input).toHaveValue(draft);
      await page.keyboard.press("Escape");
      await expect(more).toBeFocused();
      await expect(menu).toBeHidden();
      await expect(page.locator(".primary-panel")).toHaveAttribute(
        "data-interaction",
        "input",
      );

      // Full history puts this stable control group near the reading top. Its
      // compact menu must open below that trigger instead of escaping above
      // the viewport, including at CSS 200%.
      await more.click();
      await menu
        .getByRole("button", { name: "展开完整记录", exact: true })
        .click();
      await expect(page.locator(".primary-panel")).toHaveAttribute(
        "data-interaction",
        "history",
      );
      await expectFloats(page);
      await more.click();
      await expect(menu).toBeVisible();
      await expect(async () => {
        const trigger = (await more.boundingBox())!;
        const bounds = (await menu.boundingBox())!;
        expect(bounds.y - trigger.y - trigger.height).toBeCloseTo(4 * zoom, 0);
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(960);
        const menuButtons = menu.getByRole("button");
        expect(await menuButtons.count()).toBeGreaterThanOrEqual(2);
        for (const button of await menuButtons.all()) {
          expect(
            await button.evaluate((element) => {
              const box = element.getBoundingClientRect();
              const hit = document.elementFromPoint(
                box.x + box.width / 2,
                box.y + box.height / 2,
              );
              return Boolean(hit && element.contains(hit));
            }),
          ).toBe(true);
        }
      }).toPass();
      await page.keyboard.press("Escape");
      await expect(more).toBeFocused();
      await expect(menu).toBeHidden();
      await controls
        .getByRole("button", { name: "收起交流记录", exact: true })
        .click();
      await expect(page.locator(".primary-panel")).toHaveAttribute(
        "data-interaction",
        "input",
      );
      await expect(page.locator(".exchange-panel-header")).toHaveCount(0);
      await expect(page.locator(".exchange-resizer")).toHaveCount(0);
      await expectFloats(page);
      await expect(controlsSlot).toHaveAttribute(
        "data-floating-controls-mount",
        "matrix-original",
      );
      await expect(controls).toHaveAttribute(
        "data-floating-controls-mount",
        "matrix-original",
      );
      await expect(input).toHaveAttribute("data-floating-mount", "original");
      await expect(input).toHaveValue(draft);
      expect(await savedInputDrafts(page)).toEqual(savedDrafts);
    }
    const launcherButton = page.getByRole("button", {
      name: "全部应用",
      exact: true,
    });
    await launcherButton.click();
    const launcher = page.getByRole("group", { name: "选择应用", exact: true });
    await expect(launcher).toBeVisible();
    await launcher
      .getByRole("button", { name: "在工作台管理应用", exact: true })
      .focus();
    await page.getByRole("heading", { name: "应用", exact: true }).hover();
    await expect(launcher).toBeVisible();
    await expect(input).toHaveValue(draft);
    await page.keyboard.press("Escape");
    await expect(launcherButton).toBeFocused();
    await expect(launcher).toBeHidden();
    await expect(page.locator(".primary-panel")).toHaveAttribute(
      "data-interaction",
      "input",
    );
    await page.screenshot({
      path: `test-results/exchange-floats-${width}-${zoom}.png`,
    });
  }
  // No hidden full-width rail may absorb an outside click. The original draft
  // survives the established hide/reopen path without creating a Session.
  expect(await savedInputDrafts(page)).toEqual(savedDrafts);
  const outside = await outsideCanvasPoint(page);
  expect(outside.canvasHit).toBe(true);
  await page.mouse.click(outside.x, outside.y);
  await expect(input).toHaveCount(0);
  expect(await savedInputDrafts(page)).toEqual(savedDrafts);
  await openInput(page);
  await expect(input).toHaveValue(draft);
  expect(await savedInputDrafts(page)).toEqual(savedDrafts);
  expect(writes).toEqual([]);
});

test("CSS 200% 的阅读拖拽用布局像素保存，ARIA 与真实高度一致且恢复缩放不跳变", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/platform\/(?:messages|projects\/[^/]+\/conversations)(?:\?|$)/.test(
        request.url(),
      )
    )
      writes.push(request.url());
  });
  const input = await workbench(page);
  await exchangeAction(page, "固定输入框");
  if (
    await exchangeControls(page)
      .getByRole("button", { name: "收起交流记录", exact: true })
      .isVisible()
  )
    await exchangeAction(page, "收起交流记录");
  await fixtureZoom(page, 2);
  await expectFloats(page);
  await exchangeAction(page, "查看交流记录");
  const handle = page.getByRole("separator", {
    name: "调整消息区高度",
    exact: true,
  });
  const reading = page.locator(".exchange-panel > .conversation");
  const panel = page.locator(".exchange-panel");
  const preferences = () =>
    page.evaluate(() => {
      const key = Object.keys(localStorage).find((key) =>
        key.endsWith(":preferences"),
      );
      return key ? JSON.parse(localStorage.getItem(key)!) : {};
    });
  const expectReadingHeight = async (height: number, zoom: number) => {
    await expect(handle).toHaveAttribute("aria-valuenow", String(height));
    await expect
      .poll(async () => (await reading.boundingBox())!.height / zoom)
      .toBeCloseTo(height, 0);
  };
  await expect(handle).toBeInViewport();
  await expectFloats(page);
  const beforeHeight = Number(await handle.getAttribute("aria-valuenow"));
  await expectReadingHeight(beforeHeight, 2);
  const max = Number(await handle.getAttribute("aria-valuemax"));
  const target = 200;
  expect(max).toBeGreaterThan(target + 48);
  const panelBefore = (await panel.boundingBox())!;
  const composerBefore = (await page.locator(".composer").boundingBox())!;
  const beforePreferences = await preferences();
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - (target - beforeHeight) * 2, { steps: 8 });
  await expect(panel).toHaveAttribute("data-resizing", "");
  await expectReadingHeight(target, 2);
  expect(await preferences()).toEqual(beforePreferences);
  expect((await panel.boundingBox())!.height).toBeCloseTo(
    panelBefore.height + (target - beforeHeight) * 2,
    0,
  );
  expect((await page.locator(".composer").boundingBox())!.y).toBeCloseTo(
    composerBefore.y,
    0,
  );
  await page.mouse.up();
  await expect(panel).not.toHaveAttribute("data-resizing");
  await expect(page.locator(".exchange-resize-shield")).toHaveCount(0);
  await expect(page.locator(".primary-panel")).toHaveAttribute(
    "data-interaction",
    "recent",
  );
  await expectReadingHeight(target, 2);
  expect(Object.values((await preferences()).exchangeHeights)).toEqual([
    target,
  ]);
  await expectFloats(page);
  await fixtureZoom(page, 1);
  await expectReadingHeight(target, 1);
  expect(Object.values((await preferences()).exchangeHeights)).toEqual([
    target,
  ]);
  await expectFloats(page);
  await expect(input).toHaveAttribute("data-floating-mount", "original");
  await expect(input).toHaveValue(draft);
  expect(writes).toEqual([]);
});

test("缩窄时固定应用与交流控件焦点转交稳定入口，不自动收起或丢草稿", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/platform\/(?:messages|projects\/[^/]+\/conversations|app-views\/launch)(?:\?|$)/.test(
        request.url(),
      )
    )
      writes.push(request.url());
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  const input = await workbench(page);
  await exchangeAction(page, "收起交流记录");
  await expectFloats(page);
  const savedDrafts = await savedInputDrafts(page);
  const pin = page.locator(".application-dock-pins button").first();
  await pin.focus();
  await expect(pin).toBeFocused();
  await page.setViewportSize({ width: 390, height: 960 });
  await expect(
    page.getByRole("button", { name: "全部应用", exact: true }),
  ).toBeFocused();
  await expect(pin).toBeHidden();
  await expectFloats(page);
  await expect(input).toHaveValue(draft);
  await page.setViewportSize({ width: 1440, height: 960 });
  await expectFloats(page);
  await exchangeControls(page)
    .getByRole("button", { name: "展开完整记录", exact: true })
    .focus();
  await page.setViewportSize({ width: 390, height: 960 });
  await expect(
    exchangeControls(page).getByRole("button", {
      name: "查看交流记录",
      exact: true,
    }),
  ).toBeFocused();
  await expectFloats(page);
  await expect(page.locator(".primary-panel")).toHaveAttribute(
    "data-interaction",
    "input",
  );
  await expect(input).toHaveAttribute("data-floating-mount", "original");
  await expect(input).toHaveValue(draft);
  expect(await savedInputDrafts(page)).toEqual(savedDrafts);
  expect(writes).toEqual([]);
});

test.describe("粗指针悬浮操作层", () => {
  test.use({ hasTouch: true });

  test("触控窄宽下操作栏与 Launcher 可命中、不碰撞且不改工作或草稿", async ({
    page,
  }) => {
    const writes: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /\/api\/platform\/(?:messages|projects\/[^/]+\/conversations|app-views\/launch)(?:\?|$)/.test(
          request.url(),
        )
      )
        writes.push(request.url());
    });
    const input = await workbench(page);
    const savedDrafts = await savedInputDrafts(page);
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);
    await exchangeAction(page, "收起交流记录");
    for (const width of [760, 390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      const geometry = await expectFloats(page);
      for (const button of geometry.buttons) {
        expect(button.height).toBeGreaterThanOrEqual(44);
        if (
          ["查看交流记录", "更多交流选项", "收起 AI 输入框"].includes(
            button.label ?? "",
          )
        )
          expect(button.width).toBeGreaterThanOrEqual(44);
      }
      const more = exchangeControls(page).getByRole("button", {
        name: "更多交流选项",
        exact: true,
      });
      if (await more.isVisible()) {
        await more.tap();
        const menu = page.getByRole("group", { name: "交流选项", exact: true });
        await expect(menu).toBeInViewport();
        await expect(
          menu.getByRole("button", { name: "固定输入框", exact: true }),
        ).toBeInViewport();
        await more.tap();
        await expect(menu).toBeHidden();
      }
      const trigger = page.getByRole("button", {
        name: "全部应用",
        exact: true,
      });
      await trigger.tap();
      const launcher = page.getByRole("group", {
        name: "选择应用",
        exact: true,
      });
      await expect(launcher).toBeInViewport();
      for (const button of await launcher.getByRole("button").all()) {
        await expect(button).toBeInViewport();
        await expect
          .poll(() =>
            button.evaluate((element) => {
              const box = element.getBoundingClientRect();
              const hit = document.elementFromPoint(
                box.x + box.width / 2,
                box.y + box.height / 2,
              );
              return Boolean(hit && element.contains(hit));
            }),
          )
          .toBe(true);
      }
      await trigger.tap();
      await expect(launcher).toBeHidden();
      await exchangeControls(page)
        .getByRole("button", { name: "查看交流记录", exact: true })
        .tap();
      await expect(page.locator(".primary-panel")).toHaveAttribute(
        "data-interaction",
        "recent",
      );
      await expectFloats(page);
      await exchangeControls(page)
        .getByRole("button", { name: "收起交流记录", exact: true })
        .tap();
      await expect(page.locator(".primary-panel")).toHaveAttribute(
        "data-interaction",
        "input",
      );
      await expectFloats(page);
      await expect(input).toHaveAttribute("data-floating-mount", "original");
      await expect(input).toHaveValue(draft);
      expect(await savedInputDrafts(page)).toEqual(savedDrafts);
    }
    expect(writes).toEqual([]);
  });
});
