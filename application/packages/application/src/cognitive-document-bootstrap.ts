import {
  cognitiveAppViewHtmlResource,
  parseCognitiveAppViewHtmlBytes,
} from "../../core/src/cognitive-app-view-resource.js";
import {
  cognitiveAppDocumentHtmlResource,
  parseCognitiveAppDocumentProof,
  type CognitiveAppDocumentResource,
} from "../../core/src/cognitive-app-document-resource.js";
import { applicationViewPermissions } from "../../core/src/resource-policy.js";

/** Shared fixed Document handoff. No business authority or mounted consumer. */
export const cognitiveDocumentBootstrapProtocol =
  "morphz-cognitive-document-bootstrap/v1";
export const cognitiveDocumentFacadeName = "__morphzCognitiveDocument";
export const cognitiveDocumentBootstrapPolicy =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

// Static trusted code: author bytes never occur in this JavaScript source.
// The original native port and observer remain lexical, not on the facade.
const documentPrefix = String.raw`(() => {
  "use strict";
  const win = window, doc = document, nativeParent = parent;
  const apply = Reflect.apply;
  const descriptor = Object.getOwnPropertyDescriptor;
  const define = Object.defineProperty;
  const freeze = Object.freeze;
  const keys = Object.keys;
  const array = Array.isArray;
  const finite = Number.isFinite;
  const nativeJSON = JSON, parse = JSON.parse;
  const encoder = new TextEncoder();
  const encode = TextEncoder.prototype.encode;
  const byteLength = descriptor(Uint8Array.prototype.__proto__, "byteLength").get;
  const elementGetter = descriptor(Document.prototype, "documentElement").get;
  const doctypeGetter = descriptor(Document.prototype, "doctype").get;
  const readyGetter = descriptor(Document.prototype, "readyState").get;
  const documentGetter = descriptor(win, "document").get;
  const root = apply(elementGetter, doc, []);
  const doctype = apply(doctypeGetter, doc, []);
  const targetGetter = descriptor(MutationRecord.prototype, "target").get;
  const removedGetter = descriptor(MutationRecord.prototype, "removedNodes").get;
  const listLength = descriptor(NodeList.prototype, "length").get;
  const listItem = NodeList.prototype.item;
  const take = MutationObserver.prototype.takeRecords;
  const observe = MutationObserver.prototype.observe;
  const disconnect = MutationObserver.prototype.disconnect;
  const add = EventTarget.prototype.addEventListener;
  const eventData = descriptor(MessageEvent.prototype, "data").get;
  const post = MessagePort.prototype.postMessage;
  const close = MessagePort.prototype.close;
  const start = MessagePort.prototype.start;
  const parentPost = nativeParent.postMessage;
  const timerSet = win.setTimeout, timerClear = win.clearTimeout;
  const channel = new MessageChannel();
  const hostPort = channel.port1, peer = channel.port2;
  let retired = false, claimed = false, subscriber = null, ready = false;
  function retire() {
    if (retired) return;
    retired = true;
    subscriber = null;
    apply(timerClear, win, [parserTimer]);
    apply(disconnect, observer, []);
    apply(close, hostPort, []);
  }
  function records(items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (apply(targetGetter, item, []) !== doc) continue;
      const removed = apply(removedGetter, item, []);
      for (let j = 0; j < apply(listLength, removed, []); j++) {
        const node = apply(listItem, removed, [j]);
        if (node === root || node === doctype) retire();
      }
    }
  }
  const observer = new MutationObserver(records);
  const parserTimer = apply(timerSet, win, [retire, 30000]);
  apply(observe, observer, [doc, {childList: true}]);
  function check() {
    try {
      // This exact call is also the controlled guard-removal mutant seam.
      records(apply(take, observer, []));
      if (retired || apply(documentGetter, win, []) !== doc ||
          apply(elementGetter, doc, []) !== root ||
          apply(doctypeGetter, doc, []) !== doctype)
        throw new Error("Cognitive document is retired.");
    } catch (error) {
      retire();
      throw error;
    }
  }
  function wire(text) {
    if (typeof text !== "string" || text.length > 524288 ||
        apply(byteLength, apply(encode, encoder, [text]), []) > 524288)
      throw new Error("Invalid cognitive document wire.");
    const value = apply(parse, nativeJSON, [text]);
    let nodes = 0;
    function visit(item, depth) {
      if (++nodes > 32768 || depth > 40) throw new Error("Invalid cognitive document wire.");
      if (item === null || typeof item === "string" || typeof item === "boolean") return;
      if (typeof item === "number") {
        if (!finite(item)) throw new Error("Invalid cognitive document wire.");
        return;
      }
      if (array(item)) {
        for (let i = 0; i < item.length; i++) visit(item[i], depth + 1);
      } else {
        const names = keys(item);
        for (let i = 0; i < names.length; i++) visit(item[names[i]], depth + 1);
      }
    }
    visit(value, 1);
    return text;
  }
  const facade = freeze({
    check() { check(); },
    send(text) {
      check();
      const detachedText = wire(text);
      check();
      apply(post, hostPort, [{kind: "wire", text: detachedText}]);
    },
    subscribe(callback) {
      check();
      if (typeof callback !== "function" || subscriber !== null)
        throw new Error("Invalid cognitive document subscriber.");
      subscriber = callback;
      return function unsubscribe() {
        if (subscriber === callback) subscriber = null;
      };
    },
    dispose() { retire(); }
  });
  define(win, "__morphzCognitiveDocument", {
    configurable: false, enumerable: false, writable: false,
    value: freeze(function claim() {
      check();
      if (claimed) throw new Error("Cognitive document was already claimed.");
      claimed = true;
      return facade;
    })
  });
  apply(add, hostPort, ["message", function ingress(event) {
    try {
      check();
      const message = apply(eventData, event, []);
      if (!message || typeof message !== "object" || keys(message).length !== 2)
        throw new Error("Invalid cognitive document ingress.");
      const kind = descriptor(message, "kind"), text = descriptor(message, "text");
      if (!kind || kind.value !== "wire" || !text || !("value" in text))
        throw new Error("Invalid cognitive document ingress.");
      const validated = wire(text.value);
      check();
      if (ready && subscriber !== null) subscriber(validated);
    } catch { retire(); }
  }]);
  apply(add, hostPort, ["messageerror", retire]);
  apply(start, hostPort, []);
  function parserReady() {
    try {
      check();
      if (ready || apply(readyGetter, doc, []) === "loading") return;
      ready = true;
      apply(timerClear, win, [parserTimer]);
      apply(post, hostPort, [{kind: "parser-ready"}]);
    } catch { retire(); }
  }
  apply(add, doc, ["DOMContentLoaded", parserReady, {once: true}]);
  apply(parentPost, nativeParent, [{
    protocol: "morphz-cognitive-document-bootstrap/v1", proof: __PROOF__
  }, "*", [peer]]);
})();`;

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function scriptLiteral(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export type CognitiveDocumentBootstrap = CognitiveAppDocumentResource & {
  html: string;
  authorBytes: Uint8Array;
  authorSha256: string;
  contentSecurityPolicy: string;
  permissionsPolicy: string;
};

/** String API retained for the isolated prototype; byte adapters use the same builder. */
export async function createCognitiveDocumentBootstrap(
  authorHtml: string,
  proof: string,
): Promise<CognitiveDocumentBootstrap> {
  return createCognitiveDocumentBootstrapFromBytes(
    cognitiveAppViewHtmlResource(authorHtml).bytes,
    proof,
  );
}

/** Captures exact raw bytes synchronously before hashing. Callers own all real
 * authorization and post-await identity/cancellation gates; proof grants none. */
export async function createCognitiveDocumentBootstrapFromBytes(
  authorBytes: Uint8Array,
  proof: string,
): Promise<CognitiveDocumentBootstrap> {
  const bytes = parseCognitiveAppViewHtmlBytes(authorBytes);
  proof = parseCognitiveAppDocumentProof(proof);
  const payload = base64(bytes);
  const prefix = `<!doctype html><html><head><meta charset="utf-8"><script>${documentPrefix.replace("__PROOF__", JSON.stringify(proof))}</script>`;
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  const authorSha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body,iframe{margin:0;border:0;width:100%;height:100%;display:block}</style></head><body><script>
(() => {
  "use strict";
  const proof = ${JSON.stringify(proof)};
  const protocol = ${JSON.stringify(cognitiveDocumentBootstrapProtocol)};
  const inner = document.createElement("iframe");
  inner.title = "Cognitive document handoff prototype";
  inner.sandbox = "allow-scripts";
  inner.referrerPolicy = "no-referrer";
  inner.allow = "camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'; clipboard-read 'none'; clipboard-write 'none'";
  let consumed = false;
  const timer = setTimeout(() => { if (!consumed) inner.remove(); }, 30000);
  addEventListener("message", (event) => {
    if (event.source !== inner.contentWindow || event.origin !== "null") return;
    const packet = event.data;
    if (consumed || !packet || typeof packet !== "object" ||
        Object.keys(packet).length !== 2 || packet.protocol !== protocol ||
        packet.proof !== proof || event.ports.length !== 1) {
      for (const port of event.ports) port.close();
      return;
    }
    consumed = true;
    clearTimeout(timer);
    parent.postMessage({protocol, proof}, "*", [event.ports[0]]);
  });
  const binary = atob("${payload}");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const author = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes);
  inner.srcdoc = ${scriptLiteral(prefix)} + author;
  document.body.append(inner);
})();
</script></body></html>`;
  return {
    ...cognitiveAppDocumentHtmlResource(html),
    html,
    authorBytes: new Uint8Array(bytes),
    authorSha256,
    contentSecurityPolicy: cognitiveDocumentBootstrapPolicy,
    permissionsPolicy: applicationViewPermissions,
  };
}
