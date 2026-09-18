import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  applyCommand,
  stateSchema,
  localAccess,
  type Command,
  type AccessContext,
} from "../packages/core/src/model.js";

/** Offline fixture for data committed before website creation was retired.
 * No production bypass: load the old persisted shape and original receipt. */
export function seedLegacyWebsite(
  filename: string,
  command: Command,
  access: AccessContext = localAccess,
) {
  if (
    !isAbsolute(filename) ||
    !/[/]morphz-[^/]+[/]workspace\.sqlite$/.test(filename)
  )
    throw new Error("Legacy fixture requires an isolated test database");
  const op = command.operation;
  if (op.type !== "create-artifact" || op.content.kind !== "website")
    throw new Error("Expected a legacy website command");
  const db = new DatabaseSync(filename);
  try {
    db.exec("BEGIN IMMEDIATE");
    const row = db.prepare("SELECT body FROM workspace WHERE id=1").get() as {
      body: string;
    };
    const { state, receipt } = applyCommand(
      stateSchema.parse(JSON.parse(row.body)),
      {
        ...command,
        operation: { ...op, content: { kind: "document", markdown: "" } },
      },
      access,
    );
    const artifact = state.artifacts.find((a) => a.id === receipt.entityId)!;
    artifact.content = structuredClone(op.content);
    artifact.versions[0]!.content = structuredClone(op.content);
    db.prepare("UPDATE workspace SET body=? WHERE id=1").run(
      JSON.stringify(stateSchema.parse(state)),
    );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ command, access }))
      .digest("hex");
    db.prepare(
      "INSERT INTO commands(id,fingerprint,receipt) VALUES(?,?,?)",
    ).run(command.commandId, fingerprint, JSON.stringify(receipt));
    db.exec("COMMIT");
    return receipt;
  } finally {
    db.close();
  }
}
