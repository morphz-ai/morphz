import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDirectory } from "./paths.js";
import { WorkspaceStore } from "./store.js";
import { openApplicationDomainsHost } from "../../../packages/application/src/application-domains-host.js";
import { createAppServer } from "./http.js";
import { loadRuntimeConfig, RuntimeBridge } from "./runtime.js";
import { loadServiceEnvironment } from "./environment.js";
import { prepareHostTools, runtimeAgentTools } from "./agent-tools.js";
import { BrowserBroker, platformBrowserPageAuthority } from "./browser.js";
import { SpeechService } from "./speech.js";
import {
  identityConfiguration,
  loadIdentity,
  readCenterMembers,
} from "./identity-config.js";
process.umask(0o077);
loadServiceEnvironment();
const port = Number(
  process.env.MORPHZ_APP_PORT ?? process.env.MORPHZWORK_PORT ?? 65420,
);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("MORPHZ_APP_PORT 无效。");
const source = fileURLToPath(import.meta.url);
const webRoot = source.includes("/dist/service/")
  ? resolve(fileURLToPath(new URL("../../../../web/", import.meta.url)))
  : resolve(fileURLToPath(new URL("../../../dist/web/", import.meta.url)));
const platformPostgresUrl = process.env.MORPHZ_APP_PLATFORM_POSTGRES_URL;
const platformPostgresSchema = process.env.MORPHZ_APP_PLATFORM_POSTGRES_SCHEMA;
const platformTenantId = process.env.MORPHZ_APP_TENANT_ID;
const uiStoreRoot = process.env.MORPHZ_APP_UI_STORE_ROOT;
const uiStoreSchema = process.env.MORPHZ_APP_UI_STORE_POSTGRES_SCHEMA;
const cloudStore = {
  connectionString: process.env.MORPHZ_APP_CLOUD_STORE_POSTGRES_URL,
  uiSchema: process.env.MORPHZ_APP_CLOUD_STORE_UI_SCHEMA,
  readerSchema: process.env.MORPHZ_APP_CLOUD_STORE_READER_SCHEMA,
  imageSchema: process.env.MORPHZ_APP_CLOUD_STORE_IMAGE_SCHEMA,
  stagingRoot: process.env.MORPHZ_APP_CLOUD_STORE_STAGING_ROOT,
  bucket: process.env.MORPHZ_APP_CLOUD_STORE_BUCKET,
  prefix: process.env.MORPHZ_APP_CLOUD_STORE_PREFIX,
  region: process.env.MORPHZ_APP_CLOUD_STORE_REGION,
  endpoint: process.env.MORPHZ_APP_CLOUD_STORE_ENDPOINT,
  forcePathStyle: process.env.MORPHZ_APP_CLOUD_STORE_FORCE_PATH_STYLE,
};
const requiredCloudStore = [
  cloudStore.connectionString,
  cloudStore.uiSchema,
  cloudStore.readerSchema,
  cloudStore.imageSchema,
  cloudStore.stagingRoot,
  cloudStore.bucket,
  cloudStore.prefix,
  cloudStore.region,
];
if (
  Object.values(cloudStore).some(Boolean) &&
  requiredCloudStore.some((value) => !value)
)
  throw new Error(
    "云对象 Store 的连接、三个 schema、暂存根、bucket、prefix 和 region 必须完整配置。",
  );
if (
  cloudStore.forcePathStyle &&
  !["true", "false"].includes(cloudStore.forcePathStyle)
)
  throw new Error(
    "MORPHZ_APP_CLOUD_STORE_FORCE_PATH_STYLE 只能为 true 或 false。",
  );
if (!!platformPostgresUrl !== !!platformPostgresSchema)
  throw new Error(
    "Platform PostgreSQL 连接和 schema 必须一起配置；拒绝静默回退 SQLite。",
  );
if (platformPostgresUrl && !platformTenantId)
  throw new Error("云端 Platform 必须配置稳定的 MORPHZ_APP_TENANT_ID。");
if (!platformPostgresUrl && platformTenantId)
  throw new Error("MORPHZ_APP_TENANT_ID 仅用于 PostgreSQL Platform 部署。");
if (platformPostgresUrl && !!uiStoreRoot !== !!uiStoreSchema)
  throw new Error(
    "PostgreSQL 界面包 Store 的共享字节根和 schema 必须一起配置。",
  );
if (!platformPostgresUrl && (uiStoreRoot || uiStoreSchema))
  throw new Error(
    "SQLite 中心的界面包 Store 由本中心管理，不接受云端 Store 配置。",
  );
if (cloudStore.connectionString && (uiStoreRoot || uiStoreSchema))
  throw new Error("云对象 Store 与本机界面包 Store 不能同时配置。");
const cognitivePostgres = {
  deploymentId: process.env.MORPHZ_APP_COGNITIVE_DEPLOYMENT_ID,
  connectionStrings: {
    objects: process.env.MORPHZ_APP_OBJECTS_POSTGRES_URL,
    scriptStudio: process.env.MORPHZ_APP_SCRIPT_POSTGRES_URL,
    reader: process.env.MORPHZ_APP_READER_POSTGRES_URL,
    browser: process.env.MORPHZ_APP_BROWSER_POSTGRES_URL,
  },
  schemas: {
    objects: process.env.MORPHZ_APP_OBJECTS_POSTGRES_SCHEMA,
    scriptStudio: process.env.MORPHZ_APP_SCRIPT_POSTGRES_SCHEMA,
    reader: process.env.MORPHZ_APP_READER_POSTGRES_SCHEMA,
    browser: process.env.MORPHZ_APP_BROWSER_POSTGRES_SCHEMA,
  },
};
const cognitiveValues = [
  cognitivePostgres.deploymentId,
  ...Object.values(cognitivePostgres.connectionStrings),
  ...Object.values(cognitivePostgres.schemas),
];
if (cognitiveValues.some(Boolean) && cognitiveValues.some((value) => !value))
  throw new Error(
    "四个认知应用各自的 PostgreSQL 连接、schema 和部署标识必须全部配置；拒绝静默回退 SQLite。",
  );
if (
  cloudStore.connectionString &&
  (!platformPostgresUrl || !cognitivePostgres.deploymentId)
)
  throw new Error("云对象 Store 需要 PostgreSQL Platform 和认知应用私库。");
const database = join(dataDirectory(), "workspace.sqlite");
const store = new WorkspaceStore(database, {
  mode: "transport",
  ...(platformTenantId ? { tenantId: platformTenantId } : {}),
});
const identity = await loadIdentity(store, dataDirectory());
const config = loadRuntimeConfig(dataDirectory());
const runtime = config ? new RuntimeBridge(store, config, identity) : undefined;
const domains = await openApplicationDomainsHost(
  dataDirectory(),
  store,
  identity,
  {
    retirementInputCoverage: platformPostgresUrl
      ? "cross-host-unverified"
      : "single-host",
    ...(platformPostgresUrl && platformPostgresSchema
      ? {
          platform: {
            kind: "postgres" as const,
            connectionString: platformPostgresUrl,
            schema: platformPostgresSchema,
          },
        }
      : {}),
    ...(platformPostgresUrl && uiStoreRoot && uiStoreSchema
      ? {
          uiPackages: {
            root: uiStoreRoot,
            postgres: {
              connectionString: platformPostgresUrl,
              schema: uiStoreSchema,
            },
          },
        }
      : {}),
    ...(cloudStore.connectionString &&
    cloudStore.uiSchema &&
    cloudStore.readerSchema &&
    cloudStore.imageSchema &&
    cloudStore.stagingRoot &&
    cloudStore.bucket &&
    cloudStore.prefix &&
    cloudStore.region
      ? {
          cloudStore: {
            connectionString: cloudStore.connectionString,
            stagingRoot: cloudStore.stagingRoot,
            schemas: {
              ui: cloudStore.uiSchema,
              reader: cloudStore.readerSchema,
              images: cloudStore.imageSchema,
            },
            bytes: {
              bucket: cloudStore.bucket,
              prefix: cloudStore.prefix,
              region: cloudStore.region,
              ...(cloudStore.endpoint ? { endpoint: cloudStore.endpoint } : {}),
              forcePathStyle: cloudStore.forcePathStyle === "true",
            },
          },
        }
      : {}),
    ...(cognitivePostgres.connectionStrings.objects &&
    cognitivePostgres.connectionStrings.scriptStudio &&
    cognitivePostgres.connectionStrings.reader &&
    cognitivePostgres.connectionStrings.browser &&
    cognitivePostgres.deploymentId &&
    cognitivePostgres.schemas.objects &&
    cognitivePostgres.schemas.scriptStudio &&
    cognitivePostgres.schemas.reader &&
    cognitivePostgres.schemas.browser
      ? {
          applications: {
            deploymentId: cognitivePostgres.deploymentId,
            connectionStrings: {
              objects: cognitivePostgres.connectionStrings.objects,
              scriptStudio: cognitivePostgres.connectionStrings.scriptStudio,
              reader: cognitivePostgres.connectionStrings.reader,
              browser: cognitivePostgres.connectionStrings.browser,
            },
            schemas: {
              objects: cognitivePostgres.schemas.objects,
              scriptStudio: cognitivePostgres.schemas.scriptStudio,
              reader: cognitivePostgres.schemas.reader,
              browser: cognitivePostgres.schemas.browser,
            },
          },
        }
      : {}),
  },
);
const browser = new BrowserBroker(store, platformBrowserPageAuthority(domains));
const bookmarkAgent = runtime ? domains.bindRuntime(runtime) : undefined;
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
  bookmarkDomain: domains.browser,
  platformWork: domains.work,
  platformDocuments: domains.content,
  platformScripts: domains.content,
  platformReader: domains.reader,
  messageAttachments: domains.messageAttachments,
  images: domains.images,
  uiPackages: domains.uiPackages,
  notifications: domains.notifications,
  platformTaskRuns: domains.taskRuns(runtime),
  speech: new SpeechService(process.env.DOUBAO_API_KEY),
  agentTools:
    runtime && hostTools && bookmarkAgent
      ? runtimeAgentTools(
          runtime,
          hostTools.token,
          {
            authority: bookmarkAgent.authority,
            work: domains.work.service,
            content: domains.content,
            reader: domains.reader.service,
          },
          {
            browser: browser,
            bookmarkDomain: bookmarkAgent,
          },
        )
      : undefined,
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Morphz 本机中心：http://127.0.0.1:${port}`);
  console.log(`数据：${database}`);
  console.log(
    runtime
      ? `${identity ? "中心身份认证" : "本机单用户模式"}；正在连接 Morphz Runtime。`
      : `${identity ? "中心身份认证" : "本机单用户模式"}；未连接 Morphz Runtime。`,
  );
  runtime?.start();
  bookmarkAgent?.dispatcher.start();
});
server.on("error", (error) => {
  console.error(error.message);
  void domains.close().finally(() => store.close());
  process.exitCode = 1;
});
let stopping = false;
let identityReload: Promise<void> = Promise.resolve();
function stop() {
  if (stopping) return;
  stopping = true;
  server.closeStreams();
  server.close(() => {
    void (async () => {
      await identityReload;
      await bookmarkAgent?.dispatcher.stop();
      await runtime?.stop();
      await domains.close();
      store.close();
    })();
  });
  server.closeIdleConnections();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", () => {
  if (!identity) return;
  identityReload = identityReload
    .then(async () => {
      const config = readCenterMembers(dataDirectory());
      if (!config) throw new Error("团队身份配置缺失。");
      const authentication = identityConfiguration(config);
      await identity.replaceConfiguration(authentication, config.members);
      console.log("中心成员授权已重新加载。");
    })
    .catch(() => {
      console.error("成员配置未完整加载；请检查本机配置与 Platform 成员状态。");
    });
});
