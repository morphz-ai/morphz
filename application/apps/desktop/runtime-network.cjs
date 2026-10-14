/** Desktop Runtime traffic uses Chromium's network service, never the Node
 * fetch body channel which can remain stalled in a long-lived Electron main
 * process. A separate non-persistent Session carries no browsing cookies or
 * custom application protocols. This adapter does not retry any request. */
function createDesktopRuntimeRequest(runtimeSession) {
  return (input, init) =>
    runtimeSession.fetch(input, {
      ...init,
      credentials: "omit",
      cache: "no-store",
      bypassCustomProtocolHandlers: true,
    });
}
module.exports = { createDesktopRuntimeRequest };
