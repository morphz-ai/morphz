import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(import.meta.url);
const path = require.resolve("../apps/desktop/stdio.cjs");
const { protectStandardStreams } = require(path);

test("桌面日志仅忽略已关闭管道，不吞掉其他错误，可解除监听", () => {
  const stream = new EventEmitter();
  const release = protectStandardStreams([stream]);
  assert.doesNotThrow(() =>
    stream.emit("error", Object.assign(new Error("closed"), { code: "EPIPE" })),
  );
  const other = Object.assign(new Error("disk failure"), { code: "EIO" });
  assert.throws(
    () => stream.emit("error", other),
    (error) => error === other,
  );
  release();
  assert.equal(stream.listenerCount("error"), 0);
});

test("启动者关闭 stdout/stderr 后，桌面仍能处理日志并正常退出", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    require(${JSON.stringify(path)}).protectStandardStreams();
    process.on('message', () => {
      console.log('late log'); console.error('late IPC error');
      setTimeout(() => { process.send('alive'); process.disconnect(); }, 30);
    });
    process.send('ready');
  `,
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  let survived = false;
  child.on("message", (message) => {
    if (message === "ready") {
      child.stdout!.destroy();
      child.stderr!.destroy();
      child.send("closed");
    } else if (message === "alive") survived = true;
  });
  const exit = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exit, 0);
  assert.equal(survived, true);
});
