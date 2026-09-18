const { existsSync } = require("node:fs");
const { join, isAbsolute } = require("node:path");

// Compatibility is explicit and one-way: current names (including blanks) win.
// Never copy arbitrary process settings such as NODE_OPTIONS or PATH.
const legacyEnvironmentNames = {
  MORPHZ_APP_DATA_DIR: "MORPHZWORK_DATA_DIR",
  MORPHZ_APP_PORT: "MORPHZWORK_PORT",
  MORPHZ_APP_ENV_FILE: "MORPHZWORK_ENV_FILE",
  MORPHZ_APP_PROFILE: "MORPHZWORK_TEST_PROFILE",
  MORPHZ_APP_RUNTIME_BINARY: "MORPHZWORK_RUNTIME_BINARY",
  MORPHZ_APP_LIVE_MODEL: "MORPHZWORK_LIVE_MODEL",
  MORPHZ_APP_LIVE_PROTOCOL: "MORPHZWORK_LIVE_PROTOCOL",
  MORPHZ_APP_LIVE_BASE_URL: "MORPHZWORK_LIVE_BASE_URL",
  MORPHZ_APP_TEST_KEY: "MORPHZWORK_TEST_KEY",
  MORPHZ_APP_BROWSER_TEST_PORT: "MORPHZWORK_BROWSER_TEST_PORT",
  MORPHZ_APP_DESKTOP_TEST_PORT: "MORPHZWORK_DESKTOP_TEST_PORT",
  MORPHZ_APP_EMBEDDED_FIXTURE: "MORPHZWORK_EMBEDDED_FIXTURE",
  MORPHZ_APP_DEVELOPMENT_MODEL_KEY: "MORPHZWORK_DEVELOPMENT_MODEL_KEY",
};

function normalizeApplicationEnvironment(env = process.env) {
  for (const [current, legacy] of Object.entries(legacyEnvironmentNames))
    if (env[current] === undefined && env[legacy] !== undefined)
      env[current] = env[legacy];
  return env;
}

function desktopProfile(appData, env = process.env, exists = existsSync) {
  const selected = env.MORPHZ_APP_PROFILE ?? env.MORPHZWORK_TEST_PROFILE;
  if (selected !== undefined) {
    if (!isAbsolute(selected))
      throw new Error("MORPHZ_APP_PROFILE 必须是绝对路径。");
    return selected;
  }
  const current = join(appData, "Morphz", "desktop");
  const legacy = join(appData, "MorphzWork", "desktop");
  if (exists(current) && exists(legacy))
    throw new Error(
      "发现两份桌面配置；请用 MORPHZ_APP_PROFILE 明确选择，未移动或合并数据。",
    );
  return exists(legacy) ? legacy : current;
}

/** Reuse an existing Chromium partition in place, preserving cookies and drafts. */
function persistentPartition(profile, suffix, exists = existsSync) {
  if (!/^(app|browser-[a-f0-9]{64})$/.test(suffix))
    throw new Error("无效的应用存储分区。");
  const current = "morphz-" + suffix;
  const legacy = "morphzwork-" + suffix;
  // Existing profiles remain on their exact partition. No copying live LevelDB.
  if (
    exists(join(profile, "Partitions", current)) &&
    exists(join(profile, "Partitions", legacy))
  )
    throw new Error("发现同一身份的两份存储分区；未自动选择或合并。");
  return (
    "persist:" +
    (exists(join(profile, "Partitions", legacy)) ? legacy : current)
  );
}

module.exports = {
  normalizeApplicationEnvironment,
  desktopProfile,
  persistentPartition,
};
