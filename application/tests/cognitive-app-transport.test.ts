import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  CognitiveAppTransport,
  CognitiveAppTransportError,
  isPublicCognitiveAppAddress,
  resolveCognitiveAppAddress,
  type CognitiveAppBinding,
  type CognitiveAppPath,
  type HostDnsLookup,
} from "../packages/application/src/cognitive-app-transport.js";

const execFileAsync = promisify(execFile);
const privateToken = "fixture-only-private-author-credential";
type Mode =
  | "ok"
  | "redirect"
  | "error"
  | "compressed"
  | "large"
  | "invalid-utf8"
  | "bad-json"
  | "deep"
  | "headers"
  | "hang"
  | "slow";

async function fixture() {
  const requests: {
    method: string;
    path: string;
    headers: IncomingMessage["headers"];
    body: string;
  }[] = [];
  const state: { mode: Mode } = { mode: "ok" };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    requests.push({
      method: request.method!,
      path: request.url!,
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    if (state.mode === "hang") return;
    if (state.mode === "redirect") {
      response.writeHead(307, { Location: `/redirect?secret=${privateToken}` });
      response.end(JSON.stringify({ error: privateToken }));
    } else if (state.mode === "error") {
      response.writeHead(503);
      response.end(JSON.stringify({ error: privateToken }));
    } else if (state.mode === "compressed") {
      response.setHeader("Content-Encoding", "gzip");
      response.end("{}");
    } else if (state.mode === "large") {
      response.write('"');
      response.end("x".repeat(512 * 1024) + '"');
    } else if (state.mode === "invalid-utf8") {
      response.end(Buffer.from([0x22, 0xc3, 0x28, 0x22]));
    } else if (state.mode === "bad-json") {
      response.end(`not-json-${privateToken}`);
    } else if (state.mode === "deep") {
      response.end("[".repeat(41) + "0" + "]".repeat(41));
    } else if (state.mode === "headers") {
      response.setHeader("X-Large", "x".repeat(9000));
      response.end("{}");
    } else if (state.mode === "slow") {
      response.write("[");
      const timer = setInterval(() => response.write(" "), 5);
      response.once("close", () => clearInterval(timer));
    } else response.end(JSON.stringify({ path: request.url, accepted: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    state,
    requests,
    binding: {
      baseUrl: `http://127.0.0.1:${port}`,
      credential: privateToken,
      explicitApprovedLoopback: { host: "127.0.0.1", port },
    } satisfies CognitiveAppBinding,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
function errorWith(reason?: CognitiveAppTransportError["reason"]) {
  return (error: unknown) => {
    assert.ok(error instanceof CognitiveAppTransportError);
    if (reason) assert.equal(error.reason, reason);
    for (const sensitive of [
      privateToken,
      "private-alias",
      "private.example",
    ]) {
      assert.equal(String(error).includes(sensitive), false);
      assert.equal(JSON.stringify(error).includes(sensitive), false);
      assert.equal(error.stack?.includes(sensitive), false);
    }
    assert.equal("cause" in error, false);
    return true;
  };
}
async function sent(requests: unknown[], count: number) {
  const deadline = Date.now() + 1000;
  while (requests.length < count) {
    assert.ok(
      Date.now() < deadline,
      "isolated server should observe the actual request",
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("public address policy rejects every first-v1 special IPv4 range and disguised IPv6", () => {
  for (const address of [
    "0.1.2.3",
    "10.0.0.1",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.9",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.0.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:8.8.8.8",
    "::ffff:127.0.0.1",
    "64:ff9b::808:808",
    "64:ff9b:1::1",
    "100::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001::1",
    "2001:1ff:ffff::1",
    "2001:db8::1",
    "2002:808:808::1",
    "3fff::1",
    "3fff:f::1",
    "2606:4700::1%eth0",
    "not-an-ip",
    "0177.0.0.1",
    "8.8.8.8 ",
  ])
    assert.equal(isPublicCognitiveAppAddress(address), false, address);
  for (const address of [
    "8.8.8.8",
    "1.1.1.1",
    "100.63.255.255",
    "100.128.0.1",
    "172.15.255.255",
    "172.32.0.1",
    "198.17.255.255",
    "198.20.0.1",
    "223.255.255.255",
    "2606:4700:4700::1111",
    "2a00:1450::1",
    "2001:200::1",
    "3fff:1000::1",
  ])
    assert.equal(isPublicCognitiveAppAddress(address), true, address);
});

test("DNS validates all bounded records and pins the checked numeric address without a second resolution", async () => {
  let resolutions = 0;
  const dns: HostDnsLookup = async () => {
    resolutions++;
    return [
      { address: resolutions === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 },
      { address: "2606:4700::1111", family: 6 },
    ];
  };
  const pinned = await resolveCognitiveAppAddress(
    "public.example",
    dns,
    new AbortController().signal,
  );
  assert.equal(pinned.address, "8.8.8.8");
  assert.equal(pinned.family, 4);
  for (let index = 0; index < 3; index++) {
    await new Promise<void>((resolve, reject) =>
      pinned.lookup(
        "public.example",
        { family: 4 },
        (error, address, family) => {
          if (error) return reject(error);
          assert.equal(address, "8.8.8.8");
          assert.equal(family, 4);
          resolve();
        },
      ),
    );
  }
  assert.equal(resolutions, 1);
  for (const records of [
    [],
    Array.from({ length: 17 }, () => ({ address: "8.8.8.8", family: 4 })),
    [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
    [{ address: "8.8.8.8", family: 6 }],
    [{ address: "2606:4700::1111", family: 4 }],
    [{ address: "invalid", family: 4 }],
  ])
    await assert.rejects(
      resolveCognitiveAppAddress(
        "public.example",
        async () => records,
        new AbortController().signal,
      ),
      errorWith("denied-address"),
    );
});

test("all four fixed paths use the actual approved HTTP service with only Host-owned auth headers", async () => {
  const local = await fixture();
  try {
    const transport = new CognitiveAppTransport({
      lookup: async () => {
        throw new Error("numeric approved loopback must not use DNS");
      },
    });
    for (const path of [
      "describe",
      "invoke",
      "objects/read",
      "receipts/read",
    ] satisfies CognitiveAppPath[]) {
      const lease = transport.tryAcquire("fixture-connection")!;
      assert.deepEqual(
        await lease.post(local.binding, path, {
          parameters: {
            endpoint: "business text, not a route",
            headers: { Authorization: "caller text" },
          },
        }),
        { path: `/${path}`, accepted: true },
      );
      const request = local.requests.at(-1)!;
      assert.equal(request.method, "POST");
      assert.equal(request.path, `/${path}`);
      assert.equal(request.headers.authorization, `Bearer ${privateToken}`);
      assert.equal(request.headers["accept-encoding"], "identity");
      assert.equal(
        request.headers["content-type"],
        "application/json; charset=utf-8",
      );
      assert.equal(request.headers.cookie, undefined);
      assert.equal(request.headers["x-morphz-token"], undefined);
      assert.deepEqual(JSON.parse(request.body), {
        parameters: {
          endpoint: "business text, not a route",
          headers: { Authorization: "caller text" },
        },
      });
      await assert.rejects(
        lease.post(local.binding, path, {}),
        errorWith("lease-used"),
      );
    }
    assert.equal(local.requests.length, 4);
  } finally {
    await local.close();
  }
});

test("unapproved routes, credentials in URLs, aliases and noncanonical loopback never contact a server", async () => {
  const local = await fixture();
  try {
    let dnsCalls = 0;
    const transport = new CognitiveAppTransport({
      lookup: async () => {
        dnsCalls++;
        return [];
      },
    });
    const port = local.binding.explicitApprovedLoopback.port;
    for (const binding of [
      { ...local.binding, explicitApprovedLoopback: undefined },
      { ...local.binding, baseUrl: `http://localhost:${port}` },
      { ...local.binding, baseUrl: `http://2130706433:${port}` },
      { ...local.binding, baseUrl: `http://0x7f000001:${port}` },
      { ...local.binding, baseUrl: `http://127.0.0.1:${port}/extra` },
      {
        ...local.binding,
        baseUrl: `${local.binding.baseUrl}?secret=${privateToken}`,
      },
      { ...local.binding, baseUrl: `${local.binding.baseUrl}#fragment` },
      {
        ...local.binding,
        baseUrl: `http://user:${privateToken}@127.0.0.1:${port}`,
      },
      {
        ...local.binding,
        explicitApprovedLoopback: {
          host: "127.0.0.1" as const,
          port: port + 1,
        },
      },
      { ...local.binding, credential: `${privateToken}\r\nInjected: true` },
      { baseUrl: "https://127.0.0.1", credential: privateToken },
      { baseUrl: "https://private.example?", credential: privateToken },
      { baseUrl: "https://private.example#", credential: privateToken },
      { baseUrl: "https://@private.example", credential: privateToken },
      {
        baseUrl: "https://private.example",
        credential: privateToken,
        explicitApprovedLoopback: { host: "127.0.0.1" as const, port },
      },
    ])
      await assert.rejects(
        transport.tryAcquire("private-alias")!.post(binding, "invoke", {}),
        errorWith(),
      );
    await assert.rejects(
      transport
        .tryAcquire("fixture")!
        .post(local.binding, "../redirect" as CognitiveAppPath, {}),
      errorWith("invalid-request"),
    );
    assert.equal(local.requests.length, 0);
    assert.equal(dnsCalls, 0);
  } finally {
    await local.close();
  }
});

test("HTTPS DNS failure or any unsafe record fails closed with no network and no private diagnostics", async () => {
  for (const lookup of [
    async () => {
      throw new Error(`private.example ${privateToken}`);
    },
    async () => [{ address: "127.0.0.1", family: 4 }],
    async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "::ffff:169.254.169.254", family: 6 },
    ],
  ] satisfies HostDnsLookup[]) {
    const lease = new CognitiveAppTransport({ lookup }).tryAcquire(
      "private-alias",
    )!;
    await assert.rejects(
      lease.post(
        { baseUrl: "https://private.example", credential: privateToken },
        "invoke",
        {},
      ),
      errorWith(),
    );
  }
});

test("redirect and non-2xx responses are never followed or retried and never expose private response data", async () => {
  const local = await fixture();
  try {
    const transport = new CognitiveAppTransport();
    for (const mode of ["redirect", "error"] satisfies Mode[]) {
      local.state.mode = mode;
      const before = local.requests.length;
      await assert.rejects(
        transport.tryAcquire("fixture")!.post(local.binding, "invoke", {}),
        errorWith("response"),
      );
      assert.equal(local.requests.length, before + 1);
    }
    assert.ok(local.requests.every((request) => request.path === "/invoke"));
  } finally {
    await local.close();
  }
});

test("compressed, oversized, malformed, excessive-depth and excessive-header responses are bounded and sanitized", async () => {
  const local = await fixture();
  try {
    const transport = new CognitiveAppTransport();
    for (const mode of [
      "compressed",
      "large",
      "invalid-utf8",
      "bad-json",
      "deep",
      "headers",
    ] satisfies Mode[]) {
      local.state.mode = mode;
      await assert.rejects(
        transport.tryAcquire("fixture")!.post(local.binding, "describe", {}),
        errorWith("response"),
      );
    }
    assert.equal(local.requests.length, 6);
  } finally {
    await local.close();
  }
});

test("wire budget rejects malformed outbound values before the actual network request", async () => {
  const local = await fixture();
  try {
    const transport = new CognitiveAppTransport();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const payload of [
      cycle,
      { text: "x".repeat(512 * 1024) },
      { value: Infinity },
      Array(2),
    ])
      await assert.rejects(
        transport.tryAcquire("fixture")!.post(local.binding, "invoke", payload),
        errorWith("invalid-request"),
      );
    assert.equal(local.requests.length, 0);
  } finally {
    await local.close();
  }
});

test("absolute deadline covers hung and continuously trickling responses, not only idle sockets", async () => {
  const local = await fixture();
  try {
    for (const mode of ["hang", "slow"] satisfies Mode[]) {
      local.state.mode = mode;
      const transport = new CognitiveAppTransport({ deadlineMs: 70 });
      const start = Date.now();
      await assert.rejects(
        transport.tryAcquire("fixture")!.post(local.binding, "invoke", {}),
        errorWith("timeout"),
      );
      assert.ok(Date.now() - start < 1500);
      transport.tryAcquire("fixture")!.release();
    }
    assert.equal(local.requests.length, 2);
  } finally {
    await local.close();
  }
});

test("DNS deadline rejects promptly, retains capacity until lookup settles and never dials a late answer", async () => {
  let complete!: (records: { address: string; family: number }[]) => void;
  let observed = 0;
  const lookup: HostDnsLookup = () => {
    observed++;
    return new Promise((resolve) => {
      complete = resolve;
    });
  };
  const transport = new CognitiveAppTransport({ lookup, deadlineMs: 40 });
  const first = transport.tryAcquire("dns-held")!;
  const second = transport.tryAcquire("dns-held")!;
  await assert.rejects(
    first.post(
      { baseUrl: "https://private.example", credential: privateToken },
      "invoke",
      {},
    ),
    errorWith("timeout"),
  );
  first.release();
  assert.equal(transport.tryAcquire("dns-held"), null);
  second.release();
  assert.equal(observed, 1);
  complete([{ address: "127.0.0.1", family: 4 }]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const restored = transport.tryAcquire("dns-held")!;
  assert.ok(restored);
  restored.release();
});

test("synchronous outbound JSON work cannot start an HTTP request after its monotonic deadline", async () => {
  const local = await fixture();
  const original = JSON.stringify;
  const payload = { marker: "outbound-budget" };
  let blocked = 0;
  JSON.stringify = ((value: unknown, ...args: unknown[]) => {
    if (value === payload) {
      blocked++;
      const until = performance.now() + 25;
      while (performance.now() < until) {
        /* Controlled synchronous CPU delay, not a timer. */
      }
    }
    return Reflect.apply(original, JSON, [value, ...args]);
  }) as typeof JSON.stringify;
  try {
    const transport = new CognitiveAppTransport({ deadlineMs: 5 });
    await assert.rejects(
      transport
        .tryAcquire("outbound-budget")!
        .post(local.binding, "invoke", payload),
      errorWith("timeout"),
    );
    assert.equal(blocked, 1);
    assert.equal(local.requests.length, 0);
    transport.tryAcquire("outbound-budget")!.release();
  } finally {
    JSON.stringify = original;
    await local.close();
  }
});

test("synchronous response JSON work cannot report success after its monotonic deadline", async () => {
  const local = await fixture();
  const original = JSON.parse;
  let blocked = 0;
  JSON.parse = ((text: string, ...args: unknown[]) => {
    if (text.includes('"accepted":true')) {
      blocked++;
      const until = performance.now() + 550;
      while (performance.now() < until) {
        /* Timer cannot execute during this parse hook. */
      }
    }
    return Reflect.apply(original, JSON, [text, ...args]);
  }) as typeof JSON.parse;
  try {
    const transport = new CognitiveAppTransport({ deadlineMs: 500 });
    await assert.rejects(
      transport
        .tryAcquire("response-budget")!
        .post(local.binding, "invoke", {}),
      errorWith("timeout"),
    );
    assert.equal(blocked, 1);
    assert.equal(local.requests.length, 1);
    transport.tryAcquire("response-budget")!.release();
  } finally {
    JSON.parse = original;
    await local.close();
  }
});

test("leases enforce global Host16 and per-connection2 across instances, including premature release and parallel post", async () => {
  const local = await fixture();
  const controller = new AbortController();
  try {
    local.state.mode = "hang";
    const transport = new CognitiveAppTransport();
    const other = new CognitiveAppTransport();
    const first = transport.tryAcquire("capacity-held")!,
      second = other.tryAcquire("capacity-held")!;
    assert.equal(transport.tryAcquire("capacity-held"), null);
    const remaining = Array.from({ length: 14 }, (_, index) =>
      transport.tryAcquire(`capacity-${index}`)!,
    );
    assert.ok(remaining.every(Boolean));
    assert.equal(other.tryAcquire("seventeenth"), null);
    const a = first.post(local.binding, "invoke", {}, controller.signal),
      b = second.post(local.binding, "invoke", {}, controller.signal);
    const observedErrors = Promise.all([
      assert.rejects(a, errorWith("cancelled")),
      assert.rejects(b, errorWith("cancelled")),
    ]);
    await sent(local.requests, 2);
    first.release();
    second.release();
    assert.equal(other.tryAcquire("capacity-held"), null);
    assert.equal(other.tryAcquire("seventeenth"), null);
    await assert.rejects(
      first.post(local.binding, "invoke", {}),
      errorWith("lease-used"),
    );
    for (const lease of remaining) lease.release();
    controller.abort(new Error(privateToken));
    await observedErrors;
    const replacement = other.tryAcquire("capacity-held")!;
    assert.ok(replacement);
    replacement.release();
    assert.equal(local.requests.length, 2);
  } finally {
    controller.abort();
    await local.close();
  }
});

test("released unused leases cannot send and caller abort reasons never leak", async () => {
  const local = await fixture();
  try {
    const transport = new CognitiveAppTransport();
    const lease = transport.tryAcquire("fixture")!;
    lease.release();
    lease.release();
    await assert.rejects(
      lease.post(local.binding, "invoke", {}),
      errorWith("lease-used"),
    );
    const aborted = new AbortController();
    aborted.abort(new Error(privateToken));
    await assert.rejects(
      transport
        .tryAcquire("fixture")!
        .post(local.binding, "invoke", {}, aborted.signal),
      errorWith("cancelled"),
    );
    assert.equal(local.requests.length, 0);
  } finally {
    await local.close();
  }
  for (const deadlineMs of [0, -1, Infinity, 30001])
    assert.throws(
      () => new CognitiveAppTransport({ deadlineMs }),
      errorWith("invalid-request"),
    );
});

test("Node environment proxies cannot intercept an actual approved loopback request", async () => {
  const local = await fixture();
  let proxyRequests = 0;
  const proxy = createServer((_request, response) => {
    proxyRequests++;
    response.end("{}");
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const module = new URL(
      "../packages/application/src/cognitive-app-transport.ts",
      import.meta.url,
    ).href;
    const script = `import { CognitiveAppTransport } from ${JSON.stringify(module)}; const lease=new CognitiveAppTransport().tryAcquire("proxy-check"); const result=await lease.post(${JSON.stringify(local.binding)},"invoke",{}); process.stdout.write(JSON.stringify(result));`;
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        env: {
          NODE_USE_ENV_PROXY: "1",
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          ALL_PROXY: proxyUrl,
          NO_PROXY: "",
        },
        timeout: 10000,
        maxBuffer: 65536,
      },
    );
    assert.deepEqual(JSON.parse(result.stdout), {
      path: "/invoke",
      accepted: true,
    });
    assert.equal(proxyRequests, 0);
    assert.equal(local.requests.length, 1);
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await local.close();
  }
});
