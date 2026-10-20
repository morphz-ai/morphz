import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const installedPackage = fileURLToPath(
  new URL("../node_modules/electron/", import.meta.url),
);

// Electron 44 installs lazily when imported. Multiple Node test workers must
// never race that download/extraction. Dependency preparation is explicit;
// this preflight reads readiness only and neither imports nor launches it.
export function verifyTestElectron(packageDirectory = installedPackage) {
  try {
    const { version } = JSON.parse(
      readFileSync(resolve(packageDirectory, "package.json"), "utf8"),
    );
    const dist = resolve(packageDirectory, "dist");
    const actualVersion = readFileSync(resolve(dist, "version"), "utf8")
      .trim()
      .replace(/^v/, "");
    if (!version || actualVersion !== version)
      throw new Error(
        "Electron binary version does not match the locked package",
      );
    const entry = readFileSync(
      resolve(packageDirectory, "path.txt"),
      "utf8",
    ).trim();
    if (!entry || isAbsolute(entry))
      throw new Error("Electron installation entry is absent or invalid");
    const executable = resolve(dist, entry);
    const within = relative(dist, executable);
    if (
      isAbsolute(within) ||
      within === ".." ||
      within.startsWith("../") ||
      within.startsWith("..\\")
    )
      throw new Error(
        "Electron installation entry is outside its distribution",
      );
    if (!statSync(executable).isFile())
      throw new Error("Electron executable is missing");
    accessSync(executable, constants.X_OK);
    return executable;
  } catch (cause) {
    throw new Error(
      "Test preparation: Electron is not completely installed. Run `node node_modules/electron/install.js` in application/ before npm test; parallel test workers must not install it.",
      { cause },
    );
  }
}
