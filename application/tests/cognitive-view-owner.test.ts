import test from "node:test";
import assert from "node:assert/strict";
import { cognitiveNavigationLocation } from "../apps/web/src/host/cognitive-navigation-location.js";
import {
  createCognitiveViewOwner,
  cognitiveViewSourceForOwner,
} from "../apps/web/src/host/cognitive-view-owner.js";
import { composeSource } from "./fixtures/cognitive-compose-data.js";

// Finite controlled current-Human read ports. These UNIT witnesses do not
// prove HPA, SQL, package SHA, production App mounting or author execution.
const slot = {
  projectId: "project",
  appId: "example.notes",
  version: "1.1.0",
  expectedDefinitionHash: "a".repeat(64),
};
function location() {
  const source = composeSource();
  return {
    slot: {
      projectId: slot.projectId,
      appId: slot.appId,
      version: slot.version,
      definitionHash: slot.expectedDefinitionHash,
    },
    view: {
      viewId: source.view.id,
      viewRevision: source.view.revision,
      status: "open" as const,
      binding: {
        bindingRevision: source.binding.revision,
        connectionId: source.binding.connectionId,
        instanceId: source.binding.instanceId,
        serviceId: source.binding.serviceId,
        dataAuthorityId: source.binding.dataAuthorityId,
      },
    },
  };
}
function fixture(
  lookup: unknown = location(),
  source: unknown = composeSource(),
) {
  const calls: Array<{ method: string; parameters: unknown }> = [];
  const owner = createCognitiveViewOwner({
    async call(method, parameters) {
      calls.push({ method, parameters: structuredClone(parameters) });
      if (method === "cognitive-app-views.locate") return lookup;
      if (method === "cognitive-app-views.read-ui") return source;
      throw new Error("Unexpected business or mutation call: " + method);
    },
  });
  return { owner, calls };
}

test("UNIT view position is a detached strict locate slot, never persisted authority/CAS/body", () => {
  const raw = { kind: "view", slot: { ...slot } };
  const parsed = cognitiveNavigationLocation(raw);
  assert(parsed?.kind === "view");
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.slot), true);
  raw.slot.expectedDefinitionHash = "b".repeat(64);
  assert.deepEqual(parsed.slot, slot);
  assert.deepEqual(Object.keys(parsed), ["kind", "slot"]);
  let getters = 0;
  for (const invalid of [
    Object.create({ kind: "view", slot }),
    Object.defineProperty({ kind: "view" }, "slot", {
      enumerable: true,
      get() {
        getters++;
        return slot;
      },
    }),
    { kind: "view", slot, body: "PRIVATE" },
    { kind: "view", slot, authority: composeSource().authority },
    { kind: "view", slot, [Symbol("secret")]: "PRIVATE" },
    { kind: "view", slot: { ...slot, connectionId: "connection" } },
    { kind: "view", slot: { ...slot, expectedViewRevision: 0 } },
    { kind: "view", slot: { ...slot, expectedDefinitionHash: undefined } },
    { kind: "view", slot: { ...slot, version: "latest" } },
    { kind: "view", slot: { ...slot, projectId: "../foreign" } },
  ])
    assert.throws(() => cognitiveNavigationLocation(invalid));
  assert.equal(getters, 0);
});

test("UNIT restore only locates own exact slot then reads exact returned window/binding CAS", async () => {
  const f = fixture();
  const result = await f.owner.read(slot, new AbortController().signal);
  assert.equal(result.status, "ready");
  assert.deepEqual(f.calls, [
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
  assert(result.status === "ready");
  assert.deepEqual(result.source, composeSource());
  assert.deepEqual(result.location, location());
});

test("UNIT absent/closed/unbound restore is truthful metadata without launch/bind/grant/connection/default UI read", async () => {
  const located = location();
  for (const [status, view] of [
    ["absent", null],
    ["closed", { ...located.view, status: "closed" }],
    ["unbound", { ...located.view, binding: null }],
  ] as const) {
    const f = fixture({ ...located, view });
    const result = await f.owner.read(slot, new AbortController().signal);
    assert.equal(result.status, status);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.method, "cognitive-app-views.locate");
    assert(!("source" in result));
  }
});

test("UNIT foreign slot/old hash and contradictory UI read are rejected, not retargeted or retried", async () => {
  for (const field of [
    "projectId",
    "appId",
    "version",
    "definitionHash",
  ] as const) {
    const located = location();
    located.slot[field] =
      field === "definitionHash"
        ? "b".repeat(64)
        : field === "version"
          ? "2.0.0"
          : "other";
    const f = fixture(located);
    await assert.rejects(f.owner.read(slot, new AbortController().signal));
    assert.equal(f.calls.length, 1);
  }
  const cases = [
    (source: ReturnType<typeof composeSource>) => {
      source.view.id = source.binding.viewId = "other";
    },
    (source: ReturnType<typeof composeSource>) => {
      source.view.revision = source.binding.viewRevision = 3;
    },
    (source: ReturnType<typeof composeSource>) => {
      source.binding.revision = 4;
    },
    (source: ReturnType<typeof composeSource>) => {
      source.binding.connectionId = "other";
    },
    (source: ReturnType<typeof composeSource>) => {
      source.authority = {
        ...source.authority,
        definitionHash: "b".repeat(64),
      };
    },
    (source: ReturnType<typeof composeSource>) => {
      source.binding.instanceId = "other";
      source.authority = { ...source.authority, instanceId: "other" };
    },
  ];
  for (const alter of cases) {
    const source = structuredClone(composeSource());
    alter(source);
    const f = fixture(location(), source);
    await assert.rejects(f.owner.read(slot, new AbortController().signal));
    assert.equal(f.calls.length, 2);
  }
});

test("UNIT read snapshots the slot before the first await and rejects cancelled late metadata/UI replies", async () => {
  for (const phase of ["locate", "read-ui"] as const) {
    let release!: (value: unknown) => void;
    const calls: string[] = [];
    const owner = createCognitiveViewOwner({
      async call(method) {
        calls.push(method);
        if (method === "cognitive-app-views." + phase)
          return new Promise((resolve) => {
            release = resolve;
          });
        return location();
      },
    });
    const abort = new AbortController();
    const raw = { ...slot };
    const pending = owner.read(raw, abort.signal);
    raw.expectedDefinitionHash = "b".repeat(64);
    if (phase === "read-ui") await Promise.resolve();
    assert.equal(typeof release, "function");
    abort.abort();
    release(phase === "locate" ? location() : composeSource());
    await assert.rejects(pending);
    assert.equal(calls.length, phase === "locate" ? 1 : 2);
  }
  const f = fixture(),
    abort = new AbortController();
  abort.abort();
  await assert.rejects(f.owner.read(slot, abort.signal));
  assert.deepEqual(f.calls, []);
});

test("UNIT trusted same-owner new save CAS may advance view and binding.viewRevision, never fixed binding or access premises", () => {
  const initial = composeSource();
  const saved = structuredClone(initial);
  saved.view.revision = saved.binding.viewRevision = initial.view.revision + 1;
  saved.view.state = {
    view: "opaque:another-view",
    object: { objectId: "原件", versionRef: "opaque:V3" },
  };
  const accepted = cognitiveViewSourceForOwner(initial, saved);
  assert(accepted);
  assert.equal(accepted.view.revision, 3);
  assert.notStrictEqual(accepted, saved);
  for (const mutate of [
    (s: typeof saved) => {
      s.view.revision = s.binding.viewRevision = 1;
    },
    (s: typeof saved) => {
      s.binding.revision++;
    },
    (s: typeof saved) => {
      s.binding.connectionId = "other";
    },
    (s: typeof saved) => {
      s.grantRevision++;
    },
    (s: typeof saved) => {
      s.connectionRevision++;
    },
    (s: typeof saved) => {
      s.authority = { ...s.authority, definitionHash: "b".repeat(64) };
    },
    (s: typeof saved) => {
      s.manifest.permissions = [];
    },
    (s: typeof saved) => {
      s.manifest.ui = { type: "sandbox", html: "different author bytes" };
    },
    (s: typeof saved) => {
      s.view.status = "closed";
    },
  ]) {
    const changed = structuredClone(saved);
    mutate(changed);
    assert.equal(cognitiveViewSourceForOwner(initial, changed), null);
  }
});
