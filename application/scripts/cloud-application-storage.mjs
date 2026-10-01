import { isAbsolute } from "node:path";
import {
  backupCloudApplicationStorage,
  restoreCloudApplicationStorage,
} from "../dist/service/packages/application/src/cloud-deployment-backup.js";

process.umask(0o077);
const [operation, directory, acknowledgement] = process.argv.slice(2);
if (
  process.argv.slice(2).length !== 3 ||
  !["backup", "restore"].includes(operation) ||
  !directory ||
  !isAbsolute(directory) ||
  acknowledgement !== "--stopped"
)
  throw new Error(
    "用法：npm run backup:cloud-application -- <绝对备份根目录> --stopped；恢复使用 restore:cloud-application 与完整备份包目录。先停止全部相关写入者。",
  );

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少云应用存储配置 ${name}。`);
  return value;
};
const flag = process.env.MORPHZ_APP_CLOUD_STORE_FORCE_PATH_STYLE;
if (flag && !["true", "false"].includes(flag))
  throw new Error(
    "MORPHZ_APP_CLOUD_STORE_FORCE_PATH_STYLE 只能为 true 或 false。",
  );
const location = {
  tenantId: required("MORPHZ_APP_TENANT_ID"),
  platform: {
    connectionString: required("MORPHZ_APP_PLATFORM_POSTGRES_URL"),
    schema: required("MORPHZ_APP_PLATFORM_POSTGRES_SCHEMA"),
  },
  applications: {
    deploymentId: required("MORPHZ_APP_COGNITIVE_DEPLOYMENT_ID"),
    connectionStrings: {
      objects: required("MORPHZ_APP_OBJECTS_POSTGRES_URL"),
      scriptStudio: required("MORPHZ_APP_SCRIPT_POSTGRES_URL"),
      reader: required("MORPHZ_APP_READER_POSTGRES_URL"),
      browser: required("MORPHZ_APP_BROWSER_POSTGRES_URL"),
    },
    schemas: {
      objects: required("MORPHZ_APP_OBJECTS_POSTGRES_SCHEMA"),
      scriptStudio: required("MORPHZ_APP_SCRIPT_POSTGRES_SCHEMA"),
      reader: required("MORPHZ_APP_READER_POSTGRES_SCHEMA"),
      browser: required("MORPHZ_APP_BROWSER_POSTGRES_SCHEMA"),
    },
  },
  stores: {
    connectionString: required("MORPHZ_APP_CLOUD_STORE_POSTGRES_URL"),
    schemas: {
      ui: required("MORPHZ_APP_CLOUD_STORE_UI_SCHEMA"),
      reader: required("MORPHZ_APP_CLOUD_STORE_READER_SCHEMA"),
      images: required("MORPHZ_APP_CLOUD_STORE_IMAGE_SCHEMA"),
    },
    bytes: {
      bucket: required("MORPHZ_APP_CLOUD_STORE_BUCKET"),
      prefix: required("MORPHZ_APP_CLOUD_STORE_PREFIX"),
      region: required("MORPHZ_APP_CLOUD_STORE_REGION"),
      ...(process.env.MORPHZ_APP_CLOUD_STORE_ENDPOINT
        ? { endpoint: process.env.MORPHZ_APP_CLOUD_STORE_ENDPOINT }
        : {}),
      forcePathStyle: flag === "true",
    },
  },
};
const stagingRoot = required("MORPHZ_APP_CLOUD_STORE_STAGING_ROOT");
if (!isAbsolute(stagingRoot))
  throw new Error("云 Store 暂存根必须是绝对路径。");
if (operation === "backup") {
  const result = await backupCloudApplicationStorage({
    location,
    backupRoot: directory,
    stagingRoot,
    writersStopped: true,
    ...(process.env.MORPHZ_APP_PG_DUMP
      ? { pgDumpPath: process.env.MORPHZ_APP_PG_DUMP }
      : {}),
  });
  console.log(`云应用存储成套备份完成：${result.destination}`);
} else {
  const result = await restoreCloudApplicationStorage({
    location,
    backupDirectory: directory,
    stagingRoot,
    writersStopped: true,
    ...(process.env.MORPHZ_APP_PG_RESTORE
      ? { pgRestorePath: process.env.MORPHZ_APP_PG_RESTORE }
      : {}),
  });
  console.log(`云应用存储恢复并校验：${result.tenantId}`);
}
console.log(
  "不含 Runtime、其他 Host 本机消息投递、客户端草稿或第三方应用存储。",
);
