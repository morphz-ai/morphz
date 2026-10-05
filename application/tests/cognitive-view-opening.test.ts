import assert from "node:assert/strict";
import test from "node:test";
import {
  createCognitiveViewOpening,
  type CognitiveViewOpeningRequest,
  type CognitiveViewOpeningPorts,
} from "../apps/web/src/host/cognitive-view-opening.js";
import { composeSource } from "./fixtures/cognitive-compose-data.js";

// Finite UNIT call ports only. No HPA/SQL/byte SHA/author or production App
// navigation is proved by these DTOs. Those actual gates retain their tests.
function request(): CognitiveViewOpeningRequest {
  const source = composeSource();
  return {
    projectId: source.view.workspaceId,
    target: {
      connectionId: source.binding.connectionId,
      authority: { ...source.authority },
    },
    expectedGrantRevision: source.grantRevision,
    expectedConnectionRevision: source.connectionRevision,
    commandId: "explicit-open-command",
  };
}
function located(status: "absent" | "open" | "closed" | "unbound" = "open") {
  const source = composeSource();
  return {
    slot: {
      projectId: source.view.workspaceId,
      appId: source.authority.appId,
      version: source.authority.version,
      definitionHash: source.authority.definitionHash,
    },
    view:
      status === "absent"
        ? null
        : {
            viewId: source.view.id,
            viewRevision: source.view.revision,
            status:
              status === "closed" ? ("closed" as const) : ("open" as const),
            binding:
              status === "unbound"
                ? null
                : {
                    bindingRevision: source.binding.revision,
                    connectionId: source.binding.connectionId,
                    instanceId: source.binding.instanceId,
                    serviceId: source.binding.serviceId,
                    dataAuthorityId: source.binding.dataAuthorityId,
                  },
          },
  };
}
function sourceFor(status: "absent" | "open" | "closed" | "unbound") {
  const source = composeSource();
  if (status === "absent") {
    source.view.revision = source.binding.viewRevision = 1;
    source.binding.revision = 1;
  }
  if (status === "closed")
    source.view.revision = source.binding.viewRevision = 3;
  return source;
}
function fixture(status: "absent" | "open" | "closed" | "unbound" = "open") {
  const state = {
    location: located(status),
    source: sourceFor(status),
    mutation: {
      receipt: {
        viewId: "view",
        viewRevision: status === "absent" ? 1 : 3,
        bindingRevision: status === "absent" ? 1 : 3,
      },
      replayed: false,
    },
    live: true,
  };
  const calls: {
    method: string;
    parameters: unknown;
    signal: AbortSignal | undefined;
  }[] = [];
  const ports: CognitiveViewOpeningPorts = {
    current: () => state.live,
    async call(method, parameters, options) {
      calls.push({
        method,
        parameters: structuredClone(parameters),
        signal: options.signal,
      });
      if (method === "cognitive-app-views.locate") return state.location;
      if (method === "cognitive-app-views.launch") return state.mutation;
      if (method === "cognitive-app-views.read-ui") return state.source;
      throw new Error("Unexpected bind / grant / business / close operation.");
    },
  };
  return { state, calls, ports, owner: createCognitiveViewOpening(ports) };
}
const code = (expected: string) => (error: unknown) =>
  !!error &&
  typeof error === "object" &&
  Reflect.get(error, "code") === expected;
const params = (f: ReturnType<typeof fixture>) =>
  f.calls.map(({ method, parameters }) => ({ method, parameters }));

test("UNIT explicit opening of an open same-owner slot only locates then reads its exact CAS; location carries only the detached slot", async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  const result = await f.owner.open(request(), signal);
  const slot = {
    projectId: "project",
    appId: "example.notes",
    version: "1.1.0",
    expectedDefinitionHash: "a".repeat(64),
  };
  assert.deepEqual(params(f), [
    { method: "cognitive-app-views.locate", parameters: slot },
    {
      method: "cognitive-app-views.read-ui",
      parameters: {
        viewId: "view",
        expectedViewRevision: 2,
        expectedBindingRevision: 3,
      },
    },
  ]);
  assert(f.calls.every((call) => call.signal === signal));
  assert.deepEqual(result.location, { kind: "view", slot });
  assert.deepEqual(result.source, composeSource());
  assert(
    Object.isFrozen(result) &&
      Object.isFrozen(result.source.manifest.ui) &&
      Object.isFrozen(result.location.slot),
  );
  assert.notStrictEqual(result.source, f.state.source);
  f.state.source.view.state = { view: "later" };
  assert.deepEqual(result.source.view.state, {});
});

for (const status of ["absent", "closed"] as const)
  test(`UNIT explicit ${status} opening launches once using ${status === "absent" ? "only genuine absence 0/0" : "known same-owner slot CAS"}, then requires original readUI`, async () => {
    const f = fixture(status);
    const result = await f.owner.open(request(), new AbortController().signal);
    assert.deepEqual(
      f.calls.map((call) => call.method),
      [
        "cognitive-app-views.locate",
        "cognitive-app-views.launch",
        "cognitive-app-views.read-ui",
      ],
    );
    assert.deepEqual(f.calls[1]!.parameters, {
      projectId: "project",
      appId: "example.notes",
      version: "1.1.0",
      expectedDefinitionHash: "a".repeat(64),
      connectionId: "connection",
      expectedGrantRevision: 4,
      expectedConnectionRevision: 5,
      commandId: "explicit-open-command",
      expectedViewRevision: status === "absent" ? 0 : 2,
      expectedBindingRevision: status === "absent" ? 0 : 3,
    });
    assert.deepEqual(f.calls[2]!.parameters, {
      viewId: "view",
      expectedViewRevision: status === "absent" ? 1 : 3,
      expectedBindingRevision: status === "absent" ? 1 : 3,
    });
    assert.deepEqual(result.source, sourceFor(status));
    assert.deepEqual(result.location.slot, {
      projectId: "project",
      appId: "example.notes",
      version: "1.1.0",
      expectedDefinitionHash: "a".repeat(64),
    });
  });

test("UNIT strict own-data request rejects accessors/inheritance/unknown authority or endpoint fields before any call, with no getter invocation", async () => {
  let getters = 0;
  const raw = request();
  const invalid: unknown[] = [
    null,
    [],
    Object.create(raw),
    { ...raw, actorId: "other-human" },
    { ...raw, endpoint: "https://foreign.invalid" },
    { ...raw, expectedGrantRevision: 0 },
    { ...raw, expectedConnectionRevision: Number.POSITIVE_INFINITY },
    { ...raw, commandId: "../unsafe" },
    { ...raw, projectId: "../foreign" },
    { ...raw, target: { ...raw.target, endpoint: "https://foreign.invalid" } },
    {
      ...raw,
      target: {
        ...raw.target,
        authority: { ...raw.target.authority, authorId: "foreign" },
      },
    },
    Object.defineProperty({ ...raw }, "target", {
      enumerable: true,
      get() {
        getters++;
        return raw.target;
      },
    }),
    Object.defineProperty({ ...raw }, "hidden", {
      enumerable: false,
      value: "hidden",
    }),
    { ...raw, [Symbol("hidden")]: "hidden" },
    {
      ...raw,
      target: Object.defineProperty({ ...raw.target }, "authority", {
        enumerable: true,
        get() {
          getters++;
          return raw.target.authority;
        },
      }),
    },
  ];
  for (const value of invalid) {
    const f = fixture();
    await assert.rejects(
      f.owner.open(
        value as CognitiveViewOpeningRequest,
        new AbortController().signal,
      ),
      code("invalid"),
    );
    assert.deepEqual(f.calls, []);
  }
  assert.equal(getters, 0);
});

test("UNIT foreign exact slot, unbound historical slot and different complete save owner remain untouched, never auto-bind or choose a default connection", async () => {
  for (const status of ["open", "closed"] as const)
    for (const field of [
      "connectionId",
      "instanceId",
      "serviceId",
      "dataAuthorityId",
    ] as const) {
      const f = fixture(status);
      f.state.location.view!.binding![field] = "different";
      const old = structuredClone(f.state.location);
      await assert.rejects(
        f.owner.open(request(), new AbortController().signal),
        code("conflict"),
      );
      assert.deepEqual(f.state.location, old);
      assert.equal(f.calls.length, 1);
    }
  for (const status of ["open", "closed"] as const) {
    const f = fixture(status);
    f.state.location.view!.binding = null;
    await assert.rejects(
      f.owner.open(request(), new AbortController().signal),
      code("conflict"),
    );
    assert.equal(f.calls.length, 1);
  }
  for (const field of [
    "projectId",
    "appId",
    "version",
    "definitionHash",
  ] as const) {
    const f = fixture();
    f.state.location.slot[field] =
      field === "version"
        ? "2.0.0"
        : field === "definitionHash"
          ? "b".repeat(64)
          : "foreign";
    await assert.rejects(
      f.owner.open(request(), new AbortController().signal),
      code("conflict"),
    );
    assert.equal(f.calls.length, 1);
  }
});

test("UNIT a launch receipt alone never opens UI; closed receipt cannot replace its known view/binding or skip the exact new CAS", async () => {
  for (const field of ["viewId", "viewRevision", "bindingRevision"] as const) {
    const f = fixture("closed");
    if (field === "viewId") f.state.mutation.receipt.viewId = "other";
    else f.state.mutation.receipt[field]++;
    await assert.rejects(
      f.owner.open(request(), new AbortController().signal),
      code("conflict"),
    );
    assert.deepEqual(
      f.calls.map((call) => call.method),
      ["cognitive-app-views.locate", "cognitive-app-views.launch"],
    );
  }
  const f = fixture("absent");
  f.ports.call = async (method, parameters, options) => {
    f.calls.push({ method, parameters, signal: options.signal });
    if (method === "cognitive-app-views.locate") return f.state.location;
    if (method === "cognitive-app-views.launch") return f.state.mutation;
    throw Object.assign(new Error("Actual read-ui refused."), {
      code: "forbidden",
    });
  };
  await assert.rejects(
    f.owner.open(request(), new AbortController().signal),
    code("forbidden"),
  );
  assert.equal(f.calls.length, 3);
  assert(
    !f.calls.some((call) => /bind|close|grant|connect/.test(call.method)),
    "failure does not pretend rollback or issue cleanup mutations",
  );
});

test("UNIT fresh absent 0/0 creation requires receipt 1/1, not contradictory later but otherwise legal same-authority metadata", async () => {
  for (const field of ["viewRevision", "bindingRevision"] as const) {
    const f = fixture("absent");
    f.state.mutation.receipt[field] = 2;
    if (field === "viewRevision")
      f.state.source.view.revision = f.state.source.binding.viewRevision = 2;
    else f.state.source.binding.revision = 2;
    await assert.rejects(
      f.owner.open(request(), new AbortController().signal),
      code("conflict"),
    );
    assert.deepEqual(
      f.calls.map((call) => call.method),
      ["cognitive-app-views.locate", "cognitive-app-views.launch"],
    );
  }
});

test("UNIT legal but contradictory final metadata/access/authority is rejected after actual readUi, never retargeted", async () => {
  const cases = [
    (s: ReturnType<typeof composeSource>) => {
      s.view.workspaceId = s.binding.projectId = "foreign";
    },
    (s: ReturnType<typeof composeSource>) => {
      s.view.id = s.binding.viewId = "other";
    },
    (s: ReturnType<typeof composeSource>) => {
      s.view.revision = s.binding.viewRevision = 3;
    },
    (s: ReturnType<typeof composeSource>) => {
      s.binding.revision++;
    },
    (s: ReturnType<typeof composeSource>) => {
      s.binding.connectionId = "other";
    },
    (s: ReturnType<typeof composeSource>) => {
      s.authority = { ...s.authority, definitionHash: "b".repeat(64) };
    },
    (s: ReturnType<typeof composeSource>) => {
      s.binding.instanceId = "other";
      s.authority = { ...s.authority, instanceId: "other" };
    },
    (s: ReturnType<typeof composeSource>) => {
      s.binding.serviceId = "other";
      s.authority = { ...s.authority, serviceId: "other" };
    },
    (s: ReturnType<typeof composeSource>) => {
      s.binding.dataAuthorityId = "other";
      s.authority = { ...s.authority, dataAuthorityId: "other" };
    },
    (s: ReturnType<typeof composeSource>) => {
      s.grantRevision++;
    },
    (s: ReturnType<typeof composeSource>) => {
      s.connectionRevision++;
    },
  ];
  for (const alter of cases) {
    const f = fixture();
    alter(f.state.source);
    await assert.rejects(
      f.owner.open(request(), new AbortController().signal),
      code("conflict"),
    );
    assert.equal(f.calls.length, 2);
  }
  const malformed = fixture();
  malformed.state.source.view.status = "closed";
  await assert.rejects(
    malformed.owner.open(request(), new AbortController().signal),
    code("contract"),
  );
  assert.equal(malformed.calls.length, 2);
});

test("UNIT input is detached before the first await; owner/signal changes reject each late phase without retry or cleanup writes", async () => {
  for (const phase of ["locate", "launch", "read-ui"] as const)
    for (const mode of ["abort", "owner"] as const) {
      const f = fixture(phase === "launch" ? "absent" : "open");
      let release!: (value: unknown) => void, reached!: () => void;
      const held = new Promise<void>((resolve) => (reached = resolve));
      const original = f.ports.call;
      f.ports.call = async (method, parameters, options) => {
        if (method === "cognitive-app-views." + phase) {
          f.calls.push({
            method,
            parameters: structuredClone(parameters),
            signal: options.signal,
          });
          return await new Promise((resolve) => {
            release = resolve;
            reached();
          });
        }
        return await original(method, parameters, options);
      };
      const raw = structuredClone(request()),
        abort = new AbortController();
      const pending = f.owner.open(raw, abort.signal);
      Reflect.set(raw, "target", {
        connectionId: "foreign",
        authority: { ...raw.target.authority, definitionHash: "b".repeat(64) },
      });
      await held;
      if (mode === "abort") abort.abort();
      else f.state.live = false;
      release(
        phase === "locate"
          ? f.state.location
          : phase === "launch"
            ? f.state.mutation
            : f.state.source,
      );
      await assert.rejects(
        pending,
        code(mode === "abort" ? "cancelled" : "conflict"),
      );
      assert.equal(f.calls.length, phase === "locate" ? 1 : 2);
      assert.deepEqual(f.calls[0]!.parameters, {
        projectId: "project",
        appId: "example.notes",
        version: "1.1.0",
        expectedDefinitionHash: "a".repeat(64),
      });
      assert(
        !f.calls.some((call) => /bind|close|grant|connect/.test(call.method)),
      );
    }
});

test("UNIT already cancelled/retired/throwing owner and a synchronously aborting guard cannot issue a transport call", async () => {
  for (const mode of ["abort", "owner", "throw", "guard-abort"] as const) {
    const f = fixture(),
      abort = new AbortController();
    if (mode === "abort") abort.abort();
    if (mode === "owner") f.state.live = false;
    if (mode === "throw")
      f.ports.current = () => {
        throw Error("retired");
      };
    if (mode === "guard-abort")
      f.ports.current = () => {
        abort.abort();
        return true;
      };
    await assert.rejects(
      f.owner.open(request(), abort.signal),
      code(
        mode === "abort" || mode === "guard-abort" ? "cancelled" : "conflict",
      ),
    );
    assert.deepEqual(f.calls, []);
  }
});

test("UNIT malformed response accessors and foreign package fields are contract refusals, never read as author code or used as a new target", async () => {
  let getters = 0;
  for (const phase of ["locate", "launch", "read-ui"] as const) {
    const f = fixture(phase === "launch" ? "absent" : "open");
    const original = f.ports.call;
    f.ports.call = async (method, parameters, options) => {
      const value = await original(method, parameters, options);
      return method === "cognitive-app-views." + phase
        ? Object.defineProperty({}, "secret", {
            enumerable: true,
            get() {
              getters++;
              return value;
            },
          })
        : value;
    };
    await assert.rejects(
      f.owner.open(request(), new AbortController().signal),
      code("contract"),
    );
    assert.equal(f.calls.length, phase === "locate" ? 1 : 2);
  }
  assert.equal(getters, 0);
  for (const changed of ["manifest", "definition"] as const) {
    const f = fixture();
    if (changed === "manifest")
      f.state.source.manifest = {
        ...f.state.source.manifest,
        version: "2.0.0",
      };
    else
      f.state.source.definition = {
        ...f.state.source.definition,
        ui: { packageVersion: "2.0.0", sha256: "b".repeat(64) },
      };
    await assert.rejects(
      f.owner.open(request(), new AbortController().signal),
      code("contract"),
    );
    assert.equal(f.calls.length, 2);
  }
});

test("UNIT rejected transport continuations still recheck the captured owner/signal; live errors pass through without a hidden retry", async () => {
  for (const mode of ["live", "owner", "abort"] as const) {
    const f = fixture(),
      abort = new AbortController();
    const originalError = Object.assign(
      new Error("Unknown original operation."),
      { code: "unavailable" },
    );
    f.ports.call = async (method, parameters, options) => {
      f.calls.push({ method, parameters, signal: options.signal });
      if (mode === "owner") f.state.live = false;
      if (mode === "abort") abort.abort();
      throw originalError;
    };
    await assert.rejects(
      f.owner.open(request(), abort.signal),
      mode === "live"
        ? (error) => error === originalError
        : code(mode === "abort" ? "cancelled" : "conflict"),
    );
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.method, "cognitive-app-views.locate");
  }
});
