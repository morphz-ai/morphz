import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createServer, transformWithOxc } from "vite";
import react from "@vitejs/plugin-react";
import { expect, test, type Page } from "@playwright/test";

// Only production controls in a virtual React document. No App, business Host,
// Runtime, client, model requests or original Desktop. SSR cannot prove these
// node identities, actual refs, keyboard events or ResizeObserver focus commits.
const fixtureModule = `
import React, { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { IconButton } from '/src/ui/IconButton.tsx';
import { SidebarToggle } from '/src/SidebarToggle.tsx';
import { ComposerToolButtons } from '/src/ComposerToolButtons.tsx';
import { ExchangeControls } from '/src/ExchangePanel.tsx';
const events = [], remembered = new Map();
let command, objectRef, callbackNode = null, callbackAttach = 0, callbackCleanup = 0;
const callbackRef = node => {
  if (!node) throw new Error('React 19 cleanup ref must not be replaced with a null call');
  callbackNode = node;
  callbackAttach++;
  return () => { callbackCleanup++; callbackNode = null; };
};
function Fixture() {
  const [sidebar, setSidebar] = useState({ side: 'left', expanded: false, controls: 'left-panel', title: undefined, className: '' });
  const [tool, setTool] = useState({ label: '查看交流记录', pressed: false, unread: false, disabled: false, reserveOnly: false, groupStart: false, title: undefined });
  const [refState, setRefState] = useState({ mounted: true, iconId: 'pin', title: undefined });
  const [exchange, setExchange] = useState({ width: 800, conversationVisible: false, historyVisible: false, pinned: false, unread: false });
  const object = useRef(null);
  objectRef = object;
  command = (name, value) => flushSync(() => {
    if (name === 'sidebar') setSidebar(previous => ({ ...previous, ...value }));
    else if (name === 'tool') setTool(previous => ({ ...previous, ...value }));
    else if (name === 'refs') setRefState(previous => ({ ...previous, ...value }));
    else if (name === 'exchange') setExchange(previous => ({ ...previous, ...value }));
    else if (name === 'clear-events') events.length = 0;
    else throw new Error('Unknown fixture action: ' + name);
  });
  const interaction = mode => {
    events.push('interaction:' + mode);
    setExchange(previous => ({ ...previous, conversationVisible: mode !== 'input', historyVisible: mode === 'history' }));
  };
  return <main>
    <button id="outside">Outside</button>
    <section id="sidebar"><SidebarToggle {...sidebar} onClick={() => events.push('sidebar')}/></section>
    <section id="tools"><ComposerToolButtons unread={tool.unread} options={[
      { id: 'history-visibility', iconId: 'message-square-text', ...tool, onSelect: () => events.push('tool:history') },
      { id: '', label: 'empty:' + tool.label, iconId: 'pin', pressed: tool.pressed, onSelect: () => events.push('tool:empty') },
      { label: 'fallback:' + tool.label, iconId: 'maximize', onSelect: () => events.push('tool:fallback') },
    ]}/></section>
    <section id="refs">{refState.mounted && <>
      <IconButton id="object-ref" ref={object} controlRole="exchange-operation" iconId={refState.iconId} title={refState.title} onClick={() => events.push('object-ref')}/>
      <IconButton id="callback-ref" ref={callbackRef} controlRole="exchange-operation" iconId={refState.iconId} title={refState.title} onClick={() => events.push('callback-ref')}/>
    </>}</section>
    <section id="exchange" className="exchange-panel" style={{ width: exchange.width }}>
      <ExchangeControls conversationVisible={exchange.conversationVisible} historyVisible={exchange.historyVisible} pinned={exchange.pinned} unread={exchange.unread}
        onInteraction={interaction} onPin={() => { events.push('pin'); setExchange(previous => ({ ...previous, pinned: !previous.pinned })); }} onHide={() => events.push('hide')}/>
    </section>
  </main>;
}
Object.assign(window, { controlIconFixture: {
  run(name, value) { command(name, value); },
  remember(selector, key) {
    const node = document.querySelector(selector);
    if (!(node instanceof HTMLButtonElement)) throw new Error('Expected real button: ' + selector);
    remembered.set(key, node);
  },
  same(selector, key) { return remembered.get(key) === document.querySelector(selector); },
  connected(key) { return remembered.get(key)?.isConnected ?? false; },
  report() { return {
    events: [...events], callbackAttach, callbackCleanup,
    objectMatches: objectRef?.current instanceof HTMLButtonElement && objectRef.current === document.getElementById('object-ref'),
    objectNull: objectRef?.current === null,
    callbackMatches: callbackNode instanceof HTMLButtonElement && callbackNode === document.getElementById('callback-ref'),
    callbackNull: callbackNode === null,
    activeId: document.activeElement?.id,
  }; },
} });
createRoot(document.getElementById('root')).render(<StrictMode><Fixture/></StrictMode>);
`;

type Report = {
  events: string[];
  callbackAttach: number;
  callbackCleanup: number;
  objectMatches: boolean;
  objectNull: boolean;
  callbackMatches: boolean;
  callbackNull: boolean;
  activeId: string;
};
const run = (page: Page, name: string, value?: unknown) =>
  page.evaluate(
    ({ name, value }) =>
      Reflect.get(window, "controlIconFixture").run(name, value),
    { name, value },
  );
const report = (page: Page): Promise<Report> =>
  page.evaluate(() => Reflect.get(window, "controlIconFixture").report());
const remember = (page: Page, selector: string, key: string) =>
  page.evaluate(
    ({ selector, key }) =>
      Reflect.get(window, "controlIconFixture").remember(selector, key),
    { selector, key },
  );
const same = (page: Page, selector: string, key: string): Promise<boolean> =>
  page.evaluate(
    ({ selector, key }) =>
      Reflect.get(window, "controlIconFixture").same(selector, key),
    { selector, key },
  );
const connected = (page: Page, key: string): Promise<boolean> =>
  page.evaluate(
    (key) => Reflect.get(window, "controlIconFixture").connected(key),
    key,
  );
let server: Awaited<ReturnType<typeof createServer>> | undefined;
let fixtureUrl: string;

// Browser provisioning is the normal runner's responsibility. This document
// listens on an OS-selected ephemeral port, not the application Host's port.
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("apps/web"),
    plugins: [
      react(),
      {
        name: "control-icon-isolated-regression",
        resolveId(id) {
          if (id === "/__control-icons.tsx") return "\0control-icons.tsx";
        },
        async load(id) {
          if (id === "\0control-icons.tsx")
            return transformWithOxc(fixtureModule, "control-icons.tsx");
        },
        configureServer(vite) {
          vite.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__control-icons") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await vite.transformIndexHtml(
                request.url,
                '<!doctype html><html><head><style>body{margin:16px}section{margin:16px 0}.exchange-panel{box-sizing:border-box}.exchange-view-tools{display:flex;gap:4px}button{padding:8px}svg{width:24px;height:24px}</style></head><body><div id="root"></div><script type="module" src="/__control-icons.tsx"></script></body></html>',
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
  fixtureUrl = `http://127.0.0.1:${address.port}/__control-icons`;
});
test.afterAll(async () => {
  await server?.close();
});

function scenario(name: string, check: (page: Page) => Promise<void>) {
  test(name, async ({ page }) => {
    const errors: string[] = [],
      businessRequests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/"))
        businessRequests.push(request.url());
    });
    await page.goto(fixtureUrl);
    await page.waitForFunction(
      () => Reflect.get(window, "controlIconFixture")?.report().objectMatches,
    );
    await check(page);
    assert.deepEqual(errors, []);
    assert.deepEqual(businessRequests, []);
  });
}

scenario(
  "Sidebar side/expanded changes preserve one actual focused button and native events",
  async (page) => {
    const selector = "#sidebar > button",
      button = page.locator(selector);
    await remember(page, selector, "sidebar");
    await button.focus();
    for (const side of ["left", "right"] as const)
      for (const expanded of [false, true]) {
        await run(page, "sidebar", {
          side,
          expanded,
          controls: side + "-panel",
          title: "",
        });
        assert.equal(await same(page, selector, "sidebar"), true);
        await expect(button).toBeFocused();
        await expect(button).toHaveAttribute("aria-expanded", String(expanded));
        await expect(button).toHaveAttribute("aria-controls", side + "-panel");
        await expect(button).toHaveAttribute("title", "");
        await expect(button).toHaveAttribute(
          "aria-label",
          side === "left"
            ? expanded
              ? "隐藏侧边栏"
              : "显示侧边栏"
            : expanded
              ? "隐藏右侧栏"
              : "显示右侧栏",
        );
        await expect(button.locator("svg")).toHaveClass(
          new RegExp(
            side === "left" ? "lucide-panel-left" : "lucide-panel-right",
          ),
        );
        assert.equal(await button.getAttribute("type"), null);
        assert.equal(await button.getAttribute("controlRole"), null);
        assert.equal(await button.getAttribute("iconId"), null);
      }
    await button.hover();
    await button.click();
    await button.press("Enter");
    await button.press("Space");
    assert.deepEqual((await report(page)).events, [
      "sidebar",
      "sidebar",
      "sidebar",
    ]);
  },
);

scenario(
  "Tools retain same-id and empty-id nodes across label/pressed/unread updates and keep nullish-key fallback",
  async (page) => {
    const history = "#tools > button:nth-child(1)",
      empty = "#tools > button:nth-child(2)",
      fallback = "#tools > button:nth-child(3)";
    for (const [selector, key] of [
      [history, "history"],
      [empty, "empty"],
      [fallback, "fallback"],
    ])
      await remember(page, selector!, key!);
    await page.locator(history).focus();
    await run(page, "tool", {
      label: "收起交流记录",
      pressed: true,
      unread: true,
      title: "",
      groupStart: true,
    });
    assert.equal(await same(page, history, "history"), true);
    assert.equal(await same(page, empty, "empty"), true);
    assert.equal(await same(page, fallback, "fallback"), false);
    assert.equal(await connected(page, "fallback"), false);
    await expect(page.locator(history)).toBeFocused();
    await expect(page.locator(history)).toHaveAttribute(
      "aria-label",
      "收起交流记录",
    );
    await expect(page.locator(history)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(history)).toHaveAttribute(
      "aria-description",
      "有新回复",
    );
    await expect(page.locator(history)).toHaveAttribute("title", "");
    await expect(page.locator(history)).toHaveClass(
      "icon-button composer-tool composer-tool-group-start",
    );
    await expect(
      page.locator(history + " > span.composer-unread"),
    ).toHaveAttribute("aria-hidden", "true");
    await page.locator(history).hover();
    await page.locator(history).click();
    await page.locator(empty).press("Enter");
    assert.deepEqual((await report(page)).events, [
      "tool:history",
      "tool:empty",
    ]);
    await run(page, "tool", { disabled: true });
    await expect(page.locator(history)).toBeDisabled();
    await page.locator(history).dispatchEvent("click");
    assert.deepEqual((await report(page)).events, [
      "tool:history",
      "tool:empty",
    ]);
    await run(page, "tool", { disabled: false, reserveOnly: true });
    await expect(page.locator(history)).toBeDisabled();
    await expect(page.locator(history)).toHaveAttribute("aria-hidden", "true");
    await expect(page.locator(history)).toHaveClass(/composer-tool-reserved/);
    await run(page, "tool", {
      reserveOnly: false,
      unread: false,
      pressed: false,
    });
    assert.equal(await same(page, history, "history"), true);
    assert.equal(await same(page, empty, "empty"), true);
    await expect(page.locator(history)).toBeEnabled();
    await expect(page.locator(history + " > span.composer-unread")).toHaveCount(
      0,
    );
    assert.equal(await page.locator(history).getAttribute("aria-hidden"), null);
    assert.equal(
      await page.locator(history).getAttribute("aria-description"),
      null,
    );
    await expect(page.locator(history)).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  },
);

scenario(
  "Native object/callback refs keep actual focused buttons and React 19 cleanup on unmount",
  async (page) => {
    await remember(page, "#object-ref", "object");
    await remember(page, "#callback-ref", "callback");
    const initial = await report(page);
    assert.equal(initial.objectMatches, true);
    assert.equal(initial.callbackMatches, true);
    assert.ok(initial.callbackAttach > 0);
    await page.locator("#callback-ref").focus();
    await run(page, "refs", { iconId: "maximize", title: "changed" });
    assert.equal(await same(page, "#object-ref", "object"), true);
    assert.equal(await same(page, "#callback-ref", "callback"), true);
    await expect(page.locator("#callback-ref")).toBeFocused();
    const updated = await report(page);
    assert.equal(updated.objectMatches, true);
    assert.equal(updated.callbackMatches, true);
    assert.equal(updated.callbackAttach, initial.callbackAttach);
    assert.equal(updated.callbackCleanup, initial.callbackCleanup);
    await page.locator("#object-ref").click();
    await page.locator("#callback-ref").press("Enter");
    assert.deepEqual((await report(page)).events, [
      "object-ref",
      "callback-ref",
    ]);
    await run(page, "refs", { mounted: false });
    const removed = await report(page);
    assert.equal(removed.objectNull, true);
    assert.equal(removed.callbackNull, true);
    assert.equal(removed.callbackCleanup, initial.callbackCleanup + 1);
    assert.equal(removed.callbackAttach, initial.callbackAttach);
    assert.equal(await connected(page, "object"), false);
    assert.equal(await connected(page, "callback"), false);
  },
);

scenario(
  "620px compact transition unmounts secondary nodes, focuses original history and exempts original hide ref",
  async (page) => {
    const root = "#exchange .exchange-view-tools",
      history = root + " > button:first-child",
      hide = root + " > button:last-child",
      size = root + " > button:nth-child(2)",
      pin = root + " > button:nth-child(3)";
    await expect(page.locator(root + " > button")).toHaveCount(4);
    for (const [selector, key] of [
      [history, "history"],
      [hide, "hide"],
      [size, "size"],
      [pin, "pin"],
    ])
      await remember(page, selector!, key!);
    await page.locator(pin).focus();
    await run(page, "exchange", { width: 621 });
    await expect(page.locator(root)).not.toHaveAttribute(
      "data-compact",
      "true",
    );
    await expect(page.locator(pin)).toBeFocused();
    await run(page, "exchange", { width: 620 });
    await expect(page.locator(root)).toHaveAttribute("data-compact", "true");
    await expect(page.locator(root + " > button")).toHaveCount(3);
    await expect(page.locator(history)).toBeFocused();
    assert.equal(await same(page, history, "history"), true);
    assert.equal(await same(page, hide, "hide"), true);
    assert.equal(await connected(page, "size"), false);
    assert.equal(await connected(page, "pin"), false);
    await page.locator(hide).focus();
    await run(page, "exchange", { width: 621 });
    await expect(page.locator(root + " > button")).toHaveCount(4);
    await expect(page.locator(hide)).toBeFocused();
    assert.equal(await same(page, hide, "hide"), true);
    assert.equal(await same(page, size, "size"), false);
    assert.equal(await same(page, pin, "pin"), false);
    await run(page, "exchange", { width: 619 });
    await expect(page.locator(root)).toHaveAttribute("data-compact", "true");
    await expect(page.locator(hide)).toBeFocused();
    assert.equal(await same(page, hide, "hide"), true);
    await page.locator(hide).press("Enter");
    assert.deepEqual((await report(page)).events, ["hide"]);
    await page.locator("#outside").focus();
    await run(page, "exchange", { width: 800 });
    await expect(page.locator(root + " > button")).toHaveCount(4);
    await expect(page.locator("#outside")).toBeFocused();
  },
);

scenario(
  "Actual compact menu keeps original trigger, glyphs, labels, keyboard dispatch and close-to-trigger focus",
  async (page) => {
    const root = "#exchange .exchange-view-tools",
      history = root + " > button:first-child",
      trigger = root + " > button.composer-more";
    await run(page, "exchange", { width: 620, unread: true });
    await expect(page.locator(root)).toHaveAttribute("data-compact", "true");
    await remember(page, trigger, "more");
    await remember(page, history, "history");
    await run(page, "exchange", {
      conversationVisible: true,
      historyVisible: true,
      pinned: true,
    });
    assert.equal(await same(page, trigger, "more"), true);
    assert.equal(await same(page, history, "history"), true);
    await expect(page.locator(history)).toHaveAttribute(
      "aria-description",
      "有新回复",
    );
    await expect(page.locator(trigger + " > svg")).toHaveClass(
      /lucide-more-horizontal/,
    );
    assert.equal(await page.locator(trigger).getAttribute("type"), null);
    await page.locator(trigger).focus();
    await page.locator(trigger).press("Enter");
    const menu = page.getByRole("group", { name: "交流选项", exact: true });
    await expect(menu).toBeVisible();
    const size = menu.getByRole("button", {
      name: "返回工作内容",
      exact: true,
    });
    const pin = menu.getByRole("button", {
      name: "取消固定输入框",
      exact: true,
    });
    await expect(size).toBeFocused();
    await expect(size).toHaveAttribute("aria-pressed", "true");
    await expect(size.locator("svg")).toHaveClass(/lucide-minimize-2/);
    await expect(pin.locator("svg")).toHaveClass(/lucide-pin/);
    await size.press("ArrowDown");
    await expect(pin).toBeFocused();
    await pin.press("Enter");
    await expect(menu).not.toBeVisible();
    await expect(page.locator(trigger)).toBeFocused();
    assert.deepEqual((await report(page)).events, ["pin"]);
    assert.equal(await same(page, trigger, "more"), true);
    await page.locator(trigger).press("Enter");
    await expect(
      menu.getByRole("button", { name: "固定输入框", exact: true }),
    ).toBeVisible();
    await menu
      .getByRole("button", { name: "返回工作内容", exact: true })
      .press("Enter");
    await expect(page.locator(trigger)).toBeFocused();
    assert.deepEqual((await report(page)).events, [
      "pin",
      "interaction:recent",
    ]);
    await page.locator(history).press("Enter");
    assert.deepEqual((await report(page)).events, [
      "pin",
      "interaction:recent",
      "interaction:input",
    ]);
    await page.locator(trigger).press("Enter");
    const expand = menu.getByRole("button", {
      name: "展开完整记录",
      exact: true,
    });
    await expect(expand.locator("svg")).toHaveClass(/lucide-maximize-2/);
    await expand.press("Escape");
    await expect(menu).not.toBeVisible();
    await expect(page.locator(trigger)).toBeFocused();
    assert.equal(await same(page, trigger, "more"), true);
  },
);
