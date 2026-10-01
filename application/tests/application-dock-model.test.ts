import test from "node:test";
import assert from "node:assert/strict";
import {
  applicationKey,
  authorizedApplications,
  pinnedApplications,
} from "../apps/web/src/application-dock-model.js";
import {
  browserApplication,
  readerApplication,
  scriptStudioApplication,
  applicationInstanceSchema,
  type ApplicationCatalogEntry,
} from "../packages/core/src/applications.js";
import {
  initialWorkspace,
  stateSchema,
  type Workspace,
} from "../packages/core/src/model.js";

const stamp = "2026-10-01T12:00:00.000Z";
function installed(
  id: string,
  principalId = "local-owner",
  version = "1.0.0",
): Workspace["applications"][number] {
  return stateSchema.shape.applications.unwrap().element.parse({
    format: "morphz-app/v1",
    id,
    version,
    title: id,
    description: "真实安装目录头部",
    icon: "document",
    permissions: ["input.compose"],
    harness: null,
    ui: { type: "sandbox" },
    installedBy: principalId,
  });
}
function instance(
  app: ApplicationCatalogEntry,
  workspaceId = "first-project",
  status: "open" | "closed" = "open",
) {
  return applicationInstanceSchema.parse({
    id: `${app.id}-${workspaceId}-${status}`,
    workspaceId,
    applicationId: app.id,
    applicationVersion: app.version,
    revision: 1,
    state: {},
    status,
    createdAt: stamp,
    updatedAt: stamp,
  });
}

test("Dock目录保留真实内置应用，安装包只匹配当前身份", () => {
  const state = initialWorkspace(stamp);
  state.applications = [
    installed("test.mine"),
    installed("test.other", "other-human"),
  ];
  const apps = authorizedApplications(
    stateSchema.parse(state),
    "local-owner",
    "first-project",
  );
  assert.deepEqual(
    apps.map(applicationKey),
    [
      browserApplication,
      readerApplication,
      scriptStudioApplication,
      installed("test.mine"),
    ].map(applicationKey),
  );
  const another = authorizedApplications(state, "other-human", "first-project");
  assert.equal(
    another.some((app) => app.id === "test.mine"),
    false,
  );
  assert.equal(
    another.some((app) => app.id === "test.other"),
    true,
  );
});

test("他人安装包仅由当前workspace开放实例授权，不能借另一项目或closed实例", () => {
  const state = initialWorkspace(stamp);
  const shared = installed("test.shared", "other-human");
  const foreign = installed("test.foreign", "other-human");
  const closed = installed("test.closed", "other-human");
  state.applications = [shared, foreign, closed];
  state.applicationInstances = [
    instance(shared),
    instance(foreign, "another-project"),
    instance(closed, "first-project", "closed"),
  ];
  const apps = authorizedApplications(
    stateSchema.parse(state),
    "local-owner",
    "first-project",
  );
  assert.equal(
    apps.some((app) => app.id === shared.id),
    true,
  );
  assert.equal(
    apps.some((app) => app.id === foreign.id),
    false,
  );
  assert.equal(
    apps.some((app) => app.id === closed.id),
    false,
  );
  const another = authorizedApplications(
    state,
    "local-owner",
    "another-project",
  );
  assert.equal(
    another.some((app) => app.id === shared.id),
    false,
  );
  assert.equal(
    another.some((app) => app.id === foreign.id),
    true,
  );
});

test("实例授权匹配确切应用版本，不把旧版本或同名安装猜成新版本", () => {
  const state = initialWorkspace(stamp);
  const older = installed("test.versioned", "other-human", "1.0.0");
  const newer = installed("test.versioned", "other-human", "2.0.0");
  state.applications = [older, newer];
  state.applicationInstances = [instance(older)];
  const apps = authorizedApplications(
    stateSchema.parse(state),
    "local-owner",
    "first-project",
  );
  assert.equal(
    apps.some((app) => applicationKey(app) === applicationKey(older)),
    true,
  );
  assert.equal(
    apps.some((app) => applicationKey(app) === applicationKey(newer)),
    false,
  );
  assert.equal(pinnedApplications(apps, [applicationKey(newer)]).length, 0);
});

test("内置目录不会被重复安装记录替代；默认pin与显式空列表有区别", () => {
  const state = initialWorkspace(stamp);
  state.applications = [{ ...browserApplication, installedBy: "local-owner" }];
  const apps = authorizedApplications(
    stateSchema.parse(state),
    "local-owner",
    "first-project",
  );
  assert.equal(
    apps.filter(
      (app) => applicationKey(app) === applicationKey(browserApplication),
    ).length,
    1,
  );
  assert.deepEqual(
    pinnedApplications(apps).map(applicationKey),
    [scriptStudioApplication, browserApplication].map(applicationKey),
  );
  assert.deepEqual(pinnedApplications(apps, []), []);
});

test("固定入口按用户顺序去重，未知/未授权/失效版本不降级为别的应用", () => {
  const apps = [browserApplication, readerApplication, scriptStudioApplication];
  const reader = applicationKey(readerApplication),
    browser = applicationKey(browserApplication);
  const pinned = pinnedApplications(apps, [
    reader,
    reader,
    "test.missing@1.0.0",
    browser,
    "morphz.browser@9.9.9",
  ]);
  assert.deepEqual(pinned.map(applicationKey), [reader, browser]);
  assert.deepEqual(pinnedApplications([], [browser]), []);
  assert.deepEqual(pinnedApplications(apps, ["morphz.browser"]), []);
});
