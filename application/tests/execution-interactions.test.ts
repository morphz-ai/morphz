import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { isFunctionDeclaration, type Node } from "typescript/unstable/ast";
import {
  createExecutionInteractions,
  type ExecutionInteractionPorts,
} from "../apps/web/src/data/execution-interactions.js";
import {
  createFixedExecutionInteractions,
  legacyExecutionClientSha,
  legacyExecutionSourceHashes,
} from "./fixtures/execution-interactions-51f9101e.js";
import type { Boot } from "../apps/web/src/client.js";
import { initialWorkspace } from "../packages/core/src/model.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import type {
  ExecutionControl,
  ExecutionScope,
} from "../packages/core/src/execution.js";

const fixedHashes = {
  cancelInput:
    "e2fcdb5a456411526851f77347ae7e9cb3edcd91f6a5f576433e7e9fe2ade0c8",
  executionSnapshot:
    "27095ecdf2c8bef7939e3c5fd5c8c764612dfebccaeaab4963a4d8d955777411",
  executionResult:
    "8ee153277bd996ab4ff57c91c17c96640661fa6fc1a4930963244fb99f502a54",
  controlExecution:
    "d0475fb63d6bcd4afa17a17c56e135d8ca5d1e0f3da00eb0ea0acbef66946d6d",
  approvalSubmitted:
    "437a5679224991d49672cf83b9c1f9e8edd288c695a0da987c61e749ea24d409",
};
const scope: ExecutionScope = {
  projectId: "project",
  artifactId: null,
  conversationId: "conversation",
  inputId: "input",
  threadId: "thread",
};
const fingerprint = "a".repeat(64);
function approval(
  type: "allow-once" | "deny" = "allow-once",
  id = "approval",
  hash = fingerprint,
): ExecutionControl {
  return { scope, action: { type, approvalId: id, fingerprint: hash } };
}
function boot(csrfToken = "csrf-A"): Boot {
  return {
    centerId: "center",
    principalId: "human",
    actantId: "actant",
    csrfToken,
    workspace: initialWorkspace("2026-10-04T00:00:00.000Z"),
    scriptLibrary: [],
    outputs: [],
    scriptOutputs: [],
    runtime: disconnectedRuntime,
    activityByProject: {},
    taskRuns: {},
    localSavedInputIds: [],
    localInputSubmissions: {},
    capabilities: {
      runtime: false,
      teamAuthentication: false,
      conversationOnFirstInput: false,
      directedInput: false,
      localFiles: false,
      agentDirectories: false,
      modelSettings: false,
      taskCompletion: false,
      browserBookmarks: false,
    },
  };
}
function deferred<T = unknown>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const factories = [
  createFixedExecutionInteractions,
  createExecutionInteractions,
];
function harness(factory: typeof createExecutionInteractions) {
  const events: unknown[] = [];
  let value: Boot | null = boot(),
    version = 0;
  const current = {
    get current() {
      events.push(["current", value?.csrfToken ?? null]);
      return value;
    },
    set current(next: Boot | null) {
      value = next;
    },
  };
  class Ledger extends Set<string> {
    override has(key: string) {
      events.push(["has", key]);
      return super.has(key);
    }
    override add(key: string) {
      events.push(["add", key]);
      return super.add(key);
    }
  }
  const ledger = new Ledger();
  let entries: Set<string> = ledger;
  const approvalSubmissions = {
    get current() {
      events.push(["ledger-ref"]);
      return entries;
    },
    set current(next: Set<string>) {
      entries = next;
    },
  };
  const callbacks: {
    update?: () => void;
    call?: (method: string) => void;
  } = {};
  const calls: {
    method: string;
    params: unknown;
    signal?: AbortSignal;
    identity?: string;
    pending: ReturnType<typeof deferred>;
  }[] = [];
  const refreshes: ReturnType<typeof deferred<boolean>>[] = [];
  const ports: ExecutionInteractionPorts = {
    current,
    approvalSubmissions,
    updateApprovalSubmissions(action) {
      version = typeof action === "function" ? action(version) : action;
      events.push(["counter", version]);
      callbacks.update?.();
    },
    call(method, params, options) {
      events.push([
        "rpc",
        method,
        params,
        Object.keys(options ?? {}),
        options?.identityGeneration,
      ]);
      callbacks.call?.(method);
      const pending = deferred();
      calls.push({
        method,
        params,
        signal: options?.signal,
        identity: options?.identityGeneration,
        pending,
      });
      return pending.promise;
    },
    refreshAfterMutation() {
      events.push(["refresh"]);
      const pending = deferred<boolean>();
      refreshes.push(pending);
      return pending.promise;
    },
  };
  const commands = factory(ports);
  const snapshot = () => ({ events, value, version, ledger: [...entries] });
  return {
    commands,
    ports,
    current,
    approvalSubmissions,
    callbacks,
    calls,
    refreshes,
    events,
    snapshot,
    factory,
    rawCurrent: () => value,
  };
}
async function parity(
  run: (h: ReturnType<typeof harness>) => unknown | Promise<unknown>,
) {
  const fixed = harness(createFixedExecutionInteractions),
    owner = harness(createExecutionInteractions);
  const expected = await run(fixed),
    actual = await run(owner);
  assert.deepEqual(actual, expected);
  assert.deepEqual(owner.snapshot(), fixed.snapshot());
}
function instrumentSignals(t: TestContext) {
  const timeouts: { ms: number; controller: AbortController }[] = [];
  const combinations: { parents: AbortSignal[]; signal: AbortSignal }[] = [];
  const any = AbortSignal.any;
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    const controller = new AbortController();
    timeouts.push({ ms, controller });
    return controller.signal;
  });
  t.mock.method(AbortSignal, "any", (sources: AbortSignal[]) => {
    const signal = any(sources);
    combinations.push({ parents: [...sources], signal });
    return signal;
  });
  return { timeouts, combinations };
}
function rawHashes(text: string) {
  const dir = "/execution-fixed",
    config = dir + "/tsconfig.json";
  const api = new API({
    cwd: dir,
    fs: createVirtualFileSystem({
      [dir + "/source.ts"]: text,
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true },
        files: ["source.ts"],
      }),
    }),
  });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const program = snapshot.getProject(config)!.program;
    assert.deepEqual(program.getSyntacticDiagnostics(), []);
    const source = program.getSourceFile(dir + "/source.ts")!;
    const hashes: Record<string, string> = {};
    function visit(node: Node) {
      if (
        isFunctionDeclaration(node) &&
        node.name &&
        node.name.text in fixedHashes
      )
        hashes[node.name.text] = createHash("sha256")
          .update(node.getText(source))
          .digest("hex");
      node.forEachChild((child) => {
        visit(child);
      });
    }
    visit(source);
    return hashes;
  } finally {
    snapshot.dispose();
  }
}

test("fixed actual Git51f five complete raw algorithms match both oracle and candidate", () => {
  assert.equal(
    legacyExecutionClientSha,
    "effed98cb46cd9ab9ed968a1877ba3c363c2496ab6ca87bd243bd2034225c679",
  );
  assert.deepEqual(legacyExecutionSourceHashes, fixedHashes);
  for (const path of [
    "./fixtures/execution-interactions-51f9101e.ts",
    "../apps/web/src/data/execution-interactions.ts",
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.deepEqual(rawHashes(source), fixedHashes);
  }
  const old = readFileSync(
    new URL("./fixtures/execution-interactions-51f9101e.ts", import.meta.url),
    "utf8",
  );
  const changed = old.replace(
    "approvalSubmissions.current.add(key);",
    "approvalSubmissions.current.delete(key);",
  );
  assert.notEqual(changed, old);
  assert.throws(
    () => assert.deepEqual(rawHashes(changed), fixedHashes),
    assert.AssertionError,
  );
});

test("constructor borrows ports without current, Set, callback, transport or refresh access", () => {
  const fail = () => {
    throw new Error("construction performed work");
  };
  const ref = {
    get current(): never {
      return fail();
    },
  };
  for (const factory of factories) {
    const commands = factory({
      current: ref,
      approvalSubmissions: ref,
      updateApprovalSubmissions: fail,
      call: fail,
      refreshAfterMutation: fail,
    });
    assert.deepEqual(Object.keys(commands), [
      "cancelInput",
      "executionSnapshot",
      "executionResult",
      "controlExecution",
      "approvalSubmitted",
    ]);
  }
});

test("shared approval ledger writes exact key then counter before RPC; second surface cannot submit duplicate", async (t) => {
  const { timeouts } = instrumentSignals(t);
  await parity(async (h) => {
    const command = approval();
    const pending = h.commands.controlExecution(command);
    assert.equal(h.calls.length, 1);
    assert.strictEqual(h.calls[0]!.params, command);
    const order = h.events.filter((e) =>
      ["has", "add", "counter", "rpc"].includes((e as string[])[0]!),
    );
    assert.deepEqual(
      order.map((e) => (e as string[])[0]),
      ["has", "add", "counter", "rpc"],
    );
    assert.equal(h.commands.approvalSubmitted("approval", fingerprint), true);
    const secondSurface = h.factory(h.ports);
    await assert.rejects(
      secondSurface.controlExecution(approval("deny")),
      /本次审批已提交，请核对最新执行状态，不要重复批准。/,
    );
    assert.equal(h.calls.length, 1);
    h.calls[0]!.pending.resolve({ accepted: true });
    assert.deepEqual(await pending, { accepted: true });
    assert.equal(h.refreshes.length, 0);
    return order;
  });
  assert.deepEqual(
    timeouts.map((x) => x.ms),
    [12000, 12000],
  );
});

test("uncertain and definitive rejection stay locked; new fingerprint, approval ID or CSRF is a new key", async (t) => {
  instrumentSignals(t);
  await parity(async (h) => {
    const first = h.commands.controlExecution(approval());
    const error = new Error("503，回执未知");
    h.calls[0]!.pending.reject(error);
    await assert.rejects(first, (cause) => cause === error);
    assert.equal(h.commands.approvalSubmitted("approval", fingerprint), true);
    await assert.rejects(
      h.commands.controlExecution(approval()),
      /本次审批已提交/,
    );
    const candidates = [
      approval("deny", "approval", "b".repeat(64)),
      approval("allow-once", "another-id"),
    ];
    for (const command of candidates) {
      const pending = h.commands.controlExecution(command);
      h.calls.at(-1)!.pending.reject("403，明确拒绝");
      await assert.rejects(pending, (cause) => cause === "403，明确拒绝");
      if (
        command.action.type === "allow-once" ||
        command.action.type === "deny"
      )
        assert.equal(
          h.commands.approvalSubmitted(
            command.action.approvalId,
            command.action.fingerprint,
          ),
          true,
        );
    }
    h.current.current = boot("csrf-B");
    assert.equal(h.commands.approvalSubmitted("approval", fingerprint), false);
    const afterSwitch = h.commands.controlExecution(approval());
    h.calls.at(-1)!.pending.resolve("B");
    assert.equal(await afterSwitch, "B");
    h.current.current = boot("csrf-A");
    assert.equal(
      h.commands.approvalSubmitted("approval", fingerprint),
      true,
      "identity switch does not clear the retained original Set",
    );
    assert.equal(h.refreshes.length, 0);
  });
});

test("composed snapshot deadline forwards original timeout reason without another request", async (t) => {
  const { timeouts } = instrumentSignals(t);
  await parity(async (h) => {
    const caller = new AbortController();
    const pending = h.commands.executionSnapshot(scope, caller.signal);
    const error = new DOMException("deadline", "TimeoutError");
    timeouts.at(-1)!.controller.abort(error);
    assert.equal(caller.signal.aborted, false);
    assert.equal(h.calls[0]!.signal!.aborted, true);
    assert.strictEqual(h.calls[0]!.signal!.reason, error);
    h.calls[0]!.pending.reject(error);
    await assert.rejects(pending, (cause) => cause === error);
    assert.equal(h.calls.length, 1);
    assert.equal(h.refreshes.length, 0);
  });
});

test("ordinary thread/job control does not register approval, refresh, parse receipt or suppress repeated calls", async (t) => {
  instrumentSignals(t);
  await parity(async (h) => {
    for (const action of [
      { type: "cancel-thread" as const, threadId: "thread", revision: 7 },
      { type: "cancel-job" as const, jobId: "job", revision: 3 },
    ]) {
      const command = { scope, action };
      for (let n = 0; n < 2; n++) {
        const pending = h.commands.controlExecution(command);
        assert.strictEqual(h.calls.at(-1)!.params, command);
        const receipt = { accepted: true, cancelRequested: true, tag: n };
        h.calls.at(-1)!.pending.resolve(receipt);
        assert.strictEqual(await pending, receipt);
      }
    }
    assert.equal(h.snapshot().version, 0);
    assert.deepEqual(h.snapshot().ledger, []);
    assert.equal(h.refreshes.length, 0);
  });
});

test("live repeated ref reads preserve counter-side identity change and borrowed Set replacement", async (t) => {
  instrumentSignals(t);
  await parity(async (h) => {
    h.callbacks.update = () => {
      h.current.current = boot("csrf-B");
    };
    const pending = h.commands.controlExecution(approval());
    assert.deepEqual(h.snapshot().ledger, [
      JSON.stringify(["csrf-A", "approval", fingerprint]),
    ]);
    assert.equal(
      h.calls[0]!.identity,
      "csrf-B",
      "RPC re-reads current after original feedback setter",
    );
    h.calls[0]!.pending.resolve("receipt");
    await pending;
    assert.equal(h.commands.approvalSubmitted("approval", fingerprint), false);
    const next = new Set([JSON.stringify(["csrf-B", "approval", fingerprint])]);
    h.approvalSubmissions.current = next;
    assert.equal(h.commands.approvalSubmitted("approval", fingerprint), true);
    assert.strictEqual(h.approvalSubmissions.current, next);
  });
});

test("counter failure leaves original approval attempt registered and sends no RPC", async () => {
  await parity(async (h) => {
    const error = new Error("feedback failure");
    h.callbacks.update = () => {
      throw error;
    };
    await assert.rejects(
      h.commands.controlExecution(approval()),
      (cause) => cause === error,
    );
    assert.equal(h.calls.length, 0);
    assert.equal(h.commands.approvalSubmitted("approval", fingerprint), true);
    await assert.rejects(
      h.commands.controlExecution(approval()),
      /本次审批已提交/,
    );
  });
});

test("cancel has exact 8s RPC and awaits refresh only after successful receipt", async (t) => {
  const { timeouts } = instrumentSignals(t);
  await parity(async (h) => {
    let settled = false;
    const pending = h.commands.cancelInput("saved-input").then(() => {
      settled = true;
      h.events.push(["callerThen"]);
    });
    assert.equal(h.calls[0]!.method, "input.cancel");
    assert.equal(h.calls[0]!.identity, "csrf-A");
    assert.equal(h.refreshes.length, 0);
    h.calls[0]!.pending.resolve({ accepted: true });
    await Promise.resolve();
    assert.equal(h.refreshes.length, 1);
    assert.equal(settled, false);
    h.current.current = boot("csrf-B");
    h.refreshes[0]!.resolve(false);
    await pending;
    assert.equal(
      settled,
      true,
      "false refresh result does not add a new rejection",
    );
    const failure = new Error("取消未确认"),
      failed = h.commands.cancelInput("second-input");
    h.calls[1]!.pending.reject(failure);
    await assert.rejects(failed, (cause) => cause === failure);
    assert.equal(h.refreshes.length, 1);
  });
  assert.deepEqual(
    timeouts.map((x) => x.ms),
    [8000, 8000, 8000, 8000],
  );
});

test("cancel refresh failure is returned as original error after one request", async (t) => {
  instrumentSignals(t);
  await parity(async (h) => {
    const pending = h.commands.cancelInput("input");
    h.calls[0]!.pending.resolve({});
    await Promise.resolve();
    const error = new Error("刷新失败");
    h.refreshes[0]!.reject(error);
    await assert.rejects(pending, (cause) => cause === error);
    assert.equal(h.calls.length, 1);
  });
});

test("unready control/cancel keep exact errors; null approval getter is synchronous and does not clear old keys", async () => {
  await parity(async (h) => {
    h.current.current = null;
    await assert.rejects(
      h.commands.cancelInput("input"),
      /应用尚未就绪，请稍后重试。/,
    );
    await assert.rejects(
      h.commands.controlExecution(approval()),
      /应用尚未就绪，请稍后重试。/,
    );
    assert.equal(h.calls.length, 0);
    h.approvalSubmissions.current.add(
      JSON.stringify([undefined, "approval", fingerprint]),
    );
    assert.equal(h.commands.approvalSubmitted("approval", fingerprint), true);
  });
});

test("snapshot composes caller cancellation with 12s deadline without identity reads or publication", async (t) => {
  const { timeouts, combinations } = instrumentSignals(t);
  await parity(async (h) => {
    h.current.current = null;
    const caller = new AbortController();
    const pending = h.commands.executionSnapshot(scope, caller.signal);
    const call = h.calls[0]!,
      combination = combinations.at(-1)!;
    assert.strictEqual(call.params, scope);
    assert.strictEqual(combination.parents[0], caller.signal);
    assert.strictEqual(
      combination.parents[1],
      timeouts.at(-1)!.controller.signal,
    );
    assert.strictEqual(call.signal, combination.signal);
    assert.equal(
      call.identity,
      undefined,
      "keep default transport authority semantics",
    );
    const error = new DOMException("caller cancelled", "AbortError");
    caller.abort(error);
    assert.equal(call.signal!.aborted, true);
    assert.strictEqual(call.signal!.reason, error);
    call.pending.reject(error);
    await assert.rejects(pending, (cause) => cause === error);
    assert.equal(
      h.events.some((e) => (e as string[])[0] === "current"),
      false,
    );
    assert.equal(h.refreshes.length, 0);
  });
  assert.deepEqual(
    timeouts.map((x) => x.ms),
    [12000, 12000],
  );
});

test("snapshot no-caller deadline and result 12s remain independent; schema defaults/unknown fields keep old parsing", async (t) => {
  const { timeouts, combinations } = instrumentSignals(t);
  await parity(async (h) => {
    const snapshot = h.commands.executionSnapshot(scope);
    assert.strictEqual(h.calls[0]!.signal, timeouts.at(-1)!.controller.signal);
    h.calls[0]!.pending.resolve({
      jobs: [],
      approvals: [],
      limit: 0,
      unexpected: "drop",
    });
    assert.deepEqual(await snapshot, { jobs: [], approvals: [], limit: 0 });
    const result = h.commands.executionResult(scope, "job");
    assert.deepEqual(h.calls[1]!.params, { scope, jobId: "job" });
    assert.strictEqual(
      (h.calls[1]!.params as { scope: ExecutionScope }).scope,
      scope,
    );
    h.calls[1]!.pending.resolve({
      text: "",
      truncated: true,
      available: false,
      extra: "drop",
    });
    assert.deepEqual(await result, {
      text: "",
      truncated: true,
      available: false,
    });
    assert.equal(h.calls[1]!.identity, undefined);
    assert.equal(h.snapshot().version, 0);
    assert.equal(h.refreshes.length, 0);
  });
  assert.deepEqual(
    timeouts.map((x) => x.ms),
    [12000, 12000, 12000, 12000],
  );
  assert.equal(combinations.length, 0);
});

test("invalid query schema and transport failures return original errors without retry or invented idle/result", async (t) => {
  instrumentSignals(t);
  await parity(async (h) => {
    const snapshot = h.commands.executionSnapshot(scope);
    h.calls[0]!.pending.resolve({ jobs: [], approvals: [], limit: "wrong" });
    await assert.rejects(
      snapshot,
      (cause: unknown) => cause instanceof Error && cause.name === "ZodError",
    );
    const result = h.commands.executionResult(scope, "job");
    h.calls[1]!.pending.resolve({
      text: 12,
      truncated: false,
      available: true,
    });
    await assert.rejects(
      result,
      (cause: unknown) => cause instanceof Error && cause.name === "ZodError",
    );
    const third = h.commands.executionResult(scope, "other");
    const error = new Error("RPC拒绝");
    h.calls[2]!.pending.reject(error);
    await assert.rejects(third, (cause) => cause === error);
    assert.equal(h.calls.length, 3);
    assert.equal(h.refreshes.length, 0);
  });
});
