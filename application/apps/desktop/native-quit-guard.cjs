const { spawn } = require("node:child_process");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const {
  mkdtempSync,
  openSync,
  writeSync,
  closeSync,
  unlinkSync,
  rmdirSync,
} = require("node:fs");

/** The main JS loop cannot enforce a deadline inside native exit()/atexit.
 * This child has no credentials or application ports. It is armed only AFTER
 * Host receipts/storage have drained and the main Node environment is exiting.
 */
async function prepareNativeQuitGuard() {
  if (process.platform !== "darwin") return undefined;
  const owner = process.pid;
  // An anonymous one-byte file description survives parent JS/IPC teardown.
  // Unlink immediately: no marker path, credential or persistent state remains.
  const directory = mkdtempSync(join(tmpdir(), "morphz-native-quit-"));
  const path = join(directory, "committed");
  const marker = openSync(path, "wx+", 0o600);
  writeSync(marker, Buffer.from([0]), 0, 1, 0);
  unlinkSync(path);
  rmdirSync(directory);
  let markerOpen = true;
  const releaseMarker = () => {
    if (!markerOpen) return;
    closeSync(marker);
    markerOpen = false;
  };
  let child;
  try {
    child = spawn(
      process.execPath,
      [join(__dirname, "native-quit-worker.cjs"), String(owner), "5000"],
      {
        env: { ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "ignore", "ignore", "ipc", marker],
      },
    );
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => failed(new Error("退出保护未能准备完成。")),
        3000,
      );
      const cleanup = () => {
        clearTimeout(timer);
        child.off("error", failed);
        child.off("exit", exited);
        child.off("message", ready);
      };
      const failed = (error) => {
        cleanup();
        reject(error);
      };
      const exited = () => failed(new Error("退出保护进程提前结束。"));
      const ready = (message) => {
        if (message?.type !== "ready" || message.owner !== owner) return;
        cleanup();
        resolve();
      };
      child.once("error", failed);
      child.once("exit", exited);
      child.on("message", ready);
    });
  } catch (error) {
    releaseMarker();
    child?.kill();
    throw error;
  }
  // The guard never keeps an otherwise clean Desktop exit alive. Failure is
  // observable before quit; a late disconnected IPC error must not recurse.
  child.on("error", () => {});
  child.unref();
  child.channel?.unref();
  return {
    arm() {
      if (!markerOpen) return;
      // A child.send() from Node's exit callback can be lost when its IPC
      // handles are torn down immediately afterward. This is a synchronous
      // OS-visible commit, not a timeout around an unfinished application write.
      writeSync(marker, Buffer.from([1]), 0, 1, 0);
      releaseMarker();
    },
    dispose() {
      releaseMarker();
      child.kill();
    },
  };
}
module.exports = { prepareNativeQuitGuard };
