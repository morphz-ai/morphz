import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expandWorkspaceContentOpeningConsumption } from "./fixtures/workspace-content-opening-consumption.js";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  SyntaxKind,
  isArrayBindingPattern,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isJsxSelfClosingElement,
  isMethodDeclaration,
  isNamedImports,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  isVariableStatement,
  type CallExpression,
  type FunctionDeclaration,
  type Identifier,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";

// This finite gate covers the navigation owner and its actual Host seams, not
// arbitrary JS semantics, the rest of App, React commit scheduling or visuals.
// These AST fixtures retain the original ordering and dependency contract;
// command outcomes/races are separately exercised against the real factory.
const oracleText = `
function state() {
  const [openingObject, setOpeningObject] = useState(false);
  const [restoredPlace, setRestoredPlace] = useState<NavigationPlace | null>(null);
  const trail = useRef<NavigationTrail>({ places: [], index: -1 });
  const [trailVersion, setTrailVersion] = useState(0);
  const restoring = useRef(false);
  const [websiteIntent, setWebsiteIntent] = useState<string | null>(null);
  const navigationGeneration = useRef(0);
  function beginIntent() { return ++navigationGeneration.current; }
  function beginOpen() { const generation = beginIntent(); setOpeningObject(true); return generation; }
  function isCurrent(generation: number) { return generation === navigationGeneration.current; }
  function finishOpen(generation: number) { if (isCurrent(generation)) setOpeningObject(false); }
  function resetPreferenceNavigation() { setRestoredPlace(null); setOpeningObject(false); }
  function recordPlace(place: NavigationPlace, placeKey: string) {
    if (openingObject) return;
    if (restoring.current) { restoring.current = false; return; }
    if (appendNavigationPlace(trail.current, place, placeKey)) setTrailVersion((v) => v + 1);
  }
  function restorePlace(current: NavigationTrail, index: number, next: NavigationPlace, commitPreferences: () => void) {
    current.index = index;
    restoring.current = true;
    setRestoredPlace(next);
    commitPreferences();
    setTrailVersion((v) => v + 1);
  }
  return { navigationGeneration, openingObject, restoredPlace, trail, trailVersion, websiteIntent,
    beginIntent, beginOpen, isCurrent, finishOpen, resetPreferenceNavigation,
    setExplicitWebsiteIntent: setWebsiteIntent, recordPlace, restorePlace };
}
function commit() {
  const placeKey = JSON.stringify(place);
  const { openingObject, trailVersion } = owner;
  useLayoutEffect(() => owner.recordPlace(place, placeKey), [placeKey, openingObject]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest("input, textarea, [contenteditable=true], dialog[open]")) return;
      const direction = (e.altKey && e.key === "ArrowLeft") || (e.metaKey && e.key === "[") ? -1
        : (e.altKey && e.key === "ArrowRight") || (e.metaKey && e.key === "]") ? 1 : 0;
      if (direction) { e.preventDefault(); travel(direction); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [trailVersion, placeKey]);
}
function prefer() {
  if (isNavigationPreferenceChange(change)) {
    navigation.beginIntent();
    setUnderstandingOpen(false);
    navigation.resetPreferenceNavigation();
    clearResizePreview();
  }
  writePreferences((previous) => mergeNavigationPreferences(previous, change), "settings");
}
function writer() {
  setPrefs((previous) => {
    const next = update(previous);
    try { writeLocal("preferences", next); }
    catch { setNotice(failure === "settings" ? "设置暂时无法持久保存。" : "当前位置暂时无法持久保存。"); }
    return next;
  });
}
function restorePatch() { writePreferences((previous) => ({ ...previous, ...next }), "position"); }
function guardedRestorePatch() { continuation.writePreferences((previous) => ({ ...previous, ...next }), "position", guard(intent, destination)); }
function privatePrefer() {
  if (!origin.isActive()) return;
  if (isNavigationPreferenceChange(change)) {
    navigation.beginIntent(); setUnderstandingOpen(false); navigation.resetPreferenceNavigation(); clearResizePreview();
  }
  writePreferences((previous) => mergeNavigationPreferences(previous, change), "settings");
}
function privateWriter() {
  if (!origin.isActive()) return;
  host.writePreferences(update, failure, origin.capturePrivateCommit());
}
function currentEpoch() { return owner.navigationGeneration.current; }
`;
type Parsed = { source: SourceFile; symbols: Map<Node, number> };
function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}
function parse(contents: Record<string, string>): Map<string, Parsed> {
  const directory = "/workspace-navigation-boundary-fixtures";
  const config = `${directory}/tsconfig.json`;
  const files = Object.fromEntries(
    Object.entries(contents).map(([name, source]) => [
      `${directory}/${name}`,
      source,
    ]),
  );
  files[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
    files: Object.keys(contents),
  });
  const api = new API({ cwd: directory, fs: createVirtualFileSystem(files) });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const project = snapshot.getProject(config)!;
      assert.deepEqual(
        project.program.getSyntacticDiagnostics(),
        [],
        "Invalid fixtures cannot pass",
      );
      return new Map(
        Object.keys(contents).map((name) => {
          const source = project.program.getSourceFile(`${directory}/${name}`)!;
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
function functions(source: Node, name: string): FunctionDeclaration[] {
  const found: FunctionDeclaration[] = [];
  walk(source, (node) => {
    if (isFunctionDeclaration(node) && node.name?.text === name)
      found.push(node);
  });
  return found;
}
function calls(source: Node, name: string): CallExpression[] {
  const found: CallExpression[] = [];
  walk(source, (node) => {
    if (
      isCallExpression(node) &&
      node.expression.getText().replace(/\s+/g, "") === name
    )
      found.push(node);
  });
  return found;
}
function syntax(node: Node): unknown {
  const children: unknown[] = [];
  node.forEachChild((child) => {
    children.push(syntax(child));
  });
  // Leaf spelling preserves Chinese text, string whitespace, operators and
  // literal values. AST structure preserves expression and statement order.
  return [
    node.kind,
    ...((node.kind === SyntaxKind.PrefixUnaryExpression ||
      node.kind === SyntaxKind.PostfixUnaryExpression) &&
    "operator" in node
      ? [node.operator]
      : []),
    children.length ? children : node.getText(),
  ];
}
function same(a: Node | undefined, b: Node | undefined) {
  return !!a && !!b && JSON.stringify(syntax(a)) === JSON.stringify(syntax(b));
}
function zeroDOM(node: Node): unknown {
  const children: unknown[] = [];
  node.forEachChild((child) => {
    if (child.kind !== SyntaxKind.JsxText || child.getText().trim())
      children.push(zeroDOM(child));
  });
  return [node.kind, children.length ? children : node.getText()];
}
function boundCalls(parsed: Parsed, path: string, name: string) {
  const bindings: number[] = [];
  walk(parsed.source, (node) => {
    if (
      isImportDeclaration(node) &&
      isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === path &&
      node.importClause?.namedBindings &&
      isNamedImports(node.importClause.namedBindings)
    )
      for (const item of node.importClause.namedBindings.elements)
        if (
          (item.propertyName ?? item.name).text === name &&
          !item.isTypeOnly &&
          node.importClause.phaseModifier !== SyntaxKind.TypeKeyword
        ) {
          const id = parsed.symbols.get(item.name);
          if (id !== undefined) bindings.push(id);
        }
  });
  const found: CallExpression[] = [];
  walk(parsed.source, (node) => {
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      bindings.includes(parsed.symbols.get(node.expression) ?? -1)
    )
      found.push(node);
  });
  return bindings.length === 1 ? found : [];
}
function boundLifetime(parsed: Parsed, name: string, container: string) {
  const imports: Identifier[] = [];
  walk(parsed.source, (node) => {
    if (
      isImportDeclaration(node) &&
      isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "./host/use-workspace-navigation-host.js" &&
      node.importClause?.namedBindings &&
      isNamedImports(node.importClause.namedBindings) &&
      node.importClause.phaseModifier !== SyntaxKind.TypeKeyword
    )
      for (const item of node.importClause.namedBindings.elements)
        if (!item.isTypeOnly && (item.propertyName ?? item.name).text === name)
          imports.push(item.name);
  });
  const binding =
    imports.length === 1 ? parsed.symbols.get(imports[0]!) : undefined;
  const renders: Identifier[] = [];
  const parent = functions(parsed.source, container);
  if (parent.length === 1)
    walk(parent[0]!.body!, (node) => {
      if (
        isJsxSelfClosingElement(node) &&
        isIdentifier(node.tagName) &&
        node.tagName.text === name
      )
        renders.push(node.tagName);
    });
  return (
    binding !== undefined &&
    renders.length === 1 &&
    parsed.symbols.get(renders[0]!) === binding
  );
}
const oracle = parse({ "oracle.ts": oracleText }).get("oracle.ts")!.source;
const body = (name: string) => functions(oracle, name)[0]!.body!;
// New lifecycle/authorization seams are independently explicit here. They are
// not silently folded into the old state/commit/prefer oracle above.
const hostContract = `
function Host() {
 function activate(){lifetime.current.active=true;lifetime.current.incarnation++;}
 function retire(){lifetime.current.active=false;lifetime.current.incarnation++;state.beginIntent();}
 function currentProjection(){const current=getSnapshot();return current&&current.centerId===scope.centerId&&current.principalId===scope.principalId&&current.csrfToken===scope.csrfToken?current:null;}
 function isCurrentHost(){return lifetime.current.active&&!!currentProjection();}
 function captureCommit(){const incarnation=lifetime.current.incarnation;return()=>lifetime.current.active&&lifetime.current.incarnation===incarnation;}
 function permitted(){if(!lifetime.current.active||lifetime.current.incarnation!==incarnation)return false;const current=currentProjection();return !!current&&destination(current);}
 function writePreferences(){
  const incarnation=lifetime.current.incarnation;
  if(!permitted(incarnation,destination))return;
  setPrefs((previous)=>{if(!permitted(incarnation,destination))return previous;const next=update(previous);
   try{writeLocal("preferences",next);}catch{setPersistenceNotice(persistenceMessages[failure]);}return next;});
 }
 function recordContentVisit(){const incarnation=lifetime.current.incarnation;if(!permitted(incarnation,destination))return;
  setRecentContentVisits((previous)=>{if(!permitted(incarnation,destination))return previous;const next=visitContent(previous,id);
   try{writeLocal("recent-content",next);}catch{setPersistenceNotice(persistenceMessages.recent);}return next;});
 }
 return {prefs,persistenceNotice,dismissPersistenceNotice:()=>setPersistenceNotice(""),storage,recentContentVisits,
 navigation:{...state,isCurrent:(generation:number)=>isCurrentHost()&&state.isCurrent(generation)},
 isCurrentHost,captureCommit,activate,retire,currentProjection,writePreferences,recordContentVisit};
}
function NavigationHostLifetime(){useLayoutEffect(()=>{host.activate();return host.retire;},[]);return null;}
function useWorkspaceNavigationOrigin(){
 const lifetime=useRef({active:false,incarnation:0});
 function activate(){lifetime.current.active=true;lifetime.current.incarnation++;}
 function retire(){lifetime.current.active=false;lifetime.current.incarnation++;}
 function isActive(){return lifetime.current.active&&host.isCurrentHost();}
 function capturePrivateCommit():CurrentDestination {const incarnation=lifetime.current.incarnation;return()=>lifetime.current.active&&lifetime.current.incarnation===incarnation;}
 return {isActive,capturePrivateCommit,activate,retire};
}
function NavigationOriginLifetime(){useLayoutEffect(()=>{origin.activate();return origin.retire;},[]);return null;}
function WorkspaceNavigationHost(){const host=useWorkspaceNavigationHost({identity,getSnapshot:client.getSnapshot});return (<>
 <NavigationHostLifetime host={host}/>{client.boot?(<PrivateNavigationBoundary client={client} host={host}/>):(<WorkspaceConnection client={client}/>)}</>);}
function PrivateNavigationBoundary(){const origin=useWorkspaceNavigationOrigin(host);return (<><NavigationOriginLifetime origin={origin}/><WorkspaceApp client={client} host={host} origin={origin}/></>);}
function setNotice(){if(!origin.isActive())return;host.dismissPersistenceNotice();setPrivateNotice(message);}
`;
// Fixed original b8db8158 persisted schema; only its View alias is spelled by
// the identical imported WorkSurfaceView after migration. Not a new UI hash.
const preferenceContract = `
type Preferences=InterfacePreferences&{
 subjectTab?:SubjectView;subjectOpen:boolean;dockApplications?:string[];taskList?:TaskListOptions;
 executionWidth?:number;inspectorWidth?:number;view:WorkSurfaceView;projectId:string;
 artifactId:string|null;artifactRevision:number|null;artifactPage?:number|null;readerMode?:boolean;
 readingTarget?:ReaderTarget|null;collaboration:boolean;composer:boolean;conversation:boolean|null;
 sidebar:boolean;sidebarWidth?:number;sidebarCompact?:boolean;projectOpen:boolean;
 applications?:Record<string,string|null>;
 scriptLocation?:(ScriptLocation&{requestId:string;view?:"library"|"editor"})|null;
 interactions?:Record<string,InteractionMode>;exchangeHeights?:Record<string,number>;
 pinnedInputs?:Record<string,boolean>;selectedConversations?:Record<string,string>;
 localFile?:{projectId:string;reference:LocalFileView["reference"]};
};
const defaultPrefs:Preferences={...interfacePreferences({}),view:"desk",projectId:"first-project",
 artifactId:null,artifactRevision:null,collaboration:false,subjectOpen:false,composer:true,
 conversation:null,sidebar:true,projectOpen:false};
function hostRegistrations(){
 const [scope]=useState<NavigationIdentity>(()=>({...identity}));
 const [storage]=useState(()=>scopedStorage(\`\${scope.centerId}:\${scope.principalId}\`));
 const {readLocal,writeLocal}=storage;
 const [persistenceNotice,setPersistenceNotice]=useState<PersistenceNotice>("");
 const state=useWorkspaceNavigationState();const lifetime=useRef({active:false,incarnation:0});
}
`;
function properties(node: Node | undefined): Map<string, Node> {
  const values = new Map<string, Node>();
  if (node && isObjectLiteralExpression(node))
    for (const prop of node.properties) {
      if (isPropertyAssignment(prop) && isIdentifier(prop.name))
        values.set(prop.name.text, prop.initializer);
      else if (isShorthandPropertyAssignment(prop) && isIdentifier(prop.name))
        values.set(prop.name.text, prop.name);
    }
  return values;
}
function ownership(
  ownerText: string,
  appText: string,
  hostText = stableHost,
): string[] {
  const parsed = parse({
    "owner.ts": ownerText,
    "App.tsx": appText,
    "host.ts": hostText,
    "host-contract.tsx": hostContract,
    "preferences.ts": preferenceContract,
  });
  const { source: owner } = parsed.get("owner.ts")!;
  const app = parsed.get("App.tsx")!;
  const host = parsed.get("host.ts")!;
  const contract = parsed.get("host-contract.tsx")!;
  const preferences = parsed.get("preferences.ts")!.source;
  const problems: string[] = [];
  const check = (valid: boolean, rule: string) => {
    if (!valid) problems.push(rule);
  };
  const runtimeImports = new Map([
    ["react", new Set(["useState", "useRef", "useEffect", "useLayoutEffect"])],
    [
      "../../../../packages/core/src/model.js",
      new Set(["isContentArtifact", "spaceKind"]),
    ],
    [
      "../../../../packages/core/src/applications.js",
      new Set([
        "objectsApplication",
        "browserApplication",
        "readerApplication",
        "scriptStudioApplication",
      ]),
    ],
    ["../../../../packages/core/src/retrieval.js", new Set(["contentText"])],
  ]);
  const typeImports = new Set([
    ...runtimeImports.keys(),
    "../../../../packages/core/src/reader.js",
    "../../../../packages/core/src/local-files.js",
    "../../../../packages/core/src/script-delivery.js",
    "../client.js",
    "./use-exchange-controller.js",
    "./work-surface.js",
  ]);
  for (const statement of owner.statements)
    check(
      isImportDeclaration(statement) ||
        isTypeAliasDeclaration(statement) ||
        isFunctionDeclaration(statement),
      "owner-top-level-effects",
    );
  walk(owner, (node) => {
    if (isImportDeclaration(node)) {
      const path = isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : "";
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      check(
        !!clause && !!bindings && isNamedImports(bindings),
        "explicit-owner-imports",
      );
      if (bindings && isNamedImports(bindings))
        for (const item of bindings.elements) {
          const typeOnly =
            clause?.phaseModifier === SyntaxKind.TypeKeyword || item.isTypeOnly;
          check(
            typeOnly
              ? typeImports.has(path)
              : !!runtimeImports
                  .get(path)
                  ?.has((item.propertyName ?? item.name).text),
            "unreviewed-owner-dependency",
          );
        }
    }
    if (isIdentifier(node))
      check(
        ![
          "fetch",
          "WebSocket",
          "XMLHttpRequest",
          "localStorage",
          "sessionStorage",
          "writeLocal",
          "useSyncExternalStore",
          "useMemo",
          "useCallback",
          "latest",
          "latestRef",
          "getBoundingClientRect",
        ].includes(node.text),
        "owner-no-transport-storage-latest-geometry",
      );
  });
  const state = functions(owner, "useWorkspaceNavigationState");
  const commit = functions(owner, "useWorkspaceNavigationCommit");
  const factory = functions(owner, "createWorkspaceNavigationCommands");
  check(
    state.length === 1 && same(state[0]?.body, body("state")),
    "one-effect-free-state-owner-original-transitions",
  );
  check(
    commit.length === 1 && same(commit[0]?.body, body("commit")),
    "original-trail-keyboard-effects-and-dependencies",
  );
  check(
    calls(owner, "useRef").length === 3 &&
      calls(owner, "useState").length === 4,
    "unique-navigation-refs-and-state",
  );
  check(
    calls(owner, "useLayoutEffect").length === 1 &&
      calls(owner, "useEffect").length === 1,
    "effects-only-in-explicit-commit",
  );
  if (factory[0]?.body) {
    const statements = factory[0].body.statements;
    const named = statements.filter(isFunctionDeclaration);
    const commandNames = [
      "travel",
      "openScriptLocation",
      "openObject",
      "launchDockApplication",
      "readingLibrary",
      "openScriptLibrary",
      "openWorkspaceContents",
      "activateApplication",
      "navigate",
      "openBrowser",
    ];
    const guardNames = [
      "canStart",
      "capture",
      "guard",
      "permitted",
      "privateLifetimePermitted",
      "publish",
      "visit",
      "privateShell",
      "notice",
      "projectAvailable",
      "instanceAvailable",
      "artifactAvailable",
      "scriptAvailable",
    ];
    check(
      factory.length === 1 &&
        statements.length === 27 &&
        isVariableStatement(statements[0]!) &&
        statements
          .slice(1, -2)
          .every(
            (node) =>
              isFunctionDeclaration(node) ||
              (isTypeAliasDeclaration(node) && node.name.text === "Intent"),
          ) &&
        isVariableStatement(statements.at(-2)!) &&
        isReturnStatement(statements.at(-1)!),
      "factory-no-hooks-or-construction-effects",
    );
    const first = isVariableStatement(statements[0]!)
      ? statements[0].declarationList.declarations[0]
      : undefined;
    check(
      first?.initializer?.getText() === "surface",
      "factory-captures-one-surface",
    );
    const names = named.map((fn) => fn.name?.text);
    check(
      JSON.stringify(names) ===
        JSON.stringify([...guardNames, ...commandNames]),
      "only-reviewed-navigation-commands",
    );
    const preparedStatement = statements.at(-2)!;
    const prepared = isVariableStatement(preparedStatement)
      ? preparedStatement.declarationList.declarations[0]
      : undefined;
    check(
      prepared?.name.getText() === "applicationActions" &&
        prepared.initializer !== undefined &&
        isObjectLiteralExpression(prepared.initializer),
      "prepared-application-actions-without-construction-work",
    );
    if (
      prepared?.initializer &&
      isObjectLiteralExpression(prepared.initializer)
    ) {
      const fields = prepared.initializer.properties;
      check(
        fields.length === 3 &&
          isPropertyAssignment(fields[0]!) &&
          fields[0].name.getText() === "activate" &&
          fields[0].initializer.getText() === "activateApplication" &&
          fields
            .slice(1)
            .every(
              (field, index) =>
                isMethodDeclaration(field) &&
                field.name.getText() === ["launch", "close"][index] &&
                !field.modifiers?.some(
                  (modifier) => modifier.kind === SyntaxKind.AsyncKeyword,
                ),
            ),
        "prepared-actions-are-synchronous-declarations-not-eager-or-async-bridges",
      );
    }
    const returnedStatement = statements.at(-1)!;
    const returned = isReturnStatement(returnedStatement)
      ? properties(returnedStatement.expression)
      : new Map<string, Node>();
    check(
      [...returned.keys()].join(",") ===
        "travel,openObject,openScriptLocation,launchDockApplication,readingLibrary,openScriptLibrary,openWorkspaceContents,activateApplication,navigate,openBrowser,applicationActions" &&
        [...returned].every(
          ([name, value]) => isIdentifier(value) && value.text === name,
        ),
      "named-command-seam-no-setter-bag",
    );
    const executed = calls(factory[0], "client.execute");
    const operationTypes = executed
      .map((call) => {
        const type = properties(call.arguments[0]).get("type");
        return type && isStringLiteral(type) ? type.text : "unreviewed";
      })
      .sort();
    check(
      JSON.stringify(operationTypes) ===
        JSON.stringify([
          "close-application",
          ...Array<string>(7).fill("launch-application"),
          ...Array<string>(2).fill("set-application-state"),
        ]),
      "navigation-reviewed-instance-operations-no-input-session",
    );
    const travel = functions(factory[0], "travel")[0];
    const restoration = travel && calls(travel, "owner.restorePlace")[0];
    const callback = restoration?.arguments[3];
    check(
      !!callback &&
        "body" in callback &&
        same(callback.body as Node, body("guardedRestorePatch")),
      "history-raw-spread-not-prefer-or-clear-preview",
    );
    const object = functions(factory[0], "openObject")[0];
    const epoch = body("currentEpoch").statements[0];
    let updatedEpoch = false;
    if (object)
      walk(object, (node) => {
        if (isReturnStatement(node) && same(node, epoch)) updatedEpoch = true;
      });
    check(updatedEpoch, "open-object-returns-updated-current-epoch");
  } else check(false, "one-command-factory");

  const entries = new Map<string, number>();
  walk(app.source, (node) => {
    if (
      isImportDeclaration(node) &&
      isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "./host/use-workspace-navigation.js" &&
      node.importClause?.namedBindings &&
      isNamedImports(node.importClause.namedBindings)
    )
      for (const item of node.importClause.namedBindings.elements) {
        if (
          item.isTypeOnly ||
          node.importClause.phaseModifier === SyntaxKind.TypeKeyword
        )
          continue;
        const id = app.symbols.get(item.name);
        if (id !== undefined)
          entries.set((item.propertyName ?? item.name).text, id);
      }
  });
  const importedCalls = (name: string) => {
    const result: CallExpression[] = [];
    walk(app.source, (node) => {
      if (
        isCallExpression(node) &&
        isIdentifier(node.expression) &&
        entries.has(name) &&
        app.symbols.get(node.expression) === entries.get(name)
      )
        result.push(node);
    });
    return result;
  };
  const hostStates = boundCalls(
    host,
    "./use-workspace-navigation.js",
    "useWorkspaceNavigationState",
  );
  const states = hostStates;
  const factories = importedCalls("createWorkspaceNavigationCommands");
  const commits = importedCalls("useWorkspaceNavigationCommit");
  const surfaces = calls(app.source, "deriveWorkSurface");
  const focuses = calls(app.source, "useExchangeControllerFocus");
  check(
    states.length === 1 &&
      factories.length === 1 &&
      commits.length === 1 &&
      surfaces.length === 1 &&
      focuses.length === 1,
    "unique-real-imported-owner-surface-commit",
  );
  const stateEntry = states[0],
    surface = surfaces[0],
    factoryEntry = factories[0],
    commitEntry = commits[0],
    focus = focuses[0];
  check(
    !!stateEntry &&
      !!surface &&
      functions(host.source, "useWorkspaceNavigationHost")[0]
        ?.body?.getText()
        .includes(stateEntry.getText()) === true &&
      stateEntry.arguments.length === 0,
    "state-before-unique-resolver",
  );
  const stateBindings: string[] = [];
  let hostNavigationBindings = 0;
  let preferenceOwners = 0;
  function generationRef(node: Node) {
    return (
      (isPropertyAccessExpression(node) &&
        isIdentifier(node.expression) &&
        node.expression.text === "navigationGeneration" &&
        node.name.text === "current") ||
      (isElementAccessExpression(node) &&
        isIdentifier(node.expression) &&
        node.expression.text === "navigationGeneration" &&
        !!node.argumentExpression &&
        isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === "current")
    );
  }
  walk(app.source, (node) => {
    if (
      isVariableDeclaration(node) &&
      isObjectBindingPattern(node.name) &&
      node.name.elements.some(
        (element) => element.name?.getText() === "navigation",
      )
    ) {
      hostNavigationBindings++;
      check(
        node.initializer?.getText() === "host" &&
          node.name.getText().replace(/\s+/g, "") ===
            "{prefs,recentContentVisits,navigation}",
        "navigation-owned-by-stable-host-direct-binding",
      );
    }
    if (
      isVariableDeclaration(node) &&
      node.initializer?.getText() === "navigation" &&
      isObjectBindingPattern(node.name)
    )
      stateBindings.push(
        ...node.name.elements.map(
          (element) =>
            `${(element.propertyName ?? element.name)?.getText() ?? "<omitted>"}:${element.name?.getText() ?? "<omitted>"}`,
        ),
      );
    if (isVariableDeclaration(node) && isIdentifier(node.name)) {
      if (node.name.text === "navigation")
        check(false, "navigation-owned-by-state-hook");
      check(
        ![
          "navigationGeneration",
          "restoredPlace",
          "openingObject",
          "trail",
          "trailVersion",
          "restoring",
        ].includes(node.name.text),
        "no-second-app-navigation-owner",
      );
    }
    if (isVariableDeclaration(node) && isArrayBindingPattern(node.name)) {
      const first = node.name.elements[0],
        second = node.name.elements[1];
      if (
        first &&
        "name" in first &&
        first.name?.getText() === "prefs" &&
        second &&
        "name" in second &&
        second.name?.getText() === "setPrefs" &&
        node.initializer &&
        isCallExpression(node.initializer) &&
        isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === "useState"
      )
        preferenceOwners++;
      check(
        !node.name.elements.some(
          (element) =>
            "name" in element &&
            !!element.name &&
            [
              "navigationGeneration",
              "restoredPlace",
              "openingObject",
              "trail",
              "trailVersion",
              "restoring",
            ].includes(element.name.getText()),
        ),
        "no-second-app-navigation-state",
      );
    }
    if (
      isBinaryExpression(node) &&
      node.operatorToken.kind >= SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= SyntaxKind.LastAssignment
    )
      check(
        !generationRef(node.left),
        "generation-assignments-belong-to-owner",
      );
    if (
      node.kind === SyntaxKind.PrefixUnaryExpression ||
      node.kind === SyntaxKind.PostfixUnaryExpression
    )
      check(
        !node.getText().includes("navigationGeneration.current"),
        "generation-writes-belong-to-owner",
      );
  });
  check(hostNavigationBindings === 1, "unique-stable-host-navigation-binding");
  check(
    stateBindings.join(",") ===
      "openingObject:openingObject,restoredPlace:restoredPlace,trail:trail,websiteIntent:websiteIntent,navigationGeneration:navigationGeneration,setExplicitWebsiteIntent:setWebsiteIntent",
    "same-state-generation-and-restored-aliases",
  );
  const restored = properties(surface?.arguments[0]).get("restoredPlace");
  check(
    !!restored && isIdentifier(restored) && restored.text === "restoredPlace",
    "restored-place-enters-only-resolver",
  );
  const controller = calls(app.source, "useExchangeController")[0];
  const generation = properties(controller?.arguments[0]).get(
    "navigationGeneration",
  );
  check(
    !!generation &&
      isIdentifier(generation) &&
      generation.text === "navigationGeneration",
    "exchange-shares-owner-generation",
  );
  const options = properties(factoryEntry?.arguments[0]);
  const expected = {
    owner: "navigation",
    client: "client",
    workspace: "state",
    surface: "workSurface",
    preferences: "prefs",
    prefer: "prefer",
    onNotice: "setNotice",
  };
  check(
    options.size === 10 &&
      Object.entries(expected).every(
        ([key, value]) => options.get(key)?.getText() === value,
      ),
    "factory-explicit-single-owner-inputs",
  );
  const continuation = properties(options.get("continuation"));
  check(
    continuation.size === 6 &&
      Object.entries({
        isActive: "origin.isActive",
        currentProjection: "host.currentProjection",
        captureCommit: "host.captureCommit",
        prefer: "continueNavigation",
        writePreferences: "host.writePreferences",
        recordContentVisit: "host.recordContentVisit",
      }).every(([name, text]) => continuation.get(name)?.getText() === text),
    "mandatory-current-host-continuation-not-a-private-writer-bag",
  );
  check(
    factory[0]!.parameters[0]?.type
      ?.getText()
      .includes("continuation: Continuation<P>;") === true,
    "mandatory-no-test-only-fallback",
  );
  const shell = properties(options.get("shell"));
  check(
    shell.size === 2 &&
      shell.get("finishCreation")?.getText().replace(/\s+/g, "") ===
        "()=>setCreating(null)" &&
      shell.get("dismissExecutionInspector")?.getText().replace(/\s+/g, "") ===
        "()=>setExecutions(null)",
    "only-two-named-shell-actions",
  );
  const application = properties(options.get("application"));
  check(
    application.size === 4 &&
      application.get("historyVisible")?.getText() === "historyVisible" &&
      application.get("personalDesk")?.getText().replace(/\s+/g, "") ===
        '()=>personalSpace("desk")' &&
      application.get("readCapturedInstance")?.getText().replace(/\s+/g, "") ===
        "(id)=>client.boot?.workspace.applicationInstances.find((i)=>i.id===id)" &&
      application.get("selectAllContent")?.getText().replace(/\s+/g, "") ===
        '()=>setContentScope("all")',
    "application-actions-use-explicit-captured-facts-not-latest-snapshots",
  );
  for (const name of [
    "readingLibrary",
    "openScriptLibrary",
    "openWorkspaceContents",
    "activateApplication",
    "navigate",
    "openBrowser",
  ])
    check(functions(app.source, name).length === 0, "no-copied-app-navigation");
  check(
    !!factoryEntry && !!controller && controller.pos < factoryEntry.pos,
    "factory-after-exchange-clear-preview-bridge",
  );
  const layouts = calls(app.source, "useLayoutEffect");
  const positions = layouts.find(
    (call) => calls(call, "positions.current.get").length > 0,
  );
  const titles = calls(app.source, "useEffect").filter((call) =>
    call.getText().includes("document.title"),
  );
  check(
    !!positions &&
      titles.length === 1 &&
      !!commitEntry &&
      !!focus &&
      positions.pos < titles[0]!.pos &&
      titles[0]!.pos < commitEntry.pos &&
      commitEntry.pos < focus.pos,
    "scroll-title-trail-keyboard-before-exchange-focus",
  );
  check(
    commitEntry?.arguments.length === 2 &&
      commitEntry.arguments[0]?.getText() === "navigation" &&
      commitEntry.arguments[1]?.getText().replace(/\s+/g, "") ===
        "{place,travel}",
    "same-owner-explicit-commit-seam",
  );
  check(
    functions(app.source, "prefer").length === 1 &&
      same(functions(app.source, "prefer")[0]?.body, body("privatePrefer")),
    "preference-bridge-original-side-effect-order",
  );
  check(
    functions(app.source, "writePreferences").length === 1 &&
      same(
        functions(app.source, "writePreferences")[0]?.body,
        body("privateWriter"),
      ),
    "sole-persistence-updater-original-write-and-errors",
  );
  check(
    preferenceOwners === 0 &&
      calls(app.source, "setPrefs").length === 0 &&
      calls(host.source, "setPrefs").length === 1 &&
      calls(host.source, "writeLocal").filter(
        (call) =>
          isStringLiteral(call.arguments[0]!) &&
          call.arguments[0].text === "preferences",
      ).length === 1 &&
      calls(app.source, "writeLocal").filter(
        (call) =>
          call.arguments[0] &&
          isStringLiteral(call.arguments[0]) &&
          call.arguments[0].text === "preferences",
      ).length === 0,
    "one-preference-setter-and-storage-writer",
  );
  check(
    importedCalls("isNavigationPreferenceChange").length === 2 &&
      importedCalls("mergeNavigationPreferences").length === 2,
    "preference-bridge-uses-real-imports-not-shadowed-formulas",
  );
  let launchProps = 0;
  walk(app.source, (node) => {
    if (
      node.kind === SyntaxKind.JsxAttribute &&
      "name" in node &&
      (node.name as Node).getText() === "onLaunch"
    ) {
      launchProps++;
      check(
        node.getText().replace(/\s+/g, "") ===
          "onLaunch={launchDockApplication}",
        "dock-consumes-equivalent-command",
      );
    }
  });
  check(launchProps === 1, "one-dock-launch-seam");
  for (const name of [
    "activate",
    "retire",
    "currentProjection",
    "isCurrentHost",
    "captureCommit",
    "permitted",
    "writePreferences",
    "recordContentVisit",
  ]) {
    const expected = functions(contract.source, name),
      actual = functions(host.source, name);
    check(
      actual.length === expected.length &&
        actual.every((value, index) => same(value.body, expected[index]?.body)),
      "explicit-host-identity-lifetime-and-two-stage-writer-contract",
    );
  }
  const hostMain = functions(host.source, "useWorkspaceNavigationHost");
  const hostStatements = hostMain[0]?.body?.statements ?? [];
  const registrationShape = hostStatements.map((node) =>
    isVariableStatement(node)
      ? node.declarationList.declarations.length === 1
        ? node.declarationList.declarations[0]!.name.getText().replace(
            /\s+/g,
            "",
          )
        : "multiple-declarations"
      : isFunctionDeclaration(node)
        ? `function:${node.name?.text}`
        : isReturnStatement(node)
          ? "return"
          : "eager-statement",
  );
  check(
    hostMain.length === 1 &&
      JSON.stringify(registrationShape) ===
        JSON.stringify([
          "[scope]",
          "[storage]",
          "{readLocal,writeLocal}",
          "[recentContentVisits,setRecentContentVisits]",
          "[prefs,setPrefs]",
          "[persistenceNotice,setPersistenceNotice]",
          "state",
          "lifetime",
          "function:activate",
          "function:retire",
          "function:currentProjection",
          "function:isCurrentHost",
          "function:captureCommit",
          "function:permitted",
          "function:writePreferences",
          "function:recordContentVisit",
          "return",
        ]),
    "host-construction-only-reviewed-registration-and-declarations",
  );
  for (const name of [
    "scope",
    "storage",
    "readLocal",
    "persistenceNotice",
    "state",
    "lifetime",
  ]) {
    const found: Node[] = [],
      expected: Node[] = [];
    for (const [source, output] of [
      [hostMain[0]?.body, found],
      [functions(preferences, "hostRegistrations")[0]?.body, expected],
    ] as const)
      if (source)
        walk(source, (node) => {
          if (
            isVariableDeclaration(node) &&
            (node.name.getText() === name ||
              node.name.getText().replace(/\s+/g, "").startsWith(`[${name}]`) ||
              node.name.getText().replace(/\s+/g, "").startsWith(`[${name},`) ||
              node.name.getText().replace(/\s+/g, "").startsWith(`{${name},`))
          )
            output.push(node);
        });
    check(
      found.length === 1 &&
        expected.length === 1 &&
        same(found[0], expected[0]),
      "host-construction-only-reviewed-registration-and-declarations",
    );
  }
  const originalHost = functions(contract.source, "Host")[0]!;
  check(
    same(hostStatements.at(-1), originalHost.body!.statements.at(-1)),
    "host-return-preserves-currentness-and-single-navigation-state",
  );
  for (const name of ["Preferences"]) {
    const actual: Node[] = [],
      expected: Node[] = [];
    for (const [source, output] of [
      [host.source, actual],
      [preferences, expected],
    ] as const)
      walk(source, (node) => {
        if (isTypeAliasDeclaration(node) && node.name.text === name)
          output.push(node.type);
      });
    check(
      actual.length === 1 &&
        expected.length === 1 &&
        same(actual[0], expected[0]),
      "original-persisted-preference-schema-and-defaults",
    );
  }
  const defaults: Node[] = [],
    expectedDefaults: Node[] = [];
  for (const [source, output] of [
    [host.source, defaults],
    [preferences, expectedDefaults],
  ] as const)
    walk(source, (node) => {
      if (isVariableDeclaration(node) && node.name.getText() === "defaultPrefs")
        output.push(node);
    });
  check(
    defaults.length === 1 &&
      expectedDefaults.length === 1 &&
      same(defaults[0], expectedDefaults[0]),
    "original-persisted-preference-schema-and-defaults",
  );
  for (const [name, container] of [
    ["NavigationHostLifetime", "WorkspaceNavigationHost"],
    ["NavigationOriginLifetime", "PrivateNavigationBoundary"],
  ])
    check(
      boundLifetime(app, name!, container!),
      "actual-import-bound-null-sibling-lifetime-consumers",
    );
  check(
    calls(host.source, "useState").length === 5 &&
      calls(host.source, "useRef").length === 2 &&
      calls(host.source, "useLayoutEffect").length === 2 &&
      calls(host.source, "scopedStorage").length === 1 &&
      calls(host.source, "scopedStorage")[0]!.arguments[0]?.getText() ===
        "`${scope.centerId}:${scope.principalId}`" &&
      calls(host.source, "useEffect").length === 0 &&
      !hostText.includes("useInsertionEffect"),
    "only-scoped-preference-recency-and-null-slot-lifetimes",
  );
  for (const name of [
    "NavigationHostLifetime",
    "NavigationOriginLifetime",
    "useWorkspaceNavigationOrigin",
  ])
    check(
      same(
        functions(host.source, name)[0]?.body,
        functions(contract.source, name)[0]?.body,
      ),
      "first-null-sibling-only-lifetime-registration",
    );
  for (const name of ["WorkspaceNavigationHost", "PrivateNavigationBoundary"])
    check(
      !!functions(app.source, name)[0]?.body &&
        JSON.stringify(zeroDOM(functions(app.source, name)[0]!.body!)) ===
          JSON.stringify(zeroDOM(functions(contract.source, name)[0]!.body!)),
      "actual-protected-branch-and-first-null-sibling-order",
    );
  check(
    same(
      functions(app.source, "setNotice")[0]?.body,
      functions(contract.source, "setNotice")[0]?.body,
    ),
    "private-notice-remains-with-origin-not-retired-updater",
  );
  for (const name of [
    "useWorkspaceNavigationHost",
    "useWorkspaceNavigationOrigin",
  ])
    check(
      boundCalls(app, "./host/use-workspace-navigation-host.js", name)
        .length === 1,
      "actual-import-bound-lifetime-owners-not-local-mirrors",
    );
  check(
    calls(app.source, "useWorkspaceNavigationState").length === 0 &&
      calls(app.source, "useWorkspaceNavigationHost").length === 1 &&
      calls(app.source, "useWorkspaceNavigationOrigin").length === 1 &&
      calls(app.source, "scopedStorage").every(
        (call) =>
          !functions(app.source, "WorkspaceApp")[0]
            ?.body?.getText()
            .includes(call.getText()),
      ),
    "single-stable-owner-no-private-projection-retention",
  );
  return problems;
}
const { owner, app } = expandWorkspaceContentOpeningConsumption(
  readFileSync("apps/web/src/App.tsx", "utf8"),
  readFileSync("apps/web/src/host/use-workspace-navigation.ts", "utf8"),
);
const stableHost = readFileSync(
  "apps/web/src/host/use-workspace-navigation-host.ts",
  "utf8",
);
function changed(source: string, from: string, to: string) {
  assert.ok(source.includes(from), `Fixture target missing: ${from}`);
  return source.replace(from, to);
}
test("six previously accepted Host/Origin counterfactuals each violate their own finite source rule", () => {
  const cases = [
    {
      name: "Host currentness",
      host: changed(
        stableHost,
        "return lifetime.current.active && !!currentProjection();",
        "return true;",
      ),
      rule: "explicit-host-identity-lifetime-and-two-stage-writer-contract",
    },
    {
      name: "returned navigation",
      host: changed(
        stableHost,
        "isCurrentHost() && state.isCurrent(generation)",
        "state.isCurrent(generation)",
      ),
      rule: "host-return-preserves-currentness-and-single-navigation-state",
    },
    {
      name: "Host lifetime fake binding",
      app:
        changed(
          app,
          "  NavigationHostLifetime,",
          "  NavigationHostLifetime as RealNavigationHostLifetime,",
        ) + "\nfunction NavigationHostLifetime() { return null; }",
      rule: "actual-import-bound-null-sibling-lifetime-consumers",
    },
    {
      name: "Origin lifetime fake binding",
      app:
        changed(
          app,
          "  NavigationOriginLifetime,",
          "  NavigationOriginLifetime as RealNavigationOriginLifetime,",
        ) + "\nfunction NavigationOriginLifetime() { return null; }",
      rule: "actual-import-bound-null-sibling-lifetime-consumers",
    },
    {
      name: "eager snapshot construction",
      host: changed(
        stableHost,
        "  const state = useWorkspaceNavigationState();",
        "  getSnapshot();\n  const state = useWorkspaceNavigationState();",
      ),
      rule: "host-construction-only-reviewed-registration-and-declarations",
    },
    {
      name: "persisted schema",
      host: changed(
        stableHost,
        "  subjectOpen: boolean;",
        "  subjectOpen: string;",
      ),
      rule: "original-persisted-preference-schema-and-defaults",
    },
  ];
  for (const entry of cases) {
    const candidateApp = entry.app ?? app,
      candidateHost = entry.host ?? stableHost;
    parse({ "App.tsx": candidateApp, "host.ts": candidateHost });
    assert.ok(
      ownership(owner, candidateApp, candidateHost).includes(entry.rule),
      `${entry.name}: ${entry.rule}`,
    );
  }
});
test("navigation has one production owner, one preference writer and ordered real effect seams", () => {
  assert.deepEqual(ownership(owner, app), []);
});
test("navigation gate rejects duplicated generations, fake entries and copied state", () => {
  const badApps = [
    app + "\nconst navigationGeneration = useRef(0);",
    app + "\nconst [restoredPlace, restore] = useState(null);",
    changed(
      app,
      "const { prefs, recentContentVisits, navigation } = host;",
      "const navigation = {}; const { prefs, recentContentVisits } = host;",
    ),
    changed(
      app,
      "const { prefs, recentContentVisits, navigation } = host;",
      "const { prefs, recentContentVisits, navigation } = { ...host };",
    ),
    changed(
      app,
      "    restoredPlace,\n  });",
      "    restoredPlace: null,\n  });",
    ),
    changed(
      app,
      "    navigationGeneration,\n    sending,",
      "    navigationGeneration: { current: 0 },\n    sending,",
    ),
    changed(
      app,
      "navigation.beginIntent();",
      "navigationGeneration.current++;",
    ),
    changed(
      app,
      "navigation.beginIntent();",
      "navigationGeneration.current = 0;",
    ),
    changed(
      app,
      "navigation.beginIntent();",
      'navigationGeneration["current"] = 0;',
    ),
    changed(
      app,
      "    navigationGeneration,\n    setExplicitWebsiteIntent",
      "    navigationGeneration: anotherGeneration,\n    setExplicitWebsiteIntent",
    ),
    changed(
      changed(
        app,
        "const { prefs, recentContentVisits, navigation } = host;",
        "const { prefs, recentContentVisits } = host;",
      ),
      "  const [readingSurface",
      "  const navigation = useWorkspaceNavigationState();\n  const [readingSurface",
    ),
  ];
  for (const [index, candidate] of badApps.entries())
    assert.ok(
      ownership(owner, candidate).length > 0,
      `app counterfactual ${index}`,
    );
});
test("navigation gate rejects moved commits, changed dependencies and reset order", () => {
  const seam = "useWorkspaceNavigationCommit(navigation, { place, travel });";
  for (const [index, candidate] of [
    changed(app, seam, ""),
    changed(
      changed(app, seam, ""),
      "useExchangeControllerFocus(exchangeController);",
      `useExchangeControllerFocus(exchangeController);\n${seam}`,
    ),
    changed(
      app,
      seam,
      "useWorkspaceNavigationCommit({ ...navigation }, { place, travel });",
    ),
    changed(
      app,
      "      setUnderstandingOpen(false);\n      navigation.resetPreferenceNavigation();",
      "      navigation.resetPreferenceNavigation();\n      setUnderstandingOpen(false);",
    ),
    changed(app, "      clearResizePreview();", ""),
  ].entries())
    assert.ok(
      ownership(owner, candidate).length > 0,
      `app moved seam ${index}`,
    );
  for (const [index, candidate] of [
    changed(
      owner,
      "[placeKey, openingObject]",
      "[placeKey, openingObject, owner]",
    ),
    changed(
      owner,
      "[trailVersion, placeKey]",
      "[trailVersion, placeKey, travel]",
    ),
    changed(
      owner,
      "    setRestoredPlace(null);\n    setOpeningObject(false);",
      "    setOpeningObject(false);\n    setRestoredPlace(null);",
    ),
    changed(owner, "    if (openingObject) return;", ""),
    changed(
      owner,
      "    restoring.current = true;\n    setRestoredPlace(next);",
      "    setRestoredPlace(next);\n    restoring.current = true;",
    ),
  ].entries())
    assert.ok(
      ownership(candidate, app).length > 0,
      `owner counterfactual ${index}`,
    );
});
test("navigation gate rejects constructor work, extra writer, setter bag and broadened operations", () => {
  const object = functions(
    parse({ "owner.ts": owner }).get("owner.ts")!.source,
    "openObject",
  )[0]!.getText();
  for (const [index, candidate] of [
    owner + '\nfetch("/api");',
    'import { WorkspaceApp } from "../App.js";\n' + owner,
    changed(
      owner,
      "  const { project, applicationWorkspaceOpen, exchangeKey, activeInstance } =",
      "  client.execute({ type: 'launch-application' });\n  const { project, applicationWorkspaceOpen, exchangeKey, activeInstance } =",
    ),
    changed(
      owner,
      "  const { project, applicationWorkspaceOpen, exchangeKey, activeInstance } =",
      "  useEffect(() => {});\n  const { project, applicationWorkspaceOpen, exchangeKey, activeInstance } =",
    ),
    changed(
      owner,
      "    resetPreferenceNavigation,",
      "    setRestoredPlace,\n    resetPreferenceNavigation,",
    ),
    changed(owner, 'type: "launch-application",', 'type: "record-input",'),
    changed(
      owner,
      "    launch(app, captured, contents = false) {",
      "    async launch(app, captured, contents = false) {",
    ),
    changed(
      owner,
      "    close(instance, captured) {",
      "    async close(instance, captured) {",
    ),
    changed(
      owner,
      "    activate: activateApplication,",
      "    activate: client.execute({ type: 'launch-application' }),",
    ),
    changed(owner, 'type: "close-application",', 'type: "launch-application",'),
    changed(
      owner,
      object,
      changed(
        object,
        "return owner.navigationGeneration.current;",
        "return generation;",
      ),
    ),
    changed(
      owner,
      'continuation.writePreferences(\n          (previous) => ({ ...previous, ...next }),\n          "position",\n          guard(intent, destination),\n        );',
      "prefer(next);",
    ),
  ].entries())
    assert.ok(
      ownership(candidate, app).length > 0,
      `owner constructor seam ${index}`,
    );
  for (const candidate of [
    app + "\nsetPrefs({});",
    app + '\nwriteLocal("preferences", {});',
    changed(
      app,
      "(id) =>\n        client.boot?.workspace.applicationInstances.find((i) => i.id === id)",
      "(id) => client.getSnapshot().workspace.applicationInstances.find((i) => i.id === id)",
    ),
    changed(
      app,
      "onLaunch={launchDockApplication}",
      "onLaunch={async () => client.execute({ type: 'record-input' })}",
    ),
    changed(
      app,
      "    writePreferences(\n      (previous) => mergeNavigationPreferences(previous, change),",
      "    const mergeNavigationPreferences = () => ({});\n    writePreferences(\n      (previous) => mergeNavigationPreferences(previous, change),",
    ),
  ])
    assert.ok(ownership(owner, candidate).length > 0);
});
test("navigation gate allows unrelated local UI state and import aliases", () => {
  assert.deepEqual(
    ownership(
      owner,
      app +
        "\nfunction AnotherView() { const [expanded, setExpanded] = useState(false); return expanded; }",
    ),
    [],
  );
  const aliased = changed(
    app,
    "  createWorkspaceNavigationCommands,",
    "  createWorkspaceNavigationCommands as createNavigationCommands,",
  ).replace(
    "} = createWorkspaceNavigationCommands({",
    "} = createNavigationCommands({",
  );
  assert.deepEqual(ownership(owner, aliased), []);
});
test("new Host/private lifecycle rejects lost scope/session/updater checks, duplicate registration, reordered null siblings and fake imports independently of the old state oracle", () => {
  const hostCases = [
    changed(stableHost, "current.csrfToken === scope.csrfToken", "true"),
    changed(
      stableHost,
      "lifetime.current.incarnation !== incarnation",
      "false",
    ),
    changed(
      stableHost,
      "if (!permitted(incarnation, destination)) return previous;",
      "if (false) return previous;",
    ),
    changed(stableHost, "return host.retire;", "return () => {};"),
    changed(stableHost, "return origin.retire;", "return () => {};"),
    changed(
      stableHost,
      "scopedStorage(`${scope.centerId}:${scope.principalId}`)",
      "scopedStorage()",
    ),
    changed(
      stableHost,
      'from "./use-workspace-navigation.js"',
      'from "./fake-navigation.js"',
    ),
    changed(
      stableHost,
      "useLayoutEffect(() => {",
      "useInsertionEffect(() => {",
    ),
    changed(
      stableHost,
      "const state = useWorkspaceNavigationState();",
      "const useWorkspaceNavigationState = () => ({}); const state = useWorkspaceNavigationState();",
    ),
  ];
  const hostRules = [
    "explicit-host-identity-lifetime-and-two-stage-writer-contract",
    "explicit-host-identity-lifetime-and-two-stage-writer-contract",
    "explicit-host-identity-lifetime-and-two-stage-writer-contract",
    "first-null-sibling-only-lifetime-registration",
    "first-null-sibling-only-lifetime-registration",
    "host-construction-only-reviewed-registration-and-declarations",
    "unique-real-imported-owner-surface-commit",
    "first-null-sibling-only-lifetime-registration",
    "unique-real-imported-owner-surface-commit",
  ];
  assert.equal(hostCases.length, hostRules.length);
  for (const [index, candidate] of hostCases.entries()) {
    parse({ "host.ts": candidate });
    assert.ok(
      ownership(owner, app, candidate).includes(hostRules[index]!),
      `Host counterfactual ${index}: ${hostRules[index]}`,
    );
  }
  const appCases = [
    changed(
      app,
      'from "./host/use-workspace-navigation-host.js"',
      'from "./host/fake-navigation-host.js"',
    ),
    changed(
      app,
      "<NavigationHostLifetime host={host} />",
      "<NavigationHostLifetime host={{...host}} />",
    ),
    changed(
      app,
      "<NavigationOriginLifetime origin={origin} />",
      "<NavigationOriginLifetime origin={origin} /><NavigationOriginLifetime origin={origin} />",
    ),
    changed(
      app,
      "<WorkspaceApp client={client} host={host} origin={origin} />",
      "<WorkspaceApp client={client} host={host} origin={{...origin}} />",
    ),
    changed(app, "if (!origin.isActive()) return;", "if (false) return;"),
  ];
  const appRules = [
    "actual-import-bound-lifetime-owners-not-local-mirrors",
    "actual-protected-branch-and-first-null-sibling-order",
    "actual-protected-branch-and-first-null-sibling-order",
    "actual-protected-branch-and-first-null-sibling-order",
    "private-notice-remains-with-origin-not-retired-updater",
  ];
  assert.equal(appCases.length, appRules.length);
  for (const [index, candidate] of appCases.entries()) {
    parse({ "App.tsx": candidate });
    assert.ok(
      ownership(owner, candidate).includes(appRules[index]!),
      `App counterfactual ${index}: ${appRules[index]}`,
    );
  }
  assert.ok(
    ownership(
      changed(
        owner,
        "continuation: Continuation<P>;",
        "continuation?: Continuation<P>;",
      ),
      app,
    ).includes("mandatory-no-test-only-fallback"),
  );
});
