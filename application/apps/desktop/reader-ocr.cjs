const { randomUUID } = require("node:crypto");
const { join } = require("node:path");

/** Dedicated, disposable sandbox. No profile, app API, user cookies or network access. */
function createReadingOcrEngine({
  BrowserWindow,
  session,
  ipcMain,
  resources,
  preload = join(__dirname, "reader-ocr-preload.cjs"),
}) {
  return async (request, signal) => {
    signal.throwIfAborted();
    const isolated = session.fromPartition(`morphz-ocr-${randomUUID()}`);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) =>
      callback({
        cancel:
          !details.url.startsWith("morphz://app/") &&
          !details.url.startsWith("blob:morphz://app/"),
      }),
    );
    isolated.on("will-download", (event) => event.preventDefault());
    await isolated.protocol.handle("morphz", async (req) => {
      const url = new URL(req.url);
      if (url.host !== "app" || req.method !== "GET")
        return new Response("Forbidden", { status: 403 });
      const model = /^\/ocr-model\/([01])\.tar$/.exec(url.pathname);
      if (model)
        return new Response(new Uint8Array(request.models[Number(model[1])]), {
          headers: {
            "Content-Type": "application/octet-stream",
            "Cache-Control": "no-store",
          },
        });
      if (
        url.pathname !== "/ocr.html" &&
        !/^\/(assets|pdfjs|ocr-runtime)\//.test(url.pathname)
      )
        return new Response("Forbidden", { status: 403 });
      const response = await resources(req);
      const headers = new Headers(response.headers);
      // OpenCV's generated bindings use Function constructors. This exception
      // applies only to this disposable, network/API-denied sandbox, never the app.
      headers.set(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' data:; img-src blob: data:; font-src 'self' blob:; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'",
      );
      return new Response(response.body, { status: response.status, headers });
    });
    const channel = `morphz-reader-ocr-${randomUUID()}`;
    const window = new BrowserWindow({
      show: false,
      width: 400,
      height: 400,
      webPreferences: {
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        session: isolated,
        preload,
        backgroundThrottling: false,
        additionalArguments: [`--morphz-ocr-channel=${channel}`],
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (e) => e.preventDefault());
    window.webContents.on("will-attach-webview", (e) => e.preventDefault());
    try {
      return await new Promise((accept, reject) => {
        let sent = false,
          settled = false;
        const finish = (error, result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", cancel);
          ipcMain.removeHandler(channel);
          error ? reject(error) : accept(result);
        };
        const cancel = () => finish(new Error("OCR cancelled"));
        const timer = setTimeout(
          () => finish(new Error("OCR deadline exceeded")),
          90_000,
        );
        signal.addEventListener("abort", cancel, { once: true });
        ipcMain.handle(channel, (event, message) => {
          if (
            event.sender !== window.webContents ||
            event.senderFrame !== event.sender.mainFrame ||
            event.senderFrame.url !== "morphz://app/ocr.html"
          )
            throw new Error("Untrusted OCR sender");
          if (message?.type === "failed") {
            finish(new Error("Local OCR initialization failed"));
            return;
          }
          if (message?.type === "ready" && !sent) {
            sent = true;
            return { pdf: request.pdf, page: request.page };
          }
          if (!sent) throw new Error("OCR not initialized");
          if (
            message?.type === "result" &&
            JSON.stringify(message.result).length <= 2_000_000
          )
            finish(null, message.result);
          else finish(new Error("Local OCR failed"));
        });
        window.webContents.once("render-process-gone", () =>
          finish(new Error("OCR process ended")),
        );
        window.once("closed", () => finish(new Error("OCR window closed")));
        void window
          .loadURL("morphz://app/ocr.html")
          .catch((error) => finish(error));
        if (signal.aborted) cancel();
      });
    } finally {
      if (!window.isDestroyed()) window.destroy();
      isolated.protocol.unhandle("morphz");
      await isolated.clearCache();
    }
  };
}
module.exports = { createReadingOcrEngine };
