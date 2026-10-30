import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { Application } from "../packages/application/src/application.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import {
  ContinuationConflict,
  continuationTarget,
} from "../packages/application/src/continuation.js";
import { localAccess, type Receipt } from "../packages/core/src/model.js";
import { continuationInputFormat } from "../packages/application/src/session-io.js";
import type { InputContinuation } from "../packages/core/src/continuation.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import {
  assertNoLocalBusinessData,
  storedData,
} from "./platform-local-input-fixture.js";

async function fixture() {
  const directory = mkdtempSync(
    join(tmpdir(), "morphz-platform-continuation-"),
  );
  const store = new WorkspaceStore(join(directory, "transport.sqlite"), {
    mode: "transport",
  });
  const domains = await openApplicationDomainsHost(directory, store);
  const sessions = new Map<string, any>(),
    threads = new Map<string, any>(),
    accepted = new Map<string, any>();
  const attempts: any[] = [];
  const roots = new Map<string, { sessionId: string; event: any }>();
  let loseReceipt = false,
    closeAtAdmission = false,
    supportsDirectedInput = true;
  let capabilityResponseGate:
    { observed: () => void; released: Promise<void> } | undefined;
  let closedThreadResponseGate:
    { observed: () => void; released: Promise<void> } | undefined;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : null;
    const path = new URL(req.url!, "http://localhost").pathname,
      sid = path.split("/")[3]!;
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (path === "/api/status") return send(200, { model: "fixture" });
    if (path === "/api/session-io/capabilities") {
      const directedInput = supportsDirectedInput;
      const gate = capabilityResponseGate;
      capabilityResponseGate = undefined;
      if (gate) {
        gate.observed();
        await gate.released;
      }
      return send(200, {
        enabled: true,
        client_metadata: true,
        directed_input: directedInput,
        formats: [
          { definition: { id: "morphz.application.input", version: "4" } },
        ],
      });
    }
    if (path === "/api/sessions" && req.method === "POST") {
      sessions.set(body.id, {
        id: body.id,
        context_id: body.mount.context_id,
        permission_mode: null,
      });
      return send(201, sessions.get(body.id));
    }
    if (sessions.has(sid) && req.method === "PATCH") {
      const session = sessions.get(sid)!;
      session.permission_mode = body.permission_mode;
      return send(200, session);
    }
    if (path.endsWith("/principal"))
      return send(200, {
        ...sessions.get(sid),
        session_id: sid,
        principal_id: "fixture-human",
        capabilities: ["session_turn_control"],
      });
    if (path.endsWith("/scheduler"))
      return send(200, {
        threads: [...threads.values()]
          .filter((t) => t.lifecycle === "open")
          .map((thread) => ({
            thread,
            source: {
              event_id: thread.root_turn_id,
              root_turn_id: thread.root_turn_id,
              context_id: thread.context_id,
              session_id: thread.session_id,
              activation_id: null,
            },
            phase: "running",
          })),
      });
    if (path.includes("/threads/")) {
      const t = threads.get(path.split("/").at(-1)!);
      if (t?.lifecycle === "completed" && closedThreadResponseGate) {
        const gate = closedThreadResponseGate;
        closedThreadResponseGate = undefined;
        gate.observed();
        await gate.released;
      }
      return send(t ? 200 : 404, {
        snapshot: {
          thread: t,
          source: t
            ? (t.sourceProjection ?? {
                event_id: t.root_turn_id,
                root_turn_id: t.root_turn_id,
                context_id: t.context_id,
                session_id: t.session_id,
                activation_id: null,
              })
            : null,
        },
      });
    }
    if (path.endsWith("/io/messages")) {
      attempts.push(body);
      if (accepted.has(body.client_message_id))
        return send(200, accepted.get(body.client_message_id));
      const destination = body.activation.input_destination;
      if (destination) {
        const target = threads.get(destination.thread_id);
        if (closeAtAdmission) target.lifecycle = "completed";
        if (target?.lifecycle !== "open")
          return send(409, { message: "thread closed" });
        if (target.generation !== destination.generation)
          return send(409, { message: "generation changed" });
      } else {
        threads.set("thread-" + body.client_message_id, {
          id: "thread-" + body.client_message_id,
          root_turn_id: "root-" + body.client_message_id,
          session_id: sid,
          context_id: sessions.get(sid).context_id,
          initiating_principal_id: "fixture-human",
          generation: 1,
          revision: 1,
          executor_kind: "self",
          control_state: "active",
          lifecycle: "open",
          kind: "dialogue_turn",
          updated_at: new Date().toISOString(),
        });
      }
      const receipt = {
        accepted: true,
        event_id:
          (destination ? "steering-" : "root-") + body.client_message_id,
      };
      accepted.set(body.client_message_id, receipt);
      roots.set(body.client_message_id, {
        sessionId: sid,
        event: {
          id: receipt.event_id,
          sequence: roots.size + 1,
          timestamp: new Date().toISOString(),
          actor: "Session-Client",
          type: "session_message",
          topic: destination ? "chat/steering" : "chat/user_message",
          payload: {
            session_id: sid,
            context_id: sessions.get(sid).context_id,
            principal_id: "fixture-human",
            client_message_id: body.client_message_id,
            session_io: {
              request: {
                ...body,
                client_metadata: storedData(body.client_metadata),
                message: {
                  ...body.message,
                  content: {
                    ...body.message.content,
                    value: storedData(body.message.content.value),
                  },
                },
              },
            },
          },
        },
      });
      if (destination && loseReceipt) {
        loseReceipt = false;
        return res.destroy();
      }
      return send(200, receipt);
    }
    if (path.endsWith("/timeline"))
      return send(200, {
        entries: [...roots.entries()]
          .filter(([, root]) => root.sessionId === sid)
          .map(([inputId, root]) => ({
            entry_id: inputId,
            visible_at: root.event.timestamp,
            visible_at_micros: Date.parse(root.event.timestamp) * 1000,
            root_turn_id: root.event.id,
            attempt_id: null,
            display_kind: "input",
            final_event: true,
            event: root.event,
            root_event: null,
            input_event: root.event,
          })),
        next_before: null,
      });
    if (path.endsWith("/events")) return send(200, { events: [] });
    if (path === "/api/approvals") return send(200, { approvals: [] });
    return send(sessions.has(sid) ? 200 : 404, sessions.get(sid) ?? {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const config = {
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    token: "fixture",
    namespace: randomUUID(),
  };
  let bridge = new RuntimeBridge(store, config);
  let binding = domains.bindRuntime(bridge);
  const application = () =>
    new Application(store, {
      runtime: bridge,
      platformWork: domains.work,
      platformDocuments: domains.content,
    });
  await application().session(localAccess).createPlatformProject({
    commandId: randomUUID(),
    projectId: "first-project",
    title: "补充请求测试",
  });
  let connection = new LocalApplicationConnection(application());
  let boot = (await connection.call("platform.bootstrap")) as any;
  const send = (command: unknown) =>
    connection.call("platform.message", command, {
      identityGeneration: boot.csrfToken,
    }) as Promise<Receipt>;
  const ordinary = (body: string) => ({
    commandId: randomUUID(),
    operation: {
      type: "record-input",
      projectId: "first-project",
      conversationId: "first-project",
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body,
      targetActantId: "morphz-agent",
    },
  });
  const supplement = (
    target: InputContinuation,
    body = "仅给报告补充：使用人民币",
  ) => ({
    commandId: randomUUID(),
    operation: { ...ordinary(body).operation, continuation: target },
  });
  return {
    store,
    threads,
    accepted,
    attempts,
    send,
    ordinary,
    supplement,
    async runtime() {
      return (
        await bridge.platformConversationHistory(
          {
            projectId: "first-project",
            conversationId: "first-project",
          },
          localAccess,
        )
      ).runtime;
    },
    target(inputId?: string) {
      const thread = inputId
        ? threads.get(`thread-${inputId}`)
        : [...threads.values()][0];
      const input = inputId ?? thread.root_turn_id.slice("root-".length);
      assert.ok(
        (store.runtimeState() as any).deliveries.some(
          (delivery: any) =>
            delivery.inputId === input &&
            delivery.rootId === thread.root_turn_id,
        ),
      );
      const target = continuationTarget(thread, input, thread.id);
      assert.ok(target, "The controlled Runtime thread must be active");
      return target;
    },
    get bridge() {
      return bridge;
    },
    get connection() {
      return connection;
    },
    loseReceipt() {
      loseReceipt = true;
    },
    closeAtAdmission() {
      closeAtAdmission = true;
    },
    holdClosedThreadResponse() {
      assert.equal(closedThreadResponseGate, undefined);
      let observed!: () => void, release!: () => void;
      const reached = new Promise<void>((resolve) => (observed = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      closedThreadResponseGate = { observed, released };
      return { reached, release };
    },
    disableDirectedInput() {
      supportsDirectedInput = false;
    },
    holdNextCapabilityResponse() {
      assert.equal(capabilityResponseGate, undefined);
      let observed!: () => void, release!: () => void;
      const reached = new Promise<void>((resolve) => (observed = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      capabilityResponseGate = { observed, released };
      return { reached, release };
    },
    async reopen() {
      await bridge.stop();
      await domains.unbindRuntime(binding.authority);
      bridge = new RuntimeBridge(store, config);
      binding = domains.bindRuntime(bridge);
      connection = new LocalApplicationConnection(application());
      boot = await connection.call("platform.bootstrap");
    },
    async waitForRoot(inputId: string) {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        // A supplement receipt may arrive while its background tick is still
        // refreshing activity. Another tick is not a barrier for that work.
        await bridge.tick();
        const delivery = (store.runtimeState() as any).deliveries.find(
          (item: any) => item.inputId === inputId,
        );
        if (delivery?.rootId) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail(`Input ${inputId} did not receive its execution root`);
    },
    async close() {
      await bridge.stop();
      await domains.unbindRuntime(binding.authority);
      assertNoLocalBusinessData(directory);
      await domains.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("定向补充沿用原 Session/root/权限；并行工作不串线，重试不新建执行", async () => {
  const f = await fixture();
  try {
    const a = await f.send(f.ordinary("报告 A")),
      b = await f.send(f.ordinary("资料 B"));
    await f.waitForRoot(a.entityId);
    await f.waitForRoot(b.entityId);
    await f.bridge.tick();
    const target = f.target(a.entityId);
    assert.equal(target.threadId, "thread-" + a.entityId);
    const command = f.supplement(target),
      receipt = await f.send(command);
    const after = await f.runtime(),
      delivery = after.deliveries.find((d) => d.inputId === receipt.entityId)!;
    assert.equal(delivery.supplement, "delivered");
    assert.equal(delivery.cancellable, false);
    const saved = f.store.runtimeState() as any,
      record = saved.deliveries.find(
        (d: any) => d.inputId === receipt.entityId,
      );
    assert.equal(record.rootId, null);
    assert.equal(record.acceptedEventId, "steering-" + receipt.entityId);
    assert.deepEqual(record.request.activation, {
      mode: "evaluate",
      dispatch_mode: "parallel",
      input_destination: {
        kind: "thread",
        thread_id: target.threadId,
        generation: 1,
      },
    });
    assert.equal(
      record.sessionId,
      saved.deliveries.find((d: any) => d.inputId === a.entityId).sessionId,
    );
    assert.equal(
      after.deliveries.find((d) => d.inputId === b.entityId)!.state,
      "running",
    );
    f.threads.get(target.threadId).lifecycle = "completed";
    const count = f.attempts.length;
    assert.deepEqual(await f.send(command), receipt);
    assert.equal(f.attempts.length, count);
    assert.equal(f.threads.size, 2);
  } finally {
    await f.close();
  }
});

test("丢失补充回执后重开：同一 immutable 请求在目标结束后仍恢复回执，不重复", async () => {
  const f = await fixture();
  try {
    const original = await f.send(f.ordinary("报告 A"));
    await f.waitForRoot(original.entityId);
    await f.bridge.tick();
    const target = f.target(),
      command = f.supplement(target);
    f.loseReceipt();
    await assert.rejects(
      f.send(command),
      (e: any) => e.code === "supplement_unconfirmed",
    );
    const before = f.store.runtimeState() as any,
      delivered = before.deliveries[1],
      request = JSON.stringify(delivered.request);
    assert.equal(delivered.supplement, "unknown");
    assert.equal(f.accepted.size, 2);
    f.threads.get(target.threadId).lifecycle = "completed";
    await f.reopen();
    const receipt = await f.send(command);
    assert.equal(receipt.entityId, delivered.inputId);
    assert.equal(f.accepted.size, 2);
    assert.equal(
      JSON.stringify((f.store.runtimeState() as any).deliveries[1].request),
      request,
    );
    assert.equal(
      (await f.runtime()).deliveries.find(
        (d) => d.inputId === receipt.entityId,
      )!.supplement,
      "delivered",
    );
  } finally {
    await f.close();
  }
});

test("结束竞态不偷偷创建新执行；用户改为普通消息后仅创建一次执行", async () => {
  const f = await fixture();
  try {
    const original = await f.send(f.ordinary("报告 A"));
    await f.waitForRoot(original.entityId);
    await f.bridge.tick();
    const target = f.target(),
      command = f.supplement(target);
    f.closeAtAdmission();
    await assert.rejects(f.send(command), (e: any) => e.code === "work_closed");
    assert.equal(f.accepted.size, 1);
    assert.equal(
      (await f.runtime()).deliveries.find(
        (d) => d.inputId === command.commandId,
      )!.rejection,
      "closed",
    );
    await assert.rejects(f.send(command), (e: any) => e.code === "work_closed");
    const follow = f.ordinary(command.operation.body),
      receipt = await f.send(follow);
    await f.waitForRoot(receipt.entityId);
    const request = f.attempts.find(
      (r) => r.client_message_id === receipt.entityId,
    );
    assert.equal(request.activation.input_destination, undefined);
    assert.equal(request.message.content.value.continuation, undefined);
    assert.equal(request.message.content.value.text, command.operation.body);
    assert.equal(f.accepted.size, 2);
    assert.deepEqual(await f.send(follow), receipt);
    await f.bridge.tick();
    assert.equal(f.accepted.size, 2);
  } finally {
    await f.close();
  }
});

test("补充拒绝复核期间不发布临时 invalid，关闭原因与错误一次性确认", async () => {
  const f = await fixture();
  let gate: ReturnType<typeof f.holdClosedThreadResponse> | undefined;
  try {
    const original = await f.send(f.ordinary("报告 A"));
    await f.waitForRoot(original.entityId);
    await f.bridge.tick();
    const command = f.supplement(f.target());
    f.closeAtAdmission();
    gate = f.holdClosedThreadResponse();
    const result = f.send(command).then(
      (receipt) => ({ receipt, error: undefined }),
      (error: unknown) => ({ receipt: undefined, error }),
    );
    await gate.reached;
    // Observe the same public confirmation while the authoritative thread
    // recheck is held. A provisional rejection must not escape through it.
    const confirmation = f.bridge.confirmSupplement(command.commandId).then(
      () => ({ settled: true, error: undefined }),
      (error: unknown) => ({ settled: true, error }),
    );
    assert.deepEqual(
      await Promise.race([
        confirmation,
        new Promise<{ settled: false }>((resolve) =>
          setImmediate(() => resolve({ settled: false })),
        ),
      ]),
      { settled: false },
    );
    gate.release();
    const [sent, confirmed] = await Promise.all([result, confirmation]);
    assert.equal((sent.error as { code?: string })?.code, "work_closed");
    assert.ok(confirmed.error instanceof ContinuationConflict);
    assert.equal(confirmed.error.reason, "closed");
    assert.equal(f.accepted.size, 1);
    assert.equal(
      f.attempts.filter(
        (request) => request.client_message_id === command.commandId,
      ).length,
      1,
    );
    const delivery = (await f.runtime()).deliveries.find(
      (item) => item.inputId === command.commandId,
    )!;
    assert.equal(delivery.rejection, "closed");
    assert.equal(delivery.supplement, "rejected");
    assert.notEqual(delivery.error, null);
  } finally {
    gate?.release();
    await f.close();
  }
});

test("跨 root、陈旧代次、他人身份、扩大目录或模型权限均拒绝", async () => {
  const f = await fixture();
  try {
    const a = await f.send(f.ordinary("报告 A"));
    const b = await f.send(f.ordinary("资料 B"));
    await f.waitForRoot(a.entityId);
    await f.waitForRoot(b.entityId);
    await f.bridge.tick();
    const targets = [f.target(a.entityId), f.target(b.entityId)];
    for (const [target, code] of [
      [{ ...targets[0]!, threadId: targets[1]!.threadId }, "forbidden"],
      [{ ...targets[0]!, generation: 2 }, "work_changed"],
    ] as const)
      await assert.rejects(
        f.send(f.supplement(target)),
        (e: any) => e.code === code,
      );
    const forged = f.supplement(targets[0]!);
    Object.assign(forged.operation, { model: "other" });
    await assert.rejects(f.send(forged), /不能更换执行范围/);
    await assert.rejects(
      f.bridge.as({ principalId: "other", actantId: "other" }, () =>
        f.bridge.validatePlatformContinuation(
          targets[0]!,
          "first-project",
          "first-project",
        ),
      ),
      /不属于当前对话或发起者/,
    );
    assert.equal((f.store.runtimeState() as any).deliveries.length, 2);
    const ownerActivity = f.bridge.platformNavigationSnapshot(localAccess, [
      "first-project",
    ]).runtime.activity!;
    assert.ok(ownerActivity.threads.length > 0);
    assert.deepEqual(ownerActivity.threads[0]!.continuation, targets[0]);
    assert.equal(
      f.bridge.platformNavigationSnapshot(
        {
          principalId: "local-owner",
          actantId: "morphz-agent",
        },
        ["first-project"],
      ).runtime.activity!.threads[0]!.continuation,
      undefined,
    );
    await assert.rejects(
      f.bridge.platformConversationHistory(
        { projectId: "first-project", conversationId: "first-project" },
        { principalId: "local-owner", actantId: "morphz-agent" },
      ),
      (error: any) => error.code === "forbidden",
    );
    assert.deepEqual(
      (await f.runtime()).activity!.threads[0]!.continuation,
      targets[0],
    );
    assert.deepEqual(
      f.bridge.platformNavigationSnapshot(localAccess, ["first-project"])
        .runtime.activity!.threads[0]!.continuation,
      targets[0],
      "A read-only projection must not mutate the owner's controls",
    );
    assert.equal(f.accepted.size, 2);
    f.threads.get("thread-" + a.entityId).control_state = "paused";
    await assert.rejects(
      f.send(f.supplement(targets[0]!)),
      (e: any) => e.code === "work_closed",
    );
  } finally {
    await f.close();
  }
});

test("Objective 主线程用监督代次，custom 分支不假装可直接补充", () => {
  const base = {
    generation: 2,
    control_state: "active",
    lifecycle: "open",
    kind: "execution",
    executor_kind: "custom",
  };
  assert.equal(continuationTarget(base, "input", "thread"), undefined);
  const target = continuationTarget(
    {
      ...base,
      supervision: {
        supervisor_kind: "objective",
        supervisor_id: "objective",
        generation: 3,
        origin_evaluation_id: null,
      },
    },
    "input",
    "thread",
  )!;
  assert.deepEqual(target.objective, { id: "objective", generation: 3 });
  assert.equal(continuationInputFormat.version, "4");
});

test("Objective synthetic root accepts only Runtime-confirmed original provenance without loosening Human or generation checks", async () => {
  const f = await fixture();
  try {
    const input = await f.send(f.ordinary("原发布目标"));
    await f.waitForRoot(input.entityId);
    const thread = f.threads.get("thread-" + input.entityId);
    const originalRoot = thread.root_turn_id;
    thread.sourceProjection = {
      event_id: originalRoot,
      root_turn_id: originalRoot,
      session_id: thread.session_id,
      context_id: thread.context_id,
      activation_id: null,
    };
    thread.root_turn_id = "synthetic-objective-root";
    thread.kind = "execution";
    thread.executor_kind = "custom";
    thread.supervision = {
      supervisor_kind: "objective",
      supervisor_id: "goal-fixture",
      generation: 2,
      origin_evaluation_id: null,
    };
    const target = continuationTarget(thread, input.entityId, thread.id)!;
    await f.bridge.validatePlatformContinuation(
      target,
      "first-project",
      "first-project",
    );
    for (const patch of [
      { root_turn_id: "other-root" },
      { session_id: "other-session" },
      { context_id: "other-context" },
    ]) {
      const saved = thread.sourceProjection;
      thread.sourceProjection = { ...saved, ...patch };
      await assert.rejects(
        f.bridge.validatePlatformContinuation(
          target,
          "first-project",
          "first-project",
        ),
        /不属于原请求/,
      );
      thread.sourceProjection = saved;
    }
    await assert.rejects(
      f.bridge.validatePlatformContinuation(
        { ...target, objective: { id: "wrong", generation: 2 } },
        "first-project",
        "first-project",
      ),
      /不属于原请求/,
    );
    thread.initiating_principal_id = "other-human";
    await assert.rejects(
      f.bridge.validatePlatformContinuation(
        target,
        "first-project",
        "first-project",
      ),
      /不属于原请求/,
    );
  } finally {
    await f.close();
  }
});

test("旧 Runtime 不提供假入口，也不把已接受补充重新发送", async () => {
  const f = await fixture();
  try {
    const original = await f.send(f.ordinary("报告 A"));
    await f.waitForRoot(original.entityId);
    await f.bridge.tick();
    const target = f.target(),
      command = f.supplement(target);
    const receipt = await f.send(command);
    // Drain the receipt's existing pass before controlling the next response.
    await f.bridge.tick();
    const gate = f.holdNextCapabilityResponse();
    const previousCapabilityPass = f.bridge.tick();
    try {
      await gate.reached;
      f.disableDirectedInput();
      const joinedCapabilityPass = f.bridge.tick();
      gate.release();
      await joinedCapabilityPass;
    } finally {
      gate.release();
      await previousCapabilityPass;
    }
    // Joining a pass cannot change the capability snapshot it already read.
    assert.equal(f.bridge.supportsDirectedInput, true);
    // Start a new request after that pass, rather than racing its old response.
    await f.bridge.tick();
    assert.equal(f.bridge.supportsDirectedInput, false);
    assert.equal(
      (await f.runtime()).activity!.threads[0]!.continuation,
      undefined,
    );
    assert.equal(
      ((await f.connection.call("platform.bootstrap")) as any).capabilities
        .directedInput,
      false,
    );
    await assert.rejects(
      f.send(f.supplement(target, "另一份补充")),
      (e: any) => e.code === "invalid",
    );
    const count = f.attempts.length;
    assert.deepEqual(await f.send(command), receipt);
    assert.equal(f.attempts.length, count);
    assert.equal((f.store.runtimeState() as any).deliveries.length, 2);
  } finally {
    await f.close();
  }
});
