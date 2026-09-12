import { DatabaseSync, backup } from "node:sqlite";
import {
  mkdtempSync,
  existsSync,
  mkdirSync,
  cpSync,
  writeFileSync,
  chmodSync,
  readFileSync,
} from "node:fs";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
const root = process.argv[2];
if (!root || !isAbsolute(root))
  throw new Error("Specify the existing application root explicitly");
const sources = [
  join(root, "center/workspace.sqlite"),
  join(root, "runtime/runtime.sqlite"),
];
if (!sources.every(existsSync))
  throw new Error("Both existing databases must be present");
const destination = mkdtempSync(join(tmpdir(), "morphz-embedded-cutover-"));
chmodSync(destination, 0o700);
const files = [];
for (const [index, source] of sources.entries()) {
  const filename = join(
    destination,
    index ? "runtime.sqlite" : "workspace.sqlite",
  );
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(database, filename);
  } finally {
    database.close();
  }
  chmodSync(filename, 0o600);
  const check = new DatabaseSync(filename, { readOnly: true });
  try {
    const integrity = check.prepare("PRAGMA integrity_check").get();
    if (Object.values(integrity)[0] !== "ok")
      throw new Error("Backup integrity check failed");
  } finally {
    check.close();
  }
  files.push({
    source,
    filename,
    sha256: createHash("sha256").update(readFileSync(filename)).digest("hex"),
  });
}
for (const file of [
  "center/runtime.json",
  "center/host-tools.json",
  "runtime/morphz.toml",
  "runtime/models.toml",
  "development-center.json",
  "desktop/source-grants.json",
]) {
  const source = join(root, file);
  if (!existsSync(source)) continue;
  const target = join(destination, "configuration", file);
  mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
  cpSync(source, target);
  chmodSync(target, 0o600);
}
const database = new DatabaseSync(join(destination, "workspace.sqlite"), {
  readOnly: true,
});
let summary;
try {
  const workspace = JSON.parse(
    database.prepare("SELECT body FROM workspace WHERE id=1").get().body,
  );
  summary = {
    centerId: database
      .prepare("SELECT identity FROM center_metadata WHERE id=1")
      .get().identity,
    revision: workspace.revision,
    projects: workspace.projects.length,
    conversations: workspace.conversations.length,
    inputs: workspace.inputs.length,
    artifacts: workspace.artifacts.length,
    commands: database.prepare("SELECT count(*) AS count FROM commands").get()
      .count,
  };
} finally {
  database.close();
}
writeFileSync(
  join(destination, "manifest.json"),
  JSON.stringify(
    { createdAt: new Date().toISOString(), root, files, summary },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    destination,
    summary,
    integrity: "Both SQLite backups verified",
  }),
);
