// Hidden automated renderer only: no Host, Runtime, database or real credential.
const { app, BrowserWindow, session } = require("electron");
const { basename, isAbsolute } = require("node:path");
const { lstatSync } = require("node:fs");
const profile = process.env.MORPHZ_CREATION_NATIVE_PROFILE;
const url = new URL(process.env.MORPHZ_CREATION_NATIVE_URL);
if (
  !profile ||
  !isAbsolute(profile) ||
  !basename(profile).startsWith("morphz-creation-native-profile-") ||
  !lstatSync(profile).isDirectory() ||
  url.protocol !== "http:" ||
  url.hostname !== "127.0.0.1" ||
  url.pathname !== "/__new-menu-native"
)
  throw new Error("An isolated native creation-menu fixture is required");
app.setPath("userData", profile);
app.setName("Morphz automated creation-menu fixture");
app.enableSandbox();
app.whenReady().then(async () => {
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  const isolated = session.fromPartition("persist:creation-menu-fixture");
  isolated.setPermissionRequestHandler((_contents, _permission, done) =>
    done(false),
  );
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, done) => {
    const target = new URL(details.url);
    const local =
      target.hostname === url.hostname &&
      target.port === url.port &&
      ["http:", "ws:"].includes(target.protocol);
    done({ cancel: !local && target.protocol !== "data:" });
  });
  const window = new BrowserWindow({
    width: 760,
    height: 850,
    useContentSize: true,
    show: false,
    webPreferences: {
      session: isolated,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await window.loadURL(url.href);
});
app.on("window-all-closed", () => app.quit());
