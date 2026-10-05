import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  NodeFlags,
  isBinaryExpression,
  isBindingElement,
  isArrowFunction,
  isPropertyAccessExpression,
  isReturnStatement,
  isTypeLiteralNode,
  isMethodSignatureDeclaration,
  isPropertySignatureDeclaration,
  isJsxAttributes,
  isJsxOpeningElement,
  SyntaxKind,
  isCallExpression,
  isExportDeclaration,
  isExportSpecifier,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportSpecifier,
  isJsxAttribute,
  isJsxExpression,
  isJsxSelfClosingElement,
  isNamedImports,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  isVariableStatement,
  type Identifier,
  type Node,
} from "typescript/unstable/ast";
import { referenceGovernanceHistory } from "./exchange-reference-governance-history.js";

// Actual Git75ba independently frozen before adapting any candidate. Ordinary
// CI needs no Git. Finite source/consumer proof is not mounted scheduling,
// authority/HTTP, compiled full-App geometry or native-window acceptance.
export const referencePreparationFixed = {
  commit: "75ba44c030bfc9d569be4145044621600cf7572a",
  appSHA256: "8a0deb7d7239318f862113529868c416c7d2283772de7ab5547485b4c1b6c2b1",
  appBytes: 113015,
  ownerSHA256:
    "0097bc36accb5c625e94d2e7dbaef3d17075bbd72642c6a8e783fbc7e259f69c",
  ownerBytes: 8263,
  ownerRaw:
    'import type { Workspace } from "../../../../packages/core/src/model.js";\nimport type { InputIntent } from "../../../../packages/core/src/input-intent.js";\nimport type { ReadingReference } from "../../../../packages/core/src/reader.js";\nimport type { TextQuote } from "../../../../packages/core/src/text-quotes.js";\nimport type { WorkspaceClient } from "../client.js";\nimport type { InputDraft } from "./exchange-drafts.js";\nimport type { useExchangeController } from "./use-exchange-controller.js";\nimport type {\n  createWorkspaceNavigationCommands,\n  NavigationOwner,\n} from "./use-workspace-navigation.js";\nimport type { WorkspaceNavigationOrigin } from "./use-workspace-navigation-host.js";\n\ntype NavigationCommands = ReturnType<typeof createWorkspaceNavigationCommands>;\ntype ExchangeController = ReturnType<typeof useExchangeController>;\nexport type ReadingComposeCommand = (\n  id: string,\n  revision: number,\n  reference: ReadingReference,\n  question: string,\n) => { ok: boolean; error?: string };\n\nexport type ExchangeReferenceOptions = {\n  render: {\n    conversationId: string;\n    contextKey: string;\n    workspace: Pick<Workspace, "artifacts"> | undefined;\n    drafts: Record<string, InputDraft>;\n    draft: InputDraft;\n    sending: boolean;\n    emptyDraft: InputDraft;\n  };\n  origin: Pick<WorkspaceNavigationOrigin, "isActive">;\n  navigation: Pick<\n    NavigationOwner,\n    "navigationGeneration" | "isCurrent" | "setExplicitWebsiteIntent"\n  > &\n    Pick<\n      NavigationCommands,\n      | "openObject"\n      | "openScriptLocation"\n      | "openBrowser"\n      | "activateApplication"\n    > & {\n      selectConversation(\n        workspaceId: string,\n        id: string,\n        focus?: boolean,\n      ): void;\n    };\n  client: Pick<WorkspaceClient, "resolveArtifact">;\n  drafts: {\n    replace(key: string, value: InputDraft): void;\n    update(key: string, update: (value: InputDraft) => InputDraft): void;\n  };\n  exchange: Pick<\n    ExchangeController,\n    "showInput" | "setInteraction" | "requestConversationFocus"\n  > & { keepOpen(): void };\n  quotes: {\n    clearSelection(): void;\n    reveal(quote: TextQuote): boolean;\n    setReveal(value: { quote: TextQuote; token: string }): void;\n  };\n  onNotice(message: string): void;\n};\n\n/** Four distinct, render-captured preparation/revisit commands. Construction\n * borrows facts and ports only: no ref/DOM read, query, token or lifecycle.\n * Authority, draft persistence and actual focus remain with the original Host.\n */\nexport function createExchangeReferenceCommands({\n  render,\n  origin,\n  navigation,\n  client,\n  drafts: draftPorts,\n  exchange,\n  quotes,\n  onNotice: setNotice,\n}: ExchangeReferenceOptions) {\n  const {\n    conversationId,\n    contextKey,\n    workspace: state,\n    drafts,\n    draft,\n    sending,\n    emptyDraft,\n  } = render;\n  const {\n    navigationGeneration,\n    openObject,\n    openScriptLocation,\n    openBrowser,\n    activateApplication,\n    selectConversation,\n    setExplicitWebsiteIntent: setWebsiteIntent,\n  } = navigation;\n  const { replace: setDraft, update: updateDraft } = draftPorts;\n  const {\n    keepOpen: keepExchangeOpen,\n    showInput,\n    setInteraction,\n    requestConversationFocus,\n  } = exchange;\n  const { reveal: revealTextQuote, setReveal: setQuoteReveal } = quotes;\n\n  async function openTextQuote(quote: TextQuote) {\n    if (!origin.isActive()) return;\n    quotes.clearSelection();\n    const source = quote.source;\n    if (source.kind !== "message" && revealTextQuote(quote)) {\n      return;\n    }\n    if (source.kind === "message") {\n      if (source.conversationId !== conversationId) {\n        selectConversation(source.projectId, source.conversationId);\n      }\n      keepExchangeOpen();\n      setInteraction("recent");\n      setQuoteReveal({ quote, token: crypto.randomUUID() });\n    } else if (source.kind === "artifact" || source.kind === "reading") {\n      const generation = await openObject(\n        source.projectId,\n        source.artifactId,\n        source.revision,\n        source.kind === "artifact" ? source.page : undefined,\n        source.kind === "reading",\n        source.kind === "reading" ? source.location : undefined,\n      );\n      if (\n        !origin.isActive() ||\n        generation === undefined ||\n        !navigation.isCurrent(generation)\n      )\n        return;\n      setQuoteReveal({ quote, token: crypto.randomUUID() });\n    } else if (source.kind === "script") {\n      const generation = await openScriptLocation({\n        productionId: source.productionId,\n        itemId: source.entryId,\n        revision: source.revision,\n        candidateId: source.candidateId,\n      });\n      if (\n        !origin.isActive() ||\n        generation === undefined ||\n        !navigation.isCurrent(generation)\n      )\n        return;\n      setQuoteReveal({ quote, token: crypto.randomUUID() });\n    } else if (source.kind === "web") {\n      const generation = await openBrowser(source.url);\n      if (\n        !origin.isActive() ||\n        generation === undefined ||\n        !navigation.isCurrent(generation)\n      )\n        return;\n      setQuoteReveal({ quote, token: crypto.randomUUID() });\n    } else if (source.applicationInstanceId) {\n      activateApplication(source.applicationInstanceId);\n    } else setNotice("已保留所选原文；这个界面没有固定的内容位置。");\n  }\n  async function composeContent(id: string) {\n    if (!origin.isActive()) return;\n    const expectedNavigation = navigationGeneration.current;\n    const target =\n      state?.artifacts.find((a) => a.id === id) ??\n      (await client.resolveArtifact(id));\n    if (\n      !origin.isActive() ||\n      !navigation.isCurrent(expectedNavigation) ||\n      !target\n    )\n      return;\n    // Opening a result changes the object reference, never the current Session.\n    const key = conversationId + ":" + id;\n    const revision = drafts[key]?.revision ?? target.revision;\n    updateDraft(key, (old) => ({ ...old, revision: old.revision ?? revision }));\n    setWebsiteIntent(null);\n    keepExchangeOpen();\n    // A current result is a live document, not an implicit history selection.\n    // Keep an older unsent draft anchored to its original reference, however.\n    const generation = await openObject(\n      target.projectId,\n      id,\n      revision === target.revision ? undefined : revision,\n    );\n    if (generation !== undefined) {\n      if (!origin.isActive() || !navigation.isCurrent(generation)) return;\n      requestConversationFocus(conversationId, generation);\n      keepExchangeOpen();\n      setInteraction("recent");\n    }\n  }\n  const composeReading: ReadingComposeCommand = (\n    id,\n    revision,\n    reference,\n    question,\n  ) => {\n    const key = conversationId + ":" + id,\n      old = drafts[key] ?? emptyDraft;\n    if (\n      old.body.trim() ||\n      old.selection ||\n      old.attachments?.length ||\n      old.continuation ||\n      old.taskResult ||\n      old.scriptGeneration\n    )\n      return {\n        ok: false,\n        error: "输入框中有未发送内容，请先处理原草稿；这次选文仍保留。",\n      };\n    setDraft(key, {\n      ...old,\n      reading: structuredClone(reference),\n      skipReading: false,\n      revision,\n      selection: reference.quote,\n      body: question,\n      annotation: false,\n      intent: undefined,\n    });\n    showInput();\n    return { ok: true };\n  };\n  function composeIntent(intent: InputIntent) {\n    if (\n      intent === "script" &&\n      (sending ||\n        draft.pendingSupplement ||\n        draft.continuation ||\n        draft.annotation ||\n        draft.taskResult ||\n        draft.scriptGeneration)\n    ) {\n      setNotice(\n        "输入中已有另一份请求，请先完成或明确移除原请求，再构思新剧。原草稿保留。",\n      );\n      showInput();\n      return;\n    }\n    if (intent === "website") {\n      void openBrowser();\n      return;\n    }\n    // Preserve the exact workspace, object reference, selection and unfinished text.\n    // Clicking a shortcut neither submits a request nor creates an empty object.\n    setDraft(contextKey, {\n      ...draft,\n      intent,\n      annotation: false,\n      taskResult: undefined,\n    });\n    showInput();\n  }\n  return { openTextQuote, composeContent, composeReading, composeIntent };\n}\n',
  spans: {
    state:
      "const [quoteReveal, setQuoteReveal] = useState<{\n    quote: TextQuote;\n    token: string;\n  } | null>(null);",
    effect: "useEffect(() => setQuoteReveal(null), [conversationId]);",
    factory:
      "const { openTextQuote, composeContent, composeReading, composeIntent } =\n    createExchangeReferenceCommands({\n      render: {\n        conversationId,\n        contextKey,\n        workspace: state,\n        drafts,\n        draft,\n        sending,\n        emptyDraft,\n      },\n      origin,\n      navigation: {\n        navigationGeneration,\n        isCurrent: navigation.isCurrent,\n        setExplicitWebsiteIntent: setWebsiteIntent,\n        openObject,\n        openScriptLocation,\n        openBrowser,\n        activateApplication,\n        selectConversation,\n      },\n      client,\n      drafts: { replace: setDraft, update: updateDraft },\n      exchange: {\n        keepOpen: keepExchangeOpen,\n        showInput,\n        setInteraction,\n        requestConversationFocus,\n      },\n      quotes: {\n        clearSelection: () => window.getSelection()?.removeAllRanges(),\n        reveal: revealTextQuote,\n        setReveal: setQuoteReveal,\n      },\n      onNotice: setNotice,\n    });",
    conversationKey:
      "function conversationKey(workspaceId: string) {\n    return workSurfaceConversationId(\n      workSurface,\n      prefs.selectedConversations,\n      workspaceId,\n    );\n  }",
    search:
      '(id, projectId, revision, quote, page) => {\n            void openObject(\n              projectId,\n              id,\n              revision,\n              page,\n              false,\n              undefined,\n              quote,\n            ).then((generation) => {\n              if (\n                generation === undefined ||\n                generation !== navigationGeneration.current\n              )\n                return;\n              const key = conversationKey(projectId) + ":" + id;\n              setDraft(key, {\n                ...(drafts[key] ?? emptyDraft),\n                selection: quote,\n                revision,\n                page,\n              });\n              setInteraction("recent");\n              requestAnimationFrame(() => {\n                if (!exchange.current?.contains(document.activeElement))\n                  input.current?.focus();\n              });\n            });\n          }',
    select:
      "(quote, revision, page, annotation) => {\n                        setDraft(contextKey, {\n                          ...draft,\n                          selection: quote,\n                          revision,\n                          page,\n                          annotation,\n                          taskResult: undefined,\n                          intent: undefined,\n                        });\n                        showInput();\n                      }",
    change:
      "(textQuotes) =>\n        updateDraft(contextKey, (old) => ({ ...old, textQuotes }))",
    focus:
      "() => {\n        showInput();\n        requestAnimationFrame(() =>\n          input.current?.focus({ preventScroll: true }),\n        );\n      }",
    searchFrame:
      "requestAnimationFrame(() => {\n                if (!exchange.current?.contains(document.activeElement))\n                  input.current?.focus();\n              })",
    commentFrame:
      "requestAnimationFrame(() =>\n          input.current?.focus({ preventScroll: true }),\n        )",
    searchElement:
      '<SearchDocuments\n          client={client}\n          onClose={() => setSearchOpen(false)}\n          onOpen={openUser}\n          onQuote={(id, projectId, revision, quote, page) => {\n            void openObject(\n              projectId,\n              id,\n              revision,\n              page,\n              false,\n              undefined,\n              quote,\n            ).then((generation) => {\n              if (\n                generation === undefined ||\n                generation !== navigationGeneration.current\n              )\n                return;\n              const key = conversationKey(projectId) + ":" + id;\n              setDraft(key, {\n                ...(drafts[key] ?? emptyDraft),\n                selection: quote,\n                revision,\n                page,\n              });\n              setInteraction("recent");\n              requestAnimationFrame(() => {\n                if (!exchange.current?.contains(document.activeElement))\n                  input.current?.focus();\n              });\n            });\n          }}\n        />',
    artifactElement:
      '<ArtifactEditor\n                      autoOpenWebsite={websiteIntent === artifact.id}\n                      titleInToolbar={\n                        artifact.content.kind === "pdf" ||\n                        (!applicationWorkspaceOpen &&\n                          artifact.content.kind === "task")\n                      }\n                      toolbarTarget={\n                        creating === "document" ? null : detailToolbarTarget\n                      }\n                      key={\n                        artifact.id +\n                        ":" +\n                        (prefs.artifactRevision ?? "current") +\n                        ":" +\n                        (prefs.artifactPage ?? "saved")\n                      }\n                      artifact={artifact}\n                      state={state}\n                      client={client}\n                      onOpen={openUser}\n                      onNotice={setNotice}\n                      onTaskInput={(result) => {\n                        setDraft(contextKey, {\n                          ...draft,\n                          intent: undefined,\n                          selection: "",\n                          revision: artifact.revision,\n                          taskResult: result\n                            ? {\n                                taskId: artifact.id,\n                                revision: artifact.revision,\n                              }\n                            : undefined,\n                        });\n                        showInput();\n                      }}\n                      initialRevision={prefs.artifactRevision}\n                      initialPage={prefs.artifactPage}\n                      onSelect={(quote, revision, page, annotation) => {\n                        setDraft(contextKey, {\n                          ...draft,\n                          selection: quote,\n                          revision,\n                          page,\n                          annotation,\n                          taskResult: undefined,\n                          intent: undefined,\n                        });\n                        showInput();\n                      }}\n                    />',
    provider:
      "{\n      quotes: draft.textQuotes,\n      scope: conversationId,\n      reveal: quoteReveal,\n      disabled:\n        sending ||\n        !!draft.pendingSupplement ||\n        !!selectedConversation?.archivedAt,\n      onChange: (textQuotes) =>\n        updateDraft(contextKey, (old) => ({ ...old, textQuotes })),\n      onEngage: keepExchangeOpen,\n      onFocusComposer: () => {\n        showInput();\n        requestAnimationFrame(() =>\n          input.current?.focus({ preventScroll: true }),\n        );\n      },\n      onOpen: (quote) => void openTextQuote(quote),\n      onNotice: setNotice,\n    }",
    referenceImport:
      'import { createExchangeReferenceCommands } from "./host/exchange-reference-commands.js";',
    textQuoteImport:
      'import type { TextQuote } from "../../../packages/core/src/text-quotes.js";',
    beforeState: "const sendPending = useRef(false);",
    afterState:
      "const draftCommands = createExchangeDraftCommands({\n    inputs: inputDraftState,\n    conversations: conversationDraftState,\n    discarded: discardedDraftState,\n    storage: { readLocal, writeLocal },\n    onNotice: setNotice,\n  });",
    beforeEffect:
      "function conversationKey(workspaceId: string) {\n    return workSurfaceConversationId(\n      workSurface,\n      prefs.selectedConversations,\n      workspaceId,\n    );\n  }",
    afterEffect:
      "const [conversationToolbarTarget, setConversationToolbarTarget] =\n    useState<HTMLDivElement | null>(null);",
    beforeFactory:
      "const {\n    selectContentScope,\n    selectConversation,\n    createProjectConversation,\n    discardConversationDraft,\n    restoreConversationDraft,\n    openProject,\n    prepareCreatedProject,\n  } = createPrivateProjectConversationScope({\n    render: {\n      state,\n      prefs,\n      navigationProject,\n      project,\n      sharedDefault,\n      defaultConversation,\n      conversationId,\n      hasConversationDraft,\n      personalSpace,\n    },\n    origin,\n    draftCommands,\n    sendPending,\n    navigation: {\n      navigationGeneration,\n      isCurrent: navigation.isCurrent,\n      setWebsiteIntent,\n      prefer,\n      continueNavigation,\n    },\n    host,\n    privateUi: { setContentScope, setCreating, setExecutions },\n    exchange: { keepExchangeOpen, requestConversationFocus },\n    onNotice: setNotice,\n  });",
    afterFactory:
      "function readingTargetConsumed(requestId: string) {\n    if (prefs.readingTarget?.requestId === requestId)\n      prefer({ readingTarget: null });\n  }",
  },
  spanHashes: {
    state: "8a3934d8c5015f209ff9e0baae4590a9ca46a1207783319e0d6efb637e90cca9",
    effect: "afc6478b5aa06c2b299ed1293b6395d17a5dbe54a9744c63068cbecf61ededd4",
    factory: "558e615515fb011e82ef2575b20a93ce6db06b25df61d303b3edf8f63e200b11",
    conversationKey:
      "ced8f64972d548d1539a6cb96b854b2249ad306dba27928982dec633b0815f72",
    search: "838e96cf365058d676c25673064dc6de0e7c9e4470df6c8a4cb15ccb1d49ae97",
    select: "000ef25adb432e5c5688a92d2d4f6dced043d397fe887bb558783966a676ce39",
    change: "6cdff7c39a2dc08b1e56add18b694ec86685ef7242a82210d924e3717b32e30e",
    focus: "bd4f4c037d9e989259a8b6f22a961bb0799c1742a9b0f02a6f17813a155f83b4",
    searchFrame:
      "a13f7416ae84611e4132ba982964e0b4a1d9ebbcedc513d26f1fd67c3ba9934e",
    commentFrame:
      "90c868ae1926efc3ded08691300673757ccd791bc8361b64a3eaed5a04d72ac0",
    searchElement:
      "ba0a72ee9c42daa3b379cbd387d73e1bf91907f00072a93e8af8fe53c8817043",
    artifactElement:
      "e3c6525c15f0a36bea65bc10b145261a0bd2a20ac6f86a6df06c5fe250778f9b",
    provider:
      "a0ef0261ccd880122b59a812b0e7c968bcaafd19dbbc475ea847ba44e967933b",
    referenceImport:
      "f8857dc541c2bc31ad4a7eb35ab513b4488bc331a1d098e38b0fba9a32710c98",
    textQuoteImport:
      "c7e7a3f7e49a0cabb24ff9c944d469c297060ed94133a6b3987690f13f2d271e",
    beforeState:
      "2e8e9a52bfbbcea1913a91063792bc9e4130fcba747c4398b38cc79d6e7cf94a",
    afterState:
      "93ac133489ba051c761633513988ee09f864b366b4b3c94bcb71fe6da676613d",
    beforeEffect:
      "ced8f64972d548d1539a6cb96b854b2249ad306dba27928982dec633b0815f72",
    afterEffect:
      "787e8d810fded4fda9129117b30280a63d53a984387a8219a005afc920db3f53",
    beforeFactory:
      "2e2be7e660691137bd16ba76957e74a71f60a25b174d9ffc0ab2a8ad809c65a3",
    afterFactory:
      "95860d3d62fd19801c5dc479786a3eb684e4348ff2155c2a5851b02613819c98",
  },
  methodHashes: {
    openTextQuote:
      "1bb2f8bdec650bff5cd37461b72bc741eb17aa26ce4eae5fcec1399cf855d77c",
    composeContent:
      "c773919ac64df8a32955b623d78031907d7e72bb10d13f7a70d224f2d2484623",
    composeReading:
      "5abf506ffad05c23143bc0c6117e8d77dcfc8729a7c5e2e874e920b2255cd2ec",
    composeIntent:
      "85b135a8844909a5305f4eef7f20cb5374d7ca0b550d39b488d43b3c6a5f273f",
  },
} as const;

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
for (const [name, raw] of Object.entries(referencePreparationFixed.spans))
  assert.equal(
    hash(raw),
    referencePreparationFixed.spanHashes[
      name as keyof typeof referencePreparationFixed.spans
    ],
    "fixed complete actual Git75ba preparation span " + name,
  );
assert.equal(
  hash(referencePreparationFixed.ownerRaw),
  referencePreparationFixed.ownerSHA256,
  "fixed complete actual Git75ba reference owner",
);
const fixed = referencePreparationFixed.spans;
const oldNames = [
  "openTextQuote",
  "composeContent",
  "composeReading",
  "composeIntent",
] as const;
const newNames = [
  "prepareSearchQuote",
  "selectArtifactQuote",
  "changeTextQuotes",
  "focusCommentComposer",
] as const;
const allNames = [...oldNames, ...newNames];
const hookNames = [
  "useExchangeQuoteRevealState",
  "useExchangeQuoteRevealCommit",
] as const;
const modulePath = "./host/exchange-reference-commands.js";
const reactImport =
  'import { useEffect, useState, type Dispatch, type SetStateAction } from "react";';
function replace(text: string, before: string, after: string, rule: string) {
  assert.equal(text.split(before).length - 1, 1, rule);
  return text.replace(before, after);
}
function indent(text: string, offset: number) {
  return text
    .split("\n")
    .map((line, index) => (index ? line.slice(offset) : line))
    .join("\n");
}
const recipes = {
  prepareSearchQuote:
    "function prepareSearchQuote(\n    id: string,\n    projectId: string,\n    revision: number,\n    quote: string,\n    page?: number,\n  ) " +
    indent(
      replace(
        fixed.search.slice(fixed.search.indexOf("{")),
        fixed.searchFrame + ";",
        "scheduleSearchQuoteFocus();",
        "one original search DOM frame",
      ),
      8,
    ),
  selectArtifactQuote:
    "function selectArtifactQuote(\n    quote: string,\n    revision: number,\n    page?: number,\n    annotation?: boolean,\n  ) " +
    indent(fixed.select.slice(fixed.select.indexOf("{")), 20),
  changeTextQuotes:
    "const changeTextQuotes = " +
    indent(
      fixed.change.replace("(textQuotes)", "(textQuotes: TextQuote[])"),
      4,
    ) +
    ";",
  focusCommentComposer:
    "function focusCommentComposer() " +
    indent(
      replace(
        fixed.focus.slice(fixed.focus.indexOf("{")),
        fixed.commentFrame + ";",
        "scheduleCommentComposerFocus();",
        "one original comment DOM frame",
      ),
      4,
    ),
};
const hooks = `export type QuoteReveal = { quote: TextQuote; token: string } | null;

// Separate original registration seams retain the Host's hook/effect order.
export function useExchangeQuoteRevealState() {
  ${fixed.state}
  return { quoteReveal, setQuoteReveal };
}

export function useExchangeQuoteRevealCommit(
  conversationId: string,
  setQuoteReveal: Dispatch<SetStateAction<QuoteReveal>>,
) {
  ${fixed.effect}
}

`;
const scopeType =
  "  scope: { conversationKey(workspaceId: string): string };\n";
const oldExchangeType = "  > & { keepOpen(): void };";
const exchangeType = `  > & {
    keepOpen(): void;
    scheduleSearchQuoteFocus(): void;
    scheduleCommentComposerFocus(): void;
  };`;
const oldReturn =
  "return { openTextQuote, composeContent, composeReading, composeIntent };";
const newReturn =
  "return {\n" +
  allNames.map((name) => "    " + name + ",").join("\n") +
  "\n  };";
const extraCapture =
  "    scheduleSearchQuoteFocus,\n    scheduleCommentComposerFocus,\n";
let expectedModule = reactImport + "\n" + referencePreparationFixed.ownerRaw;
expectedModule = replace(
  expectedModule,
  "export type ExchangeReferenceOptions",
  hooks + "export type ExchangeReferenceOptions",
  "fixed hook insertion",
);
expectedModule = replace(
  expectedModule,
  '  origin: Pick<WorkspaceNavigationOrigin, "isActive">;',
  scopeType + '  origin: Pick<WorkspaceNavigationOrigin, "isActive">;',
  "fixed scope type insertion",
);
expectedModule = replace(
  expectedModule,
  oldExchangeType,
  exchangeType,
  "fixed focus type insertion",
);
expectedModule = replace(
  expectedModule,
  "/** Four distinct, render-captured",
  "/** Distinct, render-captured",
  "fixed reviewed owner description",
);
expectedModule = replace(
  expectedModule,
  "  render,\n  origin,",
  "  render,\n  scope,\n  origin,",
  "fixed scope parameter",
);
expectedModule = replace(
  expectedModule,
  "  } = render;\n",
  "  } = render;\n  const { conversationKey } = scope;\n",
  "fixed scope capture",
);
expectedModule = replace(
  expectedModule,
  "    requestConversationFocus,\n  } = exchange;",
  "    requestConversationFocus,\n" + extraCapture + "  } = exchange;",
  "fixed focus captures",
);
expectedModule = replace(
  expectedModule,
  oldReturn,
  Object.values(recipes).join("\n  ") + "\n  " + newReturn,
  "fixed four method additions",
);
const focusPorts = `      scheduleSearchQuoteFocus: () =>
        ${indent(fixed.searchFrame, 6)},
      scheduleCommentComposerFocus: () =>
        ${fixed.commentFrame},
`;
let expectedFactory =
  "const {\n" +
  allNames.map((name) => "    " + name + ",").join("\n") +
  "\n  } = createExchangeReferenceCommands({\n" +
  fixed.factory
    .split("\n")
    .slice(2)
    .map((line) => line.slice(2))
    .join("\n");
expectedFactory = replace(
  expectedFactory,
  "    origin,\n",
  "    scope: { conversationKey },\n    origin,\n",
  "fixed App scope borrow",
);
expectedFactory = replace(
  expectedFactory,
  "      requestConversationFocus,\n",
  "      requestConversationFocus,\n" + focusPorts,
  "fixed App lazy focus borrows",
);
const stateRegistration =
  "const { quoteReveal, setQuoteReveal } = useExchangeQuoteRevealState();";
const commitRegistration =
  "useExchangeQuoteRevealCommit(conversationId, setQuoteReveal);";
const appImport = `import {
  createExchangeReferenceCommands,
  useExchangeQuoteRevealState,
  useExchangeQuoteRevealCommit,
} from "./host/exchange-reference-commands.js";`;
function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  node.forEachChild((child) => {
    walk(child, visit);
  });
}
export function parseReferencePreparation(contents: Record<string, string>) {
  const root = "/reference-preparation-consumption",
    config = root + "/tsconfig.json";
  const path = (name: string) => root + "/" + name + ".tsx";
  const files = Object.fromEntries(
    Object.entries(contents).map(([name, text]) => [path(name), text]),
  );
  files[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
    files: Object.keys(contents).map(path),
  });
  const api = new API({ cwd: root, fs: createVirtualFileSystem(files) });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const project = snapshot.getProject(config)!;
    assert.deepEqual(
      project.program.getSyntacticDiagnostics(),
      [],
      "legal preparation source before finite rules",
    );
    return new Map(
      Object.keys(contents).map((name) => {
        const source = project.program.getSourceFile(path(name))!;
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
type Parsed =
  ReturnType<typeof parseReferencePreparation> extends Map<string, infer P>
    ? P
    : never;
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
    ...(isImportSpecifier(node) ||
    isExportSpecifier(node) ||
    isExportDeclaration(node)
      ? [node.isTypeOnly]
      : []),
    ...(isBinaryExpression(node) ? [node.operatorToken.kind] : []),
    ...(isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)
      ? [node.operator]
      : []),
    children.length ? children : node.getText(),
  ];
}
function one<T>(values: T[], rule: string) {
  assert.equal(values.length, 1, rule);
  return values[0]!;
}
function fn(parsed: Parsed, name: string) {
  return one(
    parsed.nodes
      .filter(isFunctionDeclaration)
      .filter((node) => node.name?.text === name),
    "one complete preparation function " + name,
  );
}
function variable(parsed: Parsed, name: string) {
  return one(
    parsed.nodes
      .filter(isVariableDeclaration)
      .filter((node) => node.name.getText() === name),
    "one complete preparation variable " + name,
  );
}
function statement(node: Node) {
  const parent = node.parent?.parent;
  assert.ok(
    parent && isVariableStatement(parent),
    "complete original preparation variable statement",
  );
  return parent;
}
function method(parsed: Parsed, name: string) {
  return name === "composeReading" || name === "changeTextQuotes"
    ? statement(variable(parsed, name))
    : fn(parsed, name);
}
function imports(parsed: Parsed, path: string) {
  return parsed.source.statements
    .filter(isImportDeclaration)
    .filter(
      (node) =>
        isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === path,
    );
}
function runtimeImport(parsed: Parsed, path: string, name: string) {
  const declaration = one(
      imports(parsed, path),
      "one actual preparation dependency " + path,
    ),
    clause = declaration.importClause;
  assert.equal(
    clause?.phaseModifier,
    undefined,
    "actual runtime preparation import " + name,
  );
  assert.ok(
    clause &&
      !clause.name &&
      clause.namedBindings &&
      isNamedImports(clause.namedBindings),
    "same-name preparation import shape",
  );
  const member = one(
    clause.namedBindings.elements.filter((node) => node.name.text === name),
    "same-name preparation import " + name,
  );
  assert.ok(
    !member.propertyName && !member.isTypeOnly,
    "same-name runtime preparation import " + name,
  );
  assert.notEqual(
    parsed.symbols.get(member.name),
    undefined,
    "resolved real preparation import " + name,
  );
  return member.name;
}
function sameSymbol(
  parsed: Parsed,
  a: Identifier,
  b: Identifier,
  rule: string,
) {
  const symbol = parsed.symbols.get(a);
  assert.notEqual(symbol, undefined, rule);
  assert.equal(parsed.symbols.get(b), symbol, rule);
}
function calls(parsed: Parsed, name: string) {
  return parsed.nodes
    .filter(isCallExpression)
    .filter((node) => node.expression.getText() === name);
}
function attribute(node: ReturnType<typeof element>, name: string) {
  return one(
    node.attributes.properties
      .filter(isJsxAttribute)
      .filter((attr) => attr.name.getText() === name),
    "one actual preparation JSX attribute " + name,
  );
}
function element(parsed: Parsed, name: string) {
  return one(
    parsed.nodes
      .filter(isJsxSelfClosingElement)
      .filter((node) => node.tagName.getText() === name),
    "one actual preparation JSX consumer " + name,
  );
}
function property(node: Node, name: string) {
  assert.ok(
    isObjectLiteralExpression(node),
    "direct original preparation object",
  );
  return one(
    node.properties
      .filter(isPropertyAssignment)
      .filter((p) => p.name.getText() === name),
    "one actual preparation property " + name,
  );
}
function rawExact(actual: Node, expected: Node, rule: string) {
  assert.deepEqual(shape(actual), shape(expected), rule);
  assert.equal(
    actual.getText(),
    expected.getText(),
    rule + " raw approved span",
  );
}
function wholeHash(text: string, kind: "App" | "owner") {
  assert.equal(
    Buffer.byteLength(text),
    kind === "App"
      ? referencePreparationFixed.appBytes
      : referencePreparationFixed.ownerBytes,
    "whole actual Git75ba " +
      kind +
      " bytes after only approved preparation inverse",
  );
  assert.equal(
    hash(text),
    kind === "App"
      ? referencePreparationFixed.appSHA256
      : referencePreparationFixed.ownerSHA256,
    "whole actual Git75ba " +
      kind +
      " SHA after only approved preparation inverse",
  );
}
function moduleInverse(text: string, requireActual: boolean) {
  if (
    !requireActual &&
    !text.includes("useExchangeQuoteRevealState") &&
    !text.includes("useExchangeQuoteRevealCommit")
  )
    return text;
  const parsed = parseReferencePreparation({
    Actual: text,
    Expected: expectedModule,
    Old: referencePreparationFixed.ownerRaw,
  });
  const actual = parsed.get("Actual")!,
    expected = parsed.get("Expected")!;
  if (
    !requireActual &&
    actual.source.statements
      .filter(isFunctionDeclaration)
      .every((node) => !hookNames.some((name) => node.name?.text === name))
  )
    return text;
  const actualReact = imports(actual, "react");
  assert.equal(actualReact.length, 1, "one real preparation React hook import");
  rawExact(
    actualReact[0]!,
    imports(expected, "react")[0]!,
    "exact preparation React runtime hooks and type-only writer ports",
  );
  assert.deepEqual(
    actual.source.statements.filter(isImportDeclaration).map(shape),
    expected.source.statements.filter(isImportDeclaration).map(shape),
    "original type-only preparation dependencies plus one reviewed React runtime import",
  );
  for (const name of hookNames) {
    const hook = fn(actual, name),
      original = fn(expected, name);
    rawExact(
      hook,
      original,
      "complete original preparation hook recipe " + name,
    );
    const imported = runtimeImport(
      actual,
      "react",
      name === "useExchangeQuoteRevealState" ? "useState" : "useEffect",
    );
    const call = one(
      calls(
        actual,
        name === "useExchangeQuoteRevealState" ? "useState" : "useEffect",
      ),
      "single preparation hook registration",
    );
    assert.ok(isIdentifier(call.expression));
    sameSymbol(
      actual,
      imported,
      call.expression,
      "real imported React preparation hook not shadowed",
    );
  }
  for (const name of newNames)
    rawExact(
      method(actual, name),
      method(expected, name),
      "complete original preparation recipe " + name,
    );
  const options = one(
    actual.source.statements
      .filter(isTypeAliasDeclaration)
      .filter((node) => node.name.text === "ExchangeReferenceOptions"),
    "one preparation options type",
  );
  const expectedOptions = one(
    expected.source.statements
      .filter(isTypeAliasDeclaration)
      .filter((node) => node.name.text === "ExchangeReferenceOptions"),
    "one expected options type",
  );
  rawExact(
    options,
    expectedOptions,
    "exact preparation scope focus render and authority port types",
  );
  const factory = fn(actual, "createExchangeReferenceCommands"),
    expectedFactoryNode = fn(expected, "createExchangeReferenceCommands");
  assert.ok(factory.body && expectedFactoryNode.body);
  assert.deepEqual(
    shape(factory.parameters[0]!),
    shape(expectedFactoryNode.parameters[0]!),
    "exact render-captured preparation factory parameters",
  );
  const captures = factory.body.statements.filter(
    (node) =>
      !isFunctionDeclaration(node) &&
      !(
        isVariableStatement(node) &&
        node.declarationList.declarations.some(
          (decl) =>
            isIdentifier(decl.name) &&
            ["composeReading", "changeTextQuotes"].includes(decl.name.text),
        )
      ),
  );
  const expectedCaptures = expectedFactoryNode.body.statements.filter(
    (node) =>
      !isFunctionDeclaration(node) &&
      !(
        isVariableStatement(node) &&
        node.declarationList.declarations.some(
          (decl) =>
            isIdentifier(decl.name) &&
            ["composeReading", "changeTextQuotes"].includes(decl.name.text),
        )
      ),
  );
  assert.deepEqual(
    captures.map(shape),
    expectedCaptures.map(shape),
    "inert preparation construction exact borrowed captures and eight direct returns",
  );
  const inventory = actual.source.statements.map((node) =>
    isFunctionDeclaration(node) ? node.name?.text : node.kind,
  );
  assert.deepEqual(
    inventory,
    expected.source.statements.map((node) =>
      isFunctionDeclaration(node) ? node.name?.text : node.kind,
    ),
    "reviewed finite preparation module inventory",
  );
  // Remove only these exact approved new spans. Old methods are not overwritten:
  // mutations must remain available to the old verifier's specified rules.
  let result = replace(
    text,
    reactImport + "\n",
    "",
    "remove approved preparation React import",
  );
  result = replace(
    result,
    hooks,
    "",
    "remove approved preparation hook recipes",
  );
  result = replace(
    result,
    scopeType,
    "",
    "remove approved preparation scope type",
  );
  result = replace(
    result,
    exchangeType,
    oldExchangeType,
    "restore original preparation exchange type",
  );
  result = replace(
    result,
    "/** Distinct, render-captured",
    "/** Four distinct, render-captured",
    "restore original owner description",
  );
  result = replace(
    result,
    "  render,\n  scope,\n",
    "  render,\n",
    "remove approved preparation scope parameter",
  );
  result = replace(
    result,
    "  const { conversationKey } = scope;\n",
    "",
    "remove approved preparation scope capture",
  );
  result = replace(
    result,
    extraCapture,
    "",
    "remove approved preparation lazy focus captures",
  );
  result = replace(
    result,
    Object.values(recipes).join("\n  ") + "\n  ",
    "",
    "remove four approved preparation complete methods",
  );
  result = replace(
    result,
    newReturn,
    oldReturn,
    "restore original four direct return names",
  );
  // Exact approved module scaffold, imports and original declaration order,
  // without requiring old method bytes here (the old negative lane owns them).
  const restored = parseReferencePreparation({
    Actual: result,
    Old: referencePreparationFixed.ownerRaw,
  });
  const restoredActual = restored.get("Actual")!,
    restoredOld = restored.get("Old")!;
  assert.deepEqual(
    restoredActual.source.statements.map((node) =>
      isFunctionDeclaration(node) ? node.name?.text : node.kind,
    ),
    restoredOld.source.statements.map((node) =>
      isFunctionDeclaration(node) ? node.name?.text : node.kind,
    ),
    "restored original reference module inventory",
  );
  if (requireActual) {
    for (const name of oldNames)
      assert.equal(
        hash(method(actual, name).getText()),
        referencePreparationFixed.methodHashes[name],
        "complete untouched original reference method " + name,
      );
    wholeHash(result, "owner");
  }
  return result;
}
const readOwner = () =>
  readFileSync(
    new URL(
      "../../apps/web/src/host/exchange-reference-commands.ts",
      import.meta.url,
    ),
    "utf8",
  );
export function inverseExchangeReferencePreparationModule(text: string) {
  return moduleInverse(text, false);
}
function appInverse(text: string, ownerText: string, requireActual: boolean) {
  if (
    !requireActual &&
    !text.includes("useExchangeQuoteRevealState") &&
    !text.includes("useExchangeQuoteRevealCommit")
  )
    return text;
  if (!requireActual) {
    const legacy = parseReferencePreparation({ App: text }).get("App")!;
    const containsNewImport = imports(legacy, modulePath).some((node) => {
      const bindings = node.importClause?.namedBindings;
      return (
        bindings &&
        isNamedImports(bindings) &&
        bindings.elements.some((binding) =>
          hookNames.some(
            (name) => (binding.propertyName ?? binding.name).text === name,
          ),
        )
      );
    });
    if (!containsNewImport) return text;
  }
  moduleInverse(ownerText, requireActual);
  const parsed = parseReferencePreparation({
    App: text,
    ExpectedFactory: expectedFactory,
    State: stateRegistration,
    Commit: commitRegistration,
    Search: fixed.searchElement,
    Artifact: fixed.artifactElement,
    Provider: "const fixed = " + fixed.provider + ";",
  });
  const app = parsed.get("App")!;
  const actualImport = one(
    imports(app, modulePath),
    "one actual preparation owner runtime import",
  );
  assert.equal(
    actualImport.getText(),
    appImport,
    "complete same-name runtime preparation owner import",
  );
  const factoryBinding = runtimeImport(
    app,
    modulePath,
    "createExchangeReferenceCommands",
  );
  const stateBinding = runtimeImport(app, modulePath, hookNames[0]),
    commitBinding = runtimeImport(app, modulePath, hookNames[1]);
  const main = fn(app, "WorkspaceApp");
  assert.ok(main.body);
  const stateCall = one(
    calls(app, hookNames[0]),
    "one original-slot preparation state registration",
  );
  const commitCall = one(
    calls(app, hookNames[1]),
    "one original-slot preparation retirement registration",
  );
  for (const [call, binding, name] of [
    [stateCall, stateBinding, hookNames[0]],
    [commitCall, commitBinding, hookNames[1]],
  ] as const) {
    assert.ok(isIdentifier(call.expression));
    sameSymbol(
      app,
      binding,
      call.expression,
      "real imported preparation hook not local shadow " + name,
    );
    const statementNode =
      call === stateCall ? statement(call.parent) : call.parent;
    assert.equal(
      statementNode.parent,
      main.body,
      "unconditional original preparation hook slot " + name,
    );
    assert.equal(
      statementNode.getText(),
      call === stateCall ? stateRegistration : commitRegistration,
      "exact original preparation state writer and effect arguments",
    );
    const index = main.body.statements.indexOf(
      statementNode as (typeof main.body.statements)[number],
    );
    assert.equal(
      main.body.statements[index - 1]?.getText(),
      call === stateCall ? fixed.beforeState : fixed.beforeEffect,
      "original preparation hook preceding witness " + name,
    );
    assert.equal(
      main.body.statements[index + 1]?.getText(),
      call === stateCall ? fixed.afterState : fixed.afterEffect,
      "original preparation hook following witness " + name,
    );
  }
  const factoryCall = one(
    calls(app, "createExchangeReferenceCommands"),
    "one real preparation factory consumption",
  );
  assert.ok(isIdentifier(factoryCall.expression));
  sameSymbol(
    app,
    factoryBinding,
    factoryCall.expression,
    "real imported preparation factory not shadowed",
  );
  assert.equal(
    factoryCall.arguments.length,
    1,
    "one captured preparation options object",
  );
  assert.ok(
    isVariableDeclaration(factoryCall.parent) &&
      isObjectBindingPattern(factoryCall.parent.name),
    "eight direct preparation aliases",
  );
  const aliases = factoryCall.parent.name.elements;
  assert.deepEqual(
    aliases.map((node) => ({
      name: node.name?.getText(),
      alias: node.propertyName?.getText(),
      rest: !!node.dotDotDotToken,
      initial: node.initializer?.getText(),
    })),
    allNames.map((name) => ({
      name,
      alias: undefined,
      rest: false,
      initial: undefined,
    })),
    "eight same-name direct preparation aliases no Promise bridge",
  );
  const factoryStatement = statement(factoryCall.parent);
  assert.equal(
    factoryStatement.parent,
    main.body,
    "inert preparation factory original unconditional Host slot",
  );
  const factoryIndex = main.body.statements.indexOf(factoryStatement);
  const preceding = main.body.statements[factoryIndex - 1];
  assert.ok(
    preceding && isVariableStatement(preceding),
    "original preparation factory preceding private owner declaration",
  );
  const privateDeclaration = one(
    [...preceding.declarationList.declarations],
    "original preparation factory preceding private owner declaration",
  );
  assert.ok(
    isObjectBindingPattern(privateDeclaration.name),
    "original preparation factory preceding seven private aliases",
  );
  assert.deepEqual(
    privateDeclaration.name.elements.map((binding) =>
      (binding.propertyName ?? binding.name)?.getText(),
    ),
    [
      "selectContentScope",
      "selectConversation",
      "createProjectConversation",
      "discardConversationDraft",
      "restoreConversationDraft",
      "openProject",
      "prepareCreatedProject",
    ],
    "original preparation factory preceding seven private aliases",
  );
  // Other owners retain their algorithms, legal import aliases and specified
  // counterfactuals. Only actual-new strict validation checks that this witness
  // borrows the real private import; inverse leaves all of its bytes untouched.
  if (requireActual) {
    const privateImport = one(
      imports(app, "./host/private-project-conversation-scope.js"),
      "real original private owner preceding preparation factory",
    ).importClause;
    assert.ok(
      privateImport &&
        privateImport.phaseModifier === undefined &&
        privateImport.namedBindings &&
        isNamedImports(privateImport.namedBindings),
      "real original private owner preceding preparation factory",
    );
    const member = one(
      privateImport.namedBindings.elements.filter(
        (binding) =>
          (binding.propertyName ?? binding.name).text ===
            "createPrivateProjectConversationScope" && !binding.isTypeOnly,
      ),
      "real original private owner preceding preparation factory",
    );
    const call = privateDeclaration.initializer;
    assert.ok(
      call && isCallExpression(call) && isIdentifier(call.expression),
      "real original private owner preceding preparation factory",
    );
    sameSymbol(
      app,
      member.name,
      call.expression,
      "real original private owner preceding preparation factory",
    );
  }
  assert.equal(
    main.body.statements[factoryIndex + 1]?.getText(),
    fixed.afterFactory,
    "original preparation factory before reading callbacks",
  );
  rawExact(
    factoryStatement,
    parsed.get("ExpectedFactory")!.source.statements[0]!,
    "complete preparation captured render fields scope and distinct lazy focus ports",
  );
  const conversationKey = fn(app, "conversationKey");
  assert.equal(
    conversationKey.getText(),
    fixed.conversationKey,
    "original captured private conversation key function",
  );
  const scope = property(factoryCall.arguments[0]!, "scope").initializer;
  assert.ok(isObjectLiteralExpression(scope));
  const scopeKey = one(
    scope.properties.filter(isShorthandPropertyAssignment),
    "direct captured conversationKey port",
  );
  assert.ok(conversationKey.name && isIdentifier(scopeKey.name));
  sameSymbol(
    app,
    conversationKey.name,
    scopeKey.name,
    "real captured conversationKey not latest-state rebound",
  );
  const search = element(app, "SearchDocuments"),
    artifact = element(app, "ArtifactEditor");
  const onQuote = attribute(search, "onQuote"),
    onSelect = attribute(artifact, "onSelect");
  const providerCall = one(
    calls(app, "createElement"),
    "one actual TextQuoteProvider composition",
  );
  assert.equal(
    providerCall.arguments[0]?.getText(),
    "TextQuoteProvider",
    "actual TextQuoteProvider consumer",
  );
  const provider = providerCall.arguments[1]!;
  const onChange = property(provider, "onChange"),
    onFocus = property(provider, "onFocusComposer");
  for (const [name, consumer] of [
    [newNames[0], onQuote.initializer],
    [newNames[1], onSelect.initializer],
    [newNames[2], onChange.initializer],
    [newNames[3], onFocus.initializer],
  ] as const) {
    const expression =
      consumer && isJsxExpression(consumer) ? consumer.expression : consumer;
    assert.ok(
      expression && isIdentifier(expression) && expression.text === name,
      "direct actual preparation consumer " + name,
    );
    const alias = one(
      aliases.filter((node) => node.name?.getText() === name),
      "one direct preparation alias " + name,
    );
    assert.ok(alias.name && isIdentifier(alias.name));
    sameSymbol(
      app,
      alias.name,
      expression,
      "actual returned preparation method symbol not local shadow " + name,
    );
  }
  for (const name of newNames) {
    const alias = one(
      aliases.filter((node) => node.name?.getText() === name),
      "one direct preparation alias " + name,
    );
    assert.ok(alias.name && isIdentifier(alias.name));
    const symbol = app.symbols.get(alias.name);
    const uses = app.nodes
      .filter(isIdentifier)
      .filter(
        (node) => app.symbols.get(node) === symbol && node !== alias.name,
      );
    assert.equal(
      uses.length,
      1,
      "one direct preparation consumer no alias wrapper or extra invocation " +
        name,
    );
  }
  const mappedSearch = fixed.searchElement.replace(
    "onQuote={" + fixed.search + "}",
    "onQuote={prepareSearchQuote}",
  );
  const mappedArtifact = fixed.artifactElement.replace(
    "onSelect={" + fixed.select + "}",
    "onSelect={selectArtifactQuote}",
  );
  const mappedProvider = fixed.provider
    .replace("onChange: " + fixed.change, "onChange: changeTextQuotes")
    .replace(
      "onFocusComposer: " + fixed.focus,
      "onFocusComposer: focusCommentComposer",
    );
  const expectedConsumers = parseReferencePreparation({
    Search: mappedSearch,
    Artifact: mappedArtifact,
    Provider: "const fixed = " + mappedProvider + ";",
  });
  rawExact(
    search,
    one(
      expectedConsumers.get("Search")!.nodes.filter(isJsxSelfClosingElement),
      "expected complete Search consumer",
    ),
    "complete original Search consumer guard close open and direct quote preparation",
  );
  rawExact(
    artifact,
    one(
      expectedConsumers.get("Artifact")!.nodes.filter(isJsxSelfClosingElement),
      "expected complete Artifact consumer",
    ),
    "complete original Artifact consumer identity keys captured callbacks and selection",
  );
  rawExact(
    provider,
    variable(expectedConsumers.get("Provider")!, "fixed").initializer!,
    "complete original Provider props reveal disabled engage notice and distinct direct focus change",
  );
  let result = replace(
    text,
    appImport,
    fixed.referenceImport,
    "restore only original reference owner import",
  );
  result = replace(
    result,
    'import { quoteSource, revealTextQuote } from "./text-quote-dom.js";',
    'import { quoteSource, revealTextQuote } from "./text-quote-dom.js";\n' +
      fixed.textQuoteImport,
    "restore only original TextQuote type import",
  );
  result = replace(
    result,
    stateRegistration,
    fixed.state,
    "restore only original quote reveal state",
  );
  result = replace(
    result,
    commitRegistration,
    fixed.effect,
    "restore only original quote reveal retirement",
  );
  result = replace(
    result,
    factoryStatement.getText(),
    fixed.factory,
    "restore only validated captured reference factory",
  );
  result = replace(
    result,
    "onQuote={prepareSearchQuote}",
    "onQuote={" + fixed.search + "}",
    "restore only original search quote callback",
  );
  result = replace(
    result,
    "onSelect={selectArtifactQuote}",
    "onSelect={" + fixed.select + "}",
    "restore only original artifact select callback",
  );
  result = replace(
    result,
    "onChange: changeTextQuotes",
    "onChange: " + fixed.change,
    "restore only original text quote writer callback",
  );
  result = replace(
    result,
    "onFocusComposer: focusCommentComposer",
    "onFocusComposer: " + fixed.focus,
    "restore only original comment focus callback",
  );
  if (requireActual) wholeHash(result, "App");
  return result;
}
export function inverseExchangeReferencePreparationApp(
  appText: string,
  ownerText = readOwner(),
) {
  return appInverse(appText, ownerText, false);
}
export function assertExchangeReferencePreparationWholeApp(
  appText: string,
  ownerText = readOwner(),
) {
  return appInverse(appText, ownerText, true);
}
export function assertExchangeReferencePreparationWholeModule(
  ownerText: string,
) {
  return moduleInverse(ownerText, true);
}

// Current finite contract. The legacy inverse APIs above retain their original
// historical semantics for explicitly historical peers, but are never called
// here. Independent domains can add their own hooks, fields, methods and JSX.
function ownedNodes(root: Node) {
  const result: Node[] = [];
  walk(root, (node) => result.push(node));
  return result;
}
function currentFunction(parsed: Parsed, name: string) {
  return one(
    parsed.source.statements
      .filter(isFunctionDeclaration)
      .filter((n) => n.name?.text === name),
    "one actual governed function " + name,
  );
}
function currentImport(
  parsed: Parsed,
  path: string,
  name: string,
  typeOnly = false,
  rule = "reference-runtime-origin " + name,
) {
  const matches = imports(parsed, path).flatMap((declaration) => {
    const named = declaration.importClause?.namedBindings;
    return named && isNamedImports(named)
      ? named.elements
          .filter((item) => (item.propertyName ?? item.name).text === name)
          .map((item) => ({ declaration, item }))
      : [];
  });
  const { declaration, item } = one(matches, rule);
  const isType =
    declaration.importClause?.phaseModifier === SyntaxKind.TypeKeyword ||
    item.isTypeOnly;
  assert.equal(isType, typeOnly, rule);
  assert.notEqual(
    parsed.symbols.get(item.name),
    undefined,
    "reference-called-value-origin " + name,
  );
  return item.name;
}
function aliases(parsed: Parsed) {
  const names = new Map<number, string>();
  for (const declaration of parsed.source.statements.filter(
    isImportDeclaration,
  )) {
    const named = declaration.importClause?.namedBindings;
    if (named && isNamedImports(named))
      for (const member of named.elements) {
        const id = parsed.symbols.get(member.name);
        if (id !== undefined)
          names.set(id, (member.propertyName ?? member.name).text);
      }
  }
  // Only actual const direct aliases, never wrappers or a name-only substitute.
  for (let pass = 0; pass < 2; pass++)
    for (const variable of parsed.nodes.filter(isVariableDeclaration)) {
      if (
        !isIdentifier(variable.name) ||
        !variable.initializer ||
        !isIdentifier(variable.initializer) ||
        !(variable.parent.flags & NodeFlags.Const)
      )
        continue;
      const source = parsed.symbols.get(variable.initializer),
        target = parsed.symbols.get(variable.name);
      if (source !== undefined && target !== undefined && names.has(source))
        names.set(target, names.get(source)!);
    }
  return names;
}
// A spelling map helps compare finite recipes, but never proves origin. Only
// transparent const identifier aliases may borrow an actual source symbol.
function aliasOrigin(parsed: Parsed, value: Identifier) {
  let id = parsed.symbols.get(value);
  const seen = new Set<number>();
  while (id !== undefined && !seen.has(id)) {
    seen.add(id);
    const declaration = parsed.nodes
      .filter(isVariableDeclaration)
      .find((d) => isIdentifier(d.name) && parsed.symbols.get(d.name) === id);
    if (
      !declaration?.initializer ||
      !isIdentifier(declaration.initializer) ||
      !(declaration.parent.flags & NodeFlags.Const)
    )
      break;
    id = parsed.symbols.get(declaration.initializer);
  }
  return id;
}
function normalized(
  node: Node,
  parsed: Parsed,
  names = aliases(parsed),
): unknown {
  if (isIdentifier(node)) {
    const id = parsed.symbols.get(node);
    return [
      node.kind,
      id === undefined ? node.text : (names.get(id) ?? node.text),
    ];
  }
  const children: unknown[] = [];
  node.forEachChild((child) => {
    children.push(normalized(child, parsed, names));
  });
  return [
    node.kind,
    node.flags & (NodeFlags.Const | NodeFlags.Let | NodeFlags.OptionalChain),
    ...(isBinaryExpression(node) ? [node.operatorToken.kind] : []),
    ...(isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)
      ? [node.operator]
      : []),
    children.length ? children : node.getText(),
  ];
}
function currentSame(
  actual: Node,
  ap: Parsed,
  expected: Node,
  ep: Parsed,
  rule: string,
  names = aliases(ap),
) {
  assert.deepEqual(
    normalized(actual, ap, names),
    normalized(expected, ep),
    rule,
  );
}
function calledAs(parsed: Parsed, root: Node, binding: Identifier) {
  const names = aliases(parsed),
    id = parsed.symbols.get(binding);
  return ownedNodes(root)
    .filter(isCallExpression)
    .filter(
      (call) =>
        isIdentifier(call.expression) &&
        (parsed.symbols.get(call.expression) === id ||
          names.get(parsed.symbols.get(call.expression)!) === names.get(id!)),
    );
}
function localVariable(root: Node, name: string) {
  return one(
    ownedNodes(root)
      .filter(isVariableDeclaration)
      .filter((n) => n.name.getText() === name),
    "reference-live-binding " + name,
  );
}
function currentTypeFields(
  actual: Node,
  expected: Node,
  ap: Parsed,
  ep: Parsed,
) {
  // Existing option fields remain exact; new unrelated fields are not inventory.
  assert(
    isTypeAliasDeclaration(actual) &&
      isTypeAliasDeclaration(expected) &&
      isTypeLiteralNode(actual.type) &&
      isTypeLiteralNode(expected.type),
    "exact preparation scope focus render and authority port types",
  );
  const actualFields = actual.type.members,
    expectedFields = expected.type.members;
  for (const field of expectedFields) {
    assert(
      isPropertySignatureDeclaration(field) ||
        isMethodSignatureDeclaration(field),
      "named original option field",
    );
    assert(field.name, "named original option field");
    const text = field.name.getText();
    const same = actualFields.filter(
      (n) =>
        (isPropertySignatureDeclaration(n) ||
          isMethodSignatureDeclaration(n)) &&
        n.name?.getText() === text,
    );
    currentSame(
      one(
        same,
        "exact preparation scope focus render and authority port types " + text,
      ),
      ap,
      field,
      ep,
      "exact preparation scope focus render and authority port types",
    );
  }
}
export function verifyExchangeReferencePreparationModuleCurrent(text: string) {
  const parsed = parseReferencePreparation({
      Actual: text,
      Expected: expectedModule,
    }),
    actual = parsed.get("Actual")!,
    expected = parsed.get("Expected")!;
  for (const [path, name] of [
    ["../client.js", "WorkspaceClient"],
    ["react", "Dispatch"],
    ["react", "SetStateAction"],
  ]) {
    const rule =
      path === "react"
        ? "exact preparation React runtime hooks and type-only writer ports"
        : "original type-only preparation dependencies plus one reviewed React runtime import";
    currentImport(actual, path!, name!, true, rule);
  }
  for (const name of hookNames) {
    const hook = currentFunction(actual, name),
      original = currentFunction(expected, name);
    currentSame(
      hook,
      actual,
      original,
      expected,
      "complete original preparation hook recipe " + name,
    );
    const react = currentImport(
      actual,
      "react",
      name === hookNames[0] ? "useState" : "useEffect",
    );
    const calls = calledAs(actual, hook, react);
    assert.equal(calls.length, 1, "single preparation hook registration");
    const real = one(
      ownedNodes(hook)
        .filter(isCallExpression)
        .filter(
          (c) =>
            isIdentifier(c.expression) &&
            aliases(actual).get(actual.symbols.get(c.expression)!) ===
              (name === hookNames[0] ? "useState" : "useEffect"),
        ),
      "real imported React preparation hook not shadowed",
    );
    sameSymbol(
      actual,
      react,
      real.expression as Identifier,
      "real imported React preparation hook not shadowed",
    );
  }
  const factory = currentFunction(actual, "createExchangeReferenceCommands"),
    original = currentFunction(expected, "createExchangeReferenceCommands");
  assert(factory.body && original.body, "reference-inert-sync-factory");
  assert(
    !factory.asteriskToken &&
      !factory.modifiers?.some((m) => m.kind === SyntaxKind.AsyncKeyword),
    "synchronous reference factory",
  );
  currentSame(
    factory.parameters[0]!,
    actual,
    original.parameters[0]!,
    expected,
    "exact render-captured preparation factory parameters",
  );
  const options = one(
    actual.source.statements
      .filter(isTypeAliasDeclaration)
      .filter((n) => n.name.text === "ExchangeReferenceOptions"),
    "one preparation options type",
  );
  const oldOptions = one(
    expected.source.statements
      .filter(isTypeAliasDeclaration)
      .filter((n) => n.name.text === "ExchangeReferenceOptions"),
    "one expected options type",
  );
  currentTypeFields(options, oldOptions, actual, expected);
  const typeRoots: Node[] = [
    options,
    factory.parameters[0]!,
    ...hookNames.map((name) => currentFunction(actual, name)),
  ];
  for (const name of [
    "NavigationCommands",
    "ExchangeController",
    "ReadingComposeCommand",
    "QuoteReveal",
  ]) {
    const declaration = one(
      actual.source.statements
        .filter(isTypeAliasDeclaration)
        .filter((t) => t.name.text === name),
      "reference original typed dependency " + name,
    );
    currentSame(
      declaration,
      actual,
      one(
        expected.source.statements
          .filter(isTypeAliasDeclaration)
          .filter((t) => t.name.text === name),
        "fixed original typed dependency " + name,
      ),
      expected,
      "reference original typed dependency " + name,
    );
    typeRoots.push(declaration);
  }
  const actualNames = aliases(actual);
  for (const declaration of expected.source.statements.filter(
    isImportDeclaration,
  )) {
    const bindings = declaration.importClause?.namedBindings;
    if (
      !isStringLiteral(declaration.moduleSpecifier) ||
      !bindings ||
      !isNamedImports(bindings)
    )
      continue;
    for (const member of bindings.elements) {
      if (
        declaration.importClause?.phaseModifier !== SyntaxKind.TypeKeyword &&
        !member.isTypeOnly
      )
        continue;
      const name = (member.propertyName ?? member.name).text,
        binding = currentImport(
          actual,
          declaration.moduleSpecifier.text,
          name,
          true,
          "reference original type-only dependency origin " + name,
        );
      for (const root of typeRoots)
        for (const id of ownedNodes(root)
          .filter(isIdentifier)
          .filter(
            (n) => (actualNames.get(actual.symbols.get(n)!) ?? n.text) === name,
          ))
          sameSymbol(
            actual,
            binding,
            id,
            "reference actual typed port binding " + name,
          );
    }
  }
  for (const name of allNames) {
    const root = ownedNodes(factory),
      matches = root.filter(
        (n) =>
          (isFunctionDeclaration(n) || isVariableDeclaration(n)) &&
          n.name?.getText() === name,
      );
    const complete = one(
        matches,
        "one complete actual reference algorithm " + name,
      ),
      old = method(expected, name);
    currentSame(
      isVariableDeclaration(complete) ? statement(complete) : complete,
      actual,
      old,
      expected,
      newNames.includes(name as (typeof newNames)[number])
        ? "complete original preparation recipe " + name
        : "original reference algorithm " + name,
    );
  }
  const expectedCaptures = original.body.statements
    .filter(isVariableStatement)
    .filter(
      (s) =>
        !s.declarationList.declarations.some((d) =>
          ["composeReading", "changeTextQuotes"].includes(d.name.getText()),
        ),
    );
  for (const capture of expectedCaptures) {
    const declarations = capture.declarationList.declarations;
    const value = declarations[0]!.initializer!.getText();
    const found = factory.body.statements
      .filter(isVariableStatement)
      .filter((s) =>
        s.declarationList.declarations.some(
          (d) => d.initializer?.getText() === value,
        ),
      );
    currentSame(
      one(
        found,
        "inert preparation construction exact borrowed captures and eight direct returns",
      ),
      actual,
      capture,
      expected,
      "inert preparation construction exact borrowed captures and eight direct returns",
    );
  }
  for (const node of factory.body.statements) {
    if (isFunctionDeclaration(node)) continue;
    assert(
      isVariableStatement(node) || isReturnStatement(node),
      "reference construction only captures and returns commands",
    );
    if (isVariableStatement(node))
      for (const d of node.declarationList.declarations)
        if (d.initializer && !isArrowFunction(d.initializer))
          walk(d.initializer, (n) => {
            assert(
              !isCallExpression(n),
              "inert preparation construction exact borrowed captures and eight direct returns: no constructor port call",
            );
            assert(
              !isPropertyAccessExpression(n) || n.name.text !== "current",
              "inert preparation construction exact borrowed captures and eight direct returns: no constructor live ref read",
            );
          });
  }
  const returned = one(
    factory.body.statements.filter(isReturnStatement),
    "reference-direct-returned-command",
  );
  assert(
    returned.expression && isObjectLiteralExpression(returned.expression),
    "reference-direct-returned-command",
  );
  for (const name of allNames) {
    const p = one(
      returned.expression.properties.filter(
        (p) =>
          (isPropertyAssignment(p) || isShorthandPropertyAssignment(p)) &&
          p.name.getText() === name,
      ),
      "inert preparation construction exact borrowed captures and eight direct returns",
    );
    assert(
      isShorthandPropertyAssignment(p) && isIdentifier(p.name),
      "inert preparation construction exact borrowed captures and eight direct returns",
    );
    const declaration = one(
      ownedNodes(factory).filter(
        (n) =>
          (isFunctionDeclaration(n) || isVariableDeclaration(n)) &&
          n.name?.getText() === name,
      ),
      "actual returned reference method " + name,
    );
    assert(
      (isFunctionDeclaration(declaration) ||
        isVariableDeclaration(declaration)) &&
        declaration.name &&
        isIdentifier(declaration.name),
      "actual returned reference method " + name,
    );
    sameSymbol(
      actual,
      p.name,
      declaration.name,
      "reference-direct-returned-command " + name,
    );
  }
  const reading = one(
    ownedNodes(factory)
      .filter(isVariableDeclaration)
      .filter((d) => d.name.getText() === "composeReading"),
    "actual composeReading",
  );
  const clone = one(
    ownedNodes(reading)
      .filter(isCallExpression)
      .filter((c) => c.expression.getText() === "structuredClone"),
    "reference-called-clone-origin",
  );
  assert.equal(
    actual.symbols.get(clone.expression),
    undefined,
    "reference-called-clone-origin",
  );
  return { methods: allNames, hooks: hookNames };
}

// Only this owner's current App seam is governed. Neither a whole renderer
// digest nor any other owner's inverse participates in this verification.
export function verifyExchangeReferencePreparationConsumption(
  appText: string,
  ownerText: string,
  integration = {
    builtin: readFileSync(
      new URL(
        "../../apps/web/src/host/builtin-application-adapters.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    host: readFileSync(
      new URL("../../apps/web/src/ApplicationHost.tsx", import.meta.url),
      "utf8",
    ),
  },
) {
  verifyExchangeReferencePreparationModuleCurrent(ownerText);
  const history = referenceGovernanceHistory;
  const parsed = parseReferencePreparation({
    App: appText,
    Builtin: integration.builtin,
    Host: integration.host,
    BuiltinIntent: 'const value = () => onComposeIntent("script");',
    Factory: expectedFactory,
    CognitiveWriter: `const writeDrafts = createCognitiveDraftWriter({
      writeInputs: draftCommands.writeInputs,
      captureScope: () =>
        cognitiveSurface ? { key: contextKey, surface: cognitiveSurface } : null,
      onError: setNotice,
    });`,
    State: stateRegistration,
    Commit: commitRegistration,
    Witness:
      history.recipes.imports +
      "\nfunction WorkspaceApp() {\n" +
      Object.entries(history.recipes)
        .filter(([key]) => key !== "imports")
        .map(([, value]) =>
          value.startsWith("function ") ? value : "const " + value + ";",
        )
        .join("\n") +
      "\n}",
    Search: fixed.searchElement.replace(
      "onQuote={" + fixed.search + "}",
      "onQuote={prepareSearchQuote}",
    ),
    Artifact: fixed.artifactElement.replace(
      "onSelect={" + fixed.select + "}",
      "onSelect={selectArtifactQuote}",
    ),
    Provider:
      "const props = " +
      fixed.provider
        .replace(fixed.change, "changeTextQuotes")
        .replace(fixed.focus, "focusCommentComposer") +
      ";",
  });
  const app = parsed.get("App")!,
    main = currentFunction(app, "WorkspaceApp"),
    witness = parsed.get("Witness")!,
    names = aliases(app);
  assert(main.body, "actual reference Host function");
  const body = main.body;
  const commandOrigins = new Map<string, number>();
  const hostOrigins = new Map<string, number>();
  const hostDefinitions: Identifier[] = [];
  for (const parameter of main.parameters)
    hostDefinitions.push(
      ...ownedNodes(parameter.name)
        .filter(isIdentifier)
        .filter(
          (n) =>
            n === parameter.name ||
            (isBindingElement(n.parent) && n.parent.name === n),
        ),
    );
  for (const s of body.statements) {
    if (isFunctionDeclaration(s) && s.name) hostDefinitions.push(s.name);
    if (isVariableStatement(s))
      for (const d of s.declarationList.declarations)
        hostDefinitions.push(
          ...ownedNodes(d.name)
            .filter(isIdentifier)
            .filter(
              (n) =>
                n === d.name ||
                (isBindingElement(n.parent) && n.parent.name === n),
            ),
        );
  }
  for (const definition of hostDefinitions) {
    const id = app.symbols.get(definition);
    assert.notEqual(id, undefined, "resolved original Host capture");
    hostOrigins.set(definition.text, id!);
    if (!names.has(id!)) names.set(id!, definition.text);
  }
  const factoryBinding = currentImport(
    app,
    modulePath,
    "createExchangeReferenceCommands",
    false,
    "one actual reference owner import from its real module",
  );
  const hookBindings = hookNames.map((name) =>
    currentImport(
      app,
      modulePath,
      name,
      false,
      "complete same-name runtime preparation owner import",
    ),
  );
  function actualCall(name: string, binding: Identifier, rule: string) {
    const importedName = names.get(app.symbols.get(binding)!);
    const candidates = ownedNodes(main)
      .filter(isCallExpression)
      .filter(
        (c) =>
          isIdentifier(c.expression) &&
          (c.expression.text === name ||
            names.get(app.symbols.get(c.expression)!) === importedName),
      );
    const call = one(candidates, rule);
    assert(isIdentifier(call.expression), rule);
    assert.equal(
      aliasOrigin(app, call.expression),
      app.symbols.get(binding),
      rule,
    );
    return call;
  }
  function mapBindings(
    node: Node,
    expectedKeys: readonly string[],
    rule: string,
  ) {
    assert(
      isVariableDeclaration(node) && isObjectBindingPattern(node.name),
      rule,
    );
    assert.deepEqual(
      node.name.elements.map((e) => (e.propertyName ?? e.name)?.getText()),
      expectedKeys,
      rule,
    );
    for (const e of node.name.elements) {
      assert(
        e.name && isIdentifier(e.name) && !e.initializer && !e.dotDotDotToken,
        rule,
      );
      names.set(app.symbols.get(e.name)!, (e.propertyName ?? e.name).getText());
      if (expectedKeys === allNames)
        commandOrigins.set(
          (e.propertyName ?? e.name).getText(),
          app.symbols.get(e.name)!,
        );
    }
  }
  function directStatement(node: Node, rule: string) {
    const s = isVariableDeclaration(node) ? statement(node) : node;
    assert(s.parent === body, rule);
    if (isVariableStatement(s))
      assert(s.declarationList.flags & NodeFlags.Const, rule);
    return s;
  }
  for (let i = 0; i < hookNames.length; i++) {
    const name = hookNames[i]!,
      call = actualCall(
        name,
        hookBindings[i]!,
        "real imported preparation hook not local shadow " + name,
      );
    if (i === 0)
      mapBindings(
        call.parent,
        ["quoteReveal", "setQuoteReveal"],
        "exact original preparation state writer and effect arguments",
      );
    const s = directStatement(
        i === 0 ? call.parent : call.parent,
        "unconditional original preparation hook slot " + name,
      ),
      ep = parsed.get(i === 0 ? "State" : "Commit")!;
    currentSame(
      s,
      app,
      ep.source.statements[0]!,
      ep,
      "exact original preparation state writer and effect arguments",
      names,
    );
    const previous =
      i === 0
        ? localVariable(main, "sendPending")
        : one(
            ownedNodes(main)
              .filter(isFunctionDeclaration)
              .filter((f) => f.name?.text === "conversationKey"),
            "original conversation key",
          );
    if (i === 0)
      assert(
        previous.end < s.getStart() &&
          s.end < localVariable(main, "draftCommands").getStart(),
        "original preparation hook preceding witness " + name,
      );
    else {
      const toolbar = one(
        ownedNodes(main)
          .filter(isVariableDeclaration)
          .filter((v) =>
            v.name.getText().includes("conversationToolbarTarget"),
          ),
        "original preparation hook following witness " + name,
      );
      assert(
        previous.end < s.getStart() && s.end < toolbar.getStart(),
        "original preparation hook preceding witness " + name,
      );
    }
  }
  const call = actualCall(
    "createExchangeReferenceCommands",
    factoryBinding,
    "real imported preparation factory not shadowed",
  );
  assert(
    isVariableDeclaration(call.parent),
    "eight same-name direct preparation aliases no Promise bridge",
  );
  mapBindings(
    call.parent,
    allNames,
    "eight same-name direct preparation aliases no Promise bridge",
  );
  const registration = directStatement(
    call.parent,
    "inert preparation factory original unconditional Host slot",
  );
  const before = one(
      ownedNodes(main)
        .filter(isFunctionDeclaration)
        .filter((v) => v.name?.text === "open"),
      "original reference open witness",
    ),
    after = one(
      ownedNodes(main)
        .filter(isFunctionDeclaration)
        .filter((v) => v.name?.text === "readingTargetConsumed"),
      "original preparation factory before reading callbacks",
    );
  const privateCall = one(
    ownedNodes(main)
      .filter(isVariableDeclaration)
      .filter(
        (v) =>
          isObjectBindingPattern(v.name) &&
          v.name.elements.some(
            (e) =>
              (e.propertyName ?? e.name)?.getText() === "prepareCreatedProject",
          ),
      ),
    "original preparation factory preceding seven private aliases",
  );
  assert(
    before.end < privateCall.getStart() &&
      privateCall.end < registration.getStart() &&
      registration.end < after.getStart(),
    "original preparation factory preceding private aliases before reading callbacks",
  );
  const privateBinding = currentImport(
    app,
    "./host/private-project-conversation-scope.js",
    "createPrivateProjectConversationScope",
  );
  assert(
    privateCall.initializer &&
      isCallExpression(privateCall.initializer) &&
      isIdentifier(privateCall.initializer.expression),
    "real original private owner preceding preparation factory",
  );
  assert.equal(
    aliasOrigin(app, privateCall.initializer.expression),
    app.symbols.get(privateBinding),
    "real original private owner preceding preparation factory",
  );
  assert.equal(
    call.arguments.length,
    1,
    "one captured preparation options object",
  );
  assert(
    isObjectLiteralExpression(call.arguments[0]!),
    "complete preparation captured render fields scope and distinct lazy focus ports",
  );
  const expected = parsed.get("Factory")!,
    expectedCall = one(
      expected.nodes
        .filter(isCallExpression)
        .filter(
          (c) => c.expression.getText() === "createExchangeReferenceCommands",
        ),
      "fixed preparation factory",
    );
  // Local direct command aliases are legal only when they are actually consumed.
  for (let pass = 0; pass < 2; pass++)
    for (const v of ownedNodes(main).filter(isVariableDeclaration))
      if (
        isIdentifier(v.name) &&
        v.initializer &&
        isIdentifier(v.initializer) &&
        v.parent.flags & NodeFlags.Const
      ) {
        const from = names.get(app.symbols.get(v.initializer)!);
        if (from) names.set(app.symbols.get(v.name)!, from);
      }
  currentSame(
    call.arguments[0]!,
    app,
    expectedCall.arguments[0]!,
    expected,
    "complete preparation captured render fields scope and distinct lazy focus ports",
    names,
  );
  for (const identifier of ownedNodes(call.arguments[0]!).filter(
    isIdentifier,
  )) {
    if (
      (isPropertyAssignment(identifier.parent) &&
        identifier.parent.name === identifier) ||
      (isPropertyAccessExpression(identifier.parent) &&
        identifier.parent.name === identifier)
    )
      continue;
    const role = names.get(app.symbols.get(identifier)!) ?? identifier.text,
      source = hostOrigins.get(role);
    if (source !== undefined)
      assert.equal(
        aliasOrigin(app, identifier),
        source,
        "reference actual captured Host value origin " + role,
      );
  }
  // Actual public client/render value, actual guarded stable draft writer and
  // actual controller outputs: a lookalike name is not a borrowed authority.
  const parameter = main.parameters[0];
  assert(
    parameter && isObjectBindingPattern(parameter.name),
    "reference captured Client authority",
  );
  const client = one(
    parameter.name.elements.filter(
      (e) => (e.propertyName ?? e.name)?.getText() === "client",
    ),
    "reference captured Client authority",
  );
  assert(
    client.name && isIdentifier(client.name),
    "reference captured Client authority",
  );
  const clientProperty = one(
    call.arguments[0]!.properties.filter(isShorthandPropertyAssignment).filter(
      (p) => p.name.getText() === "client",
    ),
    "reference captured Client authority",
  );
  assert(
    isIdentifier(clientProperty.name),
    "reference captured Client authority",
  );
  sameSymbol(
    app,
    client.name,
    clientProperty.name,
    "reference captured Client authority",
  );
  const origin = one(
    parameter.name.elements.filter(
      (e) => (e.propertyName ?? e.name)?.getText() === "origin",
    ),
    "reference captured origin lifetime authority",
  );
  assert(origin.name && isIdentifier(origin.name));
  const originProperty = one(
    call.arguments[0]!.properties.filter(isShorthandPropertyAssignment).filter(
      (p) => p.name.getText() === "origin",
    ),
    "reference captured origin lifetime authority",
  );
  assert(isIdentifier(originProperty.name));
  sameSymbol(
    app,
    origin.name,
    originProperty.name,
    "reference captured origin lifetime authority",
  );
  for (const key of [
    "state",
    "drafts",
    "setDraft",
    "updateDraft",
    "setNotice",
    "conversationKey",
    "draftCommands",
    "exchangeController",
    "input",
    "exchange",
  ]) {
    const candidate = one(
      ownedNodes(main).filter(
        (n) =>
          (isFunctionDeclaration(n) || isVariableDeclaration(n)) &&
          n.name?.getText() === key,
      ),
      "reference borrowed live binding " + key,
    );
    const original = one(
      ownedNodes(currentFunction(witness, "WorkspaceApp")).filter(
        (n) =>
          (isFunctionDeclaration(n) || isVariableDeclaration(n)) &&
          n.name?.getText() === key,
      ),
      "fixed reference borrowed live binding " + key,
    );
    currentSame(
      candidate,
      app,
      original,
      witness,
      "reference borrowed live binding " + key,
      names,
    );
    if (isVariableDeclaration(candidate))
      assert(
        candidate.parent.flags & NodeFlags.Const,
        "reference stable captured declaration " + key,
      );
    for (const importedCall of ownedNodes(original)
      .filter(isCallExpression)
      .filter((c) => isIdentifier(c.expression))) {
      const importedName = aliases(witness).get(
        witness.symbols.get(importedCall.expression)!,
      );
      if (!importedName) continue;
      const c = one(
        ownedNodes(candidate)
          .filter(isCallExpression)
          .filter(
            (c) =>
              isIdentifier(c.expression) &&
              (names.get(app.symbols.get(c.expression)!) ??
                c.expression.text) === importedName,
          ),
        "reference called borrowed factory origin " + importedName,
      );
      const importDeclaration = one(
        witness.source.statements.filter(isImportDeclaration).filter((d) => {
          const b = d.importClause?.namedBindings;
          return (
            b &&
            isNamedImports(b) &&
            b.elements.some(
              (m) =>
                witness.symbols.get(m.name) ===
                witness.symbols.get(importedCall.expression),
            )
          );
        }),
        "fixed borrowed factory actual import origin " + importedName,
      );
      assert(isStringLiteral(importDeclaration.moduleSpecifier));
      const binding = currentImport(
        app,
        importDeclaration.moduleSpecifier.text,
        importedName,
        false,
        "reference called borrowed factory origin " + importedName,
      );
      assert(isIdentifier(c.expression));
      assert.equal(
        aliasOrigin(app, c.expression),
        app.symbols.get(binding),
        "reference called borrowed factory origin " + importedName,
      );
    }
  }
  const write = one(
    ownedNodes(main)
      .filter(isVariableDeclaration)
      .filter(
        (v) =>
          (isObjectBindingPattern(v.name) &&
            v.name.elements.some((e) => e.name?.getText() === "writeDrafts")) ||
          (isIdentifier(v.name) && v.name.text === "writeDrafts"),
      ),
    "reference original writeInputs writer",
  );
  if (isObjectBindingPattern(write.name)) {
    // The actual original direct writer remains a distinct exact profile.
    assert(
      write.initializer &&
        isIdentifier(write.initializer) &&
        write.initializer.text === "draftCommands",
      "reference original writeInputs writer",
    );
    assert.deepEqual(
      write.name.elements.map((e) => ({
        key: e.propertyName?.getText(),
        name: e.name?.getText(),
      })),
      [{ key: "writeInputs", name: "writeDrafts" }],
      "reference original writeInputs writer",
    );
  } else {
    const rule = "reference cognitive draft writer exact original capture";
    const imported = currentImport(
      app,
      "./host/cognitive-draft-writer.js",
      "createCognitiveDraftWriter",
      false,
      rule,
    );
    assert(
      write.initializer &&
        isCallExpression(write.initializer) &&
        isIdentifier(write.initializer.expression),
      rule,
    );
    assert.equal(
      aliasOrigin(app, write.initializer.expression),
      app.symbols.get(imported),
      rule,
    );
    const original = parsed.get("CognitiveWriter")!;
    currentSame(
      directStatement(write, rule),
      app,
      original.source.statements[0]!,
      original,
      rule,
      names,
    );
    // The fixed recipe proves shape, not authority. Every lazy capture must
    // resolve to the actual Host binding, never a nominal or mirrored scope.
    for (const name of [
      "draftCommands",
      "cognitiveSurface",
      "contextKey",
      "setNotice",
    ]) {
      const captures: Identifier[] = ownedNodes(write.initializer)
        .filter(isIdentifier)
        .filter((id) => (names.get(app.symbols.get(id)!) ?? id.text) === name);
      assert(captures.length > 0, rule);
      for (const capture of captures)
        assert.equal(aliasOrigin(app, capture), hostOrigins.get(name), rule);
    }
  }
  function directValue(value: Node | undefined, name: string, rule: string) {
    assert(
      value &&
        isIdentifier(value) &&
        aliasOrigin(app, value) === commandOrigins.get(name),
      rule,
    );
  }
  function jsx(tag: string, attributeName: string, name: string) {
    const component = currentImport(
        app,
        tag === "SearchDocuments"
          ? "./LibraryDialogs.js"
          : "./ArtifactEditor.js",
        tag,
      ),
      elementNode = one(
        ownedNodes(main)
          .filter(isJsxSelfClosingElement)
          .filter(
            (n) =>
              isIdentifier(n.tagName) &&
              app.symbols.get(n.tagName) === app.symbols.get(component),
          ),
        "one actual preparation JSX consumer " + tag,
      );
    const attr = attribute(elementNode, attributeName);
    assert(attr.initializer && isJsxExpression(attr.initializer));
    directValue(
      attr.initializer.expression,
      name,
      "direct actual preparation consumer " + name,
    );
    return elementNode;
  }
  const search = jsx("SearchDocuments", "onQuote", "prepareSearchQuote"),
    artifact = jsx("ArtifactEditor", "onSelect", "selectArtifactQuote");
  const searchGuard = [
    search.parent,
    search.parent?.parent,
    search.parent?.parent?.parent,
  ].find((n) => n && isBinaryExpression(n));
  assert(
    searchGuard &&
      isBinaryExpression(searchGuard) &&
      searchGuard.operatorToken.kind === SyntaxKind.AmpersandAmpersandToken &&
      searchGuard.left.getText() === "searchOpen",
    "reference-search-visibility-guard",
  );
  const artifactExpected = parsed.get("Artifact")!;
  currentSame(
    attribute(artifact, "key"),
    app,
    attribute(element(artifactExpected, "ArtifactEditor"), "key"),
    artifactExpected,
    "complete original Artifact consumer identity keys captured callbacks and selection",
    names,
  );
  const providerBinding = currentImport(
    app,
    "./TextQuotes.js",
    "TextQuoteProvider",
  );
  const provider = one(
    ownedNodes(main)
      .filter(isCallExpression)
      .filter(
        (c) =>
          c.arguments[0] &&
          isIdentifier(c.arguments[0]) &&
          app.symbols.get(c.arguments[0]) === app.symbols.get(providerBinding),
      ),
    "reference actual TextQuoteProvider",
  );
  const providerProps = provider.arguments[1];
  assert(
    providerProps && isObjectLiteralExpression(providerProps),
    "reference actual TextQuoteProvider",
  );
  for (const [key, name] of [
    ["onChange", "changeTextQuotes"],
    ["onFocusComposer", "focusCommentComposer"],
  ])
    directValue(
      property(providerProps, key!).initializer,
      name!,
      "direct actual preparation consumer " + name,
    );
  const providerExpected = parsed.get("Provider")!,
    expectedProps = variable(providerExpected, "props").initializer!;
  for (const key of [
    "quotes",
    "scope",
    "reveal",
    "disabled",
    "onEngage",
    "onOpen",
    "onNotice",
  ])
    currentSame(
      property(providerProps, key),
      app,
      property(expectedProps, key),
      providerExpected,
      "complete original Provider props reveal disabled engage notice and distinct direct focus change",
      names,
    );
  for (const callee of ownedNodes(property(providerProps, "onOpen"))
    .filter(isCallExpression)
    .map((c) => c.expression))
    directValue(
      callee,
      "openTextQuote",
      "reference original void quote consumer",
    );
  for (const name of newNames) {
    const references = ownedNodes(main)
      .filter(isIdentifier)
      .filter((n) => names.get(app.symbols.get(n)!) === name);
    const extra = references
      .filter(
        (n) => isVariableDeclaration(n.parent) && n.parent.initializer === n,
      )
      .filter((n) => {
        const aliasName = (n.parent as ReturnType<typeof localVariable>).name;
        return !ownedNodes(main)
          .filter(isIdentifier)
          .some(
            (other) =>
              other !== aliasName &&
              app.symbols.get(other) === app.symbols.get(aliasName) &&
              !(
                isVariableDeclaration(other.parent) &&
                other.parent.name === other
              ),
          );
      });
    assert.equal(
      extra.length,
      0,
      "one direct preparation consumer no alias wrapper or extra invocation " +
        name,
    );
    assert.equal(
      references.filter(
        (n) => isCallExpression(n.parent) && n.parent.expression === n,
      ).length,
      0,
      "one direct preparation consumer no alias wrapper or extra invocation " +
        name,
    );
  }
  // Stage54 transferred only these two borrowed command sites to the trusted
  // builtin adapter. Its complete recipes/panes/Sandbox are governed by the
  // builtin boundary, not copied here or restored through a whole-App inverse.
  const builtin = parsed.get("Builtin")!,
    builtinNames = aliases(builtin),
    host = parsed.get("Host")!;
  const builtinBinding = currentImport(
    app,
    "./host/builtin-application-adapters.js",
    "createBuiltinApplicationAdapters",
    false,
    "reference actual builtin factory value origin",
  );
  const builtinCall = actualCall(
    "createBuiltinApplicationAdapters",
    builtinBinding,
    "reference actual builtin factory value origin",
  );
  assert(
    isVariableDeclaration(builtinCall.parent) &&
      isIdentifier(builtinCall.parent.name) &&
      builtinCall.arguments.length === 1 &&
      isObjectLiteralExpression(builtinCall.arguments[0]!),
    "reference direct render-captured builtin registration",
  );
  const builtinDeclaration = builtinCall.parent;
  const builtinStatement = directStatement(
    builtinDeclaration,
    "reference direct render-captured builtin registration",
  );
  assert(
    registration.end < builtinStatement.getStart(),
    "reference original command captured before builtin registration",
  );
  function builtinField(key: string) {
    assert(isObjectLiteralExpression(builtinCall.arguments[0]!));
    const field = one(
      builtinCall.arguments[0]!.properties.filter(
        (p) =>
          (isPropertyAssignment(p) || isShorthandPropertyAssignment(p)) &&
          p.name.getText() === key,
      ),
      "reference original direct consumer " + key,
    );
    assert(isPropertyAssignment(field) || isShorthandPropertyAssignment(field));
    return isPropertyAssignment(field) ? field.initializer : field.name;
  }
  for (const [key, command] of [
    ["onReadingCompose", "composeReading"],
    ["onComposeIntent", "composeIntent"],
  ] as const)
    directValue(
      builtinField(key),
      command,
      "reference original direct consumer " + command + " " + key,
    );

  function jsxValue(node: Node, key: string) {
    assert(isJsxOpeningElement(node) || isJsxSelfClosingElement(node));
    const field = one(
      node.attributes.properties
        .filter(isJsxAttribute)
        .filter((p) => p.name.getText() === key),
      "reference actual builtin JSX port " + key,
    );
    assert(field.initializer && isJsxExpression(field.initializer));
    assert(field.initializer.expression);
    return field.initializer.expression;
  }
  function noMountKey(node: Node) {
    assert(isJsxOpeningElement(node) || isJsxSelfClosingElement(node));
    assert(
      !node.attributes.properties
        .filter(isJsxAttribute)
        .some((p) => p.name.getText() === "key"),
      "reference original compose consumer identity",
    );
  }
  const hostBinding = currentImport(
    app,
    "./ApplicationHost.js",
    "ApplicationHost",
    false,
    "reference actual generic Host value origin",
  );
  const hostNode = one(
    ownedNodes(main)
      .filter(isJsxOpeningElement)
      .filter(
        (node) =>
          isIdentifier(node.tagName) &&
          aliasOrigin(app, node.tagName) === app.symbols.get(hostBinding),
      ),
    "reference actual generic Host value consumer",
  );
  const renderer = jsxValue(hostNode, "renderBuiltin");
  assert(
    isPropertyAccessExpression(renderer) &&
      renderer.name.text === "renderBuiltin" &&
      isIdentifier(renderer.expression) &&
      aliasOrigin(app, renderer.expression) ===
        app.symbols.get(builtinDeclaration.name),
    "reference actual direct builtin renderer consumption",
  );
  noMountKey(hostNode);
  const hostFactory = currentFunction(host, "ApplicationHost");
  const hostParameters = hostFactory.parameters[0];
  assert(
    hostFactory.body &&
      hostParameters &&
      isObjectBindingPattern(hostParameters.name),
  );
  const hostRenderer = one(
    hostParameters.name.elements.filter(
      (p) => (p.propertyName ?? p.name)?.getText() === "renderBuiltin",
    ),
    "reference actual generic Host renderer port",
  );
  const hostRendererName = hostRenderer.name;
  assert(
    hostRendererName &&
      isIdentifier(hostRendererName) &&
      !hostRenderer.initializer,
  );
  one(
    ownedNodes(hostFactory.body)
      .filter(isCallExpression)
      .filter(
        (c) =>
          isIdentifier(c.expression) &&
          aliasOrigin(host, c.expression) ===
            host.symbols.get(hostRendererName),
      ),
    "reference actual generic Host renderer invocation",
  );

  const builtinFactory = currentFunction(
    builtin,
    "createBuiltinApplicationAdapters",
  );
  const builtinParameters = builtinFactory.parameters[0];
  assert(
    builtinFactory.body &&
      builtinParameters &&
      isObjectBindingPattern(builtinParameters.name),
    "reference actual builtin capture ports",
  );
  const render = one(
    builtinFactory.body.statements
      .filter(isFunctionDeclaration)
      .filter((n) => n.name?.text === "renderBuiltin"),
    "reference actual builtin returned renderer",
  );
  assert(render.body && render.name);
  const returned = one(
    builtinFactory.body.statements.filter(isReturnStatement),
    "reference actual builtin returned renderer",
  );
  assert(returned.expression && isObjectLiteralExpression(returned.expression));
  const renderField = one(
    returned.expression.properties.filter(
      (p) =>
        (isPropertyAssignment(p) || isShorthandPropertyAssignment(p)) &&
        p.name.getText() === "renderBuiltin",
    ),
    "reference actual builtin returned renderer",
  );
  assert(
    isPropertyAssignment(renderField) ||
      isShorthandPropertyAssignment(renderField),
  );
  const renderValue = isPropertyAssignment(renderField)
    ? renderField.initializer
    : renderField.name;
  assert(
    isIdentifier(renderValue) &&
      aliasOrigin(builtin, renderValue) === builtin.symbols.get(render.name),
    "reference actual builtin returned renderer",
  );
  for (const [tag, module, port] of [
    ["Reader", "../Reader.js", "onReadingCompose"],
    ["ScriptStudio", "../ScriptStudio.js", "onComposeIntent"],
  ] as const) {
    const importedLeaf = currentImport(
      builtin,
      module,
      tag,
      false,
      "reference actual builtin leaf value origin " + tag,
    );
    const leaf = one(
      ownedNodes(render.body)
        .filter(isJsxSelfClosingElement)
        .filter(
          (node) =>
            isIdentifier(node.tagName) &&
            aliasOrigin(builtin, node.tagName) ===
              builtin.symbols.get(importedLeaf),
        ),
      "reference actual builtin leaf value consumer " + tag,
    );
    const captured = one(
      builtinParameters.name.elements.filter(
        (p) => (p.propertyName ?? p.name)?.getText() === port,
      ),
      "reference original direct consumer " + port,
    );
    const capturedName = captured.name;
    assert(
      capturedName && isIdentifier(capturedName) && !captured.initializer,
      "reference original direct consumer " + port,
    );
    if (tag === "Reader") {
      const value = jsxValue(leaf, "onCompose");
      assert(
        isIdentifier(value) &&
          aliasOrigin(builtin, value) === builtin.symbols.get(capturedName),
        "reference original direct consumer composeReading onReadingCompose",
      );
      noMountKey(leaf);
    } else {
      builtinNames.set(builtin.symbols.get(capturedName)!, "onComposeIntent");
      const expectedIntent = parsed.get("BuiltinIntent")!;
      currentSame(
        jsxValue(leaf, "onConceive"),
        builtin,
        variable(expectedIntent, "value").initializer!,
        expectedIntent,
        "reference original direct consumer composeIntent onComposeIntent",
        builtinNames,
      );
      const invoked = one(
        ownedNodes(jsxValue(leaf, "onConceive")).filter(isCallExpression),
        "reference original direct consumer composeIntent onComposeIntent",
      );
      assert(
        isIdentifier(invoked.expression) &&
          aliasOrigin(builtin, invoked.expression) ===
            builtin.symbols.get(capturedName),
        "reference original direct consumer composeIntent onComposeIntent",
      );
    }
  }

  // Original public command sites remain direct, including quote wrappers
  // whose void/argument behavior is part of the old public contract.
  for (const [attrName, command, count] of [
    ["onCompose", "composeReading", 1],
    ["onCreate", "composeIntent", 1],
    ["onCompose", "composeContent", 1],
  ] as const) {
    const values = ownedNodes(main)
      .filter(isJsxAttribute)
      .filter(
        (a) =>
          a.name.getText() === attrName &&
          a.initializer &&
          isJsxExpression(a.initializer) &&
          a.initializer.expression &&
          isIdentifier(a.initializer.expression) &&
          names.get(app.symbols.get(a.initializer.expression)!) === command,
      );
    assert.equal(
      values.length,
      count,
      "reference original direct consumer " + command + " " + attrName,
    );
    for (const value of values) {
      assert(value.initializer && isJsxExpression(value.initializer));
      directValue(
        value.initializer.expression,
        command,
        "reference original direct consumer " + command + " " + attrName,
      );
    }
    if (command === "composeContent") {
      const original = parseReferencePreparation({
        Historical: history.preparationApp,
      }).get("Historical")!;
      const originalContent = one(
        original.nodes
          .filter(isJsxSelfClosingElement)
          .filter((n) => n.tagName.getText() === "ObjectCollection"),
        "historical compose consumer identity",
      );
      const attrs = values[0]!.parent;
      assert(isJsxAttributes(attrs));
      const key = one(
        attrs.properties
          .filter(isJsxAttribute)
          .filter((a) => a.name.getText() === "key"),
        "reference original compose consumer identity",
      );
      currentSame(
        key,
        app,
        attribute(originalContent, "key"),
        original,
        "reference original compose consumer identity",
        names,
      );
    }
  }
  const quoteOpen = one(
    ownedNodes(main)
      .filter(isJsxAttribute)
      .filter((a) => a.name.getText() === "onOpenQuote"),
    "reference original quote consumer",
  );
  const quoteExpected = parseReferencePreparation({
    Quote: "const value = (quote) => void openTextQuote(quote);",
  }).get("Quote")!;
  assert(
    quoteOpen.initializer &&
      isJsxExpression(quoteOpen.initializer) &&
      quoteOpen.initializer.expression,
  );
  currentSame(
    quoteOpen.initializer.expression,
    app,
    variable(quoteExpected, "value").initializer!,
    quoteExpected,
    "reference original void quote consumer",
    names,
  );
  for (const callee of ownedNodes(quoteOpen.initializer.expression)
    .filter(isCallExpression)
    .map((c) => c.expression))
    directValue(
      callee,
      "openTextQuote",
      "reference original void quote consumer",
    );
  return { methods: allNames, hooks: hookNames, consumers: 4 };
}
