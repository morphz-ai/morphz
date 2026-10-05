import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applicationCall,
  applicationIdentity,
  RequestError,
} from "../apps/web/src/application-transport.js";
import {
  cognitiveAppApplicationMethods,
  type ApplicationInvocation,
  type ApplicationReply,
} from "../packages/core/src/application-api.js";
import { Application } from "../packages/application/src/application.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { HumanPlatformAuthority } from "../packages/application/src/human-platform-authority.js";
import {
  CognitiveAppServiceError,
  type CognitiveAppService,
} from "../packages/application/src/cognitive-app-service.js";
import { localAccess } from "../packages/core/src/model.js";

const target = {
  projectId: "project",
  appId: "example.notes",
  version: "1.0.0",
  connectionId: "connection",
};
const commandId = "original_command";
const request = () => ({
  ...target,
  commandId,
  operationId: "notes.create",
  parameters: { title: "Original", markdown: "Original\u0000正文" },
  resources: [{ objectId: "object", versionRef: "exact\n旧版" }],
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const success = (value: unknown = {}): ApplicationReply => ({
  ok: true,
  value,
});
const boot = (name: string) =>
  success({
    centerId: "center",
    principalId: name,
    csrfToken: `generation-${name}`,
  });
type Bridge = Pick<
  NonNullable<NonNullable<Window["morphzDesktop"]>["application"]>,
  "invoke" | "cancel"
>;
async function withBridge(
  bridge: Bridge | undefined,
  work: () => Promise<void>,
) {
  const old = Object.getOwnPropertyDescriptor(globalThis, "window");
  Reflect.set(globalThis, "window", { morphzDesktop: { application: bridge } });
  try {
    await work();
  } finally {
    if (old) Object.defineProperty(globalThis, "window", old);
    else Reflect.deleteProperty(globalThis, "window");
  }
}
const failure = (
  error: unknown,
  status: number,
  code: string | undefined,
  id: string | null = commandId,
) => {
  assert.ok(error instanceof RequestError);
  assert.equal(error.status, status);
  assert.equal(error.code, code);
  assert.equal(error.commandId, id ?? undefined);
  return true;
};

// UNIT preload contract: these are ordinary invoke/cancel objects matching the
// real preload's public contract, not Electron IPC or original-App acceptance.
test("UNIT renderer/preload: unsafe getters/toJSON and Host-only fields never reach native invoke", async () => {
  let calls = 0,
    getters = 0,
    serializers = 0;
  await withBridge(
    {
      invoke: async () => {
        calls++;
        return success();
      },
      cancel() {},
    },
    async () => {
      const accessor = { ...request(), parameters: {} };
      Object.defineProperty(accessor.parameters, "title", {
        enumerable: true,
        get() {
          getters++;
          return "secret";
        },
      });
      const serialized = {
        ...request(),
        parameters: {
          toJSON() {
            serializers++;
            return {};
          },
        },
      };
      for (const invalid of [
        accessor,
        serialized,
        { ...request(), tenantId: "foreign" },
      ]) {
        await assert.rejects(
          applicationCall("cognitive-apps.invoke", invalid),
          (error) => failure(error, 400, "invalid", null),
        );
      }
      assert.equal(getters, 0);
      assert.equal(serializers, 0);
      assert.equal(calls, 0);
    },
  );
});

test("UNIT renderer/preload: all ten allowlisted DTOs are detached before the first native await", async () => {
  const definition = JSON.parse(
    readFileSync(
      new URL("../examples/cognitive-notes/definition.json", import.meta.url),
      "utf8",
    ),
  );
  const args: unknown[] = [
    { limit: 10 },
    {
      projectId: target.projectId,
      appId: target.appId,
      version: target.version,
    },
    { definition },
    {
      appId: target.appId,
      version: target.version,
      expectedRevision: 0,
      state: "active",
    },
    {
      appId: target.appId,
      version: target.version,
      connectionId: target.connectionId,
      expectedRevision: 0,
      serviceId: "service",
      dataAuthorityId: "authority",
    },
    {
      appId: target.appId,
      version: target.version,
      connectionId: target.connectionId,
      expectedRevision: 1,
      state: "disabled",
    },
    request(),
    {
      ...target,
      object: { objectId: "object", versionRef: "exact" },
      maxBytes: 1024,
    },
    { ...target, commandId },
    { ...target, commandId },
  ];
  const seen: ApplicationInvocation[] = [];
  await withBridge(
    {
      invoke: async (value) => {
        seen.push(value);
        return success();
      },
      cancel() {},
    },
    async () => {
      for (const [index, method] of cognitiveAppApplicationMethods.entries()) {
        const input = args[index]!;
        await applicationCall(method, input);
        assert.equal(seen[index]!.method, method);
        assert.deepEqual(seen[index]!.params, input);
        assert.notEqual(seen[index]!.params, input);
        assert.equal("url" in seen[index]!, false);
      }
    },
  );
});

test("UNIT renderer/preload: nested parameters/resources and fixed command tuple survive caller mutation", async () => {
  const held = deferred<ApplicationReply>();
  let sent!: ApplicationInvocation;
  await withBridge(
    {
      invoke: (value) => {
        sent = value;
        return held.promise;
      },
      cancel() {},
    },
    async () => {
      const input = request(),
        expected = structuredClone(input);
      const pending = applicationCall("cognitive-apps.invoke", input);
      input.commandId = "replacement_command";
      input.connectionId = "other_connection";
      input.parameters.markdown = "Changed";
      input.resources[0]!.versionRef = "Changed";
      assert.deepEqual(sent.params, expected);
      held.resolve(success({ status: "unconfirmed", commandId }));
      assert.deepEqual(await pending, { status: "unconfirmed", commandId });
    },
  );
});

test("UNIT renderer/preload: structured refusal retains caller commandId, not a foreign reply ID", async () => {
  for (const supplied of [commandId, "foreign_command", undefined]) {
    await withBridge(
      {
        invoke: async () => ({
          ok: false,
          error: {
            status: 409,
            code: "conflict",
            message: "Original conflict",
            ...(supplied ? { commandId: supplied } : {}),
          },
        }),
        cancel() {},
      },
      async () => {
        await assert.rejects(
          applicationCall("cognitive-apps.invoke", request()),
          (error) => failure(error, 409, "conflict"),
        );
      },
    );
  }
});

test("UNIT renderer/preload: raw IPC failure is bounded unavailable with original ID and no retry", async () => {
  let calls = 0;
  await withBridge(
    {
      invoke: async () => {
        calls++;
        throw new Error(
          "/private/credentials https://secret.example TOKEN=private",
        );
      },
      cancel() {},
    },
    async () => {
      await assert.rejects(
        applicationCall("cognitive-apps.invoke", request()),
        (error) => {
          failure(error, 503, "unavailable");
          assert.doesNotMatch((error as Error).message, /private|secret|TOKEN/);
          return true;
        },
      );
      assert.equal(calls, 1);
    },
  );
});

test("UNIT renderer/preload: already aborted and in-flight abort retain original ID without replay", async () => {
  let calls = 0;
  const cancelled: string[] = [],
    held = deferred<ApplicationReply>();
  await withBridge(
    {
      invoke: async () => {
        calls++;
        return held.promise;
      },
      cancel(id) {
        cancelled.push(id);
      },
    },
    async () => {
      const stopped = new AbortController();
      stopped.abort(new Error("private abort reason"));
      await assert.rejects(
        applicationCall("cognitive-apps.invoke", request(), {
          signal: stopped.signal,
        }),
        (error) => failure(error, 408, "cancelled"),
      );
      assert.equal(calls, 0);
      const controller = new AbortController();
      const pending = applicationCall("cognitive-apps.invoke", request(), {
        signal: controller.signal,
      });
      const rejected = assert.rejects(pending, (error) =>
        failure(error, 408, "cancelled"),
      );
      controller.abort(new Error("private abort reason"));
      await rejected;
      assert.equal(calls, 1);
      assert.equal(cancelled.length, 1);
      assert.match(cancelled[0]!, /^[a-f0-9-]{36}$/);
      held.resolve(success({ committed: true }));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 1);
    },
  );
});

test("UNIT renderer/preload: a response delivered just before abort is not disclosed", async () => {
  const controller = new AbortController();
  await withBridge(
    {
      invoke: async () => {
        controller.abort();
        return success({ privateBody: "old" });
      },
      cancel() {},
    },
    async () => {
      await assert.rejects(
        applicationCall("cognitive-apps.invoke", request(), {
          signal: controller.signal,
        }),
        (error) => failure(error, 408, "cancelled"),
      );
    },
  );
});

test("UNIT renderer/preload: failed native cancel cannot expose IPC errors or lose the original ID", async () => {
  const controller = new AbortController(),
    held = deferred<ApplicationReply>();
  let calls = 0,
    cancellations = 0;
  await withBridge(
    {
      invoke: async () => {
        calls++;
        return held.promise;
      },
      cancel() {
        cancellations++;
        throw new Error("private IPC credential");
      },
    },
    async () => {
      const pending = applicationCall("cognitive-apps.invoke", request(), {
        signal: controller.signal,
      });
      const rejected = assert.rejects(pending, (error) =>
        failure(error, 408, "cancelled"),
      );
      controller.abort();
      // Settle the producer even on the RED baseline; this is not a retry.
      held.resolve(success({ privateBody: "late" }));
      await rejected;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 1);
      assert.equal(cancellations, 1);
    },
  );
});

test("UNIT renderer/preload: identity transition rejects new writes and discards late original response with its ID", async () => {
  const operation = deferred<ApplicationReply>(),
    login = deferred<ApplicationReply>();
  let calls = 0,
    name = "old";
  await withBridge(
    {
      invoke: async (value) => {
        if (value.method === "platform.bootstrap") return boot(name);
        if (value.method === "login") return login.promise;
        calls++;
        return operation.promise;
      },
      cancel() {},
    },
    async () => {
      await applicationCall("platform.bootstrap");
      const old = applicationCall("cognitive-apps.invoke", request());
      const transition = applicationCall("login", { token: "fixture" });
      // Both held promises must be settled even when the baseline assertion is
      // RED, so a single failure cannot poison later singleton adapter cases.
      try {
        await assert.rejects(
          applicationCall("cognitive-apps.invoke", request()),
          (error) => failure(error, 409, "conflict"),
        );
        assert.equal(calls, 1);
        login.resolve(success());
        await transition;
        name = "new";
        await applicationCall("platform.bootstrap");
        operation.resolve(success({ privateBody: "old" }));
        await assert.rejects(old, (error) => failure(error, 408, "cancelled"));
        assert.equal(applicationIdentity(), "center:new:generation-new");
        assert.equal(calls, 1);
      } finally {
        login.resolve(success());
        operation.resolve(success());
        await Promise.allSettled([old, transition]);
      }
    },
  );
});

test("UNIT renderer/preload: null read ID stays absent and legacy abort/errors are unchanged", async () => {
  const stopped = new AbortController();
  stopped.abort();
  const raw = new Error("legacy native failure");
  await withBridge(
    {
      invoke: async (value) => {
        if (value.method === "cognitive-apps.invoke") throw raw;
        throw raw;
      },
      cancel() {},
    },
    async () => {
      await assert.rejects(
        applicationCall("cognitive-apps.invoke", {
          ...request(),
          operationId: "notes.list",
          commandId: null,
        }),
        (error) => failure(error, 503, "unavailable", null),
      );
      await assert.rejects(
        applicationCall("documents.create", {}, { signal: stopped.signal }),
        (error) => error instanceof DOMException && error.name === "AbortError",
      );
      await assert.rejects(
        applicationCall("documents.create", {}),
        (error) => error === raw,
      );
    },
  );
});

test("UNIT renderer/Web fallback: HTTP network and late body identity errors retain original ID", async () => {
  const originalFetch = globalThis.fetch;
  await withBridge(undefined, async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error("private network credential");
    };
    await assert.rejects(
      applicationCall("cognitive-apps.invoke", request()),
      (error) => failure(error, 503, "unavailable"),
    );
    assert.equal(calls, 1);
    const held = deferred<unknown>();
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/api/identity/logout"))
        return Response.json({ disconnected: true });
      const response = Response.json({});
      response.json = () => held.promise;
      return response;
    };
    const pending = applicationCall("cognitive-apps.invoke", request());
    await new Promise<void>((resolve) => setImmediate(resolve));
    await applicationCall("logout");
    held.resolve({ privateBody: "old" });
    // Core's existing HTTP epoch refusal has no structured reason code.
    // Preserve that exact contract rather than changing the frozen client.
    await assert.rejects(pending, (error) => failure(error, 408, undefined));
  }).finally(() => {
    globalThis.fetch = originalFetch;
  });
});

test("UNIT actual Local composition: renderer → real Local/Application/HPA → FakeService refusal/cancel retains exact ID", async () => {
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  const authority = new HumanPlatformAuthority("tenant", async () => true);
  const verifier = authority.verifier({
    resolveActor: async () => null,
    resolveActant: async () => null,
    resolveProjectAgent: async () => null,
    verifyApplicationObject: async () => false,
  });
  let received: unknown,
    calls = 0;
  let held: Promise<void> | undefined;
  const entered = deferred<void>();
  const unsupported = async () => {
    throw new CognitiveAppServiceError("unavailable");
  };
  const service: CognitiveAppService = {
    list: unsupported,
    describe: unsupported,
    install: unsupported,
    grant: unsupported,
    connect: unsupported,
    connectionState: unsupported,
    readObject: unsupported,
    commandStatus: unsupported,
    recover: unsupported,
    invoke: async (actor, value) => {
      const actual = await verifier.resolveActor(actor);
      assert.equal(actual?.principalId, localAccess.principalId);
      received = value;
      calls++;
      if (held) {
        entered.resolve();
        await held;
      }
      throw new CognitiveAppServiceError("conflict", commandId);
    },
  };
  const host = new LocalApplicationConnection(
    new Application(store, { cognitiveApps: { authority, service } }),
  );
  const native: Promise<ApplicationReply>[] = [];
  let nativeCancelCalls = 0;
  try {
    await withBridge(
      {
        invoke: (value) => {
          const pending = host.invoke(value);
          native.push(pending);
          return pending;
        },
        cancel: (id) => {
          nativeCancelCalls++;
          host.cancel(id);
        },
      },
      async () => {
        await applicationCall("platform.bootstrap");
        const input = request(),
          expected = structuredClone(input);
        const pending = applicationCall("cognitive-apps.invoke", input);
        input.parameters.markdown = "Mutated";
        await assert.rejects(pending, (error) =>
          failure(error, 409, "conflict"),
        );
        assert.deepEqual(received, expected);
        assert.equal(calls, 1);

        const release = deferred<void>();
        held = release.promise;
        const controller = new AbortController();
        const cancelled = applicationCall("cognitive-apps.invoke", request(), {
          signal: controller.signal,
        });
        const rejected = assert.rejects(cancelled, (error) =>
          failure(error, 408, "cancelled"),
        );
        try {
          await entered.promise;
          controller.abort();
          await rejected;
          assert.equal(nativeCancelCalls, 1);
          assert.equal(calls, 2);
        } finally {
          release.resolve();
          await Promise.all(native);
        }
        assert.equal(calls, 2);
      },
    );
  } finally {
    host.close();
    store.close();
  }
});
