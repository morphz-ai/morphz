import test from "node:test";
import assert from "node:assert/strict";
import {
  applicationCall,
  cognitiveAppViewCall,
  RequestError,
} from "../apps/web/src/application-transport.js";
import {
  type ApplicationMethod,
  type ApplicationReply,
} from "../packages/core/src/application-api.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import {
  cognitiveAppViewApplicationMethods,
  cognitiveAppViewApplicationRoutes,
  cognitiveAppViewApplicationRoute,
} from "../packages/core/src/cognitive-app-view-methods.js";
const save = () => ({
  viewId: "view",
  expectedViewRevision: 1,
  expectedBindingRevision: 1,
  commandId: "original-save",
  state: { view: "list" },
});
const result = {
  receipt: { viewId: "view", viewRevision: 2, bindingRevision: 1 },
  replayed: false,
};
const success = (value: unknown): ApplicationReply => ({ ok: true, value });
const boot = success({
  centerId: "center",
  principalId: "bob",
  csrfToken: "generation-bob",
});
type Bridge = Pick<
  NonNullable<NonNullable<Window["morphzDesktop"]>["application"]>,
  "invoke" | "cancel"
>;
async function withBridge(bridge: Bridge, work: () => Promise<void>) {
  const old = Object.getOwnPropertyDescriptor(globalThis, "window");
  Reflect.set(globalThis, "window", { morphzDesktop: { application: bridge } });
  try {
    await work();
  } finally {
    if (old) Object.defineProperty(globalThis, "window", old);
    else Reflect.deleteProperty(globalThis, "window");
  }
}
const failure =
  (status: number, code: string, commandId?: string) => (error: unknown) => {
    assert.ok(error instanceof RequestError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.equal(error.commandId, commandId);
    return true;
  };
// UNIT ordinary preload-shaped objects only. No Browser/Electron/native window.
test("UNIT view renderer: strict independent input, actual generation field and typed success", async () => {
  let calls = 0,
    getters = 0;
  await withBridge(
    {
      invoke: async (request) => {
        if (request.method === "platform.bootstrap") return boot;
        calls++;
        assert.equal(request.method, "cognitive-app-views.save");
        assert.equal(request.identityGeneration, "generation-bob");
        assert.deepEqual(request.params, save());
        return success(result);
      },
      cancel() {},
    },
    async () => {
      await applicationCall("platform.bootstrap");
      const accessor = save();
      Object.defineProperty(accessor.state, "view", {
        enumerable: true,
        get() {
          getters++;
          return "secret";
        },
      });
      for (const input of [
        accessor,
        { ...save(), actor: {} },
        { ...save(), endpoint: "secret" },
      ])
        await assert.rejects(
          applicationCall(
            "cognitive-app-views.save" as ApplicationMethod,
            input,
          ),
          failure(400, "invalid"),
        );
      assert.equal(getters, 0);
      assert.equal(calls, 0);
      assert.deepEqual(
        await applicationCall(
          "cognitive-app-views.save" as ApplicationMethod,
          save(),
        ),
        result,
      );
      assert.equal(calls, 1);
    },
  );
});
test("UNIT view renderer: abort/disconnected IPC retains original command, never retries", async () => {
  let resolve!: (reply: ApplicationReply) => void,
    calls = 0,
    cancelled = 0;
  await withBridge(
    {
      invoke: (request) => {
        if (request.method === "platform.bootstrap")
          return Promise.resolve(boot);
        calls++;
        return new Promise((r) => {
          resolve = r;
        });
      },
      cancel() {
        cancelled++;
        throw new Error("private disconnect");
      },
    },
    async () => {
      await applicationCall("platform.bootstrap");
      const controller = new AbortController();
      const pending = applicationCall(
        "cognitive-app-views.save" as ApplicationMethod,
        save(),
        { signal: controller.signal },
      );
      controller.abort();
      await assert.rejects(pending, failure(408, "cancelled", "original-save"));
      resolve(success(result));
      await Promise.resolve();
      assert.equal(calls, 1);
      assert.equal(cancelled, 1);
    },
  );
});
test("UNIT view renderer: late success after identity transition is retired, not republished or resent", async () => {
  let resolve!: (reply: ApplicationReply) => void,
    calls = 0;
  await withBridge(
    {
      invoke: (request) => {
        if (request.method === "platform.bootstrap")
          return Promise.resolve(boot);
        if (request.method === "logout")
          return Promise.resolve(success({ disconnected: true }));
        calls++;
        return new Promise((r) => {
          resolve = r;
        });
      },
      cancel() {},
    },
    async () => {
      await applicationCall("platform.bootstrap");
      const pending = applicationCall(
        "cognitive-app-views.save" as ApplicationMethod,
        save(),
      );
      await applicationCall("logout");
      resolve(success(result));
      await assert.rejects(pending, failure(408, "cancelled", "original-save"));
      assert.equal(calls, 1);
    },
  );
});
test("UNIT view renderer: malformed successful receipt is a contract failure with original ID", async () => {
  await withBridge(
    {
      invoke: async (request) =>
        request.method === "platform.bootstrap"
          ? boot
          : success({ ...result, privateAlias: "secret" }),
      cancel() {},
    },
    async () => {
      await applicationCall("platform.bootstrap");
      await assert.rejects(
        applicationCall(
          "cognitive-app-views.save" as ApplicationMethod,
          save(),
        ),
        failure(503, "contract", "original-save"),
      );
    },
  );
});
test("UNIT view map: exactly seven deeply frozen own entries, separate from domain and guest protocols", () => {
  assert.ok(Object.isFrozen(cognitiveAppViewApplicationMethods));
  assert.ok(Object.isFrozen(cognitiveAppViewApplicationRoutes));
  assert.equal(cognitiveAppViewApplicationMethods.length, 7);
  assert.equal(Object.keys(cognitiveAppViewApplicationRoutes).length, 7);
  assert.deepEqual(
    cognitiveAppViewApplicationRoute("cognitive-app-views.locate"),
    {
      method: "locate",
      path: "/api/platform/cognitive-app-views/locate",
    },
  );
  for (const method of cognitiveAppViewApplicationMethods) {
    const route = cognitiveAppViewApplicationRoute(method);
    assert.ok(route && Object.isFrozen(route));
    assert.match(route.path, /^\/api\/platform\/cognitive-app-views\/[a-z-]+$/);
  }
  for (const value of [
    "constructor",
    "__proto__",
    "toString",
    "cognitive-apps.invoke",
    "cognitive-app-views.recover",
  ])
    assert.equal(cognitiveAppViewApplicationRoute(value), null);
});
test("UNIT typed presentation renderer preserves existing applicationCall contextual type", async () => {
  await withBridge(
    {
      invoke: async (request) =>
        request.method === "platform.bootstrap" ? boot : success(result),
      cancel() {},
    },
    async () => {
      await applicationCall("platform.bootstrap");
      const parsed = await cognitiveAppViewCall(
        "cognitive-app-views.save",
        save(),
      );
      const revision: number = parsed.receipt.viewRevision;
      assert.equal(revision, 2);
    },
  );
});
test("UNIT window HTTP client: bounded/fatal successful response and safe unavailable retain ID, with one request only", async () => {
  for (const invalid of [
    new Response(JSON.stringify({ ...result, unknown: true }), {
      headers: { "Content-Type": "application/json" },
    }),
    new Response(new Uint8Array([0xc3, 0x28]), {
      headers: { "Content-Type": "application/json" },
    }),
    new Response("x".repeat(512 * 1024 + 1), {
      headers: { "Content-Type": "application/json" },
    }),
    new Response(JSON.stringify(result), {
      headers: { "Content-Type": "text/html" },
    }),
  ]) {
    let calls = 0;
    const client = new HttpApplicationClient(
      "http://unit.invalid",
      async () => {
        calls++;
        return invalid;
      },
    );
    await assert.rejects(
      client.call("cognitive-app-views.save", save()),
      failure(503, "contract", "original-save"),
    );
    assert.equal(calls, 1);
  }
  let calls = 0;
  const unavailable = new HttpApplicationClient(
    "http://unit.invalid",
    async () => {
      calls++;
      throw new Error("PRIVATE-TRANSPORT-CAUSE");
    },
  );
  await assert.rejects(
    unavailable.call("cognitive-app-views.save", save()),
    failure(503, "unavailable", "original-save"),
  );
  assert.equal(calls, 1);
});

test("UNIT window HTTP streaming: identity/abort changes retire held body with original ID; UI carrier stays bounded at 8 MiB", async () => {
  for (const change of ["identity", "abort"] as const) {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let pulling!: () => void;
    const waiting = new Promise<void>((resolve) => (pulling = resolve));
    let cancelled = 0,
      writes = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          stream = controller;
        },
        pull() {
          pulling();
        },
        cancel() {
          cancelled++;
        },
      },
      { highWaterMark: 0 },
    );
    const client = new HttpApplicationClient(
      "http://unit.invalid",
      async (url) => {
        if (String(url).endsWith("/api/identity/logout"))
          return new Response("{}", {
            headers: { "Content-Type": "application/json" },
          });
        writes++;
        return new Response(body, {
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    const abort = new AbortController();
    const pending = client.call("cognitive-app-views.save", save(), {
      signal: abort.signal,
    });
    // Zero prefetch: pull is reached only by the actual Response reader.
    // It is awaiting body bytes, not just response headers.
    await waiting;
    if (change === "identity") await client.call("logout");
    else abort.abort();
    stream.enqueue(new TextEncoder().encode("{}"));
    await assert.rejects(pending, failure(408, "cancelled", "original-save"));
    assert.equal(writes, 1);
    assert.equal(cancelled, 1);
  }
  let calls = 0;
  const oversized = new HttpApplicationClient(
    "http://unit.invalid",
    async () => {
      calls++;
      return new Response(new Uint8Array(8 * 1024 * 1024 + 1), {
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  await assert.rejects(
    oversized.call("cognitive-app-views.read-ui", {
      viewId: "view",
      expectedViewRevision: 1,
      expectedBindingRevision: 1,
    }),
    failure(503, "contract"),
  );
  assert.equal(calls, 1);
});
