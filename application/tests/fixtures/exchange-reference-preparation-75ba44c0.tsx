import { useState, useEffect, type Dispatch, type SetStateAction } from "react";
import type { TextQuote } from "../../packages/core/src/text-quotes.js";
import type { InputDraft } from "../../apps/web/src/host/exchange-drafts.js";
import type { ExchangeReferenceOptions } from "../../apps/web/src/host/exchange-reference-commands.js";

// Independently embedded actual Git75ba source. CI does not require Git or shell.
// Browser/command ports are controlled: no authority or actual App claim.
export const fixedReferencePreparationBaseline = {
  git: "75ba44c030bfc9d569be4145044621600cf7572a",
  originalFiles: {
    "App.tsx": {
      bytes: 113015,
      sha256:
        "8a0deb7d7239318f862113529868c416c7d2283772de7ab5547485b4c1b6c2b1",
    },
    "host/exchange-reference-commands.ts": {
      bytes: 8263,
      sha256:
        "0097bc36accb5c625e94d2e7dbaef3d17075bbd72642c6a8e783fbc7e259f69c",
    },
    "LibraryDialogs.tsx": {
      bytes: 12997,
      sha256:
        "3e99c2ca8a8f67768e22f627c2437f310f17c315a1cb98bb74b0f2b2f52a16c6",
    },
    "TextQuotes.tsx": {
      bytes: 24410,
      sha256:
        "ae91d562807a1ae7cd855c43b6e1cc8e2bf4aab14fea3fa44ddac2362803344f",
    },
    "SelectionActions.tsx": {
      bytes: 2589,
      sha256:
        "0f6db55a54229fb196d7c70824aaf06170d775223b6a980d4e244438792f2096",
    },
    "text-quote-dom.ts": {
      bytes: 7515,
      sha256:
        "4a8429f77faf0288ce031bde173a0a59d2d364d3d8430a1dbb624386e2cb1cb6",
    },
    "composer-drafts.ts": {
      bytes: 3691,
      sha256:
        "4c810c8e773e7c13eca8f18cc96fc6d3f41e61b1801039b29f46f162a77f4903",
    },
    "host/exchange-drafts.ts": {
      bytes: 7594,
      sha256:
        "009caa7f273c1a83bea9341c29b5790296e7cb055e68754cdc9771a486eb57c4",
    },
    "useModal.ts": {
      bytes: 5140,
      sha256:
        "f9f45b71766ac08a3ae47ff3a5b4300a61193f2fef17e76f99ab63924781cac4",
    },
    "local-preferences.ts": {
      bytes: 1977,
      sha256:
        "505dff560588587948f1b0f067af97c2c41967c4dec414250a3a335e2d13963f",
    },
    "main.tsx": {
      bytes: 703,
      sha256:
        "e6c85a40ffa6adbf8ee9b5f541a04dd47d3ac01659bbea30b5876eb61743bbc3",
    },
    "ArtifactEditor.tsx": {
      bytes: 31749,
      sha256:
        "b5e0b9c687a786faa2dce8398f978c9d5a0289bb2a24436676708124861bb4e1",
    },
    "interaction.ts": {
      bytes: 575,
      sha256:
        "589983637b8dae74e9933f24295aae672708496d4002e13fe67ac9bee478df1a",
    },
  },
  spans: {
    QuoteRevealState: {
      raw: "const [quoteReveal, setQuoteReveal] = useState<{\n    quote: TextQuote;\n    token: string;\n  } | null>(null);",
      bytes: 108,
      sha256:
        "8a3934d8c5015f209ff9e0baae4590a9ca46a1207783319e0d6efb637e90cca9",
    },
    QuoteRevealCommit: {
      raw: "useEffect(() => setQuoteReveal(null), [conversationId]);",
      bytes: 56,
      sha256:
        "afc6478b5aa06c2b299ed1293b6395d17a5dbe54a9744c63068cbecf61ededd4",
    },
    PrepareSearchQuote: {
      raw: '(id, projectId, revision, quote, page) => {\n            void openObject(\n              projectId,\n              id,\n              revision,\n              page,\n              false,\n              undefined,\n              quote,\n            ).then((generation) => {\n              if (\n                generation === undefined ||\n                generation !== navigationGeneration.current\n              )\n                return;\n              const key = conversationKey(projectId) + ":" + id;\n              setDraft(key, {\n                ...(drafts[key] ?? emptyDraft),\n                selection: quote,\n                revision,\n                page,\n              });\n              setInteraction("recent");\n              requestAnimationFrame(() => {\n                if (!exchange.current?.contains(document.activeElement))\n                  input.current?.focus();\n              });\n            });\n          }',
      bytes: 914,
      sha256:
        "838e96cf365058d676c25673064dc6de0e7c9e4470df6c8a4cb15ccb1d49ae97",
    },
    SelectArtifactQuote: {
      raw: "(quote, revision, page, annotation) => {\n                        setDraft(contextKey, {\n                          ...draft,\n                          selection: quote,\n                          revision,\n                          page,\n                          annotation,\n                          taskResult: undefined,\n                          intent: undefined,\n                        });\n                        showInput();\n                      }",
      bytes: 456,
      sha256:
        "000ef25adb432e5c5688a92d2d4f6dced043d397fe887bb558783966a676ce39",
    },
    ChangeTextQuotes: {
      raw: "(textQuotes) =>\n        updateDraft(contextKey, (old) => ({ ...old, textQuotes }))",
      bytes: 82,
      sha256:
        "6cdff7c39a2dc08b1e56add18b694ec86685ef7242a82210d924e3717b32e30e",
    },
    FocusCommentComposer: {
      raw: "() => {\n        showInput();\n        requestAnimationFrame(() =>\n          input.current?.focus({ preventScroll: true }),\n        );\n      }",
      bytes: 140,
      sha256:
        "bd4f4c037d9e989259a8b6f22a961bb0799c1742a9b0f02a6f17813a155f83b4",
    },
    ReferenceFactory: {
      raw: "const { openTextQuote, composeContent, composeReading, composeIntent } =\n    createExchangeReferenceCommands({\n      render: {\n        conversationId,\n        contextKey,\n        workspace: state,\n        drafts,\n        draft,\n        sending,\n        emptyDraft,\n      },\n      origin,\n      navigation: {\n        navigationGeneration,\n        isCurrent: navigation.isCurrent,\n        setExplicitWebsiteIntent: setWebsiteIntent,\n        openObject,\n        openScriptLocation,\n        openBrowser,\n        activateApplication,\n        selectConversation,\n      },\n      client,\n      drafts: { replace: setDraft, update: updateDraft },\n      exchange: {\n        keepOpen: keepExchangeOpen,\n        showInput,\n        setInteraction,\n        requestConversationFocus,\n      },\n      quotes: {\n        clearSelection: () => window.getSelection()?.removeAllRanges(),\n        reveal: revealTextQuote,\n        setReveal: setQuoteReveal,\n      },\n      onNotice: setNotice,\n    });",
      bytes: 977,
      sha256:
        "558e615515fb011e82ef2575b20a93ce6db06b25df61d303b3edf8f63e200b11",
    },
    ProviderProps: {
      raw: "{\n      quotes: draft.textQuotes,\n      scope: conversationId,\n      reveal: quoteReveal,\n      disabled:\n        sending ||\n        !!draft.pendingSupplement ||\n        !!selectedConversation?.archivedAt,\n      onChange: (textQuotes) =>\n        updateDraft(contextKey, (old) => ({ ...old, textQuotes })),\n      onEngage: keepExchangeOpen,\n      onFocusComposer: () => {\n        showInput();\n        requestAnimationFrame(() =>\n          input.current?.focus({ preventScroll: true }),\n        );\n      },\n      onOpen: (quote) => void openTextQuote(quote),\n      onNotice: setNotice,\n    }",
      bytes: 589,
      sha256:
        "a0ef0261ccd880122b59a812b0e7c968bcaafd19dbbc475ea847ba44e967933b",
    },
    SearchConsumer: {
      raw: '<SearchDocuments\n          client={client}\n          onClose={() => setSearchOpen(false)}\n          onOpen={openUser}\n          onQuote={(id, projectId, revision, quote, page) => {\n            void openObject(\n              projectId,\n              id,\n              revision,\n              page,\n              false,\n              undefined,\n              quote,\n            ).then((generation) => {\n              if (\n                generation === undefined ||\n                generation !== navigationGeneration.current\n              )\n                return;\n              const key = conversationKey(projectId) + ":" + id;\n              setDraft(key, {\n                ...(drafts[key] ?? emptyDraft),\n                selection: quote,\n                revision,\n                page,\n              });\n              setInteraction("recent");\n              requestAnimationFrame(() => {\n                if (!exchange.current?.contains(document.activeElement))\n                  input.current?.focus();\n              });\n            });\n          }}\n        />',
      bytes: 1063,
      sha256:
        "ba0a72ee9c42daa3b379cbd387d73e1bf91907f00072a93e8af8fe53c8817043",
    },
    SearchGuard: {
      raw: 'searchOpen && (\n        <SearchDocuments\n          client={client}\n          onClose={() => setSearchOpen(false)}\n          onOpen={openUser}\n          onQuote={(id, projectId, revision, quote, page) => {\n            void openObject(\n              projectId,\n              id,\n              revision,\n              page,\n              false,\n              undefined,\n              quote,\n            ).then((generation) => {\n              if (\n                generation === undefined ||\n                generation !== navigationGeneration.current\n              )\n                return;\n              const key = conversationKey(projectId) + ":" + id;\n              setDraft(key, {\n                ...(drafts[key] ?? emptyDraft),\n                selection: quote,\n                revision,\n                page,\n              });\n              setInteraction("recent");\n              requestAnimationFrame(() => {\n                if (!exchange.current?.contains(document.activeElement))\n                  input.current?.focus();\n              });\n            });\n          }}\n        />\n      )',
      bytes: 1095,
      sha256:
        "01409fb6020ebce354c86270726ec03413171400a013a14b31273458d747b517",
    },
    ArtifactConsumer: {
      raw: '<ArtifactEditor\n                      autoOpenWebsite={websiteIntent === artifact.id}\n                      titleInToolbar={\n                        artifact.content.kind === "pdf" ||\n                        (!applicationWorkspaceOpen &&\n                          artifact.content.kind === "task")\n                      }\n                      toolbarTarget={\n                        creating === "document" ? null : detailToolbarTarget\n                      }\n                      key={\n                        artifact.id +\n                        ":" +\n                        (prefs.artifactRevision ?? "current") +\n                        ":" +\n                        (prefs.artifactPage ?? "saved")\n                      }\n                      artifact={artifact}\n                      state={state}\n                      client={client}\n                      onOpen={openUser}\n                      onNotice={setNotice}\n                      onTaskInput={(result) => {\n                        setDraft(contextKey, {\n                          ...draft,\n                          intent: undefined,\n                          selection: "",\n                          revision: artifact.revision,\n                          taskResult: result\n                            ? {\n                                taskId: artifact.id,\n                                revision: artifact.revision,\n                              }\n                            : undefined,\n                        });\n                        showInput();\n                      }}\n                      initialRevision={prefs.artifactRevision}\n                      initialPage={prefs.artifactPage}\n                      onSelect={(quote, revision, page, annotation) => {\n                        setDraft(contextKey, {\n                          ...draft,\n                          selection: quote,\n                          revision,\n                          page,\n                          annotation,\n                          taskResult: undefined,\n                          intent: undefined,\n                        });\n                        showInput();\n                      }}\n                    />',
      bytes: 2187,
      sha256:
        "e3c6525c15f0a36bea65bc10b145261a0bd2a20ac6f86a6df06c5fe250778f9b",
    },
    ConversationReveal: {
      raw: 'quoteReveal?.quote.source.kind === "message" &&\n                      quoteReveal.quote.source.conversationId === conversationId\n                        ? quoteReveal\n                        : null',
      bytes: 197,
      sha256:
        "e432153a35bac6a8a5e12d5d5e837313604a86a5692bde3415ce91f9cae2534d",
    },
    ConversationKey: {
      raw: "function conversationKey(workspaceId: string) {\n    return workSurfaceConversationId(\n      workSurface,\n      prefs.selectedConversations,\n      workspaceId,\n    );\n  }",
      bytes: 169,
      sha256:
        "ced8f64972d548d1539a6cb96b854b2249ad306dba27928982dec633b0815f72",
    },
  },
} as const;

export function useFixedExchangeQuoteRevealState() {
  // prettier-ignore
  const [quoteReveal, setQuoteReveal] = useState<{
    quote: TextQuote;
    token: string;
  } | null>(null);
  return { quoteReveal, setQuoteReveal };
}
export function useFixedExchangeQuoteRevealCommit(
  conversationId: string,
  setQuoteReveal: Dispatch<
    SetStateAction<{ quote: TextQuote; token: string } | null>
  >,
) {
  useEffect(() => setQuoteReveal(null), [conversationId]);
}

export type FixedReferencePreparationBindings = {
  openObject: ExchangeReferenceOptions["navigation"]["openObject"];
  navigationGeneration: { readonly current: number };
  conversationKey(workspaceId: string): string;
  setDraft(key: string, draft: InputDraft): void;
  updateDraft(key: string, update: (old: InputDraft) => InputDraft): void;
  setInteraction: ExchangeReferenceOptions["exchange"]["setInteraction"];
  showInput(): void;
  contextKey: string;
  drafts: Record<string, InputDraft>;
  draft: InputDraft;
  emptyDraft: InputDraft;
  requestAnimationFrame(callback: () => void): number;
  exchange: { current: { contains(element: unknown): boolean } | null };
  input: { current: { focus(options?: FocusOptions): void } | null };
  document: { readonly activeElement: unknown };
};
export function createFixedExchangeReferencePreparations({
  openObject,
  navigationGeneration,
  conversationKey,
  setDraft,
  updateDraft,
  setInteraction,
  showInput,
  contextKey,
  drafts,
  draft,
  emptyDraft,
  requestAnimationFrame,
  exchange,
  input,
  document,
}: FixedReferencePreparationBindings) {
  // prettier-ignore
  const prepareSearchQuote: (id: string, projectId: string, revision: number, quote: string, page?: number) => void = (id, projectId, revision, quote, page) => {
            void openObject(
              projectId,
              id,
              revision,
              page,
              false,
              undefined,
              quote,
            ).then((generation) => {
              if (
                generation === undefined ||
                generation !== navigationGeneration.current
              )
                return;
              const key = conversationKey(projectId) + ":" + id;
              setDraft(key, {
                ...(drafts[key] ?? emptyDraft),
                selection: quote,
                revision,
                page,
              });
              setInteraction("recent");
              requestAnimationFrame(() => {
                if (!exchange.current?.contains(document.activeElement))
                  input.current?.focus();
              });
            });
          };
  // prettier-ignore
  const selectArtifactQuote: (quote: string, revision: number, page?: number, annotation?: boolean) => void = (quote, revision, page, annotation) => {
                        setDraft(contextKey, {
                          ...draft,
                          selection: quote,
                          revision,
                          page,
                          annotation,
                          taskResult: undefined,
                          intent: undefined,
                        });
                        showInput();
                      };
  // prettier-ignore
  const changeTextQuotes: (textQuotes: TextQuote[]) => void = (textQuotes) =>
        updateDraft(contextKey, (old) => ({ ...old, textQuotes }));
  // prettier-ignore
  const focusCommentComposer: () => void = () => {
        showInput();
        requestAnimationFrame(() =>
          input.current?.focus({ preventScroll: true }),
        );
      };
  return {
    prepareSearchQuote,
    selectArtifactQuote,
    changeTextQuotes,
    focusCommentComposer,
  };
}
