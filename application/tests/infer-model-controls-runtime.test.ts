import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { scriptStudioApplication } from "../packages/core/src/applications.js";
import {
  fixtureAnnotationsMessage,
  profileActualTransportFixture,
} from "./profile-actual-transport-fixture.js";

/** Real input admission, installed HNS, durable infer hand-off and outbound
 * provider HTTP. Controlled model replies do not replace the routing logic. */
test(
  "actual Harness infer inherits task model controls through every physical request, without changing defaults or tools",
  {
    skip: process.env.MORPHZ_RESPONSE_ANNOTATIONS_RUNTIME_E2E !== "1",
    timeout: 120_000,
  },
  async () => {
    const f = await profileActualTransportFixture({
      evalCallableTools: ["host_morphz"],
      harnessPackages: [
        {
          filename: "script-studio.hns",
          source: readFileSync("harnesses/script-studio.hns", "utf8"),
        },
      ],
    });
    try {
      const projectId = "infer_controls_" + randomUUID().replaceAll("-", "");
      await f.client.call(
        "projects.create",
        { commandId: randomUUID(), projectId, title: "TEST infer 控制继承" },
        f.options,
      );
      const app = (await f.client.call(
        "app-views.launch",
        {
          commandId: randomUUID(),
          projectId,
          appId: scriptStudioApplication.id,
          packageVersion: scriptStudioApplication.version,
          state: {},
        },
        f.options,
      )) as { id: string };
      let definitions: unknown;
      for (const effort of ["max", "none", "low", undefined] as const) {
        const marker = "TEST_INFER_CONTROLS_" + randomUUID();
        const conversationId =
          "conversation_" + randomUUID().replaceAll("-", "");
        const start = f.requests.length;
        f.hold(marker);
        await f.client.call(
          "platform.message",
          {
            commandId: randomUUID(),
            operation: {
              type: "record-input",
              projectId,
              conversationId,
              artifactId: null,
              artifactRevision: null,
              selection: "",
              body: marker + " 只讨论一个创意，不创作、不保存。",
              targetActantId: "morphz-agent",
              newConversation: { title: marker },
              model: "profile-actual",
              ...(effort ? { reasoningEffort: effort } : {}),
              applicationInstanceId: app.id,
              application: {
                id: scriptStudioApplication.id,
                version: scriptStudioApplication.version,
              },
            },
          },
          f.options,
        );
        const first = await f.waitRequest(marker, start);
        assert.equal(first.model, "profile-actual");
        assert.equal(
          first.reasoning_effort,
          effort ?? "low",
          "Unspecified infer must inherit the parent task, not the low Runtime default",
        );
        definitions ??= first.tools;
        assert.deepEqual(first.tools, definitions);
        const child = f.sql<{
          id: string;
          parent_thread_id: string;
          model_alias: string;
          reasoning_effort: string | null;
        }>(
          "SELECT id,parent_thread_id,model_alias,reasoning_effort FROM threads WHERE executor_kind='plan_infer' ORDER BY rowid DESC LIMIT 1",
        )[0]!;
        assert.ok(child.parent_thread_id);
        const parent = f.sql<{
          id: string;
          status: string;
          model_alias: string;
          reasoning_effort: string | null;
        }>(
          "SELECT id,status,model_alias,reasoning_effort FROM threads WHERE id=?",
          child.parent_thread_id,
        )[0]!;
        assert.equal(child.model_alias, "profile-actual");
        assert.equal(child.model_alias, parent.model_alias);
        assert.equal(child.reasoning_effort, parent.reasoning_effort);
        if (effort !== undefined) assert.equal(parent.reasoning_effort, effort);
        f.hold(marker);
        f.releaseWithMessages(marker, [
          { name: "host_morphz", arguments: { action: "list", limit: 20 } },
          fixtureAnnotationsMessage({
            execution: { title: "TEST 讨论创意", progress: "核对项目目录" },
            calls: [{ index: 0, intent: "核对本项目目录" }],
          }),
        ]);
        const second = await f.waitRequest(marker, start + 1);
        assert.equal(second.model, "profile-actual");
        assert.equal(second.reasoning_effort, effort ?? "low");
        assert.deepEqual(second.tools, definitions);
        f.releaseWithMessages(
          marker,
          [
            fixtureAnnotationsMessage({
              execution: { title: "TEST 讨论创意", result: "仅讨论，未保存" },
            }),
          ],
          JSON.stringify({
            execute: false,
            reply: "TEST 创意讨论完成。",
            task: "",
          }),
        );
        for (let i = 0; i < 300; i++) {
          if (
            f.sql<{ status: string }>(
              "SELECT status FROM threads WHERE id=?",
              parent.id,
            )[0]?.status === "completed"
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        assert.equal(
          f.sql<{ status: string }>(
            "SELECT status FROM threads WHERE id=?",
            parent.id,
          )[0]?.status,
          "completed",
        );
        assert.equal(
          f.requests.length - start,
          2,
          "No relay or metadata-only model call",
        );
        assert.deepEqual(
          f
            .sql<{ reasoning_effort: string | null }>(
              "SELECT reasoning_effort FROM sessions WHERE id=(SELECT session_id FROM threads WHERE id=?)",
              parent.id,
            )
            .map((row) => row.reasoning_effort),
          [null],
          "A task override must not mutate its Session default",
        );
        const states = f.sql<{ payload: string }>(
          "SELECT payload FROM events WHERE topic='runtime/model_attempt_state' AND json_extract(payload,'$.thread_id')=? AND json_extract(payload,'$.state')='streaming'",
          child.id,
        );
        assert.equal(states.length, 2);
        for (const state of states)
          assert.equal(
            JSON.parse(state.payload).effective_reasoning_effort,
            effort ?? "low",
          );
      }
    } finally {
      await f.close();
    }
  },
);
