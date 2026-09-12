// Minimal isolated harness; --production smoke tests exercise the real entry.
const {
  app,
  BrowserWindow,
  protocol,
  ipcMain,
  session,
  nativeTheme,
} = require("electron");
const { join, basename, isAbsolute } = require("node:path");
const { lstatSync } = require("node:fs");
const root = join(__dirname, "../..");
const fixture = process.env.MORPHZWORK_EMBEDDED_FIXTURE;
if (
  !fixture ||
  !isAbsolute(fixture) ||
  !basename(fixture).startsWith("morphz-embedded-electron-") ||
  !lstatSync(fixture).isDirectory()
)
  throw new Error(
    "This entry requires an isolated generated fixture directory",
  );
require(join(root, "apps/desktop/stdio.cjs")).protectStandardStreams();
const { webPreferences, trustedMainURL } = require(
  join(root, "apps/desktop/security.cjs"),
);
const { registerApplicationBridge } = require(
  join(root, "apps/desktop/application-bridge.cjs"),
);
const { DesktopAppearance, windowAppearanceOptions } = require(
  join(root, "apps/desktop/appearance.cjs"),
);
app.setPath("userData", join(fixture, "profile"));
app.setName("Morphz Embedded Fixture");
app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  {
    scheme: "morphz",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);
// Fail the test immediately if an application module attempts to open a TCP service.
const originalListen = require("node:net").Server.prototype.listen;
require("node:net").Server.prototype.listen = function (...args) {
  if (typeof args[0] !== "string")
    throw new Error("Embedded Desktop must not listen on TCP");
  return originalListen.apply(this, args);
};
let host,
  window,
  closing = false;
app
  .whenReady()
  .then(async () => {
    const { openEmbeddedApplication, embeddedResources } = await import(
      join(root, "dist/service/apps/desktop/application-host.js")
    );
    host = await openEmbeddedApplication(
      join(fixture, "data"),
      app.getPath("userData"),
    );
    const partition = "persist:fixture-app",
      appSession = session.fromPartition(partition);
    appSession.protocol.handle(
      "morphz",
      embeddedResources(join(root, "dist/web"), host.connection),
    );
    const appearanceOptions = windowAppearanceOptions(nativeTheme);
    window = new BrowserWindow({
      width: 1280,
      height: 900,
      ...appearanceOptions,
      webPreferences: {
        ...webPreferences,
        partition,
        preload: join(root, "apps/desktop/preload.cjs"),
        additionalArguments: ["--morphz-application-bridge"],
      },
    });
    const appearance = new DesktopAppearance(
      window,
      nativeTheme,
      process.platform,
      appearanceOptions,
    );
    const requireMain = (event) => {
      if (
        event.sender !== window.webContents ||
        event.senderFrame !== event.sender.mainFrame ||
        !trustedMainURL(event.senderFrame.url, "morphz://app")
      )
        throw new Error("Untrusted frame");
    };
    registerApplicationBridge(ipcMain, host.connection, requireMain, () =>
      host.persistAuthentication(),
    );
    ipcMain.handle("appearance:mode", (event, mode) => {
      requireMain(event);
      return appearance.setMode(mode);
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (!trustedMainURL(url, "morphz://app")) event.preventDefault();
    });
    appSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    appSession.setPermissionCheckHandler(() => false);
    window.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isInPlace)
        host.connection.invalidate();
    });
    await window.loadURL("morphz://app/");
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
app.on("before-quit", (event) => {
  if (!closing && host) {
    event.preventDefault();
    closing = true;
    void host.close().finally(() => app.quit());
  }
});
