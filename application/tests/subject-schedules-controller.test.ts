import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, type Page } from "@playwright/test";
import { createServer, transformWithOxc } from "vite";
import {
  nativeSchedule,
  scheduleActivity,
  scheduleOriginal,
  scheduleRuntime,
  scheduleTask,
} from "./fixtures/subject-schedules-controller.js";

// Full current renderer and original applicationCall bridge. Controlled logical
// replies prove UI/controller contracts, not HTTP/SQL authorization or OS focus.
const migration =
  process.env.MORPHZ_TEST_SUBJECT_SCHEDULES_MIGRATION_EQUIVALENCE === "1";
function oldSource() {
  if (!migration) return null;
  const directory = process.env.MORPHZ_TEST_SUBJECT_SCHEDULES_BASELINE_DIR;
  assert(directory, "explicit schedule migration requires BASELINE_DIR");
  const manifest = JSON.parse(
    readFileSync(resolve(directory, "manifest.json"), "utf8"),
  );
  for (const field of [
    "originalGit",
    "source",
    "file",
    "sha256",
    "bytes",
  ] as const)
    assert.equal(manifest[field], scheduleOriginal.manifest[field]);
  const raw = readFileSync(resolve(directory, manifest.file), "utf8");
  assert.equal(createHash("sha256").update(raw).digest("hex"), manifest.sha256);
  return raw;
}
const cssImports = [
  ...readFileSync("apps/web/src/main.tsx", "utf8").matchAll(
    /import\s+["'](\.\/[^"']+\.css)["'];/g,
  ),
]
  .map((m) => `import ${JSON.stringify("/src/" + m[1]!.slice(2))};`)
  .join("\n");
const fixture = `
import React,{StrictMode,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {SubjectSchedules as Current} from '/src/SubjectSchedules.tsx';
import {SubjectSchedules as Historical} from '__SCHEDULE_HISTORY__';
import {scheduleActivity} from '/@fs/${resolve("tests/fixtures/subject-schedules-controller.ts")}';
${cssImports}
const Component=new URL(location.href).searchParams.get('lane')==='historical'?Historical:Current;
const root=createRoot(document.getElementById('root')),allRequests=new Map();
let serial=0,requestId=0,requests=[],events=[],api,config,initialSection,initialRefresh,unmounted=false;
// Only bridge request IDs are test-owned deterministic UUIDs. No DOM/ARIA,
// schedule IDs, source scopes, errors or public observations are normalized.
crypto.randomUUID=()=> '00000000-0000-4000-8000-'+String(++requestId).padStart(12,'0');
function deferred(method,params,generation,id,label){
 const index=requests.length;events.push(['request',index,method,generation??null,label??null]);
 return new Promise((accept,reject)=>{const r={index,id:id??null,method,params,generation:generation??null,label:label??null,accept,reject,settled:false,aborted:false};requests.push(r);if(id)allRequests.set(id,r);});
}
window.morphzDesktop={application:{invoke:r=>deferred(r.method,r.params,r.identityGeneration,r.id),cancel:id=>{const r=allRequests.get(id);if(r){r.aborted=true;events.push(['cancel',r.index,r.method]);}}}};
const defaults={identity:'csrf-A',label:'A',online:true,connected:true,activity:scheduleActivity(),revision:0,show:true};
function Frame({initial}){
 const [value,setValue]=useState({...defaults,...initial});config=value;
 const label=value.label;
 const client={online:value.online,workspaceChangeRevision:value.revision,boot:{csrfToken:value.identity,runtime:{connected:value.connected,activity:value.activity}},refresh:()=>deferred('client.refresh',[],undefined,undefined,label)};
 api={set:patch=>setValue(old=>({...old,...patch}))};
 return <div className="app" data-appearance="light" data-accent="cyan"><aside className="subject-sidebar">{value.show&&<Component client={client} onOpen={id=>events.push(['open',id])} onInspect={scope=>events.push(['inspect',scope])}/>}</aside></div>;
}
async function settle(){for(let i=0;i<3;i++){await Promise.resolve();await new Promise(done=>{const c=new MessageChannel();c.port1.onmessage=()=>{c.port1.close();c.port2.close();done();};c.port2.postMessage(null);});}}
function report(){const section=document.querySelector('.subject-section'),refresh=section?.querySelector('[aria-label="刷新定时任务"]'),active=document.activeElement;return {
 dom:section?.outerHTML??null,present:!!section,loading:section?.textContent.includes('读取中…')??false,empty:section?.textContent.includes('暂无可确认的定时任务')??false,
 alert:section?.querySelector('[role="alert"]')?.textContent.trim()??null,more:section?.textContent.includes('事项绑定的定时任务未全部读取')??false,quality:section?.textContent.includes('部分定时任务来源尚未核验')??false,
 disabled:refresh?.disabled??null,records:[...section?.querySelectorAll('.subject-record')??[]].map(n=>({tag:n.tagName,id:n.getAttribute('data-schedule-id'),title:n.querySelector('strong')?.textContent,label:n.querySelector('small')?.textContent})),
 sameSection:section===initialSection,sameRefresh:refresh===initialRefresh,active:active?.getAttribute('aria-label')||active?.id||active?.tagName,
 requests:requests.map(({index,id,method,params,generation,label,settled,aborted})=>({index,id,method,params,generation,label,settled,aborted})),events:[...events],globalUnsettled:[...allRequests.values()].filter(r=>!r.settled).length,unmounted};}
function release(r,value){r.settled=true;r.accept(r.method==='client.refresh'?value:{ok:true,value});}
function reset(initial={}){const previous=requests;flushSync(()=>root.render(null));for(const r of previous)if(!r.settled)release(r,undefined);requests=[];events=[];unmounted=false;flushSync(()=>root.render(<StrictMode><Frame key={++serial} initial={initial}/></StrictMode>));initialSection=document.querySelector('.subject-section');initialRefresh=initialSection?.querySelector('[aria-label="刷新定时任务"]');}
window.scheduleFixture={report,settle,reset,async run(name,value){
 if(name==='set')flushSync(()=>api.set(value));
 else if(name==='release'){const r=requests[value.index];if(!r||r.settled)throw Error('invalid request '+value.index);events.push(['release',r.index]);if(value.error==='nonerror'){r.settled=true;r.reject('TEST nonerror');}else if(value.error==='error'){r.settled=true;r.reject(Error(value.message));}else if(value.error==='reply'){r.settled=true;r.accept({ok:false,error:{status:503,message:value.message}});}else release(r,value.value);}
 else if(name==='unmount'){flushSync(()=>api.set({show:false}));unmounted=true;}
 else throw Error('unknown operation '+name);
 await settle();return report();},async cleanup(){flushSync(()=>root.unmount());unmounted=true;for(const r of allRequests.values())if(!r.settled)release(r,undefined);for(const r of requests)if(!r.settled)release(r,undefined);await settle();return report();}};
reset();
`;
type Request = {
  index: number;
  id: string | null;
  method: string;
  params: unknown;
  generation: string | null;
  label: string | null;
  settled: boolean;
  aborted: boolean;
};
type Report = {
  dom: string | null;
  present: boolean;
  loading: boolean;
  empty: boolean;
  alert: string | null;
  more: boolean;
  quality: boolean;
  disabled: boolean | null;
  records: { tag: string; id: string | null; title: string; label: string }[];
  sameSection: boolean;
  sameRefresh: boolean;
  active: string;
  requests: Request[];
  events: unknown[][];
  globalUnsettled: number;
  unmounted: boolean;
};
const pending = (report: Report, method: string) =>
  report.requests.filter(
    (r) => r.method === method && !r.settled && !r.aborted,
  );
const next = (report: Report, method: string) => {
  const r = pending(report, method).at(-1);
  assert(r, "pending " + method);
  return r.index;
};

test(
  "complete SubjectSchedules StrictMode lifecycle and exact source actions",
  { timeout: 60000 },
  async (context) => {
    const historical = oldSource(),
      cache = await mkdtemp(resolve(tmpdir(), "morphz-schedules-vite-"));
    const historyId = resolve("apps/web/src/__SubjectSchedules_Git57e.tsx");
    const source = fixture.replace(
      "__SCHEDULE_HISTORY__",
      historical ? historyId : "/src/SubjectSchedules.tsx",
    );
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir: cache,
      plugins: [
        react(),
        {
          name: "complete-subject-schedules-test",
          resolveId(id) {
            if (id === "/__schedules.tsx") return "\0" + id;
            if (id === historyId && historical) return id;
          },
          async load(id) {
            if (id === "\0/__schedules.tsx")
              return transformWithOxc(source, "schedules.tsx");
            if (id === historyId && historical) return historical;
          },
          configureServer(vite) {
            vite.middlewares.use(async (req, res, next) => {
              if (req.url?.split("?")[0] !== "/__schedules") return next();
              res.setHeader("Content-Type", "text/html");
              res.end(
                await vite.transformIndexHtml(
                  req.url,
                  '<!doctype html><html><head><link rel="icon" href="data:,"><style>body{margin:0}.subject-sidebar{width:360px;min-height:500px}</style></head><body><button id="outside">Outside</button><div id="root"></div><script type="module" src="/__schedules.tsx"></script></body></html>',
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
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    const pages: Page[] = [],
      errors: string[] = [],
      business: string[] = [],
      ledger: { name: string; report: Report }[] = [];
    let phase = "setup";
    try {
      await server.listen();
      const address = server.httpServer!.address();
      assert(address && typeof address !== "string");
      const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
      assert(
        existsSync(executable || chromium.executablePath()),
        "test entry prepared browser",
      );
      browser = await chromium.launch({
        headless: true,
        executablePath: executable || undefined,
      });
      for (const lane of migration ? ["historical", "current"] : ["current"]) {
        const session = await browser.newContext({
          viewport: { width: 1000, height: 800 },
          timezoneId: "UTC",
        });
        const page = await session.newPage();
        page.setDefaultTimeout(3500);
        page.on("pageerror", (e) => errors.push(e.message));
        page.on("request", (r) => {
          if (
            ["fetch", "xhr"].includes(r.resourceType()) &&
            !r.url().includes("/@vite/")
          )
            business.push(r.url());
        });
        await page.goto(
          `http://127.0.0.1:${address.port}/__schedules?lane=${lane}`,
        );
        await page.waitForFunction(() => !!(window as any).scheduleFixture);
        await page.evaluate(() => (window as any).scheduleFixture.settle());
        pages.push(page);
      }
      async function observe(
        name: string,
        operation?: (page: Page) => Promise<unknown>,
      ) {
        phase = name;
        const reports: Report[] = [];
        for (const page of pages) {
          if (operation) await operation(page);
          reports.push(
            await page.evaluate(() => (window as any).scheduleFixture.report()),
          );
        }
        if (migration)
          assert.deepEqual(
            reports[1],
            reports[0],
            "whole old/new observation: " + name,
          );
        const report = reports.at(-1)!;
        ledger.push({ name, report });
        return report;
      }
      const run = (name: string, value?: unknown) =>
        observe(name, (p) =>
          p.evaluate(
            ({ name, value }) =>
              (window as any).scheduleFixture.run(name, value),
            { name, value },
          ),
        );
      const reset = (initial: Record<string, unknown> = {}) =>
        observe("reset", async (p) => {
          await p.evaluate(
            (v) => (window as any).scheduleFixture.reset(v),
            initial,
          );
          await p.evaluate(() => (window as any).scheduleFixture.settle());
        });
      const release = (r: Report, method: string, value: unknown) =>
        run("release", { index: next(r, method), value });
      const click = (selector: string) =>
        observe("actual click " + selector, (p) =>
          p
            .locator(selector)
            .click()
            .then(() =>
              p.evaluate(() => (window as any).scheduleFixture.settle()),
            ),
        );
      const idle = async (initial: Record<string, unknown> = {}) => {
        let r = await reset(initial);
        return release(r, "tasks.list", []);
      };

      await context.test(
        "1 initial, dependency-only invalidation and offline quality",
        async () => {
          let r = await observe("initial");
          assert.equal(pending(r, "tasks.list").length, 1);
          assert(
            r.requests.some((x) => x.aborted),
            "StrictMode retires first observation",
          );
          assert.deepEqual(pending(r, "tasks.list")[0]!.params, {
            owner: "agent",
            limit: 50,
          });
          assert.equal(pending(r, "tasks.list")[0]!.generation, "csrf-A");
          assert.equal(r.requests.length, 2);
          r = await release(r, "tasks.list", []);
          assert(r.empty && !r.loading && !r.disabled);
          const count = r.requests.length;
          r = await run("set", {
            label: "B",
            revision: 8,
            activity: scheduleActivity(),
          });
          assert.equal(r.requests.length, count);
          assert(r.sameSection && r.sameRefresh);
          r = await run("set", { online: false });
          assert.match(r.alert!, /连接中断，定时任务待核对/);
          assert(r.disabled && !r.empty);
          assert.equal(pending(r, "tasks.list").length, 0);
          r = await run("set", { online: true, identity: "csrf-B" });
          assert.equal(pending(r, "tasks.list")[0]!.generation, "csrf-B");
          await release(r, "tasks.list", []);
          r = await reset({ connected: false });
          assert.equal(r.requests.length, 0);
          assert.match(r.alert!, /部分定时任务暂时无法读取/);
          r = await run("set", { connected: true });
          await release(r, "tasks.list", []);
        },
      );
      await context.test(
        "2 refresh navigation → captured client → list, failures and false",
        async () => {
          let r = await idle();
          r = await observe("actual refresh focus", (p) =>
            p.locator('[aria-label="刷新定时任务"]').focus(),
          );
          assert.equal(r.active, "刷新定时任务");
          r = await click('[aria-label="刷新定时任务"]');
          assert(r.loading && r.disabled && !r.empty);
          assert.equal(
            r.active,
            "BODY",
            "disabling the real focused button blurs it",
          );
          assert.deepEqual(pending(r, "runtime.navigation")[0]!.params, {
            refreshActivity: true,
          });
          r = await run("set", { label: "B" });
          r = await release(r, "runtime.navigation", {});
          assert.equal(pending(r, "client.refresh")[0]!.label, "A");
          assert.equal(pending(r, "tasks.list").length, 0);
          r = await release(r, "client.refresh", false);
          r = await release(r, "tasks.list", []);
          assert(r.empty && !r.disabled);
          r = await click('[aria-label="刷新定时任务"]');
          r = await run("release", {
            index: next(r, "runtime.navigation"),
            error: "reply",
            message: "TEST navigation failure",
          });
          assert.equal(r.alert, "TEST navigation failure");
          assert(!r.loading);
          assert.equal(pending(r, "client.refresh").length, 0);
          r = await click('[aria-label="刷新定时任务"]');
          r = await release(r, "runtime.navigation", {});
          r = await run("release", {
            index: next(r, "client.refresh"),
            error: "error",
            message: "TEST refresh failure",
          });
          assert.equal(r.alert, "TEST refresh failure");
          assert.equal(pending(r, "tasks.list").length, 0);
        },
      );
      await context.test(
        "3 task limit50, at most16 snapshots and four-wide serial batches",
        async () => {
          let r = await reset();
          const tasks = [
            scheduleTask("unrequested", 0),
            ...Array.from({ length: 19 }, (_, i) =>
              scheduleTask("bounded-" + i),
            ),
          ];
          r = await release(r, "tasks.list", tasks);
          assert(r.more);
          assert.equal(pending(r, "task.snapshot").length, 4);
          for (let offset = 0; offset < 16; offset += 4) {
            const batch = pending(r, "task.snapshot");
            assert.deepEqual(
              batch.map((x) => x.params),
              tasks.slice(1 + offset, 5 + offset).map((t) => t.id),
            );
            for (let j = 0; j < 4; j++) {
              r = await run("release", {
                index: batch[j]!.index,
                value: scheduleRuntime(String(batch[j]!.params)),
              });
              if (j < 3)
                assert.equal(
                  r.requests.filter((x) => x.method === "task.snapshot").length,
                  offset + 4,
                );
            }
          }
          assert.equal(r.records.length, 16);
          assert.equal(
            r.requests.filter((x) => x.method === "task.snapshot").length,
            16,
          );
          assert(!r.loading && r.more);
          r = await reset();
          r = await release(
            r,
            "tasks.list",
            Array.from({ length: 50 }, (_, i) =>
              scheduleTask("not-requested-" + i, 0),
            ),
          );
          assert(r.more && r.empty);
          assert.equal(pending(r, "task.snapshot").length, 0);
        },
      );
      await context.test(
        "4 live eligibility, exact run errors and atomic publication",
        async () => {
          const cases = [
            ["queued", {}],
            ["paused", { paused: true }],
            ["control", { controlPending: "pending", paused: true }],
            [
              "watch",
              {
                hasSourceWatch: true,
                record: {
                  id: "schedule-watch",
                  revision: 1,
                  status: "completed",
                  interval_seconds: null,
                },
              },
            ],
            [
              "repeat",
              {
                record: {
                  id: "schedule-repeat",
                  revision: 1,
                  status: "dispatched",
                  interval_seconds: 90,
                },
              },
            ],
            [
              "cancelled",
              {
                record: {
                  revision: 1,
                  status: "cancelled",
                  interval_seconds: null,
                },
              },
            ],
            [
              "completed",
              {
                record: {
                  revision: 1,
                  status: "completed",
                  interval_seconds: null,
                },
              },
            ],
            [
              "dispatched",
              {
                record: {
                  revision: 1,
                  status: "dispatched",
                  interval_seconds: null,
                },
              },
            ],
            ["stopped", { sourceStopped: true }],
            ["absent", { record: null }],
            ["missing-run", { run: 2 }],
          ] as const;
          let r = await reset();
          r = await release(
            r,
            "tasks.list",
            cases.map(([id]) => scheduleTask(id)),
          );
          while (pending(r, "task.snapshot").length) {
            const batch = pending(r, "task.snapshot");
            for (const request of batch) {
              const entry = cases.find(([id]) => id === request.params)!;
              r = await run("release", {
                index: request.index,
                value: scheduleRuntime(entry[0], entry[1] as any),
              });
            }
          }
          assert.deepEqual(
            r.records.map((x) => x.title),
            [
              "TEST queued",
              "TEST paused",
              "TEST control",
              "TEST watch",
              "TEST repeat",
            ],
          );
          assert.deepEqual(
            r.records.map((x) => x.label),
            ["已排队", "已暂停", "控制待确认", "持续关注", "每 90 秒"],
          );
          r = await reset();
          r = await release(r, "tasks.list", [
            scheduleTask("good"),
            scheduleTask("bad"),
          ]);
          const batch = pending(r, "task.snapshot");
          r = await run("release", {
            index: batch[0]!.index,
            value: scheduleRuntime("good"),
          });
          assert.equal(r.records.length, 0);
          r = await run("release", {
            index: batch[1]!.index,
            value: scheduleRuntime("bad", { error: "TEST run error" }),
          });
          assert.equal(r.alert, "定时任务读取失败：TEST run error");
          assert.equal(r.records.length, 0);
          assert(!r.loading);
          r = await reset();
          r = await release(r, "tasks.list", [scheduleTask("other-run")]);
          const runtime = scheduleRuntime("other-run");
          runtime.runs.push({
            ...runtime.runs[0]!,
            run: 2,
            error: "old unrelated run error",
          });
          r = await release(r, "task.snapshot", runtime);
          assert.equal(r.records.length, 1);
          assert.equal(r.alert, null);
          r = await reset();
          r = await release(r, "tasks.list", [scheduleTask("runtime-error")]);
          r = await release(
            r,
            "task.snapshot",
            scheduleRuntime(
              "runtime-error",
              {},
              { error: "TEST runtime error" },
            ),
          );
          assert.equal(r.alert, "定时任务读取失败：TEST runtime error");
          assert.equal(r.records.length, 0);
          r = await reset();
          r = await run("release", {
            index: next(r, "tasks.list"),
            error: "nonerror",
          });
          assert.equal(r.alert, "定时任务暂时无法读取。");
          assert(!r.loading);
          r = await reset();
          r = await release(r, "tasks.list", [{}]);
          assert(r.alert && !r.loading);
          assert.equal(pending(r, "task.snapshot").length, 0);
        },
      );
      await context.test(
        "5 native quality, exact source qualification, priority and real actions",
        async () => {
          const exact = nativeSchedule("exact", {
              intervalSeconds: 90,
              notBefore: "invalid-date",
            }),
            lookalike = nativeSchedule("lookalike", {
              threadId: exact.threadId,
            }),
            covered = nativeSchedule("schedule-task");
          const activity = scheduleActivity([exact, lookalike, covered]);
          activity.threads = activity.threads.filter(
            (t) => t.inputId !== lookalike.inputId,
          );
          let r = await reset({ activity });
          assert.equal(r.records.find((x) => x.id === "exact")!.tag, "BUTTON");
          assert.equal(r.records.find((x) => x.id === "lookalike")!.tag, "DIV");
          assert.match(
            r.records.find((x) => x.id === "exact")!.label,
            /每 90 秒/,
          );
          assert.match(
            r.records.find((x) => x.id === "exact")!.label,
            /时间待核对/,
          );
          r = await release(r, "tasks.list", [scheduleTask("task")]);
          r = await release(
            r,
            "task.snapshot",
            scheduleRuntime("task", {
              stopRequested: true,
              controlPending: "pending",
              paused: true,
            }),
          );
          assert(!r.records.some((x) => x.id === "schedule-task"));
          assert.equal(r.records.at(-1)!.label, "停止待确认");
          r = await click('[data-schedule-id="exact"]');
          assert.deepEqual(r.events.at(-1), [
            "inspect",
            {
              projectId: exact.projectId,
              conversationId: exact.conversationId,
              artifactId: null,
              inputId: exact.inputId,
              threadId: exact.threadId,
            },
          ]);
          r = await click('button.subject-record:has-text("TEST task")');
          assert.deepEqual(r.events.at(-1), ["open", "task"]);
          assert(r.sameSection && r.sameRefresh);
          for (const field of [
            "id",
            "inputId",
            "projectId",
            "conversationId",
          ]) {
            const wrong = scheduleActivity([exact]);
            (wrong.threads[0] as any)[field] = "wrong-" + field;
            r = await run("set", { activity: wrong });
            assert.equal(r.records.find((x) => x.id === "exact")!.tag, "DIV");
          }
          r = await run("set", {
            activity: scheduleActivity([], true, { schedulesTruncated: true }),
          });
          assert(r.quality && !r.empty);
          r = await idle({
            activity: scheduleActivity([], true, { schedulesTruncated: true }),
          });
          assert(r.quality && !r.empty);
          r = await run("set", {
            activity: scheduleActivity([], true, { schedulesAvailable: false }),
          });
          assert.match(r.alert!, /部分定时任务暂时无法读取/);
          assert(!r.empty);
          // Same schedule identity chooses higher revision, preserving distinct IDs.
          const one = nativeSchedule("dup", { revision: 1, intent: "old" }),
            two = { ...one, revision: 2, intent: "new" };
          r = await run("set", { activity: scheduleActivity([one, two]) });
          assert.equal(r.records.find((x) => x.id === "dup")!.title, "new");
        },
      );
      await context.test(
        "6 held navigation, refresh, list and snapshots retire on identity/unmount",
        async () => {
          for (const method of [
            "runtime.navigation",
            "client.refresh",
            "tasks.list",
            "task.snapshot",
          ]) {
            let r = await idle();
            if (method !== "tasks.list") {
              r = await click('[aria-label="刷新定时任务"]');
              if (method !== "runtime.navigation")
                r = await release(r, "runtime.navigation", {});
              if (method === "task.snapshot") {
                r = await release(r, "client.refresh", true);
                r = await release(r, "tasks.list", [scheduleTask("late")]);
              }
            } else r = await reset();
            const held = next(r, method);
            r = await run("set", { identity: "csrf-B" });
            assert.equal(pending(r, "tasks.list").at(-1)!.generation, "csrf-B");
            r = await release(r, "tasks.list", []);
            assert(r.empty && !r.loading);
            r = await run("release", {
              index: held,
              value:
                method === "tasks.list"
                  ? [scheduleTask("stale")]
                  : method === "task.snapshot"
                    ? scheduleRuntime("late")
                    : true,
            });
            assert(r.empty && !r.loading && r.records.length === 0);
            if (method !== "client.refresh") assert(r.requests[held]!.aborted);
          }
          let r = await reset();
          const disconnected = next(r, "tasks.list");
          r = await run("set", { connected: false });
          assert(r.requests[disconnected]!.aborted);
          r = await run("release", {
            index: disconnected,
            error: "error",
            message: "TEST retired late failure",
          });
          assert.match(r.alert!, /连接中断，定时任务待核对/);
          assert(!r.loading);
          r = await run("set", { connected: true });
          r = await release(r, "tasks.list", []);
          assert(r.empty);
          r = await reset();
          const held = next(r, "tasks.list");
          r = await run("unmount");
          assert(!r.present && r.requests[held]!.aborted);
          r = await run("release", { index: held, value: [] });
          assert(!r.present);
        },
      );
      await context.test(
        "7 refresh clears stale task facts while native inventory remains and recovery closes",
        async () => {
          const native = nativeSchedule("retained");
          let r = await reset({ activity: scheduleActivity([native]) });
          r = await release(r, "tasks.list", [scheduleTask("before")]);
          r = await release(r, "task.snapshot", scheduleRuntime("before"));
          assert.equal(r.records.length, 2);
          r = await click('[aria-label="刷新定时任务"]');
          assert(
            r.loading &&
              r.records.length === 1 &&
              r.records[0]!.id === "retained",
          );
          assert(r.sameSection && r.sameRefresh);
          r = await release(r, "runtime.navigation", {});
          r = await release(r, "client.refresh", true);
          r = await release(r, "tasks.list", []);
          assert(!r.loading && !r.empty && r.records.length === 1);
          assert(
            r.requests.every((x) =>
              [
                "runtime.navigation",
                "tasks.list",
                "task.snapshot",
                "client.refresh",
              ].includes(x.method),
            ),
          );
          r = await observe("cleanup", (p) =>
            p.evaluate(() => (window as any).scheduleFixture.cleanup()),
          );
          assert(!r.present && r.unmounted);
          assert(r.requests.every((x) => x.settled));
          assert.equal(
            r.globalUnsettled,
            0,
            "all bridge replies are released before private browser/server shutdown",
          );
          assert.deepEqual(errors, []);
          assert.deepEqual(business, []);
        },
      );
    } finally {
      for (const page of pages)
        if (!page.isClosed())
          await page
            .evaluate(() => (window as any).scheduleFixture?.cleanup())
            .catch(() => {});
      await browser?.close();
      await server.close();
      await rm(cache, { recursive: true, force: true });
      const evidence = process.env.MORPHZ_TEST_SUBJECT_SCHEDULES_EVIDENCE_DIR;
      if (evidence) {
        await writeFile(
          resolve(
            evidence,
            migration ? "migration-ledger.json" : "current-ledger.json",
          ),
          JSON.stringify(ledger, null, 2) + "\n",
        );
      }
      context.diagnostic(
        JSON.stringify({
          migration,
          phase,
          observations: ledger.length,
          requests: ledger.at(-1)?.report.requests.length,
          ledgerSha: createHash("sha256")
            .update(JSON.stringify(ledger))
            .digest("hex"),
          errors,
          business,
        }),
      );
    }
  },
);
