import { join } from "node:path";
import { dataDirectory } from "../dist/service/packages/application/src/paths.js";
import { backupCenterStorage } from "../dist/service/packages/application/src/center-backup.js";

if (process.argv.slice(2).join(" ") !== "--stopped")
  throw new Error(
    "先正常关闭使用该中心的 Desktop/Service，再运行 npm run backup:center -- --stopped。",
  );
const sourceDirectory = dataDirectory();
const result = await backupCenterStorage({
  sourceDirectory,
  backupDirectory: join(sourceDirectory, "backups"),
  writersStopped: true,
});
console.log(`中心存储备份完成：${result.destination}`);
console.log(
  `已校验 ${result.files.join("、")}；不含 Runtime、客户端草稿及 PostgreSQL 私库。`,
);
