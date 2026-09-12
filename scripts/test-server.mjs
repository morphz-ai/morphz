import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = mkdtempSync(join(tmpdir(), "morphz-e2e-"));
const child = spawn(
  process.execPath,
  ["--import", "tsx", "apps/service/src/main.ts"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      MORPHZ_APP_PORT: "65421",
      MORPHZ_APP_DATA_DIR: directory,
      MORPHZ_APP_ENV_FILE: "",
    },
  },
);
child.on("exit", (code) => {
  rmSync(directory, { recursive: true });
  process.exitCode = code ?? 0;
});
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
