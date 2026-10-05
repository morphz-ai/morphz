import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { buildSync } from "esbuild";
import {
  chromium,
  type Browser,
  type Frame,
  type Page,
} from "@playwright/test";
import {
  createCognitiveDocumentBootstrap,
  cognitiveDocumentBootstrapProtocol,
} from "../../packages/application/src/cognitive-document-bootstrap.js";
import { appContentSecurityPolicy } from "../../packages/core/src/resource-policy.js";

const productionHostCode = buildSync({
  stdin: {
    contents:
      'export { createCognitiveDocumentPort } from "./apps/web/src/host/cognitive-document-port.ts";',
    resolveDir: new URL("../../", import.meta.url).pathname,
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "pairedPortProduction",
  target: "es2023",
  write: false,
}).outputFiles[0]!.text;

/** Deliberately not an SDK: synchronous author-facing production facade calls
 * and actual subscriber observations only. No business replies are invented. */
const author = `<!doctype html><html><head><meta charset="utf-8"><title>Paired native author</title><script>
(() => {
 const facade=window.__morphzCognitiveDocument(), received=[];
 let callbackRetired=false;
 facade.subscribe(text=>{
   received.push(text);
   if(text==='"retire-during-callback"'){facade.dispose();callbackRetired=true;}
 });
 window.pairedAuthor={send:text=>facade.send(text),check:()=>facade.check(),report:()=>({received:[...received],callbackRetired})};
 facade.send('{"type":"morphz-cognitive-ui/v1:connect"}');
})();
</script></head><body><main>实际原生端口测试 😀</main></body></html>`;

const parentCode = String.raw`(() => {
 const protocol=__PROTOCOL__,proof=__PROOF__;
 const hostWires=[],hostPosts=[];let peer=null,bridge=null,ready=0,retired=0,peers=0;
 const wrapper=document.createElement("iframe");wrapper.id="paired-wrapper";wrapper.src="/paired-wrapper";
 function attach(){
  if(!peer||bridge)throw Error("Missing/unexpected actual native peer");
  const originalPost=peer.postMessage;
  peer.postMessage=function(...args){const result=Reflect.apply(originalPost,this,args);hostPosts.push(structuredClone(args[0]));return result;};
  bridge=pairedPortProduction.createCognitiveDocumentPort(peer,{
   onWire(text){hostWires.push(text);},onReady(){ready++;},onRetire(){retired++;}
  });
 }
 addEventListener("message",event=>{
  const packet=event.data;
  if(event.source!==wrapper.contentWindow||event.origin!==location.origin||
     !packet||packet.protocol!==protocol||packet.proof!==proof||event.ports.length!==1||peers!==0)return;
  peers++;peer=event.ports[0];if(!__HOLD_HOST__)attach();
 });
 window.pairedHost={
  releasePeer(){attach();},
  send(text){if(!bridge)throw Error("Actual peer not attached");bridge.send(text);},
  dispose(){bridge?.dispose();},
  report(){return{hostWires:[...hostWires],hostPosts:structuredClone(hostPosts),ready,retired,peers,attached:bridge!==null};}
 };
 document.body.append(wrapper);
})();`;

/** CONTROLLED native receive-start gate, installed in only the opaque srcdoc
 * realm before the production prefix captures native methods. The actual port
 * is lexical here, never exposed to author code. No message is fabricated,
 * manually acknowledged or delivered: release invokes Chromium's saved start.
 * This instrumentation is not a production scheduling/lifecycle mechanism. */
const documentGate = String.raw`(() => {
 if(location.href!=="about:srcdoc")return;
 const nativeStart=MessagePort.prototype.start,nativePost=MessagePort.prototype.postMessage;
 const apply=Reflect.apply,clone=structuredClone.bind(window);
 let held=__HOLD_DOC__,target=null,heldStarts=0;
 const posts=[];
 MessagePort.prototype.start=function(...args){
  if(target===null)target=this;
  if(this===target&&held){heldStarts++;return;}
  return apply(nativeStart,this,args);
 };
 MessagePort.prototype.postMessage=function(...args){
  const result=apply(nativePost,this,args);
  posts.push(clone(args[0]));return result;
 };
 window.pairedNativeGate={
  release(){if(!target||!held)throw Error("Missing/unexpected native receive-start hold");held=false;MessagePort.prototype.start=nativeStart;apply(nativeStart,target,[]);},
  report(){return{held,heldStarts,posts:clone(posts)};}
 };
})();`;

export type PairedHostReport = {
  hostWires: string[];
  hostPosts: Array<{ kind: string; text?: string; sequence?: number }>;
  ready: number;
  retired: number;
  peers: number;
  attached: boolean;
};
export type PairedDocumentReport = {
  received: string[];
  callbackRetired: boolean;
  held: boolean;
  heldStarts: number;
  posts: Array<{ kind: string; text?: string; sequence?: number }>;
};
export async function pairedBrowser(): Promise<Browser> {
  const executablePath =
    process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || chromium.executablePath();
  assert.ok(
    existsSync(executablePath),
    "Actual Chromium is required; no skip/download.",
  );
  return chromium.launch({ headless: true, executablePath });
}
export async function hostReport(page: Page): Promise<PairedHostReport> {
  return page.evaluate(() => Reflect.get(window, "pairedHost").report());
}
export async function documentReport(
  frame: Frame,
): Promise<PairedDocumentReport> {
  return frame.evaluate(() => ({
    ...Reflect.get(window, "pairedAuthor").report(),
    ...Reflect.get(window, "pairedNativeGate").report(),
  }));
}
export async function withPairedDocument(
  browser: Browser,
  options: { holdHost?: boolean; holdDocument?: boolean },
  work: (page: Page, frame: Frame) => Promise<void>,
) {
  const proof = randomUUID();
  const resource = await createCognitiveDocumentBootstrap(author, proof);
  const wrapperBytes = new Uint8Array(resource.bytes);
  assert.deepEqual(resource.authorBytes, new TextEncoder().encode(author));
  assert.equal(
    resource.authorSha256,
    createHash("sha256").update(new TextEncoder().encode(author)).digest("hex"),
  );
  const wrapperHash = createHash("sha256").update(wrapperBytes).digest("hex");
  const script =
    productionHostCode +
    "\n" +
    parentCode
      .replace(
        "__PROTOCOL__",
        JSON.stringify(cognitiveDocumentBootstrapProtocol),
      )
      .replace("__PROOF__", JSON.stringify(proof))
      .replace("__HOLD_HOST__", JSON.stringify(options.holdHost ?? false));
  let servedWrapper = 0;
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Content-Security-Policy", appContentSecurityPolicy);
      response.end(
        '<!doctype html><html><body><script src="/paired-parent.js"></script></body></html>',
      );
    } else if (request.url === "/paired-parent.js") {
      response.setHeader("Content-Type", "text/javascript; charset=utf-8");
      response.end(script);
    } else if (request.url === "/paired-wrapper") {
      servedWrapper++;
      assert.equal(
        createHash("sha256").update(wrapperBytes).digest("hex"),
        wrapperHash,
      );
      response.setHeader("Content-Type", resource.mime);
      response.setHeader("Content-Length", String(wrapperBytes.byteLength));
      response.setHeader(
        "Content-Security-Policy",
        resource.contentSecurityPolicy,
      );
      response.setHeader("Permissions-Policy", resource.permissionsPolicy);
      response.end(wrapperBytes);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const context = await browser.newContext();
  await context.addInitScript(
    documentGate.replace(
      "__HOLD_DOC__",
      JSON.stringify(options.holdDocument ?? false),
    ),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const actualWrapper = page.waitForResponse((response) =>
    response.url().endsWith("/paired-wrapper"),
  );
  try {
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const response = await actualWrapper;
    assert.equal(response.status(), 200);
    assert.deepEqual(
      new Uint8Array(await response.body()),
      wrapperBytes,
      "The actually loaded fixed wrapper bytes were not mutated by the fixture.",
    );
    assert.equal(
      response.headers()["content-security-policy"],
      resource.contentSecurityPolicy,
    );
    await page.waitForFunction(
      () => Reflect.get(window, "pairedHost")?.report().peers === 1,
    );
    const frame = page
      .frames()
      .find((candidate) => candidate.url() === "about:srcdoc");
    assert.ok(frame);
    await frame.waitForFunction(
      () =>
        document.readyState === "complete" &&
        !!Reflect.get(window, "pairedAuthor") &&
        !!Reflect.get(window, "pairedNativeGate"),
    );
    await work(page, frame);
    assert.equal(servedWrapper, 1);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
