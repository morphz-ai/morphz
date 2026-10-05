import test from "node:test";
import assert from "node:assert/strict";
import {
  createCognitiveObjectOwner,
  type CognitiveObjectOwnerPorts,
} from "../apps/web/src/host/cognitive-object-owner.js";
import { ApplicationRequestError } from "../packages/core/src/application-api.js";
import {
  parseCognitiveAppViewResponse,
  type CognitiveAppViewUi,
} from "../packages/core/src/cognitive-app-view-api.js";
import { parseCognitiveAppObjectLocator } from "../packages/core/src/cognitive-app-object-locator.js";
import type { PlatformContent } from "../apps/web/src/platform-client.js";
import { viewSubmission } from "./fixtures/cognitive-app-view-service-fixture.js";

const object = {
  objectId: "原件/ 😀\n",
  versionRef: "000900719925474099312345:旧😀\n",
};
const signal = () => new AbortController().signal;
function source(html?: string): CognitiveAppViewUi {
  const { definition, manifest } = viewSubmission(html);
  const now = "2026-10-05T00:00:00Z";
  return parseCognitiveAppViewResponse("readUi", {
    definition,
    manifest,
    authority: {
      appId: definition.id,
      version: definition.version,
      definitionHash: "a".repeat(64),
      instanceId: "instance_exact",
      serviceId: "author/service",
      dataAuthorityId: "author/original",
    },
    view: {
      id: "view_exact",
      workspaceId: "project_exact",
      applicationId: definition.id,
      applicationVersion: definition.version,
      revision: 2,
      state: { object },
      status: "open",
      createdAt: now,
      updatedAt: now,
    },
    binding: {
      appId: definition.id,
      version: definition.version,
      instanceId: "instance_exact",
      serviceId: "author/service",
      dataAuthorityId: "author/original",
      viewId: "view_exact",
      projectId: "project_exact",
      connectionId: "connection_exact",
      revision: 3,
      viewRevision: 2,
      createdAt: now,
      updatedAt: now,
    },
    grantRevision: 4,
    connectionRevision: 5,
  });
}
function locator(ui = source()) {
  return parseCognitiveAppObjectLocator({
    contentId: "catalog_exact",
    projectId: ui.binding.projectId,
    connectionId: ui.binding.connectionId,
    authority: ui.authority,
    object,
  });
}
const failure = (status: number) => (error: unknown) => {
  assert.ok(error instanceof ApplicationRequestError);
  assert.equal(error.status, status);
  assert.equal("cause" in error, false);
  assert.doesNotMatch(error.message, /PRIVATE|credential|host_binding|sqlite/);
  return true;
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
/** UNIT controlled Human transport and author replies only. This is not
 * actual SQL, author network, GUI navigation, draft or submitted-input evidence. */
function unit(initial = source()) {
  let current = structuredClone(initial);
  let catalog: PlatformContent = {
    id: "catalog_exact",
    appId: initial.binding.appId,
    instanceId: initial.binding.instanceId,
    providerRevision: 1,
    appObjectId: object.objectId,
    projectId: initial.binding.projectId,
    kind: "note",
    title: "Current title",
    observedVersionRef: "CURRENT_HEAD_V2",
    availability: "available",
    revision: 1,
    createdAt: "2026-10-05T00:00:00Z",
    updatedAt: "2026-10-05T00:00:00Z",
  };
  const calls: Array<{
    method: string;
    parameters: Record<string, unknown>;
    signal: AbortSignal;
  }> = [];
  const control: {
    call?: (
      method: string,
      parameters: Record<string, unknown>,
      index: number,
    ) => Promise<void>;
    reply?: (
      method: string,
      parameters: Record<string, unknown>,
      fallback: unknown,
    ) => unknown;
  } = {};
  const ports: CognitiveObjectOwnerPorts = {
    async call(method, parameters, options) {
      const params = parameters as Record<string, unknown>;
      calls.push({
        method,
        parameters: structuredClone(params),
        signal: options.signal,
      });
      await control.call?.(method, params, calls.length);
      const fallback =
        method === "cognitive-app-views.read-ui"
          ? current
          : method === "cognitive-apps.read-object"
            ? {
                protocol: "morphz-domain/v1",
                authority: current.authority,
                object: params.object,
                kind: "note",
                title: "Historical title",
                content: { format: "markdown", text: "PINNED_V1_旧原件" },
              }
            : catalog;
      return control.reply
        ? control.reply(method, params, fallback)
        : structuredClone(fallback);
    },
  };
  return {
    owner: createCognitiveObjectOwner(ports),
    calls,
    control,
    current: () => current,
    catalog: () => catalog,
    changeView: (update: (value: CognitiveAppViewUi) => CognitiveAppViewUi) => {
      current = update(current);
    },
    changeEntry: (update: (value: PlatformContent) => PlatformContent) => {
      catalog = update(catalog);
    },
  };
}

test("UNIT locator resolves the exact instance/catalog tuple between fixed double-CAS gates without reading author bytes", async () => {
  const ui = source(),
    f = unit(ui),
    abort = signal();
  assert.deepEqual(
    await f.owner.locatorForView(ui, object, abort),
    locator(ui),
  );
  assert.deepEqual(
    f.calls.map(({ method }) => method),
    [
      "cognitive-app-views.read-ui",
      "content.resolve",
      "content.get",
      "cognitive-app-views.read-ui",
    ],
  );
  assert.deepEqual(f.calls[0]!.parameters, {
    viewId: ui.view.id,
    expectedViewRevision: 2,
    expectedBindingRevision: 3,
  });
  assert.deepEqual(f.calls[1]!.parameters, {
    appId: ui.binding.appId,
    appObjectId: object.objectId,
    instanceId: ui.binding.instanceId,
  });
  assert.deepEqual(f.calls[2]!.parameters, { contentId: "catalog_exact" });
  assert.deepEqual(f.calls[3]!.parameters, f.calls[0]!.parameters);
  assert.ok(f.calls.every((call) => call.signal === abort));
});

test("UNIT read-original preserves historical opaque version, exact authority and bounded public parameters despite a newer catalog head", async () => {
  const f = unit(),
    original = locator(),
    result = await f.owner.readOriginal(original, 100, signal());
  assert.deepEqual(result.locator, original);
  assert.deepEqual(result.original.object, object);
  assert.equal(result.original.title, "Historical title");
  assert.equal(result.entry.observedVersionRef, "CURRENT_HEAD_V2");
  assert.deepEqual(result.original.content, {
    format: "markdown",
    text: "PINNED_V1_旧原件",
  });
  assert.deepEqual(
    f.calls.map(({ method }) => method),
    ["content.get", "cognitive-apps.read-object", "content.get"],
  );
  assert.deepEqual(f.calls[1]!.parameters, {
    projectId: original.projectId,
    appId: original.authority.appId,
    version: original.authority.version,
    connectionId: original.connectionId,
    expectedDefinitionHash: original.authority.definitionHash,
    object,
    maxBytes: 100,
  });
  assert.ok(
    Object.isFrozen(result.locator) && Object.isFrozen(result.locator.object),
  );
});

test("UNIT caller snapshots precede the first await and returned author/catalog bodies are independent", async () => {
  const ui = source(),
    raw = structuredClone(object),
    f = unit(ui),
    wait = deferred();
  f.control.call = async (_method, _params, index) => {
    if (index === 1) await wait.promise;
  };
  const pending = f.owner.locatorForView(ui, raw, signal());
  (ui.authority as { serviceId: string }).serviceId = "changed";
  ui.binding.projectId = "changed";
  raw.versionRef = "changed";
  wait.resolve();
  assert.deepEqual(await pending, locator());
  const rawLocator = structuredClone(locator()),
    read = unit(),
    readWait = deferred();
  read.control.call = async (_method, _params, index) => {
    if (index === 1) await readWait.promise;
  };
  const reading = read.owner.readOriginal(rawLocator, 100, signal());
  (rawLocator.object as { versionRef: string }).versionRef = "changed";
  (rawLocator.authority as { dataAuthorityId: string }).dataAuthorityId =
    "changed";
  readWait.resolve();
  assert.deepEqual((await reading).locator, locator());
  const body = {
    protocol: "morphz-domain/v1",
    authority: source().authority,
    object: structuredClone(object),
    kind: "note",
    title: "Original",
    content: { format: "json", value: { text: "old" } },
  };
  read.control.reply = (method, _params, fallback) =>
    method === "cognitive-apps.read-object" ? body : fallback;
  const detached = await read.owner.readOriginal(locator(), 100, signal());
  body.content.value.text = "changed";
  read.catalog().title = "changed";
  assert.deepEqual(detached.original.content, {
    format: "json",
    value: { text: "old" },
  });
  assert.equal(detached.entry.title, "Current title");
});

test("UNIT 1 MB HTML keeps its separate view budget instead of the smaller metadata wire budget", async () => {
  const ui = source("x".repeat(1_000_000)),
    f = unit(ui);
  assert.deepEqual(
    await f.owner.locatorForView(ui, object, signal()),
    locator(ui),
  );
});

test("UNIT numeric/invalid opaque references, private aliases and accessors fail before any service call", async () => {
  const f = unit();
  let getters = 0;
  const getter = () => {
    getters++;
    throw new Error("PRIVATE-credential");
  };
  for (const raw of [
    { ...object, versionRef: 1 },
    { ...object, versionRef: "nul\u0000" },
    { ...object, versionRef: "unpaired\ud800" },
    { ...object, versionRef: "" },
    { ...object, actor: "private" },
    Object.defineProperty({}, "objectId", { enumerable: true, get: getter }),
  ])
    await assert.rejects(
      f.owner.locatorForView(source(), raw as typeof object, signal()),
      failure(400),
    );
  const badUi = Object.defineProperty({}, "binding", {
    enumerable: true,
    get: getter,
  });
  await assert.rejects(
    f.owner.locatorForView(badUi as CognitiveAppViewUi, object, signal()),
    failure(400),
  );
  const badLocator = Object.defineProperty({}, "object", {
    enumerable: true,
    get: getter,
  });
  await assert.rejects(
    f.owner.readOriginal(
      badLocator as ReturnType<typeof locator>,
      100,
      signal(),
    ),
    failure(400),
  );
  await assert.rejects(
    f.owner.readOriginal(
      { ...locator(), actor: "private" } as ReturnType<typeof locator>,
      100,
      signal(),
    ),
    failure(400),
  );
  assert.equal(getters, 0);
  assert.equal(f.calls.length, 0);
});

test("UNIT resolve and content-get cannot substitute project, app, instance, object, catalog ID or unavailable originals", async () => {
  for (const method of ["content.resolve", "content.get"]) {
    for (const change of [
      { id: "other_catalog" },
      { projectId: "other_project" },
      { appId: "other.app" },
      { instanceId: "other_instance" },
      { appObjectId: "other/object" },
      { availability: "deleted" },
    ]) {
      const f = unit();
      f.control.reply = (called, _params, fallback) =>
        called === method
          ? { ...(fallback as object), ...change }
          : structuredClone(fallback);
      await assert.rejects(
        f.owner.locatorForView(source(), object, signal()),
        failure(409),
      );
      assert.equal(
        f.calls.some((call) => call.method === "cognitive-apps.read-object"),
        false,
      );
      assert.notEqual(f.calls.at(-1)!.method, "cognitive-app-views.read-ui");
    }
  }
});

test("UNIT final view gate rejects changed grant, connection, binding, state or original revision after metadata work", async () => {
  const changes: Array<(value: CognitiveAppViewUi) => CognitiveAppViewUi> = [
    (v) => ({ ...v, grantRevision: v.grantRevision + 1 }),
    (v) => ({ ...v, connectionRevision: v.connectionRevision + 1 }),
    (v) => ({
      ...v,
      binding: { ...v.binding, connectionId: "other_connection" },
    }),
    (v) => ({
      ...v,
      binding: { ...v.binding, revision: v.binding.revision + 1 },
    }),
    (v) => ({
      ...v,
      view: {
        ...v.view,
        state: { object: { ...object, versionRef: "other" } },
      },
    }),
    (v) => ({
      ...v,
      view: { ...v.view, revision: 3 },
      binding: { ...v.binding, viewRevision: 3 },
    }),
    (v) => ({
      ...v,
      authority: { ...v.authority, serviceId: "other/service" },
      binding: { ...v.binding, serviceId: "other/service" },
    }),
  ];
  for (const change of changes) {
    const f = unit();
    f.control.call = async (method) => {
      if (method === "content.get") f.changeView(change);
    };
    await assert.rejects(
      f.owner.locatorForView(source(), object, signal()),
      failure(409),
    );
    assert.equal(f.calls.length, 4);
  }
});

test("UNIT abort at every awaited boundary drops late results and makes no further calls", async () => {
  for (const kind of ["locator", "original"] as const) {
    const count = kind === "locator" ? 4 : 3;
    for (let boundary = 0; boundary <= count; boundary++) {
      const controller = new AbortController(),
        f = unit();
      if (boundary === 0) controller.abort();
      f.control.call = async (_method, _params, index) => {
        if (index === boundary) controller.abort();
      };
      await assert.rejects(
        kind === "locator"
          ? f.owner.locatorForView(source(), object, controller.signal)
          : f.owner.readOriginal(locator(), 100, controller.signal),
        failure(408),
      );
      assert.equal(f.calls.length, boundary);
    }
  }
});

test("UNIT final deferred read-ui still rejects retirement or revocation before publishing the locator", async () => {
  for (const retirement of ["abort", "revoke"] as const) {
    const f = unit(),
      controller = new AbortController(),
      entered = deferred(),
      wait = deferred();
    f.control.call = async (_method, _params, index) => {
      if (index === 4) {
        entered.resolve();
        await wait.promise;
      }
    };
    const pending = f.owner.locatorForView(source(), object, controller.signal);
    await entered.promise;
    if (retirement === "abort") controller.abort();
    else f.changeView((v) => ({ ...v, grantRevision: v.grantRevision + 1 }));
    wait.resolve();
    await assert.rejects(pending, failure(retirement === "abort" ? 408 : 409));
    assert.equal(f.calls.length, 4);
  }
});

test("UNIT rejected awaited calls also honor retirement instead of exposing a late transport error", async () => {
  for (const kind of ["locator", "original"] as const) {
    const f = unit(),
      controller = new AbortController(),
      entered = deferred(),
      wait = deferred();
    f.control.call = async () => {
      entered.resolve();
      await wait.promise;
      throw new Error("PRIVATE-late-transport-error");
    };
    const pending =
      kind === "locator"
        ? f.owner.locatorForView(source(), object, controller.signal)
        : f.owner.readOriginal(locator(), 100, controller.signal);
    await entered.promise;
    controller.abort();
    wait.resolve();
    await assert.rejects(pending, failure(408));
    assert.equal(f.calls.length, 1);
  }
});

test("UNIT author response must match every authority field and the exact original object/version", async () => {
  const authorityChanges = [
    { appId: "other.app" },
    { version: "2.0.0" },
    { definitionHash: "b".repeat(64) },
    { instanceId: "other_instance" },
    { serviceId: "other/service" },
    { dataAuthorityId: "other/data" },
  ];
  for (const change of authorityChanges) {
    const f = unit();
    f.control.reply = (method, _params, fallback) =>
      method === "cognitive-apps.read-object"
        ? {
            ...(fallback as object),
            authority: { ...source().authority, ...change },
          }
        : fallback;
    await assert.rejects(
      f.owner.readOriginal(locator(), 100, signal()),
      failure(502),
    );
    assert.equal(f.calls.length, 2);
  }
  for (const change of [
    { objectId: "other/object" },
    { versionRef: "CURRENT_HEAD_V2" },
  ]) {
    const f = unit();
    f.control.reply = (method, _params, fallback) =>
      method === "cognitive-apps.read-object"
        ? { ...(fallback as object), object: { ...object, ...change } }
        : fallback;
    await assert.rejects(
      f.owner.readOriginal(locator(), 100, signal()),
      failure(502),
    );
    assert.equal(f.calls.length, 2);
  }
});

test("UNIT original byte budget is validated before authorization and enforced as UTF-8 for text and JSON", async () => {
  for (const maxBytes of [0, -1, 262145, Number.NaN, 1.5]) {
    const f = unit();
    await assert.rejects(
      f.owner.readOriginal(locator(), maxBytes, signal()),
      failure(400),
    );
    assert.equal(f.calls.length, 0);
  }
  for (const [content, exactBytes] of [
    [{ format: "text", text: "中" }, 3],
    [{ format: "json", value: "中" }, 5],
  ] as const) {
    const f = unit();
    f.control.reply = (method, _params, fallback) =>
      method === "cognitive-apps.read-object"
        ? { ...(fallback as object), content }
        : fallback;
    await assert.rejects(
      f.owner.readOriginal(locator(), exactBytes - 1, signal()),
      failure(502),
    );
    assert.equal(f.calls.length, 2);
    assert.deepEqual(
      (await f.owner.readOriginal(locator(), exactBytes, signal())).original
        .content,
      content,
    );
  }
});

test("UNIT metadata is rechecked after author reply; changed ownership or availability discards private bytes", async () => {
  for (const change of [
    { id: "other_catalog" },
    { projectId: "other_project" },
    { appId: "other.app" },
    { instanceId: "other_instance" },
    { appObjectId: "other/object" },
    { availability: "deleted" },
  ]) {
    const f = unit();
    f.control.call = async (method) => {
      if (method === "cognitive-apps.read-object")
        f.changeEntry((v) => ({ ...v, ...change }));
    };
    await assert.rejects(
      f.owner.readOriginal(locator(), 100, signal()),
      failure(409),
    );
    assert.equal(f.calls.length, 3);
  }
});

test("UNIT malformed metadata/author accessors never execute or expose their error text", async () => {
  for (const method of [
    "content.resolve",
    "content.get",
    "cognitive-apps.read-object",
  ]) {
    const f = unit();
    let executed = 0;
    f.control.reply = (called, _params, fallback) =>
      called === method
        ? Object.defineProperty({}, "title", {
            enumerable: true,
            get() {
              executed++;
              throw new Error("PRIVATE-credential");
            },
          })
        : fallback;
    await assert.rejects(
      method === "content.resolve"
        ? f.owner.locatorForView(source(), object, signal())
        : f.owner.readOriginal(locator(), 100, signal()),
      failure(502),
    );
    assert.equal(executed, 0);
  }
});

test("UNIT concurrent historical reads never share a mutable latest-reference slot and public failures are not retried", async () => {
  const f = unit(),
    entered = deferred(),
    wait = deferred();
  const old = locator(),
    another = parseCognitiveAppObjectLocator({
      ...old,
      object: { ...object, versionRef: "another historical version" },
    });
  f.control.call = async (method, params) => {
    if (
      method === "cognitive-apps.read-object" &&
      (params.object as typeof object).versionRef === old.object.versionRef
    ) {
      entered.resolve();
      await wait.promise;
    }
  };
  const first = f.owner.readOriginal(old, 100, signal());
  await entered.promise;
  const second = await f.owner.readOriginal(another, 100, signal());
  assert.deepEqual(second.original.object, another.object);
  wait.resolve();
  assert.deepEqual((await first).original.object, old.object);
  const unavailable = unit(),
    originalFailure = new ApplicationRequestError(
      403,
      "公开授权已撤销。",
      "forbidden",
    );
  unavailable.control.call = async (method) => {
    if (method === "cognitive-apps.read-object") throw originalFailure;
  };
  await assert.rejects(
    unavailable.owner.readOriginal(old, 100, signal()),
    (error) => error === originalFailure,
  );
  assert.equal(unavailable.calls.length, 2);
});
