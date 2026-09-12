const { contextBridge, ipcRenderer } = require("electron");
// Explicit methods only: no raw IPC, Node, filesystems, paths or shell execution.
contextBridge.exposeInMainWorld(
  "morphzDesktop",
  Object.freeze({
    // Only an explicitly trusted application entry opts in. The main process
    // selects local business calls or the private remote HTTP adapter.
    application: process.argv.includes("--morphz-application-bridge")
      ? Object.freeze({
          invoke: (request) =>
            ipcRenderer.invoke("application:invoke", request),
          cancel: (id) => ipcRenderer.send("application:cancel", id),
          subscribe: (id, scope, generation) =>
            ipcRenderer.invoke("application:subscribe", id, scope, generation),
          unsubscribe: (id) => ipcRenderer.send("application:unsubscribe", id),
          onStream: (callback) => {
            const receive = (_event, value) => callback(value);
            ipcRenderer.on("application:stream", receive);
            return () =>
              ipcRenderer.removeListener("application:stream", receive);
          },
        })
      : undefined,
    appearance: Object.freeze({
      setMode: (mode) => ipcRenderer.invoke("appearance:mode", mode),
      onChange: (callback) => {
        const receive = (_event, state) => callback(state);
        ipcRenderer.on("appearance:changed", receive);
        return () => ipcRenderer.removeListener("appearance:changed", receive);
      },
    }),
    openExternal: (url) => ipcRenderer.invoke("open-external", url),
    capture: Object.freeze({
      select: (options) => ipcRenderer.invoke("capture:select", options),
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
