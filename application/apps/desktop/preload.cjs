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
    scriptExports: process.argv.includes("--morphz-application-bridge")
      ? Object.freeze({
          save: (request) => ipcRenderer.invoke("script-exports:save", request),
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
      visibility: (pageId, visible) =>
        ipcRenderer.invoke("browser:visibility", pageId, visible),
      onInput: (callback) => {
        const receive = () => callback();
        ipcRenderer.on("browser:input", receive);
        return () => ipcRenderer.removeListener("browser:input", receive);
      },
      onSelection: (callback) => {
        const receive = (_event, selection) => callback(selection);
        ipcRenderer.on("browser:selection", receive);
        return () => ipcRenderer.removeListener("browser:selection", receive);
      },
      reveal: (pageId, request) =>
        ipcRenderer.invoke("browser:reveal", pageId, request),
      close: (pageId) => ipcRenderer.invoke("browser:close", pageId),
    }),
    directories: Object.freeze({
      choose: (projectId, conversationId) =>
        ipcRenderer.invoke("directories:choose", projectId, conversationId),
    }),
    files: Object.freeze({
      choose: (projectId, kind) =>
        ipcRenderer.invoke("files:choose", projectId, kind),
      read: (request) => ipcRenderer.invoke("files:read", request),
      revoke: (request) => ipcRenderer.invoke("files:revoke", request),
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
