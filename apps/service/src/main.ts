import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDirectory } from "./paths.js";
import { WorkspaceStore } from "./store.js";
import { createAppServer } from "./http.js";
import { loadRuntimeConfig, RuntimeBridge } from "./runtime.js";
import { loadServiceEnvironment } from "./environment.js";
import { prepareHostTools, runtimeAgentTools } from "./agent-tools.js";
import { BrowserBroker } from "./browser.js";
import { SpeechService } from "./speech.js";
import { loadIdentity } from "./identity-config.js";
process.umask(0o077);
loadServiceEnvironment();
const port = Number(process.env.MORPHZWORK_PORT ?? 65420);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("MORPHZWORK_PORT 无效。");
const source = fileURLToPath(import.meta.url);
const webRoot = source.includes("/dist/service/")
  ? resolve(fileURLToPath(new URL("../../../../web/", import.meta.url)))
  : resolve(fileURLToPath(new URL("../../../dist/web/", import.meta.url)));
const database = join(dataDirectory(), "workspace.sqlite");
const store = new WorkspaceStore(database);
const identity = loadIdentity(store, dataDirectory());
const config = loadRuntimeConfig(dataDirectory());
const runtime = config ? new RuntimeBridge(store, config, identity) : undefined;
const browser = new BrowserBroker(store);
runtime?.attachBrowser(browser);
const hostTools = config
  ? prepareHostTools(
      dataDirectory(),
      port,
      config.namespace,
      runtime!.teamIdentity,
    )
  : undefined;
const server = createAppServer(store, {
  port,
  webRoot,
  devOrigin: "http://127.0.0.1:65419",
  runtime,
  identity,
  browser,
  speech: new SpeechService(process.env.DOUBAO_API_KEY),
  agentTools:
    runtime && hostTools
      ? runtimeAgentTools(store, runtime, hostTools.token, browser)
      : undefined,
});
server.listen(port, "127.0.0.1", () => {
  console.log(`MorphzWork 本机中心：http://127.0.0.1:${port}`);
  console.log(`数据：${database}`);
  console.log(
    runtime
      ? `${identity ? "中心身份认证" : "本机单用户模式"}；正在连接 Morphz Runtime。`
      : `${identity ? "中心身份认证" : "本机单用户模式"}；未连接 Morphz Runtime。`,
  );
  runtime?.start();
});
server.on("error", (error) => {
  console.error(error.message);
  store.close();
  process.exitCode = 1;
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.closeStreams();
  server.close(() => {
    void (async () => {
      await runtime?.stop();
      store.close();
    })();
  });
  server.closeIdleConnections();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", () => {
  if (!identity) return;
  try {
    loadIdentity(store, dataDirectory(), identity);
    console.log("中心成员授权已重新加载。");
  } catch {
    console.error("成员配置未通过校验；保持现有授权，请检查本机配置。");
  }
});
