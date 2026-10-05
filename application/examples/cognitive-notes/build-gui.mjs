import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCognitiveAppDefinition } from "@morphz/cognitive-app-sdk";

// This author project builds outside the Morphz repository. Only the public
// SDK is bundled; there are no Host imports, network permissions or addresses.
const root = new URL("./", import.meta.url);
const old = parseCognitiveAppDefinition(
  JSON.parse(readFileSync(new URL("definition.json", root), "utf8")),
);
if (old.id !== "example.notes" || old.version !== "1.0.0" || old.ui !== null)
  throw new Error("The fixed headless author definition is required.");
const bundled = await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: ["gui/index.ts"],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  minify: true,
  legalComments: "none",
  charset: "utf8",
  metafile: true,
});
if (
  bundled.outputFiles.length !== 1 ||
  Object.keys(bundled.metafile.inputs).some(
    (path) =>
      path !== "gui/index.ts" &&
      !path.startsWith("node_modules/@morphz/cognitive-app-sdk/") &&
      !path.startsWith("node_modules/zod/"),
  )
)
  throw new Error("The GUI must use only the public browser SDK.");
const template = readFileSync(new URL("gui/index.html", root), "utf8");
const marker = "<!-- APP_SCRIPT -->";
if (template.split(marker).length !== 2)
  throw new Error("The fixed GUI template requires one script position.");
const html = template.replace(
  marker,
  () =>
    `<script>${bundled.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")}</script>`,
);
const bytes = Buffer.from(html, "utf8");
if (bytes.byteLength > 1_000_000)
  throw new Error("The author GUI exceeds its original-byte budget.");
const definition = parseCognitiveAppDefinition({
  ...old,
  version: "1.1.0",
  ui: {
    packageVersion: "1.1.0",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  },
});
const manifest = {
  format: "morphz-app/v1",
  id: definition.id,
  version: definition.version,
  title: definition.title,
  description: definition.description,
  icon: definition.icon,
  permissions: ["input.compose"],
  harness: null,
  ui: { type: "sandbox", html, presentation: "workspace" },
};
mkdirSync(new URL("dist/", root), { recursive: true });
writeFileSync(new URL("dist/notes.html", root), bytes);
writeFileSync(
  new URL("dist/definition.gui.json", root),
  `${JSON.stringify(definition, null, 2)}\n`,
);
writeFileSync(
  new URL("dist/install.gui.json", root),
  `${JSON.stringify({ definition, manifest }, null, 2)}\n`,
);
console.log(
  "Built the optional example.notes 1.1.0 GUI and exact-byte carrier.",
);
