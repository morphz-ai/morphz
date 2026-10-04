import assert from "node:assert/strict";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { createServer, transformWithOxc } from "vite";
import { expect, test, type Page } from "@playwright/test";

// Mount the actual editor and focus-return helper. Only the command/read ports
// are controlled: there is no App, business Host, Runtime or model request.
// The run port retains the existing early focus return so the deferred version
// read makes the observed Save -> disabled -> body race deterministic.
const fixtureModule = `
import React, { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ScriptItemEditor } from '/src/ScriptStudioEditor.tsx';
import { scriptFocusReturn } from '/src/script-studio-focus.ts';
import { emptyScriptBrief, emptyScriptDraft, defaultScriptExportTemplate } from '/@fs${resolve("packages/core/src/script-studio.ts")}';
const original = emptyScriptDraft('保存焦点场景');
original.text = '原始正文';
const author = { principalId: 'human', actantId: 'human-actant' };
const now = '2026-10-04T00:00:00.000Z';
const boot = { centerId: 'save-focus-center', principalId: 'human', csrfToken: 'save-focus-identity', workspace: { actants: [], artifacts: [] } };
let revision = 1, submitted, resolveCommand, resolveVersion, rejectVersion, change, phase = 'initial';
const events = [], remembered = new Map();
function item() { return {
  id: 'scene', kind: 'scene', revision, workflowRevision: 1, status: 'draft',
  title: original.title, parentId: null, order: 0, basis: 'original', dependencies: [],
  characters: [], approval: null, textCharacters: original.text.length, sourceCount: 0,
  pendingCandidateCount: 0, currentPendingReviewCount: 0, blockingReviewCount: 0,
  hasText: true, approvalCurrent: false,
}; }
function production() { return {
  id: 'production', projectId: 'desk', title: '保存焦点剧本', revision: 1,
  brief: { ...emptyScriptBrief }, reviewerPrincipalIds: [], template: { ...defaultScriptExportTemplate },
  createdBy: author, createdAt: now, updatedAt: now, activityRevision: revision,
  creativeEpoch: 1, totals: { items: 1, candidates: 0, pendingCandidates: 0, reviews: 0, pendingReviews: 0, exports: 0, metadataVersions: 1 },
  contentId: 'catalog', catalogRevision: revision, providerRevision: revision, items: [item()],
}; }
function version(at) { return {
  productionId: 'production', itemId: 'scene', kind: 'scene', status: 'draft',
  headRevision: revision, workflowRevision: 1, revision: at, candidateId: null,
  author, createdAt: now, approvalForRequestedVersion: null,
  draft: structuredClone(at === 1 ? original : submitted),
}; }
const client = {
  boot, contentCatalog: [], contentCatalogVersion: 0,
  getSnapshot: () => boot,
  async readScriptEditor() { events.push('read-editor'); return { ...production(), activityRevision: 2 }; },
  readScriptVersion(_production, _item, exactRevision) {
    if (exactRevision !== undefined) return Promise.resolve(version(exactRevision));
    events.push('read-version-held'); phase = 'version';
    return new Promise((resolve, reject) => { resolveVersion = resolve; rejectVersion = reject; });
  },
};
function Fixture() {
  const [busy, setBusy] = useState(false), [head, setHead] = useState(1), [mounted, setMounted] = useState(true);
  change = (name) => flushSync(() => name === 'head' ? setHead(revision) : setMounted(false));
  const run = async command => {
    submitted = structuredClone(command.draft);
    const restore = scriptFocusReturn(document.activeElement?.closest('.script-editor') ?? null);
    flushSync(() => setBusy(true));
    phase = 'command'; events.push('run');
    try {
      await new Promise(resolve => { resolveCommand = resolve; });
      events.push('command-resolved');
      return { saved: true };
    } finally {
      flushSync(() => setBusy(false));
      restore(); events.push('early-return-scheduled');
    }
  };
  return <main data-head={head}>
    <button id="newer-focus">较新的操作</button>
    {mounted && <ScriptItemEditor client={client} production={production()} item={item()} canWrite={!busy} run={run} onCompose={() => ({ accepted: true })}/>}
  </main>;
}
Object.assign(window, { scriptSaveFocusFixture: {
  commandResolved() { if (phase !== 'command') throw new Error('No pending command'); resolveCommand(); },
  finish(mode) {
    if (phase !== 'version') throw new Error('No held version read');
    if (mode === 'reject') rejectVersion(new Error('TEST 精确正文读取失败'));
    else { revision = 2; change('head'); resolveVersion(version(2)); }
    phase = 'settled';
  },
  unmount() { change('unmount'); },
  remember() { remembered.set('save', Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '保存文稿')); },
  report() { return {
    phase, events: [...events],
    sameSave: remembered.get('save') === Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '保存文稿'),
    originConnected: remembered.get('save')?.isConnected ?? false,
  }; },
} });
createRoot(document.getElementById('root')).render(<StrictMode><Fixture/></StrictMode>);
`;

let server: Awaited<ReturnType<typeof createServer>> | undefined;
let fixtureUrl: string;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("apps/web"),
    plugins: [
      react(),
      {
        name: "script-save-focus-isolated-regression",
        resolveId(id) {
          if (id === "/__script-save-focus.tsx")
            return "\0script-save-focus.tsx";
        },
        async load(id) {
          if (id === "\0script-save-focus.tsx")
            return transformWithOxc(fixtureModule, "script-save-focus.tsx");
        },
        configureServer(vite) {
          vite.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__script-save-focus") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await vite.transformIndexHtml(
                request.url,
                '<!doctype html><html><head><style>body{margin:16px}button,input,textarea{margin:4px;padding:8px}.script-editor{min-height:300px}strong{display:inline-block;padding:8px}</style></head><body><div id="root"></div><script type="module" src="/__script-save-focus.tsx"></script></body></html>',
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
  fixtureUrl = `http://127.0.0.1:${address.port}/__script-save-focus`;
});
test.afterAll(async () => {
  await server?.close();
});

type Report = {
  phase: string;
  events: string[];
  sameSave: boolean;
  originConnected: boolean;
};
const report = (page: Page): Promise<Report> =>
  page.evaluate(() => Reflect.get(window, "scriptSaveFocusFixture").report());
const run = (page: Page, method: string, value?: string) =>
  page.evaluate(
    ({ method, value }) =>
      Reflect.get(window, "scriptSaveFocusFixture")[method](value),
    { method, value },
  );
const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

async function startSave(page: Page) {
  await expect(page.getByLabel("剧本正文", { exact: true })).toHaveValue(
    "原始正文",
  );
  await page
    .getByLabel("剧本正文", { exact: true })
    .fill("TEST 完整保存必须在精确正文读取完成后恢复焦点");
  const save = page.getByRole("button", { name: "保存文稿", exact: true });
  await expect(save).toBeEnabled();
  await run(page, "remember");
  await save.click();
  await expect(save).toBeDisabled();
  await run(page, "commandResolved");
  await page.waitForFunction(
    () =>
      Reflect.get(window, "scriptSaveFocusFixture").report().phase ===
      "version",
  );
  await expect(save).toBeEnabled();
  await frames(page);
  // Verify the real early-restore state, not just that focus() was invoked.
  await expect(save).toBeFocused();
  assert.equal((await report(page)).sameSave, true);
  assert.deepEqual((await report(page)).events, [
    "run",
    "command-resolved",
    "early-return-scheduled",
    "read-editor",
    "read-version-held",
  ]);
  return save;
}

function scenario(name: string, check: (page: Page) => Promise<void>) {
  test(name, async ({ page }) => {
    const errors: string[] = [],
      requests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/"))
        requests.push(request.url());
    });
    await page.goto(fixtureUrl);
    await check(page);
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, []);
  });
}

scenario(
  "完整保存晚回执禁用同一 Save 后，真实焦点返回原编辑器 anchor",
  async (page) => {
    const save = await startSave(page);
    await run(page, "finish", "success");
    await expect(save).toBeDisabled();
    await expect(
      page.locator(".script-editor [data-script-focus-anchor]"),
    ).toBeFocused();
    await expect(page.getByRole("status")).toContainText("已保存 v2");
    await expect(page.getByLabel("剧本正文", { exact: true })).toHaveValue(
      "TEST 完整保存必须在精确正文读取完成后恢复焦点",
    );
    assert.equal((await report(page)).sameSave, true);
  },
);

scenario(
  "保存读取失败保留草稿，并恢复真实可用的原 Save 触发器",
  async (page) => {
    const save = await startSave(page);
    await run(page, "finish", "reject");
    await expect(page.getByRole("alert")).toContainText(
      "TEST 精确正文读取失败",
    );
    await expect(save).toBeEnabled();
    await expect(save).toBeFocused();
    await expect(page.getByLabel("剧本正文", { exact: true })).toHaveValue(
      "TEST 完整保存必须在精确正文读取完成后恢复焦点",
    );
    assert.equal((await report(page)).sameSave, true);
  },
);

scenario("完整保存晚回执不能抢走较新的真实可用焦点", async (page) => {
  const save = await startSave(page);
  const newer = page.getByRole("button", { name: "较新的操作", exact: true });
  await newer.click();
  await expect(newer).toBeFocused();
  await run(page, "finish", "success");
  await expect(save).toBeDisabled();
  await frames(page);
  await expect(newer).toBeFocused();
  assert.equal((await report(page)).sameSave, true);
});

scenario("原编辑器卸载后，保存晚回执不转去另一个可用元素", async (page) => {
  await startSave(page);
  await run(page, "unmount");
  assert.equal((await report(page)).originConnected, false);
  const newer = page.getByRole("button", { name: "较新的操作", exact: true });
  await newer.click();
  await run(page, "finish", "success");
  await frames(page);
  await expect(newer).toBeFocused();
  await expect(page.locator(".script-editor")).toHaveCount(0);
});
