import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { objectToolName } from "../packages/core/src/application-names.js";
import type { ExecutionActivity } from "../packages/core/src/conversation.js";
import { executionSnapshotSchema } from "../packages/core/src/execution.js";
import { presentRuntimeErrors } from "../apps/web/src/runtime-error-presentation.js";
import { responseAnswered } from "../apps/web/src/conversation-presentation.js";
import { LiveConversationProjection } from "../packages/core/src/live-conversation.js";
import {
  profileActualTransportFixture,
  profileFixtureAnnotationsMessage,
  profileFixtureReturnBinding,
  profileFixtureCurrentRootId,
  profileFixtureObservationResult,
  fixtureAnnotationsMessage,
} from "./profile-actual-transport-fixture.js";

test("fixture takes only the actual kernel activation root, not another observation or row order", () => {
  const request = {
    messages: [
      {
        role: "user",
        content:
          '(context (observation (current-activation (root-turn (id wrong-observation)))) (kernel (current-activation (root-turn (id "actual-root")))))',
      },
    ],
  };
  assert.equal(profileFixtureCurrentRootId(request), "actual-root");
  assert.throws(
    () =>
      profileFixtureCurrentRootId({
        messages: [
          {
            role: "user",
            content:
              "(context (observation (current-activation (root-turn (id wrong-observation)))))",
          },
        ],
      }),
    /Actual request lacks kernel/,
  );
});

test("fixture reads the latest actual native tool continuation before frozen Context", () => {
  const messages = [
    {
      role: "user",
      content:
        '(context (observation (seq 999) (tool host_morphz) (kind tool_output) (content (text "{\\"items\\":[\\"old\\"]}"))))',
    },
    {
      role: "tool",
      content: JSON.stringify({
        tool_name: "host_morphz",
        result: JSON.stringify({ items: ["current"] }),
      }),
    },
    {
      role: "tool",
      content: JSON.stringify({ tool_name: "another_tool", result: "{}" }),
    },
  ];
  assert.deepEqual(
    profileFixtureObservationResult({ messages }, "host_morphz"),
    {
      items: ["current"],
    },
  );
  assert.deepEqual(
    profileFixtureObservationResult(
      { messages: messages.slice(0, 1) },
      "host_morphz",
    ),
    { items: ["old"] },
  );
});

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
    const nativeMessages = messages.map((message) => ({
      ...message,
      content: message.content.replace(
        "(session-io-return",
        "(session-io-return (carrier native_v3)",
      ),
    }));
    assert.equal(
      profileFixtureAnnotationsMessage({ messages: nativeMessages, tools }),
      undefined,
      "A fresh ordinary native reply never synthesizes a companion",
    );
  }
  assert.equal(
    profileFixtureAnnotationsMessage({ messages: [], tools }),
    undefined,
  );
});

test(
  "actual Runtime + Host: rejected empty wait is corrected once, delivered and never presented as a failed reply",
  {
    skip: process.env.MORPHZ_RESPONSE_ANNOTATIONS_RUNTIME_E2E !== "1",
    timeout: 120_000,
  },
  async () => {
    let calls = 0;
    const answer = "TEST 等待条件已核对，结果已经交付。";
    const f = await profileActualTransportFixture({
      deterministicTool: () =>
        ++calls === 1
          ? { name: "no_reply", arguments: { mode: "wait", wait_secs: 180 } }
          : { text: answer },
    });
    const projectId = "recovered_wait_" + randomUUID().replaceAll("-", "");
    const conversationId = "conversation_" + randomUUID().replaceAll("-", "");
    const marker = "TEST_RECOVERED_WAIT_" + randomUUID();
    try {
      await f.client.call(
        "projects.create",
        {
          commandId: randomUUID(),
          projectId,
          title: "TEST 已纠正等待拒绝",
        },
        f.options,
      );
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
            newConversation: { title: marker },
          },
        },
        f.options,
      );
      let history: any;
      for (let i = 0; i < 300; i++) {
        history = await f.client.call(
          "conversations.history",
          { projectId, conversationId },
          f.options,
        );
        if (history.runtime.messages.some((m: any) => m.text === answer)) break;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      const reply = history.runtime.messages.find(
        (m: any) => m.text === answer,
      );
      assert.ok(
        reply,
        "the actual corrected Runtime result is delivered through the Host",
      );
      const errors = f.sql<{
        id: string;
        timestamp: string;
        type: string;
        topic: string;
        payload: string;
      }>(
        "SELECT id,timestamp,type,topic,payload FROM events WHERE topic='runtime/response_protocol_error'",
      );
      assert.equal(errors.length, 1);
      const rejection = {
        ...errors[0]!,
        payload: JSON.parse(errors[0]!.payload),
      };
      assert.equal(rejection.payload.response_state, "invalid_wait");
      assert.match(
        rejection.payload.reason,
        /no_reply\(mode=wait\) was rejected/,
      );
      assert.equal(
        f.requests.length,
        2,
        "one correction, not a replay of the accepted input",
      );
      assert.ok(
        JSON.stringify(f.requests[1]!.messages).includes(
          rejection.payload.reason,
        ),
      );
      assert.equal(
        JSON.stringify(f.requests[0]!.tools),
        JSON.stringify(f.requests[1]!.tools),
      );
      assert.equal(
        f.sql<{ n: number }>("SELECT count(*) n FROM execution_jobs")[0]!.n,
        0,
      );
      const rootId = profileFixtureCurrentRootId(f.requests[0]!);
      assert.equal(
        reply.rootId,
        rootId,
        "Host reply must belong to the actual request",
      );
      let threads: Array<{ id: string; status: string }> = [];
      for (let i = 0; i < 300; i++) {
        threads = f.sql<{ id: string; status: string }>(
          "SELECT id,status FROM threads WHERE root_turn_id = ?",
          rootId,
        );
        assert.equal(
          threads.length,
          1,
          "the exact request has one logical Thread",
        );
        if (threads[0]!.status !== "open") break;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert.equal(threads[0]!.id, rejection.payload.thread_id);
      assert.equal(
        threads[0]!.status,
        "completed",
        "actual corrected Thread must reach its durable terminal state",
      );

      // The actual rejection still exists in live execution evidence, but is
      // not an answer or a failed request while the model corrects it.
      const projection = new LiveConversationProjection(() => ({
        projectId,
        conversationId,
        artifactId: null,
        inputId: reply.inputId,
        rootId: reply.rootId,
      }));
      projection.consume(rejection);
      const diagnostics = projection.snapshot();
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]!.failure!.phase, "diagnostic");
      assert.equal(responseAnswered(diagnostics, reply.inputId), false);
      assert.deepEqual(presentRuntimeErrors(diagnostics), []);
      assert.deepEqual(
        presentRuntimeErrors([...diagnostics, reply]).map((m) => m.id),
        [reply.id],
      );
      const reloaded: any = await f.client.call(
        "conversations.history",
        { projectId, conversationId },
        f.options,
      );
      assert.equal(
        presentRuntimeErrors(reloaded.runtime.messages).filter(
          (m) => m.kind === "error",
        ).length,
        0,
      );
      assert.equal(
        f.requests.length,
        2,
        "reading or reloading never invokes a model",
      );
      assert.equal(
        f.sql<{ n: number }>(
          "SELECT count(*) n FROM events WHERE topic='runtime/response_protocol_error'",
        )[0]!.n,
        1,
        "presentation does not erase the persisted diagnostic",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "actual Runtime + Host history: terminal failure restores its exact cause without response captures or another infer",
  {
    skip: process.env.MORPHZ_RESPONSE_ANNOTATIONS_RUNTIME_E2E !== "1",
    timeout: 120_000,
  },
  async () => {
    const f = await profileActualTransportFixture();
    const projectId = "failure_" + randomUUID().replaceAll("-", "");
    const conversationId = "conversation_" + randomUUID().replaceAll("-", "");
    const marker = "TEST_FAILURE_DIAGNOSTIC_" + randomUUID();
    try {
      await f.client.call(
        "projects.create",
        { commandId: randomUUID(), projectId, title: "TEST 失败原因读取" },
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
            targetActantId: "morphz-agent",
            newConversation: { title: marker },
          },
        },
        f.options,
      );
      const request = await f.waitRequest(marker);
      const thread = f.sql<{ id: string }>(
        "SELECT id FROM threads WHERE root_turn_id = ?",
        profileFixtureCurrentRootId(request),
      )[0]!;
      // A real invalid outcome: display-only metadata cannot stand in for an
      // answer. The existing business guard must still reject it, once.
      f.releaseWithMessages(
        marker,
        [
          fixtureAnnotationsMessage({
            execution: { title: "TEST 只有注解，没有回答" },
          }),
        ],
        "",
      );
      for (let i = 0; i < 300; i++) {
        if (
          f.sql<{ status: string }>(
            "SELECT status FROM threads WHERE id = ?",
            thread.id,
          )[0]?.status === "failed"
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert.equal(
        f.sql<{ status: string }>(
          "SELECT status FROM threads WHERE id = ?",
          thread.id,
        )[0]!.status,
        "failed",
      );
      const events = f.sql<{ id: string; payload: string }>(
        "SELECT id,payload FROM events WHERE thread_id = ? AND topic = 'runtime/response_protocol_error'",
        thread.id,
      );
      assert.equal(events.length, 1);
      const reason = JSON.parse(events[0]!.payload).reason;
      assert.match(
        reason,
        /Body and annotations cannot use a separate delivery call/,
      );
      for (let refresh = 0; refresh < 2; refresh++) {
        const history: any = await f.client.call(
          "conversations.history",
          { projectId, conversationId },
          f.options,
        );
        const errors = history.runtime.messages.filter(
          (message: any) => message.failure?.phase === "terminal",
        );
        assert.equal(errors.length, 1);
        assert.deepEqual(errors[0].failure.diagnostics, [
          { eventId: events[0]!.id, reason },
        ]);
        assert.ok(!JSON.stringify(errors).includes("response_capture"));
        assert.ok(!JSON.stringify(errors).includes("只有注解，没有回答"));
      }
      assert.equal(
        f.requests.length,
        1,
        "reading error details does not repair or resubmit the failed request",
      );
      assert.equal(
        f.sql<{ n: number }>("SELECT count(*) n FROM execution_jobs")[0]!.n,
        0,
      );
    } finally {
      await f.close();
    }
  },
);

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
      const request = await f.waitRequest(marker);
      const thread = f.sql<{ id: string; session_id: string }>(
        "SELECT id,session_id FROM threads WHERE root_turn_id = ?",
        profileFixtureCurrentRootId(request),
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
      producing.finish();
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
        "SELECT id,response_annotations FROM threads WHERE root_turn_id = ?",
        profileFixtureCurrentRootId(activeRequest),
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
      f.releaseWithText(marker, "TEST ON BODY");
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
        "SELECT id,response_annotations FROM threads WHERE root_turn_id = ?",
        profileFixtureCurrentRootId(nextRequest),
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
          "Session IO: the frozen evaluation-environment.session-io-return binding owns interpretation",
        ),
      );
      const toolDefinitions = first.tools as Array<{
        function: {
          name: string;
          parameters: { properties?: Record<string, unknown> };
        };
      }>;
      assert.ok(
        toolDefinitions.find((tool) => tool.function.name === objectToolName)
          ?.function.parameters.properties?._morphz,
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
          arguments: {
            action: "profile",
            profile: { action: "read" },
            _morphz: {
              execution: { title: "检查资料与输入", progress: "正在读取资料" },
              intent: "读取当前 Agent 资料",
            },
          },
        },
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
        {
          name: objectToolName,
          arguments: {
            action: "read-input",
            _morphz: {
              execution: {
                title: "同一输入的后续步骤不应改名",
                progress: "资料已读取，正在核对输入",
              },
              intent: "核对本次输入",
              observations: [
                { ref: firstRef, result: "已读取当前 Agent 资料" },
              ],
            },
          },
        },
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
      assert.deepEqual(first.tools, second.tools);
      assert.deepEqual(second.tools, third.tools);
      const finalBody = "TEST：两次只读检查完成，没有修改资料。";
      f.releaseWithText(marker, finalBody);
      const terminal = await eventually(
        activity,
        (threads) => threads[0]?.lifecycle === "completed",
      );
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0]!.id, threadId);
      assert.equal(terminal[0]!.title, "检查资料与输入");
      assert.equal(
        terminal[0]!.summary,
        undefined,
        "No separately generated final annotation",
      );
      assert.equal(
        terminal[0]!.outcome?.summary,
        finalBody,
        "The original committed body is retained",
      );
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
        new Set(["已读取当前 Agent 资料", undefined]),
      );
      for (const job of detail.jobs) {
        assert.equal(job.thread_id, threadId);
        assert.equal(job.status, "succeeded");
        assert.ok(job.result_event_id);
        assert.ok(
          !JSON.stringify(job.request).includes('"_morphz":'),
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
  "actual Runtime + Platform HTTP: native bodies preserve protocol examples verbatim without repair",
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
          f.releaseRawValue(marker, raw);
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
          const expectedBody = raw;
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
          assert.equal(
            bundle.raw_response.content,
            raw,
            "retain actual provider bytes independently of the projected body",
          );
          assert.equal(bundle.return_binding.carrier, "native_v3");
          assert.equal(bundle.return_binding.output, undefined);
          assert.equal(bundle.native_response.binding.message_encoding, "text");
          assert.equal(
            bundle.raw_response.tool_calls.length,
            0,
            "no separate annotation call",
          );
          assert.equal(
            bundle.records.length,
            0,
            "Protocol-looking text is ordinary body, not display metadata",
          );
          assert.equal(bundle.diagnostics.length, 0);
          assert.notEqual(terminal.title, valid.annotations.execution.title);
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
