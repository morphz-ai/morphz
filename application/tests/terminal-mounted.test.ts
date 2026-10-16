import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { chromium, expect } from "@playwright/test";
import { createServer, transformWithOxc } from "vite";
import { currentAppCSSImports } from "./fixtures/current-app-css.js";

const source = `
import React,{StrictMode,useState} from 'react';import {createRoot} from 'react-dom/client';
import {Terminal} from '/src/features/terminal/Terminal.tsx';
import {ApplicationRequestError} from ${JSON.stringify("/@fs" + resolve("packages/core/src/application-api.ts"))};
${currentAppCSSImports()}
const events=[],query=new URL(location.href).searchParams;let api,copied='';
Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{copied=text;}}});
const record={id:'terminal-exact',session_id:'session-exact',context_id:'context-exact',principal_id:'human-exact',root_turn_id:'root-exact',source_job_id:'job-exact',target_id:'target-default',revision:2,status:'open',title:'编译与检查',shell:'/bin/zsh',cwd:'/workspace/terminal-check',rows:24,cols:80,sandbox_status:'enforced',network_enabled:false,exit_code:null,created_at:'2026-10-16T00:00:00Z',updated_at:'2026-10-16T00:00:00Z'};
const records=new Map(query.has('emptyCatalog')?[]:[[record.id,record]]),opens=new Map();let openAttempts=0;
const text='实际输出：中文 <script>不是脚本</script>',screen={sequence:3,rows:24,cols:80,lines:Array.from({length:24},(_,i)=>i===1?[{text:'~/workspace',fg:'#3973c6',fg_index:4},{text:' ❯ ',fg:'#298451',fg_index:2},{text:'truecolor',fg:'#298451'}].map(span=>({...span,bold:false,italic:false,underline:false,inverse:false})):[{text:i===0?text:' ',bold:false,italic:false,underline:false,inverse:false}]),text,cursor:[1,13],cursor_visible:true,alternate_screen:false,scrollback:0,previous_available:true};
function Frame(){
 const [facts,setFacts]=useState({active:true,online:true,appearance:'dark',accent:'cyan',csrf:'original',screenError:false,serverError:false,instance:{id:'instance-exact',workspaceId:'project-exact',applicationId:'morphz.terminal',applicationVersion:'1.0.0',state:query.has('emptySelection')?{}:{terminalId:'terminal-exact'},revision:1,status:'open',createdAt:record.created_at,updatedAt:record.updated_at}});
 api={set:value=>setFacts(old=>({...old,...value}))};
 const client={boot:{centerId:'center-exact',principalId:facts.principal??'human-exact',csrfToken:facts.csrf},online:facts.online,workspaceChangeRevision:0,
 terminalCatalog:async(scope,signal)=>{events.push(['catalog',scope]);return{terminals:[...records.values()],limit:50,has_more:false};},
 terminalOpen:async(scope,commandId)=>{events.push(['open',scope,commandId]);openAttempts++;if(!opens.has(commandId)){const created={...record,id:'human-'+commandId,title:'终端 '+(opens.size+1),root_turn_id:null,source_job_id:null,creation_command_id:commandId};records.set(created.id,created);opens.set(commandId,created);}await new Promise(r=>setTimeout(r,100));if(query.has('lostOpen')&&openAttempts===1)throw Error('TEST lost creation receipt');return {command_id:commandId,terminal:opens.get(commandId),connected:true};},
 terminalRead:async(scope,id,offset,signal)=>{events.push(['read',scope,id,offset]);if(facts.screenError)throw new Error('TEST screen unavailable');if(facts.serverError)throw new ApplicationRequestError(503,'保存失败。内容尚未确认写入，请保留草稿后重试。','unavailable');return{input_supported:!!facts.inputSupported,terminal:records.get(id),connected:true,checkpoint:false,screen:{...screen,text:offset?'此前输出':text,lines:screen.lines.map((line,i)=>i===0?[{...line[0],text:offset?'此前输出':text}]:line),scrollback:offset,previous_available:offset<48}};},
 terminalCommand:async(scope,id,command)=>{events.push(['command',command]);if(facts.commandError)throw Error('TEST lost receipt');record.revision++;return {command_id:command.command_id,terminal_id:id,revision:record.revision,input_status:'submitted',command_completion:'not_asserted'};},
 execute:async op=>{events.push(['navigation',op]);if(query.has('failSelect'))throw new Error('TEST selection conflict');setFacts(old=>({...old,instance:{...old.instance,state:op.state,revision:old.instance.revision+1}}));return{};}};
 return <div className="app" data-appearance={facts.appearance} data-accent={facts.accent} style={{height:'100dvh',display:'block',colorScheme:facts.appearance==='system'?'light dark':facts.appearance}}><Terminal client={client} instance={facts.instance} projectId="project-exact" conversationId="conversation-exact" active={facts.active} onCompose={value=>{events.push(['compose',value]);return{ok:true};}} onContext={value=>events.push(['context',value])} onNotice={value=>events.push(['notice',value])}/></div>;
}
createRoot(document.getElementById('root')).render(<StrictMode><Frame/></StrictMode>);
Reflect.set(window,'terminalFixture',{set:value=>api.set(value),state:()=>({events:[...events],copied})});
`;

test("mounted Terminal uses one Agent composer, compact stable copy feedback and bounded active-only reads", async (t) => {
  const cache = mkdtempSync(join(tmpdir(), "morphz-terminal-ui-"));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  const server = await createServer({
    configFile: false,
    root: resolve("apps/web"),
    cacheDir: cache,
    plugins: [
      react(),
      {
        name: "terminal-mounted-fixture",
        resolveId(id) {
          if (id === "/__terminal.tsx") return "\0" + id;
        },
        async load(id) {
          if (id === "\0/__terminal.tsx")
            return transformWithOxc(source, "terminal-mounted.tsx");
        },
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (req.url?.split("?")[0] !== "/__terminal") return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                '<!doctype html><html><head><link rel="icon" href="data:,"></head><body style="margin:0"><div id="root"></div><script type="module" src="/__terminal.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
    ],
    server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    await browser?.close();
    await server.close();
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string")
    throw new Error("Terminal fixture did not bind");
  browser = await chromium.launch({
    headless: true,
    ...(process.env.MORPHZ_TEST_BROWSER_EXECUTABLE
      ? { executablePath: process.env.MORPHZ_TEST_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1100, height: 700 },
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/__terminal`);
  await expect(
    page.getByRole("region", { name: "真实终端屏幕" }),
  ).toContainText("实际输出：中文");
  assert.equal(await page.locator(".terminal-app script").count(), 0);
  const before = await page.locator(".terminal-footer").boundingBox();
  const copyBefore = await page
    .getByRole("button", { name: "复制当前屏幕文本" })
    .boundingBox();
  await page.getByRole("button", { name: "复制当前屏幕文本" }).click();
  await expect(
    page.getByRole("button", { name: "已复制终端文本" }),
  ).toBeVisible();
  const after = await page.locator(".terminal-footer").boundingBox();
  const copyAfter = await page
    .getByRole("button", { name: "已复制终端文本" })
    .boundingBox();
  assert.deepEqual(after, before, "copy must not add a row or move the footer");
  assert.equal(copyAfter!.width, copyBefore!.width);
  const copied = await page.evaluate(
    () => Reflect.get(window, "terminalFixture").state().copied,
  );
  assert.equal(copied, "实际输出：中文 <script>不是脚本</script>");
  await page.getByRole("button", { name: "让 Morphz 操作" }).click();
  const compose = await page.evaluate(() =>
    Reflect.get(window, "terminalFixture")
      .state()
      .events.filter((e: any[]) => e[0] === "compose"),
  );
  assert.equal(compose.length, 1);
  assert.match(compose[0][1], /terminal_id: terminal-exact/);
  assert.equal(
    await page.getByLabel("AI 输入内容").count(),
    0,
    "terminal keyboard is not another Agent composer",
  );
  await page.getByRole("button", { name: "此前输出" }).click();
  await expect(
    page.getByRole("region", { name: "真实终端屏幕" }),
  ).toContainText("此前输出");
  await page.getByRole("button", { name: "最新屏幕" }).click();
  await expect(
    page.getByRole("region", { name: "真实终端屏幕" }),
  ).toContainText("实际输出：中文");
  for (const appearance of ["light", "dark"]) {
    await page.evaluate(
      (appearance) =>
        Reflect.get(window, "terminalFixture").set({ appearance }),
      appearance,
    );
    for (const width of [1100, 420]) {
      await page.setViewportSize({ width, height: 700 });
      const geometry = await page.locator(".terminal-app").evaluate((el) => ({
        scroll: document.documentElement.scrollWidth,
        width: innerWidth,
        bg: getComputedStyle(el).backgroundColor,
        footer: el.querySelector("footer")!.getBoundingClientRect().height,
        toolbar: el.querySelector("header")!.getBoundingClientRect().height,
        location: el
          .querySelector(".terminal-location")!
          .getBoundingClientRect().height,
      }));
      assert.ok(
        geometry.scroll <= geometry.width + 1,
        "horizontal overflow belongs to terminal grid, not the whole page",
      );
      assert.ok(geometry.footer <= 44, "footer stays compact");
      assert.ok(
        geometry.toolbar <= 32,
        `desktop tabs are flat, not a tall card: ${JSON.stringify(geometry)}`,
      );
      assert.ok(
        geometry.location <= 28,
        "path and connection share a compact line",
      );
      assert.equal(
        geometry.bg,
        appearance === "dark" ? "rgb(25, 25, 27)" : "rgb(255, 255, 255)",
      );
      await expect(page.locator(".terminal-emulator")).toHaveAttribute(
        "data-ready",
        "true",
      );
      const blackSurfaces = await page
        .locator(".terminal-screen")
        .evaluate((el) =>
          [...el.querySelectorAll("*")]
            .filter((node) => {
              const style = getComputedStyle(node),
                box = node.getBoundingClientRect();
              return (
                style.backgroundColor === "rgb(0, 0, 0)" &&
                style.opacity !== "0" &&
                box.width > 100 &&
                box.height > 20
              );
            })
            .map((node) => ({
              tag: node.tagName,
              class: node.className,
              style: node.getAttribute("style"),
            })),
        );
      assert.deepEqual(
        blackSurfaces,
        [],
        "terminal background stays coherent beyond the PTY grid",
      );
      const green = await page.locator(".terminal-app").evaluate((el) => {
        const p = document.createElement("span");
        el.append(p);
        p.style.color = "var(--terminal-ansi-2)";
        const c = getComputedStyle(p).color;
        p.remove();
        return c;
      });
      assert.equal(
        green,
        appearance === "dark" ? "rgb(166, 227, 161)" : "rgb(64, 160, 43)",
      );
      const directory = resolve("test-results/terminal-appearance");
      mkdirSync(directory, { recursive: true });
      await page.screenshot({
        path: join(directory, `terminal-${appearance}-${width}.png`),
      });
    }
  }
  const navigations = () =>
    page.evaluate(
      () =>
        Reflect.get(window, "terminalFixture")
          .state()
          .events.filter((e: any[]) => ["compose", "navigation"].includes(e[0]))
          .length,
    );
  const beforeTheme = await navigations();
  assert.equal(
    await page.getByRole("button", { name: "终端配色", exact: true }).count(),
    0,
  );
  for (const appearance of ["light", "dark", "system"]) {
    await page.evaluate(
      (appearance) =>
        Reflect.get(window, "terminalFixture").set({ appearance }),
      appearance,
    );
    for (const accent of ["cyan", "iris", "coral", "mono"]) {
      await page.evaluate(
        (accent) => Reflect.get(window, "terminalFixture").set({ accent }),
        accent,
      );
      await expect
        .poll(() =>
          page.locator(".terminal-app").evaluate((el) => {
            const sample = document.createElement("span");
            el.append(sample);
            sample.style.color = "var(--terminal-ansi-4)";
            const terminal = getComputedStyle(sample).color;
            sample.style.color = "var(--accent-strong)";
            const app = getComputedStyle(sample).color;
            sample.remove();
            return terminal === app;
          }),
        )
        .toBe(true);
    }
  }
  await page.evaluate(() =>
    Reflect.get(window, "terminalFixture").set({ appearance: "system" }),
  );
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect
      .poll(() =>
        page
          .locator(".terminal-app")
          .evaluate((el) => getComputedStyle(el).backgroundColor),
      )
      .toBe(colorScheme === "dark" ? "rgb(25, 25, 27)" : "rgb(255, 255, 255)");
  }
  assert.equal(
    await navigations(),
    beforeTheme,
    "changing appearance never sends Agent input or process control",
  );
  await page.reload();
  assert.equal(
    await page.locator(".terminal-app").getAttribute("data-terminal-theme"),
    null,
  );
  await page.evaluate(() => {
    document.documentElement.dataset.appMotion = "reduce";
  });
  await expect(page.locator(".terminal-screen")).toHaveAttribute(
    "data-cursor-motion",
    "static",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => {
    delete document.documentElement.dataset.appMotion;
  });
  await expect(page.locator(".terminal-screen")).toHaveAttribute(
    "data-cursor-motion",
    "static",
  );
  await page.evaluate(() =>
    Reflect.get(window, "terminalFixture").set({ inputSupported: true }),
  );
  await expect(page.locator(".terminal-screen")).toHaveAttribute(
    "data-input",
    "enabled",
  );
  const keyboard = page.getByLabel("终端输入", { exact: true });
  await keyboard.focus();
  await page.keyboard.type("printf ");
  await page.keyboard.insertText("中文");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+c");
  await expect
    .poll(() =>
      page.evaluate(() =>
        Reflect.get(window, "terminalFixture")
          .state()
          .events.filter(
            (e: any[]) => e[0] === "command" && e[1].action.type === "input",
          )
          .map((e: any[]) => e[1].action.data)
          .join(""),
      ),
    )
    .toBe("printf 中文\r\x03");
  await keyboard.evaluate((node: HTMLTextAreaElement) => {
    node.value = "";
    node.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    node.value = "输入法";
    node.dispatchEvent(
      new CompositionEvent("compositionupdate", {
        data: "输入法",
        bubbles: true,
      }),
    );
    node.dispatchEvent(
      new CompositionEvent("compositionend", { data: "输入法", bubbles: true }),
    );
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        Reflect.get(window, "terminalFixture")
          .state()
          .events.filter(
            (e: any[]) => e[0] === "command" && e[1].action.type === "input",
          )
          .map((e: any[]) => e[1].action.data)
          .join(""),
      ),
    )
    .toBe("printf 中文\r\x03输入法");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Backspace");
  await keyboard.evaluate((node) => {
    const data = new DataTransfer();
    data.setData("text/plain", "粘贴😀");
    node.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true }),
    );
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        Reflect.get(window, "terminalFixture")
          .state()
          .events.filter(
            (e: any[]) => e[0] === "command" && e[1].action.type === "input",
          )
          .map((e: any[]) => e[1].action.data)
          .join(""),
      ),
    )
    .toBe("printf 中文\r\x03输入法\x1b[D\x7f粘贴😀");
  await page.evaluate(() =>
    Reflect.get(window, "terminalFixture").set({ commandError: true }),
  );
  await page.keyboard.insertText("no-replay");
  await expect(page.locator(".terminal-input-error")).toContainText(
    "不会自动重发",
  );
  const commands = await page.evaluate(
    () =>
      Reflect.get(window, "terminalFixture")
        .state()
        .events.filter((e: any[]) => e[0] === "command").length,
  );
  await page.waitForTimeout(150);
  assert.equal(
    await page.evaluate(
      () =>
        Reflect.get(window, "terminalFixture")
          .state()
          .events.filter((e: any[]) => e[0] === "command").length,
    ),
    commands,
  );
  await page.getByRole("button", { name: "复制未确认输入" }).click();
  assert.equal(
    await page.evaluate(
      () => Reflect.get(window, "terminalFixture").state().copied,
    ),
    "no-replay",
  );
  await page.evaluate(() =>
    Reflect.get(window, "terminalFixture").set({ serverError: true }),
  );
  await expect(
    page.locator(".terminal-notice:not(.terminal-input-error)"),
  ).toContainText("终端暂不可读取");
  await expect(page.locator(".terminal-app")).not.toContainText("保存失败");
  await expect(
    page.getByRole("region", { name: "真实终端屏幕" }),
  ).toContainText("实际输出：中文");
  await page.evaluate(() =>
    Reflect.get(window, "terminalFixture").set({ serverError: false }),
  );
  await expect(
    page.locator(".terminal-notice:not(.terminal-input-error)"),
  ).toHaveCount(0);
  await page.evaluate(() =>
    Reflect.get(window, "terminalFixture").set({ active: false }),
  );
  await page.waitForTimeout(100);
  const paused = await page.evaluate(
    () => Reflect.get(window, "terminalFixture").state().events.length,
  );
  await page.waitForTimeout(1200);
  assert.equal(
    await page.evaluate(
      () => Reflect.get(window, "terminalFixture").state().events.length,
    ),
    paused,
    "hidden app must stop its read loop, not the real terminal",
  );
  assert.deepEqual(errors, []);
  await page.goto(
    `http://127.0.0.1:${address.port}/__terminal?emptySelection=1&failSelect=1`,
  );
  await expect(page.getByRole("tab", { name: "编译与检查" })).toBeVisible();
  await page.waitForTimeout(1800);
  const attempts = await page.evaluate(
    () =>
      Reflect.get(window, "terminalFixture")
        .state()
        .events.filter((e: any[]) => e[0] === "navigation").length,
  );
  assert.equal(
    attempts,
    1,
    "a failed selection must not trigger a render/retry loop",
  );
  await page.goto(
    `http://127.0.0.1:${address.port}/__terminal?emptySelection=1&emptyCatalog=1&lostOpen=1`,
  );
  const newButton = page.getByRole("button", { name: "新终端", exact: true });
  await expect(newButton).toBeVisible();
  assert.equal(
    await newButton.innerText(),
    "",
    "toolbar creation is just a plus icon",
  );
  await page.waitForTimeout(250);
  const openCount = () =>
    page.evaluate(
      () =>
        Reflect.get(window, "terminalFixture")
          .state()
          .events.filter((e: any[]) => e[0] === "open").length,
    );
  assert.equal(
    await openCount(),
    0,
    "mounting an empty Terminal never creates a process",
  );
  await newButton.dblclick();
  await expect(
    page.getByRole("button", { name: "核对新建终端", exact: true }).first(),
  ).toBeVisible();
  assert.equal(
    await openCount(),
    1,
    "double click cannot create two terminals",
  );
  await page
    .getByRole("button", { name: "核对新建终端", exact: true })
    .first()
    .click();
  await expect(page.getByRole("tab", { name: "终端 1" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const createdEvents = await page.evaluate(
    () => Reflect.get(window, "terminalFixture").state().events,
  );
  const opens = createdEvents.filter((e: any[]) => e[0] === "open");
  assert.equal(opens.length, 2);
  assert.equal(
    opens[0][2],
    opens[1][2],
    "lost receipt uses the same command identity",
  );
  assert.equal(
    createdEvents.filter((e: any[]) => e[0] === "compose").length,
    0,
    "direct creation never prepares an Agent message",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Reflect.get(window, "terminalFixture")
            .state()
            .events.filter((e: any[]) => e[0] === "context")
            .at(-1)?.[1]?.title,
      ),
    )
    .toBe("终端 1");
  const beforeReload = await openCount();
  await page.waitForTimeout(1200);
  assert.equal(
    await openCount(),
    beforeReload,
    "background refresh never repeats creation",
  );
});
