import { _electron, expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Profiling-only journey on the diagnostic branch. Never a substitute for the
// complete capture, focus, input and persistence checks required by main CI.
test("diagnostic: observe the complete production startup phases", async ({}, info) => {
  expect(process.platform).toBe("darwin");
  test.setTimeout(45000);
  const directory = await mkdtemp(join(tmpdir(), "morphz-embedded-electron-"));
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      MORPHZ_APP_EMBEDDED_FIXTURE: directory,
      MORPHZ_APP_ENV_FILE: "",
      MORPHZ_TEST_SOFTWARE_RENDERING: "1",
    }).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  let stderr = "",
    stdout = "";
  try {
    app = await _electron.launch({
      args: ["tests/fixtures/capture-desktop-entry.cjs"],
      env,
    });
    app.process().stderr?.on("data", (c) => {
      stderr = (stderr + c).slice(-65536);
    });
    app.process().stdout?.on("data", (c) => {
      stdout = (stdout + c).slice(-65536);
    });
    await expect
      .poll(() => app!.windows().some((p) => p.url() === "morphz://app/"))
      .toBe(true)
      .catch(async (error) => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        throw error;
      });
  } finally {
    const journal = await readFile(
      join(directory, "native-startup.jsonl"),
      "utf8",
    ).catch(() => "");
    const startupFailure = await readFile(
      join(directory, "profile/desktop-startup-failure.json"),
      "utf8",
    ).catch(() => null);
    await info.attach("capture-startup-process", {
      body: JSON.stringify({ journal, stderr, stdout, startupFailure }),
      contentType: "application/json",
    });
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
