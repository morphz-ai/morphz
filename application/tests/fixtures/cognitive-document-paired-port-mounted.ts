import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { buildSync } from "esbuild";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Frame,
  type Page,
} from "@playwright/test";
import {
  createCognitiveDocumentBootstrap,
  cognitiveDocumentBootstrapProtocol,
  type CognitiveDocumentBootstrap,
} from "../../packages/application/src/cognitive-document-bootstrap.js";
import { appContentSecurityPolicy } from "../../packages/core/src/resource-policy.js";
import { documentBootstrapFrame } from "./cognitive-document-bootstrap-mounted.js";

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
 const hostWires=[],hostPosts=[],hostFrames=[];let peer=null,bridge=null,ready=0,retired=0,peers=0;
 const wrapper=document.createElement("iframe");wrapper.id="paired-wrapper";wrapper.src="/paired-wrapper";
 function attach(){
  if(!peer||bridge)throw Error("Missing/unexpected actual native peer");
  // Transparent receipt observation on the original transferred peer. Do not
  // start, block, replace or forward its native delivery; the production helper
  // below alone starts this endpoint and generates its actual credits.
  peer.addEventListener("message",event=>hostFrames.push(structuredClone(event.data)));
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
  report(){return{hostWires:[...hostWires],hostPosts:structuredClone(hostPosts),hostFrames:structuredClone(hostFrames),ready,retired,peers,attached:bridge!==null};}
 };
 document.body.append(wrapper);
})();`;

export type NativePacket = {
  kind: string;
  text?: string;
  sequence?: number;
};
export type PairedHostReport = {
  hostWires: string[];
  hostPosts: NativePacket[];
  hostFrames: NativePacket[];
  ready: number;
  retired: number;
  peers: number;
  attached: boolean;
};
export type PairedDocumentReport = {
  received: string[];
  callbackRetired: boolean;
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
  return frame.evaluate(() => Reflect.get(window, "pairedAuthor").report());
}
type PairedWork = (page: Page, frame: Frame) => Promise<void>;

/** Production fixed-wrapper end-to-end path. There is no pre-script injection,
 * wrapper rewrite, native child hook or synthetic transport acknowledgement. */
export async function withPairedDocument(
  browser: Browser,
  options: { holdHost?: boolean },
  work: PairedWork,
) {
  return mountPairedDocument(browser, options, work);
}

/** Explicit separate test boundary. Only the CONTROLLED prefix fixture may
 * supply a rewritten resource; this does not claim unmodified-wrapper E2E. */
export async function withControlledPairedResource(
  browser: Browser,
  options: { holdHost?: boolean },
  rewrite: (original: CognitiveDocumentBootstrap) => Uint8Array,
  work: PairedWork,
) {
  return mountPairedDocument(browser, options, work, rewrite);
}

async function mountPairedDocument(
  browser: Browser,
  options: { holdHost?: boolean },
  work: PairedWork,
  rewrite?: (original: CognitiveDocumentBootstrap) => Uint8Array,
) {
  const proof = randomUUID();
  const resource = await createCognitiveDocumentBootstrap(author, proof);
  const originalWrapperBytes = new Uint8Array(resource.bytes);
  const wrapperBytes = rewrite ? rewrite(resource) : originalWrapperBytes;
  assert.equal(
    Buffer.from(wrapperBytes).equals(Buffer.from(originalWrapperBytes)),
    !rewrite,
    "Only the explicitly CONTROLLED prefix harness may alter wrapper bytes.",
  );
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
  let context: BrowserContext | undefined;
  const failures: unknown[] = [];
  try {
    context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const actualWrapper = page.waitForResponse((response) =>
      response.url().endsWith("/paired-wrapper"),
    );
    // Retain the original wait for the assertion below while preventing an
    // unrelated navigation failure from producing an unhandled rejection.
    void actualWrapper.catch(() => {});
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const response = await actualWrapper;
    assert.equal(response.status(), 200);
    assert.deepEqual(
      new Uint8Array(await response.body()),
      wrapperBytes,
      rewrite
        ? "The CONTROLLED resource loaded exactly the explicitly composed test bytes."
        : "The actually loaded fixed wrapper bytes were not mutated by the fixture.",
    );
    assert.equal(
      response.headers()["permissions-policy"],
      resource.permissionsPolicy,
    );
    assert.equal(
      response.headers()["content-security-policy"],
      resource.contentSecurityPolicy,
    );
    await page.waitForFunction(
      () => Reflect.get(window, "pairedHost")?.report().peers === 1,
    );
    const frame = await documentBootstrapFrame(page, { wrapper: "paired" });
    await frame.waitForFunction(
      () =>
        document.readyState === "complete" &&
        !!Reflect.get(window, "pairedAuthor"),
    );
    await work(page, frame);
    assert.equal(servedWrapper, 1);
    assert.deepEqual(errors, []);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await context?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Paired assertions and cleanup failed.");
}
