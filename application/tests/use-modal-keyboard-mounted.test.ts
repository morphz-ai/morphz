import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, type Browser } from "@playwright/test";
import { createServer, transformWithOxc, type ViteDevServer } from "vite";
import {
  beforeReviewedInspectorKeyboardChange,
  beforeReviewedModalChanges,
  inspectorModalKeyboardGuard,
  modalKeyboardChanges,
  modalInitialPositionChange,
} from "./fixtures/modal-keyboard-boundary.js";

const modalSource = readFileSync(resolve("apps/web/src/useModal.ts"), "utf8");
const inspectorSource = readFileSync(
  resolve("apps/web/src/InspectorPanel.tsx"),
  "utf8",
);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

test("modal evolution permits only reviewed event-order and initial-position spans, not altered focus, cleanup or ancestor shortcuts", () => {
  const original = beforeReviewedModalChanges(modalSource);
  assert.equal(
    sha(original),
    "8ceb55250ffa2f6130837b3f7d9cf7d401821ed08ae991d8f5d938b99e513592",
  );
  for (const [current] of [...modalKeyboardChanges, modalInitialPositionChange])
    assert.throws(() =>
      beforeReviewedModalChanges(modalSource.replace(current, "")),
    );
  for (const [before, after] of [
    ["if (candidate !== event) return;", "if (false) return;"],
    ["const cleanup = window.setTimeout(", "const cleanup = queueMicrotask("],
    ["window.clearTimeout(cleanup);", ""],
    ["event.defaultPrevented ||", "false ||"],
    ['element.removeEventListener("keydown", scopeKeyboardEvent, true);', ""],
  ])
    assert.throws(() =>
      beforeReviewedModalChanges(modalSource.replace(before!, after!)),
    );
  assert.notEqual(
    sha(
      beforeReviewedModalChanges(
        modalSource.replace("returnTarget?.focus", "origin?.focus"),
      ),
    ),
    sha(original),
    "unrelated focus restoration cannot pass the original owner hash",
  );
  const inspector = beforeReviewedInspectorKeyboardChange(inspectorSource);
  assert.throws(() =>
    beforeReviewedInspectorKeyboardChange(
      inspectorSource.replace(inspectorModalKeyboardGuard, ""),
    ),
  );
  assert.throws(() =>
    beforeReviewedInspectorKeyboardChange(
      inspectorSource.replace(
        "node instanceof HTMLDialogElement",
        "node instanceof HTMLElement",
      ),
    ),
  );
  assert.notEqual(
    beforeReviewedInspectorKeyboardChange(
      inspectorSource.replace('event.key === "Escape"', "true"),
    ),
    inspector,
    "the existing inspector shortcut is not part of the approved delta",
  );
});

// Real React delegation, actual useModal/InspectorPanel and a genuine portal.
// The child handlers intentionally exercise both stopped propagation and
// flushSync unmount without stopPropagation; neither a mocked event loop nor
// a dialog existence query can prove this ordering.
const fixture = `
import React,{StrictMode,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {createPortal,flushSync} from 'react-dom';
import {useModal} from '/src/useModal.ts';
import {InspectorPanel} from '/src/InspectorPanel.tsx';
const events=[], listeners=new Set();
const add=document.addEventListener.bind(document),remove=document.removeEventListener.bind(document);
document.addEventListener=(type,listener,...rest)=>{if(type==='keydown')listeners.add(listener);return add(type,listener,...rest);};
document.removeEventListener=(type,listener,...rest)=>{if(type==='keydown')listeners.delete(listener);return remove(type,listener,...rest);};
window.addEventListener('keydown',event=>events.push(['window',event.key,!!document.querySelector('dialog[open]')]));
let reset,unmount;
function Modal({mode,close}){
 const dialog=useRef(null),first=useRef(null);useModal(dialog,first);
 return <dialog ref={dialog} aria-label="keyboard regression" onCancel={event=>{events.push(['cancel']);event.preventDefault();close();}}>
  <input ref={first} aria-label="first" onKeyDown={event=>{
   events.push(['child',event.key,event.nativeEvent.isComposing]);
   if(event.key==='Escape'&&mode==='handled'){event.preventDefault();event.stopPropagation();}
   if(event.key==='Escape'&&mode==='unmount')close();
   if(event.key==='Tab'&&mode==='handled'){event.preventDefault();document.getElementById('middle').focus();}
  }}/>
  <button id="middle">middle</button><button id="last">last</button>
 </dialog>;
}
function Fixture(){
 const [state,setState]=useState({open:true,mode:'handled'});
 const close=()=>flushSync(()=>setState(old=>({...old,open:false})));
 reset=mode=>{flushSync(()=>setState({open:false,mode}));document.getElementById('inspector-control').focus();flushSync(()=>setState({open:true,mode}));events.length=0;};
 return <InspectorPanel className="keyboard-owner" label="inspector" title="inspector" resizeLabel="resize"
  layout={{mode:'docked',width:300,maxWidth:500}} onResize={()=>{}} focusOnMount={false}
  onClose={()=>events.push(['inspector-close'])}>
  <button id="inspector-control">inspector control</button>
  {state.open&&createPortal(<Modal mode={state.mode} close={close}/>,document.getElementById('portal'))}
 </InspectorPanel>;
}
const root=createRoot(document.getElementById('root'));
flushSync(()=>root.render(<StrictMode><Fixture/></StrictMode>));
window.modalKeyboard={reset,clear(){events.length=0;},report(){return {events:[...events],listeners:listeners.size,
 open:!!document.querySelector('dialog[open]'),active:document.activeElement?.id||document.activeElement?.getAttribute('aria-label')};},
 unmount(){flushSync(()=>root.unmount());}};
`;

test(
  "modal keys reach React controls before focus trapping, survive synchronous portal unmount, and leave no listeners",
  { timeout: 60_000 },
  async (context) => {
    const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
    assert.ok(
      existsSync(executable || chromium.executablePath()),
      "run through npm test to prepare a real browser",
    );
    const cache = mkdtempSync(join(tmpdir(), "morphz-modal-keyboard-"));
    let server: ViteDevServer | undefined, browser: Browser | undefined;
    try {
      server = await createServer({
        configFile: false,
        root: resolve("apps/web"),
        cacheDir: cache,
        logLevel: "error",
        optimizeDeps: {
          entries: [
            resolve("apps/web/src/useModal.ts"),
            resolve("apps/web/src/InspectorPanel.tsx"),
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
            name: "modal-keyboard-fixture",
            resolveId(id) {
              if (id === "/__modal-keyboard.tsx") return "\0" + id;
            },
            load(id) {
              if (id === "\0/__modal-keyboard.tsx")
                return transformWithOxc(fixture, "modal-keyboard.tsx");
            },
            configureServer(vite) {
              vite.middlewares.use(async (request, response, next) => {
                if (request.url !== "/__modal-keyboard") return next();
                response.setHeader("Content-Type", "text/html");
                response.end(
                  await vite.transformIndexHtml(
                    request.url,
                    '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="root"></div><div id="portal"></div><button id="outside">outside</button><script type="module" src="/__modal-keyboard.tsx"></script></body></html>',
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
      const address = server.httpServer!.address();
      assert.ok(address && typeof address !== "string");
      browser = await chromium.launch({
        headless: true,
        executablePath: executable || undefined,
      });
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}/__modal-keyboard`);
      await page.waitForFunction(() => !!(window as any).modalKeyboard);
      const report = () =>
        page.evaluate(async () => {
          // Observe after the promised event-task cleanup, not in a competing
          // automation task scheduled before the browser's pending timer.
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
          return (window as any).modalKeyboard.report();
        }) as Promise<{
          events: unknown[][];
          listeners: number;
          open: boolean;
          active: string;
        }>;
      const reset = (mode: string) =>
        page.evaluate(
          (value) => (window as any).modalKeyboard.reset(value),
          mode,
        );

      await context.test(
        "IME Escape is prevented by the child and never cancels the modal",
        async () => {
          const dispatched = await page.getByRole("textbox").evaluate((input) =>
            input.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "Escape",
                bubbles: true,
                cancelable: true,
                isComposing: true,
              }),
            ),
          );
          assert.equal(dispatched, false);
          assert.deepEqual(await report(), {
            events: [["child", "Escape", true]],
            listeners: 0,
            open: true,
            active: "first",
          });
        },
      );

      await context.test(
        "child Escape and Tab take precedence over native cancel and the focus loop",
        async () => {
          await reset("handled");
          await page.getByRole("textbox").press("Escape");
          assert.equal((await report()).open, true);
          await page.getByRole("textbox").press("Shift+Tab");
          const actual = await report();
          assert.equal(actual.active, "middle");
          assert.equal(actual.listeners, 0);
          assert.equal(
            actual.events.some(
              ([kind]) => kind === "cancel" || kind === "inspector-close",
            ),
            false,
          );
        },
      );

      await context.test(
        "unhandled Tab wraps in both directions after child handlers",
        async () => {
          await reset("native");
          await page.locator("#last").focus();
          await page.keyboard.press("Tab");
          assert.equal((await report()).active, "first");
          await page.keyboard.press("Shift+Tab");
          const actual = await report();
          assert.equal(actual.active, "last");
          assert.equal(actual.listeners, 0);
          assert.ok(
            actual.events.some(
              ([kind, key]) => kind === "child" && key === "Tab",
            ),
          );
        },
      );

      await context.test(
        "unhandled Escape preserves native cancel without closing the portal's inspector",
        async () => {
          await reset("native");
          await page.getByRole("textbox").press("Escape");
          assert.deepEqual(await report(), {
            events: [["child", "Escape", false], ["cancel"]],
            listeners: 0,
            open: false,
            active: "inspector-control",
          });
        },
      );

      await context.test(
        "flushSync removal cannot expose that same Escape to React ancestors or window",
        async () => {
          await reset("unmount");
          await page.getByRole("textbox").press("Escape");
          const actual = await report();
          assert.equal(actual.open, false);
          assert.equal(actual.listeners, 0);
          assert.deepEqual(actual.events, [["child", "Escape", false]]);
        },
      );

      await context.test(
        "stopped keys clean up and subsequent non-modal shortcuts retain their original scope",
        async () => {
          for (let index = 0; index < 4; index++) {
            await reset("handled");
            await page.getByRole("textbox").press("Escape");
            assert.equal((await report()).listeners, 0);
          }
          await reset("unmount");
          await page.getByRole("textbox").press("Escape");
          await page.evaluate(() => (window as any).modalKeyboard.clear());
          await page.locator("#inspector-control").press("Escape");
          assert.deepEqual((await report()).events, [["inspector-close"]]);
          await page.evaluate(() => (window as any).modalKeyboard.clear());
          await page.locator("#outside").press("Escape");
          assert.deepEqual((await report()).events, [
            ["window", "Escape", false],
          ]);
          await page.evaluate(() => (window as any).modalKeyboard.unmount());
          assert.equal((await report()).listeners, 0);
        },
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await server?.close();
      rmSync(cache, { recursive: true, force: true });
    }
  },
);
