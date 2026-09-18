const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("regionPicker", {
  select: (rectangle) => ipcRenderer.send("capture:region:selected", rectangle),
  cancel: () => ipcRenderer.send("capture:region:cancelled"),
});
