import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { prepareDesktop } from "./desktop-bundle.mjs";

const require = createRequire(import.meta.url);
require("../apps/desktop/stdio.cjs").protectStandardStreams();
const { centerFromArgs } = require("../apps/desktop/security.cjs");
const { developmentOrigin } = require("../apps/desktop/development.cjs");
const args = process.argv.slice(2);
if (args.some((arg) => !arg.startsWith("--center=")))
  throw new Error(
    "Usage: npm run desktop:dev -- --center=http://127.0.0.1:65424",
  );
const center = centerFromArgs(args);
if (center === developmentOrigin)
  throw new Error("中心不能占用 Vite 的 65419 端口。");
const response = await fetch(`${center}/api/health`, {
  redirect: "error",
  signal: AbortSignal.timeout(5000),
});
if (!response.ok)
  throw new Error("请先启动指定中心；本命令不会重启或更换中心。");

const cwd = fileURLToPath(new URL("../", import.meta.url));
const vite = await createServer({
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  server: { proxy: { "/api": { target: center } } },
});
let desktop;
let closing = false;
async function stop(code = 0) {
  if (closing) return;
  closing = true;
  process.exitCode = code;
  await vite.close();
  // Centers are externally owned. Normal desktop quit is the supported exit;
  // terminating the launcher never stops a center or its running tasks.
  console.log("UI 热更新服务已停止；中心与后台任务继续运行。");
}
try {
  await vite.listen();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
        "MORPHZWORK_TEST_PROFILE",
      ].includes(key),
    ),
  );
  const launch = prepareDesktop({
    center,
    hot: true,
    profile: env.MORPHZWORK_TEST_PROFILE,
  });
  desktop = spawn(launch.executable, launch.args, {
    cwd,
    env,
    stdio: "inherit",
  });
  desktop.once("error", (error) => {
    console.error(error.message);
    void stop(1);
  });
  desktop.once("exit", (code) => void stop(code ?? 1));
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  console.log(
    `桌面界面热更新已启动：${developmentOrigin} → ${center}（中心未重启）。`,
  );
} catch (error) {
  await stop(1);
  throw error;
}
