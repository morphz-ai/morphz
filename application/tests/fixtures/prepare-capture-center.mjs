import { isAbsolute, basename, join } from "node:path";
import { lstatSync } from "node:fs";
import { openEmbeddedApplication } from "../../dist/service/apps/desktop/application-host.js";

const directory = process.argv[2];
if (
  !directory ||
  !isAbsolute(directory) ||
  !basename(directory).startsWith("morphz-embedded-electron-") ||
  !lstatSync(directory).isDirectory()
)
  throw new Error("A generated isolated capture fixture is required");
// Prepare the real empty center through its production owner. The Electron
// profile remains new; no application service, fake data, schema bypass or
// persistent user profile is involved. Both phases remain inside the test's
// original total deadline.
const host = await openEmbeddedApplication(
  join(directory, "data"),
  join(directory, "fixture-preparation-profile"),
);
await host.close();
