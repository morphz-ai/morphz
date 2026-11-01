// Use the production window, picker and IPC against an isolated center/profile.
// Only the final OS pixel read is replaced; never capture the user's desktop.
const { writeFile } = require("node:fs/promises");
const { appendFileSync, lstatSync } = require("node:fs");
const { join, basename, isAbsolute } = require("node:path");
const { app, dialog } = require("electron");
if (process.env.MORPHZ_TEST_SOFTWARE_RENDERING === "1")
  app.disableHardwareAcceleration();
const fixture = process.env.MORPHZ_APP_EMBEDDED_FIXTURE;
if (
  !fixture ||
  !isAbsolute(fixture) ||
  !basename(fixture).startsWith("morphz-embedded-electron-") ||
  !lstatSync(fixture).isDirectory()
)
  throw new Error("A generated isolated fixture is required");
const journal = join(fixture, "native-startup.jsonl");
let records = 0;
function record(stage, details = {}) {
  if (++records > 200) return;
  try {
    appendFileSync(
      journal,
      JSON.stringify({ at: Date.now(), stage, ...details }) + "\n",
      { mode: 0o600 },
    );
  } catch {}
}
record("fixture-entry", { pid: process.pid });
globalThis.__morphzStartupDiagnostic = record;
app.on("gpu-info-update", () =>
  record("gpu-info", { features: app.getGPUFeatureStatus() }),
);
for (const name of [
  "ready",
  "before-quit",
  "will-quit",
  "quit",
  "window-all-closed",
])
  app.on(name, () => record(name));
app.on("browser-window-created", (_event, window) => {
  const id = window.id;
  record("window-created", { id });
  for (const name of ["show", "closed"])
    window.on(name, () => record("window-" + name, { id }));
  window.webContents.on("did-finish-load", () => {
    if (!window.isDestroyed())
      record("did-finish-load", {
        id,
        url: window.webContents.getURL().split(/[?#]/)[0],
      });
  });
  window.webContents.on("did-fail-load", (_event, code, description, url) =>
    record("did-fail-load", {
      id,
      code,
      description,
      url: String(url).split(/[?#]/)[0],
    }),
  );
  window.webContents.on("render-process-gone", (_event, details) =>
    record("render-process-gone", { id, details }),
  );
});
const errorBox = dialog.showErrorBox;
dialog.showErrorBox = function (title, message) {
  record("error-box", { title, message: message.slice(0, 2048) });
  return errorBox.apply(this, arguments);
};
const preferences = require("../../apps/desktop/preferences.cjs");
for (const name of ["collectLegacyPreferences", "restorePreferences"]) {
  const original = preferences[name];
  preferences[name] = async function (...args) {
    record(name + ":start");
    try {
      const value = await original.apply(this, args);
      record(name + ":done");
      return value;
    } catch (error) {
      record(name + ":error", { message: String(error).slice(0, 2048) });
      throw error;
    }
  };
}
const captureModule = require("../../apps/desktop/capture.cjs");
const OriginalCapture = captureModule.DesktopCapture;
globalThis.__captureWindowFixture = { reads: [], fail: false };
captureModule.DesktopCapture = class extends OriginalCapture {
  constructor(options) {
    super({
      ...options,
      runner: async (_command, args) => {
        const state = globalThis.__captureWindowFixture;
        state.reads.push({ visible: options.getWindow().isVisible() });
        if (state.fail) throw new Error("Simulated capture failure");
        await writeFile(
          args.at(-1),
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKp8AAAAASUVORK5CYII=",
            "base64",
          ),
        );
      },
    });
  }
};
require("./production-desktop-entry.cjs");
record("production-entry-loaded");
