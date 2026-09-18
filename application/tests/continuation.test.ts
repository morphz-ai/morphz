import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { Application } from "../packages/application/src/application.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { continuationTarget } from "../packages/application/src/continuation.js";
import { localAccess, type Receipt } from "../packages/core/src/model.js";
import { continuationInputFormat } from "../packages/application/src/session-io.js";
import type { InputContinuation } from "../packages/core/src/continuation.js";

async function fixture() {
  const store = new WorkspaceStore(":memory:");
  const sessions = new Map<string, any>(),
    threads = new Map<string, any>(),
    accepted = new Map<string, any>();
  const attempts: any[] = [];
  let loseReceipt = false,
    closeAtAdmission = false,
    supportsDirectedInput = true;
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
    if (path === "/api/session-io/capabilities")
      return send(200, {
        enabled: true,
        directed_input: supportsDirectedInput,
        formats: [
          { definition: { id: "morphz.application.input", version: "4" } },
        ],
      });
    if (path === "/api/sessions" && req.method === "POST") {
      sessions.set(body.id, { id: body.id, context_id: body.mount.context_id });
      return send(201, sessions.get(body.id));
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
          .map((thread) => ({ thread, phase: "running" })),
      });
    if (path.includes("/threads/")) {
      const t = threads.get(path.split("/").at(-1)!);
      return send(t ? 200 : 404, { snapshot: { thread: t } });
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
      if (destination && loseReceipt) {
        loseReceipt = false;
        return res.destroy();
      }
      return send(200, receipt);
    }
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
  let bridge = new RuntimeBridge(store, config),
    connection = new LocalApplicationConnection(
      new Application(store, { runtime: bridge }),
    );
  let boot = (await connection.call("workspace")) as any;
  const call = (method: "message" | "command", command: unknown) =>
    connection.call(method, command, {
      identityGeneration: boot.csrfToken,
    }) as Promise<Receipt>;
  const ordinary = (body: string) => ({
    commandId: randomUUID(),
    operation: {
      type: "record-input",
      projectId: "first-project",
      conversationId: "local-dialogue",
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
    call,
    ordinary,
    supplement,
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
    disableDirectedInput() {
      supportsDirectedInput = false;
    },
    async reopen() {
      await bridge.stop();
      bridge = new RuntimeBridge(store, config);
      connection = new LocalApplicationConnection(
        new Application(store, { runtime: bridge }),
      );
      boot = await connection.call("workspace");
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
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    },
  };
}

test("定向补充沿用原 Session/root/权限；并行工作不串线，重试不新建执行", async () => {
  const f = await fixture();
  try {
    const a = await f.call("message", f.ordinary("报告 A")),
      b = await f.call("message", f.ordinary("资料 B"));
    await f.bridge.tick();
    const target = f.bridge
      .snapshot(localAccess)
      .activity!.threads.find((t) => t.inputId === a.entityId)!.continuation!;
    assert.equal(target.threadId, "thread-" + a.entityId);
    const command = f.supplement(target),
      receipt = await f.call("message", command);
    const after = f.bridge.snapshot(localAccess),
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
    assert.deepEqual(await f.call("message", command), receipt);
    assert.equal(f.attempts.length, count);
    assert.equal(f.threads.size, 2);
  } finally {
    await f.close();
  }
});

test("丢失补充回执后重开：同一 immutable 请求在目标结束后仍恢复回执，不重复", async () => {
  const f = await fixture();
  try {
    await f.call("message", f.ordinary("报告 A"));
    await f.bridge.tick();
    const target = f.bridge.snapshot().activity!.threads[0]!.continuation!,
      command = f.supplement(target);
    f.loseReceipt();
    await assert.rejects(
      f.call("message", command),
      (e: any) => e.code === "supplement_unconfirmed",
    );
    const before = f.store.runtimeState() as any,
      delivered = before.deliveries[1],
      request = JSON.stringify(delivered.request);
    assert.equal(delivered.supplement, "unknown");
    assert.equal(f.accepted.size, 2);
    f.threads.get(target.threadId).lifecycle = "completed";
    await f.reopen();
    const receipt = await f.call("message", command);
    assert.equal(receipt.entityId, delivered.inputId);
    assert.equal(f.accepted.size, 2);
    assert.equal(
      JSON.stringify((f.store.runtimeState() as any).deliveries[1].request),
      request,
    );
    assert.equal(f.bridge.snapshot().deliveries[1]!.supplement, "delivered");
  } finally {
    await f.close();
  }
});

test("结束竞态不给新执行；显式后续请求有历史关联并创建一次新执行", async () => {
  const f = await fixture();
  try {
    await f.call("message", f.ordinary("报告 A"));
    await f.bridge.tick();
    const target = f.bridge.snapshot().activity!.threads[0]!.continuation!,
      command = f.supplement(target);
    f.closeAtAdmission();
    await assert.rejects(
      f.call("message", command),
      (e: any) => e.code === "work_closed",
    );
    assert.equal(f.accepted.size, 1);
    assert.equal(f.bridge.snapshot().deliveries[1]!.rejection, "closed");
    await assert.rejects(
      f.call("message", command),
      (e: any) => e.code === "work_closed",
    );
    const follow = f.supplement({ ...target, mode: "follow-up" }),
      receipt = await f.call("message", follow);
    await f.waitForRoot(receipt.entityId);
    const request = f.attempts.find(
      (r) => r.client_message_id === receipt.entityId,
    );
    assert.equal(request.activation.input_destination, undefined);
    assert.equal(
      request.message.content.value.continuation.original_request,
      "报告 A",
    );
    assert.equal(f.accepted.size, 2);
    assert.deepEqual(await f.call("message", follow), receipt);
    await f.bridge.tick();
    assert.equal(f.accepted.size, 2);
  } finally {
    await f.close();
  }
});

test("跨 root、陈旧代次、他人身份、扩大目录或模型权限均拒绝", async () => {
  const f = await fixture();
  try {
    const a = await f.call("message", f.ordinary("报告 A"));
    await f.call("message", f.ordinary("资料 B"));
    await f.bridge.tick();
    const targets = f.bridge
      .snapshot()
      .activity!.threads.map((t) => t.continuation!);
    for (const [target, code] of [
      [{ ...targets[0]!, threadId: targets[1]!.threadId }, "forbidden"],
      [{ ...targets[0]!, generation: 2 }, "work_changed"],
    ] as const)
      await assert.rejects(
        f.call("message", f.supplement(target)),
        (e: any) => e.code === code,
      );
    const forged = f.supplement(targets[0]!);
    Object.assign(forged.operation, { model: "other" });
    assert.throws(() => f.store.execute(forged, localAccess), /模型和权限/);
    await assert.rejects(
      f.bridge.as({ principalId: "other", actantId: "other" }, () =>
        f.bridge.validateContinuation(targets[0]!),
      ),
      /其他身份/,
    );
    assert.equal(f.store.snapshot().inputs.length, 2);
    assert.equal(
      f.bridge.snapshot({
        principalId: "local-owner",
        actantId: "morphz-agent",
      }).activity!.threads[0]!.continuation,
      undefined,
    );
    assert.equal(f.accepted.size, 2);
    f.threads.get("thread-" + a.entityId).control_state = "paused";
    await assert.rejects(
      f.call("message", f.supplement(targets[0]!)),
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

test("旧 Runtime 不提供假入口，也不把已接受补充重新发送", async () => {
  const f = await fixture();
  try {
    await f.call("message", f.ordinary("报告 A"));
    await f.bridge.tick();
    const target = f.bridge.snapshot().activity!.threads[0]!.continuation!,
      command = f.supplement(target);
    const receipt = await f.call("message", command);
    f.disableDirectedInput();
    await f.bridge.tick();
    assert.equal(f.bridge.supportsDirectedInput, false);
    assert.equal(
      f.bridge.snapshot().activity!.threads[0]!.continuation,
      undefined,
    );
    assert.equal(
      ((await f.connection.call("workspace")) as any).capabilities
        .directedInput,
      false,
    );
    await assert.rejects(
      f.call("message", f.supplement(target, "另一份补充")),
      (e: any) => e.code === "invalid",
    );
    const count = f.attempts.length;
    assert.deepEqual(await f.call("message", command), receipt);
    assert.equal(f.attempts.length, count);
    assert.equal(f.store.snapshot().inputs.length, 2);
  } finally {
    await f.close();
  }
});
