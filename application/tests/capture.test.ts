import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { DesktopCapture } = createRequire(import.meta.url)(
  "../apps/desktop/capture.cjs",
);
test("自绘选区确认前不读取像素，确认后只读取选定范围，取消不启动截图", async () => {
  const temporary = await mkdtemp(
    join(tmpdir(), "morphz-application-region-unit-"),
  );
  let choose!: (value: unknown) => void;
  let calls = 0;
  const capture = new DesktopCapture({
    platform: "darwin",
    temporary,
    chooseRegion: () =>
      new Promise((resolve) => {
        choose = resolve;
      }),
    runner: async (_command: string, args: string[]) => {
      calls++;
      assert.deepEqual(args.slice(0, -1), [
        "-R",
        "-1180,100,200,150",
        "-x",
        "-t",
        "png",
      ]);
      await writeFile(
        args.at(-1)!,
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
      );
    },
  });
  try {
    const pending = capture.select();
    assert.equal(calls, 0);
    assert.deepEqual(await readdir(temporary), []);
    choose({ x: -1180, y: 100, width: 200, height: 150 });
    assert.equal((await pending).mime, "image/png");
    assert.equal(calls, 1);
    const cancelled = capture.select();
    choose(null);
    assert.equal(await cancelled, null);
    assert.equal(calls, 1);
    const late = capture.select();
    capture.cancel();
    choose({ x: -1180, y: 100, width: 200, height: 150 });
    assert.equal(await late, null);
    assert.equal(calls, 1);
    assert.deepEqual(await readdir(temporary), []);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
test("截图必须交互选择，只返回本次 PNG，并清理临时文件", async () => {
  const temporary = await mkdtemp(
    join(tmpdir(), "morphz-application-capture-unit-"),
  );
  try {
    const service = new DesktopCapture({
      platform: "darwin",
      temporary,
      runner: async (command: string, args: string[]) => {
        assert.equal(command, "/usr/sbin/screencapture");
        assert.deepEqual(args.slice(0, 4), ["-i", "-x", "-t", "png"]);
        await writeFile(
          args.at(-1)!,
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
        );
      },
    });
    assert.equal((await service.select()).mime, "image/png");
    assert.deepEqual(await readdir(temporary), []);
    const unsupported = new DesktopCapture({ platform: "linux" });
    await assert.rejects(() => unsupported.select(), /macOS/);
    const cancelled = new DesktopCapture({
      platform: "darwin",
      temporary,
      runner: async () => {
        throw Object.assign(new Error("cancel"), { code: 1 });
      },
    });
    assert.equal(await cancelled.select(), null);
    assert.deepEqual(await readdir(temporary), []);
    const rejected = new DesktopCapture({
      platform: "darwin",
      temporary,
      runner: async (_command: string, args: string[]) => {
        await writeFile(args.at(-1)!, Buffer.alloc(6 * 1024 * 1024 + 1));
      },
    });
    await assert.rejects(() => rejected.select(), /6 MB/);
    assert.deepEqual(await readdir(temporary), []);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("截图取消会中止在途选择、清理临时文件并允许再次选择", async () => {
  const temporary = await mkdtemp(
    join(tmpdir(), "morphz-application-capture-cancel-unit-"),
  );
  let signalStarted!: () => void;
  const started = {
    promise: new Promise<void>((resolve) => {
      signalStarted = resolve;
    }),
    resolve: () => signalStarted(),
  };
  let first = true;
  const capture = new DesktopCapture({
    platform: "darwin",
    temporary,
    runner: async (
      _command: string,
      args: string[],
      options: { signal: AbortSignal },
    ) => {
      if (!first) {
        await writeFile(
          args.at(-1)!,
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
        );
        return;
      }
      first = false;
      const interrupted = new Promise<void>((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () =>
            reject(
              Object.assign(new Error("cancelled"), { name: "AbortError" }),
            ),
          { once: true },
        );
      });
      started.resolve();
      await interrupted;
    },
  });
  try {
    const pending = capture.select();
    await started.promise;
    await assert.rejects(() => capture.select(), /已有截图选择/);
    capture.cancel();
    assert.equal(await pending, null);
    assert.deepEqual(await readdir(temporary), []);
    assert.equal((await capture.select()).mime, "image/png");
    assert.deepEqual(await readdir(temporary), []);
  } finally {
    capture.cancel();
    await rm(temporary, { recursive: true, force: true });
  }
});
