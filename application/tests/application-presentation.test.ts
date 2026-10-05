import assert from "node:assert/strict";
import test from "node:test";
import {
  browserApplication,
  readerApplication,
  scriptStudioApplication,
  objectsApplication,
} from "../packages/core/src/applications.js";
import {
  initialWorkspace,
  type Workspace,
} from "../packages/core/src/model.js";
import type { CognitiveAppCatalogDto } from "../packages/core/src/cognitive-app-api.js";
import {
  cognitiveApplicationTargets,
  cognitiveApplicationForPackage,
  normalizeApplicationPresentation,
  presentationKey,
  presentationTitle,
  projectApplicationPresentation,
} from "../apps/web/src/application-presentation.js";
import { pinnedPresentationApplications } from "../apps/web/src/application-dock-model.js";
import { placeDockApplication } from "../apps/web/src/application-dock-interaction.js";

const now = "2026-10-05T00:00:00.000Z";
type Metadata = CognitiveAppCatalogDto["versions"][number];
type Connection = CognitiveAppCatalogDto["connections"][number];
function version(overrides: Partial<Metadata> = {}): Metadata {
  return {
    appId: "author.notes",
    version: "1.0.0",
    definitionHash: "a".repeat(64),
    title: "作者笔记",
    description: "作者保存原件",
    icon: "document",
    registeredAt: now,
    installationState: "active",
    harness: { id: "notes", version: "1.0.0" },
    ui: null,
    grant: {
      appId: "author.notes",
      version: "1.0.0",
      state: "active",
      revision: 1,
      consentedAt: now,
      updatedAt: now,
    },
    ...overrides,
  };
}
function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    appId: "author.notes",
    connectionId: "connection-A",
    instanceId: "instance-A",
    serviceId: "author/service",
    dataAuthorityId: "原始数据😀",
    state: "active",
    revision: 2,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
function directory(versions = [version()], connections = [connection()]) {
  return projectApplicationPresentation({
    workspace: initialWorkspace(now),
    principalId: "local-owner",
    workspaceId: "first-project",
    cognitiveCatalog: { versions, connections },
  });
}

test("shared presentation preserves actual bundled and legacy entries without manufacturing cognitive manifests", () => {
  const workspace: Workspace = initialWorkspace(now);
  const uiOnly: Workspace["applications"][number] = {
    format: "morphz-app/v1",
    id: "author.gui",
    version: "1.0.0",
    title: "旧应用",
    description: "原头部",
    icon: "code",
    harness: null,
    permissions: ["input.compose"],
    ui: { type: "sandbox" },
    installedBy: "local-owner",
  };
  workspace.applications = [
    uiOnly,
    { ...uiOnly, id: "author.foreign", installedBy: "other" },
  ];
  const result = projectApplicationPresentation({
    workspace,
    principalId: "local-owner",
    workspaceId: "first-project",
    cognitiveCatalog: { versions: [version()], connections: [connection()] },
  });
  assert.deepEqual(
    result.entries.slice(0, 3).map(presentationKey),
    [browserApplication, readerApplication, scriptStudioApplication].map(
      (a) => `${a.id}@${a.version}`,
    ),
  );
  const legacy = result.entries[3];
  assert(legacy?.kind === "ui-only");
  assert.equal(legacy.application, uiOnly);
  assert.equal(result.entries.length, 5);
  const cognitive = result.entries[4];
  assert(cognitive?.kind === "cognitive");
  assert.equal(Object.hasOwn(cognitive, "application"), false);
  assert.equal(cognitive.metadata.ui, null);
  assert.equal(cognitive.gui, "absent");
});

test("exact cognitive version/hash keys do not collide with old pins or select a latest version", () => {
  const one = version(),
    two = version({
      version: "2.0.0",
      definitionHash: "b".repeat(64),
      grant: {
        appId: "author.notes",
        version: "2.0.0",
        state: "active",
        revision: 1,
        consentedAt: now,
        updatedAt: now,
      },
    });
  const { entries } = directory([one, two]);
  const cognitive = entries.filter((e) => e.kind === "cognitive");
  assert.deepEqual(cognitive.map(presentationKey), [
    `cognitive:author.notes@1.0.0#${one.definitionHash}`,
    `cognitive:author.notes@2.0.0#${two.definitionHash}`,
  ]);
  assert.deepEqual(cognitive.map(presentationTitle), ["作者笔记", "作者笔记"]);
  const [first, second] = cognitive;
  assert(first && second);
  assert.notEqual(presentationKey(first), "author.notes@1.0.0");
  assert.equal(first.metadata, one);
  assert.equal(second.metadata, two);
});

test("multiple actual connections remain explicit choices with full original authority, not first/default or online", () => {
  const a = connection(),
    b = connection({
      connectionId: "connection-B",
      instanceId: "instance-B",
      dataAuthorityId: "另一保存方",
    });
  const result = directory(
    [version()],
    [
      a,
      b,
      connection({ connectionId: "disabled", state: "disabled" }),
      connection({ appId: "foreign.app", connectionId: "foreign" }),
    ],
  );
  const entry = result.entries.find((e) => e.kind === "cognitive");
  assert(entry?.kind === "cognitive");
  assert.equal(entry.connections.length, 3);
  assert.equal(Object.hasOwn(entry, "selectedConnection"), false);
  assert.deepEqual(
    cognitiveApplicationTargets(entry),
    [a, b].map((c) => ({
      connectionId: c.connectionId,
      authority: {
        appId: "author.notes",
        version: "1.0.0",
        definitionHash: "a".repeat(64),
        instanceId: c.instanceId,
        serviceId: c.serviceId,
        dataAuthorityId: c.dataAuthorityId,
      },
    })),
  );
});

test("registered, revoked and unavailable facts stay manageable but never enter quick operations", () => {
  for (const metadata of [
    version({ grant: null }),
    version({
      grant: {
        appId: "author.notes",
        version: "1.0.0",
        state: "disabled",
        revision: 3,
        consentedAt: now,
        updatedAt: now,
      },
    }),
    version({ installationState: "disabled" }),
    version({ installationState: "unavailable" }),
  ]) {
    const result = directory([metadata]);
    const entry = result.entries.find((e) => e.kind === "cognitive");
    assert(entry?.kind === "cognitive");
    assert.equal(entry.metadata, metadata);
    assert.deepEqual(cognitiveApplicationTargets(entry), []);
    assert.equal(
      result.quickEntries.some((e) => e.kind === "cognitive"),
      false,
    );
  }
  const result = directory(
    [version()],
    [
      connection({ state: "unavailable" }),
      connection({ connectionId: "disabled", state: "disabled" }),
    ],
  );
  const entry = result.entries.find((e) => e.kind === "cognitive");
  assert(entry?.kind === "cognitive");
  assert.equal(entry.inputAvailability, "no-active-connection");
  assert.equal(entry.connections.length, 2);
  assert.equal(
    result.quickEntries.some((e) => e.kind === "cognitive"),
    false,
  );
});

test("declared cognitive GUI remains honestly unavailable and cannot become the old sandbox path", () => {
  const png = "data:image/png;base64," + "A".repeat(160000);
  const entry = directory([
    version({
      iconImage: png,
      ui: { packageVersion: "1.0.0", sha256: "c".repeat(64) },
    }),
  ]).entries.find((e) => e.kind === "cognitive");
  assert(entry?.kind === "cognitive");
  assert.equal(entry.gui, "host-not-accepted");
  assert.equal(entry.metadata.iconImage, png);
  assert.equal(Object.hasOwn(entry, "application"), false);
  assert.equal(cognitiveApplicationTargets(entry).length, 1);
});

test("old raw compatibility uses the same typed presentation and keeps supplied entries unchanged", () => {
  const raw = [browserApplication, readerApplication];
  const normalized = normalizeApplicationPresentation(raw);
  const bundled = normalized[0];
  assert(bundled?.kind === "builtin");
  assert.equal(bundled.application, browserApplication);
  assert.deepEqual(
    normalized.map(presentationKey),
    raw.map((a) => `${a.id}@${a.version}`),
  );
  assert.deepEqual(normalizeApplicationPresentation(normalized), normalized);
});

test("author-controlled builtin declarations and copied/colliding headers never gain trusted bundled identity", () => {
  const entries = normalizeApplicationPresentation([
    browserApplication,
    { ...browserApplication },
    { ...browserApplication, id: "author.fake-browser" },
    { ...browserApplication, version: "99.0.0" },
  ]);
  assert.equal(entries[0]?.kind, "builtin");
  assert.deepEqual(
    entries.slice(1).map((entry) => entry.kind),
    ["ui-only", "ui-only", "ui-only"],
  );
});

test("exact cognitive declaration suppresses its real UI-package legacy launch, not independent versions or bundled apps", () => {
  const workspace = initialWorkspace(now);
  const legacy: Workspace["applications"][number] = {
    format: "morphz-app/v1",
    id: "author.notes",
    version: "1.0.0",
    title: "UI package header",
    description: "existing installed GUI header",
    icon: "code",
    permissions: ["input.compose"],
    harness: null,
    ui: { type: "sandbox" },
    installedBy: "local-owner",
  };
  workspace.applications = [legacy, { ...legacy, version: "2.0.0" }];
  const result = projectApplicationPresentation({
    workspace,
    principalId: "local-owner",
    workspaceId: "first-project",
    cognitiveCatalog: {
      versions: [
        version({ ui: { packageVersion: "1.0.0", sha256: "c".repeat(64) } }),
      ],
      connections: [connection()],
    },
  });
  assert.equal(
    result.entries.some(
      (entry) =>
        entry.kind !== "cognitive" &&
        entry.application.id === "author.notes" &&
        entry.application.version === "1.0.0",
    ),
    false,
  );
  assert.equal(
    result.entries.some(
      (entry) =>
        entry.kind === "ui-only" && entry.application.version === "2.0.0",
    ),
    true,
  );
  const actual = result.entries.find((entry) => entry.kind === "cognitive");
  assert(actual?.kind === "cognitive");
  assert.equal(actual.gui, "host-not-accepted");
  assert.equal(
    result.entries.filter((entry) => entry.kind === "builtin").length,
    3,
  );
});

test("presentation defensively honors explicit UI package references across metadata versions without a legacy fallback", () => {
  // Public metadata is typed separately from the strict v1 author definition
  // (which currently requires equal UI/app versions). This is a defensive
  // renderer DTO witness, not a claim that mismatched author definitions install.
  const workspace = initialWorkspace(now);
  const legacy: Workspace["applications"][number] = {
    format: "morphz-app/v1",
    id: "author.notes",
    version: "8.0.0",
    title: "shared GUI",
    description: "真实包头",
    icon: "code",
    permissions: ["input.compose"],
    harness: null,
    ui: { type: "sandbox" },
    installedBy: "local-owner",
  };
  workspace.applications = [legacy, { ...legacy, version: "9.0.0" }];
  const ui = { packageVersion: "8.0.0", sha256: "c".repeat(64) };
  const result = projectApplicationPresentation({
    workspace,
    principalId: "local-owner",
    workspaceId: "first-project",
    cognitiveCatalog: {
      versions: [
        version({ ui, grant: null }),
        version({
          version: "2.0.0",
          definitionHash: "b".repeat(64),
          ui,
          installationState: "disabled",
        }),
      ],
      connections: [],
    },
  });
  assert.equal(
    result.entries.some(
      (entry) =>
        entry.kind !== "cognitive" &&
        entry.application.id === legacy.id &&
        entry.application.version === legacy.version,
    ),
    false,
  );
  assert.equal(
    result.entries.filter((entry) => entry.kind === "cognitive").length,
    2,
  );
  assert.equal(
    result.entries.some(
      (entry) =>
        entry.kind === "ui-only" && entry.application.version === "9.0.0",
    ),
    true,
  );
});

test("registered cognitive GUI and headless definitions never escape through a legacy exact-version package when unavailable", () => {
  const workspace = initialWorkspace(now);
  workspace.applications = [
    {
      format: "morphz-app/v1",
      id: "author.notes",
      version: "1.0.0",
      title: "legacy exact-version UI",
      description: "旧包不能代替认知授权",
      icon: "code",
      permissions: ["input.compose"],
      harness: null,
      ui: { type: "sandbox" },
      installedBy: "local-owner",
    },
  ];
  for (const ui of [
    null,
    { packageVersion: "1.0.0", sha256: "c".repeat(64) },
  ]) {
    for (const unavailable of [
      { grant: null },
      { installationState: "disabled" as const },
    ]) {
      const result = projectApplicationPresentation({
        workspace,
        principalId: "local-owner",
        workspaceId: "first-project",
        cognitiveCatalog: {
          versions: [version({ ui, ...unavailable })],
          connections: [connection()],
        },
      });
      assert.equal(
        result.entries.some(
          (entry) =>
            entry.kind === "ui-only" && entry.application.id === "author.notes",
        ),
        false,
      );
      assert.equal(
        result.quickEntries.some((entry) => entry.kind === "cognitive"),
        false,
      );
      assert.equal(
        result.entries.filter((entry) => entry.kind === "cognitive").length,
        1,
      );
    }
  }
});

test("the same classification protects restored exact-version packages, not canonical builtins or unrelated versions", () => {
  const headless = version({ grant: null }),
    gui = version({
      version: "2.0.0",
      ui: { packageVersion: "2.0.0", sha256: "c".repeat(64) },
      installationState: "disabled",
    });
  const versions = [headless, gui];
  assert.equal(
    cognitiveApplicationForPackage(
      { id: "author.notes", version: "1.0.0" },
      versions,
    ),
    headless,
  );
  assert.equal(
    cognitiveApplicationForPackage(
      { id: "author.notes", version: "2.0.0" },
      versions,
    ),
    gui,
  );
  assert.equal(
    cognitiveApplicationForPackage(
      { id: "author.notes", version: "3.0.0" },
      versions,
    ),
    undefined,
  );
  for (const builtin of [
    browserApplication,
    readerApplication,
    scriptStudioApplication,
    objectsApplication,
  ]) {
    const collision = version({ appId: builtin.id, version: builtin.version });
    assert.equal(
      cognitiveApplicationForPackage(builtin, [collision]),
      undefined,
    );
    assert.equal(
      cognitiveApplicationForPackage({ ...builtin }, [collision]),
      collision,
    );
  }
});

test("presentation pins preserve defaults, explicit empty and hidden exact cognitive keys without upgrade", () => {
  const result = directory();
  const cog = result.quickEntries.find((entry) => entry.kind === "cognitive");
  assert(cog?.kind === "cognitive");
  const old = "author.notes@1.0.0",
    hidden = `cognitive:author.notes@9.0.0#${"b".repeat(64)}`;
  assert.deepEqual(
    pinnedPresentationApplications(result.quickEntries).map(presentationKey),
    ["morphz.script-studio@1.0.0", "morphz.browser@1.0.0"],
  );
  assert.deepEqual(pinnedPresentationApplications(result.quickEntries, []), []);
  const saved = [hidden, cog.key, old, "morphz.browser@1.0.0", cog.key];
  assert.deepEqual(
    pinnedPresentationApplications(result.quickEntries, saved).map(
      presentationKey,
    ),
    [cog.key, "morphz.browser@1.0.0"],
  );
  const revoked = directory([version({ grant: null })]);
  assert.deepEqual(
    pinnedPresentationApplications(revoked.quickEntries, saved).map(
      presentationKey,
    ),
    ["morphz.browser@1.0.0"],
  );
  assert.deepEqual(saved, [
    hidden,
    cog.key,
    old,
    "morphz.browser@1.0.0",
    cog.key,
  ]);
  assert.deepEqual(
    placeDockApplication(
      saved.slice(0, 4),
      result.quickEntries.map(presentationKey),
      "morphz.browser@1.0.0",
      0,
    ),
    [hidden, "morphz.browser@1.0.0", old, cog.key],
  );
  assert.deepEqual(
    pinnedPresentationApplications(result.quickEntries, saved).map(
      presentationKey,
    ),
    [cog.key, "morphz.browser@1.0.0"],
  );
});

test("wrong-version grant and unavailable project cannot manufacture an operational target", () => {
  const wrong = directory([
    version({
      grant: {
        appId: "author.notes",
        version: "2.0.0",
        state: "active",
        revision: 1,
        consentedAt: now,
        updatedAt: now,
      },
    }),
  ]);
  const entry = wrong.entries.find((e) => e.kind === "cognitive");
  assert(entry?.kind === "cognitive");
  assert.equal(entry.inputAvailability, "not-granted");
  assert.deepEqual(cognitiveApplicationTargets(entry), []);
  const workspace = initialWorkspace(now);
  const unavailable = projectApplicationPresentation({
    workspace,
    principalId: "local-owner",
    workspaceId: "not-visible",
    cognitiveCatalog: { versions: [version()], connections: [connection()] },
  });
  const missing = unavailable.entries.find((e) => e.kind === "cognitive");
  assert(missing?.kind === "cognitive");
  assert.equal(missing.inputAvailability, "project-unavailable");
  assert.deepEqual(cognitiveApplicationTargets(missing), []);
});
