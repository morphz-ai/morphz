import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { chromium, type Browser, type Page } from "@playwright/test";
import {
  createCognitiveDocumentBootstrap,
  cognitiveDocumentBootstrapProtocol,
} from "../../apps/web/src/host/cognitive-document-bootstrap.js";
import { appContentSecurityPolicy } from "../../packages/core/src/resource-policy.js";

export type DocumentBootstrapReport = {
  peers: number;
  ready: number;
  loads: number;
  requests: Array<{ id: string; method: string }>;
  sent: Array<{ kind: string; marker?: string; id?: string }>;
  observations: Array<Record<string, unknown>>;
  invalid: number;
  credits: number[];
};

/** Controlled synchronous SDK facade stub; not the packed production SDK. */
export const documentSdkStub = String.raw`(() => {
  const post = top.postMessage.bind(top), parse = JSON.parse, stringify = JSON.stringify;
  const observe = value => post({fixtureObservation:value}, "*");
  let facade;
  try {
    facade = window.__morphzCognitiveDocument();
    facade.subscribe(text => {
      const message = parse(text);
      observe({type:"delivered", ...message, document:document.getElementById("replacement") ? "replacement" : "original"});
    });
    window.documentSdkStub = {
      request(id) { facade.send(stringify({kind:"request",method:"readObject",id})); },
      send(text) { facade.send(text); },
      subscribe(callback) { return facade.subscribe(callback); },
      check() { facade.check(); },
      dispose() { facade.dispose(); },
      observe
    };
    observe({type:"stub-claimed"});
  } catch(error) { observe({type:"claim-rejected",message:String(error)}); }
  addEventListener("message", event => {
    if (event.data?.kind === "init" || event.data?.kind === "result")
      observe({type:"sensitive-window-message",message:event.data});
  });
})();`;

export function authorDocument(before = "", after = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Original author</title><script>${before}</script><script>${documentSdkStub}</script></head><body><main id="original">原作者 😀</main><script>${after}</script></body></html>`;
}

const parentCode = String.raw`(() => {
  const expected = __EXPECTED__, marker = __MARKER__, protocol = __PROTOCOL__;
  const report = {peers:0,ready:0,loads:0,requests:[],sent:[],observations:[],invalid:0,credits:[]};
  let port = null, heldPeer = null, holdPeer = __HOLDPEER__, holdReplies = false, ready = false;
  const waiting = [];
  let sentSequence = 0, creditedSequence = 0, receivedSequence = 0;
  const wrapper = document.createElement("iframe");
  wrapper.id = "trusted-wrapper"; wrapper.src = "/trusted-wrapper";
  wrapper.addEventListener("load", () => report.loads++);
  function emit(message) {
    report.sent.push(message);
    if (port) {
      sentSequence++;
      port.postMessage({kind:"wire",text:JSON.stringify(message)});
    }
  }
  function attach(peer) {
    if (port !== null) { peer.close(); return; }
    port = peer;
    peer.onmessage = event => {
      const packet = event.data;
      if (packet?.kind === "parser-ready" && Object.keys(packet).length === 1) {
        if (ready) { report.invalid++; return; }
        ready = true; report.ready++;
        emit({kind:"init",marker});
        return;
      }
      if (packet?.kind === "credit") {
        if (Array.isArray(packet) || Object.keys(packet).length !== 2 ||
            !Number.isSafeInteger(packet.sequence) || packet.sequence !== creditedSequence + 1 ||
            packet.sequence > sentSequence) { report.invalid++; return; }
        creditedSequence = packet.sequence;
        report.credits.push(packet.sequence);
        return;
      }
      let consumedWire = false;
      try {
        if (!packet || packet.kind !== "wire" || Object.keys(packet).length !== 2 ||
            typeof packet.text !== "string" || new TextEncoder().encode(packet.text).byteLength > 524288)
          throw Error("bad frame");
        consumedWire = true;
        if (!ready) throw Error("not parser-ready");
        const request = JSON.parse(packet.text);
        if (request?.kind !== "request" || request.method !== "readObject" ||
            typeof request.id !== "string" || request.id.length > 100 || Object.keys(request).length !== 3)
          throw Error("bad request");
        report.requests.push({id:request.id,method:request.method});
        if (holdReplies) waiting.push(request.id);
        else emit({kind:"result",id:request.id,marker});
      } catch { report.invalid++; }
      finally {
        if (consumedWire) peer.postMessage({kind:"credit",sequence:++receivedSequence});
      }
    };
    peer.start();
  }
  addEventListener("message", event => {
    if (event.data?.fixtureObservation) {
      report.observations.push({...event.data.fixtureObservation, eventOrigin:event.origin});
      return;
    }
    const packet = event.data;
    if (event.source !== wrapper.contentWindow || event.origin !== location.origin ||
        packet?.protocol !== protocol || packet?.proof !== expected || event.ports.length !== 1 ||
        report.peers !== 0) {
      for (const candidate of event.ports) candidate.close();
      return;
    }
    report.peers++;
    if (holdPeer) heldPeer = event.ports[0]; else attach(event.ports[0]);
  });
  window.documentBootstrapHost = {
    report: () => structuredClone(report),
    releasePeer() { holdPeer = false; if (heldPeer) { attach(heldPeer); heldPeer = null; } },
    holdReplies(value) { holdReplies = value; },
    releaseReplies() { holdReplies = false; for (const id of waiting.splice(0)) emit({kind:"result",id,marker}); },
    emit(message) { emit(message); },
    packet(packet) { port?.postMessage(packet); },
    retire() { port?.close(); },
    marker
  };
  document.body.append(wrapper);
})();`;

export async function prepareDocumentBootstrapBrowser(): Promise<Browser> {
  const executable =
    process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || chromium.executablePath();
  assert.ok(
    existsSync(executable),
    "Actual Chromium required; no skip/download.",
  );
  return chromium.launch({ headless: true, executablePath: executable });
}

export async function withDocumentBootstrap(
  browser: Browser,
  author: string,
  options: {
    holdPeer?: boolean;
    /** Extra adversarial witness only; the production leaf policy is unchanged. */
    controlledNavigationPolicy?: boolean;
    /** Explicit controlled mutant, not an alternate production mode. */
    mutate?: (html: string) => string;
  },
  use: (
    page: Page,
    evidence: {
      originalSha256: string;
      originalBytes: Uint8Array;
      marker: string;
      proof: string;
      paths: string[];
      wrapperHtml: string;
      wrapperPolicy: string;
      console: string[];
    },
  ) => Promise<void>,
): Promise<void> {
  const proof = randomUUID(),
    marker = randomUUID();
  const resource = await createCognitiveDocumentBootstrap(author, proof);
  const wrapperHtml = options.mutate?.(resource.html) ?? resource.html;
  const wrapperPolicy = options.controlledNavigationPolicy
    ? resource.contentSecurityPolicy.replace(
        "frame-src 'none'",
        "frame-src 'self'",
      )
    : resource.contentSecurityPolicy;
  const paths: string[] = [];
  const script = parentCode
    .replace("__EXPECTED__", JSON.stringify(proof))
    .replace("__MARKER__", JSON.stringify(marker))
    .replace("__PROTOCOL__", JSON.stringify(cognitiveDocumentBootstrapProtocol))
    .replace("__HOLDPEER__", JSON.stringify(options.holdPeer ?? false));
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Content-Security-Policy", appContentSecurityPolicy);
      response.end(
        '<!doctype html><html><body><script src="/parent.js"></script></body></html>',
      );
    } else if (request.url === "/parent.js") {
      response.setHeader("Content-Type", "text/javascript; charset=utf-8");
      response.end(script);
    } else if (request.url === "/trusted-wrapper") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Content-Security-Policy", wrapperPolicy);
      response.setHeader("Permissions-Policy", resource.permissionsPolicy);
      response.end(wrapperHtml);
    } else if (request.url?.startsWith("/replacement")) {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader(
        "Content-Security-Policy",
        resource.contentSecurityPolicy,
      );
      response.end(
        `<!doctype html><html><body><main id="replacement">Replacement</main><script>
top.postMessage({fixtureObservation:{type:"replacement-executing"}},"*");
const forged=new MessageChannel();forged.port1.onmessage=event=>top.postMessage({fixtureObservation:{type:"replacement-forged-peer-body",body:event.data}},"*");
parent.postMessage({protocol:${JSON.stringify(cognitiveDocumentBootstrapProtocol)},proof:${JSON.stringify(proof)}},"*",[forged.port2]);
${documentSdkStub}</script></body></html>`,
      );
    } else {
      response.statusCode = 404;
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
  const page = await context.newPage();
  const console: string[] = [];
  page.on("console", (message) => console.push(message.text()));
  page.on("pageerror", (error) => console.push(String(error)));
  try {
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.waitForFunction(
      () => !!Reflect.get(window, "documentBootstrapHost"),
    );
    assert.equal(
      resource.authorSha256,
      createHash("sha256").update(Buffer.from(author)).digest("hex"),
    );
    await use(page, {
      originalSha256: resource.authorSha256,
      originalBytes: resource.authorBytes,
      marker,
      proof,
      paths,
      wrapperHtml,
      wrapperPolicy,
      console,
    });
  } finally {
    await context.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

export async function documentBootstrapReport(
  page: Page,
): Promise<DocumentBootstrapReport> {
  return page.evaluate(() =>
    Reflect.get(window, "documentBootstrapHost").report(),
  );
}
