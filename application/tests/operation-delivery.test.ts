import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createOperationDelivery,
  operationMayCommitBeforeError,
  UnsentOperationError,
  type OperationDeliveryPorts,
} from "../apps/web/src/data/operation-delivery.js";
import { executePlatformOperation, type Boot } from "../apps/web/src/client.js";
import { RequestError } from "../apps/web/src/application-transport.js";
import { draftKey } from "../apps/web/src/local-preferences.js";
import { applicationStoragePrefix } from "../packages/core/src/application-names.js";
import {
  taskContentSchema,
  type Operation,
  type Receipt,
} from "../packages/core/src/model.js";
import type { PlatformClient } from "../apps/web/src/platform-client.js";
import {
  createFixedOperationDelivery,
  FixedUnsentOperationError,
  fixedExecutePlatformOperation,
  operationMayCommitBeforeError as fixedClassifier,
} from "./fixtures/operation-delivery-618fc8b9.js";

// Controlled ports/storage exercise real current delivery, not HTTP/ACL or
// original App. Only the explicit migration mode executes the fixed old lane.
const migration =
  process.env.MORPHZ_TEST_OPERATION_DELIVERY_MIGRATION_EQUIVALENCE === "1";
const project: Operation = { type: "create-project", title: "确切项目" };
const document: Operation = {
  type: "create-artifact",
  projectId: "project",
  title: "确切文档",
  content: { kind: "document", markdown: "原文" },
};
const boot = (principalId = "human", centerId = "center", csrfToken = "csrf") =>
  ({
    centerId,
    principalId,
    actantId: principalId + "-actant",
    csrfToken,
    workspace: { revision: 7, artifacts: [] },
  }) as unknown as Boot;
const defer = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function until(ready: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!ready()) {
    assert.ok(
      Date.now() < deadline,
      "controlled delivery phase must be reached",
    );
    await new Promise<void>((done) => setImmediate(done));
  }
}
const expectedKey = (
  identity: Boot,
  operation: Operation,
  dispatch = false,
  applicationInstanceId?: string,
  externalCommandId?: string,
) =>
  applicationStoragePrefix +
  identity.centerId +
  ":" +
  identity.principalId +
  ":" +
  draftKey(
    "pending:" +
      createHash("sha256")
        .update(
          JSON.stringify({
            operation,
            dispatch,
            applicationInstanceId,
            externalCommandId,
          }),
        )
        .digest("hex"),
  );
type Environment = {
  rows: Map<string, string>;
  events: unknown[];
  writes: number;
  failWrite?: number;
  digest?: () => Promise<void>;
};
async function environment<T>(run: (value: Environment) => Promise<T>) {
  const descriptors = ["localStorage", "crypto"].map((name) => ({
    name,
    descriptor: Object.getOwnPropertyDescriptor(globalThis, name),
  }));
  const nativeCrypto = globalThis.crypto;
  const value: Environment = { rows: new Map(), events: [], writes: 0 };
  const storage: Storage = {
    get length() {
      return value.rows.size;
    },
    key(n) {
      return [...value.rows.keys()][n] ?? null;
    },
    clear() {
      value.rows.clear();
    },
    getItem(key) {
      value.events.push(["read", key]);
      return value.rows.get(key) ?? null;
    },
    setItem(key, text) {
      value.events.push(["write", key, JSON.parse(text)]);
      if (++value.writes === value.failWrite)
        throw Error("TEST storage write failed");
      value.rows.set(key, text);
    },
    removeItem() {
      assert.fail("delivery retains the original null write, not remove");
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      randomUUID() {
        value.events.push(["uuid"]);
        return "00000000-0000-4000-8000-000000000099";
      },
      subtle: {
        async digest(algorithm: AlgorithmIdentifier, data: BufferSource) {
          value.events.push([
            "digest",
            algorithm,
            new TextDecoder().decode(data),
          ]);
          await value.digest?.();
          return nativeCrypto.subtle.digest(algorithm, data);
        },
      },
    },
  });
  try {
    return await run(value);
  } finally {
    descriptors.forEach(({ name, descriptor }) => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}
const factory = (old: boolean) =>
  old ? createFixedOperationDelivery : createOperationDelivery;
const unsent = (old: boolean) =>
  old ? FixedUnsentOperationError : UnsentOperationError;
async function compare<T>(run: (old: boolean) => Promise<T>) {
  const current = await run(false);
  if (migration)
    assert.deepEqual(
      current,
      await run(true),
      "explicit whole old/current delivery ledger",
    );
  return current;
}
function ports(
  value: Environment,
  changes: Partial<OperationDeliveryPorts> = {},
): OperationDeliveryPorts {
  const identity = boot();
  return {
    current: { current: identity },
    platform: {
      current: { boot: { csrfToken: identity.csrfToken } } as PlatformClient,
    },
    localInputDelivery: {
      recordInput: () => {
        assert.fail("unexpected generic input path");
      },
    },
    executePlatformOperation: async (_source, captured, command, dispatch) => {
      value.events.push(["dispatch", captured.principalId, command, dispatch]);
      return {
        commandId: command.commandId,
        entityId: command.commandId,
        workspaceRevision: 8,
      };
    },
    refreshAfterMutation: async () => {
      value.events.push(["refresh"]);
      return true;
    },
    ...changes,
  };
}

test("durable construction is inert and record-input delegates before generic hash/pending/refresh", async () => {
  await compare((old) =>
    environment(async (value) => {
      const borrowed = {
        get current(): Boot | null {
          value.events.push(["current"]);
          return null;
        },
      };
      const input = factory(old)({
        ...ports(value),
        current: borrowed,
        platform: {
          get current() {
            value.events.push(["platform"]);
            return null;
          },
        },
      });
      assert.deepEqual(Object.keys(input), ["execute"]);
      assert.deepEqual(value.events, []);
      await assert.rejects(input.execute(project), {
        message: "应用尚未就绪，请稍后重试。",
      });
      assert.deepEqual(value.events, [["current"]]);
      value.events.length = 0;
      const identity = boot(),
        receipt: Receipt = {
          commandId: "input",
          entityId: "input",
          workspaceRevision: 8,
        },
        staged = () => {};
      const operation = {
        type: "record-input",
        projectId: "project",
        artifactId: null,
        artifactRevision: null,
        selection: "",
        body: "输入",
        targetActantId: "morphz-agent",
      } satisfies Extract<Operation, { type: "record-input" }>;
      const owner = factory(old)(
        ports(value, {
          current: { current: identity },
          localInputDelivery: {
            recordInput: (captured, given, dispatch, id, callback) => {
              assert.equal(captured, identity);
              assert.equal(given, operation);
              assert.equal(callback, staged);
              value.events.push(["record", dispatch, id]);
              return receipt;
            },
          },
        }),
      );
      assert.equal(
        await owner.execute(
          operation,
          true,
          "ignored-input-instance",
          "input-external",
          staged,
        ),
        receipt,
      );
      assert.deepEqual(value.events, [["record", true, "input-external"]]);
      assert.equal(value.rows.size, 0);
      return value.events;
    }),
  );
});

test("exact four-field SHA key and captured center/principal storage retain the whole saved command across remount", async () => {
  await compare((old) =>
    environment(async (value) => {
      const identity = boot(),
        key = expectedKey(identity, project, true, "instance", "external"),
        saved = {
          commandId: "saved-id",
          operation: { type: "create-project", title: "saved entire command" },
          applicationInstanceId: "saved-instance",
          extra: "original saved field",
        };
      value.rows.set(key, JSON.stringify(saved));
      const held = Error("TEST unknown lost reply"),
        captured: unknown[] = [];
      const shared = ports(value, {
        current: { current: identity },
        executePlatformOperation: async (source, origin, command, dispatch) => {
          assert.equal(origin, identity);
          assert.equal(source, shared.platform.current);
          captured.push(command);
          assert.equal(dispatch, true);
          throw held;
        },
      });
      await assert.rejects(
        factory(old)(shared).execute(project, true, "instance", "external"),
        (e) => e === held,
      );
      await assert.rejects(
        factory(old)(shared).execute(project, true, "instance", "external"),
        (e) => e === held,
      );
      assert.deepEqual(captured.slice(), [saved, saved]);
      assert.deepEqual(JSON.parse(value.rows.get(key)!), saved);
      const other = ports(value, {
        current: { current: boot("second") },
        executePlatformOperation: async (_source, _origin, command) => {
          captured.push(command);
          throw held;
        },
      });
      await assert.rejects(
        factory(old)(other).execute(project, true, "instance", "external"),
      );
      assert.equal(
        value.rows.size,
        2,
        "another principal has separate whole pending",
      );
      const phases = value.events as unknown[][];
      assert.deepEqual(
        phases
          .filter((event) => event[0] === "digest")
          .map((event) => event[2]),
        Array(3).fill(
          JSON.stringify({
            operation: project,
            dispatch: true,
            applicationInstanceId: "instance",
            externalCommandId: "external",
          }),
        ),
      );
      return { rows: [...value.rows], captured, events: value.events };
    }),
  );
});

test("preflight storage and exact captured checks run before dispatch, with original exception boundaries", async () => {
  await compare(async (old) => {
    const ledgers: unknown[] = [];
    for (const mode of ["digest", "write", "identity", "source"] as const)
      ledgers.push(
        await environment(async (value) => {
          const current = { current: boot() },
            shared = ports(value, { current });
          if (mode === "digest")
            value.digest = async () => {
              throw Error("TEST digest failure");
            };
          if (mode === "write") value.failWrite = 1;
          if (mode === "identity")
            value.digest = async () => {
              current.current = boot("other", "center", "new-csrf");
            };
          if (mode === "source") shared.platform = { current: null };
          const error = await factory(old)(shared)
            .execute(project, false, undefined, "external")
            .then(
              () => assert.fail("expected preflight rejection"),
              (e: unknown) => e,
            );
          assert(error instanceof Error);
          assert.equal(
            value.events.some(
              (event) =>
                (event as string[])[0] === "dispatch" ||
                (event as string[])[0] === "refresh",
            ),
            false,
          );
          assert.equal(value.rows.size, mode === "source" ? 1 : 0);
          if (mode === "identity")
            assert.equal(error.message, "身份已切换，操作未发送。");
          if (mode === "source")
            assert.equal(error.message, "身份已变化，操作未发送。");
          return {
            mode,
            error: error.message,
            events: value.events,
            rows: [...value.rows],
          };
        }),
      );
    return ledgers;
  });
});

test("same Unsent class, complete may-commit classifier and RequestError status preserve exact pending/error/refresh policy", async () => {
  await compare(async (old) => {
    const classifier = old ? fixedClassifier : operationMayCommitBeforeError;
    const yes = [
      { type: "install-application" },
      { type: "launch-application" },
      { type: "set-application-state" },
      { type: "close-application" },
      { type: "update-project", state: "archived" },
      { type: "organize-content", changes: { title: "" } },
      { type: "script-command" },
      { type: "import-document" },
      ...["create-artifact", "revise-artifact"].flatMap((type) =>
        ["document", "image", "interactive"].map((kind) => ({
          type,
          content: { kind },
        })),
      ),
    ];
    const no = [
      { type: "create-project" },
      { type: "update-project", title: "rename" },
      { type: "organize-content", changes: { projectId: "move" } },
      { type: "create-artifact", content: { kind: "task" } },
    ];
    yes.forEach((operation) =>
      assert.equal(classifier(operation as Operation), true),
    );
    no.forEach((operation) =>
      assert.equal(classifier(operation as Operation), false),
    );
    const ledgers: unknown[] = [];
    for (const mode of [
      "unsent",
      "ordinary",
      "400",
      "403",
      "409",
      "408",
      "500",
      "may-commit-409",
    ])
      ledgers.push(
        await environment(async (value) => {
          const operation = mode === "may-commit-409" ? document : project;
          const error =
            mode === "unsent"
              ? new (unsent(old))("not sent")
              : mode === "ordinary"
                ? Error("ordinary")
                : new RequestError(
                    Number(mode.replace("may-commit-", "")),
                    "request",
                  );
          const owner = factory(old)(
            ports(value, {
              executePlatformOperation: async () => {
                value.events.push(["dispatch"]);
                throw error;
              },
            }),
          );
          await assert.rejects(
            owner.execute(operation, false, undefined, "external"),
            (e) => e === error,
          );
          const pending = [...value.rows.values()].map((text) =>
            JSON.parse(text),
          );
          const cleared =
            mode === "unsent" || ["400", "403", "409"].includes(mode);
          assert.equal(pending[0] === null, cleared);
          assert.equal(
            value.events.filter((event) => (event as string[])[0] === "refresh")
              .length,
            error instanceof RequestError ? 1 : 0,
          );
          return { mode, pending, events: value.events };
        }),
      );
    return ledgers;
  });
});

test("success clears null before awaited refresh; false, reject and storage exceptions retain original return/error ordering", async () => {
  await compare(async (old) => {
    const ledgers: unknown[] = [];
    for (const mode of [
      "held-refresh",
      "false-refresh",
      "reject-refresh",
      "clear-failure",
      "request-refresh-failure",
      "unsent-clear-failure",
    ] as const)
      ledgers.push(
        await environment(async (value) => {
          const waiting = defer<boolean>(),
            receipt: Receipt = {
              commandId: "external",
              entityId: "entity",
              workspaceRevision: 8,
            },
            refreshError = Error("TEST refresh rejected");
          if (mode === "clear-failure" || mode === "unsent-clear-failure")
            value.failWrite = 2;
          const owner = factory(old)(
            ports(value, {
              executePlatformOperation: async () => {
                value.events.push(["dispatch"]);
                if (mode === "request-refresh-failure")
                  throw new RequestError(409, "request");
                if (mode === "unsent-clear-failure")
                  throw new (unsent(old))("not sent");
                return receipt;
              },
              refreshAfterMutation: async () => {
                value.events.push(["refresh"]);
                if (
                  mode.endsWith("refresh-failure") ||
                  mode === "reject-refresh"
                )
                  throw refreshError;
                if (mode === "held-refresh") return waiting.promise;
                return false;
              },
            }),
          );
          let settled = false;
          const request = owner
            .execute(project, false, undefined, "external")
            .finally(() => {
              settled = true;
            });
          if (mode === "held-refresh") {
            await until(() =>
              value.events.some(
                (event) => (event as string[])[0] === "refresh",
              ),
            );
            assert.equal(settled, false);
            assert.equal([...value.rows.values()][0], "null");
            waiting.resolve(true);
          }
          const result = await request.then(
            (value) => ({ receipt: value }),
            (error: unknown) => ({ error }),
          );
          if (mode === "held-refresh" || mode === "false-refresh") {
            assert("receipt" in result);
            assert.equal(result.receipt, receipt);
          } else {
            assert("error" in result);
            assert(result.error instanceof Error);
            if (mode.includes("refresh"))
              assert.equal(result.error, refreshError);
            else
              assert.equal(result.error.message, "TEST storage write failed");
          }
          const phases = value.events.map((event) => (event as string[])[0]);
          assert.ok(phases.indexOf("write") < phases.indexOf("dispatch"));
          if (phases.includes("refresh"))
            assert.equal([...value.rows.values()][0], "null");
          return {
            mode,
            events: value.events,
            rows: [...value.rows],
            outcome:
              "error" in result
                ? (result.error as Error).message
                : result.receipt,
          };
        }),
      );
    return ledgers;
  });
});

test("actual retained dispatcher and identical error constructor qualify operations; captured source and identity never become a new policy", async () => {
  await compare(async (old) => {
    const dispatcher = old
      ? fixedExecutePlatformOperation
      : executePlatformOperation;
    const Class = unsent(old),
      identity = boot();
    const calls: unknown[] = [],
      source = {
        boot: { csrfToken: "csrf" },
        createProject: async (...args: unknown[]) => {
          calls.push(args);
        },
      } as unknown as PlatformClient;
    const receipt = await dispatcher(
      source,
      identity,
      {
        commandId: "command",
        operation: project,
        applicationInstanceId: "instance",
      },
      true,
    );
    assert.deepEqual(calls, [[project.title, "command", "command"]]);
    assert.deepEqual(receipt, {
      commandId: "command",
      entityId: "command",
      workspaceRevision: 8,
    });
    await assert.rejects(
      dispatcher(
        source,
        identity,
        {
          commandId: "bad",
          operation: {
            type: "create-artifact",
            projectId: "p",
            title: "task",
            content: taskContentSchema.parse({
              kind: "task",
              priority: "high",
              description: "",
              assigneeId: "human",
              model: null,
              dueDate: null,
              assignment: "proposed",
              execution: "planned",
              delivery: "none",
              resultIds: [],
            }),
          },
        },
        false,
      ),
      (error) =>
        error instanceof Class &&
        error.message === "此事项包含尚未接通的初始状态或关联；未创建事项。",
    );
    await assert.rejects(
      dispatcher(
        source,
        identity,
        {
          commandId: "unsupported",
          operation: { type: "unsupported" } as unknown as Operation,
        },
        false,
      ),
      (error) => error instanceof Class,
    );
    const normal = await environment(async (value) => {
      const shared = ports(value, {
        current: { current: identity },
        platform: { current: source },
        executePlatformOperation: dispatcher,
      });
      const result = await factory(old)(shared).execute(
        project,
        true,
        "instance",
        "command",
      );
      assert.deepEqual(result, receipt);
      return { events: value.events, rows: [...value.rows] };
    });
    // Existing no-lock/no-post-guard characteristics are migration evidence,
    // not a permanent ordinary-CI requirement for future policy decisions.
    if (migration)
      await environment(async (value) => {
        const pending = defer<Receipt>(),
          current = { current: identity },
          shared = ports(value, {
            current,
            executePlatformOperation: async () => {
              value.events.push(["dispatch"]);
              return pending.promise;
            },
          });
        const owner = factory(old)(shared),
          one = owner.execute(project, false, undefined, "concurrent"),
          two = owner.execute(project, false, undefined, "concurrent");
        await until(
          () =>
            value.events.filter(
              (event) => (event as string[])[0] === "dispatch",
            ).length === 2,
        );
        current.current = boot("other", "center", "other-csrf");
        pending.resolve(receipt);
        assert.equal(await one, receipt);
        assert.equal(await two, receipt);
      });
    return { calls: calls.slice(0, 2), receipt, normal };
  });
});
