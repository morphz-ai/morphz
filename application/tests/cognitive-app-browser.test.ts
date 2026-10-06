import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import { build } from "vite";
import {
  cognitiveBrowserProtocol,
  cognitiveBrowserLimits,
  cognitiveBrowserCommandStates,
  parseBrowserContext,
  parseBrowserRequest,
  parseBrowserResult,
  parseBrowserMessage,
  type BrowserContext,
  type BrowserCommandState,
} from "../packages/cognitive-app-sdk/src/browser-wire.js";
import type { CognitiveAppCommandState } from "../packages/platform/src/cognitive-app-commands.js";
import { parseBrowserNavigationState } from "../packages/cognitive-app-sdk/src/browser.js";
import { createSdkDocumentBrowserFixture } from "./fixtures/cognitive-app-sdk-document-browser.js";

const opaque = { objectId: "原件/ 😀\n", versionRef: "v:opaque/first" };
const contextValue = () => ({
  definition: {
    format: "morphz-cognitive-app/v1",
    protocol: "morphz-domain/v1",
    id: "example.notes",
    version: "1.0.0",
    title: "Notes",
    description: "Author-owned notes",
    icon: "document",
    harness: null,
    ui: { packageVersion: "1.0.0", sha256: "a".repeat(64) },
    operations: [
      {
        id: "notes.read",
        title: "Read",
        description: "Read",
        effect: "read",
        scope: "objects",
        inputSchema: { type: "null" },
        outputSchema: { type: "string" },
      },
      {
        id: "notes.create",
        title: "Create",
        description: "Create",
        effect: "write",
        scope: "project",
        inputSchema: { type: "string", maxLength: 30 },
        outputSchema: { type: "string" },
      },
    ],
  },
  authority: {
    appId: "example.notes",
    version: "1.0.0",
    definitionHash: "b".repeat(64),
    instanceId: "instance",
    serviceId: "author/service",
    dataAuthorityId: "author/original",
  },
  view: {
    id: "view",
    revision: 1,
    bindingRevision: 1,
    active: true,
    state: { object: opaque, view: "editor" },
  },
  ui: { compose: true },
  theme: { appearance: "dark", accent: "iris" },
  presentation: { mode: "workspace", returnControl: null },
});
const facts = () => ({
  commandId: "original_command",
  operationId: "notes.create",
  effect: "write",
  state: "unknown",
  revision: 3,
  projectionState: "none",
  receiptRef: null,
  receiptHash: null,
  committedAt: null,
  objects: null,
  createdAt: "2026-10-05T10:00:00Z",
  updatedAt: "2026-10-05T10:00:01Z",
});

test("public navigation parser alone owns strict opaque navigation and captures independent inputs", () => {
  const original = { object: { ...opaque }, view: "reader" };
  const parsed = parseBrowserNavigationState(original);
  assert.deepEqual(parsed, original);
  original.object.versionRef = "changed after parsing";
  original.view = "changed view";
  assert.equal(parsed.object!.versionRef, opaque.versionRef);
  assert.equal(parsed.view, "reader");
  for (const field of ["body", "draft", "unknown"])
    assert.throws(() =>
      parseBrowserNavigationState({
        object: opaque,
        [field]: "not navigation",
      }),
    );
  assert.throws(() =>
    parseBrowserNavigationState({ object: { ...opaque, versionRef: 1 } }),
  );
  assert.throws(() =>
    parseBrowserNavigationState({
      object: { ...opaque, body: "not reference" },
    }),
  );
  assert.throws(() => parseBrowserNavigationState({ view: "x".repeat(101) }));
});

test("browser DTOs keep actual ledger enums, immutable budgets and exact navigation refs", () => {
  assert.equal(cognitiveBrowserProtocol, "morphz-cognitive-ui/v1");
  assert.deepEqual(cognitiveBrowserLimits, { pending: 16, deadlineMs: 30_000 });
  assert.equal(Object.isFrozen(cognitiveBrowserLimits), true);
  const ledger = readFileSync(
    new URL(
      "../packages/platform/src/cognitive-app-commands.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const declaration = ledger.match(
    /export type CognitiveAppCommandState\s*=([\s\S]*?);/,
  );
  assert.ok(declaration);
  const actualStates = [...declaration[1]!.matchAll(/"([^"]+)"/g)].map(
    (match) => match[1],
  );
  if (actualStates.length)
    assert.deepEqual(
      actualStates.sort(),
      [...cognitiveBrowserCommandStates].sort(),
    );
  else assert.match(declaration[1]!, /BrowserCommandState/);
  const sameActualType: [CognitiveAppCommandState] extends [BrowserCommandState]
    ? [BrowserCommandState] extends [CognitiveAppCommandState]
      ? true
      : never
    : never = true;
  assert.equal(sameActualType, true);
  const context = parseBrowserContext(contextValue());
  assert.deepEqual(context.view.state.object, opaque);
  assert.equal(context.authority.version, "1.0.0");
  for (const field of [
    "actor",
    "credentials",
    "endpoint",
    "draft",
    "hostBindingId",
  ])
    assert.throws(() =>
      parseBrowserContext({ ...contextValue(), [field]: "private" }),
    );
  assert.throws(() =>
    parseBrowserContext({
      ...contextValue(),
      authority: { ...contextValue().authority, version: "2.0.0" },
    }),
  );
});

test("browser invocation validates real operation effect, schemas, explicit command and resource scope", () => {
  const context = parseBrowserContext(contextValue());
  const read = {
    method: "invoke",
    operationId: "notes.read",
    parameters: null,
    resources: [opaque],
    commandId: null,
  };
  assert.equal(parseBrowserRequest(read, context).method, "invoke");
  for (const extra of [
    { commandId: "command" },
    { commandId: undefined },
    { resources: [] },
    { parameters: "not null" },
    { operationId: "not.declared" },
    { endpoint: "https://bad.example" },
    { actor: "owner" },
    { projectId: "other" },
  ])
    assert.throws(() => parseBrowserRequest({ ...read, ...extra }, context));
  const write = {
    method: "invoke",
    operationId: "notes.create",
    parameters: "original",
    resources: [],
    commandId: "original_command",
  };
  assert.equal(parseBrowserRequest(write, context).method, "invoke");
  assert.throws(() =>
    parseBrowserRequest({ ...write, commandId: null }, context),
  );
  assert.throws(() =>
    parseBrowserRequest(
      {
        method: "saveState",
        expectedRevision: 1,
        state: { object: opaque, body: "not navigation" },
      },
      context,
    ),
  );
  assert.throws(() =>
    parseBrowserRequest(
      { method: "compose", text: "x".repeat(30_001) },
      context,
    ),
  );
  assert.throws(() =>
    parseBrowserRequest(
      {
        method: "readObject",
        object: { ...opaque, versionRef: 1 },
        maxBytes: 256 * 1024,
      },
      context,
    ),
  );
});

test("browser result retains uncertain durable facts without inventing committed receipts", () => {
  const context = parseBrowserContext(contextValue());
  const request = parseBrowserRequest(
    { method: "recoverReceipt", commandId: "original_command" },
    context,
  );
  const uncertain = {
    kind: "command",
    commandId: "original_command",
    command: facts(),
    hostIssue: "receipt-storage",
    persistence: "pending",
    observedCommitted: {
      receiptId: "author/receipt",
      receiptHash: "c".repeat(64),
      committedAt: "2026-10-05T10:00:01Z",
      objects: [{ ...opaque, kind: "document", title: "Original" }],
    },
  };
  const result = parseBrowserResult(request, uncertain, context);
  assert.equal((result as typeof uncertain).command.state, "unknown");
  for (const invalid of [
    { ...uncertain, command: { ...facts(), receiptRef: "fake" } },
    { ...uncertain, command: { ...facts(), state: "committed" } },
    { ...uncertain, persistence: undefined },
    {
      ...uncertain,
      command: { ...facts(), actor: { principalId: "private" } },
    },
    { ...uncertain, commandId: "different" },
  ])
    assert.throws(() => parseBrowserResult(request, invalid, context));
  const committed = {
    ...facts(),
    state: "committed",
    projectionState: "pending",
    receiptRef: "receipt",
    receiptHash: "c".repeat(64),
    committedAt: "2026-10-05T10:00:01Z",
    objects: [],
  };
  assert.doesNotThrow(() =>
    parseBrowserResult(
      request,
      {
        kind: "command",
        commandId: "original_command",
        command: committed,
        hostIssue: "projection-pending",
      },
      context,
    ),
  );
  assert.throws(() =>
    parseBrowserResult(
      request,
      {
        kind: "command",
        commandId: "original_command",
        command: { ...committed, projectionState: "none" },
      },
      context,
    ),
  );
  const rejected = {
    ...facts(),
    state: "rejected",
    receiptRef: "receipt",
    receiptHash: "c".repeat(64),
  };
  assert.doesNotThrow(() =>
    parseBrowserResult(
      request,
      { kind: "command", commandId: "original_command", command: rejected },
      context,
    ),
  );
});

test("browser exact-object response and envelopes reject scope drift and hostile values", () => {
  const context = parseBrowserContext(contextValue());
  const request = parseBrowserRequest(
    { method: "readObject", object: opaque, maxBytes: 16 },
    context,
  );
  const response = {
    protocol: "morphz-domain/v1",
    authority: context.authority,
    object: opaque,
    kind: "document",
    title: "Original",
    content: { format: "text", text: "正文😀" },
  };
  assert.deepEqual(parseBrowserResult(request, response, context), response);
  assert.throws(() =>
    parseBrowserResult(
      request,
      { ...response, object: { ...opaque, versionRef: "latest" } },
      context,
    ),
  );
  assert.throws(() =>
    parseBrowserResult(
      request,
      { ...response, content: { format: "text", text: "a".repeat(17) } },
      context,
    ),
  );
  assert.throws(() =>
    parseBrowserMessage({
      type: "morphz-cognitive-ui/v1:response",
      channel: "bad",
      requestId: crypto.randomUUID(),
      ok: true,
      result: {},
    }),
  );
  assert.throws(() =>
    parseBrowserMessage({
      type: "morphz-cognitive-ui/v1:init",
      channel: crypto.randomUUID(),
      context: { ...contextValue(), ["endpoint"]: "secret" },
    }),
  );
  assert.throws(() =>
    parseBrowserMessage({
      type: "morphz-cognitive-ui/v1:request",
      channel: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      request: { method: "ready", actor: "forged" },
    }),
  );
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => parseBrowserResult(request, cyclic, context));
});

export type FixtureBrowserContext = BrowserContext;

test("browser bounded DTOs reject oversized values and retain legal business JSON unchanged", () => {
  const context = parseBrowserContext(contextValue());
  assert.throws(() =>
    parseBrowserRequest(
      {
        method: "invoke",
        operationId: "notes.create",
        parameters: "x".repeat(256 * 1024 + 1),
        resources: [],
        commandId: "original_command",
      },
      context,
    ),
  );
  for (const text of ["bad\u0000ref", "bad\ud800ref"]) {
    assert.throws(() =>
      parseBrowserRequest(
        {
          method: "readObject",
          object: { ...opaque, objectId: text },
          maxBytes: 100,
        },
        context,
      ),
    );
    assert.throws(() =>
      parseBrowserRequest(
        { method: "saveState", expectedRevision: 1, state: { view: text } },
        context,
      ),
    );
  }
  const unchanged = "原文\u0000\ud800\n\t😀";
  const parsed = parseBrowserRequest(
    {
      method: "invoke",
      operationId: "notes.create",
      parameters: unchanged,
      resources: [],
      commandId: "original_command",
    },
    context,
  );
  assert.equal(parsed.method === "invoke" && parsed.parameters, unchanged);
  for (const state of cognitiveBrowserCommandStates) {
    const command = { ...facts(), state };
    if (state === "committed" || state === "rejected")
      assert.throws(() =>
        parseBrowserResult(
          parseBrowserRequest(
            { method: "commandStatus", commandId: command.commandId },
            context,
          ),
          command,
          context,
        ),
      );
    else
      assert.doesNotThrow(() =>
        parseBrowserResult(
          parseBrowserRequest(
            { method: "commandStatus", commandId: command.commandId },
            context,
          ),
          command,
          context,
        ),
      );
  }
});

test(
  "packed author Browser SDK runs in an actual fixed Document facade/native port with bounded channels and no network capability (controlled business DTOs, not Host authorization)",
  { timeout: 180_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "morphz-browser-sdk-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const author = join(directory, "author"),
      consumer = join(directory, "consumer");
    mkdirSync(join(author, "src"), { recursive: true });
    mkdirSync(consumer);
    const packageRoot = fileURLToPath(
      new URL("../packages/cognitive-app-sdk/", import.meta.url),
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
    const npm = async (args: string[], cwd: string) => {
      try {
        return await execute("npm", args, {
          cwd,
          env,
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
        });
      } catch {
        throw new Error(
          "Isolated Browser SDK public-cache build/install failed; no dependency or capability gate was disabled.",
        );
      }
    };
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
    ) as { filename: string; integrity: string }[];
    assert.equal(packed.length, 1);
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({
        name: "isolated-browser-author",
        private: true,
        type: "module",
      }),
    );
    await npm([...install, join(author, packed[0]!.filename)], consumer);
    const source = `
import {connectMorphz,parseBrowserNavigationState} from '@morphz/cognitive-app-sdk/browser';
let client;const outcomes={},running={},notifications=[],windowMessages=[];let stopObserver;
const handle=(key,promise)=>{running[key]=true;promise.then(value=>{outcomes[key]={ok:true,value};delete running[key];},error=>{outcomes[key]={ok:false,code:error.code,commandId:error.commandId};delete running[key];});};
globalThis.fixture={outcomes,running,windowMessages,context:()=>client.context,
 async hostileInputs(){let calls=0;const reports=[];const accessor=()=>{calls++;throw Error('TEST-private-input-error');};const root=Object.defineProperty({text:'Question'},'secret',{enumerable:true,get:accessor}),nested=Object.defineProperty({objectId:'original'},'versionRef',{enumerable:true,get:accessor}),methodGetter=Object.defineProperty({text:'Question'},'method',{enumerable:true,get:accessor});for(const input of [root,{text:'Question',object:nested},methodGetter,{text:'Question',method:'compose'},Object.assign(Object.create({authorOnly:true}),{text:'Question'})]){let promise;let sync=false;try{promise=client.compose(input);}catch(error){sync=true;promise=Promise.reject(error);}reports.push(await Promise.resolve(promise).then(()=>({ok:true}),error=>({ok:false,sync,name:error.name,code:error.code,privateLeak:String(error).includes('TEST-private-input-error')})));}return {calls,reports};},
 navigation(){const input={object:{objectId:'原件/ 😀\\n',versionRef:'v:opaque/first'},view:'reader'},snapshot=parseBrowserNavigationState(input);input.object.versionRef='caller mutated';const rejected=[];for(const value of [{body:'not navigation'},{draft:'not navigation'},{unknown:true},{object:{objectId:'original',versionRef:1}}]){try{parseBrowserNavigationState(value);rejected.push(false);}catch{rejected.push(true);}}return {snapshot,rejected};},
 notifications,
 observe(){stopObserver=client.onContextChange(value=>notifications.push({theme:value.theme,view:value.view}));client.onContextChange(()=>{throw Error('private author callback failure')});client.onContextChange(()=>notifications.push({continued:true}));},
 stopObserve(){stopObserver();stopObserver();},
 observerBound(){const stop=[];for(let i=0;i<13;i++)stop.push(client.onContextChange(()=>{}));let code;try{client.onContextChange(()=>{});}catch(error){code=error.code;}for(const remove of stop)remove();return code;},
 run(key,method,args){let p;try{p=method==='ready'?client.ready():method==='commandStatus'||method==='recoverReceipt'?client[method](args):client[method](args);}catch(error){p=Promise.reject(error)}handle(key,p);},
 reconnect(key){handle(key,connectMorphz().then(value=>{client=value;return client.context;}));},
 shared(){return connectMorphz().then(value=>value===client);},
 dispose(){client.dispose();},
 retireOnUpdate(){client.onContextChange(()=>client.dispose());},
 elapsed(){const old=performance.now.bind(performance),base=old();let calls=0;Object.defineProperty(performance,'now',{configurable:true,value:()=>++calls===1?base:base+30000});handle('serializeDeadline',client.ready());delete performance.now;},
 offsetClock(){const old=performance.now.bind(performance);Object.defineProperty(performance,'now',{configurable:true,value:()=>old()+30000});},
 resetClock(){delete performance.now;},
 async security(){let network=false,parentReadable=false,storage=false;try{await fetch('/forbidden-network');network=true;}catch{}try{parentReadable=!!parent.document;}catch{}try{localStorage.setItem('x','x');storage=true;}catch{}return {network,parentReadable,storage,origin:location.origin,hasNode:typeof process!=='undefined'||typeof require!=='undefined'};}
};
addEventListener('message',event=>windowMessages.push({type:event.data?.type,origin:event.origin,fromParent:event.source===parent}));
setTimeout(()=>handle('connect',connectMorphz().then(value=>{client=value;return client.context;})),20);
`;
    const entry = join(consumer, "author.js");
    writeFileSync(entry, source);
    const built = await build({
      configFile: false,
      root: consumer,
      logLevel: "silent",
      build: {
        write: false,
        minify: false,
        lib: { entry, name: "IsolatedAuthor", formats: ["iife"] },
      },
    });
    const outputs = Array.isArray(built) ? built : [built];
    const chunk = outputs
      .flatMap((output) => ("output" in output ? output.output : []))
      .find((output) => output.type === "chunk");
    assert.ok(chunk && chunk.type === "chunk");
    assert.doesNotMatch(
      chunk.code,
      /\bimport\s|node:|PlatformStore|CognitiveAppBindings|CognitiveAppTransport/,
    );
    const childHtml = `<!doctype html><meta charset="utf-8"><script>${chunk.code}</script>`;
    const initial = contextValue();
    const documentFixture = await createSdkDocumentBrowserFixture(
      childHtml,
      initial,
      facts(),
    );
    const urls: string[] = [];
    const server = createServer((request, response) => {
      urls.push(request.url ?? "");
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      if (request.url?.split("?")[0] === "/guest") {
        response.setHeader(
          "Content-Security-Policy",
          documentFixture.document.contentSecurityPolicy,
        );
        response.end(documentFixture.document.bytes);
      } else if (request.url === "/") response.end(documentFixture.parentHtml);
      else {
        response.statusCode = 404;
        response.end();
      }
    });
    await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
    t.after(
      () =>
        new Promise<void>((accept, reject) =>
          server.close((error) => (error ? reject(error) : accept())),
        ),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const executable =
      process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || chromium.executablePath();
    assert.ok(
      existsSync(executable),
      "Actual installed browser capability is required; this test never skips or downloads.",
    );
    const browser = await chromium.launch({
      headless: true,
      executablePath: executable,
    });
    t.after(() => browser.close());
    const page = await browser.newPage(),
      errors: string[] = [],
      writes: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.method() !== "GET") writes.push(request.method());
    });
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const currentGuest = async () => {
      await page
        .frameLocator("#guest")
        .frameLocator("iframe")
        .locator("body")
        .waitFor({ state: "attached" });
      const frame = page
        .frames()
        .find(
          (frame) =>
            frame.url() === "about:srcdoc" &&
            frame.parentFrame()?.url().includes("/guest"),
        );
      assert.ok(
        frame,
        "the actual shared prefix owns the opaque author Document",
      );
      await frame.waitForFunction(
        () => Reflect.get(window, "fixture")?.outcomes.connect?.ok === true,
      );
      return frame;
    };
    let guest = await currentGuest();
    const freshDocument = async () => {
      const carrier = guest.parentFrame();
      assert.ok(carrier);
      const generation = await page.evaluate(() =>
        Reflect.get(window, "hostFixture").newDocument(),
      );
      await carrier.waitForURL(
        (url) =>
          url.searchParams.get("documentGeneration") === String(generation),
      );
      guest = await currentGuest();
    };
    const run = async (
      key: string,
      method: string,
      args: unknown = undefined,
    ) => {
      await guest.evaluate(
        ({ key, method, args }) =>
          Reflect.get(window, "fixture").run(key, method, args),
        { key, method, args },
      );
      await guest.waitForFunction(
        (key) => Reflect.get(window, "fixture").outcomes[key] !== undefined,
        key,
      );
      return guest.evaluate(
        (key) => Reflect.get(window, "fixture").outcomes[key],
        key,
      ) as Promise<{
        ok: boolean;
        code?: string;
        commandId?: string;
        value?: unknown;
      }>;
    };
    assert.equal(
      await page.evaluate(() => Reflect.get(window, "hostFixture").connects),
      1,
      "Late SDK recovers from an init sent before it subscribed; no automatic retry.",
    );
    assert.deepEqual(
      await page.evaluate(() => Reflect.get(window, "hostFixture").accepted),
      [
        {
          origin: `http://127.0.0.1:${address.port}`,
          actualCarrierSource: true,
          proof: documentFixture.proof,
          ports: 1,
        },
      ],
      "Only the actual trusted carrier hands one real fixed Document port to this Host.",
    );
    assert.equal(
      await guest.evaluate(() => Reflect.get(window, "fixture").shared()),
      true,
    );
    assert.equal(
      await page.evaluate(() => Reflect.get(window, "hostFixture").connects),
      1,
      "Repeated explicit connection borrows the single live channel, not another pending budget.",
    );
    const seen = () =>
      page.evaluate(
        () => Reflect.get(window, "hostFixture").records.length,
      ) as Promise<number>;
    await t.test(
      "real public client rejects root/nested accessors and own method before evaluation or send",
      async () => {
        const before = await seen();
        const report = await guest.evaluate(() =>
          Reflect.get(window, "fixture").hostileInputs(),
        );
        assert.equal(
          report.calls,
          0,
          "No accessor may execute before the pure JSON guard and deadline.",
        );
        assert.equal(
          await seen(),
          before,
          "Rejected public inputs must not reach parent RPC.",
        );
        for (const item of report.reports)
          assert.deepEqual(item, {
            ok: false,
            sync: false,
            name: "CognitiveBrowserError",
            code: "invalid",
            privateLeak: false,
          });
      },
    );
    await t.test(
      "same binding accepts semantic object-key reorders in init/ready but retires actual schema changes",
      async () => {
        try {
          await page.evaluate(() =>
            Reflect.get(window, "hostFixture").reorderInit(),
          );
          await page.waitForTimeout(30);
          assert.equal((await run("semanticInit", "ready")).ok, true);
          await page.evaluate(() => {
            Reflect.get(window, "hostFixture").hold = true;
          });
          const before = await seen();
          await guest.evaluate(() =>
            Reflect.get(window, "fixture").run("semanticReady", "ready"),
          );
          await page.waitForFunction(
            (count) =>
              Reflect.get(window, "hostFixture").records.length === count + 1,
            before,
          );
          await page.evaluate(() =>
            Reflect.get(window, "hostFixture").reorderInit(),
          );
          await page.waitForTimeout(30);
          assert.equal(
            await guest.evaluate(
              () => Reflect.get(window, "fixture").outcomes.semanticReady,
            ),
            undefined,
            "A same-binding key-only init must retain the existing pending request.",
          );
          await page.evaluate(() =>
            Reflect.get(window, "hostFixture").reorderReady(),
          );
          await guest.waitForFunction(
            () =>
              Reflect.get(window, "fixture").outcomes.semanticReady !==
              undefined,
          );
          assert.equal(
            await guest.evaluate(
              () => Reflect.get(window, "fixture").outcomes.semanticReady.ok,
            ),
            true,
          );
          await guest.evaluate(() =>
            Reflect.get(window, "fixture").run("schemaChange", "ready"),
          );
          await page.waitForFunction(
            (count) =>
              Reflect.get(window, "hostFixture").records.length === count + 2,
            before,
          );
          await page.evaluate(() =>
            Reflect.get(window, "hostFixture").changeSchema(),
          );
          await guest.waitForFunction(
            () =>
              Reflect.get(window, "fixture").outcomes.schemaChange !==
              undefined,
          );
          assert.equal(
            await guest.evaluate(
              () => Reflect.get(window, "fixture").outcomes.schemaChange.code,
            ),
            "disposed",
          );
        } finally {
          await guest.evaluate(() => Reflect.get(window, "fixture").dispose());
          await guest.evaluate(() =>
            Reflect.get(window, "fixture").reconnect("semanticRefused"),
          );
          await guest.waitForFunction(
            () =>
              Reflect.get(window, "fixture").outcomes.semanticRefused !==
              undefined,
          );
          assert.equal(
            await guest.evaluate(
              () =>
                Reflect.get(window, "fixture").outcomes.semanticRefused.code,
            ),
            "disposed",
            "Retired original Document cannot reclaim its one fixed transport.",
          );
          await page.evaluate(() => Reflect.get(window, "hostFixture").reset());
          await freshDocument();
        }
      },
    );
    const initialConnections = await page.evaluate(
      () => Reflect.get(window, "hostFixture").connects,
    );
    assert.deepEqual(
      await guest.evaluate(() => Reflect.get(window, "fixture").navigation()),
      {
        snapshot: { object: opaque, view: "reader" },
        rejected: [true, true, true, true],
      },
    );
    assert.deepEqual(
      await guest.evaluate(() => Reflect.get(window, "fixture").security()),
      {
        network: false,
        parentReadable: false,
        storage: false,
        origin: "null",
        hasNode: false,
      },
    );
    assert.equal(urls.includes("/forbidden-network"), false);
    const beforeInvalid = await seen();
    assert.equal(
      (
        await run("forged", "invoke", {
          operationId: "notes.read",
          parameters: null,
          resources: [opaque],
          commandId: null,
          actor: "forged",
        })
      ).code,
      "invalid",
    );
    assert.equal(
      (
        await run("readCommand", "invoke", {
          operationId: "notes.read",
          parameters: null,
          resources: [opaque],
          commandId: "wrong",
        })
      ).code,
      "invalid",
    );
    assert.equal(await seen(), beforeInvalid);
    assert.equal(
      (
        await run("read", "invoke", {
          operationId: "notes.read",
          parameters: null,
          resources: [opaque],
          commandId: null,
        })
      ).ok,
      true,
    );
    const written = await run("write", "invoke", {
      operationId: "notes.create",
      parameters: "Original",
      resources: [],
      commandId: "original_command",
    });
    assert.equal(
      (written.value as { command: { state: string; projectionState: string } })
        .command.projectionState,
      "pending",
    );
    const recorded = await page.evaluate(() =>
      Reflect.get(window, "hostFixture").records.at(-1),
    );
    assert.notEqual(recorded.requestId, recorded.request.commandId);
    for (const [key, method, args] of [
      ["object", "readObject", { object: opaque, maxBytes: 16 }],
      ["open", "openObject", { object: opaque }],
      ["compose", "compose", { text: "Question", object: opaque }],
      [
        "save",
        "saveState",
        { expectedRevision: 1, state: { object: opaque, view: "reader" } },
      ],
      ["status", "commandStatus", "original_command"],
      ["recover", "recoverReceipt", "original_command"],
    ] as const)
      assert.equal((await run(key, method, args)).ok, true, method);
    await guest.evaluate(() => Reflect.get(window, "fixture").observe());
    assert.equal(
      await guest.evaluate(() =>
        Reflect.get(window, "fixture").observerBound(),
      ),
      "busy",
    );
    const beforeNotifications = await seen();
    await page.evaluate(() => Reflect.get(window, "hostFixture").update());
    await guest.waitForFunction(
      () => Reflect.get(window, "fixture").notifications.length === 2,
    );
    const notifications = await guest.evaluate(
      () => Reflect.get(window, "fixture").notifications,
    );
    assert.deepEqual(notifications[0].theme, {
      appearance: "light",
      accent: "coral",
    });
    assert.equal(notifications[0].view.active, false);
    assert.equal(notifications[0].view.state.object.versionRef, "opaque:next");
    assert.deepEqual(
      notifications[1],
      { continued: true },
      "Throwing author callback is isolated from later observers and the Host handler.",
    );
    await page.evaluate(() => Reflect.get(window, "hostFixture").invalidInit());
    await page.waitForTimeout(30);
    assert.equal(
      await guest.evaluate(
        () => Reflect.get(window, "fixture").notifications.length,
      ),
      2,
    );
    assert.equal(
      await seen(),
      beforeNotifications,
      "UI notifications never automatically read/invoke/recover.",
    );
    await guest.evaluate(() => Reflect.get(window, "fixture").stopObserve());
    await page.evaluate(() => {
      Reflect.get(window, "hostFixture").hold = true;
    });
    await guest.evaluate(() =>
      Reflect.get(window, "fixture").run("guarded", "ready"),
    );
    await page.waitForFunction(
      () =>
        Reflect.get(window, "hostFixture").records.at(-1).request.method ===
        "ready",
    );
    const guarded = await page.evaluate(() =>
      Reflect.get(window, "hostFixture").records.at(-1),
    );
    await page.evaluate((request) => {
      const host = Reflect.get(window, "hostFixture");
      host.sibling({
        type: "morphz-cognitive-ui/v1:response",
        channel: request.channel,
        requestId: request.requestId,
        ok: true,
        result: {},
      });
      host.send({
        type: "morphz-cognitive-ui/v1:response",
        channel: crypto.randomUUID(),
        requestId: request.requestId,
        ok: true,
        result: {},
      });
    }, guarded);
    await guest.evaluate(
      (request) =>
        window.dispatchEvent(
          new MessageEvent("message", {
            source: parent,
            origin: "https://wrong-origin.example",
            data: {
              type: "morphz-cognitive-ui/v1:response",
              channel: request.channel,
              requestId: request.requestId,
              ok: true,
              result: {},
            },
          }),
        ),
      guarded,
    );
    await guest.waitForFunction(
      () => Reflect.get(window, "fixture").windowMessages.length === 2,
    );
    assert.deepEqual(
      (
        await guest.evaluate(
          () => Reflect.get(window, "fixture").windowMessages,
        )
      ).sort((left: { origin: string }, right: { origin: string }) =>
        left.origin.localeCompare(right.origin),
      ),
      [
        {
          type: "morphz-cognitive-ui/v1:response",
          origin: "null",
          fromParent: false,
        },
        {
          type: "morphz-cognitive-ui/v1:response",
          origin: "https://wrong-origin.example",
          fromParent: true,
        },
      ].sort((left, right) => left.origin.localeCompare(right.origin)),
    );
    await page.waitForTimeout(30);
    assert.equal(
      await guest.evaluate(
        () => Reflect.get(window, "fixture").outcomes.guarded,
      ),
      undefined,
    );
    await page.evaluate(
      (request) =>
        Reflect.get(window, "hostFixture").respond(
          request,
          Reflect.get(window, "hostFixture") && {
            ...JSON.parse(JSON.stringify(request)),
            invalid: true,
          },
        ),
      guarded,
    );
    await guest.waitForFunction(
      () => Reflect.get(window, "fixture").outcomes.guarded !== undefined,
    );
    assert.equal(
      await guest.evaluate(
        () => Reflect.get(window, "fixture").outcomes.guarded.code,
      ),
      "contract",
    );
    // Actual browser clock-controlled CPU deadline: no timer is fired to rescue
    // the check; the synchronous validation budget itself must prevent a send.
    const beforeDeadline = await seen();
    await guest.evaluate(() => Reflect.get(window, "fixture").elapsed());
    await guest.waitForFunction(
      () =>
        Reflect.get(window, "fixture").outcomes.serializeDeadline !== undefined,
    );
    assert.equal(
      await guest.evaluate(
        () => Reflect.get(window, "fixture").outcomes.serializeDeadline.code,
      ),
      "timeout",
    );
    assert.equal(await seen(), beforeDeadline);
    await guest.evaluate(() =>
      Reflect.get(window, "fixture").run("responseDeadline", "compose", {
        text: "Late",
      }),
    );
    await page.waitForFunction(
      (count) => Reflect.get(window, "hostFixture").records.length > count,
      beforeDeadline,
    );
    const late = await page.evaluate(() =>
      Reflect.get(window, "hostFixture").records.at(-1),
    );
    await guest.evaluate(() => Reflect.get(window, "fixture").offsetClock());
    await page.evaluate(
      (request) =>
        Reflect.get(window, "hostFixture").respond(request, { prepared: true }),
      late,
    );
    await guest.waitForFunction(
      () =>
        Reflect.get(window, "fixture").outcomes.responseDeadline !== undefined,
    );
    assert.equal(
      await guest.evaluate(
        () => Reflect.get(window, "fixture").outcomes.responseDeadline.code,
      ),
      "timeout",
    );
    await guest.evaluate(() => Reflect.get(window, "fixture").resetClock());
    // Browser virtual timers prove a silent Host does not retain permits forever.
    await page.clock.install();
    const beforeTimer = await seen();
    await guest.evaluate(() => {
      const fixture = Reflect.get(window, "fixture");
      for (let i = 0; i < 16; i++) fixture.run("timer" + i, "ready");
    });
    await page.waitForFunction(
      (count) =>
        Reflect.get(window, "hostFixture").records.length === count + 16,
      beforeTimer,
    );
    await page.clock.fastForward(30_000);
    await guest.waitForFunction(
      () => Reflect.get(window, "fixture").outcomes.timer15 !== undefined,
    );
    assert.equal(
      await guest.evaluate(
        () => Reflect.get(window, "fixture").outcomes.timer0.code,
      ),
      "timeout",
    );
    const afterTimers = await seen();
    await guest.evaluate(() =>
      Reflect.get(window, "fixture").run("afterTimeout", "ready"),
    );
    await page.waitForFunction(
      (count) =>
        Reflect.get(window, "hostFixture").records.length === count + 1,
      afterTimers,
    );
    await page.evaluate(() => {
      const host = Reflect.get(window, "hostFixture");
      host.respond(host.records.at(-1), host.context());
    });
    await guest.waitForFunction(
      () => Reflect.get(window, "fixture").outcomes.afterTimeout !== undefined,
    );
    assert.equal(
      await guest.evaluate(
        () => Reflect.get(window, "fixture").outcomes.afterTimeout.ok,
      ),
      true,
    );
    const beforeCapacity = await seen();
    await guest.evaluate(() => {
      const fixture = Reflect.get(window, "fixture");
      for (let i = 0; i < 17; i++) fixture.run("capacity" + i, "ready");
    });
    await guest.waitForFunction(
      () => Reflect.get(window, "fixture").outcomes.capacity16 !== undefined,
    );
    assert.equal(
      await guest.evaluate(
        () => Reflect.get(window, "fixture").outcomes.capacity16.code,
      ),
      "busy",
    );
    await page.waitForFunction(
      (count) =>
        Reflect.get(window, "hostFixture").records.length === count + 16,
      beforeCapacity,
    );
    await page.evaluate(() => Reflect.get(window, "hostFixture").rotate());
    await guest.waitForFunction(
      () => Reflect.get(window, "fixture").outcomes.capacity15 !== undefined,
    );
    assert.equal(
      await guest.evaluate(
        () => Reflect.get(window, "fixture").outcomes.capacity0.code,
      ),
      "disposed",
    );
    assert.equal(
      await guest.evaluate(
        () => Reflect.get(window, "fixture").notifications.length,
      ),
      2,
      "Retirement clears observers without publishing a new target into the old UI.",
    );
    assert.equal((await run("oldClient", "ready")).code, "disposed");
    await page.evaluate(
      (request) =>
        Reflect.get(window, "hostFixture").send({
          type: "morphz-cognitive-ui/v1:response",
          channel: request.channel,
          requestId: request.requestId,
          ok: true,
          result: { prepared: true },
        }),
      late,
    );
    await guest.evaluate(() =>
      Reflect.get(window, "fixture").reconnect("reconnected"),
    );
    await guest.waitForFunction(
      () => Reflect.get(window, "fixture").outcomes.reconnected !== undefined,
    );
    assert.equal(
      await guest.evaluate(
        () => Reflect.get(window, "fixture").outcomes.reconnected.code,
      ),
      "disposed",
      "Binding retirement cannot reuse the same original Document or its port.",
    );
    await page.evaluate(() => Reflect.get(window, "hostFixture").update());
    await page.waitForTimeout(30);
    assert.equal(
      await guest.evaluate(
        () => Reflect.get(window, "fixture").notifications.length,
      ),
      2,
      "Old observer callbacks remain retired, including after refused same-Document reconnect.",
    );
    await freshDocument();
    assert.equal(
      await page.evaluate(() => Reflect.get(window, "hostFixture").connects),
      initialConnections + 1,
      "Only a genuinely new Document, module and native port reconnect.",
    );
    assert.equal(
      await guest.evaluate(
        () => Reflect.get(window, "fixture").context().view.bindingRevision,
      ),
      2,
    );
    await page.evaluate(() => Reflect.get(window, "hostFixture").update());
    await page.waitForTimeout(30);
    assert.equal(
      await guest.evaluate(
        () => Reflect.get(window, "fixture").notifications.length,
      ),
      0,
      "Old observer callbacks are not rebound to a new connection.",
    );
    const beforeObserverDisposal = await seen();
    await page.evaluate(() => {
      Reflect.get(window, "hostFixture").hold = true;
    });
    await guest.evaluate(() => {
      const fixture = Reflect.get(window, "fixture");
      fixture.retireOnUpdate();
      fixture.run("observerDisposal", "ready");
    });
    await page.waitForFunction(
      (count) =>
        Reflect.get(window, "hostFixture").records.length === count + 1,
      beforeObserverDisposal,
    );
    await page.evaluate(() => {
      const host = Reflect.get(window, "hostFixture");
      host.reviseSilent();
      host.respond(host.records.at(-1), host.context());
    });
    await guest.waitForFunction(
      () =>
        Reflect.get(window, "fixture").outcomes.observerDisposal !== undefined,
    );
    assert.equal(
      await guest.evaluate(
        () => Reflect.get(window, "fixture").outcomes.observerDisposal.code,
      ),
      "disposed",
      "A ready callback that retires its channel must not still resolve a successful old-scope RPC.",
    );
    await guest.evaluate(() => Reflect.get(window, "fixture").dispose());
    assert.equal((await run("disposed", "ready")).code, "disposed");
    assert.equal(
      await page.evaluate(
        () => Reflect.get(window, "hostFixture").accepted.length,
      ),
      3,
      "Each of the three genuine author Documents hands exactly one native peer; refused same-Document reconnect adds none.",
    );
    assert.deepEqual(
      await page.evaluate(() => Reflect.get(window, "hostFixture").rejected),
      [],
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, []);
    console.log(
      `[browser SDK fixture] ${JSON.stringify({ sdkVersion: "0.3.0", packedIntegrity: packed[0]!.integrity, outsideRepository: true, selfContainedHtml: true, opaqueSandbox: true, fixedDocumentFacadeAndNativePort: true, sourceAndChannel: true, windowForgeryPositiveControl: true, sameDocumentReclaimRejected: true, genuineNewDocumentReconnect: true, pending: 16, absoluteDeadlineMs: 30000, clockControlledDeadline: true, retiredChannel: true, noBusinessRequests: true, hostAuthorization: "not implemented by this fixture" })}`,
    );
  },
);
