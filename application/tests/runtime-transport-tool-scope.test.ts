import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { DomainError } from "../packages/core/src/model.js";

test("正式 Host 对旧 Session 工具回调在读取旧工作区之前拒绝", async () => {
  const namespace = randomUUID();
  const endpoint = "http://127.0.0.1:1";
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  try {
    store.saveRuntimeState({
      namespace,
      endpoint,
      connected: false,
      model: "",
      error: "",
      sessions: {
        "legacy-session": {
          id: "legacy-session",
          projectId: "legacy-project",
          artifactId: null,
          cursor: 0,
          events: [],
          runtimePrincipalId: "morphz-service",
          scope: "workspace",
        },
        "platform-session": {
          id: "platform-session",
          projectId: "current-project",
          conversationId: "current-project",
          artifactId: null,
          cursor: 0,
          events: [],
          runtimePrincipalId: "morphz-service",
          scope: "workspace",
          platform: true,
        },
      },
      deliveries: [],
    });
    const bridge = new RuntimeBridge(
      store,
      { url: endpoint, token: "test-token", namespace },
      undefined,
      false,
    );
    await assert.rejects(
      async () =>
        bridge.toolScope({
          context_id: `mw-context-${namespace}`,
          session_id: "legacy-session",
          principal_id: "morphz-service",
          agent_id: "morphz-agent",
          thread_id: "legacy-thread",
          target_id: "legacy-target",
          job_id: "legacy-job",
          tool_call_id: "legacy-call",
        }),
      (error: unknown) =>
        error instanceof DomainError &&
        error.code === "forbidden" &&
        /未绑定到已授权/.test(error.message),
    );
    bridge.bindPlatformAgentScope(async () => ({
      platform: true,
      projectId: "current-project",
      conversationId: "current-project",
      inputId: "current-input",
      access: { principalId: "human", actantId: "human-actant" },
    }));
    assert.deepEqual(
      await bridge.toolScope({
        context_id: `mw-context-${namespace}`,
        session_id: "platform-session",
        principal_id: "morphz-service",
        agent_id: "morphz-agent",
        thread_id: "current-thread",
        target_id: "current-target",
        job_id: "current-job",
        tool_call_id: "current-call",
      }),
      {
        platform: true,
        projectId: "current-project",
        conversationId: "current-project",
        inputId: "current-input",
        access: { principalId: "human", actantId: "human-actant" },
      },
    );
  } finally {
    store.close();
  }
});
