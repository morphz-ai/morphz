import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { build } from "esbuild";
import {
  chromium,
  type Browser,
  type Frame,
  type Page,
} from "@playwright/test";
import { appContentSecurityPolicy } from "../../packages/core/src/resource-policy.js";
import { cognitiveDocumentBootstrapProtocol } from "../../packages/application/src/cognitive-document-bootstrap.js";
import { packCognitiveAuthor } from "./cognitive-app-packed-author.js";
import { withViewTransport } from "./cognitive-app-view-transport-fixture.js";

type Transport = Parameters<Parameters<typeof withViewTransport>[1]>[0];
export type ConsumerFixtureOptions = {
  holdPeer?: boolean;
  holdAuthorize?: boolean;
  rejectAuthorize?: boolean;
  count?: number;
  initiallyCurrent?: boolean;
  suppressOuterLoad?: boolean;
  abortInsideCurrent?: boolean;
};

const author = String.raw`
import {connectMorphz} from '@morphz/cognitive-app-sdk/browser';
let client;const outcomes={},contexts=[];
const settle=(key,promise)=>Promise.resolve(promise).then(value=>outcomes[key]={ok:true,value},error=>outcomes[key]={ok:false,code:error.code,commandId:error.commandId});
window.consumerAuthor={outcomes,contexts,connected:false,
 run(key,method,args){try{settle(key,client[method](args));}catch(error){settle(key,Promise.reject(error));}},
 context(){return client.context;},
 normalDOM(){const p=document.createElement('p');p.textContent='ordinary author update';document.body.append(p);document.body.classList.add('edited');},
 rootCycle(){const root=document.documentElement,doctype=document.doctype;root.remove();doctype.remove();document.append(doctype,root);},
 forge(proof){const channel=new MessageChannel();channel.port1.start();channel.port1.onmessage=event=>outcomes.forged={ok:true,value:event.data};top.postMessage({protocol:'morphz-cognitive-document-bootstrap/v2',proof},'*',[channel.port2]);window.consumerAuthor.forgedSent=true;},
};
top.postMessage({consumerAuthorObservation:{phase:'script',state:document.readyState}},'*');
settle('connect',connectMorphz().then(value=>{client=value;window.consumerAuthor.connected=true;client.onContextChange(context=>contexts.push(context));return true;}));
`;

const host = String.raw`
import {createCognitiveDocumentConsumer} from './apps/web/src/host/cognitive-document-consumer.ts';
const settings=__SETTINGS__,protocol=__PROTOCOL__;
const report={ready:[],retired:0,calls:[],aborts:0,loads:0,observations:[],peers:[],closed:[],held:0};
const held=[],waiting=[],consumers=[],controllers=[],timers=new Set();let current=settings.initiallyCurrent??true,holdAuthorize=settings.holdAuthorize,holdBusiness=false;
const nativeSet=window.setTimeout.bind(window),nativeClear=window.clearTimeout.bind(window);
window.setTimeout=(callback,delay,...args)=>{const timer=nativeSet(()=>{timers.delete(timer);callback(...args);},delay);timers.add(timer);return timer;};
window.clearTimeout=timer=>{timers.delete(timer);nativeClear(timer);};
const nativeClose=MessagePort.prototype.close,portLabels=new WeakMap();
MessagePort.prototype.close=function(){report.closed.push(portLabels.get(this)??'private');return Reflect.apply(nativeClose,this,[]);};
addEventListener('message',event=>{
 if(event.data?.consumerAuthorObservation)report.observations.push(event.data.consumerAuthorObservation);
 const data=event.data;if(data?.protocol!==protocol)return;
 const outer=Array.from(document.querySelectorAll('section>iframe')).find(frame=>frame.contentWindow===event.source);
 const label=outer?'outer':'foreign';for(const port of event.ports)portLabels.set(port,label);
 report.peers.push({origin:event.origin,label,proof:data.proof,ports:event.ports.length});
 if(outer&&settings.holdPeer&&report.held===0){held.push(event);report.held++;event.stopImmediatePropagation();}
},true);
document.addEventListener('load',event=>{if(event.target?.tagName==='IFRAME'){report.loads++;if(settings.suppressOuterLoad)event.stopImmediatePropagation();}},true);
const pause=()=>new Promise(resolve=>waiting.push(resolve));
const call=async(method,parameters,options)=>{
 report.calls.push({method,parameters,aborted:options.signal?.aborted??false,loads:report.loads});
 const id=crypto.randomUUID(),abort=()=>{report.aborts++;window.consumerAbort(id);};
 options.signal?.addEventListener('abort',abort,{once:true});
 try{
  if(method==='cognitive-app-views.read-ui'){
   if(holdAuthorize)await pause();
   if(settings.rejectAuthorize)throw {code:'forbidden'};
   return await window.consumerCall(id,method,parameters);
  }
  if(method==='cognitive-app-views.save')return await window.consumerCall(id,method,parameters);
  if(holdBusiness)await pause();
  return {protocol:'morphz-domain/v1',authority:window.consumerSourceValue.authority,operationId:parameters.operationId,result:'controlled business result'};
 }finally{options.signal?.removeEventListener('abort',abort);}
};
window.consumerHost={report,
 timerCount(){return timers.size;},
 release(){holdAuthorize=false;holdBusiness=false;settings.holdPeer=false;for(const event of held.splice(0))window.dispatchEvent(new MessageEvent('message',{source:event.source,origin:event.origin,data:event.data,ports:event.ports}));for(const resolve of waiting.splice(0))resolve();},
 hold(){holdBusiness=true;},
 ownerGone(){current=false;},
 abort(index=0){controllers[index].abort();},
 retire(index=0){consumers[index].retire();},
 update(input,index=0){return consumers[index].updatePresentation(input);},
 relocate(){document.querySelector('section>iframe').remove();},
 reinsert(){const iframe=document.querySelector('section>iframe'),container=iframe.parentNode,before=iframe.contentWindow;iframe.remove();container.append(iframe);report.reinsertDifferent=before!==iframe.contentWindow;},
 proofs(){return Array.from(document.querySelectorAll('section>iframe')).map(frame=>new URL(frame.src).searchParams.get('documentProof'));},
 virtualExpire(){Object.defineProperty(performance,'now',{configurable:true,value:()=>1e12});},
};
const source=await window.consumerSource();window.consumerSourceValue=source;
for(let index=0;index<(settings.count??1);index++){
 const controller=new AbortController();controllers.push(controller);
 const container=document.createElement('section');document.getElementById('mount').append(container);
 const consumer=createCognitiveDocumentConsumer({source,container,
  routerPorts:{call,openObject:async request=>({opened:true,object:request.object}),compose:async()=>({prepared:true})},
  current:()=>{if(settings.abortInsideCurrent)controller.abort();return current;},signal:controller.signal,
  presentation:{theme:{appearance:'dark',accent:'cyan'},presentation:{mode:'workspace',returnControl:null},active:true},
  onRetire:()=>report.retired++,
 });
 consumers.push(consumer);consumer.ready.then(value=>report.ready[index]=value);
}
window.consumerHost.mounted=true;
`;

/** Actual public tarball, original Managed UI bytes, Identity/HPA, dual SQL,
 * authenticated document GET/CSP, consumer/channel/router and native Chromium
 * ports. Only the trusted root shell is test-served. Author business results
 * are controlled, not real author-service commits or production-App acceptance. */
export async function openDocumentConsumerFixture() {
  const packed = packCognitiveAuthor();
  let browser: Browser | undefined;
  try {
    const bundle = (
      await build({
        stdin: { contents: author, resolveDir: packed.root, loader: "ts" },
        bundle: true,
        platform: "browser",
        format: "iife",
        target: "es2023",
        write: false,
      })
    ).outputFiles[0]!.text;
    assert.doesNotMatch(
      bundle,
      /packages\/application|createCognitiveDocumentPort/,
    );
    const authorHtml = `<!doctype html><html><head><meta charset="utf-8"><script>${bundle.replaceAll("</script", "<\\/script")}</script></head><body><main id="original">实际独立 SDK 作者 😀</main></body></html>`;
    const executable =
      process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || chromium.executablePath();
    assert.ok(
      existsSync(executable),
      "Actual Chromium required; no skip/download.",
    );
    browser = await chromium.launch({
      headless: true,
      executablePath: executable,
    });
    return {
      async close() {
        await browser?.close();
        packed.close();
      },
      async run(
        backend: "sqlite" | "postgres",
        work: (fixture: {
          page: Page;
          guests(): Promise<Frame[]>;
          transport: Transport;
          documentResponses: Array<{
            url: string;
            status: number;
            csp: string;
            permissions: string;
          }>;
          callOutcomes: Array<{ method: string; ok: boolean; code?: string }>;
        }) => Promise<void>,
        settings: ConsumerFixtureOptions = {},
      ) {
        await withViewTransport(
          backend,
          async (transport) => {
            const { receipt } = await transport.local.call(
              "cognitive-app-views.launch",
              transport.launch,
              { identityGeneration: transport.localCsrf },
            );
            const source = await transport.local.call(
              "cognitive-app-views.read-ui",
              {
                viewId: receipt.viewId,
                expectedViewRevision: receipt.viewRevision,
                expectedBindingRevision: receipt.bindingRevision,
              },
              { identityGeneration: transport.localCsrf },
            );
            const code = (
              await build({
                stdin: {
                  contents: host
                    .replace("__SETTINGS__", JSON.stringify(settings))
                    .replace(
                      "__PROTOCOL__",
                      JSON.stringify(cognitiveDocumentBootstrapProtocol),
                    ),
                  resolveDir: new URL("../../", import.meta.url).pathname,
                  loader: "ts",
                },
                bundle: true,
                platform: "browser",
                format: "esm",
                target: "es2023",
                write: false,
              })
            ).outputFiles[0]!.text;
            const context = await browser!.newContext();
            const cookie = transport.cookie()!;
            const at = cookie.indexOf("=");
            await context.addCookies([
              {
                name: cookie.slice(0, at),
                value: cookie.slice(at + 1),
                url: transport.origin,
              },
            ]);
            const page = await context.newPage();
            page.setDefaultTimeout(4000);
            const pending = new Map<string, AbortController>();
            const callOutcomes: Array<{
              method: string;
              ok: boolean;
              code?: string;
            }> = [];
            await page.exposeFunction("consumerSource", () => source);
            await page.exposeFunction("consumerAbort", (id: string) =>
              pending.get(id)?.abort(),
            );
            await page.exposeFunction(
              "consumerCall",
              async (id: string, method: string, parameters: unknown) => {
                assert.ok(
                  method === "cognitive-app-views.read-ui" ||
                    method === "cognitive-app-views.save",
                );
                const controller = new AbortController();
                pending.set(id, controller);
                try {
                  const response = await transport.local.call(
                    method,
                    parameters as never,
                    {
                      signal: controller.signal,
                      identityGeneration: transport.localCsrf,
                    },
                  );
                  callOutcomes.push({ method, ok: true });
                  return response;
                } catch (error) {
                  const code =
                    error && typeof error === "object"
                      ? Object.getOwnPropertyDescriptor(error, "code")?.value
                      : undefined;
                  callOutcomes.push({
                    method,
                    ok: false,
                    ...(typeof code === "string" ? { code } : {}),
                  });
                  console.error(
                    "Controlled Local consumer fixture call failed",
                    method,
                    code,
                  );
                  throw error;
                } finally {
                  pending.delete(id);
                }
              },
            );
            const documentResponses: Array<{
              url: string;
              status: number;
              csp: string;
              permissions: string;
            }> = [];
            page.on("response", (response) => {
              if (
                !new URL(response.url()).pathname.startsWith(
                  "/api/cognitive-app-document/",
                )
              )
                return;
              const headers = response.headers();
              documentResponses.push({
                url: response.url(),
                status: response.status(),
                csp: headers["content-security-policy"]!,
                permissions: headers["permissions-policy"]!,
              });
            });
            // No author wrapper/body or resource response is intercepted. Both
            // actual document bytes and security headers come from the service.
            await page.route(transport.origin + "/", (route) =>
              route.fulfill({
                contentType: "text/html; charset=utf-8",
                headers: {
                  "Content-Security-Policy": appContentSecurityPolicy,
                },
                body: '<!doctype html><div id="mount"></div><script type="module" src="/consumer-host.js"></script>',
              }),
            );
            await page.route(transport.origin + "/consumer-host.js", (route) =>
              route.fulfill({ contentType: "text/javascript", body: code }),
            );
            try {
              await page.goto(transport.origin + "/");
              await page.waitForFunction(
                () => Reflect.get(window, "consumerHost")?.mounted === true,
              );
              await work({
                page,
                transport,
                documentResponses,
                callOutcomes,
                async guests() {
                  await page.waitForFunction(() => {
                    const frames = [
                      ...document.querySelectorAll<HTMLIFrameElement>(
                        "section>iframe",
                      ),
                    ];
                    return (
                      frames.length > 0 &&
                      frames.every((outer) =>
                        outer.contentDocument?.querySelector("iframe"),
                      )
                    );
                  });
                  const guests: Frame[] = [];
                  for (const outer of page.mainFrame().childFrames()) {
                    const guest = outer.childFrames()[0];
                    if (guest) {
                      await guest.waitForFunction(() =>
                        Reflect.get(window, "consumerAuthor"),
                      );
                      guests.push(guest);
                    }
                  }
                  return guests;
                },
              });
            } finally {
              for (const controller of pending.values()) controller.abort();
              await context.close();
            }
          },
          { html: authorHtml },
        );
      },
    };
  } catch (error) {
    await browser?.close();
    packed.close();
    throw error;
  }
}
