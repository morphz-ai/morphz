import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RemoteApplicationConnection } from "../apps/desktop/remote-host.js";
import { objectToolName } from "../packages/core/src/application-names.js";
import { executionSnapshotSchema } from "../packages/core/src/execution.js";
import { localAccess } from "../packages/core/src/model.js";
import type { WorkspaceChange } from "../packages/core/src/workspace-changes.js";
import { profileActualTransportFixture } from "./profile-actual-transport-fixture.js";

test(
  "actual Rust Job commit wakes authorized Host SSE without the Host reconciliation ticker",
  {
    skip: process.env.MORPHZ_WORKSPACE_RUNTIME_E2E !== "1",
    timeout: 120_000,
  },
  async () => {
    const f = await profileActualTransportFixture();
    const remote = new RemoteApplicationConnection(f.origin, fetch);
    const frames: WorkspaceChange[] = [];
    const observerId = randomUUID();
    const projectId = "event_" + randomUUID().replaceAll("-", "");
    const conversationId = "conversation_" + randomUUID().replaceAll("-", "");
    const inputId = randomUUID();
    const marker = "TEST_EVENT_DRIVEN_JOB_" + randomUUID();
    const until = async (check: () => boolean, timeout = 10_000) => {
      const end = Date.now() + timeout;
      while (!check()) {
        assert.ok(
          Date.now() < end,
          "Expected actual Runtime committed event → Host SSE wake",
        );
        await new Promise((done) => setTimeout(done, 10));
      }
    };
    try {
      await f.client.call(
        "projects.create",
        {
          commandId: randomUUID(),
          projectId,
          title: "TEST event-driven Runtime acceptance",
        },
        f.options,
      );
      f.hold(marker);
      await f.client.call(
        "platform.message",
        {
          commandId: inputId,
          operation: {
            type: "record-input",
            projectId,
            conversationId,
            artifactId: null,
            artifactRevision: null,
            selection: "",
            body: marker,
            targetActantId: "morphz-agent",
            newConversation: { title: marker },
          },
        },
        f.options,
      );
      await f.waitRequest(marker);
      const boot = (await remote.call("platform.bootstrap")) as {
        csrfToken: string;
      };
      await remote.observe(
        observerId,
        { kind: "workspace" },
        boot.csrfToken,
        (frame) => {
          assert.ok("kind" in frame);
          assert.equal(frame.kind, "workspace");
          frames.push(frame as WorkspaceChange);
        },
        () => {},
      );
      await until(() => frames.length >= 1);
      // Deliberate white-box isolation: the Runtime process and provider remain
      // live, but the Host's old 1.2 s reconciliation loop cannot supply a wake.
      const bridge = f.runtime as unknown as {
        timer?: ReturnType<typeof setInterval>;
        busyCompletion?: Promise<void>;
      };
      clearInterval(bridge.timer);
      bridge.timer = undefined;
      await bridge.busyCompletion;
      await new Promise((done) => setTimeout(done, 500));
      const baseline = frames.length;
      const version = f.runtime.platformExecutionChangeVersion(localAccess, [
        projectId,
      ]);
      const nextRound = f.requests.length;
      f.hold(marker);
      f.releaseWithTool(marker, objectToolName, {
        action: "profile",
        profile: { action: "read" },
        _annotations: {
          execution: { title: "验证事件更新", progress: "正在读取资料" },
          intent: "只读资料",
        },
      });
      await f.waitRequest(marker, nextRound);
      await until(() => frames.length > baseline);
      assert.notEqual(
        f.runtime.platformExecutionChangeVersion(localAccess, [projectId]),
        version,
      );
      const jobs = f.sql<{
        id: string;
        thread_id: string;
        session_id: string;
        status: string;
        result_event_id: string;
      }>(
        "SELECT id,thread_id,session_id,status,result_event_id FROM execution_jobs",
      );
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]!.status, "succeeded");
      assert.ok(jobs[0]!.result_event_id);
      const detail = executionSnapshotSchema.parse(
        await f.client.call(
          "execution.snapshot",
          {
            projectId,
            conversationId,
            artifactId: null,
            inputId,
            threadId: jobs[0]!.thread_id,
          },
          f.options,
        ),
      );
      assert.equal(detail.jobs[0]?.status, "succeeded");
      const finishFrames = frames.length;
      f.releaseWithTool(marker, "reply", {
        content: "TEST：只读资料完成，没有修改资料。",
        annotations: {
          execution: { title: "验证事件更新", result: "只读资料完成" },
        },
      });
      await until(() => frames.length > finishFrames);
      await until(
        () =>
          f.sql<{ lifecycle: string }>(
            "SELECT status AS lifecycle FROM threads WHERE id=?",
            jobs[0]!.thread_id,
          )[0]?.lifecycle === "completed",
      );
      assert.equal(
        f.requests.length,
        2,
        "No extra model call for notification or summary",
      );
      assert.equal(f.realCalls, 0);
      for (const frame of frames)
        assert.deepEqual(Object.keys(frame).sort(), [
          "accessChanged",
          "kind",
          "reason",
          "sequence",
        ]);
      assert.deepEqual(
        frames.map((frame) => frame.sequence),
        frames.map((_, i) => i + 1),
      );
      assert.equal((await f.read()).agent.revision, 0);
    } finally {
      remote.unobserve(observerId);
      await f.close();
    }
  },
);
