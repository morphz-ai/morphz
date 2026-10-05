import { lookup as systemLookup } from "node:dns/promises";
import { request as httpRequest, type ClientRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { performance } from "node:perf_hooks";
import {
  parseWireJson,
  type JsonValue,
} from "../../cognitive-app-sdk/src/protocol.js";

/** Host-private configuration. Never an Application/Agent/iframe request. */
export type CognitiveAppBinding = {
  readonly baseUrl: string;
  readonly credential: string;
  readonly explicitApprovedLoopback?: {
    readonly host: "127.0.0.1" | "::1";
    readonly port: number;
  };
};
export type CognitiveAppPath =
  "describe" | "invoke" | "objects/read" | "receipts/read";
export type HostDnsLookup = (
  hostname: string,
) => Promise<readonly { readonly address: string; readonly family: number }[]>;
type Reason =
  | "invalid-binding"
  | "invalid-request"
  | "denied-address"
  | "dns"
  | "timeout"
  | "cancelled"
  | "network"
  | "response"
  | "lease-used";
const messages: Record<Reason, string> = {
  "invalid-binding": "应用连接配置无效。",
  "invalid-request": "应用请求格式或预算无效。",
  "denied-address": "应用连接地址不符合网络安全策略。",
  dns: "无法确认应用服务地址。",
  timeout: "应用服务请求超时；操作结果可能尚未确定。",
  cancelled: "应用服务请求已取消；已发出的操作不会因此回滚。",
  network: "无法完成应用服务请求；操作结果可能尚未确定。",
  response: "应用服务响应无效；操作结果可能尚未确定。",
  "lease-used": "应用请求许可已使用或已释放。",
};
/** No external message, cause, URL, DNS record, body or private alias escapes. */
export class CognitiveAppTransportError extends Error {
  constructor(readonly reason: Reason) {
    super(messages[reason]);
    this.name = "CognitiveAppTransportError";
  }
}
function fail(reason: Reason): never {
  throw new CognitiveAppTransportError(reason);
}
const maxWireBytes = 512 * 1024;
const paths = new Set<CognitiveAppPath>([
  "describe",
  "invoke",
  "objects/read",
  "receipts/read",
]);

const denied4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  denied4.addSubnet(network, prefix, "ipv4");
const ordinary6 = new BlockList();
ordinary6.addSubnet("2000::", 3, "ipv6");
const denied6 = new BlockList();
for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  denied6.addSubnet(network, prefix, "ipv6");

/** First-v1 conservative public-unicast policy, not a claim of full IANA support. */
export function isPublicCognitiveAppAddress(address: string) {
  if (typeof address !== "string" || address.includes("%")) return false;
  const family = isIP(address);
  return family === 4
    ? !denied4.check(address, "ipv4")
    : family === 6 &&
        ordinary6.check(address, "ipv6") &&
        !denied6.check(address, "ipv6");
}
const defaultLookup: HostDnsLookup = (hostname) =>
  systemLookup(hostname, { all: true, order: "verbatim" });
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      cleanup();
      reject(new CognitiveAppTransportError("cancelled"));
    };
    const cleanup = () => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    work.then(
      (value) => {
        cleanup();
        if (signal.aborted) aborted();
        else resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(
          signal.aborted ? new CognitiveAppTransportError("cancelled") : error,
        );
      },
    );
    if (signal.aborted) aborted();
  });
}

/** Host/test seam only: the socket's lookup is this checked value, never DNS again. */
export async function resolveCognitiveAppAddress(
  hostname: string,
  lookup: HostDnsLookup = defaultLookup,
  signal: AbortSignal,
) {
  if (signal.aborted) fail("cancelled");
  let records: Awaited<ReturnType<HostDnsLookup>>;
  try {
    const literalFamily = isIP(hostname);
    records = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : await abortable(lookup(hostname), signal);
  } catch (error) {
    if (signal.aborted) fail("cancelled");
    if (error instanceof CognitiveAppTransportError) throw error;
    fail("dns");
  }
  if (signal.aborted) fail("cancelled");
  if (
    !Array.isArray(records) ||
    records.length === 0 ||
    records.length > 16 ||
    records.some(
      (record) =>
        !record ||
        (record.family !== 4 && record.family !== 6) ||
        typeof record.address !== "string" ||
        isIP(record.address) !== record.family ||
        !isPublicCognitiveAppAddress(record.address),
    )
  )
    fail("denied-address");
  const first = records[0]!;
  const address = first.address,
    family = first.family as 4 | 6;
  const pinned: LookupFunction = (name, options, callback) => {
    queueMicrotask(() => {
      if (name !== hostname || (options.family && options.family !== family))
        callback(new CognitiveAppTransportError("denied-address"), "", family);
      else if (options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    });
  };
  return Object.freeze({ address, family, lookup: pinned });
}

function target(binding: CognitiveAppBinding) {
  try {
    if (
      typeof binding.baseUrl !== "string" ||
      binding.baseUrl.length > 2048 ||
      typeof binding.credential !== "string" ||
      !/^[\x21-\x7e]{1,4096}$/.test(binding.credential)
    )
      fail("invalid-binding");
    const url = new URL(binding.baseUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      fail("invalid-binding");
    const hostname = url.hostname.startsWith("[")
      ? url.hostname.slice(1, -1)
      : url.hostname;
    if (!hostname || hostname.length > 253) fail("invalid-binding");
    if (url.protocol === "https:" && !binding.explicitApprovedLoopback) {
      // Reject empty ?, # and @ syntax too: URL otherwise normalizes them away.
      if (
        binding.baseUrl !== url.origin &&
        binding.baseUrl !== `${url.origin}/`
      )
        fail("invalid-binding");
      return { url, hostname, credential: binding.credential, loopback: false };
    }
    const approved = binding.explicitApprovedLoopback;
    // Raw spelling is canonical numeric loopback: no localhost, decimal/octal/hex aliases.
    if (
      url.protocol !== "http:" ||
      !approved ||
      !Number.isInteger(approved.port) ||
      approved.port < 1 ||
      approved.port > 65535 ||
      (approved.host !== "127.0.0.1" && approved.host !== "::1") ||
      hostname !== approved.host ||
      Number(url.port || 80) !== approved.port ||
      !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]{1,5}\/?$/.test(binding.baseUrl)
    )
      fail("invalid-binding");
    return { url, hostname, credential: binding.credential, loopback: true };
  } catch {
    fail("invalid-binding");
  }
}

function send(
  selected: ReturnType<typeof target>,
  path: CognitiveAppPath,
  bytes: Buffer,
  pinned: Awaited<ReturnType<typeof resolveCognitiveAppAddress>> | undefined,
  signal: AbortSignal,
  checkDeadline: () => void,
): Promise<JsonValue> {
  return new Promise((resolve, reject) => {
    let request: ClientRequest | undefined,
      done = false;
    const finish = (error?: CognitiveAppTransportError, value?: JsonValue) => {
      if (done) return;
      done = true;
      if (error) {
        request?.destroy();
        reject(error);
      } else resolve(value!);
    };
    const options: RequestOptions & { autoSelectFamily: false } = {
      protocol: selected.url.protocol,
      hostname: selected.hostname,
      port: selected.url.port || (selected.loopback ? 80 : 443),
      method: "POST",
      path: `/${path}`,
      headers: {
        Host: selected.url.host,
        Authorization: `Bearer ${selected.credential}`,
        Accept: "application/json",
        "Accept-Encoding": "identity",
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": bytes.byteLength,
        Connection: "close",
      },
      // Node's env-proxy is configured on globalAgent; false creates a fresh,
      // unconfigured Agent and never inherits its proxyEnv or pooled sockets.
      agent: false,
      autoSelectFamily: false,
      family: pinned?.family ?? isIP(selected.hostname),
      lookup: pinned?.lookup,
      servername: isIP(selected.hostname) ? undefined : selected.hostname,
      rejectUnauthorized: true,
      maxHeaderSize: 8 * 1024,
      signal,
    };
    try {
      checkDeadline();
      request = (selected.loopback ? httpRequest : httpsRequest)(
        options,
        (response) => {
          if (done) {
            response.destroy();
            return;
          }
          const type = response.headers["content-type"],
            encoding = response.headers["content-encoding"],
            length = response.headers["content-length"];
          if (
            !response.statusCode ||
            response.statusCode < 200 ||
            response.statusCode >= 300 ||
            typeof type !== "string" ||
            !/^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/i.test(
              type,
            ) ||
            (encoding !== undefined && encoding.toLowerCase() !== "identity") ||
            (length !== undefined &&
              (!/^\d+$/.test(length) || Number(length) > maxWireBytes))
          ) {
            finish(new CognitiveAppTransportError("response"));
            response.destroy();
            return;
          }
          const body = Buffer.allocUnsafe(maxWireBytes);
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            if (done) return;
            if (size + chunk.byteLength > maxWireBytes) {
              finish(new CognitiveAppTransportError("response"));
              response.destroy();
              return;
            }
            chunk.copy(body, size);
            size += chunk.byteLength;
          });
          response.once("error", () =>
            finish(new CognitiveAppTransportError("response")),
          );
          response.once("aborted", () =>
            finish(new CognitiveAppTransportError("response")),
          );
          response.once("end", () => {
            if (done) return;
            try {
              checkDeadline();
              const json: unknown = JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(
                  body.subarray(0, size),
                ),
              );
              const parsed = parseWireJson(json);
              checkDeadline();
              finish(undefined, parsed);
            } catch (error) {
              finish(
                error instanceof CognitiveAppTransportError
                  ? error
                  : new CognitiveAppTransportError("response"),
              );
            }
          });
        },
      );
      request.once("error", (error: NodeJS.ErrnoException) =>
        finish(
          new CognitiveAppTransportError(
            error.code?.startsWith("HPE_") ? "response" : "network",
          ),
        ),
      );
      // Exactly one POST. No redirect, auth retry, endpoint fallback or retry on reset.
      checkDeadline();
      request.end(bytes);
    } catch (error) {
      finish(
        error instanceof CognitiveAppTransportError
          ? error
          : new CognitiveAppTransportError("network"),
      );
    }
  });
}

export type CognitiveAppTransportLease = {
  post(
    binding: CognitiveAppBinding,
    path: CognitiveAppPath,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<JsonValue>;
  release(): void;
};
const issuedLeases = new WeakSet<object>();
/** Host-private runtime brand. Structural copies/Proxies are not permits. */
export function isCognitiveAppTransportLease(
  value: unknown,
): value is CognitiveAppTransportLease {
  return typeof value === "object" && value !== null && issuedLeases.has(value);
}
// Shared by every transport in this Host process; creating another instance is
// not a way around capacity. Keys are trusted connection identities, not URLs.
let hostActive = 0;
const connectionActive = new Map<string, number>();

export class CognitiveAppTransport {
  private readonly lookup: HostDnsLookup;
  private readonly deadlineMs: number;
  constructor(options: { lookup?: HostDnsLookup; deadlineMs?: number } = {}) {
    const deadline = options.deadlineMs ?? 30_000;
    if (!Number.isInteger(deadline) || deadline < 1 || deadline > 30_000)
      fail("invalid-request");
    this.lookup = options.lookup ?? defaultLookup;
    this.deadlineMs = deadline;
  }
  /** Acquire before SQL admission; no queue and no network while holding SQL locks. */
  tryAcquire(connectionKey: string): CognitiveAppTransportLease | null {
    if (
      typeof connectionKey !== "string" ||
      connectionKey.length < 1 ||
      connectionKey.length > 1024
    )
      fail("invalid-request");
    const active = connectionActive.get(connectionKey) ?? 0;
    if (hostActive >= 16 || active >= 2) return null;
    hostActive++;
    connectionActive.set(connectionKey, active + 1);
    let state: "ready" | "running" | "finished" = "ready",
      counted = true;
    const releaseCount = () => {
      if (!counted) return;
      counted = false;
      hostActive--;
      const remaining = connectionActive.get(connectionKey)! - 1;
      if (remaining) connectionActive.set(connectionKey, remaining);
      else connectionActive.delete(connectionKey);
    };
    const lease: CognitiveAppTransportLease = Object.freeze({
      release: () => {
        if (state === "ready") {
          state = "finished";
          releaseCount();
        }
      },
      post: async (
        binding: CognitiveAppBinding,
        path: CognitiveAppPath,
        payload: unknown,
        signal?: AbortSignal,
      ): Promise<JsonValue> => {
        if (state !== "ready") fail("lease-used");
        state = "running";
        const deadlineAt = performance.now() + this.deadlineMs;
        const controller = new AbortController();
        let timedOut = false,
          dnsPending = false,
          dnsWork: Promise<void> | undefined;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, this.deadlineMs);
        const checkDeadline = () => {
          if (performance.now() >= deadlineAt) {
            timedOut = true;
            controller.abort();
            fail("timeout");
          }
          if (controller.signal.aborted) fail("cancelled");
        };
        const cancel = () => controller.abort();
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
        try {
          checkDeadline();
          if (!paths.has(path)) fail("invalid-request");
          const selected = target(binding);
          let bytes: Buffer;
          try {
            bytes = Buffer.from(JSON.stringify(parseWireJson(payload)), "utf8");
          } catch {
            fail("invalid-request");
          }
          // Timers cannot run while JSON work blocks the event loop. Do not
          // begin DNS/TCP after synchronous validation/serialization used the budget.
          checkDeadline();
          const tracked: HostDnsLookup = (hostname) => {
            const work = this.lookup(hostname);
            dnsPending = true;
            dnsWork = work.then(
              () => {
                dnsPending = false;
              },
              () => {
                dnsPending = false;
              },
            );
            return work;
          };
          const pinned = selected.loopback
            ? undefined
            : await resolveCognitiveAppAddress(
                selected.hostname,
                tracked,
                controller.signal,
              );
          checkDeadline();
          const result = await send(
            selected,
            path,
            bytes,
            pinned,
            controller.signal,
            checkDeadline,
          );
          checkDeadline();
          return result;
        } catch (error) {
          if (performance.now() >= deadlineAt) {
            timedOut = true;
            controller.abort();
          }
          if (controller.signal.aborted)
            fail(timedOut ? "timeout" : "cancelled");
          if (error instanceof CognitiveAppTransportError) throw error;
          fail("network");
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          state = "finished";
          // System getaddrinfo cannot be cancelled. The late answer cannot dial,
          // but its retained permit prevents a stream of timed-out DNS jobs.
          if (dnsPending && dnsWork) void dnsWork.then(releaseCount);
          else releaseCount();
        }
      },
    });
    issuedLeases.add(lease);
    return lease;
  }
}
