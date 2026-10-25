import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, expect, type Browser } from "@playwright/test";
import { createServer, transformWithOxc, type ViteDevServer } from "vite";
import { currentAppCSSImports } from "./fixtures/current-app-css.js";

function contrastRatio(first: string, second: string): number {
  const luminance = (color: string) => {
    const values = color
      .match(/[\d.]+/g)!
      .slice(0, 3)
      .map((value) => {
        const channel = Number(value) / 255;
        return channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      });
    return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
  };
  const a = luminance(first),
    b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function fixture(surface: "desktop" | "dashboard") {
  const dashboard = resolve("../dashboard/src");
  return `
import React,{useRef,useState} from 'react';
import {Clock3,ChevronRight} from 'lucide-react';
import {createRoot} from 'react-dom/client';
import {UserInputDialogHost} from '${surface === "desktop" ? "/src/UserInputDialogHost.tsx" : "/@fs/" + dashboard + "/components/UserInputDialogHost.tsx"}';
import {UserInputPreview} from '${surface === "desktop" ? "/src/UserInputPreview.tsx" : "/@fs/" + dashboard + "/components/UserInputPreview.tsx"}';
${surface === "desktop" ? currentAppCSSImports() : `import '/@fs/${dashboard}/index.css';import '/@fs/${dashboard}/App.css';import '/@fs/${dashboard}/i18n/index.ts';`}
const desktop=${JSON.stringify(surface === "desktop")};
let refresh=()=>{};
const accepted=new Map(),commands=[];
let failNext=false,forbidden=false;
function question(n){return {request_id:'question-'+n,thread_id:'thread-'+n,thread_generation:1,
 session_id:'TEST-session',context_id:'TEST-context',requested_at:'2026-10-25T01:00:00Z',
 questions:[{id:'preview',question:'是否启用第 '+n+' 项合成预览？',multi_select:true,options:[{id:'yes',label:'启用预览'},{id:'no',label:'保持关闭'}]}]};}
const threads=[1,2].map(n=>({id:'thread-'+n,title:'TEST 合成预览 '+n+(n===1?'：'+ '这是保留原文与原身份的长任务来源，不应该遮住当前待答问题。'.repeat(12):''),sessionId:'TEST-session',contextId:'TEST-context',
 projectId:'TEST-project',conversationId:'TEST-project',inputId:'TEST-input-'+n,kind:'execution',lifecycle:'open',phase:'waiting',controlState:'active',
 continuation:{mode:'supplement',inputId:'TEST-input-'+n,threadId:'thread-'+n,generation:1},userInputRequest:question(n)}));
const legacyGoal={id:'TEST-goal',title:'TEST 旧任务',stated_objective:'TEST 旧任务',inputId:'TEST-input-old',
 projectId:'TEST-project',conversationId:'TEST-project',sessionId:'TEST-session',context_id:'TEST-context',coordinator_session_id:'TEST-session',
 generation:1,revision:7,status:'active',pendingUserInput:{kind:'legacy',requestId:'legacy-record-1'},
 wait_condition:{kind:'user_input',session_id:'TEST-session',request_id:'legacy-record-1'}};
const oldThread={id:'legacy-thread',sessionId:'TEST-session',projectId:'TEST-project',conversationId:'TEST-project',continuation:{mode:'supplement',inputId:'TEST-input-old',threadId:'legacy-thread',generation:1,
 objective:{id:'TEST-goal',generation:1}}};
function snapshot(thread){return {intent:thread.title,user_input_request:thread.userInputRequest,phase:'waiting',schedules:[],activations:[],pending_signals:[],thread:{
 id:thread.id,session_id:thread.sessionId,context_id:thread.contextId,generation:1,revision:1,kind:'execution',lifecycle:'open',control_state:'active',executor_kind:'self',
 supervision:{supervisor_kind:'none',generation:1}}};}
function api(path,body){
 if(forbidden)return {status:403,value:{error:'TEST permission revoked'}};
 if(body){
  commands.push(structuredClone(body));
  const previous=accepted.get(body.client_message_id);
  if(previous)return JSON.stringify(previous.body)===JSON.stringify(body)?{status:200,value:{event_id:previous.eventId}}:{status:409,value:{error:'TEST changed command'}};
  const destination=body.input_destination;
  if(destination.kind==='user_input'){
   const thread=threads.find(t=>t.id===destination.thread_id);
   if(!thread?.userInputRequest||thread.userInputRequest.request_id!==destination.request_id)return {status:409,value:{error:'TEST stale question'}};
   thread.userInputRequest=undefined;
  }else if(destination.kind==='objective'){
   if(!legacyGoal.wait_condition||destination.reply_to_request_id!=='legacy-record-1')return {status:409,value:{error:'TEST old wait changed'}};
   legacyGoal.wait_condition=undefined;
  }else throw Error('unexpected destination');
  const eventId='accepted-'+accepted.size;accepted.set(body.client_message_id,{body:structuredClone(body),eventId});refresh();
  if(failNext){failNext=false;return {status:503,value:{error:'TEST lost receipt'}};}
  return {status:200,value:{event_id:eventId}};
 }
 if(path.includes('/threads/')){const thread=threads.find(t=>t.id===path.split('/').at(-1));return {status:thread?200:404,value:{snapshot:thread?snapshot(thread):null}};}
 if(path.includes('/objectives/'))return {status:200,value:{objective:legacyGoal}};
 throw Error('Unexpected test API '+path);
}
window.morphzDesktop={application:{cancel(){},async invoke(envelope){
 const origin=envelope.params;
 if(envelope.method!=='user-input.read')throw Error('Unexpected logical method');
 if(forbidden)return {ok:false,error:{status:403,code:'forbidden',message:'TEST permission revoked'}};
 const thread=threads.find(thread=>thread.id===origin.continuation.threadId);
 return {ok:true,value:{title:thread?.title??legacyGoal.title,
 ...(origin.legacy?{legacyRequestId:origin.requestId}:{request:thread?.userInputRequest}),continuation:origin.continuation,
 source:{inputId:origin.continuation.inputId,projectId:'TEST-project',conversationId:'TEST-project',targetActantId:'TEST-agent',artifactId:null,artifactRevision:null}}};
}}};
const client={online:true,boot:{centerId:'TEST-center',principalId:'TEST-person',actantId:'TEST-agent',runtime:{connected:true,activity:{available:true,threads,objectives:[legacyGoal]}}},
 async execute(operation,_queue,_options,id){
  const reply=operation.continuation.reply;
  const destination=reply.kind==='question'?{kind:'user_input',request_id:reply.requestId,thread_id:operation.continuation.threadId,
   generation:operation.continuation.generation,answers:reply.answers}:{kind:'objective',objective_id:operation.continuation.objective.id,
   generation:operation.continuation.objective.generation,reply_to_request_id:reply.requestId};
  const response=api('/messages',{client_message_id:id,text:operation.body,dispatch_mode:operation.dispatchMode,input_destination:destination});
  if(response.status!==200)throw Error(response.value.error);
  return {commandId:id,entityId:response.value.event_id};
 },async refresh(){refresh();}};
function Fixture(){
 const [,render]=useState(0);refresh=()=>render(n=>n+1);
 const host=useRef(null);const [composerSlot,setComposerSlot]=useState(null);
 const release=()=>requestAnimationFrame(()=>document.querySelector('#main-draft')?.focus());
 window.questionFixture={api,report:()=>({commands,accepted:accepted.size,draft:document.querySelector('#main-draft').value}),
  loseReceipt:()=>{failNext=true;},revoke:()=>{forbidden=true;},
  replace:()=>{threads[1].userInputRequest={...question(2),request_id:'question-2-replaced'};refresh();},
  single:()=>{threads[0].userInputRequest={...question(1),request_id:'question-single',questions:[{...question(1).questions[0],multi_select:false}]};refresh();},
  singleBatch:()=>{threads[0].userInputRequest={...question(1),request_id:'question-single-batch',questions:[
   {...question(1).questions[0],multi_select:false},{...question(1).questions[0],id:'second',question:'第二个单选问题',multi_select:false}]};refresh();},
  batch:()=>{threads[0].userInputRequest={...question(1),request_id:'question-batch',questions:[
   {...question(1).questions[0],multi_select:false},{id:'multiple',question:'选择要验证的两项',multi_select:true,options:[{id:'one',label:'第一项'},{id:'two',label:'第二项'}]},
   {id:'custom',question:'补充你的验收条件'}]};refresh();}};
 return <div className={desktop?'app':'page-shell'} data-color-mode="light" data-accent="cyan" style={{height:'100vh',width:'100%',display:'block'}}>
  <div className="workspace" style={{height:'100%',display:'block'}}><main className="primary-panel" style={{height:'100%',padding:24,overflow:'auto',color:desktop?'var(--ink)':'var(--text)'}}>
   <h1 style={{fontSize:18}}>TEST 待答工作</h1>
   <aside aria-label="TEST 活动" style={{width:380,maxWidth:'100%',marginLeft:'auto',marginTop:24}}>
   <h2 style={{fontSize:12,fontWeight:500,color:'var(--muted)'}}>进行中</h2>
   {threads.map(thread=><section key={thread.id} data-thread={thread.id} className={desktop?'execution-activity-entry':'dialogue-thread-card'}>
    {desktop?<><button className="execution-activity-row" type="button" aria-label={'查看原任务：'+thread.title}><span className="execution-activity-icon" data-status="waiting"><Clock3 size={19}/></span><span className="execution-activity-body"><strong title={thread.title}>{thread.title}</strong><span className="execution-activity-meta">10:30 · gpt-6.1-sol · low · TEST</span></span><ChevronRight size={14}/></button>
     <UserInputPreview thread={thread} onReply={value=>host.current.open(value)}/></>:
     <><header className="dialogue-thread-card-header"><button className="dialogue-thread-summary" type="button" aria-label={'查看原任务：'+thread.title}><span className="activity-status waiting"><i/>等待中</span><span className="dialogue-thread-identity"><strong>执行线程</strong><span className="thread-assignment" title={thread.title}>{thread.title}</span><small>TEST thread</small></span></button><div className="dialogue-thread-card-tools"><UserInputPreview snapshot={snapshot(thread)} onReply={value=>host.current.open(value)}/></div><button className="dialogue-thread-disclosure" aria-label="展开原任务"><ChevronRight size={13}/></button></header><div className="dialogue-thread-origin"><span>当前会话</span><time>1 分钟前</time></div></>}
   </section>)}
   </aside>
   <button onClick={()=>desktop?host.current.openObjective(legacyGoal,[oldThread]):host.current.openLegacy(legacyGoal)}>TEST 旧任务回复</button>
   <div className="composer" id={desktop?'global-composer':'dashboard-composer'} style={{position:'fixed',left:24,bottom:24,width:'calc(100% - 48px)',maxWidth:740}}><div ref={setComposerSlot} className="question-composer-slot"/><div className={desktop?'composer-writing':'composer-input-area'}><textarea id="main-draft" aria-label="主输入" defaultValue="保留主输入草稿"/></div><div className={desktop?'composer-actions composer-action-bar':'composer-actions'}><button type="button" disabled>主输入发送</button></div></div>
   {desktop?<UserInputDialogHost ref={host} client={client} container={composerSlot} onRelease={release}/>:<UserInputDialogHost ref={host} principalId="TEST-person" readOnly={false} container={composerSlot} onRelease={release} onAccepted={refresh}/>}
  </main></div>
 </div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
}

test(
  "Desktop and Dashboard supplement buttons answer inside the original composer, retain independent drafts, and retry one exact command",
  { timeout: 180_000 },
  async () => {
    const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
    assert.ok(
      existsSync(executable || chromium.executablePath()),
      "an installed test browser is required; no skip fallback",
    );
    const cache = mkdtempSync(join(tmpdir(), "morphz-question-ui-"));
    let server: ViteDevServer | undefined, browser: Browser | undefined;
    try {
      server = await createServer({
        configFile: false,
        root: resolve("apps/web"),
        cacheDir: cache,
        logLevel: "error",
        resolve: {
          dedupe: ["react", "react-dom"],
          alias: [
            {
              find: /^react$/,
              replacement: resolve("node_modules/react/index.js"),
            },
            {
              find: /^react\/jsx-runtime$/,
              replacement: resolve("node_modules/react/jsx-runtime.js"),
            },
            {
              find: /^react\/jsx-dev-runtime$/,
              replacement: resolve("node_modules/react/jsx-dev-runtime.js"),
            },
          ],
        },
        optimizeDeps: {
          entries: [
            resolve("apps/web/src/UserInputDialogHost.tsx"),
            resolve("../dashboard/src/components/UserInputDialogHost.tsx"),
          ],
          include: [
            "react",
            "react-dom",
            "react-dom/client",
            "react/jsx-runtime",
            "react/jsx-dev-runtime",
          ],
        },
        plugins: [
          {
            name: "question-ui-fixture",
            resolveId(id) {
              if (id.startsWith("/__question-") && id.endsWith(".tsx"))
                return "\0" + id;
            },
            load(id) {
              if (id.startsWith("\0/__question-"))
                return transformWithOxc(
                  fixture(id.includes("dashboard") ? "dashboard" : "desktop"),
                  id.slice(1),
                );
            },
            configureServer(vite) {
              vite.middlewares.use(async (request, response, next) => {
                const surface =
                  request.url === "/__question-desktop"
                    ? "desktop"
                    : request.url === "/__question-dashboard"
                      ? "dashboard"
                      : undefined;
                if (!surface) return next();
                response.setHeader("Content-Type", "text/html");
                response.end(
                  await vite.transformIndexHtml(
                    request.url!,
                    '<!doctype html><html><head><base href="/"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/__question-' +
                      surface +
                      '.tsx"></script></body></html>',
                  ),
                );
              });
            },
          },
          react(),
        ],
        server: {
          host: "127.0.0.1",
          port: 0,
          hmr: false,
          fs: { allow: [resolve("..")] },
        },
      });
      await server.listen();
      for (const surface of ["desktop", "dashboard"])
        await server.environments.client!.transformRequest(
          `/__question-${surface}.tsx`,
        );
      await server.environments.client!.waitForRequestsIdle();
      const address = server.httpServer!.address();
      assert.ok(address && typeof address !== "string");
      browser = await chromium.launch({
        headless: true,
        executablePath: executable || undefined,
      });
      for (const surface of ["desktop", "dashboard"] as const) {
        const page = await browser.newPage({
          viewport: { width: 1280, height: 900 },
          locale: "zh-CN",
        });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route(
          /\/api\/(?:contexts|sessions|objectives)\//,
          async (route) => {
            const value = await page.evaluate(
              ({ path, body }) =>
                (window as any).questionFixture.api(path, body),
              {
                path: new URL(route.request().url()).pathname,
                body: route.request().postDataJSON(),
              },
            );
            await route.fulfill({ status: value.status, json: value.value });
          },
        );
        await page.goto(
          `http://127.0.0.1:${address.port}/__question-${surface}`,
        );
        await page.waitForFunction(() => !!(window as any).questionFixture);
        const previewSelector =
          surface === "desktop"
            ? ".user-input-preview"
            : ".runtime-question-preview";
        const preview = page.locator(previewSelector).first();
        const previewGeometry = await preview.evaluate((element) => {
          const button = element.querySelector("button")!;
          const style = getComputedStyle(element);
          const rect = button.getBoundingClientRect();
          return {
            display: style.display,
            background: style.backgroundColor,
            fontSize: getComputedStyle(button).fontSize,
            inlineQuestion: element.querySelector("p,details") !== null,
            buttonWidth: rect.width,
            buttonHeight: rect.height,
            buttonText: button.textContent,
            buttonName: button.getAttribute("aria-label"),
          };
        });
        assert.ok(
          ["inline-flex", "flex"].includes(previewGeometry.display),
          "the supplement is an inline action, never an expanded question block",
        );
        assert.equal(previewGeometry.background, "rgba(0, 0, 0, 0)");
        assert.equal(
          previewGeometry.inlineQuestion,
          false,
          "question is absent from the activity card",
        );
        assert.ok(
          previewGeometry.buttonWidth >= 28 &&
            previewGeometry.buttonWidth <= 33,
        );
        assert.ok(
          previewGeometry.buttonHeight >= 28 &&
            previewGeometry.buttonHeight < 33,
        );
        assert.equal(previewGeometry.buttonText, "");
        assert.equal(previewGeometry.buttonName, "补充");
        const attention = preview.locator("button");
        await expect(attention).toHaveAttribute("data-attention-motion", "on");
        const light = await attention.evaluate((button) => {
          const glow = getComputedStyle(button, "::before");
          const ring = getComputedStyle(button, "::after");
          return {
            glow: glow.animationName,
            ring: ring.animationName,
            play: glow.animationPlayState,
            border: ring.borderStyle,
            top: ring.top,
            blur: glow.filter,
            background: getComputedStyle(button).backgroundColor,
            color: getComputedStyle(button.querySelector("svg")!).color,
            opacity: getComputedStyle(button.querySelector("svg")!).opacity,
          };
        });
        assert.equal(light.glow, "supplement-breathe");
        assert.equal(
          light.ring,
          "none",
          "the edge stays fixed while surface gloss breathes",
        );
        assert.equal(light.play, "running");
        assert.equal(light.border, "solid");
        assert.equal(light.top, "0px", "a breathing button, not a corner dot");
        assert.equal(light.blur, "none", "no blurry tint outside the button");
        assert.ok(
          !light.background.startsWith("rgba"),
          "the theme background is solid: " + JSON.stringify(light),
        );
        assert.ok(contrastRatio(light.color, light.background) >= 4.5);
        assert.equal(
          light.opacity,
          "1",
          "the icon remains readable while the surrounding light breathes",
        );
        const breathLevels = await attention.evaluate((button) => {
          const breath = button
            .getAnimations({ subtree: true })
            .find(
              (animation) =>
                (animation as CSSAnimation).animationName ===
                "supplement-breathe",
            )!;
          const previous = breath.currentTime;
          breath.pause();
          breath.currentTime = 0;
          const dim = Number(getComputedStyle(button, "::before").opacity);
          breath.currentTime = 1600;
          const bright = Number(getComputedStyle(button, "::before").opacity);
          breath.currentTime = previous;
          breath.play();
          return [dim, bright];
        });
        assert.ok(
          breathLevels[1]! - breathLevels[0]! >= 0.6,
          "the button really breathes between dim and bright, not a static style",
        );
        const palettes = await attention.evaluate(async (button) => {
          const root = button.closest(".app, .page-shell")!;
          const colors = [];
          for (const mode of ["light", "dark"]) {
            for (const accent of ["cyan", "iris", "coral", "mono"]) {
              root.setAttribute("data-appearance", mode);
              root.setAttribute("data-color-mode", mode);
              root.setAttribute("data-accent", accent);
              document.documentElement.setAttribute("data-appearance", mode);
              document.documentElement.setAttribute("data-color-mode", mode);
              // Theme switches use the incumbent short background transition;
              // inspect the settled theme, not its previous-frame color.
              getComputedStyle(button).backgroundColor;
              await Promise.all(
                button
                  .getAnimations()
                  .filter((animation) => animation instanceof CSSTransition)
                  .map((animation) => animation.finished),
              );
              colors.push({
                mode,
                accent,
                background: getComputedStyle(button).backgroundColor,
                color: getComputedStyle(button.querySelector("svg")!).color,
              });
            }
          }
          root.setAttribute("data-appearance", "light");
          root.setAttribute("data-color-mode", "light");
          root.setAttribute("data-accent", "cyan");
          document.documentElement.setAttribute("data-appearance", "light");
          document.documentElement.setAttribute("data-color-mode", "light");
          return colors;
        });
        for (const palette of palettes) {
          assert.ok(
            !palette.background.startsWith("rgba"),
            JSON.stringify(palette),
          );
          assert.ok(
            contrastRatio(palette.color, palette.background) >= 4.5,
            surface + " " + JSON.stringify(palette),
          );
        }
        const motionCaptures = process.env.MORPHZ_QUESTION_UI_CAPTURE_DIR;
        if (motionCaptures) {
          mkdirSync(motionCaptures, { recursive: true });
          for (const mode of ["light", "dark"]) {
            await page
              .locator(".app, .page-shell")
              .evaluate((element, mode) => {
                element.setAttribute("data-color-mode", mode);
                element.setAttribute("data-appearance", mode);
                document.documentElement.setAttribute("data-color-mode", mode);
                document.documentElement.setAttribute("data-appearance", mode);
              }, mode);
            for (const time of [0, 1600]) {
              await attention.evaluate((button, time) => {
                for (const animation of button.getAnimations({
                  subtree: true,
                })) {
                  animation.pause();
                  animation.currentTime = time;
                }
              }, time);
              await page.screenshot({
                path: join(
                  motionCaptures,
                  `${surface}-attention-${mode}-${time}.png`,
                ),
                fullPage: true,
              });
            }
          }
          await page.locator(".app, .page-shell").evaluate((element) => {
            element.setAttribute("data-color-mode", "light");
            element.setAttribute("data-appearance", "light");
            document.documentElement.setAttribute("data-color-mode", "light");
            document.documentElement.setAttribute("data-appearance", "light");
          });
          await attention.evaluate((button) => {
            for (const animation of button.getAnimations({ subtree: true }))
              animation.play();
          });
        }
        await page.emulateMedia({ reducedMotion: "reduce" });
        assert.equal(
          await attention.evaluate(
            (button) => getComputedStyle(button, "::before").animationName,
          ),
          "none",
        );
        assert.notEqual(
          await attention.evaluate(
            (button) => getComputedStyle(button, "::after").borderStyle,
          ),
          "none",
          "reduced motion retains a static, legible pending state",
        );
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await preview.evaluate((element) => {
          (element as HTMLElement).style.display = "none";
        });
        await expect(attention).toHaveAttribute("data-attention-motion", "off");
        assert.equal(
          await attention.evaluate(
            (button) => getComputedStyle(button, "::before").animationPlayState,
          ),
          "paused",
        );
        await preview.evaluate((element) => {
          (element as HTMLElement).style.removeProperty("display");
        });
        await expect(attention).toHaveAttribute("data-attention-motion", "on");
        const captureDirectory = process.env.MORPHZ_QUESTION_UI_CAPTURE_DIR;
        const capture = async (name: string) => {
          if (!captureDirectory) return;
          mkdirSync(captureDirectory, { recursive: true });
          await page.waitForFunction(() => {
            const dialog =
              document.querySelector<HTMLElement>(".composer-question");
            return (
              dialog &&
              dialog.getAttribute("aria-busy") !== "true" &&
              Number(getComputedStyle(dialog).opacity) === 1 &&
              dialog.getBoundingClientRect().height > 0
            );
          });
          await page.evaluate(async () => {
            await Promise.all(
              document
                .getAnimations()
                .filter(
                  (animation) =>
                    animation.effect?.getComputedTiming().iterations !==
                    Infinity,
                )
                .map((animation) => animation.finished.catch(() => undefined)),
            );
          });
          await page.screenshot({
            path: join(captureDirectory, `${surface}-${name}.png`),
            fullPage: true,
          });
        };
        if (captureDirectory) {
          mkdirSync(captureDirectory, { recursive: true });
          await page.screenshot({
            path: join(captureDirectory, `${surface}-pending-activity.png`),
            fullPage: true,
          });
        }
        const first = page
            .locator('[data-thread="thread-1"]')
            .getByRole("button", { name: "补充", exact: true }),
          second = page
            .locator('[data-thread="thread-2"]')
            .getByRole("button", { name: "补充", exact: true });
        await page.getByLabel("主输入").fill("主输入：不要修改我");
        await first.click();
        let dialog = page.locator(".composer-question");
        assert.equal(await page.locator("dialog[open]").count(), 0);
        assert.equal(await page.getByLabel("主输入").isVisible(), false);
        assert.equal(
          await page
            .getByRole("button", { name: "主输入发送", includeHidden: true })
            .isVisible(),
          false,
        );
        assert.equal(
          await dialog.evaluate((el) => !!el.closest(".composer")),
          true,
        );
        await dialog.getByRole("checkbox", { name: /启用预览/ }).waitFor();
        const source = dialog.locator(
          surface === "desktop"
            ? ".user-input-composer-target"
            : ".runtime-question-target",
        );
        assert.ok(
          (await source.getAttribute("title"))!.includes("长任务来源"),
          "full original source remains available without a duplicate source row",
        );
        assert.ok(
          (await source.evaluate(
            (element) => element.getBoundingClientRect().height,
          )) < 30,
          "source stays one compact line",
        );
        const proportions = await dialog.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const question = element
            .querySelector("legend")!
            .getBoundingClientRect();
          const source = element
            .querySelector("header")!
            .getBoundingClientRect();
          const choice = element
            .querySelector("label:has(input[type=checkbox])")!
            .getBoundingClientRect();
          return {
            width: rect.width,
            height: rect.height,
            questionTop: question.top,
            sourceTop: source.top,
            choiceHeight: choice.height,
          };
        });
        assert.ok(
          proportions.width <= 740,
          "the question uses the existing input width, not an overlay",
        );
        assert.ok(
          proportions.height <= 360,
          "short answer panel does not inherit oversized header/footer spacing",
        );
        assert.ok(
          proportions.questionTop > proportions.sourceTop,
          "the original supplement target is a compact input header, not a separate task card",
        );
        assert.ok(
          proportions.choiceHeight >= 36 && proportions.choiceHeight <= 41,
          "pointer choices keep a compact, legible row",
        );
        await source.focus();
        await expect(source).toBeFocused();
        assert.equal(
          await dialog
            .getByRole("button", { name: "发送", exact: true })
            .isDisabled(),
          true,
        );
        await dialog.getByRole("checkbox", { name: /启用预览/ }).check();
        await dialog.getByRole("textbox").fill("只使用合成数据");
        if (captureDirectory) {
          for (const mode of ["light", "dark"]) {
            await page.evaluate((mode) => {
              document.documentElement.dataset.appearance = mode;
              document.documentElement.dataset.colorMode = mode;
              document.querySelector<HTMLElement>(
                ".app, .page-shell",
              )!.dataset.appearance = mode;
              document.querySelector<HTMLElement>(
                ".app, .page-shell",
              )!.dataset.colorMode = mode;
            }, mode);
            if (surface === "dashboard" && mode === "light") {
              for (const accent of ["cyan", "iris", "coral", "mono"]) {
                await page
                  .locator(".page-shell")
                  .evaluate(
                    (element, value) =>
                      ((element as HTMLElement).dataset.accent = value),
                    accent,
                  );
                const colors = await dialog.evaluate((element) => {
                  const send = getComputedStyle(
                    element.querySelector(".runtime-question-send")!,
                  );
                  const clear = getComputedStyle(
                    element.querySelector(
                      ".runtime-question-text-label button",
                    )!,
                  );
                  return {
                    send: [send.color, send.backgroundColor] as const,
                    clear: [
                      clear.color,
                      getComputedStyle(element.closest(".composer")!)
                        .backgroundColor,
                    ] as const,
                  };
                });
                const ratios = {
                  send: contrastRatio(...colors.send),
                  clear: contrastRatio(...colors.clear),
                };
                assert.ok(
                  ratios.send >= 4.5 && ratios.clear >= 4.5,
                  `${accent} enabled controls need 4.5:1 contrast: ${JSON.stringify(ratios)}`,
                );
              }
              await page
                .locator(".page-shell")
                .evaluate(
                  (element) =>
                    ((element as HTMLElement).dataset.accent = "cyan"),
                );
            }
            await capture(`choices-${mode}`);
          }
          await page.setViewportSize({ width: 390, height: 844 });
          await capture("choices-narrow-dark");
          assert.ok(
            await dialog.evaluate((element) => {
              const rect = element.getBoundingClientRect();
              return (
                rect.left >= 0 &&
                rect.right <= window.innerWidth &&
                rect.bottom <= window.innerHeight
              );
            }),
            surface + " narrow dialog stays within the viewport",
          );
          await page.setViewportSize({ width: 1280, height: 900 });
        }
        assert.equal(
          (await page.evaluate(() => (window as any).questionFixture.report()))
            .commands.length,
          0,
        );
        await page.getByRole("button", { name: "TEST 旧任务回复" }).focus();
        assert.equal(
          await page
            .getByRole("button", { name: "TEST 旧任务回复" })
            .evaluate((el) => el === document.activeElement),
          true,
          "background remains keyboard reachable; no modal focus trap",
        );
        await dialog.getByRole("textbox").focus();
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
        await expect(page.getByLabel("主输入")).toBeFocused();
        await second.click();
        dialog = page.locator(".composer-question");
        await dialog.getByRole("checkbox", { name: /保持关闭/ }).check();
        await dialog.getByRole("textbox").fill("第二项独立草稿");
        await page.keyboard.press("Escape");
        await first.click();
        dialog = page.locator(".composer-question");
        assert.equal(
          await dialog.getByRole("checkbox", { name: /启用预览/ }).isChecked(),
          true,
        );
        assert.equal(
          await dialog.getByRole("textbox").inputValue(),
          "只使用合成数据",
        );
        await page.evaluate(() =>
          (window as any).questionFixture.loseReceipt(),
        );
        await dialog
          .getByRole("button", { name: "发送", exact: true })
          .evaluate((element) => {
            (element as HTMLButtonElement).click();
            (element as HTMLButtonElement).click();
          });
        await dialog.getByRole("alert").waitFor();
        await dialog.getByText(/答案和本次投递已保留/).waitFor();
        await capture("unknown-receipt");
        assert.equal(await dialog.getByRole("textbox").isDisabled(), true);
        await dialog
          .getByRole("button", { name: "核对投递", exact: true })
          .click();
        await dialog.waitFor({ state: "detached" });
        let report = await page.evaluate(() =>
          (window as any).questionFixture.report(),
        );
        assert.equal(report.accepted, 1);
        assert.equal(report.commands.length, 2);
        assert.deepEqual(
          report.commands[0],
          report.commands[1],
          "unknown delivery must reuse every original command byte",
        );
        assert.equal(
          report.commands[0].input_destination.thread_id,
          "thread-1",
        );
        assert.equal(report.commands[0].input_destination.kind, "user_input");
        assert.equal(report.draft, "主输入：不要修改我");
        await second.click();
        dialog = page.locator(".composer-question");
        assert.equal(
          await dialog.getByRole("textbox").inputValue(),
          "第二项独立草稿",
        );
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "TEST 旧任务回复" }).click();
        dialog = page.locator(".composer-question");
        await dialog.getByText(/旧记录没有保存具体问题/).waitFor();
        await capture("legacy-question");
        await dialog.getByRole("textbox").fill("旧任务的明确回复");
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "TEST 旧任务回复" }).click();
        dialog = page.locator(".composer-question");
        assert.equal(
          await dialog.getByRole("textbox").inputValue(),
          "旧任务的明确回复",
        );
        await page.keyboard.press("Escape");
        await second.click();
        dialog = page.locator(".composer-question");
        await page.evaluate(() => (window as any).questionFixture.replace());
        const send = dialog.getByRole("button", { name: "发送", exact: true });
        if (surface === "desktop") await expect(send).toBeDisabled();
        else {
          await send.click();
          await dialog.getByText(/问题已不再待答/).waitFor();
        }
        report = await page.evaluate(() =>
          (window as any).questionFixture.report(),
        );
        assert.equal(
          report.accepted,
          1,
          "a replaced form never answers another request",
        );
        await page.keyboard.press("Escape");
        await page.evaluate(() => (window as any).questionFixture.batch());
        await first.click();
        dialog = page.locator(".composer-question");
        await dialog.getByRole("radio", { name: /启用预览/ }).check();
        await dialog.getByRole("checkbox", { name: /第一项/ }).check();
        await dialog.getByRole("checkbox", { name: /第二项/ }).check();
        if (captureDirectory) {
          await page.setViewportSize({ width: 640, height: 450 });
          await capture("batch-compact");
          await page.setViewportSize({ width: 1280, height: 900 });
        }
        assert.equal(
          await dialog
            .getByRole("button", { name: "发送", exact: true })
            .isDisabled(),
          true,
        );
        await dialog.getByRole("textbox").nth(2).fill("不得访问外部数据");
        await dialog.getByRole("button", { name: "发送", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        report = await page.evaluate(() =>
          (window as any).questionFixture.report(),
        );
        assert.equal(report.accepted, 2);
        assert.equal(
          report.commands.at(-1).input_destination.answers.length,
          3,
        );
        assert.deepEqual(
          report.commands.at(-1).input_destination.answers[1]
            .selected_option_ids,
          ["one", "two"],
        );
        assert.equal(report.draft, "主输入：不要修改我");
        await page.getByRole("button", { name: "TEST 旧任务回复" }).click();
        dialog = page.locator(".composer-question");
        await dialog.getByRole("button", { name: "发送", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        report = await page.evaluate(() =>
          (window as any).questionFixture.report(),
        );
        assert.equal(report.accepted, 3);
        assert.deepEqual(report.commands.at(-1).input_destination, {
          kind: "objective",
          objective_id: "TEST-goal",
          generation: 1,
          reply_to_request_id: "legacy-record-1",
        });
        await page.evaluate(() => (window as any).questionFixture.single());
        await first.click();
        dialog = page.locator(".composer-question");
        await expect(dialog.getByRole("textbox")).toBeEnabled();
        await dialog.getByRole("textbox").fill("单选附加说明");
        const beforeSingle = report.commands.length;
        await page.evaluate(() =>
          (window as any).questionFixture.loseReceipt(),
        );
        await dialog
          .getByRole("radio", { name: /启用预览/ })
          .evaluate((element) => {
            (element as HTMLInputElement).click();
            (element as HTMLInputElement).click();
          });
        await dialog.getByRole("alert").waitFor();
        report = await page.evaluate(() =>
          (window as any).questionFixture.report(),
        );
        assert.equal(
          report.commands.length,
          beforeSingle + 1,
          "single choice submits exactly once without a Send click",
        );
        assert.equal(report.accepted, 4);
        assert.deepEqual(report.commands.at(-1).input_destination.answers, [
          {
            question_id: "preview",
            selected_option_ids: ["yes"],
            text: "单选附加说明",
          },
        ]);
        await dialog
          .getByRole("button", { name: "核对投递", exact: true })
          .click();
        await dialog.waitFor({ state: "detached" });
        report = await page.evaluate(() =>
          (window as any).questionFixture.report(),
        );
        assert.deepEqual(
          report.commands.at(-1),
          report.commands.at(-2),
          "automatic send retains exact command identity after unknown receipt",
        );
        await page.evaluate(() =>
          (window as any).questionFixture.singleBatch(),
        );
        await first.click();
        dialog = page.locator(".composer-question");
        await expect(dialog.getByRole("radio").first()).toBeEnabled();
        await dialog
          .getByRole("radio", { name: /启用预览/ })
          .first()
          .check();
        assert.equal(
          (await page.evaluate(() => (window as any).questionFixture.report()))
            .accepted,
          4,
          "an incomplete question batch never sends early",
        );
        await dialog
          .getByRole("radio", { name: /保持关闭/ })
          .nth(1)
          .click();
        await dialog.waitFor({ state: "detached" });
        report = await page.evaluate(() =>
          (window as any).questionFixture.report(),
        );
        assert.equal(report.accepted, 5);
        assert.equal(
          report.commands.at(-1).input_destination.answers.length,
          2,
        );
        assert.equal(report.draft, "主输入：不要修改我");
        await page.evaluate(() => (window as any).questionFixture.revoke());
        await second.click();
        dialog = page.locator(".composer-question");
        await dialog
          .getByRole("alert")
          .filter({ hasText: "TEST permission revoked" })
          .waitFor();
        await dialog.getByText(/恢复访问权限后/).waitFor();
        await capture("permission-revoked");
        await expect(
          dialog.getByRole("button", { name: "发送", exact: true }),
        ).toBeDisabled();
        assert.equal(
          (await page.evaluate(() => (window as any).questionFixture.report()))
            .accepted,
          5,
        );
        await page.keyboard.press("Escape");
        assert.deepEqual(errors, [], surface + " has no browser exceptions");
        await page.close();
      }
    } catch (error) {
      // Report the assertion before browser/server teardown, which can itself
      // wait for outstanding requests after a failed mounted interaction.
      console.error(error);
      throw error;
    } finally {
      await browser?.close();
      await server?.close();
      rmSync(cache, { recursive: true, force: true });
    }
  },
);
