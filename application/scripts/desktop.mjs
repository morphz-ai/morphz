import { spawn } from "node:child_process";
import "./application-configuration.mjs";
import { prepareDesktop } from "./desktop-bundle.mjs";

const center = process.argv
  .slice(2)
  .find((arg) => arg.startsWith("--center="))
  ?.slice(9);
const envFile =
  process.argv
    .slice(2)
    .find((arg) => arg.startsWith("--env-file="))
    ?.slice(11) ?? process.env.MORPHZ_APP_ENV_FILE;
const launch = prepareDesktop({
  center,
  envFile,
  dataDir: process.argv
    .slice(2)
    .find((arg) => arg.startsWith("--data-dir="))
    ?.slice(11),
  migrateOrigins: process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--migrate-origin="))
    .map((arg) => arg.slice(17)),
  profile: process.env.MORPHZ_APP_PROFILE,
});
const child = spawn(
  launch.executable,
  [...launch.args, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      ...(envFile === undefined ? {} : { MORPHZ_APP_ENV_FILE: envFile }),
    },
  },
);
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
