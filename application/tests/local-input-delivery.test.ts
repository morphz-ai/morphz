import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { isFunctionDeclaration, type Node } from "typescript/unstable/ast";
import {
  createLocalInputDelivery,
  type LocalInputDeliveryPorts,
} from "../apps/web/src/data/local-input-delivery.js";
import type { Boot } from "../apps/web/src/client.js";
import type { PlatformClient } from "../apps/web/src/platform-client.js";
import {
  initialWorkspace,
  type Operation,
  type Receipt,
} from "../packages/core/src/model.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import {
  newInputOperation,
  saveInputLocally,
  withSavedInputs,
  type LocalSavedInput,
} from "../apps/web/src/local-saved-inputs.js";
import {
  createLegacyLocalInputDelivery,
  legacyClientSha,
  legacySourceHashes,
  legacyRecordBlock,
  legacyConfirmationBlock,
  type LegacyLocalInputBindings,
} from "./fixtures/local-input-delivery-32c52210.js";

const now = "2026-10-04T00:00:00.000Z";
const id = (n: number) =>
  "10000000-0000-4000-8000-" + String(n).padStart(12, "0");
const scope = (identity: Pick<Boot, "centerId" | "principalId" | "actantId">) =>
  `${identity.centerId}:${identity.principalId}:${identity.actantId}`;
type Input = Extract<Operation, { type: "record-input" }>;
function input(overrides: Partial<Input> = {}): Input {
  return {
    type: "record-input",
    projectId: "first-project",
    artifactId: null,
    artifactRevision: null,
    selection: "",
    body: "冻结正文",
    targetActantId: "morphz-agent",
    ...overrides,
  };
}
function boot(): Boot {
  return {
    centerId: id(99),
    principalId: "local-owner",
    actantId: "local-human",
    csrfToken: "csrf-A",
    workspace: initialWorkspace(now),
    scriptLibrary: [],
    outputs: [],
    scriptOutputs: [],
    runtime: { ...disconnectedRuntime, configured: true },
    capabilities: {
      runtime: true,
      teamAuthentication: false,
      conversationOnFirstInput: true,
      directedInput: true,
      localFiles: false,
      agentDirectories: false,
      modelSettings: false,
      taskCompletion: false,
      browserBookmarks: false,
    },
    activityByProject: {},
    taskRuns: {},
    localSavedInputIds: [],
    localInputSubmissions: {},
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function receipt(commandId = id(1)): Receipt {
  return { commandId, entityId: commandId, workspaceRevision: 1 };
}
type Lane = "fixed" | "owner";
function harness(lane: Lane) {
  const events: unknown[] = [];
  const values = new Map<string, string>();
  const faults: {
    write?: Error;
    remove?: Error;
    removeAfter?: number;
    publish?: Error;
  } = {};
  const storage: Storage = {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      events.push(["write", key, value]);
      if (faults.write) throw faults.write;
      values.set(key, value);
    },
    removeItem(key) {
      events.push(["remove", key]);
      if (faults.remove) {
        if (!faults.removeAfter) throw faults.remove;
        faults.removeAfter--;
      }
      values.delete(key);
    },
    clear: () => values.clear(),
  };
  const original = boot();
  const current = { current: original as Boot | null };
  // Controlled typed transport stand-in. Only the real Client tests establish
  // HTTP/ACL authority; this two-lane test establishes call and ref ordering.
  const source = { boot: original } as unknown as PlatformClient;
  const platform = { current: source as PlatformClient | null };
  const inputSends = { current: new Map<string, Promise<Receipt>>() };
  const snapshotText = { current: "pre-submit" };
  const requests: ReturnType<typeof deferred<Receipt>>[] = [];
  const seen: {
    source: PlatformClient;
    identity: Boot;
    operation: Operation;
  }[] = [];
  const executePlatformOperation: LocalInputDeliveryPorts["executePlatformOperation"] =
    (captured, identity, command, dispatch) => {
      seen.push({ source: captured, identity, operation: command.operation });
      events.push([
        "transport",
        command,
        dispatch,
        captured.boot.csrfToken,
        identity.csrfToken,
      ]);
      const request = deferred<Receipt>();
      requests.push(request);
      return request.promise;
    };
  const setBoot = (value: Boot) => {
    assert.strictEqual(
      current.current,
      value,
      "current is assigned before publication",
    );
    assert.equal(
      snapshotText.current,
      "",
      "snapshot reuse invalidated before publication",
    );
    events.push([
      "publish",
      value.workspace.inputs,
      value.localSavedInputIds,
      value.localInputSubmissions,
    ]);
    if (faults.publish) throw faults.publish;
  };
  const refreshAfterMutation = () => {
    events.push(["refresh"]);
    return Promise.resolve(true);
  };
  const call: LocalInputDeliveryPorts["call"] = async (
    method,
    params,
    options,
  ) => {
    events.push(["call", method, params, options]);
    return undefined;
  };
  const scopedStorage: LegacyLocalInputBindings["scopedStorage"] = (
    capturedScope,
  ) => {
    events.push(["scopedStorage", capturedScope]);
    return {
      readLocal: <T>(_key: string, fallback: T) => fallback,
      readLocalStrict: () => ({ found: false }),
      writeLocal: (key: string, value: unknown) => {
        events.push(["preferenceWrite", key, value]);
      },
      removeLocal: (key: string) => {
        events.push(["preferenceRemove", key]);
      },
    };
  };
  const ports = {
    current,
    inputSends,
    platform,
    snapshotText,
    savedInputScope: scope,
    executePlatformOperation,
    setBoot,
    refreshAfterMutation,
  };
  const owner =
    lane === "owner"
      ? createLocalInputDelivery({
          ...ports,
          storage: () => storage,
          call,
        })
      : undefined;
  const fixed =
    lane === "fixed"
      ? createLegacyLocalInputDelivery({
          ...ports,
          localStorage: storage,
          applicationCall: call,
          scopedStorage,
        })
      : undefined;
  const methods = owner ?? fixed!;
  // The production Client keeps its original async execute and pre-record
  // initialization. This adapter is only the candidate record seam.
  const execute = fixed
    ? fixed.execute
    : async (
        operation: Operation,
        dispatch = false,
        _applicationInstanceId?: string,
        externalCommandId?: string,
        onInputStaged?: (inputId: string) => void,
      ) => {
        if (!current.current) throw new Error("应用尚未就绪，请稍后重试。");
        const identity = current.current;
        scopedStorage(`${identity.centerId}:${identity.principalId}`);
        if (operation.type !== "record-input")
          throw new Error("test targets record input only");
        return owner!.recordInput(
          identity,
          operation,
          dispatch,
          externalCommandId,
          onInputStaged,
        );
      };
  function seed(
    commandId = id(1),
    operation = input(),
    submission?: LocalSavedInput["submission"],
  ) {
    const entry: LocalSavedInput = {
      commandId,
      operation,
      createdAt: now,
      ...(submission ? { submission } : {}),
    };
    saveInputLocally(storage, scope(original), entry);
    events.length = 0;
    return entry;
  }
  const snapshot = () => ({
    events,
    values: [...values.entries()],
    pending: [...inputSends.current.keys()],
    boot: current.current,
    snapshotText: snapshotText.current,
  });
  return {
    ...methods,
    execute,
    owner,
    current,
    original,
    source,
    platform,
    inputSends,
    snapshotText,
    events,
    storage,
    faults,
    values,
    requests,
    seen,
    seed,
    snapshot,
  };
}
async function parity(
  run: (h: ReturnType<typeof harness>) => Promise<unknown> | unknown,
) {
  const old = harness("fixed"),
    candidate = harness("owner");
  const left = await run(old),
    right = await run(candidate);
  assert.deepEqual(right, left);
  assert.deepEqual(candidate.snapshot(), old.snapshot());
}

test("fixed 32c52210 delivery oracle keeps five complete functions and both original blocks", () => {
  assert.deepEqual(legacySourceHashes, {
    sendingInputIds:
      "8a397cb625982b39ec6976b5834e4d8c859410782b1d819d97ee0c96d332ef02",
    publishSavedInputs:
      "04ffdacfd5799e64f0ed21ee4c4f4b76215ef78ce209d1afd31bd44c70f87e4e",
    submitSavedInput:
      "3db6ed7338ca04d5b6183a0a0b70331c3d388b00104438abf4896646dc478fda",
    execute: "632e1d95d6b8c60505a2658e1c812702cdd45f6a705e64f389ec2381b8f11fca",
    dispatchInput:
      "8ca70fe6f7559c75d4d0c792d6ba96e30d49c4839d68f8343f1765d4233cbc28",
    confirm: "bc765397ff1333e9c0dc5a8110c1d5dcea6b83238f7d081316b37578399e29bb",
    record: "89309f544d8ccf1eadc04028325ff44c2596903f2c41c9af4fe1f33aa7e55557",
  });
  assert.equal(
    legacyClientSha,
    "5ef656793c9f70eada0bfc4eb0dcfc54ae4efab2d25eca6fd8d7dbdcdb2c3128",
  );
  const directory = "/local-input-fixed",
    config = directory + "/tsconfig.json";
  const text = readFileSync(
    new URL("./fixtures/local-input-delivery-32c52210.ts", import.meta.url),
    "utf8",
  );
  const api = new API({
    cwd: directory,
    fs: createVirtualFileSystem({
      [directory + "/fixture.ts"]: text,
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true },
        files: ["fixture.ts"],
      }),
    }),
  });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const program = snapshot.getProject(config)!.program;
    assert.deepEqual(program.getSyntacticDiagnostics(), []);
    const source = program.getSourceFile(directory + "/fixture.ts")!;
    const hashes: Record<string, string> = {};
    function visit(node: Node) {
      if (
        isFunctionDeclaration(node) &&
        node.name &&
        node.name.text in legacySourceHashes
      )
        hashes[node.name.text] = createHash("sha256")
          .update(node.getText(source))
          .digest("hex");
      node.forEachChild((child) => {
        visit(child);
      });
    }
    visit(source);
    assert.deepEqual(
      hashes,
      Object.fromEntries(
        Object.entries(legacySourceHashes).filter(
          ([key]) => key !== "record" && key !== "confirm",
        ),
      ),
    );
    assert.equal(
      createHash("sha256").update(legacyRecordBlock).digest("hex"),
      legacySourceHashes.record,
    );
    assert.equal(
      createHash("sha256").update(legacyConfirmationBlock).digest("hex"),
      legacySourceHashes.confirm,
    );
  } finally {
    snapshot.dispose();
  }
});

test("constructor is inert; storage and borrowed refs remain lazy", () => {
  const fail = () => {
    throw new Error("constructor accessed a port");
  };
  const ref = {
    get current(): never {
      return fail();
    },
    set current(_value: unknown) {
      fail();
    },
  };
  const owner = createLocalInputDelivery({
    inputSends: ref,
    current: ref,
    platform: ref,
    snapshotText: ref,
    storage: fail,
    savedInputScope: fail,
    executePlatformOperation: fail,
    setBoot: fail,
    refreshAfterMutation: fail,
    call: fail,
  });
  assert.deepEqual(Object.keys(owner), [
    "readSaved",
    "sendingInputIds",
    "publishSavedInputs",
    "submitSavedInput",
    "recordInput",
    "dispatchInput",
    "confirmAndProject",
  ]);
});

test("save is synchronous inside the owner, freezes dispatch mode and keeps scoped execute ordering", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(now) });
  await parity(async (h) => {
    const promise = h.execute(input(), false, undefined, id(1), (key) =>
      h.events.push(["staged", key]),
    );
    h.events.push(["caller"]);
    assert.equal(h.current.current!.localSavedInputIds[0], id(1));
    assert.equal(
      h.readSaved(h.original)[0]!.operation.dispatchMode,
      "interrupt",
    );
    assert.equal(h.requests.length, 0);
    return await promise;
  });
  const h = harness("owner");
  const value = h.owner!.recordInput(h.original, input(), false, id(2));
  assert.ok(
    !(value instanceof Promise),
    "no async wrapper around synchronous record",
  );
  assert.deepEqual(value, {
    commandId: id(2),
    entityId: id(2),
    workspaceRevision: 0,
  });
});

test("non-Error failure keeps the original fallback and refreshes without awaiting publication success", async () => {
  await parity(async (h) => {
    const entry = h.seed(),
      pending = h.submitSavedInput(h.original, entry);
    await Promise.resolve();
    h.requests[0]!.reject("offline");
    await assert.rejects(pending, (e) => e === "offline");
    assert.deepEqual(h.readSaved(h.original)[0]!.submission, {
      state: "failed",
      error: "发送失败，点击重试。",
    });
    assert.equal(h.inputSends.current.size, 0);
    assert.deepEqual(h.events.slice(-1), [["refresh"]]);
  });
});

test("borrowed refs stay live; source boot CSRF does not add a new local preflight guard", async () => {
  await parity(async (h) => {
    const entry = h.seed();
    const retainedSource = {
      boot: { ...h.original, csrfToken: "transport-old" },
    } as unknown as PlatformClient;
    h.platform.current = retainedSource;
    const sends = new Map<string, Promise<Receipt>>();
    h.inputSends.current = sends;
    const pending = h.submitSavedInput(h.original, entry);
    assert.equal(sends.size, 1);
    await Promise.resolve();
    assert.strictEqual(h.seen[0]!.source, retainedSource);
    assert.equal(h.seen[0]!.identity.csrfToken, "csrf-A");
    h.requests[0]!.resolve(receipt());
    await pending;
    assert.equal(sends.size, 0);
    // This is original invocation behavior at a controlled port, not evidence
    // that actual transport would authorize a stale generation.
  });
});

test("same-key pending lookup and old finally keep original ABA map semantics", async () => {
  await parity(async (h) => {
    const entry = h.seed(),
      key = scope(h.original) + ":" + entry.commandId;
    const first = h.submitSavedInput(h.original, entry);
    await Promise.resolve();
    h.inputSends.current.delete(key);
    h.current.current = null;
    h.current.current = h.original;
    const second = h.submitSavedInput(h.original, entry);
    await Promise.resolve();
    assert.equal(h.requests.length, 2);
    const replacement = h.inputSends.current.get(key);
    assert.ok(replacement);
    assert.notStrictEqual(replacement, h.requests[0]!.promise);
    h.requests[0]!.resolve(receipt());
    await first;
    assert.equal(
      h.inputSends.current.has(key),
      false,
      "no new epoch/instance guard is introduced into original finally",
    );
    h.requests[1]!.resolve(receipt());
    await second;
    assert.equal(h.readSaved(h.original)[0]!.submission?.state, "accepted");
  });
});

test("saved payload mismatches reject without rewriting original bytes; supplements retain omitted parallel compatibility", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(now) });
  await parity(async (h) => {
    const op = input({
      continuation: {
        mode: "supplement",
        inputId: "root",
        threadId: "thread",
        generation: 7,
      },
    });
    h.seed(id(1), newInputOperation(op), {
      state: "failed",
      error: "旧回执丢失",
    });
    const before = [...h.values.entries()];
    await h.execute(op, false, undefined, id(1));
    assert.deepEqual([...h.values.entries()], before);
    for (const changed of [
      { ...op, body: "新正文" },
      { ...op, dispatchMode: "interrupt" as const },
      { ...op, model: "新模型" },
      { ...op, artifactRevision: 2 },
    ]) {
      await assert.rejects(
        h.execute(changed, true, undefined, id(1)),
        /这条消息已保存，请从原消息重试；新草稿未发送。/,
      );
      assert.deepEqual([...h.values.entries()], before);
    }
    return before;
  });
});

test("first locally saved named-conversation input blocks later saves and retries, not unrelated conversations", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(now) });
  await parity(async (h) => {
    h.seed(
      id(1),
      input({ conversationId: "named-A", newConversation: { title: "A" } }),
    );
    const later = h.seed(id(2), input({ conversationId: "named-A" }));
    await assert.rejects(
      h.execute(later.operation, false, undefined, later.commandId),
      /请先发送这段对话中已保存的第一条消息。/,
    );
    await assert.rejects(
      h.dispatchInput(later.commandId),
      /请先发送这段对话中已保存的第一条消息。/,
    );
    await h.execute(
      input({ conversationId: "named-B" }),
      false,
      undefined,
      id(3),
    );
    return h.readSaved(h.original).map((entry) => entry.commandId);
  });
});

test("submit persists and publishes before callback and transport; duplicate key joins before authority check", async () => {
  await parity(async (h) => {
    const entry = h.seed();
    const first = h.submitSavedInput(h.original, entry, (key) =>
      h.events.push(["staged", key]),
    );
    assert.equal(h.requests.length, 0);
    assert.deepEqual(
      h.events.map((event) => (event as unknown[])[0]),
      ["write", "publish", "staged"],
    );
    const raw = h.inputSends.current.get(
      scope(h.original) + ":" + entry.commandId,
    )!;
    h.current.current = null;
    h.platform.current = null;
    const duplicate = h.submitSavedInput(h.original, entry, () =>
      assert.fail("duplicate must not stage twice"),
    );
    await Promise.resolve();
    assert.equal(h.requests.length, 1);
    assert.strictEqual(h.seen[0]!.source, h.source);
    assert.strictEqual(h.seen[0]!.identity, h.original);
    assert.notStrictEqual(
      first,
      raw,
      "original async submit assimilates its raw request",
    );
    h.requests[0]!.resolve(receipt());
    assert.deepEqual(await first, await duplicate);
    assert.equal(h.inputSends.current.size, 0);
    assert.equal(h.readSaved(h.original)[0]!.submission?.state, "accepted");
    assert.equal(
      h.events.some((e) => (e as unknown[])[0] === "refresh"),
      false,
    );
    return await raw;
  });
});

test("failed delivery retains frozen bytes for retry and sends retained legacy missing mode as parallel", async () => {
  await parity(async (h) => {
    const entry = h.seed(id(1), input());
    const first = h.submitSavedInput(h.original, entry);
    await Promise.resolve();
    assert.equal(h.seen[0]!.operation.type, "record-input");
    assert.equal((h.seen[0]!.operation as Input).dispatchMode, "parallel");
    const failure = new Error("真实交付失败");
    h.requests[0]!.reject(failure);
    await assert.rejects(first, (e) => e === failure);
    assert.deepEqual(h.readSaved(h.original)[0]!.submission, {
      state: "failed",
      error: failure.message,
    });
    assert.deepEqual(h.readSaved(h.original)[0]!.operation, entry.operation);
    const next = h.dispatchInput(entry.commandId);
    await Promise.resolve();
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.seen[1]!.operation, h.seen[0]!.operation);
    h.requests[1]!.resolve(receipt());
    await next;
    assert.equal(h.readSaved(h.original)[0]!.submission?.state, "accepted");
    return h.events.filter((e) => (e as unknown[])[0] === "refresh").length;
  });
});

test("fresh dispatch preserves original Promise microtasks, staged callback and captured source across identity replacement", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(now) });
  await parity(async (h) => {
    const pending = h.execute(input(), true, undefined, id(1), () =>
      h.events.push(["staged"]),
    );
    const caller = pending.then(() => {
      h.events.push(["callerThen"]);
    });
    assert.equal(h.requests.length, 0);
    h.current.current = { ...h.original, csrfToken: "csrf-B" };
    h.platform.current = {
      boot: { ...h.original, csrfToken: "csrf-B" },
    } as unknown as PlatformClient;
    await Promise.resolve();
    assert.strictEqual(h.seen[0]!.source, h.source);
    h.requests[0]!.resolve(receipt());
    await caller;
    assert.equal(h.current.current!.csrfToken, "csrf-B");
    assert.equal(
      h.events.filter((e) => (e as unknown[])[0] === "publish").length,
      1,
    );
    assert.equal(
      h.events.filter((e) => (e as unknown[])[0] === "refresh").length,
      0,
    );
    return await pending;
  });
});

test("preflight and persistence failures keep exact errors and partial-work boundary", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(now) });
  await parity(async (h) => {
    const entry = h.seed();
    h.platform.current = null;
    await assert.rejects(
      h.submitSavedInput(h.original, entry),
      /身份已变化，消息未发送。/,
    );
    assert.equal(h.inputSends.current.size, 0);
    h.platform.current = h.source;
    h.current.current = { ...h.original, csrfToken: "csrf-B" };
    await assert.rejects(
      h.submitSavedInput(h.original, entry),
      /身份已变化，消息未发送。/,
    );
    h.current.current = h.original;
    h.faults.write = new Error("disk");
    await assert.rejects(
      h.execute(input(), true, undefined, id(2)),
      /本机暂时无法保存这条消息；编辑框中的内容仍在。/,
    );
    assert.equal(h.requests.length, 0);
    assert.equal(h.inputSends.current.size, 0);
    return h.readSaved(h.original);
  });
});

test("onStaged and publication errors remain before submit try/finally, preserving original pending request", async () => {
  for (const phase of ["staged", "publish"] as const)
    await parity(async (h) => {
      const entry = h.seed(),
        error = new Error(phase);
      if (phase === "publish") h.faults.publish = error;
      const pending = h.submitSavedInput(h.original, entry, () => {
        throw error;
      });
      await assert.rejects(pending, (e) => e === error);
      assert.equal(h.requests.length, 1);
      assert.equal(
        h.inputSends.current.size,
        1,
        "original callback throw does not enter finally",
      );
      h.requests[0]!.resolve(receipt());
      await h.inputSends.current.get(scope(h.original) + ":" + entry.commandId);
      assert.equal(h.readSaved(h.original)[0]!.submission?.state, "sending");
      assert.equal(
        h.events.some((e) => (e as unknown[])[0] === "refresh"),
        false,
      );
    });
});

test("publication strips only former overlay and respects exact CSRF; unknown local project remains stored", async () => {
  await parity((h) => {
    h.seed(id(1));
    h.seed(id(2), input({ projectId: "no-access-project" }));
    const authoritative = withSavedInputs(
      h.original.workspace,
      [
        {
          commandId: id(3),
          createdAt: now,
          operation: input(),
        },
      ],
      h.original,
    ).workspace.inputs[0]!;
    h.current.current = {
      ...h.original,
      workspace: { ...h.original.workspace, inputs: [authoritative] },
    };
    h.publishSavedInputs(h.original);
    assert.deepEqual(
      h.current.current!.workspace.inputs.map((v) => v.id),
      [id(3), id(1)],
    );
    assert.deepEqual(h.current.current!.localSavedInputIds, [id(1)]);
    const prior = h.current.current,
      count = h.events.length;
    h.publishSavedInputs({ ...h.original, csrfToken: "csrf-B" });
    assert.strictEqual(h.current.current, prior);
    assert.equal(h.events.length, count);
    return h.readSaved(h.original).map((entry) => entry.commandId);
  });
});

test("history publication rereads storage and confirms only same ID, principal and actant", async () => {
  await parity((h) => {
    const early = h.readSaved(h.original);
    h.seed(id(1));
    h.seed(id(2));
    h.seed(id(3));
    assert.deepEqual(early, [], "early read is not reused for confirmation");
    const local = h.readSaved(h.original);
    const projected = withSavedInputs(
      h.original.workspace,
      local,
      h.original,
    ).workspace;
    const inputs = projected.inputs.map((value) =>
      value.id === id(2)
        ? { ...value, author: { ...value.author, principalId: "other-human" } }
        : value.id === id(3)
          ? { ...value, author: { ...value.author, actantId: "other-actant" } }
          : value,
    );
    const authoritative = { ...h.original.workspace, inputs };
    const result = h.confirmAndProject(authoritative, h.source);
    assert.deepEqual(
      h.readSaved(h.original).map((v) => v.commandId),
      [id(2), id(3)],
    );
    assert.deepEqual(
      result.localInputIds,
      [],
      "known IDs still suppress overlay independently of confirmation",
    );
    assert.strictEqual(result.workspace.inputs[0], authoritative.inputs[0]);
    return result;
  });
});

test("confirmation failure retains ordered partial removals; corrupt/foreign keys do not obstruct projection", async () => {
  await parity((h) => {
    h.seed();
    h.seed(id(2));
    h.values.set("foreign-key", "garbage");
    h.values.set([...h.values.keys()][0]!.replace(id(1), id(3)), "{broken");
    const real = withSavedInputs(
      h.original.workspace,
      h.readSaved(h.original),
      h.original,
    ).workspace;
    const error = new Error("remove failed");
    h.faults.remove = error;
    h.faults.removeAfter = 1;
    assert.throws(
      () => h.confirmAndProject(real, h.source),
      (e) => e === error,
    );
    assert.equal(h.readSaved(h.original).length, 1);
    assert.equal(h.readSaved(h.original)[0]!.commandId, id(2));
    h.faults.remove = undefined;
    const result = h.confirmAndProject(real, h.source);
    assert.deepEqual(h.readSaved(h.original), []);
    assert.equal(h.values.get("foreign-key"), "garbage");
    return result;
  });
});

test("concurrent history confirmation prevents success or failure from resurrecting the local entry", async () => {
  for (const success of [true, false])
    await parity(async (h) => {
      const entry = h.seed(),
        pending = h.submitSavedInput(h.original, entry);
      await Promise.resolve();
      const confirmed = withSavedInputs(
        h.original.workspace,
        [entry],
        h.original,
      ).workspace;
      h.confirmAndProject(confirmed, h.source);
      assert.deepEqual(h.readSaved(h.original), []);
      if (success) {
        h.requests[0]!.resolve(receipt());
        await pending;
      } else {
        h.requests[0]!.reject("non-Error failure");
        await assert.rejects(pending, (e) => e === "non-Error failure");
      }
      assert.deepEqual(h.readSaved(h.original), []);
      assert.equal(h.inputSends.current.size, 0);
    });
});

test("dispatch local readiness guards remain separate from remote input.send and its awaited refresh", async () => {
  await parity(async (h) => {
    const entry = h.seed();
    h.current.current = { ...h.original, runtime: disconnectedRuntime };
    await assert.rejects(
      h.dispatchInput(entry.commandId),
      /连接 Agent 后才能发送这条本机保存的消息。/,
    );
    assert.equal(h.requests.length, 0);
    await h.dispatchInput("remote-input");
    assert.deepEqual(h.events.slice(-2), [
      ["call", "input.send", "remote-input", { identityGeneration: "csrf-A" }],
      ["refresh"],
    ]);
    h.current.current = null;
    await assert.rejects(
      h.dispatchInput(entry.commandId),
      /应用尚未就绪，请稍后重试。/,
    );
    await assert.rejects(
      h.execute(input(), false),
      /应用尚未就绪，请稍后重试。/,
    );
  });
});

test("sending IDs remain center/principal/actant scoped and rendering replaces orphan sending only in projection", async () => {
  await parity((h) => {
    const entry = h.seed(id(1), input(), { state: "sending" });
    const currentKey = scope(h.original) + ":";
    h.inputSends.current.set(currentKey + id(1), Promise.resolve(receipt()));
    h.inputSends.current.set(
      scope({ ...h.original, actantId: "other" }) + ":" + id(2),
      Promise.resolve(receipt(id(2))),
    );
    assert.deepEqual([...h.sendingInputIds(h.original)], [id(1)]);
    h.publishSavedInputs(h.original);
    assert.equal(
      h.current.current!.localInputSubmissions[id(1)]!.state,
      "sending",
    );
    h.inputSends.current.delete(currentKey + id(1));
    h.publishSavedInputs(h.original);
    assert.deepEqual(h.current.current!.localInputSubmissions[id(1)], {
      state: "failed",
      error: "发送结果待确认，点击重试。",
    });
    assert.deepEqual(h.readSaved(h.original)[0]!.submission, entry.submission);
    return [...h.sendingInputIds(h.original)];
  });
});
