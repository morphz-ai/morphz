import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createElement, useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useExecutionInspection } from "../apps/web/src/features/execution/useExecutionInspection.js";
import {
  fixedInspectionMetadata,
  fixedInspectionSources,
  useFixedExecutionInspection,
  type FixedInspectionOptions,
} from "./fixtures/execution-inspection-114960d1-behavior.js";

const migration =
  process.env.MORPHZ_TEST_EXECUTION_INSPECTION_MIGRATION_EQUIVALENCE === "1";
const factories = migration
  ? [useFixedExecutionInspection, useExecutionInspection]
  : [useExecutionInspection];

test("fixed execution inspection archive preserves independent committed full Dialog and lifecycle provenance", () => {
  const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
  assert.equal(
    fixedInspectionMetadata.git,
    "114960d1cd1529082751efb424f0a7d8584bd721",
  );
  assert.equal(
    sha(fixedInspectionSources.module),
    fixedInspectionMetadata.sources["ExecutionDialog.tsx"].sha256,
  );
  for (const key of [
    "ExecutionDialog",
    "lifecycle",
    "refsAndState",
    "scopeProjection",
    "observation",
    "modal",
    "retirement",
    "control",
    "readResult",
    "producedId",
    "renderTail",
    "rendererRefPrefix",
  ] as const)
    assert.equal(
      sha(fixedInspectionSources[key]),
      fixedInspectionMetadata.spans[key].sha256,
      key,
    );
});

function render(
  factory: typeof useExecutionInspection,
  client: FixedInspectionOptions["client"],
  scope: FixedInspectionOptions["scope"],
) {
  let captured: ReturnType<typeof useExecutionInspection> | undefined;
  function Probe() {
    // Original first native-dialog ref, followed by the actual controller hook.
    const dialog = useRef<HTMLDialogElement>(null);
    captured = factory({ client, scope, dialog, embedded: true });
    return createElement("span", { "data-inspection": "initial" });
  }
  assert.equal(
    renderToStaticMarkup(createElement(Probe)),
    '<span data-inspection="initial"></span>',
  );
  assert.ok(captured);
  return captured;
}

test("actual React SSR initial state and unavailable observer refresh keep the original nine-value contract without IO", async () => {
  for (const online of [true, false]) {
    const values = [];
    for (const factory of factories) {
      const events: unknown[] = [];
      const client: FixedInspectionOptions["client"] = {
        boot: null,
        online,
        workspaceChangeRevision: 17,
        get contentCatalog(): FixedInspectionOptions["client"]["contentCatalog"] {
          throw new Error("null initial result must not read catalog");
        },
        async executionSnapshot() {
          events.push("snapshot");
          throw new Error("SSR must not query");
        },
        async executionResult() {
          events.push("result");
          throw new Error("SSR must not query");
        },
        async controlExecution() {
          events.push("control");
          throw new Error("SSR must not mutate");
        },
      };
      const view = render(factory, client, {
        projectId: "original",
        artifactId: null,
        conversationId: "conversation-original",
      });
      assert.deepEqual(Object.keys(view), [
        "snapshot",
        "error",
        "busy",
        "notice",
        "result",
        "producedId",
        "refresh",
        "control",
        "readResult",
      ]);
      const { refresh, control, readResult, ...initial } = view;
      assert.deepEqual(initial, {
        snapshot: null,
        error: "",
        busy: "",
        notice: "",
        result: null,
        producedId: undefined,
      });
      assert.equal(typeof control, "function");
      assert.equal(typeof readResult, "function");
      assert.equal(
        await refresh(),
        false,
        "without mounted passive observation there is no drain",
      );
      assert.deepEqual(events, []);
      values.push(initial);
    }
    if (migration) assert.deepEqual(values[1], values[0]);
  }
});

test("scope serialization uses the original render client and exact scope property order, not an eager query or canonicalizer", () => {
  for (const factory of factories) {
    const events: string[] = [];
    const scope: FixedInspectionOptions["scope"] = {
      get projectId() {
        events.push("projectId");
        return "original-project";
      },
      get artifactId() {
        events.push("artifactId");
        return null;
      },
      get conversationId() {
        events.push("conversationId");
        return "original-conversation";
      },
      get threadId() {
        events.push("threadId");
        return "";
      },
    };
    const client: FixedInspectionOptions["client"] = {
      get boot() {
        events.push("boot");
        return null;
      },
      get online() {
        events.push("online");
        return false;
      },
      get workspaceChangeRevision() {
        events.push("revision");
        return 0;
      },
      get contentCatalog(): FixedInspectionOptions["client"]["contentCatalog"] {
        throw new Error("initial result has no catalog read");
      },
      async executionSnapshot() {
        throw new Error("not mounted");
      },
      async executionResult() {
        throw new Error("not mounted");
      },
      async controlExecution() {
        throw new Error("not mounted");
      },
    };
    render(factory, client, scope);
    assert.deepEqual(events, [
      "boot",
      "boot",
      "boot",
      "projectId",
      "artifactId",
      "conversationId",
      "threadId",
      "online",
      "revision",
    ]);
  }
});
