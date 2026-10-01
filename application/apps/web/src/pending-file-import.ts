import { z } from "zod";

type PendingImportStorage = {
  readLocal<T>(key: string, fallback: T): T;
  writeLocal(key: string, value: unknown): void;
  removeLocal(key: string): void;
};

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** A file import can commit its app original before the catalog response is
 * observed. Retain its command identity until the client has refreshed the
 * resulting catalog; a later explicit import after success gets a new ID.
 * The key contains only a request fingerprint, never file bytes or names.
 */
export async function runPendingFileImport<T>(
  request: {
    method: "pdf.import" | "reader.import";
    projectId: string;
    relativePath: string;
    bytes: Uint8Array<ArrayBuffer>;
  },
  storage: PendingImportStorage,
  send: (commandId: string) => Promise<T>,
  confirm: (result: T) => Promise<void>,
): Promise<T> {
  const contentDigest = hex(
    await crypto.subtle.digest("SHA-256", request.bytes),
  );
  const fingerprint = hex(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify([
          request.method,
          request.projectId,
          request.relativePath,
          contentDigest,
        ]),
      ),
    ),
  );
  const key = `pending:file-import:${fingerprint}`;
  const stored = storage.readLocal<unknown>(key, null);
  const prior = z.object({ commandId: z.uuid() }).safeParse(stored);
  const commandId = prior.success ? prior.data.commandId : crypto.randomUUID();
  // Do not send unless the retry identity is durable on this client.
  storage.writeLocal(key, { commandId });
  const result = await send(commandId);
  await confirm(result);
  storage.removeLocal(key);
  return result;
}
