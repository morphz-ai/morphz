import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { objectToolName } from "../packages/core/src/application-names.js";
import type { ExecutionActivity } from "../packages/core/src/conversation.js";
import { executionSnapshotSchema } from "../packages/core/src/execution.js";
import {
  profileActualTransportFixture,
  profileFixtureAnnotationsMessage,
  profileFixtureReturnBinding,
  fixtureAnnotationsMessage,
} from "./profile-actual-transport-fixture.js";

test("metadata follows frozen Runtime binding; tool definitions never select annotation mode", () => {
  const tools = [
    {
      type: "function",
      function: { name: "deliver_message", parameters: { type: "object" } },
    },
  ];
  for (const enabled of [false, true]) {
    const messages = [
      {
        role: "user",
        content: `Runtime Context:\n(context (evaluation-environment (session-io-return (delivery_id return-test) (format (id morphz.chat) (version 1) (encoding utf8)) (annotations_enabled ${enabled}))))`,
      },
    ];
    const carrier = profileFixtureAnnotationsMessage({ messages, tools });
    assert.equal(!!carrier, enabled);
    if (carrier) {
      assert.equal(carrier.name, "deliver_message");
      const args = carrier.arguments as any;
      assert.equal(args.message.format.id, "morphz.response.annotations");
      assert.ok(args.message.content.value.execution.title);
      assert.ok(args.message.content.value.execution.result);
      assert.equal("content" in args, false);
    }
  }
  assert.equal(
    profileFixtureAnnotationsMessage({ messages: [], tools }),
    undefined,
  );
});

test(
  "actual Runtime setting: disabling during an active response preserves its contract, new input is off without annotations",
  {
    skip: process.env.MORPHZ_RESPONSE_ANNOTATIONS_RUNTIME_E2E !== "1",
    timeout: 120_000,
  },
  async () => {
    const f = await profileActualTransportFixture();
    try {
      const projectId = "setting_" + randomUUID().replaceAll("-", ""),
        conversationId = "conversation_" + randomUUID().replaceAll("-", "");
      let created = false;
      const send = async (marker: string) => {
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
              body: marker,
              targetActantId: "morphz-agent",
              ...(!created
                ? { newConversation: { title: "TEST 注解设置隔离验证" } }
                : {}),
            },
          },
          f.options,
        );
        created = true;
        return f.waitRequest(marker);
      };
      const settle = async (id: string) => {
        for (let i = 0; i < 300; i++) {
          const thread = f.sql<{ status: string }>(
            "SELECT status FROM threads WHERE id = ?",
            id,
          )[0];
          if (
            ["completed", "failed", "cancelled"].includes(thread?.status ?? "")
          ) {
            assert.equal(thread?.status, "completed");
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.fail("Input did not settle");
      };
      await f.client.call(
        "projects.create",
        { commandId: randomUUID(), projectId, title: "TEST 响应注解设置" },
        f.options,
      );
      const marker = "TEST_SETTING_ACTIVE_" + randomUUID();
      const activeRequest = await send(marker);
      const active = f.sql<{ id: string; response_annotations: string }>(
        "SELECT id,response_annotations FROM threads ORDER BY rowid DESC LIMIT 1",
      )[0]!;
      assert.equal(active.response_annotations, "on");
      // Remote HTTP deliberately lacks local admin capabilities. Use the
      // canonical local Host domain without weakening that RPC boundary.
      await f.runtime.modelSettings.apply(
        { action: "response-annotations", mode: "off", expectedMode: "on" },
        AbortSignal.timeout(5000),
        () => {},
      );
      assert.equal(
        (
          await f.runtime.modelSettings.read(
            AbortSignal.timeout(5000),
            () => {},
          )
        ).responseAnnotations,
        "off",
      );
      assert.equal(
        f.sql<{ response_annotations: string }>(
          "SELECT response_annotations FROM threads WHERE id = ?",
          active.id,
        )[0]!.response_annotations,
        "on",
      );
      f.releaseWithMessages(
        marker,
        [
          fixtureAnnotationsMessage({
            execution: { title: "TEST 原执行仍开启", result: "原设置未被改变" },
          }),
        ],
        "TEST ON BODY",
      );
      await settle(active.id);
      const nextMarker = "TEST_SETTING_NEW_OFF_" + randomUUID();
      const nextRequest = await send(nextMarker);
      assert.equal(
        profileFixtureReturnBinding(activeRequest)?.annotations_enabled,
        true,
      );
      assert.equal(
        profileFixtureReturnBinding(nextRequest)?.annotations_enabled,
        false,
      );
      assert.deepEqual(
        activeRequest.tools,
        nextRequest.tools,
        "Setting does not mutate schemas or order",
      );
      const next = f.sql<{ id: string; response_annotations: string }>(
        "SELECT id,response_annotations FROM threads ORDER BY rowid DESC LIMIT 1",
      )[0]!;
      assert.equal(next.response_annotations, "off");
      f.releaseWithText(nextMarker, "TEST OFF BODY");
      await settle(next.id);
      assert.equal(
        f
          .sql<{ payload: string }>(
            "SELECT payload FROM events WHERE thread_id = ? AND topic = 'chat/reply'",
            next.id,
          )
          .map((row) => JSON.parse(row.payload).text)
          .join(""),
        "TEST OFF BODY",
      );
      assert.equal(
        f.sql<{ n: number }>(
          "SELECT count(*) AS n FROM execution_jobs WHERE thread_id IN (?,?)",
          active.id,
          next.id,
        )[0]!.n,
        0,
      );
      assert.equal(
        f.sql<{ n: number }>(
          "SELECT count(*) AS n FROM events WHERE thread_id IN (?,?) AND topic = 'runtime/response_protocol_error'",
          active.id,
          next.id,
        )[0]!.n,
        0,
      );
      assert.equal(f.requests.length, 2);
      assert.equal(f.realCalls, 0);
    } finally {
      await f.close();
    }
  },
);

/** The provider is deterministic, but every admission, schema, carrier, Host
 * tool, receipt, EventStore projection and Application Client read is real.
 * No original profile, provider credential or paid model is used. */
test(
  "actual Runtime + Platform HTTP: two commands form one activity, three original model rounds, durable refresh and exact Job receipts",
  {
    skip: process.env.MORPHZ_RESPONSE_ANNOTATIONS_RUNTIME_E2E !== "1",
    timeout: 120_000,
  },
  async () => {
    const f = await profileActualTransportFixture();
    const projectId = "annotations_" + randomUUID().replaceAll("-", "");
    const conversationId = "conversation_" + randomUUID().replaceAll("-", "");
    const marker = "TEST_ANNOTATIONS_ACTUAL_" + randomUUID();
    const scope = { projectId, conversationId, artifactId: null };
    const activity = async () => {
      const snapshot = (await f.client.call(
        "runtime.navigation",
        { projectId, conversationId, refreshActivity: true },
        f.options,
      )) as { runtime: { activity?: ExecutionActivity } };
      return (
        snapshot.runtime.activity?.threads.filter(
          (thread) => thread.projectId === projectId,
        ) ?? []
      );
    };
    const eventually = async <T>(
      read: () => Promise<T>,
      done: (v: T) => boolean,
    ) => {
      for (let attempt = 0; attempt < 300; attempt++) {
        const value = await read();
        if (done(value)) return value;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail(
        "Actual annotations did not reach the authorized Application view",
      );
    };
    const receiptRef = (request: {
      messages: Array<{ role: string; content: unknown }>;
    }) => {
      const receipts = request.messages.flatMap((message) => {
        if (message.role !== "tool" || typeof message.content !== "string")
          return [];
        const receipt = JSON.parse(message.content) as {
          status?: string;
          observation_ref?: string;
        };
        return receipt.observation_ref ? [receipt] : [];
      });
      assert.ok(
        receipts.length > 0,
        "Actual Runtime must supply a trusted observation reference: " +
          JSON.stringify(
            request.messages.map((message) => ({
              role: message.role,
              content:
                typeof message.content === "string"
                  ? message.content.slice(-1000)
                  : message.content,
            })),
          ),
      );
      assert.equal(receipts.at(-1)!.status, "success");
      return receipts.at(-1)!.observation_ref!;
    };
    try {
      await f.client.call(
        "projects.create",
        { commandId: randomUUID(), projectId, title: "注解端到端隔离验证" },
        f.options,
      );
      f.hold(marker);
      await f.client.call(
        "platform.message",
        {
          commandId: randomUUID(),
          operation: {
            type: "record-input",
            ...scope,
            artifactRevision: null,
            selection: "",
            body: marker,
            targetActantId: "morphz-agent",
            newConversation: { title: marker },
          },
        },
        f.options,
      );
      const first = await f.waitRequest(marker);
      assert.ok(JSON.stringify(first).includes("Session IO response contract"));
      const toolDefinitions = first.tools as Array<{
        function: {
          name: string;
          parameters: { properties?: Record<string, unknown> };
        };
      }>;
      assert.equal(
        toolDefinitions.find((tool) => tool.function.name === objectToolName)
          ?.function.parameters.properties?._annotations,
        undefined,
      );
      assert.ok(
        toolDefinitions.some(
          (tool) => tool.function.name === "deliver_message",
        ),
      );

      const secondIndex = f.requests.length;
      f.hold(marker);
      f.releaseWithMessages(marker, [
        {
          name: objectToolName,
          arguments: { action: "profile", profile: { action: "read" } },
        },
        fixtureAnnotationsMessage({
          execution: { title: "检查资料与输入", progress: "正在读取资料" },
          calls: [{ index: 0, intent: "读取当前 Agent 资料" }],
        }),
      ]);
      const second = await f.waitRequest(marker, secondIndex);
      const firstRef = receiptRef(second);
      const working = await eventually(
        activity,
        (threads) => threads[0]?.title === "检查资料与输入",
      );
      assert.equal(working.length, 1);
      assert.equal(working[0]!.summary, "正在读取资料");
      assert.equal(working[0]!.lifecycle, "open");
      const threadId = working[0]!.id;

      const thirdIndex = f.requests.length;
      f.hold(marker);
      f.releaseWithMessages(marker, [
        { name: objectToolName, arguments: { action: "read-input" } },
        fixtureAnnotationsMessage({
          execution: {
            title: "同一输入的后续步骤不应改名",
            progress: "资料已读取，正在核对输入",
          },
          calls: [{ index: 0, intent: "核对本次输入" }],
          observations: [{ ref: firstRef, result: "已读取当前 Agent 资料" }],
        }),
      ]);
      const third = await f.waitRequest(marker, thirdIndex);
      const secondRef = receiptRef(third);
      assert.notEqual(secondRef, firstRef);
      const continued = await eventually(
        activity,
        (threads) => threads[0]?.summary === "资料已读取，正在核对输入",
      );
      assert.equal(continued[0]!.title, "检查资料与输入");
      assert.equal(continued[0]!.id, threadId);
      f.releaseWithMessages(
        marker,
        [
          fixtureAnnotationsMessage({
            execution: {
              title: "检查资料与输入",
              result: "资料与输入检查完成，未修改任何参数",
            },
            observations: [{ ref: secondRef, result: "已核对本次输入" }],
          }),
        ],
        "TEST：两次只读检查完成，没有修改资料。",
      );
      const terminal = await eventually(
        activity,
        (threads) => threads[0]?.lifecycle === "completed",
      );
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0]!.id, threadId);
      assert.equal(terminal[0]!.title, "检查资料与输入");
      assert.equal(terminal[0]!.summary, "资料与输入检查完成，未修改任何参数");
      assert.equal(terminal[0]!.annotationProtocol, "on");
      assert.equal(terminal[0]!.annotationsTruncated, false);

      const detail = executionSnapshotSchema.parse(
        await f.client.call(
          "execution.snapshot",
          { ...scope, threadId, inputId: terminal[0]!.inputId },
          f.options,
        ),
      );
      assert.equal(
        detail.jobs.length,
        2,
        "reply must not become a third physical Job",
      );
      assert.deepEqual(
        new Set(detail.jobs.map((job) => job.annotation?.intent)),
        new Set(["读取当前 Agent 资料", "核对本次输入"]),
      );
      assert.deepEqual(
        new Set(detail.jobs.map((job) => job.annotation?.result)),
        new Set(["已读取当前 Agent 资料", "已核对本次输入"]),
      );
      for (const job of detail.jobs) {
        assert.equal(job.thread_id, threadId);
        assert.equal(job.status, "succeeded");
        assert.ok(job.result_event_id);
        assert.ok(
          !JSON.stringify(job.request).includes("_annotations"),
          "Annotations must never enter the Host business request",
        );
        const receipt = f.sql<{ id: string }>(
          "SELECT id FROM events WHERE id = ?",
          job.result_event_id,
        );
        assert.equal(receipt[0]?.id, job.result_event_id);
      }
      assert.deepEqual(
        await activity(),
        terminal,
        "Client refresh rebuilds the same durable annotation projection",
      );
      assert.equal(
        f.requests.length,
        3,
        "No independent summary/repair/model requests are allowed",
      );
      assert.equal(f.realCalls, 0);
      assert.equal(
        (await f.read()).agent.revision,
        0,
        "Read-only acceptance must preserve Profile",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "actual Runtime + Platform HTTP: native metadata never wraps or invalidates normal reply content",
  {
    skip: process.env.MORPHZ_RESPONSE_ANNOTATIONS_RUNTIME_E2E !== "1",
    timeout: 120_000,
  },
  async (parent) => {
    const cases: {
      name: string;
      metadata: Record<string, unknown>;
      text?: boolean;
      valid?: boolean;
      body?: string;
    }[] = [
      { name: "missing annotations", metadata: {} },
      {
        name: "missing final title",
        metadata: {
          annotations: { execution: { result: "TEST synthetic result" } },
        },
      },
      {
        name: "empty final result",
        metadata: {
          annotations: {
            execution: { title: "TEST synthetic task", result: " " },
          },
        },
      },
      { name: "plain text without metadata", metadata: {}, text: true },
      {
        name: "implicit reply without title",
        metadata: { annotations: { execution: { result: "TEST result" } } },
        text: true,
      },
      {
        name: "implicit reply with empty result",
        metadata: {
          annotations: { execution: { title: "TEST title", result: " " } },
        },
        text: true,
      },
      {
        name: "implicit reply with required annotations",
        text: true,
        valid: true,
        metadata: {
          annotations: {
            execution: {
              title: "TEST 普通文本注解",
              result: "TEST 正文已返回",
            },
          },
        },
      },
      {
        name: "multiline Markdown stays in implicit content with independent annotations",
        text: true,
        valid: true,
        body: '第一段："引号"、反斜线 \\ 和中文 🧠。\n\n第二段保留真实换行。\n\n```json\n{"delivery_id":"example"}\n```\n\n:::morphz-reply\n这里是讨论协议的正文，不是可执行消息。\n:::',
        metadata: {
          annotations: {
            execution: {
              title: "TEST 多段正文独立注解",
              result: "TEST 原文已完整返回，未包裹为工具参数",
            },
          },
        },
      },
    ];
    for (const entry of cases)
      await parent.test(entry.name, async () => {
        const f = await profileActualTransportFixture();
        const projectId =
          "annotations_invalid_" + randomUUID().replaceAll("-", "");
        const conversationId =
          "conversation_" + randomUUID().replaceAll("-", "");
        const marker = "TEST_ANNOTATIONS_INVALID_" + randomUUID();
        const scope = { projectId, conversationId, artifactId: null };
        try {
          await f.client.call(
            "projects.create",
            {
              commandId: randomUUID(),
              projectId,
              title: "注解与正文独立隔离验证",
            },
            f.options,
          );
          f.hold(marker);
          await f.client.call(
            "platform.message",
            {
              commandId: randomUUID(),
              operation: {
                type: "record-input",
                ...scope,
                artifactRevision: null,
                selection: "",
                body: marker,
                targetActantId: "morphz-agent",
                newConversation: { title: marker },
              },
            },
            f.options,
          );
          const request = await f.waitRequest(marker);
          assert.ok(profileFixtureReturnBinding(request)?.annotations_enabled);
          assert.equal(f.requests.length, 1);
          const candidate = entry.body ?? "TEST VALID BODY MUST REMAIN VISIBLE";
          const binding = profileFixtureReturnBinding(request)!;
          const nativeMessages = [];
          if (!entry.text)
            nativeMessages.push({
              name: "deliver_message",
              arguments: {
                delivery_id: binding.delivery_id,
                message: {
                  format: {
                    id: binding.format.id,
                    version: binding.format.version,
                  },
                  content: {
                    encoding: binding.format.encoding,
                    value:
                      binding.format.encoding === "utf8"
                        ? candidate
                        : { text: candidate },
                  },
                },
              },
            });
          if (entry.metadata.annotations !== undefined)
            nativeMessages.push(
              fixtureAnnotationsMessage(entry.metadata.annotations),
            );
          f.releaseWithMessages(
            marker,
            nativeMessages,
            entry.text ? candidate : undefined,
          );
          let terminal: ExecutionActivity["threads"][number] | undefined;
          for (let attempt = 0; attempt < 300; attempt++) {
            const data = (await f.client.call(
              "runtime.navigation",
              {
                projectId,
                conversationId,
                refreshActivity: true,
              },
              f.options,
            )) as { runtime: { activity?: ExecutionActivity } };
            terminal = data.runtime.activity?.threads.find(
              (thread) => thread.projectId === projectId,
            );
            if (terminal?.lifecycle === "completed") break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          assert.equal(terminal?.lifecycle, "completed");
          assert.ok(terminal);
          const detail = executionSnapshotSchema.parse(
            await f.client.call(
              "execution.snapshot",
              {
                ...scope,
                threadId: terminal.id,
                inputId: terminal.inputId,
              },
              f.options,
            ),
          );
          assert.equal(
            detail.jobs.length,
            0,
            "Neither response carrier nor missing metadata dispatches a physical Job",
          );
          const thread = f.sql<{
            status: string;
            response_annotations: string;
          }>(
            "SELECT status, response_annotations FROM threads WHERE id = ?",
            terminal.id,
          );
          assert.deepEqual(
            { ...thread[0] },
            {
              status: "completed",
              response_annotations: "on",
            },
          );
          const fused = f.sql<{ payload: string }>(
            "SELECT payload FROM events WHERE thread_id = ? AND topic = 'runtime/response_protocol_fused'",
            terminal.id,
          );
          assert.equal(fused.length, 0);
          const failures = f.sql<{ payload: string }>(
            "SELECT payload FROM events WHERE thread_id = ? AND topic IN ('chat/reply', 'session/io_state') AND json_extract(payload, '$.terminal_kind') = 'failed'",
            terminal.id,
          );
          assert.equal(failures.length, 0);
          const replies = f.sql<{ payload: string }>(
            "SELECT payload FROM events WHERE thread_id = ? AND topic = 'chat/reply'",
            terminal.id,
          );
          assert.equal(replies.length, 1);
          assert.equal(JSON.parse(replies[0]!.payload).text, candidate);
          const sources = f.sql<{ payload: string }>(
            "SELECT payload FROM events WHERE thread_id = ? AND topic = 'chat/assistant_call' AND json_extract(payload, '$.terminal_outcome') = 1",
            terminal.id,
          );
          assert.equal(sources.length, 1);
          const bundle = JSON.parse(
            sources[0]!.payload,
          ).response_annotation_bundle;
          assert.equal(
            bundle.raw_response.content,
            entry.text ? candidate : "",
          );
          assert.equal(
            bundle.raw_response.tool_calls.length,
            nativeMessages.length,
          );
          assert.ok(
            bundle.raw_response.tool_calls.every(
              (call: any) => call.func_name === "deliver_message",
            ),
          );
          const metadataCall = bundle.raw_response.tool_calls.find(
            (call: any) =>
              JSON.parse(call.arguments).message.format.id ===
              "morphz.response.annotations",
          );
          if (entry.metadata.annotations !== undefined)
            assert.deepEqual(
              JSON.parse(metadataCall.arguments).message.content.value,
              entry.metadata.annotations,
            );
          if (entry.valid) {
            assert.equal(bundle.diagnostics.length, 0);
            assert.equal(terminal.title, "TEST 普通文本注解");
            assert.equal(terminal.summary, "TEST 正文已返回");
          } else {
            const errors = f.sql<{ payload: string }>(
              "SELECT payload FROM events WHERE thread_id = ? AND topic = 'runtime/response_protocol_error'",
              terminal.id,
            );
            assert.equal(errors.length, 0);
            assert.ok(
              bundle.diagnostics.length > 0,
              "missing metadata is diagnosed, never fabricated",
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
          assert.equal(
            f.requests.length,
            1,
            "Display metadata never requests a repair or independent summary",
          );
          assert.equal(f.realCalls, 0);
          assert.equal((await f.read()).agent.revision, 0);
        } finally {
          await f.close();
        }
      });
  },
);
