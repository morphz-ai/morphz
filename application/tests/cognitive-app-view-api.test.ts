import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseCognitiveAppViewRequest,
  parseCognitiveAppViewResponse,
} from "../packages/core/src/cognitive-app-view-api.js";
import type { CognitiveAppViewMethod } from "../packages/core/src/cognitive-app-view-api.js";

const at = "2026-10-05T00:00:00.000Z";
const launch = {
  projectId: "project-a",
  appId: "example.notes",
  version: "1.0.0",
  connectionId: "connection-a",
  commandId: "launch-a",
  expectedViewRevision: 0,
  expectedBindingRevision: 0,
};
const cas = {
  viewId: "launch-a",
  expectedViewRevision: 1,
  expectedBindingRevision: 1,
};
const inputs: Record<CognitiveAppViewMethod, unknown> = {
  locate: {
    projectId: launch.projectId,
    appId: launch.appId,
    version: launch.version,
    expectedDefinitionHash: "a".repeat(64),
  },
  launch,
  bind: { ...launch, ...cas },
  read: { viewId: cas.viewId },
  readUi: cas,
  save: { ...cas, commandId: "save-a", state: { view: "notes" } },
  close: { ...cas, commandId: "close-a" },
};
function uiResult(html = "<!doctype html><h1>真实界面 😀</h1>") {
  const definition = {
    format: "morphz-cognitive-app/v1",
    protocol: "morphz-domain/v1",
    id: launch.appId,
    version: launch.version,
    title: "便笺",
    description: "原件在作者数据库",
    icon: "document",
    harness: null,
    ui: { packageVersion: launch.version, sha256: "b".repeat(64) },
    operations: [],
  };
  const manifest = {
    format: "morphz-app/v1",
    id: definition.id,
    version: definition.version,
    title: definition.title,
    description: definition.description,
    icon: definition.icon,
    harness: null,
    permissions: ["input.compose"],
    ui: { type: "sandbox", html },
  };
  const view = {
    id: cas.viewId,
    workspaceId: launch.projectId,
    applicationId: launch.appId,
    applicationVersion: launch.version,
    revision: 1,
    state: { view: "notes" },
    status: "open",
    createdAt: at,
    updatedAt: at,
  };
  const binding = {
    appId: launch.appId,
    version: launch.version,
    instanceId: "instance-a",
    serviceId: "service/notes",
    dataAuthorityId: "database/notes",
    viewId: view.id,
    projectId: view.workspaceId,
    connectionId: launch.connectionId,
    revision: 1,
    viewRevision: 1,
    createdAt: at,
    updatedAt: at,
  };
  const authority = {
    appId: launch.appId,
    version: launch.version,
    definitionHash: "a".repeat(64),
    instanceId: binding.instanceId,
    serviceId: binding.serviceId,
    dataAuthorityId: binding.dataAuthorityId,
  };
  return {
    view,
    binding,
    manifest,
    definition,
    authority,
    grantRevision: 1,
    connectionRevision: 1,
  };
}

test("view lifecycle has independent strict requests and fixed mutation receipts", () => {
  const request = {
    projectId: "project-a",
    appId: "example.notes",
    version: "1.0.0",
    connectionId: "connection-a",
    commandId: "launch-a",
    expectedViewRevision: 0,
    expectedBindingRevision: 0,
  };
  assert.deepEqual(parseCognitiveAppViewRequest("launch", request), request);
  assert.deepEqual(
    parseCognitiveAppViewResponse("launch", {
      receipt: { viewId: "launch-a", viewRevision: 1, bindingRevision: 1 },
      replayed: false,
    }),
    {
      receipt: { viewId: "launch-a", viewRevision: 1, bindingRevision: 1 },
      replayed: false,
    },
  );
});

test("seven finite requests never accept caller authority, address, owner, time or credentials", () => {
  for (const method of Object.keys(inputs) as CognitiveAppViewMethod[]) {
    assert.deepEqual(
      parseCognitiveAppViewRequest(method, inputs[method]),
      inputs[method],
    );
    for (const key of [
      "actor",
      "owner",
      "principalId",
      "tenantId",
      "source",
      "authority",
      "dataAuthorityId",
      "serviceId",
      "endpoint",
      "url",
      "hostBindingId",
      "credential",
      "installedBy",
      "now",
      "html",
      "verified",
    ])
      assert.throws(() =>
        parseCognitiveAppViewRequest(method, {
          ...(inputs[method] as object),
          [key]: "PRIVATE",
        }),
      );
  }
  assert.throws(() =>
    parseCognitiveAppViewRequest("launch", { ...launch, commandId: null }),
  );
  assert.throws(() =>
    parseCognitiveAppViewRequest("launch", {
      ...launch,
      expectedViewRevision: -1,
    }),
  );
  assert.throws(() =>
    parseCognitiveAppViewRequest("bind", {
      ...launch,
      viewId: "v",
      expectedViewRevision: 0,
    }),
  );
  assert.throws(() =>
    parseCognitiveAppViewRequest("close", {
      ...(inputs.close as object),
      state: {},
    }),
  );
  assert.throws(() =>
    parseCognitiveAppViewRequest("readUi", {
      ...cas,
      expectedBindingRevision: 0,
    }),
  );
});

test("save preserves opaque exact navigation and refuses document/draft/unsafe refs", () => {
  const state = {
    view: "notes",
    object: { objectId: "note/ 😀", versionRef: " exact/old\nversion " },
  };
  const parsed = parseCognitiveAppViewRequest("save", {
    ...cas,
    commandId: "save",
    state,
  });
  state.object.versionRef = "changed";
  assert.equal(parsed.state.object!.versionRef, " exact/old\nversion ");
  for (const state of [
    { body: "private" },
    { draft: "private" },
    { object: { objectId: "x", versionRef: 2 } },
    { object: { objectId: "x", versionRef: "\u0000" } },
    { object: { objectId: "x", versionRef: "\ud800" } },
  ])
    assert.throws(() =>
      parseCognitiveAppViewRequest("save", {
        ...cas,
        commandId: "save",
        state,
      }),
    );
});

test("request guards never run accessors/toJSON and bound bytes/depth/nodes", () => {
  let calls = 0;
  for (const hostile of [
    Object.defineProperty({ ...launch }, "commandId", {
      enumerable: true,
      get() {
        calls++;
        return "getter";
      },
    }),
    {
      ...launch,
      toJSON() {
        calls++;
        return launch;
      },
    },
    Object.assign(Object.create({ inherited: true }), launch),
  ])
    assert.throws(() => parseCognitiveAppViewRequest("launch", hostile));
  assert.equal(calls, 0);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() =>
    parseCognitiveAppViewRequest("save", {
      ...cas,
      commandId: "save",
      state: cycle,
    }),
  );
  assert.throws(() =>
    parseCognitiveAppViewRequest("launch", {
      ...launch,
      extra: "x".repeat(512 * 1024),
    }),
  );
  let deep: unknown = null;
  for (let n = 0; n < 41; n++) deep = { child: deep };
  assert.throws(() =>
    parseCognitiveAppViewRequest("save", {
      ...cas,
      commandId: "save",
      state: deep,
    }),
  );
  assert.throws(() =>
    parseCognitiveAppViewRequest("save", {
      ...cas,
      commandId: "save",
      state: Array(32769).fill(null),
    }),
  );
});

test("metadata is exact bound navigation, not byte permission or arbitrary saved state", () => {
  const { view, binding } = uiResult();
  assert.deepEqual(parseCognitiveAppViewResponse("read", { view, binding }), {
    view,
    binding,
  });
  assert.equal(
    parseCognitiveAppViewResponse("read", {
      view: { ...view, status: "closed" },
      binding,
    }).view.status,
    "closed",
  );
  for (const bad of [
    { view, binding: null },
    { view, binding: { ...binding, viewId: "other" } },
    { view, binding: { ...binding, projectId: "other" } },
    { view, binding: { ...binding, viewRevision: 2 } },
    { view: { ...view, state: { markdown: "body" } }, binding },
    { view, binding, manifest: uiResult().manifest },
    { view, binding: { ...binding, ownerPrincipalId: "private" } },
  ])
    assert.throws(() => parseCognitiveAppViewResponse("read", bad));
});

test("mutation replies contain only the original fixed receipt and replay flag", () => {
  const value = {
    receipt: { viewId: "view", viewRevision: 2, bindingRevision: 1 },
    replayed: true,
  };
  for (const method of ["launch", "bind", "save", "close"] as const) {
    assert.deepEqual(parseCognitiveAppViewResponse(method, value), value);
    assert.throws(() =>
      parseCognitiveAppViewResponse(method, {
        ...value,
        currentView: uiResult().view,
      }),
    );
    assert.throws(() =>
      parseCognitiveAppViewResponse(method, {
        ...value,
        receipt: { ...value.receipt, state: {} },
      }),
    );
  }
});

test("UI response uses its dedicated escaping carrier but enforces exact UTF-8 HTML bounds", () => {
  const html = '"\\\n'.repeat(333_333) + "x";
  assert.equal(new TextEncoder().encode(html).byteLength, 1_000_000);
  assert.ok(JSON.stringify(uiResult(html)).length > 512 * 1024);
  assert.equal(
    (
      parseCognitiveAppViewResponse("readUi", uiResult(html)).manifest.ui as {
        html: string;
      }
    ).html,
    html,
  );
  assert.throws(() =>
    parseCognitiveAppViewResponse("readUi", uiResult(html + "x")),
  );
  assert.throws(() =>
    parseCognitiveAppViewResponse("readUi", uiResult("😀".repeat(250_001))),
  );
  assert.throws(() =>
    parseCognitiveAppViewResponse("readUi", {
      ...uiResult(),
      extra: "x".repeat(8 * 1024 * 1024),
    }),
  );
});

test("UI response exact identity and strict public projection cannot leak Host internals", () => {
  const original = uiResult();
  assert.deepEqual(parseCognitiveAppViewResponse("readUi", original), original);
  for (const patch of [
    { view: { ...original.view, status: "closed" } },
    { authority: { ...original.authority, instanceId: "wrong" } },
    { authority: { ...original.authority, dataAuthorityId: "wrong" } },
    { definition: { ...original.definition, ui: null } },
    { manifest: { ...original.manifest, permissions: ["artifacts.read"] } },
    { manifest: { ...original.manifest, title: "not this definition" } },
    { installedByPrincipalId: "private" },
    { storeId: "private" },
    { actor: { credential: "private" } },
    { proof: { verified: true } },
  ])
    assert.throws(() =>
      parseCognitiveAppViewResponse("readUi", { ...original, ...patch }),
    );
  let calls = 0;
  const hostile = Object.defineProperty({ ...original }, "manifest", {
    enumerable: true,
    get() {
      calls++;
      return original.manifest;
    },
  });
  assert.throws(() => parseCognitiveAppViewResponse("readUi", hostile));
  assert.equal(calls, 0);
});

test("Core window contract has no Platform/Application/Node authority dependency", () => {
  const source = readFileSync(
    new URL("../packages/core/src/cognitive-app-view-api.ts", import.meta.url),
    "utf8",
  );
  for (const forbidden of [
    "node:",
    "platform/src",
    "application/src",
    "fetch(",
    "createHash(",
    "SqlQuery",
  ])
    assert.equal(source.includes(forbidden), false);
});
