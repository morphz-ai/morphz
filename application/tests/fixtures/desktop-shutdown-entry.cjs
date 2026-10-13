// Actual production entry, with one isolated native-exit fault injection.
require("./production-desktop-entry.cjs");
process.on("exit", () => console.log("MORPHZ_SHUTDOWN_COMMITTED"));
if (process.env.MORPHZ_TEST_QUIT_NATIVE_HANG === "1")
  process.once("exit", () => {
    // Host cleanup, storage flush and Electron quit have ALREADY completed.
    // The independent guard must work after the main event loop is gone.
    const until = performance.now() + 10000;
    while (performance.now() < until) {}
  });
