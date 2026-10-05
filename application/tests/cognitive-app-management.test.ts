import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ApplicationRequestError } from "../packages/core/src/application-api.js";
import type { CognitiveAppRequestMap } from "../packages/core/src/cognitive-app-api.js";
import { parseCognitiveAppDefinition } from "../packages/cognitive-app-sdk/src/protocol.js";
import {
  createCognitiveAppClient,
  type CognitiveAppTransport,
} from "../apps/web/src/cognitive-app-client.js";
import {
  createCognitiveAppManagement,
  cognitiveAppManagementLimits,
} from "../apps/web/src/data/cognitive-app-management.js";

// Actual management owner and typed facade, with a controlled logical caller.
// These UNIT tests do not claim Host policy, SQL, author-network or native UI acceptance.
const definition = parseCognitiveAppDefinition(
  JSON.parse(
    readFileSync(
      new URL("../examples/cognitive-notes/definition.json", import.meta.url),
      "utf8",
    ),
  ),
);
const hash = "a".repeat(64);
const at = "2026-10-05T00:00:00.000Z";
const identity = {
  centerId: "00000000-0000-4000-8000-000000000001",
  principalId: "alice",
  csrfToken: "alice-generation-1",
};
const preview = {
  mode: "registered-management" as const,
  appId: definition.id,
  version: definition.version,
  expectedDefinitionHash: hash,
};
const grant = {
  appId: definition.id,
  version: definition.version,
  expectedRevision: 0,
  state: "active" as const,
};
const register = {
  mode: "register-installed" as const,
  commandId: "original-registration-command",
  appId: definition.id,
  version: definition.version,
  definitionHash: hash,
};
const connect = {
  appId: definition.id,
  version: definition.version,
  connectionId: "original-connection",
  expectedRevision: 0 as const,
  serviceId: "author/service",
  dataAuthorityId: "author/data",
  expectedDefinitionHash: hash,
};
function reply(
  method: string,
  params: CognitiveAppRequestMap[keyof CognitiveAppRequestMap],
) {
  if (method.endsWith("describe"))
    return {
      mode: "registered-management",
      definition,
      definitionHash: hash,
      registeredAt: at,
      installationState: "active",
      grant: null,
    };
  if (method.endsWith("install"))
    return {
      appId: definition.id,
      version: definition.version,
      definitionHash: hash,
    };
  if (method.endsWith("grant")) {
    const input = params as CognitiveAppRequestMap["grant"];
    return {
      appId: input.appId,
      version: input.version,
      state: input.state,
      revision: input.expectedRevision + 1,
      consentedAt: at,
      updatedAt: at,
    };
  }
  const input = params as
    | CognitiveAppRequestMap["connect"]
    | CognitiveAppRequestMap["connectionState"];
  return {
    appId: input.appId,
    instanceId: "author-instance",
    serviceId: connect.serviceId,
    dataAuthorityId: connect.dataAuthorityId,
    connectionId: input.connectionId,
    state: "state" in input ? input.state : "active",
    revision: input.expectedRevision + 1,
    createdAt: at,
    updatedAt: at,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function harness(handler?: CognitiveAppTransport) {
  const calls: {
    method: string;
    params: CognitiveAppRequestMap[keyof CognitiveAppRequestMap];
    signal?: AbortSignal;
  }[] = [];
  const facade = createCognitiveAppClient(async (method, params, signal) => {
    calls.push({ method, params, signal });
    return handler ? handler(method, params, signal) : reply(method, params);
  });
  const source = { boot: { ...identity }, cognitiveApps: facade };
  const current = { current: { ...identity } as typeof identity | null };
  const platform = { current: source as typeof source | null };
  const generation = { current: 0 };
  let mounted = true;
  let refreshes = 0;
  let refresh = async () => true;
  const owner = createCognitiveAppManagement({
    current,
    platform,
    protectedReadGeneration: generation,
    isMounted: () => mounted,
    refreshAfterMutation: () => {
      refreshes++;
      return refresh();
    },
  });
  return {
    owner,
    calls,
    current,
    platform,
    generation,
    source,
    observe: () => owner.observeIdentity(source.boot),
    setMounted: (value: boolean) => {
      mounted = value;
    },
    setRefresh: (value: () => Promise<boolean>) => {
      refresh = value;
    },
    refreshes: () => refreshes,
    access: () => {
      generation.current++;
      current.current = null;
      platform.current = null;
      owner.invalidateAccess();
    },
    restore: () => {
      current.current = { ...source.boot };
      platform.current = source;
    },
  };
}
const rejected = (code: string, commandId?: string) => (error: unknown) => {
  assert.ok(error instanceof ApplicationRequestError);
  assert.equal(error.code, code);
  assert.equal(error.commandId, commandId);
  return true;
};

test("Cognitive management constructs inertly and exposes only the five Human management operations", async () => {
  const h = harness();
  assert.equal(h.calls.length, 0);
  assert.deepEqual(Object.keys(h.owner.operations).sort(), [
    "connect",
    "connectionState",
    "describeRegistered",
    "grant",
    "install",
  ]);
  await assert.rejects(
    h.owner.operations.grant(grant),
    rejected("unavailable"),
  );
  assert.equal(h.calls.length, 0);
  h.observe();
  const result = await h.owner.operations.describeRegistered(preview);
  assert.equal(result.mode, "registered-management");
  assert.equal(result.grant, null);
  assert.equal(h.refreshes(), 0);
  assert.equal(h.calls[0]?.method, "cognitive-apps.describe");
});

test("Cognitive management own access invalidation cancels reads but preserves its actual CAS ACK and refresh", async () => {
  const read = deferred<unknown>();
  let h!: ReturnType<typeof harness>;
  h = harness(async (method, params) => {
    if (method.endsWith("describe")) return read.promise;
    h.access();
    return reply(method, params);
  });
  h.observe();
  const held = h.owner.operations.describeRegistered(preview);
  const cancelled = assert.rejects(held, rejected("cancelled"));
  const result = await h.owner.operations.grant(grant);
  await cancelled;
  assert.equal(result.value.revision, 1);
  assert.equal(result.refreshed, true);
  assert.equal(h.refreshes(), 1);
  assert.equal(h.calls[0]?.signal?.aborted, true);
  assert.equal(h.calls[1]?.signal?.aborted, false);
  read.resolve(reply("cognitive-apps.describe", preview));
  await Promise.resolve();
  assert.equal(h.calls.length, 2);
});

test("Cognitive management explicit cancellation during refresh rejects late ACK disclosure with the original command", async () => {
  const h = harness();
  h.observe();
  const entered = deferred<void>();
  h.setRefresh(() => {
    entered.resolve();
    return new Promise<boolean>(() => {});
  });
  const caller = new AbortController();
  const result = h.owner.operations.install(register, caller.signal);
  const checked = assert.rejects(
    result,
    rejected("cancelled", register.commandId),
  );
  await entered.promise;
  caller.abort();
  await checked;
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]?.signal?.aborted, true);
});

test("Cognitive management validates and detaches own data before any dispatch or field access", async () => {
  const h = harness();
  h.observe();
  let getters = 0;
  const root = Object.defineProperty({}, "commandId", {
    enumerable: true,
    get() {
      getters++;
      return "private-command";
    },
  });
  const nested = { definition: { ...definition } };
  Object.defineProperty(nested.definition, "title", {
    enumerable: true,
    get() {
      getters++;
      return "private-title";
    },
  });
  for (const input of [
    root,
    nested,
    {
      ...register,
      toJSON() {
        getters++;
        return register;
      },
    },
    Object.assign(Object.create({ private: true }), register),
  ])
    await assert.rejects(
      h.owner.operations.install(input as CognitiveAppRequestMap["install"]),
      rejected("invalid"),
    );
  await assert.rejects(
    h.owner.operations.describeRegistered({
      appId: definition.id,
      version: definition.version,
    } as typeof preview),
    rejected("invalid"),
  );
  await assert.rejects(
    h.owner.operations.grant({
      ...grant,
      commandId: "fabricated",
    } as typeof grant),
    rejected("invalid"),
  );
  await assert.rejects(
    h.owner.operations.connect({
      ...connect,
      endpoint: "https://private.invalid/",
      actor: "bob",
    } as typeof connect),
    rejected("invalid"),
  );
  assert.equal(getters, 0);
  assert.equal(h.calls.length, 0);
  const held = deferred<unknown>();
  const snapshot = harness(async () => held.promise);
  snapshot.observe();
  const input = { ...register };
  const result = snapshot.owner.operations.install(input);
  input.commandId = "changed-after-dispatch";
  input.definitionHash = "b".repeat(64);
  assert.deepEqual(snapshot.calls[0]?.params, register);
  held.resolve(reply("cognitive-apps.install", register));
  assert.equal((await result).value.definitionHash, hash);
});

test("Cognitive management requires all three current/source identity fields and mounted readiness for every new operation", async () => {
  for (const field of ["centerId", "principalId", "csrfToken"] as const) {
    const h = harness();
    h.observe();
    h.source.boot[field] = `changed-${field}`;
    await assert.rejects(
      h.owner.operations.install(register),
      rejected("unavailable", register.commandId),
    );
    assert.equal(h.calls.length, 0);
  }
  const h = harness();
  h.observe();
  h.setMounted(false);
  await assert.rejects(
    h.owner.operations.install(register),
    rejected("unavailable", register.commandId),
  );
  h.setMounted(true);
  h.access();
  await assert.rejects(
    h.owner.operations.grant(grant),
    rejected("unavailable"),
  );
  h.restore();
  assert.equal((await h.owner.operations.grant(grant)).value.revision, 1);
  assert.equal(h.calls.length, 1);
});

test("Cognitive management permission generation changes reject a late read even without the explicit cancellation hook", async () => {
  const held = deferred<unknown>();
  const h = harness(async () => held.promise);
  h.observe();
  const result = h.owner.operations.describeRegistered(preview);
  const checked = assert.rejects(result, rejected("cancelled"));
  h.generation.current++;
  held.resolve(reply("cognitive-apps.describe", preview));
  await checked;
  assert.equal(h.calls[0]?.signal?.aborted, true);
  assert.equal(h.refreshes(), 0);
});

test("Cognitive management observed identity replacement cancels late writes across center, Human and auth generation", async () => {
  for (const field of ["centerId", "principalId", "csrfToken"] as const) {
    const held = deferred<unknown>();
    const h = harness(async () => held.promise);
    h.observe();
    const result = h.owner.operations.install(register);
    const checked = assert.rejects(
      result,
      rejected("cancelled", register.commandId),
    );
    h.source.boot[field] = `changed-${field}`;
    h.current.current = { ...h.source.boot };
    h.observe();
    await checked;
    held.resolve(reply("cognitive-apps.install", register));
    await Promise.resolve();
    assert.equal(h.refreshes(), 0);
    assert.equal(h.calls.length, 1);
  }
});

test("Cognitive management retirement does not revive old requests when StrictMode observes the same identity again", async () => {
  const held = deferred<unknown>();
  let first = true;
  const h = harness(async (method, params) => {
    if (first) {
      first = false;
      return held.promise;
    }
    return reply(method, params);
  });
  h.observe();
  const old = h.owner.operations.install(register);
  const checked = assert.rejects(
    old,
    rejected("cancelled", register.commandId),
  );
  h.owner.retireIdentity();
  await checked;
  await assert.rejects(
    h.owner.operations.install(register),
    rejected("unavailable", register.commandId),
  );
  h.observe();
  const replacement = await h.owner.operations.install(register);
  assert.equal(replacement.refreshed, true);
  held.resolve(reply("cognitive-apps.install", register));
  await Promise.resolve();
  assert.equal(h.refreshes(), 1);
  assert.equal(h.calls.length, 2);
});

test("Cognitive management read cancellation and already aborted writes never initiate a replacement dispatch", async () => {
  const held = deferred<unknown>();
  const h = harness(async () => held.promise);
  h.observe();
  const caller = new AbortController();
  const result = h.owner.operations.describeRegistered(preview, caller.signal);
  const checked = assert.rejects(result, rejected("cancelled"));
  caller.abort();
  await checked;
  await assert.rejects(
    h.owner.operations.install(register, caller.signal),
    rejected("cancelled", register.commandId),
  );
  held.resolve(reply("cognitive-apps.describe", preview));
  await Promise.resolve();
  assert.equal(h.calls.length, 1);
});

test("Cognitive management returns original ACK plus refreshed false when the existing drain fails or throws", async () => {
  for (const refresh of [
    async () => false,
    async (): Promise<boolean> => {
      throw new Error("controlled refresh failure");
    },
  ]) {
    const h = harness();
    h.observe();
    h.setRefresh(refresh);
    const result = await h.owner.operations.install(register);
    assert.deepEqual(result.value, {
      appId: definition.id,
      version: definition.version,
      definitionHash: hash,
    });
    assert.equal(result.refreshed, false);
    assert.equal(h.refreshes(), 1);
    assert.equal(h.calls.length, 1);
  }
});

test("Cognitive management identity retirement after ACK rejects held refresh disclosure rather than calling it unsent", async () => {
  const h = harness();
  h.observe();
  const entered = deferred<void>();
  const late = deferred<boolean>();
  h.setRefresh(() => {
    entered.resolve();
    return late.promise;
  });
  const result = h.owner.operations.install(register);
  const checked = assert.rejects(
    result,
    rejected("cancelled", register.commandId),
  );
  await entered.promise;
  h.setMounted(false);
  h.owner.retireIdentity();
  await checked;
  late.resolve(true);
  await Promise.resolve();
  assert.equal(h.calls.length, 1);
  assert.equal(h.refreshes(), 1);
});

test("Cognitive management GUI and registration retries preserve the caller's original command and exact bytes", async () => {
  const html = "<!doctype html><p>作者原字节</p>" + "x".repeat(600000);
  const gui: CognitiveAppRequestMap["install"] = {
    commandId: "original-gui-command",
    definition: parseCognitiveAppDefinition({
      ...definition,
      ui: { packageVersion: definition.version, sha256: hash },
    }),
    manifest: {
      format: "morphz-app/v1",
      id: definition.id,
      version: definition.version,
      title: definition.title,
      description: definition.description,
      icon: "book",
      harness: null,
      permissions: ["input.compose"],
      ui: { type: "sandbox", html },
    },
  };
  for (const input of [gui, register]) {
    let first = true;
    const h = harness(async (method, params) => {
      if (first) {
        first = false;
        throw new ApplicationRequestError(
          503,
          "受控回执未知",
          "unavailable",
          input.commandId,
        );
      }
      return reply(method, params);
    });
    h.observe();
    await assert.rejects(
      h.owner.operations.install(input),
      rejected("unavailable", input.commandId),
    );
    assert.equal(h.calls.length, 1);
    const result = await h.owner.operations.install(input);
    assert.equal(result.refreshed, true);
    assert.deepEqual(
      h.calls.map((v) => v.params),
      [input, input],
    );
    assert.equal(h.refreshes(), 1);
  }
  const h = harness();
  h.observe();
  await h.owner.operations.install({ definition });
  assert.deepEqual(h.calls[0]?.params, { definition });
  await assert.rejects(
    h.owner.operations.install({
      definition,
      commandId: "fabricated-headless",
    } as CognitiveAppRequestMap["install"]),
    rejected("invalid"),
  );
});

test("Cognitive management retains strict original CAS, public connection identity and does not auto grant or rebase", async () => {
  const conflict = harness(async () => {
    throw new ApplicationRequestError(409, "受控版本冲突", "conflict");
  });
  conflict.observe();
  await assert.rejects(
    conflict.owner.operations.grant({ ...grant, expectedRevision: 7 }),
    rejected("conflict"),
  );
  assert.equal(conflict.calls.length, 1);
  assert.equal(conflict.refreshes(), 0);
  assert.deepEqual(conflict.calls[0]?.params, {
    ...grant,
    expectedRevision: 7,
  });
  const h = harness();
  h.observe();
  const created = await h.owner.operations.connect(connect);
  const state = {
    appId: definition.id,
    version: definition.version,
    connectionId: connect.connectionId,
    expectedRevision: created.value.revision,
    state: "disabled" as const,
  };
  const disabled = await h.owner.operations.connectionState(state);
  assert.equal(disabled.value.state, "disabled");
  assert.equal(disabled.value.revision, 2);
  assert.deepEqual(
    h.calls.map((v) => v.method),
    ["cognitive-apps.connect", "cognitive-apps.connection-state"],
  );
  assert.deepEqual(
    h.calls.map((v) => v.params),
    [connect, state],
  );
  assert.equal(
    h.calls.some((v) => "commandId" in v.params),
    false,
  );
});

test("Cognitive management bounds local pending leases, fails fast duplicate app writes, and never queues", async () => {
  const held = deferred<unknown>();
  const h = harness(async () => held.promise);
  h.observe();
  const callers = Array.from(
    { length: cognitiveAppManagementLimits.pending },
    () => new AbortController(),
  );
  const results = callers.map((caller) =>
    assert.rejects(
      h.owner.operations.describeRegistered(preview, caller.signal),
      rejected("cancelled"),
    ),
  );
  assert.equal(h.calls.length, cognitiveAppManagementLimits.pending);
  await assert.rejects(
    h.owner.operations.install(register),
    rejected("conflict", register.commandId),
  );
  for (const caller of callers) caller.abort();
  await Promise.all(results);
  const first = new AbortController();
  const write = assert.rejects(
    h.owner.operations.install(register, first.signal),
    rejected("cancelled", register.commandId),
  );
  await assert.rejects(h.owner.operations.grant(grant), rejected("conflict"));
  first.abort();
  await write;
  const before = h.calls.length;
  held.resolve(reply("cognitive-apps.describe", preview));
  await Promise.resolve();
  assert.equal(h.calls.length, before);
});

test("Cognitive management ignored cancellation is still bounded by one thirty-second deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const held = deferred<unknown>();
  const h = harness(async () => held.promise);
  h.observe();
  const result = h.owner.operations.install(register);
  const checked = assert.rejects(
    result,
    rejected("cancelled", register.commandId),
  );
  t.mock.timers.tick(cognitiveAppManagementLimits.timeoutMs);
  await checked;
  assert.equal(h.calls[0]?.signal?.aborted, true);
  held.resolve(reply("cognitive-apps.install", register));
  await Promise.resolve();
  assert.equal(h.calls.length, 1);
  assert.equal(h.refreshes(), 0);
});

test("Cognitive management deadline during ignored refresh preserves already parsed ACK without a second budget or write", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  h.observe();
  const entered = deferred<void>();
  const late = deferred<boolean>();
  h.setRefresh(() => {
    entered.resolve();
    return late.promise;
  });
  const result = h.owner.operations.install(register);
  await entered.promise;
  t.mock.timers.tick(cognitiveAppManagementLimits.timeoutMs);
  const acknowledged = await result;
  assert.equal(acknowledged.value.definitionHash, hash);
  assert.equal(acknowledged.refreshed, false);
  late.resolve(true);
  await Promise.resolve();
  assert.equal(acknowledged.refreshed, false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.refreshes(), 1);
});

test("Cognitive management monotonic gates include synchronous parse and late response work when timers have not run", async (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const h = harness(async (method, params) => {
    clock = cognitiveAppManagementLimits.timeoutMs;
    return reply(method, params);
  });
  h.observe();
  await assert.rejects(
    h.owner.operations.install(register),
    rejected("cancelled", register.commandId),
  );
  assert.equal(h.calls.length, 1);
  assert.equal(h.refreshes(), 0);
  let readings = 0;
  t.mock.method(performance, "now", () =>
    readings++ === 0 ? 0 : cognitiveAppManagementLimits.timeoutMs,
  );
  const before = harness();
  before.observe();
  await assert.rejects(
    before.owner.operations.install(register),
    rejected("cancelled", register.commandId),
  );
  assert.equal(before.calls.length, 0);
});
