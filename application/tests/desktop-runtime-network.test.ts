import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
const { createDesktopRuntimeRequest } = createRequire(import.meta.url)(
  "../apps/desktop/runtime-network.cjs",
);

test("Desktop Runtime transport strips browser credentials and never retries a failed write", async () => {
  const signal = AbortSignal.timeout(5000);
  const calls: unknown[] = [];
  const failure = new Error("network failure");
  const request = createDesktopRuntimeRequest({
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      throw failure;
    },
  });
  await assert.rejects(
    request("http://127.0.0.1:1/api/test", {
      method: "POST",
      body: "fixture",
      signal,
      headers: { Authorization: "Bearer fixture" },
      credentials: "include",
    }),
    (error: unknown) => error === failure,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    url: "http://127.0.0.1:1/api/test",
    init: {
      method: "POST",
      body: "fixture",
      signal,
      headers: { Authorization: "Bearer fixture" },
      credentials: "omit",
      cache: "no-store",
      bypassCustomProtocolHandlers: true,
    },
  });
});

test("Runtime reads, connection checks, model settings and Profile use the injected Host channel", async () => {
  const store = new WorkspaceStore(":memory:");
  const calls: string[] = [];
  const request: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer fixture",
    );
    return Response.json(
      path === "/api/status"
        ? {
            model: "fixture",
            agent_id: "agent-fixture",
            principal_id: "human-fixture",
          }
        : path === "/api/runtime/inference"
          ? { model: "fixture", models: ["fixture"] }
          : path === "/api/runtime/response-annotations"
            ? { mode: "on" }
            : path === "/api/runtime/providers/oauth/services"
              ? { services: [] }
              : path === "/api/runtime/providers"
                ? { auth_accounts: {} }
                : {},
      { status: path.includes("profile") ? 404 : 200 },
    );
  };
  const runtime = new RuntimeBridge(
    store,
    { url: "http://127.0.0.1:1", token: "fixture", namespace: "fixture" },
    undefined,
    false,
    { request },
  );
  try {
    assert.equal((await runtime.models(false)).current, "fixture");
    assert.equal((await runtime.inspectConnection()).state, "connected");
    const settings = await runtime.modelSettings.read(
      AbortSignal.timeout(5000),
      () => {},
    );
    assert.equal(settings.responseAnnotations, "on");
    await runtime.profiles.identity({ principalId: "fixture" });
    assert.ok(calls.filter((path) => path === "/api/status").length >= 2);
    assert.ok(calls.includes("/api/runtime/providers"));
    assert.ok(calls.includes("/api/runtime/response-annotations"));
  } finally {
    await runtime.stop();
    store.close();
  }
});
