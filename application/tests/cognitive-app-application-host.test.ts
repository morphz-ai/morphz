import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { PlatformStore } from "../packages/platform/src/store.js";
import {
  Application,
  type ApplicationOptions,
} from "../packages/application/src/application.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { HumanPlatformAuthority } from "../packages/application/src/human-platform-authority.js";
import {
  CognitiveAppServiceError,
  type CognitiveAppService,
} from "../packages/application/src/cognitive-app-service.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { IdentityCenter } from "../packages/application/src/identity.js";
import { createAppServer } from "../apps/service/src/http.js";
import { RemoteApplicationConnection } from "../apps/desktop/remote-host.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import {
  ApplicationRequestError,
  applicationMethods,
  type ApplicationReply,
} from "../packages/core/src/application-api.js";
import { localAccess } from "../packages/core/src/model.js";
import type { CognitiveAppMethod } from "../packages/core/src/cognitive-app-api.js";

const definition = JSON.parse(
  readFileSync(
    new URL("../examples/cognitive-notes/definition.json", import.meta.url),
    "utf8",
  ),
);
const target = {
  projectId: "project",
  appId: definition.id,
  version: definition.version,
  connectionId: "connection",
};
const command = { ...target, commandId: "original_command" };
const cases: [string, CognitiveAppMethod, unknown][] = [
  ["list", "list", { limit: 10 }],
  [
    "describe",
    "describe",
    { projectId: "project", appId: definition.id, version: definition.version },
  ],
  ["install", "install", { definition }],
  [
    "grant",
    "grant",
    {
      appId: definition.id,
      version: definition.version,
      expectedRevision: 0,
      state: "active",
    },
  ],
  [
    "connect",
    "connect",
    {
      appId: definition.id,
      version: definition.version,
      connectionId: "connection",
      expectedRevision: 0,
      serviceId: "service",
      dataAuthorityId: "data",
    },
  ],
  [
    "connection-state",
    "connectionState",
    {
      appId: definition.id,
      version: definition.version,
      connectionId: "connection",
      expectedRevision: 1,
      state: "disabled",
    },
  ],
  [
    "invoke",
    "invoke",
    {
      ...command,
      operationId: "notes.create",
      parameters: { title: "Draft", markdown: "Original" },
      resources: [],
    },
  ],
  [
    "read-object",
    "readObject",
    {
      ...target,
      object: { objectId: "object", versionRef: "v1" },
      maxBytes: 1024,
    },
  ],
  ["command-status", "commandStatus", command],
  ["recover", "recover", command],
];
const value = (reply: ApplicationReply): any => {
  assert.ok(reply.ok, JSON.stringify(reply));
  return reply.ok ? reply.value : undefined;
};
const invoke = (
  host: LocalApplicationConnection | RemoteApplicationConnection,
  method: string,
  params?: unknown,
  identityGeneration?: string,
) => host.invoke({ id: randomUUID(), method, params, identityGeneration });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** UNIT fakeService: real HPA, identity/session and transport only. This is not
 * an author-service or SQL domain authorization acceptance fixture. */
function unit() {
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  const events: {
    method: CognitiveAppMethod;
    request: any;
    principalId: string;
  }[] = [];
  const state = {
    verify: undefined as (() => Promise<void>) | undefined,
    work: undefined as (() => Promise<void>) | undefined,
    error: undefined as CognitiveAppServiceError | undefined,
    active: true,
  };
  const authority = new HumanPlatformAuthority("tenant", async () => {
    await state.verify?.();
    return state.active;
  });
  const verifier = authority.verifier({
    resolveActor: async () => null,
    resolveActant: async () => null,
    resolveProjectAgent: async () => null,
    verifyApplicationObject: async () => false,
  });
  const service = Object.fromEntries(
    cases.map(([, method]) => [
      method,
      async (actor: { credential: string }, request: unknown) => {
        const actual = await verifier.resolveActor(actor);
        assert.ok(actual);
        events.push({ method, request, principalId: actual.principalId });
        await state.work?.();
        if (state.error) throw state.error;
        return { method, request, principalId: actual.principalId };
      },
    ]),
  ) as unknown as CognitiveAppService;
  const options = {
    cognitiveApps: { authority, service },
  } as ApplicationOptions;
  const host = new LocalApplicationConnection(new Application(store, options));
  return {
    store,
    events,
    state,
    authority,
    verifier,
    service,
    options,
    host,
    close: () => {
      host.close();
      store.close();
    },
  };
}
async function httpUnit(f: ReturnType<typeof unit>, identity?: IdentityCenter) {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const server = createAppServer(f.store, {
    ...f.options,
    identity,
    port,
    webRoot: "/nonexistent",
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    server,
    close: async () => {
      server.closeStreams();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

test("UNIT fakeService: exactly ten public methods share real Local session/HPA and reject Host-only names", async () => {
  const f = unit();
  try {
    const boot = value(await invoke(f.host, "platform.bootstrap"));
    for (const [suffix, method, params] of cases) {
      assert.ok(
        (applicationMethods as readonly string[]).includes(
          `cognitive-apps.${suffix}`,
        ),
      );
      assert.deepEqual(
        value(
          await invoke(
            f.host,
            `cognitive-apps.${suffix}`,
            params,
            boot.csrfToken,
          ),
        ),
        { method, request: params, principalId: localAccess.principalId },
      );
    }
    for (const suffix of [
      "prepare",
      "resolve",
      "tenant",
      "page-recovery",
      "record-receipt",
      "sql",
      "verified-ui",
    ])
      assert.equal(
        (await invoke(f.host, `cognitive-apps.${suffix}`, {}, boot.csrfToken))
          .ok,
        false,
      );
    assert.equal(f.events.length, 10);
  } finally {
    f.close();
  }
});

test("UNIT fakeService: Session parses independent nested parameters before the HPA identity await", async () => {
  const f = unit(),
    entered = deferred(),
    release = deferred();
  const input = structuredClone(cases[6]![2]) as any;
  f.state.verify = async () => {
    entered.resolve();
    await release.promise;
  };
  try {
    const result = f.host.application
      .session(localAccess)
      .cognitiveApp("invoke", input);
    await entered.promise;
    input.commandId = "changed_command";
    input.parameters.markdown = "Changed during identity await";
    input.resources.push({ objectId: "changed", versionRef: "changed" });
    release.resolve();
    const returned = (await result) as any;
    assert.equal(returned.request.commandId, "original_command");
    assert.equal(returned.request.parameters.markdown, "Original");
    assert.deepEqual(returned.request.resources, []);
    assert.equal(f.events.length, 1);
  } finally {
    release.resolve();
    f.close();
  }
});

test("UNIT fakeService: Local/HTTP/Remote clients reject getters and toJSON before serialization or authority work", async () => {
  const f = unit();
  let reads = 0,
    fetches = 0,
    verifies = 0;
  f.state.verify = async () => {
    verifies++;
  };
  const client = new HttpApplicationClient("https://unit.invalid", async () => {
    fetches++;
    return Response.json({});
  });
  const remote = new RemoteApplicationConnection(
    "https://unit.invalid",
    async () => {
      fetches++;
      return Response.json({});
    },
  );
  const malicious = Object.defineProperty({}, "limit", {
    enumerable: true,
    get() {
      reads++;
      return 1;
    },
  });
  const serializer = {
    limit: 1,
    toJSON() {
      reads++;
      return { limit: 1 };
    },
  };
  try {
    const boot = value(await invoke(f.host, "platform.bootstrap"));
    for (const params of [malicious, serializer]) {
      for (const host of [f.host, remote])
        await assert.rejects(
          host.call("cognitive-apps.list", params, {
            identityGeneration: boot.csrfToken,
          }),
        );
      await assert.rejects(client.call("cognitive-apps.list", params));
      assert.equal(
        (await invoke(f.host, "cognitive-apps.list", params, boot.csrfToken))
          .ok,
        false,
      );
    }
    assert.equal(reads, 0);
    assert.equal(fetches, 0);
    assert.equal(verifies, 0);
  } finally {
    remote.close();
    f.close();
  }
});

test("UNIT fakeService: missing Facade does not fall back to legacy workspace and retains original command identity", async () => {
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  const host = new LocalApplicationConnection(new Application(store));
  try {
    const boot = value(await invoke(host, "platform.bootstrap"));
    const result = await invoke(
      host,
      "cognitive-apps.invoke",
      cases[6]![2],
      boot.csrfToken,
    );
    assert.equal(result.ok, false);
    if (!result.ok)
      assert.deepEqual(result.error, {
        status: 503,
        code: "unavailable",
        message: "应用服务暂不可用；已有命令事实保留。",
        commandId: "original_command",
      });
  } finally {
    host.close();
    store.close();
  }
});

test("UNIT fakeService: Local cancellation and identity invalidation retain original ID without replay", async () => {
  for (const action of ["cancel", "invalidate"] as const) {
    const f = unit(),
      entered = deferred(),
      release = deferred();
    f.state.work = async () => {
      entered.resolve();
      await release.promise;
    };
    try {
      const boot = value(await invoke(f.host, "platform.bootstrap"));
      const id = randomUUID();
      const pending = f.host.invoke({
        id,
        method: "cognitive-apps.invoke",
        params: cases[6]![2],
        identityGeneration: boot.csrfToken,
      });
      await entered.promise;
      if (action === "cancel") f.host.cancel(id);
      else f.host.invalidate();
      release.resolve();
      const reply = await pending;
      assert.equal(reply.ok, false);
      if (!reply.ok) {
        assert.equal(reply.error.status, 408);
        assert.equal(reply.error.commandId, "original_command");
      }
      assert.equal(f.events.length, 1);
      const stale = await invoke(
        f.host,
        "cognitive-apps.invoke",
        cases[6]![2],
        "stale",
      );
      assert.equal(stale.ok, false);
      if (!stale.ok) {
        assert.equal(stale.error.status, 403);
        assert.equal(stale.error.commandId, "original_command");
      }
      assert.equal(f.events.length, 1);
    } finally {
      release.resolve();
      f.close();
    }
  }
});

test("UNIT fakeService: actual HTTP rejects fatal UTF8 and bounds JSON bytes separately from legal escaped UI HTML", async () => {
  const f = unit(),
    h = await httpUnit(f);
  try {
    const boot = await (
      await fetch(h.origin + "/api/platform/bootstrap")
    ).json();
    const headers = {
      Origin: h.origin,
      "Content-Type": "application/json",
      "X-Morphz-Token": boot.csrfToken,
    };
    const post = (suffix: string, body: string | Buffer) =>
      fetch(h.origin + `/api/platform/cognitive-apps/${suffix}`, {
        method: "POST",
        headers,
        body: typeof body === "string" ? body : new Uint8Array(body),
      });
    const validInvokeJson = JSON.stringify(cases[6]![2]);
    const bodyOffset = validInvokeJson.indexOf("Original");
    const badUtf8 = Buffer.concat([
      Buffer.from(validInvokeJson.slice(0, bodyOffset)),
      Buffer.from([0xc3, 0x28]),
      Buffer.from(validInvokeJson.slice(bodyOffset + "Original".length)),
    ]);
    assert.equal((await post("invoke", badUtf8)).status, 400);
    assert.equal(
      (await post("list", " ".repeat(512 * 1024) + '{"limit":1}')).status,
      400,
    );
    const html = "<!doctype html><body>" + '"\\'.repeat(499900) + "</body>";
    assert.ok(Buffer.byteLength(html) < 1_000_000);
    const guiDefinition = {
      ...definition,
      ui: {
        packageVersion: definition.version,
        sha256: createHash("sha256").update(html).digest("hex"),
      },
    };
    const manifest = {
      format: "morphz-app/v1",
      id: definition.id,
      version: definition.version,
      title: definition.title,
      description: definition.description,
      icon: definition.icon,
      permissions: [],
      harness: definition.harness,
      ui: { type: "sandbox", html },
    };
    const encoded = JSON.stringify({
      definition: guiDefinition,
      manifest,
      commandId: "ui_install",
    });
    assert.ok(Buffer.byteLength(encoded) > 1024 * 1024);
    assert.ok(Buffer.byteLength(encoded) < 8 * 1024 * 1024);
    const response = await post("install", encoded);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0]!.request.manifest.ui.html, html);
    assert.equal(
      (
        await post(
          "install",
          " ".repeat(8 * 1024 * 1024) + JSON.stringify({ definition }),
        )
      ).status,
      400,
    );
    assert.equal(f.events.length, 1);
  } finally {
    await h.close();
    f.close();
  }
});

test("UNIT fakeService: real cookie identity and CSRF rotation refuse anonymous and old-session calls", async () => {
  const f = unit();
  const tokens = ["c".repeat(64), "d".repeat(64)];
  const members = [localAccess, { principalId: "bob", actantId: "bob_human" }];
  const identity = new IdentityCenter(f.store, {
    version: 1,
    members: members.map((access, i) => ({
      ...access,
      enabled: true,
      loginTokenHash: createHash("sha256").update(tokens[i]!).digest("hex"),
    })),
  });
  const authPlatform = await PlatformStore.sqlite(":memory:", f.verifier);
  await authPlatform.provisionTenant(f.store.identity());
  await identity.bindPlatform(authPlatform, f.store.identity());
  const h = await httpUnit(f, identity);
  const login = (token: string) =>
    fetch(h.origin + "/api/identity/login", {
      method: "POST",
      headers: { Origin: h.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
  try {
    assert.equal(
      (
        await fetch(h.origin + "/api/platform/cognitive-apps/list", {
          method: "POST",
          headers: { Origin: h.origin, "Content-Type": "application/json" },
          body: '{"limit":1}',
        })
      ).status,
      401,
    );
    const first = await login(tokens[0]!);
    const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
    const boot = await (
      await fetch(h.origin + "/api/platform/bootstrap", {
        headers: { Cookie: cookie },
      })
    ).json();
    const post = (csrf: string, sessionCookie = cookie) =>
      fetch(h.origin + "/api/platform/cognitive-apps/list", {
        method: "POST",
        headers: {
          Origin: h.origin,
          "Content-Type": "application/json",
          "X-Morphz-Token": csrf,
          Cookie: sessionCookie,
        },
        body: '{"limit":1}',
      });
    assert.equal((await post(boot.csrfToken)).status, 200);
    const second = await login(tokens[1]!);
    const secondCookie = second.headers.get("set-cookie")!.split(";")[0]!;
    assert.equal((await post(boot.csrfToken, secondCookie)).status, 403);
    await identity.logout(identity.authenticate(cookie)!.sessionHash);
    assert.equal((await post(boot.csrfToken)).status, 401);
    assert.equal(f.events.length, 1);
    const relogin = await login(tokens[0]!);
    const freshCookie = relogin.headers.get("set-cookie")!.split(";")[0]!;
    const freshBoot = await (
      await fetch(h.origin + "/api/platform/bootstrap", {
        headers: { Cookie: freshCookie },
      })
    ).json();
    const entered = deferred(),
      release = deferred();
    f.state.work = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = fetch(h.origin + "/api/platform/cognitive-apps/invoke", {
      method: "POST",
      headers: {
        Origin: h.origin,
        "Content-Type": "application/json",
        "X-Morphz-Token": freshBoot.csrfToken,
        Cookie: freshCookie,
      },
      body: JSON.stringify(cases[6]![2]),
    });
    await entered.promise;
    await identity.logout(identity.authenticate(freshCookie)!.sessionHash);
    release.resolve();
    const late = await pending;
    assert.equal(late.status, 403);
    const lateError = await late.json();
    assert.equal(lateError.commandId, "original_command");
    assert.equal(lateError.code, "forbidden");
    assert.equal(f.events.length, 2);
    const local = new LocalApplicationConnection(
      new Application(f.store, { ...f.options, identity }),
    );
    try {
      const anonymous = await invoke(local, "platform.bootstrap");
      assert.equal(anonymous.ok, false);
      if (!anonymous.ok) assert.equal(anonymous.error.status, 401);
      await local.call("login", { token: tokens[0] });
      const localBoot = value(await invoke(local, "platform.bootstrap"));
      const localEntered = deferred(),
        localRelease = deferred();
      f.state.work = async () => {
        localEntered.resolve();
        await localRelease.promise;
      };
      const pendingLocal = invoke(
        local,
        "cognitive-apps.invoke",
        cases[6]![2],
        localBoot.csrfToken,
      );
      await localEntered.promise;
      await identity.logout(
        identity.authenticate(local.authenticationCookie())!.sessionHash,
      );
      localRelease.resolve();
      const localReply = await pendingLocal;
      assert.equal(localReply.ok, false);
      if (!localReply.ok) {
        assert.equal(localReply.error.status, 403);
        assert.equal(localReply.error.code, "forbidden");
        assert.equal(localReply.error.commandId, "original_command");
      }
      assert.equal(f.events.length, 3);
    } finally {
      local.close();
    }
  } finally {
    await h.close();
    f.close();
    await authPlatform.close();
  }
});

test("UNIT transport: Remote cancellation, identity change and unknown network failure retain ID without resend", async () => {
  for (const mode of ["network", "cancel", "identity"] as const) {
    const entered = deferred(),
      release = deferred();
    let sends = 0;
    const remote = new RemoteApplicationConnection(
      "https://unit.invalid",
      async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/platform/bootstrap")
          return Response.json({ csrfToken: "original_generation" });
        if (path === "/api/identity/login")
          return Response.json({ connected: true });
        assert.equal(path, "/api/platform/cognitive-apps/invoke");
        sends++;
        entered.resolve();
        await release.promise;
        if (mode === "network")
          throw new Error("https://private.invalid/secret credential");
        return Response.json({ accepted: true });
      },
    );
    try {
      await remote.call("platform.bootstrap");
      const id = randomUUID();
      const pending = remote.invoke({
        id,
        method: "cognitive-apps.invoke",
        params: cases[6]![2],
        identityGeneration: "original_generation",
      });
      await entered.promise;
      if (mode === "cancel") remote.cancel(id);
      if (mode === "identity") await remote.call("login", { token: "test" });
      release.resolve();
      const reply = await pending;
      assert.equal(reply.ok, false);
      if (!reply.ok) {
        assert.equal(reply.error.commandId, "original_command");
        assert.equal(reply.error.status, mode === "network" ? 503 : 408);
        assert.doesNotMatch(reply.error.message, /private\.invalid|credential/);
      }
      assert.equal(sends, 1);
    } finally {
      release.resolve();
      remote.close();
    }
  }
});

test("UNIT transport: already aborted public calls keep ID and never enter service/network", async () => {
  const f = unit();
  let sends = 0;
  const request: typeof fetch = async () => {
    sends++;
    throw new Error("fetch should reject abort");
  };
  const client = new HttpApplicationClient("https://unit.invalid", request);
  const remote = new RemoteApplicationConnection(
    "https://unit.invalid",
    request,
  );
  const controller = new AbortController();
  controller.abort();
  const check = (error: unknown) => {
    assert.ok(error instanceof ApplicationRequestError);
    assert.equal(error.status, 408);
    assert.equal(error.commandId, "original_command");
    return true;
  };
  try {
    for (const host of [f.host, remote, client])
      await assert.rejects(
        host.call("cognitive-apps.invoke", cases[6]![2], {
          signal: controller.signal,
        }),
        check,
      );
    assert.equal(f.events.length, 0);
    assert.equal(sends, 0);
  } finally {
    remote.close();
    f.close();
  }
});

test("UNIT fakeService: safe Facade error statuses and original command ID survive local, HTTP and remote", async () => {
  const f = unit(),
    h = await httpUnit(f);
  const client = new HttpApplicationClient(h.origin);
  const remote = new RemoteApplicationConnection(h.origin, fetch);
  const statuses = {
    invalid: 400,
    forbidden: 403,
    not_found: 404,
    conflict: 409,
    busy: 429,
    unavailable: 503,
    contract: 502,
  } as const;
  try {
    const localBoot = value(await invoke(f.host, "platform.bootstrap"));
    const boot = await (
      await fetch(h.origin + "/api/platform/bootstrap")
    ).json();
    const remoteBoot = (await remote.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    for (const [reason, status] of Object.entries(statuses)) {
      f.state.error = new CognitiveAppServiceError(
        reason as keyof typeof statuses,
      );
      const check = (error: unknown) => {
        assert.ok(error instanceof ApplicationRequestError);
        assert.equal(error.status, status);
        assert.equal(error.code, reason);
        assert.equal(error.commandId, "original_command");
        assert.doesNotMatch(error.message, /credential|route|secret/);
        return true;
      };
      await assert.rejects(
        f.host.call("cognitive-apps.invoke", cases[6]![2], {
          identityGeneration: localBoot.csrfToken,
        }),
        check,
      );
      await assert.rejects(
        client.call("cognitive-apps.invoke", cases[6]![2], {
          identityGeneration: boot.csrfToken,
        }),
        check,
      );
      await assert.rejects(
        remote.call("cognitive-apps.invoke", cases[6]![2], {
          identityGeneration: remoteBoot.csrfToken,
        }),
        check,
      );
    }
    assert.equal(f.events.length, 21);
  } finally {
    remote.close();
    await h.close();
    f.close();
  }
});

test("UNIT transport: uncertain network/cancel/late identity errors keep ID, redact private error and never retry", async () => {
  for (const mode of ["network", "cancel", "identity"] as const) {
    const entered = deferred(),
      release = deferred();
    let calls = 0;
    const client = new HttpApplicationClient(
      "https://unit.invalid",
      async (input) => {
        if (String(input).endsWith("/api/identity/login"))
          return Response.json({ connected: true });
        calls++;
        entered.resolve();
        await release.promise;
        if (mode === "network")
          throw new Error("private credential https://secret.invalid/route");
        return Response.json({ accepted: true });
      },
    );
    const controller = new AbortController();
    const pending = client.call("cognitive-apps.invoke", cases[6]![2], {
      signal: controller.signal,
    });
    await entered.promise;
    if (mode === "cancel") controller.abort();
    if (mode === "identity") await client.call("login", { token: "test" });
    release.resolve();
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof ApplicationRequestError);
      assert.equal(error.commandId, "original_command");
      assert.equal(error.status, mode === "network" ? 503 : 408);
      assert.doesNotMatch(error.message, /secret\.invalid|credential/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("UNIT fakeService: actual HTTP routes use POST/Origin/CSRF and no Host-only/query/GET entry", async () => {
  const f = unit(),
    h = await httpUnit(f);
  try {
    const boot = await (
      await fetch(h.origin + "/api/platform/bootstrap")
    ).json();
    const post = (
      suffix: string,
      params: unknown,
      headers: Record<string, string> = {},
    ) =>
      fetch(h.origin + `/api/platform/cognitive-apps/${suffix}`, {
        method: "POST",
        headers: {
          Origin: h.origin,
          "Content-Type": "application/json",
          "X-Morphz-Token": boot.csrfToken,
          ...headers,
        },
        body: JSON.stringify(params),
      });
    for (const [suffix, method, params] of cases) {
      const response = await post(suffix, params);
      assert.equal(response.status, 200, suffix);
      assert.deepEqual(await response.json(), {
        method,
        request: params,
        principalId: localAccess.principalId,
      });
    }
    const count = f.events.length;
    for (const suffix of [
      "sql",
      "prepare",
      "record-receipt",
      "list?tenantId=other",
      "list/",
    ])
      assert.notEqual((await post(suffix, { limit: 1 })).status, 200);
    assert.notEqual(
      (await fetch(h.origin + "/api/platform/cognitive-apps/list")).status,
      200,
    );
    assert.equal(
      (await post("list", { limit: 1 }, { Origin: "https://foreign.invalid" }))
        .status,
      403,
    );
    assert.equal(
      (await post("list", { limit: 1 }, { "X-Morphz-Token": "stale" })).status,
      403,
    );
    assert.equal(f.events.length, count);
  } finally {
    await h.close();
    f.close();
  }
});
