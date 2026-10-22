import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { scriptStudioApplication } from "../packages/core/src/applications.js";
import { sessionEvaluationSnapshotSchema } from "../packages/core/src/session-evaluation.js";
import {
  modelSettingsResultSchema,
  modelSettingsSchema,
} from "../packages/core/src/model-settings.js";
import { profileActualTransportFixture } from "./profile-actual-transport-fixture.js";

test(
  "actual local Host account deletion uses Runtime cleanup without model calls or Session changes and remains forbidden over HTTP",
  {
    skip: process.env.MORPHZ_RESPONSE_ANNOTATIONS_RUNTIME_E2E !== "1",
    timeout: 120_000,
  },
  async () => {
    const f = await profileActualTransportFixture({
      localModelManagement: true,
    });
    try {
      const embedded = await f.embeddedClient();
      const before = modelSettingsSchema.parse(
        await embedded.client.call(
          "model-settings.read",
          undefined,
          embedded.options,
        ),
      );
      const sessions = f.sql(
        "SELECT id,model_alias,reasoning_effort FROM sessions ORDER BY id",
      );
      const created = modelSettingsResultSchema.parse(
        await embedded.client.call(
          "model-settings.update",
          {
            action: "connect-api",
            requestId: randomUUID(),
            label: "TEST 可删除的隔离账号",
            protocol: "openai-chat",
            baseUrl: "http://127.0.0.1:1",
            apiKey: "synthetic-test-only",
            model: "synthetic-uncontacted-model",
          },
          embedded.options,
        ),
      );
      assert.equal(created.kind, "saved");
      assert.ok(created.kind === "saved" && created.accountId);
      await assert.rejects(
        () => f.client.call("model-settings.read", undefined, f.options),
        { code: "forbidden" },
      );
      const added = modelSettingsSchema.parse(
        await embedded.client.call(
          "model-settings.read",
          undefined,
          embedded.options,
        ),
      );
      const account = added.accounts.find(
        (account) => account.id === created.accountId,
      )!;
      assert.ok(account);
      assert.equal(account.label, "TEST 可删除的隔离账号");
      assert.equal(added.accounts.length, before.accounts.length + 1);
      const command = {
        action: "account-delete",
        accountId: account.id,
        expectedVersion: account.version,
      } as const;
      assert.deepEqual(
        await embedded.client.call(
          "model-settings.update",
          command,
          embedded.options,
        ),
        { kind: "removed", accountId: account.id },
      );
      const after = modelSettingsSchema.parse(
        await embedded.client.call(
          "model-settings.read",
          undefined,
          embedded.options,
        ),
      );
      assert.ok(
        !after.accounts.some((candidate) => candidate.id === account.id),
      );
      assert.deepEqual(
        after.accounts.map((account) => account.id).sort(),
        before.accounts.map((account) => account.id).sort(),
      );
      assert.equal(after.catalog.current, before.catalog.current);
      assert.deepEqual(
        await embedded.client.call(
          "model-settings.update",
          command,
          embedded.options,
        ),
        { kind: "removed", accountId: account.id },
      );
      await assert.rejects(
        () => f.client.call("model-settings.update", command, f.options),
        { code: "forbidden" },
      );
      assert.deepEqual(
        f.sql(
          "SELECT id,model_alias,reasoning_effort FROM sessions ORDER BY id",
        ),
        sessions,
      );
      assert.equal(
        f.requests.length,
        0,
        "Account administration must not probe or infer",
      );
      assert.equal(f.realCalls, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  "actual Host inherited input follows a live Session switch only after the in-flight request, while an explicit task remains fixed",
  {
    skip: process.env.MORPHZ_RESPONSE_ANNOTATIONS_RUNTIME_E2E !== "1",
    timeout: 120_000,
  },
  async () => {
    const f = await profileActualTransportFixture({
      evalCallableTools: ["host_morphz"],
      additionalModels: ["fixture-alternate"],
    });
    try {
      const projectId = "live_model_" + randomUUID().replaceAll("-", "");
      const conversationId = "conversation_" + randomUUID().replaceAll("-", "");
      await f.client.call(
        "projects.create",
        {
          commandId: randomUUID(),
          projectId,
          title: "TEST 实时模型继承",
        },
        f.options,
      );
      const threadFor = (marker: string) =>
        f.sql<{
          id: string;
          session_id: string;
          model_alias: string | null;
          reasoning_effort: string | null;
          status: string;
        }>(
          "SELECT id,session_id,model_alias,reasoning_effort,status FROM threads WHERE root_turn_id=(SELECT id FROM events WHERE topic='chat/user_message' AND json_extract(payload,'$.client_message_id')=?)",
          marker,
        )[0]!;
      let sessionId = "";
      let definitions: unknown;
      const embedded = await f.embeddedClient();
      for (const explicit of [false, true]) {
        const inputId = randomUUID();
        const marker = "TEST_LIVE_MODEL_" + inputId;
        const start = f.requests.length;
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
              ...(!sessionId
                ? {
                    newConversation: { title: "TEST 实时模型继承" },
                    initialSessionEvaluation: {
                      model: "profile-actual",
                      reasoningEffort: "low",
                    },
                  }
                : {}),
              ...(explicit
                ? { model: "profile-actual", reasoningEffort: "none" }
                : {}),
            },
          },
          f.options,
        );
        const first = await f.waitRequest(marker, start);
        const thread = threadFor(inputId);
        assert.ok(thread);
        sessionId ||= thread.session_id;
        assert.equal(thread.session_id, sessionId);
        assert.equal(thread.model_alias, explicit ? "profile-actual" : null);
        assert.equal(thread.reasoning_effort, explicit ? "none" : null);
        if (!explicit) {
          const initial = f.sql<{
            model_alias: string;
            reasoning_effort: string;
          }>(
            "SELECT model_alias,reasoning_effort FROM sessions WHERE id=?",
            sessionId,
          )[0]!;
          assert.equal(initial.model_alias, "profile-actual");
          assert.equal(initial.reasoning_effort, "low");
        }
        assert.equal(first.model, "profile-actual");
        assert.equal(first.reasoning_effort, explicit ? "none" : "low");
        definitions ??= first.tools;
        assert.deepEqual(first.tools, definitions);
        const selection = {
          model_alias: "fixture-alternate",
          reasoning_effort: explicit ? "low" : "high",
        };
        const scope = { projectId, conversationId };
        const before = sessionEvaluationSnapshotSchema.parse(
          await embedded.client.call(
            "session-evaluation.read",
            scope,
            embedded.options,
          ),
        );
        assert.equal(before.runtimeSessionId, sessionId);
        const changed = sessionEvaluationSnapshotSchema.parse(
          await embedded.client.call(
            "session-evaluation.update",
            {
              ...scope,
              defaults: {
                model: selection.model_alias,
                reasoningEffort: selection.reasoning_effort,
              },
              expectedFingerprint: before.fingerprint,
            },
            embedded.options,
          ),
        );
        assert.deepEqual(changed.defaults, {
          model: selection.model_alias,
          reasoningEffort: selection.reasoning_effort,
        });
        assert.equal(
          f.requests.length,
          start + 1,
          "a settings change never interrupts or replays the open request",
        );
        assert.equal(first.model, "profile-actual");
        f.hold(marker);
        f.releaseWithMessages(marker, [
          {
            name: "host_morphz",
            arguments: {
              action: "list",
              limit: 5,
              _morphz: {
                execution: {
                  title: "TEST 核对模型继承",
                  progress: "核对隔离目录",
                },
                intent: "读取隔离项目目录",
              },
            },
          },
        ]);
        const second = await f.waitRequest(marker, start + 1);
        assert.equal(
          second.model,
          explicit ? "profile-actual" : selection.model_alias,
        );
        assert.equal(
          second.reasoning_effort,
          explicit ? "none" : selection.reasoning_effort,
        );
        assert.deepEqual(
          second.tools,
          definitions,
          "the model switch keeps exactly the original tools",
        );
        f.releaseWithText(marker, "TEST 实时模型继承完成");
        for (
          let i = 0;
          i < 300 && threadFor(inputId).status !== "completed";
          i++
        )
          await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(threadFor(inputId).status, "completed");
        assert.equal(
          f.requests.length - start,
          2,
          "one original request, one normal post-tool continuation; no repair call",
        );
        assert.deepEqual(
          f
            .sql<{ model_alias: string; reasoning_effort: string }>(
              "SELECT model_alias,reasoning_effort FROM sessions WHERE id=?",
              sessionId,
            )
            .map((row) => ({ ...row })),
          [selection],
        );
        assert.equal(
          f.sql<{ count: number }>(
            "SELECT count(*) AS count FROM execution_jobs WHERE thread_id=?",
            thread.id,
          )[0]!.count,
          1,
        );
      }
    } finally {
      await f.close();
    }
  },
);

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
      const embedded = await f.embeddedClient();
      for (const effort of [
        "max",
        "none",
        "low",
        undefined,
        "session",
      ] as const) {
        const inherited = effort === "session";
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
              ...(inherited
                ? {
                    initialSessionEvaluation: {
                      model: "profile-actual",
                      reasoningEffort: "max",
                    },
                  }
                : {
                    model: "profile-actual",
                    ...(effort ? { reasoningEffort: effort } : {}),
                  }),
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
          inherited ? "max" : (effort ?? "low"),
          "Unspecified infer must inherit the parent task, not the low Runtime default",
        );
        definitions ??= first.tools;
        assert.deepEqual(first.tools, definitions);
        const child = f.sql<{
          id: string;
          parent_thread_id: string;
          session_id: string;
          model_alias: string | null;
          reasoning_effort: string | null;
        }>(
          "SELECT id,parent_thread_id,session_id,model_alias,reasoning_effort FROM threads WHERE executor_kind='plan_infer' ORDER BY rowid DESC LIMIT 1",
        )[0]!;
        assert.ok(child.parent_thread_id);
        const parent = f.sql<{
          id: string;
          status: string;
          model_alias: string | null;
          reasoning_effort: string | null;
        }>(
          "SELECT id,status,model_alias,reasoning_effort FROM threads WHERE id=?",
          child.parent_thread_id,
        )[0]!;
        assert.equal(child.model_alias, inherited ? null : "profile-actual");
        assert.equal(child.model_alias, parent.model_alias);
        assert.equal(child.reasoning_effort, parent.reasoning_effort);
        if (inherited) assert.equal(parent.reasoning_effort, null);
        else if (effort !== undefined)
          assert.equal(parent.reasoning_effort, effort);
        f.hold(marker);
        if (inherited) {
          const scope = { projectId, conversationId };
          const before = sessionEvaluationSnapshotSchema.parse(
            await embedded.client.call(
              "session-evaluation.read",
              scope,
              embedded.options,
            ),
          );
          assert.equal(before.runtimeSessionId, child.session_id);
          await embedded.client.call(
            "session-evaluation.update",
            {
              ...scope,
              expectedFingerprint: before.fingerprint,
              defaults: { model: "profile-actual", reasoningEffort: "high" },
            },
            embedded.options,
          );
          assert.equal(f.requests.length - start, 1);
        }
        f.releaseWithMessages(marker, [
          {
            name: "host_morphz",
            arguments: {
              action: "list",
              limit: 20,
              _morphz: {
                execution: { title: "TEST 讨论创意", progress: "核对项目目录" },
                intent: "核对本项目目录",
              },
            },
          },
        ]);
        const second = await f.waitRequest(marker, start + 1);
        assert.equal(second.model, "profile-actual");
        assert.equal(
          second.reasoning_effort,
          inherited ? "high" : (effort ?? "low"),
        );
        assert.deepEqual(second.tools, definitions);
        f.releaseWithText(
          marker,
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
          [inherited ? "high" : null],
          "A task override must not mutate its Session default",
        );
        const states = f.sql<{ payload: string }>(
          "SELECT payload FROM events WHERE topic='runtime/model_attempt_state' AND json_extract(payload,'$.thread_id')=? AND json_extract(payload,'$.state')='streaming'",
          child.id,
        );
        assert.equal(states.length, 2);
        assert.deepEqual(
          states.map(
            (state) => JSON.parse(state.payload).effective_reasoning_effort,
          ),
          inherited ? ["max", "high"] : [effort ?? "low", effort ?? "low"],
          "Attempt receipts must record the effective effort of each physical request",
        );
      }
    } finally {
      await f.close();
    }
  },
);
