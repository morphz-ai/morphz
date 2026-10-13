// No Host, database, Runtime, network, credentials or arbitrary target PID.
// An already orphaned child never targets its former parent's PID: getppid
// must still identify the original parent, not merely kill(pid, 0).
const owner = Number(process.argv[2]);
const budget = Number(process.argv[3]);
const { readSync, closeSync } = require("node:fs");
if (
  !process.send ||
  !Number.isSafeInteger(owner) ||
  owner < 2 ||
  owner !== process.ppid ||
  !Number.isInteger(budget) ||
  budget < 50 ||
  budget > 5000
)
  process.exit(1);

let armedAt;
const marker = Buffer.alloc(1);
try {
  if (readSync(4, marker, 0, 1, 0) !== 1 || marker[0] !== 0) process.exit(1);
} catch {
  process.exit(1);
}
// IPC may disconnect during Node teardown BEFORE native threadpool joining.
// Disconnection is not proof that the OS process has exited.
process.on("disconnect", () => {});
setInterval(() => {
  if (process.ppid !== owner) {
    closeSync(4);
    process.exit(0);
  }
  if (armedAt === undefined) {
    try {
      if (readSync(4, marker, 0, 1, 0) === 1 && marker[0] === 1)
        armedAt = performance.now();
    } catch {
      process.exit(1);
    }
  }
  if (armedAt === undefined || performance.now() - armedAt < budget) return;
  try {
    process.kill(owner, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") process.exitCode = 1;
  }
  closeSync(4);
  process.exit();
}, 50);
process.send({ type: "ready", owner });
