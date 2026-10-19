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
        content: `Runtime Context:\n(context (evaluation-environment (session-io-return (delivery_id return-test) (caller_format (id morphz.chat) (version 1) (encoding utf8)) (annotations_enabled ${enabled}))))`,
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
  "actual Runtime + Host IO: late subscription restores the complete prefix, streams before completion and settles once",
  {
    skip: process.env.MORPHZ_RESPONSE_ANNOTATIONS_RUNTIME_E2E !== "1",
    timeout: 120_000,
  },
  async () => {
    const f = await profileActualTransportFixture();
    const abort = new AbortController();
    const readers: Promise<void>[] = [];
    const projectId = "io_" + randomUUID().replaceAll("-", "");
    const conversationId = "conversation_" + randomUUID().replaceAll("-", "");
    const marker = "TEST_LATE_IO_" + randomUUID();
    const prefix = "第一段在订阅前已经生成。\n\n";
    const suffix = "第二段在原执行结束前实时到达。";
    const frames: Array<{
      messages?: Array<{ kind: string; text: string; streaming?: boolean }>;
    }> = [];
    const eventually = async (ready: () => boolean) => {
      for (let i = 0; i < 300; i++) {
        if (ready()) return;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert.fail("Actual Session IO did not reach the authorized Host view");
    };
    const consume = async (
      response: Response,
      accept: (value: any) => void,
    ) => {
      assert.equal(response.status, 200);
      assert.ok(response.body);
      let buffer = "";
      const decoder = new TextDecoder();
      try {
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (data) accept(JSON.parse(data));
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) throw error;
      }
    };
    try {
      await f.client.call(
        "projects.create",
        { commandId: randomUUID(), projectId, title: "TEST Session IO 迟订阅" },
        f.options,
      );
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
            model: "profile-actual",
            reasoningEffort: "low",
            targetActantId: "morphz-agent",
            newConversation: { title: marker },
          },
        },
        f.options,
      );
      await f.waitRequest(marker);
      const thread = f.sql<{ id: string; session_id: string }>(
        "SELECT id,session_id FROM threads ORDER BY rowid DESC LIMIT 1",
      )[0]!;
      const producing = f.beginHeldTextStream(marker, prefix);
      let runtimePrefix = false;
      readers.push(
        consume(await f.ioStream(thread.session_id, abort.signal), (value) => {
          if (value.type?.startsWith("output.") && value.text === prefix)
            runtimePrefix = true;
        }),
      );
      await eventually(() => runtimePrefix);
      // The Host did not subscribe to started or the first delta. Its only
      // truthful recovery is the existing complete Session IO draft snapshot.
      readers.push(
        consume(
          await fetch(
            `${f.origin}/api/platform/projects/${projectId}/conversations/${conversationId}/stream`,
            {
              headers: { "X-Morphz-Token": f.options.identityGeneration },
              signal: abort.signal,
            },
          ),
          (value) => frames.push(value),
        ),
      );
      const visible = (text: string) =>
        frames.some((frame) =>
          frame.messages?.some(
            (message) =>
              message.kind === "reply" &&
              message.text === text &&
              message.streaming,
          ),
        );
      await eventually(() => visible(prefix));
      producing.append(suffix);
      await eventually(() => visible(prefix + suffix));
      assert.equal(
        f.sql<{ status: string }>(
          "SELECT status FROM threads WHERE id = ?",
          thread.id,
        )[0]?.status,
        "open",
      );
      assert.equal(
        f.sql<{ n: number }>(
          "SELECT count(*) AS n FROM thread_activations a JOIN threads t ON t.context_id = a.context_id AND t.session_id = a.session_id AND t.root_turn_id = a.root_turn_id WHERE t.id = ? AND a.status = 'running'",
          thread.id,
        )[0]!.n,
        1,
        "The producing Activation must still be running while its body is visible",
      );
      producing.finish([
        fixtureAnnotationsMessage({
          execution: {
            title: "TEST 迟订阅流式返回",
            result: "完整前缀和实时后缀已显示",
          },
        }),
      ]);
      await eventually(
        () =>
          f.sql<{ status: string }>(
            "SELECT status FROM threads WHERE id = ?",
            thread.id,
          )[0]?.status === "completed",
      );
      await eventually(() =>
        frames.some((frame) =>
          frame.messages?.some(
            (message) =>
              message.kind === "reply" &&
              message.text === prefix + suffix &&
              !message.streaming,
          ),
        ),
      );
      const final = frames
        .at(-1)!
        .messages!.filter((message) => message.kind === "reply");
      assert.equal(final.length, 1);
      assert.equal(final[0]!.text, prefix + suffix);
      const history = (await f.client.call(
        "conversations.history",
        { projectId, conversationId },
        f.options,
      )) as { inputs: Array<{ model?: string; reasoningEffort?: string }> };
      assert.equal(history.inputs[0]!.model, "profile-actual");
      assert.equal(history.inputs[0]!.reasoningEffort, "low");
      assert.equal(
        f.requests.length,
        1,
        "IO delivery cannot cause another infer",
      );
      assert.equal(
        f.sql<{ n: number }>("SELECT count(*) AS n FROM execution_jobs")[0]!.n,
        0,
      );
      assert.equal(
        f.sql<{ n: number }>(
          "SELECT count(*) AS n FROM events WHERE topic = 'runtime/response_protocol_error'",
        )[0]!.n,
        0,
      );
    } finally {
      abort.abort();
      await Promise.allSettled(readers);
      await f.close();
    }
  },
);

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
      const modelRows = (await f.client.call(
        "runtime.navigation",
        { projectId, conversationId, refreshActivity: true },
        f.options,
      )) as { runtime: { activity: ExecutionActivity } };
      for (const id of [active.id, next.id]) {
        const recorded = modelRows.runtime.activity.threads.find(
          (thread) => thread.id === id,
        )?.executionModel;
        assert.ok(
          recorded,
          "Actual physical configuration survives annotation on/off",
        );
        assert.ok(recorded.model_attempt_id);
        assert.ok(recorded.model);
        assert.ok("reasoning_effort" in recorded);
        assert.ok(!JSON.stringify(recorded).includes("auth_account_id"));
        const source = JSON.parse(
          f.sql<{ payload: string }>(
            "SELECT payload FROM events WHERE thread_id=? AND topic='runtime/model_attempt_state' AND json_extract(payload,'$.model_binding') IS NOT NULL ORDER BY rowid DESC LIMIT 1",
            id,
          )[0]!.payload,
        );
        assert.equal(recorded.model, source.model_binding.physical_model);
        assert.equal(
          recorded.reasoning_effort,
          source.effective_reasoning_effort,
        );
      }
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
    const receiptRef = (
      request: Parameters<typeof profileFixtureReturnBinding>[0],
    ) => {
      const refs =
        profileFixtureReturnBinding(request)?.annotation_observation_refs;
      assert.ok(
        refs?.length,
        "Runtime must supply the actual eligible result directory, never forged native history",
      );
      return refs.at(-1)!;
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
      assert.ok(
        JSON.stringify(first).includes(
          "Session IO return and optional display annotations:",
        ),
      );
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
  "actual Runtime + Platform HTTP: native bodies preserve protocol examples and partial optional metadata without repair",
  {
    skip: process.env.MORPHZ_RESPONSE_ANNOTATIONS_RUNTIME_E2E !== "1",
    timeout: 120_000,
  },
  async (parent) => {
    const body =
      '第一段："引号"、反斜线 \\ 和中文 🧠。\n\n`deliver_message` 与 :::morphz-reply 是正文，不是协议。';
    const valid = {
      body,
      annotations: {
        execution: {
          title: "TEST 完整结构化交付",
          progress: "",
          result: "TEST 正文与注解已完整返回",
        },
        observations: [],
      },
      effects: [],
    };
    for (const name of [
      "valid",
      "missing annotations",
      "missing title",
      "empty result",
      "plain text",
      "invalid JSON",
    ] as const)
      await parent.test(name, async () => {
        const f = await profileActualTransportFixture();
        const projectId = "io_schema_" + randomUUID().replaceAll("-", ""),
          conversationId = "conversation_" + randomUUID().replaceAll("-", "");
        const marker = "TEST_SCHEMA_" + randomUUID();
        const scope = { projectId, conversationId, artifactId: null };
        try {
          await f.client.call(
            "projects.create",
            { commandId: randomUUID(), projectId, title: "TEST IO Schema" },
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
          const value: any = structuredClone(valid);
          if (name === "missing annotations") delete value.annotations;
          if (name === "missing title")
            delete value.annotations.execution.title;
          if (name === "empty result") value.annotations.execution.result = " ";
          const raw =
            name === "plain text"
              ? body
              : JSON.stringify(value) + (name === "invalid JSON" ? "}" : "");
          if (name === "plain text" || name === "invalid JSON")
            f.releaseRawValue(marker, raw);
          else
            f.releaseWithMessages(
              marker,
              value.annotations
                ? [fixtureAnnotationsMessage(value.annotations)]
                : [],
              body,
            );
          let terminal: any;
          for (let attempt = 0; attempt < 300; attempt++) {
            const navigation: any = await f.client.call(
              "runtime.navigation",
              { projectId, conversationId, refreshActivity: true },
              f.options,
            );
            terminal = navigation.runtime.activity?.threads.find(
              (thread: any) => thread.projectId === projectId,
            );
            if (
              terminal &&
              ["completed", "failed"].includes(terminal.lifecycle)
            )
              break;
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
          assert.ok(terminal, "the real Runtime must settle the input");
          const replies = f.sql<{ payload: string }>(
            "SELECT payload FROM events WHERE thread_id = ? AND topic = 'chat/reply'",
            terminal.id,
          );
          const errors = f.sql<{ payload: string }>(
            "SELECT payload FROM events WHERE thread_id = ? AND topic = 'runtime/response_protocol_error'",
            terminal.id,
          );
          assert.equal(terminal.lifecycle, "completed");
          assert.equal(errors.length, 0);
          assert.equal(replies.length, 1);
          const expectedBody =
            name === "plain text" || name === "invalid JSON" ? raw : body;
          assert.equal(
            JSON.parse(replies[0]!.payload).text,
            expectedBody,
            "ordinary body text is never scanned for protocol or JSON",
          );
          const sources = f.sql<{ payload: string }>(
            "SELECT payload FROM events WHERE thread_id = ? AND topic = 'chat/assistant_call' AND json_extract(payload, '$.terminal_outcome') = 1",
            terminal.id,
          );
          assert.equal(sources.length, 1);
          const bundle = JSON.parse(
            sources[0]!.payload,
          ).response_annotation_bundle;
          assert.equal(bundle.raw_response.content, expectedBody);
          assert.equal(
            bundle.return_binding.output,
            undefined,
            "annotations do not select a JSON output envelope",
          );
          const plain = [
            "plain text",
            "invalid JSON",
            "missing annotations",
          ].includes(name);
          assert.equal(bundle.raw_response.tool_calls.length, plain ? 0 : 1);
          assert.equal(
            bundle.records.length,
            plain ? 0 : name === "valid" ? 2 : 1,
            "valid partial fields are accepted without fabricating missing ones",
          );
          assert.equal(bundle.diagnostics.length > 0, name === "empty result");
          if (name === "valid")
            assert.equal(terminal.title, valid.annotations.execution.title);
          assert.equal(
            f.requests.length,
            1,
            "no metadata repair or reply relay",
          );
          assert.equal(
            f.sql<{ count: number }>(
              "SELECT count(*) AS count FROM execution_jobs",
            )[0]!.count,
            0,
          );
          assert.equal(
            f.sql<{ count: number }>(
              "SELECT count(*) AS count FROM events WHERE thread_id = ? AND topic = 'session/io_output' AND json_extract(payload, '$.io_message.format.id') = 'morphz.evaluation'",
              terminal.id,
            )[0]!.count,
            0,
            "new inputs never publish the legacy Evaluation wrapper",
          );
        } finally {
          await f.close();
        }
      });
  },
);
