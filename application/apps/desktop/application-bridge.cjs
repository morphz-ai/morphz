// Register only the application contract. This module never opens a listener or exposes paths/SQL.
function registerApplicationBridge(
  ipcMain,
  connection,
  requireMain,
  persistAuthentication = () => {},
) {
  ipcMain.handle("application:invoke", async (event, request) => {
    requireMain(event);
    const result = await connection.invoke(request);
    requireMain(event);
    if (result.ok && ["login", "logout"].includes(request?.method))
      persistAuthentication();
    return result;
  });
  ipcMain.on("application:cancel", (event, id) => {
    try {
      requireMain(event);
      connection.cancel(id);
    } catch {}
  });
  ipcMain.handle(
    "application:subscribe",
    async (event, id, scope, generation) => {
      requireMain(event);
      const send = (value) => {
        try {
          requireMain(event);
          event.senderFrame.send("application:stream", { id, ...value });
        } catch {
          connection.unobserve(id);
        }
      };
      await connection.observe(
        id,
        scope,
        generation,
        (value) => send({ value }),
        () => send({ closed: true }),
      );
      requireMain(event);
    },
  );
  ipcMain.on("application:unsubscribe", (event, id) => {
    try {
      requireMain(event);
      connection.unobserve(id);
    } catch {}
  });
}
module.exports = { registerApplicationBridge };
