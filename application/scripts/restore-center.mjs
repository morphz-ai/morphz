import { isAbsolute } from "node:path";
import { restoreCenterStorage } from "../dist/service/packages/application/src/center-backup.js";

const [backupDirectory, destinationDirectory, acknowledgement] =
  process.argv.slice(2);
if (
  !backupDirectory ||
  !destinationDirectory ||
  !isAbsolute(backupDirectory) ||
  !isAbsolute(destinationDirectory) ||
  acknowledgement !== "--stopped"
)
  throw new Error(
    "用法：npm run restore:center -- /绝对路径/备份包 /绝对路径/新中心目录 --stopped；恢复不覆盖现有目录。",
  );
const result = await restoreCenterStorage({
  backupDirectory,
  destinationDirectory,
  writersStopped: true,
});
console.log(`中心存储已恢复并校验：${result.destination}`);
