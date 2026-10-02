import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { workspaceFor } from "../apps/service/src/identity.js";
import { contentSchema } from "../packages/core/src/model.js";
import type { WorkspaceClient } from "../apps/web/src/client.js";
import { viewModelFixture } from "./view-model-fixture.js";

// This is an HTML/authorization assertion, not a browser/CSS renderer. Keep
// the production component's stylesheet imports: read actual CSS (so missing
// assets still fail), but do not ask Node to execute it as JavaScript. Limit
// the hook to this import and deregister before executing the test.
const styles = registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && new URL(url).pathname.endsWith(".css")) {
      readFileSync(new URL(url), "utf8");
      return { format: "module", source: "export {};", shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { ObjectCollection } = await (async () => {
  try {
    return await import("../apps/web/src/ObjectCollection.js");
  } finally {
    styles.deregister();
  }
})();

test("分页目录首帧不从旧快照或本地目录补出对象", () => {
  const fixture = viewModelFixture();
  const privateSpace = fixture.seedProject({
    title: "不可见的私有空间",
    members: ["local-owner", "morphz-service"],
  }).id;
  fixture.seedArtifact({
    projectId: privateSpace,
    title: "不可见的私有文档",
    content: { kind: "document", markdown: "私有正文不会进入资料列表" },
  });
  fixture.seedArtifact({
    projectId: "first-project",
    title: "共享文档",
    content: { kind: "document", markdown: "可以阅读的共享正文" },
  });
  fixture.seedArtifact({
    projectId: "first-project",
    title: "不进入内容目录的事项",
    content: contentSchema.parse({
      kind: "task",
      description: "只在事项视图中显示",
      assigneeId: "local-human",
      model: null,
      priority: "normal",
      dueDate: null,
      assignment: "accepted",
      execution: "planned",
      delivery: "none",
      resultIds: [],
    }),
  });
  const access = {
    principalId: "library-reader",
    actantId: "library-reader-human",
  };
  // Renderer authorization/projection fixture only; no persistence claim.
  fixture.state.principals.push({ id: access.principalId, name: "资料读者" });
  fixture.state.actants.push({
    id: access.actantId,
    principalId: access.principalId,
    kind: "human",
    name: "资料读者",
  });
  fixture.state.projects
    .find((project) => project.id === "first-project")!
    .members.push(access.principalId);
  const authorized = workspaceFor(fixture.state, access);
  const shared = authorized.artifacts.find(
    (artifact) => artifact.title === "共享文档",
  )!;
  const html = renderToStaticMarkup(
    createElement(ObjectCollection, {
      project: authorized.projects.find((p) => p.id === "first-project")!,
      projects: authorized.projects,
      objects: authorized.artifacts,
      state: authorized,
      client: {
        online: true,
        boot: { workspace: authorized },
        contentCatalog: [
          {
            id: shared.id,
            appId: "morphz.objects",
            instanceId: "objects-test",
            appObjectId: shared.id,
            projectId: shared.projectId,
            kind: "document",
            title: shared.title,
            observedVersionRef: String(shared.revision),
            availability: "available",
            revision: 1,
            createdAt: shared.createdAt,
            updatedAt: shared.updatedAt,
          },
        ],
      } as WorkspaceClient,
      onOpen() {},
      onCompose() {},
      onCreate() {},
      onWrite() {},
      catalog: true,
    }),
  );
  assert.match(html, /全部内容/);
  assert.match(html, /正在查找/);
  assert.doesNotMatch(html, /共享文档/);
  assert.doesNotMatch(html, /可以阅读的共享正文/);
  assert.doesNotMatch(html, /不进入内容目录的事项|只在事项视图中显示|新建事项/);
  assert.doesNotMatch(
    html,
    /不可见的私有空间|不可见的私有文档|私有正文不会进入资料列表/,
  );
});
