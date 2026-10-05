// Isolated automatic native mechanism witness only. The real production entry
// owns scheme privileges, protocol handling, webPreferences and the window.
// No application production hook, alternate business authority or HTTP server.
const { join } = require("node:path");
const root = join(__dirname, "../..");
const bridge = require("../../apps/desktop/application-bridge.cjs");
const register = bridge.registerApplicationBridge;
let connection;
let configured;
let originalDocument;
const documentReads = [];
let rawReads = 0;
let legacyReads = 0;
let tcpAttempts = 0;
bridge.registerApplicationBridge = function (ipcMain, value, ...options) {
  if (connection) throw new Error("Native document fixture has one connection");
  connection = value;
  originalDocument = value.cognitiveAppDocumentResource;
  const raw = value.cognitiveAppViewResource.bind(value);
  value.cognitiveAppViewResource = function (...args) {
    rawReads++;
    return raw(...args);
  };
  const legacy = value.resource.bind(value);
  value.resource = function (...args) {
    legacyReads++;
    return legacy(...args);
  };
  return register(ipcMain, value, ...options);
};
globalThis.__cognitiveDocumentNativeFixture = {
  ready: () => !!connection,
  async configure(authorHtml, proof) {
    if (!connection || configured)
      throw Error("Invalid native fixture lifecycle");
    const {
      createCognitiveDocumentBootstrap,
      cognitiveDocumentBootstrapProtocol,
    } = await import(
      join(
        root,
        "dist/service/packages/application/src/cognitive-document-bootstrap.js",
      )
    );
    const { parseCognitiveAppDocumentResourceRequest } = await import(
      join(
        root,
        "dist/service/packages/core/src/cognitive-app-document-resource.js",
      )
    );
    const { ApplicationRequestError } = await import(
      join(root, "dist/service/packages/core/src/application-api.js")
    );
    const carrier = await createCognitiveDocumentBootstrap(authorHtml, proof);
    const expected = parseCognitiveAppDocumentResourceRequest({
      viewId: "native-document-view",
      expectedViewRevision: 1,
      expectedBindingRevision: 1,
      documentProof: proof,
    });
    configured = { carrier, expected };
    // Explicitly controlled typed business port in this fixture main process.
    // The production resource adapter remains unchanged and is actually used.
    connection.cognitiveAppDocumentResource = async function (input, signal) {
      const request = parseCognitiveAppDocumentResourceRequest(input);
      if (JSON.stringify(request) !== JSON.stringify(expected))
        throw new ApplicationRequestError(
          400,
          "Invalid native test request",
          "invalid",
        );
      signal?.throwIfAborted();
      documentReads.push({ request, hasSignal: !!signal });
      return { mime: carrier.mime, bytes: new Uint8Array(carrier.bytes) };
    };
    return {
      request: expected,
      byteLength: carrier.bytes.byteLength,
      authorSha256: carrier.authorSha256,
      protocol: cognitiveDocumentBootstrapProtocol,
      policy: carrier.contentSecurityPolicy,
    };
  },
  report() {
    return { documentReads, rawReads, legacyReads, tcpAttempts };
  },
  retire() {
    if (connection) connection.cognitiveAppDocumentResource = originalDocument;
    configured = null;
  },
};
// Existing entry validates the generated directory, isolates profile/data,
// forbids TCP, and loads actual main.cjs. Never modify that shared entry.
require("./production-desktop-entry.cjs");
const { Server } = require("node:net");
const guardedListen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  if (typeof args[0] !== "string") tcpAttempts++;
  return guardedListen.apply(this, args);
};
