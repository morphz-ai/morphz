// Fixed actual Git b5f698dd App baseline, not generated from the candidate.
// Complete original command declarations live in the independently fixed
// exchange-reference-39cf13cf fixture and are verified against their raw hashes.
// CI does not use Git. These are finite source contracts, not visual proof.
export const referenceConsumptionBaseline = {
  sourceSha256:
    "c8d514979a8ad3dfdd0dc39b125bc9affeeb39ed459f0490dea3fbe3bb921d3d",
  tree: "dd965b45958e6039094c174966d94fcc49361a83c5abcaae02ccfe8e47f754d3",
  ownerCapture:
    "e920cb688cd91403d64535c6cfe38c4dcc33f4b9566571ca05aee9ad3ee953b1",
  nodes: 16513,
  jsxNodes: 204,
  hooks: 61,
  effects: 12,
} as const;

export const referenceConsumptionAdapter = `
function capture() {
 const { openTextQuote, composeContent, composeReading, composeIntent } =
   createExchangeReferenceCommands({
     render: { conversationId, contextKey, workspace: state, drafts, draft, sending, emptyDraft },
     origin,
     navigation: {
       navigationGeneration,
       isCurrent: navigation.isCurrent,
       setExplicitWebsiteIntent: setWebsiteIntent,
       openObject,
       openScriptLocation,
       openBrowser,
       activateApplication,
       selectConversation,
     },
     client,
     drafts: { replace: setDraft, update: updateDraft },
     exchange: { keepOpen: keepExchangeOpen, showInput, setInteraction, requestConversationFocus },
     quotes: {
       clearSelection: () => window.getSelection()?.removeAllRanges(),
       reveal: revealTextQuote,
       setReveal: setQuoteReveal,
     },
     onNotice: setNotice,
   });
}
`;
// Only unused type imports change during consumption. Restore these exact
// original imports for the whole-original-tree comparison, not generic import
// stripping or import-order normalization.
export const referenceOriginalImports = {
  "./Reader.js": 'import { Reader, type ReadingCompose } from "./Reader.js";',
  "../../../packages/core/src/input-intent.js":
    'import { inputIntents, type InputIntent } from "../../../packages/core/src/input-intent.js";',
} as const;
