import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inverseHumanCreationFeature } from "./human-creation-consumption.js";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  NodeFlags,
  isBinaryExpression,
  isCallExpression,
  isExpressionStatement,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isVariableStatement,
  type FunctionDeclaration,
  type Identifier,
  type Node,
  type Statement,
} from "typescript/unstable/ast";

// Actual Git c35b9fde581e06a9ef1800103438b9b25cc3cdd6, independently captured before the candidate.
// CI needs no Git; source inverse/behavior evidence is not original App/native acceptance.
export const privateProjectScopeFixed = {
  commit: "c35b9fde581e06a9ef1800103438b9b25cc3cdd6",
  appSHA256: "22188005fd1074e58486c9976c1e1d2f0230c0cca53e6903a32c89b79a6ff941",
  appBytes: 125134,
  actionHashes: {
    selectContentScope:
      "6056651b2a27cb4489d61630f791e1c82da43e4604da17b2fb29978fee55154f",
    selectConversation:
      "ab04e8d7b137702ea0b687a1878ad3239b12ae97c96a1308a0e774671a9b9b91",
    createProjectConversation:
      "bcaafcd0f6c6bfd4c84bd662a23628948c65771593d6282ffbe5f32a952b8c6a",
    discardConversationDraft:
      "7308b6d2527bd11a4df330f286fedbe3738000064bb78a1071a6d118a2964662",
    restoreConversationDraft:
      "e1c01e2e22fae1f9a887784f4cff3c391ee4cb332eceda3802fa0225679f3a23",
    openProject:
      "2573417b162f26113ee413f40deec6406959b8334a99784cef09a780362608e4",
    prepareCreatedProject:
      "5896067cac96b2d75e68df84c592826834152323d30af08a25159d1b3b0b9ad6",
  },
  functions: {
    selectContentScope:
      "function selectContentScope(scope: string) {\n    if (!origin.isActive()) return;\n    setContentScope(scope);\n    // Treat a destination change as navigation: stale open/picker callbacks\n    // must not restore the previous scope or focus. Drafts and grants remain\n    // keyed by their original workspace, not copied into the new destination.\n    prefer({ artifactId: null, scriptLocation: null });\n  }",
    selectConversation:
      'function selectConversation(workspaceId: string, id: string, focus = false) {\n    if (!origin.isActive()) return;\n    setWebsiteIntent(null);\n    const sameProject =\n      prefs.view === "projects" &&\n      prefs.projectOpen &&\n      navigationProject?.id === workspaceId &&\n      // Search can open another space\'s object without changing the navigation\n      // entry. Preserve an object only when it actually belongs to this project.\n      project?.id === workspaceId;\n    const selectedExchange =\n      id === (sharedDefault ? defaultConversation : workspaceId)\n        ? workspaceId\n        : id;\n    setCreating(null);\n    setExecutions(null);\n    prefer({\n      view: "projects",\n      projectId: workspaceId,\n      projectOpen: true,\n      ...(!sameProject ? { artifactId: null } : {}),\n      selectedConversations: {\n        [workspaceId]: id,\n      },\n      interactions: {\n        [selectedExchange]:\n          prefs.interactions?.[selectedExchange] === "history"\n            ? "history"\n            : "recent",\n      },\n    });\n    if (focus) {\n      keepExchangeOpen();\n      requestConversationFocus(id, navigationGeneration.current);\n    }\n  }',
    createProjectConversation:
      "async function createProjectConversation(workspaceId: string, title: string) {\n    // Starting to type is local navigation, not a server-side conversation.\n    // Repeated clicks reuse the unfinished draft; the first input commits both.\n    const pending = draftCommands.createConversation(workspaceId, title);\n    selectConversation(workspaceId, pending.id, true);\n  }",
    discardConversationDraft:
      'function discardConversationDraft(id: string) {\n    if (sendPending.current) {\n      setNotice("消息正在提交，请等待结果后整理草稿。");\n      return;\n    }\n    draftCommands.discardConversation(\n      id,\n      () => state?.conversations.find((c) => c.id === id),\n      (conversation) => {\n        if (conversationId === id) openProject(conversation.projectId);\n      },\n    );\n  }',
    restoreConversationDraft:
      "function restoreConversationDraft(id: string) {\n    draftCommands.restoreConversation(\n      id,\n      hasConversationDraft,\n      (conversation) => {\n        selectConversation(conversation.projectId, id, true);\n      },\n    );\n  }",
    openProject:
      'function openProject(id: string) {\n    // An explicit project click means its default conversation, not whichever\n    // named Session happened to be used last. Reuse the same switching path so\n    // drafts, the current application/object and in-flight work stay intact.\n    selectConversation(\n      id,\n      sharedDefault ? (personalSpace("dialogue")?.id ?? id) : id,\n    );\n  }',
    prepareCreatedProject:
      'function prepareCreatedProject() {\n    const intent = { generation: navigationGeneration.current };\n    const lifetime = host.captureCommit();\n    const active = origin.isActive();\n    return (id: string, kind: string) => {\n      if (!active || kind !== "project") return;\n      const destination: CurrentDestination = (current) =>\n        lifetime(current) &&\n        navigation.isCurrent(intent.generation) &&\n        current.workspace.projects.some(\n          (value) =>\n            value.id === id &&\n            spaceKind(value) === "project" &&\n            !value.deletedAt,\n        );\n      const current = host.currentProjection();\n      if (!current || !destination(current)) return;\n      const conversation = current.capabilities.teamAuthentication\n        ? id\n        : (current.workspace.projects.find(\n            (value) =>\n              value.kind === "dialogue" &&\n              value.ownerPrincipalId === current.principalId,\n          )?.id ?? id);\n      // This is the original default-conversation route only. No old child\n      // draft, focus, notice or creation setter is transferred to the new tree.\n      continueNavigation(\n        {\n          view: "projects",\n          projectId: id,\n          projectOpen: true,\n          artifactId: null,\n          selectedConversations: { [id]: conversation },\n          interactions: {\n            [id]: prefs.interactions?.[id] === "history" ? "history" : "recent",\n          },\n        },\n        intent,\n        destination,\n      );\n    };\n  }',
  },
  statements: {
    contentScope:
      'const [contentScope, setContentScope] = useState(\n    () =>\n      readLocal<{ scope?: string }>("library-view:all-content", {}).scope ??\n      "all",\n  );',
    startedConversations:
      "const startedConversations = new Set([\n    ...(state?.conversations\n      .filter((c) => c.id !== c.projectId)\n      .map((c) => c.id) ?? []),\n    ...(state?.inputs\n      .filter((input) => !client.boot?.localSavedInputIds.includes(input.id))\n      .map(discussionId) ?? []),\n    ...(client.boot?.runtime.messages.map(discussionId) ?? []),\n  ]);",
    hasConversationDraft:
      'const hasConversationDraft = (id: string) =>\n    state?.inputs.some(\n      (input) =>\n        discussionId(input) === id &&\n        client.boot?.localSavedInputIds.includes(input.id),\n    ) ||\n    Object.entries(drafts).some(\n      ([key, value]) =>\n        key.startsWith(id + ":") &&\n        !!(\n          value.body.trim() ||\n          value.attachments?.length ||\n          value.textQuotes?.length ||\n          value.selection ||\n          value.intent\n        ),\n    );',
  },
  effects: {
    retirement:
      "useEffect(() => {\n    draftCommands.retireCommittedConversations(state?.conversations);\n  }, [state?.conversations]);",
    history:
      "useEffect(() => {\n    // An unsent draft has no Platform conversation or Runtime Session yet.\n    // Keep the last authorized history scope until its first send commits;\n    // reading the reserved draft ID would make normal refresh fail with 404.\n    if (!selectedDraft && conversationProjectId && conversationId)\n      void client.selectHistoryScope({\n        projectId: conversationProjectId,\n        conversationId,\n      });\n  }, [conversationProjectId, conversationId, selectedDraft?.id]);",
  },
  actionBlock:
    'function selectContentScope(scope: string) {\n    if (!origin.isActive()) return;\n    setContentScope(scope);\n    // Treat a destination change as navigation: stale open/picker callbacks\n    // must not restore the previous scope or focus. Drafts and grants remain\n    // keyed by their original workspace, not copied into the new destination.\n    prefer({ artifactId: null, scriptLocation: null });\n  }\n  function selectConversation(workspaceId: string, id: string, focus = false) {\n    if (!origin.isActive()) return;\n    setWebsiteIntent(null);\n    const sameProject =\n      prefs.view === "projects" &&\n      prefs.projectOpen &&\n      navigationProject?.id === workspaceId &&\n      // Search can open another space\'s object without changing the navigation\n      // entry. Preserve an object only when it actually belongs to this project.\n      project?.id === workspaceId;\n    const selectedExchange =\n      id === (sharedDefault ? defaultConversation : workspaceId)\n        ? workspaceId\n        : id;\n    setCreating(null);\n    setExecutions(null);\n    prefer({\n      view: "projects",\n      projectId: workspaceId,\n      projectOpen: true,\n      ...(!sameProject ? { artifactId: null } : {}),\n      selectedConversations: {\n        [workspaceId]: id,\n      },\n      interactions: {\n        [selectedExchange]:\n          prefs.interactions?.[selectedExchange] === "history"\n            ? "history"\n            : "recent",\n      },\n    });\n    if (focus) {\n      keepExchangeOpen();\n      requestConversationFocus(id, navigationGeneration.current);\n    }\n  }\n  async function createProjectConversation(workspaceId: string, title: string) {\n    // Starting to type is local navigation, not a server-side conversation.\n    // Repeated clicks reuse the unfinished draft; the first input commits both.\n    const pending = draftCommands.createConversation(workspaceId, title);\n    selectConversation(workspaceId, pending.id, true);\n  }\n  function discardConversationDraft(id: string) {\n    if (sendPending.current) {\n      setNotice("消息正在提交，请等待结果后整理草稿。");\n      return;\n    }\n    draftCommands.discardConversation(\n      id,\n      () => state?.conversations.find((c) => c.id === id),\n      (conversation) => {\n        if (conversationId === id) openProject(conversation.projectId);\n      },\n    );\n  }\n  function restoreConversationDraft(id: string) {\n    draftCommands.restoreConversation(\n      id,\n      hasConversationDraft,\n      (conversation) => {\n        selectConversation(conversation.projectId, id, true);\n      },\n    );\n  }\n  function openProject(id: string) {\n    // An explicit project click means its default conversation, not whichever\n    // named Session happened to be used last. Reuse the same switching path so\n    // drafts, the current application/object and in-flight work stay intact.\n    selectConversation(\n      id,\n      sharedDefault ? (personalSpace("dialogue")?.id ?? id) : id,\n    );\n  }\n  function prepareCreatedProject() {\n    const intent = { generation: navigationGeneration.current };\n    const lifetime = host.captureCommit();\n    const active = origin.isActive();\n    return (id: string, kind: string) => {\n      if (!active || kind !== "project") return;\n      const destination: CurrentDestination = (current) =>\n        lifetime(current) &&\n        navigation.isCurrent(intent.generation) &&\n        current.workspace.projects.some(\n          (value) =>\n            value.id === id &&\n            spaceKind(value) === "project" &&\n            !value.deletedAt,\n        );\n      const current = host.currentProjection();\n      if (!current || !destination(current)) return;\n      const conversation = current.capabilities.teamAuthentication\n        ? id\n        : (current.workspace.projects.find(\n            (value) =>\n              value.kind === "dialogue" &&\n              value.ownerPrincipalId === current.principalId,\n          )?.id ?? id);\n      // This is the original default-conversation route only. No old child\n      // draft, focus, notice or creation setter is transferred to the new tree.\n      continueNavigation(\n        {\n          view: "projects",\n          projectId: id,\n          projectOpen: true,\n          artifactId: null,\n          selectedConversations: { [id]: conversation },\n          interactions: {\n            [id]: prefs.interactions?.[id] === "history" ? "history" : "recent",\n          },\n        },\n        intent,\n        destination,\n      );\n    };\n  }',
} as const;

export const privateProjectScopeActions = [
  "selectContentScope",
  "selectConversation",
  "createProjectConversation",
  "discardConversationDraft",
  "restoreConversationDraft",
  "openProject",
  "prepareCreatedProject",
] as const;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
for (const name of privateProjectScopeActions)
  assert.equal(
    hash(privateProjectScopeFixed.functions[name]),
    privateProjectScopeFixed.actionHashes[name],
    "fixed complete actual Git action " + name,
  );

const ownerModule = "./host/private-project-conversation-scope.js";
const exports = [
  "createPrivateProjectConversationScope",
  "projectConversationDraftPresence",
  "startedProjectConversationIds",
  "useCommittedConversationDraftRetirement",
  "usePrivateConversationHistorySelection",
  "usePrivateProjectContentScope",
] as const;
const originalStateComment =
  "  // The catalog and its composer share a destination. Keep the existing\n" +
  "  // catalog preference key so returning/reloading restores the same scope.\n";

// This is the approved finite port/capture skeleton, not candidate algorithms.
// All seven algorithms and the five hook/projection recipes below are composed
// from the independently frozen actual Git declarations above.
const expectedOwner = `
import { useEffect, useState } from "react";
import type { scopedStorage } from "../local-preferences.js";
import { discussionId, spaceKind, type Workspace } from "../../../../packages/core/src/model.js";
import type { Project } from "../../../../packages/core/src/projects.js";
import type { WorkspaceClient } from "../client.js";
import type { InputDraft, createExchangeDraftCommands } from "./exchange-drafts.js";
import type { CurrentDestination, NavigationIntent } from "./use-workspace-navigation.js";
import type { Preferences } from "./use-workspace-navigation-host.js";
type ScopeWorkspace = Pick<Workspace, "conversations" | "inputs">;
type CapturedConversationClient = Pick<WorkspaceClient, "boot">;
export type ProjectConversationRead = {
 state: ScopeWorkspace | undefined; client: CapturedConversationClient;
};
type ScopeStorage = Pick<ReturnType<typeof scopedStorage>, "readLocal">;
export function usePrivateProjectContentScope({ readLocal }: ScopeStorage) {
 ${privateProjectScopeFixed.statements.contentScope}
 return { contentScope, setContentScope };
}
export function useCommittedConversationDraftRetirement(
 draftCommands: Pick<ReturnType<typeof createExchangeDraftCommands>, "retireCommittedConversations">,
 state: Pick<Workspace, "conversations"> | undefined
) { ${privateProjectScopeFixed.effects.retirement} }
export function usePrivateConversationHistorySelection({
 client, selectedDraft, conversationProjectId, conversationId
}: {
 client: Pick<WorkspaceClient, "selectHistoryScope">;
 selectedDraft: { id: string } | undefined;
 conversationProjectId: string; conversationId: string;
}) { ${privateProjectScopeFixed.effects.history} }
export function startedProjectConversationIds({ state, client }: ProjectConversationRead) {
 ${privateProjectScopeFixed.statements.startedConversations.replace("const startedConversations =", "return")}
}
export function projectConversationDraftPresence({ state, client, drafts }:
 ProjectConversationRead & { drafts: Record<string, InputDraft> }) {
 ${privateProjectScopeFixed.statements.hasConversationDraft.replace("const hasConversationDraft =", "return")}
}
type DraftCommands = Pick<ReturnType<typeof createExchangeDraftCommands>,
 "createConversation" | "discardConversation" | "restoreConversation">;
type Projection = NonNullable<ReturnType<WorkspaceClient["getSnapshot"]>>;
export type PrivateProjectConversationPorts = {
 render: {
  state: Pick<Workspace, "conversations"> | undefined;
  prefs: Pick<Preferences, "view" | "projectOpen" | "interactions">;
  navigationProject: Pick<Project, "id"> | undefined;
  project: Pick<Project, "id"> | undefined;
  sharedDefault: boolean; defaultConversation: string | undefined;
  conversationId: string | undefined;
  hasConversationDraft(id: string): boolean | undefined;
  personalSpace(kind: "dialogue"): Project | undefined;
 };
 origin: { isActive(): boolean }; draftCommands: DraftCommands;
 sendPending: { readonly current: boolean };
 navigation: {
  navigationGeneration: { readonly current: number };
  isCurrent(generation: number): boolean;
  setWebsiteIntent(value: null): void;
  prefer(change: Partial<Preferences>): void;
  continueNavigation(change: Partial<Preferences>, intent: NavigationIntent,
   destination: CurrentDestination): void;
 };
 host: { captureCommit(): CurrentDestination; currentProjection(): Projection | null };
 privateUi: { setContentScope(scope: string): void; setCreating(value: null): void; setExecutions(value: null): void };
 exchange: { keepExchangeOpen(): void; requestConversationFocus(id: string, generation: number): void };
 onNotice(message: string): void;
};
export function createPrivateProjectConversationScope({
 render, origin, draftCommands, sendPending, navigation, host, privateUi,
 exchange, onNotice: setNotice
}: PrivateProjectConversationPorts) {
 const { state, prefs, navigationProject, project, sharedDefault,
 defaultConversation, conversationId, hasConversationDraft, personalSpace } = render;
 const { navigationGeneration, isCurrent, setWebsiteIntent, prefer, continueNavigation } = navigation;
 const { setContentScope, setCreating, setExecutions } = privateUi;
 const { keepExchangeOpen, requestConversationFocus } = exchange;
 ${privateProjectScopeActions.map((name) => privateProjectScopeFixed.functions[name].replace("navigation.isCurrent(intent.generation)", "isCurrent(intent.generation)")).join("\n")}
 return { ${privateProjectScopeActions.join(", ")} };
}
`;
const expectedAppSeams = `
const { contentScope, setContentScope } = usePrivateProjectContentScope({ readLocal });
const startedConversations = startedProjectConversationIds({ state, client });
useCommittedConversationDraftRetirement(draftCommands, state);
const hasConversationDraft = projectConversationDraftPresence({ state, client, drafts });
usePrivateConversationHistorySelection({ client, selectedDraft, conversationProjectId, conversationId });
const { ${privateProjectScopeActions.join(", ")} } = createPrivateProjectConversationScope({
 render: { state, prefs, navigationProject, project, sharedDefault,
 defaultConversation, conversationId, hasConversationDraft, personalSpace },
 origin, draftCommands, sendPending,
 navigation: { navigationGeneration, isCurrent: navigation.isCurrent,
 setWebsiteIntent, prefer, continueNavigation },
 host, privateUi: { setContentScope, setCreating, setExecutions },
 exchange: { keepExchangeOpen, requestConversationFocus }, onNotice: setNotice
});
`;

function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}
function parse(contents: Record<string, string>) {
  const root = "/private-project-conversation-scope-consumption";
  const config = root + "/tsconfig.json";
  const files = Object.fromEntries(
    Object.entries(contents).map(([name, value]) => [
      `${root}/${name}.tsx`,
      value,
    ]),
  );
  files[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
    files: Object.keys(contents).map((name) => name + ".tsx"),
  });
  const api = new API({ cwd: root, fs: createVirtualFileSystem(files) });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const project = snapshot.getProject(config)!;
    assert.deepEqual(
      project.program.getSyntacticDiagnostics(),
      [],
      "legal private scope source before finite rules",
    );
    return new Map(
      Object.keys(contents).map((name) => {
        const source = project.program.getSourceFile(`${root}/${name}.tsx`)!;
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
    ...(isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)
      ? [node.operator]
      : []),
    ...(isBinaryExpression(node) ? [node.operatorToken.kind] : []),
    children.length ? children : node.getText(),
  ];
}
function fn(parsed: Parsed, name: string): FunctionDeclaration {
  const found = parsed.nodes
    .filter(isFunctionDeclaration)
    .filter((node) => node.name?.text === name);
  assert.equal(found.length, 1, "unique private scope function " + name);
  assert.ok(found[0]!.body);
  return found[0]!;
}
function uniqueReplace(text: string, from: string, to: string, rule: string) {
  assert.equal(text.split(from).length - 1, 1, rule);
  return text.replace(from, to);
}
function statementOf(node: Node) {
  let statement = node;
  while (
    statement.parent &&
    !isVariableStatement(statement) &&
    !isExpressionStatement(statement)
  ) {
    statement = statement.parent;
  }
  assert.ok(
    isVariableStatement(statement) || isExpressionStatement(statement),
    "private scope call is a complete direct statement",
  );
  return statement as Statement;
}

// Restore only the approved twelve App seams. The no-new-import lane returns
// its input byte-for-byte, allowing older gates to keep their own specified
// negative rules; it never removes arbitrary deltas or validates an old hash.
export function inversePrivateProjectConversationScope(
  appText: string,
  ownerText = readFileSync(
    new URL(
      "../../apps/web/src/host/private-project-conversation-scope.ts",
      import.meta.url,
    ),
    "utf8",
  ),
) {
  appText = inverseHumanCreationFeature(appText);
  const parsed = parse({
    App: appText,
    Owner: ownerText,
    ExpectedOwner: expectedOwner,
    ExpectedApp: expectedAppSeams,
  });
  const app = parsed.get("App")!,
    owner = parsed.get("Owner")!,
    expectedOwnerSource = parsed.get("ExpectedOwner")!,
    expectedApp = parsed.get("ExpectedApp")!;
  const scopeImports = app.source.statements
    .filter(isImportDeclaration)
    .filter(
      (node) =>
        isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === ownerModule,
    );
  if (scopeImports.length === 0) {
    for (const name of exports)
      assert.equal(
        app.nodes.filter(isIdentifier).filter((node) => node.text === name)
          .length,
        0,
        "no partial new private scope seam on legacy lane",
      );
    return appText;
  }
  assert.equal(scopeImports.length, 1, "unique real private scope import");
  const importDeclaration = scopeImports[0]!;
  const imports = importDeclaration.importClause?.namedBindings;
  assert.ok(
    imports && isNamedImports(imports),
    "named runtime private scope import",
  );
  assert.equal(
    importDeclaration.importClause!.phaseModifier,
    undefined,
    "runtime private scope import",
  );
  assert.deepEqual(
    imports.elements.map(
      (value) => value.propertyName?.text ?? value.name.text,
    ),
    exports,
    "exact six real private scope imports",
  );
  assert.ok(
    imports.elements.every((value) => !value.isTypeOnly),
    "six runtime private scope imports",
  );
  const importSymbols = new Map(
    imports.elements.map((value) => [
      value.propertyName?.text ?? value.name.text,
      app.symbols.get(value.name),
    ]),
  );
  const workspace = fn(app, "WorkspaceApp");
  const calls = new Map(
    exports.map((name) => {
      const symbol = importSymbols.get(name);
      assert.notEqual(
        symbol,
        undefined,
        "resolved private scope import " + name,
      );
      const importedLocal = imports.elements.find(
        (value) => (value.propertyName?.text ?? value.name.text) === name,
      )!.name.text;
      const found = app.nodes
        .filter(isCallExpression)
        .filter(
          (node) =>
            isIdentifier(node.expression) &&
            node.expression.text === importedLocal,
        );
      assert.equal(found.length, 1, "one real private scope call " + name);
      assert.equal(
        app.symbols.get(found[0]!.expression),
        symbol,
        "real imported private scope call " + name,
      );
      const statement = statementOf(found[0]!);
      assert.equal(
        statement.parent,
        workspace.body,
        "private scope seam remains directly registered in WorkspaceApp " +
          name,
      );
      const expectedCall = expectedApp.nodes
        .filter(isCallExpression)
        .find(
          (node) =>
            isIdentifier(node.expression) && node.expression.text === name,
        )!;
      const actualText = statement
        .getText()
        .replace(importedLocal + "(", name + "(");
      const normalized = parse({
        Actual: actualText,
        Expected: statementOf(expectedCall).getText(),
      });
      assert.deepEqual(
        shape(normalized.get("Actual")!.source),
        shape(normalized.get("Expected")!.source),
        name === "createPrivateProjectConversationScope"
          ? "seven direct aliases and exact captured private scope ports"
          : "original independent private scope hook/projection capture " +
              name,
      );
      return [name, statement] as const;
    }),
  );
  const factory = fn(owner, "createPrivateProjectConversationScope");
  const expectedFactory = fn(
    expectedOwnerSource,
    "createPrivateProjectConversationScope",
  );
  assert.equal(
    factory.body!.statements.length,
    12,
    "inert private scope factory has only four captures seven declarations and return",
  );
  assert.deepEqual(
    shape(factory.parameters[0]!),
    shape(expectedFactory.parameters[0]!),
    "exact private scope port capture binding",
  );
  for (let index = 0; index < 4; index++)
    assert.deepEqual(
      shape(factory.body!.statements[index]!),
      shape(expectedFactory.body!.statements[index]!),
      "four constructor captures borrow original render values without reads",
    );
  for (const name of privateProjectScopeActions) {
    assert.equal(
      app.nodes
        .filter(isFunctionDeclaration)
        .filter((node) => node.name?.text === name).length,
      0,
      "no copied private scope App action " + name,
    );
    const actual = fn(owner, name),
      expected = fn(expectedOwnerSource, name);
    assert.equal(
      actual.parent,
      factory.body,
      "seven actions share one private scope owner",
    );
    assert.deepEqual(
      shape(actual),
      shape(expected),
      "complete actual Git private scope algorithm " + name,
    );
  }
  assert.ok(
    isReturnStatement(factory.body!.statements[11]!),
    "private scope returns direct seven aliases",
  );
  assert.deepEqual(
    shape(factory.body!.statements[11]!),
    shape(expectedFactory.body!.statements[11]!),
    "private scope returns direct seven aliases",
  );
  for (const name of exports.slice(1))
    assert.deepEqual(
      shape(fn(owner, name)),
      shape(fn(expectedOwnerSource, name)),
      "complete original private scope hook/projection recipe " + name,
    );
  assert.deepEqual(
    shape(owner.source),
    shape(expectedOwnerSource.source),
    "finite private scope module exact imports fields recipes and inert construction",
  );

  const statements = workspace.body!.statements;
  const factoryStatement = calls.get("createPrivateProjectConversationScope")!;
  const slot = statements.indexOf(factoryStatement);
  assert.equal(
    statements[slot - 1]?.getText(),
    fn(app, "open").getText(),
    "scope factory stays immediately after original open",
  );
  assert.match(
    statements[slot + 1]!.getText(),
    /createExchangeReferenceCommands\(/,
    "scope aliases precede first reference consumer",
  );
  const scopeState = calls.get("usePrivateProjectContentScope")!;
  const stateIndex = statements.indexOf(scopeState);
  assert.equal(
    statements[stateIndex - 1]!.getText(),
    "const { prefs, recentContentVisits, navigation } = host;",
    "private scope state keeps original registration predecessor",
  );
  assert.match(
    statements[stateIndex + 1]!.getText(),
    /^const leftSidebarPreference = sidebarPreference\(/,
    "private scope state keeps original registration successor",
  );
  assert.equal(
    statements[
      statements.indexOf(
        calls.get("useCommittedConversationDraftRetirement")!,
      ) - 1
    ],
    calls.get("startedProjectConversationIds"),
    "retirement effect follows original started projection",
  );
  assert.match(
    statements[
      statements.indexOf(
        calls.get("useCommittedConversationDraftRetirement")!,
      ) + 1
    ]!.getText(),
    /^const projectMetrics = useMemo\(/,
    "retirement effect keeps original hook successor",
  );
  assert.match(
    statements[
      statements.indexOf(calls.get("usePrivateConversationHistorySelection")!) -
        1
    ]!.getText(),
    /^const currentReading =/,
    "history effect keeps original registration predecessor",
  );
  assert.match(
    statements[
      statements.indexOf(calls.get("usePrivateConversationHistorySelection")!) +
        1
    ]!.getText(),
    /^useEffect\(/,
    "history effect stays ahead of original shared Session refresh",
  );

  let result = appText;
  result = uniqueReplace(
    result,
    importDeclaration.getText() + "\n",
    "",
    "remove only private scope runtime import",
  );
  result = uniqueReplace(
    result,
    "  inConversation,\n  applicationFor,",
    "  inConversation,\n  discussionId,\n  applicationFor,",
    "restore only migrated projection model import",
  );
  const replacement = new Map<string, string>([
    [
      "usePrivateProjectContentScope",
      originalStateComment.slice(2) +
        "  " +
        privateProjectScopeFixed.statements.contentScope,
    ],
    [
      "startedProjectConversationIds",
      privateProjectScopeFixed.statements.startedConversations,
    ],
    [
      "useCommittedConversationDraftRetirement",
      privateProjectScopeFixed.effects.retirement,
    ],
    [
      "projectConversationDraftPresence",
      privateProjectScopeFixed.statements.hasConversationDraft,
    ],
    [
      "usePrivateConversationHistorySelection",
      privateProjectScopeFixed.effects.history,
    ],
  ]);
  for (const [name, before] of calls)
    if (name !== "createPrivateProjectConversationScope")
      result = uniqueReplace(
        result,
        before.getText(),
        replacement.get(name)!,
        "restore only original private scope seam " + name,
      );
  result = uniqueReplace(
    result,
    "  " + factoryStatement.getText() + "\n",
    "",
    "remove only seven-alias private scope registration",
  );
  result = uniqueReplace(
    result,
    "  const closeSpeech = createExchangeInputToolCloseCommand({",
    "  " +
      privateProjectScopeFixed.actionBlock +
      "\n  const closeSpeech = createExchangeInputToolCloseCommand({",
    "restore only original seven-action position",
  );
  return result;
}

export function assertPrivateProjectConversationWholeApp(
  appText: string,
  ownerText?: string,
) {
  const restored = inversePrivateProjectConversationScope(appText, ownerText);
  assert.equal(
    Buffer.byteLength(restored),
    privateProjectScopeFixed.appBytes,
    "whole actual Git App byte count after only approved private scope inverse",
  );
  assert.equal(
    hash(restored),
    privateProjectScopeFixed.appSHA256,
    "whole actual Git App SHA after only approved private scope inverse",
  );
  return restored;
}
