const { join } = require("node:path");
const { webPreferences } = require("./security.cjs");

// Only rectangles drawn inside the trusted, display-sized picker are accepted.
// No image is read while the user is deciding what to capture.
function selectedRegion(value, bounds) {
  if (
    !value ||
    !["x", "y", "width", "height"].every((key) => Number.isFinite(value[key]))
  )
    return null;
  const { x, y, width, height } = value;
  if (
    x < 0 ||
    y < 0 ||
    width < 8 ||
    height < 8 ||
    x + width > bounds.width ||
    y + height > bounds.height
  )
    return null;
  const left = Math.floor(x),
    top = Math.floor(y);
  return {
    x: bounds.x + left,
    y: bounds.y + top,
    width: Math.ceil(x + width) - left,
    height: Math.ceil(y + height) - top,
  };
}

class RegionPicker {
  constructor({ BrowserWindow, screen, ipcMain }) {
    this.BrowserWindow = BrowserWindow;
    this.screen = screen;
    this.ipcMain = ipcMain;
    this.active = null;
  }
  async select(signal) {
    if (signal.aborted) return null;
    if (this.active) throw new Error("已有截图选择正在进行。");
    const records = [];
    let finished = false;
    let resolveResult;
    const result = new Promise((resolve) => {
      resolveResult = resolve;
    });
    const selected = "capture:region:selected";
    const cancelled = "capture:region:cancelled";
    const owner = (event) =>
      records.find(
        ({ window }) =>
          !window.isDestroyed() &&
          event.sender === window.webContents &&
          event.senderFrame === window.webContents.mainFrame,
      );
    const finish = (region = null) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      this.ipcMain.removeListener(selected, onSelected);
      this.ipcMain.removeListener(cancelled, onCancelled);
      this.screen.removeListener("display-added", abort);
      this.screen.removeListener("display-removed", abort);
      this.screen.removeListener("display-metrics-changed", abort);
      for (const { window } of records) {
        if (!window.isDestroyed()) window.destroy();
      }
      this.active = null;
      // Allow the OS compositor to remove all picker windows before reading pixels.
      if (region)
        setTimeout(() => resolveResult(signal.aborted ? null : region), 100);
      else resolveResult(null);
    };
    const abort = () => finish();
    const onSelected = (event, value) => {
      const record = owner(event);
      if (!record) return;
      const region = selectedRegion(value, record.bounds);
      if (region) finish(region);
    };
    const onCancelled = (event) => {
      if (owner(event)) finish();
    };
    this.active = { cancel: abort };
    signal.addEventListener("abort", abort, { once: true });
    this.ipcMain.on(selected, onSelected);
    this.ipcMain.on(cancelled, onCancelled);
    this.screen.on("display-added", abort);
    this.screen.on("display-removed", abort);
    this.screen.on("display-metrics-changed", abort);
    try {
      const displays = this.screen.getAllDisplays();
      if (!displays.length) throw new Error("没有可用的截图屏幕。");
      const activeDisplay = this.screen.getDisplayNearestPoint(
        this.screen.getCursorScreenPoint(),
      );
      await Promise.all(
        displays.map(async ({ id, bounds }) => {
          const window = new this.BrowserWindow({
            ...bounds,
            title: "截图选区 — Morphz",
            show: false,
            frame: false,
            transparent: true,
            backgroundColor: "#00000000",
            hasShadow: false,
            resizable: false,
            movable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            skipTaskbar: true,
            acceptFirstMouse: true,
            enableLargerThanScreen: true,
            webPreferences: {
              ...webPreferences,
              preload: join(__dirname, "region-picker-preload.cjs"),
              zoomFactor: 1,
            },
          });
          records.push({ window, bounds, id });
          window.setAlwaysOnTop(true, "screen-saver");
          // The picker is an auxiliary window, not an auxiliary application.
          // Electron's default process transformation hides the whole app's Dock
          // entry and can outlive this short-lived window.
          window.setVisibleOnAllWorkspaces(true, {
            visibleOnFullScreen: true,
            skipTransformProcessType: true,
          });
          window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
          window.webContents.on("will-navigate", (event) =>
            event.preventDefault(),
          );
          window.webContents.on("will-attach-webview", (event) =>
            event.preventDefault(),
          );
          window.webContents.on("render-process-gone", abort);
          window.on("closed", abort);
          await window.loadFile(join(__dirname, "region-picker.html"));
        }),
      );
      if (!finished) {
        for (const { window } of records) window.showInactive();
        (
          records.find(({ id }) => id === activeDisplay.id) ?? records[0]
        ).window.focus();
      }
    } catch (error) {
      if (finished) return result;
      finish();
      throw error;
    }
    return result;
  }
}

module.exports = { RegionPicker, selectedRegion };
