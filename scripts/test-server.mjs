import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = mkdtempSync(join(tmpdir(), "morphzwork-e2e-"));
const child = spawn(
  process.execPath,
  ["--import", "tsx", "apps/service/src/main.ts"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      MORPHZWORK_PORT: "65421",
      MORPHZWORK_DATA_DIR: directory,
      MORPHZWORK_ENV_FILE: "",
    },
  },
);
child.on("exit", (code) => {
  rmSync(directory, { recursive: true });
  process.exitCode = code ?? 0;
});
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
