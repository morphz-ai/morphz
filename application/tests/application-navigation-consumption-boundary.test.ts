import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  SyntaxKind,
  isArrowFunction,
  isBindingElement,
  isBinaryExpression,
  isCallExpression,
  isFunctionDeclaration,
  isElementAccessExpression,
  isExpressionStatement,
  isIdentifier,
  isIfStatement,
  isImportDeclaration,
  isJsxAttribute,
  isJsxAttributes,
  isJsxElement,
  isJsxExpression,
  isJsxFragment,
  isJsxOpeningElement,
  isJsxSelfClosingElement,
  isNamedImports,
  isMethodDeclaration,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPrefixUnaryExpression,
  isPostfixUnaryExpression,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  type CallExpression,
  type Identifier,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";

// Finite consumption contract, not arbitrary JS purity, React scheduling or
// visual/OS hit-test proof. cb7246a2 canonical hashes below were computed from
// the fixed original App/Host, not the migrated implementation. CI needs no git
// history. The App→Host prop replacements and Stage13's six exact inspector
// event ports are normalized; the latter use the independently fixed Git85
// callbacks. The four state registrations/one commit expand the actual owner
// at their real import-bound calls, retaining the original hook/effect hashes.
// Exchange read state/ack/commit likewise expand to the fixed 4ce registrations
// only after the actual new owner and its host ports pass a finite seam check.
// literal trees, callbacks, keys/refs/hidden/portals and hook arguments remain.
// A future deliberate UI/lifecycle change must explicitly review this baseline.
const baseline = {
  App: {
    jsxNodes: 196,
    jsxRoots: 14,
    jsx: "0462fe0a8503ae683190966d423547dc451cd14c73f5630d1a32b86d3033b66f",
    effectsCount: 16,
    effects: "d92523acc4e40a0ed0f32aa5b6a4a7e8db96327403173f9823e3b7000f430562",
    hooksCount: 81,
    hooks: "c6ed83e4de5d7b4f1497671e611429fa9ee96d5d311e31cee372e0b6a4739de6",
  },
  Host: {
    jsxNodes: 71,
    jsxRoots: 5,
    jsx: "409f5e6e0f02684d364194c204c9723160f8dbe8bde3925a7ba2c35a98cfaf36",
    effectsCount: 5,
    effects: "d9935ce60400847c4ebe466baa13bcb40a8f9d5d6c4cf256c1641cb6e2104416",
    hooksCount: 20,
    hooks: "920302f2c6c8dd66d3959d8fe96dd57db898a5536a6660ee94b446eb0c660b18",
  },
} as const;

// Approved adapter: the original Host guard/catch/finally remain local and the
// original execute promise is awaited there. This is not an extra async owner
// bridge, a second lock or a copy of the moved feature/navigation algorithms.
const adapterText = `
async function launch(app: ApplicationCatalogEntry, contents = false) {
  if (launching.current) return;
  launching.current = true;
  setBusy(true);
  try {
    const action = applicationActions.launch(app, navigationSnapshot, contents);
    if (action.kind === "contents") { await action.pending; return; }
    action.commit(await action.pending);
  } catch (error) { onNotice((error as Error).message); }
  finally { launching.current = false; setBusy(false); }
}
async function close(instance: ApplicationInstance) {
  try {
    const action = applicationActions.close(instance, navigationSnapshot);
    await action.pending;
    action.commit();
  } catch (error) { onNotice((error as Error).message); }
}
function capture() {
  const navigationSnapshot = { workspaceId, navigationId, activeId, instances };
}
function prepared() {
  const applicationActions: ApplicationNavigationActions = {
    activate: activateApplication,
    launch(app, captured, contents = false) {
      if (contents) return { kind: "contents", pending: openWorkspaceContents() };
      return {
        kind: "application",
        pending: client.execute({ type: "launch-application", workspaceId: captured.workspaceId,
          applicationId: app.id, applicationVersion: app.version }),
        commit(receipt) { activateApplication(receipt.entityId, captured.navigationId); },
      };
    },
    close(instance, captured) {
      return {
        pending: client.execute({ type: "close-application", instanceId: instance.id,
          expectedRevision: instance.revision }),
        commit() {
          if (captured.activeId === instance.id) {
            const index = captured.instances.findIndex((i) => i.id === instance.id);
            activateApplication(captured.instances[index + 1]?.id ?? captured.instances[index - 1]?.id ?? null,
              captured.navigationId);
          }
        },
      };
    },
  };
}
`;
// Approved bounded additions. The cb7246a2 baselines above are unchanged.
// Only after these exact seams pass can their old registration/DOM counterparts
// be expanded for the old whole-tree comparison; new lifetime is checked apart.
const navigationAdapterText = `
function App() {
 const client=useWorkspace();
 const currentIdentity=client.boot?{centerId:client.boot.centerId,principalId:client.boot.principalId,csrfToken:client.boot.csrfToken}:null;
 const [identity,setIdentity]=useState<NavigationIdentity|null>(currentIdentity);
 const nextIdentity=client.authenticationRequired?null:(currentIdentity??identity);
 if(identity?.centerId!==nextIdentity?.centerId||identity?.principalId!==nextIdentity?.principalId||identity?.csrfToken!==nextIdentity?.csrfToken)setIdentity(nextIdentity);
 if(client.authenticationRequired){return <WorkspaceLogin client={client}/>;}
 if(client.boot){storageScope(client.boot.centerId,client.boot.principalId);}
 if(!nextIdentity)return <WorkspaceConnection client={client}/>;
 return (<WorkspaceNavigationHost key={JSON.stringify(nextIdentity)} client={client} identity={nextIdentity}/>);
}
function WorkspaceNavigationHost(){const host=useWorkspaceNavigationHost({identity,getSnapshot:client.getSnapshot});return (<><NavigationHostLifetime host={host}/>{client.boot?(<PrivateNavigationBoundary client={client} host={host}/>):(<WorkspaceConnection client={client}/>)}</>);}
function PrivateNavigationBoundary(){const origin=useWorkspaceNavigationOrigin(host);return (<><NavigationOriginLifetime origin={origin}/><WorkspaceApp client={client} host={host} origin={origin}/></>);}
function NavigationHostLifetime(){useLayoutEffect(()=>{host.activate();return host.retire;},[]);return null;}
function NavigationOriginLifetime(){useLayoutEffect(()=>{origin.activate();return origin.retire;},[]);return null;}
function hostIdentityCapture(){const [scope]=useState<NavigationIdentity>(()=>({...identity}));const lifetime=useRef({active:false,incarnation:0});}
function scopedRegistration(){const [storage]=useState(()=>scopedStorage(\`\${scope.centerId}:\${scope.principalId}\`));}
function originalStorage(){const {readLocal,writeLocal}=useState(()=>scopedStorage())[0];}
const newScriptPort = <ApplicationHost onOpenScript={(id,itemId)=>void openScriptLocation({productionId:id,...(itemId?{itemId}:{})},renderNavigation)}/>;
const oldScriptPort = <ApplicationHost onOpenScript={(id,itemId)=>void openScriptLocation({productionId:id,...(itemId?{itemId}:{})})}/>;
const newProjectPort = <CreateDialog prepareCreated={creating === "project" ? prepareCreatedProject : undefined} onCreated={(id,kind)=>{setCreating(null);if(kind!=="project")void openObject(project.id,id);}}/>;
const oldProjectPort = <CreateDialog onCreated={(id,kind)=>{setCreating(null);if(kind==="project")openProject(id);else void openObject(project.id,id);}}/>;
function prepared(){const applicationActions:ApplicationNavigationActions={
 activate:activateApplication,
 launch(app,captured,contents=false){
  if(contents)return {kind:"contents",pending:openWorkspaceContents()};
  const intent=capture(captured.navigationId);
  const destination:CurrentDestination=(current)=>projectAvailable(current,captured.workspaceId);
  if(!privateLifetimePermitted(intent,destination))return {kind:"application",pending:Promise.reject(new Error("原位置已不可用或无访问权限。")),commit(){}};
  return {kind:"application",pending:client.execute({type:"launch-application",workspaceId:captured.workspaceId,applicationId:app.id,applicationVersion:app.version}),
   commit(receipt){if(!permitted(intent,(current)=>instanceAvailable(current,receipt.entityId,captured.workspaceId,app)))return;activateApplication(receipt.entityId,captured.navigationId,app);}};
 },
 close(instance,captured){
  const intent=capture(captured.navigationId);const app={id:instance.applicationId,version:instance.applicationVersion};
  if(!privateLifetimePermitted(intent,(current)=>instanceAvailable(current,instance.id,captured.workspaceId,app)))return {pending:Promise.reject(new Error("原位置已不可用或无访问权限。")),commit(){}};
  return {pending:client.execute({type:"close-application",instanceId:instance.id,expectedRevision:instance.revision}),commit(){
   if(!permitted(intent,(current)=>projectAvailable(current,captured.workspaceId)&&!current.workspace.applicationInstances.some((value)=>value.id===instance.id)))return;
   if(captured.activeId===instance.id){const index=captured.instances.findIndex((i)=>i.id===instance.id);const next=captured.instances[index+1]??captured.instances[index-1];const nextApp=next?{id:next.applicationId,version:next.applicationVersion}:undefined;
    if(next&&!permitted(intent,(current)=>instanceAvailable(current,next.id,captured.workspaceId,nextApp)))return;activateApplication(next?.id??null,captured.navigationId,nextApp);}
  }};
 }
};}
`;
// Original b8db8158 persisted schema/defaults, with its View alias spelled by
// the identical WorkSurfaceView import. New Host seams are checked before any
// old-tree expansion; the fixed cb7246a2 counts and hashes are not recalculated.
const navigationHostContractText = `
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
function registrations(){
 const {readLocal,writeLocal}=storage;
 const [persistenceNotice,setPersistenceNotice]=useState<PersistenceNotice>("");
 const state=useWorkspaceNavigationState();
}
function isCurrentHost(){return lifetime.current.active&&!!currentProjection();}
function returned(){return {prefs,persistenceNotice,dismissPersistenceNotice:()=>setPersistenceNotice(""),storage,recentContentVisits,
 navigation:{...state,isCurrent:(generation:number)=>isCurrentHost()&&state.isCurrent(generation)},
 isCurrentHost,captureCommit,activate,retire,currentProjection,writePreferences,recordContentVisit};}
`;
// Exact original App function from Git cb7246a2, verified before embedding.
// This is a DOM/hook comparison projection, not production navigation code.
const fixedAppRoot = `export function App() {
  const client = useWorkspace();
  if (client.authenticationRequired) return <WorkspaceLogin client={client} />;
  if (!client.boot)
    return (
      <main className="connection-screen">
        <BrandMark />
        <h1>Morphz</h1>
        <p>{client.error || "正在打开工作空间…"}</p>
        <button onClick={() => void client.refresh()}>重试</button>
      </main>
    );
  storageScope(client.boot.centerId, client.boot.principalId);
  return (
    <WorkspaceApp
      key={\`\${client.boot.centerId}:\${client.boot.principalId}\`}
      client={client}
    />
  );
}`;
// New, reviewed input-port wiring is checked independently. Old JSX arrows
// below are copied from Git 39cf13cf (also unchanged in b8db8158), not generated
// from the extracted owner. The original cb7246a2 hashes above stay fixed.
const inputToolAdapterText = `
function registrations(){
 const inputDictation=useExchangeDictationState();
 const {dictationControls,speechRecording,setSpeechRecording}=inputDictation;
 const inputMedia=useExchangeInputMediaState();
 const {uploadingDrafts,speech,capture}=inputMedia;
 const nativeInput=useExchangeNativeInputState();
 const {directoryPickerScope,nativeExportDialog,setNativeExportDialog}=nativeInput;
 useExchangeInputToolCommit(inputMedia,{contextKey,inputVisible});
 const closeSpeech=createExchangeInputToolCloseCommand({dictation:inputDictation,media:inputMedia,currentContext,keepExchangeOpen,
  focusMicrophone:()=>exchange.current?.querySelector<HTMLButtonElement>('button[aria-label="语音输入"]')?.focus()});
 const inputTools=createExchangeInputToolCommands({closeSpeech,dictation:inputDictation,media:inputMedia,native:nativeInput,
  render:{contextKey,directoryScope,contextTitle,draft,project,artifact,preferences:prefs},
  drafts:{replace:setDraft,update:updateDraft},currentContext,exchange:{showInput,setInteraction},
  focus:{scheduleInput:()=>requestAnimationFrame(()=>input.current?.focus())},
  openSavedCapture:(projectId,id)=>void openObject(projectId,id),
  reportInputError:(key,message)=>setInputErrors((old)=>({...old,[key]:message}))});
}
const fixedInputPorts=(<>
 <MessageAttachments
  capture={{onSelect:(hideWindow)=>setCapture({key:contextKey,projectId:project.id,hideWindow,
   ...(artifact?{artifactId:artifact.id,artifactRevision:draft.revision??prefs.artifactRevision??artifact.revision}:{})})}}
  onBusy={(busy)=>setUploadingDrafts((old)=>({...old,[contextKey]:busy}))}
  onChange={(update)=>updateDraft(contextKey,(old)=>({...old,attachments:update(old.attachments??[])}))}
  onError={(message)=>setInputErrors((old)=>({...old,[contextKey]:message}))}/>
 <button aria-label="语音输入" onClick={()=>{
  if(speech?.key===contextKey&&!speech.modal)dictationControls.current?.toggle();
  else setSpeech({scope:{projectId:project.id,...(artifact?{artifactId:artifact.id,revision:draft.revision??prefs.artifactRevision??artifact.revision}:{})},
   title:contextTitle,key:contextKey,draft:{...draft}});
 }}/>
 <AgentDirectories onSelecting={(selecting)=>setDirectoryPickerScope((current)=>selecting?directoryScope:current===directoryScope?null:current)}
  onError={(message)=>setInputErrors((old)=>({...old,[contextKey]:message}))}/>
 <SpeechDialog onTranscript={speech.modal?undefined:(text,previous)=>updateDraft(speech.key,(saved)=>({...saved,body:replaceDictationTail(saved.body,text,previous),revision:speech.scope.revision??null}))}
  onInsert={(text)=>{
   const saved=speech.draft;
   const body=[saved.body,text].filter(Boolean).join("\\n");
   if(body.length>30000)throw new Error("这段文字超过单条消息长度，请先保存为文档，再围绕文档输入；文字不会被截断。");
   setDraft(speech.key,{...saved,body,revision:speech.scope.revision??null});
   setSpeech(null);setInteraction("input");requestAnimationFrame(()=>input.current?.focus());
  }}/>
 <CaptureDialog onClose={()=>setCapture(null)}
  onAttach={(attachment)=>{const key=capture.key;updateDraft(key,(old)=>({...old,attachments:[...(old.attachments??[]),attachment]}));setCapture(null);if(currentContext.current===key)showInput();}}
  onSaved={(id)=>{const projectId=capture.projectId;setCapture(null);void openObject(projectId,id);}}/>
</>);
`;
type Parsed = {
  source: SourceFile;
  nodes: Node[];
  identifiers: Identifier[];
  symbols: Map<Node, number | undefined>;
};
function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}
function parse(contents: Record<string, string>) {
  const directory = "/application-navigation-consumption";
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
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const project = snapshot.getProject(config)!;
    assert.deepEqual(
      project.program.getSyntacticDiagnostics(),
      [],
      "invalid source cannot satisfy a consumption gate",
    );
    return new Map(
      Object.keys(contents).map((name): [string, Parsed] => {
        const source = project.program.getSourceFile(
          `${directory}/${name}.tsx`,
        )!;
        const nodes: Node[] = [],
          identifiers: Identifier[] = [];
        walk(source, (node) => {
          nodes.push(node);
          if (isIdentifier(node)) identifiers.push(node);
        });
        const resolved = project.checker.getSymbolAtLocation(identifiers);
        return [
          name,
          {
            source,
            nodes,
            identifiers,
            symbols: new Map(
              identifiers.map((node, index) => [node, resolved[index]?.id]),
            ),
          },
        ];
      }),
    );
  } finally {
    snapshot.dispose();
    api.close();
  }
}
function syntax(
  node: Node,
  normalizeAppHost = false,
  subjectAttributes?: Map<Node, unknown>,
): unknown {
  if (subjectAttributes?.has(node)) return subjectAttributes.get(node);
  if (
    normalizeAppHost &&
    isJsxAttribute(node) &&
    isJsxAttributes(node.parent)
  ) {
    const tag = node.parent.parent;
    if (
      (isJsxOpeningElement(tag) || isJsxSelfClosingElement(tag)) &&
      tag.tagName.getText() === "ApplicationHost" &&
      ["onActivate", "onOpenContents", "applicationActions"].includes(
        node.name.getText(),
      )
    )
      return undefined;
  }
  const children: unknown[] = [];
  node.forEachChild((child) => {
    const value = syntax(child, normalizeAppHost, subjectAttributes);
    if (value !== undefined) children.push(value);
  });
  return [node.kind, children.length ? children : node.getText()];
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const jsx = (node: Node) =>
  isJsxElement(node) || isJsxFragment(node) || isJsxSelfClosingElement(node);
function imported(
  parsed: Parsed,
  path: string,
  name: string,
  typeOnly = false,
) {
  const matches: Identifier[] = [];
  for (const node of parsed.nodes.filter(isImportDeclaration)) {
    if (
      !isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== path ||
      !node.importClause?.namedBindings ||
      !isNamedImports(node.importClause.namedBindings)
    )
      continue;
    for (const item of node.importClause.namedBindings.elements)
      if (
        (item.propertyName ?? item.name).text === name &&
        (item.isTypeOnly ||
          node.importClause.phaseModifier === SyntaxKind.TypeKeyword) ===
          typeOnly
      )
        matches.push(item.name);
  }
  assert.equal(matches.length, 1, `one actual ${name} import`);
  const binding = parsed.symbols.get(matches[0]!);
  assert.ok(binding !== undefined, `${name} import binding resolves`);
  return binding;
}
function oneFunction(parsed: Parsed, name: string) {
  const found = parsed.nodes
    .filter(isFunctionDeclaration)
    .filter((node) => node.name?.text === name);
  assert.equal(found.length, 1, `one ${name} function`);
  return found[0]!;
}
function oneVariable(parsed: Parsed, name: string) {
  const found = parsed.nodes
    .filter(isVariableDeclaration)
    .filter((node) => isIdentifier(node.name) && node.name.text === name);
  assert.equal(found.length, 1, `one ${name} variable`);
  return found[0]!;
}
function reactHooks(parsed: Parsed) {
  const hooks = new Map<number | undefined, string>();
  for (const node of parsed.nodes.filter(isImportDeclaration)) {
    if (
      !isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== "react"
    )
      continue;
    assert.ok(
      node.importClause?.namedBindings &&
        isNamedImports(node.importClause.namedBindings) &&
        !node.importClause.name,
      "original explicit React imports, no hidden namespace lifecycle",
    );
    for (const item of node.importClause.namedBindings.elements) {
      const name = (item.propertyName ?? item.name).text;
      if (
        item.isTypeOnly ||
        node.importClause.phaseModifier === SyntaxKind.TypeKeyword
      )
        continue;
      assert.ok(
        [
          "createElement",
          "useState",
          "useRef",
          "useEffect",
          "useLayoutEffect",
          "useCallback",
          "useMemo",
        ].includes(name),
        "no unreviewed React store or lifecycle primitive",
      );
      if (/^use[A-Z]/.test(name)) {
        const binding = parsed.symbols.get(item.name);
        assert.ok(binding !== undefined);
        hooks.set(binding, name);
        for (const use of parsed.identifiers.filter(
          (node) => parsed.symbols.get(node) === binding,
        ))
          assert.ok(
            use === item.name ||
              (isCallExpression(use.parent) && use.parent.expression === use),
            "hook imports are original direct calls, not alias/async bridges",
          );
      }
    }
  }
  return hooks;
}
type SubjectContract = {
  attributes: Map<Node, unknown>;
  expanded: Map<Node, { node: CallExpression; name: string }[]>;
};
function structure(
  parsed: Parsed,
  normalizeAppHost: boolean,
  subject?: SubjectContract,
) {
  const hooks = reactHooks(parsed);
  const calls = parsed.nodes.filter(isCallExpression).flatMap((node) => {
    const expanded = subject?.expanded.get(node);
    if (expanded) return expanded;
    if (
      isIdentifier(node.expression) &&
      hooks.has(parsed.symbols.get(node.expression))
    )
      return [{ node, name: hooks.get(parsed.symbols.get(node.expression))! }];
    return [];
  });
  const hook = ({ node, name }: (typeof calls)[number]) => [
    name,
    [...(node.typeArguments ?? [])].map((node) => syntax(node)),
    [...node.arguments].map((node) => syntax(node)),
  ];
  const effects = calls.filter(({ name }) =>
    ["useEffect", "useLayoutEffect"].includes(name),
  );
  const jsxNodes = parsed.nodes.filter(jsx);
  const roots = jsxNodes.filter((node) => {
    for (let parent = node.parent; parent; parent = parent.parent)
      if (jsx(parent)) return false;
    return true;
  });
  return {
    jsxNodes: jsxNodes.length,
    jsxRoots: roots.length,
    jsx: digest(
      roots.map((node) => syntax(node, normalizeAppHost, subject?.attributes)),
    ),
    effectsCount: effects.length,
    effects: digest(effects.map(hook)),
    hooksCount: calls.length,
    hooks: digest(calls.map(hook)),
  };
}
const subjectPath = "./host/use-subject-inspector.js";
const subjectAdapterText = `
const commitArguments = {contextKey, executions, understandingOpen, collaborationVisible};
const originalAllWork = setAllActivity;
const originalExecution = setExecutions;
`;
function bindingVariable(parsed: Parsed, name: string) {
  const found = parsed.nodes.filter(isVariableDeclaration).filter((node) => {
    let matched = false;
    walk(node.name, (child) => {
      if (isIdentifier(child) && child.text === name) matched = true;
    });
    return matched;
  });
  assert.equal(found.length, 1, `one ${name} registration seam`);
  return found[0]!;
}
function subjectContract(
  app: Parsed,
  subject: Parsed,
  fixed: Parsed,
  adapter: Parsed,
): SubjectContract {
  const expanded: SubjectContract["expanded"] = new Map(),
    attributes = new Map<Node, unknown>(),
    ownerHooks = reactHooks(subject),
    registered = new Set<Node>();
  for (const [name, local, before, after, primitives] of [
    [
      "useSubjectActivityState",
      "subjectActivity",
      "notificationsOpen",
      "unreadNotifications",
      ["useState"],
    ],
    [
      "useSubjectInspectionState",
      "subjectInspection",
      "capture",
      "searchOpen",
      ["useState", "useState"],
    ],
    [
      "useSubjectCollaborationState",
      "subjectCollaboration",
      "compact",
      "personalSpace",
      ["useState"],
    ],
    [
      "useSubjectInspectorMemory",
      "inspectorSelections",
      "inspectorOpen",
      "resizeInspector",
      ["useRef"],
    ],
    ["useSubjectInspectorCommit", null, null, null, ["useLayoutEffect"]],
  ] as const) {
    const symbol = imported(app, subjectPath, name);
    const uses = app.identifiers.filter(
      (node) => app.symbols.get(node) === symbol,
    );
    const calls = uses.filter(
      (node) =>
        isCallExpression(node.parent) && node.parent.expression === node,
    );
    assert.equal(uses.length, 2, `${name}: import plus one direct call only`);
    assert.equal(calls.length, 1, `${name}: one actual registration`);
    const call = calls[0]!.parent;
    assert.ok(isCallExpression(call));
    assert.equal(call.typeArguments?.length ?? 0, 0);
    if (local) {
      assert.equal(oneVariable(app, local).initializer, call);
      assert.equal(call.arguments.length, 0);
      assert.ok(bindingVariable(app, before).end < call.pos);
      assert.ok(call.end < bindingVariable(app, after).pos);
    } else {
      assert.equal(call.parent.kind, SyntaxKind.ExpressionStatement);
      assert.equal(call.arguments.length, 2);
      assert.equal(call.arguments[0]!.getText(), "inspectorSelections");
      assert.deepEqual(
        syntax(call.arguments[1]!),
        syntax(oneVariable(adapter, "commitArguments").initializer!),
      );
    }
    const body = oneFunction(subject, name).body;
    assert.ok(body);
    const hookCalls: { node: CallExpression; name: string }[] = [];
    walk(body, (node) => {
      if (!isCallExpression(node) || !isIdentifier(node.expression)) return;
      const hookName = ownerHooks.get(subject.symbols.get(node.expression));
      if (hookName) {
        registered.add(node);
        hookCalls.push({ node, name: hookName });
      } else
        assert.doesNotMatch(
          node.expression.text,
          /^use[A-Z]/,
          "no hidden hook bridge",
        );
    });
    assert.deepEqual(
      hookCalls.map(({ name }) => name),
      primitives,
    );
    expanded.set(call, hookCalls);
  }
  const allOwnerHooks = subject.nodes
    .filter(isCallExpression)
    .filter(
      (node) =>
        isIdentifier(node.expression) &&
        ownerHooks.has(subject.symbols.get(node.expression)),
    );
  assert.equal(
    allOwnerHooks.length,
    registered.size,
    "no extra owner lifecycle outside original registrations",
  );

  const factory = imported(app, subjectPath, "createSubjectInspectorCommands");
  const commandCalls = app.nodes
    .filter(isCallExpression)
    .filter(
      (node) =>
        isIdentifier(node.expression) &&
        app.symbols.get(node.expression) === factory,
    );
  assert.equal(commandCalls.length, 1, "one actual subject command factory");
  const declaration = oneVariable(app, "subjectInspector");
  assert.equal(declaration.initializer, commandCalls[0]);
  const commands = app.symbols.get(declaration.name);
  assert.ok(commands !== undefined);
  for (const [tag, path, attr, member, original] of [
    [
      "WorkspaceTopbar",
      "./shell/WorkspaceTopbar.js",
      "onToggleCollaboration",
      "toggleCollaboration",
      "toggleCollaboration",
    ],
    ["SubjectSidebar", "./SubjectSidebar.js", "onBack", "back", "onBack"],
    [
      "SubjectSidebar",
      "./SubjectSidebar.js",
      "onInspect",
      "selectScope",
      "onInspect",
    ],
    [
      "ExecutionSidebar",
      "./ExecutionSidebar.js",
      "onAllWorkChange",
      "setAllActivity",
      "originalAllWork",
    ],
    [
      "ExecutionSidebar",
      "./ExecutionSidebar.js",
      "onSelect",
      "selectExecution",
      "originalExecution",
    ],
    [
      "SubjectObjectives",
      "./SubjectObjectives.js",
      "onSelect",
      "selectExecution",
      "originalExecution",
    ],
  ]) {
    const component = imported(app, path!, tag!);
    const ports = app.nodes.filter(isJsxAttribute).filter((node) => {
      const opening = node.parent.parent;
      return (
        node.name.getText() === attr &&
        (isJsxOpeningElement(opening) || isJsxSelfClosingElement(opening)) &&
        isIdentifier(opening.tagName) &&
        app.symbols.get(opening.tagName) === component
      );
    });
    assert.equal(ports.length, 1, `${tag}.${attr}: one original consumer port`);
    const port = ports[0]!,
      value = port.initializer;
    assert.ok(value && isJsxExpression(value) && value.expression);
    const expression = value.expression;
    assert.ok(
      isPropertyAccessExpression(expression) &&
        isIdentifier(expression.expression),
    );
    assert.equal(app.symbols.get(expression.expression), commands);
    assert.equal(expression.name.text, member);
    const originalNode = oneVariable(
      original!.startsWith("original") ? adapter : fixed,
      original!,
    ).initializer!;
    let originalTree = syntax(originalNode);
    if (original === "onInspect") {
      // The fixed fixture adds a type solely for its extracted binding. Git85's
      // JSX callback is `(scope) => { ... }`; its exact original body is reused.
      assert.ok(isArrowFunction(originalNode));
      assert.equal(originalNode.parameters.length, 1);
      const parameter = originalNode.parameters[0]!;
      assert.equal(parameter.name.getText(), "scope");
      assert.equal(parameter.type?.getText(), "ExecutionScope");
      const children: unknown[] = [];
      originalNode.forEachChild((child) => {
        if (child === parameter) {
          const binding: unknown[] = [];
          child.forEachChild((part) => {
            if (part !== parameter.type) binding.push(syntax(part));
          });
          children.push([child.kind, binding]);
        } else children.push(syntax(child));
      });
      originalTree = [originalNode.kind, children];
    }
    attributes.set(port, [
      port.kind,
      [syntax(port.name), [SyntaxKind.JsxExpression, [originalTree]]],
    ]);
  }
  return { attributes, expanded };
}

const exchangeReadPath = "./host/use-exchange-read-receipts.js";
const exchangeReadAdapterText = `
function useExchangeReadReceiptState() {
  const [seenReplies, setSeenReplies] = useState(() => {
    const restored = readReplyReceipts(readStored());
    if (restored !== null) return restored;
    const bootstrap = readBootstrap();
    return acknowledgeReplies({}, replyReceipts(bootstrap.messages, bootstrap.outputs, bootstrap.scriptOutputs));
  });
  return {seenReplies, setSeenReplies};
}
function useExchangeReadAcknowledgement() {
  return useCallback((receipts: ReplyReceipt[]) => {
    setSeenReplies((old) => acknowledgeReplies(old, receipts));
  }, []);
}
function useExchangeReadReceiptCommit() {
  useEffect(() => {
    setSeenReplies((old) => reconcileReplyReceipts(old, receipts));
  }, [version]);
  useEffect(() => {
    try { persist(seenReplies); }
    catch { onNotice("已读状态暂时无法保存，重开后可能再次提示。"); }
  }, [seenReplies]);
}
const stateArguments = {
  readStored: () => readLocal<unknown>("conversation-read-receipts", null),
  readBootstrap: () => ({messages: client.boot!.runtime.messages,
    outputs: client.boot!.outputs, scriptOutputs: client.boot!.scriptOutputs}),
};
const acknowledgementArguments = readReceiptState;
const commitArguments = {receipts, version: receiptVersion,
  persist: (seen) => writeLocal("conversation-read-receipts", seen), onNotice: setNotice};
`;
function scalarSyntax(node: Node): unknown {
  const children: unknown[] = [];
  node.forEachChild((child) => {
    children.push(scalarSyntax(child));
  });
  return [
    node.kind,
    ...(isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)
      ? [node.operator]
      : []),
    ...(isBinaryExpression(node) ? [node.operatorToken.kind] : []),
    children.length ? children : node.getText(),
  ];
}
function finiteNavigationTree(node: Node): unknown {
  const children: unknown[] = [];
  node.forEachChild((child) => {
    if (child.kind !== SyntaxKind.JsxText || child.getText().trim())
      children.push(finiteNavigationTree(child));
  });
  return [
    node.kind,
    ...(isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)
      ? [node.operator]
      : []),
    ...(isBinaryExpression(node) ? [node.operatorToken.kind] : []),
    children.length ? children : node.getText(),
  ];
}
function navigationProjection(
  app: Parsed,
  stable: Parsed,
  adapter: Parsed,
  fixed: Parsed,
  hostContract: Parsed,
): Parsed {
  const edits: { start: number; end: number; text: string }[] = [];
  const replace = (node: Node, text: string) =>
    edits.push({ start: node.getStart(), end: node.end, text });
  const tree = (node: Node) => JSON.stringify(finiteNavigationTree(node));
  for (const name of [
    "App",
    "WorkspaceNavigationHost",
    "PrivateNavigationBoundary",
  ]) {
    const actual = oneFunction(app, name),
      expected = oneFunction(adapter, name);
    assert.equal(
      tree(actual.body!),
      tree(expected.body!),
      "new identity/zero-DOM sibling seam: " + name,
    );
    replace(actual, name === "App" ? fixedAppRoot : "");
  }
  for (const name of ["NavigationHostLifetime", "NavigationOriginLifetime"])
    assert.equal(
      tree(oneFunction(stable, name).body!),
      tree(oneFunction(adapter, name).body!),
      "new lifetime registered exactly once separately: " + name,
    );
  for (const [name, container] of [
    ["NavigationHostLifetime", "WorkspaceNavigationHost"],
    ["NavigationOriginLifetime", "PrivateNavigationBoundary"],
  ] as const) {
    const binding = imported(
      app,
      "./host/use-workspace-navigation-host.js",
      name,
    );
    const rendered = app.nodes
      .filter(isJsxSelfClosingElement)
      .filter(
        (node) =>
          node.tagName.getText() === name &&
          node.getStart() > oneFunction(app, container).getStart() &&
          node.end < oneFunction(app, container).end,
      );
    assert.equal(
      rendered.length,
      1,
      "actual imported lifetime consumer: " + name,
    );
    assert.ok(isIdentifier(rendered[0]!.tagName));
    assert.equal(
      app.symbols.get(rendered[0]!.tagName),
      binding,
      "actual imported lifetime consumer: " + name,
    );
  }
  const connection = oneFunction(app, "WorkspaceConnection");
  assert.equal(
    connection.body!.statements.length,
    1,
    "connection extraction cannot hide an extra lifecycle or statement",
  );
  const originalConnection = oneFunction(fixed, "App").body!.statements[2]!;
  assert.equal(originalConnection.kind, SyntaxKind.IfStatement);
  const originalReturns: Node[] = [];
  walk(originalConnection, (node) => {
    if (isReturnStatement(node)) originalReturns.push(node);
  });
  assert.equal(originalReturns.length, 1);
  assert.equal(
    tree(connection.body!.statements[0]!),
    tree(originalReturns[0]!),
    "connection DOM/errors/retry are original, not a placeholder projection",
  );
  replace(connection, "");
  for (const name of [
    "useWorkspaceNavigationHost",
    "useWorkspaceNavigationOrigin",
  ]) {
    const binding = imported(
      app,
      "./host/use-workspace-navigation-host.js",
      name,
    );
    assert.equal(
      app.nodes
        .filter(isCallExpression)
        .filter(
          (node) =>
            isIdentifier(node.expression) &&
            app.symbols.get(node.expression) === binding,
        ).length,
      1,
      "one actual " + name,
    );
  }
  const hook = oneFunction(stable, "useWorkspaceNavigationHost");
  const statements = hook.body!.statements;
  assert.deepEqual(
    statements.map((node) => {
      if (node.kind === SyntaxKind.VariableStatement) {
        const variables: Node[] = [];
        node.forEachChild((list) => {
          list.forEachChild((child) => {
            if (isVariableDeclaration(child)) variables.push(child);
          });
        });
        assert.equal(
          variables.length,
          1,
          "Host construction only reviewed registrations/declarations",
        );
        return (variables[0] as ReturnType<typeof oneVariable>).name
          .getText()
          .replace(/\s+/g, "");
      }
      return isFunctionDeclaration(node)
        ? `function:${node.name?.text}`
        : isReturnStatement(node)
          ? "return"
          : "eager-statement";
    }),
    [
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
    ],
    "Host construction only reviewed registrations/declarations",
  );
  for (const name of ["readLocal", "persistenceNotice", "state"])
    assert.equal(
      tree(bindingVariable(stable, name)),
      tree(bindingVariable(hostContract, name)),
      "Host construction only reviewed registrations/declarations",
    );
  assert.equal(
    tree(oneFunction(stable, "isCurrentHost").body!),
    tree(oneFunction(hostContract, "isCurrentHost").body!),
    "Host currentness cannot bypass identity/lifetime",
  );
  assert.equal(
    tree(statements.at(-1)!),
    tree(oneFunction(hostContract, "returned").body!.statements[0]!),
    "Host returned navigation preserves currentness/single state",
  );
  const types = (parsed: Parsed) =>
    parsed.nodes
      .filter(isTypeAliasDeclaration)
      .filter((node) => node.name.text === "Preferences");
  assert.equal(
    types(stable).length,
    1,
    "original persisted Preferences schema/defaults",
  );
  assert.equal(
    tree(types(stable)[0]!.type),
    tree(types(hostContract)[0]!.type),
    "original persisted Preferences schema/defaults",
  );
  assert.equal(
    tree(oneVariable(stable, "defaultPrefs")),
    tree(oneVariable(hostContract, "defaultPrefs")),
    "original persisted Preferences schema/defaults",
  );
  assert.equal(
    tree(bindingVariable(stable, "scope")),
    tree(bindingVariable(adapter, "scope")),
    "only the three primitive identity values are captured",
  );
  const lifetimes = hook
    .body!.statements.filter(
      (node) => node.kind === SyntaxKind.VariableStatement,
    )
    .flatMap((node) => {
      const values: Node[] = [];
      walk(node, (child) => {
        if (isVariableDeclaration(child) && child.name.getText() === "lifetime")
          values.push(child);
      });
      return values;
    });
  assert.equal(lifetimes.length, 1);
  assert.equal(
    tree(lifetimes[0]!),
    tree(oneVariable(adapter, "lifetime")),
    "host lease captures no Boot, body, cache or pending state",
  );
  assert.equal(
    hook
      .body!.getText()
      .includes("const state = useWorkspaceNavigationState();"),
    true,
  );
  const ownerBinding = imported(
    stable,
    "./use-workspace-navigation.js",
    "useWorkspaceNavigationState",
  );
  assert.equal(
    stable.nodes
      .filter(isCallExpression)
      .filter(
        (node) =>
          isIdentifier(node.expression) &&
          stable.symbols.get(node.expression) === ownerBinding,
      ).length,
    1,
  );
  assert.equal(
    tree(bindingVariable(stable, "storage")),
    tree(bindingVariable(adapter, "storage")),
    "one explicit identity-scoped storage registration",
  );
  const hostAlias = bindingVariable(app, "prefs");
  assert.equal(hostAlias.initializer?.getText(), "host");
  assert.equal(
    hostAlias.name.getText().replace(/\s/g, ""),
    "{prefs,recentContentVisits,navigation}",
  );
  replace(hostAlias.parent.parent, "");
  const storageAlias = bindingVariable(app, "readLocal");
  assert.equal(storageAlias.initializer?.getText(), "host.storage");
  replace(
    storageAlias.parent.parent,
    oneFunction(adapter, "originalStorage").body!.statements[0]!.getText() +
      "\n" +
      bindingVariable(stable, "recentContentVisits").parent.parent.getText(),
  );
  const preferences = bindingVariable(stable, "prefs");
  const sidebar = oneVariable(app, "leftSidebarPreference");
  edits.push({
    start: sidebar.parent.parent.getStart(),
    end: sidebar.parent.parent.getStart(),
    text: preferences.parent.parent.getText() + "\n",
  });
  const hostRender = app.nodes
    .filter(isJsxOpeningElement)
    .find((node) => node.tagName.getText() === "ApplicationHost");
  assert.ok(hostRender);
  const script = hostRender.attributes.properties
    .filter(isJsxAttribute)
    .find((node) => node.name.getText() === "onOpenScript");
  assert.ok(script);
  const attr = (name: string, tag: string) =>
    adapter.nodes
      .filter(isJsxAttribute)
      .find(
        (node) =>
          node.name.getText() === name &&
          node.parent.parent.getText().startsWith("<" + tag),
      )!;
  assert.equal(tree(script), tree(attr("onOpenScript", "ApplicationHost")));
  const oldScript = adapter.nodes
    .filter(isJsxAttribute)
    .filter((node) => node.name.getText() === "onOpenScript")[1]!;
  replace(script, oldScript.getText());
  const project = app.nodes
    .filter(isJsxSelfClosingElement)
    .filter(
      (node) =>
        node.tagName.getText() === "CreateDialog" &&
        node.attributes.properties.some(
          (prop) =>
            isJsxAttribute(prop) && prop.name.getText() === "prepareCreated",
        ),
    );
  assert.equal(project.length, 1);
  for (const name of ["prepareCreated", "onCreated"]) {
    const actual = project[0]!.attributes.properties
      .filter(isJsxAttribute)
      .find((node) => node.name.getText() === name)!;
    assert.equal(tree(actual), tree(attr(name, "CreateDialog")));
    replace(
      actual,
      name === "prepareCreated"
        ? ""
        : adapter.nodes
            .filter(isJsxAttribute)
            .filter((node) => node.name.getText() === "onCreated")[1]!
            .getText(),
    );
  }
  const primitives = reactHooks(stable);
  assert.deepEqual(
    stable.nodes
      .filter(isCallExpression)
      .filter(
        (node) =>
          isIdentifier(node.expression) &&
          primitives.has(stable.symbols.get(node.expression)),
      )
      .map((node) => primitives.get(stable.symbols.get(node.expression))),
    [
      "useState",
      "useState",
      "useState",
      "useState",
      "useState",
      "useRef",
      "useLayoutEffect",
      "useRef",
      "useLayoutEffect",
    ],
    "new primitive lifetimes are separate, not folded into fixed old effect counts",
  );
  let text = app.source.getFullText();
  for (const edit of edits.sort((a, b) => b.start - a.start))
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return parse({ Projected: text }).get("Projected")!;
}
function checkedNavigationProjection(
  app: Parsed,
  stable: Parsed,
  adapter: Parsed,
  fixed: Parsed,
  hostContract: Parsed,
): Parsed {
  try {
    return navigationProjection(app, stable, adapter, fixed, hostContract);
  } catch (error) {
    assert.fail(`navigation-host-owner-seams: ${(error as Error).message}`);
  }
}
// Keep the original prepared oracle live as well as the explicit new guard
// contract. These are the old raw operation receipts/capture policy, not a
// second implementation of the permitted/destination predicates.
function originalPreparedPolicy(actual: Node, original: Node) {
  const methods = (node: Node, name: string) => {
    const found: Node[] = [];
    walk(node, (child) => {
      if (isMethodDeclaration(child) && child.name.getText() === name)
        found.push(child);
    });
    assert.equal(found.length, 1, `one original prepared ${name}`);
    return found[0]!;
  };
  const pending = (node: Node) => {
    const found: Node[] = [];
    walk(node, (child) => {
      if (
        isPropertyAssignment(child) &&
        child.name.getText() === "pending" &&
        isCallExpression(child.initializer) &&
        child.initializer.expression.getText() !== "Promise.reject"
      )
        found.push(child.initializer);
    });
    return found.map(scalarSyntax);
  };
  const activate = (node: Node) => {
    const found: CallExpression[] = [];
    walk(node, (child) => {
      if (
        isCallExpression(child) &&
        child.expression.getText() === "activateApplication"
      )
        found.push(child);
    });
    assert.equal(found.length, 1);
    return found[0]!;
  };
  for (const name of ["launch", "close"]) {
    const next = methods(actual, name),
      old = methods(original, name);
    assert.deepEqual(
      pending(next),
      pending(old),
      `${name}: original promise-producing calls, arguments and order`,
    );
  }
  const nextLaunch = activate(methods(actual, "launch")),
    oldLaunch = activate(methods(original, "launch"));
  assert.deepEqual(
    nextLaunch.arguments.slice(0, 2).map(scalarSyntax),
    oldLaunch.arguments.map(scalarSyntax),
    "launch preserves original receipt id and captured generation",
  );
  const nextClose = methods(actual, "close"),
    oldClose = methods(original, "close");
  const activeCondition = (node: Node) => {
    const found: Node[] = [];
    walk(node, (child) => {
      if (
        isBinaryExpression(child) &&
        child.left.getText() === "captured.activeId"
      )
        found.push(child);
    });
    assert.equal(found.length, 1);
    return scalarSyntax(found[0]!);
  };
  assert.deepEqual(
    activeCondition(nextClose),
    activeCondition(oldClose),
    "close retains captured active-instance policy",
  );
  const neighbours = (node: Node) => {
    const found: Node[] = [];
    walk(node, (child) => {
      if (
        isElementAccessExpression(child) &&
        child.expression.getText() === "captured.instances"
      )
        found.push(child);
    });
    return found.map(scalarSyntax);
  };
  assert.deepEqual(
    neighbours(nextClose),
    neighbours(oldClose),
    "close retains the original next-then-previous captured neighbour order",
  );
  assert.deepEqual(
    scalarSyntax(activate(nextClose).arguments[1]!),
    scalarSyntax(activate(oldClose).arguments[1]!),
    "close retains original captured generation",
  );
}
function exchangeReadContract(
  app: Parsed,
  owner: Parsed,
  fixed: Parsed,
  adapter: Parsed,
  contract: SubjectContract,
) {
  try {
    const registrations = [
      ["useExchangeReadReceiptState", "useFixedReceiptState", ["useState"]],
      [
        "useExchangeReadAcknowledgement",
        "useFixedReceiptAcknowledgement",
        ["useCallback"],
      ],
      [
        "useExchangeReadReceiptCommit",
        "useFixedReceiptCommit",
        ["useEffect", "useEffect"],
      ],
    ] as const;
    const ownerHooks = reactHooks(owner),
      fixedHooks = reactHooks(fixed);
    const calls: CallExpression[] = [],
      registered = new Set<Node>();
    for (const [name, original, primitives] of registrations) {
      const symbol = imported(app, exchangeReadPath, name);
      const uses = app.identifiers.filter(
        (node) => app.symbols.get(node) === symbol,
      );
      assert.equal(uses.length, 2, `${name}: import plus one direct call`);
      const call = uses.find(
        (node) =>
          isCallExpression(node.parent) && node.parent.expression === node,
      )?.parent;
      assert.ok(call && isCallExpression(call));
      assert.equal(call.typeArguments?.length ?? 0, 0);
      calls.push(call);
      const body = oneFunction(owner, name).body;
      assert.ok(body);
      assert.deepEqual(
        scalarSyntax(body),
        scalarSyntax(oneFunction(adapter, name).body!),
      );
      const actual: string[] = [];
      walk(body, (node) => {
        if (!isCallExpression(node) || !isIdentifier(node.expression)) return;
        const primitive = ownerHooks.get(owner.symbols.get(node.expression));
        if (primitive) {
          actual.push(primitive);
          registered.add(node);
        } else
          assert.doesNotMatch(
            node.expression.text,
            /^use[A-Z]/,
            "no hidden read hook bridge",
          );
      });
      assert.deepEqual(actual, primitives);
      const expanded: { node: CallExpression; name: string }[] = [];
      walk(oneFunction(fixed, original).body!, (node) => {
        if (!isCallExpression(node) || !isIdentifier(node.expression)) return;
        const primitive = fixedHooks.get(fixed.symbols.get(node.expression));
        if (primitive) expanded.push({ node, name: primitive });
      });
      assert.deepEqual(
        expanded.map(({ name }) => name),
        primitives,
      );
      contract.expanded.set(call, expanded);
    }
    assert.equal(
      owner.nodes
        .filter(isCallExpression)
        .filter(
          (node) =>
            isIdentifier(node.expression) &&
            ownerHooks.has(owner.symbols.get(node.expression)),
        ).length,
      registered.size,
    );
    for (const statement of owner.source.statements)
      assert.ok(
        isImportDeclaration(statement) ||
          isTypeAliasDeclaration(statement) ||
          (isFunctionDeclaration(statement) &&
            registrations.some(([name]) => statement.name?.text === name)),
        "only the three read hooks, types and imports; no module mirror/state effect",
      );
    for (const [name, count] of [
      ["acknowledgeReplies", 2],
      ["readReplyReceipts", 1],
      ["reconcileReplyReceipts", 1],
      ["replyReceipts", 1],
    ] as const) {
      const symbol = imported(owner, "../conversation-read.js", name);
      assert.equal(
        owner.nodes
          .filter(isCallExpression)
          .filter(
            (node) =>
              isIdentifier(node.expression) &&
              owner.symbols.get(node.expression) === symbol,
          ).length,
        count,
        `actual ${name} helper binding`,
      );
    }
    const [state, ack, commit] = calls;
    assert.ok(state && ack && commit);
    assert.equal(oneVariable(app, "readReceiptState").initializer, state);
    const seen = bindingVariable(app, "seenReplies");
    assert.equal(seen.initializer?.getText(), "readReceiptState");
    assert.equal(state.arguments.length, 1);
    assert.deepEqual(
      scalarSyntax(state.arguments[0]!),
      scalarSyntax(oneVariable(adapter, "stateArguments").initializer!),
    );
    assert.equal(oneVariable(app, "readReplies").initializer, ack);
    assert.equal(ack.arguments.length, 1);
    assert.deepEqual(
      scalarSyntax(ack.arguments[0]!),
      scalarSyntax(
        oneVariable(adapter, "acknowledgementArguments").initializer!,
      ),
    );
    assert.equal(commit.parent.kind, SyntaxKind.ExpressionStatement);
    assert.equal(commit.arguments.length, 2);
    assert.deepEqual(
      scalarSyntax(commit.arguments[0]!),
      scalarSyntax(ack.arguments[0]!),
    );
    assert.deepEqual(
      scalarSyntax(commit.arguments[1]!),
      scalarSyntax(oneVariable(adapter, "commitArguments").initializer!),
    );
    const ownerState = app.symbols.get(
      oneVariable(app, "readReceiptState").name,
    );
    assert.ok(ownerState !== undefined);
    for (const node of [
      seen.initializer!,
      ack.arguments[0]!,
      commit.arguments[0]!,
    ])
      assert.equal(
        app.symbols.get(node),
        ownerState,
        "one actual read state owner, not a mirror",
      );
    assert.ok(
      bindingVariable(app, "revealedInputs").end < state.pos &&
        state.end < oneVariable(app, "inputs").pos,
    );
    assert.ok(
      oneVariable(app, "unseenReply").end < ack.pos && ack.end < commit.pos,
    );
    const appHooks = reactHooks(app);
    const layouts = app.nodes
      .filter(isCallExpression)
      .filter(
        (node) =>
          isIdentifier(node.expression) &&
          appHooks.get(app.symbols.get(node.expression)) === "useLayoutEffect",
      );
    const scroll = layouts.filter((node) =>
      node.getText().includes("positions.current.set(contextKey"),
    );
    assert.equal(scroll.length, 1);
    assert.ok(
      commit.end < scroll[0]!.pos,
      "receipt commits precede the original scroll/title/trail/focus seams",
    );
  } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    throw new assert.AssertionError({
      message: "exchange-read-owner-seams: " + error.message,
    });
  }
}
function exchangeInputToolContract(
  app: Parsed,
  owner: Parsed,
  fixed: Parsed,
  adapter: Parsed,
  ownerText: string,
  contract: SubjectContract,
) {
  try {
    // This pins the reviewed NEW API/constructor lane, not an old algorithm
    // oracle. The independent fixed-b8 test and mounted ledgers prove the
    // moved algorithms. It deliberately includes the real nullable version
    // type discovered when the previously unconsumed candidate was connected.
    assert.equal(
      createHash("sha256").update(ownerText).digest("hex"),
      "d6aebe9b808e45041b9b4c946a1612e98d6787d013188d555b7cf16fd6748f34",
      "reviewed input owner API, inert constructors and complete algorithms",
    );
    const path = "./host/use-exchange-input-tools.js";
    const workspace = oneFunction(app, "WorkspaceApp");
    const oneImportedCall = (name: string) => {
      const symbol = imported(app, path, name);
      const uses = app.identifiers.filter(
        (node) => app.symbols.get(node) === symbol,
      );
      assert.equal(
        uses.length,
        2,
        `${name}: actual import and one direct call`,
      );
      const calls = app.nodes
        .filter(isCallExpression)
        .filter(
          (node) =>
            isIdentifier(node.expression) &&
            app.symbols.get(node.expression) === symbol,
        );
      assert.equal(calls.length, 1, `${name}: no wrapper or duplicate owner`);
      return calls[0]!;
    };
    const fixedHooks = reactHooks(fixed);
    const ownerHooks = reactHooks(owner);
    for (const [name, oldName, binding, primitives] of [
      [
        "useExchangeDictationState",
        "useFixedDictationState",
        "inputDictation",
        ["useRef", "useState"],
      ],
      [
        "useExchangeInputMediaState",
        "useFixedInputMediaState",
        "inputMedia",
        ["useState", "useState", "useState"],
      ],
      [
        "useExchangeNativeInputState",
        "useFixedNativeInputState",
        "nativeInput",
        ["useState", "useState"],
      ],
      [
        "useExchangeInputToolCommit",
        "useFixedInputToolCommit",
        null,
        ["useEffect"],
      ],
    ] as const) {
      const call = oneImportedCall(name);
      if (binding) {
        const declaration = oneVariable(app, binding);
        assert.equal(
          declaration.initializer,
          call,
          `${name}: directly borrowed state, no mirror`,
        );
        assert.equal(
          declaration.parent.parent.parent,
          workspace.body,
          `${name}: direct unconditional original Host registration`,
        );
        assert.equal(call.arguments.length, 0);
      } else {
        assert.ok(
          isExpressionStatement(call.parent) &&
            call.parent.parent === workspace.body,
          "input retirement is a direct unconditional Host expression",
        );
        const slot = workspace.body!.statements.indexOf(call.parent);
        assert.equal(
          workspace.body!.statements[slot - 1]?.getText().replace(/\s+/g, ""),
          "useExchangeControllerFocus(exchangeController);",
          "input retirement retains original focus/retirement seam",
        );
        assert.ok(
          workspace
            .body!.statements[slot + 1]?.getText()
            .startsWith("const collaborationVisible"),
          "input retirement precedes original collaboration derivation",
        );
        const expected = adapter.nodes
          .filter(isCallExpression)
          .find((node) => node.expression.getText() === name)!;
        assert.deepEqual(
          call.arguments.map(scalarSyntax),
          expected.arguments.map(scalarSyntax),
          "original retirement scope/visibility arguments",
        );
      }
      const registrations = (
        parsed: Parsed,
        functionName: string,
        hooks: Map<number | undefined, string>,
      ) => {
        const result: { node: CallExpression; name: string }[] = [];
        walk(oneFunction(parsed, functionName).body!, (node) => {
          if (isCallExpression(node) && isIdentifier(node.expression)) {
            const primitive = hooks.get(parsed.symbols.get(node.expression));
            if (primitive) result.push({ node, name: primitive });
          }
        });
        return result;
      };
      const actual = registrations(owner, name, ownerHooks);
      const original = registrations(fixed, oldName, fixedHooks);
      assert.deepEqual(
        actual.map(({ name }) => name),
        primitives,
      );
      assert.deepEqual(
        original.map(({ name }) => name),
        primitives,
      );
      assert.deepEqual(
        actual.map(({ node }) => node.arguments.map(scalarSyntax)),
        original.map(({ node }) => node.arguments.map(scalarSyntax)),
        `${name}: original initialization/effect arguments`,
      );
      // Fixed original type syntax is kept for the whole-tree oracle. The
      // actual owner uses explicit equivalent Scene aliases, not new state.
      contract.expanded.set(call, original);
    }
    for (const name of [
      "dictationControls",
      "uploadingDrafts",
      "directoryPickerScope",
    ]) {
      const actual = bindingVariable(app, name);
      const expected = bindingVariable(adapter, name);
      assert.deepEqual(scalarSyntax(actual.name), scalarSyntax(expected.name));
      assert.deepEqual(
        scalarSyntax(actual.initializer!),
        scalarSyntax(expected.initializer!),
        `original ${name} state/ref/setter aliases`,
      );
    }
    for (const [name, binding] of [
      ["createExchangeInputToolCloseCommand", "closeSpeech"],
      ["createExchangeInputToolCommands", "inputTools"],
    ] as const) {
      const call = oneImportedCall(name);
      const declaration = oneVariable(app, binding);
      assert.equal(declaration.initializer, call);
      assert.equal(
        declaration.parent.parent.parent,
        workspace.body,
        `${binding}: direct original Host constructor phase`,
      );
      const expected = oneVariable(adapter, binding).initializer!;
      assert.ok(isCallExpression(expected));
      assert.equal(call.typeArguments?.length ?? 0, 0);
      assert.deepEqual(
        call.arguments.map(scalarSyntax),
        expected.arguments.map(scalarSyntax),
        `${binding}: exact captured render, original writers/focus/navigation ports`,
      );
    }
    const startupReturn = workspace
      .body!.statements.filter(isIfStatement)
      .find(
        (node) =>
          node.expression.getText().replace(/\s+/g, "") === "!state||!project",
      )!;
    assert.ok(startupReturn, "original guarded startup branch exists");
    const close = oneVariable(app, "closeSpeech");
    const commands = oneVariable(app, "inputTools");
    assert.ok(
      close.end < startupReturn.pos &&
        startupReturn.end < oneVariable(app, "contextTitle").pos &&
        oneVariable(app, "contextTitle").end < commands.pos,
      "early close before startup return, full commands after original context title",
    );
    const keyboard = app.nodes
      .filter(isCallExpression)
      .find(
        (node) =>
          node.expression.getText() === "useEffect" &&
          node.getText().includes("function keyboard(e: KeyboardEvent)"),
      )!;
    assert.ok(
      close.end < keyboard.pos,
      "close stays available to original keyboard registration",
    );
    const tools = oneVariable(app, "inputTools");
    assert.ok(isIdentifier(tools.name));
    const toolsSymbol = app.symbols.get(tools.name);
    assert.ok(toolsSymbol !== undefined);
    const consumed = new Set<Node>();
    const tags = new Map<string, Node>();
    for (const tag of [
      "MessageAttachments",
      "AgentDirectories",
      "SpeechDialog",
      "CaptureDialog",
    ]) {
      const symbol = imported(app, `./${tag}.js`, tag);
      const actual = app.nodes.filter(
        (node) =>
          (isJsxOpeningElement(node) || isJsxSelfClosingElement(node)) &&
          isIdentifier(node.tagName) &&
          app.symbols.get(node.tagName) === symbol,
      );
      assert.equal(actual.length, 1, `real imported ${tag} consumer`);
      tags.set(tag, actual[0]!);
    }
    const microphone = app.nodes.filter(
      (node) =>
        isJsxOpeningElement(node) &&
        node.tagName.getText() === "button" &&
        node.attributes.properties.some(
          (attribute) =>
            isJsxAttribute(attribute) &&
            attribute.name.getText() === "aria-label" &&
            attribute.initializer?.getText() === '"语音输入"',
        ),
    );
    assert.equal(microphone.length, 1);
    tags.set("button", microphone[0]!);
    const attribute = (tag: Node, name: string) => {
      assert.ok(isJsxOpeningElement(tag) || isJsxSelfClosingElement(tag));
      const found = tag.attributes.properties
        .filter(isJsxAttribute)
        .filter((node) => node.name.getText() === name);
      assert.equal(
        found.length,
        1,
        `one ${name} attribute on ${tag.tagName.getText()}`,
      );
      return found[0]!;
    };
    const originalTag = (name: string) =>
      adapter.nodes.find(
        (node) =>
          (isJsxOpeningElement(node) || isJsxSelfClosingElement(node)) &&
          node.tagName.getText() === name,
      )!;
    for (const [tag, name, command] of [
      ["MessageAttachments", "onBusy", "attachmentsBusyChanged"],
      ["MessageAttachments", "onChange", "attachmentsChanged"],
      ["MessageAttachments", "onError", "attachmentError"],
      ["button", "onClick", "toggleDictation"],
      ["AgentDirectories", "onSelecting", "directorySelectingChanged"],
      ["AgentDirectories", "onError", "attachmentError"],
      ["SpeechDialog", "onTranscript", "transcriptChanged"],
      ["SpeechDialog", "onInsert", "transcriptInserted"],
      ["CaptureDialog", "onClose", "closeCapture"],
      ["CaptureDialog", "onAttach", "captureAttached"],
      ["CaptureDialog", "onSaved", "captureSaved"],
    ] as const) {
      const actual = attribute(tags.get(tag)!, name);
      assert.ok(actual.initializer && isJsxExpression(actual.initializer));
      const expression = actual.initializer.expression!;
      assert.equal(
        expression.getText().replace(/\s+/g, ""),
        name === "onTranscript"
          ? `speech.modal?undefined:inputTools.${command}`
          : `inputTools.${command}`,
        `${tag}.${name}: exact originating input command and optional-transcript condition`,
      );
      walk(expression, (node) => {
        if (isIdentifier(node) && node.text === "inputTools") {
          assert.equal(
            app.symbols.get(node),
            toolsSymbol,
            "actual factory result, not shadowed input commands",
          );
          consumed.add(node);
        }
      });
      contract.attributes.set(
        actual,
        syntax(attribute(originalTag(tag), name)),
      );
    }
    const capture = attribute(tags.get("MessageAttachments")!, "capture");
    const properties: Node[] = [];
    walk(capture, (node) => {
      if (isPropertyAssignment(node) && node.name.getText() === "onSelect")
        properties.push(node);
    });
    assert.equal(properties.length, 1);
    const selector = properties[0]!;
    assert.ok(
      isPropertyAssignment(selector) &&
        isPropertyAccessExpression(selector.initializer) &&
        isIdentifier(selector.initializer.expression),
    );
    assert.equal(selector.initializer.name.text, "openCapture");
    assert.equal(
      app.symbols.get(selector.initializer.expression),
      toolsSymbol,
      "capture borrows actual originating scene command",
    );
    consumed.add(selector.initializer.expression);
    const fixedSelectors: Node[] = [];
    walk(attribute(originalTag("MessageAttachments"), "capture"), (node) => {
      if (isPropertyAssignment(node) && node.name.getText() === "onSelect")
        fixedSelectors.push(node);
    });
    assert.equal(fixedSelectors.length, 1);
    contract.attributes.set(selector, syntax(fixedSelectors[0]!));
    assert.equal(consumed.size, 12);
    assert.equal(
      app.identifiers.filter((node) => app.symbols.get(node) === toolsSymbol)
        .length,
      consumed.size + 1,
      "one directly consumed command result, no alias/mirror/extra work",
    );
  } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    throw new assert.AssertionError({
      message: "exchange-input-tool-owner-seams: " + error.message,
    });
  }
}
function consumption(
  appText: string,
  hostText: string,
  ownerText: string,
  subjectOwnerText = subjectOwner,
  exchangeReadOwnerText = exchangeReadOwner,
  navigationHostText = stableNavigationHost,
  inputOwnerText = exchangeInputToolOwner,
) {
  const parsed = parse({
    App: appText,
    Host: hostText,
    Owner: ownerText,
    Adapter: adapterText,
    Subject: subjectOwnerText,
    FixedSubject: fixedSubject,
    SubjectAdapter: subjectAdapterText,
    ExchangeRead: exchangeReadOwnerText,
    FixedExchangeRead: fixedExchangeRead,
    ExchangeReadAdapter: exchangeReadAdapterText,
    NavigationHost: navigationHostText,
    NavigationAdapter: navigationAdapterText,
    FixedAppRoot: fixedAppRoot,
    NavigationHostContract: navigationHostContractText,
    InputTools: inputOwnerText,
    FixedInputTools: fixedInputTools,
    InputToolAdapter: inputToolAdapterText,
  });
  const app = parsed.get("App")!,
    host = parsed.get("Host")!,
    owner = parsed.get("Owner")!,
    adapter = parsed.get("Adapter")!;
  const factory = imported(
    app,
    "./host/use-workspace-navigation.js",
    "createWorkspaceNavigationCommands",
  );
  const factoryCalls = app.nodes
    .filter(isCallExpression)
    .filter(
      (node) =>
        isIdentifier(node.expression) &&
        app.symbols.get(node.expression) === factory,
    );
  assert.equal(factoryCalls.length, 1, "one real owner factory call");
  const call = factoryCalls[0]!;
  assert.ok(
    isVariableDeclaration(call.parent) &&
      call.parent.initializer === call &&
      isObjectBindingPattern(call.parent.name),
    "commands consumed directly, not returned from an async wrapper",
  );
  const command = call.parent.name.elements.filter(
    (node) =>
      isBindingElement(node) &&
      !node.propertyName &&
      !!node.name &&
      isIdentifier(node.name) &&
      node.name.text === "applicationActions",
  );
  assert.equal(command.length, 1, "actual applicationActions owner binding");
  const actions = app.symbols.get(command[0]!.name!);
  assert.ok(actions !== undefined);
  const hostImport = imported(app, "./ApplicationHost.js", "ApplicationHost");
  const hostRenders = app.nodes
    .filter(
      (node) => isJsxOpeningElement(node) || isJsxSelfClosingElement(node),
    )
    .filter(
      (node) =>
        isIdentifier(node.tagName) &&
        app.symbols.get(node.tagName) === hostImport,
    );
  assert.equal(hostRenders.length, 1, "one actual imported Host render");
  const attributes = hostRenders[0]!.attributes.properties;
  const actionProps = attributes
    .filter(isJsxAttribute)
    .filter((node) => node.name.getText() === "applicationActions");
  assert.equal(actionProps.length, 1, "one applicationActions Host port");
  const value = actionProps[0]!.initializer;
  assert.ok(
    value &&
      isJsxExpression(value) &&
      value.expression &&
      isIdentifier(value.expression) &&
      app.symbols.get(value.expression) === actions,
    "Host uses the real directly-destructured applicationActions, no wrapper",
  );
  assert.equal(
    attributes
      .filter(isJsxAttribute)
      .some((node) =>
        ["onActivate", "onOpenContents"].includes(node.name.getText()),
      ),
    false,
    "retired Host callback props cannot duplicate the owner",
  );

  const actionType = imported(
    host,
    "./host/use-workspace-navigation.js",
    "ApplicationNavigationActions",
    true,
  );
  const hostFunction = oneFunction(host, "ApplicationHost");
  const parameter = hostFunction.parameters[0]!;
  assert.ok(isObjectBindingPattern(parameter.name));
  const local = parameter.name.elements.filter(
    (node) =>
      !!node.name &&
      isIdentifier(node.name) &&
      node.name.text === "applicationActions",
  );
  assert.equal(local.length, 1, "Host original prop binding receives actions");
  const localBinding = host.symbols.get(local[0]!.name!);
  assert.ok(localBinding !== undefined);
  const typed: Node[] = [];
  parameter.type!.forEachChild((node) => {
    if (
      node.kind === SyntaxKind.PropertySignature &&
      node.getText().replace(/\s+/g, "") ===
        "applicationActions:ApplicationNavigationActions;"
    )
      typed.push(node);
  });
  assert.equal(typed.length, 1, "Host actions use the real typed owner port");
  const typeUses: Identifier[] = [];
  walk(typed[0]!, (node) => {
    if (isIdentifier(node) && host.symbols.get(node) === actionType)
      typeUses.push(node);
  });
  assert.equal(typeUses.length, 1, "not a locally-shadowed action type");
  const uses = host.identifiers.filter(
    (node) => host.symbols.get(node) === localBinding,
  );
  assert.equal(
    uses.length,
    4,
    "only receive/activate/launch/close action uses",
  );
  assert.deepEqual(
    uses
      .filter((node) => node !== local[0]!.name)
      .map((node) => {
        assert.ok(
          isPropertyAccessExpression(node.parent) &&
            node.parent.expression === node,
          "direct typed port, no Host-local second action store",
        );
        return node.parent.name.text;
      }),
    ["activate", "launch", "close"],
  );
  const activate = oneVariable(host, "onActivate").initializer;
  assert.ok(
    activate &&
      isPropertyAccessExpression(activate) &&
      isIdentifier(activate.expression) &&
      host.symbols.get(activate.expression) === localBinding &&
      activate.name.text === "activate",
    "original JSX callbacks use the direct owner activation reference",
  );
  assert.deepEqual(
    syntax(oneVariable(host, "navigationSnapshot").initializer!),
    syntax(oneVariable(adapter, "navigationSnapshot").initializer!),
    "captured original workspace/generation/active/ordered instances",
  );
  for (const name of ["launch", "close"])
    assert.deepEqual(
      syntax(oneFunction(host, name).body!),
      syntax(oneFunction(adapter, name).body!),
      `${name}: raw promise inside original caller-local try/catch/finally`,
    );

  const prepared = oneVariable(owner, "applicationActions");
  assert.equal(prepared.type?.getText(), "ApplicationNavigationActions");
  assert.deepEqual(
    scalarSyntax(prepared.initializer!),
    scalarSyntax(
      oneVariable(parsed.get("NavigationAdapter")!, "applicationActions")
        .initializer!,
    ),
    "prepared union adds explicit retired/scope guards without altering raw promises or captured activation policy",
  );
  originalPreparedPolicy(
    prepared.initializer!,
    oneVariable(adapter, "applicationActions").initializer!,
  );
  const actionTypes = owner.nodes
    .filter(isTypeAliasDeclaration)
    .filter((node) => node.name.text === "ApplicationNavigationActions");
  assert.equal(actionTypes.length, 1, "one typed prepared action owner");
  const preparedTypeNames: Identifier[] = [];
  walk(prepared.type!, (node) => {
    if (isIdentifier(node)) preparedTypeNames.push(node);
  });
  assert.equal(preparedTypeNames.length, 1);
  assert.equal(
    owner.symbols.get(preparedTypeNames[0]!),
    owner.symbols.get(actionTypes[0]!.name),
    "prepared value uses its actual declared action type",
  );
  const returned = oneFunction(
    owner,
    "createWorkspaceNavigationCommands",
  ).body!.statements.at(-1)!;
  assert.ok(
    isReturnStatement(returned) &&
      returned.expression &&
      isObjectLiteralExpression(returned.expression),
  );
  const returnedActions = returned.expression.properties.filter(
    (node) =>
      (isShorthandPropertyAssignment(node) || isPropertyAssignment(node)) &&
      node.name.getText() === "applicationActions",
  );
  assert.equal(returnedActions.length, 1);
  assert.ok(isShorthandPropertyAssignment(returnedActions[0]!));

  const projectedApp = checkedNavigationProjection(
    app,
    parsed.get("NavigationHost")!,
    parsed.get("NavigationAdapter")!,
    parsed.get("FixedAppRoot")!,
    parsed.get("NavigationHostContract")!,
  );
  const appContract = subjectContract(
    projectedApp,
    parsed.get("Subject")!,
    parsed.get("FixedSubject")!,
    parsed.get("SubjectAdapter")!,
  );
  exchangeReadContract(
    projectedApp,
    parsed.get("ExchangeRead")!,
    parsed.get("FixedExchangeRead")!,
    parsed.get("ExchangeReadAdapter")!,
    appContract,
  );
  exchangeInputToolContract(
    projectedApp,
    parsed.get("InputTools")!,
    parsed.get("FixedInputTools")!,
    parsed.get("InputToolAdapter")!,
    inputOwnerText,
    appContract,
  );
  assert.deepEqual(
    structure(projectedApp, true, appContract),
    baseline.App,
    "original App JSX/effects/all React lifecycle registrations",
  );
  assert.deepEqual(
    structure(host, false),
    baseline.Host,
    "original Host JSX/effects/all React lifecycle registrations",
  );
}
const app = readFileSync("apps/web/src/App.tsx", "utf8");
const host = readFileSync("apps/web/src/ApplicationHost.tsx", "utf8");
const owner = readFileSync(
  "apps/web/src/host/use-workspace-navigation.ts",
  "utf8",
);
const subjectOwner = readFileSync(
  "apps/web/src/host/use-subject-inspector.ts",
  "utf8",
);
const fixedSubject = readFileSync(
  "tests/fixtures/subject-inspector-85a50934.ts",
  "utf8",
);
const exchangeReadOwner = readFileSync(
  "apps/web/src/host/use-exchange-read-receipts.ts",
  "utf8",
);
const fixedExchangeRead = readFileSync(
  "tests/fixtures/exchange-read-receipts-4ce98b64.ts",
  "utf8",
);
const stableNavigationHost = readFileSync(
  "apps/web/src/host/use-workspace-navigation-host.ts",
  "utf8",
);
const exchangeInputToolOwner = readFileSync(
  "apps/web/src/host/use-exchange-input-tools.ts",
  "utf8",
);
const fixedInputTools = readFileSync(
  "tests/fixtures/exchange-input-tools-b8db8158.ts",
  "utf8",
);
function changed(source: string, from: string, to: string) {
  assert.ok(source.includes(from), `negative fixture target absent: ${from}`);
  return source.replace(from, to);
}

test("actual App/Host consume the typed prepared navigation owner and retain fixed cb7246a2 JSX/lifecycle", () => {
  consumption(app, host, owner);
});
test("input tools reject parsed fake imports, mirrors, altered scopes/focus and optional transcript drift before fixed-tree expansion", () => {
  const cases = [
    {
      source: changed(
        app,
        "useExchangeInputToolCommit(inputMedia, { contextKey, inputVisible });",
        "if (inputVisible) useExchangeInputToolCommit(inputMedia, { contextKey, inputVisible });",
      ),
      rule: "input retirement is a direct unconditional Host expression",
    },
    {
      source: changed(
        app,
        "useExchangeInputToolCommit(inputMedia, { contextKey, inputVisible });",
        "function hiddenRetirement(){useExchangeInputToolCommit(inputMedia, { contextKey, inputVisible });}\nhiddenRetirement();",
      ),
      rule: "input retirement is a direct unconditional Host expression",
    },
    {
      source:
        changed(
          app,
          "  useExchangeDictationState,",
          "  useExchangeDictationState as ActualInputDictation,",
        ) + "\nfunction useExchangeDictationState(){return {};}",
      rule: "useExchangeDictationState: actual import and one direct call",
    },
    {
      source: changed(
        app,
        "useExchangeInputToolCommit(inputMedia, { contextKey, inputVisible });",
        "useExchangeInputToolCommit(inputMedia, { contextKey, inputVisible });\nuseExchangeInputToolCommit(inputMedia, { contextKey, inputVisible });",
      ),
      rule: "useExchangeInputToolCommit: actual import and one direct call",
    },
    {
      source: changed(
        app,
        "      contextKey,\n      directoryScope,\n      contextTitle,",
        "      contextKey: currentContext.current,\n      directoryScope,\n      contextTitle,",
      ),
      rule: "inputTools: exact captured render, original writers/focus/navigation ports",
    },
    {
      source: changed(
        app,
        "drafts: { replace: setDraft, update: updateDraft }",
        "drafts: { replace: setDraft, update: () => {} }",
      ),
      rule: "inputTools: exact captured render, original writers/focus/navigation ports",
    },
    {
      source: changed(
        app,
        "?.querySelector<HTMLButtonElement>('button[aria-label=\"语音输入\"]')\n        ?.focus()",
        "?.querySelector<HTMLButtonElement>('button[aria-label=\"语音输入\"]')\n        ?.focus({ preventScroll: true })",
      ),
      rule: "closeSpeech: exact captured render, original writers/focus/navigation ports",
    },
    {
      source: changed(
        app,
        "openSavedCapture: (projectId, id) => void openObject(projectId, id)",
        "openSavedCapture: (projectId, id) => void openObject(project.id, id)",
      ),
      rule: "inputTools: exact captured render, original writers/focus/navigation ports",
    },
    {
      source: changed(
        app,
        "inputTools.directorySelectingChanged",
        "inputTools.attachmentsBusyChanged",
      ),
      rule: "AgentDirectories.onSelecting: exact originating input command",
    },
    {
      source: changed(
        app,
        "speech.modal ? undefined : inputTools.transcriptChanged",
        "inputTools.transcriptChanged",
      ),
      rule: "SpeechDialog.onTranscript: exact originating input command",
    },
    {
      source: changed(
        app,
        "onSelect: inputTools.openCapture",
        "onSelect: (hideWindow) => inputTools.openCapture(hideWindow)",
      ),
      rule: "exchange-input-tool-owner-seams:",
    },
  ];
  for (const entry of cases) {
    parse({ Candidate: entry.source });
    assert.throws(
      () => consumption(entry.source, host, owner),
      (error) =>
        error instanceof assert.AssertionError &&
        error.message.startsWith("exchange-input-tool-owner-seams:") &&
        error.message.includes(entry.rule),
    );
  }
  const close = oneVariable(parse({ App: app }).get("App")!, "closeSpeech");
  const statement = close.parent.parent.getText();
  const moved = changed(
    changed(app, statement, ""),
    "  const inputTools =",
    statement + "\n  const inputTools =",
  );
  parse({ Candidate: moved });
  assert.throws(
    () => consumption(moved, host, owner),
    (error) =>
      error instanceof assert.AssertionError &&
      error.message.includes(
        "exchange-input-tool-owner-seams: early close before startup return",
      ),
  );
  const extraWork =
    exchangeInputToolOwner + '\nfetch("/unreviewed-input-request");';
  parse({ CandidateOwner: extraWork });
  assert.throws(
    () =>
      consumption(
        app,
        host,
        owner,
        subjectOwner,
        exchangeReadOwner,
        stableNavigationHost,
        extraWork,
      ),
    (error) =>
      error instanceof assert.AssertionError &&
      error.message.includes(
        "exchange-input-tool-owner-seams: reviewed input owner API",
      ),
  );
});
test("input owner imports may be renamed without changing actual direct consumption", () => {
  const alias = changed(
    changed(
      app,
      "  createExchangeInputToolCommands,",
      "  createExchangeInputToolCommands as createOriginalInputTools,",
    ),
    "const inputTools = createExchangeInputToolCommands(",
    "const inputTools = createOriginalInputTools(",
  );
  consumption(alias, host, owner);
});
test("six previously accepted Host/Origin counterfactuals reject before old-tree normalization for the exact source rule", () => {
  const cases = [
    {
      name: "Host currentness",
      stable: changed(
        stableNavigationHost,
        "return lifetime.current.active && !!currentProjection();",
        "return true;",
      ),
      rule: "Host currentness cannot bypass identity/lifetime",
    },
    {
      name: "returned navigation",
      stable: changed(
        stableNavigationHost,
        "isCurrentHost() && state.isCurrent(generation)",
        "state.isCurrent(generation)",
      ),
      rule: "Host returned navigation preserves currentness/single state",
    },
    {
      name: "Host lifetime fake binding",
      app:
        changed(
          app,
          "  NavigationHostLifetime,",
          "  NavigationHostLifetime as RealNavigationHostLifetime,",
        ) + "\nfunction NavigationHostLifetime() { return null; }",
      rule: "actual imported lifetime consumer: NavigationHostLifetime",
    },
    {
      name: "Origin lifetime fake binding",
      app:
        changed(
          app,
          "  NavigationOriginLifetime,",
          "  NavigationOriginLifetime as RealNavigationOriginLifetime,",
        ) + "\nfunction NavigationOriginLifetime() { return null; }",
      rule: "actual imported lifetime consumer: NavigationOriginLifetime",
    },
    {
      name: "eager snapshot construction",
      stable: changed(
        stableNavigationHost,
        "  const state = useWorkspaceNavigationState();",
        "  getSnapshot();\n  const state = useWorkspaceNavigationState();",
      ),
      rule: "Host construction only reviewed registrations/declarations",
    },
    {
      name: "persisted schema",
      stable: changed(
        stableNavigationHost,
        "  subjectOpen: boolean;",
        "  subjectOpen: string;",
      ),
      rule: "original persisted Preferences schema/defaults",
    },
  ];
  for (const entry of cases) {
    const candidateApp = entry.app ?? app,
      candidateHost = entry.stable ?? stableNavigationHost;
    parse({ CandidateApp: candidateApp, CandidateHost: candidateHost });
    assert.throws(
      () =>
        consumption(
          candidateApp,
          host,
          owner,
          subjectOwner,
          exchangeReadOwner,
          candidateHost,
        ),
      (error) =>
        error instanceof assert.AssertionError &&
        error.message.startsWith("navigation-host-owner-seams:") &&
        error.message.includes(entry.rule),
      `${entry.name}: ${entry.rule}`,
    );
  }
});
test("new navigation lifetime/identity seams reject valid drift before expanding the fixed old tree", () => {
  const appCandidates = [
    changed(
      app,
      "csrfToken: client.boot.csrfToken,",
      'csrfToken: "another-session",',
    ),
    changed(
      app,
      "key={JSON.stringify(nextIdentity)}",
      "key={nextIdentity.centerId}",
    ),
    changed(app, "{client.boot ? (", "{true ? ("),
    changed(
      app,
      "      <NavigationOriginLifetime origin={origin} />\n      <WorkspaceApp client={client} host={host} origin={origin} />",
      "      <WorkspaceApp client={client} host={host} origin={origin} />\n      <NavigationOriginLifetime origin={origin} />",
    ),
    changed(
      app,
      "<NavigationHostLifetime host={host} />",
      "<NavigationHostLifetime host={host} /><NavigationHostLifetime host={host} />",
    ),
    changed(app, '"正在打开工作空间…"', '"unapproved connecting placeholder"'),
    changed(
      app,
      '  return (\n    <main className="connection-screen">',
      '  useEffect(() => {}, []);\n  return (\n    <main className="connection-screen">',
    ),
    changed(
      app,
      "const { readLocal, writeLocal } = host.storage;",
      "const { readLocal, writeLocal } = scopedStorage();",
    ),
    changed(
      app,
      'creating === "project" ? prepareCreatedProject : undefined',
      "undefined",
    ),
    changed(
      app,
      '"./host/use-workspace-navigation-host.js"',
      '"./host/fake-navigation-host.js"',
    ),
  ];
  const stableCandidates = [
    changed(
      stableNavigationHost,
      "scopedStorage(`${scope.centerId}:${scope.principalId}`)",
      "scopedStorage()",
    ),
    changed(stableNavigationHost, "return host.retire;", "return () => {};"),
    changed(stableNavigationHost, "return origin.retire;", "return () => {};"),
    changed(
      stableNavigationHost,
      "useRef({ active: false, incarnation: 0 })",
      "useRef({ active: false, incarnation: 0, boot: getSnapshot() })",
    ),
    changed(
      stableNavigationHost,
      "useState<NavigationIdentity>(() => ({ ...identity }))",
      "useState<NavigationIdentity>(() => ({ ...identity, boot: getSnapshot() }))",
    ),
    changed(
      stableNavigationHost,
      "const state = useWorkspaceNavigationState();",
      "const state = useWorkspaceNavigationState();\nuseLayoutEffect(() => {}, []);",
    ),
  ];
  for (const [index, candidate] of appCandidates.entries()) {
    // A syntactically invalid candidate or absent mutation target is not proof.
    parse({ Candidate: candidate });
    assert.throws(
      () => consumption(candidate, host, owner),
      (error) =>
        error instanceof assert.AssertionError &&
        error.message.startsWith("navigation-host-owner-seams:"),
      `App lifetime seam candidate ${index}`,
    );
  }
  for (const [index, candidate] of stableCandidates.entries()) {
    parse({ Candidate: candidate });
    assert.throws(
      () =>
        consumption(
          app,
          host,
          owner,
          subjectOwner,
          exchangeReadOwner,
          candidate,
        ),
      (error) =>
        error instanceof assert.AssertionError &&
        error.message.startsWith("navigation-host-owner-seams:"),
      `Host lifetime seam candidate ${index}`,
    );
  }
  const originalPreferenceDrift = changed(
    stableNavigationHost,
    "subjectOpen: p.subjectOpen === true,",
    "subjectOpen: true,",
  );
  parse({ Candidate: originalPreferenceDrift });
  assert.throws(
    () =>
      consumption(
        app,
        host,
        owner,
        subjectOwner,
        exchangeReadOwner,
        originalPreferenceDrift,
      ),
    (error) =>
      error instanceof assert.AssertionError &&
      error.message.startsWith(
        "original App JSX/effects/all React lifecycle registrations",
      ),
    "moved original initializer still fails the unchanged old hook hash, not the new lifetime check",
  );
});
test("App consumption rejects fake/shadowed ports and unapproved DOM or lifecycle changes", () => {
  const candidates = [
    changed(
      app,
      "applicationActions={applicationActions}",
      "applicationActions={otherActions}",
    ),
    changed(
      app,
      "applicationActions={applicationActions}",
      "applicationActions={{ ...applicationActions }}",
    ),
    changed(
      app,
      "applicationActions={applicationActions}",
      "onActivate={activateApplication} applicationActions={applicationActions}",
    ),
    changed(
      app,
      "applicationActions={applicationActions}",
      "applicationActions={applicationActions} key={navigationGeneration.current}",
    ),
    changed(
      app,
      "  const {\n    travel,",
      "  const createWorkspaceNavigationCommands = () => ({});\n  const {\n    travel,",
    ),
    changed(
      app,
      '<div className="object-surface" hidden={creating === "document"}>',
      '<div className="object-surface" hidden={false}>',
    ),
    changed(
      app,
      "const positions = useRef(new Map<string, number>());",
      "useEffect(() => {}, []);\n  const positions = useRef(new Map<string, number>());",
    ),
    changed(
      app,
      "const positions = useRef(new Map<string, number>());",
      "const mirror = useState(null);\n  const positions = useRef(new Map<string, number>());",
    ),
  ];
  for (const candidate of candidates) {
    parse({ Candidate: candidate });
    assert.throws(
      () => consumption(candidate, host, owner),
      assert.AssertionError,
    );
  }
});
test("Host rejects an async bridge, changed capture or relocated local busy/error/finally contract", () => {
  for (const candidate of [
    changed(
      host,
      "const action = applicationActions.launch(",
      "const action = await applicationActions.launch(",
    ),
    changed(
      host,
      "action.commit(await action.pending);",
      "await action.pending;\n      await Promise.resolve();\n      action.commit(undefined);",
    ),
    changed(
      host,
      "await action.pending;\n      action.commit();",
      "action.commit();\n      await action.pending;",
    ),
    changed(
      host,
      "const navigationSnapshot = { workspaceId, navigationId, activeId, instances };",
      "const navigationSnapshot = { workspaceId, navigationId: 0, activeId, instances };",
    ),
    changed(
      host,
      "const navigationSnapshot = { workspaceId, navigationId, activeId, instances };",
      "const navigationSnapshot = { workspaceId, navigationId, activeId, instances: [...instances] };",
    ),
    changed(
      host,
      "const onActivate = applicationActions.activate;",
      "const onActivate = (...args) => applicationActions.activate(...args);",
    ),
    changed(host, "if (launching.current) return;", "if (busy) return;"),
    changed(
      host,
      "launching.current = false;\n      setBusy(false);",
      "setBusy(false);\n      launching.current = false;",
    ),
    changed(
      host,
      "onNotice((error as Error).message);",
      "if (activeId) onNotice((error as Error).message);",
    ),
    changed(
      host,
      "applicationActions: ApplicationNavigationActions;",
      "applicationActions: any;",
    ),
    changed(
      host,
      "import type { ApplicationNavigationActions }",
      "import type { OtherActions as ApplicationNavigationActions }",
    ),
  ]) {
    parse({ Candidate: candidate });
    assert.throws(
      () => consumption(app, candidate, owner),
      assert.AssertionError,
    );
  }
});
test("Host fixed-tree/lifecycle gate rejects pane remount, altered portal and new state/effects", () => {
  for (const candidate of [
    changed(host, "key={instance.id}", "key={navigationId}"),
    changed(host, "hidden={active?.id !== instance.id}", "hidden={false}"),
    changed(
      host,
      "createPortal(toolbar, toolbarTarget)",
      "createPortal(<section>{toolbar}</section>, toolbarTarget)",
    ),
    changed(
      host,
      "const launching = useRef(false);",
      "useEffect(() => {}, []);\n  const launching = useRef(false);",
    ),
    changed(
      host,
      "const launching = useRef(false);",
      "const [mirrored, setMirrored] = useState(null);\n  const launching = useRef(false);",
    ),
    changed(
      host,
      "[activeId, instanceIds, enabled, toolbarTarget]",
      "[activeId, instances, enabled, toolbarTarget]",
    ),
    changed(
      host,
      "<small>{applicationDescription(app)}</small>",
      "<small>changed late sibling</small>",
    ),
    changed(
      host,
      'attributeFilter: ["data-appearance", "data-accent"]',
      'attributeFilter: ["data-appearance", "data-unreviewed"]',
    ),
  ]) {
    parse({ Candidate: candidate });
    assert.throws(
      () => consumption(app, candidate, owner),
      assert.AssertionError,
    );
  }
});
test("prepared owner rejects async/raw-promise wrappers and changed captured activation/neighbor order", () => {
  for (const candidate of [
    changed(
      owner,
      "launch(app, captured, contents = false) {",
      "async launch(app, captured, contents = false) {",
    ),
    changed(
      owner,
      "pending: openWorkspaceContents()",
      "pending: Promise.resolve().then(() => openWorkspaceContents())",
    ),
    changed(
      owner,
      "}),\n        commit(receipt)",
      "}).then((receipt) => receipt),\n        commit(receipt)",
    ),
    changed(
      owner,
      "activateApplication(receipt.entityId, captured.navigationId, app);",
      "activateApplication(receipt.entityId);",
    ),
    changed(
      owner,
      "captured.instances[index + 1] ??",
      "captured.instances[index - 1] ??",
    ),
  ]) {
    parse({ Candidate: candidate });
    assert.throws(
      () => consumption(app, host, candidate),
      assert.AssertionError,
    );
  }
});
test("finite gate permits comments and unrelated non-UI/non-lifecycle helpers", () => {
  consumption(
    app +
      "\n// No governed JSX or lifecycle changed.\nfunction unrelatedPureHelper(value: number) { return value + 1; }\n",
    host + "\n// An unrelated comment is not a mount or state change.\n",
    owner,
  );
});

test("Stage13 expansion rejects fake/shadowed imports, repeated or relocated hooks and unapproved inspector ports", () => {
  const commit = app.match(
    /  useSubjectInspectorCommit\(inspectorSelections, \{[\s\S]*?\n  \}\);/,
  )?.[0];
  assert.ok(commit, "the real commit seam exists");
  for (const candidate of [
    changed(app, subjectPath, "./host/fake-subject-inspector.js"),
    changed(
      app,
      "const subjectActivity = useSubjectActivityState();",
      "const useSubjectActivityState = () => ({allActivity:false});\nconst subjectActivity = useSubjectActivityState();",
    ),
    changed(
      app,
      "const subjectActivity = useSubjectActivityState();",
      "const subjectActivity = useSubjectActivityState();\nconst duplicate = useSubjectActivityState();",
    ),
    changed(
      app,
      "const subjectActivity = useSubjectActivityState();",
      "const subjectActivity = (() => useSubjectActivityState())();",
    ),
    changed(
      app,
      commit,
      commit.replace("    contextKey,", '    contextKey: "another-surface",'),
    ),
    changed(
      changed(app, commit, ""),
      "  useExchangeControllerFocus(exchangeController);",
      `${commit}\n  useExchangeControllerFocus(exchangeController);`,
    ),
    changed(app, "onBack={subjectInspector.back}", "onBack={unrelated.back}"),
    changed(
      app,
      "onSelect={subjectInspector.selectExecution}",
      "onSelect={subjectInspector.selectScope}",
    ),
    changed(
      app,
      "onAllWorkChange={subjectInspector.setAllActivity}",
      "onAllWorkChange={(value) => subjectInspector.setAllActivity(value)}",
    ),
  ]) {
    parse({ Candidate: candidate });
    assert.throws(
      () => consumption(candidate, host, owner),
      assert.AssertionError,
    );
  }
});

test("Stage13 expands actual owner initializers/effect trees and rejects drift or an extra lifecycle", () => {
  for (const candidate of [
    changed(subjectOwner, "useState(false)", "useState(true)"),
    changed(
      subjectOwner,
      "new Map<string, InspectorSelection>()",
      "new Map<string, InspectorSelection>([[contextKey, selection]])",
    ),
    changed(
      subjectOwner,
      "[contextKey, executions, understandingOpen, collaborationVisible]",
      "[executions, contextKey, understandingOpen, collaborationVisible]",
    ),
    changed(
      subjectOwner,
      "if (executions)",
      'if (subjectView === "activity" && executions)',
    ),
    changed(
      subjectOwner,
      "const [allActivity, setAllActivity] = useState(false);",
      "useLayoutEffect(() => {}, []);\nconst [allActivity, setAllActivity] = useState(false);",
    ),
    subjectOwner + "\nexport function extraLifecycle() { useState(0); }\n",
  ]) {
    parse({ Candidate: candidate });
    assert.throws(
      () => consumption(app, host, owner, candidate),
      assert.AssertionError,
    );
  }
});

test("exchange read expansion rejects valid fake/mirror/miswired ports and displaced original registrations", () => {
  const state = app.match(
    /  const readReceiptState = useExchangeReadReceiptState\(\{[\s\S]*?\n  \}\);/,
  )?.[0];
  const commit = app.match(
    /  useExchangeReadReceiptCommit\(readReceiptState, \{[\s\S]*?\n  \}\);/,
  )?.[0];
  assert.ok(state && commit, "actual exchange read seams exist");
  const candidates = [
    changed(app, exchangeReadPath, "./host/fake-read-receipts.js"),
    changed(
      app,
      state,
      "const useExchangeReadReceiptState = () => ({});\n" + state,
    ),
    changed(app, commit, commit + "\n" + commit),
    changed(
      changed(app, state, ""),
      "  const positions = useRef",
      state + "\n  const positions = useRef",
    ),
    changed(
      changed(app, commit, ""),
      "  const readReplies =",
      commit + "\n  const readReplies =",
    ),
    changed(
      app,
      "const { seenReplies } = readReceiptState;",
      "const { seenReplies } = { ...readReceiptState };",
    ),
    changed(
      app,
      "useExchangeReadAcknowledgement(readReceiptState)",
      "useExchangeReadAcknowledgement({ ...readReceiptState })",
    ),
    changed(
      app,
      'readLocal<unknown>("conversation-read-receipts", null)',
      'readLocal<unknown>("other-read-receipts", null)',
    ),
    changed(
      app,
      "messages: client.boot!.runtime.messages,",
      "messages: replies,",
    ),
    changed(
      app,
      'writeLocal("conversation-read-receipts", seen)',
      'writeLocal("conversation-read-receipts", receipts)',
    ),
    changed(
      app,
      "onNotice: setNotice,\n  });\n  useLayoutEffect",
      "onNotice: () => {},\n  });\n  useLayoutEffect",
    ),
  ];
  for (const candidate of candidates) {
    // A syntax/loader/program exception must not masquerade as rule rejection.
    parse({ Fixture: candidate });
    assert.throws(
      () => consumption(candidate, host, owner),
      (error) =>
        error instanceof assert.AssertionError &&
        error.message.startsWith("exchange-read-owner-seams:"),
    );
  }
});

test("exchange read expansion validates actual owner helpers, lazy fallback and both original commit trees", () => {
  const candidates = [
    changed(exchangeReadOwner, 'from "react"', 'from "./fake-react.js"'),
    changed(
      exchangeReadOwner,
      'from "../conversation-read.js"',
      'from "../fake-conversation-read.js"',
    ),
    changed(exchangeReadOwner, "restored !== null", "restored === null"),
    changed(
      exchangeReadOwner,
      "if (restored !== null) return restored;",
      "if (restored !== null) return {};",
    ),
    changed(exchangeReadOwner, "[version]", "[receipts]"),
    changed(exchangeReadOwner, "[seenReplies]", "[version]"),
    changed(exchangeReadOwner, "persist(seenReplies)", "persist({})"),
    changed(
      exchangeReadOwner,
      "reconcileReplyReceipts(old, receipts)",
      "acknowledgeReplies(old, receipts)",
    ),
    exchangeReadOwner + "\nconst mirroredReadState = new Map();\n",
    exchangeReadOwner +
      "\nexport function extraReadEffect() { useEffect(() => {}, []); }\n",
  ];
  for (const candidate of candidates) {
    parse({ Fixture: candidate });
    assert.throws(
      () => consumption(app, host, owner, subjectOwner, candidate),
      (error) =>
        error instanceof assert.AssertionError &&
        error.message.startsWith("exchange-read-owner-seams:"),
    );
  }
});
