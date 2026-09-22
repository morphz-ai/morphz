import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeModelSettings } from "../packages/application/src/model-settings.js";
import {
  Application,
  applicationFailure,
} from "../packages/application/src/application.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { localAccess } from "../packages/core/src/model.js";

async function fixture() {
  const secret = "fixture-never-render-this-key";
  const calls: { path: string; method: string; body: any }[] = [];
  const state = {
    model: "first",
    effort: "high",
    fail: false,
    completed: false,
    delay: false,
    failureStatus: 400,
  };
  const providers = {
    auth_adapters: [
      { id: "codex-oauth", stability: "stable" },
      { id: "xai-oauth", stability: "experimental" },
    ],
    provider_instances: {
      original: {
        models: {
          first: {
            context_window_tokens: 32000,
            prompt_cache_strategy: "disabled",
          },
          second: {},
        },
        headers: { Authorization: secret },
      },
    },
    auth_accounts: {
      existing: {
        config: {
          provider: "original",
          label: "Existing account",
          credential_ref: secret,
        },
        effective_enabled: true,
        oauth: false,
        authenticated: true,
      },
      pending: {
        config: { provider: "original", label: "Not an account yet" },
        effective_enabled: true,
        oauth: true,
        authenticated: false,
      },
    },
    model_routes: {
      first: {
        display_alias: "First label",
        candidates: [
          { provider: "original", model: "first", account: "existing" },
        ],
      },
    },
    discovered_models: [
      { auth_account_id: "existing", physical_model: "second" },
    ],
  };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({
      path: req.url!,
      method: req.method!,
      body: body ? JSON.parse(body) : undefined,
    });
    res.setHeader("Content-Type", "application/json");
    if (state.delay) return;
    if (state.fail) {
      res.writeHead(state.failureStatus);
      res.end(JSON.stringify({ error: secret }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${secret}`) {
      res.writeHead(401);
      res.end("{}");
      return;
    }
    const json = (value: unknown) => res.end(JSON.stringify(value));
    if (req.url === "/api/runtime/providers") return json(providers);
    if (req.url === "/api/runtime/providers/accounts/existing/connection")
      return json({
        account_id: "existing",
        base_url: "https://example.com/v1",
        protocol: "openai-responses",
        version: "connection-v2",
        key_editable: true,
        key_unavailable_reason: null,
        endpoint_accounts: ["Existing account"],
        key_accounts: ["Existing account"],
        api_key: secret,
        credential_ref: secret,
      });
    if (req.url === "/api/runtime/providers/oauth/services")
      return json({
        services: [
          { id: "codex", auth_adapter: "codex-oauth" },
          { id: "xai", auth_adapter: "xai-oauth" },
        ],
      });
    if (req.url === "/api/runtime/inference") {
      if (body) {
        const data = JSON.parse(body);
        state.model = data.model;
        if (data.reasoning_effort) state.effort = data.reasoning_effort;
      }
      return json({
        model: state.model,
        models: ["first", "second"],
        reasoning_effort: state.effort,
        model_options: [
          {
            id: "first",
            label: "First",
            supported_reasoning_efforts: ["high"],
          },
          { id: "second", label: "Second", supported_reasoning_efforts: [] },
        ],
      });
    }
    if (req.url === "/api/runtime/providers/discover-models")
      return json({ models: ["second", "first", "second"] });
    if (req.url === "/api/runtime/providers/oauth/start")
      return json({
        login_id: "login-1",
        account_id: "new-account",
        authorization_url: "https://example.com/authorize?state=test",
        expires_at: new Date(Date.now() + 60000).toISOString(),
        poll_interval_secs: 2,
        flow: "authorization_code_pkce",
      });
    if (req.url === "/api/runtime/providers/oauth/login-1/continue") {
      if (req.method === "DELETE") {
        res.writeHead(204);
        res.end();
        return;
      }
      return json(
        state.completed
          ? {
              status: "complete",
              account: { account_id: "new-account", access_token: secret },
            }
          : { status: "pending", retry_after_secs: 3 },
      );
    }
    return json({
      managed_config_path: "/private/runtime/config",
      credential: secret,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    token: secret,
    namespace: randomUUID(),
  };
  const settings = new RuntimeModelSettings(() => config);
  const apply = (action: unknown) =>
    settings.apply(action, AbortSignal.timeout(5000), () => {});
  const read = () => settings.read(AbortSignal.timeout(5000), () => {});
  return {
    settings,
    config,
    providers,
    state,
    calls,
    secret,
    apply,
    read,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

test("model settings return only sanitized real accounts, actual services and enabled models", async () => {
  const f = await fixture();
  try {
    const result = await f.read();
    assert.equal(result.accounts.length, 1);
    assert.equal(result.accounts[0]!.label, "Existing account");
    assert.deepEqual(result.accounts[0]!.models, [
      { id: "first", enabled: true },
      { id: "second", enabled: false },
    ]);
    assert.equal(result.services.length, 2);
    assert.equal(result.services[1]!.experimental, true);
    assert.ok(!JSON.stringify(result).includes(f.secret));
    assert.ok(!JSON.stringify(result).includes("credential_ref"));
  } finally {
    await f.close();
  }
});
test("API connection edits are bounded, redact secrets, preserve accounts and expose conflicts", async () => {
  const f = await fixture();
  try {
    const read = await f.apply({
      action: "api-connection-read",
      accountId: "existing",
    });
    assert.equal(read.kind, "connection");
    assert.ok(!JSON.stringify(read).includes(f.secret));
    assert.ok(!JSON.stringify(read).includes("credential_ref"));
    await f.apply({
      action: "api-endpoint",
      accountId: "existing",
      expectedVersion: "v1",
      baseUrl: "https://example.com/next/",
    });
    await f.apply({
      action: "api-key",
      accountId: "existing",
      expectedVersion: "v2",
      apiKey: "replacement-fixture",
    });
    assert.deepEqual(
      f.calls.filter((c) => c.method !== "GET").map((c) => c.body),
      [
        {
          kind: "endpoint",
          expected_version: "v1",
          base_url: "https://example.com/next",
        },
        {
          kind: "credential",
          expected_version: "v2",
          api_key: "replacement-fixture",
        },
      ],
    );
    assert.ok(f.calls.every((c) => c.path.endsWith("/connection")));
    await assert.rejects(
      f.apply({
        action: "api-endpoint",
        accountId: "existing",
        expectedVersion: "v1",
        baseUrl: "https://example.com?token=secret",
      }),
      /API 地址/,
    );
    f.state.fail = true;
    f.state.failureStatus = 409;
    await assert.rejects(
      f.apply({
        action: "api-key",
        accountId: "existing",
        expectedVersion: "stale",
        apiKey: f.secret,
      }),
      /重新载入/,
    );
  } finally {
    await f.close();
  }
});
test("default model writes only the requested setting, is retry safe, and rejects stale/unavailable selections", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.apply({ action: "default", model: "second", expectedCurrent: "stale" }),
      /刷新/,
    );
    await assert.rejects(
      f.apply({
        action: "default",
        model: "missing",
        expectedCurrent: "first",
      }),
      /不可用/,
    );
    await f.apply({
      action: "default",
      model: "second",
      expectedCurrent: "first",
    });
    assert.deepEqual(f.calls.find((c) => c.method === "PUT")?.body, {
      model: "second",
      reasoning_effort: "default",
    });
    await f.apply({
      action: "default",
      model: "second",
      expectedCurrent: "first",
    });
    assert.equal(f.calls.filter((c) => c.method === "PUT").length, 1);
  } finally {
    await f.close();
  }
});
test("API onboarding reuses Runtime atomic setup with stable identities and never returns the secret", async () => {
  const f = await fixture();
  try {
    const action = {
      action: "connect-api",
      requestId: randomUUID(),
      protocol: "openai-responses",
      baseUrl: "https://example.com/v1",
      apiKey: f.secret,
      label: "My account",
      model: "gpt-test",
    };
    const first = await f.apply(action),
      second = await f.apply(action);
    assert.deepEqual(first, second);
    assert.ok(!JSON.stringify(first).includes(f.secret));
    const writes = f.calls.filter((c) => c.method === "PUT");
    assert.deepEqual(writes[0]!.body, writes[1]!.body);
    assert.equal(writes[0]!.body.managed_secret.value, f.secret);
    assert.ok(writes[0]!.body.provider_id.startsWith("desktop-"));
    assert.equal(writes[0]!.body.account.secret_backend, "morphz_env_file");
    assert.ok(
      writes[0]!.body.route.aliases.includes(
        writes[0]!.body.route.display_alias,
      ),
    );
    assert.deepEqual(
      await f.apply({
        action: "discover",
        protocol: "openai-chat",
        baseUrl: "https://example.com/v1",
        apiKey: f.secret,
      }),
      { kind: "discovered", models: ["first", "second"] },
    );
    for (const baseUrl of [
      "http://example.com",
      "https://user:key@example.com",
      "https://example.com?token=x",
      "file:///private/key",
    ]) {
      await assert.rejects(f.apply({ ...action, baseUrl }));
    }
  } finally {
    await f.close();
  }
});
test("model enablement preserves model profiles and aliases and rejects stale account versions", async () => {
  const f = await fixture();
  try {
    const account = (await f.read()).accounts[0]!;
    await assert.rejects(
      f.apply({
        action: "account-models",
        accountId: account.id,
        models: ["first"],
        expectedVersion: "old",
      }),
      /刷新/,
    );
    await f.apply({
      action: "account-models",
      accountId: account.id,
      models: ["first", "second"],
      expectedVersion: account.version,
    });
    const first = f.calls.find((c) => c.method === "PUT")!.body.models[0];
    assert.equal(first.alias, "First label");
    assert.equal(first.context_window_tokens, 32000);
    assert.equal(first.prompt_cache_strategy, "disabled");
    await assert.rejects(
      f.apply({
        action: "account-models",
        accountId: account.id,
        models: ["unknown"],
        expectedVersion: account.version,
      }),
      /请选择/,
    );
  } finally {
    await f.close();
  }
});
test("OAuth keeps login capability in host, supports poll/callback/cancel, and strips token metadata", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.apply({ action: "oauth-poll", loginId: "someone-else" }),
      /失效/,
    );
    await assert.rejects(
      f.apply({ action: "oauth-start", service: "unregistered" }),
      /不可用/,
    );
    const start = await f.apply({ action: "oauth-start", service: "codex" });
    assert.equal(start.kind, "login");
    assert.deepEqual(
      await f.apply({ action: "oauth-poll", loginId: "login-1" }),
      { kind: "pending", retrySeconds: 3 },
    );
    f.state.completed = true;
    assert.deepEqual(
      await f.apply({
        action: "oauth-complete",
        loginId: "login-1",
        response: "fixture-code",
      }),
      { kind: "saved", accountId: "new-account" },
    );
    assert.equal(f.calls.at(-1)!.body.kind, "authorization_response");
    await assert.rejects(f.apply({ action: "oauth-poll", loginId: "login-1" }));
    await f.apply({ action: "oauth-start", service: "codex" });
    assert.deepEqual(
      await f.apply({ action: "oauth-cancel", loginId: "login-1" }),
      { kind: "cancelled" },
    );
  } finally {
    await f.close();
  }
});
test("provider error bodies, credentials and callbacks never escape; identity is rechecked before writes", async () => {
  const f = await fixture();
  try {
    f.state.fail = true;
    await assert.rejects(
      f.read(),
      (error) => !JSON.stringify(applicationFailure(error)).includes(f.secret),
    );
    f.state.fail = false;
    let checks = 0;
    await assert.rejects(
      f.settings.apply(
        { action: "default", model: "second", expectedCurrent: "first" },
        AbortSignal.timeout(5000),
        () => {
          checks++;
          if (checks >= 4) throw Error("revoked");
        },
      ),
      /revoked/,
    );
    assert.ok(!f.calls.some((c) => c.method === "PUT"));
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
      f.settings.apply(
        { action: "oauth-start", service: "codex" },
        cancelled.signal,
        () => {},
      ),
    );
    assert.ok(!f.calls.some((c) => c.method === "POST"));
  } finally {
    await f.close();
  }
});
test("remote and non-owner sessions cannot use host model management", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-model-permissions-"));
  const store = new WorkspaceStore(join(directory, "workspace.sqlite"));
  try {
    const application = new Application(store);
    await assert.rejects(
      application
        .session(localAccess)
        .modelSettings(undefined, AbortSignal.timeout(1000)),
      /本机/,
    );
    await assert.rejects(
      application
        .session({ ...localAccess, principalId: "another-user" })
        .modelSettings(undefined, AbortSignal.timeout(1000)),
      /本机/,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("expired OAuth cancellation is idempotent and does not trap the dialog", async () => {
  const f = await fixture();
  try {
    await f.apply({ action: "oauth-start", service: "codex" });
    f.state.fail = true;
    f.state.failureStatus = 404;
    assert.deepEqual(
      await f.apply({ action: "oauth-cancel", loginId: "login-1" }),
      { kind: "cancelled" },
    );
  } finally {
    await f.close();
  }
});
