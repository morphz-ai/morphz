import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createServer, transformWithOxc } from "vite";
import react from "@vitejs/plugin-react";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { applicationKey } from "../apps/web/src/application-dock-model.js";
import {
  browserApplication,
  readerApplication,
  scriptStudioApplication,
} from "../packages/core/src/applications.js";

const browser = applicationKey(browserApplication),
  reader = applicationKey(readerApplication),
  studio = applicationKey(scriptStudioApplication),
  hidden = "unavailable-application@9.2";
// Real Dock/Popover/Pointer capture and paint, but no App, center, model or client.
// This source fixture is not original-Desktop or aesthetic acceptance evidence.
const module = `
import React, {StrictMode, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ApplicationDock} from '/src/ApplicationDock.tsx';
import '/src/application-icons.css';
import {browserApplication, readerApplication, scriptStudioApplication} from ${JSON.stringify(`/@fs/${resolve("packages/core/src/applications.ts")}`)};
import {scopedStorage} from '/src/local-preferences.ts';
const defaults = [scriptStudioApplication, browserApplication, readerApplication];
const initial = ${JSON.stringify([studio, hidden, browser])};
const store=scopedStorage('TEST-Center:TEST-Human'), foreign=scopedStorage('OTHER-Center:TEST-Human');
const defaultsPrefs={dockApplications:initial,interactions:{'scope-A':'input'},draft:{body:'TEST original untouched draft'},conversationId:'unchanged-conversation'};
let current, control, launches = 0, manages = 0, pointerId = 0;
document.addEventListener('pointerdown',event=>{pointerId=event.pointerId;},true);
const writes = [];
function Fixture() {
 const [keys,setKeys] = useState(()=>store.readLocal('preferences',defaultsPrefs).dockApplications), [apps,setApps] = useState(defaults), [width,setWidth] = useState(620), [mounted,setMounted] = useState(true);
 current = {keys, apps: apps.map(app=>app.id+'@'+app.version), writes, launches, manages};
 control = (name,value) => flushSync(()=>{
  if(name==='catalog')setApps(defaults.filter(app=>value.includes(app.id+'@'+app.version)));
  else if(name==='applications')setApps(value);
  else if(name==='keys')setKeys(value);
  else if(name==='width')setWidth(value);
  else if(name==='unmount')setMounted(false);
  else throw new Error(name);
 });
 return <div className="app"><main id="canvas"><button id="outside">Unchanged canvas</button><iframe id="guest" srcDoc="<button id='guest-action'>Guest action</button>"/></main>
  <div className="exchange-panel" style={{width, position:'fixed', bottom:40, left:100}}>
   <textarea id="draft" defaultValue="TEST original untouched draft"/>
   {mounted && <ApplicationDock applications={apps} pinned={keys} activeKey={${JSON.stringify(studio)}} compactWithExchange onPinned={next=>{writes.push([...next]);store.writeLocal('preferences',{...store.readLocal('preferences',defaultsPrefs),dockApplications:next});setKeys(next);}} onLaunch={async()=>{launches++;}} onManage={()=>{manages++;}}/>}
   <button id="right-controls" style={{position:'absolute',right:0,bottom:8}}>Controls</button>
  </div></div>;
}
Object.assign(window,{dockFixture:{run:(...args)=>control(...args),report:()=>({...current,launches,manages,pointerId,preferences:store.readLocal('preferences',defaultsPrefs),foreign:foreign.readLocal('preferences',null),writes:[...writes],draft:document.getElementById('draft').value,scope:'TEST-Center:TEST-Human',sessions:0,inputs:0,activeInstance:'unchanged-app-instance'})}});
createRoot(document.getElementById('root')).render(<StrictMode><Fixture/></StrictMode>);
`;
type Report = {
  keys: string[];
  writes: string[][];
  launches: number;
  manages: number;
  draft: string;
  scope: string;
  sessions: number;
  inputs: number;
  activeInstance: string;
  pointerId: number;
  preferences: {
    dockApplications: string[];
    interactions: Record<string, string>;
    draft: { body: string };
    conversationId: string;
  };
  foreign: null;
};
const report = (page: Page): Promise<Report> =>
  page.evaluate(() => Reflect.get(window, "dockFixture").report());
const run = (page: Page, name: string, value?: unknown) =>
  page.evaluate(
    ({ name, value }) => Reflect.get(window, "dockFixture").run(name, value),
    { name, value },
  );
const shortcut = (page: Page, key: string) =>
  page.locator(`.application-dock-pins [data-dock-key="${key}"]`);
const center = async (locator: Locator) => {
  const box = await locator.boundingBox();
  assert.ok(box);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const start = async (
  page: Page,
  source: Locator,
  destination: { x: number; y: number },
) => {
  const origin = await center(source);
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(destination.x, destination.y, { steps: 8 });
  await expect(page.locator(".application-dock")).toHaveAttribute(
    "data-dragging",
    "true",
  );
};
const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
const geometry = (page: Page) =>
  page.evaluate(() => {
    const rect = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    return [
      ...document.querySelectorAll(
        ".application-dock-shortcut, .application-dock-buttons, #right-controls, #draft",
      ),
    ].map(rect);
  });
const glyphPaint = (source: Locator) =>
  source.evaluate((element) => {
    const glyph = element.querySelector("svg, img")!,
      clip = element.closest(".application-dock-pins"),
      paint = glyph.getBoundingClientRect(),
      button = element.getBoundingClientRect(),
      style = getComputedStyle(glyph),
      frame = getComputedStyle(element),
      dot = getComputedStyle(element, "::after"),
      matrix = new DOMMatrixReadOnly(
        style.transform === "none" ? undefined : style.transform,
      );
    return {
      width: parseFloat(style.width),
      height: parseFloat(style.height),
      scale: matrix.a,
      visibleWidth: paint.width,
      visibleHeight: paint.height,
      paint: {
        left: paint.left,
        right: paint.right,
        top: paint.top,
        bottom: paint.bottom,
      },
      clip: clip
        ? (() => {
            const r = clip.getBoundingClientRect();
            return {
              left: r.left,
              right: r.right,
              top: r.top,
              bottom: r.bottom,
            };
          })()
        : null,
      background: frame.backgroundColor,
      shadow: frame.boxShadow,
      border: frame.borderWidth,
      dot: {
        content: dot.content,
        width: dot.width,
        height: dot.height,
        bottom: dot.bottom,
        background: dot.backgroundColor,
        pointerEvents: dot.pointerEvents,
      },
      centerHit:
        document
          .elementFromPoint(
            button.x + button.width / 2,
            button.y + button.height / 2,
          )
          ?.closest(".application-dock-shortcut") === element,
      aboveHit:
        document
          .elementFromPoint(button.x + button.width / 2, button.y - 0.5)
          ?.closest(".application-dock-shortcut") === element,
      edgeHits: [
        -0.5,
        -1,
        -1.5,
        -2,
        button.height + 0.5,
        button.height + 1.5,
      ].map(
        (offset) =>
          document
            .elementFromPoint(button.x + button.width / 2, button.y + offset)
            ?.closest(".application-dock-shortcut") === element,
      ),
    };
  });
let server: Awaited<ReturnType<typeof createServer>> | undefined,
  fixtureUrl: string;
const failures = new WeakMap<
  Page,
  { errors: string[]; requests: string[]; expectedLaunches: number }
>();
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("apps/web"),
    plugins: [
      react(),
      {
        name: "application-dock-isolated-regression",
        resolveId(id) {
          if (id === "/__application-dock.tsx") return "\0application-dock.tsx";
        },
        async load(id) {
          if (id === "\0application-dock.tsx")
            return transformWithOxc(module, "application-dock.tsx");
        },
        configureServer(vite) {
          vite.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__application-dock") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await vite.transformIndexHtml(
                request.url,
                '<html><head><style>body{margin:0;--surface-raised:#fff;--line:#ddd;--text-secondary:#444;--ink:#222;--soft:#eee;--accent-strong:#4488aa;--selection:#eef;--line-strong:#aaa;}#canvas{height:500px}#draft{display:block;width:100%;height:40px}</style></head><body><div id="root"></div><script type="module" src="/__application-dock.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
    ],
    server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
    logLevel: "error",
  });
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== "string");
  fixtureUrl = `http://127.0.0.1:${address.port}/__application-dock`;
});
test.afterAll(async () => {
  await server?.close();
});
test.beforeEach(async ({ page }) => {
  const found = {
    errors: [] as string[],
    requests: [] as string[],
    expectedLaunches: 0,
  };
  failures.set(page, found);
  page.on("pageerror", (error) => found.errors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/"))
      found.requests.push(request.url());
  });
  await page.goto(fixtureUrl);
  await expect(shortcut(page, studio)).toBeVisible();
});
test.afterEach(async ({ page }) => {
  const state = await report(page);
  expect(state.launches).toBe(failures.get(page)!.expectedLaunches);
  expect(state.manages).toBe(0);
  expect(state.draft).toBe("TEST original untouched draft");
  expect(state.scope).toBe("TEST-Center:TEST-Human");
  expect(state.sessions).toBe(0);
  expect(state.inputs).toBe(0);
  expect(state.activeInstance).toBe("unchanged-app-instance");
  expect(state.preferences.interactions).toEqual({ "scope-A": "input" });
  expect(state.preferences.draft).toEqual({
    body: "TEST original untouched draft",
  });
  expect(state.preferences.conversationId).toBe("unchanged-conversation");
  expect(state.foreign).toBe(null);
  expect(failures.get(page)!.errors).toEqual([]);
  expect(failures.get(page)!.requests).toEqual([]);
});

test("mouse reorder writes the complete keys once, keeps hidden versions and never launches", async ({
  page,
}) => {
  const target = await center(shortcut(page, studio));
  await start(page, shortcut(page, browser), { x: target.x - 10, y: target.y });
  expect(
    await shortcut(page, browser).evaluate(
      (element) => getComputedStyle(element).opacity,
    ),
  ).toBe("0.45");
  expect((await report(page)).writes).toEqual([]);
  await page.mouse.up();
  expect((await report(page)).keys).toEqual([browser, hidden, studio]);
  expect((await report(page)).writes).toEqual([[browser, hidden, studio]]);
  await expect(shortcut(page, browser)).toBeFocused();
});
test("Launcher drag pins at the selected slot without closing or launching the tile", async ({
  page,
}) => {
  await page.getByRole("button", { name: "全部应用", exact: true }).click();
  const tile = page.locator(
    `.application-dock-launch[data-dock-key="${reader}"]`,
  );
  await expect(tile).toBeVisible();
  const target = await center(shortcut(page, browser));
  await start(page, tile, { x: target.x - 10, y: target.y });
  expect(
    await tile.evaluate((element) => getComputedStyle(element).opacity),
  ).toBe("0.45");
  await page.mouse.up();
  expect(
    await tile.evaluate((element) => getComputedStyle(element).opacity),
  ).toBe("1");
  expect((await report(page)).keys).toEqual([studio, hidden, reader, browser]);
  expect((await report(page)).writes).toEqual([
    [studio, hidden, reader, browser],
  ]);
  await expect(
    page.getByRole("button", { name: "全部应用", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
});
test("explicit in-window drag out removes only the shortcut, including when its app is active", async ({
  page,
}) => {
  await start(page, shortcut(page, studio), { x: 800, y: 250 });
  await expect(page.locator(".application-dock-drag-hint")).toHaveText(
    "移除快捷入口（保留应用）",
  );
  await page.mouse.up();
  expect((await report(page)).keys).toEqual([hidden, browser]);
  expect((await report(page)).writes).toEqual([[hidden, browser]]);
  await expect(shortcut(page, studio)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "全部应用", exact: true }),
  ).toBeFocused();
});

test("ordinary click below the drag threshold still launches once without pin writes", async ({
  page,
}) => {
  failures.get(page)!.expectedLaunches = 1;
  const origin = await center(shortcut(page, studio));
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + 2, origin.y + 1);
  await page.mouse.up();
  await expect.poll(async () => (await report(page)).launches).toBe(1);
  expect((await report(page)).writes).toEqual([]);
});
test("saved reordered full list survives refresh in its original local identity scope", async ({
  page,
}) => {
  await shortcut(page, browser).focus();
  await page.keyboard.press("Alt+ArrowLeft");
  expect((await report(page)).writes).toEqual([[browser, hidden, studio]]);
  await page.reload();
  await expect(shortcut(page, browser)).toBeVisible();
  expect((await report(page)).keys).toEqual([browser, hidden, studio]);
  expect((await report(page)).writes).toEqual([]);
});
test("release outside the viewport is cancellation, never a shortcut-removal receipt", async ({
  page,
}) => {
  await start(page, shortcut(page, studio), { x: 800, y: 250 });
  await page.mouse.move(-20, 250);
  await page.mouse.up();
  expect((await report(page)).writes).toEqual([]);
  expect((await report(page)).keys).toEqual([studio, hidden, browser]);
});
for (const origin of ["dock", "launcher"] as const) {
  for (const edge of ["left", "right"] as const) {
    test(`${origin} window-${edge} release inside the Dock safety margin still cancels`, async ({
      page,
    }) => {
      const group = page.locator(".application-dock-buttons");
      const box = await group.boundingBox();
      assert.ok(box);
      const viewportWidth = await page.evaluate(() => innerWidth);
      const shift =
        edge === "left" ? -box.x : viewportWidth - (box.x + box.width);
      await page.locator(".exchange-panel").evaluate((element, shift) => {
        const panel = element as HTMLElement;
        panel.style.left = `${parseFloat(getComputedStyle(panel).left) + shift}px`;
      }, shift);
      if (origin === "launcher")
        await page
          .getByRole("button", { name: "全部应用", exact: true })
          .click();
      const source =
        origin === "dock"
          ? shortcut(page, browser)
          : page.locator(`.application-dock-launch[data-dock-key="${reader}"]`);
      const placed = await group.boundingBox();
      assert.ok(placed);
      const outside = {
        x: edge === "left" ? -1 : viewportWidth + 1,
        y: placed.y + placed.height / 2,
      };
      await start(page, source, outside);
      await page.mouse.up();
      expect((await report(page)).writes).toEqual([]);
      expect((await report(page)).keys).toEqual([studio, hidden, browser]);
    });
  }
}
for (const reason of [
  "escape",
  "pointercancel",
  "lostcapture",
  "blur",
  "catalog",
  "compact",
  "preferences",
  "unmount",
] as const) {
  test(`cancel by ${reason} restores preview with zero preference writes`, async ({
    page,
  }) => {
    const source = shortcut(page, studio);
    await start(page, source, { x: 800, y: 250 });
    if (reason === "escape") await page.keyboard.press("Escape");
    else if (reason === "pointercancel")
      await source.dispatchEvent("pointercancel", {
        pointerId: (await report(page)).pointerId,
        pointerType: "mouse",
      });
    else if (reason === "lostcapture") {
      await source.evaluate(
        (element, pointerId) => {
          const button = element as HTMLElement;
          button.releasePointerCapture(pointerId);
        },
        (await report(page)).pointerId,
      );
      // Capture changes are processed before the browser's next pointer event.
      await page.mouse.move(801, 250);
    } else if (reason === "blur")
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    else if (reason === "catalog")
      await run(page, "catalog", [browser, reader]);
    else if (reason === "compact") await run(page, "width", 400);
    else if (reason === "preferences")
      await run(page, "keys", [browser, hidden, studio]);
    else await run(page, "unmount");
    await expect(page.locator(".application-dock[data-dragging]")).toHaveCount(
      0,
    );
    await page.mouse.up();
    expect((await report(page)).writes).toEqual([]);
  });
}
test("keyboard and original pin paths remain available; removal restores Launcher focus first", async ({
  page,
}) => {
  await shortcut(page, browser).focus();
  await page.keyboard.press("Alt+ArrowLeft");
  expect((await report(page)).keys).toEqual([browser, hidden, studio]);
  await expect(shortcut(page, browser)).toBeFocused();
  await page.keyboard.press("Delete");
  expect((await report(page)).keys).toEqual([hidden, studio]);
  await expect(
    page.getByRole("button", { name: "全部应用", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  const pin = page.getByRole("button", {
    name: `固定到 Dock：${readerApplication.title}`,
    exact: true,
  });
  await pin.focus();
  await page.keyboard.press("Space");
  expect((await report(page)).keys).toEqual([hidden, studio, reader]);
});
test("glyph hover never changes layout/hit geometry; menu and dynamic local reduce clear paint immediately", async ({
  page,
}) => {
  const source = shortcut(page, studio),
    group = page.locator(".application-dock-buttons"),
    controls = page.locator("#right-controls"),
    draft = page.locator("#draft");
  const before = await Promise.all([
    source.boundingBox(),
    group.boundingBox(),
    controls.boundingBox(),
    draft.boundingBox(),
  ]);
  const origin = await center(source);
  await page.mouse.move(origin.x, origin.y);
  await frames(page);
  expect(
    await source
      .locator("svg")
      .first()
      .evaluate((e) => getComputedStyle(e).transform),
  ).not.toBe("none");
  expect(
    await Promise.all([
      source.boundingBox(),
      group.boundingBox(),
      controls.boundingBox(),
      draft.boundingBox(),
    ]),
  ).toEqual(before);
  await page.evaluate(() => {
    document.documentElement.dataset.appMotion = "reduce";
    window.dispatchEvent(new Event("morphz:motion-preference-changed"));
  });
  expect(
    await source.evaluate((e) => e.style.getPropertyValue("--dock-scale")),
  ).toBe("");
  expect(
    await source
      .locator("svg")
      .first()
      .evaluate((e) => getComputedStyle(e).transform),
  ).toBe("none");
  await page.evaluate(() => {
    delete document.documentElement.dataset.appMotion;
    window.dispatchEvent(new Event("morphz:motion-preference-changed"));
  });
  await page.mouse.move(origin.x + 1, origin.y);
  await frames(page);
  await page.getByRole("button", { name: "全部应用", exact: true }).click();
  expect(
    await source.evaluate((e) => e.style.getPropertyValue("--dock-scale")),
  ).toBe("");
});

for (const appearance of ["light", "dark"] as const)
  test(`bare ${appearance} Dock: original hit geometry, visible magnification and active dot without a framed hover/active state`, async ({
    page,
  }, testInfo) => {
    await page.evaluate((appearance) => {
      document.documentElement.style.colorScheme = appearance;
      document.body.style.background =
        appearance === "light" ? "#f7f7f7" : "#202020";
      document.body.style.setProperty(
        "--ink",
        appearance === "light" ? "#222" : "#ececec",
      );
      document.body.style.setProperty(
        "--text-secondary",
        appearance === "light" ? "#444" : "#b5b5b5",
      );
    }, appearance);
    // Original finite layout declarations, reviewed in the previous CSS. This
    // overlay is only an independent geometry oracle, not another Dock UI.
    const old = await page.addStyleTag({
      content: `
      .application-dock-pins { padding-block:0; margin-block:0; }
      .app .application-dock-shortcut { padding:8px; }
      .app .application-dock-shortcut svg, .app .application-dock-shortcut img { width:14px; height:14px; }
    `,
    });
    const original = await geometry(page);
    const originalEdges = (await glyphPaint(shortcut(page, studio))).edgeHits;
    expect(
      original.filter((rect) => rect.width === 32 && rect.height === 32),
    ).toHaveLength(3);
    const nodes = await page
      .locator(".application-dock-shortcut")
      .evaluateAll((elements) => {
        Reflect.set(window, "originalDockButtons", elements);
        Reflect.set(
          window,
          "originalDockGlyphs",
          elements.map((element) => element.querySelector("svg, img")),
        );
        return elements.map(
          (element) => element.querySelector("svg")!.outerHTML,
        );
      });
    await old.evaluate((element) => (element as HTMLElement).remove());
    await frames(page);
    expect(await geometry(page)).toEqual(original);
    expect(
      await page
        .locator(".application-dock-shortcut")
        .evaluateAll((elements) =>
          elements.every(
            (element, index) =>
              Reflect.get(window, "originalDockButtons")[index] === element &&
              Reflect.get(window, "originalDockGlyphs")[index] ===
                element.querySelector("svg, img"),
          ),
        ),
    ).toBe(true);
    expect(
      await page
        .locator(".application-dock-shortcut")
        .evaluateAll((elements) =>
          elements.map((element) => element.querySelector("svg")!.outerHTML),
        ),
    ).toEqual(nodes);
    const source = shortcut(page, studio),
      origin = await center(source);
    let paint = await glyphPaint(source);
    expect(paint.width).toBe(22);
    expect(paint.height).toBe(22);
    expect(paint.background).toBe("rgba(0, 0, 0, 0)");
    expect(paint.shadow).toBe("none");
    expect(paint.border).toBe("0px");
    expect(paint.dot).toMatchObject({
      content: '""',
      width: "3px",
      height: "3px",
      bottom: "-1px",
      pointerEvents: "none",
    });
    expect(paint.dot.background).not.toBe("rgba(0, 0, 0, 0)");
    expect((await glyphPaint(shortcut(page, browser))).dot.content).toBe(
      "none",
    );
    for (const other of [
      shortcut(page, browser),
      page.getByRole("button", { name: "全部应用", exact: true }),
    ]) {
      const point = await center(other);
      await page.mouse.move(point.x, point.y);
      await expect
        .poll(async () => (await glyphPaint(other)).scale)
        .toBeGreaterThanOrEqual(1.37);
      const otherPaint = await glyphPaint(other);
      expect(otherPaint.width).toBe(22);
      expect(otherPaint.background).toBe("rgba(0, 0, 0, 0)");
      expect(otherPaint.shadow).toBe("none");
      expect(otherPaint.border).toBe("0px");
      expect(await geometry(page)).toEqual(original);
    }
    await page.mouse.move(origin.x, origin.y);
    await expect
      .poll(async () => (await glyphPaint(source)).scale)
      .toBeGreaterThanOrEqual(1.37);
    paint = await glyphPaint(source);
    expect(paint.visibleWidth / paint.width).toBeGreaterThanOrEqual(1.3);
    expect(paint.visibleHeight / paint.height).toBeGreaterThanOrEqual(1.3);
    expect(paint.clip).not.toBe(null);
    expect(paint.paint.top).toBeGreaterThanOrEqual(paint.clip!.top);
    expect(paint.paint.bottom).toBeLessThanOrEqual(paint.clip!.bottom);
    expect(paint.paint.left).toBeGreaterThanOrEqual(paint.clip!.left);
    expect(paint.centerHit).toBe(true);
    // Chromium hit testing quantizes fractional boundary pixels. Compare the
    // actual old boundary samples rather than assuming y - .5 is outside.
    expect(paint.edgeHits).toEqual(originalEdges);
    expect(await geometry(page)).toEqual(original);
    const neighbour = await glyphPaint(shortcut(page, browser));
    expect(paint.paint.right).toBeLessThan(neighbour.paint.left);
    const controls = await page.locator("#right-controls").boundingBox();
    assert.ok(controls);
    expect(neighbour.paint.right).toBeLessThan(controls.x);
    await page
      .locator(".exchange-panel")
      .screenshot({ path: testInfo.outputPath(`bare-dock-${appearance}.png`) });
    // The real shared button :active rule must not reintroduce its rectangle.
    const shared = await page.addStyleTag({
      content:
        ".app button:active:not(:disabled){background-color:rgb(232,232,232)}",
    });
    await page.mouse.down();
    for (const element of [source, shortcut(page, browser)]) {
      const current = await glyphPaint(element);
      expect(current.background).toBe("rgba(0, 0, 0, 0)");
      expect(current.shadow).toBe("none");
    }
    await page.keyboard.press("Escape");
    await page.mouse.move(800, 250);
    await page.mouse.up();
    // No click/launch was performed: the captured pointer is cancelled by Esc.
    await shared.evaluate((element) => (element as HTMLElement).remove());
    await source.focus();
    await page.keyboard.press("Tab");
    await expect(shortcut(page, browser)).toBeFocused();
    expect(
      await shortcut(page, browser).evaluate((element) => {
        const style = getComputedStyle(element);
        return (
          style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0
        );
      }),
    ).toBe(true);
    expect(
      await page
        .locator(".application-dock-shortcut")
        .evaluateAll((elements) =>
          elements.every(
            (element, index) =>
              Reflect.get(window, "originalDockButtons")[index] === element &&
              Reflect.get(window, "originalDockGlyphs")[index] ===
                element.querySelector("svg, img"),
          ),
        ),
    ).toBe(true);
    expect((await report(page)).writes).toEqual([]);
  });

test("bare scroll-edge glyphs and drag markers keep their original group/insertion geometry; empty/compact do not add height", async ({
  page,
}) => {
  const entries = Array.from({ length: 12 }, (_, index) => ({
    ...browserApplication,
    id: `test.dock.${index}`,
    title: `TEST Dock ${index}`,
  }));
  const keys = entries.map(applicationKey);
  await run(page, "applications", entries);
  await run(page, "keys", keys);
  const group = page.locator(".application-dock-buttons"),
    pins = page.locator(".application-dock-pins");
  await group.evaluate((element) => {
    (element as HTMLElement).style.width = "180px";
  });
  await expect
    .poll(() =>
      pins.evaluate((element) => element.scrollWidth > element.clientWidth),
    )
    .toBe(true);
  const before = await geometry(page);
  for (const key of [keys[0]!, keys.at(-1)!]) {
    await pins.evaluate(
      (element, last) => {
        element.scrollLeft = last ? element.scrollWidth : 0;
      },
      key === keys.at(-1),
    );
    const source = shortcut(page, key),
      origin = await center(source);
    const edges = (await glyphPaint(source)).edgeHits;
    await page.mouse.move(origin.x, origin.y);
    await expect
      .poll(async () => (await glyphPaint(source)).scale)
      .toBeGreaterThanOrEqual(1.37);
    const paint = await glyphPaint(source);
    expect(paint.paint.left).toBeGreaterThanOrEqual(paint.clip!.left);
    expect(paint.paint.right).toBeLessThanOrEqual(paint.clip!.right);
    expect(paint.paint.top).toBeGreaterThanOrEqual(paint.clip!.top);
    expect(paint.paint.bottom).toBeLessThanOrEqual(paint.clip!.bottom);
    expect(paint.centerHit).toBe(true);
    expect(paint.edgeHits).toEqual(edges);
    expect((await group.boundingBox())!.height).toBe(32);
  }
  await page.mouse.move(800, 250);
  await pins.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await frames(page);
  expect(await geometry(page)).toEqual(before);
  const marker = await pins.evaluate((element) => {
    element.setAttribute("data-drop-end", "true");
    const rect = element.getBoundingClientRect(),
      style = getComputedStyle(element, "::after");
    return {
      top: rect.top + parseFloat(style.top),
      height: parseFloat(style.height),
    };
  });
  const first = await shortcut(page, keys[0]!).boundingBox();
  assert.ok(first);
  expect(marker).toEqual({ top: first.y + 4, height: 24 });
  await pins.evaluate((element) => {
    element.removeAttribute("data-drop-end");
  });
  await run(page, "keys", []);
  expect((await group.boundingBox())!.height).toBe(32);
  await run(page, "keys", keys);
  await run(page, "width", 400);
  expect((await group.boundingBox())!.height).toBe(32);
  await expect(pins).toBeHidden();
  expect((await report(page)).writes).toEqual([]);
});

test("installed PNG keeps its exact image identity and receives the same unclipped bare-glyph paint", async ({
  page,
}) => {
  const entry = {
    ...readerApplication,
    id: "test.installed-image",
    title: "TEST Installed PNG",
    iconImage:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6uAoAAAAASUVORK5CYII=",
  };
  await run(page, "applications", [entry]);
  await run(page, "keys", [applicationKey(entry)]);
  const source = shortcut(page, applicationKey(entry)),
    image = source.locator("img");
  await expect(image).toHaveAttribute("src", entry.iconImage);
  await expect
    .poll(() =>
      image.evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBe(1);
  const original = await geometry(page),
    origin = await center(source);
  await image.evaluate((element) => {
    Reflect.set(window, "originalDockImage", element);
  });
  await page.mouse.move(origin.x, origin.y);
  await expect
    .poll(async () => (await glyphPaint(source)).scale)
    .toBeGreaterThanOrEqual(1.37);
  const paint = await glyphPaint(source);
  expect(paint.width).toBe(22);
  expect(paint.height).toBe(22);
  expect(paint.background).toBe("rgba(0, 0, 0, 0)");
  expect(paint.shadow).toBe("none");
  expect(paint.paint.top).toBeGreaterThanOrEqual(paint.clip!.top);
  expect(paint.paint.bottom).toBeLessThanOrEqual(paint.clip!.bottom);
  expect(await geometry(page)).toEqual(original);
  await expect(image).toHaveAttribute("src", entry.iconImage);
  expect(
    await image.evaluate(
      (element) => Reflect.get(window, "originalDockImage") === element,
    ),
  ).toBe(true);
  expect((await report(page)).writes).toEqual([]);
});
test("system reduce disables magnification, but ordering keeps its non-motion semantics", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const source = shortcut(page, studio),
    origin = await center(source);
  await page.mouse.move(origin.x, origin.y);
  await frames(page);
  expect(
    await source
      .locator("svg")
      .first()
      .evaluate((e) => getComputedStyle(e).transform),
  ).toBe("none");
  await source.focus();
  await page.keyboard.press("Alt+ArrowRight");
  expect((await report(page)).keys).toEqual([browser, hidden, studio]);
});
test("200% CSS zoom uses actual stable pointer coordinates, with drag paint disabled", async ({
  page,
}) => {
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  const target = await center(shortcut(page, studio));
  await start(page, shortcut(page, browser), { x: target.x - 10, y: target.y });
  expect(
    await shortcut(page, browser)
      .locator("svg")
      .first()
      .evaluate((e) => getComputedStyle(e).transform),
  ).toBe("none");
  await page.mouse.up();
  expect((await report(page)).keys).toEqual([browser, hidden, studio]);
});
test("coarse touch retains 44px targets, visible pins and no hover/drag requirement", async ({
  browser: runner,
}) => {
  const context = await runner.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 800, height: 700 },
  });
  const page = await context.newPage();
  await page.goto(fixtureUrl);
  const source = shortcut(page, studio);
  await expect(source).toBeVisible();
  expect((await source.boundingBox())!.width).toBe(44);
  // Mobile emulation maps CSS coordinates through a fractional viewport scale;
  // its reported rect height can be 43.999938 while the actual target is 44px.
  expect(
    await source.evaluate((element) => ({
      height: getComputedStyle(element).height,
      target: (element as HTMLElement).offsetHeight,
    })),
  ).toEqual({ height: "44px", target: 44 });
  const paint = await glyphPaint(source);
  expect(paint.width).toBe(22);
  expect(paint.height).toBe(22);
  expect(paint.scale).toBe(1);
  expect(paint.background).toBe("rgba(0, 0, 0, 0)");
  expect(paint.shadow).toBe("none");
  expect(paint.paint.top).toBeGreaterThanOrEqual(paint.clip!.top);
  expect(paint.paint.bottom).toBeLessThanOrEqual(paint.clip!.bottom);
  await source.dispatchEvent("pointermove", {
    pointerType: "touch",
    clientX: 200,
    clientY: 600,
  });
  expect(
    await source
      .locator("svg")
      .first()
      .evaluate((e) => getComputedStyle(e).transform),
  ).toBe("none");
  await page.getByRole("button", { name: "全部应用", exact: true }).tap();
  const pin = page.getByRole("button", {
    name: `固定到 Dock：${readerApplication.title}`,
    exact: true,
  });
  await expect(pin).toBeVisible();
  expect(await pin.evaluate((e) => getComputedStyle(e).opacity)).toBe("1");
  await pin.tap();
  expect((await report(page)).keys).toEqual([studio, hidden, browser, reader]);
  expect((await report(page)).launches).toBe(0);
  await context.close();
});
