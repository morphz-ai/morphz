import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  SyntaxKind,
  isIdentifier,
  isImportDeclaration,
  isJsxAttribute,
  isJsxOpeningElement,
  isJsxSelfClosingElement,
  isStringLiteral,
  isNamedImports,
  isArrayBindingPattern,
  isVariableDeclaration,
  isCallExpression,
  isJsxExpression,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isJsxElement,
  type Node,
} from "typescript/unstable/ast";
import { WorkspaceTopbar } from "../apps/web/src/shell/WorkspaceTopbar.js";
import {
  OriginalWorkspaceTopbar,
  initialTopbarScenario,
  topbarLabels,
  type TopbarScenario,
} from "./fixtures/workspace-topbar-baseline.js";

const actions = {
  onToggleSidebar() {},
  onTravel() {},
  onNavigateView() {},
  onOpenProject() {},
  onToggleCollaboration() {},
};
const slots = { application: null, page: null, detail: null };
const projectControls = createElement(
  "button",
  { "data-project-controls": true },
  "项目菜单",
);
function candidateProps(
  s: TopbarScenario,
): ComponentProps<typeof WorkspaceTopbar> {
  return {
    view: {
      applicationWorkspaceOpen: s.applicationWorkspaceOpen,
      view: s.prefs.view,
      viewLabel: topbarLabels[s.prefs.view],
      projectTitle: s.project.title,
      projectOpen: s.prefs.projectOpen,
      artifact: s.artifact
        ? { title: s.artifact.title, kind: s.artifact.content.kind }
        : null,
      openingObject: s.openingObject,
      creating: s.creating,
      collaborationVisible: s.collaborationVisible,
    },
    history: s.history,
    sidebarExpanded: s.prefs.sidebar,
    slots,
    projectControls,
    ...actions,
  };
}
function equivalent(scenario: TopbarScenario) {
  assert.equal(
    renderToStaticMarkup(
      createElement(WorkspaceTopbar, candidateProps(scenario)),
    ),
    renderToStaticMarkup(
      createElement(OriginalWorkspaceTopbar, {
        scenario,
        slots,
        projectControls,
        actions,
      }),
    ),
    JSON.stringify(scenario),
  );
}

test("Topbar native markup matches the fixed pre-extraction branch oracle", () => {
  let cases = 0;
  for (const view of Object.keys(
    topbarLabels,
  ) as TopbarScenario["prefs"]["view"][])
    for (const applicationWorkspaceOpen of [false, true])
      for (const kind of [null, "document", "pdf", "task"])
        for (const projectOpen of [false, true]) {
          equivalent({
            ...initialTopbarScenario,
            applicationWorkspaceOpen,
            prefs: { ...initialTopbarScenario.prefs, view, projectOpen },
            artifact: kind ? { title: "对象 <&> v2", content: { kind } } : null,
          });
          cases++;
        }
  assert.equal(cases, 80);
});

test("slot visibility, creating/opening and pressed/disabled attributes retain every branch", () => {
  for (const applicationWorkspaceOpen of [false, true])
    for (const present of [false, true])
      for (const openingObject of [false, true])
        for (const creating of [null, "document", "project"] as const)
          equivalent({
            ...initialTopbarScenario,
            applicationWorkspaceOpen,
            openingObject,
            creating,
            artifact: present
              ? { title: "", content: { kind: "document" } }
              : null,
          });
  for (const index of [-1, 0, 1, 2, 3, Number.NaN])
    for (const length of [0, 1, 3])
      equivalent({ ...initialTopbarScenario, history: { index, length } });
  for (const sidebar of [false, true])
    for (const collaborationVisible of [false, true])
      equivalent({
        ...initialTopbarScenario,
        prefs: { ...initialTopbarScenario.prefs, sidebar },
        collaborationVisible,
        artifact: { title: "对象", content: { kind: "document" } },
      });
});

function shellContract(text: string) {
  const directory = "/topbar-boundary-fixture",
    config = `${directory}/tsconfig.json`,
    path = `${directory}/WorkspaceTopbar.tsx`;
  const api = new API({
    cwd: directory,
    fs: createVirtualFileSystem({
      [path]: text,
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
        files: [path],
      }),
    }),
  });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const program = snapshot.getProject(config)!.program;
    assert.deepEqual(program.getSyntacticDiagnostics(), []);
    const source = program.getSourceFile(path)!;
    const runtimeImports: string[] = [],
      refs: string[] = [],
      tags: string[] = [],
      forbidden: string[] = [];
    const visit = (node: Node) => {
      if (
        isImportDeclaration(node) &&
        node.importClause?.phaseModifier !== SyntaxKind.TypeKeyword
      )
        runtimeImports.push(
          isStringLiteral(node.moduleSpecifier)
            ? node.moduleSpecifier.text
            : "invalid",
        );
      if (isJsxOpeningElement(node) || isJsxSelfClosingElement(node))
        tags.push(node.tagName.getText());
      if (isJsxAttribute(node) && node.name.getText() === "ref")
        refs.push(node.initializer!.getText());
      if (
        isIdentifier(node) &&
        [
          "useState",
          "useEffect",
          "useLayoutEffect",
          "createPortal",
          "localStorage",
          "sessionStorage",
          "fetch",
          "applicationCall",
          "useWorkspace",
          "IconButton",
          "memo",
          "window",
          "document",
          "navigator",
          "setTimeout",
          "setInterval",
          "requestAnimationFrame",
        ].includes(node.text)
      )
        forbidden.push(node.text);
      if (isJsxAttribute(node) && node.name.getText() === "key")
        forbidden.push("key");
      node.forEachChild(visit);
    };
    visit(source);
    assert.deepEqual(runtimeImports, ["lucide-react", "../SidebarToggle.js"]);
    assert.deepEqual(refs, [
      "{slots.application}",
      "{slots.page}",
      "{slots.detail}",
    ]);
    assert.equal(tags.filter((tag) => tag === "header").length, 1);
    assert.deepEqual(forbidden, []);
  } finally {
    snapshot.dispose();
    api.close();
  }
}

test("new chrome owner is a bounded shell renderer with exact direct slot refs", () => {
  const text = readFileSync(
    new URL("../apps/web/src/shell/WorkspaceTopbar.tsx", import.meta.url),
    "utf8",
  );
  shellContract(text);
  assert.throws(() =>
    shellContract(
      text.replace("ref={slots.page}", "ref={(node) => slots.page(node)}"),
    ),
  );
  assert.throws(() =>
    shellContract(
      text.replace('className="topbar"', 'key={view.view} className="topbar"'),
    ),
  );
  assert.throws(() =>
    shellContract('import { useEffect } from "react";\n' + text),
  );
});

// This governs only the migrated App seam, not unrelated JSX, hooks or commands.
function appTopbarContract(text: string) {
  const directory = "/topbar-app-fixture",
    config = `${directory}/tsconfig.json`,
    path = `${directory}/App.tsx`;
  const api = new API({
    cwd: directory,
    fs: createVirtualFileSystem({
      [path]: text,
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
        files: [path],
      }),
    }),
  });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const project = snapshot.getProject(config)!,
      source = project.program.getSourceFile(path)!;
    assert.deepEqual(
      project.program.getSyntacticDiagnostics(),
      [],
      "valid App fixture syntax",
    );
    const nodes: Node[] = [],
      identifiers: Node[] = [];
    const visit = (node: Node) => {
      nodes.push(node);
      if (isIdentifier(node)) identifiers.push(node);
      node.forEachChild(visit);
    };
    visit(source);
    const resolved = project.checker.getSymbolAtLocation(identifiers),
      symbols = new Map(
        identifiers.map((node, index) => [node, resolved[index]?.id]),
      );
    const imports = nodes.filter(isImportDeclaration);
    const ownerImports = imports.filter(
      (node) =>
        isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === "./shell/WorkspaceTopbar.js",
    );
    assert.equal(ownerImports.length, 1, "one actual chrome owner import");
    const clause = ownerImports[0]!.importClause;
    assert.ok(
      clause &&
        clause.phaseModifier !== SyntaxKind.TypeKeyword &&
        clause.namedBindings &&
        isNamedImports(clause.namedBindings),
    );
    const ownerNames = clause.namedBindings.elements.filter(
      (item) =>
        !item.isTypeOnly &&
        (item.propertyName ?? item.name).text === "WorkspaceTopbar",
    );
    assert.equal(ownerNames.length, 1);
    const binding = symbols.get(ownerNames[0]!.name);
    assert.ok(binding !== undefined, "actual import binding resolved");
    const renders = nodes
      .filter(isJsxSelfClosingElement)
      .filter(
        (node) =>
          isIdentifier(node.tagName) && symbols.get(node.tagName) === binding,
      );
    assert.equal(
      renders.length,
      1,
      "one render of the imported owner, not a shadow",
    );
    const render = renders[0]!;
    const uses = identifiers.filter((node) => symbols.get(node) === binding);
    assert.deepEqual(
      uses,
      [ownerNames[0]!.name, render.tagName],
      "governed import has no alias/call/second render",
    );
    assert.ok(
      isJsxElement(render.parent),
      "unconditional direct native-parent render",
    );
    assert.equal(render.parent.openingElement.tagName.getText(), "div");
    const parentClass = render.parent.openingElement.attributes.properties.find(
      (node) => isJsxAttribute(node) && node.name.getText() === "className",
    );
    assert.ok(
      parentClass &&
        isJsxAttribute(parentClass) &&
        parentClass.initializer &&
        isStringLiteral(parentClass.initializer),
    );
    assert.equal(
      parentClass.initializer.text,
      "workspace",
      "keep workspace direct child",
    );
    assert.equal(
      render.attributes.properties.some(
        (node) => isJsxAttribute(node) && node.name.getText() === "key",
      ),
      false,
      "no new remount key",
    );
    assert.equal(
      render.parent.openingElement.attributes.properties.some(
        (node) => isJsxAttribute(node) && node.name.getText() === "key",
      ),
      false,
      "no parent remount key",
    );
    const oldHeaders = nodes
      .filter(
        (node) => isJsxOpeningElement(node) || isJsxSelfClosingElement(node),
      )
      .filter((node) => node.tagName.getText() === "header")
      .filter((node) => {
        const attribute = node.attributes.properties.find(
          (item) => isJsxAttribute(item) && item.name.getText() === "className",
        );
        if (!attribute || !isJsxAttribute(attribute) || !attribute.initializer)
          return false;
        const value = isJsxExpression(attribute.initializer)
          ? attribute.initializer.expression
          : attribute.initializer;
        return (
          !!value &&
          (isStringLiteral(value) ||
            value.kind === SyntaxKind.NoSubstitutionTemplateLiteral) &&
          value.getText().slice(1, -1).split(/\s+/).includes("topbar")
        );
      });
    assert.equal(oldHeaders.length, 0, "no retained literal old native topbar");
    const stateImports = imports
      .filter(
        (node) =>
          isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text === "react",
      )
      .flatMap((node) =>
        node.importClause?.namedBindings &&
        isNamedImports(node.importClause.namedBindings)
          ? node.importClause.namedBindings.elements
          : [],
      );
    const useState = stateImports.find(
      (item) => (item.propertyName ?? item.name).text === "useState",
    );
    assert.ok(useState);
    const useStateBinding = symbols.get(useState.name);
    const expected = {
      application: ["toolbarTarget", "setToolbarTarget"],
      page: ["pageToolbarTarget", "setPageToolbarTarget"],
      detail: ["detailToolbarTarget", "setDetailToolbarTarget"],
    };
    const setterBindings = new Map<string, number>();
    for (const [slot, [valueName, setterName]] of Object.entries(expected)) {
      const declarations = nodes
        .filter(isVariableDeclaration)
        .filter(
          (node) =>
            isArrayBindingPattern(node.name) &&
            node.name.elements.length === 2 &&
            node.name.elements[0]!.getText() === valueName &&
            node.name.elements[1]!.getText() === setterName,
        );
      assert.equal(declarations.length, 1, slot);
      const declaration = declarations[0]!;
      assert.ok(
        declaration.initializer && isCallExpression(declaration.initializer),
      );
      assert.equal(
        symbols.get(declaration.initializer.expression),
        useStateBinding,
        "original React state registration",
      );
      assert.equal(declaration.initializer.arguments.length, 1);
      assert.equal(
        declaration.initializer.arguments[0]!.kind,
        SyntaxKind.NullKeyword,
      );
      const element = isArrayBindingPattern(declaration.name)
        ? declaration.name.elements[1]!
        : undefined;
      assert.ok(element);
      const names: Node[] = [];
      element.forEachChild((node) => {
        if (isIdentifier(node)) names.push(node);
      });
      const setter = symbols.get(names[0]!);
      assert.ok(setter !== undefined);
      setterBindings.set(slot, setter);
    }
    const slots = render.attributes.properties.find(
      (node) => isJsxAttribute(node) && node.name.getText() === "slots",
    );
    assert.ok(
      slots &&
        isJsxAttribute(slots) &&
        slots.initializer &&
        isJsxExpression(slots.initializer) &&
        slots.initializer.expression &&
        isObjectLiteralExpression(slots.initializer.expression),
    );
    const assignments = slots.initializer.expression.properties;
    assert.equal(assignments.length, 3);
    for (const property of assignments) {
      assert.ok(
        isPropertyAssignment(property) &&
          isIdentifier(property.name) &&
          isIdentifier(property.initializer),
        "direct original setters, not callback wrappers",
      );
      assert.equal(
        symbols.get(property.initializer),
        setterBindings.get(property.name.text),
        property.name.text,
      );
      setterBindings.delete(property.name.text);
    }
    assert.equal(setterBindings.size, 0);
  } finally {
    snapshot.dispose();
    api.close();
  }
}

test("actual App consumes the imported topbar once with direct original state-setter slots", () => {
  const text = readFileSync(
    new URL("../apps/web/src/App.tsx", import.meta.url),
    "utf8",
  );
  appTopbarContract(text);
  appTopbarContract(
    text
      .replace(
        "import { WorkspaceTopbar }",
        "import { WorkspaceTopbar as Chrome }",
      )
      .replace("<WorkspaceTopbar\n", "<Chrome\n"),
  );
  const cases: [string, string][] = [
    [
      "foreign module",
      text.replace(
        'from "./shell/WorkspaceTopbar.js"',
        'from "./other-topbar.js"',
      ),
    ],
    [
      "local same-name shadow",
      text.replace(
        "  const profile = useProfile(client);",
        "  const WorkspaceTopbar = () => null;\n  const profile = useProfile(client);",
      ),
    ],
    [
      "wrapped ref",
      text.replace(
        "application: setToolbarTarget",
        "application: (node) => setToolbarTarget(node)",
      ),
    ],
    [
      "wrong original setter",
      text.replace(
        "application: setToolbarTarget",
        "application: setPageToolbarTarget",
      ),
    ],
    [
      "remount key",
      text.replace("<WorkspaceTopbar\n", "<WorkspaceTopbar key={contextKey}\n"),
    ],
    [
      "parent remount key",
      text.replace(
        'className="workspace"',
        'key={contextKey} className="workspace"',
      ),
    ],
    [
      "second render",
      text.replace(
        "{inspectorControls}",
        "<WorkspaceTopbar />{inspectorControls}",
      ),
    ],
    [
      "old native header",
      text.replace(
        "{inspectorControls}",
        '<header className="topbar" />{inspectorControls}',
      ),
    ],
  ];
  for (const [name, candidate] of cases) {
    assert.notEqual(candidate, text, name);
    assert.throws(
      () => appTopbarContract(candidate),
      (error) =>
        error instanceof Error &&
        !error.message.includes("valid App fixture syntax"),
      name,
    );
  }
});
