// Isolated spawned test process, never a user Desktop/profile or Runtime.
const { spawn } = require("node:child_process");
const {
  mkdtempSync,
  openSync,
  writeSync,
  closeSync,
  unlinkSync,
  rmdirSync,
} = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const mode = process.argv[3];
if (!["wedged", "unarmed", "wrong-owner", "normal"].includes(mode))
  process.exit(1);
const directory = mkdtempSync(join(tmpdir(), "morphz-test-quit-"));
const path = join(directory, "marker");
const marker = openSync(path, "wx+", 0o600);
writeSync(marker, Buffer.from([0]), 0, 1, 0);
unlinkSync(path);
rmdirSync(directory);
const child = spawn(
  process.execPath,
  [process.argv[2], String(process.pid), "150"],
  {
    stdio: ["ignore", "ignore", "inherit", "ipc", marker],
    env: {},
  },
);
child.on("message", (message) => {
  if (message?.type !== "ready" || message.owner !== process.pid) return;
  console.log("worker:" + child.pid);
  if (mode === "wedged" || mode === "normal") {
    writeSync(marker, Buffer.from([1]), 0, 1, 0);
    console.log("clean-quit-confirmed");
  } else if (mode === "wrong-owner") {
    child.send({ type: "committed-quit", owner: process.pid + 1 });
  }
  closeSync(marker);
  child.disconnect();
  if (mode === "wedged")
    setTimeout(() => {
      for (;;) {}
    }, 25);
  else setTimeout(() => process.exit(0), mode === "normal" ? 25 : 350);
});
