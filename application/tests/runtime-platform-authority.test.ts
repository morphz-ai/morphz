import test from "node:test";
import assert from "node:assert/strict";
import type { HostInvocation } from "../packages/application/src/agent-tools.js";
import {
  createScriptProduction,
  platformScriptStudioAuthority,
} from "../packages/application/src/script-production-service.js";
import { RuntimePlatformAuthority } from "../packages/application/src/runtime-platform-authority.js";
import type { RuntimeInputEvidenceReader } from "../packages/application/src/runtime-input-evidence.js";
import {
  PlatformStore,
  type PlatformActor,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import { ScriptStudioStore } from "../packages/script-studio/src/store.js";

const route: HostInvocation = {
  job_id: "job-one",
  tool_call_id: "call-one",
  session_id: "session-one",
  context_id: "context-one",
  principal_id: "runtime-alice",
  agent_id: "runtime-agent",
  thread_id: "thread-one",
  target_id: "target-one",
};

function evidence(
  claimedHumanActantId = "alice-human",
): RuntimeInputEvidenceReader {
  return {
    async readThread() {
      return {
        snapshot: {
          thread: {
            id: "thread-one",
            session_id: "session-one",
            context_id: "context-one",
            root_turn_id: "event-one",
            initiating_principal_id: "runtime-alice",
            agent_id: "runtime-agent",
            executor_kind: "agent",
            executor_id: null,
          },
        },
      };
    },
    async readSessionEvent() {
      return {
        id: "event-one",
        actor: "Session-Client",
        type: "session_message",
        topic: "chat/user_message",
        payload: {
          session_id: "session-one",
          context_id: "context-one",
          principal_id: "runtime-alice",
          client_message_id: "input-one",
          session_io: {
            request: {
              io_version: "1",
              client_message_id: "input-one",
              message: {
                format: { id: "morphz.application.input", version: "1" },
                content: {
                  encoding: "json",
                  value: {
                    type: "object",
                    value: {
                      input_id: { type: "string", value: "input-one" },
                      workspace_id: { type: "string", value: "project-one" },
                      author_actant_id: {
                        type: "string",
                        value: claimedHumanActantId,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      };
    },
  };
}

test("Runtime 持久输入经当前身份映射后创建剧本，不能借其他项目或旧凭据扩大权限", async () => {
  let active = true;
  let studio!: ScriptStudioStore;
  const authority = new RuntimePlatformAuthority(
    evidence(),
    async (runtimePrincipalId, runtimeAgentId) =>
      active &&
      runtimePrincipalId === "runtime-alice" &&
      runtimeAgentId === "runtime-agent"
        ? {
            tenantId: "tenant-one",
            principalId: "alice",
            humanActantId: "alice-human",
            agentActantId: "agent-one",
          }
        : null,
  );
  const remaining: Omit<PlatformAuthorityVerifier, "resolveActor"> = {
    async resolveActant({ actantId }) {
      return actantId === "agent-one"
        ? { principalId: "morphz-service", kind: "agent" }
        : null;
    },
    async resolveProjectAgent() {
      return { principalId: "morphz-service", actantId: "agent-one" };
    },
    async verifyApplicationObject(request) {
      return studio.verifyCommittedProduction({
        tenantId: request.tenantId,
        principalId: request.principalId,
        actantId: request.actantId,
        runtimeInputId: request.runtimeInputId,
        productionId: request.objectId,
        projectId: request.projectId,
        title: request.title,
        versionRef: request.versionRef,
        receiptId: request.receiptId,
      });
    },
  };
  const agentVerifier = authority.verifier(remaining);
  const platform = await PlatformStore.sqlite(":memory:", {
    ...agentVerifier,
    async resolveActor(actor) {
      if (actor.credential === "human-setup")
        return {
          tenantId: "tenant-one",
          principalId: "alice",
          actantId: "alice-human",
          kind: "human",
          runtimeInputId: null,
        };
      return agentVerifier.resolveActor(actor);
    },
  });
  try {
    studio = await ScriptStudioStore.sqlite(
      ":memory:",
      platformScriptStudioAuthority(platform, "studio-one", () => ({
        routeKind: "service",
        routeRef: "test:studio-one",
      })),
    );
    try {
      await platform.provisionTenant("tenant-one");
      for (const projectId of ["project-one", "project-two"])
        await platform.createProject(
          { credential: "human-setup" },
          {
            commandId: `create-${projectId}`,
            projectId,
            title: projectId,
          },
        );
      await platform.registerApplication("tenant-one", {
        appId: "morphz.script-studio",
        installationId: "install-one",
        instanceId: "studio-one",
        routeKind: "service",
        routeRef: "test:studio-one",
      });
      let escaped: PlatformActor | undefined;
      const created = await authority.withInvocation(
        route,
        async (actor, scope) => {
          escaped = actor;
          assert.deepEqual(scope, {
            kind: "input",
            projectId: "project-one",
            inputId: "input-one",
          });
          await assert.rejects(
            createScriptProduction({
              platform,
              studio,
              actor,
              instanceId: "studio-one",
              commandId: "cross-project-command",
              productionId: "cross-project-production",
              projectId: "project-two",
              title: "越界",
            }),
            /超出原始输入/,
          );
          return createScriptProduction({
            platform,
            studio,
            actor,
            instanceId: "studio-one",
            commandId: "valid-command",
            productionId: "valid-production",
            projectId: scope.projectId,
            title: "受权剧本",
          });
        },
      );
      assert.equal(created.original.productionId, "valid-production");
      assert.equal(
        (
          await platform.content(
            { credential: "human-setup" },
            created.contentId,
          )
        ).project_id,
        "project-one",
      );
      assert.equal(
        await studio.verifyCommittedProduction({
          tenantId: "tenant-one",
          principalId: "alice",
          actantId: "agent-one",
          runtimeInputId: "input-one",
          productionId: "valid-production",
          projectId: "project-one",
          title: "受权剧本",
          versionRef: "1",
          receiptId: "valid-command",
        }),
        true,
      );
      await assert.rejects(
        platform.authorizeApplicationProject(
          escaped!,
          "studio-one",
          "morphz.script-studio",
          "project-one",
        ),
        /身份已失效/,
      );
      await authority.withInvocation(route, async (actor) => {
        active = false;
        await assert.rejects(
          platform.authorizeApplicationProject(
            actor,
            "studio-one",
            "morphz.script-studio",
            "project-one",
          ),
          /身份已失效/,
        );
      });
      await assert.rejects(
        authority.withInvocation(route, async (actor) =>
          platform.authorizeApplicationProject(
            actor,
            "studio-one",
            "morphz.script-studio",
            "project-one",
          ),
        ),
        /身份已失效/,
      );
    } finally {
      await studio.close();
    }
  } finally {
    await platform.close();
  }
});

test("输入声称的 Human Actant 与 Runtime 身份映射不同，不能签发 Platform 凭据", async () => {
  const authority = new RuntimePlatformAuthority(
    evidence("other-human"),
    async () => ({
      tenantId: "tenant-one",
      principalId: "alice",
      humanActantId: "alice-human",
      agentActantId: "agent-one",
    }),
  );
  await assert.rejects(
    authority.withInvocation(route, async () => "unexpected"),
    /Human 身份已失效或与 Runtime 身份不符/,
  );
});

test("后台事项在未确认回执时仍用已提交准入证明身份，撤权后立即失效", async () => {
  let active = true;
  let platform!: PlatformStore;
  const key = "b".repeat(40);
  const scheduledThread = {
    id: "scheduled-thread",
    session_id: "session-one",
    context_id: "context-one",
    root_turn_id: `client-schedule-task_${key}`,
    initiating_principal_id: "runtime-alice",
    agent_id: "runtime-agent",
    executor_kind: "self",
    executor_id: null,
  };
  let admittedScheduleId: string | undefined;
  const reader: RuntimeInputEvidenceReader = {
    async readThread() {
      return { snapshot: { thread: scheduledThread } };
    },
    async readSessionEvent() {
      throw new Error("后台任务不能借用普通聊天输入");
    },
    async readSessionSchedule() {
      return {
        id: admittedScheduleId,
        thread_id: scheduledThread.id,
        source_turn_id: scheduledThread.root_turn_id,
      };
    },
  };
  const authority = new RuntimePlatformAuthority(reader, async () => null, {
    taskRuns: {
      admissionForRuntime: (sessionId, scheduleId) =>
        platform.taskRunAdmissionForRuntime(
          "tenant-one",
          sessionId,
          scheduleId,
        ),
      async identityForTaskRun(runtimePrincipalId, runtimeAgentId) {
        return active &&
          runtimePrincipalId === "runtime-alice" &&
          runtimeAgentId === "runtime-agent"
          ? {
              tenantId: "tenant-one",
              principalId: "alice",
              humanActantId: "alice-human",
              agentActantId: "agent-one",
            }
          : null;
      },
    },
  });
  const agentVerifier = authority.verifier({
    async resolveActant({ actantId }) {
      if (actantId === "alice-human")
        return { principalId: "alice", kind: "human" };
      if (actantId === "agent-one")
        return { principalId: "morphz-service", kind: "agent" };
      return null;
    },
    async resolveProjectAgent() {
      return { principalId: "morphz-service", actantId: "agent-one" };
    },
    async verifyApplicationObject() {
      return false;
    },
  });
  platform = await PlatformStore.sqlite(":memory:", {
    ...agentVerifier,
    async resolveActor(actor) {
      if (actor.credential === "human-setup")
        return {
          tenantId: "tenant-one",
          principalId: "alice",
          actantId: "alice-human",
          kind: "human",
          runtimeInputId: null,
        };
      return agentVerifier.resolveActor(actor);
    },
  });
  try {
    const human = { credential: "human-setup" };
    await platform.provisionTenant("tenant-one");
    await platform.createProject(human, {
      commandId: "create-scheduled-project",
      projectId: "project-one",
      title: "计划项目",
    });
    await platform.createTask(human, {
      commandId: "create-scheduled-task",
      taskId: "task-one",
      projectId: "project-one",
      title: "计划事项",
      assigneeId: "agent-one",
    });
    const admission = await platform.requestTaskRun(human, {
      commandId: "start-scheduled-task",
      taskId: "task-one",
      expectedRevision: 1,
      sessionId: "session-one",
      intent: "执行这项工作",
      notBefore: "2026-09-26T00:00:00.000Z",
    });
    admittedScheduleId = admission.request.id;
    scheduledThread.root_turn_id = `client-schedule-${admission.request.id}`;
    let escaped: PlatformActor | undefined;
    await authority.withInvocation(
      { ...route, thread_id: scheduledThread.id },
      async (actor, scope) => {
        escaped = actor;
        assert.deepEqual(scope, {
          kind: "task-run",
          projectId: "project-one",
          inputId: null,
        });
        const tasks = await platform.listTasks(actor, "project-one");
        assert.equal(tasks.length, 1);
        active = false;
        await assert.rejects(
          platform.listTasks(actor, "project-one"),
          /身份已失效/,
        );
      },
    );
    await assert.rejects(
      platform.listTasks(escaped!, "project-one"),
      /身份已失效/,
    );
    active = true;
    await assert.rejects(
      authority.withInvocation(
        {
          ...route,
          principal_id: "other-human",
          thread_id: scheduledThread.id,
        },
        async () => null,
      ),
      /未绑定/,
    );
  } finally {
    await platform.close();
  }
});
