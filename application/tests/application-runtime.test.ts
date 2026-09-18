import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { RuntimeBridge } from "../apps/service/src/runtime.js";
import { localAccess, type Operation } from "../packages/core/src/model.js";
import { applicationManifestSchema } from "../packages/core/src/applications.js";

test("同空间跨应用与对象共用 Session，各输入固定 Harness，并行调度；保存项目后路由不变", () => {
  const store = new WorkspaceStore(":memory:");
  const config = {
    namespace: randomUUID(),
    url: "http://127.0.0.1:12345",
    token: "test-only",
  };
  const bridge = new RuntimeBridge(store, config);
  const run = (operation: Operation) =>
    store.execute({ commandId: randomUUID(), operation }, localAccess).entityId;
  const input = (
    projectId: string,
    applicationInstanceId?: string,
    artifactId: string | null = null,
  ) => {
    const id = run({
      type: "record-input",
      projectId,
      applicationInstanceId,
      artifactId,
      artifactRevision: artifactId ? 1 : null,
      selection: "",
      body: "工作输入",
      targetActantId: "morphz-agent",
    });
    bridge.enqueue(id);
    return id;
  };
  try {
    const ids: string[] = [];
    for (const name of ["writing", "editing"]) {
      const manifest = applicationManifestSchema.parse({
        format: "morphz-work-app/v1",
        id: `test.${name}`,
        version: "1.0.0",
        title: name,
        description: "Fixture",
        icon: "document",
        permissions: ["input.compose"],
        harness: { id: name, version: "1.2.3" },
        ui: { type: "sandbox", html: "<p>Fixture</p>" },
      });
      run({ type: "install-application", manifest });
      const app = run({
        type: "launch-application",
        workspaceId: "local-worktable",
        applicationId: manifest.id,
        applicationVersion: manifest.version,
      });
      const artifactId = run({
        type: "create-artifact",
        projectId: "local-worktable",
        title: name,
        content: { kind: "document", markdown: name },
      });
      ids.push(input("local-worktable", app, artifactId));
    }
    input("first-project");
    input("local-inbox");
    type Ledger = {
      sessions: Record<
        string,
        {
          id: string;
          projectId: string;
          artifactId: string | null;
          scope: string;
        }
      >;
      deliveries: {
        inputId: string;
        sessionId: string;
        request: {
          activation: {
            harness?: { id: string; version: string };
            dispatch_mode: string;
          };
        };
      }[];
    };
    const before = store.runtimeState() as Ledger;
    assert.equal(Object.keys(before.sessions).length, 3);
    assert.equal(
      before.deliveries[0]!.sessionId,
      before.deliveries[1]!.sessionId,
    );
    assert.notEqual(
      before.deliveries[0]!.sessionId,
      before.deliveries[2]!.sessionId,
    );
    assert.notEqual(
      before.deliveries[2]!.sessionId,
      before.deliveries[3]!.sessionId,
    );
    assert.deepEqual(
      before.deliveries.slice(0, 2).map((d) => d.request.activation.harness),
      [
        { id: "writing", version: "1.2.3" },
        { id: "editing", version: "1.2.3" },
      ],
    );
    assert.ok(
      before.deliveries.every(
        (d) => d.request.activation.dispatch_mode === "parallel",
      ),
    );
    run({
      type: "save-workspace-as-project",
      workspaceId: "local-worktable",
      title: "保存后的工作",
    });
    const restarted = new RuntimeBridge(store, config);
    const third = run({
      type: "record-input",
      projectId: "local-worktable",
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "继续原来的工作",
      targetActantId: "morphz-agent",
    });
    restarted.enqueue(third);
    const after = store.runtimeState() as Ledger;
    assert.equal(
      after.deliveries.at(-1)!.sessionId,
      before.deliveries[0]!.sessionId,
    );
    assert.deepEqual(after.deliveries.slice(0, 4), before.deliveries);
  } finally {
    store.close();
  }
});
