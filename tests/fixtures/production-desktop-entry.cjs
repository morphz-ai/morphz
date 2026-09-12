// Runs the real entry against isolated data; refuses an application TCP listener.
const { join, basename, isAbsolute } = require("node:path");
const { lstatSync } = require("node:fs");
const fixture = process.env.MORPHZWORK_EMBEDDED_FIXTURE;
if (
  !fixture ||
  !isAbsolute(fixture) ||
  !basename(fixture).startsWith("morphz-embedded-electron-") ||
  !lstatSync(fixture).isDirectory()
)
  throw new Error("A generated isolated fixture is required");
process.env.MORPHZWORK_TEST_PROFILE = join(fixture, "profile");
process.env.MORPHZWORK_DATA_DIR = join(fixture, "data");
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
require("../../apps/desktop/main.cjs");
globalThis.__fixturePreferences = require("../../apps/desktop/preferences.cjs");
