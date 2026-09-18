import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, readdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const { DesktopCapture } = createRequire(import.meta.url)(
  "../apps/desktop/capture.cjs",
);
const region = { x: 10, y: 20, width: 100, height: 80 };

async function fixture(
  overrides: {
    settle?(): Promise<void>;
    choose?(signal: AbortSignal): Promise<typeof region | null>;
    read?(): Promise<void>;
  } = {},
) {
  const temporary = await mkdtemp(join(tmpdir(), "morphz-capture-window-"));
  const events: string[] = [];
  class Window extends EventEmitter {
    visible = true;
    destroyed = false;
    isVisible() {
      return this.visible;
    }
    isDestroyed() {
      return this.destroyed;
    }
    hide() {
      this.visible = false;
      events.push("hide");
    }
    show() {
      this.visible = true;
      events.push("show");
    }
    close() {
      this.emit("close");
      this.destroyed = true;
      this.emit("closed");
    }
  }
  const window = new Window();
  const capture = new DesktopCapture({
    platform: "darwin",
    temporary,
    getWindow: () => window,
    settleWindow: async () => {
      events.push("settle");
      await overrides.settle?.();
    },
    chooseRegion: async (signal: AbortSignal) => {
      events.push(`choose:${window.visible}`);
      return overrides.choose ? overrides.choose(signal) : region;
    },
    runner: async (_command: string, args: string[]) => {
      events.push(`read:${window.visible}`);
      await overrides.read?.();
      await writeFile(
        args.at(-1)!,
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
      );
    },
  });
  return {
    capture,
    window,
    events,
    temporary,
    async dispose() {
      capture.cancel();
      await rm(temporary, { recursive: true, force: true });
    },
  };
}

test("普通截图不隐藏窗口；修饰键截图等待窗口撤下，读取像素完成才恢复", async () => {
  const f = await fixture();
  try {
    await f.capture.select();
    assert.deepEqual(f.events, ["choose:true", "read:true"]);
    f.events.length = 0;
    await f.capture.select({ hideWindow: true });
    assert.deepEqual(f.events, [
      "hide",
      "settle",
      "choose:false",
      "read:false",
      "show",
    ]);
    assert.equal(f.window.visible, true);
    assert.equal(f.capture.active, null);
    assert.equal(f.capture.hiddenWindow, null);
    assert.equal(f.window.listenerCount("close"), 0);
    assert.deepEqual(await readdir(f.temporary), []);
  } finally {
    await f.dispose();
  }
});

test("选区取消、采集失败和超时均恢复本次隐藏的窗口", async (t) => {
  for (const outcome of ["cancel", "error", "timeout"] as const) {
    await t.test(outcome, async () => {
      const f = await fixture({
        choose: async () => (outcome === "cancel" ? null : region),
        read: async () => {
          throw Object.assign(new Error("fixture failure"), {
            killed: outcome === "timeout",
          });
        },
      });
      try {
        const pending = f.capture.select({ hideWindow: true });
        if (outcome === "cancel") assert.equal(await pending, null);
        else
          await assert.rejects(
            pending,
            outcome === "timeout" ? /超时/ : /未成功/,
          );
        assert.equal(f.events.at(-1), "show");
        assert.equal(f.window.visible, true);
        assert.equal(f.capture.active, null);
        assert.equal(f.capture.hiddenWindow, null);
        assert.deepEqual(await readdir(f.temporary), []);
      } finally {
        await f.dispose();
      }
    });
  }
});

test("窗口隐藏过渡期间取消不打开迟到选择器，并恢复原窗口", async () => {
  let settle!: () => void;
  const f = await fixture({
    settle: () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  });
  try {
    const pending = f.capture.select({ hideWindow: true });
    assert.equal(f.window.visible, false);
    f.capture.cancel();
    settle();
    assert.equal(await pending, null);
    assert.deepEqual(f.events, ["hide", "settle", "show"]);
  } finally {
    await f.dispose();
  }
});

test("重复请求不能恢复进行中的隐藏窗口，原请求取消后可重新截图", async () => {
  let choose!: (value: typeof region | null) => void;
  const f = await fixture({
    choose: () =>
      new Promise((resolve) => {
        choose = resolve;
      }),
  });
  try {
    const pending = f.capture.select({ hideWindow: true });
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(f.capture.select({ hideWindow: true }), /已有截图/);
    assert.equal(f.window.visible, false);
    assert.equal(f.events.includes("show"), false);
    f.capture.cancel();
    choose(region);
    assert.equal(await pending, null);
    assert.equal(
      f.events.some((event) => event.startsWith("read:")),
      false,
    );
    assert.equal(f.window.visible, true);
    const next = f.capture.select({ hideWindow: false });
    choose(null);
    assert.equal(await next, null);
  } finally {
    await f.dispose();
  }
});

test("截图期间关闭的窗口不会复活，原本不可见的窗口不会被擅自显示", async () => {
  let settle!: () => void;
  const f = await fixture({
    settle: () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  });
  try {
    const pending = f.capture.select({ hideWindow: true });
    f.window.close();
    settle();
    assert.equal(await pending, null);
    assert.deepEqual(f.events, ["hide", "settle"]);
    assert.equal(f.capture.hiddenWindow, null);
    assert.equal(f.window.listenerCount("close"), 0);
  } finally {
    await f.dispose();
  }
  const hidden = await fixture();
  try {
    hidden.window.visible = false;
    await hidden.capture.select({ hideWindow: true });
    assert.deepEqual(hidden.events, ["choose:false", "read:false"]);
    assert.equal(hidden.window.visible, false);
  } finally {
    await hidden.dispose();
  }
});

test("截图选项严格校验，未支持的平台在隐藏窗口之前明确拒绝", async () => {
  const f = await fixture();
  try {
    for (const options of [
      null,
      true,
      [],
      { hideWindow: "true" },
      { path: "/tmp" },
    ])
      await assert.rejects(f.capture.select(options), /选项无效/);
    for (const platform of ["win32", "linux"]) {
      f.capture.platform = platform;
      await assert.rejects(
        f.capture.select({ hideWindow: true }),
        /仅接入 macOS/,
      );
    }
    assert.deepEqual(f.events, []);
    assert.equal(f.window.visible, true);
  } finally {
    await f.dispose();
  }
});

test("桌面 preload 只通过现有截图 IPC 传递本次隐藏选项", async () => {
  let bridge: any;
  const calls: unknown[] = [];
  runInNewContext(
    await readFile(
      new URL("../apps/desktop/preload.cjs", import.meta.url),
      "utf8",
    ),
    {
      process: { argv: [] },
      require: (name: string) => {
        assert.equal(name, "electron");
        return {
          contextBridge: {
            exposeInMainWorld: (_name: string, value: unknown) => {
              bridge = value;
            },
          },
          ipcRenderer: {
            invoke: (...args: unknown[]) => {
              calls.push(args);
              return Promise.resolve(null);
            },
          },
        };
      },
    },
  );
  await bridge.capture.select({ hideWindow: true });
  await bridge.capture.select();
  await bridge.capture.cancel();
  assert.deepEqual(calls, [
    ["capture:select", { hideWindow: true }],
    ["capture:select", undefined],
    ["capture:cancel"],
  ]);
});
