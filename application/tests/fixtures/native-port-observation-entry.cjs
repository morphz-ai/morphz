// Automated scheduling counterexample only. No Host, Runtime, credentials,
// network or business database, and no production window/throttling changes.
const { app, BrowserWindow, session } = require("electron");
const { basename, isAbsolute } = require("node:path");
const { lstatSync } = require("node:fs");
const profile = process.env.MORPHZ_NATIVE_PORT_OBSERVATION_PROFILE;
if (
  !profile ||
  !isAbsolute(profile) ||
  !basename(profile).startsWith("morphz-native-port-observation-") ||
  !lstatSync(profile).isDirectory()
)
  throw new Error("An isolated native port-observation profile is required");
app.setPath("userData", profile);
app.setName("Morphz automated native port observation");
app.enableSandbox();
app.whenReady().then(async () => {
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  const isolated = session.fromPartition("native-port-observation-fixture");
  isolated.setPermissionRequestHandler((_contents, _permission, done) =>
    done(false),
  );
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, done) =>
    done({ cancel: !details.url.startsWith("data:") }),
  );
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      session: isolated,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const html = `<!doctype html><meta charset="utf-8"><title>Isolated port observation</title><script>
    const frames = new Map();
    let nextFrame = 0, executedFrames = 0, oldChecks = 0;
    let deliveredStateReads = 0, creditStateReads = 0;
    // Installed before Playwright's first injected script captures the APIs.
    // Hold, do not synthesize, animation frames; native MessagePort still runs.
    window.requestAnimationFrame = callback => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = id => frames.delete(id);
    const report = { wires: [], credits: [] };
    const channel = new MessageChannel();
    channel.port1.onmessage = event => {
      if (event.data.kind === "credit") report.credits.push(event.data.sequence);
      else report.wires.push(event.data);
    };
    window.nativeDocumentHost = {
      report() {
        return {
          get wires() {
            deliveredStateReads++;
            return structuredClone(report.wires);
          },
          get credits() {
            creditStateReads++;
            return structuredClone(report.credits);
          },
        };
      },
    };
    window.nativePortObservationControl = {
      oldCheck() { oldChecks++; },
      observation() {
        return { pendingFrames: frames.size, executedFrames, oldChecks,
          deliveredStateReads, creditStateReads,
          delivered: report.wires.length, credited: report.credits.length,
          visibility: document.visibilityState };
      },
      send() {
        channel.port2.postMessage({type: "delivered", kind: "init"});
        channel.port2.postMessage({kind: "credit", sequence: 1});
      },
      releaseFrames() {
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) {
          executedFrames++;
          callback(performance.now());
        }
      },
    };
  </script>`;
  await window.loadURL(
    "data:text/html;charset=utf-8," + encodeURIComponent(html),
  );
});
app.on("window-all-closed", () => app.quit());
