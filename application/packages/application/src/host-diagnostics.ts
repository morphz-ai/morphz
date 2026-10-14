import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type HostFailureReporter = (operation: string, error: unknown) => void;
const diagnosticNames = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "DOMException",
  "TimeoutError",
  "AbortError",
  "ZodError",
  "RuntimeTransportError",
  "UpstreamError",
  "DomainError",
  "PlatformStorageError",
]);
const diagnosticCodes = new Set([
  "ERR_SQLITE_ERROR",
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_THIS",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "EPIPE",
  "ECANCELED",
  "EACCES",
  "EPERM",
  "ENOENT",
  "ENOMEM",
  "EMFILE",
  "ENFILE",
  "EIO",
  "ENOSPC",
  "EROFS",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_RESPONSE_CONTENT_LENGTH_MISMATCH",
]);

/** Private operational evidence, never a business ledger or a renderer API.
 * No request, response, credential, error message or arbitrary Error property
 * is serialized. Even native fetch/header exceptions may contain Bearer data.
 */
export function hostFailureDiagnostic(operation: string, error: unknown) {
  const chain: { name: string; code?: string; sqliteCode?: number }[] = [];
  const seen = new Set<unknown>();
  let current = error;
  for (
    let depth = 0;
    depth < 4 && current && typeof current === "object";
    depth++
  ) {
    if (seen.has(current)) break;
    seen.add(current);
    const value = current as Record<string, unknown>;
    const name =
      typeof value.name === "string" && diagnosticNames.has(value.name)
        ? value.name
        : "Error";
    const code =
      typeof value.code === "string" && diagnosticCodes.has(value.code)
        ? value.code
        : undefined;
    const sqliteCode =
      code === "ERR_SQLITE_ERROR" && Number.isSafeInteger(value.errcode)
        ? (value.errcode as number)
        : undefined;
    chain.push({
      name,
      ...(code ? { code } : {}),
      ...(sqliteCode === undefined ? {} : { sqliteCode }),
    });
    current = value.cause;
  }
  const stack = error instanceof Error ? error.stack : undefined;
  const prefix =
    error instanceof Error ? `${error.name}: ${error.message}` : "";
  // Retain only module paths and positions. Ignore the message/first line,
  // function names, URLs, eval source, user filenames and parameter values.
  const frames =
    typeof stack === "string" && prefix && stack.startsWith(prefix + "\n")
      ? stack
          .slice(prefix.length + 1, prefix.length + 16 * 1024)
          .split("\n")
          .flatMap((line) => {
            const module = line.match(
              /(?:\/|file:\/\/[^\s]*)application\/(?:apps|packages|dist\/service)\/[A-Za-z0-9_./-]+\.[cm]?[jt]s:\d+:\d+/,
            )?.[0];
            if (!module) return [];
            const start = module.indexOf("application/");
            return [module.slice(start, start + 256)];
          })
          .slice(0, 8)
      : [];
  return {
    operation: /^[a-z][a-z0-9.:-]{0,100}$/.test(operation)
      ? operation
      : "unknown",
    errors: chain,
    frames,
  };
}

/** Bounded, owner-private Host log. A diagnostic write must never change a
 * business operation's result, stop the Runtime, or erase its real failure.
 */
export function privateHostFailureReporter(
  profile: string,
): HostFailureReporter {
  const directory = join(profile, "diagnostics");
  const filename = join(directory, "host-failures.jsonl");
  const previous = join(directory, "host-failures.previous.jsonl");
  const maximum = 128 * 1024;
  const recent = new Map<string, number>();
  return (operation, error) => {
    try {
      const details = hostFailureDiagnostic(operation, error);
      const key = JSON.stringify(details);
      const now = Date.now();
      if (now - (recent.get(key) ?? 0) < 30_000) return;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const root = lstatSync(directory);
      if (
        !root.isDirectory() ||
        root.isSymbolicLink() ||
        (process.platform !== "win32" &&
          (root.mode & 0o077 || root.uid !== process.getuid!()))
      )
        return;
      const descriptor = openSync(
        filename,
        constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_CREAT |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      let rotate = false;
      try {
        const file = fstatSync(descriptor);
        if (
          !file.isFile() ||
          (process.platform !== "win32" &&
            (file.mode & 0o077 || file.uid !== process.getuid!()))
        )
          return;
        rotate = file.size >= maximum;
        if (!rotate)
          writeSync(
            descriptor,
            JSON.stringify({
              id: randomUUID(),
              at: new Date(now).toISOString(),
              pid: process.pid,
              ...details,
            }) + "\n",
          );
      } finally {
        closeSync(descriptor);
      }
      if (rotate) {
        // Rotate only this explicitly owned bounded operational log. Never
        // touch database, attachment, task or model configuration files.
        renameSync(filename, previous);
        writeFileSync(
          filename,
          JSON.stringify({
            id: randomUUID(),
            at: new Date(now).toISOString(),
            pid: process.pid,
            ...details,
          }) + "\n",
          { mode: 0o600, flag: "wx" },
        );
      }
      recent.set(key, now);
      if (recent.size > 64) recent.delete(recent.keys().next().value!);
    } catch {
      // Logging is best effort. Original request/receipt semantics survive.
    }
  };
}
