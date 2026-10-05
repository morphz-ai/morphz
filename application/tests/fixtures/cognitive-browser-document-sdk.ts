import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import {
  chromium,
  type Browser,
  type Page,
  type Frame,
} from "@playwright/test";
import {
  createCognitiveDocumentBootstrap,
  cognitiveDocumentBootstrapProtocol,
} from "../../packages/application/src/cognitive-document-bootstrap.js";
import { appContentSecurityPolicy } from "../../packages/core/src/resource-policy.js";

const authorSource = String.raw`
import {connectMorphz} from '@morphz/cognitive-app-sdk/browser';
let client; const outcomes={}, notifications=[],timers=new Set();
const timerSet=window.setTimeout.bind(window),timerClear=window.clearTimeout.bind(window);
window.setTimeout=(callback,delay,...args)=>{let id=timerSet(()=>{timers.delete(id);callback(...args);},delay);timers.add(id);return id;};
window.clearTimeout=(id)=>{timers.delete(id);timerClear(id);};
const handle=(key,promise)=>Promise.resolve(promise).then(value=>outcomes[key]={ok:true,value},error=>outcomes[key]={ok:false,code:error.code,commandId:error.commandId});
window.sdkFixture={outcomes,notifications,
 timerCount(){return timers.size;},
 run(key,method,args){try{handle(key,method==='ready'?client.ready():method==='commandStatus'||method==='recoverReceipt'?client[method](args):client[method](args));}catch(error){handle(key,Promise.reject(error));}},
 context(){return client.context;},
 inspect(){return {frozen:Object.isFrozen(client)&&Object.isFrozen(client.context)&&Object.isFrozen(client.context.authority),origin:location.origin,keys:Object.keys(client),context:client.context};},
 shared(){return connectMorphz().then(next=>next===client);},
 reconnect(key){handle(key,connectMorphz());},
 dispose(){client.dispose();},
 observe(callback){return client.onContextChange(callback);},
 removeOriginal(){const root=document.documentElement,doctype=document.doctype;root.remove();doctype.remove();document.append(doctype,root);},
 rewrite(){document.open();document.write('<!doctype html><main>Replacement author document</main>');document.close();},
 reorderBody(){const node=document.getElementById('original');node.remove();document.body.append(node);},
 poisonParse(){const original=JSON.parse;JSON.parse=function(text,...args){const value=Reflect.apply(original,JSON,[text,...args]);if(value?.type==='morphz-cognitive-ui/v1:response'){JSON.parse=original;notifications.push('parse-rewrite');window.sdkFixture.removeOriginal();}return value;};},
 poisonFreeze(){const original=Object.freeze;Object.freeze=function(value){if(value?.protocol==='morphz-domain/v1'&&value?.operationId==='notes.read'){Object.freeze=original;notifications.push('freeze-rewrite');window.sdkFixture.removeOriginal();}return original(value);};},
 poisonClear(){const original=window.clearTimeout;window.clearTimeout=(id)=>{window.clearTimeout=original;original(id);notifications.push('timer-clear-rewrite');window.sdkFixture.removeOriginal();notifications.push(window.sdkFixture.contextError());};},
 poisonClearExpiry(){const original=window.clearTimeout;window.clearTimeout=(id)=>{window.clearTimeout=original;original(id);notifications.push('timer-clear-expiry');window.sdkFixture.virtualExpiry();};},
 poisonClearThrow(){const original=window.clearTimeout;window.clearTimeout=(id)=>{window.clearTimeout=original;original(id);notifications.push('actual-native-clear-throw');throw Error('private-author-cleanup-error');};},
 poisonRequestSnapshot(){const original=TextDecoder.prototype.decode;TextDecoder.prototype.decode=function(...args){const text=Reflect.apply(original,this,args);if(text.includes('notes.read')){TextDecoder.prototype.decode=original;notifications.push('snapshot-rewrite');window.sdkFixture.removeOriginal();}return text;};},
 poisonUUID(){const original=crypto.randomUUID.bind(crypto);Object.defineProperty(crypto,'randomUUID',{configurable:true,value:()=>{const id=original();notifications.push('actual-native-uuid');window.sdkFixture.removeOriginal();notifications.push(window.sdkFixture.contextError());return id;}});},
 reenterUUID(){const original=crypto.randomUUID.bind(crypto);Object.defineProperty(crypto,'randomUUID',{configurable:true,value:()=>{Object.defineProperty(crypto,'randomUUID',{configurable:true,value:original});const id=original();notifications.push('actual-native-uuid-reentry');window.sdkFixture.run('nested','ready');return id;}});},
 poisonTimer(){const original=window.setTimeout;window.setTimeout=(...args)=>{const id=Reflect.apply(original,window,args);notifications.push('actual-native-timer');window.sdkFixture.removeOriginal();notifications.push(window.sdkFixture.contextError());return id;};},
 observeRewrite(){client.onContextChange(()=>{notifications.push('first');window.sdkFixture.removeOriginal();});client.onContextChange(()=>notifications.push('second'));},
 observeThrow(){client.onContextChange(()=>{notifications.push('first');throw Error('private-author-error');});client.onContextChange(()=>notifications.push('second'));},
 observeMark(){client.onContextChange(()=>notifications.push('context-credit-barrier'));},
 directBurst(count){for(let i=0;i<count;i++)window.sdkFixture.run('burst'+i,'ready');},
 burstFollow(){for(let i=0;i<16;i++){const promise=client.ready();handle('burst'+i,promise);if(i===0)promise.then(()=>handle('follow',client.invoke({operationId:'notes.write',parameters:'unsent',resources:[],commandId:'native-busy-original'})));}},
 accessor(){let reads=0;const input={operationId:'notes.read',parameters:null,resources:[],commandId:null};Object.defineProperty(input,'parameters',{enumerable:true,get(){reads++;window.sdkFixture.removeOriginal();return null;}});handle('accessor',client.invoke(input));return reads;},
 contextError(){try{client.context;return 'visible';}catch(error){return error.code;}},
 observeError(){try{client.onContextChange(()=>{});return 'subscribed';}catch(error){return error.code;}},
 virtualExpiry(){const original=performance.now.bind(performance);Object.defineProperty(performance,'now',{configurable:true,value:()=>original()+30000});},
 resetClock(){delete performance.now;}
};
handle('connect',connectMorphz().then(next=>{client=next;return next.context;}));
`;

function contextValue(sha256: string) {
  return {
    definition: {
      format: "morphz-cognitive-app/v1",
      protocol: "morphz-domain/v1",
      id: "example.notes",
      version: "1.0.0",
      title: "Notes",
      description: "Fixture author data",
      icon: "document",
      harness: null,
      ui: { packageVersion: "1.0.0", sha256 },
      operations: [
        {
          id: "notes.read",
          title: "Read",
          description: "Read",
          effect: "read",
          scope: "project",
          inputSchema: { type: "null" },
          outputSchema: { type: "string" },
        },
        {
          id: "notes.write",
          title: "Write",
          description: "Write",
          effect: "write",
          scope: "project",
          inputSchema: { type: "string" },
          outputSchema: { type: "string" },
        },
      ],
    },
    authority: {
      appId: "example.notes",
      version: "1.0.0",
      definitionHash: "b".repeat(64),
      instanceId: "fixture-instance",
      serviceId: "fixture-service",
      dataAuthorityId: "fixture-author-data",
    },
    view: {
      id: "fixture-view",
      revision: 1,
      bindingRevision: 1,
      active: true,
      state: {},
    },
    ui: { compose: true },
    theme: { appearance: "dark", accent: "iris" },
    presentation: { mode: "workspace", returnControl: null },
  };
}

/** Actual packed public SDK in an external offline author project, esbuild
 * self-contained browser HTML, real Chromium/MessageChannel/shared prefix.
 * Host channel and port are actual leaves; business authorization/results are
 * controlled, never SQL, a production consumer, native App or real business. */
export async function openDocumentSdkFixture() {
  const directory = mkdtempSync(join(tmpdir(), "morphz-document-sdk-"));
  let browser: Browser | undefined,
    server: ReturnType<typeof createServer> | undefined;
  const close = async () => {
    await browser?.close();
    if (server)
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    const author = join(directory, "author"),
      consumer = join(directory, "consumer");
    mkdirSync(join(author, "src"), { recursive: true });
    mkdirSync(consumer);
    const packageRoot = fileURLToPath(
      new URL("../../packages/cognitive-app-sdk/", import.meta.url),
    );
    for (const path of [
      "package.json",
      "tsconfig.build.json",
      "README.md",
      "LICENSE",
      ...["index", "protocol", "domain-wire", "browser", "browser-wire"].map(
        (name) => `src/${name}.ts`,
      ),
    ])
      copyFileSync(join(packageRoot, path), join(author, path));
    const userConfig = join(directory, "empty-user.npmrc"),
      globalConfig = join(directory, "empty-global.npmrc");
    writeFileSync(userConfig, "");
    writeFileSync(globalConfig, "");
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "SYSTEMROOT"])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    Object.assign(env, {
      npm_config_cache: join(homedir(), ".npm"),
      npm_config_userconfig: userConfig,
      npm_config_globalconfig: globalConfig,
      npm_config_offline: "true",
      npm_config_registry: "https://registry.npmjs.org/",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    });
    const execute = promisify(execFile);
    const npm = (args: string[], cwd: string) =>
      execute("npm", args, {
        cwd,
        env,
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      });
    const install = [
      "install",
      "--offline",
      "--ignore-scripts",
      "--package-lock=false",
      "--no-audit",
      "--no-fund",
    ];
    await npm(install, author);
    const packed = JSON.parse(
      (await npm(["pack", "--offline", "--json", "--silent"], author)).stdout,
    ) as Array<{ filename: string; integrity: string }>;
    assert.equal(packed.length, 1);
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({
        name: "isolated-document-sdk",
        private: true,
        type: "module",
      }),
    );
    await npm([...install, join(author, packed[0]!.filename)], consumer);
    const built = await build({
      stdin: {
        contents: authorSource,
        resolveDir: consumer,
        sourcefile: "author.ts",
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      target: "es2022",
      minify: true,
    });
    const code = built.outputFiles![0]!.text;
    assert.doesNotMatch(
      code,
      /\bimport\s|node:|PlatformStore|CognitiveAppTransport/,
    );
    const proof = randomUUID().replaceAll("-", "");
    const wrapper = await createCognitiveDocumentBootstrap(
      `<!doctype html><html><head><meta charset="utf-8"><script>${code}</script></head><body><main id="original">Actual author SDK</main></body></html>`,
      proof,
    );
    const initial = contextValue(wrapper.authorSha256);
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const hostSource = `
import {createCognitiveDocumentPort} from './apps/web/src/host/cognitive-document-port.ts';
import {createCognitiveBrowserChannel} from './apps/web/src/host/cognitive-browser-channel.ts';
const wrapper=document.getElementById('wrapper'), proof=${JSON.stringify(proof)}, protocol=${JSON.stringify(cognitiveDocumentBootstrapProtocol)};
let current=true, hold=false, early=false, context=${JSON.stringify(initial)}, bridge=null, channel=null;
const initHeld=new URL(location.href).searchParams.has('holdInit');
const waiting=[],report={peers:0,ready:0,connects:0,businessWindow:0,wires:[],requests:[],sent:[],retired:0,cancelled:0};
const facts=(request)=>({commandId:request.commandId,operationId:'notes.write',effect:'write',state:'unknown',revision:1,projectionState:'none',receiptRef:null,receiptHash:null,committedAt:null,objects:null,createdAt:'2026-10-05T10:00:00Z',updatedAt:'2026-10-05T10:00:00Z'});
const response=(request)=>{
 if(request.method==='ready')return context;
 if(request.method==='compose')return {prepared:true};
 if(request.method==='saveState')return {revision:request.expectedRevision+1,state:request.state};
 if(request.method==='openObject')return {opened:true,object:request.object};
 if(request.method==='readObject')return {protocol:'morphz-domain/v1',authority:context.authority,object:request.object,kind:'document',title:'Actual author object',content:{format:'text',text:'Original object'}};
 if(request.method==='commandStatus')return facts(request);
 if(request.method==='invoke'&&request.commandId===null)return {protocol:'morphz-domain/v1',authority:context.authority,operationId:request.operationId,result:'PRIVATE-FIXTURE-RESULT'};
 return {kind:'command',commandId:request.commandId,command:facts(request)};
};
addEventListener('message',event=>{
 if(event.data?.type?.startsWith('morphz-cognitive-ui/')){report.businessWindow++;return;}
 if(event.source!==wrapper.contentWindow||event.origin!==location.origin||event.data?.protocol!==protocol||event.data?.proof!==proof||event.ports.length!==1||report.peers){for(const port of event.ports)port.close();return;}
 report.peers++;
 const frame={postMessage(message){report.sent.push(message);bridge.send(JSON.stringify(message));}};
 channel=createCognitiveBrowserChannel(context,{frame,current:()=>current,authorize:async()=>{if(initHeld)await new Promise(()=>{});},request(request,_context,signal){report.requests.push(request);if(!hold)return Promise.resolve(response(request));return new Promise(resolve=>{signal.addEventListener('abort',()=>report.cancelled++,{once:true});waiting.push(()=>resolve(response(request)));});}});
 bridge=createCognitiveDocumentPort(event.ports[0],{onReady(){report.ready++;void channel.loaded();},onWire(text){const data=JSON.parse(text);report.wires.push(data);if(data.type==='morphz-cognitive-ui/v1:connect')report.connects++;if(early&&data.type==='morphz-cognitive-ui/v1:request')frame.postMessage({type:'morphz-cognitive-ui/v1:response',channel:data.channel,requestId:data.requestId,ok:true,result:response(data.request)});void channel.receive({source:frame,origin:'null',data});},onRetire(){report.retired++;channel.retire();}});
});
window.sdkHost={report,hold(value=true){hold=value;},early(value=true){early=value;},release(){hold=false;for(const work of waiting.splice(0))work();},update(){context={...context,theme:{appearance:'light',accent:'coral'}};void channel.updateContext(context);},retire(){current=false;channel.retire();},send(message){bridge.send(JSON.stringify(message));},channel:()=>report.sent.find(message=>message.type==='morphz-cognitive-ui/v1:init')?.channel};
wrapper.src='/document';
`;
    const host = await build({
      stdin: {
        contents: hostSource,
        resolveDir: root,
        sourcefile: "controlled-host.ts",
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      target: "es2022",
      minify: true,
    });
    const requests: string[] = [];
    server = createServer((request, response) => {
      requests.push(request.url!);
      if (request.url === "/" || request.url === "/?holdInit") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Content-Security-Policy", appContentSecurityPolicy);
        response.end(
          '<!doctype html><iframe id="wrapper"></iframe><script src="/host.js"></script>',
        );
      } else if (request.url === "/document") {
        response.setHeader("Content-Type", wrapper.mime);
        response.setHeader(
          "Content-Security-Policy",
          wrapper.contentSecurityPolicy,
        );
        response.setHeader("Permissions-Policy", wrapper.permissionsPolicy);
        response.end(wrapper.bytes);
      } else if (request.url === "/host.js") {
        response.setHeader("Content-Type", "text/javascript");
        response.end(host.outputFiles![0]!.text);
      } else if (request.url === "/unsupported") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Content-Security-Policy", appContentSecurityPolicy);
        response.end('<!doctype html><script src="/author.js"></script>');
      } else if (request.url === "/author.js") {
        response.setHeader("Content-Type", "text/javascript");
        response.end(code);
      } else {
        response.statusCode = 404;
        response.end();
      }
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const executable =
      process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || chromium.executablePath();
    assert.ok(
      existsSync(executable),
      "Actual installed browser required; no skip/download.",
    );
    browser = await chromium.launch({
      headless: true,
      executablePath: executable,
    });
    return {
      close,
      requests,
      integrity: packed[0]!.integrity,
      async unsupported() {
        const page = await browser!.newPage();
        page.setDefaultTimeout(4000);
        await page.addInitScript(() => {
          Reflect.set(window, "windowPosts", 0);
          window.postMessage = () => {
            Reflect.set(
              window,
              "windowPosts",
              Reflect.get(window, "windowPosts") + 1,
            );
          };
        });
        await page.goto(`http://127.0.0.1:${address.port}/unsupported`);
        await page.waitForFunction(
          () =>
            Reflect.get(window, "sdkFixture")?.outcomes.connect !== undefined,
        );
        return page;
      },
      async page(holdInit = false): Promise<{ page: Page; guest: Frame }> {
        const page = await browser!.newPage();
        page.setDefaultTimeout(4000);
        const diagnostics: string[] = [];
        page.on("pageerror", (error) => diagnostics.push(error.message));
        page.on("console", (message) => diagnostics.push(message.text()));
        await page.goto(
          `http://127.0.0.1:${address.port}/${holdInit ? "?holdInit" : ""}`,
        );
        try {
          await page.waitForFunction(
            () => Reflect.get(window, "sdkHost")?.report.connects === 1,
          );
        } catch (error) {
          console.error(
            "SDK fixture connection diagnostics",
            diagnostics,
            await page.evaluate(() => Reflect.get(window, "sdkHost")?.report),
          );
          throw error;
        }
        const guest = page
          .frames()
          .find((frame) => frame.url() === "about:srcdoc");
        assert.ok(guest);
        if (!holdInit)
          await guest.waitForFunction(
            () =>
              Reflect.get(window, "sdkFixture")?.outcomes.connect?.ok === true,
          );
        return { page, guest };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
