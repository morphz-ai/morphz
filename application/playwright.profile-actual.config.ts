import { defineConfig } from "@playwright/test";

/** Each test owns a real isolated Host/Runtime, not scripts/test-server.mjs. */
export default defineConfig({
  testDir: "tests",
  testMatch: "profile-actual-transport.spec.ts",
  workers: 1,
  fullyParallel: false,
  use: {
    viewport: { width: 1440, height: 960 },
    trace: "retain-on-failure",
  },
  reporter: "list",
});
