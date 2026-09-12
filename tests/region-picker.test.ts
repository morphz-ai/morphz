import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
const { RegionPicker, selectedRegion } = createRequire(import.meta.url)(
  "../apps/desktop/region-picker.cjs",
);

test("划区只接受显示器内的有限有效矩形，保留负坐标和 Retina 逻辑尺寸", () => {
  const bounds = { x: -1440, y: -200, width: 1440, height: 900 };
  assert.deepEqual(
    selectedRegion({ x: 10.5, y: 12.1, width: 300.2, height: 200.3 }, bounds),
    { x: -1430, y: -188, width: 301, height: 201 },
  );
  for (const value of [
    null,
    {},
    { x: -1, y: 0, width: 8, height: 8 },
    { x: 0, y: 0, width: 7, height: 8 },
    { x: 1438, y: 0, width: 8, height: 8 },
    { x: 0, y: 899, width: 8, height: 8 },
    { x: NaN, y: 0, width: 8, height: 8 },
    { x: 0, y: 0, width: Infinity, height: 8 },
  ])
    assert.equal(selectedRegion(value, bounds), null);
});

function fixture() {
  const windows: any[] = [];
  class Window extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: {},
      setWindowOpenHandler() {},
    });
    destroyed = false;
    shown = false;
    focused = false;
    workspaceVisibility: unknown;
    constructor(public options: any) {
      super();
      windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces(visible: boolean, options: unknown) {
      this.workspaceVisibility = { visible, options };
    }
    async loadFile() {}
    showInactive() {
      this.shown = true;
    }
    focus() {
      this.focused = true;
    }
  }
  const ipcMain = new EventEmitter();
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => [
      { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 } },
      { id: 2, bounds: { x: -1280, y: 0, width: 1280, height: 720 } },
    ],
    getCursorScreenPoint: () => ({ x: -100, y: 50 }),
    getDisplayNearestPoint: () => ({ id: 2 }),
  });
  return {
    picker: new RegionPicker({ BrowserWindow: Window, screen, ipcMain }),
    windows,
    ipcMain,
    screen,
  };
}

test("划区等待真实选择，拒绝其他窗口和子框架；先撤掉全部遮罩才交回矩形", async () => {
  const { picker, windows, ipcMain } = fixture();
  const controller = new AbortController();
  const pending = picker.select(controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(windows.length, 2);
  assert.equal(windows[1].focused, true);
  for (const window of windows) {
    assert.deepEqual(window.workspaceVisibility, {
      visible: true,
      options: { visibleOnFullScreen: true, skipTransformProcessType: true },
    });
  }
  assert.equal(
    windows.every(
      (w) =>
        w.shown &&
        w.options.webPreferences.sandbox &&
        !w.options.webPreferences.nodeIntegration,
    ),
    true,
  );
  const rectangle = { x: 100, y: 100, width: 200, height: 150 };
  ipcMain.emit(
    "capture:region:selected",
    { sender: {}, senderFrame: {} },
    rectangle,
  );
  ipcMain.emit(
    "capture:region:selected",
    { sender: windows[1].webContents, senderFrame: {} },
    rectangle,
  );
  assert.equal(
    windows.some((w) => w.destroyed),
    false,
  );
  ipcMain.emit(
    "capture:region:selected",
    {
      sender: windows[1].webContents,
      senderFrame: windows[1].webContents.mainFrame,
    },
    rectangle,
  );
  assert.equal(
    windows.every((w) => w.destroyed),
    true,
  );
  assert.deepEqual(await pending, {
    x: -1180,
    y: 100,
    width: 200,
    height: 150,
  });
  assert.equal(ipcMain.listenerCount("capture:region:selected"), 0);
});

test("取消、显示器变化与迟到选择都不能留下采集或遮罩", async () => {
  for (const cancelBy of ["abort", "display", "escape"] as const) {
    const { picker, windows, ipcMain, screen } = fixture();
    const controller = new AbortController();
    const pending = picker.select(controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    const source = {
      sender: windows[0].webContents,
      senderFrame: windows[0].webContents.mainFrame,
    };
    if (cancelBy === "abort") controller.abort();
    else if (cancelBy === "display") screen.emit("display-metrics-changed");
    else ipcMain.emit("capture:region:cancelled", source);
    ipcMain.emit("capture:region:selected", source, {
      x: 0,
      y: 0,
      width: 30,
      height: 30,
    });
    assert.equal(await pending, null);
    assert.equal(
      windows.every((w) => w.destroyed),
      true,
    );
    assert.equal(ipcMain.eventNames().length, 0);
    assert.equal(screen.eventNames().length, 0);
  }
});
