import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, type Browser } from "@playwright/test";
import { createServer, transformWithOxc, type ViteDevServer } from "vite";
import { currentAppCSSImports } from "./fixtures/current-app-css.js";

// Real useModal through its actual application-picker consumer and current CSS.
// Only ResizeObserver delivery is held. A synchronous React commit must already
// have correct geometry: no animation/frame/observer wait may repair it first.
const fixture = `
import React,{StrictMode,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {CognitiveApplicationPicker} from '/src/features/applications/CognitiveApplicationChoices.tsx';
${currentAppCSSImports()}
const observers=new Set(),shown=[];
window.ResizeObserver=class {
 constructor(callback){this.callback=callback;this.targets=new Set();observers.add(this);}
 observe(target){this.targets.add(target);}
 unobserve(target){this.targets.delete(target);}
 disconnect(){this.targets.clear();observers.delete(this);}
};
const nativeShow=HTMLDialogElement.prototype.showModal;
HTMLDialogElement.prototype.showModal=function(){
 const before={zoom:this.currentCSSZoom,display:getComputedStyle(this).display};
 nativeShow.call(this);
 shown.push({before,after:{zoom:this.currentCSSZoom,display:getComputedStyle(this).display}});
};
const entries=Array.from({length:10},(_,index)=>({
 kind:'cognitive',key:'test-'+index,gui:'absent',inputAvailability:'selectable',
 metadata:{appId:'test-'+index,version:'1.0.0',title:'合成应用 '+(index+1),icon:'document'},
 connections:[]
}));
let change;
function Fixture(){
 const [open,setOpen]=useState(false);change=setOpen;
 return <div className="app" style={{display:'block',width:'100%',height:'100%'}}>
  <div className="workspace" style={{display:'block',width:'100%',height:'100%'}}>
   <main className="primary-panel" style={{position:'relative',marginLeft:160,width:'calc(100% - 160px)',height:'100%'}}>
    <input id="origin" aria-label="原输入" defaultValue="保留草稿"/>
    {open&&<CognitiveApplicationPicker entries={entries} onChoose={()=>{throw Error('unexpected choose');}} onClose={()=>change(false)}/>}
   </main>
  </div>
 </div>;
}
const root=createRoot(document.getElementById('root'));
flushSync(()=>root.render(<StrictMode><Fixture/></StrictMode>));
function report(){
 const dialog=document.querySelector('dialog'),box=dialog?.getBoundingClientRect();
 return {open:!!dialog?.open,box:box?.toJSON(),viewport:{width:innerWidth,height:innerHeight},
  zoom:dialog?.currentCSSZoom,center:dialog?.style.getPropertyValue('--modal-center'),
  maxHeight:dialog?.style.getPropertyValue('--modal-max-height'),
  active:document.activeElement?.getAttribute('aria-label')||document.activeElement?.textContent,
  activeInside:!!dialog?.contains(document.activeElement),shown:[...shown],observers:observers.size,
  draft:document.getElementById('origin').value,selection:document.getElementById('origin').selectionStart};
}
window.modalGeometry={
 open(zoom){
  flushSync(()=>change(false));shown.length=0;
  const app=document.querySelector('.app');
  app.style.zoom=String(zoom);app.style.width=(innerWidth/zoom)+'px';app.style.height=(innerHeight/zoom)+'px';
  document.querySelector('.primary-panel').style.width='calc(100% - 160px)';
  const input=document.getElementById('origin');input.focus();input.setSelectionRange(2,2);
  flushSync(()=>change(true));
  return report();
 },
 resize(width){
  document.querySelector('.primary-panel').style.width=width+'px';
  for(const observer of observers)observer.callback([],observer);
  return report();
 },
 close(){flushSync(()=>change(false));return report();},
 unmount(){flushSync(()=>root.unmount());return observers.size;}
};
`;

test(
  "native modal is positioned at 200% CSS zoom before any ResizeObserver delivery, preserving focus and resize",
  { timeout: 60_000 },
  async (context) => {
    const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
    assert.ok(
      existsSync(executable || chromium.executablePath()),
      "run through npm test to prepare a real browser",
    );
    const cache = mkdtempSync(join(tmpdir(), "morphz-modal-geometry-vite-"));
    const evidence = mkdtempSync(
      join(tmpdir(), "morphz-modal-geometry-proof-"),
    );
    let server: ViteDevServer | undefined, browser: Browser | undefined;
    try {
      server = await createServer({
        configFile: false,
        root: resolve("apps/web"),
        cacheDir: cache,
        logLevel: "error",
        optimizeDeps: {
          entries: [
            resolve(
              "apps/web/src/features/applications/CognitiveApplicationChoices.tsx",
            ),
          ],
          include: [
            "react",
            "react-dom",
            "react-dom/client",
            "react/jsx-runtime",
          ],
        },
        plugins: [
          {
            name: "modal-initial-geometry-fixture",
            resolveId(id) {
              if (id === "/__modal-geometry.tsx") return "\0" + id;
            },
            load(id) {
              if (id === "\0/__modal-geometry.tsx")
                return transformWithOxc(fixture, "modal-geometry.tsx");
            },
            configureServer(vite) {
              vite.middlewares.use(async (request, response, next) => {
                if (request.url !== "/__modal-geometry") return next();
                response.setHeader("Content-Type", "text/html");
                response.end(
                  await vite.transformIndexHtml(
                    request.url,
                    '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/__modal-geometry.tsx"></script></body></html>',
                  ),
                );
              });
            },
          },
          react(),
        ],
        server: { host: "127.0.0.1", port: 0 },
      });
      await server.listen();
      assert.ok(
        await server.environments.client!.transformRequest(
          "/__modal-geometry.tsx",
        ),
      );
      await server.environments.client!.waitForRequestsIdle();
      const address = server.httpServer!.address();
      assert.ok(address && typeof address !== "string");
      browser = await chromium.launch({
        headless: true,
        executablePath: executable || undefined,
      });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}/__modal-geometry`);
      await page.waitForFunction(() => !!(window as any).modalGeometry);
      for (const scenario of [
        { name: "wide-light", width: 1440, height: 1000, zoom: 1, dark: false },
        { name: "wide-dark", width: 1440, height: 1000, zoom: 1, dark: true },
        { name: "narrow-light", width: 760, height: 540, zoom: 1, dark: false },
        { name: "narrow-dark", width: 760, height: 540, zoom: 1, dark: true },
        {
          name: "css-200-light",
          width: 1440,
          height: 1000,
          zoom: 2,
          dark: false,
        },
        {
          name: "css-200-dark",
          width: 1440,
          height: 1000,
          zoom: 2,
          dark: true,
        },
      ]) {
        const { zoom } = scenario;
        await page.setViewportSize({
          width: scenario.width,
          height: scenario.height,
        });
        await page.emulateMedia({
          colorScheme: scenario.dark ? "dark" : "light",
        });
        // The returned value is captured synchronously after the layout effect,
        // inside the same JS task. Browser frames cannot make this assertion pass.
        const actual = await page.evaluate(
          (value) => (window as any).modalGeometry.open(value),
          zoom,
        );
        writeFileSync(
          join(evidence, `${scenario.name}.json`),
          JSON.stringify(actual, null, 2),
          { mode: 0o600 },
        );
        await page.screenshot({
          path: join(evidence, `${scenario.name}-first-frame.png`),
          fullPage: true,
        });
        context.diagnostic(`${scenario.name}: ${JSON.stringify(actual)}`);
        assert.equal(actual.open, true);
        assert.equal(actual.zoom, zoom);
        assert.equal(actual.activeInside, true);
        assert.equal(actual.observers, 1, "StrictMode cleans the first mount");
        assert.ok(
          actual.box.left >= -1 &&
            actual.box.top >= -1 &&
            actual.box.right <= actual.viewport.width + 1 &&
            actual.box.bottom <= actual.viewport.height + 1,
          JSON.stringify(actual),
        );
        assert.equal(actual.center, `${(scenario.width / zoom + 160) / 2}px`);
        assert.equal(actual.maxHeight, `${scenario.height / zoom - 32}px`);
        // Initial geometry above is already captured and checked. These waits
        // are exclusively for a readable, settled full-surface visual record.
        await page.locator("dialog").evaluate(async (element) => {
          await Promise.all(
            element
              .getAnimations({ subtree: true })
              .map((item) => item.finished),
          );
          await new Promise((done) =>
            requestAnimationFrame(() => requestAnimationFrame(done)),
          );
        });
        await page.screenshot({
          path: join(evidence, `${scenario.name}.png`),
          fullPage: true,
        });
        const resized = await page.evaluate(() =>
          (window as any).modalGeometry.resize(400),
        );
        assert.equal(resized.center, "360px");
        const closed = await page.evaluate(() =>
          (window as any).modalGeometry.close(),
        );
        assert.equal(closed.open, false);
        assert.equal(closed.active, "原输入");
        assert.equal(closed.draft, "保留草稿");
        assert.equal(closed.selection, 2);
        assert.equal(closed.observers, 0);
      }
      assert.equal(
        await page.evaluate(() => (window as any).modalGeometry.unmount()),
        0,
      );
      assert.deepEqual(errors, []);
    } finally {
      context.diagnostic(`geometry evidence: ${evidence}`);
      await browser?.close();
      await server?.close();
      rmSync(cache, { recursive: true, force: true });
    }
  },
);
