import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inverseObjectAnnotationsFeature } from "./object-annotations-consumption.js";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  NodeFlags,
  SyntaxKind,
  isBinaryExpression,
  isCallExpression,
  isExportDeclaration,
  isExportSpecifier,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportSpecifier,
  isJsxElement,
  isJsxExpression,
  isJsxSelfClosingElement,
  isNamedImports,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isVariableStatement,
  type Identifier,
  type Node,
} from "typescript/unstable/ast";

// Independently frozen complete actual Git 778 source. Ordinary CI needs no Git.
// Source inverse is separate from actual-new component/React and compiled App evidence.
export const humanCreationFixed = {
  commit: "778e6b9384e67612801999aa76a17b70a4551efd",
  appSHA256: "85b1520ab5271c4f4a7d86d59daf727b15b9824dc0219369e186f3acf6095265",
  appBytes: 120474,
  functionSHA256:
    "f52985b727e085f0263fb27e9a26898466f58f47720951946d85e67d8832b60c",
  functionRaw:
    'function CreateDialog({\n  kind,\n  projectId,\n  client,\n  onClose,\n  onCreated,\n  prepareCreated,\n  toolbarTarget,\n}: {\n  kind: "document" | "project";\n  projectId: string;\n  client: ReturnType<typeof useWorkspace>;\n  onClose: () => void;\n  onCreated: (id: string, kind: string) => void;\n  prepareCreated?: () => (id: string, kind: string) => void;\n  toolbarTarget?: HTMLElement | null;\n}) {\n  const [storage] = useState(() => scopedStorage());\n  const alive = useRef(true);\n  useEffect(() => {\n    alive.current = true;\n    return () => {\n      alive.current = false;\n    };\n  }, []);\n  const draftId = draftKey("create-document:" + projectId);\n  const cached =\n    kind === "document"\n      ? storage.readLocal<{ title: string; markdown: string }>(draftId, {\n          title: "",\n          markdown: "",\n        })\n      : { title: "", markdown: "" };\n  const dialog = useRef<HTMLDialogElement>(null),\n    [title, setTitle] = useState(cached.title),\n    [markdown, setMarkdown] = useState(cached.markdown),\n    [busy, setBusy] = useState(false),\n    [error, setError] = useState("");\n  useModal(dialog);\n  useEffect(() => {\n    if (kind === "document") {\n      try {\n        storage.writeLocal(draftId, { title, markdown });\n      } catch {\n        setError("草稿未能保存，请保留当前页面。\\n");\n      }\n    }\n  }, [title, markdown, kind, draftId, storage]);\n  async function submit(e: FormEvent) {\n    e.preventDefault();\n    if (!title.trim() || busy) return;\n    setBusy(true);\n    setError("");\n    const created = prepareCreated?.();\n    try {\n      const result = await client.execute(\n        kind === "project"\n          ? { type: "create-project", title }\n          : {\n              type: "create-artifact",\n              projectId,\n              title,\n              content: { kind: "document", markdown },\n            },\n      );\n      if (kind === "document") {\n        try {\n          storage.writeLocal(draftId, { title: "", markdown: "" });\n        } catch {\n          /* Creation already succeeded; never repeat it on a local storage failure. */\n        }\n      }\n      created?.(result.entityId, kind);\n      if (alive.current) onCreated(result.entityId, kind);\n    } catch (e) {\n      if (alive.current)\n        setError(e instanceof Error ? e.message : "创建失败。");\n    } finally {\n      if (alive.current) setBusy(false);\n    }\n  }\n  const heading = (\n    <header className={kind === "document" ? "draft-toolbar" : undefined}>\n      <h2 id="create-title">{kind === "project" ? "新建项目" : "新建文档"}</h2>\n      <button\n        type="button"\n        aria-label="关闭新建窗口"\n        disabled={busy}\n        onClick={onClose}\n      >\n        <X />\n      </button>\n    </header>\n  );\n  const form = (\n    <form onSubmit={(e) => void submit(e)}>\n      {kind === "document"\n        ? toolbarTarget && createPortal(heading, toolbarTarget)\n        : heading}\n      {kind === "document" ? (\n        <div>\n          <label className="field">\n            标题\n            <input\n              autoFocus\n              aria-label="新对象标题"\n              maxLength={180}\n              value={title}\n              onChange={(e) => setTitle(e.target.value)}\n              required\n            />\n          </label>\n        </div>\n      ) : (\n        <div className="dialog-input-row">\n          <input\n            aria-label="项目名称"\n            placeholder="项目名称"\n            maxLength={180}\n            value={title}\n            onChange={(e) => setTitle(e.target.value)}\n            required\n          />\n          <button className="primary" disabled={busy || !title.trim()}>\n            {busy ? "保存中…" : "创建"}\n          </button>\n        </div>\n      )}\n      {kind === "document" && (\n        <label className="field">\n          正文 · Markdown\n          <textarea\n            aria-label="新文档正文"\n            value={markdown}\n            onChange={(e) => setMarkdown(e.target.value)}\n            rows={8}\n            placeholder="开始写作…"\n          />\n        </label>\n      )}\n      {error && (\n        <div role="alert" className="form-error">\n          {error}\n        </div>\n      )}\n      {kind === "document" && (\n        <footer>\n          <button type="button" onClick={onClose} disabled={busy}>\n            取消\n          </button>\n          <button className="primary" disabled={busy || !title.trim()}>\n            {busy ? "保存中…" : "创建"}\n          </button>\n        </footer>\n      )}\n    </form>\n  );\n  if (kind === "document")\n    return (\n      <section className="document-draft" aria-label="新建文档编辑区">\n        {form}\n      </section>\n    );\n  return (\n    <dialog\n      ref={dialog}\n      className="create-dialog project-dialog"\n      onCancel={(e) => {\n        e.preventDefault();\n        if (!busy) onClose();\n      }}\n      aria-labelledby="create-title"\n    >\n      {form}\n    </dialog>\n  );\n}',
  consumers: [
    {
      sha256:
        "d8d75c79fe415327c413a620bd55fccdcb637ae1178d7fdc115b847a228fc2b5",
      raw: '<CreateDialog\n                  key={project.id}\n                  kind="document"\n                  toolbarTarget={detailToolbarTarget}\n                  projectId={project.id}\n                  client={client}\n                  onClose={() => setCreating(null)}\n                  onCreated={(id) => {\n                    setCreating(null);\n                    void openObject(project.id, id);\n                  }}\n                />',
      attributes: [
        "key={project.id}",
        'kind="document"',
        "toolbarTarget={detailToolbarTarget}",
        "projectId={project.id}",
        "client={client}",
        "onClose={() => setCreating(null)}",
        "onCreated={(id) => {\n                    setCreating(null);\n                    void openObject(project.id, id);\n                  }}",
      ],
    },
    {
      sha256:
        "62fcd7f0f270cd250cff576a95bdfd57d48a3fa9d632fcaee5b2bace48965d27",
      raw: '<CreateDialog\n          kind={creating}\n          projectId={project.id}\n          client={client}\n          onClose={() => setCreating(null)}\n          prepareCreated={\n            creating === "project" ? prepareCreatedProject : undefined\n          }\n          onCreated={(id, kind) => {\n            setCreating(null);\n            if (kind !== "project") void openObject(project.id, id);\n          }}\n        />',
      attributes: [
        "kind={creating}",
        "projectId={project.id}",
        "client={client}",
        "onClose={() => setCreating(null)}",
        'prepareCreated={\n            creating === "project" ? prepareCreatedProject : undefined\n          }',
        'onCreated={(id, kind) => {\n            setCreating(null);\n            if (kind !== "project") void openObject(project.id, id);\n          }}',
      ],
    },
  ],
  guards: ['creating === "document"', 'creating && creating !== "document"'],
  originalImports: [
    'import {\n  createElement,\n  useEffect,\n  useLayoutEffect,\n  useRef,\n  useState,\n  useCallback,\n  useMemo,\n  type FormEvent,\n  type CSSProperties,\n} from "react";',
    'import { createPortal, flushSync } from "react-dom";',
    'import {\n  actorName,\n  scopedStorage,\n  draftKey,\n  useWorkspace,\n  storageScope,\n} from "./client.js";',
    'import { useModal } from "./useModal.js";',
  ],
  runtime: {
    clientReexport:
      'export {\n  draftKey,\n  readLocal,\n  scopedStorage,\n  storageScope,\n  writeLocal,\n} from "./local-preferences.js";',
    scopedStorageDefinition:
      "export function scopedStorage(scope = localScope) {\n  return {\n    readLocal: <T>(key: string, fallback: T) => readLocal(key, fallback, scope),\n    writeLocal: (key: string, value: unknown) => writeLocal(key, value, scope),\n    removeLocal: (key: string) => removeLocal(key, scope),\n  };\n}",
    draftKeyDefinition:
      'export const draftKey = (key: string) => "draft:" + draftOwner + ":" + key;',
  },
} as const;

const componentModule = "./features/creation/CreateDialog.js";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
assert.equal(
  hash(humanCreationFixed.functionRaw),
  humanCreationFixed.functionSHA256,
  "fixed complete actual Git CreateDialog",
);
for (const consumer of humanCreationFixed.consumers)
  assert.equal(
    hash(consumer.raw),
    consumer.sha256,
    "fixed complete actual Git creation consumer",
  );
const expectedFeature =
  `
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { WorkspaceClient } from "../../client.js";
import { scopedStorage, draftKey } from "../../local-preferences.js";
import { useModal } from "../../useModal.js";
` +
  humanCreationFixed.functionRaw
    .replace(/^function CreateDialog/, "export function CreateDialog")
    .replace(
      "client: ReturnType<typeof useWorkspace>;",
      'client: Pick<WorkspaceClient, "execute">;',
    );
function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}
function parse(contents: Record<string, string>) {
  const root = "/human-creation-consumption",
    config = root + "/tsconfig.json";
  const fileName = (name: string) =>
    name + (["App", "Feature", "Expected"].includes(name) ? ".tsx" : ".ts");
  const files = Object.fromEntries(
    Object.entries(contents).map(([name, value]) => [
      root + "/" + fileName(name),
      value,
    ]),
  );
  files[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
    files: Object.keys(contents).map(fileName),
  });
  const api = new API({ cwd: root, fs: createVirtualFileSystem(files) });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const project = snapshot.getProject(config)!;
    assert.deepEqual(
      project.program.getSyntacticDiagnostics(),
      [],
      "legal human creation source before finite rules",
    );
    return new Map(
      Object.keys(contents).map((name) => {
        const source = project.program.getSourceFile(
          root + "/" + fileName(name),
        )!;
        const nodes: Node[] = [],
          identifiers: Identifier[] = [];
        walk(source, (node) => {
          nodes.push(node);
          if (isIdentifier(node)) identifiers.push(node);
        });
        const resolved = project.checker.getSymbolAtLocation(identifiers);
        const symbols = new Map<Node, number | undefined>(
          identifiers.map((node, index) => [node, resolved[index]?.id]),
        );
        for (const node of nodes.filter(isShorthandPropertyAssignment))
          symbols.set(
            node.name,
            project.checker.getShorthandAssignmentValueSymbol(node)?.id,
          );
        return [name, { source, nodes, symbols }] as const;
      }),
    );
  } finally {
    snapshot.dispose();
    api.close();
  }
}
type Parsed = ReturnType<typeof parse> extends Map<string, infer P> ? P : never;
function shape(node: Node): unknown {
  const children: unknown[] = [];
  node.forEachChild((child) => {
    children.push(shape(child));
  });
  return [
    node.kind,
    node.flags &
      (NodeFlags.Const |
        NodeFlags.Let |
        NodeFlags.Using |
        NodeFlags.OptionalChain),
    ...(isImportDeclaration(node) ? [node.importClause?.phaseModifier] : []),
    ...(isExportDeclaration(node) ||
    isImportSpecifier(node) ||
    isExportSpecifier(node)
      ? [node.isTypeOnly]
      : []),
    ...(isBinaryExpression(node) ? [node.operatorToken.kind] : []),
    ...(isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)
      ? [node.operator]
      : []),
    children.length ? children : node.getText(),
  ];
}
function imports(parsed: Parsed, module: string) {
  return parsed.source.statements
    .filter(isImportDeclaration)
    .filter(
      (node) =>
        isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === module,
    );
}
function oneFunction(parsed: Parsed, name: string) {
  const found = parsed.nodes
    .filter(isFunctionDeclaration)
    .filter((node) => node.name?.text === name);
  assert.equal(found.length, 1, "one complete human creation function " + name);
  return found[0]!;
}
function uniqueReplace(
  source: string,
  before: string,
  after: string,
  rule: string,
) {
  assert.equal(source.split(before).length - 1, 1, rule);
  return source.replace(before, after);
}
const originalReact = humanCreationFixed.originalImports.find((value) =>
  value.endsWith('from "react";'),
)!;
const originalDom = humanCreationFixed.originalImports.find((value) =>
  value.endsWith('from "react-dom";'),
)!;
const originalClient = humanCreationFixed.originalImports.find((value) =>
  value.endsWith('from "./client.js";'),
)!;
const originalModal = humanCreationFixed.originalImports.find((value) =>
  value.endsWith('from "./useModal.js";'),
)!;
const reviewedAppImports = [
  ["react", originalReact.replace("  type FormEvent,\n", ""), originalReact],
  ["react-dom", 'import { flushSync } from "react-dom";', originalDom],
  [
    "./client.js",
    'import { actorName, useWorkspace, storageScope } from "./client.js";',
    originalClient,
  ],
] as const;
function expand(
  appText: string,
  featureText: string,
  clientText: string,
  storageText: string,
  requireActual: boolean,
) {
  appText = inverseObjectAnnotationsFeature(appText);
  // No-import/nested old lane changes no byte and strips no old counterfactual.
  // A separate actual-new entry below must require the real feature import.
  if (!requireActual && !appText.includes(componentModule)) return appText;
  const parsed = parse({
    App: appText,
    Feature: featureText,
    Expected: expectedFeature,
    Client: clientText,
    Storage: storageText,
    Runtime:
      humanCreationFixed.runtime.clientReexport +
      "\n" +
      humanCreationFixed.runtime.scopedStorageDefinition +
      "\n" +
      humanCreationFixed.runtime.draftKeyDefinition,
  });
  const app = parsed.get("App")!,
    feature = parsed.get("Feature")!,
    expected = parsed.get("Expected")!,
    client = parsed.get("Client")!,
    storage = parsed.get("Storage")!,
    runtime = parsed.get("Runtime")!;
  const imported = imports(app, componentModule);
  if (!requireActual && imported.length === 0) return appText;
  assert.equal(imported.length, 1, "one actual human creation runtime import");
  const declaration = imported[0]!,
    clause = declaration.importClause;
  assert.equal(
    clause?.phaseModifier,
    undefined,
    "actual runtime human creation import",
  );
  assert.ok(
    clause &&
      !clause.name &&
      clause.namedBindings &&
      isNamedImports(clause.namedBindings),
    "same-name named human creation import",
  );
  assert.equal(
    clause.namedBindings.elements.length,
    1,
    "same-name named human creation import",
  );
  const binding = clause.namedBindings.elements[0]!;
  assert.equal(
    binding.name.text,
    "CreateDialog",
    "same-name actual human creation import",
  );
  assert.equal(
    binding.propertyName,
    undefined,
    "same-name actual human creation import",
  );
  assert.equal(
    binding.isTypeOnly,
    false,
    "actual runtime human creation import",
  );
  const symbol = app.symbols.get(binding.name);
  assert.notEqual(symbol, undefined, "resolved actual creation import");
  const consumers = app.nodes
    .filter(isJsxSelfClosingElement)
    .filter((node) => node.tagName.getText() === "CreateDialog");
  assert.equal(consumers.length, 2, "two original actual creation consumers");
  for (const [index, node] of consumers.entries()) {
    assert.equal(
      app.symbols.get(node.tagName),
      symbol,
      "real imported creation symbol, not local shadow",
    );
    assert.equal(
      node.getText(),
      humanCreationFixed.consumers[index]!.raw,
      "complete original creation props keys portal and captured callbacks",
    );
    const paren = node.parent;
    assert.ok(
      isParenthesizedExpression(paren) && isBinaryExpression(paren.parent),
      "original direct conditional creation placement",
    );
    const guard = paren.parent;
    assert.equal(
      guard.operatorToken.kind,
      SyntaxKind.AmpersandAmpersandToken,
      "original creation conditional operator",
    );
    assert.equal(
      guard.right,
      paren,
      "original direct conditional creation placement",
    );
    assert.equal(
      guard.left.getText(),
      humanCreationFixed.guards[index],
      "original document/project creation guard",
    );
    assert.ok(
      isJsxExpression(guard.parent) && isJsxElement(guard.parent.parent),
      "original creation native ancestor",
    );
    assert.equal(
      guard.parent.parent.openingElement.tagName.getText(),
      index === 0 ? "main" : "div",
      "original creation native ancestor",
    );
  }
  assert.deepEqual(
    app.nodes
      .filter(isIdentifier)
      .filter((node) => app.symbols.get(node) === symbol),
    [binding.name, ...consumers.map((node) => node.tagName)],
    "only two direct imported creation uses, no alias or render factory",
  );
  assert.equal(
    app.nodes
      .filter(isFunctionDeclaration)
      .filter((node) => node.name?.text === "CreateDialog").length,
    0,
    "no copied App creation component",
  );
  const component = oneFunction(feature, "CreateDialog");
  assert.equal(
    component.parent,
    feature.source,
    "one module-scope creation component identity",
  );
  assert.deepEqual(
    component.modifiers?.map((node) => node.kind),
    [SyntaxKind.ExportKeyword],
    "one named exported creation component",
  );
  const mapped = component
    .getText()
    .replace(/^export /, "")
    .replace(
      'client: Pick<WorkspaceClient, "execute">;',
      "client: ReturnType<typeof useWorkspace>;",
    );
  assert.equal(
    mapped,
    humanCreationFixed.functionRaw,
    "complete actual Git creation body ten hooks seven props and only approved client Pick",
  );
  assert.deepEqual(
    shape(feature.source),
    shape(expected.source),
    "only reviewed runtime imports, type-only Client and complete creation component",
  );
  for (const name of ["scopedStorage", "draftKey"]) {
    const storageImports = imports(feature, "../../local-preferences.js");
    assert.equal(
      storageImports.length,
      1,
      "actual defining-module storage imports",
    );
    const names = storageImports[0]!.importClause?.namedBindings;
    assert.ok(names && isNamedImports(names));
    const member = names.elements.find((value) => value.name.text === name)!;
    assert.ok(
      member &&
        !member.isTypeOnly &&
        storageImports[0]!.importClause?.phaseModifier === undefined,
      "runtime original storage binding " + name,
    );
    const calls = feature.nodes
      .filter(isCallExpression)
      .filter(
        (node) =>
          isIdentifier(node.expression) && node.expression.text === name,
      );
    assert.equal(calls.length, 1, "original creation storage call " + name);
    assert.equal(
      feature.symbols.get(calls[0]!.expression),
      feature.symbols.get(member.name),
      "actual defining storage binding " + name,
    );
  }
  const reexports = client.source.statements
    .filter(isExportDeclaration)
    .filter(
      (node) =>
        node.moduleSpecifier &&
        isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === "./local-preferences.js",
    );
  assert.equal(
    reexports.length,
    1,
    "original Client storage reexport to same defining module",
  );
  assert.deepEqual(
    shape(reexports[0]!),
    shape(runtime.source.statements[0]!),
    "original Client runtime storage reexport bindings, no wrapper or alias",
  );
  assert.equal(
    oneFunction(storage, "scopedStorage").getText(),
    humanCreationFixed.runtime.scopedStorageDefinition,
    "same original scoped storage definition",
  );
  const key = storage.source.statements
    .filter(isVariableStatement)
    .filter((node) => node.getText().startsWith("export const draftKey ="));
  assert.equal(key.length, 1, "one original draft key definition");
  assert.equal(
    key[0]!.getText(),
    humanCreationFixed.runtime.draftKeyDefinition,
    "same original shared draft key definition",
  );
  for (const [module, reviewed] of reviewedAppImports) {
    const actual = imports(app, module);
    assert.equal(
      actual.length,
      1,
      "one reviewed remaining App import " + module,
    );
    assert.equal(
      actual[0]!.getText(),
      reviewed,
      "only approved unused creation bindings removed " + module,
    );
  }
  assert.equal(
    imports(app, "./useModal.js").length,
    0,
    "only moved App modal import removed",
  );
  const importIndex = app.source.statements.indexOf(declaration);
  assert.equal(
    app.source.statements[importIndex + 1]?.getText(),
    'import { ArtifactEditor } from "./ArtifactEditor.js";',
    "creation import keeps approved original feature slot",
  );
  const workspace = oneFunction(app, "WorkspaceApp");
  let result = uniqueReplace(
    appText,
    declaration.getText() + "\n",
    "",
    "remove only approved creation runtime import",
  );
  for (const [module, reviewed, original] of reviewedAppImports)
    result = uniqueReplace(
      result,
      reviewed,
      original,
      "restore only approved creation import binding " + module,
    );
  result = uniqueReplace(
    result,
    'import { Notifications } from "./Notifications.js";\n',
    'import { Notifications } from "./Notifications.js";\n' +
      originalModal +
      "\n",
    "restore only original modal import position",
  );
  result = uniqueReplace(
    result,
    workspace.getText() + "\n",
    workspace.getText() + "\n" + humanCreationFixed.functionRaw + "\n",
    "restore only complete creation function at original WorkspaceApp successor",
  );
  return result;
}
const readFeature = () =>
  readFileSync(
    new URL(
      "../../apps/web/src/features/creation/CreateDialog.tsx",
      import.meta.url,
    ),
    "utf8",
  );
const readClient = () =>
  readFileSync(
    new URL("../../apps/web/src/client.ts", import.meta.url),
    "utf8",
  );
const readStorage = () =>
  readFileSync(
    new URL("../../apps/web/src/local-preferences.ts", import.meta.url),
    "utf8",
  );
export function inverseHumanCreationFeature(
  appText: string,
  featureText = readFeature(),
  clientText = readClient(),
  storageText = readStorage(),
) {
  return expand(appText, featureText, clientText, storageText, false);
}
export function assertHumanCreationWholeApp(
  appText: string,
  featureText = readFeature(),
  clientText = readClient(),
  storageText = readStorage(),
) {
  const restored = expand(appText, featureText, clientText, storageText, true);
  assert.equal(
    Buffer.byteLength(restored),
    humanCreationFixed.appBytes,
    "whole actual Git778 App bytes after only approved creation inverse",
  );
  assert.equal(
    hash(restored),
    humanCreationFixed.appSHA256,
    "whole actual Git778 App SHA after only approved creation inverse",
  );
  return restored;
}
