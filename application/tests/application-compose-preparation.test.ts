import assert from "node:assert/strict";
import test from "node:test";
import {
  createApplicationComposePreparation,
  type ApplicationComposePreparationOptions as Options,
} from "../apps/web/src/host/application-compose-preparation.js";
import { replaceComposerSurface } from "../apps/web/src/composer-drafts.js";
import type { InputDraft } from "../apps/web/src/host/exchange-drafts.js";
import type { ScriptGeneration } from "../packages/core/src/script-studio.js";
import { createFixedApplicationCompose } from "./fixtures/application-compose-7c1aea5a.js";
import {
  artifact,
  catalog,
  empty,
  generation,
  production,
  quote,
} from "./fixtures/application-compose-data.js";

// Narrow controlled command ports; mounted tests separately use the actual
// React draft writer and distinguish acknowledgement from publication.
type Maker = (
  options: Options,
) => ReturnType<typeof createApplicationComposePreparation>;
type Model = ReturnType<Options["client"]["getScriptEditor"]>;
type Config = {
  draft?: Partial<InputDraft>;
  latest?: Record<string, InputDraft>;
  source?: "artifact" | "catalog" | "none";
  version?: string;
  model?: Model;
  sending?: boolean;
  defaultConversation?: string;
  currentKey?: string;
  skipUpdater?: boolean;
  throwAt?: string;
};
function harness(config: Config = {}) {
  const events: unknown[][] = [];
  const rendered: InputDraft = { ...empty, ...config.draft };
  let latest = config.latest ?? { "conversation:artifact": { ...rendered } };
  const initial = latest,
    sentinel = new Error("controlled-port-error");
  const emit = (name: string, ...args: unknown[]) => {
    events.push([name, ...args]);
    if (config.throwAt === name) throw sentinel;
  };
  const options: Options = {
    render: {
      state: {
        artifacts:
          (config.source ?? "artifact") === "artifact" ? [artifact()] : [],
      },
      project: { id: "project" },
      draft: rendered,
      contextKey: "conversation:artifact",
      conversationId: "conversation",
      defaultConversation: config.defaultConversation,
      sending: config.sending ?? false,
      emptyDraft: empty,
    },
    client: {
      getScriptEditor(id) {
        emit("script.read", id);
        return "model" in config ? config.model : production();
      },
      get contentCatalog() {
        emit("catalog.read");
        return config.source === "none" ? [] : [catalog(config.version)];
      },
    },
    setDraft(key, value) {
      emit("setDraft", key, structuredClone(value));
      latest = replaceComposerSurface(latest, key, empty, value);
    },
    writeDrafts(update) {
      emit("writer.before");
      if (!config.skipUpdater) {
        emit("updater.before");
        latest = update(latest);
        emit("updater.after");
      }
      emit("writer.after");
    },
    flushSync(run) {
      emit("flush.before");
      run();
      emit("flush.after");
    },
    currentContext: {
      get current() {
        emit("currentContext.read");
        return config.currentKey ?? "conversation:artifact";
      },
    },
    dictationControls: {
      get current() {
        emit("dictation.read");
        return {
          interrupt() {
            emit("interrupt");
          },
        };
      },
    },
    prefer(value) {
      emit("prefer", value);
    },
    showInput() {
      emit("showInput");
    },
  };
  return {
    options,
    events,
    rendered,
    sentinel,
    get latest() {
      return latest;
    },
    setLatest(value: Record<string, InputDraft>) {
      latest = value;
    },
    snapshot(result: unknown) {
      return {
        result,
        events,
        latest: structuredClone(latest),
        sameInitialReference: latest === initial,
      };
    },
  };
}
function pair(
  configure: () => Config,
  run: (command: ReturnType<Maker>, h: ReturnType<typeof harness>) => unknown,
) {
  const snapshots: unknown[] = [];
  for (const create of [
    createFixedApplicationCompose,
    createApplicationComposePreparation,
  ]) {
    const h = harness(configure()),
      command = create(h.options);
    assert.deepEqual(h.events, [], "constructor must not call/read deep ports");
    snapshots.push(h.snapshot(run(command, h)));
  }
  assert.deepEqual(
    snapshots[1],
    snapshots[0],
    "complete bounded ordered old/new ledger and result",
  );
}

test("script first priority, exact preparation fields and original allowed fields", () => {
  pair(
    () => ({
      draft: {
        intent: "script",
        selection: "旧选文",
        revision: 1,
        continuationFailure: "closed",
        page: 0,
        model: "route",
        reasoningEffort: "max",
        skipReading: true,
      },
    }),
    (command, h) => {
      const result = command("准备请求", "also-artifact", generation);
      assert.deepEqual(result, { ok: true });
      assert.deepEqual(
        h.events.map((e) => e[0]),
        ["script.read", "setDraft", "showInput"],
      );
      const next = h.latest["conversation:artifact"]!;
      assert.equal(next.body, "准备请求");
      assert.equal(next.intent, undefined);
      assert.equal(next.selection, "");
      assert.equal(next.revision, null);
      assert.equal(next.page, 0);
      assert.equal(next.continuationFailure, "closed");
      assert.equal(next.model, "route");
      assert.equal(next.reasoningEffort, "max");
      assert.deepEqual(next.scriptGeneration, generation);
      assert.notEqual(
        next.scriptGeneration,
        generation,
        "original structured clone",
      );
      return result;
    },
  );
});
test("every original script source/version guard refuses before any draft write", () => {
  const cases: (() => Model)[] = [
    () => undefined,
    () => ({ ...production(), projectId: "other" }),
    () => ({ ...production(), items: [] }),
    () => ({
      ...production(),
      items: [{ ...production().items[0]!, id: "other-target" }],
    }),
    () => ({
      ...production(),
      items: [{ ...production().items[0]!, revision: 3 }],
    }),
    () => ({ ...production(), revision: 6 }),
  ];
  for (const build of cases)
    pair(
      () => ({ model: build() }),
      (command, h) => {
        const result = command("不得写入", undefined, generation);
        assert.deepEqual(result, {
          ok: false,
          error: "剧本引用已有变化，请关闭后重新准备请求；原草稿保留。",
        });
        assert.deepEqual(h.events, [["script.read", "script-one"]]);
        return result;
      },
    );
});
test("each exact captured script conflict remains a refusal; whitespace alone is allowed", () => {
  const conflicts: Partial<InputDraft>[] = [
    {
      pendingSupplement: {
        commandId: "command",
        operation: {
          type: "annotate",
          artifactId: "artifact",
          artifactRevision: 9,
          quote: "",
          body: "评论",
        },
      },
    },
    {
      continuation: {
        mode: "supplement",
        inputId: "input",
        threadId: "thread",
        generation: 1,
      },
    },
    { annotation: true },
    { taskResult: { taskId: "task", revision: 1 } },
    { body: "未发文字" },
    { attachments: [{ assetId: "a".repeat(64), name: "附件" }] },
    { textQuotes: [quote] },
    { intent: "document" },
    { scriptGeneration: generation },
  ];
  for (const draft of conflicts)
    pair(
      () => ({ draft }),
      (command, h) => {
        const result = command("请求", undefined, generation);
        assert.deepEqual(result, {
          ok: false,
          error:
            "输入框中已有未发送的内容或请求。请先处理原输入，再准备本次请求；这里填写的要求已保留。",
        });
        assert.deepEqual(
          h.events.map((e) => e[0]),
          ["script.read"],
        );
        return result;
      },
    );
  pair(
    () => ({ sending: true }),
    (command) => {
      const result = command("请求", undefined, generation);
      assert.equal(result.ok, false);
      return result;
    },
  );
  pair(
    () => ({ draft: { body: "  \n  " } }),
    (command) => {
      const result = command("请求", undefined, generation);
      assert.deepEqual(result, { ok: true });
      return result;
    },
  );
});
test("artifact catalog-only revision conversion and artifact-head precedence are exact", () => {
  for (const [version, revision] of [
    ["9", 9],
    ["", null],
    ["NaN", null],
    ["0", null],
    ["-2", null],
    ["2.5", null],
    ["9007199254740992", null],
  ] as const)
    pair(
      () => ({ source: "catalog", version }),
      (command, h) => {
        const result = command("追加", "artifact");
        assert.deepEqual(result, { ok: true });
        assert.equal(h.latest["conversation:artifact"]!.revision, revision);
        return result;
      },
    );
  pair(
    () => ({ source: "artifact", version: "11" }),
    (command, h) => {
      const result = command("追加", "artifact");
      assert.equal(h.latest["conversation:artifact"]!.revision, 9);
      return result;
    },
  );
  pair(
    () => ({ source: "none" }),
    (command, h) => {
      const result = command("追加", "artifact");
      assert.deepEqual(result, { ok: false, error: "引用的内容已不可用。" });
      assert.deepEqual(h.events, [["catalog.read"]]);
      return result;
    },
  );
});
test("artifact latest functional state, default-only legacy key, retained settings/source and quote map", () => {
  pair(
    () => ({
      draft: { body: "旧渲染" },
      latest: {
        "conversation:artifact": {
          ...empty,
          body: "最新正文",
          revision: 2,
          selection: "确切旧来源",
          model: "new-route",
          reasoningEffort: "max",
        },
        "conversation:quotes": { ...empty, textQuotes: [quote] },
      },
    }),
    (command, h) => {
      const result = command("追加", "artifact");
      const next = h.latest["conversation:artifact"]!;
      assert.equal(next.body, "最新正文\n追加");
      assert.equal(next.revision, 2);
      assert.equal(next.model, "new-route");
      assert.equal(next.reasoningEffort, "max");
      assert.deepEqual(h.latest["conversation:quotes"]!.textQuotes, [quote]);
      assert.deepEqual(
        h.events.map((e) => e[0]),
        [
          "catalog.read",
          "flush.before",
          "writer.before",
          "updater.before",
          "updater.after",
          "writer.after",
          "flush.after",
          "currentContext.read",
          "dictation.read",
          "interrupt",
          "prefer",
          "showInput",
        ],
      );
      return result;
    },
  );
  for (const defaultConversation of ["conversation", "different", undefined])
    pair(
      () => ({
        defaultConversation,
        latest: {
          "project:artifact": { ...empty, body: "legacy", revision: 3 },
        },
      }),
      (command, h) => {
        const result = command("追加", "artifact");
        assert.equal(
          h.latest["conversation:artifact"]!.body,
          defaultConversation === "conversation" ? "legacy\n追加" : "追加",
        );
        return result;
      },
    );
});
test("artifact refusal ACK waits for executed updater and leaves original map untouched", () => {
  const refusals: Config[] = [
    { latest: { "conversation:artifact": { ...empty, annotation: true } } },
    {
      latest: {
        "conversation:artifact": { ...empty, body: "x".repeat(30000) },
      },
    },
    { skipUpdater: true },
  ];
  for (const config of refusals)
    pair(
      () => config,
      (command, h) => {
        const previous = h.latest,
          result = command("追加", "artifact");
        assert.equal(result.ok, false);
        assert.equal(h.latest, previous);
        assert.equal(
          h.events.some((e) =>
            [
              "currentContext.read",
              "dictation.read",
              "interrupt",
              "prefer",
              "showInput",
            ].includes(String(e[0])),
          ),
          false,
        );
        if (config.skipUpdater)
          assert.deepEqual(result, {
            ok: false,
            error: "暂时无法准备输入，原草稿已保留。",
          });
        return result;
      },
    );
});
test("artifact successful no-body-change/other-surface skips interrupt but still prefer then reveal", () => {
  const cases: Config[] = [
    { draft: { body: "原正文" } },
    { currentKey: "other:surface" },
  ];
  for (const config of cases)
    pair(
      () => config,
      (command, h) => {
        const result = command(config.currentKey ? "追加" : "", "artifact");
        assert.deepEqual(result, { ok: true });
        assert.equal(
          h.events.some(
            (e) => e[0] === "dictation.read" || e[0] === "interrupt",
          ),
          false,
        );
        assert.deepEqual(
          h.events.slice(-2).map((e) => e[0]),
          ["prefer", "showInput"],
        );
        return result;
      },
    );
});
test("plain append remains captured, uncapped, same original dedicated fields", () => {
  pair(
    () => ({
      draft: { body: "旧正文", annotation: true },
      latest: { "conversation:artifact": { ...empty, body: "最新正文" } },
    }),
    (command, h) => {
      const result = command("普通追加");
      assert.deepEqual(result, { ok: true });
      assert.equal(h.latest["conversation:artifact"]!.body, "旧正文\n普通追加");
      assert.equal(h.latest["conversation:artifact"]!.annotation, true);
      assert.deepEqual(
        h.events.map((e) => e[0]),
        ["setDraft", "showInput"],
      );
      return result;
    },
  );
  pair(
    () => ({ draft: { body: "x".repeat(30000) } }),
    (command, h) => {
      const result = command("y");
      assert.equal(h.latest["conversation:artifact"]!.body.length, 30002);
      return result;
    },
  );
});
test("uncaught errors and partial-write ordering do not become success/refusal bridges", () => {
  for (const [throwAt, branch] of [
    ["script.read", "script"],
    ["setDraft", "plain"],
    ["catalog.read", "artifact"],
    ["writer.before", "artifact"],
    ["flush.after", "artifact"],
    ["interrupt", "artifact"],
    ["prefer", "artifact"],
    ["showInput", "artifact"],
  ] as const)
    pair(
      () => ({ throwAt }),
      (command, h) => {
        assert.throws(
          () =>
            branch === "script"
              ? command("追加", undefined, generation)
              : branch === "artifact"
                ? command("追加", "artifact")
                : command("追加"),
          (error) => error === h.sentinel,
        );
        assert.equal(h.events.at(-1)?.[0], throwAt);
        return { thrown: h.sentinel.message };
      },
    );
  for (const create of [
    createFixedApplicationCompose,
    createApplicationComposePreparation,
  ]) {
    const h = harness(),
      command = create(h.options),
      uncloneable: ScriptGeneration = { ...generation };
    Object.defineProperty(uncloneable, "testOnlyUncloneable", {
      value: () => {},
      enumerable: true,
    });
    assert.throws(
      () => command("请求", undefined, uncloneable),
      (error) =>
        error instanceof DOMException && error.name === "DataCloneError",
    );
    assert.deepEqual(
      h.events.map((e) => e[0]),
      ["script.read"],
    );
  }
});
