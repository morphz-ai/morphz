const { contextBridge, ipcRenderer } = require("electron");
// Explicit methods only: no raw IPC, Node, filesystems, paths or shell execution.
contextBridge.exposeInMainWorld(
  "morphzDesktop",
  Object.freeze({
    capture: Object.freeze({
      select: () => ipcRenderer.invoke("capture:select"),
      cancel: () => ipcRenderer.invoke("capture:cancel"),
    }),
    voice: Object.freeze({
      requestMicrophone: () => ipcRenderer.invoke("voice:microphone"),
      cancelMicrophone: () => ipcRenderer.invoke("voice:cancel-microphone"),
    }),
    browser: Object.freeze({
      open: (artifactId) => ipcRenderer.invoke("browser:open", artifactId),
      state: () => ipcRenderer.invoke("browser:state"),
      navigate: (pageId, url) =>
        ipcRenderer.invoke("browser:navigate", pageId, url),
      control: (pageId, action) =>
        ipcRenderer.invoke("browser:control", pageId, action),
      layout: (pageId, bounds) =>
        ipcRenderer.invoke("browser:layout", pageId, bounds),
      close: (pageId) => ipcRenderer.invoke("browser:close", pageId),
    }),
    sources: Object.freeze({
      list: () => ipcRenderer.invoke("sources:list"),
      choose: (projectId, kind) =>
        ipcRenderer.invoke("sources:choose", projectId, kind),
      control: (id, action) =>
        ipcRenderer.invoke("sources:control", id, action),
    }),
  }),
);
