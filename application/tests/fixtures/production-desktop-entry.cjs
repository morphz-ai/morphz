// Runs the real entry against isolated data; refuses an application TCP listener.
const { join, basename, isAbsolute } = require("node:path");
const { lstatSync } = require("node:fs");
const fixture = process.env.MORPHZ_APP_EMBEDDED_FIXTURE;
if (
  !fixture ||
  !isAbsolute(fixture) ||
  !basename(fixture).startsWith("morphz-embedded-electron-") ||
  !lstatSync(fixture).isDirectory()
)
  throw new Error("A generated isolated fixture is required");
process.env.MORPHZ_APP_PROFILE = join(fixture, "profile");
process.env.MORPHZ_APP_DATA_DIR = join(fixture, "data");
const { Server } = require("node:net");
if (process.platform === "darwin") {
  require("electron").app.dock.setIcon = () => {
    throw new Error(
      "Use the bundled icon; a raw Dock override bypasses system normalization",
    );
  };
}
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  if (typeof args[0] !== "string")
    throw new Error("Desktop must not open a TCP application listener");
  return listen.apply(this, args);
};
// Test-only one-shot transport failure. It targets a real renderer app-view
// save, after the production bridge's trusted-main check, rather than creating
// a notice DOM node or invoking React state directly. Other calls use the real
// embedded connection and store, with no application TCP listener.
const applicationBridge = require("../../apps/desktop/application-bridge.cjs");
const registerApplicationBridge = applicationBridge.registerApplicationBridge;
applicationBridge.registerApplicationBridge = function (
  ipcMain,
  connection,
  ...options
) {
  const invoke = connection.invoke.bind(connection);
  connection.invoke = async function (request) {
    const fault = globalThis.__fixtureAppViewSaveConflict;
    if (
      fault?.remaining === 1 &&
      request?.method === "app-views.save" &&
      request.params?.state?.url === fault.url
    ) {
      fault.remaining = 0;
      fault.requests.push({ method: request.method, params: request.params });
      return {
        ok: false,
        error: { status: 409, code: "conflict", message: fault.message },
      };
    }
    return invoke(request);
  };
  return registerApplicationBridge(ipcMain, connection, ...options);
};
require("../../apps/desktop/main.cjs");
globalThis.__fixturePreferences = require("../../apps/desktop/preferences.cjs");
