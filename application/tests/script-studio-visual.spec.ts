import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { createServer, transformWithOxc } from "vite";
import { expect, test, type Page } from "@playwright/test";

// The complete production Studio, Navigation and Editor, with controlled read
// ports only. No App, SQL, model or native-window acceptance is implied here.
const css = [
  ...readFileSync("apps/web/src/main.tsx", "utf8").matchAll(
    /import\s+["'](\.\/[^"']+\.css)["'];/g,
  ),
]
  .map((m) => `import ${JSON.stringify("/src/" + m[1]!.slice(2))};`)
  .join("\n");
const entry = `${css}
import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initialWorkspace } from '/@fs${resolve("packages/core/src/model.ts")}';
import { emptyScriptDraft, emptyScriptBrief, defaultScriptExportTemplate } from '/@fs${resolve("packages/core/src/script-studio.ts")}';
const { ScriptStudio } = await import('/src/ScriptStudio.tsx');
const now = '2026-10-10T00:00:00Z', author = {principalId:'human',actantId:'human-actant'};
const paragraph = '第一场　内景·餐桌·夜\\n\\n桌上摆着两份证件。他停下手里的动作，等她把话说完。\\n\\n林乔：我们先说清楚。\\n陈屿：好，你说。';
const text = paragraph + '\\n\\n' + ('这是按原样保存的创作正文，不猜测分场，不重写对白。'.repeat(12)) + '\\n\\n## 保留原始标记\\n<script>不会执行</script>\\n' + paragraph;
const draft = {...emptyScriptDraft('第一集'),text};
const items = [
 ['outline','outline','五场戏大纲',null,0], ['episode','episode','第一集',null,1],
 ['scene','scene','一场较长的名称，用于检查目录在有限宽度中的信息排列','episode',2],
 ['character-a','character','主角一',null,3], ['character-b','character','主角二',null,4],
 ['source','source','创作参考',null,5],
].map(([id,kind,title,parentId,order]) => ({id,kind,title,parentId,order,revision:1,workflowRevision:1,status:'draft',basis:'original',dependencies:[],characters:[],approval:null,textCharacters:text.length,sourceCount:0,pendingCandidateCount:id==='episode'?Number(new URL(location.href).searchParams.get('count')||1):0,currentPendingReviewCount:0,blockingReviewCount:0,hasText:true,approvalCurrent:false}));
const count = Number(new URL(location.href).searchParams.get('count')||1);
const candidates = Array.from({length:count},(_,at)=>({id:'candidate-'+(at+1),ordinal:at+1,revision:1,status:'pending',stale:false,baseRevision:1,createdAt:now,textCharacters:text.length}));
const book = {id:'production',projectId:'first-project',title:'TEST 剧本视觉回归',revision:1,activityRevision:1,creativeEpoch:1,brief:{...emptyScriptBrief},reviewerPrincipalIds:['human'],template:{...defaultScriptExportTemplate},createdBy:author,createdAt:now,updatedAt:now,totals:{items:items.length,candidates:count,pendingCandidates:count,reviews:0,pendingReviews:0,exports:0,metadataVersions:1},contentId:'catalog',catalogRevision:1,providerRevision:1,items};
const boot = {centerId:'visual-test-center',principalId:'human',csrfToken:'visual-test-identity',actantId:'human-actant',workspace:initialWorkspace(now),scriptLibrary:[{...book,availability:'available'}],runtime:{configured:false,connected:false,harnesses:[]}};
const operations = [];
function version(id,revision=1) { const item=items.find(i=>i.id===id); return {productionId:book.id,itemId:id,kind:item.kind,status:'draft',headRevision:1,workflowRevision:1,revision,candidateId:null,author,createdAt:now,approvalForRequestedVersion:null,draft:{...draft,title:item.title}}; }
const client = {boot,online:true,contentCatalog:[],contentCatalogVersion:1,getSnapshot:()=>boot,
 readScriptEditor:async()=>structuredClone(book),
 readScriptVersion:async(_p,id,revision)=>structuredClone(version(id,revision)),
 readScriptEditorPage:async(_p,pane)=>structuredClone(pane==='candidates'?{candidates,total:count,defaultCandidateId:candidates.at(-1).id}:pane==='versions'?{versions:[version('episode')]}:pane==='reviews'?{reviews:[]}:pane==='events'?{events:[]}:{exports:[]}),
 readScriptCandidate:async(_p,id)=>structuredClone({...candidates.find(c=>c.id===id),draft:{...draft,title:new URL(location.href).searchParams.has('renamed')?'修订后的第一集':draft.title,text:id==='candidate-1'?text:'第二份候选\\n\\n'+text},explanation:'TEST 受控返回，不是模型生成',acceptedRevision:null}),
 listContentPage:async()=>({items:[],nextCursor:null}),
 execute:async(operation)=>{operations.push(structuredClone(operation));if(operation.type!=='set-application-state')throw Error('Visual fixture rejects domain writes');return {saved:true};},
};
Reflect.set(window,'studioVisualFixture',{text,report:()=>({operations,originalText:draft.text})});
const instance={id:'visual-instance',workspaceId:'first-project',revision:1,state:{productionId:book.id,itemId:'episode',view:'editor'}};
createRoot(document.getElementById('root')).render(<StrictMode><div className="app without-collaboration" data-appearance="light" data-accent="cyan" style={{display:'block',height:'100dvh',minHeight:0}}><ScriptStudio client={client} instance={instance} activeView={true} onCompose={()=>({ok:true})} onConceive={()=>{}} onOpenScript={()=>{}} onLibrary={()=>{}} onNotice={()=>{}}/></div></StrictMode>);
`;

let server: Awaited<ReturnType<typeof createServer>>;
let fixtureUrl: string;
const businessRequests = new WeakMap<Page, string[]>();
const pageErrors = new WeakMap<Page, string[]>();
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("apps/web"),
    plugins: [
      react(),
      {
        name: "script-studio-visual-regression",
        resolveId(id) {
          if (id === "/__studio-visual.tsx") return "\0studio-visual.tsx";
        },
        async load(id) {
          if (id === "\0studio-visual.tsx")
            return (
              await transformWithOxc(entry, "studio-visual.tsx", {
                jsx: { runtime: "automatic" },
              })
            ).code;
          const baseline = process.env.MORPHZ_STUDIO_VISUAL_BASELINE;
          if (
            baseline &&
            [
              "script-studio.css",
              "ScriptCandidates.tsx",
              "ScriptStudioEditor.tsx",
            ].some((name) => id === resolve("apps/web/src", name))
          )
            return readFileSync(
              resolve(baseline, "original-" + id.split("/").at(-1)),
              "utf8",
            );
        },
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (req.url?.split("?")[0] !== "/__studio-visual") return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url!,
                '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/__studio-visual.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
    ],
    server: {
      host: "127.0.0.1",
      port: 0,
      hmr: false,
      fs: { allow: [resolve(".")] },
    },
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string")
    throw Error("Missing isolated fixture address");
  fixtureUrl = `http://127.0.0.1:${address.port}/__studio-visual`;
});
test.afterAll(async () => server?.close());
test.beforeEach(async ({ page }) => {
  const requests: string[] = [];
  const errors: string[] = [];
  businessRequests.set(page, requests);
  pageErrors.set(page, errors);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/")) requests.push(r.url());
  });
});
test.afterEach(async ({ page }) => {
  expect(businessRequests.get(page)).toEqual([]);
  expect(pageErrors.get(page)).toEqual([]);
  if (
    !page.isClosed() &&
    (await page.evaluate(() => !!Reflect.get(window, "studioVisualFixture")))
  ) {
    const state = await page.evaluate(() =>
      Reflect.get(window, "studioVisualFixture").report(),
    );
    expect(
      state.operations.every(
        (op: { type: string }) => op.type === "set-application-state",
      ),
    ).toBe(true);
    expect(state.originalText).toContain("## 保留原始标记");
  }
});
async function openCandidate(page: Page, count = 1) {
  await page.goto(fixtureUrl + "?count=" + count);
  await expect(page.getByLabel("剧本正文", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /^候选稿/ }).click();
  await expect(page.locator(".script-candidate-body pre")).toContainText(
    "第一场",
  );
}
test("directory and manuscript have a balanced reading layout", async ({
  page,
}) => {
  await openCandidate(page);
  const metrics = await page.locator(".script-studio").evaluate((root) => {
    const directory = root.querySelector<HTMLElement>(".script-directory")!,
      main = root.querySelector<HTMLElement>(".script-main")!,
      editor = root.querySelector<HTMLElement>(".script-editor")!,
      body = root.querySelector<HTMLElement>(".script-candidate-body pre")!,
      row = root.querySelector<HTMLElement>(".script-tree-row")!,
      group = root.querySelector<HTMLElement>(".script-nav-group")!;
    const m = main.getBoundingClientRect(),
      e = editor.getBoundingClientRect();
    return {
      directory: directory.clientWidth,
      reading: editor.clientWidth,
      rowHeight: row.clientHeight,
      font: parseFloat(getComputedStyle(row).fontSize),
      groupGap: parseFloat(getComputedStyle(group).marginTop),
      balance: Math.abs(e.left - m.left - (m.right - e.right)),
      textAlign: getComputedStyle(body).textAlign,
    };
  });
  expect(metrics.directory).toBeGreaterThanOrEqual(232);
  expect(metrics.directory).toBeLessThanOrEqual(272);
  expect(metrics.reading).toBeLessThanOrEqual(820);
  expect(metrics.rowHeight).toBeGreaterThanOrEqual(36);
  expect(metrics.font).toBeGreaterThanOrEqual(13);
  expect(metrics.groupGap).toBeGreaterThanOrEqual(14);
  expect(metrics.balance).toBeLessThanOrEqual(1);
  // Centre the reading column, not each line of long-form prose.
  expect(["start", "left"]).toContain(metrics.textAlign);
});
test("one candidate needs no redundant switcher or repeated unchanged title", async ({
  page,
}) => {
  await openCandidate(page);
  await expect(
    page.getByRole("navigation", { name: "选择候选稿" }),
  ).toHaveCount(0);
  await expect(page.locator(".script-candidate-body h4")).toHaveCount(0);
  await expect(page.locator(".script-candidate-heading")).toContainText(
    "候选 1",
  );
  await expect(page.locator(".script-candidate-heading")).toContainText(
    "待决定",
  );
});
for (const [width, appearance, zoom] of [
  [1440, "light", 1],
  [1440, "dark", 1],
  [920, "light", 1],
  [560, "light", 1],
  [560, "dark", 1],
  [760, "light", 2],
] as const) {
  test(`readable actual Studio ${width}/${appearance}/zoom${zoom}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 960 });
    await openCandidate(page);
    await page.evaluate(
      ({ appearance, zoom }) => {
        document.documentElement.dataset.appearance = appearance;
        document.querySelector<HTMLElement>(".app")!.dataset.appearance =
          appearance;
        document.documentElement.style.zoom = String(zoom);
      },
      { appearance, zoom },
    );
    await expect
      .poll(() => page.locator(".script-layout").getAttribute("data-compact"))
      .toBe(String(width / zoom <= 680));
    const pre = page.locator(".script-candidate-body pre");
    await expect(pre).toHaveText(
      await page.evaluate(
        () => Reflect.get(window, "studioVisualFixture").text,
      ),
    );
    await expect(pre.locator("script,h1,h2")).toHaveCount(0);
    const geometry = await page.locator(".script-studio").evaluate((root) => {
      const body = root.querySelector<HTMLElement>(".script-candidate-body")!,
        editor = root.querySelector<HTMLElement>(".script-editor")!;
      return {
        documentOverflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
        bodyOverflow: body.scrollWidth - body.clientWidth,
        editorOverflow: editor.scrollWidth - editor.clientWidth,
      };
    });
    expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
    expect(geometry.bodyOverflow).toBeLessThanOrEqual(1);
    expect(geometry.editorOverflow).toBeLessThanOrEqual(1);
    for (const name of ["拒绝候选", "采纳为新版本"]) {
      const button = page.getByRole("button", { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      expect(
        await button.evaluate((e) => {
          const b = e.getBoundingClientRect();
          return e.contains(
            document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2),
          );
        }),
      ).toBe(true);
    }
    await page.screenshot({
      path: info.outputPath(`candidate-${width}-${appearance}-${zoom}.png`),
    });
    await info.attach("layout", {
      body: JSON.stringify(geometry),
      contentType: "application/json",
    });
  });
}
test("body and history keep original text and readable type; multiple candidates remain selectable", async ({
  page,
}, info) => {
  await openCandidate(page, 2);
  await page
    .getByRole("button", { name: "候选 1 · 待决定", exact: true })
    .focus();
  await page.keyboard.press("Space");
  await expect(page.locator(".script-candidate-body pre")).toHaveText(
    await page.evaluate(() => Reflect.get(window, "studioVisualFixture").text),
  );
  await page.getByRole("tab", { name: "正文", exact: true }).click();
  const body = page.getByLabel("剧本正文", { exact: true });
  await expect(body).toHaveValue(
    await page.evaluate(() => Reflect.get(window, "studioVisualFixture").text),
  );
  expect(
    await body.evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
  ).toBeGreaterThanOrEqual(15);
  await page.screenshot({ path: info.outputPath("body-light.png") });
  await page.getByRole("tab", { name: "历史", exact: true }).click();
  const history = page.locator(".script-history > pre");
  await expect(history).toHaveText(
    await page.evaluate(() => Reflect.get(window, "studioVisualFixture").text),
  );
  expect(
    await history.evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
  ).toBeGreaterThanOrEqual(15);
  await page.screenshot({ path: info.outputPath("history-light.png") });
});
test("reviews, overview and renamed candidate retain meaningful titles and consistent content width", async ({
  page,
}, info) => {
  await page.goto(fixtureUrl + "?count=1&renamed=1");
  await expect(page.getByLabel("剧本正文", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /^候选稿/ }).click();
  await expect(page.locator(".script-candidate-body h4")).toHaveText(
    "修订后的第一集",
  );
  await page.getByRole("tab", { name: "审阅", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "人工审阅与锁稿" }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("reviews-light.png") });
  await page
    .getByRole("navigation", { name: "剧本目录" })
    .getByRole("button", { name: "概览", exact: true })
    .click();
  await expect(page.locator(".script-overview")).toBeVisible();
  expect(
    await page.locator(".script-overview").evaluate((e) => e.clientWidth),
  ).toBeLessThanOrEqual(820);
  await page.screenshot({ path: info.outputPath("overview-light.png") });
});
