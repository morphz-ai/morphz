import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer, transformWithOxc } from "vite";
import react from "@vitejs/plugin-react";
import { expect, test, type Page } from "@playwright/test";

// Actual React mounts of the production hooks/factory and real browser storage.
// No App, business Host, navigation, Runtime, model or native-window acceptance.
// StrictMode may replay lazy initializers; it must not invent draft commands.
const fixtureModule = `
import React, { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  useExchangeInputDraftState, useExchangeConversationDraftState,
  useExchangeDiscardedDraftState, createExchangeDraftCommands,
} from '/src/host/exchange-drafts.ts';
import { scopedStorage, draftKey, draftOwner } from '/src/local-preferences.ts';
const root = createRoot(document.getElementById('root'));
const reads = [], writes = [], notices = [], events = [];
let state, commands, redraw, rememberedRef, renderCount = 0;
function tracedStorage(scope) {
  const actual = scopedStorage(scope);
  return {
    readLocal(key, fallback) { reads.push({ scope, key }); return actual.readLocal(key, fallback); },
    writeLocal(key, value) { writes.push({ scope, key }); actual.writeLocal(key, value); },
  };
}
function Fixture({ scope, storage }) {
  const [, setRender] = useState(0);
  const inputs = useExchangeInputDraftState(storage);
  const conversations = useExchangeConversationDraftState(storage);
  const discarded = useExchangeDiscardedDraftState(storage);
  commands = createExchangeDraftCommands({ inputs, conversations, discarded, storage, onNotice: message => notices.push(message) });
  state = { scope, inputs, conversations, discarded };
  redraw = () => setRender(previous => previous + 1);
  renderCount++;
  return <pre id="state">{JSON.stringify({ scope, inputs: inputs.value, conversations: conversations.value, discarded: discarded.value })}</pre>;
}
Object.assign(window, { exchangeDraftFixture: {
  mount({ center = 'center-a', principal = 'human-a', strict = false } = {}) {
    const scope = center + ':' + principal;
    const element = <Fixture key={scope} scope={scope} storage={tracedStorage(scope)}/>;
    flushSync(() => root.render(strict ? <StrictMode>{element}</StrictMode> : element));
  },
  run(action, value) {
    let result;
    flushSync(() => {
      if (action === 'render') redraw();
      else if (action === 'create') result = commands.createConversation(value.project, value.title);
      else if (action === 'create-pair') {
        const ref = state.conversations.ref;
        rememberedRef = ref;
        const first = commands.createConversation(value.project, '第一次标题');
        const refImmediate = ref.current[value.project] === first;
        const second = commands.createConversation(value.project, '不能替换的标题');
        result = { first, second, same: first === second, refImmediate, refObjectSame: state.conversations.ref === ref };
      } else if (action === 'input') commands.writeInputs(previous => ({ ...previous, [value.key]: value.draft }));
      else if (action === 'input-sequence') {
        commands.writeInputs(previous => ({ ...previous, [value.key]: { body: '第一段', selection: '原始引用', revision: 2, model: 'fixture-model', reasoningEffort: 'max' } }));
        commands.writeInputs(previous => ({ ...previous, [value.key]: { ...previous[value.key], body: previous[value.key].body + '\\n第二段' }, companion: { body: '另一个待保存输入', selection: '', revision: null } }));
      } else if (action === 'discard') commands.discardConversation(value, () => { events.push('persisted-lookup'); return undefined; }, entry => events.push('discard:' + entry.id));
      else if (action === 'restore') commands.restoreConversation(value, id => Object.entries(state.inputs.value).some(([key, draft]) => key.startsWith(id + ':') && !!draft.body), entry => events.push('restore:' + entry.id));
      else throw new Error('Unknown fixture action: ' + action);
    });
    return result;
  },
  report() { return {
    owner: draftOwner, keys: ['inputs', 'conversations', 'discarded-conversations'].map(draftKey),
    scope: state?.scope, inputs: state?.inputs.value, conversations: state?.conversations.value, discarded: state?.discarded.value,
    refMatches: state?.conversations.ref.current === state?.conversations.value,
    refObjectSame: rememberedRef === state?.conversations.ref,
    reads: [...reads], writes: [...writes], notices: [...notices], events: [...events], renderCount,
  }; },
} });
`;

type Draft = {
  body: string;
  selection: string;
  revision: number | null;
  model?: string;
  reasoningEffort?: string;
};
type Conversation = {
  id: string;
  projectId: string;
  title: string;
  inputId: string;
};
type Report = {
  owner: string;
  keys: string[];
  scope: string;
  inputs: Record<string, Draft>;
  conversations: Record<string, Conversation>;
  discarded: Record<
    string,
    { conversation: Conversation; drafts: Record<string, Draft> }
  >;
  refMatches: boolean;
  refObjectSame: boolean;
  reads: { scope: string; key: string }[];
  writes: { scope: string; key: string }[];
  notices: string[];
  events: string[];
  renderCount: number;
};
type Scope = { center?: string; principal?: string; strict?: boolean };
const report = (page: Page): Promise<Report> =>
  page.evaluate(() => Reflect.get(window, "exchangeDraftFixture").report());
const run = <T = void>(
  page: Page,
  action: string,
  value?: unknown,
): Promise<T> =>
  page.evaluate(
    ({ action, value }) =>
      Reflect.get(window, "exchangeDraftFixture").run(action, value),
    { action, value },
  );
async function mount(page: Page, scope: Scope = {}) {
  await page.evaluate(
    (value) => Reflect.get(window, "exchangeDraftFixture").mount(value),
    scope,
  );
  await expect(page.locator("#state")).toBeVisible();
}
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );
}
let server: Awaited<ReturnType<typeof createServer>> | undefined;
let fixtureUrl: string;

// The suite owns only an OS-selected ephemeral Vite port, never Host :65421.
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    cacheDir: resolve(tmpdir(), `morphz-exchange-draft-vite-${process.pid}`),
    root: resolve("apps/web"),
    plugins: [
      react(),
      {
        name: "exchange-draft-isolated-regression",
        resolveId(id) {
          if (id === "/__exchange-drafts.tsx") return "\0exchange-drafts.tsx";
        },
        async load(id) {
          if (id === "\0exchange-drafts.tsx")
            return transformWithOxc(fixtureModule, "exchange-drafts.tsx");
        },
        configureServer(vite) {
          vite.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__exchange-drafts") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await vite.transformIndexHtml(
                request.url,
                '<!doctype html><html><body><div id="root"></div><script type="module" src="/__exchange-drafts.tsx"></script></body></html>',
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
  fixtureUrl = `http://127.0.0.1:${address.port}/__exchange-drafts`;
});
test.afterAll(async () => {
  await server?.close();
});

function scenario(
  name: string,
  check: (page: Page, watch: (page: Page) => void) => Promise<void>,
) {
  test(name, async ({ page }) => {
    const errors: string[] = [],
      businessRequests: string[] = [];
    const watch = (target: Page) => {
      target.on("pageerror", (error) => errors.push(error.message));
      target.on("request", (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/"))
          businessRequests.push(request.url());
      });
    };
    watch(page);
    await page.goto(fixtureUrl);
    await page.waitForFunction(
      () => !!Reflect.get(window, "exchangeDraftFixture"),
    );
    await check(page, watch);
    assert.deepEqual(errors, []);
    assert.deepEqual(businessRequests, []);
  });
}

scenario(
  "three original keys initialize once; repeated React renders do not read or write drafts",
  async (page) => {
    await mount(page);
    const initial = await report(page);
    assert.deepEqual(
      initial.keys,
      ["inputs", "conversations", "discarded-conversations"].map(
        (key) => `draft:${initial.owner}:${key}`,
      ),
    );
    assert.deepEqual(
      initial.reads,
      initial.keys.map((key) => ({ scope: "center-a:human-a", key })),
    );
    assert.deepEqual(
      [initial.inputs, initial.conversations, initial.discarded],
      [{}, {}, {}],
    );
    for (let count = 0; count < 3; count++) await run(page, "render");
    await settle(page);
    const repeated = await report(page);
    assert.ok(repeated.renderCount > initial.renderCount);
    assert.deepEqual(repeated.reads, initial.reads);
    assert.deepEqual(repeated.writes, []);
    assert.deepEqual(repeated.events, []);
    assert.deepEqual(repeated.notices, []);
    assert.equal(repeated.refMatches, true);
  },
);

scenario(
  "same-tick creates keep IDs/ref; functional inputs see the latest pending update",
  async (page) => {
    await mount(page);
    const created = await run<{
      first: Conversation;
      second: Conversation;
      same: boolean;
      refImmediate: boolean;
      refObjectSame: boolean;
    }>(page, "create-pair", { project: "project-a" });
    assert.equal(created.same, true);
    assert.equal(created.refImmediate, true);
    assert.equal(created.refObjectSame, true);
    assert.deepEqual(created.first, created.second);
    assert.equal(created.first.title, "第一次标题");
    assert.match(created.first.id, /^[\da-f-]{36}$/);
    assert.match(created.first.inputId, /^[\da-f-]{36}$/);
    assert.notEqual(created.first.id, created.first.inputId);
    assert.deepEqual(
      await run<Conversation>(page, "create", {
        project: "project-a",
        title: "重新渲染后也不能替换",
      }),
      created.first,
    );
    const key = `${created.first.id}:document-v2`;
    await run(page, "input-sequence", { key });
    const current = await report(page);
    assert.equal(current.refMatches, true);
    assert.equal(current.refObjectSame, true);
    assert.deepEqual(current.conversations["project-a"], created.first);
    assert.deepEqual(current.inputs[key], {
      body: "第一段\n第二段",
      selection: "原始引用",
      revision: 2,
      model: "fixture-model",
      reasoningEffort: "max",
    });
    assert.equal(current.inputs.companion?.body, "另一个待保存输入");
    assert.deepEqual(
      current.writes.map((write) => write.key),
      [current.keys[1], current.keys[0], current.keys[0]],
    );
    await page.reload();
    await page.waitForFunction(
      () => !!Reflect.get(window, "exchangeDraftFixture"),
    );
    await mount(page);
    const recovered = await report(page);
    assert.equal(recovered.owner, current.owner);
    assert.deepEqual(recovered.inputs, current.inputs);
    assert.deepEqual(recovered.conversations, current.conversations);
  },
);

scenario(
  "keyed center/principal remount and independent windows isolate bodies, input settings and recovered drafts",
  async (page, watch) => {
    await mount(page);
    const original = await run<Conversation>(page, "create", {
      project: "project-a",
      title: "身份 A 草稿",
    });
    const key = `${original.id}:desk`;
    const originalDraft: Draft = {
      body: "A 原文\n保留换行",
      selection: "A 引用",
      revision: 4,
      model: "model-a",
      reasoningEffort: "max",
    };
    await run(page, "input", { key, draft: originalDraft });
    await run(page, "discard", original.id);
    const discarded = await report(page);
    assert.deepEqual(discarded.discarded[original.id], {
      conversation: original,
      drafts: { [key]: originalDraft },
    });
    for (const scope of [
      { center: "center-b", principal: "human-a" },
      { center: "center-a", principal: "human-b" },
    ]) {
      await mount(page, scope);
      const empty = await report(page);
      assert.deepEqual(
        [empty.inputs, empty.conversations, empty.discarded],
        [{}, {}, {}],
      );
      await run(page, "restore", original.id);
      assert.equal((await report(page)).writes.length, empty.writes.length);
      const other = await run<Conversation>(page, "create", {
        project: "project-a",
        title: "另一个身份",
      });
      assert.notEqual(other.id, original.id);
      await run(page, "input", {
        key: `${other.id}:desk`,
        draft: {
          ...originalDraft,
          body: scope.center + scope.principal,
          model: "other-model",
          reasoningEffort: "low",
        },
      });
    }
    await mount(page);
    assert.deepEqual((await report(page)).discarded, discarded.discarded);
    await run(page, "restore", original.id);
    const restored = await report(page);
    assert.deepEqual(restored.inputs, { [key]: originalDraft });
    assert.deepEqual(restored.conversations, { "project-a": original });
    assert.deepEqual(restored.discarded, {});
    assert.equal(restored.refMatches, true);
    assert.deepEqual(restored.events, [
      `discard:${original.id}`,
      `restore:${original.id}`,
    ]);
    const second = await page.context().newPage();
    watch(second);
    try {
      await second.goto(fixtureUrl);
      await second.waitForFunction(
        () => !!Reflect.get(window, "exchangeDraftFixture"),
      );
      await mount(second);
      const separate = await report(second);
      assert.notEqual(separate.owner, restored.owner);
      assert.deepEqual(
        [separate.inputs, separate.conversations, separate.discarded],
        [{}, {}, {}],
      );
      const secondConversation = await run<Conversation>(second, "create", {
        project: "project-a",
        title: "窗口 B",
      });
      await run(second, "input", {
        key: `${secondConversation.id}:desk`,
        draft: {
          ...originalDraft,
          body: "第二窗口原文",
          model: "window-model",
        },
      });
      await run(second, "discard", secondConversation.id);
      await second.reload();
      await second.waitForFunction(
        () => !!Reflect.get(window, "exchangeDraftFixture"),
      );
      await mount(second);
      assert.equal((await report(second)).owner, separate.owner);
      await run(second, "restore", secondConversation.id);
      assert.equal(
        (await report(second)).inputs[`${secondConversation.id}:desk`]?.model,
        "window-model",
      );
      assert.equal(
        (await report(second)).inputs[`${secondConversation.id}:desk`]?.body,
        "第二窗口原文",
      );
      await page.reload();
      await page.waitForFunction(
        () => !!Reflect.get(window, "exchangeDraftFixture"),
      );
      await mount(page);
      const recovered = await report(page);
      assert.equal(recovered.owner, restored.owner);
      assert.deepEqual(recovered.inputs, restored.inputs);
      assert.deepEqual(recovered.conversations, restored.conversations);
    } finally {
      await second.close();
    }
  },
);

scenario(
  "StrictMode mount and render replay never issue spontaneous draft writes or commands",
  async (page) => {
    await mount(page, { strict: true });
    await settle(page);
    const initial = await report(page);
    assert.ok(initial.renderCount >= 2);
    assert.ok(initial.reads.length >= 3);
    assert.deepEqual(
      [...new Set(initial.reads.map((read) => read.key))],
      initial.keys,
    );
    for (let count = 0; count < 3; count++) await run(page, "render");
    await settle(page);
    const repeated = await report(page);
    assert.ok(repeated.renderCount > initial.renderCount);
    assert.deepEqual(repeated.reads, initial.reads);
    assert.deepEqual(repeated.writes, []);
    assert.deepEqual(repeated.events, []);
    assert.deepEqual(repeated.notices, []);
    assert.deepEqual(
      [repeated.inputs, repeated.conversations, repeated.discarded],
      [{}, {}, {}],
    );
  },
);
