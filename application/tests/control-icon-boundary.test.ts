import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  SyntaxKind,
  isAsExpression,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isJsxSelfClosingElement,
  isNamedImports,
  isParenthesizedExpression,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  type Identifier,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";

// Finite first-batch ownership: these seven glyphs, this primitive and three
// consumers. Old Menu/ComposerOptions and other native buttons remain legal.
// These AST contracts prove dependency/wiring shape, not mounted React or CSS.
const paths = {
  registry: "apps/web/src/design/control-icons.tsx",
  primitive: "apps/web/src/ui/IconButton.tsx",
  sidebar: "apps/web/src/SidebarToggle.tsx",
  tools: "apps/web/src/ComposerToolButtons.tsx",
  exchange: "apps/web/src/ExchangePanel.tsx",
};
const originalGlyphs = {
  "panel-left": "PanelLeft",
  "panel-right": "PanelRight",
  "message-square-text": "MessageSquareText",
  maximize: "Maximize2",
  minimize: "Minimize2",
  pin: "Pin",
  "chevron-down": "ChevronDown",
};
const oracleText = `
const registry = { "panel-left": PanelLeft, "panel-right": PanelRight, "message-square-text": MessageSquareText, maximize: Maximize2, minimize: Minimize2, pin: Pin, "chevron-down": ChevronDown };
const roles = { "sidebar-visibility": ["panel-left", "panel-right"], "exchange-operation": ["message-square-text", "maximize", "minimize", "pin", "chevron-down"] };
type ButtonProps = Omit<ComponentPropsWithRef<"button">, "children" | "dangerouslySetInnerHTML"> & ControlIconSelection & { afterIcon?: ReactNode };
function icon({ name }: { name: ControlIconId }) {
  if (!Object.hasOwn(controlIcons, name)) throw new TypeError("Unknown control icon");
  const Icon = controlIcons[name];
  return <Icon />;
}
function guard(role: ControlRole, name: ControlIconId): void {
  if (!Object.hasOwn(controlRoleIcons, role) || !Object.hasOwn(controlIcons, name)) throw new TypeError("Unknown control role or icon");
  const allowed: readonly ControlIconId[] = controlRoleIcons[role];
  if (!allowed.includes(name)) throw new TypeError("Control icon does not belong to this role");
}
function button({ controlRole, iconId, afterIcon, ...buttonProps }: IconButtonProps) {
  assertControlIconRole(controlRole, iconId);
  return <button {...buttonProps}><ControlIcon name={iconId} />{afterIcon}</button>;
}
function sidebar() { return <IconButton
  controlRole="sidebar-visibility"
  iconId={side === "left" ? "panel-left" : "panel-right"}
  className={\`icon-button sidebar-visibility-toggle \$\{className\}\`}
  aria-label={label} title={title ?? label} aria-expanded={expanded}
  aria-controls={controls} onClick={onClick} />; }
function tools() { return <IconButton key={option.id ?? option.label}
  controlRole="exchange-operation" iconId={option.iconId}
  className={"icon-button composer-tool" + (option.groupStart ? " composer-tool-group-start" : "") + (option.reserveOnly ? " composer-tool-reserved" : "")}
  aria-label={option.label} aria-hidden={option.reserveOnly || undefined}
  aria-pressed={option.pressed} aria-description={unread && option.id === "history-visibility" ? "有新回复" : undefined}
  title={option.title ?? option.label} disabled={option.disabled || option.reserveOnly} onClick={option.onSelect}
  afterIcon={unread && option.id === "history-visibility" && <span className="composer-unread" aria-hidden="true" />} />; }
function hide() { return <IconButton controlRole="exchange-operation" iconId="chevron-down"
  ref={hide} className="icon-button" aria-label="收起 AI 输入框" title="收起 AI 输入框" onClick={onHide} />; }
function compact() { return <ComposerOptions label="更多交流选项" menuLabel="交流选项" below={conversationVisible}
  options={secondaryOptions.map(({ iconId, ...option }) => ({ ...option, icon: <ControlIcon name={iconId} /> }))} />; }
const secondary = [
  { id: "history-size", label: historyVisible ? "返回工作内容" : "展开完整记录", iconId: historyVisible ? "minimize" : "maximize", pressed: historyVisible, onSelect: () => onInteraction(historyVisible ? "recent" : "history") },
  { id: "pin", label: pinned ? "取消固定输入框" : "固定输入框", iconId: "pin", pressed: pinned, onSelect: onPin },
];
const visible = [{ id: "history-visibility", label: conversationVisible ? "收起交流记录" : "查看交流记录", iconId: "message-square-text", pressed: conversationVisible, onSelect: () => onInteraction(conversationVisible ? "input" : "recent") }];
function exchangeLifecycle() {
  const tools = useRef<HTMLDivElement>(null);
  const hide = useRef<HTMLButtonElement>(null);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const root = tools.current;
    const panel = root?.closest<HTMLElement>(".exchange-panel");
    if (!root || !panel) return;
    let previous = false;
    const measure = () => {
      const next = panel.clientWidth <= 620;
      if (next === previous) return;
      previous = next;
      const history = root.querySelector<HTMLButtonElement>(":scope > button");
      const focused = document.activeElement;
      if (focused && root.contains(focused) && focused !== history && focused !== hide.current)
        history?.focus({ preventScroll: true });
      setCompact(next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    measure();
    return () => observer.disconnect();
  }, []);
}
`;
type Parsed = { source: SourceFile; symbols: Map<Node, number> };
function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}
function parse(contents: Record<string, string>): Map<string, Parsed> {
  const directory = "/control-icon-boundary-fixtures";
  const config = `${directory}/tsconfig.json`;
  const files = Object.fromEntries(
    Object.entries(contents).map(([name, source]) => [
      `${directory}/${name}.tsx`,
      source,
    ]),
  );
  files[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
    files: Object.keys(contents).map((name) => `${name}.tsx`),
  });
  const api = new API({ cwd: directory, fs: createVirtualFileSystem(files) });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const project = snapshot.getProject(config)!;
      assert.deepEqual(
        project.program.getSyntacticDiagnostics(),
        [],
        "Malformed fixtures cannot pass",
      );
      return new Map(
        Object.keys(contents).map((name) => {
          const source = project.program.getSourceFile(
            `${directory}/${name}.tsx`,
          )!;
          const names: Identifier[] = [];
          walk(source, (node) => {
            if (isIdentifier(node)) names.push(node);
          });
          const resolved = project.checker.getSymbolAtLocation(names);
          const symbols = new Map<Node, number>();
          names.forEach((node, index) => {
            if (resolved[index]) symbols.set(node, resolved[index]!.id);
          });
          return [name, { source, symbols }];
        }),
      );
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}
function nodes(source: Node, predicate: (node: Node) => boolean): Node[] {
  const found: Node[] = [];
  walk(source, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
}
function syntax(node: Node): unknown {
  if (isParenthesizedExpression(node)) return syntax(node.expression);
  if (node.kind === SyntaxKind.JsxText)
    return [node.kind, node.getText().trim()];
  const children: unknown[] = [];
  node.forEachChild((child) => {
    if (
      child.kind === SyntaxKind.JsxText &&
      /[\r\n]/.test(child.getSourceFile().text.slice(child.pos, child.end)) &&
      !child.getSourceFile().text.slice(child.pos, child.end).trim()
    )
      return;
    children.push(syntax(child));
  });
  return [node.kind, children.length ? children : node.getText()];
}
function same(a: Node | undefined, b: Node | undefined) {
  return !!a && !!b && JSON.stringify(syntax(a)) === JSON.stringify(syntax(b));
}
function declaration(source: SourceFile, name: string) {
  return nodes(
    source,
    (node) =>
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.name.text === name,
  ).filter(isVariableDeclaration)[0];
}
function fn(source: SourceFile, name: string) {
  return nodes(
    source,
    (node) => isFunctionDeclaration(node) && node.name?.text === name,
  ).filter(isFunctionDeclaration)[0];
}
const oracle = parse({ oracle: oracleText }).get("oracle")!.source;
const oracleElement = (name: string) =>
  nodes(fn(oracle, name)!, isJsxSelfClosingElement).filter(
    isJsxSelfClosingElement,
  )[0]!;
function imports(parsed: Parsed, path: string) {
  const result = new Map<string, number>();
  walk(parsed.source, (node) => {
    if (
      !isImportDeclaration(node) ||
      !isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== path ||
      !node.importClause?.namedBindings ||
      !isNamedImports(node.importClause.namedBindings)
    )
      return;
    for (const item of node.importClause.namedBindings.elements) {
      if (
        item.isTypeOnly ||
        node.importClause.phaseModifier === SyntaxKind.TypeKeyword
      )
        continue;
      const id = parsed.symbols.get(item.name);
      if (id !== undefined)
        result.set((item.propertyName ?? item.name).text, id);
    }
  });
  return result;
}
function ownership(contents: Record<keyof typeof paths, string>): string[] {
  const parsed = parse(contents);
  const problems: string[] = [];
  const check = (valid: boolean, name: string) => {
    if (!valid) problems.push(name);
  };
  const allowed = {
    registry: new Set(["lucide-react"]),
    primitive: new Set(["../design/control-icons.js"]),
    sidebar: new Set(["./ui/IconButton.js"]),
    tools: new Set(["./ui/IconButton.js"]),
    exchange: new Set([
      "react",
      "./design/control-icons.js",
      "./ui/IconButton.js",
      "./ComposerOptions.js",
      "./ComposerToolButtons.js",
      "./ExchangeResizeHandle.js",
    ]),
  };
  const typeAllowed = {
    registry: new Set<string>(),
    primitive: new Set(["react", "../design/control-icons.js"]),
    sidebar: new Set<string>(),
    tools: new Set(["./design/control-icons.js", "./ui/IconButton.js"]),
    exchange: new Set([...allowed.exchange, "./interaction.js"]),
  };
  for (const [name, input] of parsed) {
    const owner = name as keyof typeof paths;
    walk(input.source, (node) => {
      if (isImportDeclaration(node)) {
        const path = isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : "";
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        check(
          !!clause && !!bindings && isNamedImports(bindings),
          `explicit-import:${owner}`,
        );
        if (bindings && isNamedImports(bindings))
          for (const item of bindings.elements) {
            const typeOnly =
              clause?.phaseModifier === SyntaxKind.TypeKeyword ||
              item.isTypeOnly;
            check(
              (typeOnly ? typeAllowed[owner] : allowed[owner]).has(path),
              `dependency:${owner}`,
            );
            if (owner === "registry")
              check(
                Object.values(originalGlyphs).includes(
                  (item.propertyName ?? item.name).text,
                ),
                "only-seven-lucide-imports",
              );
          }
      }
      if ((owner === "registry" || owner === "primitive") && isIdentifier(node))
        check(
          ![
            "window",
            "document",
            "matchMedia",
            "fetch",
            "WebSocket",
            "localStorage",
            "sessionStorage",
            "client",
            "useState",
            "useRef",
            "useEffect",
            "useLayoutEffect",
            "useSyncExternalStore",
          ].includes(node.text),
          `no-policy-or-effects:${owner}`,
        );
    });
  }
  const registry = parsed.get("registry")!;
  const glyphs = declaration(registry.source, "controlIcons")?.initializer;
  const unwrappedGlyphs =
    glyphs && isAsExpression(glyphs) ? glyphs.expression : glyphs;
  check(
    same(unwrappedGlyphs, declaration(oracle, "registry")!.initializer),
    "exact-seven-registered-constructors",
  );
  const lucide = imports(registry, "lucide-react");
  const bindings = nodes(
    unwrappedGlyphs ?? registry.source,
    isIdentifier,
  ).filter(isIdentifier);
  for (const name of Object.values(originalGlyphs)) {
    const values = bindings.filter((node) => node.text === name);
    check(
      values.length === 1 &&
        lucide.has(name) &&
        registry.symbols.get(values[0]!) === lucide.get(name),
      "registry-real-import-not-shadowed",
    );
  }
  const roles = declaration(registry.source, "controlRoleIcons")?.initializer;
  check(
    same(
      roles && isAsExpression(roles) ? roles.expression : roles,
      declaration(oracle, "roles")!.initializer,
    ),
    "exact-role-icon-matrix",
  );
  check(
    same(fn(registry.source, "ControlIcon")?.body, fn(oracle, "icon")!.body),
    "original-svg-no-added-attrs-or-fallback",
  );
  check(
    same(
      fn(registry.source, "assertControlIconRole")?.body,
      fn(oracle, "guard")!.body,
    ),
    "own-property-and-role-validation",
  );
  const primitive = parsed.get("primitive")!;
  check(
    same(
      fn(primitive.source, "IconButton")?.body,
      fn(oracle, "button")!.body,
    ) &&
      same(
        fn(primitive.source, "IconButton")?.parameters[0],
        fn(oracle, "button")!.parameters[0],
      ),
    "one-native-button-original-ref-props-no-defaults",
  );
  const props = nodes(
    primitive.source,
    (node) =>
      isTypeAliasDeclaration(node) && node.name.text === "IconButtonProps",
  ).filter(isTypeAliasDeclaration)[0];
  const oracleProps = nodes(
    oracle,
    (node) => isTypeAliasDeclaration(node) && node.name.text === "ButtonProps",
  ).filter(isTypeAliasDeclaration)[0];
  check(
    same(props?.type, oracleProps?.type),
    "typed-icon-role-not-reactnode-children",
  );
  const primitiveImports = imports(primitive, "../design/control-icons.js");
  for (const name of ["ControlIcon", "assertControlIconRole"]) {
    const used = nodes(
      fn(primitive.source, "IconButton")!,
      (node) => isIdentifier(node) && node.text === name,
    ).filter(isIdentifier);
    check(
      used.length === 1 &&
        primitive.symbols.get(used[0]!) === primitiveImports.get(name),
      "primitive-real-registry-import",
    );
  }
  for (const name of ["sidebar", "tools", "exchange"] as const) {
    const consumer = parsed.get(name)!;
    const scope = fn(
      consumer.source,
      {
        sidebar: "SidebarToggle",
        tools: "ComposerToolButtons",
        exchange: "ExchangeControls",
      }[name],
    );
    check(!!scope, `explicit-consumer-scope:${name}`);
    if (!scope) continue;
    const entries = imports(consumer, "./ui/IconButton.js");
    const elements = nodes(scope, isJsxSelfClosingElement)
      .filter(isJsxSelfClosingElement)
      .filter(
        (element) =>
          isIdentifier(element.tagName) &&
          element.tagName.text === "IconButton",
      );
    check(
      elements.length === 1 &&
        entries.has("IconButton") &&
        consumer.symbols.get(elements[0]?.tagName as Node) ===
          entries.get("IconButton"),
      `one-real-consumer:${name}`,
    );
    check(
      same(elements[0], oracleElement(name === "exchange" ? "hide" : name)),
      `original-consumer-attrs-events-keys:${name}`,
    );
    check(
      nodes(
        scope,
        (node) =>
          (node.kind === SyntaxKind.JsxOpeningElement ||
            node.kind === SyntaxKind.JsxSelfClosingElement) &&
          "tagName" in node &&
          (node.tagName as Node).getText() === "button",
      ).length === 0,
      `no-native-consumer-bypass:${name}`,
    );
  }
  const exchange = parsed.get("exchange")!;
  const exchangeScope = fn(exchange.source, "ExchangeControls");
  if (!exchangeScope) return [...problems, "missing-exchange-controls"];
  const lifecycle = fn(oracle, "exchangeLifecycle")!;
  const layoutEffects = (source: Node) =>
    nodes(source, isCallExpression)
      .filter(isCallExpression)
      .filter(
        (node) =>
          isIdentifier(node.expression) &&
          node.expression.text === "useLayoutEffect",
      );
  const effects = layoutEffects(exchangeScope);
  check(
    effects.length === 1 && same(effects[0], layoutEffects(lifecycle)[0]),
    "original-620px-observer-focus-exceptions-and-effect-dependencies",
  );
  for (const name of ["tools", "hide"]) {
    check(
      same(
        declaration(exchange.source, name)?.initializer,
        nodes(lifecycle, isVariableDeclaration)
          .filter(isVariableDeclaration)
          .find((node) => isIdentifier(node.name) && node.name.text === name)
          ?.initializer,
      ),
      `original-object-ref-initializer:${name}`,
    );
  }
  const compactState = (source: Node) =>
    nodes(source, isVariableDeclaration)
      .filter(isVariableDeclaration)
      .find((node) => node.name.getText() === "[compact, setCompact]");
  check(
    same(compactState(exchangeScope), compactState(lifecycle)),
    "original-compact-state-without-trigger-remount-strategy",
  );
  const compact = nodes(exchangeScope, isJsxSelfClosingElement)
    .filter(isJsxSelfClosingElement)
    .filter(
      (node) =>
        isIdentifier(node.tagName) && node.tagName.text === "ComposerOptions",
    );
  check(
    compact.length === 1 && same(compact[0], oracleElement("compact")),
    "compact-only-adapter-keeps-legacy-menu-interface",
  );
  check(
    same(
      declaration(exchange.source, "secondaryOptions")?.initializer,
      declaration(oracle, "secondary")!.initializer,
    ),
    "secondary-original-label-pressed-and-events",
  );
  const toolCalls = nodes(exchangeScope, isJsxSelfClosingElement)
    .filter(isJsxSelfClosingElement)
    .filter(
      (node) =>
        isIdentifier(node.tagName) &&
        node.tagName.text === "ComposerToolButtons",
    );
  check(toolCalls.length === 2, "two-original-direct-tool-consumers");
  const visible = toolCalls[0]?.attributes.properties.find((attr) =>
    attr.getText().startsWith("options="),
  );
  const visibleExpression =
    visible &&
    "initializer" in visible &&
    visible.initializer &&
    "expression" in visible.initializer
      ? (visible.initializer.expression as Node)
      : undefined;
  check(
    same(visibleExpression, declaration(oracle, "visible")!.initializer),
    "visible-history-original-label-pressed-and-event",
  );
  const direct = toolCalls[1]?.attributes.properties.find((attr) =>
    attr.getText().startsWith("options="),
  );
  check(
    direct?.getText() === "options={secondaryOptions}",
    "wide-secondary-no-transformed-options",
  );
  return problems;
}
const contents = Object.fromEntries(
  Object.entries(paths).map(([name, path]) => [
    name,
    readFileSync(path, "utf8"),
  ]),
) as Record<keyof typeof paths, string>;
function changed(source: string, from: string, to: string) {
  assert.ok(source.includes(from), `Fixture target missing: ${from}`);
  return source.replace(from, to);
}
function reject(owner: keyof typeof paths, source: string) {
  assert.ok(
    ownership({ ...contents, [owner]: source }).length > 0,
    `${owner} violation must be rejected`,
  );
}
test("first control registry/primitive/consumers obey bounded dependencies, roles and original wiring", () => {
  assert.deepEqual(ownership(contents), []);
});
test("registry gate rejects new glyphs, prototype guards, wrong role mapping and SVG policy", () => {
  for (const source of [
    contents.registry + '\nimport { Activity } from "lucide-react";',
    contents.registry + '\nimport { client } from "../client.js";',
    changed(
      contents.registry,
      '"panel-left": PanelLeft,',
      '"panel-left": PanelRight,',
    ),
    changed(
      contents.registry,
      '"sidebar-visibility": ["panel-left", "panel-right"]',
      '"sidebar-visibility": ["panel-left", "panel-right", "pin"]',
    ),
    changed(
      contents.registry,
      "Object.hasOwn(controlIcons, name)",
      "name in controlIcons",
    ),
    changed(
      contents.registry,
      "return <Icon />;",
      'return <Icon aria-hidden="true" focusable="false" size={13} />;',
    ),
    changed(
      contents.registry,
      "const Icon = controlIcons[name];",
      "const Icon = Pin;",
    ),
  ])
    reject("registry", source);
});
test("primitive gate rejects extra DOM/defaults, ref wrappers, arbitrary icons and business effects", () => {
  for (const source of [
    contents.primitive +
      '\nimport { deriveWorkSurface } from "../host/work-surface.js";',
    contents.primitive + '\nimport { useState } from "react";',
    changed(
      contents.primitive,
      "<button {...buttonProps}>",
      '<button type="button" className="icon-button" {...buttonProps}>',
    ),
    changed(
      contents.primitive,
      "<button {...buttonProps}>",
      "<button {...buttonProps} role={controlRole}>",
    ),
    changed(
      contents.primitive,
      "<button {...buttonProps}>",
      "<button {...buttonProps} ref={(node) => buttonProps.ref(node)}>",
    ),
    changed(
      contents.primitive,
      "<ControlIcon name={iconId} />",
      "{afterIcon || <ControlIcon name={iconId} />}",
    ),
    changed(
      contents.primitive,
      "<ControlIcon name={iconId} />",
      "<span><ControlIcon name={iconId} /></span>",
    ),
    changed(
      contents.primitive,
      "  assertControlIconRole(controlRole, iconId);",
      "  const ControlIcon = () => null;\n  assertControlIconRole(controlRole, iconId);",
    ),
    changed(
      contents.primitive,
      "  ControlIconSelection &",
      "  { controlRole: string; iconId: ReactNode } &",
    ),
  ])
    reject("primitive", source);
});
test("consumer gate rejects bypasses, roles, key/props drift and compact menu rewrites", () => {
  reject(
    "sidebar",
    contents.sidebar + '\nimport { PanelLeft } from "lucide-react";',
  );
  reject(
    "sidebar",
    changed(
      contents.sidebar,
      'controlRole="sidebar-visibility"',
      'controlRole="exchange-operation"',
    ),
  );
  reject(
    "sidebar",
    changed(
      contents.sidebar,
      "title={title ?? label}",
      "title={title || label}",
    ),
  );
  reject(
    "tools",
    changed(
      contents.tools,
      "key={option.id ?? option.label}",
      "key={option.label}",
    ),
  );
  reject(
    "tools",
    changed(contents.tools, "iconId={option.iconId}", 'iconId="panel-left"'),
  );
  reject(
    "tools",
    changed(
      contents.tools,
      "disabled={option.disabled || option.reserveOnly}",
      "disabled={option.disabled}",
    ),
  );
  reject(
    "tools",
    changed(
      contents.tools,
      "onClick={option.onSelect}",
      "onClick={() => option.onSelect()}",
    ),
  );
  reject(
    "tools",
    changed(contents.tools, 'aria-hidden="true"', 'aria-hidden="false"'),
  );
  reject("exchange", changed(contents.exchange, "ref={hide}", "ref={tools}"));
  reject(
    "exchange",
    changed(contents.exchange, 'label="更多交流选项"', 'label="更多输入选项"'),
  );
  reject(
    "exchange",
    changed(contents.exchange, "below={conversationVisible}", "below={false}"),
  );
  reject(
    "exchange",
    changed(
      contents.exchange,
      "<ComposerToolButtons options={secondaryOptions} />",
      '<button className="icon-button" />',
    ),
  );
  reject(
    "exchange",
    changed(
      contents.exchange,
      'iconId: historyVisible ? "minimize" : "maximize"',
      'iconId: historyVisible ? "maximize" : "minimize"',
    ),
  );
});
test("unmigrated native buttons and legacy ReactNode menus are outside this finite gate", () => {
  assert.deepEqual(
    ownership({
      ...contents,
      exchange:
        contents.exchange +
        "\nfunction LegacyView() { return <div><button>Existing feature action</button><ComposerOptions options={[]} triggerIcon={null} /></div>; }",
    }),
    [],
  );
  // An unrelated file is not included in this batch's explicit source map.
  assert.deepEqual(ownership(contents), []);
});
test("bounded Exchange lifecycle gate rejects threshold, focus/ref, dependencies and observer cleanup drift", () => {
  for (const [from, to] of [
    ["panel.clientWidth <= 620", "panel.clientWidth < 620"],
    ["panel.clientWidth <= 620", "panel.getBoundingClientRect().width <= 620"],
    ["focused !== hide.current", "focused !== tools.current"],
    ["focused !== history &&", "true &&"],
    ["history?.focus({ preventScroll: true });", "history?.focus();"],
    [
      "const hide = useRef<HTMLButtonElement>(null);",
      "const hide = useRef<HTMLButtonElement>(document.createElement('button'));",
    ],
    [
      "const [compact, setCompact] = useState(false);",
      "const [compact, setCompact] = useState(true);",
    ],
    ["return () => observer.disconnect();", "return () => {};"],
    [
      "return () => observer.disconnect();\n  }, []);",
      "return () => observer.disconnect();\n  }, [conversationVisible]);",
    ],
    ["      setCompact(next);", "      setCompact(!next);"],
  ])
    reject("exchange", changed(contents.exchange, from!, to!));
});
