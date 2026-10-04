import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  expandWorkspaceContentOpeningConsumption,
  fixedContentOpeningBaseline,
} from "./fixtures/workspace-content-opening-consumption.js";

const app = readFileSync(
  new URL("../apps/web/src/App.tsx", import.meta.url),
  "utf8",
);
const owner = readFileSync(
  new URL("../apps/web/src/host/use-workspace-navigation.ts", import.meta.url),
  "utf8",
);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function changed(source: string, from: string, to: string) {
  assert.equal(
    source.split(from).length - 1,
    1,
    "unique legal negative target",
  );
  return source.replace(from, to);
}
function openingChanged(from: string, to: string) {
  const start = owner.indexOf("  async function openUser(");
  const end = owner.indexOf("  async function launchDockApplication(", start);
  assert.ok(start > 0 && end > start);
  return (
    owner.slice(0, start) +
    changed(owner.slice(start, end), from, to) +
    owner.slice(end)
  );
}
test("actual App consumes both complete navigation methods and exact inverse restores actual Git 2cf6 whole files", () => {
  const original = expandWorkspaceContentOpeningConsumption(app, owner);
  assert.equal(hash(original.app), fixedContentOpeningBaseline.app);
  assert.equal(hash(original.owner), fixedContentOpeningBaseline.owner);
});

test("a real runtime factory import alias remains a direct consumer, not a detached mirror", () => {
  const renamed = changed(
    changed(
      app,
      "  createWorkspaceNavigationCommands,\n",
      "  createWorkspaceNavigationCommands as makeNavigationCommands,\n",
    ),
    "  } = createWorkspaceNavigationCommands({",
    "  } = makeNavigationCommands({",
  );
  const expanded = expandWorkspaceContentOpeningConsumption(renamed, owner);
  assert.ok(expanded.app.includes("  } = makeNavigationCommands({"));
  assert.equal(hash(expanded.owner), fixedContentOpeningBaseline.owner);
});

test("reject legal direct-consumption changes, rather than accepting a detached helper", () => {
  const cases = [
    {
      text: changed(
        app,
        "    openUser,\n    openReading,",
        "    openUser: openOther,\n    openReading,",
      ),
      rule: /exact original ten captured options and direct App aliases/,
    },
    {
      text: changed(
        app,
        "    workspace: state,\n    surface: workSurface,",
        "    workspace: client.getSnapshot()?.workspace,\n    surface: workSurface,",
      ),
      rule: /exact original ten captured options and direct App aliases/,
    },
    {
      text: changed(
        app,
        "    workspace: state,\n    surface: workSurface,",
        "    workspace: state,\n    getClient: () => client,\n    surface: workSurface,",
      ),
      rule: /exact original ten captured options and direct App aliases/,
    },
    {
      text: changed(
        app,
        "  const positions = useRef(new Map<string, number>());",
        "  const duplicate = createWorkspaceNavigationCommands({});\n  const positions = useRef(new Map<string, number>());",
      ),
      rule: /unique actual navigation factory call/,
    },
    {
      text: changed(
        app,
        "    void openUser(id, revision, page);",
        "    function openUser() {}\n    void openUser(id, revision, page);",
      ),
      rule: /no duplicate App content-opening algorithm/,
    },
  ];
  for (const { text, rule } of cases)
    assert.throws(() => expandWorkspaceContentOpeningConsumption(text, owner), {
      name: "AssertionError",
      message: rule,
    });
});

test("reject legal owner scope, construction, Pick and wrapper counterfactuals", () => {
  const cases = [
    {
      text: changed(
        owner,
        '  | "resolveCatalogContent"\n>;',
        '  | "resolveCatalogContent"\n  | "getSnapshot"\n>;',
      ),
      rule: /only three required captured Client fields/,
    },
    {
      text: changed(
        owner,
        "  async function openUser(\n",
        "  const latestBoot = client.boot;\n  async function openUser(\n",
      ),
      rule: /only two methods added; no constructor reads/,
    },
    {
      text: changed(
        owner,
        "    openObject,\n    openUser,\n    openReading,",
        "    openObject,\n    openUser: (...args) => openUser(...args),\n    openReading,",
      ),
      rule: /direct shorthand public aliases/,
    },
    {
      text: openingChanged(
        "const script = client.boot?.scriptLibrary.find(",
        "const script = continuation.currentProjection()?.scriptLibrary.find(",
      ),
      rule: /complete original content-opening algorithm openUser/,
    },
  ];
  for (const { text, rule } of cases)
    assert.throws(() => expandWorkspaceContentOpeningConsumption(app, text), {
      name: "AssertionError",
      message: rule,
    });
});

test("reject legal changes to each different timing, source, notice and await contract", () => {
  const cases = [
    [
      "if (script) return openScriptLocation({ productionId: script.id });",
      "if (script) return await openScriptLocation({ productionId: script.id });",
      "openUser",
    ],
    [
      "(!loadedArtifact ? await client.resolveCatalogContent(id) : null)",
      "(await client.resolveCatalogContent(id))",
      "openUser",
    ],
    [
      "if (!continuation.isActive() || !owner.isCurrent(generation)) return;\n      if (\n        catalogEntry?.appId",
      "if (!continuation.isActive()) return;\n      if (\n        catalogEntry?.appId",
      "openUser",
    ],
    [
      "loadedArtifact ?? (await client.resolveArtifact(id))",
      "loadedArtifact ?? (await client.resolveArtifact(id, revision))",
      "openUser",
    ],
    [
      'a?.content.kind === "website" ? a.id : null,',
      'a?.content.kind === "website" ? id : null,',
      "openUser",
    ],
    [
      "void openObject(a.projectId, id, revision, page, !!reading, reading);",
      "await openObject(a.projectId, id, revision, page, !!reading, reading);",
      "openUser",
    ],
    [
      'onNotice("对象暂时无法读取，请检查连接或访问权限后重试。");',
      'notice("对象暂时无法读取，请检查连接或访问权限后重试。");',
      "openUser",
    ],
    [
      'onNotice(\n        error instanceof Error ? error.message : "内容暂时无法打开，请重试。",',
      'if (continuation.isActive()) onNotice(\n        error instanceof Error ? error.message : "内容暂时无法打开，请重试。",',
      "openUser",
    ],
    [
      "if (a) await openObject(a.projectId, id, undefined, undefined, true);",
      "if (a) void openObject(a.projectId, id, undefined, undefined, true);",
      "openReading",
    ],
    [
      "if (a) await openObject(a.projectId, id, undefined, undefined, true);",
      "if (a) { owner.setExplicitWebsiteIntent(a.id); await openObject(a.projectId, id, undefined, undefined, true); }",
      "openReading",
    ],
    [
      "if (a) await openObject(a.projectId, id, undefined, undefined, true);",
      "if (a) await openObject(a.projectId, id, undefined, undefined, true); else onNotice('missing');",
      "openReading",
    ],
  ] as const;
  for (const [from, to, name] of cases) {
    const counterfactual = openingChanged(from, to);
    assert.throws(
      () => expandWorkspaceContentOpeningConsumption(app, counterfactual),
      {
        name: "AssertionError",
        message: new RegExp(
          "complete original content-opening algorithm " + name,
        ),
      },
    );
  }
});
