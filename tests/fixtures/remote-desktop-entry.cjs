// Use the real remote entry with isolated preferences. Surface startup failures
// to the test runner instead of waiting forever on an unattended native dialog.
const { isAbsolute, basename } = require("node:path");
const profile = process.env.MORPHZWORK_TEST_PROFILE;
if (
  !profile ||
  !isAbsolute(profile) ||
  !basename(profile).startsWith("morphz-sidebar-native-")
)
  throw new Error("An isolated native fixture profile is required");
const { dialog } = require("electron");
globalThis.__fixtureStartupErrors = [];
dialog.showErrorBox = (title, content) => {
  globalThis.__fixtureStartupErrors.push({ title, content });
  console.error(title, content);
};
require("../../apps/desktop/main.cjs");
