import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createServer, transformWithOxc } from "vite";
import react from "@vitejs/plugin-react";
import { test, type Page } from "@playwright/test";
import type { ExchangePreferences } from "../apps/web/src/host/use-exchange-controller.js";
import type { InteractionMode } from "../apps/web/src/interaction.js";

// Mount the production hooks in a tiny React document with no App, real center,
// application client, model or business requests. This verifies actual focus /
// layout commits, not acceptance of the user's Desktop or its visual design.
const fixtureModule = `
import React, { StrictMode, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useExchangeController, useExchangeControllerFocus } from '/src/host/use-exchange-controller.ts';
const writes = [], events = [];
let controller, current, generation, showCount = 0;
let control;
function Fixture() {
  const [model, setModel] = useState({ exchangeKey: 'surface-A', contextKey: 'conversation-A:object-A', conversationId: 'conversation-A', dialogueCanvas: false, sending: false, suspended: false, sequence: 0 });
  const [preferences, setPreferences] = useState({ interactions: { 'surface-A': 'input', 'surface-B': 'input' }, pinnedInputs: { 'surface-A': true, 'surface-B': true }, exchangeHeights: { 'surface-A': 250, 'surface-B': 180 } });
  const input = useRef(null), exchange = useRef(null), toggle = useRef(null), navigationGeneration = useRef(1);
  generation = navigationGeneration;
  const prefer = change => {
    writes.push(structuredClone(change));
    setPreferences(previous => ({ ...previous, ...change, ...Object.fromEntries(['interactions','pinnedInputs','exchangeHeights'].filter(key => change[key]).map(key => [key, { ...previous[key], ...change[key] }])) }));
  };
  controller = useExchangeController({ surface: { ...model, navigationProject: { id: 'project-A' } }, preferences, input, exchange, toggle, navigationGeneration, sending: model.sending, suspended: model.dialogueCanvas || model.suspended, prefer, onShowInput: () => { showCount++; } });
  // Preserve the real Host's ordering seam: owner restoration precedes focus.
  useLayoutEffect(() => { events.push('canvas'); }, [model.contextKey]);
  useLayoutEffect(() => { events.push('trail'); }, [model.contextKey, model.conversationId]);
  useExchangeControllerFocus(controller);
  useLayoutEffect(() => { events.push('inspector'); }, [model.contextKey]);
  current = { ...model, preferences };
  const update = change => setModel(previous => ({ ...previous, ...change, sequence: previous.sequence + 1 }));
  control = (name, value) => flushSync(() => {
    if (name === 'show') controller.showInput();
    else if (name === 'hide') controller.hideInput();
    else if (name === 'mode') controller.setInteraction(value);
    else if (name === 'other-mode') controller.setInteraction(value, 'surface-B');
    else if (name === 'pin') controller.toggleInputPin();
    else if (name === 'preview') controller.resize.onPreview(value);
    else if (name === 'commit') controller.resize.onCommit(value);
    else if (name === 'clear-preview') controller.clearResizePreview();
    else if (name === 'lock') update({ sending: true });
    else if (name === 'unlock') update({ sending: false });
    else if (name === 'sent') controller.showSentInput(value || model.contextKey);
    else if (name === 'sent-focus') { controller.requestSentInputFocus(value || model.contextKey); update({}); }
    else if (name === 'named-focus') { controller.requestConversationFocus(value, navigationGeneration.current); update({}); }
    else if (name === 'resolve-named') update({ conversationId: value, contextKey: value + ':object', exchangeKey: 'surface-B' });
    else if (name === 'navigate') { navigationGeneration.current++; controller.clearResizePreview(); update(value); }
    else if (name === 'aba') { navigationGeneration.current += 2; update({}); }
    else if (name === 'show-navigate') { controller.showInput(); navigationGeneration.current++; update(value); }
    else if (name === 'dialogue') update({ dialogueCanvas: value });
    else if (name === 'suspend') update({ suspended: value });
    else if (name === 'pulse') update({});
    else if (name === 'clear-log') { writes.length = 0; events.length = 0; }
    else throw new Error('Unknown fixture action: ' + name);
  });
  return <div className="primary-panel">
    <button id="origin">Original focus</button><button id="outside">Outside focus</button>
    <button id="toggle" ref={toggle} onClick={() => controller.showInput()}>Open input</button>
    <div ref={exchange} className="exchange-surface">
      <div className="exchange-panel" data-open={controller.inputVisible || controller.conversationVisible || undefined}>
        {controller.conversationVisible && <div id="reading">Reading</div>}
        {controller.inputVisible && <div id="global-composer"><textarea id="input" ref={input} disabled={model.sending} defaultValue="untouched draft" onFocus={() => events.push('input:focus')}/><button id="inside">Input tool</button></div>}
      </div>
    </div>
  </div>;
}
Object.assign(window, { exchangeFixture: {
  run(name, value) { control(name, value); },
  report() { return { ...current, generation: generation.current, mode: controller.interaction, inputVisible: controller.inputVisible, readingVisible: controller.conversationVisible, historyVisible: controller.historyVisible, pending: controller.sentInputFocusPending, showCount, writes: structuredClone(writes), events: [...events], active: document.activeElement?.id, height: controller.resize.height }; },
} });
createRoot(document.getElementById('root')).render(<StrictMode><Fixture/></StrictMode>);
`;

type Report = {
  mode: InteractionMode;
  inputVisible: boolean;
  readingVisible: boolean;
  historyVisible: boolean;
  pending: boolean;
  active: string;
  height: number;
  preferences: Required<ExchangePreferences>;
  events: string[];
  writes: Partial<ExchangePreferences>[];
};
const run = (page: Page, name: string, value?: unknown) =>
  page.evaluate(
    ({ name, value }) =>
      Reflect.get(window, "exchangeFixture").run(name, value),
    { name, value },
  );
const report = (page: Page): Promise<Report> =>
  page.evaluate(() => Reflect.get(window, "exchangeFixture").report());
const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );
let server: Awaited<ReturnType<typeof createServer>> | undefined;
let fixtureUrl: string;

// Browser installation and launch belong to the normal Playwright runner. CI
// installs its configured Chrome before test:e2e; this spec never self-skips or
// assumes a machine-specific executable. The virtual source fixture has no API.
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("apps/web"),
    plugins: [
      react(),
      {
        name: "exchange-controller-isolated-regression",
        resolveId(id) {
          if (id === "/__exchange-controller.tsx")
            return "\0exchange-controller.tsx";
        },
        async load(id) {
          if (id === "\0exchange-controller.tsx")
            return transformWithOxc(fixtureModule, "exchange-controller.tsx");
        },
        configureServer(vite) {
          vite.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__exchange-controller") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await vite.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__exchange-controller.tsx"></script></body></html>',
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
  fixtureUrl = `http://127.0.0.1:${address.port}/__exchange-controller`;
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
    await page.waitForFunction(() =>
      Reflect.get(window, "exchangeFixture")?.report(),
    );
    await check(page);
    assert.deepEqual(errors, []);
    assert.deepEqual(businessRequests, []);
  });
}

scenario(
  "focus never opens reading, and explicit reopen shows input only",
  async (page) => {
    await page.locator("#input").focus();
    assert.equal((await report(page)).readingVisible, false);
    await run(page, "hide");
    await frames(page);
    await page.locator("#origin").focus();
    await run(page, "show");
    assert.equal((await report(page)).mode, "input");
    assert.equal((await report(page)).active, "input");
    assert.equal((await report(page)).readingVisible, false);
    assert.equal(await page.locator("#input").inputValue(), "untouched draft");
  },
);
scenario(
  "show preserves existing recent/history and does not replace input",
  async (page) => {
    await page
      .locator("#input")
      .evaluate((element) => element.setAttribute("data-original", "yes"));
    for (const mode of ["input", "recent", "history"] as const) {
      await run(page, "mode", mode);
      await run(page, "show");
      assert.equal((await report(page)).mode, mode);
      assert.equal(
        await page.locator("#input").getAttribute("data-original"),
        "yes",
      );
    }
  },
);
scenario(
  "dialogue hide only blurs, without preference or reading changes",
  async (page) => {
    await run(page, "dialogue", true);
    await page.locator("#input").focus();
    await run(page, "clear-log");
    await run(page, "hide");
    const actual = await report(page);
    assert.notEqual(actual.active, "input");
    assert.equal(actual.inputVisible, true);
    assert.equal(actual.readingVisible, true);
    assert.deepEqual(actual.writes, []);
  },
);
scenario(
  "send focus waits until React removes disabled, keeping reading intent",
  async (page) => {
    await page.locator("#input").focus();
    await run(page, "lock");
    await run(page, "sent");
    assert.equal((await report(page)).pending, true);
    assert.equal((await report(page)).mode, "recent");
    assert.notEqual((await report(page)).active, "input");
    await run(page, "unlock");
    assert.equal((await report(page)).active, "input");
  },
);
scenario(
  "hidden late receipts do not reopen input or acquire focus",
  async (page) => {
    await run(page, "hide");
    await page.locator("#outside").focus();
    await run(page, "lock");
    await run(page, "sent");
    await run(page, "unlock");
    const actual = await report(page);
    assert.equal(actual.mode, "hidden");
    assert.equal(actual.pending, false);
    assert.equal(actual.active, "outside");
  },
);
for (const invalidation of ["navigate", "aba"] as const)
  scenario(
    `send focus rejects ${invalidation} even if the composer is available`,
    async (page) => {
      await run(page, "lock");
      await run(page, "sent");
      await page.locator("#outside").focus();
      await run(page, invalidation, {
        exchangeKey: "surface-B",
        contextKey: "conversation-B:object-B",
        conversationId: "conversation-B",
      });
      await run(page, "unlock");
      assert.equal((await report(page)).active, "outside");
      await run(page, "pulse");
      assert.equal((await report(page)).pending, false);
    },
  );
scenario(
  "send focus rejects another context without requiring a navigation increment",
  async (page) => {
    await run(page, "lock");
    await run(page, "sent-focus", "other-context");
    await page.locator("#outside").focus();
    await run(page, "unlock");
    assert.equal((await report(page)).active, "outside");
  },
);
scenario(
  "named intent waits for the exact conversation and commits after owner restoration",
  async (page) => {
    await page.locator("#outside").focus();
    await run(page, "named-focus", "conversation-B");
    await run(page, "pulse");
    assert.equal((await report(page)).active, "outside");
    await run(page, "clear-log");
    await run(page, "resolve-named", "conversation-B");
    assert.equal((await report(page)).active, "input");
    assert.deepEqual((await report(page)).events, [
      "canvas",
      "trail",
      "input:focus",
      "inspector",
    ]);
  },
);
scenario(
  "named intent is discarded after newer navigation, including ABA",
  async (page) => {
    await page.locator("#outside").focus();
    await run(page, "named-focus", "conversation-B");
    await run(page, "aba");
    await run(page, "resolve-named", "conversation-B");
    assert.equal((await report(page)).active, "outside");
  },
);
scenario(
  "guest show intent cannot focus a newer work surface",
  async (page) => {
    await run(page, "hide");
    await page.locator("#outside").focus();
    await run(page, "show-navigate", {
      exchangeKey: "surface-B",
      contextKey: "conversation-B:object-B",
      conversationId: "conversation-B",
    });
    assert.equal((await report(page)).active, "outside");
  },
);
scenario("delayed hide cannot steal a newer external focus", async (page) => {
  await page.locator("#origin").focus();
  await run(page, "show");
  await page.evaluate(() => {
    Reflect.get(window, "exchangeFixture").run("hide");
    document.getElementById("outside")!.focus();
  });
  await frames(page);
  assert.equal((await report(page)).active, "outside");
});
scenario(
  "delayed hide cannot steal a reopened input or newer navigation",
  async (page) => {
    await page.locator("#origin").focus();
    await run(page, "show");
    await page.evaluate(() => {
      const fixture = Reflect.get(window, "exchangeFixture");
      fixture.run("hide");
      fixture.run("show");
    });
    await frames(page);
    assert.equal((await report(page)).active, "input");
    await page.evaluate(() => {
      const fixture = Reflect.get(window, "exchangeFixture");
      fixture.run("hide");
      fixture.run("navigate", {});
    });
    await frames(page);
    assert.notEqual((await report(page)).active, "origin");
  },
);
scenario(
  "pin and resize write only the original scope; previews never persist height",
  async (page) => {
    await run(page, "clear-log");
    await run(page, "preview", "recent");
    assert.equal((await report(page)).mode, "recent");
    assert.deepEqual((await report(page)).writes, []);
    await run(page, "navigate", {
      exchangeKey: "surface-B",
      contextKey: "conversation-B:object-B",
    });
    assert.equal((await report(page)).mode, "input");
    await run(page, "pin");
    assert.deepEqual((await report(page)).writes.at(-1), {
      pinnedInputs: { "surface-B": false },
    });
    await run(page, "commit", { mode: "recent", height: 310 });
    assert.deepEqual((await report(page)).writes.at(-1), {
      interactions: { "surface-B": "recent" },
      exchangeHeights: { "surface-B": 310 },
    });
    await run(page, "commit", { mode: "history", height: 500 });
    assert.deepEqual((await report(page)).writes.at(-1), {
      interactions: { "surface-B": "history" },
    });
    await run(page, "commit", { mode: "input", height: 0 });
    assert.deepEqual((await report(page)).writes.at(-1), {
      interactions: { "surface-B": "input" },
    });
    assert.deepEqual((await report(page)).preferences.exchangeHeights, {
      "surface-A": 250,
      "surface-B": 310,
    });
    await run(page, "other-mode", "history");
    assert.equal(
      (await report(page)).preferences.interactions["surface-A"],
      "input",
    );
  },
);
scenario(
  "suspension keeps internal/native focus alive; normal outside interaction still hides",
  async (page) => {
    await run(page, "pin");
    await run(page, "suspend", true);
    await page.locator("#input").focus();
    await page.locator("#outside").click();
    await frames(page);
    assert.equal((await report(page)).inputVisible, true);
    await run(page, "suspend", false);
    await page.locator("#input").focus();
    await page.locator("#inside").focus();
    await frames(page);
    assert.equal((await report(page)).inputVisible, true);
    await page.locator("#outside").click();
    await frames(page);
    assert.equal((await report(page)).mode, "hidden");
  },
);
