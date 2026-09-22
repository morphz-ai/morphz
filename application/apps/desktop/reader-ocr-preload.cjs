const { contextBridge, ipcRenderer } = require("electron");
const channel = process.argv
  .find((v) => v.startsWith("--morphz-ocr-channel="))
  ?.slice("--morphz-ocr-channel=".length);
if (channel)
  contextBridge.exposeInMainWorld("readingOcr", {
    input: () => ipcRenderer.invoke(channel, { type: "ready" }),
    result: (result) => ipcRenderer.invoke(channel, { type: "result", result }),
    failed: () => ipcRenderer.invoke(channel, { type: "failed" }),
  });
if (channel) {
  window.addEventListener(
    "error",
    () => void ipcRenderer.invoke(channel, { type: "failed" }).catch(() => {}),
  );
  window.addEventListener(
    "unhandledrejection",
    () => void ipcRenderer.invoke(channel, { type: "failed" }).catch(() => {}),
  );
}
