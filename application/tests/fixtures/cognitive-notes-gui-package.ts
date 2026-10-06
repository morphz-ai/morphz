/** Independent author release, installed and built from tarballs outside the
 * repository. Service/GUI proofs here are not production Host authorization. */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { buildSync } from "esbuild";
import { chromium } from "@playwright/test";
import type { CognitiveAppDefinition } from "../../packages/cognitive-app-sdk/src/index.js";
import { appContentSecurityPolicy } from "../../packages/core/src/resource-policy.js";
import {
  cognitiveDocumentBootstrapProtocol,
  createCognitiveDocumentBootstrap,
} from "../../packages/application/src/cognitive-document-bootstrap.js";
import {
  packCognitiveAuthor,
  stopPackedAuthor,
} from "./cognitive-app-packed-author.js";

const source = fileURLToPath(
  new URL("../../examples/cognitive-notes/", import.meta.url),
);
export function packCognitiveNotesGui() {
  const packed = packCognitiveAuthor();
  const cli = process.env.npm_execpath;
  assert.ok(cli, "The formal npm entry supplies its actual CLI");
  const environment: NodeJS.ProcessEnv = { NODE_NO_WARNINGS: "1" };
  for (const name of ["PATH", "HOME", "TMPDIR", "SYSTEMROOT"])
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  const npm = (cwd: string, args: string[]) =>
    execFileSync(process.execPath, [cli, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...environment,
        npm_config_offline: "true",
        npm_config_cache: join(homedir(), ".npm"),
        npm_config_userconfig: join(packed.directory, "npm-user.cfg"),
        npm_config_globalconfig: join(packed.directory, "npm-global.cfg"),
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
      },
    });
  try {
    for (const file of ["build-gui.mjs", "gui"])
      cpSync(join(source, file), join(packed.root, file), { recursive: true });
    // npm's local test installation rewrote its dependency to a file tarball.
    // The distributed author package retains the real public 0.3.0 contract.
    writeFileSync(
      join(packed.root, "package.json"),
      readFileSync(join(source, "package.json")),
    );
    const release: { filename: string; files: { path: string }[] }[] =
      JSON.parse(
        npm(packed.root, [
          "pack",
          "--offline",
          "--json",
          "--silent",
          "--ignore-scripts",
        ]),
      );
    assert.equal(release.length, 1);
    const consumer = join(packed.directory, "independent-consumer");
    mkdirSync(consumer);
    execFileSync("tar", [
      "-xzf",
      join(packed.root, release[0]!.filename),
      "--strip-components=1",
      "-C",
      consumer,
    ]);
    npm(consumer, [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(packed.directory, "sdk", "morphz-cognitive-app-sdk-0.3.0.tgz"),
    ]);
    return {
      ...packed,
      root: consumer,
      sourcePackage: packed.root,
      files: release[0]!.files.map((item) => item.path),
      npm,
      environment,
      build: () => npm(consumer, ["run", "build:gui"]),
      packBuilt: () => {
        writeFileSync(
          join(consumer, "package.json"),
          readFileSync(join(source, "package.json")),
        );
        return JSON.parse(
          npm(consumer, [
            "pack",
            "--offline",
            "--json",
            "--silent",
            "--ignore-scripts",
          ]),
        ) as { filename: string; files: { path: string }[] }[];
      },
      checkGuiTypes: () =>
        execFileSync(
          process.execPath,
          [
            join(packed.directory, "sdk/node_modules/typescript/bin/tsc"),
            "--noEmit",
            "--strict",
            "--target",
            "es2023",
            "--module",
            "NodeNext",
            "--moduleResolution",
            "NodeNext",
            "--lib",
            "es2023,dom,dom.iterable",
            "--skipLibCheck",
            "gui/index.ts",
          ],
          {
            cwd: consumer,
            encoding: "utf8",
            timeout: 60_000,
            env: environment,
          },
        ),
    };
  } catch (error) {
    packed.close();
    throw error;
  }
}

export async function startNotesGuiAuthor(
  root: string,
  database: string,
  config: string,
  gui: boolean,
) {
  const environment: NodeJS.ProcessEnv = { NODE_NO_WARNINGS: "1" };
  for (const name of ["PATH", "HOME", "TMPDIR", "SYSTEMROOT"])
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  const child = spawn(
    process.execPath,
    [
      join(root, "service.mjs"),
      "--db",
      database,
      "--config",
      config,
      "--port",
      "0",
      ...(gui ? ["--gui"] : []),
    ],
    { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    const ready = await new Promise<{
      port: number;
      serviceId: string;
      dataAuthorityId: string;
      definition: { appId: string; version: string; definitionHash: string };
    }>((resolve, reject) => {
      let stdout = "";
      const timer = setTimeout(
        () => reject(new Error("Independent GUI author readiness deadline")),
        10_000,
      );
      child.stdout!.on("data", (bytes: Buffer) => {
        stdout += bytes.toString();
        if (!stdout.includes("\n")) return;
        try {
          const value = JSON.parse(stdout.split("\n")[0]!);
          assert.ok(Number.isSafeInteger(value.port) && value.port > 0);
          clearTimeout(timer);
          resolve(value);
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      });
      child.stderr!.on("data", () => {});
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Independent GUI author exited ${code}`));
      });
    });
    return {
      child,
      ready,
      origin: `http://127.0.0.1:${ready.port}`,
      stop: () => stopPackedAuthor(child),
    };
  } catch (error) {
    await stopPackedAuthor(child);
    throw error;
  }
}

export async function expectNotesGuiStartupRefusal(
  root: string,
  database: string,
  config: string,
) {
  const child: ChildProcess = spawn(
    process.execPath,
    [join(root, "service.mjs"), "--db", database, "--config", config, "--gui"],
    {
      cwd: root,
      env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  child.stdout!.on("data", (bytes) => {
    stdout += String(bytes);
  });
  child.stderr!.on("data", () => {});
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [code, signal] = await once(child, "exit");
    assert.equal(signal, null, "Refusal must exit on its own, not time out");
    assert.equal(code, 1);
    assert.equal(
      stdout,
      "",
      "Refused GUI release must not advertise readiness",
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Real packed author HTML and SDK, actual shared prefix and private native
 * MessageChannel. Only the Host's business DTOs are controlled; not a SQL GUI,
 * approved service connection, production owner or original desktop App. */
export async function openNotesGuiBrowser(
  html: string,
  definition: CognitiveAppDefinition,
) {
  const proof = randomUUID();
  const wrapper = await createCognitiveDocumentBootstrap(html, proof);
  const hostCode = buildSync({
    stdin: {
      contents:
        'export { createCognitiveDocumentPort } from "./apps/web/src/host/cognitive-document-port.ts";',
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "notesActualHostPort",
    write: false,
  }).outputFiles[0]!.text;
  const literal = (value: unknown) =>
    JSON.stringify(value).replaceAll("<", "\\u003c");
  const context = {
    definition,
    authority: {
      appId: definition.id,
      version: definition.version,
      definitionHash: "b".repeat(64),
      instanceId: "controlled_gui_instance",
      serviceId: "controlled_gui_service",
      dataAuthorityId: "controlled_author_data",
    },
    view: {
      id: "controlled_gui_view",
      revision: 1,
      bindingRevision: 1,
      active: true,
      state: {},
    },
    ui: { compose: true },
    theme: { appearance: "light", accent: "cyan" },
    presentation: { mode: "workspace", returnControl: null },
  };
  const hostScript = `${hostCode}
  const frame=document.getElementById('guest');
  const protocol=${literal(cognitiveDocumentBootstrapProtocol)},proof=${literal(proof)};
  let bridge=null,ready=false,claimed=false,context=${literal(context)},channel=crypto.randomUUID();
  const original=${literal({ objectId: "原件/ 😀\n", versionRef: "v:opaque/first" })};
  let write=null;
  const report={requests:[],accepted:[],rejected:[],connects:0,businessWindow:0,writeState:'unknown',readUnavailable:false};
  const send=value=>bridge?.send(JSON.stringify(value));
  const respond=(data,result)=>send({type:'morphz-cognitive-ui/v1:response',channel,requestId:data.requestId,ok:true,result});
  const init=()=>{if(ready)send({type:'morphz-cognitive-ui/v1:init',channel,context});};
  const facts=id=>({commandId:id,operationId:write?.operationId??'notes.create',effect:'write',state:report.writeState,revision:1,projectionState:report.writeState==='committed'?'projected':'none',receiptRef:report.writeState==='committed'?'controlled/receipt':null,receiptHash:report.writeState==='committed'?'${"c".repeat(64)}':null,committedAt:report.writeState==='committed'?'2026-10-06T02:00:00Z':null,objects:report.writeState==='committed'?[{objectId:'created/原件',versionRef:'created:v1',kind:'document',title:write?.parameters.title??'已保存'}]:null,createdAt:'2026-10-06T01:59:00Z',updatedAt:'2026-10-06T02:00:00Z'});
  const commandResult=id=>({kind:'command',commandId:id,command:facts(id),...(report.writeState==='committed'?{result:{objectId:'created/原件',versionRef:'created:v1',title:write?.parameters.title??'已保存',markdown:write?.parameters.markdown??''}}:{hostIssue:'unconfirmed'})});
  window.authorHost={report,original,context:()=>context,theme(){context={...context,theme:{appearance:'dark',accent:'iris'},view:{...context.view,revision:context.view.revision+1}};init();},retire(){bridge?.dispose();}};
  addEventListener('message',event=>{
    const packet=event.data;
    if(packet?.type?.startsWith('morphz-cognitive-ui/v1:'))report.businessWindow++;
    if(packet?.protocol!==protocol)return;
    const observation={origin:event.origin,source:event.source===frame.contentWindow,proof:packet.proof,ports:event.ports.length};
    if(claimed||event.source!==frame.contentWindow||event.origin!==location.origin||packet.proof!==proof||event.ports.length!==1){report.rejected.push(observation);for(const port of event.ports)port.close();return;}
    claimed=true;report.accepted.push(observation);
    bridge=notesActualHostPort.createCognitiveDocumentPort(event.ports[0],{onReady(){ready=true;init();},onRetire(){},onWire(text){
      const data=JSON.parse(text);
      if(data.type==='morphz-cognitive-ui/v1:connect'){report.connects++;init();return;}
      if(data.type!=='morphz-cognitive-ui/v1:request'||data.channel!==channel)return;
      report.requests.push(data.request);
      const request=data.request;
      if(request.method==='ready')respond(data,context);
      else if(request.method==='invoke'&&request.commandId===null)respond(data,{protocol:'morphz-domain/v1',authority:context.authority,operationId:request.operationId,result:request.parameters.afterObjectId?{objects:[{objectId:'second',versionRef:'second:v1',title:'第二份笔记'}]}:{objects:[{...original,title:'受控原文'}],nextAfterObjectId:'cursor/second'}});
      else if(request.method==='invoke'){write=request;respond(data,commandResult(request.commandId));}
      else if(request.method==='readObject'){if(report.readUnavailable)send({type:'morphz-cognitive-ui/v1:response',channel,requestId:data.requestId,ok:false,error:{code:'unavailable'}});else respond(data,{protocol:'morphz-domain/v1',authority:context.authority,object:request.object,kind:'document',title:'受控原文',content:{format:'json',value:{title:'受控原文',markdown:${literal('原文第一行\n<img src=x onerror="globalThis.authorInjected=true">')}}}});}
      else if(request.method==='commandStatus')respond(data,facts(request.commandId));
      else if(request.method==='recoverReceipt')respond(data,commandResult(request.commandId));
      else if(request.method==='openObject')respond(data,{opened:true,object:request.object});
      else if(request.method==='compose')respond(data,{prepared:true});
      else if(request.method==='saveState'){context={...context,view:{...context.view,revision:request.expectedRevision+1,state:request.state}};respond(data,{revision:context.view.revision,state:request.state});}
    }});
  });`;
  try {
    new Script(hostScript);
  } catch (error) {
    console.error(
      "Controlled Host script parse witness",
      error instanceof Error ? error.message : "unknown",
    );
    throw error;
  }
  const parent =
    '<!doctype html><style>body{margin:0}iframe{width:100vw;height:100vh;border:0}</style><iframe id="guest" src="/guest"></iframe><script src="/host.js"></script>';
  // The ephemeral server carries test bytes only; no author credentials,
  // original application profile, runtime or domain database are used.
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.setHeader("Content-Type", "text/html;charset=utf-8");
      response.setHeader("Content-Security-Policy", appContentSecurityPolicy);
      response.end(parent);
    } else if (request.url === "/guest") {
      response.setHeader("Content-Type", wrapper.mime);
      response.setHeader(
        "Content-Security-Policy",
        wrapper.contentSecurityPolicy,
      );
      response.setHeader("Permissions-Policy", wrapper.permissionsPolicy);
      response.end(wrapper.bytes);
    } else if (request.url === "/host.js") {
      response.setHeader("Content-Type", "text/javascript;charset=utf-8");
      response.end(hostScript);
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch({
    executablePath: process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || undefined,
    headless: true,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 960, height: 640 },
    });
    const errors: string[] = [],
      requests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => requests.push(request.url()));
    await page.goto(`http://127.0.0.1:${address.port}/`);
    try {
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLIFrameElement>("#guest")?.contentWindow
            ?.length === 1,
      );
    } catch (error) {
      console.error("Controlled author GUI carrier witness", {
        errors,
        requests,
        frames: page.frames().map((frame) => frame.url()),
      });
      throw error;
    }
    const carrier = page
      .frames()
      .find((frame) => frame.parentFrame() === page.mainFrame())!;
    const guest = carrier.childFrames()[0]!;
    try {
      await guest.waitForFunction(
        () =>
          document.getElementById("connection")?.textContent === "工作区已连接",
      );
    } catch (error) {
      console.error("Controlled author GUI connection witness", {
        errors,
        requests,
        host: await page.evaluate(
          () => Reflect.get(window, "authorHost")?.report,
        ),
        author: await guest.evaluate(() => ({
          text: document.body?.textContent?.slice(0, 1000),
          facade: typeof Reflect.get(window, "__morphzCognitiveDocument"),
          origin: location.origin,
        })),
      });
      await page.screenshot({
        path: "/tmp/morphz-notes-gui-connection-FAILED-oct06.png",
      });
      throw error;
    }
    return {
      browser,
      page,
      guest,
      errors,
      requests,
      async close() {
        await browser.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  } catch (error) {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
}
