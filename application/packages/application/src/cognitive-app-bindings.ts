import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { inspect } from "node:util";
import { z } from "zod";
import {
  isPortableText,
  type JsonValue,
} from "../../cognitive-app-sdk/src/protocol.js";
import {
  isCognitiveAppTransportLease,
  isPublicCognitiveAppAddress,
  type CognitiveAppBinding,
  type CognitiveAppPath,
  type CognitiveAppTransportLease,
} from "./cognitive-app-transport.js";

const maxFileBytes = 128 * 1024;
const internalId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const opaque = z.string().min(1).max(200).refine(isPortableText);
const tupleSchema = z
  .object({
    tenantId: internalId,
    principalId: internalId,
    appId: z.string().regex(/^[a-z][a-z0-9.-]{2,80}$/),
    serviceId: opaque,
    dataAuthorityId: opaque,
  })
  .strict();
/** These facts come from the authenticated Host/Platform, not model arguments. */
export type CognitiveAppBindingTuple = Readonly<z.infer<typeof tupleSchema>>;
const approvalSchema = z
  .object({
    host: z.enum(["127.0.0.1", "::1"]),
    port: z.number().int().min(1).max(65535),
  })
  .strict();
const entrySchema = tupleSchema
  .extend({
    baseUrl: z.string().min(1).max(2048),
    credentialEnv: z
      .string()
      .max(200)
      .regex(/^MORPHZ_APP_COGNITIVE_CREDENTIAL_[A-Z0-9_]+$/),
    current: z.boolean(),
    approvedLoopback: approvalSchema.optional(),
  })
  .strict();
const configSchema = z
  .object({
    format: z.literal("morphz-host-cognitive-bindings/v1"),
    issuer: opaque,
    bindings: z.array(entrySchema).max(128),
  })
  .strict();
type Entry = z.infer<typeof entrySchema>;
type Route = {
  readonly entry: Entry;
  readonly issuer: string;
  readonly hostBindingId: string;
  readonly origin: string;
};

/** A fixed safe diagnostic, with no path, alias, env name, credential or cause. */
export class CognitiveAppBindingsError extends Error {
  constructor() {
    super("应用私有连接不可用。");
    this.name = "CognitiveAppBindingsError";
  }
}
function unavailable(): never {
  throw new CognitiveAppBindingsError();
}
function key(tuple: CognitiveAppBindingTuple) {
  return JSON.stringify([
    tuple.tenantId,
    tuple.principalId,
    tuple.appId,
    tuple.serviceId,
    tuple.dataAuthorityId,
  ]);
}
function origin(entry: Entry) {
  const url = new URL(entry.baseUrl);
  const hostname = url.hostname.startsWith("[")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  if (
    !hostname ||
    hostname.length > 253 ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    unavailable();
  if (url.protocol === "https:" && !entry.approvedLoopback) {
    if (entry.baseUrl !== url.origin && entry.baseUrl !== `${url.origin}/`)
      unavailable();
    if (isIP(hostname) && !isPublicCognitiveAppAddress(hostname)) unavailable();
    return url.origin;
  }
  const approved = entry.approvedLoopback;
  if (!approved || url.protocol !== "http:") unavailable();
  const host = approved.host === "::1" ? "[::1]" : approved.host;
  const approvedOrigin = `http://${host}:${approved.port}`;
  if (
    entry.baseUrl !== approvedOrigin &&
    entry.baseUrl !== `${approvedOrigin}/`
  )
    unavailable();
  return url.origin;
}
function unchanged(before: BigIntStats, after: BigIntStats) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.uid === after.uid &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}
function readSnapshot(filename: string): readonly Route[] {
  let fd: number | undefined;
  try {
    // No Windows ACL support is claimed. FIFO/non-regular files cannot block open.
    if (
      process.platform === "win32" ||
      typeof process.getuid !== "function" ||
      !constants.O_NOFOLLOW ||
      !constants.O_NONBLOCK
    )
      unavailable();
    fd = openSync(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = fstatSync(fd, { bigint: true });
    const permissions = before.mode & 0o7777n;
    if (
      !before.isFile() ||
      before.uid !== BigInt(process.getuid()) ||
      (permissions !== 0o600n && permissions !== 0o400n) ||
      before.size > BigInt(maxFileBytes)
    )
      unavailable();
    const bytes = Buffer.alloc(maxFileBytes + 1);
    let length = 0;
    while (length < bytes.byteLength) {
      const read = readSync(
        fd,
        bytes,
        length,
        bytes.byteLength - length,
        length,
      );
      if (read === 0) break;
      length += read;
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      length > maxFileBytes ||
      BigInt(length) !== before.size ||
      !unchanged(before, after)
    )
      unavailable();
    const parsed = configSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, length),
        ),
      ),
    );
    const aliases = new Set<string>(),
      currents = new Set<string>();
    return parsed.bindings.map((entry) => {
      const canonicalOrigin = origin(entry);
      const hostBindingId =
        "cognitive_binding_" +
        createHash("sha256")
          .update(
            JSON.stringify([
              "morphz-cognitive-binding/v1",
              parsed.issuer,
              entry.tenantId,
              entry.principalId,
              entry.appId,
              entry.serviceId,
              entry.dataAuthorityId,
              canonicalOrigin,
              entry.approvedLoopback?.host ?? null,
              entry.approvedLoopback?.port ?? null,
            ]),
          )
          .digest("hex");
      const tupleKey = key(entry);
      if (
        aliases.has(hostBindingId) ||
        (entry.current && currents.has(tupleKey))
      )
        unavailable();
      aliases.add(hostBindingId);
      if (entry.current) currents.add(tupleKey);
      return {
        entry,
        issuer: parsed.issuer,
        hostBindingId,
        origin: canonicalOrigin,
      };
    });
  } catch {
    return unavailable();
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* No private diagnostic escapes. */
      }
    }
  }
}

type Request = (
  lease: CognitiveAppTransportLease,
  payload: unknown,
  signal?: AbortSignal,
) => Promise<JsonValue>;
function request(
  binding: CognitiveAppBinding,
  path: CognitiveAppPath,
): Request {
  return (lease, payload, signal) => {
    // Validate and use the exact same immutable, real transport permit. A fake
    // structural post must never receive the private binding through this closure.
    if (!isCognitiveAppTransportLease(lease)) unavailable();
    return lease.post(binding, path, payload, signal);
  };
}
type Metadata<P extends string> = {
  readonly purpose: P;
  /** Host-only values for persisted connection binding and delegation. Never a DTO. */
  readonly issuer: string;
  readonly hostBindingId: string;
};
export type CognitiveAppConnectionSetup = Metadata<"connection-setup"> & {
  readonly describe: Request;
};
export type CognitiveAppActiveConnection = Metadata<"active-connection"> & {
  readonly invoke: Request;
  readonly readObject: Request;
};
export type CognitiveAppReceiptRecovery = Metadata<"receipt-recovery"> & {
  readonly readReceipt: Request;
};
function capability<P extends string, M extends Record<string, Request>>(
  purpose: P,
  route: Route,
  methods: M,
): Readonly<Metadata<P> & M> {
  // Secrets exist only in method closures. TypeScript private/protected properties
  // would remain reachable/enumerable at runtime; no generic post/getter is offered.
  const handle = { purpose, ...methods };
  Object.defineProperties(handle, {
    issuer: { get: () => route.issuer },
    hostBindingId: { get: () => route.hostBindingId },
    toJSON: { value: () => "[Host-private cognitive app capability]" },
    [inspect.custom]: {
      value: () => `[Host-private cognitive app ${purpose}]`,
    },
  });
  return Object.freeze(handle) as Readonly<Metadata<P> & M>;
}

/** Host operator configuration only; never registered as Client/Agent/iframe API.
 * Resolver selection is not authorization: Gateway must enforce the live Platform
 * grant/connection/source fences, including disabled connections for receipt reads.
 */
export class CognitiveAppBindings {
  readonly #filename: string;
  readonly #readSecret: (name: string) => string | undefined;
  constructor(options: {
    filename: string;
    readSecret?: (name: string) => string | undefined;
  }) {
    if (
      typeof options.filename !== "string" ||
      !isAbsolute(options.filename) ||
      options.filename.includes("\0")
    )
      unavailable();
    this.#filename = options.filename;
    this.#readSecret = options.readSecret ?? ((name) => process.env[name]);
  }
  #resolve(
    actual: CognitiveAppBindingTuple,
    alias: string | undefined,
    receipt: boolean,
  ) {
    try {
      const tuple = tupleSchema.parse(actual);
      if (
        alias !== undefined &&
        !/^cognitive_binding_[a-f0-9]{64}$/.test(alias)
      )
        unavailable();
      const routes = readSnapshot(this.#filename).filter(
        (route) =>
          key(route.entry) === key(tuple) &&
          (receipt ? route.hostBindingId === alias : route.entry.current),
      );
      if (routes.length !== 1) unavailable();
      const route = routes[0]!;
      if (alias !== undefined && route.hostBindingId !== alias) unavailable();
      // Read only the selected dedicated secret name, after every entry validated.
      const credential = this.#readSecret(route.entry.credentialEnv);
      if (
        typeof credential !== "string" ||
        !/^[\x21-\x7e]{1,4096}$/.test(credential)
      )
        unavailable();
      const binding: CognitiveAppBinding = Object.freeze({
        baseUrl: route.entry.approvedLoopback
          ? route.entry.baseUrl
          : route.origin,
        credential,
        ...(route.entry.approvedLoopback
          ? {
              explicitApprovedLoopback: Object.freeze({
                ...route.entry.approvedLoopback,
              }),
            }
          : {}),
      });
      return { route, binding };
    } catch {
      unavailable();
    }
  }
  /** For an explicit Human setup/CAS only, never implicit rerouting of a connection. */
  prepareConnection(
    actual: CognitiveAppBindingTuple,
  ): CognitiveAppConnectionSetup {
    const { route, binding } = this.#resolve(actual, undefined, false);
    return capability("connection-setup", route, {
      describe: request(binding, "describe"),
    });
  }
  /** SQL's stored alias must still identify the unique current private route. */
  resolveConnection(
    actual: CognitiveAppBindingTuple,
    storedAlias: string,
  ): CognitiveAppActiveConnection {
    if (typeof storedAlias !== "string") unavailable();
    const { route, binding } = this.#resolve(actual, storedAlias, false);
    return capability("active-connection", route, {
      invoke: request(binding, "invoke"),
      readObject: request(binding, "objects/read"),
    });
  }
  /** Exact historical route only; absence never falls back to another route/person. */
  resolveReceipt(
    actual: CognitiveAppBindingTuple,
    historicalAlias: string,
  ): CognitiveAppReceiptRecovery {
    if (typeof historicalAlias !== "string") unavailable();
    const { route, binding } = this.#resolve(actual, historicalAlias, true);
    return capability("receipt-recovery", route, {
      readReceipt: request(binding, "receipts/read"),
    });
  }
  toJSON() {
    return "[Host-private cognitive app bindings]";
  }
  [inspect.custom]() {
    return "[Host-private cognitive app bindings]";
  }
}
