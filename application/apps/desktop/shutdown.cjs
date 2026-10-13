/** One quit barrier: no timeout can bypass an unresolved Host write/receipt. */
function registerDesktopShutdown({
  app,
  hasApplication,
  close,
  flush,
  prepareGuard,
  reportFailure,
  exitEvents = process,
}) {
  let closing = false;
  let prepared = false;
  let guard;
  app.on("before-quit", (event) => {
    if (!hasApplication() || prepared) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    void (async () => {
      await close();
      await flush();
      guard = await prepareGuard();
      prepared = true;
      // Never re-enter the cancelled native before-quit callback.
      setImmediate(() => app.quit());
    })().catch((error) => {
      guard?.dispose();
      guard = undefined;
      closing = false;
      reportFailure(error);
    });
  });
  exitEvents.on("exit", () => {
    // Electron can tear down Node and emit process exit BEFORE app's quit
    // event. This terminal Node lifecycle cannot be vetoed by window close or
    // will-quit; an unprepared/failed Host never arms the native fallback.
    if (prepared) guard?.arm();
  });
}
module.exports = { registerDesktopShutdown };
